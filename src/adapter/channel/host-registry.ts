/**
 * Host-internal Channel registry for the adapter Kernel.
 *
 * The live `Channel` is created by the TUI plugin row after the plugin-host
 * Kernel may already have been constructed/mounted. Rather than trying to
 * reorder service mounting, the TUI stores the live Channel under its
 * composition root in a WeakMap; the Channel driver resolves it lazily when
 * a Port method is actually called. This keeps the Kernel's composition
 * independent of the TUI render lifecycle.
 *
 * Every entry is normalized to the Cordis composition root before it is used
 * as a WeakMap key: a child/plugin context passed by a caller must never
 * create a registry entry that the Kernel (which queries through the root)
 * cannot resolve.
 */

import { compositionRoot } from '../../dsh-adapter/host-access.js'

export type TuiChannelRegistration = Readonly<{ channel: unknown; token: symbol }>

const channels = new WeakMap<object, TuiChannelRegistration>()
const channelListeners = new WeakMap<object, Set<(channel: unknown) => void>>()
const registrationListeners = new WeakMap<object, Set<(registration: TuiChannelRegistration | undefined) => void>>()

function rootKey(ctx: unknown): object | undefined {
  if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  try {
    return compositionRoot(ctx as never) as object
  } catch {
    // Non-Cordis test values / minimal embedders are their own root.
    return ctx as object
  }
}

/** Register the live Channel for a composition root.
 * @returns A token-safe disposer. Registrations have identity independent of
 * their Channel object: A → B → A and repeated registration of the same
 * Channel cannot let an older disposer erase or revive the current entry.
 */
export function registerTuiChannel(ctx: unknown, channel: unknown): () => boolean {
  const key = rootKey(ctx)
  if (key === undefined) return () => false
  const registration: TuiChannelRegistration = Object.freeze({ channel, token: Symbol('tui-channel-registration') })
  channels.set(key, registration)
  notifyChannelListeners(key, registration)
  let disposed = false
  return () => {
    if (disposed) return false
    disposed = true
    if (channels.get(key)?.token !== registration.token) return false
    channels.delete(key)
    notifyChannelListeners(key, undefined)
    return true
  }
}

function notifyChannelListeners(key: object, registration: TuiChannelRegistration | undefined): void {
  const listeners = channelListeners.get(key)
  if (listeners !== undefined) {
    for (const listener of [...listeners]) {
      try {
        listener(registration?.channel)
      } catch {
        // A registration notification is advisory; one faulty listener must not
        // prevent the Channel from being stored.
      }
    }
  }
  const identityListeners = registrationListeners.get(key)
  if (identityListeners === undefined) return
  for (const listener of [...identityListeners]) {
    try {
      listener(registration)
    } catch {
      // Identity notifications have the same advisory, fan-out semantics.
    }
  }
}

/** Resolve the live Channel for a composition root. */
export function getRegisteredTuiChannel(ctx: unknown): unknown | undefined {
  return getTuiChannelRegistration(ctx)?.channel
}

/** Return the current registration identity, not only its Channel object. */
export function getTuiChannelRegistration(ctx: unknown): TuiChannelRegistration | undefined {
  const key = rootKey(ctx)
  return key === undefined ? undefined : channels.get(key)
}

/**
 * Subscribe to live-Channel registration for one composition root.
 *
 * The Kernel uses this to re-run a refresh/mount when the TUI plugin creates
 * and registers its Channel after the plugin-host row has already started.
 * Returns a disposer; listeners are keyed by normalized composition root.
 */
export function onTuiChannelRegistered(
  ctx: unknown,
  listener: (channel: unknown) => void,
): () => void {
  const key = rootKey(ctx)
  if (key === undefined) return () => undefined
  let listeners = channelListeners.get(key)
  if (listeners === undefined) {
    listeners = new Set()
    channelListeners.set(key, listeners)
  }
  listeners.add(listener)
  return () => { listeners?.delete(listener) }
}

/** Subscribe to registration identities for consumers that own capabilities. */
export function onTuiChannelRegistration(
  ctx: unknown,
  listener: (registration: TuiChannelRegistration | undefined) => void,
): () => void {
  const key = rootKey(ctx)
  if (key === undefined) return () => undefined
  let listeners = registrationListeners.get(key)
  if (listeners === undefined) {
    listeners = new Set()
    registrationListeners.set(key, listeners)
  }
  listeners.add(listener)
  return () => { listeners?.delete(listener) }
}
