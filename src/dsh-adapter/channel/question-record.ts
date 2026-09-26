/**
 * Answered-questionnaire transcript record — a PURE fold of the durable
 * session log (issue #1009).
 *
 * `ask_user_question` renders as the interactive panel, not as a tool card,
 * so its `tool/result` had no renderer at all: the answers lived only in the
 * current process's view rows (the TUI used to push a summary when the panel
 * closed). That violated the transcript's source-of-truth rule — `/resume`,
 * rewind, `loadOlder` and any replay lost the record, and an ask that was
 * never observed closing produced none at all.
 *
 * The record now derives from the same log every other transcript row comes
 * from: the `tool/call` arguments carry the questions, the `tool/result`
 * payload carries the answers. Both are parsed at the caller's edge here, so
 * this module stays pure (no store, no i18n state, no projection imports) and
 * is directly testable.
 */

import { t } from '../../i18n.js'

/**
 * The parts of a question this fold needs. Structurally compatible with the
 * harness's `AskUserQuestionItem`, so `src/dsh-adapter/` callers pass the
 * official type straight through while this module keeps its own shape.
 */
export interface QuestionRecordQuestion {
  readonly question: string
}

/**
 * One answer as the harness persists it (a subset of
 * `AskUserQuestionAnswerItem`: the fold matches answers to questions BY ORDER,
 * mirroring how the panel collects one answer per question).
 */
export interface QuestionRecordAnswer {
  readonly selected: readonly string[]
  readonly custom?: string
}

/** One answered questionnaire as the transcript renders it. */
export interface QuestionRecord {
  /** Local-row title (dictionary text, never hand-written here). */
  readonly title: string
  /** One `· question → answer` line per answered question. */
  readonly lines: readonly string[]
}

/** Truncate a long answer line for the transcript summary. */
function clip(text: string, max = 140): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * Fold one answered questionnaire into its transcript record.
 *
 * Tolerant by contract: the projection calls this on durable replay data it
 * does not control (truncated logs, older hosts, a wizard-shaped caller), and
 * a throw inside `renderEvent` would abort the whole transcript fold. So a
 * missing/garbled question list or answer item degrades to a shorter line
 * instead of raising.
 *
 * @param questions - The ask's questions, in the order they were answered.
 * @param answers - The answers the log recorded for that same ask.
 * @param options - `redact` masks answer text (local wizards collecting
 *   secrets such as API keys must never leak into the transcript or an
 *   `/export` dump); the model-side ask never sets it.
 * @returns The title line plus its `· question → choice` body lines.
 */
export function buildQuestionRecord(
  questions: readonly (QuestionRecordQuestion | undefined)[] | undefined,
  answers: readonly (QuestionRecordAnswer | undefined)[] | undefined,
  options?: { redact?: boolean },
): QuestionRecord {
  const list = questions ?? []
  const lines = list.flatMap((question, index) => {
    const answer = answers?.[index]
    if (question === undefined || answer === undefined) return []
    // The question text comes from durable args too — a garbled entry must
    // not turn into the string "undefined" in the transcript.
    const prompt = typeof question.question === 'string' ? question.question : ''
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    if (prompt === '' && selected.length === 0 && (answer.custom ?? '') === '') return []
    const text = options?.redact === true
      ? '••••••'
      : (() => {
          const labels = selected.join('、')
          const custom = answer.custom ?? ''
          return custom !== ''
            ? labels === '' ? custom : `${labels}：${custom}`
            : labels
        })()
    return `· ${prompt} → ${clip(text)}`
  })
  return {
    title: t('questionnaire-answered', { total: list.length }),
    lines,
  }
}

/**
 * Parse the questions out of a persisted `ask_user_question` `tool/call`
 * arguments string. Returns `undefined` when the payload is not the
 * `{ questions: [...] }` object the tool declares, so the caller can fall
 * back to a title-only record.
 */
export function parseQuestionRecordQuestions(rawArguments: string | undefined): QuestionRecordQuestion[] | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments ?? '')
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const questions = (parsed as { questions?: unknown }).questions
    return Array.isArray(questions) ? questions as QuestionRecordQuestion[] : undefined
  } catch {
    // Unparseable arguments are historical/foreign data, not a program bug:
    // degrade to a title-only record rather than aborting the transcript fold.
    return undefined
  }
}

/**
 * Parse the answers out of a `tool/result` text payload. `dsh-tool-ask-user`
 * renders its output as one JSON text block — the same bytes the model reads
 * back — so the durable log is a sufficient source. A failed ask (or any
 * non-JSON body) yields `undefined`: the caller then renders the log's own
 * error text instead of fabricating an answer.
 */
export function parseQuestionRecordAnswers(rawResult: string): QuestionRecordAnswer[] | undefined {
  try {
    const parsed: unknown = JSON.parse(rawResult)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const answers = (parsed as { answers?: unknown }).answers
    return Array.isArray(answers) ? answers as QuestionRecordAnswer[] : undefined
  } catch {
    return undefined
  }
}
