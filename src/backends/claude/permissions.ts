/**
 * The Claude permission bridge (docs/agent-backend-design.md §4.7): the
 * session's `canUseTool` callback. Every prompt parks here, keyed by the
 * control request id, and surfaces to the channel as an Agent Domain event:
 *
 *  - an ordinary tool prompt → `permission.request` with backend-generated
 *    options (allow once; allow always — only when the CLI suggests what to
 *    remember and the prompt allows it — labelled by what it remembers;
 *    reject, with an optional typed reason);
 *  - `AskUserQuestion` → `question.request` (the questionnaire panel);
 *  - `ExitPlanMode` → `question.request` presented as a plan review (approve
 *    with auto-accepted edits / approve with manual approvals / keep
 *    planning, with feedback).
 *
 * The user's answer comes back through `respond` / `respondQuestion` /
 * `cancelQuestion` and becomes the `PermissionResult` the CLI expects.
 *
 * Deadlock rules (design §4.7, each pinned by verify-claude-permissions):
 *  1. the SDK's abort signal (interrupt, turn end, process exit, `close()`)
 *     settles the prompt as withdrawn and closes the panel
 *     (`permission.settled{cancelled}` / `question.settled`) — EVERY
 *     delivered signal, a redelivery's included (R2-5);
 *  2. a user cancel only interrupts the CLI (the session's `cancel()`); the
 *     abort that follows is rule 1 — this bridge never answers on its own;
 *  3. a dismissed panel is a rejection (the panel's Esc);
 *  4. dispose / switch denies every pending prompt (`settleAll`) before the
 *     query closes;
 *  5. parallel prompts all park; the shared store shows them FIFO, one at a
 *     time (the CLI itself asks one at a time — Phase 3 probe);
 *  6. the callback never throws: a failure while building a prompt denies it.
 *
 * Persistence of an allow-always choice is entirely the CLI's: the bridge
 * hands back the CLI's own suggestions as `updatedPermissions` and never
 * writes a settings file.
 */
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision, QuestionAnswers } from '../../agent/capabilities.js'
import type { AgentEvent, PermissionOptionView, PermissionOutcome, PermissionRequestView, QuestionItemView } from '../../agent/events.js'
import { t } from '../../i18n.js'
import { displayPath } from './tools.js'

/** The model-facing refusal (design §4.7). */
export const REJECT_MESSAGE = 'User refused permission to run tool'
/** The model-facing answer to a cancelled `AskUserQuestion`. */
export const QUESTION_CANCEL_MESSAGE = 'User cancelled the question'
/** The model-facing answer to a plan sent back for more planning. */
export const PLAN_KEEP_PLANNING_MESSAGE = 'The user wants to keep planning and did not approve the plan'
/** The model-facing answer to a dismissed plan review. */
export const PLAN_DISMISSED_MESSAGE = 'The user dismissed the plan review'
/** What a withdrawn prompt resolves with (the CLI records its own refusal). */
export const WITHDRAWN_MESSAGE = 'The permission prompt was withdrawn'
/** What a prompt still open at dispose resolves with. */
export const CLOSED_MESSAGE = 'The session closed before the user answered'

type Kind = 'permission' | 'question' | 'plan'

/** Plan-review option labels, fixed when the prompt parks (the answer is
 *  matched against the very strings the panel showed). */
interface PlanLabels {
  readonly accept: string
  readonly manual: string
  readonly keep: string
}

interface Pending {
  readonly kind: Kind
  readonly requestId: string
  readonly toolUseID: string
  readonly input: Record<string, unknown>
  readonly suggestions: readonly PermissionUpdate[]
  readonly view?: PermissionRequestView
  readonly questions?: readonly QuestionItemView[]
  readonly plan?: PlanLabels
  /** Resolve every callback waiting on this request id. */
  readonly resolvers: ((result: PermissionResult) => void)[]
  /** One unsubscriber per delivered signal (a redelivery adds its own,
   *  R2-5); settle detaches them all. */
  readonly detachers: (() => void)[]
}

export interface ClaudePermissionBridgeDeps {
  /** The session cwd (paths in prompts display relative to it). */
  readonly cwd: string
  /** Deliver events to the channel (buffered until it subscribes). */
  emit(events: readonly AgentEvent[]): void
  debug(message: string): void
  /** The number of parked prompts changed (session status). */
  onPendingChange?(count: number): void
  /** The session is closing: new prompts are refused at once. */
  closing(): boolean
}

type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** One line naming what the tool would do. */
export function promptCommand(toolName: string, input: Rec, cwd: string): string | undefined {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return str(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path === undefined ? undefined : displayPath(path, cwd)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Glob':
    case 'Grep': {
      const pattern = str(input.pattern)
      return pattern === undefined ? undefined : path === undefined ? pattern : `${pattern} · ${displayPath(path, cwd)}`
    }
    default: {
      const json = JSON.stringify(input)
      if (json === undefined || json === '{}') return undefined
      return json.length <= 300 ? json : `${json.slice(0, 300)}…`
    }
  }
}

/** `Tool(content)` as a permission rule is written. */
const ruleText = (rule: { readonly toolName: string; readonly ruleContent?: string }): string =>
  rule.ruleContent === undefined || rule.ruleContent === '' ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`

/**
 * The allow-always label: what the CLI's suggestions would remember, in the
 * user's words. Undefined when no suggestion has a known shape (the generic
 * label stands in).
 */
export function alwaysLabel(suggestions: readonly PermissionUpdate[], cwd: string): string | undefined {
  const parts = suggestions.flatMap((suggestion): string[] => {
    switch (suggestion.type) {
      case 'addRules': {
        if (suggestion.behavior !== 'allow' || suggestion.rules.length === 0) return []
        const rules = suggestion.rules.map(ruleText).join(', ')
        const key = suggestion.destination === 'session' || suggestion.destination === 'cliArg'
          ? 'claude-always-rules-session'
          : suggestion.destination === 'userSettings' ? 'claude-always-rules-user' : 'claude-always-rules-project'
        return [t(key, { rules })]
      }
      case 'setMode':
        return [suggestion.mode === 'acceptEdits' ? t('claude-always-accept-edits') : t('claude-always-mode', { mode: suggestion.mode })]
      case 'addDirectories':
        return suggestion.directories.length === 0 ? [] : [t('claude-always-directories', { dirs: suggestion.directories.map(dir => displayPath(dir, cwd)).join(', ') })]
      default:
        return []
    }
  })
  return parts.length === 0 ? undefined : parts.join('; ')
}

/** The structured questions of an `AskUserQuestion` input (none = unreadable). */
function questionsOf(input: Rec): QuestionItemView[] {
  const list = Array.isArray(input.questions) ? input.questions : []
  return list.flatMap((raw): QuestionItemView[] => {
    const item = rec(raw)
    const question = str(item?.question)
    if (item === undefined || question === undefined || question.trim() === '') return []
    const options = (Array.isArray(item.options) ? item.options : []).flatMap(option => {
      const value = rec(option)
      const label = str(value?.label)
      return label === undefined || label === '' ? [] : [{ label, ...(str(value?.description) === undefined ? {} : { description: str(value?.description)! }) }]
    })
    return [{
      question,
      ...(str(item.header) === undefined ? {} : { header: str(item.header)! }),
      options,
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    }]
  })
}

/** Create the bridge for one session. */
export function createClaudePermissionBridge(deps: ClaudePermissionBridgeDeps) {
  const pending = new Map<string, Pending>()

  const changed = (): void => {
    try {
      deps.onPendingChange?.(pending.size)
    } catch (error) {
      deps.debug(`claude: pending-change listener failed (${errorText(error)})`)
    }
  }

  /** Settle one prompt: resolve its callbacks, tell the channel, once. */
  const settle = (entry: Pending, result: PermissionResult, outcome: PermissionOutcome): void => {
    if (pending.get(entry.requestId) !== entry) return
    pending.delete(entry.requestId)
    for (const detach of entry.detachers.splice(0)) detach()
    for (const resolve of entry.resolvers.splice(0)) resolve(result)
    deps.emit([entry.kind === 'permission'
      ? { type: 'permission.settled', requestId: entry.requestId, outcome }
      : { type: 'question.settled', requestId: entry.requestId }])
    changed()
  }

  const deny = (entry: Pick<Pending, 'toolUseID'>, message: string, extra: { interrupt?: boolean; classify?: boolean } = {}): PermissionResult => ({
    behavior: 'deny',
    message,
    toolUseID: entry.toolUseID,
    ...(extra.interrupt === true ? { interrupt: true } : {}),
    ...(extra.classify === false ? {} : { decisionClassification: 'user_reject' as const }),
  })

  const allow = (entry: Pending, input: Record<string, unknown>, updatedPermissions?: PermissionUpdate[], permanent = false): PermissionResult => ({
    behavior: 'allow',
    updatedInput: input,
    ...(updatedPermissions === undefined ? {} : { updatedPermissions }),
    toolUseID: entry.toolUseID,
    ...(permanent ? { decisionClassification: 'user_permanent' as const } : {}),
  })

  const canUseTool: CanUseTool = (toolName, input, options) => new Promise<PermissionResult>(resolve => {
    try {
      const requestId = options.requestId
      if (deps.closing()) {
        resolve(deny(options, CLOSED_MESSAGE))
        return
      }
      // Any of the request's delivered signals aborting cancels the shared
      // prompt (rule 1): one listener per signal, every one detached on
      // settle (R2-5 — a redelivery's signal included).
      const onAbort = (): void => {
        const entry = pending.get(requestId)
        if (entry !== undefined) settle(entry, deny(entry, WITHDRAWN_MESSAGE, { classify: false }), 'cancelled')
      }
      const listen = (signal: AbortSignal): (() => void) => {
        signal.addEventListener('abort', onAbort, { once: true })
        return () => { signal.removeEventListener('abort', onAbort) }
      }
      // The SDK may redeliver a request it already handed us (reinitialize
      // after a transport gap): the second callback waits for the same
      // answer — a SHARED request, so its signal is honoured exactly like
      // the first's (R2-5): a redelivery that arrives already aborted, or
      // is cancelled later, settles the whole group once with the same
      // withdrawn-deny — no resolver may be left hanging on a cancellation
      // the bridge was told about.
      const existing = pending.get(requestId)
      if (existing !== undefined) {
        existing.resolvers.push(resolve)
        if (options.signal.aborted) {
          settle(existing, deny(existing, WITHDRAWN_MESSAGE, { classify: false }), 'cancelled')
          return
        }
        existing.detachers.push(listen(options.signal))
        return
      }
      if (options.signal.aborted) {
        resolve(deny(options, WITHDRAWN_MESSAGE, { classify: false }))
        return
      }
      const suggestions = options.suggestions ?? []
      const kind: Kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permission'
      const base = { requestId, toolUseID: options.toolUseID, input, suggestions, resolvers: [resolve], detachers: [] as (() => void)[] }
      let entry: Pending
      let event: AgentEvent
      if (kind === 'question') {
        const questions = questionsOf(input)
        if (questions.length === 0) {
          resolve(deny(options, t('claude-question-unreadable'), { classify: false }))
          return
        }
        entry = { ...base, kind, questions }
        event = {
          type: 'question.request',
          request: { requestId, callId: options.toolUseID, ...(options.agentID === undefined ? {} : { agentId: options.agentID }), questions },
        }
      } else if (kind === 'plan') {
        const plan: PlanLabels = { accept: t('claude-plan-accept-edits'), manual: t('claude-plan-manual'), keep: t('claude-plan-keep') }
        const detail = str(input.plan)
        const questions: QuestionItemView[] = [{
          question: t('claude-plan-review-question'),
          header: t('claude-plan-review-header'),
          ...(detail === undefined ? {} : { detail }),
          options: [
            { label: plan.accept, description: t('claude-plan-accept-edits-desc') },
            { label: plan.manual, description: t('claude-plan-manual-desc') },
            { label: plan.keep, description: t('claude-plan-keep-desc') },
          ],
          intent: { kind: 'plan-review', approve: plan.accept, approveAlso: [plan.manual], decline: plan.keep },
        }]
        entry = { ...base, kind, questions, plan }
        event = { type: 'question.request', request: { requestId, callId: options.toolUseID, ...(options.agentID === undefined ? {} : { agentId: options.agentID }), questions } }
      } else {
        const alwaysAllowed = suggestions.length > 0 && options.suppressAlwaysAllowRule !== true && options.matchedAskRule === undefined
        const label = alwaysAllowed ? alwaysLabel(suggestions, deps.cwd) : undefined
        const choices: PermissionOptionView[] = [
          { id: 'allow-once', kind: 'allow-once' },
          ...(alwaysAllowed ? [{ id: 'allow-always', kind: 'allow-always' as const, ...(label === undefined ? {} : { label }) }] : []),
          { id: 'reject', kind: 'reject' },
        ]
        const command = promptCommand(toolName, input, deps.cwd)
        const view: PermissionRequestView = {
          requestId,
          toolName,
          callId: options.toolUseID,
          input,
          options: choices,
          feedback: true,
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.decisionReason === undefined ? {} : { reason: options.decisionReason }),
          ...(command === undefined ? {} : { command }),
          ...(options.blockedPath === undefined ? {} : { blockedPath: displayPath(options.blockedPath, deps.cwd) }),
          ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
          ...(options.defaultToNo === true ? { defaultToNo: true } : {}),
          ...(options.suppressAlwaysAllowRule === true ? { suppressAlwaysAllow: true } : {}),
          ...(options.matchedAskRule === undefined ? {} : { matchedAskRule: { ...options.matchedAskRule } }),
          ...(options.mcpServer === undefined ? {} : { mcpServer: { ...options.mcpServer } }),
        }
        entry = { ...base, kind, view }
        event = { type: 'permission.request', request: view }
      }
      pending.set(requestId, entry)
      entry.detachers.push(listen(options.signal))
      deps.emit([event])
      changed()
    } catch (error) {
      // Rule 6: a prompt this bridge cannot present is refused, never a hang.
      deps.debug(`claude: permission prompt failed (${errorText(error)})`)
      resolve(deny(options, REJECT_MESSAGE, { classify: false }))
    }
  })

  /** The user decided a tool prompt. */
  const respond = (requestId: string, decision: PermissionDecision): void => {
    const entry = pending.get(requestId)
    if (entry === undefined) return
    if (entry.kind !== 'permission') {
      deps.debug(`claude: ${requestId} is a ${entry.kind} prompt, not a permission`)
      return
    }
    const offered = (kind: PermissionOptionView['kind']): boolean => entry.view?.options.some(option => option.kind === kind) ?? false
    switch (decision.kind) {
      case 'allow-once':
        settle(entry, allow(entry, entry.input), 'allow-once')
        return
      case 'allow-always':
        // Fail closed: an allow-always the prompt never offered is a refusal.
        if (!offered('allow-always')) {
          settle(entry, deny(entry, REJECT_MESSAGE), 'rejected')
          return
        }
        settle(entry, allow(entry, entry.input, [...entry.suggestions], true), 'allow-always')
        return
      case 'reject': {
        const reason = decision.message?.trim() ?? ''
        settle(entry, deny(entry, reason === '' ? REJECT_MESSAGE : `${REJECT_MESSAGE}. The user said: ${reason}`), 'rejected')
        return
      }
      default: {
        const unknown: never = decision
        void unknown
      }
    }
  }

  /** The user answered a question (or a plan review). */
  const respondQuestion = (requestId: string, answers: QuestionAnswers): void => {
    const entry = pending.get(requestId)
    if (entry === undefined || entry.questions === undefined) return
    if (entry.kind === 'plan' && entry.plan !== undefined) {
      const answer = answers.answers[0]
      const pick = answer?.selected[0]
      const feedback = answer?.custom?.trim() ?? ''
      if ((pick === entry.plan.accept || pick === entry.plan.manual) && feedback === '') {
        const mode = pick === entry.plan.accept ? 'acceptEdits' : 'default'
        settle(entry, allow(entry, entry.input, [{ type: 'setMode', mode, destination: 'session' }]), 'allow-once')
        return
      }
      settle(entry, deny(entry, feedback === '' ? PLAN_KEEP_PLANNING_MESSAGE : `${PLAN_KEEP_PLANNING_MESSAGE}. The user said: ${feedback}`, { interrupt: true }), 'rejected')
      return
    }
    const map: Record<string, string> = {}
    entry.questions.forEach((question, index) => {
      const answer = answers.answers[index]
      if (answer === undefined) return
      const parts = [...answer.selected, ...(answer.custom === undefined || answer.custom.trim() === '' ? [] : [answer.custom.trim()])]
      if (parts.length > 0) map[question.question] = parts.join(', ')
    })
    settle(entry, allow(entry, { ...entry.input, answers: map }), 'allow-once')
  }

  /** The user dismissed a question (or a plan review). */
  const cancelQuestion = (requestId: string): void => {
    const entry = pending.get(requestId)
    if (entry === undefined || entry.kind === 'permission') return
    settle(entry, deny(entry, entry.kind === 'plan' ? PLAN_DISMISSED_MESSAGE : QUESTION_CANCEL_MESSAGE, { interrupt: true }), 'rejected')
  }

  return {
    canUseTool,
    respond,
    respondQuestion,
    cancelQuestion,
    /** Every parked tool prompt, in park order. */
    pendingViews(): readonly PermissionRequestView[] {
      return [...pending.values()].flatMap(entry => entry.view === undefined ? [] : [entry.view])
    },
    get size(): number { return pending.size },
    /** Withdraw everything (dispose, switch, a forced turn close). */
    settleAll(message: string = CLOSED_MESSAGE): void {
      for (const entry of [...pending.values()]) settle(entry, deny(entry, message, { classify: false }), 'cancelled')
    },
  }
}

export type ClaudePermissionBridge = ReturnType<typeof createClaudePermissionBridge>
