/**
 * LaTeX math in replies: delimiter recognition for the shared `marked`
 * instance and the render policy around the vendored Unicode renderer
 * (./latex.ts).
 *
 * Math is recognized at lex time as its own token, before marked's escape
 * handling can eat `\{`, `\,` or `\\` and before `*`/`_` inside a formula
 * turn into emphasis. That keeps the exact source available for every
 * fallback: a formula that is unsupported, too long, too wide, still
 * streaming, or switched off in settings shows its original text, never a
 * half-rendered or backslash-stripped one.
 *
 * Lexing does not depend on the settings switch — tokens are cached by
 * content, so only rendering reads it.
 *
 * Delimiters: `$…$`, `\(…\)` inline; `$$…$$`, `\[…\]` as a block when the
 * opener starts a line and the closer ends one, inline otherwise. The `$`
 * rules follow Pi's markdown tokenizer and Codex's TUI math scanner so that
 * prices, shell variables and PIDs stay prose.
 */

import type { TokenizerExtension, Tokens } from 'marked'
import { renderLatex } from './latex.js'

/** A recognized formula. `text` is the TeX between the delimiters, `raw` the
 *  full source span including them. */
export interface MathToken extends Tokens.Generic {
  type: 'math' | 'mathBlock'
  raw: string
  text: string
  /** Block only: the closer has not arrived yet (streaming, or an unclosed
   *  block at the end of a reply). Always shown as source. */
  pending?: boolean
}

/**
 * Formulas longer than this keep their source. Real equations are far
 * shorter; anything this long is a paste, and the parser walks it
 * recursively. Same order as Codex's 4096-byte budget.
 */
const MATH_SOURCE_LIMIT = 4096

/** Render TeX through the vendored parser; any failure means "keep the source". */
function renderTex(text: string, display: boolean): string | undefined {
  if (text.length > MATH_SOURCE_LIMIT) return undefined
  try {
    const rendered = renderLatex(text, { display })
    return rendered === undefined || rendered.trim() === '' ? undefined : rendered
  } catch {
    return undefined
  }
}

/**
 * Single-line Unicode for a formula, or undefined when it has none. Inline
 * math sits inside wrapped prose, so a multi-line result (cases, matrices,
 * aligned rows) would be torn apart by wrapping — those keep their source.
 */
export function renderInlineMath(text: string): string | undefined {
  const rendered = renderTex(text, false)
  return rendered === undefined || rendered.includes('\n') ? undefined : rendered
}

/** Display-mode layout (stacked fractions, operator limits) as lines. */
export function renderDisplayMath(text: string): string[] | undefined {
  return renderTex(text, true)?.split('\n')
}

export function isMathToken(token: { type: string }): token is MathToken {
  return token.type === 'math'
}

export function isMathBlockToken(token: { type: string }): token is MathToken {
  return token.type === 'mathBlock'
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0
  for (let position = index - 1; position >= 0 && source[position] === '\\'; position--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
  let index = source.indexOf(closing, start)
  while (index >= 0 && isEscaped(source, index)) {
    // A literal \$ can sit directly before $$, so candidate pairs may overlap.
    index = source.indexOf(closing, index + 1)
  }
  return index
}

/** TeX commands or operators: what an unclosed `$$` block needs to hold
 *  before it is treated as a formula in progress rather than prose. */
function looksLikeMath(source: string): boolean {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source)
}

/**
 * Reasons a `$`/`$$` pair is prose, not math:
 * - body starts or ends with whitespace (`$5 and $10`, `echo $$ … $$`);
 * - `${…}` shell expansion;
 * - closer glued to an ASCII letter or digit (`$x$y`, `$1$2`) — CJK text may
 *   touch the closer, since Chinese prose does not space around math;
 * - a backtick inside (the pair straddles a code span);
 * - a bare number or an all-caps word (`$5,$`, `$HOME$`);
 * - an env-var-like body followed by another identifier (`$HOME/$USER`).
 */
function isDollarProse(body: string, after: string): boolean {
  if (/^\s|\s$/.test(body) || body.startsWith('{')) return true
  if (/^[A-Za-z0-9]/.test(after)) return true
  if (body.includes('`')) return true
  if (/^\d/.test(body) && !/[\\^_=+\-*/<>]/.test(body)) return true
  if (body.length > 1 && /^[A-Z]+$/.test(body)) return true
  return /^[A-Z_][A-Z0-9_]*[^A-Za-z0-9_\s]?$/.test(body) && /^[A-Za-z_]/.test(after)
}

const INLINE_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
  ['$$', '$$'],
  ['\\(', '\\)'],
  ['\\[', '\\]'],
  ['$', '$'],
]

/**
 * Inline math. Unlike Pi, an unclosed inline opener is NOT held as pending:
 * doing so swallows the rest of the paragraph as source, and in a finished
 * reply (`costs $5 + tax, **note**`) that silently drops real formatting.
 * The only cost is that a formula's interior may briefly show as markdown
 * while its closing `$` streams in.
 */
function tokenizeInlineMath(source: string): MathToken | undefined {
  const delimiter = INLINE_DELIMITERS.find(([opening]) => source.startsWith(opening))
  if (delimiter === undefined) return undefined
  const [opening, closing] = delimiter
  const closingIndex = findClosingDelimiter(source, closing, opening.length)
  if (closingIndex < 0) return undefined
  const text = source.slice(opening.length, closingIndex)
  if (text.trim() === '' || text.includes('\n')) return undefined
  if (opening.startsWith('$') && isDollarProse(text, source.slice(closingIndex + closing.length))) {
    return undefined
  }
  return { type: 'math', raw: source.slice(0, closingIndex + closing.length), text }
}

/**
 * Block math: the opener starts a line (up to three spaces of indent, like
 * any CommonMark block) and the closer ends one. An opener whose closer
 * appears later on a line with trailing text is left to the inline rule; a
 * block is pending only while no closer exists at all.
 */
const BLOCK_OPENER = /^ {0,3}(\$\$|\\\[)/

function tokenizeBlockMath(source: string): MathToken | undefined {
  const opener = BLOCK_OPENER.exec(source)
  if (opener === null) return undefined
  const dollar = opener[1] === '$$'
  const closing = dollar ? '$$' : '\\]'
  const closingIndex = findClosingDelimiter(source, closing, opener[0].length)
  if (closingIndex >= 0) {
    const end = closingIndex + closing.length
    const trailing = /^[ \t]*(?:\n|$)/.exec(source.slice(end))
    const text = source.slice(opener[0].length, closingIndex).trim()
    // The first closer decides the boundary. Looking for a later line-ending
    // closer would swallow intervening prose and the next formula.
    if (trailing === null || text === '') return undefined
    return { type: 'mathBlock', raw: source.slice(0, end + trailing[0].length), text }
  }
  const body = source.slice(opener[0].length).replace(/^[ \t]*\n?/, '')
  // An opener with nothing after it yet is held too, so a streaming block
  // does not flip from prose to a block node when its first command arrives.
  if (dollar && body.trim() !== '' && !looksLikeMath(body)) return undefined
  return { type: 'mathBlock', raw: source, text: body, pending: true }
}

/** Tokenizer extensions for `marked.use({ extensions })`. */
export const MATH_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
  {
    name: 'mathBlock',
    level: 'block',
    start(source) {
      const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source)
      return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined
    },
    tokenizer: tokenizeBlockMath,
  },
  {
    name: 'math',
    level: 'inline',
    start(source) {
      let first = -1
      for (const marker of ['$', '\\(', '\\[']) {
        const index = source.indexOf(marker)
        if (index >= 0 && (first < 0 || index < first)) first = index
      }
      return first >= 0 ? first : undefined
    },
    tokenizer: tokenizeInlineMath,
  },
]
