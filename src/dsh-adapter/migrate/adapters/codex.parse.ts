/**
 * Codex rollout parsing (pure): one `rollout-*.jsonl` → one
 * {@link MigrationSession}.
 *
 * Rows are `{ timestamp, type, payload }` envelopes. `session_meta` and
 * `turn_context` carry metadata (cwd, the model in effect); `response_item`
 * rows are the model-visible history (OpenAI Responses items); `event_msg`
 * rows are UI housekeeping that repeats response items and is skipped.
 *
 * Codex writes its harness context as user-role blocks: `<environment_context>`,
 * `<user_instructions>` and other `<…>` blocks, and the
 * `# AGENTS.md instructions` block that opens most rollouts. Those blocks are
 * dropped; a user message made only of them opens no turn and never titles
 * the session.
 *
 * Tool traffic: `function_call` / `custom_tool_call` items are tool calls of
 * the step in progress; their `*_output` items pair back by `call_id`. A
 * step is one model call: an output ends it, and the next model-produced
 * item opens the next one. `agent_message` items (a sub-agent's report to
 * this thread) are inputs of the next model call.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/codex.parse
 */
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { isInjectedText, unwrapUserText } from '../parse/injection.js'
import { emptyStats } from '../parse/role-turns.js'
import { normalizeTitle } from '../parse/title.js'
import { CallIndex, IMAGE_PLACEHOLDER, closeToolPairs, newStep } from '../parse/tools.js'
import type { ImportCompaction, ImportStep, ImportTurn, MigrationSession } from '../types.js'

/** What the adapter knows about a rollout besides its text. */
export interface CodexRolloutInput {
  readonly raw: string
  /** The rollout's stable source id (the uuid in its file name). */
  readonly sourceId: string
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Text of the blocks of one kind (`input_text` / `output_text`). */
function blocksText(content: unknown, want: string): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === want && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Codex-only frames around or beside the human's words: the text blocks that
 * wrap an attached image, the aborted-turn marker, and shell-command echoes.
 * Matched as prefixes like the shared table — a user text that merely starts
 * with `<` (an HTML or XML question) is the human's and must stay.
 */
const CODEX_FRAME_PREFIXES: readonly string[] = ['<image name=', '</image>', '<turn_aborted>', '<user_shell_command>']

function isCodexFrame(text: string): boolean {
  const head = text.trimStart()
  return CODEX_FRAME_PREFIXES.some(prefix => head.startsWith(prefix))
}

/** The human part of a user message: harness blocks dropped, images kept as
 *  placeholders. Returns the text and how many blocks were dropped. */
function userPrompt(content: unknown): { text: string, dropped: number } {
  if (!Array.isArray(content)) return { text: '', dropped: 0 }
  const parts: string[] = []
  let dropped = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'input_image') {
      parts.push(IMAGE_PLACEHOLDER)
    } else if (block.type === 'input_text' && typeof block.text === 'string' && block.text.trim() !== '') {
      if (isCodexFrame(block.text) || isInjectedText(block.text)) dropped += 1
      else parts.push(block.text)
    }
  }
  return { text: parts.join('\n\n').trim(), dropped }
}

/**
 * Model-facing text of a tool output. Codex writes three shapes: a plain
 * string, a JSON string `{"output": "...", "metadata": …}` (the inner output
 * is what the model saw), and an array of `input_text` / `input_image`
 * blocks (the most common shape in current rollouts).
 */
function toolOutputText(output: unknown): string {
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const block of output) {
      if (!isRecord(block)) continue
      if (block.type === 'input_text' && typeof block.text === 'string') parts.push(block.text)
      else if (block.type === 'input_image') parts.push(IMAGE_PLACEHOLDER)
    }
    return parts.join('\n')
  }
  if (isRecord(output)) return typeof output.output === 'string' ? output.output : JSON.stringify(output)
  if (typeof output !== 'string') return ''
  if (output.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(output)
      if (isRecord(parsed) && typeof parsed.output === 'string') return parsed.output
    } catch {
      // Plain text that happens to start with a brace.
    }
  }
  return output
}

/**
 * Parse one Codex rollout.
 * @returns The session, or undefined when it records no cwd or no prompt, or
 *   is a sub-agent thread (`thread_source: 'subagent'` / `source.subagent`):
 *   those are spawned by a main session and are not conversations of their
 *   own. Forks (`forked_from_id` without the sub-agent marker) are kept.
 */
export function parseCodexRollout(input: CodexRolloutInput): MigrationSession | undefined {
  const { records, badLines } = parseJsonl(input.raw)
  const stats = { ...emptyStats(), badLines }
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  let cwd: string | undefined
  let startedAt = 0
  let model: string | undefined

  const calls = new CallIndex()
  /** The model call in progress; a tool output ends it (see modelStep). */
  let step: ImportStep | undefined
  let sawOutput = false
  let unnamedCalls = 0
  let sawMeta = false
  /** Messages from sub-agents waiting for the next model call. */
  let pendingInputs: string[] = []
  let subagent = false
  /** A compaction summary waiting for the turn that follows the boundary. */
  let pendingCompaction: ImportCompaction | undefined

  const openTurn = (prompt: string): void => {
    // Sub-agent messages no model call consumed before a new prompt are stale.
    if (prompt !== '') {
      stats.filtered += pendingInputs.length
      pendingInputs = []
    }
    current = pendingCompaction === undefined ? { prompt, steps: [] } : { prompt, compaction: pendingCompaction, steps: [] }
    pendingCompaction = undefined
    turns.push(current)
    step = undefined
  }

  /**
   * The step a model-produced item belongs to. One model call returns its
   * reasoning, message and tool calls together, then the harness appends the
   * tool outputs; so the first model item AFTER an output starts the next
   * call.
   */
  const modelStep = (): ImportStep => {
    if (current === undefined) openTurn('')
    if (step === undefined || sawOutput) {
      step = newStep(model)
      step.inputs = pendingInputs
      pendingInputs = []
      current!.steps.push(step)
      sawOutput = false
    }
    return step
  }

  const acceptItem = (payload: JsonRecord): void => {
    switch (payload.type) {
      case 'message': {
        if (payload.role === 'user') {
          const { text: prompt, dropped } = userPrompt(payload.content)
          stats.filtered += dropped
          if (prompt === '') return
          openTurn(prompt)
        } else if (payload.role === 'assistant') {
          const text = blocksText(payload.content, 'output_text')
          if (text !== '') modelStep().blocks.push({ type: 'text', text })
        }
        return
      }
      case 'agent_message': {
        // A sub-agent's report delivered to this thread: model-visible input
        // of the next model call, not a turn of its own.
        const text = blocksText(payload.content, 'input_text')
        if (text === '') return
        pendingInputs.push(text)
        stats.meta += 1
        sawOutput = true
        return
      }
      case 'reasoning': {
        // The readable part is the summary; `encrypted_content` is opaque
        // provider state and is never copied.
        const text = Array.isArray(payload.summary)
          ? payload.summary.filter(isRecord).map(part => part.text).filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n\n')
          : ''
        if (text !== '') modelStep().blocks.push({ type: 'reasoning', text })
        return
      }
      case 'function_call':
      case 'custom_tool_call': {
        const id = typeof payload.call_id === 'string' && payload.call_id !== '' ? payload.call_id : `codex-call-${++unnamedCalls}`
        const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : 'unknown'
        // function_call arguments are the model's JSON text; a custom tool's
        // input is free-form (a patch, a JS snippet), kept as one JSON field.
        const args = payload.type === 'function_call'
          ? (typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments ?? {}))
          : JSON.stringify({ input: payload.input ?? '' })
        const target = modelStep()
        target.blocks.push({ type: 'tool-call', id, name, arguments: args })
        calls.register(target)
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        if (typeof payload.call_id === 'string') calls.attach(payload.call_id, toolOutputText(payload.output), false)
        else calls.orphans += 1
        sawOutput = true
      }
    }
  }

  for (const record of records) {
    const payload = record.payload
    if (!isRecord(payload)) continue
    const time = toMillis(record.timestamp)
    if (record.type === 'session_meta') {
      // Only the FIRST meta describes this rollout: a forked or spawned
      // thread repeats its parent's meta after its own, with the inherited
      // history.
      if (!sawMeta) {
        sawMeta = true
        if (typeof payload.cwd === 'string' && payload.cwd !== '') cwd = payload.cwd
        startedAt ||= toMillis(payload.timestamp) || time
        subagent = payload.thread_source === 'subagent' || (isRecord(payload.source) && payload.source.subagent !== undefined)
      }
      continue
    }
    // Codex records the active model per turn; it applies to the steps after it.
    // Compaction boundary: Codex folded the window before it into a handoff
    // summary and kept writing the same rollout. The summary becomes a
    // native checkpoint in front of the next turn; a turn cut in half by the
    // boundary continues as a prompt-less turn after it.
    if (record.type === 'compacted') {
      const summary = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (summary !== '') {
        pendingCompaction = model === undefined ? { summary } : { summary, model }
        current = undefined
        step = undefined
      }
      continue
    }
    // The only event_msg that carries meaning the response items lack: the
    // turn was interrupted (the recorded reason is always a coarse
    // 'interrupted').
    if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
      if (current !== undefined) current.aborted = true
      continue
    }
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model !== '') model = payload.model
      continue
    }
    if (record.type !== 'response_item') continue
    startedAt ||= time
    acceptItem(payload)
  }

  stats.filtered += pendingInputs.length
  if (pendingCompaction !== undefined) turns.push({ prompt: '', compaction: pendingCompaction, steps: [] })
  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0 || turn.compaction !== undefined)
  stats.droppedToolResults = calls.orphans + closeToolPairs(turns)
  if (subagent || cwd === undefined || !turns.some(turn => turn.prompt !== '')) return undefined
  // Codex keeps no title of its own: the first real prompt is the fallback.
  const firstPrompt = turns.find(turn => turn.prompt !== '')?.prompt
  const title = normalizeTitle(firstPrompt === undefined ? undefined : unwrapUserText(firstPrompt))
  return { sourceId: input.sourceId, cwd, ...(title === '' ? {} : { title }), titleExplicit: false, startedAt, turns, stats }
}
