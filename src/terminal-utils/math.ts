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
 * opener starts a line and the closer ends one, inline otherwise; a line
 * opening a display environment (`\begin{align}` …) is a block too. The `$`
 * rules follow Pi's markdown tokenizer and Codex's TUI math scanner so that
 * prices, shell variables and PIDs stay prose.
 */

import type { TokenizerExtension, Tokens } from 'marked'
import { renderLatex } from './latex.js'

/** Which delimiter introduced a formula. */
export type MathDelimiter = 'dollar' | 'double-dollar' | 'paren' | 'bracket' | 'environment'

/** A recognized formula. `text` is the TeX between the delimiters (for an
 *  environment, the whole `\begin…\end`), `raw` the full source span. */
export interface MathToken extends Tokens.Generic {
  type: 'math' | 'mathBlock'
  raw: string
  text: string
  /** TeX display style (`$$`, `\[…\]`, environments) — how it typesets. */
  display: boolean
  /** Owns its Markdown lines (a `mathBlock`) — how it lays out. `foo $$x$$
   *  bar` is display but not standalone. */
  standalone: boolean
  delimiter: MathDelimiter
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

const INLINE_DELIMITERS: ReadonlyArray<readonly [string, string, MathDelimiter]> = [
  ['$$', '$$', 'double-dollar'],
  ['\\(', '\\)', 'paren'],
  ['\\[', '\\]', 'bracket'],
  ['$', '$', 'dollar'],
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
  const [opening, closing, kind] = delimiter
  const closingIndex = findClosingDelimiter(source, closing, opening.length)
  if (closingIndex < 0) return undefined
  const text = source.slice(opening.length, closingIndex)
  if (text.trim() === '' || text.includes('\n')) return undefined
  if (opening.startsWith('$') && isDollarProse(text, source.slice(closingIndex + closing.length))) {
    return undefined
  }
  return {
    type: 'math',
    raw: source.slice(0, closingIndex + closing.length),
    text,
    display: kind === 'double-dollar' || kind === 'bracket',
    standalone: false,
    delimiter: kind,
  }
}

/**
 * Block math: the opener starts a line (up to three spaces of indent, like
 * any CommonMark block) and the closer ends one. An opener whose closer
 * appears later on a line with trailing text is left to the inline rule; a
 * block is pending only while no closer exists at all.
 */
const BLOCK_OPENER = /^ {0,3}(\$\$|\\\[)/

/**
 * Display environments models write without `$$` around them. Their bodies
 * carry `\\` row breaks and `&` alignment that Markdown would otherwise
 * mangle into prose, so a line opening one starts a block like `$$` does.
 */
const ENVIRONMENT_OPENER =
  /^ {0,3}\\begin\{((?:equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|aligned|gathered)\*?)\}/

function tokenizeEnvironmentBlock(source: string, opener: RegExpExecArray): MathToken | undefined {
  const name = opener[1]!
  const begin = `\\begin{${name}}`
  const end = `\\end{${name}}`
  let depth = 0
  let index = opener[0].length - begin.length
  while (index < source.length) {
    const nextBegin = source.indexOf(begin, index)
    const nextEnd = source.indexOf(end, index)
    if (nextEnd < 0) break
    if (nextBegin >= 0 && nextBegin < nextEnd) {
      depth += 1
      index = nextBegin + begin.length
      continue
    }
    depth -= 1
    index = nextEnd + end.length
    if (depth > 0) continue
    const trailing = /^[ \t]*(?:\n|$)/.exec(source.slice(index))
    // Prose after the closing \end on the same line: not a block of its own.
    if (trailing === null) return undefined
    const raw = source.slice(0, index + trailing[0].length)
    return { type: 'mathBlock', raw, text: raw.trim(), display: true, standalone: true, delimiter: 'environment' }
  }
  // No closing \end yet: a formula in progress (or never closed) stays source.
  return { type: 'mathBlock', raw: source, text: source.trim(), display: true, standalone: true, delimiter: 'environment', pending: true }
}

/**
 * The source the block tokenizer last saw. marked tries block extensions at
 * each block position before cutting a paragraph, then calls `start` with
 * that same source minus its first character; `start` needs the whole
 * paragraph (its first character may open a code span).
 */
let lastBlockSource = ''

function tokenizeBlockMath(source: string): MathToken | undefined {
  lastBlockSource = source
  const environment = ENVIRONMENT_OPENER.exec(source)
  if (environment !== null) return tokenizeEnvironmentBlock(source, environment)
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
    return {
      type: 'mathBlock',
      raw: source.slice(0, end + trailing[0].length),
      text,
      display: true,
      standalone: true,
      delimiter: dollar ? 'double-dollar' : 'bracket',
    }
  }
  const body = source.slice(opener[0].length).replace(/^[ \t]*\n?/, '')
  // An opener with nothing after it yet is held too, so a streaming block
  // does not flip from prose to a block node when its first command arrives.
  if (dollar && body.trim() !== '' && !looksLikeMath(body)) return undefined
  return {
    type: 'mathBlock',
    raw: source,
    text: body,
    display: true,
    standalone: true,
    delimiter: dollar ? 'double-dollar' : 'bracket',
    pending: true,
  }
}

/**
 * Backtick runs that can act as CommonMark code-span delimiters, in order.
 * A run preceded by an odd number of backslashes is escaped and stays literal
 * text, so it neither opens nor closes a span.
 */
function backtickRuns(text: string): string[] {
  const runs: string[] = []
  for (const match of text.matchAll(/`+/g)) {
    const start = match.index
    let backslashes = 0
    while (start - backslashes - 1 >= 0 && text[start - backslashes - 1] === '\\') backslashes++
    if (backslashes % 2 === 0) runs.push(match[0])
  }
  return runs
}

/**
 * Lengths of the backtick runs in `text` that no later run of the same
 * length closes (CommonMark: such a run is literal text, for now).
 */
function unmatchedBacktickRuns(text: string): number[] {
  const runs = backtickRuns(text)
  const unmatched: number[] = []
  for (let open = 0; open < runs.length; open++) {
    let close = open + 1
    while (close < runs.length && runs[close]!.length !== runs[open]!.length) close++
    if (close < runs.length) open = close
    else unmatched.push(runs[open]!.length)
  }
  return unmatched
}

/**
 * Whether position `at` of `text` (a candidate block opener) lies inside a
 * code span: a backtick run opens a span only when a run of exactly the same
 * length closes it later in the same paragraph (CommonMark); a run with no
 * closer is literal text and opens nothing.
 */
function insideOpenCodeSpan(text: string, at: number): boolean {
  const paragraphStart = text.lastIndexOf('\n\n', at)
  const before = text.slice(paragraphStart < 0 ? 0 : paragraphStart + 2, at)
  const open = unmatchedBacktickRuns(before)
  if (open.length === 0) return false
  const rest = text.slice(at)
  const paragraphEnd = rest.search(/\n[ \t]*\n/)
  const after = paragraphEnd < 0 ? rest : rest.slice(0, paragraphEnd)
  const closers = new Set(backtickRuns(after).map(run => run.length))
  return open.some(length => closers.has(length))
}

/**
 * Whether a block formula lexed right after `paragraph` is still provisional
 * in a streaming reply: the paragraph leaves a backtick run open, and no
 * blank line in `following` (the source after the paragraph) has ended it
 * yet, so a closer may still arrive and turn the paragraph, the formula and
 * the text up to the closer into one code span. A streaming renderer must
 * not seal the paragraph until this is false.
 */
export function mayBecomeCodeSpan(paragraph: string, following: string): boolean {
  if (/\n[ \t]*\n\s*$/.test(paragraph)) return false
  const paragraphStart = paragraph.lastIndexOf('\n\n')
  if (unmatchedBacktickRuns(paragraphStart < 0 ? paragraph : paragraph.slice(paragraphStart + 2)).length === 0) return false
  return !/\n[ \t]*\n/.test(following)
}

/** Tokenizer extensions for `marked.use({ extensions })`. */
export const MATH_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
  {
    name: 'mathBlock',
    level: 'block',
    start(source) {
      // Same block position: exactly one character longer (a full string
      // comparison here would cost O(remaining text) per paragraph).
      const paragraph = lastBlockSource.length === source.length + 1 ? lastBlockSource : source
      const offset = paragraph.length - source.length
      const opener = /(?:^|\n) {0,3}(?:\$\$|\\\[|\\begin\{)/g
      for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
        const index = match.index + (match[0].startsWith('\n') ? 1 : 0)
        // A code span may run across lines; a block opener inside one is
        // code, and cutting the paragraph there would split the span.
        if (!insideOpenCodeSpan(paragraph, index + offset)) return index
      }
      return undefined
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
