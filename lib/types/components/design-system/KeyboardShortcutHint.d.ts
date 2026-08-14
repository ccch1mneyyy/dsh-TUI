import React from 'react';
type Props = {
    /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
    shortcut: string;
    /** The action the key performs (e.g., "expand", "select", "navigate") */
    action: string;
    /** Whether to wrap the hint in parentheses. Default: false */
    parens?: boolean;
    /** Whether to render the shortcut in bold. Default: false */
    bold?: boolean;
};
/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 * (ported from the leak's design-system). Wrap in `<Text dimColor>` for the
 * common dim styling.
 */
export declare function KeyboardShortcutHint({ shortcut, action, parens, bold, }: Props): React.ReactNode;
export {};
//# sourceMappingURL=KeyboardShortcutHint.d.ts.map