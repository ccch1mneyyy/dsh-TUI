import React from 'react';
import type { SessionRecord } from '../sessionHistory.js';
/**
 * `/resume` session picker in the CC ModelPicker style: a Pane with the
 * recent sessions as Select rows (title + time description, ✓ on the
 * current session), plus the Enter/Esc hint line. Only WINDOW rows render;
 * the window follows the focused row, with `↑ N more` / `↓ N more` markers
 * at the edges.
 */
export declare function ResumePicker({ sessions, focusIndex, currentSessionId, }: {
    sessions: readonly SessionRecord[];
    focusIndex: number;
    currentSessionId: string;
}): React.ReactNode;
//# sourceMappingURL=ResumePicker.d.ts.map