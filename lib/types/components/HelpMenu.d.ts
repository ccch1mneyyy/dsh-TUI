import React from 'react';
import type { LocalCommand } from '../commands.js';
/**
 * The `?` help menu, ported from the leak's `PromptInputHelpMenu.tsx`
 * (three-column shortcut layout, trimmed to the keys dsh-tui actually binds).
 * The command column lists the merged slash-command surface: built-in
 * commands plus plugin-registered ones from the DSH registry (plan/goal/…).
 */
export declare function HelpMenu({ commands, }: {
    commands: readonly LocalCommand[];
}): React.ReactNode;
//# sourceMappingURL=HelpMenu.d.ts.map