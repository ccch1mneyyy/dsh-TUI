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
import { validateMessageEvent } from '../adapter/standard/protocols.js'
import { check } from '../adapter/standard/schema-check.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { cleanScalarText } from './sanitize.js'
import { activationContext, assertCallerContext, bindCallerEffect, compositionRoot, concreteService } from './host-access.js'
import { registerMessageLiveProbe } from '../adapter/kernel/host-probe-access.js'
import { readGrantStore, type GrantStore } from '../adapter/standard/grants.js'
import type { TuiEffectLedgerRuntime } from './effect-ledger.js'
import { getHostGrantStore } from './host-grants.js'
import {
  declaresObserverScope,
  declaresPermission,
  requireComponentIdentity,
  requiresContract,
  type VerifiedComponentIdentity,
} from './component-identity.js'
import {
  normalizePermissionScope,
  scopeCovers,
  SESSION_SCOPE_MAX_CHARS,
} from '../adapter/standard/permission-scope.js'

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

/** Host-only session-event ingress. Plugins receive only `subscribe`; the
 * channel uses this capability to publish events after its own identity check. */
export interface TuiMessageObserverHost {
  publish(session: unknown, event: unknown): void
}

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
/** Attachment reads are part of the broker build chain and therefore need an
 * independent bound; a wedged reader must not stall every later envelope. */
export const OBSERVE_IMAGE_READ_TIMEOUT_MS = 1500
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
  /** True for the host-internal reversible probe subscription; skips
   *  caller-grant delivery checks and observability records. */
  probe?: boolean
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
  constructor(
    ctx: Context,
    options: {
      grants?: GrantStore
      ledger?: TuiEffectLedgerRuntime
      validateEnvelope?: (value: unknown) => void
      /**
       * @deprecated Use `validateEnvelope` instead.
       * Compatibility alias retained as a long-term face for existing
       * embedders/tests. OWNER: dsh-tui adapter. UNTIL: no scheduled removal.
       */
      envelopeSchema?: Record<string, unknown>
    } = {},
  ) {
    super(ctx, 'tuiMessageObserver')
    const state: ObserverState = {
hostContext: compositionRoot(ctx),
      grantsOption: options.grants,
      fallbackGrants: readGrantStore(undefined, undefined, adapterRuntimeFor(ctx)),
      ledgerOption: options.ledger,
      subscriptions: new Set(),
      validateEnvelope: validateMessageEvent,
      validatorUnavailable: false,
      validatorWarned: false,
      runtime: adapterRuntimeFor(ctx),
      buildChain: Promise.resolve(),
    }
    const runtime = this
    const host: TuiMessageObserverHost = Object.freeze({
      publish: (session, event) => {
        try {
          runtime.#publishGuarded(session, event)
        } catch (error) {
          runtime.ctx.logger.warn(
            'dsh-tui: messages.observe publish failed (event dropped)',
          )
        }
      },
    })
    hostMessageObservers.set(runtime, host)
    if (Object.hasOwn(options, 'validateEnvelope')) {
      state.validatorUnavailable = options.validateEnvelope === undefined
      state.validateEnvelope = options.validateEnvelope ?? (() => { throw new Error('standard envelope validator unavailable') })
    } else if (Object.hasOwn(options, 'envelopeSchema')) {
      const schema = options.envelopeSchema
      state.validatorUnavailable = schema === undefined
      state.validateEnvelope = schema === undefined
        ? (() => { throw new Error('vendored envelope schema unavailable') })
        : (value: unknown) => check(value, schema, schema)
    }
    observerStates.set(this, state)
    registerMessageLiveProbe(this, () => this.#runReversibleProbe())
  }

  /** Grants: the plugin-host row's store when mounted, else a private read.
   *  Resolved PER CALL — sibling services mounted later by the same apply()
   *  are not visible to constructors (cordis), so a constructor-time probe
   *  would silently stick to the fallback. */
  private grants(): GrantStore {
    const state = observerStateFor(this)
    return state.grantsOption ?? getHostGrantStore(state.hostContext.get('tuiPluginHost')) ?? state.fallbackGrants
  }

  /** Optional observability; a bare mount (tests) simply records nothing. */
  private ledger(): TuiEffectLedgerRuntime | undefined {
    const state = observerStateFor(this)
    return state.ledgerOption ?? state.hostContext.get('tuiEffectLedger')
  }

  /**
   * Host-internal read-only diagnostic probe. It validates the mounted broker
   * without creating a subscription and without publishing anything.
   */
  probeDiagnostic(): { service: 'tuiMessageObserver'; ok: true; subscriptions: number } {
    assertCapabilityShadowPolicy('host.messages.probe', observerStateFor(this).runtime.mode, observerStateFor(this).runtime.slices)
    const state = observerStateFor(this)
    return Object.freeze({
      service: 'tuiMessageObserver',
      ok: true,
      subscriptions: state.subscriptions.size,
    })
  }

  /**
   * Host-internal reversible live probe.
   *
   * This exercises the real production subscription path and delivery
   * topology: it registers one temporary subscription through the same
   * internal registration code used by `subscribe()`, publishes one synthetic
   * user message through the PROBE-ONLY channel, verifies the listener
   * receives an envelope, then unregisters it and verifies the subscription
   * count returns to the original value. Real plugin subscriptions are never
   * matched by the probe-only publication.
   *
   * Side-effect boundary: the temporary subscription is removed before this
   * method returns and no real plugin state is touched. In passive/replay
   * shadow the capability guard denies this before any operation.
   *
   * This is an ECMAScript private method. It is reachable only through the
   * host-only probe accessor registered in the constructor.
   */
  async #runReversibleProbe(): Promise<{
    service: 'tuiMessageObserver'
    ok: true
    before: number
    during: number
    after: number
    delivered: number
  }> {
    assertCapabilityShadowPolicy('host.messages.liveProbe', observerStateFor(this).runtime.mode, observerStateFor(this).runtime.slices)
    const state = observerStateFor(this)
    const before = state.subscriptions.size
    const identity: VerifiedComponentIdentity = {
      componentId: '__dsh_tui_live_probe__',
      activationId: '__dsh_tui_live_probe__',
      version: '0.0.0',
      facet: 'host',
      manifest: { id: '__dsh_tui_live_probe__' } as never,
      projection: { id: '__dsh_tui_live_probe__' } as never,
    }
    const self = concreteService(this) as TuiMessageObserverRuntime
    const received: MessagesObserveEnvelope[] = []
    const release = self.#registerSubscription(
      state.hostContext,
      identity,
      '__dsh_tui_live_probe__',
      'session:__dsh_tui_live_probe__',
      envelope => { received.push(envelope) },
      { enforceGrants: false, recordLedger: false, bindLifecycle: false },
    )
    try {
      const during = state.subscriptions.size
      if (during !== before + 1) {
        throw new Error(`temporary subscription did not enter the broker (${before} -> ${during})`)
      }
      self.#publishGuarded(
        { id: '__dsh_tui_live_probe__' },
        {
          type: 'user/message',
          seq: 1,
          data: {
            id: 'probe-message',
            role: 'user',
            content: [{ type: 'text', text: 'live probe' }],
            source: { kind: 'user' },
          },
        },
        true,
      )
      await state.buildChain
      // The broker-wide build chain only waits for the envelope to be queued
      // to each subscription's serial delivery chain. Wait for the temporary
      // probe subscription's own chain so deferred/delayed listeners have
      // actually run before asserting delivery.
      const probeSubscription = [...state.subscriptions].find(subscription => subscription.probe === true)
      if (probeSubscription !== undefined) await probeSubscription.chain
      if (received.length !== 1 || received[0]?.payload.kind !== 'message.received') {
        throw new Error(`temporary subscription did not receive one delivered envelope (got ${received.length})`)
      }
      release()
      const after = state.subscriptions.size
      if (after !== before) {
        throw new Error(`temporary subscription leaked (${before} -> ${during} -> ${after})`)
      }
      return Object.freeze({
        service: 'tuiMessageObserver',
        ok: true,
        before,
        during,
        after,
        delivered: received.length,
      })
    } finally {
      release()
      // Defensive: a probe failure must never leave a broker entry behind.
      for (const subscription of [...state.subscriptions]) {
        if (subscription.probe) state.subscriptions.delete(subscription)
      }
    }
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
    assertCapabilityShadowPolicy('host.messages.subscribe', observerStateFor(this).runtime.mode, observerStateFor(this).runtime.slices)
    const caller = activationContext(pluginCtx)
    if (caller === undefined) throw new Error('dsh-tui: messages.observe.subscribe requires a live activation context')
    assertCallerContext(this.ctx, caller, 'messages.observe.subscribe', this)
    const identity = requireComponentIdentity(caller)
    const plugin = identity.componentId
    if (!requiresContract(identity, 'messages.dsh/v1alpha1', 'MessageObserver')) {
      observerStateFor(this).hostContext.logger.warn(
        `dsh-tui: messages.observe subscription from Component "${plugin}" denied — ` +
        'the messages.dsh/v1alpha1#MessageObserver contract was not required',
      )
      return () => false
    }
    const scope = typeof options?.scope === 'string' ? options.scope : ''
    if (scope === '' || scope.length > OBSERVE_SCOPE_MAX_CHARS) {
      observerStateFor(this).hostContext.logger.warn(
        `dsh-tui: messages.observe subscription from plugin "${plugin}" refused — options.scope must be a ` +
        `non-empty string of at most ${OBSERVE_SCOPE_MAX_CHARS} characters (e.g. "session:<id>")`,
      )
      return () => false
    }
    const self = concreteService(this) as TuiMessageObserverRuntime
    return self.#registerSubscription(
      caller,
      identity,
      plugin,
      scope,
      listener,
      { enforceGrants: true, recordLedger: true, bindLifecycle: true },
    )
  }

  /**
   * Shared production subscription registration used by the public
   * `subscribe()` surface and the reversible live probe. When
   * `enforceGrants` is true, the full static-declaration and live-grant
   * checks run exactly as in the public path; the probe sets it to false for
   * an internal temporary identity and marks the subscription as `probe` so
   * delivery can bypass the caller grant re-check.
   */
  #registerSubscription(
    ownerContext: Context,
    identity: VerifiedComponentIdentity,
    plugin: string,
    scope: string,
    listener: MessagesObserveListener,
    options: { readonly enforceGrants: boolean; readonly recordLedger: boolean; readonly bindLifecycle: boolean },
  ): () => boolean {
    if (typeof listener !== 'function'
      || (options.enforceGrants
        && (!declaresObserverScope(identity, scope)
          || !declaresPermission(identity, 'messages.observe.read', scope)
          || !this.grants().allows(
            { componentId: identity.componentId, activationId: identity.activationId },
            'messages.observe.read',
            scope,
          )))) {
      observerStateFor(this).hostContext.logger.warn(
        `dsh-tui: messages.observe subscription from Component "${plugin}" denied — ` +
        'the scope is not statically declared or the current grant does not cover it; the listener was NOT registered',
      )
      if (options.recordLedger) {
        this.ledger()?.record(
          {
            operation: 'bind',
            resource: { kind: 'permission', id: 'messages.observe.read' },
            result: 'failed',
            errorCode: 'PERMISSION_NOT_GRANTED',
          },
          ownerContext,
        )
      }
      return () => false
    }
    const subscription: Subscription = {
      plugin,
      identity,
      ownerContext,
      scope,
      listener,
      chain: Promise.resolve(),
      pendingCallbacks: 0,
      closed: false,
      ...(options.enforceGrants ? {} : { probe: true }),
    }
    observerStateFor(this).subscriptions.add(subscription)
    if (options.recordLedger) {
      this.ledger()?.record(
        { operation: 'bind', resource: { kind: 'subscription', id: plugin }, result: 'applied' },
        ownerContext,
      )
    }
    const release = (): boolean => {
      if (subscription.closed) return false
      this.drop(subscription)
      return true
    }
    if (options.enforceGrants) {
      subscription.stopGrantWatch = this.grants().onChange?.(() => {
        if (!this.grants().allows(
          { componentId: identity.componentId, activationId: identity.activationId },
          'messages.observe.read',
          scope,
        )) release()
      })
    }
    if (options.bindLifecycle) bindCallerEffect(ownerContext, release)
    return release
  }

  #publishGuarded(session: unknown, event: unknown, probeOnly = false): void {
    const state = observerStateFor(this)
    if (state.subscriptions.size === 0) return
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
      observerStateFor(this).hostContext.logger.warn('dsh-tui: messages.observe publish skipped — the session carries no string id')
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
      observerStateFor(this).hostContext.logger.warn(
        `dsh-tui: messages.observe publish skipped — the session scope exceeds ${OBSERVE_SCOPE_MAX_CHARS} characters`,
      )
      return
    }
    // C-042 isolation: match subscriptions BEFORE building anything — a
    // subscription for another scope must never see this scope's content.
    const matched = [...state.subscriptions].filter(subscription =>
      !subscription.closed
      && (probeOnly ? subscription.probe === true : subscription.probe !== true)
      && observerScopeCovers(subscription.scope, scope))
    if (matched.length === 0) return

    // Builds serialize broker-wide so delivery order stays the publish
    // order even though image reads are async (sequence stays monotonic).
    state.buildChain = state.buildChain.then(() => this.buildAndDeliver(kind, sessionId, scope, record.seq as number, message, matched))
  }

  private async buildAndDeliver(
    kind: 'message.received' | 'message.sent',
    sessionId: string,
    scope: string,
    sequence: number,
    message: { id?: unknown; content?: unknown } | undefined,
    matched: Subscription[],
  ): Promise<void> {
    const state = observerStateFor(this)
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
      if (state.validatorUnavailable) {
        if (!state.validatorWarned) {
          state.validatorWarned = true
          observerStateFor(this).hostContext.logger.warn('dsh-tui: standard message envelope validator unavailable — delivery is fail-closed')
        }
        return
      }
      try {
        state.validateEnvelope(envelope)
      } catch (error) {
        observerStateFor(this).hostContext.logger.warn(
          'dsh-tui: messages.observe envelope failed the standard validator and was dropped',
        )
        return
      }

      for (const subscription of matched) {
        if (subscription.closed) continue
        // Deliver-time grant re-check: a revoked grant RELEASES the
        // subscription (contract cleanup rule), with one warning. Internal
        // probe subscriptions bypass this re-check because they are synthetic
        // and never represent a real caller grant.
        if (!subscription.probe && !this.grants().allows(
          { componentId: subscription.identity.componentId, activationId: subscription.identity.activationId },
          'messages.observe.read',
          scope,
        )) {
          observerStateFor(this).hostContext.logger.warn(
            `dsh-tui: messages.observe subscription of plugin "${subscription.plugin}" released — the grant was revoked`,
          )
          this.drop(subscription)
          continue
        }
        if (subscription.pendingCallbacks >= OBSERVE_CALLBACK_QUEUE_LIMIT) {
          observerStateFor(this).hostContext.logger.warn(
            `dsh-tui: messages.observe listener of Component "${subscription.plugin}" reached its ` +
            `${OBSERVE_CALLBACK_QUEUE_LIMIT}-callback queue limit; this envelope was skipped`,
          )
          continue
        }
        subscription.pendingCallbacks += 1
        const run = subscription.chain.then(async () => {
          if (subscription.closed) return
          // Re-check at the actual callback boundary as well as at enqueue
          // time. A grant may be revoked while an earlier callback is still
          // running; queued envelopes must then be skipped rather than
          // delivered from the stale pre-revocation snapshot.
          if (!subscription.probe && !this.grants().allows(
            { componentId: subscription.identity.componentId, activationId: subscription.identity.activationId },
            'messages.observe.read',
            scope,
          )) {
            observerStateFor(this).hostContext.logger.warn(
              `dsh-tui: messages.observe subscription of plugin "${subscription.plugin}" released — the grant was revoked`,
            )
            this.drop(subscription)
            return
          }
          const isolated = freezeEnvelope(envelope)
          const result = await runWithBudget(
            () => subscription.listener(isolated),
            OBSERVE_CALLBACK_TIMEOUT_MS,
          )
          if (result.kind === 'timeout') {
            observerStateFor(this).hostContext.logger.warn(
              `dsh-tui: messages.observe listener of Component "${subscription.plugin}" exceeded ` +
              `${OBSERVE_CALLBACK_TIMEOUT_MS}ms and the subscription was closed`,
            )
            this.drop(subscription)
          } else if (result.kind === 'rejected') {
            observerStateFor(this).hostContext.logger.warn(
              `dsh-tui: messages.observe listener of Component "${subscription.plugin}" failed; delivery continues`,
            )
          }
        })
        subscription.chain = run.catch(error => {
          observerStateFor(this).hostContext.logger.warn('dsh-tui: messages.observe delivery failed')
        }).finally(() => { subscription.pendingCallbacks -= 1 })
      }
    } catch (error) {
      observerStateFor(this).hostContext.logger.warn(
        'dsh-tui: messages.observe publish failed (event dropped)',
      )
    }
  }

  /** Release a subscription exactly once (disposer, ctx unload, revoke). */
  private drop(subscription: Subscription): void {
    if (subscription.closed) return
    subscription.closed = true
    subscription.stopGrantWatch?.()
    subscription.stopGrantWatch = undefined
    observerStateFor(this).subscriptions.delete(subscription)
    if (!subscription.probe) {
      this.ledger()?.record(
        { operation: 'release', resource: { kind: 'subscription', id: subscription.plugin }, result: 'applied' },
        subscription.ownerContext,
      )
    }
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
      const reader = observerStateFor(this).hostContext.get('attachments') as ObserveAttachmentReader | undefined
      if (typeof reader?.readImage !== 'function') return undefined
      // A failing read drops ONLY this image (the envelope survives with the
      // truncation mark) — one corrupt attachment must not nuke the message.
      let timer: ReturnType<typeof setTimeout> | undefined
      const read = Promise.resolve().then(() => reader.readImage(attachment))
      const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), OBSERVE_IMAGE_READ_TIMEOUT_MS)
      })
      const stored = await Promise.race([read, timeout])
      if (timer !== undefined) clearTimeout(timer)
      // `read` has an attached rejection handler through the race's promise
      // chain; late completion after a timeout is deliberately ignored.
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

/** Host-only ingress accessor; deliberately omitted from `./plugin-host`. */
const hostMessageObservers = new WeakMap<TuiMessageObserverRuntime, TuiMessageObserverHost>()

export function getHostMessageObserver(runtime: TuiMessageObserverRuntime | undefined): TuiMessageObserverHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostMessageObservers.get(concreteService(runtime))
  } catch {
    return undefined
  }
}

interface ObserverState {
  readonly hostContext: Context
  readonly grantsOption: GrantStore | undefined
  readonly fallbackGrants: GrantStore
  readonly ledgerOption: TuiEffectLedgerRuntime | undefined
  readonly runtime: AdapterRuntimeOptions
  readonly subscriptions: Set<Subscription>
  validateEnvelope: (value: unknown) => void
  validatorUnavailable: boolean
  validatorWarned: boolean
  buildChain: Promise<unknown>
}

const observerStates = new WeakMap<TuiMessageObserverRuntime, ObserverState>()

function observerStateFor(runtime: TuiMessageObserverRuntime): ObserverState {
  const state = observerStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiMessageObserver host state is unavailable')
  return state
}
