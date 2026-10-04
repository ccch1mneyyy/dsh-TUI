import React from 'react'
import { Box, Text } from '../../ui.js'
import { formatDuration } from '../../trajectory/format.js'
import { t } from '../../i18n.js'
import type { InspectDetail } from '../../dsh-adapter/trajectory/index.js'
import type { TrajNode } from '../../dsh-adapter/types.js'

/**
 * The inspector — full detail for the focused row, in a fixed-height slot.
 *
 * Two properties matter more than what it shows:
 *
 * **It follows the cursor with no keystroke.** Moving down updates it; there
 * is no "open" step. That is one decision removed from the most common action
 * in the view, and it is the reason a run of rows can be triaged by holding
 * ↓ rather than by opening and closing each one.
 *
 * **Its height never changes.** A pane that grew with its content would resize
 * the frame on every cursor move — the exact motion that takes inline
 * rendering down the shrink-frame path. Fixed geometry means moving the cursor
 * emits style bytes and nothing else. `Enter` opens the same content as a
 * full-height page, which is a deliberate, once-per-inspection resize.
 */
export function Inspector({
  node,
  detail,
  height,
  width,
  expanded,
  scroll,
}: {
  node: TrajNode | undefined
  detail: InspectDetail | undefined
  /** Rows this pane occupies, borders included. Never varies with content. */
  height: number
  width: number
  /** True when `Enter` has promoted the pane to a full-height reading page. */
  expanded: boolean
  /** First body line to show, for paging an expanded pane. */
  scroll: number
}): React.ReactNode {
  const bodyHeight = Math.max(1, height - 1)

  if (node === undefined || detail === undefined) {
    return (
      <Box flexDirection="column" height={height} flexShrink={0}>
        <Text color="subtle">—</Text>
      </Box>
    )
  }

  // Flatten every section into display lines up front, so paging and
  // clipping operate on one uniform list.
  const lines: { text: string; tone?: 'error' | 'dim'; head?: boolean }[] = []
  // 还在等的审批/问卷行没有 durationMs，这里按渲染时刻算已等待时长；
  // 场景与侧栏都在动画帧上重渲染，这行会随等待走动。
  if (node.kind === 'approval' && node.status === 'running') {
    lines.push({ text: t('trajectory-wait-elapsed', { duration: formatDuration(Math.max(0, Date.now() - node.time)) }) })
  }
  if (detail.unresolved === true) {
    lines.push({ text: t('trajectory-inspect-unavailable'), tone: 'dim' })
  }
  for (const section of detail.sections) {
    // A lone section whose heading repeats the pane title (a message row's
    // `assistant` under `assistant`) spends a line saying nothing.
    const redundant =
      detail.sections.length === 1 && section.title.toLowerCase() === detail.title.toLowerCase()
    if (!redundant) lines.push({ text: section.title, tone: section.tone, head: true })
    for (const raw of section.body.split('\n')) {
      // Tabs would break column alignment inside the pane.
      lines.push({ text: raw.replace(/\t/g, '  '), tone: section.tone })
    }
  }

  // The pane always paints exactly `height` rows: one header plus bodyHeight
  // body rows, the last of which becomes the overflow marker when content
  // runs past the slot, and blank padding when it does not. Anything that
  // varied the row count here would resize the frame on every cursor move.
  const overflow = lines.length - scroll > bodyHeight
  const visibleCount = overflow ? bodyHeight - 1 : bodyHeight
  const clipped = lines.slice(scroll, scroll + visibleCount)
  const hidden = lines.length - scroll - visibleCount
  const body: (typeof lines[number] | null)[] = Array.from({ length: bodyHeight }, (_, index) => clipped[index] ?? null)
  const status = node.status === 'error' ? 'error' : node.status === 'running' ? 'success' : 'inactive'

  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      <Box flexDirection="row" gap={1} width="100%">
        <Text color={status} bold>
          {'▎'}
          {detail.title}
        </Text>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate" color="subtle">
            {detail.facts.join(' · ')}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={status}>
            {node.durationMs === undefined ? '' : formatDuration(node.durationMs)}
          </Text>
        </Box>
      </Box>
      {body.map((line, index) => {
        const isMarker = overflow && index === bodyHeight - 1
        if (isMarker) {
          return (
            <Box key="more" width="100%" overflow="hidden">
              <Text color="subtle" wrap="truncate">
                {`    …${hidden} more · ${expanded ? 'j/k' : 'enter'}`}
              </Text>
            </Box>
          )
        }
        if (line === null) {
          return (
            <Box key={index} width="100%">
              <Text> </Text>
            </Box>
          )
        }
        return (
          <Box key={index} width="100%" overflow="hidden">
            <Text
              wrap="truncate"
              bold={line.head}
              color={
                line.head
                  ? line.tone === 'error'
                    ? 'error'
                    : 'permission'
                  : line.tone === 'error'
                    ? 'error'
                    : line.tone === 'dim'
                      ? 'subtle'
                      : 'inactiveShimmer'
              }
            >
              {line.head ? `  ${line.text}` : `    ${line.text.slice(0, Math.max(0, width - 6))}`}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
