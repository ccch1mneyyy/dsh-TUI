/**
 * MCP elicitation ↔ questionnaire, backend-neutral and pure: the shapes in
 * are the MCP specification's (`mode`, `requestedSchema`, `url`, the server
 * name), the shapes out are the Agent Domain's (`QuestionItemView[]` for a
 * `question.request`, an `accept` / `decline` result with its `content`).
 * A backend keeps only the wiring (park the ask, answer its own protocol,
 * withdraw on abort); every rule of how a form is asked lives here, so two
 * backends never disagree on it.
 *
 *  - form mode: one question per field of the requested JSON schema, in
 *    declaration order — an enum is a choice list (`enumNames` / `oneOf`
 *    titles as labels), a boolean yes / no, a multi-select array
 *    checkboxes, a string / number / anything else the free-text row with a
 *    constraint hint; optional fields can be skipped; a last question sends
 *    or declines. Answers are validated against each field's constraints:
 *    an invalid answer asks that field again (and only the invalid ones),
 *    saying why; valid ones become typed content;
 *  - URL mode: one accept / decline question carrying the link (rendered
 *    as an OSC 8 hyperlink where the terminal supports one), plus the
 *    notice texts a backend shows around it.
 *
 * The option labels of a flow are fixed when it is first asked: answers
 * are matched against the very strings the panel showed, so a language
 * switch meanwhile cannot turn a valid answer into a mismatch.
 *
 * Backend-neutral (`verify:boundary`): no vendor types, no I/O.
 */
import type { QuestionAnswers } from '../agent/capabilities.js'
import type { QuestionItemView } from '../agent/events.js'
import { t } from '../i18n.js'

/** A JSON object as read from an untyped schema. */
type Rec = Readonly<Record<string, unknown>>

const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** A form value the MCP result carries. */
export type ElicitationValue = string | number | boolean | string[]

/** One field of a form elicitation, as the panel asks it. */
export interface FormField {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly required: boolean
  readonly kind: 'choice' | 'boolean' | 'multi' | 'text' | 'number' | 'integer' | 'json'
  /** Choice / multi options: the label shown and the value sent. */
  readonly choices?: readonly { readonly label: string; readonly value: string }[]
  readonly schema: Rec
}

/** The choice list of an enum schema (`enum` + `enumNames`, or `oneOf` /
 *  `anyOf` const + title). Labels are made unique. */
function choicesOf(schema: Rec | undefined): { label: string; value: string }[] | undefined {
  if (schema === undefined) return undefined
  const raw: { label: string; value: string }[] = []
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    schema.enum.forEach((value, index) => {
      if (typeof value !== 'string') return
      raw.push({ label: str(names[index]) ?? value, value })
    })
  } else {
    const list = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
    if (list === undefined) return undefined
    for (const item of list) {
      const value = str(rec(item)?.const)
      if (value === undefined) continue
      raw.push({ label: str(rec(item)?.title) ?? value, value })
    }
  }
  if (raw.length === 0) return undefined
  const seen = new Set<string>()
  return raw.map(choice => {
    let label = choice.label === '' ? choice.value : choice.label
    while (seen.has(label)) label = `${label} (${choice.value})`
    seen.add(label)
    return { label, value: choice.value }
  })
}

/** The fields of a requested schema, in declaration order. */
export function formFields(schema: unknown): FormField[] {
  const root = rec(schema)
  const properties = rec(root?.properties)
  if (properties === undefined) return []
  const required = new Set(Array.isArray(root?.required) ? root.required.filter((key): key is string => typeof key === 'string') : [])
  return Object.entries(properties).map(([key, raw]): FormField => {
    const field = rec(raw) ?? {}
    const type = str(field.type)
    const base = {
      key,
      title: str(field.title)?.trim() || key,
      ...(str(field.description)?.trim() ? { description: str(field.description)!.trim() } : {}),
      required: required.has(key),
      schema: field,
    }
    if (type === 'boolean') return { ...base, kind: 'boolean' }
    if (type === 'array') {
      const choices = choicesOf(rec(field.items))
      return choices === undefined ? { ...base, kind: 'json' } : { ...base, kind: 'multi', choices }
    }
    if (type === 'number' || type === 'integer') return { ...base, kind: type }
    const choices = choicesOf(field)
    if (choices !== undefined) return { ...base, kind: 'choice', choices }
    return { ...base, kind: type === 'string' || type === undefined ? 'text' : 'json' }
  })
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u

/**
 * A real calendar day (leap years counted). `Date.parse` cannot judge an
 * RFC3339 date: it rolls impossible days such as 2024-02-31 over into March
 * instead of refusing them (and rejects legal leap seconds), so the fields
 * of the captured groups are checked for real.
 */
function calendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day <= length
}

/** Validate one typed value against its field; the value or the reason. */
export function parseFieldText(field: FormField, text: string): { readonly value: ElicitationValue } | { readonly error: string } {
  const schema = field.schema
  if (field.kind === 'number' || field.kind === 'integer') {
    const value = Number(text)
    if (text.trim() === '' || !Number.isFinite(value)) return { error: t('elicit-invalid-number') }
    if (field.kind === 'integer' && !Number.isInteger(value)) return { error: t('elicit-invalid-integer') }
    const min = num(schema.minimum)
    const max = num(schema.maximum)
    if (min !== undefined && value < min) return { error: t('elicit-invalid-min', { min }) }
    if (max !== undefined && value > max) return { error: t('elicit-invalid-max', { max }) }
    return { value }
  }
  if (field.kind === 'json') {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { error: t('elicit-invalid-json') }
    }
    const type = str(schema.type)
    const fits = type === 'array'
      ? Array.isArray(value) && value.every(item => typeof item === 'string')
      : type === 'object' ? false : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    // An MCP form value is a string, number, boolean or string array.
    if (!fits) return { error: t('elicit-invalid-json') }
    return { value: value as ElicitationValue }
  }
  const length = [...text].length
  const minLength = num(schema.minLength)
  const maxLength = num(schema.maxLength)
  if (minLength !== undefined && length < minLength) return { error: t('elicit-invalid-min-length', { n: minLength }) }
  if (maxLength !== undefined && length > maxLength) return { error: t('elicit-invalid-max-length', { n: maxLength }) }
  switch (str(schema.format)) {
    case 'email':
      if (!EMAIL.test(text)) return { error: t('elicit-invalid-email') }
      break
    case 'uri':
      try {
        new URL(text)
      } catch {
        return { error: t('elicit-invalid-uri') }
      }
      break
    case 'date': {
      const match = DATE.exec(text)
      if (match === null || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) return { error: t('elicit-invalid-date') }
      break
    }
    case 'date-time': {
      // Full RFC3339: a real day, a clock within range (second 60 = a leap
      // second, accepted on syntax — whether the day really had one stays
      // the server's to check), and an explicit timezone (Z, z or ±HH:MM —
      // required, never the local-time fallback `Date.parse` implies).
      const match = DATE_TIME.exec(text)
      if (match === null
        || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
        || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 60
        || Number(match[7]) > 23 || Number(match[8]) > 59) return { error: t('elicit-invalid-date-time') }
      break
    }
    default:
      break
  }
  const pattern = str(schema.pattern)
  if (pattern !== undefined) {
    let matches = true
    try {
      matches = new RegExp(pattern, 'u').test(text)
    } catch {
      // A pattern this runtime cannot compile is the server's to check.
    }
    if (!matches) return { error: t('elicit-invalid-pattern') }
  }
  return { value: text }
}

/** A short constraint hint for a free-text field (shown under the question). */
function constraintHint(field: FormField): string | undefined {
  const schema = field.schema
  switch (field.kind) {
    case 'number':
    case 'integer': {
      const min = num(schema.minimum)
      const max = num(schema.maximum)
      const kind = t(field.kind === 'integer' ? 'elicit-kind-integer' : 'elicit-kind-number')
      if (min !== undefined && max !== undefined) return t('elicit-hint-range', { kind, min, max })
      if (min !== undefined) return t('elicit-hint-min', { kind, min })
      if (max !== undefined) return t('elicit-hint-max', { kind, max })
      return kind
    }
    case 'json':
      return t('elicit-hint-json')
    case 'text': {
      const format = str(schema.format)
      return format === undefined ? undefined : t('elicit-hint-format', { format })
    }
    default:
      return undefined
  }
}

/** The option labels of one form flow, fixed when it is first asked. */
export interface FormLabels {
  readonly skip: string
  readonly yes: string
  readonly no: string
}

/** The current language's form labels. */
export const formLabels = (): FormLabels => ({ skip: t('elicit-skip'), yes: t('elicit-yes'), no: t('elicit-no') })

/** A field's question (with the reason it is asked again, if any). */
export function fieldQuestion(field: FormField, header: string, lead: string | undefined, error: string | undefined, labels: FormLabels = formLabels()): QuestionItemView {
  const skip = labels.skip
  const detail = [
    error === undefined ? undefined : t('elicit-invalid', { reason: error }),
    lead,
    field.description,
    constraintHint(field),
  ].filter((line): line is string => line !== undefined && line !== '').join('\n')
  const question = field.required ? field.title : t('elicit-optional', { title: field.title })
  const optional = field.required ? [] : [{ label: skip, description: t('elicit-skip-desc') }]
  const defaults = (labels: readonly string[]): { defaultSelected?: readonly string[] } => labels.length === 0 ? {} : { defaultSelected: labels }
  const base = { question, header, ...(detail === '' ? {} : { detail }) }
  switch (field.kind) {
    case 'choice': {
      const fallback = str(field.schema.default)
      return { ...base, options: [...field.choices!.map(choice => ({ label: choice.label })), ...optional], hideCustomInput: true, ...defaults(field.choices!.filter(choice => choice.value === fallback).map(choice => choice.label)) }
    }
    case 'boolean': {
      const { yes, no } = labels
      const fallback = field.schema.default
      return { ...base, options: [{ label: yes }, { label: no }, ...optional], hideCustomInput: true, ...defaults(fallback === true ? [yes] : fallback === false ? [no] : []) }
    }
    case 'multi': {
      const fallback = Array.isArray(field.schema.default) ? field.schema.default : []
      return { ...base, options: [...field.choices!.map(choice => ({ label: choice.label })), ...optional], multiSelect: true, hideCustomInput: true, ...defaults(field.choices!.filter(choice => fallback.includes(choice.value)).map(choice => choice.label)) }
    }
    default:
      return { ...base, options: optional }
  }
}

/** One answered field: its value, `skip`, or why it is invalid. */
export function fieldValue(field: FormField, answer: QuestionAnswers['answers'][number] | undefined, labels: FormLabels = formLabels()): { readonly value: ElicitationValue } | { readonly skip: true } | { readonly error: string } {
  const selected = answer?.selected ?? []
  const custom = answer?.custom?.trim() ?? ''
  const skip = labels.skip
  const skipped = selected.includes(skip)
  switch (field.kind) {
    case 'choice': {
      const choice = field.choices!.find(item => item.label === selected[0])
      if (choice !== undefined) return { value: choice.value }
      return skipped && !field.required ? { skip: true } : { error: t('elicit-invalid-choice') }
    }
    case 'boolean':
      if (selected[0] === labels.yes) return { value: true }
      if (selected[0] === labels.no) return { value: false }
      return skipped && !field.required ? { skip: true } : { error: t('elicit-invalid-choice') }
    case 'multi': {
      const values = field.choices!.filter(choice => selected.includes(choice.label)).map(choice => choice.value)
      if (values.length === 0) return skipped && !field.required ? { skip: true } : { error: t('elicit-invalid-choice') }
      const min = num(field.schema.minItems)
      const max = num(field.schema.maxItems)
      if (min !== undefined && values.length < min) return { error: t('elicit-invalid-min-items', { n: min }) }
      if (max !== undefined && values.length > max) return { error: t('elicit-invalid-max-items', { n: max }) }
      return { value: values }
    }
    default:
      if (custom === '') return skipped && !field.required ? { skip: true } : { error: t('elicit-invalid-required') }
      return parseFieldText(field, custom)
  }
}

/** A short server label for the panel header chip. */
export function serverHeader(name: string): string {
  const flat = name.replace(/\s+/gu, ' ').trim()
  return flat.length <= 24 ? flat : `${flat.slice(0, 23)}…`
}

/** The parts of an MCP elicitation request this module reads. */
export interface ElicitationRequestView {
  /** The MCP server's name (named in the confirmation and the notices). */
  readonly serverName: string
  /** A friendlier name for the header chip, when the backend has one. */
  readonly displayName?: string
  readonly title?: string
  readonly message?: string
  /** Form mode: the JSON schema of the requested content. */
  readonly requestedSchema?: unknown
  /** URL mode: the page to open. */
  readonly url?: string
}

/** What one answered round of a form decides. */
export type ElicitationFormStep =
  | { readonly kind: 'accept'; readonly content: Readonly<Record<string, ElicitationValue>> }
  | { readonly kind: 'decline' }
  /** Some answers were invalid: ask these questions next (only those fields). */
  | { readonly kind: 'reask'; readonly questions: readonly QuestionItemView[] }

/** One form elicitation as a questionnaire flow (state: the round so far). */
export interface ElicitationForm {
  /** The first ask: every field, then send / decline. */
  readonly questions: readonly QuestionItemView[]
  /** Fold the answers to the ask currently shown. */
  answer(answers: QuestionAnswers): ElicitationFormStep
}

/**
 * A form elicitation flow: its first ask, then each answered round decides
 * accept (typed content), decline, or a re-ask of the invalid fields. The
 * send / decline choice is asked once, after the first round; a re-ask
 * keeps the values already accepted and replaces the re-asked ones.
 */
export function createElicitationForm(request: ElicitationRequestView): ElicitationForm {
  const fields = formFields(request.requestedSchema)
  const header = serverHeader(request.displayName ?? request.serverName)
  const lead = [request.title, request.message].filter((line): line is string => line !== undefined && line.trim() !== '').join('\n')
  const send = t('elicit-send')
  const decline = t('elicit-decline')
  const labels = formLabels()
  const confirm: QuestionItemView = {
    question: t('elicit-confirm', { server: request.serverName }),
    header,
    ...(fields.length === 0 && lead !== '' ? { detail: lead } : {}),
    options: [{ label: send, description: t('elicit-send-desc') }, { label: decline, description: t('elicit-decline-desc') }],
    hideCustomInput: true,
  }
  const values = new Map<string, ElicitationValue>()
  /** The fields the shown ask covers (all of them, then the invalid ones). */
  let asked: readonly FormField[] = fields
  let sending = false
  return {
    questions: [...fields.map((field, index) => fieldQuestion(field, header, index === 0 ? lead : undefined, undefined, labels)), confirm],
    answer: answers => {
      if (!sending) {
        const choice = answers.answers[asked.length]?.selected[0]
        if (choice !== send) return { kind: 'decline' }
        sending = true
      }
      const invalid: { field: FormField; error: string }[] = []
      asked.forEach((field, index) => {
        const outcome = fieldValue(field, answers.answers[index], labels)
        if ('error' in outcome) invalid.push({ field, error: outcome.error })
        else if ('skip' in outcome) values.delete(field.key)
        else values.set(field.key, outcome.value)
      })
      if (invalid.length > 0) {
        asked = invalid.map(item => item.field)
        return { kind: 'reask', questions: invalid.map(item => fieldQuestion(item.field, header, undefined, item.error, labels)) }
      }
      return { kind: 'accept', content: Object.fromEntries(values) }
    },
  }
}

/** A URL elicitation as one accept / decline question carrying the link. */
export interface ElicitationUrlAsk {
  readonly questions: readonly QuestionItemView[]
  /** Whether the answers accept (the user opened the link); else decline. */
  accepted(answers: QuestionAnswers): boolean
}

/** The URL-mode question; undefined when the request names no URL. */
export function createElicitationUrlAsk(request: ElicitationRequestView): ElicitationUrlAsk | undefined {
  const target = request.url
  if (target === undefined || target.trim() === '') return undefined
  const accept = t('elicit-url-accept')
  const message = request.message ?? ''
  return {
    questions: [{
      question: message.trim() === '' ? t('elicit-url-question', { server: request.serverName }) : message,
      header: serverHeader(request.displayName ?? request.serverName),
      detail: t('elicit-url-detail'),
      link: target,
      options: [{ label: accept, description: t('elicit-url-accept-desc') }, { label: t('elicit-decline'), description: t('elicit-decline-desc') }],
      hideCustomInput: true,
    }],
    accepted: answers => answers.answers[0]?.selected[0] === accept,
  }
}

/** The notice texts a backend shows around an elicitation. */
export const elicitationNotices = {
  /** URL mode: the server asks the user to open a page. */
  urlOpen: (server: string, url: string): string => t('elicit-url-notice', { server, url }),
  /** URL mode: the server reported the flow done. */
  urlComplete: (server: string): string => t('elicit-url-complete', { server }),
  /** URL mode without a URL: declined. */
  urlMissing: (server: string): string => t('elicit-url-missing', { server }),
  /** A mode this client cannot render: declined. */
  unsupported: (server: string, mode: string): string => t('elicit-unsupported', { server, mode }),
}
