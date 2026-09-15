import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { t } from '../i18n.js'
import type { ContextMenuEvent } from '../ink/events/context-menu-event.js'
import type { WheelEvent } from '../ink/events/wheel-event.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SearchBox } from '../components/SearchBox.js'
import { PageInsetContext } from '../components/PageMargin.js'
import { HomeAddWorkspaceRow, HomeWorkspaceRow } from '../components/workspaces/HomeWorkspaceRow.js'
import { HomeSessionPane } from '../components/workspaces/HomeSessionPane.js'
import { NewWorkspaceDialog } from '../components/workspaces/NewWorkspaceDialog.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { isPlainReturn, isMod } from '../utils/modifiers.js'
import { truncateWidth } from '../sessions/format.js'
import { normalizeWorkspaceCwd } from '../sessions/view.js'
import { readSessionPins, setSessionPinned } from '../sessionPins.js'
import type { SessionSummary } from '../dsh-adapter/sessions/index.js'
import type { TuiWorkspaceEntry, TuiWorkspaceTarget } from '../workspaces.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'

/** Rows the left rail always keeps: the header, the `+` row, the hints. */
const RAIL_CHROME_ROWS = 4
/** Width the rail gets when the terminal is wide enough to show both panes. */
const RAIL_MIN_TOTAL_COLUMNS = 84
const RAIL_WIDTH_MIN = 24
const RAIL_WIDTH_MAX = 38

type MenuAction = 'edit' | 'new' | 'rename' | 'remove'
const MENU_ACTIONS: readonly MenuAction[] = ['edit', 'new', 'rename', 'remove']
const MENU_WIDTH = 30
/** One confirm line + its explanation. */
const MENU_HEIGHT = MENU_ACTIONS.length + 2

const MENU_LABEL_KEYS = {
  edit: 'home-menu-edit',
  new: 'home-menu-new',
  rename: 'home-menu-rename',
  remove: 'home-menu-remove',
} as const

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Case-insensitive path equality, matching the workspace ledger's own rule. */
function samePath(left: string, right: string): boolean {
  return normalizeWorkspaceCwd(left) === normalizeWorkspaceCwd(right)
}

/**
 * The workspace home screen — the TUI's GUI-like landing surface.
 *
 * Two panes, both mouse-driven and both fully keyboard-navigable:
 *
 * - LEFT: the durable workspace list. Every workspace the user ever registered
 *   is a row (an empty one included, and one whose directory has since been
 *   deleted), with a `+` row on top that opens a directory picker, and a
 *   right-click menu (or `Shift+F10`) offering rename / remove / new session.
 * - RIGHT: the sessions recorded in the selected workspace.
 *
 * It replaces the conversation rather than floating above it — the same early
 * return every other screen in this app uses — so the transcript underneath is
 * never repainted, scrolled, or bled through.
 *
 * The workspace data is NOT owned here: entries come from the durable DSH
 * workspace registry (`channel.listWorkspaceRegistry`), and every mutation goes
 * back through the channel (`registerWorkspace` / `renameWorkspaceAt` /
 * `removeWorkspace`), so this screen has no storage of its own and the Web UI
 * sees the same list.
 */
export function WorkspaceHome({
  channel,
  home,
  onClose,
  onOpenSession,
  onNewSession,
}: {
  channel: Channel
  /** Home directory, for collapsing paths to `~`. */
  home: string
  /** Leave the screen and show the conversation. */
  onClose(): void
  /** Adopt a persisted session (the channel's `/resume` path). */
  onOpenSession(sessionId: string): Promise<boolean>
  /** Start a fresh session in the workspace at `path`. */
  onNewSession(target: TuiWorkspaceTarget): Promise<boolean>
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const inset = React.useContext(PageInsetContext)
  const isTerminalFocused = useTerminalFocus()

  const [entries, setEntries] = useState<readonly TuiWorkspaceEntry[]>([])
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  /**
   * Sessions eligible for the home screen, computed ONCE per listing.
   *
   * The same predicate feeds the rail's per-workspace counts and the pane's
   * list, so the number on a workspace row always equals the number of rows
   * clicking it produces. A separate count for the rail is how those two drift.
   */
  const listedSessions = useMemo(
    () => sessions.filter(session => session.hasPrompt && session.kind.kind !== 'subagent'),
    [sessions],
  )

  const [railFocus, setRailFocus] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  const [sessionFocus, setSessionFocus] = useState(0)
  const [focusSessionId, setFocusSessionId] = useState<string | undefined>(undefined)
  const [pins, setPins] = useState<ReadonlySet<string>>(() => readSessionPins())

  const [pickerOpen, setPickerOpen] = useState(false)
  const [menu, setMenu] = useState<{ path: string; col: number; row: number; item: number } | undefined>(undefined)
  const [rename, setRename] = useState<{ path: string; draft: string } | undefined>(undefined)
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>(undefined)

  const railRef = useRef(railFocus)
  railRef.current = railFocus
  const menuRef = useRef(menu)
  menuRef.current = menu
  const sessionFocusRef = useRef(sessionFocus)
  sessionFocusRef.current = sessionFocus

  const now = Date.now()

  /**
   * Reload the ledger and the session listing together.
   *
   * One `listSessions()` pass feeds every workspace: the ledger holds session
   * ids already, but the listing carries the display facts (title, recency,
   * model, branch) this screen shows, and re-reading the whole store per
   * workspace click would be both slower and inconsistent between panes.
   */
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [registry, listed] = await Promise.all([
        channel.listWorkspaceRegistry(),
        channel.listSessions(),
      ])
      setEntries(registry)
      setSessions(listed)
      setNotice((current) => (current?.tone === 'error' ? undefined : current))
    } catch (error) {
      setNotice({ text: t('home-sessions-failed', { err: message(error) }), tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [channel])

  React.useEffect(() => {
    void reload()
  }, [reload])

  // Selection follows the ledger: a removed workspace (or a first load) falls
  // back to the first entry, so the right pane is never pointing at nothing.
  React.useEffect(() => {
    if (entries.length === 0) {
      if (selectedPath !== undefined) setSelectedPath(undefined)
      return
    }
    if (selectedPath !== undefined && entries.some(entry => samePath(entry.path, selectedPath))) return
    setSelectedPath(entries[0]!.path)
  }, [entries, selectedPath])

  const selected = useMemo(
    () => entries.find(entry => selectedPath !== undefined && samePath(entry.path, selectedPath)) ?? entries[0],
    [entries, selectedPath],
  )
  /** Sessions whose recorded cwd is the selected workspace — never any other. */
  const visibleSessions = useMemo(() => {
    if (selected === undefined) return []
    return listedSessions
      .filter(session => samePath(session.cwd, selected.path))
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [listedSessions, selected])

  // Cursor identity: the ledger moves rows on register/rename, and the session
  // list reorders on every reload, so the cursor follows an ID rather than an
  // index.
  const sessionIndex = useMemo(() => {
    if (visibleSessions.length === 0) return 0
    const byId = visibleSessions.findIndex(session => session.id === focusSessionId)
    return byId >= 0 ? byId : 0
  }, [visibleSessions, focusSessionId])

  const railWidth = columns >= RAIL_MIN_TOTAL_COLUMNS
    ? Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.floor(columns * 0.3)))
    : columns
  const railVisible = columns >= RAIL_MIN_TOTAL_COLUMNS
  const sessionWidth = Math.max(20, columns - (railVisible ? railWidth + 1 : 0))
  const railListHeight = Math.max(1, rows - RAIL_CHROME_ROWS)

  const report = useCallback((text: string, tone: 'info' | 'error'): void => {
    setNotice({ text, tone })
  }, [])

  const persistPin = useCallback((id: string, pinned: boolean): void => {
    const result = setSessionPinned(id, pinned)
    if (!result.ok) {
      report(t('resume-pin-save-failed'), 'error')
      return
    }
    setPins(result.pins)
  }, [report])

  const selectEntry = useCallback((path: string): void => {
    setSelectedPath(path)
    setFocusSessionId(undefined)
    setSessionFocus(0)
    sessionFocusRef.current = 0
  }, [])

  const openSession = useCallback((session: SessionSummary): void => {
    setNotice(undefined)
    void onOpenSession(session.id)
      .then((ok) => {
        // The channel already reported WHY it refused (one shared wording via
        // `resumeFailureText`); this screen only has to stay put.
        if (!ok) report(t('session-resume-failed', { err: '' }), 'error')
      })
      .catch(error => report(t('session-resume-failed', { err: message(error) }), 'error'))
  }, [onOpenSession, report])

  const newSessionIn = useCallback((entry: TuiWorkspaceEntry): void => {
    if (channel.working) {
      report(t('home-working'), 'error')
      return
    }
    setNotice(undefined)
    void channel.resolveWorkspace(entry.path)
      .then((target) => {
        if (target === undefined) {
          report(t('workspace-open-invalid', { target: entry.path }), 'error')
          return undefined
        }
        return onNewSession(target).then((ok) => {
          if (!ok) report(t('new-session-failed', { err: '' }), 'error')
          return ok
        })
      })
      .catch(error => report(t('new-session-failed', { err: message(error) }), 'error'))
  }, [channel, onNewSession, report])

  const registerWorkspace = useCallback(async (path: string): Promise<boolean> => {
    try {
      const added = await channel.registerWorkspace(path)
      if (added === undefined) {
        report(t('workspace-open-invalid', { target: path }), 'error')
        return false
      }
      await reload()
      selectEntry(added.path)
      report(t('workspace-added', { title: added.title }), 'info')
      return true
    } catch (error) {
      report(t('workspace-open-invalid', { target: `${path} · ${message(error)}` }), 'error')
      return false
    }
  }, [channel, reload, report, selectEntry])

  const renameEntry = useCallback((path: string, title: string): void => {
    const next = title.trim()
    if (next === '') {
      report(t('home-rename-empty'), 'error')
      return
    }
    void channel.renameWorkspaceAt(path, next)
      .then((ok) => {
        if (ok) return reload()
        report(t('home-rename-failed', { err: '' }), 'error')
        return undefined
      })
      .catch(error => report(t('home-rename-failed', { err: message(error) }), 'error'))
  }, [channel, reload, report])

  const removeEntry = useCallback((path: string): void => {
    if (channel.working && selected !== undefined && samePath(selected.path, path)) {
      report(t('home-remove-working'), 'error')
      return
    }
    void channel.removeWorkspace(path)
      .then((ok) => {
        if (ok) return reload()
        report(t('workspace-remove-unknown', { target: path }), 'error')
        return undefined
      })
      .catch(error => report(t('workspace-remove-failed', { err: message(error) }), 'error'))
  }, [channel, reload, report, selected])

  const closeMenu = useCallback((): void => {
    menuRef.current = undefined
    setMenu(undefined)
  }, [])

  const activateMenu = useCallback((entry: TuiWorkspaceEntry, item: number): void => {
    closeMenu()
    const action: MenuAction = MENU_ACTIONS[item] ?? 'edit'
    if (action === 'edit') selectEntry(entry.path)
    else if (action === 'new') newSessionIn(entry)
    else if (action === 'rename') setRename({ path: entry.path, draft: entry.title })
    else setConfirmRemove(entry.path)
  }, [closeMenu, newSessionIn, selectEntry])

  const moveRail = useCallback((by: 1 | -1): void => {
    // Row 0 is the `+`; entries start at 1.
    const total = entries.length + 1
    const next = (railRef.current + by + total) % total
    railRef.current = next
    setRailFocus(next)
    if (next > 0) {
      const entry = entries[next - 1]
      if (entry !== undefined) selectEntry(entry.path)
    }
  }, [entries, selectEntry])

  const moveSession = useCallback((by: 1 | -1): void => {
    if (visibleSessions.length === 0) return
    const next = (sessionFocusRef.current + by + visibleSessions.length) % visibleSessions.length
    sessionFocusRef.current = next
    setSessionFocus(next)
    const landed = visibleSessions[next]
    if (landed !== undefined) setFocusSessionId(landed.id)
  }, [visibleSessions])

  useInput((input, key) => {
    // Modal layers own the keyboard, in the same order they render.
    if (pickerOpen) return
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
        const entry = entries.find(candidate => samePath(candidate.path, current.path))
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
      onClose()
      return
    }
    if (key.tab) {
      // Pane switch: Tab moves the cursor between the rail and the session
      // list, which is the whole point of a two-pane layout.
      if (railRef.current === 0 && key.shift) {
        setPickerOpen(true)
        return
      }
      if (key.shift) {
        const entry = entries[railRef.current - 1]
        if (entry !== undefined) {
          const next = { path: entry.path, ...keyboardMenuAnchor, item: 0 }
          menuRef.current = next
          setMenu(next)
        }
        return
      }
      // Focus currently lives in the rail; hand it to the sessions (or back).
      return
    }
    if (key.leftArrow) {
      if (railRef.current === 0) setPickerOpen(true)
      else {
        const entry = entries[railRef.current - 1]
        if (entry !== undefined) {
          const next = { path: entry.path, ...keyboardMenuAnchor, item: 0 }
          menuRef.current = next
          setMenu(next)
        }
      }
      return
    }
    if (key.upArrow || key.wheelUp) {
      moveRail(-1)
      return
    }
    if (key.downArrow || key.wheelDown) {
      moveRail(1)
      return
    }
    if (key.pageUp || key.pageDown) {
      moveRail(key.pageDown ? 1 : -1)
      return
    }
    if (isMod(key) && input === 'n') {
      const entry = entries[Math.max(0, railRef.current - 1)]
      if (entry !== undefined) newSessionIn(entry)
      return
    }
    if (isMod(key) && input === 'l') {
      void reload()
      return
    }
    if (isPlainReturn(key)) {
      if (railRef.current === 0) {
        setPickerOpen(true)
        return
      }
      const entry = entries[railRef.current - 1]
      if (entry === undefined) return
      if (key.ctrl || key.meta) {
        newSessionIn(entry)
        return
      }
      const session = visibleSessions[sessionFocusRef.current]
      if (session !== undefined && selected !== undefined && samePath(entry.path, selected.path)) openSession(session)
      else newSessionIn(entry)
    }
  })

  const railHint = rename !== undefined
    ? t('home-hint-rename')
    : confirmRemove !== undefined
      ? t('home-hint-confirm-remove')
      : menu !== undefined
        ? t('home-hint-menu')
        : t('home-hint-list')

  const railWindowTopIndex = railWindowTop(railFocus, entries.length, railListHeight)
  const visibleRailRows = entries.slice(railWindowTopIndex, railWindowTopIndex + Math.max(1, railListHeight - 1))
  /** Content-local anchor for a keyboard-opened menu (screen coords minus inset). */
  const keyboardMenuAnchor = { col: inset.x + 2, row: inset.y + 3 }

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      onClick={menu !== undefined ? closeMenu : undefined}
    >
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color="remember" bold>{` ▣ ${t('home-title')}`}</Text>
        <Text dimColor>{`  ${t('home-subtitle')}`}</Text>
      </Box>
      <Divider bleed />
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        {railVisible && (
          <ink-box
            style={{ flexDirection: 'column', width: railWidth, height: '100%', flexShrink: 0, overflow: 'hidden' }}
            onWheel={(event: WheelEvent): void => {
              moveRail(event.deltaY >= 0 ? 1 : -1)
            }}
          >
            <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
              <Text dimColor>{truncateWidth(t('home-section-workspaces', { n: entries.length }), railWidth - 2)}</Text>
            </Box>
            <HomeAddWorkspaceRow
              focused={railFocus === 0}
              width={railWidth}
              onOpen={(event): void => {
                event.stopImmediatePropagation()
                railRef.current = 0
                setRailFocus(0)
                setPickerOpen(true)
              }}
            />
            {!loading && entries.length === 0 && (
              <Box paddingX={1}>
                <Text dimColor italic wrap="truncate-end">{truncateWidth(t('home-no-workspaces'), railWidth - 2)}</Text>
              </Box>
            )}
            {visibleRailRows.map((entry, index) => {
              const absolute = entries.indexOf(entry)
              return (
                <HomeWorkspaceRow
                  key={entry.id}
                  title={entry.title}
                  path={entry.path}
                  home={home}
                  sessionCount={listedSessions.filter(session => samePath(session.cwd, entry.path)).length}
                  present={entry.present}
                  selected={selected !== undefined && samePath(selected.path, entry.path)}
                  focused={railFocus === absolute + 1}
                  width={railWidth}
                  onSelect={(event): void => {
                    event.stopImmediatePropagation()
                    railRef.current = absolute + 1
                    setRailFocus(absolute + 1)
                    selectEntry(entry.path)
                  }}
                  onMenu={(event: ContextMenuEvent): void => {
                    event.stopImmediatePropagation()
                    railRef.current = absolute + 1
                    setRailFocus(absolute + 1)
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

        <HomeSessionPane
          workspaceName={selected?.title ?? t('home-title')}
          sessions={visibleSessions}
          loading={loading}
          focusedIndex={sessionIndex}
          focusId={focusSessionId}
          pinnedIds={pins}
          notice={notice}
          listHeight={Math.max(1, rows - 7)}
          width={sessionWidth}
          now={now}
          onFocus={(index): void => {
            sessionFocusRef.current = index
            setSessionFocus(index)
          }}
          onOpen={openSession}
          onTogglePin={(session): void => persistPin(session.id, !pins.has(session.id))}
          onWheel={(event: WheelEvent): void => {
            moveSession(event.deltaY >= 0 ? 1 : -1)
          }}
          onContextMenu={(_session, at): void => {
            const entry = selected
            if (entry === undefined) return
            const next = { path: entry.path, col: at.col, row: at.row, item: 0 }
            menuRef.current = next
            setMenu(next)
          }}
        />
      </Box>

      {/* Rename editor: replaces the rail's hint row while open, exactly like
          the session browser's rename mode — the list above stays visible. */}
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
              ` ${t('home-remove-title', { name: entries.find(entry => samePath(entry.path, confirmRemove))?.title ?? confirmRemove })} · ${t('home-remove-detail')}`,
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
                const entry = entries.find(candidate => samePath(candidate.path, menu.path))
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

      {pickerOpen && (
        <NewWorkspaceDialog
          startPath={selected?.path ?? channel.cwd}
          onAdd={registerWorkspace}
          onClose={(): void => setPickerOpen(false)}
          onNotice={report}
        />
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
 */
export function railWindowTop(focus: number, entryCount: number, railListHeight: number): number {
  const capacity = Math.max(1, railListHeight - 1)
  const focusedEntry = focus - 1
  if (focusedEntry < 0) return 0
  let top = Math.max(0, focusedEntry - capacity + 1)
  if (focusedEntry < top) top = focusedEntry
  if (focusedEntry >= top + capacity) top = focusedEntry - capacity + 1
  return Math.min(top, Math.max(0, entryCount - capacity))
}
