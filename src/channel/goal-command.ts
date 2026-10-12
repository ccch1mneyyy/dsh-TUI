/**
 * The backend-neutral `/goal` (N6): its grammar for a session that serves
 * goals through the typed `goals` capability (DSH keeps its own
 * `dsh-command-goal` registry row and never reaches this), the status it
 * prints, and the budget readout every goal surface shares.
 *
 * Grammar (the DSH command's control words, plus a token budget):
 *
 *   /goal                          the current goal (or usage)
 *   /goal <objective>              set or replace the objective
 *   /goal --budget 50k <objective> … under a token budget (50000, 50k, 1.5m)
 *   /goal edit <objective>         replace the objective (same as set)
 *   /goal pause | resume | clear   only when the word is the whole input
 *
 * Pure: parsing and formatting only; the channel core's `backendGoals`
 * host performs the capability calls.
 */
import type { ChannelGoal } from '../adapter/ports/channel-view.js'
import { t } from '../i18n.js'
import { formatDuration, formatTokens } from '../terminal-utils/format.js'

/** What one `/goal` line asks for. */
export type GoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'set'; readonly objective: string; readonly tokenBudget?: number }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'invalid'; readonly reason: string }

const BUDGET_FLAG = /^--(?:budget|tokens)(?:=(\S+))?$/u
const BUDGET_VALUE = /^(\d+(?:\.\d+)?)([km])?$/iu

/** A token budget as typed (`50000`, `50k`, `1.5m`); undefined when invalid. */
export function parseTokenBudget(text: string): number | undefined {
  const match = BUDGET_VALUE.exec(text.replaceAll('_', '').replaceAll(',', ''))
  if (match === null) return undefined
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1000 : 1
  const value = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Parse the text after `/goal`. */
export function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim()
  if (input === '') return { kind: 'status' }
  if (input === 'pause' || input === 'resume' || input === 'clear') return { kind: input }
  let rest = input
  let tokenBudget: number | undefined
  const words = rest.split(/\s+/u)
  const flag = BUDGET_FLAG.exec(words[0]!)
  if (flag !== null) {
    const value = flag[1] ?? words[1]
    tokenBudget = value === undefined ? undefined : parseTokenBudget(value)
    if (tokenBudget === undefined) return { kind: 'invalid', reason: t('goal-backend-bad-budget', { value: value ?? '' }) }
    rest = words.slice(flag[1] === undefined ? 2 : 1).join(' ')
  }
  if (/^edit(?:\s|$)/u.test(rest)) rest = rest.slice(4)
  const objective = rest.trim()
  if (objective === '') return { kind: 'invalid', reason: t('goal-backend-missing-objective') }
  return { kind: 'set', objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }
}

type GoalBudget = NonNullable<ChannelGoal['budget']>

/** `Used 12.3k / 50k tokens · 4m` (no cap: `Used 12.3k tokens · 4m`). */
export function formatGoalBudget(budget: GoalBudget): string {
  const time = formatDuration(Math.max(0, budget.timeUsedSeconds) * 1000, { mostSignificantOnly: true })
  const used = formatTokens(Math.max(0, budget.tokensUsed))
  return budget.tokenBudget === null
    ? t('goal-budget-used-open', { used, time })
    : t('goal-budget-used', { used, budget: formatTokens(budget.tokenBudget), time })
}

/** The status-footer chip's compact budget: `12.3k/50k` (no cap: `12.3k`). */
export function formatGoalBudgetCompact(budget: GoalBudget): string {
  const used = formatTokens(Math.max(0, budget.tokensUsed))
  return budget.tokenBudget === null ? used : `${used}/${formatTokens(budget.tokenBudget)}`
}

const PHASE_KEYS = {
  active: 'goal-phase-active',
  paused: 'goal-phase-paused',
  blocked: 'goal-phase-blocked',
  complete: 'goal-phase-complete',
} as const

/** The `/goal` status lines: the goal, its phase, its budget (or rounds),
 *  why it is blocked; usage when there is none. */
export function goalStatusLines(goal: ChannelGoal | undefined): string[] {
  if (goal === undefined) return [t('goal-backend-none'), t('goal-backend-usage')]
  return [
    t('goal-backend-objective', { objective: goal.objective }),
    t('goal-backend-phase', { phase: t(PHASE_KEYS[goal.phase]) }),
    goal.budget === undefined
      ? t('goal-backend-rounds', { started: goal.roundsStarted, max: goal.maxGoalRounds })
      : formatGoalBudget(goal.budget),
    ...(goal.phase === 'blocked' && goal.blockedReason !== undefined ? [t('goal-backend-blocked', { message: goal.blockedReason.message })] : []),
    t('goal-backend-usage'),
  ]
}
