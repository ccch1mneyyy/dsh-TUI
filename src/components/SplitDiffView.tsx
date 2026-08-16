import React from 'react'
import { Box, Text } from '../ui.js'
import * as JsDiff from 'diff'
import chalk from 'chalk'
import { extname } from 'node:path'
import type { ToolFileDiff } from '../dsh-adapter/channel.js'
import type { Color } from '../ink/styles.js'
import { getCliHighlightPromise, type CliHighlight } from '../cc/cliHighlight.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'

/**
 * Side-by-side (two-pane) diff view for Edit/Write tool cards.
 *
 * The structured ToolFileDiff hunks (oldText/newText) are re-aligned with
 * jsdiff: unchanged lines render on both panes, del-only rows fill the left
 * (old) pane, add-only rows fill the right (new) pane, and a del+add pair
 * adjacent in the diff becomes a changed-line pair with word-level
 * highlights. Row backgrounds use the dimmed palette, changed words the
 * bright word palette — same six tokens the unified view already consumes.
 *
 * On top of the diff semantics, code is syntax-highlighted with
 * cli-highlight (language from the file extension): syntax colors come from
 * the theme's syntax* tokens, so user themes (`~/.dsh-tui/themes/*.json`)
 * restyle both the diff furniture and the code. Changed words always win
 * over syntax colors — diff semantics outrank decoration.
 *
 * One source line = one terminal row (truncate, never wrap): the two panes
 * must stay row-aligned, and a wrapped long line would tear the pairing.
 * Tabs become 3 spaces so column math holds.
 */

/** One styled run inside a pane line. */
interface Segment {
  readonly text: string
  /** Word-level diff change: renders in the bright word palette, bold. */
  readonly changed: boolean
  /** Syntax color (raw theme value); undefined = default text color. */
  readonly color?: string
}

/** One aligned row across the two panes. */
interface DiffRow {
  readonly old?: { readonly lineNo: number; readonly segments: readonly Segment[] }
  readonly new?: { readonly lineNo: number; readonly segments: readonly Segment[] }
  readonly kind: 'context' | 'del' | 'add' | 'change'
}

/** Replace tabs so width math and alignment hold (pi convention). */
const expandTabs = (text: string): string => text.replaceAll('\t', '   ')

// --- syntax highlighting ----------------------------------------------------

/** highlight.js token classes → theme syntax tokens. */
const SYNTAX_CLASS_TO_TOKEN: Record<string, string> = {
  keyword: 'syntaxKeyword',
  built_in: 'syntaxKeyword',
  literal: 'syntaxKeyword',
  string: 'syntaxString',
  subst: 'syntaxString',
  quote: 'syntaxString',
  comment: 'syntaxComment',
  number: 'syntaxNumber',
  title: 'syntaxFunction',
  'title.function_': 'syntaxFunction',
  'title.class_': 'syntaxType',
  type: 'syntaxType',
  class: 'syntaxType',
  attr: 'syntaxVariable',
  attribute: 'syntaxVariable',
  variable: 'syntaxVariable',
  'template-variable': 'syntaxVariable',
  operator: 'syntaxOperator',
  punctuation: 'syntaxPunctuation',
  symbol: 'syntaxConstant',
  regexp: 'syntaxConstant',
}

/** chalk style for one raw theme value (#hex / rgb(r,g,b) / ansi:name). */
function chalkFromToken(token: string): (text: string) => string {
  let match = /^#[0-9a-fA-F]{6}$/.exec(token)
  if (match !== null) return chalk.hex(token)
  match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(token)
  if (match !== null) return chalk.rgb(Number(match[1]), Number(match[2]), Number(match[3]))
  match = /^ansi:(\w+)$/.exec(token)
  if (match !== null) {
    const name = match[1] === 'blackBright' ? 'gray' : match[1]
    const style = (chalk as unknown as Record<string, ((text: string) => string) | undefined>)[name]
    if (style !== undefined) return style
  }
  return (text: string) => text
}

/** ANSI 16-color SGR codes → rgb() strings (the dark-ansi palette path). */
const ANSI16: Record<number, string> = {
  30: 'rgb(0,0,0)', 31: 'rgb(128,0,0)', 32: 'rgb(0,128,0)', 33: 'rgb(128,128,0)',
  34: 'rgb(0,0,128)', 35: 'rgb(128,0,128)', 36: 'rgb(0,128,128)', 37: 'rgb(192,192,192)',
  90: 'rgb(128,128,128)', 91: 'rgb(255,0,0)', 92: 'rgb(0,255,0)', 93: 'rgb(255,255,0)',
  94: 'rgb(0,0,255)', 95: 'rgb(255,0,255)', 96: 'rgb(0,255,255)', 97: 'rgb(255,255,255)',
}

/** Parse a cli-highlight ANSI line into colored runs (truecolor + 16-color). */
function parseAnsiRuns(line: string): { text: string; color?: string }[] {
  const runs: { text: string; color?: string }[] = []
  let color: string | undefined
  let rest = line
  // eslint-disable-next-line no-control-regex -- parsing SGR is the point
  const sgr = /\[([0-9;]+)m/
  while (rest.length > 0) {
    const match = sgr.exec(rest)
    const text = match === null ? rest : rest.slice(0, match.index)
    if (text !== '') runs.push(color === undefined ? { text } : { text, color })
    if (match === null) break
    const codes = match[1]!.split(';').map(Number)
    if (codes.includes(0) || codes.includes(39)) color = undefined
    else if (codes[0] === 38 && codes[1] === 2 && codes.length >= 5) {
      color = `rgb(${codes[2]},${codes[3]},${codes[4]})`
    } else if (codes.length === 1 && ANSI16[codes[0]!] !== undefined) {
      color = ANSI16[codes[0]!]
    }
    rest = rest.slice(match.index + match[0].length)
  }
  return runs
}

/** Small per-language memo: syntax runs for one source line. */
const syntaxCache = new Map<string, readonly { text: string; color?: string }[]>()
const SYNTAX_CACHE_MAX = 500

function syntaxRuns(
  text: string,
  language: string | undefined,
  hl: CliHighlight | null,
  chTheme: Record<string, (text: string) => string> | undefined,
): readonly { text: string; color?: string }[] | undefined {
  if (hl === null || chTheme === undefined || language === undefined) return undefined
  if (!hl.supportsLanguage(language)) return undefined
  const key = `${language}${text}`
  const cached = syntaxCache.get(key)
  if (cached !== undefined) return cached
  let runs: readonly { text: string; color?: string }[]
  try {
    runs = parseAnsiRuns(hl.highlight(text, { language, theme: chTheme }))
  } catch {
    runs = [{ text }]
  }
  if (syntaxCache.size >= SYNTAX_CACHE_MAX) syntaxCache.clear()
  syntaxCache.set(key, runs)
  return runs
}

/**
 * Merge syntax runs with word-diff change flags over the same string: both
 * partition it, so an offset sweep yields runs carrying a syntax color AND
 * a changed flag. The render layer lets `changed` override the color.
 */
function mergeRuns(
  syntax: readonly { text: string; color?: string }[],
  words: readonly Segment[],
): Segment[] {
  const out: Segment[] = []
  let si = 0
  let wi = 0
  let sOff = 0
  let wOff = 0
  while (si < syntax.length && wi < words.length) {
    const s = syntax[si]!
    const w = words[wi]!
    const sLen = s.text.length - sOff
    const wLen = w.text.length - wOff
    const take = Math.min(sLen, wLen)
    out.push({
      text: w.text.slice(wOff, wOff + take),
      changed: w.changed,
      color: w.changed ? undefined : s.color,
    })
    sOff += take
    wOff += take
    if (sOff >= s.text.length) { si++; sOff = 0 }
    if (wOff >= w.text.length) { wi++; wOff = 0 }
  }
  return out
}

// --- word-level diff --------------------------------------------------------

/** Strip the shared leading whitespace before word-diffing: otherwise the
 *  whole indent reads as one changed blob (pi's renderIntraLineDiff trick). */
function wordSegments(oldLine: string, newLine: string): { old: Segment[]; new: Segment[] } {
  const oldIndent = /^\s*/.exec(oldLine)?.[0] ?? ''
  const newIndent = /^\s*/.exec(newLine)?.[0] ?? ''
  const sharedIndent = oldIndent === newIndent ? oldIndent : ''
  const parts = JsDiff.diffWords(oldLine.slice(sharedIndent.length), newLine.slice(sharedIndent.length))
  const oldSegments: Segment[] = sharedIndent === '' ? [] : [{ text: sharedIndent, changed: false }]
  const newSegments: Segment[] = sharedIndent === '' ? [] : [{ text: sharedIndent, changed: false }]
  for (const part of parts) {
    if (part.added) newSegments.push({ text: part.value, changed: true })
    else if (part.removed) oldSegments.push({ text: part.value, changed: true })
    else {
      oldSegments.push({ text: part.value, changed: false })
      newSegments.push({ text: part.value, changed: false })
    }
  }
  return { old: oldSegments, new: newSegments }
}

const plainSegments = (line: string): readonly Segment[] => [{ text: line, changed: false }]

// --- hunk alignment ---------------------------------------------------------

/** Segments for one line: syntax runs merged over word flags when a
 *  highlighter is available; the word/plain segmentation otherwise. */
function styleLine(
  line: string,
  words: readonly Segment[],
  language: string | undefined,
  hl: CliHighlight | null,
  chTheme: Record<string, (text: string) => string> | undefined,
): readonly Segment[] {
  const syntax = syntaxRuns(line, language, hl, chTheme)
  if (syntax === undefined) return words
  return mergeRuns(syntax, words)
}

function alignFileDiff(
  oldText: string | null,
  newText: string,
  language: string | undefined,
  hl: CliHighlight | null,
  chTheme: Record<string, (text: string) => string> | undefined,
): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLineNo = 1
  let newLineNo = 1
  const parts = JsDiff.diffLines(expandTabs(oldText ?? ''), expandTabs(newText))
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (!part.added && !part.removed) {
      for (const line of lines) {
        rows.push({
          kind: 'context',
          old: { lineNo: oldLineNo++, segments: styleLine(line, plainSegments(line), language, hl, chTheme) },
          new: { lineNo: newLineNo++, segments: styleLine(line, plainSegments(line), language, hl, chTheme) },
        })
      }
      continue
    }
    if (part.removed) {
      const addedPart = parts[i + 1]?.added === true ? parts[i + 1] : undefined
      const addedLines = addedPart === undefined ? [] : addedPart.value.replace(/\n$/, '').split('\n')
      const pairCount = Math.min(lines.length, addedLines.length)
      for (let p = 0; p < pairCount; p++) {
        const segments = wordSegments(lines[p]!, addedLines[p]!)
        rows.push({
          kind: 'change',
          old: { lineNo: oldLineNo++, segments: styleLine(lines[p]!, segments.old, language, hl, chTheme) },
          new: { lineNo: newLineNo++, segments: styleLine(addedLines[p]!, segments.new, language, hl, chTheme) },
        })
      }
      for (let d = pairCount; d < lines.length; d++) {
        rows.push({ kind: 'del', old: { lineNo: oldLineNo++, segments: styleLine(lines[d]!, plainSegments(lines[d]!), language, hl, chTheme) } })
      }
      for (let a = pairCount; a < addedLines.length; a++) {
        rows.push({ kind: 'add', new: { lineNo: newLineNo++, segments: styleLine(addedLines[a]!, plainSegments(addedLines[a]!), language, hl, chTheme) } })
      }
      if (addedPart !== undefined) i++
      continue
    }
    for (const line of lines) {
      rows.push({ kind: 'add', new: { lineNo: newLineNo++, segments: styleLine(line, plainSegments(line), language, hl, chTheme) } })
    }
  }
  return rows
}

// --- rendering --------------------------------------------------------------

function PaneLine({
  side,
  kind,
  width,
  lineNoWidth,
  tone,
  padLeft = false,
}: {
  readonly side: { readonly lineNo: number; readonly segments: readonly Segment[] } | undefined
  readonly kind: DiffRow['kind']
  readonly width: number
  readonly lineNoWidth: number
  readonly tone: 'old' | 'new'
  readonly padLeft?: boolean
}): React.ReactNode {
  const backgroundColor =
    kind === 'context'
      ? 'toolCardBackground'
      : tone === 'old'
        ? 'diffRemovedDimmed'
        : 'diffAddedDimmed'
  const wordColor = tone === 'old' ? 'diffRemovedWord' : 'diffAddedWord'
  const lineNoText = side === undefined ? '' : String(side.lineNo).padStart(lineNoWidth)
  const prefix = padLeft ? ` ${lineNoText}` : lineNoText
  return (
    <Box width={width} flexShrink={0} backgroundColor={backgroundColor}>
      <Text dimColor backgroundColor={backgroundColor}>{`${prefix} `}</Text>
      {side === undefined ? (
        <Text backgroundColor={backgroundColor}> </Text>
      ) : (
        <Text wrap="truncate" backgroundColor={backgroundColor}>
          {side.segments.map((segment, index) =>
            segment.changed ? (
              <Text key={index} color={wordColor} bold backgroundColor={backgroundColor}>
                {segment.text}
              </Text>
            ) : (
              <Text key={index} color={segment.color as Color | undefined} backgroundColor={backgroundColor}>
                {segment.text}
              </Text>
            ),
          )}
        </Text>
      )}
    </Box>
  )
}

export function SplitDiffView({
  diffs,
  width,
  maxRows,
  verbose,
}: {
  readonly diffs: readonly ToolFileDiff[]
  /** Content width available to the whole two-pane block (divider included). */
  readonly width: number
  /** Row budget when not verbose; overflow folds into one hint row. */
  readonly maxRows: number
  readonly verbose: boolean
}): React.ReactNode {
  // cli-highlight loads lazily (it pulls highlight.js); until the promise
  // settles the view renders diff colors only, then syntax colors fade in.
  const [hl, setHl] = React.useState<CliHighlight | null>(null)
  React.useEffect(() => {
    let mounted = true
    void getCliHighlightPromise().then(loaded => {
      if (mounted) setHl(loaded)
    })
    return () => { mounted = false }
  }, [])

  const [themeName] = useTheme()
  const chTheme = React.useMemo(() => {
    const theme = getTheme(themeName)
    const out: Record<string, (text: string) => string> = {}
    for (const [tokenClass, tokenKey] of Object.entries(SYNTAX_CLASS_TO_TOKEN)) {
      const value = (theme as unknown as Record<string, string>)[tokenKey]
      if (value !== undefined) out[tokenClass] = chalkFromToken(value)
    }
    return out
  }, [themeName])

  const rows: (DiffRow | { readonly separator: string })[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) rows.push({ separator: diff.path })
      else rows.push({ separator: '⋯' })
    }
    prevPath = diff.path
    const language = extname(diff.path).replace(/^\./, '') || undefined
    rows.push(...alignFileDiff(diff.oldText, diff.newText, language, hl, chTheme))
  }

  const totalRows = rows.length
  const capped = verbose || totalRows <= maxRows || totalRows - maxRows === 1
  const visible = capped ? rows : rows.slice(0, maxRows)
  const hidden = totalRows - visible.length

  const maxLineNo = visible.reduce(
    (acc, row) => ('separator' in row ? acc : Math.max(acc, row.old?.lineNo ?? 0, row.new?.lineNo ?? 0)),
    1,
  )
  const lineNoWidth = String(maxLineNo).length
  const paneWidth = Math.max(20, Math.floor((width - 1) / 2))

  return (
    <Box flexDirection="column" width={paneWidth * 2 + 1} backgroundColor="toolCardBackgroundDim">
      {visible.map((row, index) =>
        'separator' in row ? (
          <Box key={index} width={paneWidth * 2 + 1}>
            <Text dimColor wrap="truncate">
              {row.separator === '⋯' ? '⋯' : `  ${row.separator}`}
            </Text>
          </Box>
        ) : (
          <Box key={index} flexDirection="row">
            <PaneLine side={row.old} kind={row.kind === 'add' ? 'context' : row.kind} tone="old" width={paneWidth} lineNoWidth={lineNoWidth} />
            <Box width={1} flexShrink={0} backgroundColor="toolCardBackgroundDim">
              <Text dimColor>│</Text>
            </Box>
            <PaneLine side={row.new} kind={row.kind === 'del' ? 'context' : row.kind} tone="new" width={paneWidth} lineNoWidth={lineNoWidth} padLeft />
          </Box>
        ),
      )}
      {hidden > 0 && (
        <Text dimColor>{`… +${hidden} lines (ctrl+o to expand)`}</Text>
      )}
    </Box>
  )
}
