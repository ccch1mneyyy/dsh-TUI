import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
/** Compact timestamp like `Jan 2, 03:04` for the resume list. */
function formatTimestamp(ms) {
    const date = new Date(ms);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}
/** Visible list window: the picker scrolls instead of dumping every session
 *  (long histories would fill the whole screen otherwise). */
const WINDOW = 8;
/**
 * `/resume` session picker in the CC ModelPicker style: a Pane with the
 * recent sessions as Select rows (title + time description, ✓ on the
 * current session), plus the Enter/Esc hint line. Only WINDOW rows render;
 * the window follows the focused row, with `↑ N more` / `↓ N more` markers
 * at the edges.
 */
export function ResumePicker({ sessions, focusIndex, currentSessionId, }) {
    const start = Math.max(0, Math.min(focusIndex - Math.floor(WINDOW / 2), sessions.length - WINDOW));
    const visible = sessions.slice(start, start + WINDOW);
    const above = start;
    const below = Math.max(0, sessions.length - (start + WINDOW));
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: "Resume" }) }), above > 0 && (_jsxs(Text, { dimColor: true, italic: true, children: ["\u2191 ", above, " more"] })), visible.map(session => (_jsx(ListItem, { isFocused: session.id === sessions[focusIndex]?.id, isSelected: session.id === currentSessionId, description: formatTimestamp(session.updatedAt), children: session.title || session.id }, session.id))), below > 0 && (_jsxs(Text, { dimColor: true, italic: true, children: ["\u2193 ", below, " more"] }))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsxs(Byline, { children: [_jsx(KeyboardShortcutHint, { shortcut: "Enter", action: "confirm", bold: true }), _jsx(KeyboardShortcutHint, { shortcut: "Esc", action: "exit" })] }) })] }));
}
