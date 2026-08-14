import React from 'react';
import { type HistoryEntry } from '../history.js';
/**
 * The ctrl+r history search dialog, in the shape of the leak's
 * HistorySearchDialog/FuzzyPicker: a permission-colored Pane with a bold
 * title, the ⌕ SearchBox, the filtered history as ListItem rows (newest
 * first), and the ↑/↓ · Enter · Esc hint line. Keyboard handling lives in
 * the caller (Chat).
 */
export declare function HistorySearchDialog({ query, cursorOffset, matches, focusIndex, }: {
    query: string;
    cursorOffset: number;
    matches: readonly HistoryEntry[];
    focusIndex: number;
}): React.ReactNode;
//# sourceMappingURL=HistorySearchDialog.d.ts.map