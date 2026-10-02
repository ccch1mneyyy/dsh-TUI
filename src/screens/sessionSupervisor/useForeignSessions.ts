/**
 * Data, derived state and actions for the session screen's foreign-source
 * tabs: another coding agent's conversations, grouped by directory, imported
 * on selection.
 *
 * It mirrors the DSH half's ownership rules rather than sharing its code: the
 * two lists carry different data (a DSH summary has live state, pins and a
 * registry; a foreign summary has none of those), and pretending one is the
 * other is exactly what the design ruled out. What is kept identical is the
 * cursor model — the cursor is ONE fact, the key of the row it stands on, and
 * every index is derived from it — because that is what makes Enter act on
 * the row under `❯` after a filter or a streamed row moved the rows.
 *
 * State is only what the visible tab needs: its rows and its cursor. Switching
 * tabs starts the new one fresh, and nothing outlives the screen — reopening a
 * source relists it, which the channel keeps cheap for unchanged ones.
 *
 * Every call is optional on the channel: a host (or a regression stub) that
 * predates the foreign-session facade simply has no source tabs.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { t } from '../../i18n.js'
import { normalizeWorkspaceCwd } from '../../sessions/view.js'
import type { ForeignImportOutcome, ForeignSessionRow, ForeignSource } from '../../adapter/ports/channel-session.js'
import type { ResumeResult } from '../../adapter/ports/channel-view.js'
import { resumeFailureText } from '../../sessions/resumeFailure.js'
import type { ChannelUi as Channel } from '../../adapter/channel/ui-policy.js'
import { message, samePath, type RailEntry } from './model.js'

/** The tab id of the screen's own sessions; every other tab is an agent id. */
export const DSH_TAB = 'dsh'

/** Rail key of the group holding conversations with no recorded directory. */
export const FOREIGN_UNKNOWN_GROUP = 'foreign:unknown'

/** Streamed rows are applied at most this often, not once per conversation. */
const STREAM_FLUSH_MS = 100

/** One rail row of a source tab: every conversation recorded in one directory. */
export interface ForeignGroup {
  /** Normalised directory, or {@link FOREIGN_UNKNOWN_GROUP}. */
  readonly key: string
  /** The directory as recorded ('' for the unknown group). */
  readonly path: string
  /** The DSH workspace title for a registered directory, else its basename. */
  readonly title: string
  /** False when the recorded directory no longer exists. */
  readonly present: boolean
  /** Newest first. */
  readonly rows: readonly ForeignSessionRow[]
  readonly newest: number
}

/** The visible source tab's rows. */
interface Listing {
  readonly tab: string
  readonly rows: readonly ForeignSessionRow[]
  readonly loading: boolean
}

/** The visible source tab's cursor; reset whenever the tab changes. */
interface View {
  readonly tab: string
  /** Selected group key; undefined until the user picks one. */
  readonly group?: string
  /** Key of the row the cursor stands on; undefined means the first row. */
  readonly cursor?: string
  readonly pane: 'rail' | 'list'
}

type Notice = { text: string; tone: 'info' | 'error' } | undefined

export interface ForeignSessionsInput {
  readonly channel: Channel
  /** The screen's active tab: {@link DSH_TAB} or a foreign agent id. */
  readonly tab: string
  /** The DSH workspace registry, so a known directory keeps its DSH title. */
  readonly registry: readonly RailEntry[]
  /** The screen's live query (shared with the DSH half, cleared on tab switch). */
  readonly query: string
  setNotice(next: Notice): void
  /** Mount a persisted session (the channel's unified resume path). */
  onOpenSession(sessionId: string): Promise<ResumeResult>
}

/**
 * Case-insensitive match over what a person searches a foreign row by: its
 * title and the directory it ran in.
 * @param row - The conversation to test.
 * @param needle - Lower-cased query; empty matches everything.
 * @returns True when the row stays visible.
 */
export function foreignRowMatchesQuery(row: ForeignSessionRow, needle: string): boolean {
  if (needle.length === 0) return true
  return `${row.title}\n${row.cwd}`.toLowerCase().includes(needle)
}

/**
 * Group a source's conversations by directory, newest group first.
 *
 * A directory the DSH registry knows keeps the title the user gave it there,
 * so "the same project" reads the same in every tab; anything else is named by
 * its basename. Conversations with no recorded directory share one group.
 * @param rows - The source's conversations, any order.
 * @param registry - DSH workspace registry rows.
 * @param exists - Directory probe (injected for the regression).
 * @returns Groups sorted by their newest conversation, rows newest first.
 */
export function groupForeignRows(
  rows: readonly ForeignSessionRow[],
  registry: readonly RailEntry[],
  exists: (path: string) => boolean = existsSync,
): readonly ForeignGroup[] {
  const buckets = new Map<string, { path: string; rows: ForeignSessionRow[] }>()
  for (const row of rows) {
    const key = row.cwd === '' ? FOREIGN_UNKNOWN_GROUP : normalizeWorkspaceCwd(row.cwd)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { path: row.cwd, rows: [row] })
    else bucket.rows.push(row)
  }
  const groups = [...buckets.entries()].map(([key, bucket]): ForeignGroup => {
    const sorted = bucket.rows.slice().sort((left, right) => right.updatedAt - left.updatedAt)
    const unknown = key === FOREIGN_UNKNOWN_GROUP
    const registered = unknown
      ? undefined
      : registry.find(entry => entry.from === 'registry' && samePath(entry.path, bucket.path))
    return {
      key,
      path: unknown ? '' : bucket.path,
      title: unknown
        ? t('supervisor-foreign-unknown-cwd')
        : registered?.title ?? (basename(bucket.path) || bucket.path),
      present: unknown || exists(bucket.path),
      rows: sorted,
      newest: sorted[0]?.updatedAt ?? 0,
    }
  })
  return groups.sort((left, right) => right.newest - left.newest)
}

/** Why an import failed, in words. */
const FAILURE_KEYS = {
  missing: 'supervisor-foreign-failed-missing',
  'too-large': 'supervisor-foreign-failed-too-large',
  'not-a-session': 'supervisor-foreign-failed-not-a-session',
  'write-failed': 'supervisor-foreign-failed-write-failed',
  'unknown-source': 'supervisor-foreign-failed-unknown-source',
} as const

/** The notice for an import that did not end in a session to open. */
function importFailureText(outcome: Exclude<ForeignImportOutcome, { kind: 'ready' }>): string {
  if (outcome.kind === 'cwd-missing') return t('supervisor-foreign-cwd-missing', { cwd: outcome.cwd })
  const reason = t(FAILURE_KEYS[outcome.reason])
  return outcome.detail === undefined || outcome.detail === ''
    ? t('supervisor-foreign-import-failed', { err: reason })
    : t('supervisor-foreign-import-failed', { err: `${reason} · ${outcome.detail}` })
}

/**
 * Derive the foreign-source half of the screen.
 * @param input - Channel, active tab, registry, shared query and notice, and
 *   the host's open action.
 * @returns The tab list, the active source's panes, and their actions.
 */
export function useForeignSessions(input: ForeignSessionsInput) {
  const { channel, tab, registry, query, setNotice, onOpenSession } = input
  // Importing other agents' conversations is a DSH feature (`/migrate`): a
  // backend without it never probes (its delegate would refuse loudly).
  const supported = typeof channel.listForeignSources === 'function'
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: headless hosts pass partial channels
    && (channel.capabilities?.commands.includes('migrate') ?? true)
  const agentId = tab === DSH_TAB ? undefined : tab

  const [sources, setSources] = useState<readonly ForeignSource[]>([])
  const [listing, setListing] = useState<Listing | undefined>(undefined)
  const [storedView, setView] = useState<View | undefined>(undefined)

  const mounted = useRef(true)
  /** The tab on screen now, read by async work that must not act on another. */
  const tabRef = useRef(tab)
  tabRef.current = tab
  /** Only the newest listing may publish. */
  const generation = useRef(0)
  const importing = useRef(new Set<string>())
  React.useEffect(() => () => {
    mounted.current = false
    generation.current++
  }, [])

  // The one read an open pays for: which sources have any conversation.
  React.useEffect(() => {
    if (!supported) return
    void channel.listForeignSources()
      .then((found) => {
        if (mounted.current) setSources(found)
      })
      .catch(() => {
        // No tabs is the honest answer to a failed probe; the DSH half is
        // unaffected.
      })
  }, [channel, supported])

  const list = useCallback(async (id: string): Promise<void> => {
    if (!supported) return
    const current = ++generation.current
    const live = (): boolean => generation.current === current
    setListing(previous => ({ tab: id, rows: previous?.tab === id ? previous.rows : [], loading: true }))

    // Rows stream in as the scan finds them, batched so a large source does
    // not render once per conversation.
    let pending: ForeignSessionRow[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      timer = undefined
      if (!live() || pending.length === 0) return
      const batch = pending
      pending = []
      setListing((previous) => {
        const byKey = new Map((previous?.tab === id ? previous.rows : []).map(row => [row.key, row]))
        for (const row of batch) byKey.set(row.key, row)
        return { tab: id, rows: [...byKey.values()], loading: true }
      })
    }
    try {
      const rows = await channel.listForeignSessions(id, (row) => {
        if (!live()) return
        pending.push(row)
        timer ??= setTimeout(flush, STREAM_FLUSH_MS)
      })
      if (live()) setListing({ tab: id, rows, loading: false })
    } catch (error) {
      if (!live()) return
      setListing(previous => ({ tab: id, rows: previous?.tab === id ? previous.rows : [], loading: false }))
      setNotice({ text: t('supervisor-foreign-scan-failed', { err: message(error) }), tone: 'error' })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [channel, supported, setNotice])

  // Entering a source tab lists it.
  React.useEffect(() => {
    if (agentId !== undefined) void list(agentId)
    else generation.current++
  }, [agentId, list])

  const rows = listing !== undefined && listing.tab === tab ? listing.rows : []
  const loading = agentId !== undefined && (listing === undefined || listing.tab !== tab || (listing.loading && rows.length === 0))
  const view: View = storedView !== undefined && storedView.tab === tab ? storedView : { tab, pane: 'rail' }

  const patchView = useCallback((patch: Partial<Omit<View, 'tab'>>): void => {
    setView(previous => ({ ...(previous !== undefined && previous.tab === tab ? previous : { tab, pane: 'rail' as const }), ...patch }))
  }, [tab])

  const groups = useMemo(() => groupForeignRows(rows, registry), [rows, registry])

  /**
   * The group the list shows: the one picked by hand while it still exists,
   * else the directory this terminal is in, else the newest.
   */
  const selected = useMemo((): ForeignGroup | undefined => {
    if (view.group !== undefined) {
      const picked = groups.find(group => group.key === view.group)
      if (picked !== undefined) return picked
    }
    return groups.find(group => group.path !== '' && samePath(group.path, channel.cwd)) ?? groups[0]
  }, [groups, view.group, channel.cwd])

  /** The rail cursor IS the selection, as on the DSH rail. */
  const railFocus = selected === undefined ? 0 : Math.max(0, groups.indexOf(selected))

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (selected?.rows ?? []).filter(row => foreignRowMatchesQuery(row, needle))
  }, [selected, query])

  /**
   * The list cursor, derived from the one stored fact (the row's key). A key
   * the filter removed puts the cursor on the first REAL row — there is no
   * new-session card in a source tab, so the cursor space starts at 0.
   */
  const rowIndex = useMemo(() => {
    if (view.cursor === undefined) return 0
    return Math.max(0, visibleRows.findIndex(row => row.key === view.cursor))
  }, [visibleRows, view.cursor])
  const focusedRow = visibleRows[rowIndex]

  const selectGroup = useCallback((group: ForeignGroup): void => {
    patchView({ group: group.key, cursor: undefined })
  }, [patchView])

  const moveRail = useCallback((by: 1 | -1): void => {
    if (groups.length === 0) return
    const next = groups[(railFocus + by + groups.length) % groups.length]!
    patchView({ group: next.key, cursor: undefined })
  }, [groups, railFocus, patchView])

  const moveList = useCallback((by: 1 | -1): void => {
    if (visibleRows.length === 0) return
    const next = Math.min(visibleRows.length - 1, Math.max(0, rowIndex + by))
    patchView({ cursor: visibleRows[next]!.key })
  }, [visibleRows, rowIndex, patchView])

  const activateRail = useCallback((): void => patchView({ pane: 'rail' }), [patchView])
  const activateList = useCallback((): void => patchView({ pane: 'list' }), [patchView])
  const focusRow = useCallback((row: ForeignSessionRow): void => patchView({ cursor: row.key, pane: 'list' }), [patchView])

  /**
   * Import a conversation (or find the copy an earlier selection made) and
   * open it.
   *
   * The import can take seconds, and the screen may be gone or on another tab
   * when it lands. It opens the session only while the screen is still up —
   * a user who pressed Esc meanwhile must not be pulled into it — and it
   * reports only to the tab that asked, so one source's notice never shows
   * under another.
   */
  const openRow = useCallback((row: ForeignSessionRow): void => {
    if (!supported) return
    const key = `${row.agentId}|${row.key}`
    if (importing.current.has(key)) return
    importing.current.add(key)
    const report = (next: Notice): void => {
      if (mounted.current && tabRef.current === row.agentId) setNotice(next)
    }
    report({ text: t('supervisor-foreign-importing', { name: row.title }), tone: 'info' })
    void channel.importForeignSession(row.agentId, row.key)
      .then(async (outcome) => {
        if (outcome.kind !== 'ready') {
          report({ text: importFailureText(outcome), tone: 'error' })
          return
        }
        if (!mounted.current) return
        report(undefined)
        // The host owns the refusal's reason (same contract as the DSH half):
        // `cancelled` stays silent, a plain failure shows the bare error.
        const result = await onOpenSession(outcome.sessionId)
        const reason = !result.ok && result.reason === 'failed' ? result.error : resumeFailureText(result)
        if (reason !== undefined) report({ text: t('supervisor-open-failed', { name: row.title, reason }), tone: 'error' })
      })
      .catch(error => report({ text: t('supervisor-foreign-import-failed', { err: message(error) }), tone: 'error' }))
      .finally(() => importing.current.delete(key))
  }, [channel, supported, onOpenSession, setNotice])

  /** Ctrl+L on a source tab: list it again. */
  const rescan = useCallback((): void => {
    if (agentId !== undefined) void list(agentId)
  }, [agentId, list])

  return {
    sources,
    rows,
    loading,
    groups,
    selected,
    railFocus,
    visibleRows,
    rowIndex,
    focusedRow,
    pane: view.pane,
    selectGroup,
    moveRail,
    moveList,
    activateRail,
    activateList,
    focusRow,
    openRow,
    rescan,
  }
}

export type ForeignSessionsModel = ReturnType<typeof useForeignSessions>
