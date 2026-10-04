/** Decode SDK content, usage and user-text sentinels. */
import type { UsageDelta } from '../../../agent/events.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'

/** User texts the CLI injects that are not human bubbles. */
export const INTERRUPT_ECHO = '[Request interrupted by user'
export const LOCAL_COMMAND_TAG = /^<local-command-(stdout|stderr|caveat)>/u
export const COMMAND_TAG = /^<command-(name|message|args)>/u
/** Command output sent as a prompt (`!!` / the CLI's bash mode). */
export const BASH_OUTPUT = /^<bash-stdout>\n?([\s\S]*?)\n?<\/bash-stdout>/u

/** Usage of one API response, in the domain's shape. */
export function usageOf(value: unknown): UsageDelta | undefined {
  const usage = rec(value)
  if (usage === undefined) return undefined
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheWrite = num(usage.cache_creation_input_tokens)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return { input, output, cacheRead, cacheWrite }
}

/** Joined text of a tool_result `content` (string or block array). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content).map(block => {
    const value = rec(block)
    return value?.type === 'text' ? str(value.text) ?? '' : ''
  }).join('')
}

/** The longest working-line narration kept (the ⏵ self-narration line). */
const NARRATION_CHARS = 120

/**
 * The leading ⏵ self-narration line of a streaming reply, when there is
 * one (the narrate contract puts exactly one at the very top; only a complete
 * first line counts, so a narration still streaming shows nothing yet). The
 * line is flattened and capped — it is model output destined for a status
 * line, never for re-parsing.
 */
export function narrationOf(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined
  const newline = text.indexOf('\n')
  if (newline === -1) return undefined
  const first = text.slice(0, newline).trimStart()
  if (!first.startsWith('⏵')) return undefined
  const flat = first.replace(/[\u0000-\u001f\u007f]/gu, '')
  return flat.length <= NARRATION_CHARS ? flat : flat.slice(0, NARRATION_CHARS) + '…'
}

/** First text of a user `message.content` (string or block array). */
export function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  for (const block of arr(content)) {
    const value = rec(block)
    if (value?.type === 'text') return str(value.text)
  }
  return undefined
}

/**
 * The result text of an answered `AskUserQuestion`, in the shape the shared
 * projector folds into the answered-questionnaire record (the `{answers:
 * [{selected}]}` JSON the DSH `ask_user_question` tool persists, matched to
 * the questions by order). The answers come from the structured result
 * (`answers: {question: text}`) or, failing that, the CLI's
 * `"question"="answer"` sentence; anything unreadable keeps the raw text (a
 * title-only record).
 */
export function questionRecordText(input: unknown, structured: unknown, raw: string): string {
  const questions = arr(rec(input)?.questions).map(item => str(rec(item)?.question) ?? '')
  if (questions.length === 0) return raw
  let answers: Rec | undefined = rec(rec(structured)?.answers)
  if (answers === undefined) {
    const parsed: Record<string, string> = {}
    for (const match of raw.matchAll(/"([^"]*)"="([^"]*)"/gu)) parsed[match[1]!] = match[2]!
    answers = parsed
  }
  const found = answers
  if (Object.keys(found).length === 0) return raw
  return JSON.stringify({
    answers: questions.map(question => {
      const value = str(found[question])
      return { selected: value === undefined ? [] : [value] }
    }),
  })
}
