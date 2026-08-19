import React from 'react'
import { Box, Text } from '../ui.js'
import * as JsDiff from 'diff'
import chalk from 'chalk'
import { extname } from 'node:path'
import type { ToolFileDiff } from '../dsh-adapter/channel.js'
import type { Color } from '../ink/styles.js'
import { getCliHighlightPromise, type CliHighlight } from '../cc/cliHighlight.js'
import { SYNTAX_CLASS_TO_TOKEN, chalkFromToken } from '../cc/syntaxTheme.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import type { ToolBackground } from '../tuiDisplayPrefs.js'

/**
 * Side-by-side (two-pane) diff view for Edit/Write tool cards.
 *
 * The structured ToolFileDiff hunks (oldText/newText) are re-aligned with
 * jsdiff: unchanged lines render on both panes, del-only rows fill the left
 * (old) pane, add-only rows fill the right (new) pane, and a del+add pair
 * adjacent in the diff becomes a changed-line pair with word-level
 * highlights. Unequal replacement blocks pair through a case-insensitive
 * LCS so an inserted line above an edited one cannot misalign the pair.
 *
 * ToolFileDiff carries no file offsets, so the view shows a status gutter
 * (- / + / space) instead of line numbers — a made-up number is worse than
 * none (issue #250, P2-3).
 *
 * Code is syntax-highlighted with cli-highlight over the WHOLE hunk text
 * (never per line — multi-line comments and strings need the lexer state),
 * with colors from the theme's syntax* tokens. Changed words always win
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

/** One aligned row across the two panes (text only — styling happens at
 *  render time over the visible slice). */
interface DiffRow {
  readonly kind: 'context' | 'del' | 'add' | 'change'
  /** Which ToolFileDiff this row belongs to (syntax text lookup). */
  readonly fileIndex: number
  /** Line index inside the file's old/new text (syntax run lookup). */
  readonly oldIndex?: number
  readonly newIndex?: number
  readonly oldWords?: readonly Segment[]
  readonly newWords?: readonly Segment[]
}

/** Replace tabs so width math and alignment hold (pi convention). */
const expandTabs = (text: string): string => text.replaceAll('\t', '   ')

// --- syntax highlighting ----------------------------------------------------

// The hljs-class → theme-token map and chalkFromToken live in
// ../cc/syntaxTheme.ts (shared with the markdown code-block renderer).

/** ANSI 16-color SGR codes → rgb() strings (the dark-ansi palette path). */
const ANSI16: Record<number, string> = {
  30: 'rgb(0,0,0)', 31: 'rgb(128,0,0)', 32: 'rgb(0,128,0)', 33: 'rgb(128,128,0)',
  34: 'rgb(0,0,128)', 35: 'rgb(128,0,128)', 36: 'rgb(0,128,128)', 37: 'rgb(192,192,192)',
  90: 'rgb(128,128,128)', 91: 'rgb(255,0,0)', 92: 'rgb(0,255,0)', 93: 'rgb(255,255,0)',
  94: 'rgb(0,0,255)', 95: 'rgb(255,0,255)', 96: 'rgb(0,255,255)', 97: 'rgb(255,255,255)',
}

/** Parse a cli-highlight ANSI string into colored runs, preserving open
 *  spans across embedded newlines (multi-line strings/comments). Handles
 *  truecolor 38;2, 256-color 38;5 (tmux / FORCE_COLOR=2, issue #250 P1-1),
 *  and single-code 16-color SGR. */
export function parseAnsiRuns(text: string): { text: string; color?: string }[] {
  const runs: { text: string; color?: string }[] = []
  let color: string | undefined
  let rest = text
  // eslint-disable-next-line no-control-regex -- parsing SGR is the point
  const sgr = /\x1b\[([0-9;]+)m/
  while (rest.length > 0) {
    const match = sgr.exec(rest)
    const chunk = match === null ? rest : rest.slice(0, match.index)
    if (chunk !== '') runs.push(color === undefined ? { text: chunk } : { text: chunk, color })
    if (match === null) break
    const codes = match[1]!.split(';').map(Number)
    if (codes.includes(0) || codes.includes(39)) color = undefined
    else if (codes[0] === 38 && codes[1] === 2 && codes.length >= 5) {
      color = `rgb(${codes[2]},${codes[3]},${codes[4]})`
    } else if (codes[0] === 38 && codes[1] === 5 && codes.length >= 3) {
      color = `ansi256(${codes[2]})`
    } else if (codes.length === 1 && ANSI16[codes[0]!] !== undefined) {
      color = ANSI16[codes[0]!]
    }
    rest = rest.slice(match.index + match[0].length)
  }
  return runs
}

/** Split flat runs into per-line run arrays at embedded newlines. */
function splitRunsToLines(runs: readonly { text: string; color?: string }[]): { text: string; color?: string }[][] {
  const lines: { text: string; color?: string }[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      if (parts[i] !== '') {
        lines[lines.length - 1]!.push(run.color === undefined ? { text: parts[i]! } : { text: parts[i]!, color: run.color })
      }
    }
  }
  return lines
}

/** Whole-hunk syntax runs per line, cached per (theme signature + language
 *  + text): one entry survives any amount of card re-rendering, and the
 *  palette change invalidates it (issue #250, P1-2 + P2-8). */
const syntaxCache = new Map<string, readonly { text: string; color?: string }[][]>()
const SYNTAX_CACHE_MAX = 40

export function highlightLines(
  text: string,
  language: string | undefined,
  hl: CliHighlight | null,
  chTheme: Record<string, (text: string) => string> | undefined,
  themeSig: string,
): readonly { text: string; color?: string }[][] | undefined {
  if (hl === null || chTheme === undefined || language === undefined) return undefined
  if (text === '' || !hl.supportsLanguage(language)) return undefined
  const key = `${themeSig}${language}${text}`
  const cached = syntaxCache.get(key)
  if (cached !== undefined) return cached
  let lines: readonly { text: string; color?: string }[][]
  try {
    lines = splitRunsToLines(parseAnsiRuns(hl.highlight(text, { language, theme: chTheme })))
  } catch {
    return undefined
  }
  if (syntaxCache.size >= SYNTAX_CACHE_MAX) syntaxCache.clear()
  syntaxCache.set(key, lines)
  return lines
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
    if (take > 0) {
      out.push({
        text: w.text.slice(wOff, wOff + take),
        changed: w.changed,
        color: w.changed ? undefined : s.color,
      })
    }
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

/**
 * Pair the lines of an unequal removed+added block via a case-insensitive
 * LCS: lines equal modulo case align as change pairs, everything before the
 * first match stays block order. An inserted line above an edited one
 * (`foo,bar` → `insert,FOO,bar`) therefore yields `insert` add-only, then
 * `foo ↔ FOO`, instead of the index-zip misalignment (issue #250, P2-4).
 */
function lcsPairs(oldLines: readonly string[], newLines: readonly string[]): [number, number][] {
  const m = oldLines.length
  const n = newLines.length
  // dp[i][j] = LCS length of oldLines[i:] and newLines[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = eq(oldLines[i]!, newLines[j]!)
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (eq(oldLines[i]!, newLines[j]!)) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

/** Align one file's hunks into rows (plain text + word flags; styling is a
 *  render-time concern over the visible slice). */
function alignFileDiff(fileIndex: number, oldText: string | null, newText: string): DiffRow[] {
  const rows: DiffRow[] = []
  const parts = JsDiff.diffLines(expandTabs(oldText ?? ''), expandTabs(newText))
  let oldIndex = 0
  let newIndex = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (!part.added && !part.removed) {
      for (const line of lines) {
        rows.push({
          kind: 'context',
          fileIndex,
          oldIndex: oldIndex++,
          newIndex: newIndex++,
          oldWords: plainSegments(line),
          newWords: plainSegments(line),
        })
      }
      continue
    }
    if (part.removed) {
      const addedPart = parts[i + 1]?.added === true ? parts[i + 1] : undefined
      const addedLines = addedPart === undefined ? [] : addedPart.value.replace(/\n$/, '').split('\n')
      // Same-length replacement blocks zip index-for-index (the common
      // edit case); unequal blocks pair through the ci-LCS so an inserted
      // line cannot shift the alignment (issue #250, P2-4).
      const pairs: [number, number][] = lines.length === addedLines.length
        ? lines.map((_, index) => [index, index] as [number, number])
        : lcsPairs(lines, addedLines)
      // Block order: walk both lists; unpaired entries emit in place, pairs
      // emit at the later of the two positions.
      const events: { kind: 'del' | 'add' | 'change'; o?: number; a?: number }[] = []
      let oi = 0
      let ai = 0
      for (const [o, a] of pairs) {
        while (oi < o) events.push({ kind: 'del', o: oi++ })
        while (ai < a) events.push({ kind: 'add', a: ai++ })
        events.push({ kind: 'change', o: oi++, a: ai++ })
      }
      while (oi < lines.length) events.push({ kind: 'del', o: oi++ })
      while (ai < addedLines.length) events.push({ kind: 'add', a: ai++ })
      for (const event of events) {
        if (event.kind === 'change') {
          const segments = wordSegments(lines[event.o!]!, addedLines[event.a!]!)
          rows.push({
            kind: 'change',
            fileIndex,
            oldIndex: oldIndex++,
            newIndex: newIndex++,
            oldWords: segments.old,
            newWords: segments.new,
          })
        } else if (event.kind === 'del') {
          rows.push({ kind: 'del', fileIndex, oldIndex: oldIndex++, oldWords: plainSegments(lines[event.o!]!) })
        } else {
          rows.push({ kind: 'add', fileIndex, newIndex: newIndex++, newWords: plainSegments(addedLines[event.a!]!) })
        }
      }
      if (addedPart !== undefined) i++
      continue
    }
    for (const line of lines) {
      rows.push({ kind: 'add', fileIndex, newIndex: newIndex++, newWords: plainSegments(line) })
    }
  }
  return rows
}

// --- rendering --------------------------------------------------------------

function PaneLine({
  side,
  kind,
  width,
  tone,
  toolBackground,
  padLeft = false,
}: {
  readonly side: { readonly segments: readonly Segment[] } | undefined
  readonly kind: DiffRow['kind']
  readonly width: number
  readonly tone: 'old' | 'new'
  readonly toolBackground: ToolBackground
  readonly padLeft?: boolean
}): React.ReactNode {
  const ordinaryBackground = toolBackground === 'subtle'
    ? 'toolCardBackgroundDim'
    : toolBackground === 'strong'
      ? 'toolCardBackground'
      : undefined
  // Additions/removals keep their semantic tint; unchanged and empty panes
  // inherit the configured ordinary tool-card surface.
  const backgroundColor =
    kind === 'context'
      ? ordinaryBackground
      : tone === 'old'
        ? 'diffRemovedDimmed'
        : 'diffAddedDimmed'
  const wordColor = tone === 'old' ? 'diffRemovedWord' : 'diffAddedWord'
  // Status gutter instead of line numbers: ToolFileDiff has no file
  // offsets, and an invented number misleads (issue #250, P2-3).
  const marker = kind === 'context' ? ' ' : tone === 'old' ? '−' : '+'
  const prefix = padLeft ? ` ${marker}` : marker
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
  toolBackground = 'none',
}: {
  readonly diffs: readonly ToolFileDiff[]
  /** Content width available to the whole two-pane block (divider included). */
  readonly width: number
  /** Row budget when not verbose; overflow folds into one hint row. */
  readonly maxRows: number
  readonly verbose: boolean
  readonly toolBackground?: ToolBackground
}): React.ReactNode {
  const [hl, setHl] = React.useState<CliHighlight | null>(null)
  React.useEffect(() => {
    let mounted = true
    void getCliHighlightPromise().then(loaded => {
      if (mounted) setHl(loaded)
    })
    return () => { mounted = false }
  }, [])

  const [themeName] = useTheme()
  // Resolved-palette signature: covers dark→light, light→dark, AND the
  // `auto` base flip where the name never changes (issue #250, P1-2).
  const themeSig = React.useMemo(() => {
    const theme = getTheme(themeName) as unknown as Record<string, string>
    return Object.values(SYNTAX_CLASS_TO_TOKEN)
      .map(key => theme[key] ?? '')
      .join('|')
  }, [themeName])
  const chTheme = React.useMemo(() => {
    const theme = getTheme(themeName) as unknown as Record<string, string>
    const out: Record<string, (text: string) => string> = {}
    for (const [tokenClass, tokenKey] of Object.entries(SYNTAX_CLASS_TO_TOKEN)) {
      const value = theme[tokenKey]
      if (value !== undefined) out[tokenClass] = chalkFromToken(value)
    }
    return out
    // themeSig changes exactly when any syntax token's resolved value does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeSig])

  // Alignment is text-only and capped BEFORE styling: the highlighter and
  // word-diff work lands only on the visible slice (issue #250, P2-8).
  const rows: (DiffRow | { readonly separator: string })[] = []
  let prevPath: string | undefined
  diffs.forEach((diff, fileIndex) => {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) rows.push({ separator: diff.path })
      else rows.push({ separator: '⋯' })
    }
    prevPath = diff.path
    rows.push(...alignFileDiff(fileIndex, diff.oldText, diff.newText))
  })

  const totalRows = rows.length
  const capped = verbose || totalRows <= maxRows || totalRows - maxRows === 1
  const visible = capped ? rows : rows.slice(0, maxRows)
  const hidden = totalRows - visible.length

  const paneWidth = Math.max(20, Math.floor((width - 1) / 2))

  // Whole-hunk highlight per file (multi-line lexer state preserved);
  // only the visible rows merge syntax runs with word flags below.
  const fileSyntax = diffs.map(diff => {
    const language = extname(diff.path).replace(/^\./, '') || undefined
    return {
      old: highlightLines(expandTabs(diff.oldText ?? ''), language, hl, chTheme, themeSig),
      next: highlightLines(expandTabs(diff.newText), language, hl, chTheme, themeSig),
    }
  })

  return (
    <Box flexDirection="column" width={paneWidth * 2 + 1}>
      {visible.map((row, index) => {
        if ('separator' in row) {
          return (
            <Box key={index} width={paneWidth * 2 + 1}>
              <Text dimColor wrap="truncate">
                {row.separator === '⋯' ? '⋯' : `  ${row.separator}`}
              </Text>
            </Box>
          )
        }
        const syntax = fileSyntax[row.fileIndex]
        const oldRuns = row.oldIndex !== undefined ? syntax?.old?.[row.oldIndex] : undefined
        const newRuns = row.newIndex !== undefined ? syntax?.next?.[row.newIndex] : undefined
        const oldSide = row.oldWords === undefined
          ? undefined
          : { segments: oldRuns !== undefined ? mergeRuns(oldRuns, row.oldWords) : row.oldWords }
        const newSide = row.newWords === undefined
          ? undefined
          : { segments: newRuns !== undefined ? mergeRuns(newRuns, row.newWords) : row.newWords }
        return (
          <Box key={index} flexDirection="row">
            <PaneLine side={oldSide} kind={row.kind === 'add' ? 'context' : row.kind} tone="old" width={paneWidth} toolBackground={toolBackground} />
            <Box width={1} flexShrink={0}>
              <Text dimColor>│</Text>
            </Box>
            <PaneLine side={newSide} kind={row.kind === 'del' ? 'context' : row.kind} tone="new" width={paneWidth} toolBackground={toolBackground} padLeft />
          </Box>
        )
      })}
      {hidden > 0 && (
        <Text dimColor>{`… +${hidden} lines (ctrl+o to expand)`}</Text>
      )}
    </Box>
  )
}
