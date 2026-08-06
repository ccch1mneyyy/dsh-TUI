import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React from 'react';
import { Box, Text, useTerminalSize } from '../ui.js';
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
// --- layout virtualization constants -------------------------------------
// Offscreen rows render as fixed-height spacers whose heights come from the
// previous commit's Yoga layout, so the pure-JS Yoga engine never walks
// their subtrees. Spacers preserve the scroll geometry (content height,
// sticky follow, scrollbar) of a fully-mounted list.
/** Lines of extra content mounted above/below the visible window. */
const OVERSCAN_LINES = 8;
/** Fallback row height before the first measurement (terminal lines). */
const DEFAULT_ROW_HEIGHT = 2;
/** Cold-start estimate of the header block above the rows; corrected by the
 *  first layout measurement. */
const DEFAULT_HEADER_LINES = 14;
export function MessageList({ rows, expanded, expandedRows, selectedId, onToggleRow, model, showAll, onToggleAll, onLoadOlder, thinkingVisible = true, registerRowRef, scrollHandle, forceMountRowId, }) {
    const hiddenCount = rows.length - MAX_RENDERED_ROWS;
    // The thinking filter runs BEFORE virtualization so window indices line up.
    const visibleRows = (showAll || hiddenCount <= 0
        ? rows
        : rows.slice(hiddenCount)).filter(row => thinkingVisible || row.kind !== 'reasoning');
    // CC addMargin: every rendered block gets a 1-row top margin except the
    // first. Pre-pass over the FULL list so a windowed row keeps the exact
    // spacing it would have in a fully-mounted list.
    const margins = new Map();
    {
        let prev;
        for (const row of visibleRows) {
            margins.set(row.id, prev !== undefined);
            prev = row.kind;
        }
    }
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
    // --- layout virtualization ---------------------------------------------
    const { columns } = useTerminalSize();
    const heightsRef = React.useRef(new Map());
    const localRefs = React.useRef(new Map());
    /** Content-space offset of visibleRows[0] (header + dividers), measured. */
    const baseRef = React.useRef(null);
    const [, setMeasureTick] = React.useState(0);
    const [, setScrollTick] = React.useState(0);
    // A width change reflows every row — all measurements are stale.
    const lastColumns = React.useRef(columns);
    if (lastColumns.current !== columns) {
        lastColumns.current = columns;
        heightsRef.current.clear();
        baseRef.current = null;
    }
    // Scrolling bypasses React (imperative DOM scrollTop): subscribe so the
    // window follows the viewport.
    React.useEffect(() => {
        if (!scrollHandle)
            return;
        const tick = () => setScrollTick(t => t + 1);
        return scrollHandle.subscribe(tick);
    }, [scrollHandle]);
    const heightOf = (row) => heightsRef.current.get(row.id) ?? DEFAULT_ROW_HEIGHT;
    const offsets = new Array(visibleRows.length);
    let total = 0;
    for (let i = 0; i < visibleRows.length; i++) {
        offsets[i] = total;
        total += heightOf(visibleRows[i]);
    }
    const scrollTop = scrollHandle?.getScrollTop() ?? 0;
    const pending = scrollHandle?.getPendingDelta() ?? 0;
    const viewport = scrollHandle?.getViewportHeight() ?? 24;
    const sticky = scrollHandle?.isSticky() ?? true;
    const base = baseRef.current ?? DEFAULT_HEADER_LINES;
    // Mount the union of the committed position and any in-flight pending
    // delta, plus overscan; when sticky, always reach the tail (streaming row).
    const relTop = Math.min(scrollTop, scrollTop + pending) - OVERSCAN_LINES - base;
    const relBottom = Math.max(scrollTop, scrollTop + pending) + viewport + OVERSCAN_LINES - base;
    let start = 0;
    while (start < visibleRows.length && offsets[start] + heightOf(visibleRows[start]) <= relTop)
        start++;
    let end = start;
    while (end < visibleRows.length && offsets[end] < relBottom)
        end++;
    if (sticky || !scrollHandle)
        end = visibleRows.length;
    if (forceMountRowId !== undefined && forceMountRowId !== null) {
        const idx = visibleRows.findIndex(row => row.id === forceMountRowId);
        if (idx !== -1) {
            start = Math.min(start, idx);
            end = Math.max(end, idx + 1);
        }
    }
    const topPad = offsets[start] ?? 0;
    const mountedBottom = end < visibleRows.length ? offsets[end] : total;
    const bottomPad = total - mountedBottom;
    // Post-commit: measure mounted rows, derive the content-space base from
    // the first mounted row's Yoga top, and clamp render-time scrollTop to the
    // mounted coverage so burst scrolls never show blank spacer.
    React.useLayoutEffect(() => {
        let changed = false;
        for (const [id, el] of localRefs.current) {
            const h = el.yogaNode?.getComputedHeight();
            if (h !== undefined && h > 0 && heightsRef.current.get(id) !== h) {
                heightsRef.current.set(id, h);
                changed = true;
            }
        }
        const firstMounted = visibleRows[start];
        const firstEl = firstMounted ? localRefs.current.get(firstMounted.id) : undefined;
        const top = firstEl?.yogaNode?.getComputedTop();
        if (top !== undefined) {
            const measured = top - (offsets[start] ?? 0);
            if (baseRef.current !== measured) {
                baseRef.current = measured;
                changed = true;
            }
        }
        if (scrollHandle) {
            if (sticky || (start === 0 && end >= visibleRows.length)) {
                scrollHandle.setClampBounds(undefined, undefined);
            }
            else {
                const min = Math.max(0, base + topPad - viewport);
                scrollHandle.setClampBounds(min, Math.max(min, base + mountedBottom - viewport));
            }
        }
        if (changed)
            setMeasureTick(t => t + 1);
    });
    const setRowRef = (rowId, el) => {
        if (el)
            localRefs.current.set(rowId, el);
        else
            localRefs.current.delete(rowId);
        registerRowRef?.(rowId, el);
    };
    return (_jsxs(_Fragment, { children: [rows.some(row => row.folded) && (_jsx(Box, { marginTop: 1, onClick: onLoadOlder, children: _jsx(Divider, { title: ' ↑ 加载更早消息（会话日志完整，/export 导出全文） ' }) })), !showAll && hiddenCount > 0 && (_jsx(Box, { marginTop: 1, onClick: onToggleAll, children: _jsx(Divider, { title: ` ctrl+e to show ${hiddenCount} previous messages ` }) })), topPad > 0 && _jsx(Box, { height: topPad, flexShrink: 0 }), visibleRows
                .slice(start, end)
                .map((row) => {
                // CC addMargin: pre-pass result keeps windowed rows at full-mount
                // spacing; only the very first row of the whole list has none.
                const addMargin = margins.get(row.id) === true;
                const isSelected = selectedId === row.id;
                const isExpanded = expanded || expandedRows.has(row.id);
                switch (row.kind) {
                    case 'user':
                        return (_jsx(Box, { flexDirection: "column", ref: el => setRowRef(row.id, el), children: _jsx(UserPromptMessage, { text: row.text, addMargin: addMargin, isSelected: isSelected, isExpanded: expandedRows.has(row.id), onClick: () => { onToggleRow(row.id); } }) }, row.id));
                    case 'assistant':
                        return row.streaming ? (_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: rowBackground(row.id), children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(row.text) }) })] }, row.id)) : (_jsxs(Box, { width: "100%", flexDirection: "column", backgroundColor: rowBackground(row.id), ref: el => setRowRef(row.id, el), children: [expanded && (_jsx(Box, { flexDirection: "row", justifyContent: "flex-end", gap: 1, marginTop: 1, children: _jsx(MessageMetadata, { timestamp: row.time, model: model }) })), _jsx(AssistantTextMessage, { text: stripNarration(row.text), addMargin: addMargin, isSelected: isSelected, isExpanded: expandedRows.has(row.id), onClick: () => { onToggleRow(row.id); } })] }, row.id));
                    case 'reasoning':
                        return (_jsx(Box, { flexDirection: "column", ref: el => setRowRef(row.id, el), children: _jsx(AssistantThinkingMessage, { thinking: row.text, addMargin: addMargin, 
                                // Streaming reasoning shows expanded live, then folds
                                // automatically once the turn settles (unless Ctrl+O or a
                                // single-row expansion keeps it open).
                                verbose: isExpanded || row.streaming === true, durationMs: row.durationMs, isSelected: isSelected, onClick: () => { onToggleRow(row.id); } }) }, row.id));
                    case 'tool':
                        return row.tool ? (_jsx(Box, { flexDirection: "column", ref: el => setRowRef(row.id, el), children: _jsx(AssistantToolUseMessage, { tool: row.tool, addMargin: addMargin, verbose: isExpanded, isSelected: isSelected, isExpanded: expandedRows.has(row.id) }) }, row.id)) : null;
                    case 'notice':
                        return (_jsx(Box, { marginTop: 1, ref: el => setRowRef(row.id, el), children: _jsx(Divider, { title: ` ${row.text} ` }) }, row.id));
                    case 'interrupt':
                        return (_jsx(Box, { marginTop: 1, ref: el => setRowRef(row.id, el), children: _jsx(InterruptedByUser, {}) }, row.id));
                    case 'local':
                        // `!` mode command echo, like CC's UserBashInputMessage.
                        return (_jsx(Box, { marginTop: 1, backgroundColor: rowBackground(row.id), ref: el => setRowRef(row.id, el), children: _jsxs(Text, { color: "bashBorder", children: ["! ", row.text] }) }, row.id));
                    case 'local-output':
                        return (_jsx(Box, { paddingLeft: 2, backgroundColor: rowBackground(row.id), ref: el => setRowRef(row.id, el), children: _jsx(Text, { dimColor: true, children: row.text }) }, row.id));
                }
            }), bottomPad > 0 && _jsx(Box, { height: bottomPad, flexShrink: 0 })] }));
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
//# sourceMappingURL=MessageList.js.map