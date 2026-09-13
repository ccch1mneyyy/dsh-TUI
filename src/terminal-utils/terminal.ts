import chalk from 'chalk'
import wrapAnsi from 'wrap-ansi'

/**
 * Terminal-width line truncation for long tool output: the first few
 * wrapped rows are shown as-is, and any overflow is summarized with a dim
 * `… +N lines (ctrl+o to expand)` hint.
 *
 * Wrapping reserves a few columns of slack so folded rows never touch the
 * terminal edge, and huge inputs (e.g. multi-MB dumps) are pre-truncated
 * to a character budget before wrapping so the cost stays proportional to
 * what is actually rendered.
 */

/** Columns of slack reserved inside `terminalWidth` for the fold. */
const WRAP_WIDTH_PADDING = 4
/** Rows shown above the fold before truncation kicks in. */
const MAX_VISIBLE_LINES = 3
/** Character budget per visible row (× this) used to pre-truncate input. */
const PRETRUNCATE_MULTIPLIER = 4

/**
 * Wrap `text` to `width` and split it into a visible prefix and the number
 * of lines hidden below the fold.
 *
 * Special case: when exactly one line falls below the fold, that line is
 * shown directly and counted as visible, so short overflows never get a
 * hint row of their own.
 */
function foldAtWidth(
  text: string,
  width: number,
): { visible: string; hidden: number } {
  const lines = wrapAnsi(text, width, {
    trim: false,
    hard: false,
    wordWrap: true,
  }).split('\n')
  const totalLines = lines.length

  if (totalLines <= MAX_VISIBLE_LINES) {
    return {
      visible: lines.join('\n').trimEnd(),
      hidden: 0,
    }
  }

  const belowFold = totalLines - MAX_VISIBLE_LINES

  // One extra line is cheaper to show than to describe.
  if (belowFold === 1) {
    return {
      visible: lines.slice(0, MAX_VISIBLE_LINES + 1).join('\n').trimEnd(),
      hidden: 0,
    }
  }

  return {
    visible: lines.slice(0, MAX_VISIBLE_LINES).join('\n').trimEnd(),
    hidden: belowFold,
  }
}

/**
 * The `(ctrl+o to expand)` hint, dimmed.
 * @returns The dim hint text.
 */
export function ctrlOToExpand(): string {
  return chalk.dim('(ctrl+o to expand)')
}

/**
 * Render `content` with line-based truncation for terminal display.
 * Content that fits in the visible budget is returned unchanged (modulo
 * trailing whitespace); longer content is folded with an overflow hint.
 * @param content - Text to render; trailing whitespace is trimmed.
 * @param terminalWidth - Terminal width in columns; the wrap width reserves
 *                        4 columns of padding.
 * @param suppressExpandHint - When true, omit the `(ctrl+o to expand)`
 *                             suffix from the overflow hint.
 * @returns The truncated text, or `''` when `content` is blank after trimming.
 */
export function renderClippedLines(
  content: string,
  terminalWidth: number,
  suppressExpandHint = false,
): string {
  const trimmedContent = content.trimEnd()
  if (!trimmedContent) {
    return ''
  }

  // Keep the wrap width within a sane range regardless of the caller.
  const wrapWidth = Math.max(terminalWidth - WRAP_WIDTH_PADDING, 10)

  // Pre-truncate oversized inputs before wrapping: only the characters
  // that could possibly land on the visible rows are ever wrapped, which
  // avoids O(n) wrapping on huge outputs (e.g. 64MB binary dumps).
  const charBudget = MAX_VISIBLE_LINES * wrapWidth * PRETRUNCATE_MULTIPLIER
  const preTruncated = trimmedContent.length > charBudget
  const contentForWrapping = preTruncated
    ? trimmedContent.slice(0, charBudget)
    : trimmedContent

  const { visible, hidden } = foldAtWidth(contentForWrapping, wrapWidth)

  // When the input was pre-truncated, the fold can undercount the real
  // overflow, so fall back to a length-based estimate in that case.
  const estimatedRemaining = preTruncated
    ? Math.max(
        hidden,
        Math.ceil(trimmedContent.length / wrapWidth) - MAX_VISIBLE_LINES,
      )
    : hidden

  const overflowHint =
    estimatedRemaining > 0
      ? chalk.dim(
          `… +${estimatedRemaining} lines${
            suppressExpandHint ? '' : ` ${ctrlOToExpand()}`
          }`,
        )
      : ''

  return [visible, overflowHint].filter(Boolean).join('\n')
}
