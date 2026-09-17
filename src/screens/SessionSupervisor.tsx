import React, { useCallback, useMemo, useRef, useState } from 'react'
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

/**
 * Rows the left rail always keeps: the section header, the hint line, and the
 * blank rows around them.
 *
 * There is no `+` row any more. A workspace enters the ledger by being the
 * directory a terminal started in (see the startup attach in `plugin.ts`), so
 * the rail has no creation control to reserve a row for.
 */
const RAIL_CHROME_ROWS = 4
/** Terminal rows one rail entry occupies; see {@link HomeWorkspaceRow}. */
const WORKSPACE_ROW_LINES = 2
/** Width the rail gets when the terminal is wide enough to show both panes. */
const RAIL_MIN_TOTAL_COLUMNS = 84
const RAIL_WIDTH_MIN = 24
const RAIL_WIDTH_MAX = 38
/** Two lines per session row (title + facts), plus the filter and notice rows. */
const SESSION_ROW_LINES = 2
/** Chrome the right pane spends on banner, filter, new-session card, notice and hints. */
const SESSION_PANE_CHROME_ROWS = 8

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

/**
 * One row of the workspace rail: a durable registration, or the fallback group
 * for sessions whose directory is NOT registered.
 *
 * The registry is not the whole session store — a host can run without the
 * workspace service at all (bare compositions return an empty registry), and a
 * session keeps existing after its registration is removed. Those sessions are
 * still resumable, so "no registration" must not read as "no history".
 */
type RailEntry = TuiWorkspaceEntry & { readonly from: 'registry' | 'unregistered' }

/** Synthetic id/path for the fallback group; never persisted. */
const UNREGISTERED_RAIL_ID = 'rail:unregistered'

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

  const [entries, setEntries] = useState<readonly RailEntry[]>([])
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | undefined>(undefined)
  /** Live status and occupancy are re-read on their own clock, not the listing's. */
  const [pulse, setPulse] = useState(0)
  const [query, setQuery] = useState('')

  /**
   * Cross-process occupancy, re-read on the SAME tick as the live state.
   *
   * This has to be read here, not captured by the host: the ledger is a file
   * another process writes, so a snapshot taken during the parent's render went
   * stale the moment it was taken and nothing re-took it — the parent does not
   * re-render on this screen's 2s pulse, so a foreign terminal that acquired or
   * released a session left the row red (and unclickable) until some unrelated
   * channel event happened to repaint. Reading behind a pulse-keyed ref keeps
   * it to one read per tick while the rows and the click guard always see the
   * current holder.
   */
  const occupancyRef = useRef<ReadonlyMap<string, SessionMountOwner>>(new Map())
  const occupancyPulseRef = useRef(-1)
  if (occupancyPulseRef.current !== pulse) {
    occupancyPulseRef.current = pulse
    occupancyRef.current = readSessionOwners()
  }
  const holderOf = useCallback(
    (sessionId: string): number | undefined => {
      const owner = occupancyRef.current.get(sessionId)
      return owner === undefined || owner.pid === process.pid ? undefined : owner.pid
    },
    [],
  )

  /**
   * Sessions eligible for this screen, computed ONCE per listing so the rail's
   * per-workspace counts and the pane's rows always agree.
   *
   * Three things are hidden, and the third is the one that is easy to lose:
   * a delegated run (its own row belongs to the agent-run folding, not to a
   * workspace listing), a log holding no conversation, and the CURRENT
   * session's fork ANCESTORS. The last one matters because a `/resume` fork
   * records `parentSession` exactly like a delegated run does — listing the
   * chain makes one conversation look like several, with no way to tell which
   * row continues what the user is looking at.
   *
   * The current session itself stays listed (marked `current` by the live
   * state): this screen exists to show what the terminal hosts, and "the one
   * you are in" is the row the user is most likely looking for. Only the
   * ancestors go — they are the same conversation at an earlier point, which
   * the current row already represents. `buildView` hides the current id as
   * well because its list has no live-state column to mark it with.
   */
  const listedSessions = useMemo(() => {
    const byId = new Map(sessions.map(session => [session.id, session]))
    const ancestors = new Set<string>()
    let cursor = byId.get(channel.agentId)
    while (cursor?.kind.kind === 'fork') {
      const parent = cursor.kind.parent
      if (parent === undefined || ancestors.has(parent)) break
      ancestors.add(parent)
      cursor = byId.get(parent)
    }
    return sessions.filter(session =>
      session.hasPrompt && session.kind.kind !== 'subagent' && !ancestors.has(session.id))
  }, [sessions, channel.agentId])

  /**
   * The rail's rows: the durable registry, plus one synthetic group when some
   * listed session has no registration at all.
   *
   * The registry is the sidebar's own ledger, and it is genuinely OPTIONAL:
   * `createLocalWorkspaceRuntime()` supports compositions with no workspace
   * stack and returns an empty one, and a registration can be removed while its
   * session logs stay on disk. Sessions in either case are still resumable —
   * the persistence store, not the registry, is what holds them — so an empty
   * registry must not render "no history" and leave those sessions
   * unreachable. The group carries a synthetic id and is never persisted.
   */
  const railEntries = useMemo<readonly RailEntry[]>(() => {
    const registered = entries
    const orphans = listedSessions.filter(session =>
      !registered.some(entry => samePath(entry.path, session.cwd)))
    if (orphans.length === 0) return registered
    return [...registered, {
      id: UNREGISTERED_RAIL_ID,
      path: UNREGISTERED_RAIL_ID,
      title: t('supervisor-unregistered'),
      present: true,
      sessionCount: orphans.length,
      from: 'unregistered',
    }]
  }, [entries, listedSessions])

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>()
    for (const session of listedSessions) {
      const path = railEntries.find(entry =>
        entry.from === 'registry' && samePath(entry.path, session.cwd))?.path ?? UNREGISTERED_RAIL_ID
      const bucket = groups.get(path)
      if (bucket === undefined) groups.set(path, [session])
      else bucket.push(session)
    }
    return groups
  }, [listedSessions, railEntries])

  const [railFocus, setRailFocus] = useState(0)
  /**
   * A rail entry the user picked by hand that is NOT registered — the fallback
   * group for unregistered sessions. It exists only for this screen's lifetime:
   * selecting a group is a way to SEE those sessions, never a way to register a
   * directory, so it must not create a ledger record.
   */
  const [selectedUnregistered, setSelectedUnregistered] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  /** True once the user picked a rail row by hand; see the selection effect. */
  const [selectionManual, setSelectionManual] = useState(false)
  /**
   * The session column's cursor, as ONE fact.
   *
   * It used to be three: a `sessionFocus` index, a `sessionFocusRef` mirror and
   * a `focusSessionId`, with the render deriving the index from the id while
   * Enter read the ref. The filter and the live-state re-sort move rows, so the
   * ref went stale and Enter opened a row other than the one under `❯`. The id
   * (or the card) is stored here and the index is always DERIVED from it.
   */
  /**
   * The cursor of the session column, as ONE fact: the session id it is on, or
   * undefined for the new-session card.
   *
   * The screen used to keep an index, a ref mirror and an id beside each other,
   * with the render deriving an index from the id while Enter read the ref. The
   * filter and the live-state re-sort move rows, so the stored index kept
   * pointing at the offset it had held while `❯` was drawn from the id — Enter
   * then acted on a row the user had never selected. There is one fact now, and
   * {@link focusIndex} is derived from it for the render, for movement and for
   * Enter alike.
   */
  const [focusSessionId, setFocusSessionId] = useState<string | undefined>(undefined)
  /**
   * Which column owns the keyboard, and therefore which column draws the `❯`
   * cursor. Exactly one at a time: two cursors mean "where does Enter go?" has
   * no answer, and ←/→ is how this screen answers it.
   */
  const [activePane, setActivePane] = useState<'rail' | 'list'>('rail')
  const [pins, setPins] = useState<ReadonlySet<string>>(() => readSessionPins())

  const [menu, setMenu] = useState<{ path: string; col: number; row: number; item: number } | undefined>(undefined)
  const [rename, setRename] = useState<{ path: string; draft: string } | undefined>(undefined)
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>(undefined)

  const railRef = useRef(railFocus)
  railRef.current = railFocus
  const menuRef = useRef(menu)
  menuRef.current = menu
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
   *
   * The ledger read degrades to an EMPTY rail when the host does not expose it,
   * instead of failing the whole reload: `/bg` opens this screen, and a host
   * written before the workspace ledger existed (the older in-repo regressions
   * compose exactly that) would otherwise get "failed to read sessions" on
   * screen and lose the session listing with it. The session list is the half
   * this screen cannot work without, so it must survive a missing ledger.
   */
  const reload = useCallback(async (): Promise<void> => {
    try {
      const ledger = typeof channel.listWorkspaceRegistry === 'function'
        ? channel.listWorkspaceRegistry()
        : Promise.resolve([] as readonly TuiWorkspaceEntry[])
      const [registry, listed] = await Promise.all([ledger, channel.listSessions()])
      setEntries(registry.map(entry => ({ ...entry, from: 'registry' })))
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

  // Selection follows the terminal's own directory, then the ledger: the rail
  // must open on the workspace this terminal is IN, not on whichever record
  // sorts first — otherwise launching in a workspace you have never opened
  // lands the marker on some unrelated project.
  //
  // It deliberately does NOT latch the first default it computes. The listing
  // arrives asynchronously, so the very first pass runs against an EMPTY ledger;
  // latching there would pin the rail to whatever record arrives first and never
  // reconsider. While the selection is still ours to make, every ledger update
  // re-derives it (`entries[0]` remains the fallback when the terminal's own
  // directory is not registered); once the user picks a row by hand, that choice
  // wins until its entry disappears.
  //
  // `channel.cwd` is a dependency, not just a first read: resuming a session
  // from another workspace moves this terminal to that workspace, and the rail
  // follows the session the pane is showing rather than the launch directory.
  React.useEffect(() => {
    if (railEntries.length === 0) {
      if (selectedPath !== undefined && !selectionManual) setSelectedPath(undefined)
      return
    }
    if (
      selectionManual
      && selectedPath !== undefined
      && railEntries.some(entry => entry.from === 'registry' && samePath(entry.path, selectedPath))
    ) return
    // A hand-picked fallback group stays picked while it is still on the rail.
    // Without this the group would be dropped on the very next listing pass and
    // the sessions it was showing would vanish again.
    if (selectionManual && selectedUnregistered
      && railEntries.some(entry => entry.from === 'unregistered')) return
    const here = railEntries.find(entry => entry.from === 'registry' && samePath(entry.path, channel.cwd))
    const next = here ?? railEntries[0]!
    setSelectedPath(next.from === 'registry' ? next.path : undefined)
    setSelectedUnregistered(next.from === 'unregistered')
    // The cursor travels with an automatic selection. It starts at 0, so
    // leaving it there while the selection lands elsewhere paints two green
    // rows — `❯` on the first record and the marker on the selected one — until
    // some input moves it. The two are one position on this screen, and the
    // very first frame has to render that way. A pick the user made by hand is
    // left alone (it already moved the cursor itself).
    setRailFocus(current => {
      const index = railEntries.findIndex(entry => entry.id === next.id)
      return index < 0 || current === index ? current : index
    })
  }, [railEntries, selectedPath, selectedUnregistered, selectionManual, channel.cwd])

  // The cursor indexes the entry list directly (there is no `+` row in front of
  // it), so a shrinking ledger has to pull it back inside or the last row would
  // highlight nothing.
  React.useEffect(() => {
    setRailFocus(current => Math.min(current, Math.max(0, railEntries.length - 1)))
  }, [railEntries.length])

  /** The rail row whose sessions the pane is showing (or the fallback group). */
  const selected = useMemo(() => {
    const registered = railEntries.find(entry =>
      entry.from === 'registry' && selectedPath !== undefined && samePath(entry.path, selectedPath))
    if (registered !== undefined) return registered
    if (selectedUnregistered) return railEntries.find(entry => entry.from === 'unregistered')
    return railEntries[0]
  }, [railEntries, selectedPath, selectedUnregistered])

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
    return (groupedEntries.get(selected.from === 'registry' ? selected.path : UNREGISTERED_RAIL_ID) ?? [])
      .filter(session => sessionMatchesQuery(session, needle))
      .slice()
      .sort((left, right) => {
        const leftLive = liveStateOf(left.id)?.live === true ? 1 : 0
        const rightLive = liveStateOf(right.id)?.live === true ? 1 : 0
        return rightLive - leftLive || right.updatedAt - left.updatedAt
      })
  }, [groupedEntries, selected, query, liveStateOf, pulse])

  /**
   * Cursor identity: rows reorder on every reload and filter, so the cursor
   * follows an ID rather than an index — and the cursor space includes the
   * new-session card as row 0. The card is not decoration: it has to be
   * selectable like every other card, or the keyboard loses a path to the one
   * action that still works when the list is empty.
   */
  const sessionIndex = useMemo(() => {
    // No focused session means the card (row 0) holds the cursor.
    if (focusSessionId === undefined) return 0
    const byId = visibleSessions.findIndex(session => session.id === focusSessionId)
    if (byId >= 0) return byId + 1
    // The focused session is not on screen (the filter removed it). The cursor
    // must still stand on a REAL row, because Enter acts on whatever it stands
    // on: landing on the card would turn "search, then Enter" into "start a new
    // session" — an action the user never asked for. With an empty match set the
    // card is the only row there is, so it keeps the cursor.
    return visibleSessions.length === 0 ? 0 : 1
  }, [visibleSessions, focusSessionId])

  /** True while the new-session card holds the cursor; the render says why. */
  const cardFocused = activePane === 'list' && sessionIndex === 0

  /** The new-session card is the list's row 0; sessions start at 1. */
  const sessionAt = useCallback(
    (index: number): SessionSummary | undefined => visibleSessions[index - 1],
    [visibleSessions],
  )

  /**
   * Enter the session column: land the cursor on the session this terminal is
   * attached to (that is the one the user most likely means), else on the top
   * row — which is the new-session card when the list sorted its live rows
   * lower. A cursor that stayed put while the list scrolled elsewhere would act
   * on a row the user never looked at.
   */
  const activateList = useCallback((): void => {
    setActivePane('list')
    const current = visibleSessions.find(session => liveStateOf(session.id)?.current === true)
    setFocusSessionId(current?.id)
  }, [liveStateOf, visibleSessions])

  /** Enter the workspace column. */
  const activateRail = useCallback((): void => {
    setActivePane('rail')
  }, [])

  const railWidth = columns >= RAIL_MIN_TOTAL_COLUMNS
    ? Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.floor(columns * 0.3)))
    : columns
  const railVisible = columns >= RAIL_MIN_TOTAL_COLUMNS
  const sessionWidth = Math.max(20, columns - (railVisible ? railWidth + 1 : 0))
  const railListHeight = Math.max(1, rows - RAIL_CHROME_ROWS)
  /**
   * How many WHOLE workspaces the rail can show. `HomeWorkspaceRow` is always
   * {@link WORKSPACE_ROW_LINES} rows, so the row budget has to be divided by
   * that before it can be used as a window size; handing the row count to the
   * window math directly let the list render twice as many entries as fit and
   * clipped the focused one out of the viewport.
   */
  const railEntryCapacity = Math.max(1, Math.floor(railListHeight / WORKSPACE_ROW_LINES))
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

  const selectEntry = useCallback((entry: RailEntry): void => {
    setSelectedPath(entry.from === 'registry' ? entry.path : undefined)
    setSelectedUnregistered(entry.from === 'unregistered')
    setSelectionManual(true)
    setFocusSessionId(undefined)
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
    const holder = holderOf(session.id)
    if (holder !== undefined) {
      report(t('supervisor-occupied', { pid: holder }), 'error')
      return
    }
    setNotice(undefined)
    void onOpenSession(session.id)
      .then((ok) => {
        // The host owns the REASON: it is the layer that saw the mount result
        // (Chat renders the real refusal through `resumeFailureText` and a
        // notification). This screen only names WHICH session could not be
        // entered — a notice that restated the generic failure would compete
        // with, and read worse than, the host's own sentence.
        if (!ok) report(t('supervisor-open-failed', { name: session.title.text }), 'error')
      })
      .catch(error => report(t('session-resume-failed', { err: message(error) }), 'error'))
  }, [holderOf, onOpenSession, report])

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

  const activateMenu = useCallback((entry: RailEntry, item: number): void => {
    closeMenu()
    const action: MenuAction = MENU_ACTIONS[item] ?? 'edit'
    if (action === 'edit') selectEntry(entry)
    else if (action === 'new') newSessionIn(entry)
    // The fallback group is not a registration, so there is no ledger row to
    // rename or drop: those two actions would either fail or (worse) try to
    // mutate a record that does not exist.
    else if (entry.from === 'unregistered') return
    else if (action === 'rename') setRename({ path: entry.path, draft: entry.title })
    else setConfirmRemove(entry.path)
  }, [closeMenu, newSessionIn, selectEntry])

  const moveRail = useCallback((by: 1 | -1): void => {
    // The rail is the ledger (plus the unregistered fallback group), so every
    // row is a workspace and the cursor is an entry index over that list alone.
    const total = Math.max(1, railEntries.length)
    const next = (railRef.current + by + total) % total
    railRef.current = next
    setRailFocus(next)
    const entry = railEntries[next]
    if (entry !== undefined) selectEntry(entry)
  }, [railEntries, selectEntry])

  const moveSession = useCallback((by: 1 | -1): void => {
    // +1: the cursor space includes the new-session card as row 0, and with an
    // EMPTY list the card is still a row the user can stand on. Clamping the
    // index at 0 instead would have made ↓/↑ do nothing at all there.
    const total = visibleSessions.length + 1
    const next = Math.min(total - 1, Math.max(0, sessionIndex + by))
    // Landing on the card CLEARS the id: leaving the last session's id in place
    // made the derived index resolve back to that session's row, which is what
    // put `❯` on the first session while the user had selected the card.
    const landed = sessionAt(next)
    setFocusSessionId(landed?.id)
  }, [visibleSessions, sessionAt, sessionIndex])

  /** The session under the cursor, or undefined while the card (row 0) holds it. */
  const focusedSession = sessionAt(sessionIndex)

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
                  sessionCount={(groupedEntries.get(entry.from === 'registry' ? entry.path : UNREGISTERED_RAIL_ID) ?? []).length}
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
                {` ${truncateWidth(filtered ? t('home-no-sessions') : t('home-no-sessions'), sessionWidth - 2)}`}
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
