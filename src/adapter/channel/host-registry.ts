/**
 * Host-internal Channel registry for the adapter Kernel.
 *
 * The live `Channel` is created by the TUI plugin row after the plugin-host
 * Kernel may already have been constructed/mounted. Rather than trying to
 * reorder service mounting, the TUI stores the live Channel under its
 * composition root in a WeakMap; the Channel driver resolves it lazily when
 * a Port method is actually called. This keeps the Kernel's composition
 * independent of the TUI render lifecycle.
 */

const channels = new WeakMap<object, unknown>()

function rootKey(ctx: unknown): object | undefined {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  try {
    return ctx as object
  } catch {
    return undefined
  }
}

/** Register the live Channel for a composition root. */
export function registerTuiChannel(ctx: unknown, channel: unknown): void {
  const key = rootKey(ctx)
  if (key === undefined) return
  channels.set(key, channel)
}

/** Resolve the live Channel for a composition root. */
export function getRegisteredTuiChannel(ctx: unknown): unknown | undefined {
  const key = rootKey(ctx)
  return key === undefined ? undefined : channels.get(key)
}
