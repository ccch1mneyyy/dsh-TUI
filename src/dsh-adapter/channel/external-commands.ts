import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandExecution, CommandRuntime } from '@deepseek-ai/dsh-commands'
import { installedMeetsVersion } from '../contract.js'
import { commandOwner } from '../command-attribution.js'
import { assertCapabilityShadowPolicy } from '../../adapter/kernel/runtime.js'
import { t } from '../../i18n.js'
import type { MentionAttachments } from './types.js'
import type { ChannelImageBlock } from './types.js'

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
type RegistryImage = { mediaType: ImageMediaType; data: string; name?: string }
type LegacyExecute = (agent: Agent, line: string, signal: AbortSignal) => Promise<CommandExecution | undefined>
type ImagesExecute = (agent: Agent, line: string, images: readonly RegistryImage[], signal: AbortSignal) => Promise<CommandExecution | undefined>

/** Plugin-command invocation has one owner: this module owns gates and image encoding. */
export function createExternalCommandInvoker(
  ctx: Context,
  deps: {
    commandService: CommandRuntime | undefined
    runtime: { mode: string; slices: readonly string[] }
    agent(): Agent
    capture(): unknown
    bindingCurrent(capture: unknown): boolean
    allows(subject: { componentId: string; activationId?: string }, permission: string, scope: string): boolean
    stagedImages(): ReadonlyMap<string, ChannelImageBlock['attachment']>
    attachments(): MentionAttachments | undefined
    notify(text: string, options?: { color?: 'success' | 'error' | 'warning'; timeoutMs?: number }): void
  },
) {
  const supportsImages = (service: CommandRuntime): boolean =>
    installedMeetsVersion('@deepseek-ai/dsh-commands', '0.1.0-rc.8')
      || (typeof (service.execute as { length?: number }).length === 'number' && (service.execute as { length: number }).length >= 4)

  const imagesFor = async (service: CommandRuntime, definition: unknown, line: string, signal: AbortSignal): Promise<{ images: RegistryImage[]; dropped: string[] } | undefined> => {
    if (!supportsImages(service)) return undefined
    if ((definition as { input?: { images?: boolean } } | undefined)?.input?.images !== true) return { images: [], dropped: [] }
    const images: RegistryImage[] = []
    const dropped: string[] = []
    const attachments = deps.attachments()
    if (attachments === undefined) return { images, dropped }
    for (const [token, attachment] of deps.stagedImages()) {
      if (!line.includes(token)) continue
      try {
        const stored = await (attachments as unknown as { readImage?(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> }).readImage?.(attachment, signal)
        if (stored?.data instanceof Uint8Array && stored.data.byteLength > 0) images.push({ mediaType: attachment.mediaType as ImageMediaType, data: Buffer.from(stored.data).toString('base64'), name: attachment.name })
        else dropped.push(token)
      } catch { dropped.push(token) }
    }
    return { images, dropped }
  }

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

  const invoke = async (name: string, rawInput: string): Promise<string | undefined> => {
    const capture = deps.capture()
    assertCapabilityShadowPolicy('host.commands.invoke', deps.runtime.mode as never, deps.runtime.slices)
    const service = deps.commandService
    if (service === undefined) return undefined
    const definition = service.find(deps.agent(), name)
    const initialDenied = authorize(definition, name)
    if (initialDenied !== undefined) return initialDenied
    try {
      const signal = new AbortController().signal
      const line = `/${name}${rawInput}`
      const imageResult = await imagesFor(service, definition, line, signal)
      if (!deps.bindingCurrent(capture)) return undefined
      // Image IO is an await boundary. Reject a same-name replacement rather
      // than executing a handler whose owner/input was not authorized here.
      const currentDefinition = service.find(deps.agent(), name)
      if (currentDefinition !== definition) return undefined
      const currentDenied = authorize(currentDefinition, name)
      if (currentDenied !== undefined) return currentDenied
      const execution = imageResult === undefined
        ? await (service.execute as unknown as LegacyExecute)(deps.agent(), line, signal)
        : await (service.execute as unknown as ImagesExecute)(deps.agent(), line, imageResult.images, signal)
      if (!deps.bindingCurrent(capture)) return undefined
      if (imageResult !== undefined && imageResult.dropped.length > 0) deps.notify(t('mentions-missing', { paths: imageResult.dropped.join(' ') }), { color: 'warning', timeoutMs: 4000 })
      return execution === undefined ? undefined : execution.result.text ?? ''
    } catch (error) {
      if (!deps.bindingCurrent(capture)) return undefined
      return error instanceof Error ? error.message : String(error)
    }
  }
  return { invoke }
}
