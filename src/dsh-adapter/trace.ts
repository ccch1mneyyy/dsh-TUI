/**
 * `/trace` trajectory view — data assembly (issue #80). Pure functions over
 * the DSH session event log (`SessionEvent[]`, each event carrying a
 * monotonic `seq` and epoch-ms `time`): the log is folded into a flat list
 * of one-line trace entries — one per user/assistant/thinking/todo item,
 * one per turn/step/tool bracket, with the bracket's duration filled in when
 * its closing event arrives (`tool/call` ↔ `tool/result` by callId,
 * `step/start` ↔ `step/end` and `turn/start` ↔ `turn/end` by index).
 *
 * The UI consumes {@link extendTrace}: `agent.session.events` is an
 * immutable snapshot that is REUSED until the next append (dsh-session
 * caches the frozen array), so the previous build is kept and only the new
 * tail is consumed — a long session never pays an O(log) rebuild per frame.
 * {@link buildTraceEntries} is the from-scratch form for tests and one-shot
 * consumers.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stringWidth } from '../ink/stringWidth.js'

/** The entry kinds a trace row can carry. */
export type TraceKind =
  | 'turn'
  | 'step'
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'todo'

/** One line of the trajectory timeline. */
export interface TraceEntry {
  /** Seq of the event the entry was built from (turn/step/tool: the opener). */
  readonly seq: number
  /** Epoch-ms timestamp of that event. */
  readonly time: number
  readonly kind: TraceKind
  /** One-line summary (whitespace flattened, char-capped; the view applies
   *  the final display-width truncation). */
  readonly summary: string
  /** Paired wall-clock duration, filled when the closing event lands. */
  durationMs?: number
  /** Bracket status: open brackets stay `running` until closed. */
  status?: 'running' | 'ok' | 'error'
}

/** The type filters the view cycles through (`f` key). */
export type TraceFilter = 'all' | 'tool' | 'thinking' | 'message' | 'progress'

/** Filter cycle order (the `f` key walks this list). */
export const TRACE_FILTERS: readonly TraceFilter[] = [
  'all',
  'tool',
  'thinking',
  'message',
  'progress',
]

/** Summary char cap (mirrors channel.ts's preview caps — flattened first). */
const SUMMARY_LIMIT = 120

/**
 * One in-progress assembly: the flat entry list plus the open-bracket
 * indexes that pair closers with their opener entries. Kept across appends
 * by {@link extendTrace} so only the new tail is consumed.
 */
export interface TraceBuild {
  /** The event snapshot this build consumed (identity-compared per append). */
  readonly source: readonly SessionEvent[]
  readonly entries: TraceEntry[]
  /** Open tool calls by callId (tool/call → its entry until tool/result). */
  readonly tools: ReadonlyMap<string, TraceEntry>
  /** Open steps by `turn:step` (step/start → its entry until step/end). */
  readonly steps: ReadonlyMap<string, TraceEntry>
  /** Open turns by turn number (turn/start → its entry until turn/end). */
  readonly turns: ReadonlyMap<number, TraceEntry>
}

/** Mutable working copy of a {@link TraceBuild} (its maps/entries mutate). */
interface TraceWorking {
  entries: TraceEntry[]
  tools: Map<string, TraceEntry>
  steps: Map<string, TraceEntry>
  turns: Map<number, TraceEntry>
}

/** Flatten whitespace and cap the summary (channel.ts preview semantics). */
function summarize(text: string, limit: number = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** First text block of a message content array (mention attachments ride as
 *  later blocks — model-facing only, see channel.ts firstTextOf). */
function firstText(content: readonly { type: string; text?: string }[]): string {
  return content.find(block => block.type === 'text')?.text?.trim() ?? ''
}

/** Fold one event into the working build (push entries, pair closers). */
function consume(build: TraceWorking, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/start': {
      const entry: TraceEntry = {
        seq: event.seq,
        time: event.time,
        kind: 'turn',
        summary: `turn ${event.data.turn}`,
        status: 'running',
      }
      build.turns.set(event.data.turn, entry)
      build.entries.push(entry)
      break
    }
    case 'turn/end': {
      const open = build.turns.get(event.data.turn)
      if (open !== undefined) {
        open.durationMs = Math.max(0, event.time - open.time)
        open.status = event.data.reason.kind === 'completed' ? 'ok' : 'error'
        build.turns.delete(event.data.turn)
      }
      break
    }
    case 'step/start': {
      const entry: TraceEntry = {
        seq: event.seq,
        time: event.time,
        kind: 'step',
        summary: `turn ${event.data.turn} · step ${event.data.step}`,
        status: 'running',
      }
      build.steps.set(`${event.data.turn}:${event.data.step}`, entry)
      build.entries.push(entry)
      break
    }
    case 'step/end': {
      const key = `${event.data.turn}:${event.data.step}`
      const open = build.steps.get(key)
      if (open !== undefined) {
        open.durationMs = Math.max(0, event.time - open.time)
        open.status = 'ok'
        build.steps.delete(key)
      }
      break
    }
    case 'user/message': {
      // Only direct human prompts are trajectory items; injected context
      // (plugin/skill/goal sources) mirrors the transcript's filtering.
      if (event.data.source.kind !== 'user') break
      const text = firstText(event.data.content)
      if (text === '') break
      build.entries.push({
        seq: event.seq,
        time: event.time,
        kind: 'user',
        summary: summarize(text),
      })
      break
    }
    case 'assistant/message': {
      // One entry per content block, in block order: reasoning blocks are
      // thinking entries (the view gates them on the /thinking toggle),
      // text blocks are assistant entries.
      for (const block of event.data.message.content) {
        if (block.type === 'reasoning' && block.text.trim() !== '') {
          build.entries.push({
            seq: event.seq,
            time: event.time,
            kind: 'thinking',
            summary: summarize(block.text),
          })
        } else if (block.type === 'text' && block.text.trim() !== '') {
          build.entries.push({
            seq: event.seq,
            time: event.time,
            kind: 'assistant',
            summary: summarize(block.text),
          })
        }
      }
      break
    }
    case 'tool/call': {
      const args = summarize(event.data.arguments, 100)
      const entry: TraceEntry = {
        seq: event.seq,
        time: event.time,
        kind: 'tool',
        summary: args === '' ? event.data.name : `${event.data.name} ${args}`,
        status: 'running',
      }
      build.tools.set(event.data.callId, entry)
      build.entries.push(entry)
      break
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const open = build.tools.get(callId)
      if (open !== undefined) {
        open.durationMs = Math.max(0, event.time - open.time)
        open.status = event.data.error !== undefined ? 'error' : 'ok'
        build.tools.delete(callId)
      }
      break
    }
    case 'todo/write': {
      const todos = event.data.todos
      const done = todos.filter(todo => todo.status === 'completed').length
      const current = todos.find(todo => todo.status === 'in_progress')
      build.entries.push({
        seq: event.seq,
        time: event.time,
        kind: 'todo',
        summary:
          `${done}/${todos.length}` +
          (current === undefined ? '' : ` · ${summarize(current.content, 80)}`),
      })
      break
    }
    default:
      // Chunks (token-level replay fidelity), request header/context, seed
      // markers and plugin log-only events carry no trajectory line.
      break
  }
}

/**
 * Assemble the trace from scratch (tests, one-shot consumers). Live UI uses
 * {@link extendTrace} to reuse the previous build across appends.
 */
export function buildTraceEntries(events: readonly SessionEvent[]): TraceEntry[] {
  return extendTrace(null, events).entries
}

/**
 * Extend a previous build with the session's current event snapshot. The
 * snapshot is append-only with stable event object identity (dsh-session
 * freezes each event at append), so a snapshot that prefix-extends the
 * previous one only consumes the new tail; anything else (agent swap on
 * /resume /rewind /new) triggers a full rebuild.
 */
export function extendTrace(
  prev: TraceBuild | null,
  events: readonly SessionEvent[],
): TraceBuild {
  if (
    prev !== null &&
    events.length >= prev.source.length &&
    (prev.source.length === 0 ||
      events[prev.source.length - 1] === prev.source[prev.source.length - 1])
  ) {
    if (events.length === prev.source.length) return prev
    const working: TraceWorking = {
      entries: prev.entries,
      tools: new Map(prev.tools),
      steps: new Map(prev.steps),
      turns: new Map(prev.turns),
    }
    for (let index = prev.source.length; index < events.length; index++) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: index bounded by events.length
      consume(working, events[index]!)
    }
    return { source: events, ...working }
  }
  const working: TraceWorking = {
    entries: [],
    tools: new Map(),
    steps: new Map(),
    turns: new Map(),
  }
  for (const event of events) consume(working, event)
  return { source: events, ...working }
}

/** Apply a type filter (the `f` key cycles {@link TRACE_FILTERS}). */
export function filterTraceEntries(
  entries: readonly TraceEntry[],
  filter: TraceFilter,
): readonly TraceEntry[] {
  switch (filter) {
    case 'all':
      return entries
    case 'tool':
      return entries.filter(entry => entry.kind === 'tool')
    case 'thinking':
      return entries.filter(entry => entry.kind === 'thinking')
    case 'message':
      return entries.filter(entry => entry.kind === 'user' || entry.kind === 'assistant')
    case 'progress':
      return entries.filter(entry => entry.kind === 'turn' || entry.kind === 'step')
  }
}

/** `HH:MM:SS` wall-clock of an event timestamp (local time, zero-padded). */
export function formatClock(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Compact paired duration: `350ms` / `1.5s` / `2m05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/**
 * Truncate a plain (no-ANSI) string to a terminal display width, CJK-aware
 * (wide chars count 2 via the ink core's stringWidth). Appends `…` when cut.
 */
export function truncateWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  let width = 0
  let out = ''
  for (const char of text) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    out += char
  }
  return `${out}…`
}
