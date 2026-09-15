import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { WheelEvent } from '../../ink/events/wheel-event.js'
import { SessionListRow } from '../sessions/SessionListRow.js'
import { Divider } from '../design-system/Divider.js'
import { HintLine } from '../design-system/HintLine.js'
import { truncateWidth } from '../../sessions/format.js'
import type { SessionSummary } from '../../dsh-adapter/sessions/index.js'

/** One-line banner row above the list (title + count, or a transient notice). */
function PaneBanner({
  left,
  right,
  width,
  tone,
}: {
  left: string
  right?: string
  width: number
  tone?: 'info' | 'error'
}): React.ReactNode {
  const body = Math.max(4, width - 3)
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text color={tone === 'error' ? 'error' : 'remember'} bold>
        {truncateWidth(` ${left}`, body)}
      </Text>
      {right !== undefined && <Text dimColor>{`  ${truncateWidth(right, body)}`}</Text>}
    </Box>
  )
}

/**
 * The home screen's right column: the sessions of the selected workspace.
 *
 * Deliberately NOT the `/resume` browser. That screen is a search surface over
 * every session on the machine, with its own scope/all-projects model; this one
 * is scoped by the rail the user just clicked, so the list must never widen on
 * its own. What it does share with the browser is the row rendering and the
 * focus/identity discipline — the cursor is a session id, not an index, because
 * rows reorder under a reload and an index would silently point at a different
 * conversation by the time Enter arrives.
 */
export function HomeSessionPane({
  workspaceName,
  sessions,
  loading,
  focusedIndex,
  focusId,
  pinnedIds,
  notice,
  listHeight,
  width,
  now,
  onFocus,
  onOpen,
  onTogglePin,
  onWheel,
  onContextMenu,
}: {
  workspaceName: string
  /** Sessions whose recorded cwd is this workspace, newest first. */
  sessions: readonly SessionSummary[]
  loading: boolean
  /** Focused row index within `sessions`. */
  focusedIndex: number
  /** Focused session id (the identity the cursor is restored from). */
  focusId: string | undefined
  pinnedIds: ReadonlySet<string>
  notice: { text: string; tone: 'info' | 'error' } | undefined
  /** Lines available to the list itself. */
  listHeight: number
  width: number
  now: number
  onFocus(index: number): void
  onOpen(session: SessionSummary): void
  onTogglePin(session: SessionSummary): void
  onWheel(event: WheelEvent): void
  onContextMenu(session: SessionSummary, event: { col: number; row: number }): void
}): React.ReactNode {
  const body = Math.max(8, width - 2)
  const counts = t('home-sessions-count', { n: sessions.length })
  // Scroll window: keep the focused row visible without re-shuffling the list
  // under a stationary cursor. Rows are two lines each (title + facts).
  const ROW_LINES = 2
  const capacity = Math.max(1, Math.floor(listHeight / ROW_LINES))
  let top = Math.min(
    Math.max(0, focusedIndex - capacity + 1),
    Math.max(0, sessions.length - capacity),
  )
  if (focusedIndex < top) top = focusedIndex
  const visible = sessions.slice(top, top + capacity)

  return (
    <Box flexDirection="column" width={width} height="100%" flexShrink={0} overflow="hidden">
      <PaneBanner left={t('home-sessions-title', { name: workspaceName })} right={counts} width={width} />
      <Divider bleed />
      <ink-box
        style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}
        onWheel={onWheel}
      >
        {loading && <Text dimColor italic>{` ${truncateWidth(t('home-sessions-loading'), body)}`}</Text>}
        {!loading && sessions.length === 0 && (
          <Text dimColor italic>{` ${truncateWidth(t('home-no-sessions'), body)}`}</Text>
        )}
        {visible.map((session, index) => (
          <SessionListRow
            key={session.id}
            session={session}
            width={width}
            depth={0}
            focused={top + index === focusedIndex}
            pinned={pinnedIds.has(session.id)}
            now={now}
            onClick={(event: ClickEvent): void => {
              event.stopImmediatePropagation()
              onFocus(top + index)
              onOpen(session)
            }}
            onTogglePin={() => {
              onFocus(top + index)
              onTogglePin(session)
            }}
            onContextMenu={(event): void => {
              onFocus(top + index)
              onContextMenu(session, { col: event.col, row: event.row })
            }}
          />
        ))}
      </ink-box>
      <Box flexShrink={0} height={1} overflow="hidden">
        <Text color={notice?.tone === 'error' ? 'error' : 'success'}>
          {notice === undefined ? ' ' : ` ${truncateWidth(notice.text, body)}`}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor italic><HintLine text={t('home-hint-list')} /></Text>
      </Box>
    </Box>
  )
}
