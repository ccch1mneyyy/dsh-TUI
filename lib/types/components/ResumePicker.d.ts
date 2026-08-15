import React from 'react';
import type { SessionRecord } from '../sessionHistory.js';
/** Interaction mode of the `/resume` picker (issue #112). */
export type ResumePickerMode = 'list' | 'confirm-delete' | 'rename';
/**
 * `/resume` session picker in the CC ModelPicker style: a Pane with the
 * recent sessions as Select rows (title + time description, ✓ on the
 * current session), plus the hint line. Only WINDOW rows render; the window
 * follows the focused row, with `↑ N more` / `↓ N more` markers at the
 * edges.
 *
 * Beyond plain selection (pi-tui style session management, issue #112):
 *  - `confirm-delete` replaces the hints with a delete confirmation for the
 *    focused session (Enter deletes, Esc backs out);
 *  - `rename` shows an inline SearchBox editing the focused session's title
 *    (Enter saves, Esc discards).
 * Keyboard handling lives in the caller (Chat).
 */
export declare function ResumePicker({ sessions, focusIndex, currentSessionId, mode, renameText, }: {
    sessions: readonly SessionRecord[];
    focusIndex: number;
    currentSessionId: string;
    mode: ResumePickerMode;
    renameText: string;
}): React.ReactNode;
//# sourceMappingURL=ResumePicker.d.ts.map