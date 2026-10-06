/**
 * Shared harness of the Codex translator gates (verify-codex-translate,
 * verify-codex-live-replay): a recorded wire fixture's notifications for
 * one thread through the live translator, the same thread's recorded turns
 * through the replay, both into the one shared projector, with a pinned
 * clock and language.
 *
 * Import from TypeScript scripts run with `node --import tsx/esm`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../../src/agent/events.js'
import { createItemContext, type ItemContext } from '../../src/backends/codex/translate/items.js'
import { createLiveTranslator } from '../../src/backends/codex/translate/live.js'
import { replayTurns } from '../../src/backends/codex/translate/replay.js'
import { createProjectorHarness, type ProjectorHarness } from './projector-harness.js'

type Rec = Record<string, unknown>
export const WIRE_DIR = join(import.meta.dirname, '..', 'fixtures', 'codex', 'wire')

export interface WireLine { readonly t?: number; readonly dir: 'in' | 'out'; readonly msg: Rec }

export function loadWire(name: string): WireLine[] {
  return readFileSync(join(WIRE_DIR, `${name}.jsonl`), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as WireLine)
}

const rec = (value: unknown): Rec | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined

/** The thread a message concerns. */
export function threadOfMessage(message: Rec): string | undefined {
  const params = rec(message.params)
  const id = params?.threadId ?? rec(params?.thread)?.id
  return typeof id === 'string' ? id : undefined
}

/** Server notifications (no id) of one thread, in order. */
export function notificationsOf(wire: readonly WireLine[], threadId: string): { method: string; params: Rec }[] {
  return wire.flatMap(line => {
    if (line.dir !== 'in' || typeof line.msg.method !== 'string' || line.msg.id !== undefined) return []
    if (threadOfMessage(line.msg) !== threadId) return []
    return [{ method: line.msg.method, params: rec(line.msg.params) ?? {} }]
  })
}

/** Threads with turn traffic in a fixture, in order of first appearance. */
export function turnThreads(wire: readonly WireLine[]): string[] {
  const seen: string[] = []
  for (const line of wire) {
    if (line.dir !== 'in' || line.msg.method !== 'turn/started') continue
    const id = threadOfMessage(line.msg)
    if (id !== undefined && !seen.includes(id)) seen.push(id)
  }
  return seen
}

/**
 * The recorded turns of a thread, oldest first, from the LAST full-history
 * answer in the fixture (`thread/read` with turns, `thread/turns/list` with
 * full items, a resume's full initial page), or the `index`-th one.
 */
export function recordedTurns(wire: readonly WireLine[], threadId: string, which: 'last' | number = 'last'): unknown[] | undefined {
  const requests = new Map<unknown, Rec>()
  const found: unknown[][] = []
  for (const line of wire) {
    if (line.dir === 'out' && typeof line.msg.method === 'string' && line.msg.id !== undefined) requests.set(line.msg.id, line.msg)
    if (line.dir !== 'in' || line.msg.method !== undefined || line.msg.id === undefined) continue
    const request = requests.get(line.msg.id)
    const params = rec(request?.params)
    if (request === undefined || params?.threadId !== threadId) continue
    const result = rec(line.msg.result)
    if (request.method === 'thread/read' && params.includeTurns === true) {
      const turns = rec(result?.thread)?.turns
      if (Array.isArray(turns)) found.push(turns)
    } else if (request.method === 'thread/turns/list' && params.itemsView === 'full') {
      const data = result?.data
      if (Array.isArray(data)) found.push(params.sortDirection === 'asc' ? data : [...data].reverse())
    } else if (request.method === 'thread/resume' && rec(params.initialTurnsPage)?.itemsView === 'full') {
      const data = rec(result?.initialTurnsPage)?.data
      if (Array.isArray(data)) found.push([...data].reverse())
    }
  }
  return which === 'last' ? found.at(-1) : found[which]
}

export interface TranslateRun {
  readonly events: AgentEvent[]
  readonly harness: ProjectorHarness
  readonly ctx: ItemContext
  /** Notice texts produced by notifications that history never records. */
  readonly liveOnlyNotices: Set<string>
}

/** A deterministic clock for one run (event times and the projector's). */
function pinnedClock(): { now: () => number; restore: () => void } {
  let clock = Date.UTC(2026, 9, 6, 12, 0, 0)
  const now = (): number => (clock += 7)
  const real = Date.now
  Date.now = now
  return { now, restore: () => { Date.now = real } }
}

/** Methods whose notices are facts of the live stream, never of history. */
const LIVE_ONLY_METHODS = new Set(['error', 'warning', 'guardianWarning', 'configWarning', 'deprecationNotice', 'hook/started', 'hook/completed',
  'mcpServer/startupStatus/updated', 'item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'model/rerouted', 'thread/status/changed',
  'thread/closed', 'thread/archived', 'thread/deleted'])

/** Live: every notification of the thread through the live translator. */
export function liveRun(notifications: readonly { method: string; params: Rec }[], cwd = '/TMP/cwd'): TranslateRun {
  const clock = pinnedClock()
  try {
    const ctx = createItemContext({ cwd, now: clock.now })
    const live = createLiveTranslator(ctx, { model: '', effort: null, modeId: 'auto' })
    const harness = createProjectorHarness({ model: '', activity: true, now: clock.now })
    const events: AgentEvent[] = []
    const liveOnlyNotices = new Set<string>()
    for (const { method, params } of notifications) {
      const batch = live.notification(method, params)
      if (LIVE_ONLY_METHODS.has(method)) for (const event of batch) if (event.type === 'notice') liveOnlyNotices.add(event.text)
      events.push(...batch)
      harness.apply(batch)
    }
    harness.projector.settleStreaming()
    return { events, harness, ctx, liveOnlyNotices }
  } finally {
    clock.restore()
  }
}

/** Replay: recorded turns (oldest first) through the replay. */
export function replayRun(turns: readonly unknown[], cwd = '/TMP/cwd'): TranslateRun {
  const clock = pinnedClock()
  try {
    const ctx = createItemContext({ cwd, now: clock.now })
    const harness = createProjectorHarness({ model: '', activity: true, now: clock.now })
    const events = replayTurns(turns, ctx)
    harness.apply(events, true)
    harness.projector.settleStreaming()
    return { events, harness, ctx, liveOnlyNotices: new Set() }
  } finally {
    clock.restore()
  }
}

/** The golden view of one run: compact, deterministic, review-friendly. */
export function golden(run: TranslateRun): unknown {
  const state = run.harness.state
  return {
    events: run.events.map(event => event.type === 'assistant.delta' ? `delta:${event.delta.kind}` : event.type),
    rows: state.rows.map(row => ({
      kind: row.kind,
      text: row.text.length > 160 ? `${row.text.slice(0, 160)}…` : row.text,
      ...(row.streaming === true ? { streaming: true } : {}),
      ...(row.tool === undefined ? {} : {
        tool: {
          name: row.tool.name,
          status: row.tool.status,
          call: row.tool.callView === undefined ? null : { card: row.tool.callView.card, title: 'title' in row.tool.callView ? row.tool.callView.title : null, displayKey: row.tool.callView.displayKey ?? null },
          result: row.tool.resultView === undefined ? null : { card: row.tool.resultView.card },
          ...(row.tool.errorText === undefined ? {} : { errorText: row.tool.errorText.slice(0, 120) }),
          ...(row.tool.resultText === undefined ? {} : { resultText: row.tool.resultText.slice(0, 120) }),
        },
      }),
    })),
    state: {
      working: state.working,
      contextWindow: state.contextWindow ?? null,
      tokens: { input: state.tokens.input, output: state.tokens.output, cacheRead: state.tokens.cacheRead, cacheWrite: state.tokens.cacheWrite },
      lastUsage: state.lastUsage === undefined ? null : { input: state.lastUsage.input, output: state.lastUsage.output, cacheRead: state.lastUsage.cacheRead, cacheWrite: state.lastUsage.cacheWrite },
      todos: state.todos,
      notices: run.harness.notices,
    },
  }
}
