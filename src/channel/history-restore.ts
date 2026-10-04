/**
 * "Load earlier" for a session whose durable record is read through the
 * `transcript` capability (docs/agent-backend-design.md §4.11): the
 * backend-neutral half.
 *
 * - Folding: a row the record can restore is one with a stable identity —
 *   a tool card (its `callId`), a user / assistant / reasoning row stamped
 *   with the backend's own `anchor` (`anchoredRow`). Nothing else is folded.
 * - Restoring: `restoreFoldedRows` re-derives a folded row's full text from
 *   the record's replay events, matched by those identities, exactly as the
 *   DSH log restore rebuilds it (text, tool arguments, result, views).
 * - Older history: `projectHistorySlice` projects an older slice through the
 *   ONE shared projector (and the activity projection, so subagent cards
 *   render) into scratch rows, and `prependHistoryRows` puts them ahead of
 *   the transcript as restored rows (exempt from folding) with ids below
 *   every existing row (row ids order "new since" bookkeeping).
 */
import { markChannelReadDirty } from '../adapter/channel/read-view.js'
import type { BackgroundJobState, ChatRow, SubagentState, ToolCallView } from '../adapter/ports/channel-view.js'
import type { AgentEvent, AgentEventOf } from '../agent/events.js'
import { isSuppressedPresentation } from '../agent/presentation.js'
import { createActivityProjection } from './activity.js'
import { createChannelProjection, textOfBlocks, type ProjectionState } from './projection.js'

/** Whether the durable record can restore a row (the fold predicate). */
export function anchoredRow(row: ChatRow): boolean {
  switch (row.kind) {
    case 'tool':
      return row.tool !== undefined
    case 'user':
    case 'assistant':
    case 'reasoning':
      return row.anchor !== undefined
    default:
      return false
  }
}

/** Restore folded rows from a durable record; returns the rows restored. */
export function restoreFoldedRows(rows: ChatRow[], record: readonly AgentEvent[]): number {
  const folded = rows.filter(row => row.folded === true)
  if (folded.length === 0) return 0
  const users = new Map<string, string>()
  const messages = new Map<string, { text: string; reasoning: string }>()
  const calls = new Map<string, AgentEventOf<'tool.call'>>()
  const results = new Map<string, AgentEventOf<'tool.result'>>()
  for (const event of record) {
    switch (event.type) {
      case 'user.message':
        if (event.source === 'user' && event.anchor !== '') users.set(event.anchor, event.text)
        break
      case 'assistant.message': {
        if (event.parentCallId !== undefined) break
        const known = messages.get(event.anchor) ?? { text: '', reasoning: '' }
        known.text += textOfBlocks(event.blocks)
        known.reasoning += event.blocks.map(block => (block.type === 'reasoning' ? block.text ?? '' : '')).join('')
        messages.set(event.anchor, known)
        break
      }
      case 'tool.call':
        if (event.parentCallId === undefined) calls.set(event.callId, event)
        break
      case 'tool.result':
        if (event.parentCallId === undefined) results.set(event.callId, event)
        break
      default:
        break
    }
  }
  let restored = 0
  for (const row of folded) {
    let found = false
    switch (row.kind) {
      case 'user': {
        const text = row.anchor === undefined ? undefined : users.get(row.anchor)
        if (text !== undefined) {
          if (text.trim() !== '') row.text = text
          found = true
        }
        break
      }
      case 'assistant':
      case 'reasoning': {
        const message = row.anchor === undefined ? undefined : messages.get(row.anchor)
        if (message !== undefined) {
          const text = (row.kind === 'assistant' ? message.text : message.reasoning).trim()
          if (text !== '') row.text = text
          found = true
        }
        break
      }
      case 'tool': {
        const tool = row.tool
        const call = tool === undefined ? undefined : calls.get(tool.callId)
        if (tool === undefined || call === undefined) break
        tool.argsFull = call.argsJson
        tool.callView = call.presentation === undefined || isSuppressedPresentation(call.presentation) ? undefined : call.presentation as ToolCallView
        const result = results.get(tool.callId)
        if (result !== undefined) {
          if (result.isError) {
            tool.status = 'error'
            tool.errorText = result.errorText ?? ''
          } else {
            tool.status = 'ok'
            tool.resultFull = result.text === '' ? undefined : result.text
            tool.resultView = result.presentation
          }
        }
        found = true
        break
      }
      default:
        break
    }
    if (!found) continue
    row.folded = false
    // Exempt from the next fold pass: a restore must not be undone at once.
    row.restored = true
    markChannelReadDirty(row)
    restored += 1
  }
  if (restored > 0) markChannelReadDirty(rows)
  return restored
}

const NOOP = (): void => undefined

/** A throwaway projection state (an older slice paints into its rows). */
function scratchState(thinkingFold: ProjectionState['thinkingFold']): ProjectionState & { subagents: SubagentState[]; backgroundJobs: BackgroundJobState[] } {
  const bucket = (): { input: number; output: number; cacheRead: number; cacheWrite: number } => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  return {
    thinkingFold,
    activeToolCount: 0,
    spinnerMode: 'requesting',
    goal: undefined,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tokens: { ...bucket(), peak: bucket(), idle: bucket() },
    mainCost: {},
    model: '',
    lastUsage: undefined,
    turnUsage: undefined,
    lastUserText: '',
    responseChars: 0,
    tps: undefined,
    cancelPending: false,
    working: false,
    compaction: undefined,
    turnStart: 0,
    contextWindow: undefined,
    reasoningEffort: undefined,
    sessionTitle: '',
    agentPreset: undefined,
    sessionColor: '',
    costReport: undefined,
    rows: [],
    tpsSamples: [],
    todos: [],
    subagents: [],
    backgroundJobs: [],
  }
}

/** Paint an older history slice into fresh rows (settled, no live effects). */
export function projectHistorySlice(events: readonly AgentEvent[], thinkingFold: ProjectionState['thinkingFold']): ChatRow[] {
  if (events.length === 0) return []
  const state = scratchState(thinkingFold)
  const rowIds = { value: 0 }
  const activity = createActivityProjection(() => state, { rowIds })
  const projector = createChannelProjection(state, {
    rowIds,
    resetContextWarning: NOOP,
    checkContextWarning: NOOP,
    notify: () => NOOP,
    jobs: { onOutputSeen: NOOP, onStarted: NOOP },
    inputConvergence: { cancelInFlight: false },
    selectionAttached: () => undefined,
    activity,
  })
  try {
    projector.apply(events, { replay: true })
    projector.settleStreaming()
  } finally {
    activity.dispose()
  }
  return state.rows
}

/**
 * Put older rows ahead of the transcript: restored (never folded again),
 * not fresh (no reveal animation), ids below every row already there.
 * Returns the rows prepended.
 */
export function prependHistoryRows(rows: ChatRow[], older: readonly ChatRow[]): number {
  if (older.length === 0) return 0
  let floor = 0
  for (const row of rows) if (row.id < floor) floor = row.id
  const first = floor - older.length
  const prepared = older.map((row, index) => {
    const prepended: ChatRow = { ...row, id: first + index, restored: true }
    delete prepended.fresh
    delete prepended.streaming
    return prepended
  })
  rows.unshift(...prepared)
  markChannelReadDirty(rows)
  return prepared.length
}
