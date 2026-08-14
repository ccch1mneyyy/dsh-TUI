import React from 'react';
import type { LocalCommand } from '../commands.js';
/**
 * The slash-command suggestion overlay, ported from the leak's
 * `PromptInputFooterSuggestions.tsx` (command layout only): a name column
 * padded to a fixed width, optional `[tag]`, then a truncated description.
 * The selected row renders in the theme's `suggestion` color, others dim.
 */
export declare function CommandSuggestions({ commands, selectedIndex, columns, }: {
    commands: readonly LocalCommand[];
    selectedIndex: number;
    columns: number;
}): React.ReactNode;
//# sourceMappingURL=CommandSuggestions.d.ts.map