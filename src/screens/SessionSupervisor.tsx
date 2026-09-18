import React, { useCallback, useMemo, useRef, useState } from 'react'
import { basename } from 'node:path'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { t } from '../i18n.js'
import type { ContextMenuEvent } from '../ink/events/context-menu-event.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { WheelEvent } from '../ink/events/wheel-event.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SearchBox } from '../components/SearchBox.js'
import { PageInsetContext } from '../components/PageMargin.js'
import { HomeWorkspaceRow } from '../components/workspaces/HomeWorkspaceRow.js'
import { SessionListRow } from '../components/sessions/SessionListRow.js'
import { SpinnerGlyph } from '../components/Spinner/SpinnerGlyph.js'
import { ApprovalPanel } from '../components/approvals/ApprovalPanel.js'
import type { ApprovalSnapshot } from '../dsh-adapter/approvals.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { isPlainReturn, isMod } from '../utils/modifiers.js'
import { truncateWidth } from '../sessions/format.js'
import { normalizeWorkspaceCwd } from '../sessions/view.js'
import { readSessionPins, setSessionPinned } from '../sessionPins.js'
import { readSessionOwners, type SessionMountOwner } from '../sessionMounts.js'
import type { SessionSummary } from '../dsh-adapter/sessions/index.js'
import type { TuiWorkspaceEntry, TuiWorkspaceTarget } from '../workspaces.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import { useSessionSupervisor } from './sessionSupervisor/useSessionSupervisor.js'
import { RAIL_CHROME_ROWS, WORKSPACE_ROW_LINES, RAIL_MIN_TOTAL_COLUMNS, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, SESSION_ROW_LINES, SESSION_PANE_CHROME_ROWS, MenuAction, MENU_ACTIONS, MENU_WIDTH, MENU_HEIGHT, MENU_LABEL_KEYS, SupervisorLiveState, RailEntry, UNREGISTERED_RAIL_ID, message, samePath, sessionMatchesQuery } from './sessionSupervisor/model.js'
export { sessionMatchesQuery }

/**
 * The unified session screen — `/resume`, `/agentview`, `/home` and the 🏠
 * button all land here.
 *
 * Those were three screens over one domain, which is why they kept needing
 * patches to agree with each other. This is the single surface: the workspace
 * rail on the left (the durable ledger a person manages — add, rename,
 * remove), the sessions of the selected workspace on the right, and every
 * session's LIVE state on its own row.
 *
 * The runtime it presents is a single model, and the screen is where that
 * model becomes visible:
 *
 * - This terminal hosts many sessions at once. A row that is `working` keeps
 *   working when you leave it — switching changes what you are looking at, it
 *   does not stop anything. The parked rows stay in the list with a live
 *   glyph, so "where did my other session go" has an answer on screen.
 * - A session held by another TUI terminal is shown as OCCUPIED (red, with the
 *   holder's pid) and cannot be entered. Two processes driving one
 *   append-only session log would interleave its events, so the screen refuses
 *   rather than races; the entry becomes available on its own once that
 *   process exits, because occupancy is proven by liveness rather than by a
 *   flag someone has to remember to clear.
 *
 * @param props - Channel, home directory, the opening/新 actions, and the live
 *   state + occupancy lookups the screen renders from.
 * @returns The screen, or null while the host has no channel to read.
 */
export function SessionSupervisor({
  channel,
  home,
  onClose,
  onOpenSession,
  onNewSession,
  onStopSession,
  approval,
  onApprove,
  liveStateOf,
}: {
  channel: Channel
  /** Home directory, for collapsing paths to `~`. */
  home: string
  /** Leave the screen and show the conversation. */
  onClose(): void
  /** Mount a persisted session (the channel's unified resume path). */
  onOpenSession(sessionId: string): Promise<boolean>
  /** Start a fresh session in the workspace at `path`. */
  onNewSession(target: TuiWorkspaceTarget): Promise<boolean>
  /** Stop a background session of this terminal; false when it is not ours. */
  onStopSession(sessionId: string): Promise<boolean>
  /**
   * The parked approval ask (any session's), so a background session's
   * permission prompt is answerable without leaving this screen — the one
   * thing a parked session cannot wait indefinitely for.
   */
  approval: ApprovalSnapshot | null
  onApprove(outcome: 'allowed-once' | 'rejected'): void
  /**
   * This terminal's live state for a session, or undefined when it has none.
   * Read from the channel's agent-view projection so the list agrees with the
   * overview's own rows by construction.
   */
  liveStateOf(sessionId: string): SupervisorLiveState | undefined
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const inset = React.useContext(PageInsetContext)
  const isTerminalFocused = useTerminalFocus()

  const {
    entries,
    sessions,
    loading,
    notice,
    setNotice,
    query,
    setQuery,
    holderOf,
    listedSessions,
    railEntries,
    countOf,
    railFocus,
    setRailFocus,
    setFocusSessionId,
    activePane,
    pins,
    menu,
    setMenu,
    rename,
    setRename,
    confirmRemove,
    setConfirmRemove,
    railRef,
    menuRef,
    queryRef,
    now,
    reload,
    selected,
    visibleSessions,
    sessionIndex,
    cardFocused,
    sessionAt,
    activateList,
    activateRail,
    railWidth,
    railVisible,
    sessionWidth,
    railEntryCapacity,
    sessionListHeight,
    persistPin,
    selectEntry,
    openSession,
    newSessionIn,
    renameEntry,
    removeEntry,
    stopSession,
    closeMenu,
    activateMenu,
    moveRail,
    moveSession,
    focusedSession,
  } = useSessionSupervisor({ channel, home, onOpenSession, onNewSession, onStopSession, liveStateOf, columns, rows })

  useInput((input, key) => {
    // Modal layers own the keyboard, in the same order they render.
    if (rename !== undefined) {
      if (key.escape) {
        setRename(undefined)
        return
      }
      if (isPlainReturn(key)) {
        const current = rename
        setRename(undefined)
        renameEntry(current.path, current.draft)
        return
      }
      if (key.backspace || key.delete) {
        setRename(current => (current === undefined ? current : { ...current, draft: current.draft.slice(0, -1) }))
        return
      }
      if (!isMod(key) && !key.meta && input && !key.return) {
        const typed = input.replace(/[\r\n]+/gu, '')
        if (typed !== '') setRename(current => (current === undefined ? current : { ...current, draft: current.draft + typed }))
      }
      return
    }
    if (confirmRemove !== undefined) {
      if (isPlainReturn(key)) {
        const path = confirmRemove
        setConfirmRemove(undefined)
        removeEntry(path)
      } else if (key.escape) {
        setConfirmRemove(undefined)
      }
      return
    }
    if (menuRef.current !== undefined) {
      if (key.upArrow) {
        const current = menuRef.current
        const next = { ...current, item: (current.item + MENU_ACTIONS.length - 1) % MENU_ACTIONS.length }
        menuRef.current = next
        setMenu(next)
      } else if (key.downArrow) {
        const current = menuRef.current
        const next = { ...current, item: (current.item + 1) % MENU_ACTIONS.length }
        menuRef.current = next
        setMenu(next)
      } else if (isPlainReturn(key)) {
        const current = menuRef.current
        const entry = railEntries.find(candidate => samePath(candidate.path, current.path))
        if (entry !== undefined) activateMenu(entry, current.item)
      } else {
        closeMenu()
      }
      return
    }

    if (key.escape) {
      if (notice !== undefined) {
        setNotice(undefined)
        return
      }
      if (queryRef.current.length > 0) {
        setQuery('')
        return
      }
      onClose()
      return
    }
    if (key.tab) {
      // Shift+Tab keeps the keyboard route to the focused workspace's action
      // menu. Plain Tab does nothing here: panes are chosen with ←/→ now, and
      // Tab is the composer's business.
      if (key.shift && activePane === 'rail') {
        const entry = railEntries[railRef.current]
        if (entry !== undefined) {
          const next = { path: entry.path, ...keyboardMenuAnchor, item: 0 }
          menuRef.current = next
          setMenu(next)
        }
      }
      return
    }
    // ←/→ choose the column. There is exactly one `❯` on screen because exactly
    // one column owns the keyboard, and this is what moves that ownership.
    if (key.leftArrow) {
      activateRail()
      return
    }
    if (key.rightArrow) {
      activateList()
      return
    }
    if (key.upArrow || key.wheelUp) {
      if (activePane === 'rail') moveRail(-1)
      else moveSession(-1)
      return
    }
    if (key.downArrow || key.wheelDown) {
      if (activePane === 'rail') moveRail(1)
      else moveSession(1)
      return
    }
    if (key.pageUp || key.pageDown) {
      if (activePane === 'list') moveSession(key.pageDown ? 1 : -1)
      else moveRail(key.pageDown ? 1 : -1)
      return
    }
    // The filter is a LIVE query, not a mode you enter: this screen has no
    // second cursor for a text seat, and the rail/list already own the arrows
    // (a seat would have to relearn them). So printable input goes straight to
    // the query — without this branch the box rendered, focused, and could never
    // be typed into.
    if (key.backspace || key.delete) {
      setQuery(text => text.slice(0, -1))
      return
    }
    if (isMod(key) && input === 'n') {
      const entry = railEntries[railRef.current]
      if (entry !== undefined) newSessionIn(entry)
      return
    }
    if (isMod(key) && input === 'l') {
      void reload()
      return
    }
    if (isMod(key) && input === 'x') {
      if (focusedSession !== undefined) stopSession(focusedSession)
      return
    }
    if (isPlainReturn(key)) {
      // Enter means "the thing the active column is showing": its action menu
      // for a workspace, that session for the session list. Ctrl/Cmd+Enter keeps
      // the old "start a session in this workspace" shortcut from either column.
      // Row 0 of the list is the new-session card, so it starts a session
      // instead of opening one.
      if (activePane === 'list') {
        if (sessionIndex === 0) {
          if (selected !== undefined) newSessionIn(selected)
          return
        }
        // `sessionIndex` is derived from the SAME focus fact the render draws
        // `❯` from, so Enter can only ever open the row the user is looking at.
        const session = sessionAt(sessionIndex)
        if (session !== undefined) openSession(session)
        return
      }
      const entry = railEntries[railRef.current]
      if (entry === undefined) return
      if (key.ctrl || key.meta) {
        newSessionIn(entry)
        return
      }
      const next = { path: entry.path, ...keyboardMenuAnchor, item: 0 }
      menuRef.current = next
      setMenu(next)
      return
    }
    // Reached only when nothing above claimed the key: printable characters
    // refine the filter. Control bytes are dropped so a terminal reporting an
    // unknown key cannot type an invisible glyph into the query.
    if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
      const typed = input.replace(/\p{Cc}/gu, '')
      if (typed.length > 0) setQuery(text => text + typed)
    }
  })

  // Working rows animate their glyph. The shared clock only runs while at
  // least one row is working, so an idle screen costs no extra ticks.
  const workingCount = listedSessions.filter(
    session => liveStateOf(session.id)?.status === 'working',
  ).length
  const [, spinnerTime] = useAnimationFrame(workingCount > 0 ? 120 : null)
  const spinnerFrame = Math.floor(spinnerTime / 120)

  const railHint = rename !== undefined
    ? t('home-hint-rename')
    : confirmRemove !== undefined
      ? t('home-hint-confirm-remove')
      : menu !== undefined
        ? t('home-hint-menu')
        : activePane === 'rail'
          ? t('home-hint-list')
          : t('supervisor-hint-list')

  const railWindowTopIndex = railWindowTop(railFocus, railEntries.length, railEntryCapacity)
  const visibleRailRows = railEntries.slice(railWindowTopIndex, railWindowTopIndex + railEntryCapacity)
  /** Content-local anchor for a keyboard-opened menu (screen coords minus inset). */
  const keyboardMenuAnchor = { col: inset.x + 2, row: inset.y + 3 }
  const filtered = query.trim().length > 0

  // Scroll window over the session rows, keeping the focused row visible
  // without re-shuffling the list under a stationary cursor.
  //
  // The new-session card is a permanent row above this window, so the window is
  // one card shorter and the cursor is expressed in the FULL list's space (card =
  // 0): without that offset the window kept its old height and the cursor could
  // land on a row that never made it on screen — a `❯` on an invisible row.
  const capacity = Math.max(1, Math.floor(sessionListHeight / SESSION_ROW_LINES))
  const sessionCapacity = Math.max(1, capacity - 1)
  let sessionTop = Math.min(
    Math.max(0, sessionIndex - 1 - sessionCapacity + 1),
    Math.max(0, visibleSessions.length - sessionCapacity),
  )
  if (sessionIndex - 1 < sessionTop) sessionTop = Math.max(0, sessionIndex - 1)
  const visibleSessionRows = visibleSessions.slice(sessionTop, sessionTop + sessionCapacity)

  const liveCount = listedSessions.filter(session => liveStateOf(session.id)?.live === true).length

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      onClick={menu !== undefined ? closeMenu : undefined}
    >
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color="remember" bold>{` ▣ ${t('supervisor-title')}`}</Text>
        <Text dimColor>{`  ${t('supervisor-subtitle')}`}</Text>
      </Box>
      <Divider bleed />
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        {railVisible && (
          <ink-box
            style={{ flexDirection: 'column', width: railWidth, height: '100%', flexShrink: 0, overflow: 'hidden' }}
            onClick={activateRail}
            onMouseEnter={activateRail}
            onWheel={(event: WheelEvent): void => {
              moveRail(event.deltaY >= 0 ? 1 : -1)
            }}
          >
            <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
              <Text dimColor>{truncateWidth(t('home-section-workspaces', { n: railEntries.length }), railWidth - 2)}</Text>
            </Box>
            {!loading && railEntries.length === 0 && (
              <Box paddingX={1}>
                <Text dimColor italic wrap="truncate-end">{truncateWidth(t('home-no-workspaces'), railWidth - 2)}</Text>
              </Box>
            )}
            {visibleRailRows.map((entry) => {
              const absolute = railEntries.indexOf(entry)
              return (
                <HomeWorkspaceRow
                  key={entry.id}
                  title={entry.title}
                  path={entry.path}
                  home={home}
                  sessionCount={countOf(entry)}
                  present={entry.present}
                  selected={selected !== undefined && selected.id === entry.id}
                  focused={activePane === 'rail' && railFocus === absolute}
                  width={railWidth}
                  onSelect={(event): void => {
                    event.stopImmediatePropagation()
                    railRef.current = absolute
                    setRailFocus(absolute)
                    selectEntry(entry)
                  }}
                  onMenu={(event: ContextMenuEvent): void => {
                    event.stopImmediatePropagation()
                    railRef.current = absolute
                    setRailFocus(absolute)
                    const next = { path: entry.path, col: event.col, row: event.row, item: 0 }
                    menuRef.current = next
                    setMenu(next)
                  }}
                />
              )
            })}
            <Box flexGrow={1} />
            <Box flexShrink={0} paddingX={1}>
              <Text dimColor italic><HintLine text={railHint} /></Text>
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
              <Text color="remember" bold>{truncateWidth(` ${t('home-sessions-title', { name: selected?.title ?? t('supervisor-title') })}`, Math.max(4, sessionWidth - 3))}</Text>
              <Text dimColor>
                {`  ${truncateWidth(
                  t('supervisor-counts', { working: workingCount, live: liveCount, total: visibleSessions.length }),
                  Math.max(4, sessionWidth - 3),
                )}`}
              </Text>
            </Box>
          </Box>
          <Box height={1} flexShrink={0} paddingX={1}>
            {/* Always live: the keyboard feeds this query on every printable
                key (see useInput), so a box that is "unfocused" while the
                cursor rests on the first rail entry would be a lie — and it is
                exactly where the cursor starts. */}
            <SearchBox
              query={query}
              isFocused={activePane === 'list'}
              isTerminalFocused={isTerminalFocused}
              placeholder={truncateWidth(t('supervisor-filter-placeholder'), Math.max(8, sessionWidth - 6))}
              prefix="/"
              borderless
              width={Math.max(8, sessionWidth - 2)}
            />
          </Box>
          {/* Start a session in the workspace this pane is showing.
              It lives HERE — first thing under the filter, one session card
              tall — rather than in the title row: as a right-aligned header
              control it was too easy to miss, and this is the shape every other
              row in the pane has. It is also the only affordance that works when
              the pane is EMPTY, which is exactly when the list has nothing to
              offer. It sits above the scroll window on purpose, so it never
              scrolls away from the user who needs it. */}
          <Box
            flexDirection="column"
            flexShrink={0}
            onClick={(event: ClickEvent): void => {
              event.stopImmediatePropagation()
              if (selected !== undefined) newSessionIn(selected)
            }}
          >
            {/* Row 0 of the session list, so it carries the cursor like any
                other card — and only while the cursor is actually on it. */}
            <Box height={1} flexShrink={0} overflow="hidden">
              <Text color={cardFocused ? 'success' : 'subtle'}>{cardFocused ? '❯ ' : '  '}</Text>
              <Text color={cardFocused ? 'success' : undefined} bold={cardFocused}>{t('supervisor-new-session')}</Text>
            </Box>
            <Box height={1} flexShrink={0} overflow="hidden">
              <Text dimColor>{`  ${truncateWidth(t('supervisor-new-session-hint', { name: selected?.title ?? t('supervisor-title') }), Math.max(8, sessionWidth - 3))}`}</Text>
            </Box>
          </Box>
          <ink-box
            style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}
            onWheel={(event: WheelEvent): void => {
              moveSession(event.deltaY >= 0 ? 1 : -1)
            }}
          >
            {loading && <Text dimColor italic>{` ${truncateWidth(t('home-sessions-loading'), sessionWidth - 2)}`}</Text>}
            {!loading && visibleSessions.length === 0 && (
              <Text dimColor italic>
                {` ${truncateWidth(filtered ? t('supervisor-no-matches') : t('home-no-sessions'), sessionWidth - 2)}`}
              </Text>
            )}
            {visibleSessionRows.map((session, index) => {
              const state = liveStateOf(session.id)
              const holder = holderOf(session.id)
              return (
                <SessionListRow
                  key={session.id}
                  session={session}
                  width={sessionWidth}
                  depth={0}
                  focused={activePane === 'list' && sessionTop + index + 1 === sessionIndex}
                  pinned={pins.has(session.id)}
                  now={now}
                  liveStatus={state?.live === true ? state.status : undefined}
                  current={state?.current === true}
                  occupiedPid={holder}
                  spinner={{ frame: spinnerFrame, time: spinnerTime }}
                  onClick={(event): void => {
                    event.stopImmediatePropagation()
                    setFocusSessionId(session.id)
                    openSession(session)
                  }}
                  onTogglePin={(): void => {
                    setFocusSessionId(session.id)
                    persistPin(session.id, !pins.has(session.id))
                  }}
                  onContextMenu={(event): void => {
                    setFocusSessionId(session.id)
                    const entry = selected
                    if (entry === undefined) return
                    const next = { path: entry.path, col: event.col, row: event.row, item: 0 }
                    menuRef.current = next
                    setMenu(next)
                  }}
                />
              )
            })}
          </ink-box>
          <Box flexShrink={0} height={1} overflow="hidden">
            <Text color={notice?.tone === 'error' ? 'error' : 'success'}>
              {notice === undefined ? ' ' : ` ${truncateWidth(notice.text, Math.max(0, sessionWidth - 3))}`}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor italic>
              <HintLine text={filtered ? t('supervisor-hint-filter') : t('supervisor-hint-list')} />
            </Text>
          </Box>
        </Box>
      </Box>

      {rename !== undefined && (
        <Box height={1} flexShrink={0}>
          <SearchBox
            query={rename.draft}
            isFocused
            isTerminalFocused={isTerminalFocused}
            placeholder={t('home-rename-placeholder')}
            prefix="✎"
            borderless
            width="100%"
          />
        </Box>
      )}
      {confirmRemove !== undefined && (
        <Box flexShrink={0} paddingX={1} onClick={(): void => {
          const path = confirmRemove
          setConfirmRemove(undefined)
          removeEntry(path)
        }}>
          <Text color="error">
            {truncateWidth(
              ` ${t('home-remove-title', { name: railEntries.find(entry => samePath(entry.path, confirmRemove))?.title ?? confirmRemove })} · ${t('home-remove-detail')}`,
              columns - 3,
            )}
          </Text>
        </Box>
      )}

      {menu !== undefined && (
        <Box
          position="absolute"
          left={Math.max(0, Math.min(menu.col - inset.x + 1, Math.max(0, columns - MENU_WIDTH)))}
          top={Math.max(0, Math.min(menu.row - inset.y + 1, Math.max(0, rows - MENU_HEIGHT)))}
          width={MENU_WIDTH}
          height={MENU_HEIGHT}
          flexDirection="column"
          flexShrink={0}
          borderStyle="round"
          borderColor="permission"
          backgroundColor="toolCardBackground"
        >
          {MENU_ACTIONS.map((action, index) => (
            <Box
              key={action}
              height={1}
              flexShrink={0}
              backgroundColor={index === menu.item ? 'userMessageBackgroundHover' : undefined}
              onMouseEnter={(): void => setMenu(current => (current === undefined ? current : { ...current, item: index }))}
              onClick={(event): void => {
                event.stopImmediatePropagation()
                const entry = railEntries.find(candidate => samePath(candidate.path, menu.path))
                if (entry !== undefined) activateMenu(entry, index)
              }}
            >
              <Text color={action === 'remove' ? 'error' : undefined}>
                {` ${index === menu.item ? '❯' : ' '} ${t(MENU_LABEL_KEYS[action])}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/*
        A parked approval outranks everything on this screen: a background
        session that is waiting for permission is stopped until it is answered,
        and the user is looking at the list of sessions precisely when they
        want to know which one that is. It renders below the panes rather than
        over them so the row it belongs to stays visible while answering.
      */}
      {approval !== null && (
        <Box flexShrink={0} flexDirection="column" position="absolute" bottom={1} left={0} width={columns}>
          <ApprovalPanel
            approval={approval}
            background={approval.agentId !== channel.agentId}
            onDecide={onApprove}
          />
        </Box>
      )}

    </Box>
  )
}

/**
 * Scroll anchor for the rail: the first entry index to show.
 *
 * A pure helper (exported for the headless regression) because the rail's
 * window has to hold the focused row without re-shuffling under a stationary
 * cursor — the same anchoring rule the session list uses.
 *
 * `focus` is a plain entry index: the rail's rows ARE the ledger, so the cursor
 * and the selection are one position and the window math takes that position
 * directly. It used to be offset by the `+` row that led the rail, which is
 * gone — a workspace joins the ledger by being a terminal's launch directory.
 *
 * `capacity` is a count of ENTRIES, not of terminal rows. It used to be handed
 * the row count, which is wrong for this list in a way that hides the cursor:
 * each entry is {@link WORKSPACE_ROW_LINES} rows tall, so treating rows as
 * entries made the window believe it could show twice as many workspaces as it
 * can, and the focused entry was simply clipped away by `overflow="hidden"`
 * while the user navigated it blind.
 */
export function railWindowTop(focus: number, entryCount: number, capacity: number): number {
  const entries = Math.max(1, capacity)
  if (focus < 0) return 0
  let top = Math.max(0, focus - entries + 1)
  if (focus < top) top = focus
  if (focus >= top + entries) top = focus - entries + 1
  return Math.min(top, Math.max(0, entryCount - entries))
}

/** Re-exported so a regression can drive the spinner without importing ink. */
export { SpinnerGlyph }
