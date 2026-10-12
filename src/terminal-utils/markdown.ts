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
import { getMathRendering } from '../tuiDisplayPrefs.js'
import { noteCodeHighlight, noteFormatToken } from '../ink/render-stats.js'
import { CJK_EMPHASIS_EXTENSIONS } from './cjk-emphasis.js'
import {
  isMathBlockToken,
  isMathToken,
  MATH_MARKDOWN_EXTENSIONS,
  renderInlineMath,
  type MathToken,
} from './math.js'

// '\n' is used unconditionally — os.EOL is '\r\n' on Windows, and the stray
// '\r' breaks the character-to-segment mapping in applyStylesToWrappedText,
// shifting styled text to the right.
const EOL = '\n'

/** Left one-quarter block (U+258E), the blockquote gutter marker. */
const QUOTE_BAR = '\u258e'

/** Left one-eighth block (U+258F): quote levels past the second get the thinner bar. */
const QUOTE_BAR_DEEP = '\u258f'

/** The horizontal-rule divider: three light box-drawing dashes. */
const HR_DIVIDER = '\u2500\u2500\u2500'

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
 * Configure the shared `marked` instance once. Strikethrough stays on
 * marked's built-in del tokenizer, which only matches double-tilde pairs —
 * single tildes (`~100`, models' "approximate") never pair up and render
 * literally. LaTeX math becomes `math`/`mathBlock` tokens (see math.ts),
 * and CJK-adjacent strong emphasis (`**标签：**中文`, unclosable under
 * CommonMark's flanking rule) closes via cjk-emphasis.ts.
 * Every lexer caller — Markdown and StreamingMarkdown's boundary
 * lex — must run this first so both agree on block boundaries.
 */
export function configureMarked(): void {
  if (markedInitialized) return
  markedInitialized = true

  marked.use({
    // Math first: a $…$ body holding emphasis-looking ** stays a formula;
    // the CJK strong pass only sees what math declined.
    extensions: [...MATH_MARKDOWN_EXTENSIONS, ...CJK_EMPHASIS_EXTENSIONS],
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
  /** Nesting depth of the enclosing blockquote; deeper levels get a more muted bar. */
  readonly quoteDepth: number
  /**
   * Absolute column where the enclosing list item's body block starts
   * (indent + marker + checkbox). Soft-break continuations and nested
   * blocks align there, and a nested list's items inherit it as their
   * indent so the ladder advances by one marker width per level.
   */
  readonly hang: number
}

/** A fresh context for block-level children: list state reset, no parent. */
function fresh(state: RenderState): RenderState {
  return { highlight: state.highlight, parent: null, listDepth: 0, ordinal: null, quoteDepth: 0, hang: 0 }
}

/** Same context, different parent token. */
function withParent(state: RenderState, parent: Token | null): RenderState {
  return { ...state, parent }
}

/** Inline-styled children keep the outer parent but shed list context. */
function inlineChildren(state: RenderState): RenderState {
  return { ...state, listDepth: 0, ordinal: null, quoteDepth: 0, hang: 0 }
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
  return dispatch(token, {
    highlight,
    parent,
    listDepth,
    ordinal: orderedListNumber,
    quoteDepth: 0,
    hang: 0,
  })
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
    quoteDepth: 0,
    hang: 0,
  }
  return marked
    .lexer(stripPromptXMLTags(content))
    .reduce((out: string, token: Token) => appendBlockText(out, dispatch(token, rootState)), '')
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
  noteFormatToken(token.raw ?? '')
  if (isToken(token, 'blockquote')) return renderBlockquote(token, state)
  if (isToken(token, 'checkbox')) return renderCheckbox(token)
  if (isToken(token, 'code')) return renderCodeBlock(token, state)
  if (isToken(token, 'codespan')) return renderCodeSpan(token)
  if (isToken(token, 'em')) return renderEmphasis(token, state)
  if (isToken(token, 'strong')) return renderStrong(token, state)
  if (isToken(token, 'del')) return renderDel(token, state)
  if (isToken(token, 'heading')) return renderHeading(token, state)
  if (isToken(token, 'hr')) return renderHr()
  if (isToken(token, 'image')) return renderImage(token, state)
  if (isToken(token, 'link')) return renderLink(token, state)
  if (isToken(token, 'list')) return renderList(token, state)
  if (isToken(token, 'list_item')) return renderListItem(token, state)
  if (isToken(token, 'paragraph')) return renderParagraph(token, state)
  if (isToken(token, 'space') || isToken(token, 'br')) return EOL
  if (isToken(token, 'text')) return renderText(token, state)
  if (isToken(token, 'table')) return renderTable(token, state)
  if (isToken(token, 'escape')) return token.text
  if (isMathToken(token)) return renderInlineMathToken(token)
  // Top-level math blocks are standalone MathBlock nodes; this path only
  // sees blocks nested in list items / blockquotes (or formatToken callers).
  if (isMathBlockToken(token)) return renderNestedMathBlock(token)
  if (isToken(token, 'def') || isToken(token, 'html')) {
    // Link definitions and raw HTML carry no ANSI representation.
    return ''
  }
  // Unknown token types (a marked upgrade or extension) echo their raw
  // source instead of silently dropping it; verify-markdown-token-coverage
  // fails until the type gets a renderer or an explicit ignore.
  logForDebugging(`Markdown token without a renderer, echoing raw source: ${token.type}`)
  return (token as { raw?: string }).raw ?? ''
}

/** Inline math as single-line Unicode; the exact source when it has none
 *  or rendering is switched off. */
function renderInlineMathToken(token: MathToken): string {
  return (getMathRendering() !== 'source' ? renderInlineMath(token.text) : undefined) ?? token.raw
}

/**
 * A math block inside a list item or blockquote has no width of its own to
 * lay out a 2D formula against (and would be cut by the container prefix),
 * so it gets the single-line form, else its source.
 */
function renderNestedMathBlock(token: MathToken): string {
  const rendered = getMathRendering() !== 'source' && !token.pending ? renderInlineMath(token.text) : undefined
  return (rendered ?? token.raw.trim()) + EOL
}

/**
 * The gutter for one blockquote level: the first level in the theme's
 * muted color, the second dimmed, deeper levels the thinner one-eighth
 * bar, so nesting fades instead of repeating identical rails.
 */
function quoteGutter(depth: number): string {
  if (depth === 0) return colorize(QUOTE_BAR, getActiveTheme().subtle, 'foreground')
  if (depth === 1) return chalk.dim(QUOTE_BAR)
  return chalk.dim(QUOTE_BAR_DEEP)
}

function renderBlockquote(token: Tokens.Blockquote, state: RenderState): string {
  const depth = state.quoteDepth
  // Children keep the quote context (a nested blockquote increments the
  // depth) but shed list state, exactly like fresh().
  const childState = { ...fresh(state), quoteDepth: depth + 1 }
  const inner = token.tokens.map(child => dispatch(child, childState)).join('')
  // Gutter bar per line; keep the text italic but at normal brightness —
  // chalk.dim is nearly invisible on dark themes. Blank lines inside the
  // quote keep a bare gutter so the quote stays visible across paragraph
  // gaps; only the empty piece after inner's final newline stays empty.
  const gutter = quoteGutter(depth)
  const lines = inner.split(EOL)
  // An empty quote (`>` on its own line) still shows one rail.
  if (lines.every(line => line === '')) return gutter + EOL
  return lines
    .map((line, index) => {
      if (line === '' || stripAnsi(line).trim() === '') {
        return index === lines.length - 1 ? line : gutter
      }
      return `${gutter} ${chalk.italic(line)}`
    })
    .join(EOL)
}

function renderCodeBlock(token: Tokens.Code, state: RenderState): string {
  // Kimi Code style: a muted ```lang opening line (language tag + boundary
  // for unhighlighted blocks) + 2-space indent; no closing fence (syntax
  // colors or the indent already mark the end, it only cost vertical space).
  // This ANSI form serves nested code (inside lists/quotes) and the narrow
  // fallback of CodeBlockFrame; top-level fences render through the frame
  // component sharing formatCodeBody below.
  const theme = getActiveTheme()
  const openFence = colorize('```' + codeLanguageTag(token), theme.subtle, 'foreground')
  const indent = '  '
  const body = formatCodeBody(token, state.highlight)
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

/**
 * The fence info string trimmed to its first word: a fence opening with
 * "js meta" names js. Everything after the first whitespace run is meta
 * the renderer never consumes; the full source stays in token.text.
 */
export function codeLanguageTag(token: Tokens.Code): string {
  return (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * Highlighted (or plain) body of a fenced code block, with trailing blank
 * lines stripped. Shared by the ANSI fence and CodeBlockFrame so both
 * surfaces agree on highlighting, language resolution and trimming.
 *
 * NEVER throws: cli-highlight feeds highlight.js, which converts to HTML
 * fragments and can raise synchronously on hostile inputs. Any failure in
 * the highlighting pipeline degrades to the plain body - the fence and
 * language label survive - instead of unwinding the React render that
 * called it.
 */
export function formatCodeBody(token: Tokens.Code, highlight: CliHighlight | null): string {
  const plain = token.text.replace(/\n+$/, '')
  if (!highlight || plain === '') return plain
  try {
    let language = 'plaintext'
    const tag = codeLanguageTag(token)
    if (tag) {
      if (highlight.supportsLanguage(tag)) {
        language = tag
      } else {
        logForDebugging(
          `Language not supported while highlighting code, falling back to plaintext: ${tag}`,
        )
      }
    }
    const theme = getActiveTheme()
    noteCodeHighlight()
    const highlighted = highlight.highlight(token.text, { language, theme: buildSyntaxTheme(theme) })
    // Strip ALL trailing newlines: trailing blank lines would otherwise leak
    // a stray blank line at the end of the block.
    return highlighted.replace(/\n+$/, '') || plain
  } catch (error) {
    logForDebugging(
      `Code highlighting threw, degrading the block to plaintext: ${String(error)}`,
    )
    return plain
  }
}

function renderEmphasis(token: Tokens.Em, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.italic(inner)
}

function renderStrong(token: Tokens.Strong, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.bold(inner)
}

/** Double-tilde strikethrough; marked's del tokenizer never pairs single
 *  tildes, so approximate notation like ~100 stays literal. */
function renderDel(token: Tokens.Del, state: RenderState): string {
  const inner = token.tokens.map(child => dispatch(child, inlineChildren(state))).join('')
  return chalk.strikethrough(inner)
}

/**
 * The hr divider: three dashes in the theme's muted color.
 *
 * No trailing newline: the surrounding space tokens already separate the
 * blocks, so the divider costs one row. appendBlockText adds the row
 * break when the next block does not start with one.
 */
function renderHr(): string {
  return colorize(HR_DIVIDER, getActiveTheme().subtle, 'foreground')
}

/**
 * Append one block token's rendered text to the accumulated run. Every
 * visible block renderer ends its output with a newline except the hr
 * divider; when such an unterminated block is followed directly by
 * content that does not open with its own line break (a rule
 * immediately before a heading, or two adjacent rules), the row break
 * is inserted here so the divider never merges into the next block's
 * first row.
 */
export function appendBlockText(accumulated: string, block: string): string {
  if (accumulated !== '' && !accumulated.endsWith(EOL) && block !== '' && !block.startsWith(EOL)) {
    return accumulated + EOL + block
  }
  return accumulated + block
}

function renderHeading(token: Tokens.Heading, state: RenderState): string {
  const text = token.tokens.map(child => dispatch(child, fresh(state))).join('')
  // Blue-primary ladder (kimi-style): H1 gets the mist brand blue +
  // underline, H2 the lighter border blue, then H3 bold, H4 bold italic,
  // H5 italic subtle and H6 subtle, so each level reads one step quieter.
  const theme = getActiveTheme()
  const styled =
    token.depth === 1
      ? chalk.bold.underline(colorize(text, theme.accent, 'foreground'))
      : token.depth === 2
        ? chalk.bold(colorize(text, theme.permission, 'foreground'))
        : token.depth === 3
          ? chalk.bold(text)
          : token.depth === 4
            ? chalk.bold.italic(text)
            : token.depth === 5
              ? chalk.italic(colorize(text, theme.subtle, 'foreground'))
              : colorize(text, theme.subtle, 'foreground')
  // One trailing newline: blank rows below a heading come from the
  // source's own blank lines (the following space token), not from here.
  return styled + EOL
}

/**
 * Image reference: `[img]` plus the alt text, linked to the source URL
 * with OSC 8. Nothing is fetched; the href is only a click target.
 * Without hyperlink support the plain form shows both the alt and the URL.
 */
function renderImage(token: Tokens.Image, state: RenderState): string {
  const alt = token.text.replace(/\s+/g, ' ').trim()
  if (state.parent?.type === 'link') {
    // Inside a link's OSC 8 wrap a nested sequence would override the real
    // href; show the alt (or the URL) as plain text, like nested labels.
    return alt || token.href
  }
  if (!supportsHyperlinks()) {
    return alt ? `[img] ${alt} (${token.href})` : token.href
  }
  return createHyperlink(token.href, alt ? `[img] ${alt}` : '[img]')
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
  // Tight task items carry their checkbox as a sibling token AHEAD of the
  // text token (loose items inline it inside the paragraph). Lift it out
  // here so it lands between the marker and the body.
  const isTightTask = token.task === true && token.tokens[0]?.type === 'checkbox'
  const children = isTightTask ? token.tokens.slice(1) : token.tokens
  const taskMark = isTightTask ? renderCheckbox(token.tokens[0] as Tokens.Checkbox) : ''
  const indent = ' '.repeat(state.hang)
  const marker =
    state.ordinal === null ? '-' : `${formatListMarker(state.listDepth + 1, state.ordinal)}.`
  // The body column: soft-break continuations, later paragraphs of loose
  // items, and nested blocks align one marker width (plus checkbox) past
  // this item's indent. A nested list gets this as its indent, so each
  // level steps in by one marker width.
  const bodyHang = state.hang + marker.length + 1 + stripAnsi(taskMark).length
  const childState = withParent(
    { ...state, listDepth: state.listDepth + 1, hang: bodyHang },
    token,
  )
  // Text/paragraph/blockquote children render unindented lines and the
  // assembly below pads their continuations to the body column. A nested
  // list already carries its absolute indent (its items inherit
  // bodyHang), so its lines pass through untouched.
  const segments: Array<{ text: string; preindented: boolean }> = []
  let raw = ''
  for (const child of children) {
    const part = dispatch(child, childState)
    if (child.type === 'list') {
      if (raw !== '') {
        segments.push({ text: raw, preindented: false })
        raw = ''
      }
      segments.push({ text: part, preindented: true })
    } else {
      // appendBlockText: a text token does not end its own row, and the
      // next child must start on a fresh line (a plain join would glue
      // blocks together, a join(EOL) would double blank rows).
      raw = appendBlockText(raw, part)
    }
  }
  if (raw !== '') segments.push({ text: raw, preindented: false })
  const tinted = colorize(marker, getActiveTheme().permission, 'foreground')
  const bodyIndent = ' '.repeat(bodyHang)
  let out = `${indent}${tinted} ${taskMark}`
  let firstLine = true
  for (const segment of segments) {
    const lines = segment.text.split(EOL)
    for (const line of lines) {
      if (firstLine) {
        out += line
        firstLine = false
        continue
      }
      out += EOL + (line === '' || segment.preindented ? line : bodyIndent + line)
    }
  }
  if (out === '') return ''
  if (!out.endsWith(EOL)) out += EOL
  return out
}

/**
 * Task checkbox as width-safe ASCII: literal [x] / [ ] keeps its state
 * through display, copy, and ANSI-stripping measurements alike; a styled
 * glyph pair would not survive every terminal font. The trailing space is
 * the separator to the item text.
 */
function renderCheckbox(token: Tokens.Checkbox): string {
  const mark = token.checked ? '[x]' : '[ ]'
  const color = token.checked ? getActiveTheme().success : getActiveTheme().subtle
  return colorize(mark, color, 'foreground') + ' '
}

function renderParagraph(token: Tokens.Paragraph, state: RenderState): string {
  return token.tokens.map(child => dispatch(child, fresh(state))).join('') + EOL
}

function renderText(token: Tokens.Text, state: RenderState): string {
  if (state.parent?.type === 'link') {
    // Already inside a link: the link handler wraps everything in one OSC 8
    // sequence, and a nested one would override the real href. Stay plain.
    return token.text
  }

  // List markers, checkboxes and indentation belong to renderListItem:
  // a loose item's paragraph reaches here with a fresh state, and inline
  // em/strong children recurse through here with the list_item parent.
  if (token.tokens) {
    return token.tokens.map(child => dispatch(child, withParent(state, token))).join('')
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
