/**
 * Codex server requests → the shared permission and question surfaces
 * (docs/codex-backend-design.md §5.8, §8.4).
 *
 * - Command approvals offer what the server allows (`availableDecisions`;
 *   when absent, the official client's default: accept, a proposed prefix
 *   rule, cancel — C0). Labels follow the official wording.
 * - File-change approvals: accept, accept for the session, reject.
 * - Permission requests: grant for the turn, for the session, or nothing.
 * - Questions (`item/tool/requestUserInput`): one panel question per
 *   question; a cancel answers with no answers and interrupts the turn (C0
 *   V7, as the official client's Esc does).
 * - A rejection without a reason declines (when offered) and Codex
 *   continues; with a reason it cancels and the reason runs as the next turn
 *   ("tell Codex what to do differently", D10).
 *
 * Nothing settles optimistically: a prompt the user answered closes on
 * `serverRequest/resolved` (or when its item completes / its turn ends);
 * one resolved elsewhere closes as cancelled. A request the server
 * re-delivers (a rejoin, C0 V5) is not shown twice. Dispose withdraws and
 * answers everything still open, so the server never waits forever.
 */
import { randomUUID } from 'node:crypto'
import type { PermissionDecision, QuestionAnswers } from '../../../agent/capabilities.js'
import type { AgentEvent, PermissionOptionView, PermissionOutcome, PermissionRequestView, QuestionItemView } from '../../../agent/events.js'
import { createElicitationForm, createElicitationUrlAsk, elicitationNotices } from '../../../channel/elicitation.js'
import { t } from '../../../i18n.js'
import { displayPath } from '../../shared/display-path.js'
import { arr, errorText, num, rec, str, type Rec } from '../narrow.js'
import { SERVER_REQUEST } from '../protocol/index.js'
import { REAL_CLOCK, RPC_ERROR, type RpcClock } from '../rpc/client.js'
import type { HubServerRequest } from '../rpc/hub.js'
import { unwrapShell } from '../translate/commands.js'

type Kind = 'command' | 'file' | 'permissions' | 'question' | 'elicitation'

/** One offered permission choice and the decision it sends. */
interface Choice {
  readonly option: PermissionOptionView
  readonly decision: unknown
}

interface Parked {
  readonly key: string
  readonly request: HubServerRequest
  readonly kind: Kind
  /** The thread the request came from (absent = this session's own thread).
   *  A subagent's background request parked here must SURVIVE this thread's
   *  turn completion — the server still awaits its answer. */
  readonly threadId?: string
  readonly itemId?: string
  readonly view?: PermissionRequestView
  readonly choices?: readonly Choice[]
  /** The question ids, in panel order. */
  readonly questionIds?: readonly string[]
  /** The outcome the user picked (set once answered). */
  answered?: PermissionOutcome
  askId?: string
  answerQuestion?: (answers: QuestionAnswers) => void
  cancelTimer?: () => void
}

export interface ApprovalBridgeDeps {
  readonly cwd: string
  /** The session's own thread: a request from another thread (a subagent
   *  routed here) is shown with that thread as its agent. */
  readonly threadId?: string
  emit(events: readonly AgentEvent[]): void
  debug(message: string): void
  /** Run a rejection's reason as the next turn. */
  enqueueFollowup(id: string, text: string): void
  /** Interrupt the running turn (a cancelled question). */
  interruptTurn(): void
  readonly clock?: RpcClock
}

/** The command an approval names: the lossless unwrap of a shell wrapper,
 *  else the command exactly as it will run (never Codex's parsed reading of
 *  it — a prompt must not show a different command than the one approved). */
const commandOf = (params: Rec): string | undefined => {
  const command = str(params.command)
  return command === undefined ? undefined : unwrapShell(command) ?? command
}

/** An execpolicy prefix as the official client renders it (`bash -lc`
 *  stripped, tokens space-joined); undefined when it spans lines. */
export function prefixLabel(amendment: readonly string[]): string | undefined {
  const tokens = amendment.length >= 3 && /(?:^|\/)(?:ba|z)?sh$/u.test(amendment[0]!) && /^-l?c$/u.test(amendment[1]!)
    ? [amendment.slice(2).join(' ')]
    : amendment.map(token => /^[\w./:=@%+-]+$/u.test(token) ? token : `'${token.replaceAll('\'', '\'"\'"\'')}'`)
  const label = tokens.join(' ')
  return /[\r\n]/u.test(label) ? undefined : label
}

/** The default decisions when a server sends none (the official client's). */
function defaultDecisions(params: Rec): unknown[] {
  const decisions: unknown[] = ['accept']
  const amendment = arr(params.proposedExecpolicyAmendment).filter((token): token is string => typeof token === 'string')
  if (amendment.length > 0) decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } })
  decisions.push('cancel')
  return decisions
}

/** The choices of a command approval, in the server's order. One reject
 *  stands for decline and cancel (the reason decides which is sent). */
function commandChoices(params: Rec): Choice[] {
  const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : defaultDecisions(params)
  const choices: Choice[] = []
  let network = 0
  let rejectAdded = false
  const declineOffered = offered.includes('decline')
  for (const raw of offered) {
    if (raw === 'accept') {
      choices.push({ option: { id: 'accept', kind: 'allow-once', label: t('codex-approve-accept') }, decision: 'accept' })
    } else if (raw === 'acceptForSession') {
      choices.push({ option: { id: 'session', kind: 'allow-always', label: t('codex-approve-session-command') }, decision: 'acceptForSession' })
    } else if (raw === 'decline' || raw === 'cancel') {
      // A plain rejection declines when the server allows it, else cancels.
      if (!rejectAdded) choices.push({ option: { id: 'reject', kind: 'reject', label: t(declineOffered ? 'codex-approve-decline' : 'codex-approve-cancel') }, decision: declineOffered ? 'decline' : 'cancel' })
      rejectAdded = true
    } else {
      const value = rec(raw)
      const amendment = arr(rec(value?.acceptWithExecpolicyAmendment)?.execpolicy_amendment).filter((token): token is string => typeof token === 'string')
      if (amendment.length > 0) {
        const prefix = prefixLabel(amendment)
        if (prefix !== undefined) choices.push({ option: { id: 'execpolicy', kind: 'allow-always', label: t('codex-approve-prefix', { prefix }) }, decision: raw })
        continue
      }
      const policy = rec(rec(value?.applyNetworkPolicyAmendment)?.network_policy_amendment)
      if (policy !== undefined && str(policy.action) === 'allow') {
        choices.push({ option: { id: `net:${network++}`, kind: 'allow-always', label: t('codex-approve-network', { host: str(policy.host) ?? '' }) }, decision: raw })
      }
    }
  }
  if (!rejectAdded) choices.push({ option: { id: 'reject', kind: 'reject', label: t('codex-approve-cancel') }, decision: 'cancel' })
  return choices
}

/** A one-line summary of requested extra permissions. */
function permissionsSummary(permissions: Rec | undefined, cwd: string): string {
  const parts: string[] = []
  if (rec(permissions?.network)?.enabled === true) parts.push(t('codex-perm-network'))
  const fileSystem = rec(permissions?.fileSystem)
  const paths = (access: string, legacy: unknown): string[] => [
    ...arr(legacy).filter((path): path is string => typeof path === 'string'),
    ...arr(fileSystem?.entries).flatMap(raw => {
      const entry = rec(raw)
      if (str(entry?.access) !== access) return []
      const path = rec(entry?.path)
      return [str(path?.path) ?? str(path?.pattern) ?? str(path?.value) ?? '']
    }),
  ].filter(path => path !== '').map(path => displayPath(path, cwd))
  const reads = paths('read', fileSystem?.read)
  const writes = paths('write', fileSystem?.write)
  if (reads.length > 0) parts.push(t('codex-perm-read', { paths: reads.join(', ') }))
  if (writes.length > 0) parts.push(t('codex-perm-write', { paths: writes.join(', ') }))
  return parts.join('; ')
}

/** What else a command approval asks for: input to a running terminal, a
 *  network host, extra permissions, another working directory. */
function commandDescription(params: Rec, cwd: string): string {
  const parts: string[] = []
  if (str(params.kind) === 'writeStdin') parts.push(t('codex-approve-stdin'))
  const network = rec(params.networkApprovalContext)
  const host = str(network?.host)
  if (host !== undefined && host !== '') parts.push(t('codex-approve-network-context', { host, protocol: str(network?.protocol) ?? '' }))
  const extra = permissionsSummary(rec(params.additionalPermissions), cwd)
  if (extra !== '') parts.push(t('codex-approve-extra-permissions', { what: extra }))
  const where = str(params.cwd)
  if (where !== undefined && where !== '' && where !== cwd) parts.push(t('codex-approve-cwd', { cwd: displayPath(where, cwd) }))
  return parts.join(' · ')
}

export function createApprovalBridge(deps: ApprovalBridgeDeps) {
  const parked = new Map<string, Parked>()

  /** A request from a routed subagent thread names that thread. */
  const agentOf = (params: Rec): { agentId?: string } => {
    const thread = str(params.threadId)
    return thread !== undefined && deps.threadId !== undefined && thread !== deps.threadId ? { agentId: thread } : {}
  }

  const settle = (entry: Parked, outcome: PermissionOutcome): void => {
    if (parked.get(entry.key) !== entry) return
    parked.delete(entry.key)
    entry.cancelTimer?.()
    deps.emit([entry.kind === 'question' || entry.kind === 'elicitation'
      ? { type: 'question.settled', requestId: entry.askId ?? entry.key }
      : { type: 'permission.settled', requestId: entry.key, outcome }])
  }

  const park = (entry: Parked, event: AgentEvent): void => {
    parked.set(entry.key, entry)
    deps.emit([event])
  }

  /** Answer a request this bridge cannot present (never a hang). */
  const refuse = (request: HubServerRequest, why: string): void => {
    deps.debug(`codex: refusing ${request.method} (${why})`)
    request.respondError(RPC_ERROR.methodNotFound, `dsh-tui does not handle ${request.method}`)
  }

  const onRequest = (request: HubServerRequest): void => {
    if (request.redelivered || parked.has(request.key)) {
      deps.debug(`codex: ${request.method} ${request.key} re-delivered; already on the panel`)
      return
    }
    const params = request.params
    const itemId = str(params.itemId)
    const threadId = str(params.threadId)
    switch (request.method) {
      case SERVER_REQUEST.commandApproval: {
        const choices = commandChoices(params)
        const command = commandOf(params)
        const reason = str(params.reason)
        const stdin = str(params.kind) === 'writeStdin'
        const description = commandDescription(params, deps.cwd)
        const view: PermissionRequestView = {
          requestId: request.key,
          toolName: 'shell',
          ...(itemId === undefined ? {} : { callId: itemId }),
          displayName: stdin ? t('codex-approve-stdin-name') : t('tool-name-bash'),
          ...(command === undefined ? {} : { command, input: { command } }),
          ...(description === '' ? {} : { description }),
          ...(reason === undefined || reason === '' ? {} : { reason }),
          ...agentOf(params),
          feedback: true,
          options: choices.map(choice => choice.option),
        }
        park({ key: request.key, request, kind: 'command', ...(threadId === undefined ? {} : { threadId }), ...(itemId === undefined ? {} : { itemId }), view, choices }, { type: 'permission.request', request: view })
        return
      }
      case SERVER_REQUEST.fileChangeApproval: {
        const reason = str(params.reason)
        const root = str(params.grantRoot)
        const choices: Choice[] = [
          { option: { id: 'accept', kind: 'allow-once', label: t('codex-approve-accept') }, decision: 'accept' },
          { option: { id: 'session', kind: 'allow-always', label: t('codex-approve-session-files') }, decision: 'acceptForSession' },
          { option: { id: 'reject', kind: 'reject', label: t('codex-approve-decline-files') }, decision: 'decline' },
        ]
        const view: PermissionRequestView = {
          requestId: request.key,
          toolName: 'apply_patch',
          ...(itemId === undefined ? {} : { callId: itemId }),
          displayName: t('tool-name-edit'),
          ...(reason === undefined || reason === '' ? {} : { reason }),
          ...(root === undefined || root === '' ? {} : { blockedPath: displayPath(root, deps.cwd) }),
          ...agentOf(params),
          feedback: true,
          options: choices.map(choice => choice.option),
        }
        park({ key: request.key, request, kind: 'file', ...(threadId === undefined ? {} : { threadId }), ...(itemId === undefined ? {} : { itemId }), view, choices }, { type: 'permission.request', request: view })
        return
      }
      case SERVER_REQUEST.permissionsApproval: {
        const requested = rec(params.permissions)
        const granted: Rec = {
          ...(rec(requested?.network) === undefined ? {} : { network: requested!.network }),
          ...(rec(requested?.fileSystem) === undefined ? {} : { fileSystem: requested!.fileSystem }),
        }
        const reason = str(params.reason)
        const choices: Choice[] = [
          { option: { id: 'turn', kind: 'allow-once', label: t('codex-approve-grant-turn') }, decision: { permissions: granted, scope: 'turn' } },
          { option: { id: 'session', kind: 'allow-always', label: t('codex-approve-session-permissions') }, decision: { permissions: granted, scope: 'session' } },
          { option: { id: 'reject', kind: 'reject', label: t('codex-approve-deny-permissions') }, decision: { permissions: {}, scope: 'turn' } },
        ]
        const view: PermissionRequestView = {
          requestId: request.key,
          toolName: 'permissions',
          ...(itemId === undefined ? {} : { callId: itemId }),
          displayName: t('codex-permissions-name'),
          description: permissionsSummary(requested, deps.cwd),
          ...(reason === undefined || reason === '' ? {} : { reason }),
          ...agentOf(params),
          options: choices.map(choice => choice.option),
        }
        park({ key: request.key, request, kind: 'permissions', ...(threadId === undefined ? {} : { threadId }), ...(itemId === undefined ? {} : { itemId }), view, choices }, { type: 'permission.request', request: view })
        return
      }
      case SERVER_REQUEST.userInput: {
        const ids: string[] = []
        const questions: QuestionItemView[] = arr(params.questions).flatMap(raw => {
          const question = rec(raw)
          const id = str(question?.id)
          const textValue = str(question?.question)
          if (question === undefined || id === undefined || textValue === undefined) return []
          ids.push(id)
          const header = str(question.header)
          const options = arr(question.options).flatMap(option => {
            const value = rec(option)
            const label = str(value?.label)
            return label === undefined || label === '' ? [] : [{ label, ...(str(value?.description) === undefined || str(value?.description) === '' ? {} : { description: str(value?.description)! }) }]
          })
          return [{
            question: textValue,
            ...(question.isSecret === true ? { secret: true as const } : {}),
            ...(header === undefined || header === '' ? {} : { header }),
            options,
            // No free-text row unless the question allows "other" (or has no options).
            ...(question.isOther === true || options.length === 0 ? {} : { hideCustomInput: true }),
          }]
        })
        if (questions.length === 0) {
          request.respond({ answers: {} })
          return
        }
        const view = { requestId: request.key, ...(itemId === undefined ? {} : { callId: itemId }), ...agentOf(params), questions }
        const entry: Parked = { key: request.key, request, kind: 'question', ...(threadId === undefined ? {} : { threadId }), ...(itemId === undefined ? {} : { itemId }), questionIds: ids }
        park(entry, { type: 'question.request', request: view })
        const autoMs = num(params.autoResolutionMs)
        if (autoMs !== undefined && autoMs >= 0) {
          const clock = deps.clock ?? REAL_CLOCK
          const timer = clock.setTimeout(() => {
            respondQuestion(entry.key, { answers: questions.map(question => ({ selected: question.options[0] === undefined ? [] : [question.options[0].label] })) })
            deps.emit([{ type: 'notice', level: 'info', key: `codex-auto-answer:${entry.key}`, text: t('codex-question-auto-answered') }])
          }, autoMs)
          entry.cancelTimer = () => clock.clearTimeout(timer)
        }
        return
      }
      case SERVER_REQUEST.elicitation: {
        const serverName = str(params.serverName) ?? ''
        const mode = str(params.mode) ?? 'form'
        const source = { serverName, title: str(params.title), message: str(params.message), requestedSchema: params.requestedSchema, url: str(params.url) }
        const entry: Parked = { key: request.key, request, kind: 'elicitation', askId: request.key }
        const finish = (action: 'accept' | 'decline', content: unknown = null): void => {
          entry.answered = action === 'accept' ? 'allow-once' : 'rejected'
          request.respond({ action, content, _meta: null })
        }
        const show = (questions: readonly QuestionItemView[]): void => {
          deps.emit([{ type: 'question.request', request: { requestId: entry.askId!, ...agentOf(params), questions } }])
        }
        if (mode === 'url') {
          const ask = createElicitationUrlAsk(source)
          if (ask === undefined) {
            request.respond({ action: 'decline', content: null, _meta: null })
            deps.emit([{ type: 'notice', level: 'warning', key: `elicit:${request.key}`, text: elicitationNotices.urlMissing(serverName) }])
            return
          }
          entry.answerQuestion = answers => finish(ask.accepted(answers) ? 'accept' : 'decline')
          parked.set(entry.key, entry)
          deps.emit([{ type: 'notice', level: 'info', key: `elicit-url:${request.key}`, text: elicitationNotices.urlOpen(serverName, source.url!) }])
          show(ask.questions)
        } else if (mode === 'form' || mode === 'openai/form' || mode === 'openaiForm') {
          const form = createElicitationForm(source)
          let round = 0
          entry.answerQuestion = answers => {
            const step = form.answer(answers)
            if (step.kind !== 'reask') { finish(step.kind, step.kind === 'accept' ? step.content : null); return }
            deps.emit([{ type: 'question.settled', requestId: entry.askId! }])
            entry.askId = `${request.key}~${++round}`
            show(step.questions)
          }
          parked.set(entry.key, entry)
          show(form.questions)
        } else {
          request.respond({ action: 'decline', content: null, _meta: null })
          deps.emit([{ type: 'notice', level: 'warning', key: `elicit:${request.key}`, text: elicitationNotices.unsupported(serverName, mode) }])
        }
        return
      }
      default:
        refuse(request, 'not a prompt this backend presents')
    }
  }

  const respond = (requestId: string, decision: PermissionDecision): void => {
    const entry = parked.get(requestId)
    if (entry === undefined || entry.choices === undefined || entry.answered !== undefined) return
    const pick = (predicate: (choice: Choice) => boolean): Choice | undefined => entry.choices!.find(predicate)
    const reject = pick(choice => choice.option.kind === 'reject')
    const answer = (choice: Choice | undefined, outcome: PermissionOutcome): void => {
      if (choice === undefined) return
      // The outcome is what was sent: a fallback to the reject choice is a rejection.
      entry.answered = choice.option.kind === 'reject' ? 'rejected' : outcome
      const result = entry.kind === 'permissions' ? choice.decision : { decision: choice.decision }
      entry.request.respond(result)
    }
    switch (decision.kind) {
      case 'allow-once':
        answer(pick(choice => choice.option.kind === 'allow-once') ?? reject, 'allow-once')
        return
      case 'allow-always': {
        const chosen = pick(choice => choice.option.kind === 'allow-always' && (decision.optionId === undefined || choice.option.id === decision.optionId))
        // Fail closed: an allow-always the prompt never offered is a refusal.
        if (chosen === undefined) answer(reject, 'rejected')
        else answer(chosen, 'allow-always')
        return
      }
      case 'reject': {
        const reason = decision.message?.trim() ?? ''
        if (entry.kind === 'permissions') {
          answer(reject, 'rejected')
          if (reason !== '') deps.enqueueFollowup(randomUUID(), reason)
          return
        }
        if (reason === '') {
          // Decline continues without the action; only `cancel` offered = cancel.
          answer(reject, 'rejected')
          return
        }
        entry.answered = 'rejected'
        entry.request.respond({ decision: 'cancel' })
        deps.enqueueFollowup(randomUUID(), reason)
        return
      }
      default: {
        const unknown: never = decision
        void unknown
      }
    }
  }

  const respondQuestion = (requestId: string, answers: QuestionAnswers): void => {
    const entry = parked.get(requestId) ?? [...parked.values()].find(value => value.askId === requestId)
    if (entry === undefined || entry.answered !== undefined) return
    if (entry.kind === 'elicitation') { entry.answerQuestion?.(answers); return }
    if (entry.kind !== 'question') return
    entry.cancelTimer?.()
    const map: Record<string, { answers: string[] }> = {}
    entry.questionIds?.forEach((id, index) => {
      const answer = answers.answers[index]
      if (answer === undefined) return
      const custom = answer.custom?.trim() ?? ''
      map[id] = { answers: [...answer.selected, ...(custom === '' ? [] : [custom])] }
    })
    entry.answered = 'allow-once'
    entry.request.respond({ answers: map })
  }

  const cancelQuestion = (requestId: string): void => {
    const entry = parked.get(requestId) ?? [...parked.values()].find(value => value.askId === requestId)
    if (entry === undefined || entry.answered !== undefined) return
    if (entry.kind === 'elicitation') {
      entry.answered = 'cancelled'
      entry.request.respond({ action: 'cancel', content: null, _meta: null })
      return
    }
    if (entry.kind !== 'question') return
    entry.cancelTimer?.()
    entry.answered = 'cancelled'
    entry.request.respond({ answers: {} })
    deps.interruptTurn()
  }

  /** Answer and close everything still open (dispose, connection loss). */
  const withdrawAll = (): void => {
    for (const entry of [...parked.values()]) {
      if (entry.answered === undefined) {
        try {
          if (entry.kind === 'question') entry.request.respond({ answers: {} })
          else if (entry.kind === 'elicitation') entry.request.respond({ action: 'cancel', content: null, _meta: null })
          else if (entry.kind === 'permissions') entry.request.respond({ permissions: {}, scope: 'turn' })
          else entry.request.respond({ decision: 'cancel' })
        } catch (error) {
          deps.debug(`codex: withdrawing ${entry.key} failed (${errorText(error)})`)
        }
      }
      settle(entry, entry.answered ?? 'cancelled')
    }
  }

  return {
    onRequest,
    respond,
    respondQuestion,
    cancelQuestion,
    withdrawAll,
    /** `serverRequest/resolved`: the server is done with a request. */
    resolved(requestId: unknown): void {
      for (const entry of [...parked.values()]) {
        if (entry.request.id === requestId) settle(entry, entry.answered ?? 'cancelled')
      }
    },
    /** An item finished: an answered prompt about it is over. */
    itemCompleted(itemId: string): void {
      for (const entry of [...parked.values()]) {
        if (entry.itemId === itemId) settle(entry, entry.answered ?? 'cancelled')
      }
    },
    /** A turn ended: no prompt OF THIS THREAD can still be answered. A
     *  subagent's background request parked here outlives it (the server still
     *  awaits that answer; it settles via resolved/itemCompleted/dispose). */
    turnEnded(): void {
      for (const entry of [...parked.values()]) {
        if (entry.threadId !== undefined && entry.threadId !== deps.threadId) continue
        settle(entry, entry.answered ?? 'cancelled')
      }
    },
    pendingViews(): readonly PermissionRequestView[] {
      return [...parked.values()].flatMap(entry => entry.view === undefined || entry.answered !== undefined ? [] : [entry.view])
    },
    get size(): number { return parked.size },
  }
}

export type ApprovalBridge = ReturnType<typeof createApprovalBridge>
