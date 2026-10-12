/**
 * Fold, paging and live-merge helpers for a child's transcript, shared by
 * the subagent Detail scene and the main-screen AgentTranscriptScene so a
 * child row reads the same wherever it is shown.
 */
import React from 'react'
import type { SubagentOutputLine, SubagentState } from '../../dsh-adapter/subagents.js'
import type { SubagentTranscriptView, ToolRow } from '../../adapter/ports/channel-view.js'
import type { SubagentTranscriptWindow } from '../../agent/capabilities.js'
import type { AgentEvent } from '../../agent/events.js'
import type { AgentMessageView } from './agentTeam.js'
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
  | { kind: 'agent-message'; key: string; message: AgentMessageView }

/** Presentations that never earn a duplicate card here either (the main
 *  projector's rule): a nested delegation renders as the subagent card, a
 *  todo write lives in the todo panel, a question in its dialog. */
export const TRANSCRIPT_SUPPRESSED_CARDS: ReadonlySet<string> = new Set(['subagent', 'todo', 'question'])

/** Where one history page sits among the pages, for placing the agent
 *  message feed: `olderPagesRemain` = the page is not the oldest one, so
 *  messages observed before its first event belong to an older page;
 *  `before` = the start of the newer page already folded (that page holds
 *  the messages from there on). */
export interface TranscriptPagePlacement {
  readonly olderPagesRemain?: boolean
  readonly before?: number
  /** Collects the tool results whose call this page does not hold (the
   *  call sits on an older page), keyed by call id. */
  readonly orphans?: Map<string, ToolResultEvent>
}

type ToolResultEvent = Extract<AgentEvent, { type: 'tool.result' }>

/** Settle a tool card with its recorded result. */
function applyToolResult(tool: ToolRow, event: ToolResultEvent): void {
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
}

/** Fold one history page's lane events into leaf rows (oldest first;
 *  `into` may already hold the older pages' rows). A tool result whose
 *  call is not on this page goes to `page.orphans` (or is dropped without
 *  one) until the older page with the call is folded; consecutive blocks
 *  of one API message join (the store splits a message into per-block
 *  entries sharing the anchor).
 *
 *  `messages` (the agent↔agent feed for THIS child, newest last) is
 *  interleaved by observedAt: each is flushed as an `agent-message` leaf
 *  before the first event observed at/after it. Only the messages that
 *  fall inside this page's span are placed (see TranscriptPagePlacement),
 *  so loading an older page never repeats one. Returns the lower bound of
 *  the span this page took — the `before` for the next older page. */
export function foldTranscriptLeaves(events: readonly AgentEvent[], into: TranscriptLeaf[], messages: readonly AgentMessageView[] = [], page: TranscriptPagePlacement = {}): number {
  const start = events.find(event => eventTime(event) !== undefined)
  const from = page.olderPagesRemain === true && start !== undefined ? eventTime(start)! : Number.NEGATIVE_INFINITY
  const until = page.before ?? Number.POSITIVE_INFINITY
  const own = messages.filter(message => message.observedAt >= from && message.observedAt < until)
  let next = 0
  const flushMessages = (before: number): void => {
    while (next < own.length && own[next]!.observedAt <= before) {
      const message = own[next]!
      into.push({ kind: 'agent-message', key: `am-${message.messageId}`, message })
      next += 1
    }
  }
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
      if (row === undefined) {
        page.orphans?.set(event.callId, event)
        continue
      }
      applyToolResult(row.tool, event)
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
  return from
}

const eventTime = (event: AgentEvent): number | undefined =>
  event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'assistant.message' ? event.time : undefined

/** The transcript page's load state. `ready` keeps its rows while a newer
 *  page reloads (settlement) and while an older window prepends. */
export type TranscriptState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unavailable' }
  | ReadyTranscript

/** A loaded transcript. `messagesFrom` is where the placed agent messages
 *  start (the next older page takes the ones before it); `orphanResults`
 *  are results on the loaded pages whose call is on a page not loaded yet. */
export interface ReadyTranscript {
  readonly status: 'ready'
  readonly agentId: string
  readonly leaves: TranscriptLeaf[]
  readonly parentAgentId: string | null
  readonly hasOlder: boolean
  readonly skippedFromStart: number
  /** Native opaque paging cursor, when the source does not expose a count. */
  readonly sourceCursor?: string
  readonly loadingOlder: boolean
  readonly messagesFrom: number
  readonly orphanResults: ReadonlyMap<string, ToolResultEvent>
}

/** The newest page of a child's transcript, folded. */
export function foldNewestPage(agentId: string, page: SubagentTranscriptView, messages: readonly AgentMessageView[]): ReadyTranscript {
  const leaves: TranscriptLeaf[] = []
  const orphans = new Map<string, ToolResultEvent>()
  const messagesFrom = foldTranscriptLeaves(page.events, leaves, messages, { olderPagesRemain: page.hasOlder, orphans })
  // The newest page can itself repeat one anchor (text, tool, text of one
  // message): its rows carry unique render keys from the start.
  return { status: 'ready', agentId, leaves: uniqueRenderKeys(leaves), parentAgentId: page.parentAgentId, hasOlder: page.hasOlder, skippedFromStart: page.skippedFromStart, ...(page.sourceCursor === undefined ? {} : { sourceCursor: page.sourceCursor }), loadingOlder: false, messagesFrom, orphanResults: orphans }
}

/** One older page folded in front of a loaded transcript: its agent
 *  messages are the ones before the loaded span, and the results the newer
 *  pages held for its calls settle those calls' cards. */
export function foldOlderPage(current: ReadyTranscript, page: SubagentTranscriptView, messages: readonly AgentMessageView[]): ReadyTranscript {
  const fresh: TranscriptLeaf[] = []
  const orphans = new Map<string, ToolResultEvent>()
  const messagesFrom = foldTranscriptLeaves(page.events, fresh, messages, { olderPagesRemain: page.hasOlder, before: current.messagesFrom, orphans })
  const carried = new Map(current.orphanResults)
  for (const leaf of fresh) {
    if (leaf.kind !== 'tool') continue
    const result = carried.get(leaf.tool.callId)
    if (result === undefined) continue
    applyToolResult(leaf.tool, result)
    carried.delete(leaf.tool.callId)
  }
  for (const [callId, result] of orphans) carried.set(callId, result)
  const { sourceCursor: previousCursor, ...previous } = current
  return { ...previous, leaves: prependOlderLeaves(fresh, current.leaves), hasOlder: page.hasOlder, skippedFromStart: page.skippedFromStart, ...(page.sourceCursor === undefined ? {} : { sourceCursor: page.sourceCursor }), loadingOlder: false, messagesFrom, orphanResults: carried }
}

/** One load-older window (messages; matches the backend's newest page). */
export const TRANSCRIPT_OLDER_CHUNK = 400

/** The retained output window both stores keep (channel/activity.ts and
 *  dsh-adapter/subagents.ts): a tail at this size is a WINDOW, and the
 *  output page says so when no transcript source can show the rest. */
export const OUTPUT_WINDOW_CAP = 160

/** A live tail line as the transcript page renders it below the history. */
export type LiveLeaf = { kind: 'live'; line: SubagentOutputLine }

/** Render keys must be unique per row: the store's block-per-entry split can
 *  repeat one anchor inside a page (a text, a tool and another text of one
 *  message), so a repeated key gets an ordinal suffix; a leaf is never
 *  dropped for its key. The first occurrence keeps its key, later ones are
 *  copied. */
export function uniqueRenderKeys(leaves: readonly TranscriptLeaf[]): TranscriptLeaf[] {
  const seen = new Map<string, number>()
  return leaves.map(leaf => {
    const n = seen.get(leaf.key) ?? 0
    seen.set(leaf.key, n + 1)
    return n === 0 ? leaf : { ...leaf, key: `${leaf.key}#${n + 1}` }
  })
}

/** Prepend one older page's folded leaves. The store splits one API message
 *  into per-block entries sharing the anchor, so a block can only be cut
 *  across pages at the boundary: the older page's last leaf against the
 *  current list's first. Those two merge when they share the key and the
 *  text/thinking kind (the fold already joined everything consecutive
 *  within a page). Every other leaf keeps its own row in the older page's
 *  order: a different kind under the same key is kept, and a tool between
 *  two text parts of one message stays between them. No current leaf is
 *  mutated. */
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
  subagent.toolCalls.forEach((call, callIndex) => {
    let at = -1
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!
      if (row.kind === 'tool' && row.tool.callId === call.id) { at = i; break }
    }
    if (at >= 0) {
      const leaf = rows[at] as Extract<TranscriptLeaf, { kind: 'tool' }>
      // A copy: the history leaves are the transcript state, read again on
      // every render — the live status only overlays them here.
      if (leaf.tool.status === 'running' && call.status !== 'running') {
        rows[at] = { ...leaf, tool: {
          ...leaf.tool,
          status: call.status === 'failed' ? 'error' : 'ok',
          errorText: call.error,
          resultText: call.resultPreview,
          ...(call.endedAt !== undefined ? { durationMs: Math.max(0, call.endedAt - leaf.tool.startedAt) } : {}),
        } }
      }
      return
    }
    rows.push({ kind: 'tool', key: call.id ?? `live-call-${callIndex}`, tool: {
      callId: call.id ?? call.name,
      name: call.name,
      argsText: call.argsPreview ?? '',
      status: call.status === 'failed' ? 'error' : call.status === 'running' ? 'running' : 'ok',
      startedAt: call.startedAt,
      ...(call.endedAt !== undefined ? { durationMs: Math.max(0, call.endedAt - call.startedAt) } : {}),
      ...(call.resultPreview !== undefined ? { resultText: call.resultPreview } : {}),
      ...(call.error !== undefined ? { errorText: call.error } : {}),
    } })
  })
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

export type TranscriptLoader = (agentId: string, window?: SubagentTranscriptWindow) => Promise<SubagentTranscriptView | null>

/**
 * The paged history of one child: loads the newest page while `active`,
 * reloads once when `reloadKey` changes (settlement makes the disk copy
 * final), and prepends older windows on demand.
 *
 * The loader and the message feed ride refs: the channel UI proxy mints a
 * fresh loader per read, and a reload must key on what changed (the child,
 * activation, settlement), not on a churning identity. An older window is
 * dropped when the state it was requested for is gone (the view switched
 * to another agent, or a reload moved the newest page under it).
 */
export function useSubagentTranscript(
  loadTranscript: TranscriptLoader | undefined,
  agentId: string,
  active: boolean,
  reloadKey: unknown,
  messages: readonly AgentMessageView[],
): { readonly transcript: TranscriptState; loadOlder(): void } {
  const [transcript, setTranscript] = React.useState<TranscriptState>({ status: 'idle' })
  const loaderRef = React.useRef(loadTranscript)
  loaderRef.current = loadTranscript
  const messagesRef = React.useRef(messages)
  messagesRef.current = messages
  React.useEffect(() => {
    const load = loaderRef.current
    if (!active || load === undefined) return
    let alive = true
    setTranscript(prev => prev.status === 'ready' && prev.agentId === agentId ? prev : { status: 'loading' })
    load(agentId).then(loaded => {
      if (!alive) return
      setTranscript(loaded === null ? { status: 'unavailable' } : foldNewestPage(agentId, loaded, messagesRef.current))
    }, () => { if (alive) setTranscript({ status: 'unavailable' }) })
    return () => { alive = false }
  }, [active, agentId, reloadKey])

  const loadOlder = (): void => {
    const load = loaderRef.current
    if (transcript.status !== 'ready' || !transcript.hasOlder || transcript.loadingOlder || load === undefined) return
    const requestedFor = transcript
    const count = requestedFor.sourceCursor === undefined ? Math.min(TRANSCRIPT_OLDER_CHUNK, requestedFor.skippedFromStart) : TRANSCRIPT_OLDER_CHUNK
    setTranscript(prev => prev === requestedFor ? { ...prev, loadingOlder: true } : prev)
    const current = (prev: TranscriptState): prev is ReadyTranscript =>
      prev.status === 'ready' && prev.agentId === requestedFor.agentId && prev.skippedFromStart === requestedFor.skippedFromStart && prev.sourceCursor === requestedFor.sourceCursor
    load(requestedFor.agentId, { count, skipFromStart: requestedFor.skippedFromStart, ...(requestedFor.sourceCursor === undefined ? {} : { sourceCursor: requestedFor.sourceCursor }) }).then(older => {
      setTranscript(prev => {
        if (!current(prev)) return prev
        if (older === null) return { ...prev, loadingOlder: false }
        return foldOlderPage(prev, older, messagesRef.current)
      })
    }, () => {
      setTranscript(prev => current(prev) ? { ...prev, loadingOlder: false } : prev)
    })
  }

  return { transcript, loadOlder }
}
