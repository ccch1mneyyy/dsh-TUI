/**
 * MCP elicitation and the CLI's user dialogs (docs/agent-backend-design.md
 * §4.3 `onElicitation` / `onUserDialog`, §4.7): the session's two other
 * human-in-the-loop callbacks. Every request becomes a structured ask the
 * shared QuestionStore renders (`question.request`), answered through the
 * session's `questions` capability, and settles into the shape the SDK
 * expects:
 *
 *  - form elicitation: one question per field of the requested JSON schema
 *    — an enum is a choice list, a boolean yes / no, a multi-select array
 *    checkboxes, a string or number (or any other field) the free-text row,
 *    validated against the field's constraints (an invalid answer asks that
 *    field again, saying why); optional fields can be skipped. A last
 *    question sends or declines: `{action:'accept', content}` /
 *    `{action:'decline'}`; a dismissed panel is `{action:'cancel'}`;
 *  - URL elicitation: a notice row naming the server and the URL, and an
 *    accept / decline question carrying the link (an OSC 8 hyperlink where
 *    the terminal supports one); `system/elicitation_complete` for it closes
 *    the panel as accepted;
 *  - an elicitation mode this client cannot render is declined (with a
 *    notice);
 *  - the `refusal_fallback_prompt` dialog (the only kind declared in
 *    `supportedDialogKinds`): retry on the fallback model / cancel →
 *    `{behavior:'completed', result:'retry_fallback' | 'cancelled'}`; a
 *    dismissed panel is `{behavior:'cancelled'}` (the dialog's default); any
 *    other kind is answered `{behavior:'cancelled'}` at once.
 *
 * Signal-aware like the permission bridge: the SDK's abort (an interrupt,
 * the turn ending, `close()`) withdraws the panel (`question.settled`) and
 * answers cancel; dispose and reconnects settle everything as cancelled.
 * The callbacks never throw: a request this bridge cannot present is
 * declined (elicitation) or cancelled (dialog).
 */
import type { ElicitationRequest, ElicitationResult, OnElicitation, OnUserDialog, UserDialogRequest, UserDialogResult } from '@anthropic-ai/claude-agent-sdk'
import type { QuestionAnswers } from '../../agent/capabilities.js'
import type { AgentEvent, QuestionItemView } from '../../agent/events.js'
import { t } from '../../i18n.js'

/** The dialog kinds this client renders (`supportedDialogKinds`). */
export const SUPPORTED_DIALOG_KINDS: readonly string[] = ['refusal_fallback_prompt']

type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** A form value the MCP result carries. */
type FormValue = string | number | boolean | string[]

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
export function formFields(schema: Rec | undefined): FormField[] {
  const properties = rec(schema?.properties)
  if (properties === undefined) return []
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [])
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
const DATE = /^\d{4}-\d{2}-\d{2}$/u

/** Validate one typed value against its field; the value or the reason. */
export function parseFieldText(field: FormField, text: string): { readonly value: FormValue } | { readonly error: string } {
  const schema = field.schema
  if (field.kind === 'number' || field.kind === 'integer') {
    const value = Number(text)
    if (text.trim() === '' || !Number.isFinite(value)) return { error: t('claude-elicit-invalid-number') }
    if (field.kind === 'integer' && !Number.isInteger(value)) return { error: t('claude-elicit-invalid-integer') }
    const min = num(schema.minimum)
    const max = num(schema.maximum)
    if (min !== undefined && value < min) return { error: t('claude-elicit-invalid-min', { min }) }
    if (max !== undefined && value > max) return { error: t('claude-elicit-invalid-max', { max }) }
    return { value }
  }
  if (field.kind === 'json') {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { error: t('claude-elicit-invalid-json') }
    }
    const type = str(schema.type)
    const fits = type === 'array'
      ? Array.isArray(value) && value.every(item => typeof item === 'string')
      : type === 'object' ? false : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    // An MCP form value is a string, number, boolean or string array.
    if (!fits) return { error: t('claude-elicit-invalid-json') }
    return { value: value as FormValue }
  }
  const length = [...text].length
  const minLength = num(schema.minLength)
  const maxLength = num(schema.maxLength)
  if (minLength !== undefined && length < minLength) return { error: t('claude-elicit-invalid-min-length', { n: minLength }) }
  if (maxLength !== undefined && length > maxLength) return { error: t('claude-elicit-invalid-max-length', { n: maxLength }) }
  switch (str(schema.format)) {
    case 'email':
      if (!EMAIL.test(text)) return { error: t('claude-elicit-invalid-email') }
      break
    case 'uri':
      try {
        new URL(text)
      } catch {
        return { error: t('claude-elicit-invalid-uri') }
      }
      break
    case 'date':
      if (!DATE.test(text) || Number.isNaN(Date.parse(text))) return { error: t('claude-elicit-invalid-date') }
      break
    case 'date-time':
      if (!text.includes('T') || Number.isNaN(Date.parse(text))) return { error: t('claude-elicit-invalid-date-time') }
      break
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
    if (!matches) return { error: t('claude-elicit-invalid-pattern') }
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
      const kind = t(field.kind === 'integer' ? 'claude-elicit-kind-integer' : 'claude-elicit-kind-number')
      if (min !== undefined && max !== undefined) return t('claude-elicit-hint-range', { kind, min, max })
      if (min !== undefined) return t('claude-elicit-hint-min', { kind, min })
      if (max !== undefined) return t('claude-elicit-hint-max', { kind, max })
      return kind
    }
    case 'json':
      return t('claude-elicit-hint-json')
    case 'text': {
      const format = str(schema.format)
      return format === undefined ? undefined : t('claude-elicit-hint-format', { format })
    }
    default:
      return undefined
  }
}

/** A field's question (with the reason it is asked again, if any). */
function fieldQuestion(field: FormField, header: string, lead: string | undefined, error: string | undefined): QuestionItemView {
  const skip = t('claude-elicit-skip')
  const detail = [
    error === undefined ? undefined : t('claude-elicit-invalid', { reason: error }),
    lead,
    field.description,
    constraintHint(field),
  ].filter((line): line is string => line !== undefined && line !== '').join('\n')
  const question = field.required ? field.title : t('claude-elicit-optional', { title: field.title })
  const optional = field.required ? [] : [{ label: skip, description: t('claude-elicit-skip-desc') }]
  const defaults = (labels: readonly string[]): { defaultSelected?: readonly string[] } => labels.length === 0 ? {} : { defaultSelected: labels }
  const base = { question, header, ...(detail === '' ? {} : { detail }) }
  switch (field.kind) {
    case 'choice': {
      const fallback = str(field.schema.default)
      return { ...base, options: [...field.choices!.map(choice => ({ label: choice.label })), ...optional], hideCustomInput: true, ...defaults(field.choices!.filter(choice => choice.value === fallback).map(choice => choice.label)) }
    }
    case 'boolean': {
      const yes = t('claude-elicit-yes')
      const no = t('claude-elicit-no')
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
function fieldValue(field: FormField, answer: QuestionAnswers['answers'][number] | undefined): { readonly value: FormValue } | { readonly skip: true } | { readonly error: string } {
  const selected = answer?.selected ?? []
  const custom = answer?.custom?.trim() ?? ''
  const skip = t('claude-elicit-skip')
  const skipped = selected.includes(skip)
  switch (field.kind) {
    case 'choice': {
      const choice = field.choices!.find(item => item.label === selected[0])
      if (choice !== undefined) return { value: choice.value }
      return skipped && !field.required ? { skip: true } : { error: t('claude-elicit-invalid-choice') }
    }
    case 'boolean':
      if (selected[0] === t('claude-elicit-yes')) return { value: true }
      if (selected[0] === t('claude-elicit-no')) return { value: false }
      return skipped && !field.required ? { skip: true } : { error: t('claude-elicit-invalid-choice') }
    case 'multi': {
      const values = field.choices!.filter(choice => selected.includes(choice.label)).map(choice => choice.value)
      if (values.length === 0) return skipped && !field.required ? { skip: true } : { error: t('claude-elicit-invalid-choice') }
      const min = num(field.schema.minItems)
      const max = num(field.schema.maxItems)
      if (min !== undefined && values.length < min) return { error: t('claude-elicit-invalid-min-items', { n: min }) }
      if (max !== undefined && values.length > max) return { error: t('claude-elicit-invalid-max-items', { n: max }) }
      return { value: values }
    }
    default:
      if (custom === '') return skipped && !field.required ? { skip: true } : { error: t('claude-elicit-invalid-required') }
      return parseFieldText(field, custom)
  }
}

/** A short server label for the panel header chip. */
const serverHeader = (name: string): string => {
  const flat = name.replace(/\s+/gu, ' ').trim()
  return flat.length <= 24 ? flat : `${flat.slice(0, 23)}…`
}

/** One parked ask (an elicitation or a dialog, possibly re-asked). */
interface Pending {
  /** The SDK request id (the flow's identity). */
  readonly flow: string
  /** The question request id currently shown (a re-ask gets a new one). */
  askId: string
  readonly kind: 'form' | 'url' | 'dialog'
  /** Called with the user's answers to the shown ask. */
  answer(answers: QuestionAnswers): void
  /** The user dismissed the panel. */
  dismiss(): void
  /** Withdraw (abort, dispose): answer the SDK's cancel shape. */
  withdraw(): void
  /** A redelivered request (same request id) waits for the same answer. */
  join(resolve: (result: never) => void): void
  /** URL mode: the server and elicitation id `elicitation_complete` names. */
  readonly url?: { readonly server: string; readonly elicitationId?: string }
}

export interface ClaudeDialogBridgeDeps {
  /** Deliver events to the channel (buffered until it subscribes). */
  emit(events: readonly AgentEvent[]): void
  debug(message: string): void
  /** The number of parked asks changed (session status). */
  onPendingChange?(count: number): void
  /** The session is closing: new requests are refused at once. */
  closing(): boolean
}

/** Create the bridge for one session. */
export function createClaudeDialogBridge(deps: ClaudeDialogBridgeDeps) {
  /** By the ask id currently shown. */
  const byAsk = new Map<string, Pending>()
  /** By the SDK request id. */
  const byFlow = new Map<string, Pending>()

  const changed = (): void => {
    try {
      deps.onPendingChange?.(byFlow.size)
    } catch (error) {
      deps.debug(`claude: dialog pending-change listener failed (${errorText(error)})`)
    }
  }

  /** Show (or re-show) a flow's ask. */
  const show = (entry: Pending, askId: string, questions: readonly QuestionItemView[]): void => {
    byAsk.delete(entry.askId)
    entry.askId = askId
    byAsk.set(askId, entry)
    deps.emit([{ type: 'question.request', request: { requestId: askId, questions } }])
  }

  /** Close a flow's panel and forget it (once). */
  const close = (entry: Pending): boolean => {
    if (byFlow.get(entry.flow) !== entry) return false
    byFlow.delete(entry.flow)
    byAsk.delete(entry.askId)
    deps.emit([{ type: 'question.settled', requestId: entry.askId }])
    changed()
    return true
  }

  /** Park a flow: its first ask, its abort wiring, its settlement. */
  const park = <R>(
    flow: string,
    signal: AbortSignal,
    resolve: (result: R) => void,
    build: (finish: (result: R) => void, reask: (questions: readonly QuestionItemView[]) => void) => Omit<Pending, 'flow' | 'askId' | 'withdraw' | 'join'> & { readonly questions: readonly QuestionItemView[]; readonly cancelled: R },
  ): void => {
    let settled = false
    let round = 0
    let entry: Pending | undefined
    const resolvers: ((result: R) => void)[] = [resolve]
    const onAbort = (): void => { entry?.withdraw() }
    const finish = (result: R): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (entry !== undefined) close(entry)
      for (const each of resolvers.splice(0)) each(result)
    }
    const reask = (questions: readonly QuestionItemView[]): void => {
      if (settled || entry === undefined) return
      round += 1
      // The old ask closes; the new one carries its own id.
      deps.emit([{ type: 'question.settled', requestId: entry.askId }])
      show(entry, `${flow}~${round}`, questions)
    }
    const built = build(finish, reask)
    entry = {
      flow,
      askId: flow,
      kind: built.kind,
      answer: built.answer,
      dismiss: built.dismiss,
      withdraw: () => finish(built.cancelled),
      join: (more: (result: never) => void) => { resolvers.push(more as (result: R) => void) },
      ...(built.url === undefined ? {} : { url: built.url }),
    }
    byFlow.set(flow, entry)
    byAsk.set(flow, entry)
    signal.addEventListener('abort', onAbort, { once: true })
    deps.emit([{ type: 'question.request', request: { requestId: flow, questions: built.questions } }])
    changed()
  }

  /** A form elicitation: its fields, then send / decline. */
  const form = (request: ElicitationRequest, flow: string, signal: AbortSignal, resolve: (result: ElicitationResult) => void): void => {
    const fields = formFields(rec(request.requestedSchema))
    const header = serverHeader(request.displayName ?? request.serverName)
    const lead = [request.title, request.message].filter((line): line is string => line !== undefined && line.trim() !== '').join('\n')
    const send = t('claude-elicit-send')
    const decline = t('claude-elicit-decline')
    const confirm: QuestionItemView = {
      question: t('claude-elicit-confirm', { server: request.serverName }),
      header,
      ...(fields.length === 0 && lead !== '' ? { detail: lead } : {}),
      options: [{ label: send, description: t('claude-elicit-send-desc') }, { label: decline, description: t('claude-elicit-decline-desc') }],
      hideCustomInput: true,
    }
    const values = new Map<string, FormValue>()
    /** The fields the shown ask covers (all of them, then the invalid ones). */
    let asked: readonly FormField[] = fields
    let sending = false
    park<ElicitationResult>(flow, signal, resolve, (finish, reask) => ({
      kind: 'form',
      questions: [...fields.map((field, index) => fieldQuestion(field, header, index === 0 ? lead : undefined, undefined)), confirm],
      cancelled: { action: 'cancel' },
      answer: answers => {
        // The send / decline choice is asked once, after the first round.
        if (!sending) {
          const choice = answers.answers[asked.length]?.selected[0]
          if (choice !== send) {
            finish({ action: 'decline' })
            return
          }
          sending = true
        }
        const invalid: { field: FormField; error: string }[] = []
        asked.forEach((field, index) => {
          const outcome = fieldValue(field, answers.answers[index])
          if ('error' in outcome) invalid.push({ field, error: outcome.error })
          else if ('skip' in outcome) values.delete(field.key)
          else values.set(field.key, outcome.value)
        })
        if (invalid.length > 0) {
          asked = invalid.map(item => item.field)
          reask(invalid.map(item => fieldQuestion(item.field, header, undefined, item.error)))
          return
        }
        finish({ action: 'accept', content: Object.fromEntries(values) })
      },
      dismiss: () => finish({ action: 'cancel' }),
    }))
  }

  /** A URL elicitation: the notice, then accept / decline with the link. */
  const url = (request: ElicitationRequest, flow: string, signal: AbortSignal, resolve: (result: ElicitationResult) => void): void => {
    const target = request.url
    if (target === undefined || target.trim() === '') {
      deps.emit([{ type: 'notice', level: 'warning', key: `elicit:${flow}`, text: t('claude-elicit-url-missing', { server: request.serverName }) }])
      resolve({ action: 'decline' })
      return
    }
    const accept = t('claude-elicit-url-accept')
    const decline = t('claude-elicit-decline')
    deps.emit([{ type: 'notice', level: 'info', key: `elicit-url:${request.elicitationId ?? flow}`, text: t('claude-elicit-url-notice', { server: request.serverName, url: target }) }])
    park<ElicitationResult>(flow, signal, resolve, finish => ({
      kind: 'url',
      url: { server: request.serverName, ...(request.elicitationId === undefined ? {} : { elicitationId: request.elicitationId }) },
      questions: [{
        question: request.message.trim() === '' ? t('claude-elicit-url-question', { server: request.serverName }) : request.message,
        header: serverHeader(request.displayName ?? request.serverName),
        detail: t('claude-elicit-url-detail'),
        link: target,
        options: [{ label: accept, description: t('claude-elicit-url-accept-desc') }, { label: decline, description: t('claude-elicit-decline-desc') }],
        hideCustomInput: true,
      }],
      cancelled: { action: 'cancel' },
      answer: answers => finish({ action: answers.answers[0]?.selected[0] === accept ? 'accept' : 'decline' }),
      dismiss: () => finish({ action: 'cancel' }),
    }))
  }

  const onElicitation: OnElicitation = (request, options) => new Promise<ElicitationResult>(resolve => {
    try {
      const flow = `elicit-${options.requestId}`
      if (deps.closing()) { resolve({ action: 'cancel' }); return }
      if (options.signal.aborted) { resolve({ action: 'cancel' }); return }
      const previous = byFlow.get(flow)
      if (previous !== undefined) {
        // A redelivered request (a transport gap) waits for the same answer.
        previous.join(resolve as (result: never) => void)
        return
      }
      const mode = request.mode ?? 'form'
      if (mode === 'form') form(request, flow, options.signal, resolve)
      else if (mode === 'url') url(request, flow, options.signal, resolve)
      else {
        deps.emit([{ type: 'notice', level: 'warning', key: `elicit:${flow}`, text: t('claude-elicit-unsupported', { server: request.serverName, mode: String(mode) }) }])
        resolve({ action: 'decline' })
      }
    } catch (error) {
      deps.debug(`claude: elicitation failed (${errorText(error)})`)
      resolve({ action: 'decline' })
    }
  })

  /** The refusal-fallback dialog: retry on the fallback model, or cancel. */
  const refusalFallback = (request: UserDialogRequest, flow: string, signal: AbortSignal, resolve: (result: UserDialogResult) => void): void => {
    const payload = rec(request.payload)
    const fallback = str(payload?.fallbackModel)
    const original = str(payload?.originalModel)
    if (fallback === undefined || fallback === '') {
      resolve({ behavior: 'cancelled' })
      return
    }
    const retry = t('claude-refusal-retry', { model: fallback })
    const cancel = t('claude-refusal-cancel')
    const category = str(payload?.apiRefusalCategory)
    const detail = [
      str(payload?.guidanceText)?.trim(),
      category === undefined || category === '' ? undefined : t('claude-refusal-category', { category }),
    ].filter((line): line is string => line !== undefined && line !== '').join('\n')
    park<UserDialogResult>(flow, signal, resolve, finish => ({
      kind: 'dialog',
      questions: [{
        question: t('claude-refusal-question', { model: original ?? t('claude-refusal-this-model') }),
        header: t('claude-refusal-header'),
        ...(detail === '' ? {} : { detail }),
        options: [{ label: retry, description: t('claude-refusal-retry-desc') }, { label: cancel, description: t('claude-refusal-cancel-desc') }],
        hideCustomInput: true,
      }],
      cancelled: { behavior: 'cancelled' },
      answer: answers => finish(answers.answers[0]?.selected[0] === retry
        ? { behavior: 'completed', result: 'retry_fallback' }
        : { behavior: 'completed', result: 'cancelled' }),
      dismiss: () => finish({ behavior: 'cancelled' }),
    }))
  }

  const onUserDialog: OnUserDialog = (request, options) => new Promise<UserDialogResult>(resolve => {
    try {
      const flow = `dialog-${options.requestId}`
      if (deps.closing() || options.signal.aborted) { resolve({ behavior: 'cancelled' }); return }
      const previous = byFlow.get(flow)
      if (previous !== undefined) {
        previous.join(resolve as (result: never) => void)
        return
      }
      if (request.dialogKind === 'refusal_fallback_prompt') {
        refusalFallback(request, flow, options.signal, resolve)
        return
      }
      // An undeclared kind: the SDK's contract answer (the CLI then applies
      // the dialog's default).
      deps.debug(`claude: dialog kind ${request.dialogKind} not rendered; cancelled`)
      resolve({ behavior: 'cancelled' })
    } catch (error) {
      deps.debug(`claude: dialog failed (${errorText(error)})`)
      resolve({ behavior: 'cancelled' })
    }
  })

  return {
    onElicitation,
    onUserDialog,
    /** Whether an ask id is one of this bridge's (else the permission bridge's). */
    owns: (askId: string): boolean => byAsk.has(askId),
    respond(askId: string, answers: QuestionAnswers): void {
      byAsk.get(askId)?.answer(answers)
    },
    cancel(askId: string): void {
      byAsk.get(askId)?.dismiss()
    },
    /** `system/elicitation_complete`: the URL flow it names is done. */
    complete(server: string, elicitationId: string): void {
      for (const entry of [...byFlow.values()]) {
        if (entry.kind !== 'url' || entry.url?.server !== server || entry.url.elicitationId !== elicitationId) continue
        deps.emit([{ type: 'notice', level: 'info', key: `elicit-url:${elicitationId}`, text: t('claude-elicit-url-complete', { server }) }])
        entry.answer({ answers: [{ selected: [t('claude-elicit-url-accept')] }] })
      }
    },
    get size(): number { return byFlow.size },
    /** Withdraw everything (dispose, reconnect, a forced turn close). */
    settleAll(): void {
      for (const entry of [...byFlow.values()]) entry.withdraw()
    },
  }
}

export type ClaudeDialogBridge = ReturnType<typeof createClaudeDialogBridge>
