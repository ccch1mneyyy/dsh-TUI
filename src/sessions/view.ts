/**
 * The session browser's view model.
 *
 * Every decision about *which* sessions are on screen and in what order lives
 * here, as one pure function from the full list plus the current filters to a
 * flat list of rows. Two reasons it is shaped that way:
 *
 * - Filtering is where this feature's bugs were. Keeping it pure means the
 *   truth table — a sub-agent run is hidden, a rewind fork is not, a boot
 *   artifact is hidden but counted — is checkable without rendering anything.
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
  | {
    readonly kind: 'session'
    readonly session: SessionSummary
    readonly depth: number
    /**
     * Fork-family membership. A family is one conversation plus every rewind
     * fork descending from it; the list folds it to its newest member. `rep`
     * marks the row standing in for the folded family (carries the size and
     * the expand state); `member` marks a row revealed by expanding one.
     */
    readonly family?:
      | { readonly role: 'rep'; readonly anchor: string; readonly size: number; readonly expanded: boolean }
      | { readonly role: 'member'; readonly anchor: string; readonly rep: string }
  }

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
 * @param expandedFamilies - Anchors of fork families currently expanded by
 *   the user. A family is one conversation plus every rewind fork descending
 *   from it; collapsed it shows only its newest member.
 * @returns The flat row list and the counts behind what it hides.
 */
export function buildView(
  sessions: readonly SessionSummary[],
  filters: BrowserFilters,
  context: { cwd: string; branch: string | undefined; currentId: string; sameProject: (a: string, b: string) => boolean },
  expandedFamilies: ReadonlySet<string> = new Set<string>(),
): BrowserView {
  const needle = filters.query.trim().toLowerCase()

  const inScope = (session: SessionSummary): boolean =>
    session.id !== context.currentId &&
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

  // ── fork families ──────────────────────────────────────────────────────
  // A rewind fork is a branch of its parent conversation, not a new
  // conversation: folding each family to its most recently active member
  // keeps one rewind per retry from walling the list off behind copies of
  // the same chat. Anchors walk the FULL session list — a fork whose parent
  // was deleted (or lives outside this view's project scope) anchors at
  // itself, which is simply a family of one. Folding lifts while a search
  // query is live: a folded member matching the query must stay directly
  // reachable.
  const folding = needle.length === 0
  const byId = new Map(sessions.map(session => [session.id, session] as const))
  const anchorOf = (session: SessionSummary): string => {
    let current = session
    const seen = new Set<string>([current.id])
    while (current.kind.kind === 'fork') {
      const parent = byId.get(current.kind.parent)
      if (parent === undefined || seen.has(parent.id)) return current.id
      seen.add(parent.id)
      current = parent
    }
    return current.id
  }
  const familyOf = new Map<string, SessionSummary[]>()
  for (const session of conversations) {
    const anchor = folding ? anchorOf(session) : session.id
    const members = familyOf.get(anchor)
    if (members === undefined) familyOf.set(anchor, [session])
    else members.push(session)
  }
  interface Family {
    readonly anchor: string
    /** The family's row: its most recently active member (MRU tip). */
    readonly rep: SessionSummary
    /** Every member, newest first — `members[0]` is the rep. */
    readonly members: readonly SessionSummary[]
  }
  const families: Family[] = []
  for (const [anchor, members] of familyOf) {
    const ordered = [...members].sort((left, right) => right.updatedAt - left.updatedAt)
    families.push({ anchor, rep: ordered[0]!, members: ordered })
  }
  const familyByRep = new Map(families.map(family => [family.rep.id, family] as const))
  const representatives = families.map(family => family.rep)

  // Conversation rows this view will emit: one rep per family, plus every
  // member of an expanded family. Runs attach only to emitted rows — a run
  // whose parent is folded away waits for the expansion with its parent,
  // instead of surfacing as a top-level orphan with no context.
  const emittedIds = new Set<string>()
  const foldedMemberIds = new Set<string>()
  for (const family of families) {
    emittedIds.add(family.rep.id)
    const expand = family.members.length > 1 && expandedFamilies.has(family.anchor)
    for (const member of family.members) {
      if (expand) emittedIds.add(member.id)
      else if (member.id !== family.rep.id) foldedMemberIds.add(member.id)
    }
  }

  // A run is shown under its parent; one whose parent is not in this view
  // (filtered out, or never listed) would otherwise be unreachable, so it is
  // offered at the top level instead of silently dropped.
  const byParent = new Map<string, SessionSummary[]>()
  const orphans: SessionSummary[] = []
  for (const run of runs) {
    const parent = run.kind.kind === 'subagent' ? run.kind.parent : undefined
    if (parent !== undefined && emittedIds.has(parent)) {
      const siblings = byParent.get(parent)
      if (siblings === undefined) byParent.set(parent, [run])
      else siblings.push(run)
    } else if (parent !== undefined && foldedMemberIds.has(parent)) {
      // Folded with its parent — the family's expansion reveals both.
    } else {
      orphans.push(run)
    }
  }

  const top = filters.showSubagents ? [...representatives, ...orphans] : representatives
  const visible = top.filter(session => {
    if (matches(session, needle)) return true
    // A parent whose own text does not match is still shown when one of its
    // runs does — hiding it would strand the match under a row that is gone.
    if (!filters.showSubagents) return false
    return (byParent.get(session.id) ?? []).some(run => matches(run, needle))
  })

  const rows: BrowserRow[] = []
  let shown = 0
  let lastProject: string | undefined
  const ordered = visible.sort((left, right) => right.updatedAt - left.updatedAt)
  if (filters.allProjects) {
    // Order project groups by their newest visible session, then keep every
    // session from that project together in MRU order. A global MRU sort alone
    // can interleave A/B/A and emit the same project header more than once.
    const projectOrder = new Map<string, number>()
    for (const session of ordered) {
      if (!projectOrder.has(session.cwd)) projectOrder.set(session.cwd, projectOrder.size)
    }
    ordered.sort((left, right) =>
      projectOrder.get(left.cwd)! - projectOrder.get(right.cwd)! || right.updatedAt - left.updatedAt)
  }
  for (const session of ordered) {
    // Group headers only earn their line when more than one project is in
    // play; inside a single project they would repeat the same path forever.
    if (filters.allProjects && session.cwd !== lastProject) {
      lastProject = session.cwd
      rows.push({
        kind: 'project',
        project: session.cwd,
        count: visible.filter(other => other.cwd === session.cwd).length,
      })
    }
    const family = familyByRep.get(session.id)
    const expanded = family !== undefined && family.members.length > 1 && expandedFamilies.has(family.anchor)
    rows.push({
      kind: 'session',
      session,
      depth: 0,
      ...(family !== undefined && family.members.length > 1
        ? { family: { role: 'rep' as const, anchor: family.anchor, size: family.members.length, expanded } }
        : {}),
    })
    shown += 1
    if (expanded && family !== undefined) {
      for (const member of family.members) {
        if (member.id === session.id) continue
        rows.push({
          kind: 'session',
          session: member,
          depth: 1,
          family: { role: 'member' as const, anchor: family.anchor, rep: session.id },
        })
        shown += 1
        if (!filters.showSubagents) continue
        for (const run of (byParent.get(member.id) ?? []).filter(child => matches(child, needle) || matches(member, needle))) {
          rows.push({ kind: 'session', session: run, depth: 2 })
          shown += 1
        }
      }
    }
    if (!filters.showSubagents) continue
    for (const run of (byParent.get(session.id) ?? []).filter(child => matches(child, needle) || matches(session, needle))) {
      rows.push({ kind: 'session', session: run, depth: 1 })
      shown += 1
    }
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
