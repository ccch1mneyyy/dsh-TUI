/**
 * RFC 0005 D-7 enforcement: subscribing to an intercept-class (decision)
 * event requires an explicit host-side grant — default deny.
 *
 * Interception is strictly more powerful than observation: a plugin that can
 * veto user input or a session switch can change what the user's intent
 * actually does. So `tui/input`, `tui/rewind-prompt`, `tui/session-switch`
 * and `tui/compact` are NOT free-for-all `ctx.on` targets: the subscribing
 * plugin (identified by its cordis context name — the row's `name` export)
 * must hold the matching `domain.resource.intercept` grant in the
 * host-owned grants file `~/.dsh-tui/extension-grants.json`:
 *
 * ```json
 * {
 *   "grants": {
 *     "my-guard": ["session.input.intercept", "session.switch.intercept"]
 *   }
 * }
 * ```
 *
 * A denied subscription never enters the dispatch chain — it is "as if
 * unregistered" (D-7) and the caller gets a no-op disposer plus a logger
 * warning naming the plugin, the event, and the missing grant.
 *
 * Re-check semantics (D-7: subscription, revocation, scope change): the
 * grants file is read once when the extensions row mounts, so revocation is
 * a restart — every subscription is checked at subscribe time, and a scope
 * change (plugin fiber reload) re-subscribes and is checked again. The file
 * is host-owned and read-only at runtime BY DESIGN: there is no in-session
 * mutation API to race against.
 *
 * Mechanism: cordis bails `internal/listener` on EVERY `ctx.on` before
 * registering, with `this` bound to the subscribing context; a truthy bail
 * result skips the registration and becomes the caller's disposer. That is
 * the whole hook — no patching of the events service.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DATA_DIR } from '../utils/paths.js'

/** The intercept permission each decision event requires (D-7 naming:
 *  `domain.resource.intercept`). Observe-class events (tui/rewind-done,
 *  tui/session-switched) are deliberately absent. */
export const DECISION_EVENT_PERMISSIONS: Readonly<Record<string, string>> = {
  'tui/input': 'session.input.intercept',
  'tui/rewind-prompt': 'session.rewind.intercept',
  'tui/session-switch': 'session.switch.intercept',
  'tui/compact': 'session.compact.intercept',
}

/** The grants file consulted by {@link readExtensionGrants}. */
export const EXTENSION_GRANTS_FILE = 'extension-grants.json'

export interface ExtensionGrants {
  /** True when `plugin` (cordis context name) holds `permission`. */
  allows(plugin: string, permission: string): boolean
}

/**
 * Parse the grants file; anything malformed yields a deny-all map (a
 * corrupt grants file must fail CLOSED, never open).
 * @param text - Raw file contents.
 */
export function parseExtensionGrants(text: string): ExtensionGrants {
  const table = new Map<string, ReadonlySet<string>>()
  try {
    const parsed: unknown = JSON.parse(text)
    const grants = (parsed as { grants?: unknown } | null)?.grants
    if (grants !== null && typeof grants === 'object' && !Array.isArray(grants)) {
      for (const [plugin, permissions] of Object.entries(grants as Record<string, unknown>)) {
        if (!Array.isArray(permissions)) continue
        table.set(plugin, new Set(permissions.filter((entry): entry is string => typeof entry === 'string')))
      }
    }
  } catch {
    // Fall through with the empty (deny-all) table.
  }
  return {
    allows: (plugin, permission) => table.get(plugin)?.has(permission) === true,
  }
}

/**
 * Read `extension-grants.json` from the data dir. A missing file is an
 * empty (deny-all) map — the default posture before any grant exists.
 * @param dir - Data directory (injectable for tests).
 */
export function readExtensionGrants(dir: string = DATA_DIR): ExtensionGrants {
  try {
    return parseExtensionGrants(readFileSync(join(dir, EXTENSION_GRANTS_FILE), 'utf8'))
  } catch {
    return parseExtensionGrants('')
  }
}

/**
 * Install the D-7 gate: every subscription to a decision event is checked
 * against `grants` at subscribe time. Registered with `global` so context
 * filtering can never hide a plugin's subscription from the gate, and
 * `prepend` so it decides before any later internal/listener hook.
 */
export function installDecisionGuard(ctx: Context, grants: ExtensionGrants): void {
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
