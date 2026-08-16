import React from 'react'
import { Box, Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import * as JsDiff from 'diff'
import type { ToolFileDiff } from '../dsh-adapter/channel.js'

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
 * One source line = one terminal row (truncate, never wrap): the two panes
 * must stay row-aligned, and a wrapped long line would tear the pairing.
 * Tabs become 3 spaces so column math holds.
 */

/** One aligned row across the two panes. */
interface DiffRow {
  /** Left (old) pane content; undefined = blank counterpart. */
  readonly old?: { readonly lineNo: number; readonly segments: readonly Segment[] }
  /** Right (new) pane content; undefined = blank counterpart. */
  readonly new?: { readonly lineNo: number; readonly segments: readonly Segment[] }
  /** Row kind drives background tone. */
  readonly kind: 'context' | 'del' | 'add' | 'change'
}

/** One styled run inside a pane line (word-diff output). */
interface Segment {
  readonly text: string
  readonly changed: boolean
}

/** Replace tabs so width math and alignment hold (pi convention). */
const expandTabs = (text: string): string => text.replaceAll('\t', '   ')

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

/**
 * Align one file's hunks into paired rows. jsdiff emits ordered parts;
 * a removed part immediately followed by an added part is a changed region
 * whose lines pair index-for-index (pi's generateDiffString convention).
 */
function alignFileDiff(oldText: string | null, newText: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLineNo = 1
  let newLineNo = 1
  const parts = JsDiff.diffLines((oldText ?? '').replaceAll('\t', '   '), expandTabs(newText))
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    // diffLines values end with a trailing newline except possibly the last.
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (!part.added && !part.removed) {
      for (const line of lines) {
        rows.push({
          kind: 'context',
          old: { lineNo: oldLineNo++, segments: plainSegments(line) },
          new: { lineNo: newLineNo++, segments: plainSegments(line) },
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
          old: { lineNo: oldLineNo++, segments: segments.old },
          new: { lineNo: newLineNo++, segments: segments.new },
        })
      }
      for (let d = pairCount; d < lines.length; d++) {
        rows.push({ kind: 'del', old: { lineNo: oldLineNo++, segments: plainSegments(lines[d]!) } })
      }
      for (let a = pairCount; a < addedLines.length; a++) {
        rows.push({ kind: 'add', new: { lineNo: newLineNo++, segments: plainSegments(addedLines[a]!) } })
      }
      if (addedPart !== undefined) i++
      continue
    }
    // add-only part (no adjacent removed): all rows land on the right pane.
    for (const line of lines) {
      rows.push({ kind: 'add', new: { lineNo: newLineNo++, segments: plainSegments(line) } })
    }
  }
  return rows
}

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
  /** Right pane: one space of air between the divider and the line number. */
  readonly padLeft?: boolean
}): React.ReactNode {
  const backgroundColor =
    kind === 'context'
      ? undefined
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
              <Text key={index} backgroundColor={backgroundColor}>
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
  // Assemble rows across files; a `⋯` separator row keeps scattered hunks
  // of one file apart (unified view's convention), a path row separates
  // files when several changed at once.
  const rows: (DiffRow | { readonly separator: string })[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) rows.push({ separator: diff.path })
      else rows.push({ separator: '⋯' })
    }
    prevPath = diff.path
    rows.push(...alignFileDiff(diff.oldText, diff.newText))
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
    <Box flexDirection="column" width={paneWidth * 2 + 1}>
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
            <Box width={1} flexShrink={0}>
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
