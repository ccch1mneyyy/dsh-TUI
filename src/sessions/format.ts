/**
 * Session browser formatting.
 *
 * Presentation only, and deliberately outside the adapter: these are choices
 * about a terminal's width and a reader's eye, not about what a session log
 * means.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/format
 */
import { t } from '../i18n.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { SessionKind, TitleSource } from '../dsh-adapter/sessions/index.js'
import type { Theme } from '../theme.js'

/**
 * Truncate to a terminal DISPLAY width, CJK-aware (a wide character costs two
 * columns).
 *
 * Used wherever the cut has to be exact: Ink's own `wrap="truncate"` appends
 * its ellipsis as soon as content is as wide as its box rather than wider,
 * which silently eats the last character of a row laid out at its natural
 * width — and a row that then reflows pushes every row below it down.
 *
 * @param text - Plain text, no ANSI.
 * @param maxWidth - Column budget, ellipsis included.
 * @returns `text` when it fits, otherwise a cut ending in `…`.
 */
export function truncateWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  let width = 0
  let out = ''
  for (const char of text) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    out += char
  }
  return `${out}…`
}

/** A row laid out as `left`, blank columns, then `right`. */
export interface SpreadRow {
  /** The left-hand segment, cut only if it alone exceeds the row. */
  readonly left: string
  /** Blank columns between the two segments; at least one. */
  readonly gap: number
  /** The right-hand segment, cut to whatever room the left one left. */
  readonly right: string
}

/**
 * Lay out one row with its two ends pushed apart.
 *
 * Measured in COLUMNS, which is the whole reason this is a function rather
 * than three expressions at the call site. Every string it receives is
 * localized, and in Chinese a character is two columns wide — arithmetic on
 * `.length` overstates the gap by the width of the text itself, so the row
 * overflows and the terminal either wraps it (shifting every region below it
 * down a line) or clips it (silently eating the right-hand segment). Both
 * failures are invisible to an English-only test.
 *
 * The invariant, which the regression checks exhaustively: the assembled row
 * is never wider than `columns`.
 *
 * @param left - Text pinned to the start of the row.
 * @param right - Text pinned to the end, truncated when it will not fit.
 * @param columns - Total width available.
 */
export function spreadRow(left: string, right: string, columns: number): SpreadRow {
  if (columns <= 0) return { left: '', gap: 0, right: '' }
  // One column of separation is always reserved, so the two segments can never
  // run together into an unreadable single word — which means the left segment
  // yields too when the row is narrower than it is.
  const fittedLeft = truncateWidth(left, Math.max(0, columns - 1))
  const leftWidth = stringWidth(fittedLeft)
  const fittedRight = truncateWidth(right, Math.max(0, columns - leftWidth - 1))
  return {
    left: fittedLeft,
    gap: Math.max(1, columns - leftWidth - stringWidth(fittedRight)),
    right: fittedRight,
  }
}

/**
 * Keep the END of a string within a display width, CJK-aware.
 *
 * What a single-line editor does: the caret lives at the end, so that is the
 * part worth showing. Used where text the user is typing has to stay on ONE
 * row — a wrapped input row steals a line from the list and can push the row
 * below it off the bottom of the screen.
 *
 * @param text - Plain text, no ANSI.
 * @param maxWidth - Column budget, leading ellipsis included.
 * @returns `text` when it fits, otherwise `…` followed by its tail.
 */
export function tailWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  const characters = [...text]
  let width = 0
  let out = ''
  for (let at = characters.length - 1; at >= 0; at--) {
    const character = characters[at]!
    const characterWidth = stringWidth(character)
    if (width + characterWidth > maxWidth - 1) break
    width += characterWidth
    out = character + out
  }
  return `…${out}`
}

/**
 * Elapsed time as a person would say it: `just now`, `9 hours ago`, and an
 * absolute date once "ago" stops being useful.
 *
 * The cut to an absolute date is at a week rather than a month because that is
 * roughly where a relative offset stops locating anything — "23 days ago" is a
 * number to be decoded, `Mar 3` is a memory.
 *
 * @param at - Epoch ms of the moment being described.
 * @param now - Epoch ms of the present, injectable so the formatter is a pure
 *   function and its regression does not depend on a clock.
 */
export function formatWhen(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return t('session-when-now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('session-when-minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('session-when-hours', { n: hours })
  const days = Math.round(hours / 24)
  if (days <= 7) return t('session-when-days', { n: days })
  const date = new Date(at)
  return t('session-when-date', {
    month: String(date.getMonth() + 1),
    day: String(date.getDate()),
  })
}

/**
 * Absolute local wall-clock: `2026-09-01 14:30:22`. Companion to
 * formatWhen's relative phrasing — the precise answer for telling three
 * similar-looking sessions apart in a hover tooltip.
 */
export function formatAbsolute(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Byte size at the precision the number is worth: `812 B`, `142.9 KB`,
 * `4.2 MB`. One decimal from kilobytes up, because the digit distinguishes a
 * short exchange from a long one and a second would not.
 */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Marker for a row's kind, or undefined for an ordinary conversation.
 *
 * Only the exceptional kinds are marked. A badge on every row would cost a
 * column of width and teach nothing — what a reader needs to see at a glance
 * is which rows are *not* the thing they came for.
 */
export function kindMark(kind: SessionKind): { glyph: string; color: keyof Theme } | undefined {
  if (kind.kind === 'subagent') return { glyph: '⑂', color: 'autoAccept' }
  if (kind.kind === 'fork') return { glyph: '⑃', color: 'planMode' }
  return undefined
}

/**
 * Wrap to a display width, CJK-aware.
 *
 * Greedy, breaking on a space when one is available in the line just filled
 * and mid-character when it is not — which is the correct behaviour for CJK,
 * where there are no spaces to break on and a word-only wrapper would emit one
 * enormous unbreakable line. Newlines in the input are honoured.
 *
 * @param text - Plain text, no ANSI.
 * @param width - Column budget per line.
 * @returns The wrapped lines, never empty for non-empty input.
 */
export function wrapWidth(text: string, width: number): string[] {
  if (width <= 0) return []
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let used = 0
    for (const char of paragraph) {
      const charWidth = stringWidth(char)
      if (used + charWidth > width) {
        // Prefer a word boundary, but only when it does not throw away most
        // of the line — a single long token must still make progress.
        const breakAt = line.lastIndexOf(' ')
        if (breakAt > width / 2) {
          lines.push(line.slice(0, breakAt))
          line = line.slice(breakAt + 1)
          used = stringWidth(line)
        } else {
          lines.push(line)
          line = ''
          used = 0
        }
      }
      line += char
      used += charWidth
    }
    lines.push(line)
  }
  return lines
}

/** Human name of a session kind, for the preview pane's header. */
export function kindLabel(kind: SessionKind): string {
  if (kind.kind === 'subagent') return t('session-kind-subagent')
  if (kind.kind === 'fork') return t('session-kind-fork')
  return t('session-kind-root')
}

/**
 * Colour for a title, by how much is actually known about it.
 *
 * A title the user chose is stated plainly; one a model generated reads the
 * same, because it is a real title; a first-prompt excerpt is dimmer, because
 * it is the session speaking rather than a name; a directory basename is
 * dimmest of all, because it says only "nothing here was readable".
 */
export function titleColor(source: TitleSource, focused: boolean): keyof Theme {
  if (focused) return 'suggestion'
  if (source === 'fallback') return 'subtle'
  if (source === 'prompt') return 'inactive'
  return 'text'
}

/**
 * Project label for a group header: the working directory, with `$HOME`
 * collapsed to `~` so the eye lands on the part that differs.
 */
export function formatProject(cwd: string, home: string): string {
  if (cwd.length === 0) return t('session-project-unknown')
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, '/')
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  }
  const normalized = normalize(cwd)
  const base = normalize(home)
  const comparableCwd = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const comparableBase = process.platform === 'win32' ? base.toLowerCase() : base
  const isBelowHome = comparableBase === '/'
    ? comparableCwd.startsWith('/')
    : comparableCwd.startsWith(`${comparableBase}/`)
  if (base.length > 0 && (comparableCwd === comparableBase || isBelowHome)) {
    const suffix = normalized.slice(base.length)
    return suffix.length === 0 ? '~' : `~${suffix.startsWith('/') ? suffix : `/${suffix}`}`
  }
  return normalized
}

/** Compact final path segment for the working-directory menu. */
export function projectName(cwd: string): string {
  if (cwd.length === 0) return t('session-project-unknown')
  const slashed = cwd.replace(/\\/g, '/')
  const normalized = /^\/+$/u.test(slashed) ? '/' : slashed.replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).at(-1)
  return name ?? normalized
}
