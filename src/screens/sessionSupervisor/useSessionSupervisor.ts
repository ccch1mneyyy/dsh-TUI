/**
 * Data, derived state and actions for the unified session screen.
 *
 * The screen keeps only assembly and key routing; everything that answers "what
 * is on screen and what does an action do" lives here. That is what makes the
 * two panes presentational and the derivations reachable from a regression.
 *
 * Two ownership rules must not be duplicated anywhere else:
 * - the cursor is ONE fact; every index is derived from it, so movement,
 *   rendering and Enter can never disagree;
 * - occupancy is re-read from the ledger on this screen own pulse and never
 *   captured from the parent render.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { basename } from 'node:path'
import { t } from '../../i18n.js'
import { truncateWidth } from '../../sessions/format.js'
import { normalizeWorkspaceCwd } from '../../sessions/view.js'
import { readSessionPins, setSessionPinned } from '../../sessionPins.js'
import { readSessionOwners, type SessionMountOwner } from '../../sessionMounts.js'
import type { SessionSummary } from '../../dsh-adapter/sessions/index.js'
import type { TuiWorkspaceEntry, TuiWorkspaceTarget } from '../../workspaces.js'
import type { ChannelUi as Channel } from '../../adapter/channel/ui-policy.js'
import { RAIL_CHROME_ROWS, WORKSPACE_ROW_LINES, RAIL_MIN_TOTAL_COLUMNS, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, SESSION_ROW_LINES, SESSION_PANE_CHROME_ROWS, MenuAction, MENU_ACTIONS, MENU_WIDTH, MENU_HEIGHT, MENU_LABEL_KEYS, SupervisorLiveState, RailEntry, UNREGISTERED_RAIL_ID, message, samePath, sessionMatchesQuery } from './model.js'

/** Everything the screen owns that the model needs to read. */
export interface SessionSupervisorInput {
  readonly channel: Channel
  /** Home directory, for collapsing paths to `~`. */
  readonly home: string
  /** Mount a persisted session (the channel unified resume path). */
  onOpenSession(sessionId: string): Promise<boolean>
  /** Start a fresh session in the workspace at `path`. */
  onNewSession(target: TuiWorkspaceTarget): Promise<boolean>
  /** Stop a background session of this terminal; false when it is not ours. */
  onStopSession(sessionId: string): Promise<boolean>
  /** This terminal live state for a session, or undefined when it has none. */
  liveStateOf(sessionId: string): SupervisorLiveState | undefined
  readonly columns: number
  readonly rows: number
}

/**
 * Derive the whole screen model.
 * @param input - Channel, home, the opening/stop actions and the live lookup.
 * @returns Every value the screen renders from, plus the action callbacks.
 */
export function useSessionSupervisor(input: SessionSupervisorInput) {
  const { channel, home, onOpenSession, onNewSession, onStopSession, liveStateOf, columns, rows } = input

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
   * The rail's rows: the durable registry, plus rows for sessions that live in
   * a directory the registry does not know (or while it cannot be read at all).
   *
   * The registry is the sidebar's own ledger, and it is genuinely OPTIONAL:
   * `createLocalWorkspaceRuntime()` supports compositions with no workspace
   * stack and returns an empty one, a registration can be removed while its
   * session logs stay on disk, and the service itself can reject. Sessions in
   * every one of those cases are still resumable — the persistence store, not
   * the registry, is what holds them — so an empty rail must not render "no
   * history" and leave them unreachable.
   *
   * Each unregistered directory gets its OWN row (titled by its basename), so
   * the rail keeps telling the user WHERE a session ran; when even the session
   * paths are unavailable they all land in one synthetic group. These rows live
   * only inside this screen and are never written back to the ledger.
   */
  const railEntries = useMemo<readonly RailEntry[]>(() => {
    const orphans = listedSessions.filter(session =>
      !entries.some(entry => samePath(entry.path, session.cwd)))
    if (orphans.length === 0) return entries
    const byCwd = new Map<string, { path: string; count: number }>()
    for (const session of orphans) {
      const key = normalizeWorkspaceCwd(session.cwd)
      const existing = byCwd.get(key)
      if (existing === undefined) byCwd.set(key, { path: session.cwd, count: 1 })
      else existing.count += 1
    }
    return [...entries, ...[...byCwd.entries()].map(([key, group]): RailEntry => ({
      id: `${UNREGISTERED_RAIL_ID}:${key === '' ? 'unknown' : key}`,
      path: group.path === '' ? UNREGISTERED_RAIL_ID : group.path,
      title: basename(group.path) || t('supervisor-unregistered'),
      present: true,
      sessionCount: group.count,
      from: 'unregistered',
    }))]
  }, [entries, listedSessions])

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>()
    for (const session of listedSessions) {
      const path = railEntries.find(entry =>
        entry.from === 'registry' && samePath(entry.path, session.cwd))?.path
        ?? (session.cwd === '' ? UNREGISTERED_RAIL_ID : session.cwd)
      const bucket = groups.get(path)
      if (bucket === undefined) groups.set(path, [session])
      else bucket.push(session)
    }
    return groups
  }, [listedSessions, railEntries])

  /** Session count for one rail row, from the same grouping the pane uses. */
  const countOf = useCallback(
    (entry: RailEntry): number => (groupedEntries.get(entry.path) ?? []).length,
    [groupedEntries],
  )

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
    // The two reads are independent, and the session listing is the half this
    // screen cannot work without: a registry that rejects (bare composition,
    // unmounted service, a provider throwing) must not take the history down
    // with it. So the listing is settled on its own, and a registry failure
    // degrades to the empty rail the cwd-derived fallback groups already cover.
    await Promise.all([
      (async (): Promise<void> => {
        try {
          setSessions(await channel.listSessions())
          setNotice(current => (current?.tone === 'error' ? undefined : current))
        } catch (error) {
          setNotice({ text: t('home-sessions-failed', { err: message(error) }), tone: 'error' })
        }
      })(),
      (async (): Promise<void> => {
        try {
          const registry = typeof channel.listWorkspaceRegistry === 'function'
            ? await channel.listWorkspaceRegistry()
            : []
          setEntries(registry.map(entry => ({ ...entry, from: 'registry' })))
        } catch {
          // An unreadable registry is not an empty history: the sessions stay
          // listed (and resumable) under the cwd-derived fallback groups.
          setEntries([])
        }
      })(),
    ])
    setLoading(false)
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
    return (groupedEntries.get(selected.path) ?? [])
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

  return {
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
  }
}
