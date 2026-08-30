/**
 * Markdown-to-ANSI renderer over marked's token stream.
 *
 * Converts the shared marked lexer output into styled terminal text: quote
 * gutters, syntax-highlighted fenced blocks, indented list bullets with
 * depth-based numbering, and alignment-padded tables. The visual conventions
 * (▎ bars for blockquotes, theme-colored inline code, OSC 8 hyperlinks) are
 * standard terminal markdown idioms, but this is an independent
 * implementation: a single dispatch switch fans tokens out to dedicated
 * per-type render functions, and all recursive calls thread one immutable
 * RenderState (parent token, list depth, list ordinal, highlighter) instead
 * of passing positional arguments.
 */

import chalk from 'chalk'
import { marked, type MarkedToken, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { colorize } from '../ink/colorize.js'
import { getActiveTheme } from '../theme.js'
import { buildSyntaxTheme } from './syntaxTheme.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from '../utils/debug.js'
import { createHyperlink } from './hyperlink.js'
import { fileLinkUrl, linkifyFilePaths, looksLikeFilePath } from '../utils/fileTarget.js'

// '\n' is used unconditionally — os.EOL is '\r\n' on Windows, and the stray
// '\r' breaks the character-to-segment mapping in applyStylesToWrappedText,
// shifting styled text to the right.
const EOL = '\n'

/** Left one-quarter block (U+258E), the blockquote gutter marker. */
const QUOTE_BAR = '\u258e'

/** Tool-analysis tag blocks that carry no user-facing content; dropped before lexing. */
const TOOL_ANALYSIS_TAG_BLOCKS =
  /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs

/**
 * Matches `owner/repo#NNN` style GitHub issue/PR references. Only the
 * qualified form is recognized: a bare `#NNN` would guess the current
 * repository and be wrong whenever the assistant discusses a different one.
 * The owner segment excludes dots (GitHub usernames are alphanumerics plus
 * hyphens) so hostnames like docs.example.io/guide#42 don't false-positive;
 * the repo segment allows dots (e.g. cc.kurs.web). Lookbehind is avoided —
 * it defeats YARR JIT in JSC.
 */
const ISSUE_REFERENCE_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * Strip tool-analysis XML blocks (`<commit_analysis>`, `<context>`,
 * `<function_analysis>`, `<pr_analysis>`) and their contents, then trim.
 * @param content - Markdown that may wrap the tool-analysis tag blocks.
 * @returns The content with those blocks removed and whitespace trimmed.
 */
export function stripPromptXMLTags(content: string): string {
  // Every alternative in the pattern is anchored on a literal '<', so content
  // without one cannot match. Skip the regex entirely in that case: the
  // backreference defeats most of the engine's fast paths, and streaming
  // re-runs this over the whole accumulated message on every frame.
  if (!content.includes('<')) return content.trim()
  return content.replace(TOOL_ANALYSIS_TAG_BLOCKS, '').trim()
}

let markedInitialized = false

/**
 * Configure the shared `marked` instance once. Strikethrough parsing is
 * disabled so that `~100` renders literally instead of as deleted text —
 * models use `~` far more often for "approximate" than for real
 * strikethrough.
 */
export function configureMarked(): void {
  if (markedInitialized) return
  markedInitialized = true

  marked.use({
    tokenizer: {
      del() {
        return undefined
      },
    },
  })
}

/** Inline code is painted with the active theme's permission accent. */
function paintInlineCode(text: string): string {
  return colorize(text, getActiveTheme().permission, 'foreground')
}

/**
 * Inline code that reads as a file path becomes a clickable target (the
 * OSC 8 wrap keeps the code's permission color via the identity style —
 * createHyperlink's default blue would otherwise override it). Terminals
 * without OSC 8 support keep the plain painted code span.
 */
function renderCodeSpan(token: Tokens.Codespan): string {
  // Paint via the style callback so the permission color is applied AFTER
  // createHyperlink's anti-smuggle content scrub: passing the painted
  // string as content would have its ESC bytes stripped, leaving
  // `[38;2;…m` parameter text on screen.
  const paint = (text: string): string => paintInlineCode(text)
  if (!looksLikeFilePath(token.text)) return paint(token.text)
  if (!supportsHyperlinks()) return paint(token.text)
  return createHyperlink(fileLinkUrl(token.text), token.text, {
    style: paint,
  })
}

/**
 * Linkify path-like text into clickable file targets, then issue
 * references (owner/repo#123). File spans exclude `#`, so the two
 * linkifiers cannot nest or overlap. Without OSC 8 support the text stays
 * untouched (createHyperlink's URL fallback would show the raw encoded
 * `dsh-file:` payload — worse than plain text).
 */
function linkifyText(text: string): string {
  const withFiles = supportsHyperlinks()
    ? linkifyFilePaths(text, (path, display) =>
        createHyperlink(fileLinkUrl(path), display),
      )
    : text
  return linkifyIssueReferences(withFiles)
}

/**
 * Immutable rendering context threaded through the token tree.
 * `listDepth` and `ordinal` only matter inside list items; `parent` decides
 * whether issue references are linkified (inside links they must stay plain
 * to avoid nested OSC 8 sequences).
 */
interface RenderState {
  /** Syntax highlighter for code blocks; null renders them as plain text. */
  readonly highlight: CliHighlight | null
  /** The token whose children are being rendered (link / list_item). */
  readonly parent: Token | null
  /** Nesting depth of the enclosing list; drives indentation and numbering style. */
  readonly listDepth: number
  /** Ordinal of the current ordered-list item, or null for unordered lists. */
  readonly ordinal: number | null
}

/** A fresh context for block-level children: list state reset, no parent. */
function fresh(state: RenderState): RenderState {
  return { highlight: state.highlight, parent: null, listDepth: 0, ordinal: null }
}

/** Same context, different parent token. */
function withParent(state: RenderState, parent: Token | null): RenderState {
  return { ...state, parent }
}

/** Inline-styled children keep the outer parent but shed list context. */
function inlineChildren(state: RenderState): RenderState {
  return { ...state, listDepth: 0, ordinal: null }
}

/**
 * Render one marked token to ANSI text, recursing into child tokens.
 * @param token - The marked token to render.
 * @param listDepth - Nesting depth of the enclosing list; drives indentation and numbering style.
 * @param orderedListNumber - Current ordinal of the enclosing ordered list item, or null for unordered lists.
 * @param parent - The parent token; linkification is skipped inside links and prefixes are added inside list items.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string for the token, or '' for unrendered token types.
 */
export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  return dispatch(token, { highlight, parent, listDepth, ordinal: orderedListNumber })
}

/**
 * Render markdown content to ANSI-styled text via the shared `marked` instance.
 * @param content - Markdown source to render.
 * @param highlight - Optional cli-highlight surface for code blocks; null disables syntax highlighting.
 * @returns The rendered ANSI string, trimmed.
 */
export function applyMarkdown(
  content: string,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  const rootState: RenderState = {
    highlight,
    parent: null,
    listDepth: 0,
    ordinal: null,
  }
  return marked
    .lexer(stripPromptXMLTags(content))
    .map(token => dispatch(token, rootState))
    .join('')
    // trimEnd only: the input is already trimmed, so leading whitespace in
    // the output is renderer-intended (e.g. the code block's 2-space indent
    // on its first line). A full trim() would eat that first-line indent.
    .trimEnd()
}

/**
 * Type guard that narrows to the concrete marked token of `kind`.
 * Plain `switch` narrowing fails here: Tokens.Generic declares `type: string`,
 * so every case keeps Generic in the union. Guarding against MarkedToken
 * (which excludes Generic) yields exact types for the per-type renderers.
 */
function isToken<K extends MarkedToken['type']>(
  token: Token,
  kind: K,
): token is Extract<MarkedToken, { type: K }> {
  return token.type === kind
}

/** Fan-out point: narrows the token union, then delegates to the per-type render functions. */
function dispatch(token: Token, state: RenderState): string {
  if (isToken(token, 'blockquote')) return renderBlockquote(token, state)
  if (isToken(token, 'code')) return renderCodeBlock(token, state)
  if (isToken(token, 'codespan')) return renderCodeSpan(token)
  if (isToken(token, 'em')) return renderEmphasis(token, state)
  if (isToken(token, 'strong')) return renderStrong(token, state)
  if (isToken(token, 'heading')) return renderHeading(token, state)
  if (isToken(token, 'hr')) return '---'
  if (isToken(token, 'image')) return token.href
  if (isToken(token, 'link')) return renderLink(token, state)
  if (isToken(token, 'list')) return renderList(token, state)
  if (isToken(token, 'list_item')) return renderListItem(token, state)
  if (isToken(token, 'paragraph')) return renderParagraph(token, state)
  if (isToken(token, 'space') || isToken(token, 'br')) return EOL
  if (isToken(token, 'text')) return renderText(token, state)
  if (isToken(token, 'table')) return renderTable(token, state)
  if (isToken(token, 'escape')) return token.text
  if (isToken(token, 'def') || isToken(token, 'del') || isToken(token, 'html')) {
    // Link definitions, strikethrough, and raw HTML carry no ANSI
    // representation.
    return ''
  }
  // Unknown / extension token types render as nothing.
  return ''
}

function renderBlockquote(token: Tokens.Blockquote, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, fresh(state))).join('')
  // Dim gutter bar per line; keep the text italic but at normal brightness —
  // chalk.dim is nearly invisible on dark themes.
  const gutter = chalk.dim(QUOTE_BAR)
  return inner
    .split(EOL)
    .map(line => (stripAnsi(line).trim() ? `${gutter} ${chalk.italic(line)}` : line))
    .join(EOL)
}

function renderCodeBlock(token: Tokens.Code, state: RenderState): string {
  // Kimi Code style: a muted ```lang opening line (language tag + boundary
  // for unhighlighted blocks) + 2-space indent; no closing fence (syntax
  // colors or the indent already mark the end, it only cost vertical space).
  const theme = getActiveTheme()
  const openFence = colorize('```' + (token.lang ?? ''), theme.subtle, 'foreground')
  const indent = '  '
  const renderBody = (): string => {
    if (!state.highlight) {
      return token.text
    }
    let language = 'plaintext'
    if (token.lang) {
      if (state.highlight.supportsLanguage(token.lang)) {
        language = token.lang
      } else {
        logForDebugging(
          `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
        )
      }
    }
    return state.highlight.highlight(token.text, { language, theme: buildSyntaxTheme(theme) })
  }
  // Strip ALL trailing newlines: trailing blank lines would otherwise leak a
  // stray blank line at the end of the block.
  const body = renderBody().replace(/\n+$/, '')
  if (body === '') {
    return `${openFence}${EOL}`
  }
  return (
    openFence +
    EOL +
    body
      .split(EOL)
      .map(line => (line === '' ? line : indent + line))
      .join(EOL) + EOL
  )
}

function renderEmphasis(token: Tokens.Em, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.italic(inner)
}

function renderStrong(token: Tokens.Strong, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.bold(inner)
}

function renderHeading(token: Tokens.Heading, state: RenderState): string {
  const text = token.tokens.map(child => dispatch(child, fresh(state))).join('')
  // Blue-primary progression: H1 gets the mist brand blue + underline, H2 the
  // lighter border blue, deeper levels stay bold near-text (kimi-style).
  const theme = getActiveTheme()
  const styled =
    token.depth === 1
      ? chalk.bold.underline(colorize(text, theme.claude, 'foreground'))
      : token.depth === 2
        ? chalk.bold(colorize(text, theme.permission, 'foreground'))
        : chalk.bold(text)
  return styled + EOL + EOL
}

function renderLink(token: Tokens.Link, state: RenderState): string {
  // mailto: links are shown as plain email addresses, not clickable links.
  if (token.href.startsWith('mailto:')) {
    return token.href.slice('mailto:'.length)
  }
  const label = token.tokens
    .map(child => dispatch(child, withParent(fresh(state), token)))
    .join('')
  const plainLabel = stripAnsi(label)
  // Meaningful display text (different from the URL) becomes a clickable
  // hyperlink; otherwise just show the URL.
  if (plainLabel && plainLabel !== token.href) {
    return createHyperlink(token.href, label)
  }
  return createHyperlink(token.href)
}

function renderList(token: Tokens.List, state: RenderState): string {
  // ordered lists always carry a numeric start ("" only occurs for unordered),
  // but the type says otherwise, so coerce defensively.
  const start = typeof token.start === 'number' ? token.start : 1
  return token.items
    .map((item, index) => {
      const ordinal = token.ordered ? start + index : null
      return dispatch(item, { ...state, ordinal })
    })
    .join('')
}

function renderListItem(token: Tokens.ListItem, state: RenderState): string {
  const indent = '  '.repeat(state.listDepth)
  const childState = withParent(
    { ...state, listDepth: state.listDepth + 1 },
    token,
  )
  return token.tokens.map(child => indent + dispatch(child, childState)).join('')
}

function renderParagraph(token: Tokens.Paragraph, state: RenderState): string {
  return token.tokens.map(child => dispatch(child, fresh(state))).join('') + EOL
}

function renderText(token: Tokens.Text, state: RenderState): string {
  const { parent, listDepth, ordinal } = state

  if (parent?.type === 'link') {
    // Already inside a link: the link handler wraps everything in one OSC 8
    // sequence, and a nested one would override the real href. Stay plain.
    return token.text
  }

  if (parent?.type === 'list_item') {
    const bullet = ordinal === null ? '-' : `${formatListMarker(listDepth, ordinal)}.`
    const body = token.tokens
      ? token.tokens.map(child => dispatch(child, withParent(state, token))).join('')
      : linkifyText(token.text)
    // Blue bullet marker: list structure gets a tint without loading the
    // whole item (kimi-style `•` in the accent color).
    const tinted = colorize(bullet, getActiveTheme().permission, 'foreground')
    return `${tinted} ${body}${EOL}`
  }

  return linkifyText(token.text)
}

function renderTable(token: Tokens.Table, state: RenderState): string {
  const rows = [token.header, ...token.rows]

  // Column widths derive from the visible (ANSI-stripped) cell text; 3 is
  // the minimum so a separator row always reads as a table divider.
  const columnWidths = token.header.map((_, colIndex) => {
    let widest = 3
    for (const row of rows) {
      widest = Math.max(widest, stringWidth(cellDisplayText(row[colIndex], state)))
    }
    return widest
  })

  const headerLine = renderTableRow(token.header, columnWidths, token.align, state)
  // Dashes only — alignment colons are not echoed into the output.
  const divider = `|${columnWidths.map(width => `${'-'.repeat(width + 2)}|`).join('')}${EOL}`
  const bodyLines = token.rows
    .map(row => renderTableRow(row, columnWidths, token.align, state))
    .join('')
  return headerLine + divider + bodyLines + EOL
}

/** Rendered cell content, stripped of ANSI codes, for width measurement. */
function cellDisplayText(cell: Tokens.TableCell, state: RenderState): string {
  return stripAnsi(
    cell.tokens.map(child => dispatch(child, fresh(state))).join(''),
  )
}

function renderTableRow(
  cells: Tokens.TableCell[],
  columnWidths: number[],
  aligns: Tokens.Table['align'],
  state: RenderState,
): string {
  let line = '| '
  cells.forEach((cell, index) => {
    const content = cell.tokens.map(child => dispatch(child, fresh(state))).join('')
    line +=
      padAligned(
        content,
        stringWidth(cellDisplayText(cell, state)),
        columnWidths[index],
        aligns[index],
      ) + ' | '
  })
  return line.trimEnd() + EOL
}

/**
 * Replace `owner/repo#123` references with clickable GitHub links.
 * No-op when the terminal lacks OSC 8 hyperlink support.
 */
function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REFERENCE_PATTERN,
    (_match, prefix, repo, issueNumber) =>
      prefix +
      createHyperlink(
        `https://github.com/${repo}/issues/${issueNumber}`,
        `${repo}#${issueNumber}`,
      ),
  )
}

/**
 * Ordered-list marker for a given nesting depth: decimal at depth 1,
 * letters at depth 2, roman numerals at depth 3, decimal beyond.
 */
function formatListMarker(listDepth: number, ordinal: number): string {
  switch (listDepth) {
    case 2:
      return toAlphaIndex(ordinal)
    case 3:
      return toRomanNumeral(ordinal)
    default:
      return ordinal.toString()
  }
}

/** Bijective base-26 conversion: 1 → a, 26 → z, 27 → aa. */
function toAlphaIndex(n: number): string {
  if (n <= 0) return ''
  const digit = String.fromCharCode(97 + ((n - 1) % 26))
  return toAlphaIndex(Math.floor((n - 1) / 26)) + digit
}

/** Standard greedy roman-numeral symbol table (lowercase). */
const ROMAN_SYMBOLS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function toRomanNumeral(n: number): string {
  let out = ''
  for (const [value, glyph] of ROMAN_SYMBOLS) {
    while (n >= value) {
      out += glyph
      n -= value
    }
  }
  return out
}

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is
 * the visible width of `content` (callers compute it via stringWidth on the
 * ANSI-stripped text, so embedded escape codes don't affect padding).
 * @param content - The text to pad, which may carry ANSI codes.
 * @param displayWidth - Visible width of `content` without ANSI codes.
 * @param targetWidth - Column width to pad `content` to.
 * @param align - Alignment: 'left', 'center', 'right', or null/undefined for left.
 * @returns `content` padded with spaces to `targetWidth`.
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const extra = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const left = Math.floor(extra / 2)
    return ' '.repeat(left) + content + ' '.repeat(extra - left)
  }
  if (align === 'right') {
    return ' '.repeat(extra) + content
  }
  return content + ' '.repeat(extra)
}
