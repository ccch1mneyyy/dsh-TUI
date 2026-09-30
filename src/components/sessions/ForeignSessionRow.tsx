import React, { useState } from 'react'
import { Box, Text } from '../../ui.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { useTooltip } from '../Tooltip.js'
import { formatAbsolute, formatProject, formatWhen, truncateWidth } from '../../sessions/format.js'
import type { ForeignSessionRow as ForeignSessionSummary } from '../../adapter/ports/channel-session.js'

/**
 * One conversation of another agent in a source tab: its title, and a facts
 * line with when it last moved and where it ran.
 *
 * It looks like a DSH session row on purpose — the same two lines, the same
 * `❯`, green selection and blue hover (see SessionListRow) — so the tabs read
 * as one screen. It is its own component rather than a shared core so the DSH
 * row stays untouched; the handful of lines below are the whole overlap.
 *
 * Deliberately NO import status. Selecting a row imports it on the spot (or
 * opens the copy an earlier selection made), so "imported or not" is a detail
 * of the selection, not a fact the user has to read before choosing; showing it
 * would also invite a sync the feature does not do.
 *
 * The working directory rides on the facts line here, unlike the DSH row: the
 * rail groups by directory, but a search spans every group of the source and
 * "which project was this" is the question a foreign title answers worst.
 */
export function ForeignSessionRow({
  session,
  width,
  focused,
  home,
  now,
  onClick,
}: {
  session: ForeignSessionSummary
  /** Columns available to the row. */
  width: number
  focused: boolean
  /** Home directory, for collapsing the path to `~`. */
  home: string
  /** Epoch ms used for every relative time in this render pass. */
  now: number
  /** Mouse click: import and open (same path as Enter). */
  onClick?(event: ClickEvent): void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  // Two cells for the focus marker.
  const body = Math.max(8, width - 2)
  const shownTitle = truncateWidth(session.title, Math.max(4, body - 2))
  const titleTooltip = useTooltip(() => {
    const parts: string[] = []
    if (shownTitle !== session.title) parts.push(session.title)
    parts.push(formatAbsolute(session.updatedAt))
    if (session.cwd !== '') parts.push(session.cwd)
    return parts.join('\n')
  })
  const facts = [formatWhen(session.updatedAt, now), formatProject(session.cwd, home)]
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      onClick={onClick}
      onMouseEnter={onClick === undefined ? undefined : () => setHovered(true)}
      onMouseLeave={onClick === undefined ? undefined : () => setHovered(false)}
      // Hover is the blue prompt and never marks the focused row; selection is
      // the green foreground below, as on the DSH row.
      backgroundColor={hovered && !focused ? 'userMessageBackgroundHover' : undefined}
    >
      <Box>
        <Text color={focused ? 'success' : 'subtle'}>{focused ? '❯ ' : '  '}</Text>
        <Box {...titleTooltip}>
          <Text color={focused ? 'success' : undefined} bold={focused}>{shownTitle}</Text>
        </Box>
      </Box>
      <Text color={focused ? 'success' : undefined} dimColor={!focused}>
        {`  ${truncateWidth(facts.join(' · '), body)}`}
      </Text>
    </Box>
  )
}
