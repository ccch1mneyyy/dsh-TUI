/**
 * Side Question (`/btw`): a single-turn call without tools, replaying the
 * live session's derived history (prompt-cache reuse, compaction-style
 * auxiliary call) plus one wrapped user message. The answer never enters
 * the session log — it is pure UI state in the Chat screen.
 *
 * @module
 */

import { BlockAssembler, type ContentBlock, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { answeredToolCallIds } from './compat/messages.js'

type ToolCall = Extract<ContentBlock, { type: 'tool-call' }>

/** Per-call argument budget in the pending-calls note; a file write can carry megabytes. */
const PENDING_ARGS_LIMIT = 400

/**
 * Describe the auxiliary call's scope: one answer from existing context,
 * with no tools, follow-up actions, or interruption of the main session.
 * `pending` names the main task's in-flight calls, which
 * {@link splitUnresolvedToolCalls} removed from the replayed history.
 */
export function wrapSideQuestion(question: string, pending: readonly ToolCall[] = []): string {
  const running = pending.length === 0 ? '' : `
The main task is still executing these tool calls; their results are not available yet:
${pending.map(call => `- ${call.name} ${clip(oneLine(call.arguments), PENDING_ARGS_LIMIT)}`).join('\n')}`
  return `<side-question-context>
Give one concise answer to the question below using the conversation already provided.
This auxiliary call runs alongside the main session. The main task continues independently;
do not describe it as interrupted, resumed, or as work performed by this call.
No tools are available here: do not claim to inspect files, execute commands, browse,
or carry out future actions. There will be no follow-up turn for this call.
When the available context is insufficient, state what is unknown without promising research.${running}
</side-question-context>

${question}`
}

/** Pretty-printed arguments carry literal breaks (the native adapter keeps the provider string); keep one bullet line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Cut at a code-unit budget without stranding a high surrogate (a lone one reaches the wire as `\ud83d`). */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const code = text.charCodeAt(limit - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
  return `${text.slice(0, end)}…`
}

/**
 * Split assistant `tool-call` blocks whose result never entered the derived
 * history out of it. The composer runs `/btw` immediately while the main turn
 * streams, so the derived tail can end on a tool request still executing
 * (a running command, a job read). Providers reject that transcript ("An
 * assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"): pi-ai routes pad such calls with
 * synthetic results, but the native DeepSeek adapter (dsh-llm-deepseek, 0.1.5
 * hosts) serializes history verbatim and gets a 400. Every unanswered call is
 * removed — with any message left without content — but only those in
 * `running` (see {@link openStepToolCallIds}) come back as `pending` for the
 * wrapper to name: a closed step can keep a call without a result (a failed
 * tool scheduler still appends `step/end`), and that call is not executing.
 * A history whose calls are all answered is returned unchanged.
 *
 * 0.1.7 answers a call with a tool-role message carrying `toolCallId`; older
 * logs wrap the result in a `tool-result` block inside a user message; both
 * shapes count as answered via `answeredToolCallIds` (compat/messages.ts).
 */
export function splitUnresolvedToolCalls(messages: readonly Message[], running: ReadonlySet<string>): {
  messages: readonly Message[]
  pending: ToolCall[]
} {
  const answered = new Set<string>()
  const calls: ToolCall[] = []
  for (const message of messages) {
    for (const id of answeredToolCallIds(message)) answered.add(id)
    if (message.role !== 'assistant') continue
    for (const block of message.content) if (block.type === 'tool-call') calls.push(block)
  }
  const unresolved = new Set(calls.filter(call => !answered.has(call.id)).map(call => call.id))
  if (unresolved.size === 0) return { messages, pending: [] }
  const pending = calls.filter(call => unresolved.has(call.id) && running.has(call.id))
  const kept: Message[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') {
      kept.push(message)
      continue
    }
    const content = message.content.filter(block => block.type !== 'tool-call' || !unresolved.has(block.id))
    // A reasoning-only remainder stays: upstream replays the same shape for a
    // turn interrupted mid-thinking. An emptied message drops the way
    // deriveEventMessage drops an empty assistant/message; the user→user
    // adjacency this can leave already reaches the native adapter from the
    // agent loop itself (prompt + runtime-context user messages).
    if (content.length === 0) continue
    kept.push(content.length === message.content.length ? message : { ...message, content })
  }
  return { messages: kept, pending }
}

/**
 * Tool-call ids of the open step still waiting for their result: the calls
 * the main task is executing right now. Mirrors dsh-session's crash-tail
 * scan — a turn or step boundary closes every earlier call, answered or not.
 * Ids come from `assistant/message`, not `tool/call`: upstream appends
 * `tool/call` only when execution starts, so queued calls would go unnamed.
 * `source.callId` is required on every supported line and read unguarded upstream.
 */
export function openStepToolCallIds(events: readonly SessionEvent[]): Set<string> {
  const open = new Set<string>()
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/end') open.clear()
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) if (block.type === 'tool-call') open.add(block.id)
    }
    if (event.type === 'tool/result') open.delete(event.data.message.source.callId)
  }
  return open
}

/** Outcome of one side question: the visible text answer, or an error. */
export interface SideQuestionOutcome {
  answer: string | null
  error?: string
}

/**
 * Run one side-question call: stream the assembled options, fold chunks
 * through the shared BlockAssembler, and surface the assembled text
 * blocks as the answer. `onText` receives visible text deltas only
 * (reasoning deltas are ignored — a side question wants the quick answer).
 */
export async function runSideQuestion(params: {
  /** `ctx.llm.stream` (bound); the options below pass through verbatim. */
  stream: (options: object) => AsyncIterable<StreamChunk>
  /** Assembled GenerateOptions — no `tools` field, ever. */
  options: object
  /** Streaming display hook (text deltas only). */
  onText?: (delta: string) => void
  /** Cancellation: aborting yields `{answer: null}` with no error text. */
  signal?: AbortSignal
}): Promise<SideQuestionOutcome> {
  const { stream, options, onText, signal } = params
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of stream(options)) {
      assembler.push(chunk)
      if (chunk.type === 'text-delta' && chunk.text) onText?.(chunk.text)
    }
  } catch (error) {
    if (signal?.aborted) return { answer: null }
    return { answer: null, error: error instanceof Error ? error.message : String(error) }
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return { answer: null, error: finish.failure.message }
  }
  const answer = assembler.blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (answer === '') return { answer: null, error: 'No response received' }
  return { answer }
}
