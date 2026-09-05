/** Production assembly for the in-process Channel renderer capability. */
import type { ChannelState } from './channel.js'
import { bindChannelOwner, disposeChannelOwner } from './channel/owner.js'
import { createChannelUi, createChannelUiLease } from '../adapter/channel/ui.js'
import type { ChannelUi } from '../adapter/channel/ui-policy.js'
import type { AdapterMode } from '../adapter/kernel/runtime.js'
import { getHostFacade } from './plugin-host.js'
import { getRegisteredTuiChannel, onTuiChannelRegistered } from '../adapter/channel/host-registry.js'

export function mountChannelUi(
  ctx: unknown,
  channel: ChannelState,
  pluginHost: unknown,
  mode: AdapterMode,
): { channel: ChannelUi; dispose(): void } {
  const lease = createChannelUiLease(() => getRegisteredTuiChannel(ctx) === channel)
  const unsubscribe = onTuiChannelRegistered(ctx, next => {
    if (next !== channel) { lease.dispose(); disposeChannelOwner(channel) }
  })
  const local = createChannelUi(channel, mode, {
    own: lease.own,
    assertActive() {
      lease.assertActive()
      const current = resolve()
      if (current !== local) void current.version
    },
  })
  // Before async kernel mount (or with the channel slice disabled), use
  // the identical guarded local capability. Never downgrade after binding.
  let mounted: ChannelUi | undefined
  let mountedView: ChannelUi | undefined
  const resolve = (): ChannelUi => {
    lease.assertActive()
    const facade = getHostFacade(pluginHost as never)
    const ui = facade?.channel?.projection.ui
    if (ui === undefined) {
      if (mounted !== undefined) throw new Error('dsh-tui: mounted HostFacade lost Channel UI')
      return local
    }
    const next = ui()
    if (next !== mounted) {
      mounted = next
      mountedView = createChannelUi(next, mode, lease)
    }
    return mountedView!
  }
  bindChannelOwner(channel, () => { resolve(); return true })
  const view = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(local) as (keyof ChannelUi)[]) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get() {
        const value = resolve()[key]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          lease.assertActive()
          const current = resolve()
          return Reflect.apply(current[key] as (...args: unknown[]) => unknown, current, args)
        }
      },
    })
  }
  return {
    channel: Object.freeze(view) as unknown as ChannelUi,
    dispose() { unsubscribe(); lease.dispose(); disposeChannelOwner(channel) },
  }
}
