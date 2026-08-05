import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
import { Divider } from './design-system/Divider.js';
import { UserPromptMessage } from './messages/UserPromptMessage.js';
import { AssistantTextMessage } from './messages/AssistantTextMessage.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js';
import { InterruptedByUser } from './InterruptedByUser.js';
import { LogoV2 } from './LogoV2.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';
import { MessageMetadata } from './messages/MessageMetadata.js';
import { stripNarration } from '../utils/narration.js';
/**
 * Transcript rows rendered in the Claude Code visual language: user prompts
 * on a grey bubble with a `❯` pointer, assistant text with a `●` bullet and
 * markdown, thinking folded to `∴ Thinking (ctrl+o to expand)`, tool calls as
 * status-dot cards. `expanded` (Ctrl+O) shows full reasoning + full tool
 * args/results; `expandedRows` (message-selection mode, Enter) expands single
 * rows; `selectedId` highlights the selected row.
 */
/** Render cap for very long sessions (CC's MAX_MESSAGES_WITHOUT_VIRTUALIZATION
 *  equivalent): older rows fold behind a Divider until Ctrl+E expands them. */
const MAX_RENDERED_ROWS = 300;
export function MessageList({ rows, expanded, expandedRows, selectedId, onToggleRow, model, showAll, onToggleAll, thinkingVisible = true, registerRowRef, }) {
    const hiddenCount = rows.length - MAX_RENDERED_ROWS;
    const visibleRows = showAll || hiddenCount <= 0
        ? rows
        : rows.slice(hiddenCount);
    let previousKind;
    // CC's expanded rows keep a persistent hover-grey background (VirtualItem:
    // `expanded ? userMessageBackgroundHover : undefined`).
    const rowBackground = (rowId) => {
        const isSelected = selectedId === rowId;
        if (isSelected)
            return 'messageActionsBackground';
        if (expandedRows.has(rowId))
            return 'userMessageBackgroundHover';
        return undefined;
    };
    return (_jsxs(_Fragment, { children: [!showAll && hiddenCount > 0 && (_jsx(Box, { marginTop: 1, onClick: onToggleAll, children: _jsx(Divider, { title: ` ctrl+e to show ${hiddenCount} previous messages ` }) })), visibleRows
                .filter(row => thinkingVisible || row.kind !== 'reasoning')
                .map(row => {
                // CC addMargin: every rendered block gets a 1-row top margin, so user
                // prompts, thinking, tool calls and assistant text all breathe apart.
                // (CC's MessageRow passes addMargin=true for every message in prompt
                // mode; only the first row has no preceding block.)
                const prev = previousKind;
                previousKind = row.kind;
                const addMargin = prev !== undefined;
                const isSelected = selectedId === row.id;
                const isExpanded = expanded || expandedRows.has(row.id);
                switch (row.kind) {
                    case 'user':
                        return (_jsx(Box, { flexDirection: "column", ref: el => registerRowRef?.(row.id, el), children: _jsx(UserPromptMessage, { text: row.text, addMargin: addMargin, isSelected: isSelected, isExpanded: expandedRows.has(row.id), onClick: () => onToggleRow(row.id) }) }, row.id));
                    case 'assistant':
                        return row.streaming ? (_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: rowBackground(row.id), children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(row.text) }) })] }, row.id)) : (_jsxs(Box, { width: "100%", flexDirection: "column", backgroundColor: rowBackground(row.id), ref: el => registerRowRef?.(row.id, el), children: [expanded && (_jsx(Box, { flexDirection: "row", justifyContent: "flex-end", gap: 1, marginTop: 1, children: _jsx(MessageMetadata, { timestamp: row.time, model: model }) })), _jsx(AssistantTextMessage, { text: stripNarration(row.text), addMargin: addMargin, isSelected: isSelected, isExpanded: expandedRows.has(row.id), onClick: () => onToggleRow(row.id) })] }, row.id));
                    case 'reasoning':
                        return (_jsx(Box, { flexDirection: "column", ref: el => registerRowRef?.(row.id, el), children: _jsx(AssistantThinkingMessage, { thinking: row.text, addMargin: addMargin, 
                                // Streaming reasoning shows expanded live, then folds
                                // automatically once the turn settles (unless Ctrl+O or a
                                // single-row expansion keeps it open).
                                verbose: isExpanded || row.streaming === true, durationMs: row.durationMs, isSelected: isSelected, onClick: () => onToggleRow(row.id) }) }, row.id));
                    case 'tool':
                        return row.tool ? (_jsx(Box, { flexDirection: "column", ref: el => registerRowRef?.(row.id, el), children: _jsx(AssistantToolUseMessage, { tool: row.tool, addMargin: addMargin, verbose: isExpanded, isSelected: isSelected, isExpanded: expandedRows.has(row.id) }) }, row.id)) : null;
                    case 'notice':
                        return (_jsx(Box, { marginTop: 1, ref: el => registerRowRef?.(row.id, el), children: _jsx(Divider, { title: ` ${row.text} ` }) }, row.id));
                    case 'interrupt':
                        return (_jsx(Box, { marginTop: 1, ref: el => registerRowRef?.(row.id, el), children: _jsx(InterruptedByUser, {}) }, row.id));
                    case 'local':
                        // `!` mode command echo, like CC's UserBashInputMessage.
                        return (_jsx(Box, { marginTop: 1, backgroundColor: rowBackground(row.id), ref: el => registerRowRef?.(row.id, el), children: _jsxs(Text, { color: "bashBorder", children: ["! ", row.text] }) }, row.id));
                    case 'local-output':
                        return (_jsx(Box, { paddingLeft: 2, backgroundColor: rowBackground(row.id), ref: el => registerRowRef?.(row.id, el), children: _jsx(Text, { dimColor: true, children: row.text }) }, row.id));
                }
            })] }));
}
/**
 * The header block pinned above the transcript: the DeepSeek pixel whale
 * with the wordmark, tagline, model/effort and cwd (`LogoV2`), plus the
 * welcome line. It scrolls away with the transcript once the conversation
 * fills the viewport (Claude Code shows its ✦ logo in the same slot).
 */
export function LogoHeader({ model, effort, cwd, }) {
    return (_jsx(Box, { flexDirection: "column", marginBottom: 1, children: _jsx(LogoV2, { model: model, effort: effort, cwd: cwd }) }));
}
