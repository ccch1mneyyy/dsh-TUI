import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { t } from '../i18n.js';
import { Box, Text, useTerminalSize } from '../ui.js';
import { Divider } from './design-system/Divider.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { UserPromptMessage } from './messages/UserPromptMessage.js';
import { AssistantTextMessage } from './messages/AssistantTextMessage.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js';
import { InterruptedByUser } from './InterruptedByUser.js';
import { LogoV2 } from './LogoV2.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';
import { MessageMetadata } from './messages/MessageMetadata.js';
import { stripNarration } from '../utils/narration.js';
import { stringWidth } from '../ink/stringWidth.js';
import { truncateToWidth } from '../ink/truncateToWidth.js';
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
export function MessageList({ rows, expanded, expandedRows, selectedId, onToggleRow, model, showAll, onToggleAll, onLoadOlder, thinkingVisible = true, registerRowRef, scrollHandle, forceMountRowId, newSinceRowId, onUnseenCount, }) {
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
    // Measured row heights, remembered after a row unmounts so virtualization
    // can compute total content height. Bounded: row ids grow monotonically
    // and rows are never removed from the transcript (foldRows keeps the
    // row), so without a cap this Map grew by one entry per row forever.
    // Eviction is FIFO (oldest row first); a forgotten height falls back to
    // DEFAULT_ROW_HEIGHT, which only perturbs deep scrollback estimates.
    const HEIGHTS_CACHE_MAX = 5000;
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
        const tick = () => { setScrollTick(t => t + 1); };
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
    // Pinned to bottom: the tail row must stay mounted EVERY pass. The
    // streaming row's measured height only lands in heightsRef when it
    // survives mounted across two consecutive commits (useLayoutEffect reads
    // the previous Yoga pass). If an underestimated `total` ever lets relTop
    // overshoot it, start=len unmounts everything → content collapses to the
    // header → follow yanks scrollTop to 0 → next pass remounts all → follow
    // back to the real bottom: a self-sustaining ping-pong that blanks the
    // transcript mid-stream.
    if (sticky && visibleRows.length > 0) {
        start = Math.min(start, visibleRows.length - 1);
    }
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
    // New-messages pill count: rows past the seen-anchor whose top edge is
    // still below the viewport bottom. Same rows-space math as the window
    // (offsets are rows-space, scrollTop content-space — subtract the header
    // base). Decrements as the user scrolls down through the new rows; 0 once
    // every new row has appeared on screen. Reported post-commit (parent
    // setState with an unchanged value is a React no-op, so the per-render
    // effect only re-renders on actual count changes).
    let unseenCount = 0;
    if (newSinceRowId !== null && newSinceRowId !== undefined) {
        const firstNew = visibleRows.findIndex(row => row.id > newSinceRowId);
        if (firstNew !== -1) {
            const seenBottom = scrollTop + viewport - base;
            for (let i = firstNew; i < visibleRows.length; i++) {
                if (offsets[i] >= seenBottom)
                    unseenCount++;
            }
        }
    }
    React.useEffect(() => {
        onUnseenCount?.(unseenCount);
    });
    // Post-commit: measure mounted rows, derive the content-space base from
    // the first mounted row's Yoga top, and clamp render-time scrollTop to the
    // mounted coverage so burst scrolls never show blank spacer.
    React.useLayoutEffect(() => {
        let changed = false;
        for (const [id, el] of localRefs.current) {
            const h = el.yogaNode?.getComputedHeight();
            if (h !== undefined && h > 0 && heightsRef.current.get(id) !== h) {
                if (heightsRef.current.size >= HEIGHTS_CACHE_MAX) {
                    const oldest = heightsRef.current.keys().next().value;
                    if (oldest !== undefined)
                        heightsRef.current.delete(oldest);
                }
                heightsRef.current.set(id, h);
                changed = true;
            }
        }
        const firstMounted = visibleRows[start];
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: empty list window
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
    // useCallback: the reference feeds MemoRow's shallow compare; a fresh
    // closure per render would defeat every row's memo.
    const setRowRef = React.useCallback((rowId, el) => {
        if (el)
            localRefs.current.set(rowId, el);
        else
            localRefs.current.delete(rowId);
        registerRowRef?.(rowId, el);
    }, [registerRowRef]);
    // Second-resolution clock for the running tool card's live elapsed time.
    // Computed per render (cheap) but only forwarded to running rows, so
    // settled rows never see a changing prop.
    const nowSec = Math.floor(Date.now() / 1000);
    return (_jsxs(_Fragment, { children: [rows.some(row => row.folded) && (_jsx(Box, { marginTop: 1, onClick: onLoadOlder, children: _jsx(Divider, { title: t('load-earlier') }) })), !showAll && hiddenCount > 0 && (_jsx(Box, { marginTop: 1, onClick: onToggleAll, children: _jsx(Divider, { title: ` ctrl+e to show ${hiddenCount} previous messages ` }) })), topPad > 0 && _jsx(Box, { height: topPad, flexShrink: 0 }), visibleRows
                .slice(start, end)
                .map((row) => {
                // CC addMargin: pre-pass result keeps windowed rows at full-mount
                // spacing; only the very first row of the whole list has none.
                const addMargin = margins.get(row.id) === true;
                const tool = row.tool;
                return (_jsx(MemoRow, { rowId: row.id, kind: row.kind, text: row.text, streaming: row.streaming === true, durationMs: row.durationMs, time: row.time, addMargin: addMargin, isSelected: selectedId === row.id, isExpanded: expandedRows.has(row.id), expanded: expanded, model: model, background: rowBackground(row.id), toolCallId: tool?.callId, toolName: tool?.name, toolArgsText: tool?.argsText, toolArgsFull: tool?.argsFull, toolStatus: tool?.status, toolResultText: tool?.resultText, toolResultFull: tool?.resultFull, toolErrorText: tool?.errorText, toolCallView: tool?.callView, toolResultView: tool?.resultView, toolStartedAt: tool?.startedAt, toolDurationMs: tool?.durationMs, nowSec: tool?.status === 'running' ? nowSec : undefined, onToggleRow: onToggleRow, setRowRef: setRowRef }, row.id));
            }), bottomPad > 0 && _jsx(Box, { height: bottomPad, flexShrink: 0 })] }));
}
function TranscriptRow({ rowId, kind, text, streaming, durationMs, time, addMargin, isSelected, isExpanded, expanded, model, background, toolCallId, toolName, toolArgsText, toolArgsFull, toolStatus, toolResultText, toolResultFull, toolErrorText, toolCallView, toolResultView, toolStartedAt, toolDurationMs, onToggleRow, setRowRef, }) {
    const ref = React.useCallback((el) => {
        setRowRef(rowId, el);
    }, [setRowRef, rowId]);
    const onClick = React.useCallback(() => {
        onToggleRow(rowId);
    }, [onToggleRow, rowId]);
    switch (kind) {
        case 'user':
            return (_jsx(Box, { flexDirection: "column", ref: ref, children: _jsx(UserPromptMessage, { text: text, addMargin: addMargin, isSelected: isSelected, isExpanded: isExpanded, onClick: onClick }) }));
        case 'assistant':
            return streaming ? (_jsxs(Box, { alignItems: "flex-start", flexDirection: "row", marginTop: addMargin ? 1 : 0, width: "100%", backgroundColor: background, children: [_jsx(Box, { minWidth: 2, children: _jsx(Text, { color: "text", children: "\u25CF" }) }), _jsx(Box, { flexDirection: "column", children: _jsx(StreamingMarkdown, { children: stripNarration(text) }) })] })) : (_jsxs(Box, { width: "100%", flexDirection: "column", backgroundColor: background, ref: ref, children: [expanded && (_jsx(Box, { flexDirection: "row", justifyContent: "flex-end", gap: 1, marginTop: 1, children: _jsx(MessageMetadata, { timestamp: time, model: model }) })), _jsx(AssistantTextMessage, { text: stripNarration(text), addMargin: addMargin, isSelected: isSelected, isExpanded: isExpanded, onClick: onClick })] }));
        case 'reasoning':
            return (_jsx(Box, { flexDirection: "column", ref: ref, children: _jsx(AssistantThinkingMessage, { thinking: text, addMargin: addMargin, 
                    // Streaming reasoning shows expanded live, then folds
                    // automatically once the turn settles (unless Ctrl+O or a
                    // single-row expansion keeps it open).
                    verbose: isExpanded || expanded || streaming, durationMs: durationMs, isSelected: isSelected, onClick: onClick }) }));
        case 'tool': {
            if (toolCallId === undefined ||
                toolName === undefined ||
                toolArgsText === undefined ||
                toolStatus === undefined ||
                toolStartedAt === undefined) {
                return null;
            }
            // Rebuilt per render from the flattened props — cheap object literal,
            // and AssistantToolUseMessage is only reached when memo let us through.
            const tool = {
                callId: toolCallId,
                name: toolName,
                argsText: toolArgsText,
                argsFull: toolArgsFull,
                status: toolStatus,
                resultText: toolResultText,
                resultFull: toolResultFull,
                errorText: toolErrorText,
                callView: toolCallView,
                resultView: toolResultView,
                startedAt: toolStartedAt,
                durationMs: toolDurationMs,
            };
            return (_jsx(Box, { flexDirection: "column", ref: ref, children: _jsx(AssistantToolUseMessage, { tool: tool, addMargin: addMargin, verbose: isExpanded || expanded, isSelected: isSelected, isExpanded: isExpanded }) }));
        }
        case 'notice':
            return (_jsx(Box, { marginTop: 1, ref: ref, children: _jsx(Divider, { title: ` ${text} ` }) }));
        case 'interrupt':
            return (_jsx(Box, { marginTop: 1, ref: ref, children: _jsx(InterruptedByUser, {}) }));
        case 'local':
            // `!` mode command echo, like CC's UserBashInputMessage.
            return (_jsx(Box, { marginTop: 1, backgroundColor: background, ref: ref, children: _jsxs(Text, { color: "bashBorder", children: ["! ", text] }) }));
        case 'local-output':
            return (_jsx(Box, { paddingLeft: 2, backgroundColor: background, ref: ref, children: _jsx(Text, { dimColor: true, children: text }) }));
        case 'compact':
            // The post-compaction summary defaults to a folded one-liner with a
            // text preview; Ctrl+O (global) or message-selection Enter reveals
            // the full summary.
            return (_jsx(Box, { marginTop: addMargin ? 1 : 0, paddingLeft: 2, backgroundColor: background, ref: ref, onClick: onClick, children: expanded || isExpanded ? (_jsx(Text, { dimColor: true, children: text })) : (_jsxs(Text, { dimColor: true, italic: true, children: ["\u2234 ", t('compact-summary-folded'), " \u00B7 ", compactPreview(text), ' ', _jsx(KeyboardShortcutHint, { shortcut: "ctrl+o", action: "expand", parens: true })] })) }));
    }
}
/** Folded compact-summary preview: whitespace flattened, capped with an
 *  ellipsis so the fold line never wraps. `limit` is terminal cells, so
 *  CJK wide chars count double and never split mid-glyph. */
function compactPreview(text, limit = 60) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return stringWidth(flat) <= limit ? flat : `${truncateToWidth(flat, limit - 1)}…`;
}
const MemoRow = React.memo(TranscriptRow);
/**
 * The header block pinned above the transcript: the DeepSeek pixel whale
 * with the wordmark, tagline, model/effort and cwd (`LogoV2`), plus the
 * welcome line. It scrolls away with the transcript once the conversation
 * fills the viewport (Claude Code shows its ✦ logo in the same slot).
 */
export function LogoHeader({ model, effort, cwd, }) {
    return (_jsx(Box, { flexDirection: "column", marginBottom: 1, children: _jsx(LogoV2, { model: model, effort: effort, cwd: cwd }) }));
}
