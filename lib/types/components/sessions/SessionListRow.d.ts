import React from 'react';
import type { SessionSummary } from '../../dsh-adapter/sessions/index.js';
/**
 * One session in the browser's list: a title line and a metadata line.
 *
 * Two lines rather than one because the two carry different jobs. The title
 * answers "is this the conversation I mean"; the metadata answers "which of
 * the three that look alike is it" — when it was, on what branch, how big,
 * under which model. Folding both onto one line makes the title compete with
 * facts nobody reads first, and on a narrow terminal the title is what loses.
 *
 * Widths are resolved here rather than delegated to flexbox: the row must
 * stay exactly two lines at every terminal width, and a row that wraps
 * destroys the alignment that lets the eye scan a list at all.
 */
export declare function SessionListRow({ session, width, depth, focused, now, }: {
    session: SessionSummary;
    /** Columns available to the row, indentation included. */
    width: number;
    /** 0 for a conversation, 1 for a sub-agent run under its parent. */
    depth: number;
    focused: boolean;
    /** Epoch ms used for every relative time in this render pass. */
    now: number;
}): React.ReactNode;
//# sourceMappingURL=SessionListRow.d.ts.map