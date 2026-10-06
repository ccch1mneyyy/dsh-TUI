/**
 * The replay seed of a resumed thread (docs/codex-backend-design.md §5.12):
 * the newest page of turns, which `thread/resume` returns in full when asked
 * (`initialTurnsPage` with `itemsView: 'full'`, C0 V4), oldest first through
 * the shared replay. "Load earlier" (the `transcript` capability) is C3.
 */
import type { AgentEvent } from '../../../agent/events.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import type { ItemContext } from '../translate/items.js'
import { replayTurns } from '../translate/replay.js'

/** Turns the first page replays. */
export const HISTORY_PAGE_TURNS = 20

/** The `initialTurnsPage` request of `thread/resume`. */
export const INITIAL_TURNS_PAGE = { limit: HISTORY_PAGE_TURNS, sortDirection: 'desc', itemsView: 'full' } as const

/** The resume answer's first page as events (advancing `ctx`), and the
 *  cursor of the next older page. */
export function replayResumePage(response: Rec, ctx: ItemContext): { readonly events: readonly AgentEvent[]; readonly olderCursor?: string } {
  const page = rec(response.initialTurnsPage)
  const turns = [...arr(page?.data)].reverse()
  const events = replayTurns(turns, ctx)
  const cursor = str(page?.nextCursor) ?? str(response.turnsBackwardsCursor)
  return { events, ...(cursor === undefined ? {} : { olderCursor: cursor }) }
}
