import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
/**
 * Double-Esc rewind picker (CC's "Double-tap esc to rewind the code and/or
 * conversation to a previous point in time"): lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 */
export function RewindPicker({ rows, focusIndex, confirmRow, }) {
    if (confirmRow !== null) {
        return (_jsx(Pane, { color: "permission", children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: "remember", bold: true, children: "Rewind conversation to this message?" }) }), _jsx(ListItem, { isFocused: false, description: "conversation restarts here", children: preview(confirmRow.text) }), _jsx(Text, { dimColor: true, italic: true, children: _jsxs(Byline, { children: [_jsx(KeyboardShortcutHint, { shortcut: "Enter", action: "rewind", bold: true }), _jsx(KeyboardShortcutHint, { shortcut: "Esc", action: "back" })] }) })] }) }));
    }
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { color: "remember", bold: true, children: "Rewind" }), _jsx(Text, { dimColor: true, children: "Pick a message to rewind the conversation to" })] }), rows.length === 0 ? (_jsx(ListItem, { isFocused: false, children: "No messages to rewind to" })) : (rows.map((row, index) => (_jsx(ListItem, { isFocused: index === focusIndex, description: index === 0 ? 'last message' : undefined, children: preview(row.text) }, row.id))))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsxs(Byline, { children: [_jsx(KeyboardShortcutHint, { shortcut: "Enter", action: "select", bold: true }), _jsx(KeyboardShortcutHint, { shortcut: "Esc", action: "exit" })] }) })] }));
}
/** One-line preview of a message (newlines flattened, capped). */
function preview(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}
