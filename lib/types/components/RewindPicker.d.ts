import React from 'react';
import type { ChatRow } from '../channel.js';
/**
 * Double-Esc rewind picker (CC's "Double-tap esc to rewind the code and/or
 * conversation to a previous point in time"): lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 */
export declare function RewindPicker({ rows, focusIndex, confirmRow, }: {
    rows: readonly ChatRow[];
    focusIndex: number;
    confirmRow: ChatRow | null;
}): React.ReactNode;
//# sourceMappingURL=RewindPicker.d.ts.map