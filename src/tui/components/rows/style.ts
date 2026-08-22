/**
 * Theme-to-ANSI styling helpers shared by the transcript row renderers
 * (plan §1.3, WP-03).
 *
 * pi-tui transcript rows emit ANSI-decorated strings directly through these
 * helpers. Every lookup reads `getActiveTheme()` AT CALL TIME, so a theme
 * switch only needs `invalidate()` on the row cache — no component rebuild
 * (pi-tui Markdown caches rendered ANSI, so stale caches must be dropped).
 *
 * `paint` accepts the raw palette value formats used by `src/theme.ts`
 * (`rgb(r,g,b)`, `#hex`, `ansi:name`, `ansi256(n)`, or empty = no color). It
 * is a foreground-only ANSI helper that preserves legacy theme palette
 * compatibility without depending on renderer internals.
 */
import chalk from 'chalk'
import { truncateToWidth, visibleWidth } from '../../public.js'
import { getActiveTheme, type Theme } from '../../../theme.js'

const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/
const ANSI256_REGEX = /^ansi256\(\s?(\d+)\s?\)$/

/** The `ansi:*` palette names a theme value may carry (dark-ansi theme). */
const ANSI_FG: Record<string, (text: string) => string> = {
  black: chalk.black,
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  magenta: chalk.magenta,
  cyan: chalk.cyan,
  white: chalk.white,
  gray: chalk.gray,
  grey: chalk.grey,
  blackBright: chalk.blackBright,
  redBright: chalk.redBright,
  greenBright: chalk.greenBright,
  yellowBright: chalk.yellowBright,
  blueBright: chalk.blueBright,
  magentaBright: chalk.magentaBright,
  cyanBright: chalk.cyanBright,
  whiteBright: chalk.whiteBright,
}

/**
 * Paint `text` with a raw theme color value. Empty or unparsable values
 * leave the text unchanged, preserving legacy theme compatibility.
 */
export function paint(text: string, color: string | undefined): string {
  if (!color) return text
  if (color.startsWith('ansi:')) {
    const fn = ANSI_FG[color.slice('ansi:'.length)]
    return fn === undefined ? text : fn(text)
  }
  const rgb = RGB_REGEX.exec(color)
  if (rgb) return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))(text)
  const ansi256 = ANSI256_REGEX.exec(color)
  if (ansi256) return chalk.ansi256(Number(ansi256[1]))(text)
  if (color.startsWith('#')) return chalk.hex(color)(text)
  return text
}

/** Paint `text` with a named token of the ACTIVE theme, read lazily. */
export function fg(token: keyof Theme, text: string): string {
  return paint(text, getActiveTheme()[token])
}

/**
 * One horizontal divider line with a centered title, in the Claude Code
 * visual language (`──── title ────`), with dim ANSI styling.
 * `title` is plain text (i18n strings bake their own padding spaces).
 */
export function dividerLine(title: string, width: number): string {
  const lineWidth = Math.max(0, width)
  const titleWidth = title === '' ? 0 : visibleWidth(title)
  if (titleWidth > 0 && titleWidth < lineWidth) {
    const lineLength = lineWidth - titleWidth
    const leftLength = Math.floor(lineLength / 2)
    const rightLength = Math.ceil(lineLength / 2)
    return chalk.dim('─'.repeat(leftLength) + title + '─'.repeat(rightLength))
  }
  return chalk.dim('─'.repeat(lineWidth))
}

/** Hard-clip plain text to a cell budget, ellipsis included in the budget. */
export function clip(text: string, maxWidth: number): string {
  return truncateToWidth(text, Math.max(0, maxWidth), '…')
}

/** Strip the trailing spaces pi-tui Markdown pads every line to. Safe on
 *  ANSI strings: the padding it removes is literal trailing space only. */
export function trimPad(line: string): string {
  return line.replace(/ +$/, '')
}
