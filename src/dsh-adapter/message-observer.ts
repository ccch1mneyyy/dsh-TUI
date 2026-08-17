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
 * Envelope rules (vendored schema `messages-observe-envelope-0.15.json`):
 *
 * - `scope` = `session:<sessionId>`; `sequence` = the session event's own
 *   `seq` (monotonic within scope, gaps allowed — unmapped events simply
 *   leave holes); `eventId` = `<sessionId>:<seq>` with schema-unsafe
 *   characters flattened to `_`.
 * - privacyClass is ALWAYS `sensitive` for now (conservative and
 *   irreversible-safe; finer classification is a future, documented step).
 * - Content carries text blocks only (MCP ContentBlock text/image subset —
 *   image blocks arrive when a mapped event actually carries them, which
 *   the current session events never do). `summary` is the sanitized first
 *   200 cells; `truncated` marks summary OR content truncation.
 * - EVERY produced envelope passes the vendored schema before delivery;
 *   a malformed envelope is dropped with a warning, never delivered.
 *
 * Grant gating (`messages.observe.read`, default deny):
 *
 * - SUBSCRIBE time: a denied plugin gets a no-op disposer + a warning
 *   naming plugin and grant (fast fail, as-if-unsubscribed).
 * - DELIVER time: every publish re-checks each subscription; a revoked
 *   grant RELEASES the subscription (contract cleanup rule) with one
 *   warning.
 *
 * Delivery semantics: at-most-once, no replay; callbacks of ONE
 * subscription run serially (per-subscription promise chain); a throwing
 * listener is isolated (warn, name the plugin, keep delivering to the
 * rest). The host MUST NOT persist payload through this contract — the
 * broker keeps no history.
 *
 * privacyClass: sensitive — envelope content is never logged.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { check } from '../plugin-spec/schema-check.js'
import { loadSpecData } from '../plugin-spec/registry.js'
import { cleanScalarText } from './sanitize.js'
import { readGrantStore, type GrantStore } from './grants.js'
import type { TuiEffectLedgerRuntime } from './effect-ledger.js'

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
export const OBSERVE_SCOPE_MAX_CHARS = 256
/** messageId bound (schema maxLength 256). */
export const OBSERVE_ID_MAX_CHARS = 256

interface Subscription {
  plugin: string
  /** The subscriber's own context — kept so the deliver-time revoke path can
   *  record the release against the right ledger identity (it has no other
   *  access to the plugin's fiber). */
  identity: Context
  listener: MessagesObserveListener
  /** Per-subscription serial chain (contract concurrency rule). */
  chain: Promise<unknown>
  closed: boolean
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
  private readonly envelopeSchema: Record<string, unknown> | undefined
  private warnedNoSchema = false

  constructor(
    ctx: Context,
    options: { grants?: GrantStore; ledger?: TuiEffectLedgerRuntime; envelopeSchema?: Record<string, unknown> } = {},
  ) {
    super(ctx, 'tuiMessageObserver')
    this.grantsOption = options.grants
    this.fallbackGrants = readGrantStore()
    this.ledgerOption = options.ledger
    // `'envelopeSchema' in options` lets a caller force-undefined (fail-closed
    // path under test); an absent key loads the vendored schema.
    this.envelopeSchema = 'envelopeSchema' in options ? options.envelopeSchema : loadSpecData()?.schemas.message
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
   * Subscribe to observation envelopes. Identity = the PASSED context's
   * fiber.name (same honest-identity rule as storage). A denied
   * subscription fast-fails: no-op disposer + warning. The subscription
   * releases when the caller's context unloads.
   */
  subscribe(pluginCtx: Context, listener: MessagesObserveListener): () => void {
    let plugin = 'root'
    try {
      const resolved: unknown = pluginCtx.fiber?.name
      if (typeof resolved === 'string' && resolved !== '') plugin = resolved
    } catch {
      // Degraded context without fiber access: 'root'.
    }
    if (!this.grants().allows(plugin, 'messages.observe.read')) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe subscription from plugin "${plugin}" denied — grant "messages.observe.read" ` +
        `for "${plugin}" in ~/.dsh-tui/extension-grants.json first; the listener was NOT registered`,
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
    const subscription: Subscription = { plugin, identity: pluginCtx, listener, chain: Promise.resolve(), closed: false }
    this.subscriptions.add(subscription)
    const release = (): boolean => {
      if (subscription.closed) return false
      subscription.closed = true
      this.subscriptions.delete(subscription)
      return true
    }
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
    if (this.envelopeSchema === undefined) {
      if (!this.warnedNoSchema) {
        this.warnedNoSchema = true
        this.ctx.logger.warn(
          'dsh-tui: messages.observe broker cannot self-check (vendored envelope schema unavailable); ' +
          'envelopes are suppressed fail-closed until the installation is repaired',
        )
      }
      return
    }

    const data = (record.data ?? {}) as Record<string, unknown>
    const message = (kind === 'message.sent' ? data.message : data) as
      | { id?: unknown; content?: unknown }
      | undefined
    const text = this.textOf(message?.content)

    const scope = `session:${sessionId}`.slice(0, OBSERVE_SCOPE_MAX_CHARS)
    const summary = cleanScalarText(text, OBSERVE_SUMMARY_CELLS)
    // Exact truncation detection: the capped clean differs from the
    // uncapped clean (cells ≠ chars, so length comparison would lie).
    const summaryTruncated = summary !== cleanScalarText(text, Number.MAX_SAFE_INTEGER)
    let contentText = text
    let contentTruncated = false
    if (contentText.length > OBSERVE_CONTENT_MAX_CHARS) {
      contentText = contentText.slice(0, OBSERVE_CONTENT_MAX_CHARS)
      contentTruncated = true
    }
    const envelope: MessagesObserveEnvelope = {
      eventType: 'messages.observe',
      eventVersion: '0.15',
      eventId: `${sessionId}:${record.seq}`.replace(/[^A-Za-z0-9._:-]/g, '_'),
      scope,
      sequence: record.seq,
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
        content: [{ type: 'text', text: contentText }],
        ...(summaryTruncated || contentTruncated ? { truncated: true } : {}),
      },
    }

    // Self-check EVERY envelope against the vendored schema; a malformed
    // envelope is dropped, never delivered.
    try {
      check(envelope, this.envelopeSchema, this.envelopeSchema)
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-tui: messages.observe envelope failed the vendored schema and was dropped: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    for (const subscription of [...this.subscriptions]) {
      // Deliver-time grant re-check: a revoked grant RELEASES the
      // subscription (contract cleanup rule), with one warning.
      if (!this.grants().allows(subscription.plugin, 'messages.observe.read')) {
        this.subscriptions.delete(subscription)
        subscription.closed = true
        this.ctx.logger.warn(
          `dsh-tui: messages.observe subscription of plugin "${subscription.plugin}" released — the grant was revoked`,
        )
        this.ledger()?.record(
          { operation: 'release', resource: { kind: 'subscription', id: subscription.plugin }, result: 'applied' },
          subscription.identity,
        )
        continue
      }
      const run = subscription.chain.then(() => subscription.listener(envelope))
      subscription.chain = run.catch(error => {
        this.ctx.logger.warn(
          `dsh-tui: messages.observe listener of plugin "${subscription.plugin}" threw (isolated, delivery continues): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  /** Join the text blocks of a session message's content (text-only view). */
  private textOf(content: unknown): string {
    if (!Array.isArray(content)) return ''
    return content
      .map(block => (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''))
      .join('')
      .trim()
  }
}
