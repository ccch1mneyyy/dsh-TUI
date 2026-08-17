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
 * the plugin-host row's `registerCommand(pluginCtx, definition)` supplies a
 * unique wrapper handler and stamps that actual registered definition with
 * the verified Component id and activation on success. The invoke checkpoint resolves the
 * effective definition for its receiving agent first, then looks up that
 * definition's handler here. This mirrors dsh-commands' scoped shadowing:
 * same-name definitions in separate agent scopes never share attribution.
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
import type { VerifiedComponentIdentity } from './component-identity.js'

export interface CommandOwner {
  componentId: string
  activationId: string
  commandId: string
}

const ownerMaps = new WeakMap<object, WeakMap<Function, CommandOwner>>()

function rootKeyOf(ctx: Context): object | undefined {
  const root: unknown = (ctx as { root?: unknown }).root ?? ctx
  return typeof root === 'object' && root !== null ? root : undefined
}

/** The registrant's display name for diagnostics only: the passed context's
 * fiber name (nearest named ancestor), 'root' for host-side or degraded
 * contexts. Authorization never uses this display value. */
export function fiberNameOf(ctx: Context): string {
  try {
    const resolved: unknown = ctx.fiber?.name
    if (typeof resolved === 'string' && resolved !== '') return resolved
  } catch {
    // Degraded context without fiber access: 'root'.
  }
  return 'root'
}

function handlerOf(definition: unknown): Function | undefined {
  try {
    const handler = (definition as { handler?: unknown } | undefined)?.handler
    return typeof handler === 'function' ? handler : undefined
  } catch {
    // An exotic definition cannot participate in attribution safely.
    return undefined
  }
}

/** Record one mediated command definition's owner after successful registration. */
export function stampCommandOwner(
  ctx: Context,
  definition: unknown,
  identity: VerifiedComponentIdentity,
  commandId: string,
): void {
  const key = rootKeyOf(ctx)
  const handler = handlerOf(definition)
  if (key === undefined || handler === undefined) return
  let map = ownerMaps.get(key)
  if (map === undefined) {
    map = new WeakMap()
    ownerMaps.set(key, map)
  }
  map.set(handler, Object.freeze({ componentId: identity.componentId, activationId: identity.activationId, commandId }))
}

/** Lift one definition's stamp without touching a later registration. */
export function unstampCommandOwner(ctx: Context, definition: unknown, activationId: string): void {
  const key = rootKeyOf(ctx)
  const handler = handlerOf(definition)
  if (key === undefined || handler === undefined) return
  const map = ownerMaps.get(key)
  if (map?.get(handler)?.activationId === activationId) map.delete(handler)
}

/**
 * The recorded owner of the EFFECTIVE command definition, or undefined when
 * it is unattributed (root-side/direct registrations are the documented
 * C-070 boundary). Callers must pass `commands.find(agent, name)`, not only
 * the command name, so agent-scoped shadows select their own owner.
 */
export function commandOwner(ctx: Context, definition: unknown): CommandOwner | undefined {
  const key = rootKeyOf(ctx)
  const handler = handlerOf(definition)
  if (key === undefined || handler === undefined) return undefined
  return ownerMaps.get(key)?.get(handler)
}
