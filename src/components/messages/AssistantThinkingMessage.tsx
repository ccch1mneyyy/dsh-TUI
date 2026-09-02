import React from 'react'
import chalk from 'chalk'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { StreamingMarkdown } from '../StreamingMarkdown.js'
import { formatDuration } from '../../cc/format.js'
import {
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL_MS,
  THINKING_SETTLED_MARKER,
} from '../../cc/figures.js'
import { BRAND, ICE } from '../shimmer.js'
import { interpolateColor } from '../Spinner/spinnerUtils.js'
import { isMinimalMode } from '../../minimalMode.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

/** Preview body rows — a FIXED row count (kimicode-style constant-height
 *  ticker). Ink's truncate slices the whole string across newlines as one
 *  logical line, so a single joined Text collapses to 1-2 rows whenever
 *  the combined width passes the terminal width, then bounces back as
 *  lines shift. One Text per row, each truncated to the width and padded
 *  to exactly this many rows, keeps the block height stream-independent. */
const PREVIEW_ROWS = 3

type Props = {
  thinking: string
  /** The FULL un-revealed text (reasoning rows under smooth streaming):
   *  `thinking` carries the revealed slice the expanded body paints, while
   *  the live preview ticker must follow the newest ARRIVED content — never
   *  a lagging reveal. Falls back to `thinking`. */
  textFull?: string
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** Show the full text (Ctrl+O, per-row expansion, or live click toggle). */
  verbose: boolean
  /** True while the reasoning block is still streaming — the leading anchor
   *  becomes a rotating braille spinner (Kimi Code style) and settles back
   *  to the anchor once the step ends. */
  streaming?: boolean
  /** Streaming compact mode (thinkingFold=preview): a 3-row live ticker of
   *  the model's latest reasoning lines instead of the full block —
   *  kimicode-style constant height; the block never resizes mid-stream. */
  preview?: boolean
  /** Thinking wall-clock duration once the reasoning block settled (ms). */
  durationMs?: number
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}

/**
 * Thinking block: settled rows fold to `⚓ Thinking (ctrl+o to expand)`;
 * streaming rows switch between a three-line preview and the full reasoning
 * text on click. The live leading mark is a rotating braille spinner
 * (`⠋⠙⠹…`, Kimi Code style), settling back to the static anchor (`⚓`). When
 * the channel records the reasoning duration, the label carries it
 * (`⚓ Thinking · 12s …`) — dsh-tui's take on making thinking time visible in
 * the transcript.
 */
export function AssistantThinkingMessage({
  thinking,
  textFull,
  addMargin,
  verbose,
  streaming = false,
  preview = false,
  durationMs,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  if (!thinking) return null

  // The preview ticker tracks the newest ARRIVED line (smooth streaming must
  // not lag it behind the reveal); the expanded body below paints `thinking`
  // — the revealed slice under smooth streaming, the full text otherwise.
  const tickerText = textFull ?? thinking

  // Spinner frame (80ms cadence, only while the reasoning is still
  // streaming — same pattern as BtwPanel's answering spinner).
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming) return
    const interval = setInterval(() => setFrame(f => f + 1), THINKING_SPINNER_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [streaming])

  const duration =
    durationMs !== undefined && durationMs >= 1000
      ? ` · ${formatDuration(durationMs)}`
      : ''

  // Kimi Code style blue pulse: the streaming glyph breathes along the
  // header's brand→ice ladder, one sine period per ~7 frames (≈0.56s) —
  // lively without strobing. Minimal mode drops the color (plain glyph);
  // settled always keeps the plain dim anchor.
  const label = `${t('thinking-label')}${duration}${streaming ? '…' : ` ${t('hint-expand-ctrl-o')}`}`
  const minimal = isMinimalMode()
  const pulse = (Math.sin(frame * 0.9) + 1) / 2
  const pulseColor = interpolateColor(BRAND, ICE, pulse)
  const frameText = THINKING_SPINNER_FRAMES[frame % THINKING_SPINNER_FRAMES.length]!
  // Hover 轻指示：可点击折叠时折叠头从 dim 提亮为正常色（不刷整行背景，
  // 转录视觉保持安静）。
  const [hovered, setHovered] = React.useState(false)
  const hoverProps = onClick !== undefined
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {}
  const header =
    streaming ? (
      <Box flexDirection="row">
        <Text>{minimal ? frameText : chalk.rgb(pulseColor.r, pulseColor.g, pulseColor.b).bold(frameText)}</Text>
        {/* 流式行同样可点击折叠（hover 提亮标签给出指示，与落定态一致） */}
        <Text dimColor={!hovered} color={hovered ? 'text' : undefined} italic>{` ${label}`}</Text>
      </Box>
    ) : (
      <Text italic dimColor={!hovered} color={hovered ? 'text' : undefined}>{`${minimal ? '*' : THINKING_SETTLED_MARKER} ${label}`}</Text>
    )

  if (preview) {
    // Live ticker: the model's last few reasoning lines, dimmed, one Text
    // per row so each truncates to the width independently, padded to a
    // constant PREVIEW_ROWS-tall block that follows the stream. The folded
    // summary takes over when the step settles. The LAST row truncates
    // from the start (leading ellipsis) so the newest tokens — which grow
    // at the line's end — stay visible while the line is longer than the
    // width.
    const lines = tickerText.split('\n')
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
        {...hoverProps}
      >
        {header}
        <Box
          flexDirection="column"
          paddingLeft={2}
          height={PREVIEW_ROWS}
          flexShrink={0}
          overflow="hidden"
        >
          {rows.map((line, i) => (
            <Box key={i} flexDirection="row" height={1}>
              {/* The bar is a fixed-width column OUTSIDE the truncating text:
                * ink's truncate-start rewrites the text's leading columns, so
                * a bar inside the text would be eaten by the ellipsis. */}
              <Text dimColor italic>{'│ '}</Text>
              <Box flexDirection="row" flexGrow={1}>
                <Text
                  dimColor
                  italic
                  wrap={i === rows.length - 1 ? 'truncate-start' : 'truncate'}
                >
                  {i === 0 && clipped ? `…${line}` : line}
                </Text>
              </Box>
            </Box>
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
        {...hoverProps}
      >
        {header}
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
      {...hoverProps}
    >
      {header}
      <Box paddingLeft={2}>
        {/* StreamingMarkdown: the live thinking text grows per token — the
          incremental stable-prefix + tail budget keeps the per-frame layout
          cost at O(new content) instead of re-laying out the whole block. */}
        <StreamingMarkdown dimColor>{thinking}</StreamingMarkdown>
      </Box>
    </Box>
  )
}
