/**
 * Claude Code transcript parsing (pure): one `<session>.jsonl` → one
 * {@link MigrationSession}.
 *
 * Lines are self-describing (`type`). A human prompt is a `user` line whose
 * content is a string or text blocks; an assistant line carries ONE content
 * block of a model response, and one response spans several lines sharing
 * `message.id` (thinking, text, each tool_use — tool results can land
 * between them). Those lines are merged back into one step: one step is one
 * model call.
 *
 * Tool results arrive as `user` lines of `tool_result` blocks, usually
 * after every tool_use of the response has been written; each is paired to
 * the step that made the call by `tool_use_id` (never to the newest step).
 *
 * Machine text in the user role: `isMeta` lines are context the model saw
 * mid-turn and become the next step's inputs (never a turn); slash-command
 * echoes become `/name args` prompts, dropped when the model never answered
 * them (local commands); local-command output and other injection is
 * dropped. Everything dropped is counted in `stats.filtered`.
 *
 * A `user` line flagged `isCompactSummary` is a compaction boundary: its
 * text becomes the checkpoint in front of the next turn (sessionize writes
 * the native compaction transaction). The legacy 2.0.x `summary` record is
 * a one-line leaf title written at the head of a file, not a boundary.
 *
 * Title authority: `custom-title` (the user's /rename; the LAST one wins —
 * renames append) > legacy `summary` > `ai-title` (the FIRST one; later
 * ones are rewritten per turn and drift) > the first real prompt as a
 * fallback that is not written to the log.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/claude-code.parse
 */
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { isInjectedText, stripSystemReminders, unwrapUserText } from '../parse/injection.js'
import { emptyStats } from '../parse/role-turns.js'
import { normalizeTitle } from '../parse/title.js'
import { CallIndex, IMAGE_PLACEHOLDER, closeToolPairs, newStep } from '../parse/tools.js'
import type { ImportCompaction, ImportStep, ImportTurn, MigrationSession } from '../types.js'

/** What the adapter knows about a transcript besides its text. */
export interface ClaudeTranscriptInput {
  readonly raw: string
  /** File name without `.jsonl` — the session's stable source id. */
  readonly fileStem: string
  /** cwd derived from the project directory name, used when no line records one. */
  readonly fallbackCwd: string
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Text of a string or block-array content; each image becomes a placeholder. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
    else if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER)
  }
  return parts.join('\n\n')
}

/** Model-facing text of a tool_result's content: a string, or text blocks
 *  with each image replaced by a placeholder. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(IMAGE_PLACEHOLDER)
  }
  return parts.join('\n')
}

/** Whether a user text is Claude Code's echo of a slash command. */
function isCommandEcho(text: string): boolean {
  return text.startsWith('<command-name>') || text.startsWith('<command-message>')
}

/** Body of the first `<tag>…</tag>` in text, or ''. */
function tagBody(text: string, tag: string): string {
  const open = `<${tag}>`
  const start = text.indexOf(open)
  if (start === -1) return ''
  const end = text.indexOf(`</${tag}>`, start + open.length)
  return text.slice(start + open.length, end === -1 ? undefined : end).trim()
}

/** A slash-command echo as the user typed it: `/name args`. */
function commandPrompt(text: string): string {
  const name = tagBody(text, 'command-name')
  const args = tagBody(text, 'command-args')
  return `${name} ${args}`.trim() || text
}

/**
 * Drop failed-dispatch ghosts: when a response's tool calls got no result,
 * Claude Code re-sends the SAME calls (same ids, same arguments) in the next
 * response. Kept, the id would appear twice in the log. A step is a ghost
 * when it holds only tool calls, none answered, and the very next step
 * re-sends every one of them verbatim; its inputs move to the retry.
 * @returns How many steps were dropped.
 */
function dropGhostRetries(steps: ImportStep[]): number {
  let dropped = 0
  for (let i = 0; i < steps.length - 1;) {
    const ghost = steps[i]!
    const retry = steps[i + 1]!
    const isGhost = ghost.blocks.length > 0 && ghost.results.length === 0
      && ghost.blocks.every(block => block.type === 'tool-call'
        && retry.blocks.some(again => again.type === 'tool-call' && again.id === block.id
          && again.name === block.name && again.arguments === block.arguments))
    if (!isGhost) {
      i += 1
      continue
    }
    retry.inputs = [...ghost.inputs, ...retry.inputs]
    steps.splice(i, 1)
    dropped += 1
    // Stay at i: the retry may itself be a ghost of the step after it.
  }
  return dropped
}

/** Whether a user line is a tool-result carrier rather than a prompt. */
function isToolResultLine(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => isRecord(block) && block.type === 'tool_result')
}

/**
 * Parse one Claude Code transcript.
 * @returns The session, or undefined when it holds no human prompt or is an
 *   auxiliary transcript (its records name another session: only the main
 *   `<sessionId>.jsonl` is a conversation of its own).
 */
export function parseClaudeTranscript(input: ClaudeTranscriptInput): MigrationSession | undefined {
  const { records, badLines } = parseJsonl(input.raw)
  const owner = records.find(record => typeof record.sessionId === 'string' && record.sessionId !== '')?.sessionId
  if (owner !== undefined && owner !== input.fileStem) return undefined
  const stats = { ...emptyStats(), badLines }
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  /** message.id → its step, within the current turn. */
  let stepOfMessage = new Map<string, ImportStep>()
  let startedAt = 0
  let lineCwd: string | undefined
  const calls = new CallIndex()
  /** A compaction summary waiting for the turn that follows the boundary. */
  let pendingCompaction: ImportCompaction | undefined
  let lastModel: string | undefined
  let renamedTitle: string | undefined
  let legacyTitle: string | undefined
  let aiTitle: string | undefined
  /** isMeta texts waiting for the next step of the current turn. */
  let pendingInputs: string[] = []
  /** Turns opened by a slash-command echo rather than typed words. */
  const commandTurns = new Set<ImportTurn>()

  const openTurn = (prompt: string): void => {
    current = pendingCompaction === undefined ? { prompt, steps: [] } : { prompt, compaction: pendingCompaction, steps: [] }
    pendingCompaction = undefined
    turns.push(current)
    stepOfMessage = new Map()
  }

  const appendAssistant = (message: JsonRecord): void => {
    if (current === undefined) openTurn('')
    const turn = current!
    const messageId = typeof message.id === 'string' && message.id !== '' ? message.id : undefined
    let step = messageId === undefined ? undefined : stepOfMessage.get(messageId)
    if (typeof message.model === 'string' && message.model !== '') lastModel = message.model
    if (step === undefined) {
      step = newStep(typeof message.model === 'string' && message.model !== '' ? message.model : undefined)
      step.inputs = pendingInputs
      pendingInputs = []
      turn.steps.push(step)
      if (messageId !== undefined) stepOfMessage.set(messageId, step)
    }
    const content = message.content
    if (typeof content === 'string') {
      if (content !== '') step.blocks.push({ type: 'text', text: content })
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        step.blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        // The trace lives in `thinking` (not `text`); accept both.
        const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
        if (text !== '') step.blocks.push({ type: 'reasoning', text })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && block.id !== '') {
        const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown'
        step.blocks.push({ type: 'tool-call', id: block.id, name, arguments: JSON.stringify(block.input ?? {}) })
      }
    }
    calls.register(step)
  }

  const attachResults = (content: unknown[]): void => {
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      calls.attach(block.tool_use_id, toolResultText(block.content), block.is_error === true)
    }
  }

  const acceptUserText = (record: JsonRecord, content: unknown): void => {
    const raw = textOf(content)
    const text = stripSystemReminders(raw)
    if (record.isMeta === true) {
      // Machine context the model saw mid-turn (skill bodies, image notes,
      // "Continue from where you left off."): it enters the NEXT step as a
      // user input instead of opening a turn. Local-command caveats carry
      // no model reply and are dropped.
      if (text === '' || isInjectedText(raw)) {
        stats.filtered += 1
        return
      }
      pendingInputs.push(text)
      stats.meta += 1
      return
    }
    if (isCommandEcho(text)) {
      openTurn(commandPrompt(text))
      commandTurns.add(current!)
      return
    }
    if (text === '') return
    if (isInjectedText(text)) {
      stats.filtered += 1
      return
    }
    // Mid-turn context that no step consumed before the next prompt is
    // stale; the prompt starts over.
    stats.filtered += pendingInputs.length
    pendingInputs = []
    openTurn(text)
  }

  for (const record of records) {
    const type = record.type
    if (type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim() !== '') renamedTitle = record.customTitle
    else if (type === 'summary' && typeof record.summary === 'string' && record.summary.trim() !== '') legacyTitle = record.summary
    else if (type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') aiTitle ??= record.aiTitle
    if (type !== 'user' && type !== 'assistant') continue
    if (record.isSidechain === true) continue
    const message = record.message
    if (!isRecord(message)) continue
    // Claude Code writes the authoritative cwd on every message line; the
    // dash-munged directory name cannot preserve `_`/`.`/`-`.
    if (typeof record.cwd === 'string' && record.cwd !== '') lineCwd = record.cwd
    if (startedAt === 0) startedAt = toMillis(record.timestamp)
    if (type === 'user') {
      if (isToolResultLine(message.content)) {
        attachResults(message.content as unknown[])
      } else if (record.isCompactSummary === true) {
        // Compaction boundary: the summary becomes a native checkpoint in
        // front of the next turn; the turn in progress is over.
        const summary = stripSystemReminders(textOf(message.content))
        if (summary !== '') {
          pendingCompaction = lastModel === undefined ? { summary } : { summary, model: lastModel }
          current = undefined
        }
      } else {
        acceptUserText(record, message.content)
      }
      continue
    }
    appendAssistant(message)
  }
  stats.filtered += pendingInputs.length
  // The transcript stopped right at a boundary: keep the checkpoint.
  if (pendingCompaction !== undefined) turns.push({ prompt: '', compaction: pendingCompaction, steps: [] })

  // A response that produced nothing importable leaves no step behind, and
  // a slash command the model never answered (/model, /clear, …) is local
  // housekeeping, not conversation.
  for (const turn of turns) turn.steps = turn.steps.filter(step => step.blocks.length > 0 || step.inputs.length > 0)
  turns = turns.filter(turn => {
    if (commandTurns.has(turn) && turn.steps.length === 0 && turn.compaction === undefined) {
      stats.filtered += 1
      return false
    }
    return turn.prompt !== '' || turn.steps.length > 0 || turn.compaction !== undefined
  })
  for (const turn of turns) dropGhostRetries(turn.steps)
  stats.droppedToolResults = calls.orphans + closeToolPairs(turns)
  if (!turns.some(turn => turn.prompt !== '')) return undefined

  // cwd precedence: the per-line `cwd` field → the first prompt's
  // "Primary working directory:" note → the unmunged directory name.
  let cwd = lineCwd ?? input.fallbackCwd
  if (lineCwd === undefined) {
    const noted = turns.find(turn => turn.prompt.includes('Primary working directory:'))
    const match = noted === undefined ? null : /Primary working directory: (\S+)/u.exec(noted.prompt)
    if (match !== null) cwd = match[1]!
  }
  const explicit = normalizeTitle(renamedTitle ?? legacyTitle ?? aiTitle)
  const firstPrompt = turns.find(turn => turn.prompt !== '' && !commandTurns.has(turn))?.prompt
  const title = explicit !== '' ? explicit : normalizeTitle(firstPrompt === undefined ? undefined : unwrapUserText(firstPrompt))
  return {
    sourceId: input.fileStem,
    cwd,
    ...(title === '' ? {} : { title }),
    titleExplicit: explicit !== '',
    startedAt,
    turns,
    stats,
  }
}
