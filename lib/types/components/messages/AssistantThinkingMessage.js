import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../../ui.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { Markdown } from '../Markdown.js';
import { formatDuration } from '../../cc/format.js';
/**
 * Thinking block: folded `∴ Thinking (ctrl+o to expand)`, expanded shows the
 * full reasoning text indented under `∴ Thinking…` (ported from the leak's
 * `messages/AssistantThinkingMessage.tsx`). When the channel records the
 * reasoning duration, the label carries it (`∴ Thinking · 12s …`) — dsh-tui's
 * take on making thinking time visible in the transcript.
 */
export function AssistantThinkingMessage({ thinking, addMargin, verbose, durationMs, isSelected = false, onClick, }) {
    if (!thinking)
        return null;
    const duration = durationMs !== undefined && durationMs >= 1000
        ? ` · ${formatDuration(durationMs)}`
        : '';
    if (!verbose) {
        return (_jsx(Box, { marginTop: addMargin ? 1 : 0, backgroundColor: isSelected ? 'messageActionsBackground' : undefined, onClick: onClick, children: _jsxs(Text, { dimColor: true, italic: true, children: ["\u2234 Thinking", duration, ' ', _jsx(Text, { dimColor: true, children: _jsx(KeyboardShortcutHint, { shortcut: "ctrl+o", action: "expand", parens: true }) })] }) }));
    }
    return (_jsxs(Box, { flexDirection: "column", gap: 1, marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: isSelected ? 'messageActionsBackground' : undefined, onClick: onClick, children: [_jsxs(Text, { dimColor: true, italic: true, children: ["\u2234 Thinking", duration, "\u2026"] }), _jsx(Box, { paddingLeft: 2, children: _jsx(Markdown, { dimColor: true, children: thinking }) })] }));
}
