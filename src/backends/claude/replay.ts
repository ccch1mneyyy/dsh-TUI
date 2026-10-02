/**
 * Claude session transcript → Agent Domain replay (docs/agent-backend-design.md
 * §4.11, the replay column of §5.1): the durable history a resumed session
 * paints before it follows live events.
 *
 * Input is what the SDK's read API returns — `getSessionMessages(id,
 * {includeSystemMessages:true})`, the model-visible chain (after a
 * compaction: the boundary, the summary, the preserved tail and what came
 * later) — plus each subagent's `getSubagentMessages`. Output is the same
 * vocabulary the live translator emits, produced by the SAME translator
 * (`translate.ts`): assistant blocks, tool calls and results, plan / todo /
 * question tools and the compaction rows map exactly as they do live. Only
 * the turn segmentation is replay's own, because the transcript has no
 * lifecycle frames and no `result`s:
 *
 * - a real user prompt closes the open turn and opens a user turn (its row
 *   anchored at the message uuid — the `uuid` the session pushed, which the
 *   CLI keeps, so live and replayed rows rewind the same way);
 * - a queued prompt (`isQueuedCommand`, a steer folded into a running turn)
 *   joins the open turn, as its `started` frame does live;
 * - `[Request interrupted by user]` closes the turn as aborted (the live
 *   interrupt row); a `task-notification` prompt opens the notification
 *   turn; local-command echoes (`<command-name>`, `<local-command-*>`,
 *   `<bash-stdout>`), meta and synthetic texts never become bubbles — a
 *   user-typed slash command shows as the `/name args` it was typed as
 *   (`/compact` excepted, as live);
 * - a compact summary (`isCompactSummary`) closes the open turn and renders
 *   the compaction rows (`compaction.end` + the summary).
 *
 * Thinking: the CLI records thinking blocks with empty text (the API only
 * returns signatures unless summaries are enabled). A step whose API message
 * reports `output_tokens_details.thinking_tokens` replays the same one-line
 * count row the live `thinking_tokens` estimate produces; an empty block
 * without a count is not shown (as live: nothing to show).
 *
 * Subagents: a subagent's own messages stay off the main transcript (live
 * drops `parent_tool_use_id` traffic too); its `subagent.start` follows the
 * parent `Agent` tool call and its `subagent.end` (terminal state inferred
 * from the tail of its transcript) follows the call's result — immediately,
 * for a background subagent whose result only acknowledges the launch.
 *
 * Not restored from the transcript: the context window (the read API has no
 * field for it; the first live `result` reports it) and the session cost (the
 * resumed CLI's first `result` reports it, as for any session).
 *
 * Pure: no I/O, no clock (event times come from the message timestamps).
 */
import type { AgentEvent } from '../../agent/events.js'
import { createClaudeTranslator } from './translate.js'

type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const arr = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** The tool names the CLI uses for a subagent launch (current, legacy). */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

const INTERRUPT_ECHO = '[Request interrupted by user'
const LOCAL_COMMAND_TAG = /^<local-command-(stdout|stderr|caveat)>/u
const COMMAND_TAG = /^<command-(name|message|args)>/u
const BASH_OUTPUT_TAG = /^<bash-(stdout|stderr)>/u
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/u
const TASK_NOTIFICATION = /^<task-notification>/u

/** One subagent transcript, keyed by the `Agent` tool call that launched it. */
export interface ClaudeSubagentTranscript {
  readonly agentId: string
  readonly messages: readonly unknown[]
}

export interface ClaudeReplayOptions {
  readonly cwd: string
  /** Subagent transcripts by parent `tool_use_id`. */
  readonly subagents?: ReadonlyMap<string, ClaudeSubagentTranscript>
  /** The session's title (custom or generated), when the catalog has one. */
  readonly title?: string
  readonly debug?: (message: string) => void
}

export interface ClaudeReplay {
  readonly events: readonly AgentEvent[]
  /** The counters (and model) the live translator of the resumed session
   *  continues from. */
  readonly start: { readonly turn: number; readonly seq: number; readonly model?: string }
}

/** First text of a user `message.content` (string or block array). */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  for (const block of arr(content)) {
    const value = rec(block)
    if (value?.type === 'text') return str(value.text)
  }
  return undefined
}

/** `/name args` of a recorded slash-command echo. */
function commandLine(text: string): string | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/u.exec(text)?.[1]?.trim()
  if (name === undefined || name === '') return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim() ?? ''
  const slash = name.startsWith('/') ? name : `/${name}`
  return args === '' ? slash : `${slash} ${args}`
}

/** What one user message of the chain is. */
type UserKind =
  | { readonly kind: 'results' }
  | { readonly kind: 'summary'; readonly text: string }
  | { readonly kind: 'prompt'; readonly text: string; readonly queued: boolean }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'notification' }
  | { readonly kind: 'hidden'; readonly why: string }

function classifyUser(message: Rec): UserKind {
  const content = rec(message.message)?.content
  if (arr(content).some(block => rec(block)?.type === 'tool_result')) return { kind: 'results' }
  const raw = userText(content) ?? ''
  const text = raw.trim()
  if (message.isCompactSummary === true) return { kind: 'summary', text }
  if (message.is_meta === true || message.isMeta === true) return { kind: 'hidden', why: 'meta' }
  if (text === '') return { kind: 'hidden', why: 'empty' }
  if (text.startsWith(INTERRUPT_ECHO)) return { kind: 'interrupt' }
  const origin = str(rec(message.origin)?.kind)
  if ((origin !== undefined && origin !== 'human') || TASK_NOTIFICATION.test(text)) return { kind: 'notification' }
  if (LOCAL_COMMAND_TAG.test(text) || BASH_OUTPUT_TAG.test(text)) return { kind: 'hidden', why: 'local output' }
  if (COMMAND_TAG.test(text)) {
    const line = commandLine(text)
    // `/compact` never shows its own row (live hides it too); its summary
    // is the compaction's row.
    if (line === undefined || line === '/compact' || line.startsWith('/compact ')) return { kind: 'hidden', why: 'command echo' }
    return { kind: 'prompt', text: line, queued: message.isQueuedCommand === true }
  }
  const bash = BASH_INPUT.exec(text)
  if (bash !== null) return { kind: 'prompt', text: `!${bash[1]!.trim()}`, queued: false }
  return { kind: 'prompt', text: raw, queued: message.isQueuedCommand === true }
}

/** The terminal state a subagent transcript's tail shows. */
function subagentOutcome(messages: readonly unknown[]): { status: 'completed' | 'failed' | 'unknown'; summary?: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = rec(messages[index])
    if (message === undefined) continue
    const body = rec(message.message)
    if (message.type === 'assistant') {
      const texts = arr(body?.content).flatMap(block => rec(block)?.type === 'text' ? [str(rec(block)?.text) ?? ''] : [])
      const summary = texts.join('').trim()
      if (summary !== '') return { status: 'completed', summary }
      continue
    }
    if (message.type === 'user' && arr(body?.content).some(block => rec(block)?.type === 'tool_result' && rec(block)?.is_error === true)) {
      return { status: 'failed' }
    }
  }
  return { status: 'unknown' }
}

/** Replay one transcript chain. */
export function replayClaudeTranscript(messages: readonly unknown[], options: ClaudeReplayOptions): ClaudeReplay {
  const debug = options.debug ?? (() => undefined)
  let clock = 0
  const translator = createClaudeTranslator({ cwd: options.cwd, userRows: 'lifecycle', now: () => clock, debug })
  const out: AgentEvent[] = []
  /** The open turn saw `[Request interrupted …]`: it closes as aborted. */
  let interrupted = false
  let model: string | undefined
  /** API message ids whose thinking count was already replayed. */
  const counted = new Set<string>()
  /** Subagents launched by a call whose result has not been replayed yet. */
  const launched = new Map<string, { readonly agentId: string; readonly background: boolean; readonly messages: readonly unknown[] }>()

  const closeTurn = (): void => {
    if (!translator.turnOpen) { interrupted = false; return }
    out.push(...translator.forceCloseTurn(interrupted ? { kind: 'aborted' } : { kind: 'completed' }))
    interrupted = false
  }

  const endSubagent = (callId: string): void => {
    const agent = launched.get(callId)
    if (agent === undefined) return
    launched.delete(callId)
    const outcome = subagentOutcome(agent.messages)
    out.push({ type: 'subagent.end', agentId: agent.agentId, status: outcome.status, ...(outcome.summary === undefined ? {} : { summary: outcome.summary }), time: clock })
  }

  const assistant = (message: Rec): void => {
    const body = rec(message.message)
    const id = str(body?.id)
    const messageModel = str(body?.model)
    if (messageModel !== undefined && messageModel !== '' && messageModel !== '<synthetic>') model = messageModel
    out.push(...translator.translate({ type: 'assistant', message: body, uuid: message.uuid, parent_tool_use_id: null }))
    const blocks = arr(body?.content).map(rec)
    // The count row the live `thinking_tokens` estimate produces, from the
    // API's own count (once per API message: every block entry repeats it).
    if (id !== undefined && !counted.has(id) && blocks.some(block => block?.type === 'thinking' && (str(block.thinking) ?? '') === '')) {
      counted.add(id)
      const thinking = num(rec(rec(body?.usage)?.output_tokens_details)?.thinking_tokens)
      if (thinking !== undefined && thinking > 0) out.push(...translator.translate({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: thinking }))
    }
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue
      const callId = str(block.id)
      const name = str(block.name)
      if (callId === undefined || name === undefined || !AGENT_TOOLS.has(name)) continue
      const transcript = options.subagents?.get(callId)
      if (transcript === undefined) continue
      const input = rec(block.input)
      const background = input?.run_in_background === true
      out.push({
        type: 'subagent.start',
        agentId: transcript.agentId,
        parentCallId: callId,
        description: str(input?.description) ?? '',
        ...(str(input?.subagent_type) === undefined ? {} : { kind: str(input?.subagent_type) }),
        background,
        time: clock,
      })
      launched.set(callId, { agentId: transcript.agentId, background, messages: transcript.messages })
      // A background subagent's result only acknowledges the launch; its
      // terminal state is what its transcript shows.
      if (background) endSubagent(callId)
    }
  }

  const user = (message: Rec): void => {
    const uuid = str(message.uuid) ?? `replay-${translator.seqNumber + 1}`
    const kind = classifyUser(message)
    switch (kind.kind) {
      case 'results': {
        out.push(...translator.translate({ type: 'user', uuid, message: message.message, parent_tool_use_id: null }))
        for (const block of arr(rec(message.message)?.content)) {
          const callId = str(rec(block)?.tool_use_id)
          if (callId !== undefined) endSubagent(callId)
        }
        return
      }
      case 'summary':
        closeTurn()
        out.push(...translator.translate({ type: 'system', subtype: 'compact_boundary', compact_metadata: {} }))
        out.push(...translator.translate({ type: 'user', uuid, isSynthetic: true, message: { role: 'user', content: kind.text }, parent_tool_use_id: null }))
        return
      case 'prompt':
        // A prompt folded into a running turn joins it; any other prompt
        // starts the next turn.
        if (!kind.queued) closeTurn()
        translator.registerInput(uuid, kind.text, 'turn')
        out.push(...translator.translate({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }))
        return
      case 'interrupt':
        interrupted = true
        return
      case 'notification':
        closeTurn()
        out.push(...translator.openNotificationTurn())
        return
      case 'hidden':
        debug(`claude replay: ${kind.why} user message not projected`)
        return
      default: {
        const unknown: never = kind
        return unknown
      }
    }
  }

  for (const raw of messages) {
    const message = rec(raw)
    if (message === undefined) continue
    const time = Date.parse(str(message.timestamp) ?? '')
    if (Number.isFinite(time)) clock = time
    // Subagent traffic never interleaves with the main transcript.
    if (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null) continue
    switch (message.type) {
      case 'assistant':
        assistant(message)
        break
      case 'user':
        user(message)
        break
      default:
        // System entries reach the read API without their subtype; the one
        // that matters (a compact boundary) is replayed from the summary
        // that follows it.
        break
    }
  }
  closeTurn()
  for (const callId of [...launched.keys()]) endSubagent(callId)
  if (options.title !== undefined && options.title !== '') out.push({ type: 'session.title', title: options.title, source: 'auto' })
  if (model !== undefined) out.push({ type: 'model.changed', model, source: 'resume' })
  return { events: out, start: { turn: translator.turnNumber, seq: translator.seqNumber, ...(model === undefined ? {} : { model }) } }
}

/**
 * The uuid of the chain entry right before `anchor` — where a conversation
 * rewind cuts (`forkSession({upToMessageId})` keeps it, inclusive). Undefined
 * when `anchor` is not in the chain or is its first entry (nothing precedes
 * it: there is no conversation to rewind to).
 */
export function rewindCutPoint(messages: readonly unknown[], anchor: string): string | undefined {
  const index = messages.findIndex(message => rec(message)?.uuid === anchor)
  if (index <= 0) return undefined
  return str(rec(messages[index - 1])?.uuid)
}

/** The trailing exchanges of a chain, for the browser's preview (newest last). */
export function previewEntries(messages: readonly unknown[], limit: number): { role: 'user' | 'assistant'; text: string; at: number | undefined }[] {
  const entries: { role: 'user' | 'assistant'; text: string; at: number | undefined }[] = []
  /** The API message the last assistant entry came from (one entry per
   *  block on disk: their text joins into one exchange). */
  let lastAssistantId: string | undefined
  for (const raw of messages) {
    const message = rec(raw)
    if (message === undefined || (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null)) continue
    const at = Date.parse(str(message.timestamp) ?? '')
    const time = Number.isFinite(at) ? at : undefined
    if (message.type === 'user') {
      const kind = classifyUser(message)
      if (kind.kind !== 'prompt') continue
      entries.push({ role: 'user', text: kind.text.trim(), at: time })
      lastAssistantId = undefined
      continue
    }
    if (message.type !== 'assistant') continue
    const body = rec(message.message)
    const text = arr(body?.content).flatMap(block => rec(block)?.type === 'text' ? [str(rec(block)?.text) ?? ''] : []).join('').trim()
    if (text === '') continue
    const id = str(body?.id)
    const last = entries.at(-1)
    if (last !== undefined && last.role === 'assistant' && id !== undefined && id === lastAssistantId) last.text = `${last.text}\n${text}`
    else entries.push({ role: 'assistant', text, at: time })
    lastAssistantId = id
  }
  return entries.slice(-limit)
}
