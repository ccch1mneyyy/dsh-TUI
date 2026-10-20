/**
 * One wording for "why a session could not be mounted".
 *
 * Four surfaces can refuse a mount — the supervisor, the session browser, the
 * workspace home screen and the transcript itself — and each used to spell the
 * same failures out on its own. That is how `/resume` and `/agentview` ended
 * up telling the user different things about the same refusal, and it is why a
 * newly added reason (the cross-process occupancy case) would have been
 * silently mis-reported as a generic failure on whichever surface was missed.
 *
 * The mapping is pure and total: it takes the adapter's discriminated result
 * and returns the sentence to show, or `undefined` for the outcomes that need
 * no words. The `cancelled` case is deliberately silent — the user (or a rival
 * switch) asked for it, so there is nothing to explain.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/resumeFailure
 */

import type { ResumeResult } from '../adapter/ports/channel-view.js'
import type { MountFailure } from '../sessionMounts.js'
import { t } from '../i18n.js'
import { WORKING_GATE_NOTICES } from '../commands.js'

/**
 * Whether a resume failure is an ownership refusal rather than a corrupt log.
 * The persistence backend reports `SessionAlreadyOwnedError` (name stable
 * across the validated lines) in two cases: an in-process claim collision
 * (this process already drives the log — e.g. a parked handle whose close is
 * still draining) and a foreign holder's kernel lock (another TUI terminal,
 * or dsh web sharing the same sessions root — issue #1635). Both must read
 * as "held by someone else", never as storage corruption.
 * @param error - The resume rejection.
 */
export function isSessionOwnershipError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('is already owned by an active write handle')
}
/**
 * The message for a failed mount, or undefined when it should stay silent.
 * @param result - The adapter's mount outcome.
 * @returns The user-facing sentence, or undefined for `cancelled`.
 */
export function resumeFailureText(result: ResumeResult): string | undefined {
  if (result.ok) return undefined
  switch (result.reason) {
    case 'cancelled':
      return undefined
    case 'working':
      return t(WORKING_GATE_NOTICES.resume)
    case 'unavailable':
      return t('resume-unavailable')
    case 'occupied':
      return t('resume-session-occupied', { pid: result.pid })
    case 'failed':
      return t('session-resume-failed', { err: result.error })
  }
}

/**
 * The sentence for a ledger refusal that did NOT find a holder.
 *
 * A refusal to CHECK is not a refusal by a peer, so it must not borrow the
 * "another terminal holds it" wording — that would invent a terminal. The
 * `occupied` case is here too because it is a {@link MountFailure} and its
 * sentence already exists; {@link resumeFailureText} reaches the same key from
 * the adapter's own result.
 *
 * A refusal the user can clear gets the repair instruction appended: every
 * interactive surface goes through here, and "occupancy could not be verified"
 * on its own is a dead end when the cause is a file that has to be deleted.
 * @param failure - Why the session could not be claimed.
 * @returns The user-facing sentence.
 */
export function mountFailureText(failure: MountFailure): string {
  if (failure.reason === 'occupied') {
    return t('resume-session-occupied', { pid: failure.holders[0] ?? 0 })
  }
  if (failure.reason === 'busy') return t('resume-mount-busy')
  const refusal = t('resume-mount-unavailable', { detail: failure.detail })
  // Without the flag this is exactly the sentence it was before; the repair
  // line is added only for damage, because it is advice the other causes
  // (permissions, a lock, a failed replace) would make wrong.
  return failure.damaged === true ? `${refusal} ${t('resume-mount-ledger-repair')}` : refusal
}
