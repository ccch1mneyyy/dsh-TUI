/**
 * Command ownership attribution — the data source for the C-041 invoke
 * checkpoint's per-owner grant decision.
 *
 * dsh-commands has NO owner concept (its `normalizeDefinition` rebuilds a
 * frozen object and drops unknown fields, and its scoped layers key by
 * agent, not by registrant), and neither realistic access path can carry
 * the caller's identity to `register` for us: `ctx.get('commands')` is an
 * accessor that bypasses cordis's `internal/get` waterfall, and an
 * inject-declared property read resolves before it. So attribution does
 * NOT try to spy on the registry — it is a MEDIATED REGISTRATION surface,
 * the same honest-identity pattern as storage.local / messages.observe:
 * the plugin-host row's `registerCommand(pluginCtx, definition)` stamps
 * `name → pluginCtx.fiber.name` here on success, and the returned disposer
 * lifts the stamp.
 *
 * A plugin that registers directly through `ctx.get('commands')` keeps its
 * command UNATTRIBUTED: the invoke checkpoint then applies the root grant
 * only — the documented C-070 trusted-in-process boundary, exactly like a
 * plugin calling `ctx.commands.execute` directly. Attribution only ever
 * TIGHTENS the check, never widens it.
 *
 * The map is keyed by the cordis ROOT so the row and the channel (two
 * different contexts of one runtime) share one view.
 */

import type { Context } from '@deepseek-ai/cordis'

const ownerMaps = new WeakMap<object, Map<string, string>>()

function rootKeyOf(ctx: Context): object | undefined {
  const root: unknown = (ctx as { root?: unknown }).root ?? ctx
  return typeof root === 'object' && root !== null ? root : undefined
}

/** The registrant's display name: the passed context's fiber.name (nearest
 *  named ancestor), 'root' for host-side or degraded contexts. */
export function fiberNameOf(ctx: Context): string {
  try {
    const resolved: unknown = ctx.fiber?.name
    if (typeof resolved === 'string' && resolved !== '') return resolved
  } catch {
    // Degraded context without fiber access: 'root'.
  }
  return 'root'
}

/** Record `name → owner` after a successful mediated registration. */
export function stampCommandOwner(ctx: Context, name: string, owner: string): void {
  const key = rootKeyOf(ctx)
  if (key === undefined) return
  let map = ownerMaps.get(key)
  if (map === undefined) {
    map = new Map()
    ownerMaps.set(key, map)
  }
  map.set(name, owner)
}

/** Lift the stamp — only while it still names THIS owner (a later same-name
 *  registration elsewhere must survive our disposer). */
export function unstampCommandOwner(ctx: Context, name: string, owner: string): void {
  const key = rootKeyOf(ctx)
  if (key === undefined) return
  const map = ownerMaps.get(key)
  if (map?.get(name) === owner) map.delete(name)
}

/**
 * The recorded owner (fiber name) of a registered command, or undefined
 * when the command is unattributed (root-side registrations never stamp;
 * direct ctx.get registrations are the documented C-070 bypass).
 */
export function commandOwner(ctx: Context, name: string): string | undefined {
  const key = rootKeyOf(ctx)
  if (key === undefined) return undefined
  return ownerMaps.get(key)?.get(name)
}
