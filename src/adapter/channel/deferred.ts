/**
 * A `ChannelUi` whose backing channel can be swapped once, without the
 * screen noticing an identity change.
 *
 * The fast launcher mounts the real `Chat` before dsh has composed anything
 * (see `src/preboot/`). Chat reads ~90 channel members per render and
 * subscribes to the channel exactly once at mount, so the boot-phase channel
 * and the live one must be the SAME object: every property read goes to the
 * current backing channel through a getter, every method forwards to it, and
 * the three subscription methods keep their own listener sets so a listener
 * registered against the boot channel keeps firing after the live channel
 * arrives. `version` stays monotonic across the swap (screens compare it).
 *
 * The member inventory comes from `ui-policy.ts`, so a new port member is a
 * compile error here until it is classified there — the same rule the read
 * projection already enforces.
 */
import type { ChannelUi } from '../ports/channel-ui.js'
import { CHANNEL_UI_EFFECTS, CHANNEL_UI_PROPERTIES } from './ui-policy.js'

type SubscribeKey = 'subscribe' | 'subscribeAgentView' | 'subscribeSettingsSections'
const SUBSCRIBE_KEYS: readonly SubscribeKey[] = ['subscribe', 'subscribeAgentView', 'subscribeSettingsSections']

export interface DeferredChannel {
  /** The stable channel object a screen holds for its whole life. */
  readonly channel: ChannelUi
  /** Whether {@link resolve} has run. */
  readonly resolved: boolean
  /**
   * Replace the backing channel. Listeners registered so far are moved to
   * `next` and notified once; the version jumps by exactly one past the
   * last value observed through the boot channel. A second call throws:
   * a live channel is never replaced by another one this way (the host
   * re-mounts for that).
   */
  resolve(next: ChannelUi): void
}

/**
 * Wrap `initial` (typically a boot channel with `ready === false`) so the
 * live channel can slide underneath it later.
 * @param initial - The channel that answers until {@link DeferredChannel.resolve}.
 */
export function createDeferredChannel(initial: ChannelUi): DeferredChannel {
  let current = initial
  let resolved = false
  // `channel.version` = versionBase + current.version. The base is 0 for the
  // boot channel and re-seated at resolve so the swap reads as one bump.
  let versionBase = 0
  const listeners: Record<SubscribeKey, Set<() => void>> = {
    subscribe: new Set(),
    subscribeAgentView: new Set(),
    subscribeSettingsSections: new Set(),
  }
  const forwarders: Partial<Record<SubscribeKey, () => void>> = {}
  const fanOut = (key: SubscribeKey): void => {
    for (const listener of [...listeners[key]]) listener()
  }
  /** Make sure `current` notifies the listener set for `key` (one upstream subscription per key). */
  const ensureForwarder = (key: SubscribeKey): void => {
    if (forwarders[key] !== undefined) return
    forwarders[key] = current[key](() => fanOut(key))
  }
  const dropForwarders = (): void => {
    for (const key of SUBSCRIBE_KEYS) {
      forwarders[key]?.()
      forwarders[key] = undefined
    }
  }
  const view: Record<string, unknown> = {}
  for (const key of CHANNEL_UI_PROPERTIES) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: key === 'version'
        ? () => versionBase + current.version
        : () => current[key],
    })
  }
  for (const key of Object.keys(CHANNEL_UI_EFFECTS) as (keyof typeof CHANNEL_UI_EFFECTS)[]) {
    if ((SUBSCRIBE_KEYS as readonly string[]).includes(key)) {
      const subscribeKey = key as SubscribeKey
      view[key] = (listener: () => void) => {
        listeners[subscribeKey].add(listener)
        ensureForwarder(subscribeKey)
        return () => {
          listeners[subscribeKey].delete(listener)
          // Last listener gone: leave nothing dangling on the backing channel.
          if (listeners[subscribeKey].size === 0) {
            forwarders[subscribeKey]?.()
            forwarders[subscribeKey] = undefined
          }
        }
      }
      continue
    }
    view[key] = (...args: unknown[]) =>
      Reflect.apply(current[key] as (...args: unknown[]) => unknown, current, args)
  }
  const channel = Object.freeze(view) as unknown as ChannelUi
  return {
    channel,
    get resolved() {
      return resolved
    },
    resolve(next) {
      if (resolved) throw new Error('dsh-tui: deferred channel already resolved')
      resolved = true
      const observed = versionBase + current.version
      dropForwarders()
      current = next
      versionBase = observed + 1 - next.version
      for (const key of SUBSCRIBE_KEYS) {
        if (listeners[key].size > 0) ensureForwarder(key)
      }
      for (const key of SUBSCRIBE_KEYS) fanOut(key)
    },
  }
}
