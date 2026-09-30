/**
 * Grok Build session parsing (pure): one session directory's `summary.json`
 * + `chat_history.jsonl` → one {@link MigrationSession}.
 *
 * `summary.json` carries the metadata (`info.id`, `info.cwd`, titles, clock).
 * `chat_history.jsonl` rows are tagged conversation items: `user` rows carry
 * block-array content, `assistant` rows a plain string, and a `reasoning`
 * row precedes the assistant row it explains. Rows carry no per-row
 * timestamp. The legacy v0 shape (`{role, content}`) is accepted alongside.
 *
 * Tool traffic: an assistant row lists its calls in a top-level `tool_calls`
 * array (`{ id, name, arguments }`); each result is a `tool_result` row
 * naming `tool_call_id`, with optional `images` (replaced by placeholders).
 * `backend_tool_call` rows are provider-side tools (web search) the model
 * never called through the harness; they are counted, not imported.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/grok-build.parse
 */
import { isInjectedText, unwrapUserText } from '../parse/injection.js'
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { emptyStats } from '../parse/role-turns.js'
import { normalizeTitle } from '../parse/title.js'
import { CallIndex, IMAGE_PLACEHOLDER, closeToolPairs, newStep } from '../parse/tools.js'
import type { ImportCompaction, ImportTurn, MigrationSession } from '../types.js'

/** How a compaction summary row opens (the other compaction_meta rows are
 *  the re-injected environment block). */
const COMPACTION_SUMMARY_LEAD = 'This session is being continued'

/** One session directory's two files, as text. */
export interface GrokSessionInput {
  readonly summaryJson: string
  readonly chatHistory: string
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Text of string content, or of the text blocks of block-array content. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== '') parts.push(part.text)
  }
  return parts.join('\n\n')
}

/** The readable summary of a reasoning row (its encrypted state is never copied). */
function reasoningText(row: JsonRecord): string {
  if (!Array.isArray(row.summary)) return ''
  const parts: string[] = []
  for (const part of row.summary) {
    if (isRecord(part) && typeof part.text === 'string' && part.text !== '') parts.push(part.text)
  }
  return parts.join('\n\n')
}

/**
 * Parse one Grok Build session.
 * @returns The session, or undefined when the summary lacks an id or cwd,
 *   or the history holds no prompt.
 */
export function parseGrokSession(input: GrokSessionInput): MigrationSession | undefined {
  let summaryDoc: unknown
  try {
    summaryDoc = JSON.parse(input.summaryJson)
  } catch {
    return undefined
  }
  if (!isRecord(summaryDoc) || !isRecord(summaryDoc.info)) return undefined
  const { id, cwd } = summaryDoc.info
  if (typeof id !== 'string' || id === '' || typeof cwd !== 'string' || cwd === '') return undefined
  const startedAt = toMillis(summaryDoc.created_at) || toMillis(summaryDoc.updated_at)
  // Title authority: generated_title > session_summary (both the source's
  // own, written to the log) > the first real prompt (fallback, not written).
  const ownTitle = normalizeTitle([summaryDoc.generated_title, summaryDoc.session_summary]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== ''))

  const { records, badLines } = parseJsonl(input.chatHistory)
  const stats = { ...emptyStats(), badLines }
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  let pendingReasoning: string[] = []
  /** A compaction summary waiting for the turn that follows the boundary. */
  let pendingCompaction: ImportCompaction | undefined
  let lastModel: string | undefined
  const openTurn = (prompt: string): ImportTurn => {
    const turn: ImportTurn = pendingCompaction === undefined ? { prompt, steps: [] } : { prompt, compaction: pendingCompaction, steps: [] }
    pendingCompaction = undefined
    turns.push(turn)
    return turn
  }
  const calls = new CallIndex()

  for (const row of records) {
    const kind = row.type === undefined ? row.role : row.type
    if (kind === 'user') {
      // Tagged synthetic injections (system reminders, compaction meta, …)
      // are not the human's words; the default `human` tag is omitted.
      if (row.synthetic_reason !== undefined && row.synthetic_reason !== 'human') {
        // A compaction leaves its summary as a synthetic row: the boundary
        // becomes a native checkpoint in front of the next turn.
        const text = blocksText(row.content).trim()
        if (row.synthetic_reason === 'compaction_meta' && text.startsWith(COMPACTION_SUMMARY_LEAD)) {
          pendingCompaction = lastModel === undefined ? { summary: text } : { summary: text, model: lastModel }
          current = undefined
        } else {
          stats.filtered += 1
        }
        continue
      }
      const raw = blocksText(row.content)
      // Untagged injection: the environment block (`<user_info>`) that opens
      // every session and follows every compaction.
      if (isInjectedText(raw)) {
        stats.filtered += 1
        continue
      }
      // The human words sit inside `<user_query>`, possibly behind an
      // interrupt or "sent while you were working" notice.
      const prompt = unwrapUserText(raw)
      if (prompt === '') continue
      // Speaking over a running turn cut that turn short.
      if (row.prior_turn_interrupt !== undefined && current !== undefined) current.aborted = true
      current = openTurn(prompt)
    } else if (kind === 'assistant') {
      const text = blocksText(row.content)
      const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls.filter(isRecord) : []
      if (text === '' && pendingReasoning.length === 0 && toolCalls.length === 0) continue
      current ??= openTurn('')
      if (typeof row.model_id === 'string' && row.model_id !== '') lastModel = row.model_id
      const step = newStep(typeof row.model_id === 'string' && row.model_id !== '' ? row.model_id : undefined)
      // A reasoning row is the pre-sibling of the assistant row it explains.
      for (const reasoning of pendingReasoning) step.blocks.push({ type: 'reasoning', text: reasoning })
      pendingReasoning = []
      if (text !== '') step.blocks.push({ type: 'text', text })
      for (const call of toolCalls) {
        if (typeof call.id !== 'string' || call.id === '') continue
        const name = typeof call.name === 'string' && call.name !== '' ? call.name : 'unknown'
        const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
        step.blocks.push({ type: 'tool-call', id: call.id, name, arguments: args })
      }
      calls.register(step)
      current.steps.push(step)
    } else if (kind === 'tool_result') {
      if (typeof row.tool_call_id !== 'string') {
        calls.orphans += 1
        continue
      }
      const images = Array.isArray(row.images) ? row.images.length : 0
      const text = [blocksText(row.content), ...Array.from({ length: images }, () => IMAGE_PLACEHOLDER)].filter(part => part !== '').join('\n')
      calls.attach(row.tool_call_id, text, row.is_error === true)
    } else if (kind === 'backend_tool_call') {
      stats.filtered += 1
    } else if (kind === 'reasoning') {
      const text = reasoningText(row)
      if (text !== '') pendingReasoning.push(text)
    }
  }

  if (pendingCompaction !== undefined) turns.push({ prompt: '', compaction: pendingCompaction, steps: [] })
  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0 || turn.compaction !== undefined)
  stats.droppedToolResults = calls.orphans + closeToolPairs(turns)
  if (!turns.some(turn => turn.prompt !== '')) return undefined
  const title = ownTitle !== '' ? ownTitle : normalizeTitle(turns.find(turn => turn.prompt !== '')?.prompt)
  return { sourceId: id, cwd, ...(title === '' ? {} : { title }), titleExplicit: ownTitle !== '', startedAt, turns, stats }
}
