import React from 'react'
import { Box, Text } from '../ui.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import type { SessionRecord } from '../sessionHistory.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { SearchBox } from './SearchBox.js'
import { modLabel } from '../utils/modifiers.js'

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

/** Interaction mode of the `/resume` picker (issue #112). */
export type ResumePickerMode = 'list' | 'confirm-delete' | 'rename'

/**
 * `/resume` session picker in the CC ModelPicker style: a Pane with the
 * recent sessions as Select rows (title + time description, ✓ on the
 * current session), plus the hint line. Only WINDOW rows render; the window
 * follows the focused row, with `↑ N more` / `↓ N more` markers at the
 * edges.
 *
 * Beyond plain selection (pi-tui style session management, issue #112):
 *  - `confirm-delete` replaces the hints with a delete confirmation for the
 *    focused session (Enter deletes, Esc backs out);
 *  - `rename` shows an inline SearchBox editing the focused session's title
 *    (Enter saves, Esc discards).
 * Keyboard handling lives in the caller (Chat).
 */
export function ResumePicker({
  sessions,
  focusIndex,
  currentSessionId,
  mode,
  renameText,
}: {
  sessions: readonly SessionRecord[]
  focusIndex: number
  currentSessionId: string
  mode: ResumePickerMode
  renameText: string
}): React.ReactNode {
  const isTerminalFocused = useTerminalFocus()
  const start = Math.max(
    0,
    Math.min(focusIndex - Math.floor(WINDOW / 2), sessions.length - WINDOW),
  )
  const visible = sessions.slice(start, start + WINDOW)
  const above = start
  const below = Math.max(0, sessions.length - (start + WINDOW))
  const focused = sessions[focusIndex]

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
        {mode === 'confirm-delete' && focused !== undefined && (
          <Box marginTop={1}>
            <Text color="error">
              Delete “{focused.title || focused.id}”? The session log is removed permanently.
            </Text>
          </Box>
        )}
        {mode === 'rename' && (
          <Box marginTop={1}>
            <SearchBox
              query={renameText}
              isFocused
              isTerminalFocused={isTerminalFocused}
              placeholder="New session name…"
              prefix="✎"
              borderless
            />
          </Box>
        )}
      </Box>
      <Text dimColor italic>
        {mode === 'list' ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" bold />
            <KeyboardShortcutHint shortcut="Esc" action="exit" />
            <KeyboardShortcutHint shortcut={`${modLabel}d`} action="delete" />
            <KeyboardShortcutHint shortcut={`${modLabel}r`} action="rename" />
          </Byline>
        ) : mode === 'confirm-delete' ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="delete" bold />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="save" bold />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        )}
      </Text>
    </Pane>
  )
}
