import React from 'react'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'

/**
 * Whether the channel is live, as a render-triggering value.
 *
 * The `dst` fast start mounts the screens against a boot channel
 * (`ready === false`) and later swaps the live one in underneath the SAME
 * object (see `adapter/channel/deferred.ts`), so an effect keyed on
 * `[channel]` alone never re-runs across the swap: a screen opened during
 * boot would keep the boot channel's neutral answers forever. Put this value
 * in the deps of any effect that reads channel data once. Hosts that predate
 * the flag count as ready.
 * @param channel - The channel the screen holds.
 * @returns False only while the channel is still the boot channel.
 */
export function useChannelReady(channel: Pick<ChannelUi, 'subscribe' | 'ready'>): boolean {
  // Narrow screen fixtures (Settings regressions) hand in a partial channel
  // without `subscribe`; such a channel never changes readiness.
  const subscribe = typeof channel.subscribe === 'function' ? channel.subscribe : noSubscription
  return React.useSyncExternalStore(subscribe, () => channel.ready !== false)
}

const noSubscription = (): (() => void) => () => {}
