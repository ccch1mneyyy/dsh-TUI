import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Text from '../../ink/components/Text.js';
/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 * (ported from the leak's design-system). Wrap in `<Text dimColor>` for the
 * common dim styling.
 */
export function KeyboardShortcutHint({ shortcut, action, parens = false, bold = false, }) {
    const shortcutText = bold ? _jsx(Text, { bold: true, children: shortcut }) : shortcut;
    if (parens) {
        return (_jsxs(Text, { children: ["(", shortcutText, " to ", action, ")"] }));
    }
    return (_jsxs(Text, { children: [shortcutText, " to ", action] }));
}
