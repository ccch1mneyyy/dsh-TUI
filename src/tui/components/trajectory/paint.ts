/**
 * Trajectory paint helpers — theme-aware chalk coloring and cell-width
 * clipping for the pi-tui trajectory scene.
 *
 * Trajectory components render ANSI-decorated strings directly through the
 * pi-tui boundary. Colors resolve through the active palette returned by
 * `getActiveTheme()`, and every line is clipped explicitly, ANSI-aware, via
 * pi-tui's `truncateToWidth`.
 *
 * Theme values keep the four legacy-compatible forms supported by the TUI ANSI
 * helpers — `#hex`, `rgb(r,g,b)`, `ansi256(n)`, `ansi:name` (the `dark-ansi`
 * palette) — and the parser below preserves that behavior. Unparseable values
 * pass the text through uncolored rather than throwing inside a render.
 */

import chalk from 'chalk'
import { truncateToWidth, visibleWidth } from '../../public.js'
import { getActiveTheme, type Theme } from '../../../theme.js'

/** Extra SGR styles a segment can carry (bold, dim, or italic). */
export interface PaintStyle {
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
}

type Painter = (text: string) => string

const IDENTITY: Painter = (text) => text

/** chalk's named foregrounds, keyed by the `ansi:` payload. */
const ANSI_FG: Record<string, Painter> = {
  black: chalk.black,
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  magenta: chalk.magenta,
  cyan: chalk.cyan,
  white: chalk.white,
  blackBright: chalk.blackBright,
  redBright: chalk.redBright,
  greenBright: chalk.greenBright,
  yellowBright: chalk.yellowBright,
  blueBright: chalk.blueBright,
  magentaBright: chalk.magentaBright,
  cyanBright: chalk.cyanBright,
  whiteBright: chalk.whiteBright,
  gray: chalk.gray,
  grey: chalk.grey,
}

/** chalk's named backgrounds, keyed by the `ansi:` payload. */
const ANSI_BG: Record<string, Painter> = {
  black: chalk.bgBlack,
  red: chalk.bgRed,
  green: chalk.bgGreen,
  yellow: chalk.bgYellow,
  blue: chalk.bgBlue,
  magenta: chalk.bgMagenta,
  cyan: chalk.bgCyan,
  white: chalk.bgWhite,
  blackBright: chalk.bgBlackBright,
  redBright: chalk.bgRedBright,
  greenBright: chalk.bgGreenBright,
  yellowBright: chalk.bgYellowBright,
  blueBright: chalk.bgBlueBright,
  magentaBright: chalk.bgMagentaBright,
  cyanBright: chalk.bgCyanBright,
  whiteBright: chalk.bgWhiteBright,
  gray: chalk.bgGray,
  grey: chalk.bgGrey,
}

const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/
const ANSI256_REGEX = /^ansi256\(\s?(\d+)\s?\)$/

/** Resolve a raw theme/computed color value to a chalk painter. */
function colorPainter(raw: string | undefined, background: boolean): Painter {
  if (raw === undefined || raw === '') return IDENTITY
  if (raw.startsWith('ansi:')) {
    return (background ? ANSI_BG : ANSI_FG)[raw.slice('ansi:'.length)] ?? IDENTITY
  }
  if (raw.startsWith('#')) {
    return background ? chalk.bgHex(raw) : chalk.hex(raw)
  }
  if (raw.startsWith('ansi256')) {
    const match = ANSI256_REGEX.exec(raw)
    if (match === null) return IDENTITY
    const value = Number(match[1])
    return background ? chalk.bgAnsi256(value) : chalk.ansi256(value)
  }
  if (raw.startsWith('rgb')) {
    const match = RGB_REGEX.exec(raw)
    if (match === null) return IDENTITY
    const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])]
    return background ? chalk.bgRgb(r, g, b) : chalk.rgb(r, g, b)
  }
  return IDENTITY
}

/** Compose a color painter with the optional bold/dim/italic styles. */
function styled(paint: Painter, style?: PaintStyle): Painter {
  if (style === undefined) return paint
  let out = paint
  if (style.dim) out = andThen(out, chalk.dim)
  if (style.bold) out = andThen(out, chalk.bold)
  if (style.italic) out = andThen(out, chalk.italic)
  return out
}

function andThen(first: Painter, second: Painter): Painter {
  return (text) => second(first(text))
}

/** The active palette, resolved fresh per call (theme switches are runtime-hot). */
export function activeTheme(): Theme {
  return getActiveTheme()
}

/** Foreground-paint `text` with a theme key; `undefined` key leaves it bare. */
export function fg(key: keyof Theme | undefined, text: string, style?: PaintStyle): string {
  if (key === undefined) return styled(IDENTITY, style)(text)
  return fgValue(getActiveTheme()[key] as string, text, style)
}

/** Foreground-paint with a raw color value (e.g. a `mix()` result). */
export function fgValue(raw: string | undefined, text: string, style?: PaintStyle): string {
  return styled(colorPainter(raw, false), style)(text)
}

/** The ledger badge: bold foreground over a theme-keyed background pill. */
export function badge(fgRaw: string | undefined, bgKey: keyof Theme | undefined, text: string): string {
  const foreground = colorPainter(fgRaw, false)
  const background = colorPainter(bgKey === undefined ? undefined : (getActiveTheme()[bgKey] as string), true)
  return chalk.bold(background(foreground(text)))
}

/**
 * Hard ANSI-aware clip to `width` cells for the pi-tui trajectory contract:
 * no ellipsis, and a cut segment is reset so color never leaks.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return truncateToWidth(text, width, '', false)
}

/** Pad on the right with spaces to exactly `width` visible cells. */
export function padEnd(text: string, width: number): string {
  const gap = width - visibleWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/** Pad on the left with spaces to exactly `width` visible cells. */
export function padStart(text: string, width: number): string {
  const gap = width - visibleWidth(text)
  return gap > 0 ? ' '.repeat(gap) + text : text
}
