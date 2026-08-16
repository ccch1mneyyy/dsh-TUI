/** The browser's default view: this project, conversations only. */
export const DEFAULT_FILTERS = {
    query: '',
    allProjects: false,
    branchOnly: false,
    showSubagents: false,
};
/** Case-insensitive substring test over the fields a reader would search by. */
function matches(session, needle) {
    if (needle.length === 0)
        return true;
    const haystack = [
        session.title.text,
        session.cwd,
        session.branch ?? '',
        session.model ?? '',
        session.label ?? '',
        session.agentPreset ?? '',
    ];
    return haystack.some(field => field.toLowerCase().includes(needle));
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
 * @returns The flat row list and the counts behind what it hides.
 */
export function buildView(sessions, filters, context) {
    const needle = filters.query.trim().toLowerCase();
    const inScope = (session) => session.id !== context.currentId &&
        (filters.allProjects || context.sameProject(context.cwd, session.cwd));
    // Empty sessions never reach a view, but they are counted — and the count
    // feeds a DESTRUCTIVE action, so it is scoped exactly as the list is.
    // Counting them across every project while showing one project's rows would
    // put "clean up 15 sessions" on screen next to six, and deleting another
    // project's history from a view that never mentioned it is not a surprise
    // anyone should get. The search query deliberately does NOT narrow it:
    // typing a filter is about finding one session, not about redefining what
    // "empty" means.
    const emptyIds = [];
    for (const session of sessions) {
        if (!session.hasPrompt && inScope(session))
            emptyIds.push(session.id);
    }
    const empty = new Set(emptyIds);
    const eligible = sessions.filter(session => inScope(session) &&
        !empty.has(session.id) &&
        (!filters.branchOnly || (context.branch !== undefined && session.branch === context.branch)));
    const conversations = eligible.filter(session => session.kind.kind !== 'subagent');
    const runs = eligible.filter(session => session.kind.kind === 'subagent');
    // A run is shown under its parent; one whose parent is not in this view
    // (filtered out, or never listed) would otherwise be unreachable, so it is
    // offered at the top level instead of silently dropped.
    const byParent = new Map();
    const orphans = [];
    const visibleIds = new Set(conversations.map(session => session.id));
    for (const run of runs) {
        const parent = run.kind.kind === 'subagent' ? run.kind.parent : undefined;
        if (parent !== undefined && visibleIds.has(parent)) {
            const siblings = byParent.get(parent);
            if (siblings === undefined)
                byParent.set(parent, [run]);
            else
                siblings.push(run);
        }
        else {
            orphans.push(run);
        }
    }
    const top = filters.showSubagents ? [...conversations, ...orphans] : conversations;
    const visible = top.filter(session => {
        if (matches(session, needle))
            return true;
        // A parent whose own text does not match is still shown when one of its
        // runs does — hiding it would strand the match under a row that is gone.
        if (!filters.showSubagents)
            return false;
        return (byParent.get(session.id) ?? []).some(run => matches(run, needle));
    });
    const rows = [];
    let shown = 0;
    let lastProject;
    for (const session of visible.sort((left, right) => right.updatedAt - left.updatedAt)) {
        // Group headers only earn their line when more than one project is in
        // play; inside a single project they would repeat the same path forever.
        if (filters.allProjects && session.cwd !== lastProject) {
            lastProject = session.cwd;
            rows.push({
                kind: 'project',
                project: session.cwd,
                count: visible.filter(other => other.cwd === session.cwd).length,
            });
        }
        rows.push({ kind: 'session', session, depth: 0 });
        shown += 1;
        if (!filters.showSubagents)
            continue;
        for (const run of (byParent.get(session.id) ?? []).filter(child => matches(child, needle) || matches(session, needle))) {
            rows.push({ kind: 'session', session: run, depth: 1 });
            shown += 1;
        }
    }
    return {
        rows,
        shown,
        hiddenSubagents: filters.showSubagents ? 0 : runs.length,
        emptyCount: emptyIds.length,
        emptyIds,
    };
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
export function seekSelectable(rows, from, step) {
    for (let at = from; at >= 0 && at < rows.length; at += step) {
        if (rows[at]?.kind === 'session')
            return at;
    }
    return -1;
}
/**
 * Move the selection by one selectable row, wrapping at both ends.
 *
 * @param rows - The view's rows.
 * @param current - Current index.
 * @param step - +1 for down, -1 for up.
 * @returns The new index, or the current one when nothing is selectable.
 */
export function moveSelection(rows, current, step) {
    const next = seekSelectable(rows, current + step, step);
    if (next >= 0)
        return next;
    const wrapped = seekSelectable(rows, step === 1 ? 0 : rows.length - 1, step);
    return wrapped >= 0 ? wrapped : current;
}
/** The session under the cursor, when the cursor is on one. */
export function sessionAt(rows, index) {
    const row = rows[index];
    return row?.kind === 'session' ? row.session : undefined;
}
/** Lines one row occupies: a session shows a title and a metadata line. */
export function rowHeight(row) {
    return row.kind === 'session' ? 2 : 1;
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
export function anchorTop(rows, focus, budget, previous) {
    if (rows.length === 0 || budget <= 0)
        return 0;
    let top = Math.min(Math.max(0, previous), Math.max(0, rows.length - 1));
    if (focus < top)
        top = focus;
    // Scroll down only until the focused row's last line fits.
    for (;;) {
        let used = 0;
        for (let at = top; at <= focus; at++)
            used += rowHeight(rows[at]);
        if (used <= budget || top >= focus)
            break;
        top += 1;
    }
    // A window that has slack below the last row wastes it; pull the start back
    // up so the final screenful is full rather than ragged.
    let total = 0;
    for (let at = top; at < rows.length; at++)
        total += rowHeight(rows[at]);
    while (top > 0 && total + rowHeight(rows[top - 1]) <= budget) {
        top -= 1;
        total += rowHeight(rows[top]);
    }
    return top;
}
/**
 * How many rows starting at `top` fit in `budget` lines.
 *
 * @param rows - The view's rows.
 * @param top - First visible row.
 * @param budget - Lines available.
 * @returns Exclusive end index of the visible slice.
 */
export function windowEnd(rows, top, budget) {
    let used = 0;
    let at = top;
    while (at < rows.length) {
        const next = used + rowHeight(rows[at]);
        if (next > budget)
            break;
        used = next;
        at += 1;
    }
    return at;
}
