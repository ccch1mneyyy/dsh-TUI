/** Client-side Plan implementation confirmation (official Codex TUI flow). */
import type { QuestionAnswers } from '../../../agent/capabilities.js'
import type { AgentEvent } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { errorText } from '../narrow.js'
import { PLAN_IMPLEMENTATION_PROMPT } from './prompts.js'

interface PlanReviewDeps {
  emit(events: readonly AgentEvent[]): void
  implement(): Promise<void>
  clearContext(plan: string): Promise<void>
  followup(text: string): Promise<void>
}

export function createPlanReview(deps: PlanReviewDeps) {
  let pending: { id: string; plan: string; yes: string; clear: string; stay: string } | undefined
  const withdraw = (): void => {
    if (pending === undefined) return
    const id = pending.id
    pending = undefined
    deps.emit([{ type: 'question.settled', requestId: id }])
  }
  return {
    offer(turnId: string, plan: string): void {
      withdraw()
      if (plan.trim() === '') return
      const yes = t('codex-plan-yes')
      const clear = t('codex-plan-clear')
      const stay = t('codex-plan-stay')
      const id = `codex-plan:${turnId}`
      pending = { id, plan, yes, clear, stay }
      deps.emit([{ type: 'question.request', request: { requestId: id, questions: [{
        question: t('codex-plan-implement'), header: t('codex-mode-plan'), detail: plan,
        options: [{ label: yes }, { label: clear }, { label: stay }],
        intent: { kind: 'plan-review', approve: yes, approveAlso: [clear], decline: stay },
      }] } }])
    },
    owns(id: string): boolean { return pending?.id === id },
    respond(id: string, answers: QuestionAnswers): void {
      if (pending?.id !== id) return
      const current = pending
      const answer = answers.answers[0]
      withdraw()
      const selected = answer?.selected[0]
      const action = selected === current.clear ? () => deps.clearContext(current.plan)
        : selected === current.yes ? () => deps.implement()
        : answer?.custom?.trim() ? () => deps.followup(answer.custom!.trim()) : undefined
      if (action !== undefined) void action().catch(error => deps.emit([{ type: 'notice', level: 'error', key: 'codex-plan-action', text: t('codex-plan-action-failed', { error: errorText(error) }) }]))
    },
    cancel(id: string): void { if (pending?.id === id) withdraw() },
    withdraw,
  }
}

export { PLAN_IMPLEMENTATION_PROMPT }
