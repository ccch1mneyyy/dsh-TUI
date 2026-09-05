import { type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChatRow, ToolResultView, ToolViewPresenter } from './types.js'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'

export const ARGS_PREVIEW_LIMIT = 160

export const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
export const LOCAL_OUTPUT_LIMIT = 240

/**
 * In-memory transcript window cap. Older rows beyond this count are FOLDED:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log remains the
 * complete source of truth (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
export const MAX_ROWS = 600

export function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Fold the oldest rows beyond the transcript window cap: drop each row's
 * full-text fields (assistant/reasoning text, tool args/results) and keep
 * only its preview text, kind, id, and seq. Bounds the TUI's retained text
 * without touching the session log (the source of truth for /export and
 * loadOlder). Small local/notice/interrupt rows are left intact (they hold
 * terminal-local text the log cannot restore). Restored rows are exempt so
 * a loadOlder() restore is not instantly undone. Returns the number of rows
 * folded.
 */
export function foldRows(
  rows: ChatRow[],
  cap: number,
  cursor?: { rows: unknown; index: number },
): number {
  const excess = rows.length - cap
  if (excess <= 0) {
    if (cursor !== undefined) cursor.index = 0
    return 0
  }
  // Incremental pass: rows only ever append past the fold line and the
  // folded/restored exemptions are permanent, so everything below a cursor
  // over the SAME array identity needs no re-inspection. emit/emitStream
  // fold on every frame during streaming — a full rescan of a long window
  // there was the O(rows) per-frame term of long-session streaming.
  const from = cursor === undefined ? 0 : cursor.rows === rows ? cursor.index : 0
  if (cursor !== undefined) cursor.rows = rows
  if (excess <= from) return 0
  let folded = 0
  for (const row of rows.slice(from, excess)) {
    if (row.folded || row.restored) continue
    if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'reasoning' && row.kind !== 'tool') continue
    row.folded = true
    folded += 1
    if (row.kind === 'tool' && row.tool) {
      row.tool.argsFull = undefined
      row.tool.resultFull = undefined
      row.tool.errorText = undefined
      // Presentation views hold duplicated content strings (diff before/
      // after images, terminal output); the session log re-derives them.
      row.tool.callView = undefined
      row.tool.resultView = undefined
    } else if (row.text.length > 0) {
      // Keep a short preview so the transcript reads naturally; the full
      // text lives in the session log and is restored by loadOlder().
      row.text = preview(row.text, 200)
    }
    markChannelReadDirty(row)
    markChannelReadDirty(rows)
  }
  if (cursor !== undefined) cursor.index = excess
  return folded
}

/**
 * Restore folded rows from the session log, newest folded batch first.
 * Rebuilds each folded row's full text from its source events and clears
 * the folded mark, keeping row ids, scroll anchors, and selection stable.
 * `views` re-derives the tool presentation views foldRows dropped (the
 * presenters live on the host plane, so the channel passes them in).
 * Returns the number of rows restored.
 */
export function foldBack(rows: ChatRow[], events: readonly SessionEvent[], views?: ToolViewPresenter): number {
  const folded = rows.filter(row => row.folded)
  if (folded.length === 0) return 0
  const firstFoldedSeq = folded[0]?.seq ?? 0
  const restoreEvents = events.filter(event => event.seq >= firstFoldedSeq)
  // tool results are matched by callId, not seq, because the result event
  // seq differs from the call event seq that anchored the row.
  const resultsByCall = new Map<string, SessionEvent<'tool/result'>>()
  for (const event of restoreEvents) {
    if (event.type === 'tool/result') {
      resultsByCall.set(event.data.message.source.callId, event)
    }
  }
  let restored = 0
  for (const row of folded) {
    const rowSeq = row.seq
    if (rowSeq === undefined) continue
    if (row.kind === 'tool' && row.tool !== undefined) {
      // The tool row is anchored on its tool/call seq; its result text comes
      // from the matching tool/result event.
      const call = restoreEvents.find(event => event.seq === rowSeq && event.type === 'tool/call')
      if (call === undefined || call.type !== 'tool/call') continue
      restoreRowFromEvent(row, call)
      const result = resultsByCall.get(row.tool.callId)
      if (result !== undefined) restoreToolResult(row, result)
      row.tool.callView = views?.call(call.data.name, call.data.arguments)
      row.tool.resultView = result !== undefined && result.data.error === undefined
        ? views?.result(call.data.name, call.data.arguments, result.data)
        : undefined
      row.folded = false
      markChannelReadDirty(row)
      markChannelReadDirty(rows)
      restored += 1
      continue
    }
    // Text rows are anchored on their first delta chunk; the settled
    // assistant/message at or after that seq carries the full text.
    const message = restoreEvents.find(event => event.seq >= rowSeq && event.type === 'assistant/message')
    if (message === undefined) continue
    restoreRowFromEvent(row, message)
    row.folded = false
    markChannelReadDirty(row)
    markChannelReadDirty(rows)
    restored += 1
  }
  return restored
}

/** Rebuild a folded row's full text from its source session event. */
export function restoreRowFromEvent(row: ChatRow, event: SessionEvent): void {
  switch (row.kind) {
    case 'user': {
      if (event.type !== 'user/message') break
      const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'assistant': {
      if (event.type !== 'assistant/message') break
      const text = event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'reasoning': {
      // Thinking text is carried by the assistant/message's reasoning
      // blocks, not the (ephemeral) delta chunks, so the settled message
      // restores it exactly.
      if (event.type !== 'assistant/message') break
      const text = event.data.message.content.map(block => block.type === 'reasoning' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'tool': {
      if (event.type !== 'tool/call' || row.tool === undefined) break
      row.tool.argsFull = event.data.arguments
      break
    }
    default:
      break
  }
}

/** Render the durable tool-result payload, including provider error details. */
export function toolResultText(event: SessionEvent<'tool/result'>): string {
  const block = event.data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return ''
  return block.content.map(item => item.type === 'text' ? item.text : '').join('').trim()
}

/** Phase badge for the harness goal card — mirrors the panel's PhaseBadge. */
export const GOAL_RESULT_BADGE: Record<string, string> = {
  active: '● active',
  paused: '⏸ paused',
  blocked: '⛔ blocked',
  complete: '✓ complete',
}

/**
 * Summary cards for the harness's goal/todo tools. Their results are machine
 * JSON (`{"goal":{…}}` / `{"todos":[…]}`) that would otherwise dump under the
 * tool card as a raw `⎿ {"goal":…}` line. Matched by tool-name substring AND
 * payload shape, so unrelated tools and plain-text results pass through to
 * the registry/raw-text path untouched. Runs on the live stream and replay.
 */
export function harnessToolResultView(
  name: string,
  data: SessionEvent<'tool/result'>['data'],
): ToolResultView | undefined {
  const lower = name.toLowerCase()
  const isGoalTool = lower.includes('goal')
  const isTodoTool = lower.includes('todo')
  if (!isGoalTool && !isTodoTool) return undefined
  const block = data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return undefined
  const text = block.content.map(item => item.type === 'text' ? item.text : '').join('').trim()
  if (text === '' || !text.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>

  if (isGoalTool && typeof record.goal === 'object' && record.goal !== null) {
    const goal = record.goal as Record<string, unknown>
    if (typeof goal.objective === 'string' && typeof goal.phase === 'string') {
      const badge = GOAL_RESULT_BADGE[goal.phase] ?? goal.phase
      const rounds = typeof goal.roundsStarted === 'number' && typeof goal.maxGoalRounds === 'number'
        ? ` · ${goal.roundsStarted}/${goal.maxGoalRounds}`
        : ''
      const activation = typeof record.activation === 'string' ? ` · ${record.activation}` : ''
      const lines = [`🎯 ${goal.objective}`, `${badge}${rounds}${activation}`]
      const blocked = (goal.blockedReason as { message?: unknown } | undefined)?.message
      if (typeof blocked === 'string') lines.push(`⛔ ${blocked}`)
      return { card: 'generic', content: lines.map(line => ({ type: 'text', text: line })) }
    }
  }

  if (isTodoTool && Array.isArray(record.todos)) {
    const rows = record.todos as Array<Record<string, unknown>>
    const done = rows.filter(row => row.status === 'completed').length
    const lines = [`todos ✓ ${done}/${rows.length}`]
    for (const row of rows) {
      if (row.status !== 'in_progress' || typeof row.content !== 'string') continue
      lines.push(`● ${row.content}`)
      if (lines.length >= 4) break
    }
    return { card: 'generic', content: lines.map(line => ({ type: 'text', text: line })) }
  }

  return undefined
}

export function toolErrorText(event: SessionEvent<'tool/result'>): string {
  const failure = event.data.error
  if (failure === undefined) return ''
  const identity = `${failure.name}: ${failure.code}`
  const detail = toolResultText(event)
  return detail === '' || detail === identity ? identity : `${identity} — ${detail}`
}

/** Restore a folded tool row's result text from its tool/result event. */
export function restoreToolResult(row: ChatRow, event: SessionEvent<'tool/result'>): void {
  if (row.tool === undefined) return
  const failure = event.data.error
  if (failure !== undefined) {
    row.tool.status = 'error'
    row.tool.errorText = toolErrorText(event)
    return
  }
  row.tool.status = 'ok'
  const result = toolResultText(event)
  row.tool.resultFull = result || undefined
}

/**
 * Prepare durable events for REPLAY (resume / rewind / model-switch fork):
 * drop settled `assistant/chunk` stream deltas — the sealed
 * `assistant/message` events carry the full text and reasoning blocks, so
 * per-token chunks add nothing to the replayed transcript while costing a
 * per-chunk renderEvent pass (a real 4.5MB session logs ~19k chunks against
 * ~30 messages). The trailing chunk run AFTER the last message belongs to an
 * unfinished step (crash-orphaned turn) and is kept, so a resumed session
 * still shows its partial content. Storage-level packed rows
 * (`text-chunks`/`reasoning-chunks`/`tool-call-chunks`) are dropped the
 * same way — defensive: the jsonl reader expands them, but a future
 * direct-pass path must not resurrect them. Replay-side tps sampling is
 * lost with the chunks (a live metric; lastUsage comes from the message's
 * own usage). Live events never go through this.
 */
export function prepareReplayEvents(events: readonly SessionEvent[]): SessionEvent[] {
  let lastMessageSeq = -1
  for (const event of events) {
    if (event.type === 'assistant/message') lastMessageSeq = event.seq
  }
  return events.filter(event => {
    if (event.type === 'assistant/message') return true
    if (event.type === 'assistant/chunk') {
      // Keep only the in-flight tail (no message sealed after it).
      return lastMessageSeq < 0 || event.seq > lastMessageSeq
    }
    // Storage-level packed rows: not in the SessionEvent union (they exist
    // only in the durable JSON), so compare through a widened view — the
    // defensive drop is exactly for data the static type doesn't know.
    const packedType = (event as { type: string }).type
    if (
      packedType === 'text-chunks' ||
      packedType === 'reasoning-chunks' ||
      packedType === 'tool-call-chunks'
    ) {
      return false
    }
    return true
  })
}
