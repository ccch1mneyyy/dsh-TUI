import React from 'react'
import { marked } from 'marked'
import Box from '../ink/components/Box.js'
import { stripPromptXMLTags } from '../cc/markdown.js'
import { t } from '../i18n.js'
import { Markdown } from './Markdown.js'

/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta, mirroring Claude Code's
 * `StreamingMarkdown.tsx`). marked.lexer() correctly handles unclosed code
 * fences as a single token, so block boundaries are always safe.
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

export function StreamingMarkdown({
  children,
  dimColor = false,
}: {
  children: string
  dimColor?: boolean
}): React.ReactNode {
  // The stable prefix is kept as ONE string identity across renders: a
  // fresh substring per render would break Markdown's React.memo and
  // re-layout the entire finished transcript tail on every token. The
  // identity only changes when a new block boundary advances the prefix.
  const prefixRef = React.useRef('')
  const cutRef = React.useRef(0)

  const stripped = stripPromptXMLTags(children)

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(prefixRef.current)) {
    prefixRef.current = ''
    cutRef.current = 0
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = prefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx].type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i].raw.length
  }
  if (advance > 0) {
    prefixRef.current = stripped.substring(0, boundary + advance)
  }

  const stablePrefix = prefixRef.current
  const unstableSuffix = clipSuffixTail(stripped.substring(stablePrefix.length), cutRef)

  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown dimColor={dimColor}>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown dimColor={dimColor} cacheTokens={false}>{unstableSuffix}</Markdown>}
    </Box>
  )
}
