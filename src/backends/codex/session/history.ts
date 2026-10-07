/**
 * The replay seed of a resumed thread (docs/codex-backend-design.md §5.12):
 * the newest page of turns, which `thread/resume` returns in full when asked
 * (`initialTurnsPage` with `itemsView: 'full'`, C0 V4), oldest first through
 * the shared replay. A single asynchronously prefetched page makes the
 * transcript capability synchronous; live numbering is never touched by it.
 */
import type { SessionCapabilities } from '../../../agent/capabilities.js'
import type { AgentEvent, AgentEventOf } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import type { CodexHub } from '../rpc/hub.js'
import { createItemContext, type ItemContext } from '../translate/items.js'
import { replayTurns } from '../translate/replay.js'

/** Turns the first page replays. */
export const HISTORY_PAGE_TURNS = 20

/** The `initialTurnsPage` request of `thread/resume`. */
export const INITIAL_TURNS_PAGE = { limit: HISTORY_PAGE_TURNS, sortDirection: 'desc', itemsView: 'full' } as const

/** The resume answer's first page as events (advancing `ctx`), and the
 *  cursor of the next older page. */
export function replayResumePage(response: Rec, ctx: ItemContext): { readonly events: readonly AgentEvent[]; readonly olderCursor?: string } {
  const page = rec(response.initialTurnsPage)
  const turns = page === undefined ? [...arr(rec(response.thread)?.turns)] : [...arr(page.data)].reverse()
  const events = replayTurns(turns, ctx)
  const cursor = str(page?.nextCursor) ?? str(response.turnsBackwardsCursor)
  return { events, ...(cursor === undefined ? {} : { olderCursor: cursor }) }
}

export interface CodexTranscriptHistory {
  takeInitial(): readonly AgentEvent[]
  readonly capability: NonNullable<SessionCapabilities['transcript']>
  /** Replace the paging snapshot; the caller owns live/backfill numbering. */
  reset(response: Rec): void
  /** Capture completed native facts, not deltas or optimistic tool state. */
  notification(method: string, params: Rec): void
  /** Native order, including a ready prefetch page (fork/rewind lookup). */
  readonly turns: readonly Rec[]
  /** Find the turn immediately before the turn containing an item anchor. */
  previousTurnId(anchor: string): string | undefined
  close(): void
}
export interface CodexTranscriptHistoryDeps {
  readonly hub: Pick<CodexHub, 'call'>
  readonly threadId: string
  readonly cwd: string
  readonly response: Rec
  /** Only initial replay advances the live translator context. */
  readonly ctx: ItemContext
  readonly notice?: (event: AgentEventOf<'notice'>) => void
}

const RECORD_TURNS_LIMIT = 1000
const RECORD_CHARS_LIMIT = 64 * 1024 * 1024

/** A synchronous bounded record over native full items, with one older page
 * ready ahead of the user. No I/O, decoding, or live seq changes on older(). */
export function createCodexTranscriptHistory(deps: CodexTranscriptHistoryDeps): CodexTranscriptHistory {
  let loaded: Rec[] = []
  let initial: readonly AgentEvent[] = []
  let cursor: string | undefined
  let cached: { turns: readonly Rec[]; events: readonly AgentEvent[]; next?: string } | undefined
  let record: readonly AgentEvent[] | undefined
  let pending: Promise<void> | undefined
  let abort: AbortController | undefined
  let generation = 0
  let failures = 0
  let closed = false
  const weights = new Map<string, number>()
  let retainedChars = 0
  const freshContext = (): ItemContext => createItemContext({ cwd: deps.cwd, debug: deps.ctx.debug, now: deps.ctx.now, model: deps.ctx.model })
  const replay = (turns: readonly Rec[]): readonly AgentEvent[] => replayTurns(turns, freshContext())
  const keyOf = (turn: Rec): string => str(turn.id) ?? ''
  const bound = (): void => {
    while (loaded.length > RECORD_TURNS_LIMIT || retainedChars > RECORD_CHARS_LIMIT) {
      const removed = loaded.shift()
      if (removed === undefined) break
      const id = keyOf(removed)
      retainedChars -= weights.get(id) ?? 0
      weights.delete(id)
    }
    record = undefined
  }
  const retain = (turns: Rec[]): void => {
    loaded = turns
    weights.clear()
    retainedChars = 0
    for (const turn of loaded) { const weight = JSON.stringify(turn).length; weights.set(keyOf(turn), weight); retainedChars += weight }
    bound()
  }
  const mergeTurn = (turn: Rec): void => {
    const id = keyOf(turn)
    if (id === '') return
    const at = loaded.findIndex(row => keyOf(row) === id)
    if (at === -1) loaded.push(turn)
    else loaded[at] = turn
    const weight = JSON.stringify(turn).length
    retainedChars += weight - (weights.get(id) ?? 0)
    weights.set(id, weight)
    bound()
  }
  const prefetch = (): void => {
    if (closed || cursor === undefined || pending !== undefined || cached !== undefined || failures >= 3) return
    const before = cursor
    const gen = generation
    const controller = new AbortController()
    abort = controller
    const request = deps.hub.call(CLIENT.threadTurnsList, { threadId: deps.threadId, cursor: before, limit: HISTORY_PAGE_TURNS, sortDirection: 'desc', itemsView: 'full' }, { signal: controller.signal })
    const task = request.then(answer => {
      if (closed || generation !== gen) return
      const page = rec(answer)
      const known = new Set(loaded.map(keyOf))
      const turns = [...arr(page?.data)].reverse().map(rec).filter((row): row is Rec => row !== undefined && keyOf(row) !== '' && !known.has(keyOf(row)))
      const next = str(page?.nextCursor)
      cached = { turns, events: replay(turns), ...(next === undefined || next === before ? {} : { next }) }
      failures = 0
    }, () => {
      if (closed || generation !== gen) return
      failures += 1
      deps.ctx.debug('codex: older history prefetch failed; cursor retained')
      if (failures >= 3) deps.notice?.({ type: 'notice', level: 'warning', key: 'codex-older-history', text: t('codex-history-fetch-failed') })
    }).finally(() => { if (pending === task) { pending = undefined; abort = undefined } })
    pending = task
  }
  const initialize = (response: Rec, context: ItemContext): void => {
    generation += 1
    abort?.abort()
    pending = undefined
    abort = undefined
    cached = undefined
    failures = 0
    const page = rec(response.initialTurnsPage)
    const native = arr(page?.data ?? rec(response.thread)?.turns)
    retain((page === undefined ? [...native] : [...native].reverse()).map(rec).filter((row): row is Rec => row !== undefined))
    const seed = replayResumePage(response, context)
    initial = seed.events
    cursor = seed.olderCursor
    prefetch()
  }
  const capability: NonNullable<SessionCapabilities['transcript']> = {
    record: () => {
      if (closed) return undefined
      record ??= replay(loaded)
      return record
    },
    hasOlder: () => !closed && failures < 3 && (cached !== undefined || cursor !== undefined),
    older: () => {
      if (closed || failures >= 3) return []
      if (cached === undefined) { prefetch(); return [] }
      const page = cached
      cached = undefined
      const known = new Set(loaded.map(keyOf))
      retain([...page.turns.filter(turn => !known.has(keyOf(turn))), ...loaded])
      cursor = page.next
      prefetch()
      return page.events
    },
  }
  initialize(deps.response, deps.ctx)
  return {
    capability,
    takeInitial() { const events = initial; initial = []; return events },
    reset: response => { if (!closed) initialize(response, freshContext()) },
    get turns() { return [...(cached?.turns ?? []), ...loaded] },
    previousTurnId(anchor) {
      const turns = [...(cached?.turns ?? []), ...loaded]
      const index = turns.findIndex(turn => arr(turn.items).some(item => str(rec(item)?.id) === anchor))
      return index > 0 ? str(turns[index - 1]?.id) : undefined
    },
    notification(method, params) {
      if (closed || (str(params.threadId) !== undefined && params.threadId !== deps.threadId)) return
      if (method === NOTIFY.turnStarted || method === NOTIFY.turnCompleted) {
        const turn = rec(params.turn)
        const id = turn === undefined ? undefined : str(turn.id)
        if (turn === undefined || id === undefined) return
        const existing = loaded.find(row => keyOf(row) === id)
        const items = [...arr(existing?.items)]
        const byId = new Map(items.map(item => [str(rec(item)?.id), item]))
        for (const item of arr(turn.items)) {
          const itemId = str(rec(item)?.id)
          if (itemId === undefined) continue
          // A summary cannot replace a completed full item's tool body.
          if (!byId.has(itemId)) byId.set(itemId, item)
        }
        mergeTurn({ ...existing, ...turn, items: [...byId.values()] })
      } else if (method === NOTIFY.itemCompleted) {
        const id = str(params.turnId)
        const item = rec(params.item)
        if (id === undefined || item === undefined) return
        const turn = loaded.find(row => keyOf(row) === id) ?? { id, status: 'inProgress', items: [] }
        const items = [...arr(turn.items)]
        const at = items.findIndex(row => str(rec(row)?.id) === str(item.id))
        if (at === -1) items.push(item)
        else {
          const prior = rec(items[at])
          items[at] = prior === undefined ? item : { ...prior, ...item }
        }
        mergeTurn({ ...turn, items })
      }
    },
    close() { closed = true; generation += 1; abort?.abort(); cached = undefined; loaded = []; initial = []; record = undefined; weights.clear() },
  }
}
