import React from 'react';
import type { TuiWorkspaceChoice } from '../workspaces.js';
/** Generic nested choice surface returned by a workspace provider command. */
export declare function WorkspaceFlowPicker({ title, choices, focusIndex, busy, input, }: {
    title: string;
    choices: readonly TuiWorkspaceChoice[];
    focusIndex: number;
    busy?: boolean;
    input?: {
        value: string;
        cursor: number;
        placeholder?: string;
    } | null;
}): React.ReactNode;
//# sourceMappingURL=WorkspaceFlowPicker.d.ts.map