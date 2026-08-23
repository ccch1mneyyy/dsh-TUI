import React from 'react'
import { Box, Text, useTheme } from '../../ui.js'
import { getTheme } from '../../theme.js'
import { formatDuration, formatTokens, truncateWidth } from '../../trajectory/format.js'
import { mix, reproject } from '../../trajectory/motion.js'
import { t } from '../../i18n.js'
import type { HotspotRow, HotspotSort, TrajAggregate } from '../../dsh-adapter/types.js'

/**
 * The hotspot view — the session ranked by cost instead of ordered by time.
 *
 * Chronology is the wrong order for "where did my half hour go": the answer is
 * a ranking, and a ranking is what this shows — cost per tool, per model phase
 * (decode vs. waiting for the first token vs. retry backoff), per turn.
 *
 * The three sections are flattened into ONE windowed row list rather than laid
 * out as three independent columns. A long session easily produces more rows
 * than the viewport has lines, and three self-sizing sections in a fixed-height
 * box overlap each other when they overflow — a flat window scrolls instead,
 * and the cursor can reach every row.
 *
 * The reveal is a staggered brightening rather than a growing bar. A bar that
 * grew would change its glyph count every frame, which is a layout change, and
 * layout changes are the one thing the motion rules forbid. Sweeping colour
 * across already-final bars reads the same and costs style bytes.
 */

/** Bar cells; a half block gives one extra step of resolution for free. */
const FULL = '█'
const HALF = '▌'

function bar(value: number, max: number, width: number): string {
  if (max <= 0 || width <= 0) return ''
  const exact = (value / max) * width
  const full = Math.max(0, Math.min(width, Math.floor(exact)))
  return FULL.repeat(full) + (exact - full >= 0.5 && full < width ? HALF : '')
}

/** A section heading or one ranked row, in display order. */
type Entry =
  | { readonly kind: 'title'; readonly text: string }
  | {
      readonly kind: 'row'
      readonly row: HotspotRow
      /** Index into the flattened row list the cursor walks. */
      readonly cursorIndex: number
      /** Largest value in this row's own section, for bar scaling. */
      readonly max: number
      readonly colorKey: 'chromeYellow' | 'autoAccept' | 'professionalBlue'
    }

/** Flatten the three sections into the single list the cursor walks. */
export function hotspotRows(agg: TrajAggregate): HotspotRow[] {
  return [...agg.tools, ...agg.model, ...agg.turns]
}

/** Value a row is ranked by under the active sort. */
function valueOf(row: HotspotRow, sort: HotspotSort): number {
  return sort === 'count' ? row.count : sort === 'tokens' ? row.tokens : row.totalMs
}

export function HotspotView({
  agg,
  sort,
  width,
  height,
  cursor,
  tick,
  switchTick,
  onRowClick,
}: {
  agg: TrajAggregate
  sort: HotspotSort
  width: number
  height: number
  cursor: number
  tick: number
  switchTick: number
  /**
   * Mouse pick (fullscreen): reports the clicked row's cursor index — the
   * scene jumps back to the timeline positioned on the group's first member
   * (same path as the keyboard Enter). Hover shows a dim `▸` pointer.
   */
  onRowClick?: (cursorIndex: number) => void
}): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const [hoverIndex, setHoverIndex] = React.useState(-1)

  const labelWidth = Math.min(18, Math.max(10, Math.floor(width * 0.16)))
  const barWidth = Math.max(6, Math.min(30, width - labelWidth - 34))

  // Build the flat list once, tagging each row with its section's scale.
  const entries: Entry[] = []
  let cursorIndex = 0
  for (const [title, rows, colorKey] of [
    [t('traj-hot-tools'), agg.tools, 'chromeYellow'],
    [t('traj-hot-model'), agg.model, 'autoAccept'],
    [t('traj-hot-turns'), agg.turns, 'professionalBlue'],
  ] as const) {
    if (rows.length === 0) continue
    entries.push({ kind: 'title', text: title })
    const max = Math.max(...rows.map(row => valueOf(row, sort)), 1)
    for (const row of rows) {
      entries.push({ kind: 'row', row, cursorIndex, max, colorKey })
      cursorIndex += 1
    }
  }

  // Window around the cursor's entry so ↑/↓ can reach every section.
  const focusEntry = entries.findIndex(entry => entry.kind === 'row' && entry.cursorIndex === cursor)
  const start = Math.max(0, Math.min(focusEntry - Math.floor(height / 2), entries.length - height))
  const visible = entries.slice(Math.max(0, start), Math.max(0, start) + height)

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      {visible.map((entry, offset) => {
        if (entry.kind === 'title') {
          return (
            <Box key={`t${offset}`} width="100%" height={1} flexShrink={0}>
              <Text color="subtle">{entry.text}</Text>
            </Box>
          )
        }
        const { row, max, colorKey } = entry
        const focused = entry.cursorIndex === cursor
        // 鼠标：行点击跳回 timeline 定位；悬停轻指示（dim ▸，不刷背景）
        const hovered = onRowClick !== undefined && hoverIndex === entry.cursorIndex
        // Stagger the settle by row so a section reads top-down on switch.
        const dim = reproject(tick - offset, switchTick)
        const base = row.error === true ? theme.error : theme[colorKey]
        const stats =
          `${row.count}×` +
          (row.tokens > 0 ? ` · ${formatTokens(row.tokens)}` : '') +
          (row.count > 0 && row.totalMs > 0 ? ` · ⌀${formatDuration(row.totalMs / row.count)}` : '')
        return (
          <Box
            key={`r${entry.cursorIndex}`}
            flexDirection="row"
            width="100%"
            height={1}
            flexShrink={0}
            gap={1}
            onClick={onRowClick === undefined ? undefined : () => onRowClick(entry.cursorIndex)}
            onMouseEnter={onRowClick === undefined ? undefined : () => setHoverIndex(entry.cursorIndex)}
            onMouseLeave={
              onRowClick === undefined
                ? undefined
                : () => setHoverIndex(previous => (previous === entry.cursorIndex ? -1 : previous))
            }
          >
            <Box flexShrink={0} width={2}>
              <Text color={focused ? 'suggestion' : 'inactive'}>{focused || hovered ? '▸' : ' '}</Text>
            </Box>
            <Box flexShrink={0} width={labelWidth}>
              <Text color={focused ? 'suggestion' : row.error === true ? 'error' : undefined}>
                {truncateWidth(row.label, labelWidth)}
              </Text>
            </Box>
            <Box flexShrink={0} width={barWidth}>
              <Text color={mix(base as string, theme.background as string, dim)}>
                {bar(valueOf(row, sort), max, barWidth)}
              </Text>
            </Box>
            <Box flexShrink={0} width={8} justifyContent="flex-end">
              <Text bold color={row.error === true ? 'error' : undefined}>
                {formatDuration(row.totalMs)}
              </Text>
            </Box>
            <Box flexShrink={1} overflow="hidden">
              <Text color="subtle">{truncateWidth(stats, Math.max(4, width - labelWidth - barWidth - 16))}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
