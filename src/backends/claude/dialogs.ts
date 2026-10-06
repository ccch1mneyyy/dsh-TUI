/**
 * MCP elicitation and the CLI's user dialogs (`onElicitation` /
 * `onUserDialog`): the session's two other
 * human-in-the-loop callbacks. Every request becomes a structured ask the
 * shared QuestionStore renders (`question.request`), answered through the
 * session's `questions` capability, and settles into the shape the SDK
 * expects:
 *
 *  - form elicitation: the shared form flow (`src/channel/elicitation.ts`:
 *    one question per field of the requested JSON schema, validated against
 *    the field's constraints, invalid answers asked again, optional fields
 *    skippable, a last question that sends or declines) settles as
 *    `{action:'accept', content}` / `{action:'decline'}`; a dismissed panel
 *    is `{action:'cancel'}`;
 *  - URL elicitation: a notice row naming the server and the URL, and the
 *    shared accept / decline question carrying the link;
 *    `system/elicitation_complete` for it closes the panel as accepted;
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
import { createElicitationForm, createElicitationUrlAsk, elicitationNotices } from '../../channel/elicitation.js'
import { t } from '../../i18n.js'
import { errorText, rec, str } from './narrow.js'

/** The dialog kinds this client renders (`supportedDialogKinds`). */
export const SUPPORTED_DIALOG_KINDS: readonly string[] = ['refusal_fallback_prompt']

// The form schema rules are the shared, backend-neutral ones
// (`src/channel/elicitation.ts`); re-exported for this backend's callers.
export { formFields, parseFieldText, type FormField } from '../../channel/elicitation.js'

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
  /** URL mode: the server reported the flow done (accept). */
  complete?(): void
  /** A redelivered request (same request id) waits for the same answer;
   *  its own signal withdraws the flow like the first one's. */
  join(resolve: (result: never) => void, signal: AbortSignal): void
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
    const signals: AbortSignal[] = [signal]
    const onAbort = (): void => { entry?.withdraw() }
    const finish = (result: R): void => {
      if (settled) return
      settled = true
      for (const each of signals.splice(0)) each.removeEventListener('abort', onAbort)
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
      join: (more: (result: never) => void, moreSignal: AbortSignal) => {
        resolvers.push(more as (result: R) => void)
        if (moreSignal.aborted) {
          finish(built.cancelled)
          return
        }
        signals.push(moreSignal)
        moreSignal.addEventListener('abort', onAbort, { once: true })
      },
      ...(built.url === undefined ? {} : { url: built.url }),
      ...(built.complete === undefined ? {} : { complete: built.complete }),
    }
    byFlow.set(flow, entry)
    byAsk.set(flow, entry)
    signal.addEventListener('abort', onAbort, { once: true })
    deps.emit([{ type: 'question.request', request: { requestId: flow, questions: built.questions } }])
    changed()
  }

  /** A form elicitation: its fields, then send / decline (the shared
   *  form flow decides every round; this bridge only parks and answers). */
  const form = (request: ElicitationRequest, flow: string, signal: AbortSignal, resolve: (result: ElicitationResult) => void): void => {
    const ask = createElicitationForm(request)
    park<ElicitationResult>(flow, signal, resolve, (finish, reask) => ({
      kind: 'form',
      questions: ask.questions,
      cancelled: { action: 'cancel' },
      answer: answers => {
        const step = ask.answer(answers)
        if (step.kind === 'reask') reask(step.questions)
        else if (step.kind === 'decline') finish({ action: 'decline' })
        else finish({ action: 'accept', content: { ...step.content } })
      },
      dismiss: () => finish({ action: 'cancel' }),
    }))
  }

  /** A URL elicitation: the notice, then accept / decline with the link. */
  const url = (request: ElicitationRequest, flow: string, signal: AbortSignal, resolve: (result: ElicitationResult) => void): void => {
    const ask = createElicitationUrlAsk(request)
    if (ask === undefined) {
      deps.emit([{ type: 'notice', level: 'warning', key: `elicit:${flow}`, text: elicitationNotices.urlMissing(request.serverName) }])
      resolve({ action: 'decline' })
      return
    }
    deps.emit([{ type: 'notice', level: 'info', key: `elicit-url:${request.elicitationId ?? flow}`, text: elicitationNotices.urlOpen(request.serverName, request.url!) }])
    park<ElicitationResult>(flow, signal, resolve, finish => ({
      kind: 'url',
      url: { server: request.serverName, ...(request.elicitationId === undefined ? {} : { elicitationId: request.elicitationId }) },
      questions: ask.questions,
      cancelled: { action: 'cancel' },
      answer: answers => finish({ action: ask.accepted(answers) ? 'accept' : 'decline' }),
      dismiss: () => finish({ action: 'cancel' }),
      complete: () => finish({ action: 'accept' }),
    }))
  }

  const onElicitation: OnElicitation = (request, options) => new Promise<ElicitationResult>(resolve => {
    try {
      const flow = `elicit-${options.requestId}`
      if (deps.closing()) { resolve({ action: 'cancel' }); return }
      const previous = byFlow.get(flow)
      if (previous !== undefined) {
        // A redelivered request (a transport gap) waits for the same answer.
        previous.join(resolve as (result: never) => void, options.signal)
        return
      }
      if (options.signal.aborted) { resolve({ action: 'cancel' }); return }
      const mode = request.mode ?? 'form'
      if (mode === 'form') form(request, flow, options.signal, resolve)
      else if (mode === 'url') url(request, flow, options.signal, resolve)
      else {
        deps.emit([{ type: 'notice', level: 'warning', key: `elicit:${flow}`, text: elicitationNotices.unsupported(request.serverName, String(mode)) }])
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
      if (deps.closing()) { resolve({ behavior: 'cancelled' }); return }
      const previous = byFlow.get(flow)
      if (previous !== undefined) {
        previous.join(resolve as (result: never) => void, options.signal)
        return
      }
      if (options.signal.aborted) { resolve({ behavior: 'cancelled' }); return }
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
        deps.emit([{ type: 'notice', level: 'info', key: `elicit-url:${elicitationId}`, text: elicitationNotices.urlComplete(server) }])
        entry.complete?.()
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
