import type { SessionSummary } from '../../adapter/ports/channel-session.js'
import type { ChannelActionDelegates } from './action-readiness.js'
import type { ChannelOwner } from './owner.js'

type ListSessions = ChannelActionDelegates['listSessions']
type Listener = { enriched?: Parameters<ListSessions>[0]; partial?: Parameters<ListSessions>[1] }

/** Share a pending background read with the browser, including progress that
 * arrived before it opened. Completed reads still refresh on the next open. */
export function createSessionListing(deps: {
  owner: Pick<ChannelOwner, 'own'>
  capture(): () => boolean
  read(current: () => boolean, onEnriched: NonNullable<Listener['enriched']>, onPartial: NonNullable<Listener['partial']>): ReturnType<ListSessions>
}) {
  interface Flight {
    current(): boolean
    promise: ReturnType<ListSessions>
    rows?: readonly SessionSummary[]
    listeners: Set<Listener>
  }
  let active: Flight | undefined
  let generation = 0
  const invalidate = (): void => {
    ++generation
    active?.listeners.clear()
    active = undefined
  }
  deps.owner.own(invalidate)

  const listSessions: ListSessions = async (onEnriched, onPartial) => {
    if (active === undefined || !active.current()) {
      invalidate()
      const version = generation
      const fence = deps.capture()
      const flight: Flight = {
        current: () => generation === version && fence(),
        listeners: new Set(),
        // Defer the read so the first subscriber is installed before even a
        // synchronous provider publishes progress.
        promise: Promise.resolve().then(() => flight.current() ? deps.read(flight.current, enriched => {
          if (!flight.current()) return
          flight.rows = flight.rows?.map(row => row.id === enriched.id ? enriched : row)
          for (const listener of flight.listeners) listener.enriched?.(enriched)
        }, rows => {
          if (!flight.current()) return
          flight.rows = rows
          for (const listener of flight.listeners) listener.partial?.(rows)
        }) : []).finally(() => {
          // DSH title recovery may still enrich this generation after the
          // read resolves. Let its callbacks live with that work, without
          // retaining the browser through the channel's pending-read slot.
          if (active === flight) active = undefined
        }),
      }
      active = flight
    }
    const flight = active
    flight.listeners.add({ enriched: onEnriched, partial: onPartial })
    if (flight.rows !== undefined) onPartial?.(flight.rows)
    return flight.promise
  }
  return { listSessions, invalidate }
}
