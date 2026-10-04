/**
 * Shared F8 transcript fold/page/merge helpers (design agent-team-full
 * §4.3): the Detail scene and the main-screen AgentTranscriptScene fold a
 * child's history lane through the SAME pure pipeline, so a child row reads
 * exactly like a main one wherever it is shown. Extracted verbatim from
 * SubagentDetailScene — behavior-preserving; the Detail scene keeps its
 * pages/focus/fold state, this module keeps the leaf vocabulary.
 */
import type { SubagentOutputLine, SubagentState } from '../../dsh-adapter/subagents.js'
import type { ToolRow } from '../../adapter/ports/channel-view.js'
import type { AgentEvent } from '../../agent/events.js'
import { ARGS_PREVIEW_LIMIT, preview, RESULT_PREVIEW_LIMIT } from '../../channel/transcript.js'

/** One folded leaf of the child's transcript: thinking (a real body, or
 *  the honest "body unavailable" marker a signature/count-only block
 *  degrades to), text and tool cards — the vocabulary the shared leaf
 *  renderers paint, so a child row reads exactly like a main one. */
export type TranscriptLeaf =
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'thinking-unavailable'; key: string; tokens: number | undefined }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: ToolRow }
  | { kind: 'agent-message'; key: string; message: import('./agentTeam.js').AgentMessageView }

/** Presentations that never earn a duplicate card here either (the main
 *  projector's rule): a nested delegation renders as the subagent card, a
 *  todo write lives in the todo panel, a question in its dialog. */
export const TRANSCRIPT_SUPPRESSED_CARDS: ReadonlySet<string> = new Set(['subagent', 'todo', 'question'])

/** Fold one history page's lane events into leaf rows (oldest first;
 *  `into` may already hold the older pages' rows). A tool result without
 *  its call is dropped — nothing to attach it to; consecutive blocks of
 *  one API message join (the store splits a message into per-block
 *  entries sharing the anchor).
 *
 *  `messages` (the durable agent↔agent feed for THIS child, newest last)
 *  interleaves by observedAt: each is flushed as an `agent-message` leaf
 *  before the first event observed at/after it, so the flow shares the
 *  page window and the load-older walk with thinking/text/tool rows
 *  (design §5.4 — never copied into an ordinary message row). */
export function foldTranscriptLeaves(events: readonly AgentEvent[], into: TranscriptLeaf[], messages: readonly import('./agentTeam.js').AgentMessageView[] = []): void {
  let next = 0
  const flushMessages = (before: number): void => {
    while (next < messages.length && messages[next]!.observedAt <= before) {
      const message = messages[next]!
      into.push({ kind: 'agent-message', key: `am-${message.messageId}`, message })
      next += 1
    }
  }
  const eventTime = (event: AgentEvent): number | undefined =>
    event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'assistant.message' ? event.time : undefined
  for (const event of events) {
    const at = eventTime(event)
    if (at !== undefined) flushMessages(at)
    if (event.type === 'tool.call') {
      if (event.presentation !== undefined && TRANSCRIPT_SUPPRESSED_CARDS.has(event.presentation.card)) continue
      into.push({ kind: 'tool', key: event.callId, tool: {
        callId: event.callId,
        name: event.name,
        argsText: preview(event.argsJson, ARGS_PREVIEW_LIMIT),
        argsFull: event.argsJson,
        status: 'running',
        callView: event.presentation as ToolRow['callView'],
        startedAt: event.time,
      } })
      continue
    }
    if (event.type === 'tool.result') {
      let row: Extract<TranscriptLeaf, { kind: 'tool' }> | undefined
      for (let i = into.length - 1; i >= 0; i -= 1) {
        const leaf = into[i]!
        if (leaf.kind === 'tool' && leaf.tool.callId === event.callId) { row = leaf; break }
      }
      if (row === undefined) continue
      const tool = row.tool
      tool.durationMs = Math.max(0, event.time - tool.startedAt)
      if (event.isError) {
        tool.status = 'error'
        tool.errorText = event.errorText ?? ''
      } else {
        tool.status = 'ok'
        tool.resultText = event.text !== '' ? preview(event.text, RESULT_PREVIEW_LIMIT) : undefined
        tool.resultFull = event.text !== '' ? event.text : undefined
        tool.resultView = event.presentation as ToolRow['resultView']
      }
      continue
    }
    if (event.type === 'assistant.message') {
      for (const block of event.blocks) {
        if (block.type === 'reasoning') {
          const last = into.at(-1)
          if (last !== undefined && last.kind === 'thinking' && last.key === event.anchor) last.text = last.text === '' ? block.text ?? '' : `${last.text}\n${block.text ?? ''}`
          else into.push({ kind: 'thinking', key: event.anchor, text: block.text ?? '' })
          continue
        }
        if (block.type === 'reasoning-tokens' || block.type === 'reasoning-signature') {
          into.push({ kind: 'thinking-unavailable', key: `${event.anchor}:ua`, tokens: block.type === 'reasoning-tokens' && Number.isFinite(Number(block.text)) ? Number(block.text) : undefined })
          continue
        }
        if (block.type === 'text') {
          const last = into.at(-1)
          if (last !== undefined && last.kind === 'text' && last.key === event.anchor) last.text = `${last.text}\n${block.text ?? ''}`
          else into.push({ kind: 'text', key: event.anchor, text: block.text ?? '' })
        }
      }
    }
  }
  flushMessages(Number.POSITIVE_INFINITY)
}

/** The transcript page's load state. `ready` keeps its rows while a newer
 *  page reloads (settlement) and while an older window prepends. */
export type TranscriptState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; agentId: string; leaves: TranscriptLeaf[]; parentAgentId: string | null; hasOlder: boolean; skippedFromStart: number; loadingOlder: boolean }

/** One load-older window (messages; matches the backend's newest page). */
export const TRANSCRIPT_OLDER_CHUNK = 400

/** The retained output window both stores keep (channel/activity.ts and
 *  dsh-adapter/subagents.ts): a tail at this size is a WINDOW, and the
 *  output page says so when no transcript source can show the rest. */
export const OUTPUT_WINDOW_CAP = 160

/** A live tail line as the transcript page renders it below the history. */
export type LiveLeaf = { kind: 'live'; line: SubagentOutputLine }

/** Render keys must be unique per row: the store's block-per-entry split can
 *  legitimately repeat one anchor inside a page (a text, a tool and another
 *  text of ONE message), so a repeated key gets an ordinal suffix instead of
 *  colliding. A key collision is never a reason to drop a leaf (RV round 3).
 *  Pure — first occurrence keeps its key, later ones are copied. */
export function uniqueRenderKeys(leaves: readonly TranscriptLeaf[]): TranscriptLeaf[] {
  const seen = new Map<string, number>()
  return leaves.map(leaf => {
    const n = seen.get(leaf.key) ?? 0
    seen.set(leaf.key, n + 1)
    return n === 0 ? leaf : { ...leaf, key: `${leaf.key}#${n + 1}` }
  })
}

/** Prepend one older page's folded leaves (RV rounds 2+3). The store splits
 *  one API message into per-block entries sharing the anchor, so the ONLY
 *  place a block can be split across pages is the physical boundary: the
 *  older page's LAST leaf against the current list's FIRST leaf. Those two
 *  merge when they are the same key AND the same text/thinking kind (the
 *  fold already joined everything consecutive within a page; successive
 *  load-olders keep merging into the same head leaf). Every OTHER leaf
 *  keeps its own row in the older page's original order — a heterogeneous
 *  part under a taken key (a reasoning against a text of one message) is
 *  NEVER dropped, and a tool between two same-anchor text parts stays
 *  between them (no hoisting). Pure — no current leaf is mutated. */
export function prependOlderLeaves(fresh: readonly TranscriptLeaf[], current: readonly TranscriptLeaf[]): TranscriptLeaf[] {
  let older: readonly TranscriptLeaf[] = fresh
  let head = current
  const last = fresh.at(-1)
  const first = current[0]
  if (
    last !== undefined && first !== undefined &&
    (first.kind === 'text' || first.kind === 'thinking') &&
    first.kind === last.kind && first.key === last.key
  ) {
    // Same-kind boundary blocks of one message: one continuous block the
    // page slice cut — the older text precedes, the order it was written in.
    head = [{ ...first, text: `${last.text}\n${first.text}` }, ...current.slice(1)]
    older = fresh.slice(0, -1)
  }
  return uniqueRenderKeys([...older, ...head])
}

const capLike = (line: string): string => (line.length > 400 ? `${line.slice(0, 400)}…` : line)

/** Merge the channel's live window into the folded history: tool records
 *  pair by call id (live status/previews win while the disk has not
 *  recorded the result; a call the history never saw appends as live),
 *  and text/thinking tail lines the loaded history already paints are
 *  suppressed — a settled block's lines are identical on both sides — so
 *  history and live neither double a row nor drop a tail. */
export function mergeLiveWindow(leaves: readonly TranscriptLeaf[], subagent: SubagentState, hasHistory: boolean): (TranscriptLeaf | LiveLeaf)[] {
  const rows: (TranscriptLeaf | LiveLeaf)[] = [...leaves]
  for (const call of subagent.toolCalls) {
    let leaf: Extract<TranscriptLeaf, { kind: 'tool' }> | undefined
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!
      if (row.kind === 'tool' && row.tool.callId === call.id) { leaf = row; break }
    }
    if (leaf !== undefined) {
      if (leaf.tool.status === 'running' && call.status !== 'running') {
        leaf.tool.status = call.status === 'failed' ? 'error' : 'ok'
        leaf.tool.errorText = call.error
        leaf.tool.resultText = call.resultPreview
        if (call.endedAt !== undefined) leaf.tool.durationMs = Math.max(0, call.endedAt - leaf.tool.startedAt)
      }
      continue
    }
    rows.push({ kind: 'tool', key: call.id ?? call.name, tool: {
      callId: call.id ?? call.name,
      name: call.name,
      argsText: call.argsPreview ?? '',
      status: call.status === 'failed' ? 'error' : call.status === 'running' ? 'running' : 'ok',
      startedAt: call.startedAt,
      ...(call.endedAt !== undefined ? { durationMs: Math.max(0, call.endedAt - call.startedAt) } : {}),
      ...(call.resultPreview !== undefined ? { resultText: call.resultPreview } : {}),
      ...(call.error !== undefined ? { errorText: call.error } : {}),
    } })
  }
  if (!hasHistory) {
    for (const line of subagent.outputEvents) rows.push({ kind: 'live', line })
    return rows
  }
  const seen = new Set<string>()
  for (const leaf of leaves) {
    if (leaf.kind !== 'text' && leaf.kind !== 'thinking') continue
    for (const line of leaf.text.split('\n')) if (line.trim() !== '') seen.add(capLike(line))
  }
  for (const line of subagent.outputEvents) {
    if (line.text.trim() !== '' && seen.has(capLike(line.text))) continue
    rows.push({ kind: 'live', line })
  }
  return rows
}
