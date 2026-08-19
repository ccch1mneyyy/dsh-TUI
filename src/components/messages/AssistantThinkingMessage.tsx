import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { StreamingMarkdown } from '../StreamingMarkdown.js'
import { formatDuration } from '../../cc/format.js'

/** Preview body rows — a FIXED row count (kimicode-style constant-height
 *  ticker). Ink's truncate slices the whole string across newlines as one
 *  logical line, so a single joined Text collapses to 1-2 rows whenever
 *  the combined width passes the terminal width, then bounces back as
 *  lines shift. One Text per row, each truncated to the width and padded
 *  to exactly this many rows, keeps the block height stream-independent. */
const PREVIEW_ROWS = 3

type Props = {
  thinking: string
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** True when Ctrl+O transcript/verbose mode is on — show the full text. */
  verbose: boolean
  /** Streaming compact mode (thinkingFold=preview): a 3-row live ticker of
   *  the model's latest reasoning lines instead of the full block —
   *  kimicode-style constant height; the block never resizes mid-stream. */
  preview?: boolean
  /** Thinking wall-clock duration once the reasoning block settled (ms). */
  durationMs?: number
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(): void
}

/**
 * Thinking block: folded `∴ Thinking (ctrl+o to expand)`, expanded shows the
 * full reasoning text indented under `∴ Thinking…`, mirroring Claude Code's
 * `messages/AssistantThinkingMessage.tsx`. When the channel records the
 * reasoning duration, the label carries it (`∴ Thinking · 12s …`) — dsh-tui's
 * take on making thinking time visible in the transcript.
 */
export function AssistantThinkingMessage({
  thinking,
  addMargin,
  verbose,
  preview = false,
  durationMs,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  if (!thinking) return null

  const duration =
    durationMs !== undefined && durationMs >= 1000
      ? ` · ${formatDuration(durationMs)}`
      : ''

  if (preview) {
    // Live ticker: the model's last few reasoning lines, dimmed, one Text
    // per row so each truncates to the width independently, padded to a
    // constant PREVIEW_ROWS-tall block that follows the stream. The folded
    // summary takes over when the step settles. The LAST row truncates
    // from the start (leading ellipsis) so the newest tokens — which grow
    // at the line's end — stay visible while the line is longer than the
    // width.
    const lines = thinking.split('\n')
    const visible = lines.slice(-PREVIEW_ROWS)
    const clipped = lines.length > visible.length
    // Pad with single spaces — an empty-string Text renders with zero
    // height in ink, so '' padding would not hold the row open.
    const rows = Array.from(
      { length: PREVIEW_ROWS },
      (_, i) => visible[i] ?? ' ',
    )
    return (
      <Box
        flexDirection="column"
        marginTop={addMargin ? 1 : 0}
        backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
        onClick={onClick}
      >
        <Text dimColor italic>
          ∴ {t('thinking-label')}{duration}…
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          {rows.map((line, i) => (
            <Text
              key={i}
              dimColor
              italic
              wrap={i === rows.length - 1 ? 'truncate-start' : 'truncate'}
            >
              {i === 0 && clipped ? `…${line}` : line}
            </Text>
          ))}
        </Box>
      </Box>
    )
  }

  if (!verbose) {
    return (
      <Box
        marginTop={addMargin ? 1 : 0}
        backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
        onClick={onClick}
      >
        <Text dimColor italic>
          ∴ {t('thinking-label')}{duration} {t('hint-expand-ctrl-o')}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      gap={1}
      marginTop={addMargin ? 1 : 0}
      width="100%"
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      onClick={onClick}
    >
      <Text dimColor italic>
        ∴ {t('thinking-label')}{duration}…
      </Text>
      <Box paddingLeft={2}>
        {/* StreamingMarkdown: the live thinking text grows per token — the
          incremental stable-prefix + tail budget keeps the per-frame layout
          cost at O(new content) instead of re-laying out the whole block. */}
        <StreamingMarkdown dimColor>{thinking}</StreamingMarkdown>
      </Box>
    </Box>
  )
}
