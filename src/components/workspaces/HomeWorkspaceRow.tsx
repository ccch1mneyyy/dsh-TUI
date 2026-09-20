import React, { useState } from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { ContextMenuEvent } from '../../ink/events/context-menu-event.js'
import { formatProject, spreadRow, truncateWidth } from '../../sessions/format.js'

/**
 * One workspace in the home screen's left rail.
 *
 * Two lines, like every other navigable row in this app: the name line is what
 * the user named it, the detail line is where it actually is and how much is in
 * it. The path is not decoration — two workspaces can carry the same basename
 * (`.../a/work` and `.../b/work`), and the ledger allows duplicate titles, so
 * the path is the only thing that tells them apart.
 *
 * Widths are resolved here rather than left to flexbox for the same reason the
 * session rows resolve them: a row must be exactly two lines at every terminal
 * width, and a wrapped row destroys the alignment a list is scanned by.
 */
export function HomeWorkspaceRow({
  title,
  path,
  home,
  sessionCount,
  present,
  selected,
  focused,
  width,
  onSelect,
  onMenu,
}: {
  title: string
  /** Canonical directory path recorded in the ledger. */
  path: string
  /** Home directory, for collapsing the path to `~`. */
  home: string
  sessionCount: number
  /** False when the recorded directory no longer exists. */
  present: boolean
  /** Whether this workspace's sessions are the ones on the right. */
  selected: boolean
  /** Keyboard cursor. */
  focused: boolean
  /** Columns available to the row. */
  width: number
  /** Left click: show this workspace's sessions (same path as Enter). */
  onSelect?(event: ClickEvent): void
  /** Right click: open the workspace action menu. */
  onMenu?(event: ContextMenuEvent): void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  const body = Math.max(8, width - 4)
  // The presence marker leads the badge on purpose: `spreadRow` may truncate
  // the right-hand segment, and "this directory is gone" is the one fact that
  // must never be the part that gets cut (the session count is also visible in
  // the pane, the missing directory is not).
  const count = t('home-sessions-count', { n: sessionCount })
  const badge = present ? count : `${t('home-workspace-missing')} · ${count}`
  const heading = spreadRow(`${selected ? '▣' : '▢'} ${title}`, `${selected ? '✓ ' : ''}${badge}`, body)
  const detail = formatProject(path, home)
  // The cursor (green) outranks the selection ring (green); both outrank the
  // idle colour. Blue is not part of this ladder at all — see the background.
  const headingColor = (focused || selected) ? 'success' : present ? 'text' : 'inactive'

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      onClick={onSelect}
      onContextMenu={onMenu}
      onMouseEnter={onSelect === undefined && onMenu === undefined ? undefined : () => setHovered(true)}
      onMouseLeave={onSelect === undefined && onMenu === undefined ? undefined : () => setHovered(false)}
      // Hover is the BLUE prompt — pointer feedback and nothing else, so it
      // never marks the focused or the selected row. Selection itself is green
      // in the text, which is why this row draws no box while selected.
      backgroundColor={hovered && !focused ? 'userMessageBackgroundHover' : undefined}
    >
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={focused ? 'success' : 'subtle'}>{focused ? '❯ ' : '  '}</Text>
        <Text color={headingColor} bold={focused || selected}>
          {heading.left}
        </Text>
        <Text dimColor={!focused}>{`${' '.repeat(heading.gap)}${heading.right}`}</Text>
      </Box>
      <Text color={(focused || selected) ? 'success' : undefined} dimColor={!(focused || selected)} wrap="truncate-end">{`  ${truncateWidth(detail, body - 2)}`}</Text>
    </Box>
  )
}

/**
 * The `+` row that opens the directory picker.
 *
 * Deliberately the FIRST row of the rail and always clickable: adding a
 * workspace is the rail's only creation action, and a control that is only
 * reachable by keyboard is a control most users never find in a terminal.
 */
export function HomeAddWorkspaceRow({
  focused,
  width,
  onOpen,
}: {
  focused: boolean
  width: number
  onOpen?(event: ClickEvent): void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  const body = Math.max(8, width - 4)
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      onClick={onOpen}
      onMouseEnter={onOpen === undefined ? undefined : () => setHovered(true)}
      onMouseLeave={onOpen === undefined ? undefined : () => setHovered(false)}
      backgroundColor={focused || hovered ? 'userMessageBackgroundHover' : undefined}
    >
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={focused ? 'suggestion' : 'subtle'}>{focused ? '❯ ' : '  '}</Text>
        <Text color="remember" bold>{`＋ ${t('home-add-workspace')}`}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">{`  ${truncateWidth(t('home-add-hint'), body - 2)}`}</Text>
    </Box>
  )
}
