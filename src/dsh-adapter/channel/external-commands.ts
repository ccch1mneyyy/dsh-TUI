import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandExecution, CommandRuntime } from '@deepseek-ai/dsh-commands'
import { installedMeetsVersion } from '../contract.js'
import { commandOwner } from '../command-attribution.js'
import { assertCapabilityShadowPolicy } from '../../adapter/kernel/runtime.js'
import { t } from '../../i18n.js'
import { firstStaleComposerToken, orderedComposerImages, type ComposerImages } from './composer-images.js'
import type { ChannelImageBlock, ComposerImageRef, ExternalCommandOutcome, MentionAttachments } from './types.js'

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
type RegistryImage = { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
type LegacyExecute = (agent: Agent, line: string, signal: AbortSignal) => Promise<CommandExecution | undefined>
type ImagesExecute = (agent: Agent, line: string, images: readonly RegistryImage[], signal: AbortSignal) => Promise<CommandExecution | undefined>
/** One composer image accompanying a registry-command line: structural
 *  mirror of rc.8's `EncodedImageAttachment`. Kept local so older installs
 *  never resolve rc.8-only types. */
type RegistryCommandImageBatch =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'ready'; readonly images: readonly RegistryImage[] }
  | { readonly kind: 'error'; readonly reason: 'runtime' | 'missing' | 'limits'; readonly tokens: readonly string[] }

/** Plugin-command invocation has one owner: this module owns gates, image
 *  encoding and the settled draft-consumption outcome. */
export function createExternalCommandInvoker(
  ctx: Context,
  deps: {
    commandService: CommandRuntime | undefined
    runtime: { mode: string; slices: readonly string[] }
    agent(): Agent
    capture(): unknown
    bindingCurrent(capture: unknown): boolean
    allows(subject: { componentId: string; activationId?: string }, permission: string, scope: string): boolean
    composer: ComposerImages
    attachments(): MentionAttachments | undefined
    notify(text: string, options?: { color?: 'success' | 'error' | 'warning'; timeoutMs?: number }): void
  },
) {
  /** Whether the installed command service takes composer images: version
   *  gate (composer images arrived on 0.1.0-rc.8 and every later family —
   *  0.1.1 included — keeps the 4-param shape) with a structural fallback,
   *  so a failed manifest probe (bundlers, exotic loaders) still lands on
   *  the 4-param rc.8 shape at runtime. */
  const supportsImages = (service: CommandRuntime): boolean =>
    installedMeetsVersion('@deepseek-ai/dsh-commands', '0.1.0-rc.8')
      || (typeof (service.execute as { length?: number }).length === 'number' && (service.execute as { length: number }).length >= 4)

  const authorize = (definition: unknown, name: string): string | undefined => {
    // Derive identity from the effective definition, never the display name:
    // scoped same-name handlers can have different verified owners.
    const owner = commandOwner(ctx, definition)
    const rootScope = owner?.commandId ?? (/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u.test(name) ? name : `dsh-tui.${name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'command'}`)
    if (!deps.allows({ componentId: 'root' }, 'commands.invoke', rootScope)) {
      ctx.logger.warn('dsh-tui: registry command invocation denied (commands.invoke revoked for "root" in the grants file)')
      ctx.get('tuiEffectLedger')?.record({ operation: 'bind', resource: { kind: 'permission', id: `root:commands.invoke:${rootScope}` }, result: 'failed', errorCode: 'PERMISSION_NOT_GRANTED' }, ctx)
      return t('command-invoke-denied')
    }
    if (owner !== undefined && !deps.allows({ componentId: owner.componentId, activationId: owner.activationId }, 'commands.invoke', owner.commandId)) {
      ctx.logger.warn(`dsh-tui: registry command "/${name}" invocation denied — owner Component "${owner.componentId}" lost commands.invoke for "${owner.commandId}"`)
      ctx.get('tuiEffectLedger')?.record({ operation: 'bind', resource: { kind: 'permission', id: `${owner.componentId}:commands.invoke:${owner.commandId}` }, result: 'failed', errorCode: 'PERMISSION_NOT_GRANTED' }, ctx)
      return t('command-invoke-denied-owner', { name, owner: owner.componentId })
    }
    return undefined
  }

  /** Encode the staged `@`-mention images the user pasted for THIS command
   *  line into rc.8's `EncodedImageAttachment` payloads; `kind: 'legacy'`
   *  means the installed dsh-commands line predates composer images
   *  (rc.7/rc.6), so the caller uses the legacy 3-arg invoke. Matches the
   *  submit pipeline's token rule (expandComposerMentions): a staged image
   *  attaches only when the line references its token. The composer
   *  preflights `input.images`, but this adapter still forwards every
   *  supplied image: rc.8 owns admission, so non-UI callers cannot
   *  accidentally bypass the registry contract. Preparation is atomic:
   *  limits are checked from durable metadata before any read/base64 work,
   *  and one missing or unreadable image prevents the handler from running
   *  with a silently truncated batch. */
  const registryCommandImages = async (
    service: CommandRuntime,
    line: string,
    imageRefs: readonly ComposerImageRef[],
    staged: ReadonlyMap<string, ChannelImageBlock['attachment']>,
    signal: AbortSignal,
  ): Promise<RegistryCommandImageBatch> => {
    const ordered = orderedComposerImages(line, imageRefs, staged)
    // A `[Image #N]` with no live staging is plain text here, exactly as on
    // the submit path: warn once, keep the line unchanged. Only referenced,
    // staged images take part in the batch below.
    const stale = firstStaleComposerToken(line, ordered)
    if (stale !== undefined) {
      deps.notify(t('input-image-token-stale', { token: stale }), { color: 'warning', timeoutMs: 5000 })
    }
    if (!supportsImages(service)) {
      return ordered.size > 0
        ? { kind: 'error', reason: 'runtime', tokens: [...ordered.keys()] }
        : { kind: 'legacy' }
    }
    if (ordered.size === 0) return { kind: 'ready', images: [] }
    const store = deps.attachments() as
      | (MentionAttachments & { readImage?(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> })
      | undefined
    if (typeof store?.readImage !== 'function') {
      return { kind: 'error', reason: 'missing', tokens: [...ordered.keys()] }
    }
    const { imageLimits: limits } = store
    let declaredBytes = 0
    for (const attachment of ordered.values()) {
      if (
        !Number.isSafeInteger(attachment.bytes)
        || attachment.bytes <= 0
        || attachment.bytes > limits.maxImageBytes
        || !limits.mediaTypes.includes(attachment.mediaType)
      ) {
        return { kind: 'error', reason: 'limits', tokens: [...ordered.keys()] }
      }
      declaredBytes += attachment.bytes
    }
    if (
      ordered.size > limits.maxImagesPerMessage
      || declaredBytes > limits.maxMessageImageBytes
    ) {
      return { kind: 'error', reason: 'limits', tokens: [...ordered.keys()] }
    }
    const loaded: Array<{
      readonly token: string
      readonly attachment: ChannelImageBlock['attachment']
      readonly data: Uint8Array
    }> = []
    let actualBytes = 0
    for (const [token, attachment] of ordered) {
      try {
        const stored = await store.readImage(attachment, signal)
        if (!(stored?.data instanceof Uint8Array) || stored.data.byteLength <= 0) {
          return { kind: 'error', reason: 'missing', tokens: [token] }
        }
        actualBytes += stored.data.byteLength
        if (
          stored.data.byteLength > limits.maxImageBytes
          || actualBytes > limits.maxMessageImageBytes
        ) {
          return { kind: 'error', reason: 'limits', tokens: [...ordered.keys()] }
        }
        loaded.push({ token, attachment, data: stored.data })
      } catch {
        return { kind: 'error', reason: 'missing', tokens: [token] }
      }
    }
    return {
      kind: 'ready',
      images: loaded.map(({ attachment, data }) => ({
        // Older image-only runtimes ignore the discriminator; 0.1.5 uses it
        // to distinguish encoded images from stored file attachments.
        type: 'image',
        mediaType: attachment.mediaType as ImageMediaType,
        data: Buffer.from(data).toString('base64'),
        name: attachment.name,
      })),
    }
  }

  /** Run one DSH registry command (`/plan`, …) on the live agent while
   *  preserving its settled result kind for composer admission. */
  const invoke = async (
    name: string,
    rawInput: string,
    imageRefs: readonly ComposerImageRef[] = [],
  ): Promise<ExternalCommandOutcome | undefined> => {
    const capture = deps.capture()
    assertCapabilityShadowPolicy('host.commands.invoke', deps.runtime.mode as never, deps.runtime.slices)
    const service = deps.commandService
    if (service === undefined) return undefined
    const commandAgent = deps.agent()
    const stagedSnapshot = deps.composer.snapshot()
    // Resolve the exact definition that execute() will select for this agent.
    // Same names may exist in distinct agent scopes, so a name-only lookup can
    // apply another scope's owner policy.
    const definition = service.find(commandAgent, name)
    try {
      const signal = new AbortController().signal
      const line = `/${name}${rawInput}`
      const batch = await registryCommandImages(
        service,
        line,
        deps.composer.includeLegacyImageRefs(line, imageRefs),
        stagedSnapshot,
        signal,
      )
      if (batch.kind === 'error') {
        const text = batch.reason === 'runtime'
          ? t('command-images-runtime-unsupported', { name })
          : batch.reason === 'limits'
            ? t('command-images-limit', { name })
            : t('command-images-missing', { name, paths: batch.tokens.join(' ') })
        return { kind: 'error', text, consumeDraft: false }
      }
      // Image preparation can await storage. Do not authorize definition A
      // and then execute a newly registered same-name definition B after A
      // was unloaded while those reads were pending.
      if (service.find(commandAgent, name) !== definition) {
        return { kind: 'error', text: t('command-changed', { name }), consumeDraft: false }
      }
      if (!deps.bindingCurrent(capture)) {
        deps.notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
        return { kind: 'error', text: '', consumeDraft: false }
      }
      // Grants are a live per-operation decision. Image reads above may
      // park, so take the single authoritative snapshot only now — after
      // preparation/identity guards and immediately before execute.
      const denied = authorize(definition, name)
      if (denied !== undefined) return { kind: 'error', text: denied, consumeDraft: false }
      // rc.8 moved the signal to the 4th parameter and added composer
      // images; older lines (rc.7/rc.6) take (agent, line, signal).
      const execution = batch.kind === 'legacy'
        ? await (service.execute as unknown as LegacyExecute)(commandAgent, line, signal)
        : await (service.execute as unknown as ImagesExecute)(commandAgent, line, batch.images, signal)
      // The handler itself may park. Its durable lifecycle belongs to the
      // old agent, but its toast/consume acknowledgment must never land on a
      // replacement session after /new, resume, rewind, or model switch.
      if (!deps.bindingCurrent(capture)) return { kind: 'error', text: '', consumeDraft: false }
      if (execution === undefined) return undefined
      return execution.result.kind === 'success'
        ? { kind: 'success', text: execution.result.text ?? '', consumeDraft: true }
        : {
            kind: 'error',
            text: execution.result.text,
            // Upstream composers retain image-bearing handler failures so
            // the user can fix the grammar without rebuilding attachments;
            // imageless handler errors remain consumed durable outcomes.
            consumeDraft: batch.kind === 'ready' ? batch.images.length === 0 : true,
          }
    } catch (error) {
      return {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
        consumeDraft: false,
      }
    }
  }

  /** Text-only companion kept for the public scene-facing API. */
  const invokeText = async (
    name: string,
    rawInput: string,
    imageRefs: readonly ComposerImageRef[] = [],
  ): Promise<string | undefined> => (await invoke(name, rawInput, imageRefs))?.text

  return { invoke, invokeText }
}
