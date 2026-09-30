/**
 * Title normalization shared by every migration source.
 *
 * One rule for all sources, so the same conversation shows the same title
 * whichever entry imported it: trim, collapse inner whitespace (a title is
 * one line), cap at {@link TITLE_MAX_CHARS} code points with a trailing `…`.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/parse/title
 */

/** Longest normalized title, in code points (the ellipsis included). */
export const TITLE_MAX_CHARS = 80

const ELLIPSIS = '…'

/**
 * Normalize a candidate title.
 * @param text - Raw title or first prompt.
 * @returns The one-line title, or '' when the input is blank.
 */
export function normalizeTitle(text: string | undefined): string {
  if (text === undefined) return ''
  const flat = text.trim().replace(/\s+/gu, ' ')
  if (flat === '') return ''
  // Code points, not UTF-16 units: a cut must never split a surrogate pair.
  const points = Array.from(flat)
  if (points.length <= TITLE_MAX_CHARS) return flat
  return `${points.slice(0, TITLE_MAX_CHARS - ELLIPSIS.length).join('').trimEnd()}${ELLIPSIS}`
}
