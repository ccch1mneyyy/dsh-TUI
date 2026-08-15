import React from 'react';
import { type TraceEntry, type TraceFilter } from '../dsh-adapter/trace.js';
/** Rows of the timeline visible at once (the window scrolls with the cursor). */
export declare const TRACE_WINDOW = 12;
/**
 * The `/trace` trajectory view (issue #80, TUI 对齐官方 web 端「轨迹」tab):
 * a read-only, scrollable one-line-per-event timeline of the session —
 * `HH:MM:SS  图标  摘要  (耗时)`. `entries` arrives pre-filtered from the
 * Chat screen (which owns the cursor, the `f` type filter and the /thinking
 * gate); this component only renders the cursor-centered window.
 */
export declare function TraceView({ entries, cursor, filter, }: {
    /** Pre-filtered timeline (type filter + thinking gate already applied). */
    entries: readonly TraceEntry[];
    /** Focused row index into `entries` (clamped by the caller). */
    cursor: number;
    /** Active type filter (drives the header label). */
    filter: TraceFilter;
}): React.ReactNode;
//# sourceMappingURL=TraceView.d.ts.map