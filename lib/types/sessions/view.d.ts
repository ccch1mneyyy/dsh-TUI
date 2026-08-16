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
import type { SessionSummary } from '../dsh-adapter/sessions/index.js';
/** What the browser is currently showing. */
export interface BrowserFilters {
    /** Free-text query; empty means no text filter. */
    readonly query: string;
    /** Show every project, not just the session's own working directory. */
    readonly allProjects: boolean;
    /** Show only sessions last used on the current git branch. */
    readonly branchOnly: boolean;
    /** Reveal delegated sub-agent runs, indented under their parents. */
    readonly showSubagents: boolean;
}
/** The browser's default view: this project, conversations only. */
export declare const DEFAULT_FILTERS: BrowserFilters;
/** One line in the browser's list. */
export type BrowserRow = {
    readonly kind: 'project';
    readonly project: string;
    readonly count: number;
} | {
    readonly kind: 'session';
    readonly session: SessionSummary;
    readonly depth: number;
};
/** The rendered list plus what it left out and why. */
export interface BrowserView {
    readonly rows: readonly BrowserRow[];
    /** Sessions shown, excluding group headers. */
    readonly shown: number;
    /** Delegated runs folded away by the current filters. */
    readonly hiddenSubagents: number;
    /** Sessions with no conversation in them, never listed but worth counting. */
    readonly emptyCount: number;
    /** Ids of those empty sessions, for the cleanup action. */
    readonly emptyIds: readonly string[];
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
export declare function buildView(sessions: readonly SessionSummary[], filters: BrowserFilters, context: {
    cwd: string;
    branch: string | undefined;
    currentId: string;
    sameProject: (a: string, b: string) => boolean;
}): BrowserView;
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
export declare function seekSelectable(rows: readonly BrowserRow[], from: number, step: 1 | -1): number;
/**
 * Move the selection by one selectable row, wrapping at both ends.
 *
 * @param rows - The view's rows.
 * @param current - Current index.
 * @param step - +1 for down, -1 for up.
 * @returns The new index, or the current one when nothing is selectable.
 */
export declare function moveSelection(rows: readonly BrowserRow[], current: number, step: 1 | -1): number;
/** The session under the cursor, when the cursor is on one. */
export declare function sessionAt(rows: readonly BrowserRow[], index: number): SessionSummary | undefined;
/** Lines one row occupies: a session shows a title and a metadata line. */
export declare function rowHeight(row: BrowserRow): number;
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
export declare function anchorTop(rows: readonly BrowserRow[], focus: number, budget: number, previous: number): number;
/**
 * How many rows starting at `top` fit in `budget` lines.
 *
 * @param rows - The view's rows.
 * @param top - First visible row.
 * @param budget - Lines available.
 * @returns Exclusive end index of the visible slice.
 */
export declare function windowEnd(rows: readonly BrowserRow[], top: number, budget: number): number;
//# sourceMappingURL=view.d.ts.map