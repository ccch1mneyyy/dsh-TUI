import React from 'react'
import { Box, Text } from '../ui.js'
import type { SessionRecord } from '../sessionHistory.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

/** Compact timestamp like `Jan 2, 03:04` for the resume list. */
function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** Visible list window: the picker scrolls instead of dumping every session
 *  (long histories would fill the whole screen otherwise). */
const WINDOW = 8

/**
 * `/resume` session picker in the CC ModelPicker style: a Pane with the
 * recent sessions as Select rows (title + time description, ✓ on the
 * current session), plus the Enter/Esc hint line. Only WINDOW rows render;
 * the window follows the focused row, with `↑ N more` / `↓ N more` markers
 * at the edges.
 */
export function ResumePicker({
  sessions,
  focusIndex,
  currentSessionId,
}: {
  sessions: readonly SessionRecord[]
  focusIndex: number
  currentSessionId: string
}): React.ReactNode {
  const start = Math.max(
    0,
    Math.min(focusIndex - Math.floor(WINDOW / 2), sessions.length - WINDOW),
  )
  const visible = sessions.slice(start, start + WINDOW)
  const above = start
  const below = Math.max(0, sessions.length - (start + WINDOW))

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            Resume
          </Text>
        </Box>
        {above > 0 && (
          <Text dimColor italic>
            ↑ {above} more
          </Text>
        )}
        {visible.map(session => (
          <ListItem
            key={session.id}
            isFocused={session.id === sessions[focusIndex]?.id}
            isSelected={session.id === currentSessionId}
            description={formatTimestamp(session.updatedAt)}
          >
            {session.title || session.id}
          </ListItem>
        ))}
        {below > 0 && (
          <Text dimColor italic>
            ↓ {below} more
          </Text>
        )}
      </Box>
      <Text dimColor italic>
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="confirm" bold />
          <KeyboardShortcutHint shortcut="Esc" action="exit" />
        </Byline>
      </Text>
    </Pane>
  )
}
