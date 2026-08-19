/**
 * RFC 0005 D-7 enforcement: subscribing to an intercept-class (decision)
 * event requires an explicit host-side grant — default deny.
 *
 * Interception is strictly more powerful than observation: a plugin that can
 * veto user input or a session switch can change what the user's intent
 * actually does. So `tui/input`, `tui/rewind-prompt`, `tui/session-switch`
 * and `tui/compact` are NOT free-for-all `ctx.on` targets: the subscribing
 * plugin (identified by its verified Component identity) must hold the
 * matching `domain.resource.intercept` grant. Grant answers
 * come from the unified 8-permission GrantStore in ./grants.js (registry-
 * driven defaults, `grants`/`denies` sections, corrupt fail-closed) — this
 * module is only the subscribe-time CHECKPOINT: which event needs which
 * permission, and the cordis bail hook that enforces it.
 *
 * A denied subscription never enters the dispatch chain — it is "as if
 * unregistered" (D-7) and the caller gets a no-op disposer plus a logger
 * warning naming the plugin, the event, and the missing grant.
 *
 * Re-check semantics (D-7: subscription, revocation, scope change): every
 * operation reads the live GrantStore and grant-owned registrations are
 * released when its change watcher observes a revocation.
 *
 * Mechanism: cordis bails `internal/listener` on EVERY `ctx.on` before
 * registering, with `this` bound to the subscribing context; a truthy bail
 * result skips the registration and becomes the caller's disposer. That is
 * the whole hook — no patching of the events service.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  EXTENSION_GRANTS_FILE,
  parseGrantStore,
  readGrantStore,
  type GrantStore,
} from './grants.js'
import {
  componentIdentityOf,
  requireComponentIdentity,
  requiresDecisionEvents,
  type VerifiedComponentIdentity,
} from './component-identity.js'
import {
  INTERCEPT_EVENT_SCOPE_BY_PERMISSION,
  normalizePermissionScope,
  permissionScopeCovers,
} from '../plugin-spec/permission-scope.js'
import { TUI_DECISION_EVENT_NAMES } from '../plugin-spec/tui-extension.js'
import { bindCallerEffect, compositionRoot } from './host-access.js'

/** The intercept permission each decision event requires (D-7 naming:
 *  `domain.resource.intercept`). Observe-class events (tui/rewind-done,
 *  tui/session-switched) are deliberately absent. */
export const DECISION_EVENT_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  'tui/input': 'session.input.intercept',
  'tui/rewind-prompt': 'session.rewind.intercept',
  'tui/session-switch': 'session.switch.intercept',
  'tui/compact': 'session.compact.intercept',
})

// ── Compatibility aliases (pre-GrantStore names) ────────────────────────────
// The grant-file format and these entry points predate the unified store;
// keep them working — verify batteries and any embedder code import them
// from this module.
export { EXTENSION_GRANTS_FILE }

/** @deprecated Use GrantStore from ./grants.js (same shape, plus more). */
export type ExtensionGrants = GrantStore

/** @deprecated Use parseGrantStore from ./grants.js. */
export const parseExtensionGrants: (text: string) => GrantStore = parseGrantStore

/** @deprecated Use readGrantStore from ./grants.js. */
export const readExtensionGrants: (dir?: string) => GrantStore = readGrantStore

/**
 * Install the D-7 gate: every subscription to a decision event is checked
 * against `grants` at subscribe time. Registered with `global` so context
 * filtering can never hide a plugin's subscription from the gate, and
 * `prepend` so it decides before any later internal/listener hook.
 *
 * Idempotent per cordis root: BOTH the extensions row and createChannel
 * call this — the channel is the dispatch path, so a stale patch without
 * the extensions row (or a bare embed mounting neither) must not leave
 * decision events subscribable-by-default. The first installer wins; both
 * production call sites read the same host-owned grants file, so which one
 * lands first is unobservable.
 */
const guardedRoots = new WeakSet<object>()
export interface DecisionHandlerMetadata {
  componentId: string
  activationId: string
  event: string
  order: string
}
const handlerMetadata = new WeakMap<Function, DecisionHandlerMetadata>()

/** A host-mediated DecisionEvents registration.  The registry is deliberately
 * separate from Cordis' private `_hooks`: admission and dispatch must not
 * depend on plugin load order or on an implementation detail of the event
 * service. */
export interface DecisionRegistrationOptions {
  /** Scope covered by this handler. When omitted it is derived from the
   * manifest declaration; an unsafe concrete-session declaration is refused. */
  scope?: string
  /** Deterministic order key. Handlers with the same activation/event must use
   * distinct keys; registration order is never used as a policy. */
  order?: string
}

export interface RegisteredDecisionHandler {
  readonly event: string
  readonly scope: string
  readonly componentId: string
  readonly activationId: string
  readonly order: string
  readonly identity: VerifiedComponentIdentity
  readonly ownerContext: Context
  readonly listener: (payload: Record<string, unknown>) => unknown
}

export interface DecisionRegistry {
  grants: GrantStore
  handlers: Map<string, Map<string, RegisteredDecisionHandler>>
}

const registries = new WeakMap<object, DecisionRegistry>()

function rootKey(ctx: Context): object {
  return compositionRoot(ctx) as unknown as object
}

function registryFor(ctx: Context, grants?: GrantStore): DecisionRegistry {
  const key = rootKey(ctx)
  let registry = registries.get(key)
  if (registry === undefined) {
    registry = { grants: grants ?? readGrantStore(), handlers: new Map() }
    registries.set(key, registry)
  } else if (grants !== undefined) {
    registry.grants = grants
  }
  return registry
}

export function decisionRegistryOf(ctx: Context): DecisionRegistry {
  return registryFor(ctx)
}

/** Return a stable snapshot of handlers for one event and payload scope. */
export function decisionHandlersOf(
  ctx: Context,
  event: string,
  payloadScope?: string,
): readonly RegisteredDecisionHandler[] {
  const rows = [...(registryFor(ctx).handlers.get(event)?.values() ?? [])]
  const permission = eventPermission(event)
  const scopePermission = permission ?? 'messages.observe.read'
  const actual = typeof payloadScope === 'string'
    ? normalizePermissionScope(scopePermission, payloadScope, 'host')
    : undefined
  return rows
    .filter(row => {
      const declared = normalizeDecisionScope(event, row.scope, 'host')
      // A session-scoped handler cannot be safely applied when the host did
      // not provide a session scope. Treat the missing scope as an
      // unmatchable request instead of turning a narrow grant into a global
      // one. Event-point scopes remain applicable because they deliberately
      // cover every session.
      if (actual === undefined) return declared?.kind === 'event'
      // An event-name scope (for example `tui/input`) selects the Decision
      // Events point, not one session. It therefore applies to every payload
      // session; only session-kind scopes participate in session filtering.
      return declared?.kind === 'event' && declared.value === event
        || (declared !== undefined && permissionScopeCovers(scopePermission, declared, actual))
    })
    .sort((left, right) => {
      const order = compareStableText(left.order, right.order)
      if (order !== 0) return order
      const component = compareStableText(left.componentId, right.componentId)
      if (component !== 0) return component
      return compareStableText(left.activationId, right.activationId)
    })
}

function eventPermission(event: string): string | undefined {
  return DECISION_EVENT_PERMISSIONS[event]
}

/** Normalize a handler scope against its actual event point. Notification
 * points have no intercept permission, but still support event/session scopes
 * for deterministic delivery filtering. */
function normalizeDecisionScope(
  event: string,
  scope: string,
  componentId: string,
): ReturnType<typeof normalizePermissionScope> {
  const permission = eventPermission(event)
  if (permission !== undefined) return normalizePermissionScope(permission, scope, componentId)
  if (scope === event) return { kind: 'event', value: event }
  return normalizePermissionScope('messages.observe.read', scope, componentId)
}

/** Pick a scope for a legacy-looking `ctx.on(event, listener)` call without
 * widening a concrete declaration. */
function defaultDecisionScope(identity: VerifiedComponentIdentity, event: string): string | undefined {
  const permission = eventPermission(event)
  if (permission === undefined) return event
  const expectedEvent = INTERCEPT_EVENT_SCOPE_BY_PERMISSION[permission]
  const requests = identity.manifest.permissions.filter(request => request.name === permission)
  if (requests.some(request => request.scope === expectedEvent)) return expectedEvent
  if (requests.some(request => {
    const normalized = normalizePermissionScope(permission, request.scope, identity.componentId)
    return normalized?.kind === 'session' && normalized.value === 'session:*'
  })) return 'session:*'
  // A concrete session grant cannot safely be inferred for a context-level
  // listener. The caller must pass that scope explicitly through the mediated
  // API, otherwise registration is refused.
  return undefined
}

/** Host-only registration used by TuiPluginHostRuntime. */
export function registerDecisionHandler(
  pluginCtx: Context,
  identity: VerifiedComponentIdentity,
  event: string,
  listener: (payload: Record<string, unknown>) => unknown,
  options: DecisionRegistrationOptions = {},
  onRelease?: () => void,
): () => boolean {
  if (componentIdentityOf(pluginCtx) !== identity) {
    throw new Error('DecisionEvents registration identity is not bound to the calling activation')
  }
  if (!requiresDecisionEvents(identity)) {
    throw new Error('DecisionEvents registration requires tui.dsh/v1alpha1#DecisionEvents')
  }
  if (!TUI_DECISION_EVENT_NAMES.includes(event as typeof TUI_DECISION_EVENT_NAMES[number])) {
    throw new TypeError(`unknown TUI DecisionEvents point: ${event}`)
  }
  if (typeof listener !== 'function') throw new TypeError('DecisionEvents handler must be a function')
  const scope = options.scope ?? defaultDecisionScope(identity, event)
  if (scope === undefined) {
    throw new Error(`DecisionEvents scope for ${event} must be explicit when the manifest only declares a concrete session scope`)
  }
  const normalizedScope = normalizeDecisionScope(event, scope, identity.componentId)
  if (normalizedScope === undefined) throw new TypeError(`DecisionEvents scope is not enforceable: ${scope}`)
  const permission = eventPermission(event)
  const staticallyDeclared = permission === undefined
    ? normalizedScope.kind === 'event' && normalizedScope.value === event
    : identity.manifest.permissions.some(request => {
      if (request.name !== permission) return false
      const declared = normalizePermissionScope(permission, request.scope, identity.componentId)
      return declared !== undefined && permissionScopeCovers(permission, declared, normalizedScope)
    })
  if (!staticallyDeclared) {
    throw new Error(`DecisionEvents permission ${permission}@${scope} is not statically declared by ${identity.componentId}`)
  }
  const registry = registryFor(pluginCtx)
  const principal = { componentId: identity.componentId, activationId: identity.activationId }
  const currentlyGranted = permission === undefined || registry.grants.allows(principal, permission, scope)
  if (!currentlyGranted) {
    try { pluginCtx.logger.warn(`dsh-tui: ${event} registration denied for Component "${identity.componentId}" — grant ${permission}@${scope} is missing`) } catch { /* best effort */ }
    return () => false
  }
  const order = options.order ?? identity.componentId
  if (order === '' || /[\x00-\x1f\x7f-\x9f]/u.test(order)) {
    throw new TypeError('DecisionEvents order must be a non-empty control-free string')
  }
  const key = `${identity.activationId}\0${event}\0${order}`
  const byActivation = registry.handlers.get(event) ?? new Map<string, RegisteredDecisionHandler>()
  if (byActivation.has(key)) throw new Error(`DecisionEvents order is already registered for this activation/event: ${event}@${order}`)
  const row: RegisteredDecisionHandler = Object.freeze({
    event,
    scope,
    componentId: identity.componentId,
    activationId: identity.activationId,
    order,
    identity,
    ownerContext: pluginCtx,
    listener,
  })
  byActivation.set(key, row)
  handlerMetadata.set(listener, {
    componentId: identity.componentId,
    activationId: identity.activationId,
    event,
    order,
  })
  registry.handlers.set(event, byActivation)
  let closed = false
  let stopGrantWatch: (() => void) | undefined
  const release = (): boolean => {
    if (closed) return false
    closed = true
    stopGrantWatch?.()
    stopGrantWatch = undefined
    if (byActivation.get(key) === row) byActivation.delete(key)
    if (handlerMetadata.get(listener)?.activationId === identity.activationId
      && handlerMetadata.get(listener)?.event === event
      && handlerMetadata.get(listener)?.order === order) handlerMetadata.delete(listener)
    try {
      onRelease?.()
    } catch {
      // The registry has already released the effect. Observability failures
      // must not turn a revoke/deactivate cleanup into a leaked handler.
    }
    return true
  }
  // Both deactivation and grant-file revocation are release boundaries. Bind
  // through the host-captured Fiber effect so an explicit Context shadow
  // cannot replace the cleanup function.
  bindCallerEffect(pluginCtx, release)
  if (permission !== undefined) {
    const stop = registry.grants.onChange?.(() => {
      const principal = { componentId: identity.componentId, activationId: identity.activationId }
      if (!registry.grants.allows(principal, permission, scope)) release()
    })
    stopGrantWatch = stop
    if (stop !== undefined) {
      bindCallerEffect(pluginCtx, stop)
    }
  }
  return release
}

/** Locale-independent comparator for the declared decision order policy.
 * `localeCompare()` can vary with host ICU settings, which would make the
 * winner depend on the machine running the same admitted component set. */
function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fiberKey(ctx: Context): object | undefined {
  try {
    const fiber: unknown = ctx.fiber
    return typeof fiber === 'object' && fiber !== null ? fiber : undefined
  } catch {
    return undefined
  }
}

/** Execute ctx.on for one host-mediated decision registration. */
export function withDecisionRegistration<T>(ctx: Context, callback: () => T): T {
  const fiber = fiberKey(ctx)
  if (fiber === undefined) throw new Error('decision registration requires a Cordis activation')
  return callback()
}

export function decisionHandlerMetadataOf(listener: Function): DecisionHandlerMetadata | undefined {
  return handlerMetadata.get(listener)
}

export function installDecisionGuard(ctx: Context, grants: GrantStore): void {
  // Degraded/fake contexts (minimal embedders, test harnesses) may lack
  // `root` or `on` entirely — the gate is best-effort there, matching the
  // channel's soft-degradation posture: no dedup bookkeeping without a root
  // object, no hook without an `on`.
  const root: unknown = compositionRoot(ctx)
  // Keep the live grant source even when another row installed the Cordis
  // hook first.  The file-backed GrantStore evaluates each operation again.
  registryFor(ctx, grants)
  if (typeof root === 'object' && root !== null) {
    if (guardedRoots.has(root)) return
    guardedRoots.add(root)
  }
  if (typeof (ctx as { on?: unknown }).on !== 'function') return
  ctx.on('internal/listener', function (this: Context, name: unknown, listener: unknown): (() => boolean) | undefined {
    if (typeof name !== 'string') return undefined
    const permission = DECISION_EVENT_PERMISSIONS[name]
    if (permission === undefined && !TUI_DECISION_EVENT_NAMES.includes(name as typeof TUI_DECISION_EVENT_NAMES[number])) return undefined
    // `this` is the SUBSCRIBING context (cordis binds internal/listener
    // hooks to it). A fiber name is used below only for a refusal diagnostic;
    // authorization always comes from the verified Component identity.
    let pluginName = 'root'
    try {
      const resolved: unknown = this.fiber?.name
      if (typeof resolved === 'string' && resolved !== '') pluginName = resolved
    } catch {
      // A degraded context without fiber access: fall back to 'root'.
    }
    const identity = componentIdentityOf(this)
    // The public Cordis surface remains usable, but it is mediated into the
    // same registry as subscribeDecision: a verified Component, static
    // DecisionEvents requirement, normalized scope and live grant are all
    // required before the raw listener is ever visible to dispatch. Cordis
    // treats a truthy internal/listener result as a bail/disposer, so returning
    // the registry release function prevents a second unmediated registration.
    if (identity !== undefined && typeof listener === 'function') {
      try {
        return registerDecisionHandler(
          this,
          identity,
          name,
          listener as (payload: Record<string, unknown>) => unknown,
          {},
        )
      } catch (error) {
        try {
          this.logger.warn(
            `dsh-tui: ${name} subscription from Component "${identity.componentId}" denied — ` +
            `${error instanceof Error ? error.message : String(error)}`,
          )
        } catch { /* best effort */ }
        return () => false
      }
    }
    const requiredGrant = permission === undefined ? '' : `; required grant ${permission}`
    ctx.logger.warn(
      `dsh-tui: ${name} direct subscription from Component "${pluginName}" denied${requiredGrant} — ` +
      'use the mediated DecisionEvents activation surface; the listener was NOT registered',
    )
    // Truthy bail result: cordis skips the registration and hands this back
    // as the caller's disposer — a no-op keeps the ctx.on contract intact.
    return () => false
  }, { global: true, prepend: true })
}
