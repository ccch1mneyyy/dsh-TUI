import type {
  TuiInputDecision,
  TuiRewindMode,
  TuiRewindPromptDecision,
} from '../extension-events.js'
import { cleanRenderText, cleanScalarText } from '../sanitize.js'

/** `tui/input` return normalization: transform/handled/cancel or no opinion.
 *  A blank `{ text }` rewrite is NOT a decision — it is logged and the chain
 *  continues so a later veto listener still runs. */
export function normalizeInputDecision(
  result: unknown,
  warn: (what: string) => void,
): TuiInputDecision | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result !== 'object') {
    warn(`a non-object (${typeof result})`)
    return undefined
  }
  const record = result as Record<string, unknown>
  if (record.cancel === true) {
    const reason = cleanScalarText(record.reason, NOTICE_CELLS)
    return { cancel: true, ...(reason === '' ? {} : { reason }) }
  }
  if (record.handled === true) {
    const notice = cleanScalarText(record.notice, NOTICE_CELLS)
    return { handled: true, ...(notice === '' ? {} : { notice }) }
  }
  if (typeof record.text === 'string') {
    if (record.text.trim() === '') {
      warn('a blank {text} rewrite')
      return undefined
    }
    return { text: record.text }
  }
  warn('an unrecognized decision shape')
  return undefined
}

/** `tui/rewind-prompt` return normalization: cancel/modes or no opinion.
 *  Modes are COPIED with only validated, sanitized scalar fields — the raw
 *  plugin object must never reach the render path (a `description: {}` would
 *  crash ListItem's `.replace`, and control chars would corrupt the pane).
 *  Notices/reasons are toast-bound plugin text: sanitized too (see
 *  ./sanitize.js — the one implementation of the render-path contract). */
export function normalizeRewindPromptDecision(
  result: unknown,
  warn: (what: string) => void,
): TuiRewindPromptDecision | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result !== 'object') {
    warn(`a non-object (${typeof result})`)
    return undefined
  }
  const record = result as Record<string, unknown>
  if (record.cancel === true) {
    const reason = cleanScalarText(record.reason, NOTICE_CELLS)
    return { cancel: true, ...(reason === '' ? {} : { reason }) }
  }
  if (Array.isArray(record.modes)) {
    const modes: TuiRewindMode[] = []
    for (const raw of record.modes as unknown[]) {
      if (modes.length >= 8) break
      if (raw === null || typeof raw !== 'object') continue
      const candidate = raw as Record<string, unknown>
      if (typeof candidate.id !== 'string' || candidate.id.trim() === '') continue
      const label = typeof candidate.label === 'string' ? cleanRenderText(candidate.label, 120) : ''
      if (label === '') continue
      const description =
        typeof candidate.description === 'string' && candidate.description.trim() !== ''
          ? cleanRenderText(candidate.description, 400)
          : undefined
      modes.push({ id: candidate.id, label, ...(description === undefined ? {} : { description }) })
    }
    if (modes.length === 0) {
      warn('an empty or invalid {modes} list')
      return undefined
    }
    return { modes }
  }
  warn('an unrecognized decision shape')
  return undefined
}

/** Toast-bound plugin text (veto reasons, handled notices, rewind summaries)
 *  is render-path data too: same sanitization, toast-width cap. */
export const NOTICE_CELLS = 200

/** `tui/rewind-done` return normalization: the first non-empty STRING is the
 *  summary; anything else is not a decision. */
export function normalizeRewindDoneSummary(result: unknown, warn: (what: string) => void): string | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result === 'string') {
    const summary = cleanRenderText(result, NOTICE_CELLS)
    return summary === '' ? undefined : summary
  }
  warn('a non-string summary')
  return undefined
}
