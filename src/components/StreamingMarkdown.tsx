import React from 'react'
import { marked, type Token } from 'marked'
import Box from '../ink/components/Box.js'
import { formatToken, stripPromptXMLTags } from '../terminal-utils/markdown.js'
import { t } from '../i18n.js'
import { Markdown } from './Markdown.js'

/**
 * Renders streaming markdown in sealed groups of completed top-level blocks.
 * Only the unsealed group and growing final block change as text arrives.
 * marked.lexer() keeps unclosed fences inside one token, and the boundary
 * analysis below preserves the whole-document formatter's row spacing.
 */
/**
 * Tail budget for the unstable suffix during streaming. The sticky view only
 * ever shows the last viewport of rows, but the suffix Text is re-wrapped
 * every frame — an unbounded suffix (a single huge paragraph with no block
 * boundary to advance the prefix) made that O(total) per frame. The suffix
 * is clipped to this many characters (preferring a paragraph boundary),
 * with a leading marker naming the dropped amount; settling renders the
 * full text once through the non-streaming path.
 *
 * The cut point is STICKY (advances only when the suffix outgrows budget +
 * step): a cut that slid every frame would break append-only growth, and
 * the layout layer's incremental wrap would fall back to a full re-wrap of
 * the whole tail on every token.
 */
const SUFFIX_TAIL_BUDGET = 3584
const SUFFIX_BOUNDARY_LOOKBACK = 2048
const SUFFIX_CUT_STEP = 1024
const STABLE_BLOCK_BUDGET = 8192

function clipSuffixTail(suffix: string, cut: { current: number }): string {
  const total = suffix.length
  if (total <= SUFFIX_TAIL_BUDGET) {
    cut.current = 0
    return suffix
  }
  // Advance the sticky cut only once the suffix outgrew the budget by a
  // full step, preferring a paragraph boundary inside the lookback window.
  if (total - cut.current > SUFFIX_TAIL_BUDGET + SUFFIX_CUT_STEP) {
    const windowStart = total - SUFFIX_TAIL_BUDGET
    const boundary = suffix.lastIndexOf('\n\n', windowStart + SUFFIX_BOUNDARY_LOOKBACK)
    cut.current = boundary !== -1 && boundary >= windowStart - SUFFIX_BOUNDARY_LOOKBACK
      ? boundary + 2
      : windowStart
  }
  const dropped = cut.current
  return `${t('streaming-folded', { count: dropped })}\n\n${suffix.slice(cut.current)}`
}

type StableBoundary = {
  /** False when two Markdown components cannot reproduce an inline boundary. */
  safe: boolean
  /** Empty display rows before a following text block. */
  gap: number
  /** Tables use Markdown's fixed node gap instead of text newline spacing. */
  endsWithTable: boolean
  /** Whitespace after a table becomes a zero-height node between two tables. */
  trailingEmptyTextNode: boolean
}

const UNSAFE_BOUNDARY: StableBoundary = {
  safe: false,
  gap: 0,
  endsWithTable: false,
  trailingEmptyTextNode: false,
}

/**
 * Token types whose formatted output is provably blank, taken from
 * the markdown dispatcher's table: `space`/`br` emit a single newline,
 * `def`/`del`/`html` emit nothing. Kept in step with `analyzeSuffixStart`,
 * which splits the same set into "newline" and "empty" halves.
 */
function isBlankTokenType(type: string): boolean {
  return type === 'space' || type === 'br' || type === 'def' || type === 'del' || type === 'html'
}

/** Newlines contributed by a blank token: one for `space`/`br`, none otherwise. */
function blankTokenNewlines(type: string): number {
  return type === 'space' || type === 'br' ? 1 : 0
}

/**
 * Analyze the candidate stable tokens using the same formatter as Markdown.
 * Both split halves trim their outer whitespace, so the trailing newline count
 * determines the Yoga gap: one newline merely starts the next row; every
 * additional newline is one genuinely blank row. Tables are separate layout
 * nodes and therefore keep Markdown's fixed one-row node gap.
 *
 * Only the LAST token that can produce visible text decides the outcome, so
 * the region is walked backwards and formatted one token at a time instead of
 * concatenating (and syntax-highlighting) every settled block on each new
 * boundary. `formatToken` runs once for the common case.
 */
function analyzeStableBoundary(tokens: readonly Token[], suffixIndex: number): StableBoundary {
  // A table resets the accumulated text, so only the segment after the last
  // one matters; anything before it is already folded into the table branch.
  let segmentStart = 0
  let hasTable = false
  for (let i = suffixIndex - 1; i >= 0; i--) {
    if (tokens[i]!.type === 'table') {
      segmentStart = i + 1
      hasTable = true
      break
    }
  }

  // Skip the trailing run of blank tokens, banking their newlines: they sit
  // after the last visible text and therefore only extend its newline run.
  let blankNewlines = 0
  let cursor = suffixIndex - 1
  while (cursor >= segmentStart && isBlankTokenType(tokens[cursor]!.type)) {
    blankNewlines += blankTokenNewlines(tokens[cursor]!.type)
    cursor--
  }

  // Format backwards until a token actually produces visible text. A token
  // that formats to blank is folded into the newline run and skipped over.
  for (let i = cursor; i >= segmentStart; i--) {
    const token = tokens[i]!
    const ansiText = formatToken(token)
    if (ansiText.trim() === '') {
      blankNewlines += ansiText.match(/\n+$/)?.[0].length ?? 0
      continue
    }
    const trailingNewlines = (ansiText.match(/\n+$/)?.[0].length ?? 0) + blankNewlines
    // A zero-newline boundary (notably `hr` followed immediately by prose)
    // belongs in one Markdown component; separate column children would force
    // a line break that the whole-document formatter does not contain.
    if (trailingNewlines === 0) return UNSAFE_BOUNDARY
    return {
      safe: true,
      gap: Math.max(0, trailingNewlines - 1),
      endsWithTable: false,
      trailingEmptyTextNode: false,
    }
  }

  if (hasTable) {
    return {
      safe: true,
      gap: 1,
      endsWithTable: true,
      // Whitespace after the table still occupies a zero-height text node
      // between two tables.
      trailingEmptyTextNode: blankNewlines > 0,
    }
  }
  // Definitions/raw HTML alone render nothing; advancing them buys no stable
  // work and can lose whitespace that belongs to the next visible block.
  return UNSAFE_BOUNDARY
}

type SuffixStart = {
  kind: 'text' | 'table' | undefined
  leadingNewlines: number
}

/** Find the first visible suffix node without formatting the growing token.
 * Whitespace around invisible definitions/HTML is internal in a whole render
 * but gets trimmed at the start of the split suffix, so count it into the
 * boundary gap explicitly. */
function analyzeSuffixStart(tokens: readonly Token[], startIndex: number): SuffixStart {
  let leadingNewlines = 0
  for (let i = startIndex; i < tokens.length; i++) {
    const type = tokens[i]?.type
    if (type === 'table') return { kind: 'table', leadingNewlines }
    if (type === 'space' || type === 'br') {
      leadingNewlines += 1
      continue
    }
    if (type === 'def' || type === 'del' || type === 'html') continue
    return { kind: 'text', leadingNewlines }
  }
  return { kind: undefined, leadingNewlines }
}

function gapBetween(boundary: StableBoundary, start: SuffixStart): number {
  if (start.kind === undefined) return 0
  if (boundary.endsWithTable) {
    return start.kind === 'table' && (boundary.trailingEmptyTextNode || start.leadingNewlines > 0) ? 2 : 1
  }
  return start.kind === 'table' ? 1 : boundary.gap + start.leadingNewlines
}

type StableBlocks = {
  blocks: Array<{ text: string; gap: number }>
  end: number
  tokens: Token[]
  tail: string
  tailGap: number
  boundary: StableBoundary | undefined
  definitions: boolean
}

export function StreamingMarkdown({
  children,
  dimColor = false,
}: {
  children: string
  dimColor?: boolean
}): React.ReactNode {
  // The prefix tracks source offsets; its rendered blocks are sealed once
  // so an advancing boundary never reparses the entire accumulated answer.
  const prefixRef = React.useRef('')
  const blocksRef = React.useRef<StableBlocks>({
    blocks: [], end: 0, tokens: [], tail: '', tailGap: 0,
    boundary: undefined, definitions: false,
  })
  const cutRef = React.useRef(0)
  const boundaryGapRef = React.useRef(0)
  const prefixVisibleRef = React.useRef(false)
  const prefixEndsWithTableRef = React.useRef(false)
  const prefixTrailingEmptyTextRef = React.useRef(false)

  const stripped = stripPromptXMLTags(children)

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(prefixRef.current)) {
    prefixRef.current = ''
    cutRef.current = 0
    boundaryGapRef.current = 0
    prefixVisibleRef.current = false
    prefixEndsWithTableRef.current = false
    prefixTrailingEmptyTextRef.current = false
    blocksRef.current = {
      blocks: [], end: 0, tokens: [], tail: '', tailGap: 0,
      boundary: undefined, definitions: false,
    }
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = prefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))
  const blocks = blocksRef.current
  // Reference definitions have document-wide scope, including references
  // in the growing suffix. These documents cannot use independent parsers.
  if (!blocks.definitions && Object.keys(tokens.links).length > 0) {
    blocks.definitions = true
    blocks.blocks = []
    blocks.tokens = []
    blocks.end = 0
    blocks.boundary = undefined
  }

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx].type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i].raw.length
  }
  let suffixTokenIndex = 0
  if (advance > 0) {
    const stableBoundary = analyzeStableBoundary(tokens, lastContentIdx)
    if (stableBoundary.safe) {
      if (!blocks.definitions) {
        let end = boundary
        for (let index = 0; index < lastContentIdx; index++) {
          const token = tokens[index]!
          blocks.tokens.push(token)
          end += token.raw.length
          if (end - blocks.end < STABLE_BLOCK_BUDGET) continue
          const blockBoundary = analyzeStableBoundary(blocks.tokens, blocks.tokens.length)
          if (!blockBoundary.safe) continue
          const gap = blocks.boundary === undefined ? 0 : gapBetween(blocks.boundary, analyzeSuffixStart(blocks.tokens, 0))
          // Detach the sealed slice from the growing source buffer, preserving
          // UTF-16 code units rather than pinning every historical full reply.
          const text = Buffer.from(stripped.substring(blocks.end, end), 'utf16le').toString('utf16le')
          blocks.blocks.push({ text, gap })
          blocks.end = end
          blocks.boundary = blockBoundary
          blocks.tokens = []
        }
        blocks.tail = stripped.substring(blocks.end, boundary + advance)
        blocks.tailGap = blocks.boundary === undefined ? 0 : gapBetween(blocks.boundary, analyzeSuffixStart(blocks.tokens, 0))
      }
      prefixRef.current = stripped.substring(0, boundary + advance)
      boundaryGapRef.current = stableBoundary.gap
      prefixVisibleRef.current = true
      prefixEndsWithTableRef.current = stableBoundary.endsWithTable
      prefixTrailingEmptyTextRef.current = stableBoundary.trailingEmptyTextNode
      suffixTokenIndex = lastContentIdx
    }
  }

  if (blocks.definitions) {
    return <Markdown dimColor={dimColor} cacheTokens={false}>{stripped}</Markdown>
  }

  const stablePrefix = prefixRef.current
  const prefixTail = blocks.tail
  const suffixSource = stripped.substring(stablePrefix.length)
  const unstableSuffix = clipSuffixTail(suffixSource, cutRef)
  const suffixStart = cutRef.current > 0
    ? { kind: 'text' as const, leadingNewlines: 0 }
    : analyzeSuffixStart(tokens, suffixTokenIndex)
  const boundaryGap =
    prefixVisibleRef.current && suffixStart.kind !== undefined
      ? prefixEndsWithTableRef.current
        ? suffixStart.kind === 'table' &&
          (prefixTrailingEmptyTextRef.current || suffixStart.leadingNewlines > 0)
          ? 2
          : 1
        : suffixStart.kind === 'table'
          ? 1
          : boundaryGapRef.current + suffixStart.leadingNewlines
      : 0

  // A lexer boundary must be strictly outside the stable prefix. If marked
  // reports a raw span that ends at the current cursor (possible around an
  // unfinished fence/table while deltas arrive), rendering both branches can
  // paint the same tail twice. Keep the suffix authoritative and never render
  // an overlapping empty/duplicate boundary.
  const hasDistinctSuffix = unstableSuffix !== '' &&
    (stablePrefix === '' || !unstableSuffix.startsWith(stablePrefix))

  return (
    <Box flexDirection="column">
      {blocks.blocks.map((block, index) => (
        <Box key={index} flexDirection="column" marginTop={block.gap}>
          <Markdown dimColor={dimColor}>{block.text}</Markdown>
        </Box>
      ))}
      {prefixTail && (
        <Box key="prefix" flexDirection="column" marginTop={blocks.tailGap}>
          <Markdown dimColor={dimColor}>{prefixTail}</Markdown>
        </Box>
      )}
      {hasDistinctSuffix && (
        <Box key="suffix" flexDirection="column" marginTop={boundaryGap}>
          <Markdown dimColor={dimColor} cacheTokens={false}>{unstableSuffix}</Markdown>
        </Box>
      )}
    </Box>
  )
}
