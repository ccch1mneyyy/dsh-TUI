import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import type { WheelEvent } from '../../ink/events/wheel-event.js'
import { HintLine } from '../../components/design-system/HintLine.js'
import { SearchBox } from '../../components/SearchBox.js'
import { HomeWorkspaceRow } from '../../components/workspaces/HomeWorkspaceRow.js'
import { ForeignSessionRow } from '../../components/sessions/ForeignSessionRow.js'
import { truncateWidth } from '../../sessions/format.js'
import { SESSION_ROW_LINES } from './model.js'
import type { ForeignSessionsModel } from './useForeignSessions.js'

/**
 * Chrome the right pane of a source tab spends outside its rows: the screen
 * header and divider, the pane banner, the filter, the notice and the hints.
 * Two rows fewer than the DSH pane, which also carries the new-session card.
 */
export const FOREIGN_PANE_CHROME_ROWS = 6

/**
 * First visible row of a scroll window that keeps `focus` on screen, the same
 * anchoring the DSH list uses.
 * @param focus - Cursor index.
 * @param total - Rows in the list.
 * @param capacity - Rows the window shows.
 * @returns Index of the first row to draw.
 */
export function windowTop(focus: number, total: number, capacity: number): number {
  const size = Math.max(1, capacity)
  const top = Math.max(0, focus - size + 1)
  return Math.min(top, Math.max(0, total - size))
}

/**
 * The two panes of a source tab: the source's directories on the left, the
 * conversations of the selected one on the right.
 *
 * Presentational only; every value and action comes from
 * {@link ForeignSessionsModel}. The shape follows the DSH panes on purpose so
 * the tabs read as one screen, with what a foreign source cannot do removed:
 * no workspace menu (the rail is derived, not a ledger), no new-session card,
 * no live state and no pins.
 */
export function ForeignSessionPanes({
  model,
  sourceLabel,
  home,
  now,
  query,
  notice,
  railVisible,
  railWidth,
  railEntryCapacity,
  sessionWidth,
  rows,
  isTerminalFocused,
  filterFocused,
  cursorActive,
  onFilterFocus,
}: {
  model: ForeignSessionsModel
  /** The active source's display name. */
  sourceLabel: string
  home: string
  now: number
  query: string
  notice: { text: string; tone: 'info' | 'error' } | undefined
  railVisible: boolean
  railWidth: number
  railEntryCapacity: number
  sessionWidth: number
  /** Terminal rows of the whole screen. */
  rows: number
  isTerminalFocused: boolean
  filterFocused: boolean
  cursorActive: boolean
  onFilterFocus(focused: boolean): void
}): React.ReactNode {
  const { groups, selected, railFocus, visibleRows, rowIndex, pane, loading } = model
  const searchCursor = filterFocused || (!railVisible && pane === 'rail') || (pane === 'list' && visibleRows.length === 0)
  const activateRail = (): void => {
    onFilterFocus(false)
    model.activateRail()
  }
  const activateList = (): void => {
    onFilterFocus(false)
    model.activateList()
  }
  const filtered = query.trim().length > 0

  const railTop = windowTop(railFocus, groups.length, railEntryCapacity)
  const railRows = groups.slice(railTop, railTop + railEntryCapacity)

  const capacity = Math.max(1, Math.floor(Math.max(SESSION_ROW_LINES, rows - FOREIGN_PANE_CHROME_ROWS) / SESSION_ROW_LINES))
  const listTop = windowTop(rowIndex, visibleRows.length, capacity)
  const listRows = visibleRows.slice(listTop, listTop + capacity)

  const groupName = selected?.title ?? sourceLabel
  // The rail carries its own hint; this one is always the list's, as on DSH.
  const hint = filtered ? t('supervisor-foreign-hint-filter') : t('supervisor-foreign-hint-list')

  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
      {railVisible && (
        <ink-box
          style={{ flexDirection: 'column', width: railWidth, height: '100%', flexShrink: 0, overflow: 'hidden' }}
          onClick={activateRail}
          onMouseEnter={activateRail}
          onWheel={(event: WheelEvent): void => {
            onFilterFocus(false)
            model.moveRail(event.deltaY >= 0 ? 1 : -1)
          }}
        >
          <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
            <Text dimColor>{truncateWidth(t('home-section-workspaces', { n: groups.length }), railWidth - 2)}</Text>
          </Box>
          {!loading && groups.length === 0 && (
            <Box paddingX={1}>
              <Text dimColor italic wrap="truncate-end">{truncateWidth(t('supervisor-foreign-empty', { source: sourceLabel }), railWidth - 2)}</Text>
            </Box>
          )}
          {railRows.map((group) => {
            const absolute = groups.indexOf(group)
            return (
              <HomeWorkspaceRow
                key={group.key}
                title={group.title}
                path={group.path}
                home={home}
                sessionCount={group.rows.length}
                present={group.present}
                selected={selected?.key === group.key}
                focused={pane === 'rail' && railFocus === absolute}
                declareCursor={cursorActive && !searchCursor}
                width={railWidth}
                onSelect={(event): void => {
                  event.stopImmediatePropagation()
                  onFilterFocus(false)
                  model.selectGroup(group)
                }}
              />
            )
          })}
          <Box flexGrow={1} />
          <Box flexShrink={0} paddingX={1}>
            <Text dimColor italic><HintLine text={t('supervisor-foreign-hint-rail')} /></Text>
          </Box>
        </ink-box>
      )}

      {railVisible && (
        <Box width={1} flexShrink={0} flexDirection="column">
          <Text dimColor>{'│'}</Text>
        </Box>
      )}

      <Box
        flexDirection="column"
        width={sessionWidth}
        height="100%"
        flexShrink={0}
        overflow="hidden"
        onClick={activateList}
        onMouseEnter={activateList}
      >
        <Box height={1} flexShrink={0} overflow="hidden">
          <Box flexShrink={1} overflow="hidden">
            <Text color="remember" bold>
              {truncateWidth(` ${t('supervisor-foreign-sessions-title', { source: sourceLabel, name: groupName })}`, Math.max(4, sessionWidth - 3))}
            </Text>
            <Text dimColor>
              {`  ${truncateWidth(t('supervisor-foreign-count', { total: visibleRows.length }), Math.max(4, sessionWidth - 3))}`}
            </Text>
          </Box>
        </Box>
        <Box height={1} flexShrink={0} paddingX={1} onClick={event => {
          event.stopImmediatePropagation()
          model.activateList()
          onFilterFocus(true)
        }} onMouseEnter={event => {
          event.stopImmediatePropagation()
          if (pane !== 'list') model.activateList()
          onFilterFocus(true)
        }}>
          <SearchBox
            query={query}
            isFocused={pane === 'list' || searchCursor}
            declareCursor={cursorActive && searchCursor}
            isTerminalFocused={isTerminalFocused}
            placeholder={truncateWidth(t('supervisor-foreign-filter-placeholder'), Math.max(8, sessionWidth - 6))}
            prefix="/"
            borderless
            width={Math.max(8, sessionWidth - 2)}
          />
        </Box>
        <ink-box
          style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}
          onMouseEnter={() => onFilterFocus(false)}
          onWheel={(event: WheelEvent): void => {
            onFilterFocus(false)
            model.moveList(event.deltaY >= 0 ? 1 : -1)
          }}
        >
          {loading && <Text dimColor italic>{` ${truncateWidth(t('supervisor-foreign-loading', { source: sourceLabel }), sessionWidth - 2)}`}</Text>}
          {!loading && visibleRows.length === 0 && (
            <Text dimColor italic>
              {` ${truncateWidth(filtered ? t('supervisor-no-matches') : t('supervisor-foreign-empty', { source: sourceLabel }), sessionWidth - 2)}`}
            </Text>
          )}
          {listRows.map((row, index) => (
            <ForeignSessionRow
              key={row.key}
              session={row}
              width={sessionWidth}
              focused={pane === 'list' && listTop + index === rowIndex}
              declareCursor={cursorActive && !searchCursor}
              home={home}
              now={now}
              onClick={(event): void => {
                event.stopImmediatePropagation()
                model.focusRow(row)
                model.openRow(row)
              }}
            />
          ))}
        </ink-box>
        <Box flexShrink={0} height={1} overflow="hidden">
          <Text color={notice?.tone === 'error' ? 'error' : 'success'}>
            {notice === undefined ? ' ' : ` ${truncateWidth(notice.text, Math.max(0, sessionWidth - 3))}`}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor italic>
            <HintLine text={hint} />
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
