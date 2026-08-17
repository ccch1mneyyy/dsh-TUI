/**
 * RFC 0005 D-7 enforcement: subscribing to an intercept-class (decision)
 * event requires an explicit host-side grant — default deny.
 *
 * Interception is strictly more powerful than observation: a plugin that can
 * veto user input or a session switch can change what the user's intent
 * actually does. So `tui/input`, `tui/rewind-prompt`, `tui/session-switch`
 * and `tui/compact` are NOT free-for-all `ctx.on` targets: the subscribing
 * plugin (identified by its cordis context name — the row's `name` export)
 * must hold the matching `domain.resource.intercept` grant. Grant answers
 * come from the unified 8-permission GrantStore in ./grants.js (registry-
 * driven defaults, `grants`/`denies` sections, corrupt fail-closed) — this
 * module is only the subscribe-time CHECKPOINT: which event needs which
 * permission, and the cordis bail hook that enforces it.
 *
 * A denied subscription never enters the dispatch chain — it is "as if
 * unregistered" (D-7) and the caller gets a no-op disposer plus a logger
 * warning naming the plugin, the event, and the missing grant.
 *
 * Re-check semantics (D-7: subscription, revocation, scope change): the
 * grants file is read once when the gate is installed (the extensions row
 * or the channel, whichever mounts first — see installDecisionGuard), so
 * revocation is a restart — every subscription is checked at subscribe
 * time, and a scope change (plugin fiber reload) re-subscribes and is
 * checked again. The file is host-owned and read-only at runtime BY
 * DESIGN: there is no in-session mutation API to race against.
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

/** The intercept permission each decision event requires (D-7 naming:
 *  `domain.resource.intercept`). Observe-class events (tui/rewind-done,
 *  tui/session-switched) are deliberately absent. */
export const DECISION_EVENT_PERMISSIONS: Readonly<Record<string, string>> = {
  'tui/input': 'session.input.intercept',
  'tui/rewind-prompt': 'session.rewind.intercept',
  'tui/session-switch': 'session.switch.intercept',
  'tui/compact': 'session.compact.intercept',
}

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

export function installDecisionGuard(ctx: Context, grants: GrantStore): void {
  // Degraded/fake contexts (minimal embedders, test harnesses) may lack
  // `root` or `on` entirely — the gate is best-effort there, matching the
  // channel's soft-degradation posture: no dedup bookkeeping without a root
  // object, no hook without an `on`.
  const root: unknown = (ctx as { root?: unknown }).root ?? ctx
  if (typeof root === 'object' && root !== null) {
    if (guardedRoots.has(root)) return
    guardedRoots.add(root)
  }
  if (typeof (ctx as { on?: unknown }).on !== 'function') return
  ctx.on('internal/listener', function (this: Context, name: unknown): (() => boolean) | undefined {
    if (typeof name !== 'string') return undefined
    const permission = DECISION_EVENT_PERMISSIONS[name]
    if (permission === undefined) return undefined
    // `this` is the SUBSCRIBING context (cordis binds internal/listener
    // hooks to it). The plugin's display name lives on its FIBER
    // (`ctx.fiber.name` — nearest named ancestor runtime, else 'root');
    // the bare `ctx.name` property does not exist on the context proxy.
    let pluginName = 'root'
    try {
      const resolved: unknown = this.fiber?.name
      if (typeof resolved === 'string' && resolved !== '') pluginName = resolved
    } catch {
      // A degraded context without fiber access: fall back to 'root'.
    }
    if (grants.allows(pluginName, permission)) return undefined
    ctx.logger.warn(
      `dsh-tui: ${name} subscription from plugin "${pluginName}" denied — intercept events require an explicit grant ` +
      `("${permission}" for "${pluginName}" in ~/.dsh-tui/extension-grants.json, RFC 0005 D-7); ` +
      'the listener was NOT registered',
    )
    // Truthy bail result: cordis skips the registration and hands this back
    // as the caller's disposer — a no-op keeps the ctx.on contract intact.
    return () => false
  }, { global: true, prepend: true })
}
