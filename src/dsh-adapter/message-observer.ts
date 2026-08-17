/**
 * messages.observe contract surface (C-042,
 * `messages.dsh/v1alpha1#MessageObserver`): the host event broker, mounted
 * by the dsh-tui-plugin-host row as `ctx.tuiMessageObserver`.
 *
 * Mapping (deliberately narrow):
 *
 * - `user/message`      → `message.received` (the user's prompt)
 * - `assistant/message` → `message.sent` (the assembled step reply)
 * - EVERYTHING ELSE (assistant/chunk streaming, tool/*, turn/*, mode
 *   events, …) produces NO envelope — observation starts conservative.
 *
 * Envelope rules (the pinned `@dsh-std/messages` v0.15 definition):
 *
 * - `scope` = `session:<sessionId>`; `sequence` = the session event's own
 *   `seq` (monotonic within scope, gaps allowed — unmapped events simply
 *   leave holes); `eventId` = `<sessionId>:<seq>` with schema-unsafe
 *   characters flattened to `_`.
 * - privacyClass is ALWAYS `sensitive` for now (conservative and
 *   irreversible-safe; finer classification is a future, documented step).
 * - Content carries the text/image subset (MCP ContentBlock): text runs
 *   join (a pure-text message keeps the single trimmed block); session
 *   image blocks are `{type:'image', attachment}` REFERENCES resolved via
 *   the attachments service into base64 `data` with a 192 KiB budget —
 *   an unreadable/oversize image is dropped and marks `truncated`.
 *   `summary` is the sanitized first 200 cells of the joined text;
 *   `truncated` marks summary, content, or image-drop truncation.
 * - EVERY produced envelope passes the official pinned validator before delivery;
 *   a malformed envelope is dropped with a warning, never delivered.
 *
 * Scope isolation (C-042): `subscribe` requires an exact `scope` string
 * and an envelope is delivered ONLY to subscriptions of the same scope —
 * a plugin moving between sessions subscribes per scope and never
 * receives another session's sensitive content.
 *
 * Grant gating (`messages.observe.read`, default deny):
 *
 * - SUBSCRIBE time: a denied plugin gets a no-op disposer + a warning
 *   naming plugin and grant (fast fail, as-if-unsubscribed).
 * - DELIVER time: every publish re-checks each subscription; a revoked
 *   grant RELEASES the subscription (contract cleanup rule) with one
 *   warning.
 *
 * Delivery semantics: at-most-once, no replay; envelope builds serialize
 * broker-wide (image reads are async — delivery order stays the publish
 * order, so sequence stays monotonic); callbacks of ONE subscription run
 * serially (per-subscription promise chain); a throwing listener is
 * isolated (warn, name the plugin, keep delivering to the rest). The host
 * MUST NOT persist payload through this contract — the broker keeps no
 * history.
 *
 * privacyClass: sensitive — envelope content is never logged.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { validateMessageEvent } from '@dsh-std/messages'
import { check } from '../plugin-spec/schema-check.js'
import { cleanScalarText } from './sanitize.js'
import { readGrantStore, type GrantStore } from './grants.js'
import type { TuiEffectLedgerRuntime } from './effect-ledger.js'
import {
  declaresObserverScope,
  declaresPermission,
  requireComponentIdentity,
  type VerifiedComponentIdentity,
} from './component-identity.js'
import {
  normalizePermissionScope,
  scopeCovers,
  SESSION_SCOPE_MAX_CHARS,
} from '../plugin-spec/permission-scope.js'

/** Envelope content block (MCP ContentBlock text/image subset). */
export type MessagesObserveContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface MessagesObservePayload {
  kind: 'message.created' | 'message.received' | 'message.sent'
  messageId?: string
  author?: string
  content: MessagesObserveContentBlock[]
  truncated?: boolean
}

/** The vendored `messages-observe-envelope-0.15.json` shape. */
export interface MessagesObserveEnvelope {
  eventType: 'messages.observe'
  eventVersion: '0.15'
  eventId: string
  scope: string
  sequence: number
  privacyClass: 'public' | 'internal' | 'sensitive'
  summary: string
  payload: MessagesObservePayload
}

export type MessagesObserveListener = (envelope: MessagesObserveEnvelope) => void | Promise<void>

/** Summary bound (cells; schema maxLength 1024 chars — 200 cells ≤ 1024). */
export const OBSERVE_SUMMARY_CELLS = 200
/** Content text bound (chars; schema maxLength 262144). */
export const OBSERVE_CONTENT_MAX_CHARS = 262144
/** Scope bound (schema maxLength 256). */
export const OBSERVE_SCOPE_MAX_CHARS = SESSION_SCOPE_MAX_CHARS
/** messageId bound (schema maxLength 256). */
export const OBSERVE_ID_MAX_CHARS = 256
/** Raw image byte budget per block (192 KiB → ≤262144 base64 chars). */
export const OBSERVE_IMAGE_MAX_BYTES = 192 * 1024
/** Base64 length bound implied by OBSERVE_IMAGE_MAX_BYTES. */
export const OBSERVE_IMAGE_BASE64_MAX_CHARS = 262144
/** Per-callback budget; timeout closes the subscription deterministically. */
export const OBSERVE_CALLBACK_TIMEOUT_MS = 1500
/** Bound queued callbacks per subscription so a stalled listener cannot grow
 * an unbounded Promise chain before its timeout closes the subscription. */
export const OBSERVE_CALLBACK_QUEUE_LIMIT = 32
/** The envelope schema's mimeType pattern (image blocks). */
const OBSERVE_MIME_PATTERN = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

function freezeEnvelope(envelope: MessagesObserveEnvelope): MessagesObserveEnvelope {
  return deepFreeze(structuredClone(envelope))
}

/** Session events are untrusted at this boundary. Never coerce arbitrary
 * objects through `String()` because a hostile `toString` can fabricate
 * message text (or throw) before the envelope validator sees it. */
function sourceBlockType(value: unknown): 'text' | 'image' | undefined {
  if (value === null || typeof value !== 'object') return undefined
  try {
    const type = (value as { type?: unknown }).type
    return type === 'text' || type === 'image' ? type : undefined
  } catch {
    return undefined
  }
}

function sourceText(value: unknown): string | undefined {
  try {
    const text = (value as { text?: unknown }).text
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

type BoundedCallbackResult =
  | { kind: 'fulfilled' }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' }

async function runWithBudget(
  task: () => void | Promise<void>,
  timeoutMs: number,
): Promise<BoundedCallbackResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work: Promise<BoundedCallbackResult> = Promise.resolve()
    .then(task)
    .then(() => ({ kind: 'fulfilled' as const }), error => ({ kind: 'rejected' as const, error }))
  const timeout = new Promise<BoundedCallbackResult>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Structural view of the attachments service (soft-probed — an unmounted
 *  attachment store simply means image blocks resolve to "dropped"). */
interface ObserveAttachmentReader {
  readImage(ref: unknown): Promise<unknown>
}

interface Subscription {
  plugin: string
  identity: VerifiedComponentIdentity
  ownerContext: Context
  /** Requested envelope scope (e.g. "session:<id>" or the explicit
   *  "session:*" parent). Subscriptions NEVER exceed this scope (C-042
   *  isolation). */
  scope: string
  listener: MessagesObserveListener
  /** Per-subscription serial chain (contract concurrency rule). */
  chain: Promise<unknown>
  pendingCallbacks: number
  closed: boolean
  stopGrantWatch?: () => void
}

/** Match a requested observer scope against the concrete scope of an
 * envelope.  `session:*` is an explicit, grantable parent scope; all other
 * scopes remain exact.  Keeping this relation in the broker means a wildcard
 * declaration cannot accidentally become global unless both the manifest and
 * the current grant cover it. */
function observerScopeCovers(subscriptionScope: string, envelopeScope: string): boolean {
  const declared = normalizePermissionScope('messages.observe.read', subscriptionScope, 'host')
  const actual = normalizePermissionScope('messages.observe.read', envelopeScope, 'host')
  return declared !== undefined && actual !== undefined && scopeCovers(declared, actual)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiMessageObserver: TuiMessageObserverRuntime
  }
}

/**
 * `ctx.tuiMessageObserver` — the messages.observe broker. The channel
 * publishes mapped session events; plugins subscribe with their own
 * context. When the vendored envelope schema is unavailable (packaging
 * accident) the broker fails CLOSED: subscriptions are accepted but nothing
 * is ever delivered (a host that cannot self-check must not emit).
 */
export class TuiMessageObserverRuntime extends Service {
  private readonly grantsOption: GrantStore | undefined
  private readonly fallbackGrants: GrantStore
  private readonly ledgerOption: TuiEffectLedgerRuntime | undefined
  private readonly subscriptions = new Set<Subscription>()
  private readonly validateEnvelope: (value: unknown) => void
  private readonly validatorUnavailable: boolean
  private validatorWarned = false
  private buildChain: Promise<unknown> = Promise.resolve()

  constructor(
    ctx: Context,
    options: {
      grants?: GrantStore
      ledger?: TuiEffectLedgerRuntime
      validateEnvelope?: (value: unknown) => void
      /** @deprecated compatibility alias; prefer validateEnvelope. */
      envelopeSchema?: Record<string, unknown>
    } = {},
  ) {
    super(ctx, 'tuiMessageObserver')
    this.grantsOption = options.grants
    this.fallbackGrants = readGrantStore()
    this.ledgerOption = options.ledger
    if (Object.hasOwn(options, 'validateEnvelope')) {
      this.validatorUnavailable = options.validateEnvelope === undefined
      this.validateEnvelope = options.validateEnvelope ?? (() => { throw new Error('standard envelope validator unavailable') })
    } else if (Object.hasOwn(options, 'envelopeSchema')) {
      const schema = options.envelopeSchema
      this.validatorUnavailable = schema === undefined
      this.validateEnvelope = schema === undefined
        ? (() => { throw new Error('vendored envelope schema unavailable') })
        : (value: unknown) => check(value, schema, schema)
    } else {
      this.validatorUnavailable = false
      this.validateEnvelope = (value: unknown) => { validateMessageEvent(value) }
    }
  }

  /** Grants: the plugin-host row's store when mounted, else a private read.
   *  Resolved PER CALL — sibling services mounted later by the same apply()
   *  are not visible to constructors (cordis), so a constructor-time probe
   *  would silently stick to the fallback. */
  private grants(): GrantStore {
    return this.grantsOption ?? this.ctx.get('tuiPluginHost')?.grants ?? this.fallbackGrants
  }

  /** Optional observability; a bare mount (tests) simply records nothing. */
  private ledger(): TuiEffectLedgerRuntime | undefined {
    return this.ledgerOption ?? this.ctx.get('tuiEffectLedger')
  }

  /**
   * Subscribe to observation envelopes for ONE scope. Identity = the verified
   * Component bound to the PASSED activation (the same identity rule as
   * storage); the scope
   * is required and matched exactly — a plugin moving between sessions
   * subscribes per scope and never receives another scope's sensitive
   * content (C-042 isolation). A denied subscription fast-fails: no-op
   * disposer + warning. The subscription releases when the caller's context
   * unloads.
   */
  subscribe(pluginCtx: Context, listener: MessagesObserveListener, options: { scope: string }): () => void {
    const identity = requireComponentIdentity(pluginCtx)
    const plugin = identity.componentId
    const scope = typeof options?.scope === 'string' ? options.scope : ''
    if (scope === '' || scope.length > OBSERVE_SCOPE_MAX_CHARS) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe subscription from plugin "${plugin}" refused — options.scope must be a ` +
        `non-empty string of at most ${OBSERVE_SCOPE_MAX_CHARS} characters (e.g. "session:<id>")`,
      )
      return () => false
    }
    if (typeof listener !== 'function'
      || !declaresObserverScope(identity, scope)
      || !declaresPermission(identity, 'messages.observe.read', scope)
      || !this.grants().allows(
        { componentId: identity.componentId, activationId: identity.activationId },
        'messages.observe.read',
        scope,
      )) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe subscription from Component "${plugin}" denied — ` +
        'the scope is not statically declared or the current grant does not cover it; the listener was NOT registered',
      )
      this.ledger()?.record(
        {
          operation: 'bind',
          resource: { kind: 'permission', id: 'messages.observe.read' },
          result: 'failed',
          errorCode: 'PERMISSION_NOT_GRANTED',
        },
        pluginCtx,
      )
      return () => false
    }
    const subscription: Subscription = {
      plugin,
      identity,
      ownerContext: pluginCtx,
      scope,
      listener,
      chain: Promise.resolve(),
      pendingCallbacks: 0,
      closed: false,
    }
    this.subscriptions.add(subscription)
    this.ledger()?.record(
      { operation: 'bind', resource: { kind: 'subscription', id: plugin }, result: 'applied' },
      pluginCtx,
    )
    const release = (): boolean => {
      if (subscription.closed) return false
      this.drop(subscription)
      return true
    }
    subscription.stopGrantWatch = this.grants().onChange?.(() => {
      if (!this.grants().allows(
        { componentId: identity.componentId, activationId: identity.activationId },
        'messages.observe.read',
        scope,
      )) release()
    })
    try {
      pluginCtx.effect(() => release)
    } catch {
      // Degraded context: the subscription lives until process end.
    }
    return release
  }

  /**
   * Publish a session event (channel `session/event` arm). Non-mapped
   * event types return immediately; everything else never throws into the
   * caller — problems are warned, not raised.
   */
  publish(session: unknown, event: unknown): void {
    try {
      this.publishGuarded(session, event)
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe publish failed (event dropped): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private publishGuarded(session: unknown, event: unknown): void {
    if (this.subscriptions.size === 0) return
    const record = event as { type?: unknown; seq?: unknown; data?: unknown }
    const kind = record.type === 'user/message'
      ? 'message.received' as const
      : record.type === 'assistant/message'
        ? 'message.sent' as const
        : undefined
    if (kind === undefined) return
    if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) return

    const sessionId = (session as { id?: unknown })?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      this.ctx.logger.warn('dsh-tui: messages.observe publish skipped — the session carries no string id')
      return
    }
    const data = (record.data ?? {}) as Record<string, unknown>
    const message = (kind === 'message.sent' ? data.message : data) as
      | { id?: unknown; content?: unknown }
      | undefined

    const scope = `session:${sessionId}`
    // Never truncate a session identity into the schema's scope bound: two
    // distinct long ids can otherwise collapse into one subscription scope.
    if (scope.length > OBSERVE_SCOPE_MAX_CHARS) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe publish skipped — the session scope exceeds ${OBSERVE_SCOPE_MAX_CHARS} characters`,
      )
      return
    }
    // C-042 isolation: match subscriptions BEFORE building anything — a
    // subscription for another scope must never see this scope's content.
    const matched = [...this.subscriptions].filter(subscription =>
      !subscription.closed && observerScopeCovers(subscription.scope, scope))
    if (matched.length === 0) return

    // Builds serialize broker-wide so delivery order stays the publish
    // order even though image reads are async (sequence stays monotonic).
    this.buildChain = this.buildChain.then(() => this.buildAndDeliver(kind, sessionId, scope, record.seq as number, message, matched))
  }

  private async buildAndDeliver(
    kind: 'message.received' | 'message.sent',
    sessionId: string,
    scope: string,
    sequence: number,
    message: { id?: unknown; content?: unknown } | undefined,
    matched: Subscription[],
  ): Promise<void> {
    try {
      const text = this.textOf(message?.content)
      const { blocks, truncated: contentTruncated } = await this.contentOf(message?.content)

      const summary = cleanScalarText(text, OBSERVE_SUMMARY_CELLS)
      // Exact truncation detection: the capped clean differs from the
      // uncapped clean (cells ≠ chars, so length comparison would lie).
      const summaryTruncated = summary !== cleanScalarText(text, Number.MAX_SAFE_INTEGER)
      const envelope: MessagesObserveEnvelope = {
        eventType: 'messages.observe',
        eventVersion: '0.15',
        eventId: `${sessionId}:${sequence}`.replace(/[^A-Za-z0-9._:-]/g, '_'),
        scope,
        sequence,
        // Conservative-by-default: every envelope is sensitive until a
        // documented finer classification exists.
        privacyClass: 'sensitive',
        summary,
        payload: {
          kind,
          ...(typeof message?.id === 'string' && message.id.length > 0 && message.id.length <= OBSERVE_ID_MAX_CHARS
            ? { messageId: message.id }
            : {}),
          author: kind === 'message.received' ? 'user' : 'assistant',
          content: blocks,
          ...(summaryTruncated || contentTruncated ? { truncated: true } : {}),
        },
      }

      // Self-check EVERY envelope with the pinned @dsh-std/messages validator.
      if (this.validatorUnavailable) {
        if (!this.validatorWarned) {
          this.validatorWarned = true
          this.ctx.logger.warn('dsh-tui: standard message envelope validator unavailable — delivery is fail-closed')
        }
        return
      }
      try {
        this.validateEnvelope(envelope)
      } catch (error) {
        this.ctx.logger.warn(
          `dsh-tui: messages.observe envelope failed the standard validator and was dropped: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }

      for (const subscription of matched) {
        if (subscription.closed) continue
        // Deliver-time grant re-check: a revoked grant RELEASES the
        // subscription (contract cleanup rule), with one warning.
        if (!this.grants().allows(
          { componentId: subscription.identity.componentId, activationId: subscription.identity.activationId },
          'messages.observe.read',
          scope,
        )) {
          this.ctx.logger.warn(
            `dsh-tui: messages.observe subscription of plugin "${subscription.plugin}" released — the grant was revoked`,
          )
          this.drop(subscription)
          continue
        }
        if (subscription.pendingCallbacks >= OBSERVE_CALLBACK_QUEUE_LIMIT) {
          this.ctx.logger.warn(
            `dsh-tui: messages.observe listener of Component "${subscription.plugin}" reached its ` +
            `${OBSERVE_CALLBACK_QUEUE_LIMIT}-callback queue limit; this envelope was skipped`,
          )
          continue
        }
        subscription.pendingCallbacks += 1
        const run = subscription.chain.then(async () => {
          if (subscription.closed) return
          const isolated = freezeEnvelope(envelope)
          const result = await runWithBudget(
            () => subscription.listener(isolated),
            OBSERVE_CALLBACK_TIMEOUT_MS,
          )
          if (result.kind === 'timeout') {
            this.ctx.logger.warn(
              `dsh-tui: messages.observe listener of Component "${subscription.plugin}" exceeded ` +
              `${OBSERVE_CALLBACK_TIMEOUT_MS}ms and the subscription was closed`,
            )
            this.drop(subscription)
          } else if (result.kind === 'rejected') {
            this.ctx.logger.warn(
              `dsh-tui: messages.observe listener of Component "${subscription.plugin}" failed; delivery continues: ` +
              `${result.error instanceof Error ? result.error.message : String(result.error)}`,
            )
          }
        })
        subscription.chain = run.catch(error => {
          this.ctx.logger.warn(`dsh-tui: messages.observe delivery failed: ${error instanceof Error ? error.message : String(error)}`)
        }).finally(() => { subscription.pendingCallbacks -= 1 })
      }
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe publish failed (event dropped): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Release a subscription exactly once (disposer, ctx unload, revoke). */
  private drop(subscription: Subscription): void {
    if (subscription.closed) return
    subscription.closed = true
    subscription.stopGrantWatch?.()
    subscription.stopGrantWatch = undefined
    this.subscriptions.delete(subscription)
    this.ledger()?.record(
      { operation: 'release', resource: { kind: 'subscription', id: subscription.plugin }, result: 'applied' },
      subscription.ownerContext,
    )
  }

  /** Join the text blocks of a session message's content (text-only view). */
  private textOf(content: unknown): string {
    if (!Array.isArray(content)) return ''
    let text = ''
    for (const block of content) {
      if (sourceBlockType(block) !== 'text') continue
      const value = sourceText(block)
      if (value !== undefined) text += value
    }
    return text.trim()
  }

  /**
   * Map session content blocks to envelope blocks in order (text/image
   * subset). Consecutive text runs join into one block (capped at
   * OBSERVE_CONTENT_MAX_CHARS, pure-text messages keep the exact legacy
   * shape: a single trimmed block); image blocks resolve through the
   * attachments service (soft-probe) with a byte budget. A failed or
   * oversize image becomes NO block plus the truncation mark; zero
   * surviving blocks collapse to a single empty text block (schema
   * minItems 1).
   */
  private async contentOf(content: unknown): Promise<{ blocks: MessagesObserveContentBlock[]; truncated: boolean }> {
    const blocks: MessagesObserveContentBlock[] = []
    let pendingText = ''
    let truncated = false
    const appendText = (value: string): void => {
      const remaining = OBSERVE_CONTENT_MAX_CHARS - pendingText.length
      if (remaining <= 0) {
        truncated = true
        return
      }
      if (value.length > remaining) {
        pendingText += value.slice(0, remaining)
        truncated = true
        return
      }
      pendingText += value
    }
    const flushText = (): void => {
      const run = pendingText.trim()
      pendingText = ''
      if (run === '') return
      blocks.push({ type: 'text', text: run })
    }
    if (Array.isArray(content)) {
      for (const raw of content) {
        const type = sourceBlockType(raw)
        if (type === 'text') {
          const text = sourceText(raw)
          if (text === undefined) {
            // A declared text block with a non-string body is malformed source
            // data, not the literal string "[object Object]".
            truncated = true
            continue
          }
          appendText(text)
          continue
        }
        if (type === 'image') {
          const image = await this.imageBlockOf(raw)
          if (image === undefined) {
            truncated = true
            continue
          }
          flushText()
          blocks.push(image)
          continue
        }
        // Unknown block types are outside the text/image subset: dropped.
      }
    }
    flushText()
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    return { blocks, truncated }
  }

  /** Resolve a session image block (`{type:'image', attachment}` — a
   *  REFERENCE, never inline data) to an envelope image block; undefined =
   *  drop (unreadable, oversize, bad media type, no attachment store). */
  private async imageBlockOf(block: unknown): Promise<MessagesObserveContentBlock | undefined> {
    try {
      if (block === null || typeof block !== 'object') return undefined
      const attachment = (block as { attachment?: unknown }).attachment as { mediaType?: unknown; bytes?: unknown } | null | undefined
      if (attachment === null || attachment === undefined || typeof attachment !== 'object') return undefined
      const mediaType = attachment.mediaType
      if (typeof mediaType !== 'string' || !OBSERVE_MIME_PATTERN.test(mediaType)) return undefined
      const bytes = attachment.bytes
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0 || bytes > OBSERVE_IMAGE_MAX_BYTES) return undefined
      const reader = this.ctx.get('attachments') as ObserveAttachmentReader | undefined
      if (typeof reader?.readImage !== 'function') return undefined
      // A failing read drops ONLY this image (the envelope survives with the
      // truncation mark) — one corrupt attachment must not nuke the message.
      const stored = await reader.readImage(attachment)
      const data = (stored as { data?: unknown } | undefined)?.data
      if (!(data instanceof Uint8Array) || data.byteLength > OBSERVE_IMAGE_MAX_BYTES) return undefined
      const base64 = Buffer.from(data).toString('base64')
      if (base64.length > OBSERVE_IMAGE_BASE64_MAX_CHARS) return undefined
      return { type: 'image', data: base64, mimeType: mediaType }
    } catch {
      // Source content and attachment service output are untrusted here.
      // Drop only this block and let the enclosing envelope carry truncated.
      return undefined
    }
  }
}
