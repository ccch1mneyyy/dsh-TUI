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
import { NewWorkspaceDialog } from '../components/workspaces/NewWorkspaceDialog.js'
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
import type { SessionSummary } from '../dsh-adapter/sessions/index.js'
import type { TuiWorkspaceEntry, TuiWorkspaceTarget } from '../workspaces.js'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'

/** Rows the left rail always keeps: the header, the `+` row, the hints. */
const RAIL_CHROME_ROWS = 4
/** Width the rail gets when the terminal is wide enough to show both panes. */
const RAIL_MIN_TOTAL_COLUMNS = 84
const RAIL_WIDTH_MIN = 24
const RAIL_WIDTH_MAX = 38
/** Two lines per session row (title + facts), plus the filter and notice rows. */
const SESSION_ROW_LINES = 2
/** Chrome the right pane spends on banner, filter, notice and hints. */
const SESSION_PANE_CHROME_ROWS = 6

type MenuAction = 'open' | 'new' | 'current' | 'rename' | 'remove'
const MENU_ACTIONS: readonly MenuAction[] = ['open', 'new', 'current', 'rename', 'remove']
const MENU_WIDTH = 30
/** One confirm line + its explanation. */
const MENU_HEIGHT = MENU_ACTIONS.length + 2

const MENU_LABEL_KEYS = {
  open: 'home-menu-open',
  new: 'home-menu-new',
  current: 'home-menu-set-current',
  rename: 'home-menu-rename',
  remove: 'home-menu-remove',
} as const

/**
 * What this terminal knows about one session's live state, from the channel's
 * agent-view projection. Absent for a session this process never mounted.
 */
export interface SupervisorLiveState {
  /** The row status vocabulary the overview column already uses. */
  readonly status: 'working' | 'needs-input' | 'idle' | 'completed' | 'failed' | 'stopped'
  /** True when an agent for this session is alive in THIS process. */
  readonly live: boolean
  /** True when this is the session the terminal is attached to. */
  readonly current: boolean
  /** One-line activity summary. */
  readonly summary: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Case-insensitive path equality, matching the workspace ledger's own rule. */
function samePath(left: string, right: string): boolean {
  return normalizeWorkspaceCwd(left) === normalizeWorkspaceCwd(right)
}

/**
 * Case-insensitive substring match over the fields a person searches by.
 *
 * Title and label are the obvious ones; the working directory and branch are
 * included because "which of these three look-alike sessions" is usually
 * answered by where it ran and what it was on, not by its truncated title.
 * @param session - The session to test.
 * @param needle - Lower-cased query; empty matches everything.
 * @returns True when the session should stay visible.
 */
export function sessionMatchesQuery(session: SessionSummary, needle: string): boolean {
  if (needle.length === 0) return true
  const haystack = [
    session.title.text,
    session.label ?? '',
    session.cwd,
    session.branch ?? '',
    session.model ?? '',
  ].join('\n').toLowerCase()
  return haystack.includes(needle)
}

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
  occupancyOf,
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
  /**
   * The pid holding a session in ANOTHER TUI process, or undefined when it is
   * free or already ours. Read from the cross-process ledger.
   */
  occupancyOf(sessionId: string): number | undefined
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const inset = React.useContext(PageInsetContext)
  const isTerminalFocused = useTerminalFocus()

  const [entries, setEntries] = useState<readonly TuiWorkspaceEntry[]>([])
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  /** Live status and occupancy are re-read on their own clock, not the listing's. */
  const [pulse, setPulse] = useState(0)
  const [query, setQuery] = useState('')

  /**
   * Sessions eligible for this screen, computed ONCE per listing so the rail's
   * per-workspace counts and the pane's rows always agree.
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
  const queryRef = useRef(query)
  queryRef.current = query

  const now = Date.now()

  /**
   * One cheap tick that re-derives live status and cross-process occupancy.
   *
   * Deliberately NOT a re-listing: the listing is the expensive part (a stat
   * per session and a revision-keyed digest), while status and occupancy are
   * two in-memory reads over data the process already holds. So the tick is
   * affordable at a rate that keeps `/resume` honest about a sibling
   * terminal — the user sees another TUI take or release a session while
   * looking at the screen, without this screen re-reading the session store.
   */
  React.useEffect(() => {
    const timer = setInterval(() => setPulse(value => value + 1), 2000)
    return () => clearInterval(timer)
  }, [])

  /**
   * Reload the ledger and the session listing together.
   *
   * One `listSessions()` pass feeds every workspace: re-reading the whole
   * store per workspace click would be both slower and inconsistent between
   * the two panes.
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

  /**
   * Sessions whose recorded cwd is the selected workspace, minus the search
   * filter. Live sessions in this workspace sort above stopped ones, then by
   * recency: what this terminal is currently running is what the user is
   * most likely switching between.
   */
  const visibleSessions = useMemo(() => {
    if (selected === undefined) return []
    const needle = query.trim().toLowerCase()
    void pulse
    return listedSessions
      .filter(session => samePath(session.cwd, selected.path))
      .filter(session => sessionMatchesQuery(session, needle))
      .slice()
      .sort((left, right) => {
        const leftLive = liveStateOf(left.id)?.live === true ? 1 : 0
        const rightLive = liveStateOf(right.id)?.live === true ? 1 : 0
        return rightLive - leftLive || right.updatedAt - left.updatedAt
      })
  }, [listedSessions, selected, query, liveStateOf, pulse])

  // Cursor identity: rows reorder on every reload and filter, so the cursor
  // follows an ID rather than an index.
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
  const sessionListHeight = Math.max(
    SESSION_ROW_LINES,
    rows - SESSION_PANE_CHROME_ROWS,
  )

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

  /**
   * Mount a session, refusing one another terminal holds.
   *
   * The occupancy test runs here as well as in the adapter: the adapter's is
   * the authority (it must hold for every caller), but checking first lets the
   * screen say WHICH terminal owns the session instead of reporting a generic
   * failure, and keeps a refused row from looking like a broken one.
   */
  const openSession = useCallback((session: SessionSummary): void => {
    const holder = occupancyOf(session.id)
    if (holder !== undefined) {
      report(t('supervisor-occupied', { pid: holder }), 'error')
      return
    }
    setNotice(undefined)
    void onOpenSession(session.id)
      .then((ok) => {
        if (!ok) report(t('session-resume-failed', { err: '' }), 'error')
      })
      .catch(error => report(t('session-resume-failed', { err: message(error) }), 'error'))
  }, [occupancyOf, onOpenSession, report])

  const newSessionIn = useCallback((entry: TuiWorkspaceEntry): void => {
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
    void channel.removeWorkspace(path)
      .then((ok) => {
        if (ok) return reload()
        report(t('workspace-remove-unknown', { target: path }), 'error')
        return undefined
      })
      .catch(error => report(t('workspace-remove-failed', { err: message(error) }), 'error'))
  }, [channel, reload, report])

  /** Stop a parked background session; the attached one is not stoppable. */
  const stopSession = useCallback((session: SessionSummary): void => {
    const state = liveStateOf(session.id)
    if (state?.current === true) {
      report(t('supervisor-stop-current'), 'error')
      return
    }
    if (state?.live !== true) return
    void onStopSession(session.id)
      .then((stopped) => {
        report(
          stopped ? t('supervisor-stopped', { name: session.title.text }) : t('supervisor-stop-failed'),
          stopped ? 'info' : 'error',
        )
      })
      .catch((error: unknown) => report(t('supervisor-stop-failed') + ` · ${message(error)}`, 'error'))
  }, [liveStateOf, onStopSession, report])

  const closeMenu = useCallback((): void => {
    menuRef.current = undefined
    setMenu(undefined)
  }, [])

  const activateMenu = useCallback((entry: TuiWorkspaceEntry, item: number): void => {
    closeMenu()
    const action: MenuAction = MENU_ACTIONS[item] ?? 'open'
    if (action === 'open') selectEntry(entry.path)
    else if (action === 'new') newSessionIn(entry)
    else if (action === 'current') selectEntry(entry.path)
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

  const focusedSession = visibleSessions[sessionIndex]

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
      if (queryRef.current.length > 0) {
        setQuery('')
        return
      }
      onClose()
      return
    }
    if (key.tab) {
      // Shift+Tab on the `+` row opens the directory picker, matching the rail.
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
      }
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
    if (isMod(key) && input === 'x') {
      if (focusedSession !== undefined) stopSession(focusedSession)
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
        : t('home-hint-list')

  const railWindowTopIndex = railWindowTop(railFocus, entries.length, railListHeight)
  const visibleRailRows = entries.slice(railWindowTopIndex, railWindowTopIndex + Math.max(1, railListHeight - 1))
  /** Content-local anchor for a keyboard-opened menu (screen coords minus inset). */
  const keyboardMenuAnchor = { col: inset.x + 2, row: inset.y + 3 }
  const filtered = query.trim().length > 0

  // Scroll window over the session rows, keeping the focused row visible
  // without re-shuffling the list under a stationary cursor.
  const capacity = Math.max(1, Math.floor(sessionListHeight / SESSION_ROW_LINES))
  let sessionTop = Math.min(
    Math.max(0, sessionIndex - capacity + 1),
    Math.max(0, visibleSessions.length - capacity),
  )
  if (sessionIndex < sessionTop) sessionTop = sessionIndex
  const visibleSessionRows = visibleSessions.slice(sessionTop, sessionTop + capacity)

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
            {visibleRailRows.map((entry) => {
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

        <Box flexDirection="column" width={sessionWidth} height="100%" flexShrink={0} overflow="hidden">
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text color="remember" bold>{truncateWidth(` ${t('home-sessions-title', { name: selected?.title ?? t('supervisor-title') })}`, Math.max(4, sessionWidth - 3))}</Text>
            <Text dimColor>
              {`  ${truncateWidth(
                t('supervisor-counts', { working: workingCount, live: liveCount, total: visibleSessions.length }),
                Math.max(4, sessionWidth - 3),
              )}`}
            </Text>
          </Box>
          <Box height={1} flexShrink={0} paddingX={1}>
            <SearchBox
              query={query}
              isFocused={!railVisible || railFocus > 0}
              isTerminalFocused={isTerminalFocused}
              placeholder={truncateWidth(t('supervisor-filter-placeholder'), Math.max(8, sessionWidth - 6))}
              prefix="/"
              borderless
              width={Math.max(8, sessionWidth - 2)}
            />
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
                {` ${truncateWidth(filtered ? t('home-no-sessions') : t('home-no-sessions'), sessionWidth - 2)}`}
              </Text>
            )}
            {visibleSessionRows.map((session, index) => {
              const state = liveStateOf(session.id)
              const holder = occupancyOf(session.id)
              return (
                <SessionListRow
                  key={session.id}
                  session={session}
                  width={sessionWidth}
                  depth={0}
                  focused={sessionTop + index === sessionIndex}
                  pinned={pins.has(session.id)}
                  now={now}
                  liveStatus={state?.live === true ? state.status : undefined}
                  current={state?.current === true}
                  occupiedPid={holder}
                  spinner={{ frame: spinnerFrame, time: spinnerTime }}
                  onClick={(event): void => {
                    event.stopImmediatePropagation()
                    sessionFocusRef.current = sessionTop + index
                    setSessionFocus(sessionTop + index)
                    setFocusSessionId(session.id)
                    openSession(session)
                  }}
                  onTogglePin={(): void => {
                    sessionFocusRef.current = sessionTop + index
                    setSessionFocus(sessionTop + index)
                    setFocusSessionId(session.id)
                    persistPin(session.id, !pins.has(session.id))
                  }}
                  onContextMenu={(event): void => {
                    sessionFocusRef.current = sessionTop + index
                    setSessionFocus(sessionTop + index)
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

/** Re-exported so a regression can drive the spinner without importing ink. */
export { SpinnerGlyph }
