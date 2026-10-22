import React from 'react'
import { Box, Text } from '../ui.js'
import * as JsDiff from 'diff'
import { extname } from 'node:path'
import type { ToolFileDiff } from '../dsh-adapter/channel.js'
import type { Color } from '../ink/styles.js'
import { stringWidth } from '../ink/stringWidth.js'
import { getCliHighlightPromise, type CliHighlight } from '../terminal-utils/cliHighlight.js'
import { chalkFromToken } from '../terminal-utils/syntaxTheme.js'
import { highlightLines, syntaxThemeSignature, type SyntaxRun } from '../terminal-utils/syntaxRuns.js'
// Backward-compatible re-export: repro scripts import chalkFromToken from
// this module's old home.
export { chalkFromToken } from '../terminal-utils/syntaxTheme.js'
export { parseAnsiRuns, highlightLines } from '../terminal-utils/syntaxRuns.js'
import { getTheme } from '../theme.js'
import { t } from '../i18n.js'
import { useTheme } from './design-system/ThemeProvider.js'
import type { ToolBackground } from '../tuiDisplayPrefs.js'
import { revealLinesOf } from './smoothReveal.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { primaryComboString } from '../utils/keymap.js'
import { isPatchDiff, parseFilePatch, patchHeader, patchHeaderText, type ParsedPatch, type PatchLine } from './diffPatch.js'

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
 * An old/new ToolFileDiff carries no file offsets, so the view shows a
 * status gutter (- / + / space) instead of line numbers — a made-up number
 * is worse than none (issue #250, P2-3). A patch ToolFileDiff (unified
 * hunks, `diffPatch.ts`) does carry them: each pane numbers its lines with
 * the real old / new line numbers, hunks are separated by `⋯`, and the
 * file's header row carries its `(+N -M)` stat.
 *
 * Code is syntax-highlighted with cli-highlight over the WHOLE hunk text
 * (never per line — multi-line comments and strings need the lexer state),
 * with colors from the theme's syntax* tokens. Changed words always win
 * over syntax colors — diff semantics outrank decoration.
 *
 * The alignment contract is "a logical line starts on the same screen row in
 * both panes"; the two modes keep it two different ways:
 *
 * - Collapsed: one source line = one terminal row, overflow clipped by the
 *   renderer's `truncate`. Wrapping here would make a card's height depend on
 *   the window width, while the owning card's row budget and its fold hint
 *   count source lines — so the view reports how many characters it clipped
 *   and leaves reading the rest to the expanded state. So the collapsed height
 *   only moves with the width in whether that hint row appears at all: at most
 *   `maxRows + 2` rows, the row fold hint and the character fold hint.
 * - Expanded (`verbose`): each pane pre-wraps its line into as many visual
 *   rows as the pane's text budget needs, and both panes paint
 *   `max(left, right)` rows (the shorter side pads with blank rows). The next
 *   logical line still starts at the same row in both panes, and the content
 *   that the collapse clipped is now reachable.
 *
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
  /** Real file line numbers (patch diffs only; absent = status gutter). */
  readonly oldNo?: number
  readonly newNo?: number
}

/** Replace tabs so width math and alignment hold (pi convention). */
const expandTabs = (text: string): string => text.replaceAll('\t', '   ')

/**
 * Merge syntax runs with word-diff change flags over the same string: both
 * partition it, so an offset sweep yields runs carrying a syntax color AND
 * a changed flag. The render layer lets `changed` override the color.
 */
function mergeRuns(
  syntax: readonly SyntaxRun[],
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

/** A patch file's hunks aligned into rows (the same pairing rules as
 *  {@link alignFileDiff}, applied per removed+added block of each hunk),
 *  plus the old / new side texts the rows index (syntax highlighting reads
 *  them like a whole file's texts). A patch with no readable hunk aligns
 *  its raw lines by their marker, unnumbered. */
function alignPatchFile(fileIndex: number, parsed: ParsedPatch): { rows: (DiffRow | { readonly separator: string })[]; oldSide: string[]; newSide: string[] } {
  const rows: (DiffRow | { readonly separator: string })[] = []
  const oldSide: string[] = []
  const newSide: string[] = []
  const hunks: readonly (readonly PatchLine[])[] = parsed.raw === undefined
    ? parsed.hunks.map(hunk => hunk.lines)
    : [parsed.raw.map((line): PatchLine => line.startsWith('-') ? { kind: 'del', text: line.slice(1) } : line.startsWith('+') ? { kind: 'add', text: line.slice(1) } : { kind: 'context', text: line })]
  hunks.forEach((lines, hunkIndex) => {
    if (hunkIndex > 0) rows.push({ separator: '⋯' })
    let at = 0
    while (at < lines.length) {
      const line = lines[at]!
      if (line.kind === 'context') {
        const text = expandTabs(line.text)
        rows.push({
          kind: 'context',
          fileIndex,
          oldIndex: oldSide.push(text) - 1,
          newIndex: newSide.push(text) - 1,
          oldWords: plainSegments(text),
          newWords: plainSegments(text),
          ...(line.oldNo === undefined ? {} : { oldNo: line.oldNo }),
          ...(line.newNo === undefined ? {} : { newNo: line.newNo }),
        })
        at += 1
        continue
      }
      const removed: PatchLine[] = []
      while (at < lines.length && lines[at]!.kind === 'del') removed.push(lines[at++]!)
      const added: PatchLine[] = []
      while (at < lines.length && lines[at]!.kind === 'add') added.push(lines[at++]!)
      const oldTexts = removed.map(item => expandTabs(item.text))
      const newTexts = added.map(item => expandTabs(item.text))
      const pairs: [number, number][] = oldTexts.length === newTexts.length
        ? oldTexts.map((_, index) => [index, index] as [number, number])
        : lcsPairs(oldTexts, newTexts)
      const events: { kind: 'del' | 'add' | 'change'; o?: number; a?: number }[] = []
      let oi = 0
      let ai = 0
      for (const [o, a] of pairs) {
        while (oi < o) events.push({ kind: 'del', o: oi++ })
        while (ai < a) events.push({ kind: 'add', a: ai++ })
        events.push({ kind: 'change', o: oi++, a: ai++ })
      }
      while (oi < oldTexts.length) events.push({ kind: 'del', o: oi++ })
      while (ai < newTexts.length) events.push({ kind: 'add', a: ai++ })
      for (const event of events) {
        const oldNo = event.o === undefined ? undefined : removed[event.o]!.oldNo
        const newNo = event.a === undefined ? undefined : added[event.a]!.newNo
        const numbers = { ...(oldNo === undefined ? {} : { oldNo }), ...(newNo === undefined ? {} : { newNo }) }
        if (event.kind === 'change') {
          const segments = wordSegments(oldTexts[event.o!]!, newTexts[event.a!]!)
          rows.push({ kind: 'change', fileIndex, oldIndex: oldSide.push(oldTexts[event.o!]!) - 1, newIndex: newSide.push(newTexts[event.a!]!) - 1, oldWords: segments.old, newWords: segments.new, ...numbers })
        } else if (event.kind === 'del') {
          rows.push({ kind: 'del', fileIndex, oldIndex: oldSide.push(oldTexts[event.o!]!) - 1, oldWords: plainSegments(oldTexts[event.o!]!), ...numbers })
        } else {
          rows.push({ kind: 'add', fileIndex, newIndex: newSide.push(newTexts[event.a!]!) - 1, newWords: plainSegments(newTexts[event.a!]!), ...numbers })
        }
      }
    }
  })
  return { rows, oldSide, newSide }
}

// --- visual rows ------------------------------------------------------------

/** Expanded bodies walk a bounded VISUAL-row window — the two-pane twin of the
 *  unified body's 400-line window. It bounds PAINTED rows, not the work: every
 *  shown line is still wrapped on each frame (O(body) per render). The row
 *  that crosses the window edge is cut there, so the painted body never
 *  exceeds the window; the rows above that edge are painted whole. */
const VERBOSE_VISUAL_ROW_WINDOW = 400

/** One styled grapheme: the smallest unit a wrap may cut between. */
interface StyledGrapheme {
  readonly text: string
  readonly changed: boolean
  readonly color?: string
}

/** Flatten styled runs into styled graphemes, segmenting the JOINED line.
 *
 *  Cutting a run by code unit would split a surrogate pair or a combining
 *  sequence, so the wrap walks graphemes instead. Segmenting each run on its
 *  own is not enough either: the word diff tokenizes non-Latin text per code
 *  point (jsdiff's `extendedWordChars` only covers Latin-1 / Latin Extended),
 *  so a changed family emoji or an edited combining mark leaves runs that end
 *  inside one grapheme cluster — the ZWJ or the accent lands in the next run.
 *  Segmenting the flattened text reunites the cluster; each grapheme keeps the
 *  style of the run its first code unit came from. */
function graphemes(segments: readonly Segment[]): StyledGrapheme[] {
  if (segments.length === 0) return []
  const text = segments.map(segment => segment.text).join('')
  // One style slot per UTF-16 code unit: Intl.Segmenter reports code-unit
  // indices, so this maps a cluster back to the run it starts in.
  const styles = new Array<Segment>(text.length)
  let at = 0
  for (const segment of segments) {
    for (let index = 0; index < segment.text.length; index++) styles[at + index] = segment
    at += segment.text.length
  }
  const out: StyledGrapheme[] = []
  for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
    const style = styles[index]!
    out.push({ text: segment, changed: style.changed, color: style.color })
  }
  return out
}

/** Join graphemes back into runs, merging neighbours that share a style so a
 *  wrapped row paints the same runs it would have painted unwrapped. */
function toSegments(line: readonly StyledGrapheme[]): Segment[] {
  const out: Segment[] = []
  for (const grapheme of line) {
    const last = out[out.length - 1]
    if (last !== undefined && last.changed === grapheme.changed && last.color === grapheme.color) {
      out[out.length - 1] = { text: last.text + grapheme.text, changed: last.changed, color: last.color }
    } else {
      out.push({ text: grapheme.text, changed: grapheme.changed, color: grapheme.color })
    }
  }
  return out
}

/**
 * Split one logical line into visual rows no wider than `budget` display
 * cells. A row prefers to end at the last space that fits, so prose breaks
 * between words and only an unbroken run (a URL, a minified line) is cut
 * mid-word. The space a break lands on stays at the end of the row it closes,
 * so joining the rows reproduces the input exactly.
 *
 * Empty source text still occupies one row; only a missing side has no rows.
 */
function wrapSegments(segments: readonly Segment[], budget: number): Segment[][] {
  const all = graphemes(segments)
  const rows: Segment[][] = []
  let start = 0
  while (start < all.length) {
    let width = 0
    let end = start
    /** Exclusive index just past the last space that fits on this row. */
    let breakAt = -1
    while (end < all.length) {
      const grapheme = all[end]!
      const graphemeWidth = stringWidth(grapheme.text)
      // A single grapheme wider than the whole budget still has to land
      // somewhere: it keeps a row of its own instead of disappearing.
      if (width + graphemeWidth > budget && end > start) break
      width += graphemeWidth
      end += 1
      if (/^\s+$/u.test(grapheme.text) && end < all.length) breakAt = end
    }
    if (end < all.length && breakAt > start) end = breakAt
    rows.push(toSegments(all.slice(start, end)))
    start = end
  }
  return rows.length > 0 ? rows : [[]]
}

/** How many graphemes of a pane line the renderer's `truncate` drops. It cuts
 *  only a line WIDER than the columns it is handed (`src/ink/wrap-text.ts`
 *  returns the text untouched when it fits); once it does cut, it spends one
 *  of those columns on `…` and keeps `budget - 1` cells of text. That "-1" is
 *  the renderer's, not this file's — so a line that fits its budget whole
 *  loses nothing. */
function clippedGraphemes(segments: readonly Segment[] | undefined, budget: number): number {
  if (segments === undefined) return 0
  const all = graphemes(segments)
  const widths = all.map(grapheme => stringWidth(grapheme.text))
  if (widths.reduce((total, width) => total + width, 0) <= budget) return 0
  const fits = budget - 1
  let width = 0
  let visible = 0
  while (visible < all.length) {
    const next = width + widths[visible]!
    if (next > fits) break
    width = next
    visible += 1
  }
  return all.length - visible
}

/** One painted group of terminal rows: a separator, or one logical row with
 *  the visual rows both panes paint for it (`height` = the taller pane, so
 *  neither can run ahead). */
type PaintPlan =
  | { readonly separator: string }
  | {
      readonly singleSide: 'old' | 'new' | undefined
      readonly paneWidth: number
      readonly leftPrefix: string
      readonly rightPrefix: string
      readonly leftRows: readonly (readonly Segment[])[]
      readonly rightRows: readonly (readonly Segment[])[]
      readonly leftKind: DiffRow['kind']
      readonly rightKind: DiffRow['kind']
      readonly height: number
    }

// --- rendering --------------------------------------------------------------

/** Gutter text of one painted row: the status marker alone, or a right-aligned
 *  real line number plus the marker (patch diffs). The new pane keeps the
 *  leading cell the old pane spends on nothing, so the two text columns start
 *  the same distance from their divider; the one-cell gap between gutter and
 *  text is the caller's. */
function gutterText(
  kind: DiffRow['kind'],
  tone: 'old' | 'new',
  lineNo: number | undefined,
  hasContent: boolean,
  lineNoWidth: number,
): string {
  // Status gutter instead of line numbers: ToolFileDiff has no file
  // offsets, and an invented number misleads (issue #250, P2-3).
  const marker = kind === 'context' ? ' ' : tone === 'old' ? '−' : '+'
  const numbered = lineNoWidth > 0
    ? `${(lineNo === undefined || !hasContent ? '' : String(lineNo)).padStart(lineNoWidth)} ${marker}`
    : marker
  return tone === 'new' ? ` ${numbered}` : numbered
}

/** One pane of one terminal row. `prefix` is the gutter already padded to its
 *  final width — a continuation row of a wrapped line repeats that width in
 *  spaces so its text lines up with the row above. `segments` is undefined
 *  when this pane has nothing to paint here (blank side, or a shorter wrap). */
function PaneLine({
  segments,
  prefix,
  kind,
  width,
  tone,
  toolBackground,
  paneId,
  padding,
  continuation,
}: {
  readonly padding: boolean
  readonly paneId: string
  readonly continuation?: number
  readonly segments: readonly Segment[] | undefined
  readonly prefix: string
  readonly kind: DiffRow['kind']
  readonly width: number
  readonly tone: 'old' | 'new'
  readonly toolBackground: ToolBackground
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
  return (
    <Box width={width} flexShrink={0} backgroundColor={backgroundColor} selectionPane={paneId} noSelect={padding} softWrapContinuation={continuation}>
      <Box noSelect><Text dimColor backgroundColor={backgroundColor}>{prefix}</Text></Box>
      {segments === undefined ? (
        <Text backgroundColor={backgroundColor}> </Text>
      ) : (
        // Every painted row is pre-measured against the pane's text budget, so
        // this truncate never fires — it only guarantees the row stays one
        // terminal row if the budget and the renderer ever disagree.
        <Text wrap="truncate" backgroundColor={backgroundColor}>
          {segments.map((segment, index) =>
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
  reveal,
}: {
  readonly diffs: readonly ToolFileDiff[]
  /** Content width available to the whole two-pane block (divider included). */
  readonly width: number
  /** Row budget when not verbose; overflow folds into one hint row. */
  readonly maxRows: number
  readonly verbose: boolean
  readonly toolBackground?: ToolBackground
  /**
   * Smooth-streaming participation (the card owning this view computes
   * eligibility): when present, the capped row list reveals line-by-line at
   * the shared ~30fps cadence instead of painting as one block. The `+N
   * lines` fold hint stays rendered throughout — it describes the cap, not
   * the reveal.
   */
  readonly reveal?: { readonly key: string }
}): React.ReactNode {
  const paneId = React.useId()
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
  // 按当次渲染的色板身份读，**不按名字 memo**：名字不变而色板换掉（auto 翻转、
  // 运行时同名重注册）时，按名字缓存会让签名一直算出旧值。
  const syntaxTheme = getTheme(themeName)
  const themeSig = React.useMemo(() => syntaxThemeSignature(syntaxTheme), [syntaxTheme])

  // Alignment is text-only and capped BEFORE styling: the highlighter and
  // word-diff work lands only on the visible slice (issue #250, P2-8).
  const rows: (DiffRow | { readonly separator: string })[] = []
  /** Patch files: their side texts (syntax lookup) and number gutter width. */
  const patchFiles = new Map<number, { readonly old: string; readonly next: string; readonly lineNoWidth: number }>()
  let prevPath: string | undefined
  diffs.forEach((diff, fileIndex) => {
    if (isPatchDiff(diff)) {
      const parsed = parseFilePatch(diff)
      rows.push({ separator: patchHeaderText(patchHeader(diff, parsed, diffs.length > 1)) })
      const aligned = alignPatchFile(fileIndex, parsed)
      rows.push(...aligned.rows)
      patchFiles.set(fileIndex, {
        old: aligned.oldSide.join('\n'),
        next: aligned.newSide.join('\n'),
        lineNoWidth: parsed.raw === undefined ? String(parsed.maxLineNo).length : 0,
      })
      prevPath = diff.path
      return
    }
    if (diffs.length > 1) {
      if (diff.path !== prevPath) rows.push({ separator: diff.path })
      else rows.push({ separator: '⋯' })
    }
    prevPath = diff.path
    rows.push(...alignFileDiff(fileIndex, diff.oldText, diff.newText))
  })

  // Determine each file's sides from its complete alignment, before folding
  // or smooth reveal can hide the opposite side and make the layout jump.
  const oldFiles = new Set<number>()
  const newFiles = new Set<number>()
  for (const row of rows) {
    if ('separator' in row) continue
    if (row.oldIndex !== undefined) oldFiles.add(row.fileIndex)
    if (row.newIndex !== undefined) newFiles.add(row.fileIndex)
  }

  const totalRows = rows.length
  const capped = verbose || totalRows <= maxRows || totalRows - maxRows === 1
  const visible = capped ? rows : rows.slice(0, maxRows)
  const hidden = totalRows - visible.length
  // Smooth reveal reads happen during render (the owning card subscribes to
  // the scheduler's version, so its re-render drives this view too).
  const revealedRows = reveal !== undefined
    ? revealLinesOf(reveal.key, visible.length, { enabled: true, active: true })
    : visible.length
  const shown = revealedRows >= visible.length ? visible : visible.slice(0, revealedRows)

  const paneWidth = Math.max(20, Math.floor((width - 1) / 2))
  const blockWidth = Math.max(width, paneWidth * 2 + 1)

  // Whole-hunk highlight per file (multi-line lexer state preserved);
  // only the visible rows merge syntax runs with word flags below.
  const fileSyntax = diffs.map((diff, fileIndex) => {
    const language = extname(isPatchDiff(diff) ? diff.movePath ?? diff.path : diff.path).replace(/^\./, '') || undefined
    const patch = patchFiles.get(fileIndex)
    if (patch !== undefined) {
      // Side texts are already tab-expanded (alignPatchFile).
      return {
        old: highlightLines(patch.old, language, hl, syntaxTheme, themeSig),
        next: highlightLines(patch.next, language, hl, syntaxTheme, themeSig),
      }
    }
    if (isPatchDiff(diff)) return { old: undefined, next: undefined }
    return {
      old: highlightLines(expandTabs(diff.oldText ?? ''), language, hl, syntaxTheme, themeSig),
      next: highlightLines(expandTabs(diff.newText), language, hl, syntaxTheme, themeSig),
    }
  })

  // Resolve the shown rows into paint plans. Collapsed paints one terminal row
  // per logical row (#245's height contract); expanded pre-wraps each pane and
  // both panes paint the taller column's row count.
  const windowLimit = verbose ? VERBOSE_VISUAL_ROW_WINDOW : Number.POSITIVE_INFINITY
  const paint: PaintPlan[] = []
  /** Collapsed: graphemes the renderer clipped on the painted rows of both
   *  panes (0 = nothing was clipped, so no hint). */
  let clippedChars = 0
  let paintedRows = 0
  /** Visual rows the whole shown body needs — what the window reports. */
  let totalVisualRows = 0

  for (const row of shown) {
    if ('separator' in row) {
      totalVisualRows += 1
      if (paintedRows < windowLimit) {
        paint.push({ separator: row.separator })
        paintedRows += 1
      }
      continue
    }
    const syntax = fileSyntax[row.fileIndex]
    const oldRuns = row.oldIndex !== undefined ? syntax?.old?.[row.oldIndex] : undefined
    const newRuns = row.newIndex !== undefined ? syntax?.next?.[row.newIndex] : undefined
    const oldSegments = row.oldWords === undefined
      ? undefined
      : oldRuns !== undefined ? mergeRuns(oldRuns, row.oldWords) : row.oldWords
    const newSegments = row.newWords === undefined
      ? undefined
      : newRuns !== undefined ? mergeRuns(newRuns, row.newWords) : row.newWords
    const lineNoWidth = patchFiles.get(row.fileIndex)?.lineNoWidth ?? 0
    // An add row leaves the old pane blank and vice versa, so the blank side
    // paints the "context" tone there — and, being empty, no line number.
    const leftKind = row.kind === 'add' ? 'context' : row.kind
    const rightKind = row.kind === 'del' ? 'context' : row.kind
    const leftPrefix = `${gutterText(leftKind, 'old', row.oldNo, oldSegments !== undefined, lineNoWidth)} `
    const rightPrefix = `${gutterText(rightKind, 'new', row.newNo, newSegments !== undefined, lineNoWidth)} `
    const singleSide = oldFiles.has(row.fileIndex) === newFiles.has(row.fileIndex)
      ? undefined : oldFiles.has(row.fileIndex) ? 'old' : 'new'
    const rowPaneWidth = singleSide === undefined ? paneWidth : blockWidth
    const leftBudget = rowPaneWidth - stringWidth(leftPrefix)
    const rightBudget = rowPaneWidth - stringWidth(rightPrefix)
    if (!verbose) {
      clippedChars += clippedGraphemes(oldSegments, leftBudget)
      clippedChars += clippedGraphemes(newSegments, rightBudget)
    }
    const leftRows = oldSegments === undefined
      ? []
      : verbose ? wrapSegments(oldSegments, leftBudget) : [oldSegments]
    const rightRows = newSegments === undefined
      ? []
      : verbose ? wrapSegments(newSegments, rightBudget) : [newSegments]
    // Neither pane can run ahead: the next logical row starts below the
    // taller column. A row with no content on either side still paints one.
    const height = Math.max(leftRows.length, rightRows.length, 1)
    totalVisualRows += height
    if (paintedRows < windowLimit) {
      // One logical line has no height bound of its own (a single 40k-cell
      // line wraps into ~740 rows), so the row that crosses the window edge is
      // cut to the rows left in it. Only that last row is ever cut; leaving
      // paintedRows short of totalVisualRows is what shows the window notice.
      const take = Math.min(height, windowLimit - paintedRows)
      paint.push({
        singleSide,
        paneWidth: rowPaneWidth,
        leftPrefix,
        rightPrefix,
        leftRows: take < height ? leftRows.slice(0, take) : leftRows,
        rightRows: take < height ? rightRows.slice(0, take) : rightRows,
        leftKind,
        rightKind,
        height: take,
      })
      paintedRows += take
    }
  }

  return (
    <Box flexDirection="column" width={blockWidth}>
      {paint.map((plan, index) => {
        if ('separator' in plan) {
          return (
            <Box key={index} width={blockWidth}>
              <Text dimColor wrap="truncate">
                {plan.separator === '⋯' ? '⋯' : `  ${plan.separator}`}
              </Text>
            </Box>
          )
        }
        const leftPad = ' '.repeat(stringWidth(plan.leftPrefix))
        const rightPad = ' '.repeat(stringWidth(plan.rightPrefix))
        return Array.from({ length: plan.height }, (_, visual) => (
          <Box key={`${index}-${visual}`} flexDirection="row">
            {plan.singleSide !== 'new' && <PaneLine padding={plan.leftRows[visual] === undefined} paneId={paneId + '-old'} continuation={visual > 0 && plan.leftRows[visual] !== undefined ? stringWidth(plan.leftPrefix) + stringWidth(plan.leftRows[visual - 1]!.map(s => s.text).join('')) : undefined} segments={plan.leftRows[visual]} prefix={visual === 0 ? plan.leftPrefix : leftPad} kind={plan.leftKind} tone="old" width={plan.paneWidth} toolBackground={toolBackground} />}
            {plan.singleSide === undefined && <Box width={1} flexShrink={0} noSelect>
              <Text dimColor>│</Text>
            </Box>}
            {plan.singleSide !== 'old' && <PaneLine padding={plan.rightRows[visual] === undefined} paneId={paneId + '-new'} continuation={visual > 0 && plan.rightRows[visual] !== undefined ? stringWidth(plan.rightPrefix) + stringWidth(plan.rightRows[visual - 1]!.map(s => s.text).join('')) : undefined} segments={plan.rightRows[visual]} prefix={visual === 0 ? plan.rightPrefix : rightPad} kind={plan.rightKind} tone="new" width={plan.paneWidth} toolBackground={toolBackground} />}
          </Box>
        ))
      })}
      {hidden > 0 && (
        <Text dimColor>{t('lines-folded-expand', { n: hidden, key: primaryComboString('transcript') })}</Text>
      )}
      {clippedChars > 0 && (
        <Text dimColor>{t('tool-card-lines-hidden', { parts: t('tool-card-chars-unit', { n: clippedChars }), key: primaryComboString('transcript') })}</Text>
      )}
      {paintedRows < totalVisualRows && (
        <Text dimColor>{t('tool-card-window-shown-wrapped', { shown: paintedRows, total: totalVisualRows })}</Text>
      )}
    </Box>
  )
}
