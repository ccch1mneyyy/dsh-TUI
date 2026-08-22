/**
 * Shared chrome primitives for the inline overlay panels (plan §1.3, WP-03):
 * the approval, questionnaire/plan-review and plugin-dialog views all render
 * the same visual language (permission divider, focus pointer, dim hints) as
 * the retired React panels, but as imperative pi-tui components that emit
 * ANSI strings directly.
 *
 * What lives here:
 *
 * - `fg`/`themePainter`/`dim`/`bold`/`inverse` — chalk painters resolving
 *   palette colors (`rgb()`, `#hex`, `ansi256()`, `ansi:<name>`), looked up
 *   on the ACTIVE theme per call so a runtime /theme switch applies without
 *   remounting. (The old panels got this from Ink's Text color prop.)
 * - `dividerLine` — the design-system Divider: `─` line with an optional
 *   centered title, painted with a palette color.
 * - `hintLine` — the HintLine contract: the `**primary shortcut**` segment
 *   in bold, the whole line dim + italic.
 * - `textInput` — decode a key chunk into insertable text (Kitty CSI-u
 *   printables via the facade, bracketed-paste markers stripped, control
 *   chars rejected), mirroring the fork Input component's acceptance rules.
 * - `LineEdit` — the minimal single-line edit buffer the panels carry
 *   (code-point cursor steps so an emoji can never split into lone
 *   surrogates). This is NOT a port of the fork's Input: the fork component
 *   hardcodes a `> ` prompt and has no cell-cap hook, while the dialog
 *   input must enforce the protocol's INPUT_CELLS bound on every edit path.
 */
import chalk from 'chalk'
import { getActiveTheme, type Theme } from '../../../theme.js'
import { decodeKittyPrintable, visibleWidth } from '../../public.js'

/** A string painter (ANSI wrapper). */
export type Painter = (text: string) => string

const IDENTITY: Painter = text => text

const ANSI_FG: Record<string, (text: string) => string> = {
  black: text => chalk.black(text),
  red: text => chalk.red(text),
  green: text => chalk.green(text),
  yellow: text => chalk.yellow(text),
  blue: text => chalk.blue(text),
  magenta: text => chalk.magenta(text),
  cyan: text => chalk.cyan(text),
  white: text => chalk.white(text),
  blackBright: text => chalk.blackBright(text),
  redBright: text => chalk.redBright(text),
  greenBright: text => chalk.greenBright(text),
  yellowBright: text => chalk.yellowBright(text),
  blueBright: text => chalk.blueBright(text),
  magentaBright: text => chalk.magentaBright(text),
  cyanBright: text => chalk.cyanBright(text),
  whiteBright: text => chalk.whiteBright(text),
}

const ANSI256_REGEX = /^ansi256\(\s?(\d+)\s?\)$/
const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/

/**
 * Resolve a palette color value to a foreground painter. Accepts every
 * format the theme palettes produce (`ansi:<name>`, `#hex`, `ansi256(n)`,
 * `rgb(r,g,b)`); empty/unparsable values are the identity (Ink's `color`
 * prop behaved the same way).
 */
export function fg(color: string | undefined): Painter {
  if (!color) return IDENTITY
  if (color.startsWith('ansi:')) return ANSI_FG[color.substring('ansi:'.length)] ?? IDENTITY
  if (color.startsWith('#')) return text => chalk.hex(color)(text)
  const ansi256 = ANSI256_REGEX.exec(color)
  if (ansi256) {
    const value = Number(ansi256[1])
    return text => chalk.ansi256(value)(text)
  }
  const rgb = RGB_REGEX.exec(color)
  if (rgb) {
    const r = Number(rgb[1])
    const g = Number(rgb[2])
    const b = Number(rgb[3])
    return text => chalk.rgb(r, g, b)(text)
  }
  return IDENTITY
}

/** Foreground painter for a key of the ACTIVE theme, resolved per call so a
 *  runtime theme switch repaints without a remount. */
export function themePainter(key: keyof Theme): Painter {
  return text => fg(getActiveTheme()[key])(text)
}

export const dim: Painter = text => chalk.dim(text)
export const bold: Painter = text => chalk.bold(text)
export const inverse: Painter = text => chalk.inverse(text)
export const italic: Painter = text => chalk.italic(text)

/**
 * The design-system Divider as one ANSI line of exactly `width` cells:
 * a `─` rule with the title centered in it, painted with the palette color
 * (title included, as the old Ink Text colored the whole line).
 */
export function dividerLine(width: number, title: string | undefined, color: keyof Theme): string {
  const paint = themePainter(color)
  const lineWidth = Math.max(0, width)
  const titleWidth = title === undefined ? 0 : visibleWidth(title)
  if (title !== undefined && titleWidth < lineWidth) {
    const lineLength = lineWidth - titleWidth
    const left = Math.floor(lineLength / 2)
    const right = Math.ceil(lineLength / 2)
    return paint(`${'─'.repeat(left)}${title}${'─'.repeat(right)}`)
  }
  return paint('─'.repeat(lineWidth))
}

/**
 * The HintLine contract: the dict's `**primary shortcut**` segment renders
 * bold, the whole line dim + italic (`<Text dimColor italic><HintLine/>`).
 */
export function hintLine(text: string): string {
  const parts = text.split('**')
  const body = parts.map((part, index) => (index % 2 === 1 ? bold(part) : part)).join('')
  return chalk.dim(chalk.italic(body))
}

/**
 * Decode a key chunk into insertable text, or undefined when the chunk is a
 * key (control chars, escape sequences) rather than text. Mirrors the fork
 * Input component's acceptance order: Kitty CSI-u printables first (they
 * contain ESC but ARE text), then any chunk free of C0/DEL/C1 control chars.
 * Bracketed-paste markers are stripped so a pasted chunk decodes to its
 * content. Callers still check their key bindings FIRST (Enter/arrows/Esc)
 * — this helper only runs once no binding matched.
 */
export function textInput(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined) return kitty
  const stripped = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
  if (stripped === '') return undefined
  for (const ch of stripped) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined
  }
  return stripped
}

/**
 * The minimal single-line edit buffer the overlay panels carry (custom
 * answer, plan-review feedback, dialog input). The cursor counts CODE
 * POINTS (`[...s]` iteration, the retired ExtensionDialog contract), so an
 * emoji is one step and can never be split into a lone surrogate.
 */
export class LineEdit {
  private points: string[] = []
  /** Cursor position in code points (0..points.length). */
  cursor = 0

  reset(value = '', cursor?: number): void {
    this.points = [...value]
    this.cursor = cursor === undefined ? this.points.length : Math.min(cursor, this.points.length)
  }

  get value(): string {
    return this.points.join('')
  }

  get length(): number {
    return this.points.length
  }

  /** The value that insert(text) would produce (cell-cap checks). */
  previewInsert(text: string): string {
    return this.points.slice(0, this.cursor).join('') + text + this.points.slice(this.cursor).join('')
  }

  /** Insert at the cursor (typing in a focused input row). */
  insert(text: string): void {
    const chunk = [...text]
    if (chunk.length === 0) return
    this.points.splice(this.cursor, 0, ...chunk)
    this.cursor += chunk.length
  }

  /** Append at the tail and move the cursor there (typing on an option row,
   *  where the input row's caret is not focused). */
  append(text: string): void {
    this.points.push(...[...text])
    this.cursor = this.points.length
  }

  backspace(): void {
    if (this.cursor <= 0) return
    this.points.splice(this.cursor - 1, 1)
    this.cursor -= 1
  }

  deleteForward(): void {
    if (this.cursor < this.points.length) this.points.splice(this.cursor, 1)
  }

  moveLeft(): void {
    this.cursor = Math.max(0, this.cursor - 1)
  }

  moveRight(): void {
    this.cursor = Math.min(this.points.length, this.cursor + 1)
  }

  moveHome(): void {
    this.cursor = 0
  }

  moveEnd(): void {
    this.cursor = this.points.length
  }

  /** Text before the cursor. */
  before(): string {
    return this.points.slice(0, this.cursor).join('')
  }

  /** The code point under the cursor, or a space at end of line (the cell
   *  the inverse caret paints). */
  at(): string {
    return this.points[this.cursor] ?? ' '
  }

  /** Text after the cursor; `skipAt` consumes the caret cell (focused
   *  inverse caret replaces the char), otherwise the char stays. */
  after(skipAt: boolean): string {
    return this.points.slice(skipAt ? this.cursor + 1 : this.cursor).join('')
  }
}
