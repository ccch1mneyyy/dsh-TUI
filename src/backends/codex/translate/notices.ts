/**
 * Codex warnings and errors as localized notices (docs/codex-backend-design.md
 * §7.5, §9.1). Every notice carries a `key`, so a repeat of the same
 * condition replaces its toast instead of stacking a new one.
 *
 * Known start-up noise (the bubblewrap fallback warning on Linux) is not a
 * notice: `/doctor` reports it.
 */
import { createHash } from 'node:crypto'
import type { AgentEvent, TurnEndReason } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { NOTIFY } from '../protocol/index.js'
import { rec, str, text, type Rec } from '../narrow.js'

type Notice = Extract<AgentEvent, { readonly type: 'notice' }>

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 10)

/** The kebab-case name of a `codexErrorInfo` (a string or a one-key object). */
export function errorCategory(info: unknown): string | undefined {
  const name = typeof info === 'string' ? info : Object.keys(rec(info) ?? {})[0]
  if (name === undefined || name === '') return undefined
  return name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)
}

/** Whether a configuration warning is the known sandbox fallback noise. */
export function isBubblewrapNoise(summary: string): boolean {
  return /bubblewrap/iu.test(summary)
}

/** `error` with `willRetry`: one keyed warning per turn, updated in place. */
export function retryNotice(params: Rec): Notice | undefined {
  if (params.willRetry !== true) return undefined
  const message = str(rec(params.error)?.message) ?? ''
  return { type: 'notice', level: 'warning', key: `retry:${str(params.turnId) ?? ''}`, text: t('codex-retrying', { message }) }
}

/** `warning` / `guardianWarning` / `configWarning` / `deprecationNotice`. */
export function warningNotice(method: string, params: Rec): Notice | undefined {
  const message = text(params.message) ?? text(params.summary)
  if (message === undefined) return undefined
  if (method === NOTIFY.configWarning && isBubblewrapNoise(message)) return undefined
  const details = text(params.details)
  const body = details === undefined ? message : `${message} ${details}`
  return { type: 'notice', level: 'warning', key: `${method}:${digest(message)}`, text: body }
}

/** The end reason of a `turn/completed` turn. */
export function turnEndReason(turn: Rec): TurnEndReason {
  switch (str(turn.status)) {
    case 'completed':
      return { kind: 'completed' }
    case 'interrupted':
      return { kind: 'interrupted' }
    case 'failed': {
      const error = rec(turn.error)
      const category = errorCategory(error?.codexErrorInfo)
      return { kind: 'error', message: str(error?.message) ?? t('codex-turn-failed'), ...(category === undefined ? {} : { category }) }
    }
    default:
      return { kind: 'other', label: str(turn.status) ?? 'unknown' }
  }
}

/**
 * The actionable hint after a failed turn, by its error category (§9.1):
 * sign in again, compact, wait for the limit, install the sandbox helper.
 * The turn's own message is already on its notice row.
 */
export function failureHint(reason: TurnEndReason, platform: string = process.platform): Notice | undefined {
  if (reason.kind !== 'error') return undefined
  switch (reason.category) {
    case 'unauthorized':
      return { type: 'notice', level: 'error', key: 'codex-hint:auth', text: t('codex-hint-unauthorized') }
    case 'context-window-exceeded':
      return { type: 'notice', level: 'warning', key: 'codex-hint:context', text: t('codex-hint-context') }
    case 'usage-limit-exceeded':
    case 'rate-limit-exceeded':
      return { type: 'notice', level: 'warning', key: 'codex-hint:limit', text: t('codex-hint-limit') }
    case 'sandbox-error':
      return platform === 'linux' ? { type: 'notice', level: 'warning', key: 'codex-hint:sandbox', text: t('codex-hint-sandbox') } : undefined
    default:
      return undefined
  }
}

/** `item/autoApprovalReview/*`: an info line while the auto-reviewer works. */
export function reviewNotice(method: string, params: Rec): Notice | undefined {
  const review = rec(params.review)
  const id = str(params.reviewId) ?? ''
  if (method === NOTIFY.autoApprovalReviewStarted) {
    return { type: 'notice', level: 'info', key: `auto-review:${id}`, text: t('codex-auto-review-started') }
  }
  const status = str(review?.status) ?? str(params.status)
  const outcome = status === 'approved' ? t('codex-auto-review-approved') : status === 'denied' ? t('codex-auto-review-denied') : t('codex-auto-review-ended')
  return { type: 'notice', level: 'info', key: `auto-review:${id}`, text: outcome }
}

/** `mcpServer/startupStatus/updated` failing: one warning per server. */
export function mcpStartupNotice(params: Rec): Notice | undefined {
  const status = str(params.status)
  const name = str(params.name) ?? ''
  if (status !== 'failed' && status !== 'error') return undefined
  return { type: 'notice', level: 'warning', key: `mcp:${name}`, text: t('codex-mcp-failed', { name, error: str(params.error) ?? '' }) }
}
