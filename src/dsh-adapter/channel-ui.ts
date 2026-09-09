/** Production assembly for the in-process Channel renderer capability. */
import type { ChannelState } from './channel.js'
import { bindChannelOwner, disposeChannelOwner, onChannelOwnerDispose } from './channel/owner.js'
import { createChannelUi, createChannelUiLease } from '../adapter/channel/ui.js'
import type { ChannelUi } from '../adapter/channel/ui-policy.js'
import type { AdapterMode } from '../adapter/kernel/runtime.js'
import { getHostFacade } from './plugin-host.js'
import { getTuiChannelRegistration, onTuiChannelRegistration } from '../adapter/channel/host-registry.js'

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

export function mountChannelUi(
  ctx: unknown,
  channel: ChannelState,
  pluginHost: unknown,
  mode: AdapterMode,
): { channel: ChannelUi; dispose(): void } {
  // A registration, rather than Channel object equality, is the authority for
  // this mount. Re-registering the same Channel revokes retained UI handles.
  const registration = getTuiChannelRegistration(ctx)
  let ownerActive = true
  const lease = createChannelUiLease(() => ownerActive && getTuiChannelRegistration(ctx) === registration)
  const releaseOwnerLease = onChannelOwnerDispose(channel, () => {
    ownerActive = false
    lease.dispose()
  })
  const unsubscribe = onTuiChannelRegistration(ctx, next => {
    if (next === registration) return
    // Even a throwing notification cleanup cannot skip owner teardown.
    try { lease.dispose() } finally {
      // Same-object registration only revokes this capability, not its successor.
      if (next?.channel !== channel) disposeChannelOwner(channel)
    }
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
  // This external check does not resolve UI: owner.current() is called by
  // leases, so resolving here would recurse through the owner guard.
  bindChannelOwner(channel, () => ownerActive && getTuiChannelRegistration(ctx) === registration)
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
    dispose() {
      const failures: unknown[] = []
      const releaseOwner = () => {
        const current = getTuiChannelRegistration(ctx)
        // An old mount's late cleanup must not dispose a newer mount of A.
        if (current === registration || current?.channel !== channel) disposeChannelOwner(channel)
      }
      for (const cleanup of [unsubscribe, () => lease.dispose(), releaseOwnerLease, releaseOwner]) {
        try { cleanup() } catch (error) { failures.push(error) }
      }
      throwCleanupFailures(failures, 'dsh-tui: Channel UI cleanup failed')
    },
  }
}
