/**
 * The session browser's view model.
 *
 * Every decision about *which* sessions are on screen and in what order lives
 * here, as one pure function from the full list plus the current filters to a
 * flat list of rows. Two reasons it is shaped that way:
 *
 * - Filtering is where this feature's bugs were. Keeping it pure means the
 *   truth table — a sub-agent run is hidden, an unrelated rewind fork is not,
 *   a boot artifact is hidden but counted — is checkable without rendering
 *   anything.
 * - Rows are flattened rather than nested. A windowed list of variable-height
 *   groups has to guess how much room each group needs; a flat list of
 *   single-line rows is windowed by arithmetic, and the group headers simply
 *   travel with their sessions.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/view
 */
import type { SessionSummary } from '../dsh-adapter/sessions/index.js'

/** What the browser is currently showing. */
export interface BrowserFilters {
  /** Free-text query; empty means no text filter. */
  readonly query: string
  /** Show every project, not just the session's own working directory. */
  readonly allProjects: boolean
  /** Show only sessions last used on the current git branch. */
  readonly branchOnly: boolean
  /** Reveal delegated sub-agent runs, indented under their parents. */
  readonly showSubagents: boolean
}

/** The browser's default view: this project, conversations only. */
export const DEFAULT_FILTERS: BrowserFilters = {
  query: '',
  allProjects: false,
  branchOnly: false,
  showSubagents: false,
}

/** One line in the browser's list. */
export type BrowserRow =
  | { readonly kind: 'project'; readonly project: string; readonly count: number }
  /** Header of the pinned group; always the first rows in the view. */
  | { readonly kind: 'pin'; readonly count: number }
  | { readonly kind: 'session'; readonly session: SessionSummary; readonly depth: number }

/** The rendered list plus what it left out and why. */
export interface BrowserView {
  readonly rows: readonly BrowserRow[]
  /** Sessions shown, excluding group headers. */
  readonly shown: number
  /** Delegated runs folded away by the current filters. */
  readonly hiddenSubagents: number
  /** Sessions with no conversation in them, never listed but worth counting. */
  readonly emptyCount: number
  /** Ids of those empty sessions, for the cleanup action. */
  readonly emptyIds: readonly string[]
}

/** Live-session facts shared by the directory index and session projection. */
export interface BrowserContext {
  readonly cwd: string
  readonly branch: string | undefined
  readonly currentId: string
  readonly sameProject: (a: string, b: string) => boolean
}

/** One selectable working-directory bucket in the resume browser. */
export interface WorkspaceGroup {
  /** Stable within one listing; `current` is reserved for the live workspace. */
  readonly id: string
  /** Representative cwd shown in the directory list and used as session scope. */
  readonly cwd: string
  /** Resumable top-level conversations in this directory bucket. */
  readonly count: number
  /** Most recent resumable conversation activity, or 0 for an empty current bucket. */
  readonly updatedAt: number
  /** The compatibility bucket anchored at the live session's cwd. */
  readonly current: boolean
}

/** Normalize an exact historical cwd key without treating ancestors as equal. */
export function normalizeWorkspaceCwd(cwd: string): string {
  const slashed = cwd.replace(/\\/g, '/')
  const normalized = /^\/+$/u.test(slashed) ? '/' : slashed.replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Current session plus the fork ancestors that continuing it superseded. */
function hiddenLineageIds(sessions: readonly SessionSummary[], currentId: string): Set<string> {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const hidden = new Set([currentId])
  let cursor = byId.get(currentId)
  while (cursor?.kind.kind === 'fork') {
    const parent = cursor.kind.parent
    if (hidden.has(parent)) break
    hidden.add(parent)
    cursor = byId.get(parent)
  }
  return hidden
}

/** Shared empty pin set: `buildView` without pins allocates nothing. */
const EMPTY_PINS: ReadonlySet<string> = new Set()

/**
 * Build the explicit working-directory menu.
 *
 * Only the live cwd gets the historical same-project compatibility rule: old
 * versions recorded repository subdirectories, so those sessions still belong
 * under the current workspace. Every remaining directory is grouped by its
 * normalized exact cwd. Applying sameProject transitively to arbitrary history
 * would merge sibling projects through a common ancestor and is deliberately
 * avoided.
 */
export function buildWorkspaceGroups(
  sessions: readonly SessionSummary[],
  context: BrowserContext,
): readonly WorkspaceGroup[] {
  const hidden = hiddenLineageIds(sessions, context.currentId)
  const conversations = sessions.filter(session =>
    session.hasPrompt && session.kind.kind !== 'subagent' && !hidden.has(session.id))
  const currentSessions = conversations.filter(session => context.sameProject(context.cwd, session.cwd))
  const currentIds = new Set(currentSessions.map(session => session.id))
  const current: WorkspaceGroup = {
    id: 'current',
    cwd: context.cwd,
    count: currentSessions.length,
    updatedAt: currentSessions.reduce((latest, session) => Math.max(latest, session.updatedAt), 0),
    current: true,
  }

  const foreign = new Map<string, { cwd: string; count: number; updatedAt: number }>()
  for (const session of conversations) {
    if (currentIds.has(session.id)) continue
    const key = normalizeWorkspaceCwd(session.cwd)
    const existing = foreign.get(key)
    if (existing === undefined) {
      foreign.set(key, { cwd: session.cwd, count: 1, updatedAt: session.updatedAt })
    } else {
      existing.count += 1
      existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt)
    }
  }

  const others = [...foreign.entries()]
    .map(([key, group]): WorkspaceGroup => ({
      id: `cwd:${key || '<unknown>'}`,
      cwd: group.cwd,
      count: group.count,
      updatedAt: group.updatedAt,
      current: false,
    }))
    .sort((left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  return [current, ...others]
}

/** Case-insensitive substring test over the fields a reader would search by. */
function matches(session: SessionSummary, needle: string): boolean {
  if (needle.length === 0) return true
  const haystack = [
    session.title.text,
    session.cwd,
    session.branch ?? '',
    session.model ?? '',
    session.label ?? '',
    session.agentPreset ?? '',
  ]
  return haystack.some(field => field.toLowerCase().includes(needle))
}

/**
 * Build the browser's rows.
 *
 * @param sessions - Every stored session, newest first, as the adapter listed
 *   them. Nothing is pre-filtered.
 * @param filters - The current view.
 * @param context - The session doing the browsing: its working directory
 *   anchors the default project filter, its branch the branch filter, and its
 *   own id is never offered (a live session cannot be resumed into itself).
 * @param pinned - Pinned session ids (from the persisted preference). A pin
 *   on a session the current filters already exclude is invisible here — pins
 *   float to the top OF the view, they do not widen it.
 * @returns The flat row list and the counts behind what it hides.
 */
export function buildView(
  sessions: readonly SessionSummary[],
  filters: BrowserFilters,
  context: BrowserContext,
  pinned: ReadonlySet<string> = EMPTY_PINS,
): BrowserView {
  const needle = filters.query.trim().toLowerCase()

  // `/model` and `/rewind` continue the live conversation in a fork. Offering
  // that fork's ancestors in `/resume` makes one conversation look like many,
  // and selecting one silently jumps back before the fork. Only the live
  // lineage is excluded: unrelated forks remain recoverable. Treat malformed
  // cycles as a closed chain rather than looping forever over foreign data.
  const hiddenLineage = hiddenLineageIds(sessions, context.currentId)

  const inScope = (session: SessionSummary): boolean =>
    !hiddenLineage.has(session.id) &&
    (filters.allProjects || context.sameProject(context.cwd, session.cwd))

  // Empty sessions never reach a view, but they are counted — and the count
  // feeds a DESTRUCTIVE action, so it is scoped exactly as the list is.
  // Counting them across every project while showing one project's rows would
  // put "clean up 15 sessions" on screen next to six, and deleting another
  // project's history from a view that never mentioned it is not a surprise
  // anyone should get. The search query deliberately does NOT narrow it:
  // typing a filter is about finding one session, not about redefining what
  // "empty" means.
  const emptyIds: string[] = []
  for (const session of sessions) {
    if (!session.hasPrompt && inScope(session)) emptyIds.push(session.id)
  }
  const empty = new Set(emptyIds)

  const eligible = sessions.filter(
    session =>
      inScope(session) &&
      !empty.has(session.id) &&
      (!filters.branchOnly || (context.branch !== undefined && session.branch === context.branch)),
  )

  const conversations = eligible.filter(session => session.kind.kind !== 'subagent')
  const runs = eligible.filter(session => session.kind.kind === 'subagent')

  // A run is shown under its parent; one whose parent is not in this view
  // (filtered out, or never listed) would otherwise be unreachable, so it is
  // offered at the top level instead of silently dropped.
  const byParent = new Map<string, SessionSummary[]>()
  const orphans: SessionSummary[] = []
  const visibleIds = new Set(conversations.map(session => session.id))
  for (const run of runs) {
    const parent = run.kind.kind === 'subagent' ? run.kind.parent : undefined
    if (parent !== undefined && visibleIds.has(parent)) {
      const siblings = byParent.get(parent)
      if (siblings === undefined) byParent.set(parent, [run])
      else siblings.push(run)
    } else {
      orphans.push(run)
    }
  }

  const top = filters.showSubagents ? [...conversations, ...orphans] : conversations
  const visible = top.filter(session => {
    if (matches(session, needle)) return true
    // A parent whose own text does not match is still shown when one of its
    // runs does — hiding it would strand the match under a row that is gone.
    if (!filters.showSubagents) return false
    return (byParent.get(session.id) ?? []).some(run => matches(run, needle))
  })

  const rows: BrowserRow[] = []
  let shown = 0
  let lastProjectKey: string | undefined
  const visibleChildren = (session: SessionSummary): readonly SessionSummary[] =>
    filters.showSubagents
      ? (byParent.get(session.id) ?? []).filter(child => matches(child, needle) || matches(session, needle))
      : []

  // Pinned sessions leave the ordinary flow entirely and form one group above
  // every other row. Attached sub-agent rows participate too when the runs
  // filter is on: pinning a visible child must not paint a star that stays
  // buried under its parent. The child is promoted once and removed from the
  // parent's ordinary children; orphan runs already live in `visible`.
  const pinnedChildren = pinned.size > 0 && filters.showSubagents
    ? visible.flatMap(session => visibleChildren(session).filter(child => pinned.has(child.id)))
    : []
  const pinnedRows = pinned.size > 0
    ? [
        ...visible.filter(session => pinned.has(session.id)),
        ...pinnedChildren,
      ].sort((left, right) => right.updatedAt - left.updatedAt)
    : []
  const pinnedRowIds = new Set(pinnedRows.map(session => session.id))
  const emit = (session: SessionSummary): void => {
    rows.push({ kind: 'session', session, depth: 0 })
    shown += 1
    for (const run of visibleChildren(session)) {
      if (pinnedRowIds.has(run.id)) continue
      rows.push({ kind: 'session', session: run, depth: 1 })
      shown += 1
    }
  }
  const ordered = pinnedRows.length > 0
    ? visible.filter(session => !pinnedRowIds.has(session.id))
    : visible
  if (pinnedRows.length > 0) {
    rows.push({ kind: 'pin', count: pinnedRows.length })
    for (const session of pinnedRows) emit(session)
  }
  ordered.sort((left, right) => right.updatedAt - left.updatedAt)
  const projectKey = (session: SessionSummary): string =>
    context.sameProject(context.cwd, session.cwd)
      ? 'current'
      : `cwd:${normalizeWorkspaceCwd(session.cwd) || '<unknown>'}`
  const projectDisplay = new Map<string, string>()
  const projectCounts = new Map<string, number>()
  if (filters.allProjects) {
    // Use the SAME buckets as the directory menu: current-workspace legacy
    // subdirectories coalesce, while foreign separator/case aliases share one
    // exact normalized key. This keeps the rail and "all" view consistent.
    const projectOrder = new Map<string, number>()
    for (const session of ordered) {
      const key = projectKey(session)
      if (!projectOrder.has(key)) projectOrder.set(key, projectOrder.size)
      projectDisplay.set(key, key === 'current' ? context.cwd : projectDisplay.get(key) ?? session.cwd)
      projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1)
    }
    ordered.sort((left, right) =>
      projectOrder.get(projectKey(left))! - projectOrder.get(projectKey(right))! || right.updatedAt - left.updatedAt)
  }
  for (const session of ordered) {
    // Group headers only earn their line when more than one project is in
    // play; inside a single project they would repeat the same path forever.
    const key = projectKey(session)
    if (filters.allProjects && key !== lastProjectKey) {
      lastProjectKey = key
      rows.push({
        kind: 'project',
        project: projectDisplay.get(key) ?? session.cwd,
        count: projectCounts.get(key) ?? 0,
      })
    }
    emit(session)
  }

  return {
    rows,
    shown,
    hiddenSubagents: filters.showSubagents ? 0 : runs.length,
    emptyCount: emptyIds.length,
    emptyIds,
  }
}

/**
 * Index of the first selectable row at or after `from`.
 *
 * Group headers are rows but not targets, so every movement resolves through
 * here rather than each caller re-deriving "is this one selectable".
 *
 * @param rows - The view's rows.
 * @param from - Where to start looking.
 * @param step - +1 to search forward, -1 backward.
 * @returns The index, or -1 when no selectable row lies that way.
 */
export function seekSelectable(rows: readonly BrowserRow[], from: number, step: 1 | -1): number {
  for (let at = from; at >= 0 && at < rows.length; at += step) {
    if (rows[at]?.kind === 'session') return at
  }
  return -1
}

/**
 * Move the selection by one selectable row, wrapping at both ends.
 *
 * @param rows - The view's rows.
 * @param current - Current index.
 * @param step - +1 for down, -1 for up.
 * @returns The new index, or the current one when nothing is selectable.
 */
export function moveSelection(rows: readonly BrowserRow[], current: number, step: 1 | -1): number {
  const next = seekSelectable(rows, current + step, step)
  if (next >= 0) return next
  const wrapped = seekSelectable(rows, step === 1 ? 0 : rows.length - 1, step)
  return wrapped >= 0 ? wrapped : current
}

/** The session under the cursor, when the cursor is on one. */
export function sessionAt(rows: readonly BrowserRow[], index: number): SessionSummary | undefined {
  const row = rows[index]
  return row?.kind === 'session' ? row.session : undefined
}

/** Lines one row occupies: a session shows a title and a metadata line. */
export function rowHeight(row: BrowserRow): number {
  return row.kind === 'session' ? 2 : 1
}

/**
 * Where the visible window should start.
 *
 * Rows have different heights, so the window cannot be `focus ± n`: a slice
 * that looks right by index can overflow the box by lines, and a fixed-height
 * box whose content overflows renders its rows on top of each other. This
 * resolves the window in LINES, which is the unit the box is measured in.
 *
 * The window is anchored rather than centred: it moves only as far as it must
 * to keep the focused row fully visible, so scrolling a long list does not
 * re-shuffle everything on screen under every keystroke.
 *
 * @param rows - The view's rows.
 * @param focus - Index of the focused row.
 * @param budget - Lines available to the list.
 * @param previous - The previous window start, so a stationary focus keeps a
 *   stationary window.
 * @returns The new window start index.
 */
export function anchorTop(
  rows: readonly BrowserRow[],
  focus: number,
  budget: number,
  previous: number,
): number {
  if (rows.length === 0 || budget <= 0) return 0
  let top = Math.min(Math.max(0, previous), Math.max(0, rows.length - 1))
  if (focus < top) top = focus
  // Scroll down only until the focused row's last line fits.
  for (;;) {
    let used = 0
    for (let at = top; at <= focus; at++) used += rowHeight(rows[at]!)
    if (used <= budget || top >= focus) break
    top += 1
  }
  // A window that has slack below the last row wastes it; pull the start back
  // up so the final screenful is full rather than ragged.
  let total = 0
  for (let at = top; at < rows.length; at++) total += rowHeight(rows[at]!)
  while (top > 0 && total + rowHeight(rows[top - 1]!) <= budget) {
    top -= 1
    total += rowHeight(rows[top]!)
  }
  return top
}

/**
 * How many rows starting at `top` fit in `budget` lines.
 *
 * @param rows - The view's rows.
 * @param top - First visible row.
 * @param budget - Lines available.
 * @returns Exclusive end index of the visible slice.
 */
export function windowEnd(rows: readonly BrowserRow[], top: number, budget: number): number {
  let used = 0
  let at = top
  while (at < rows.length) {
    const next = used + rowHeight(rows[at]!)
    if (next > budget) break
    used = next
    at += 1
  }
  return at
}
