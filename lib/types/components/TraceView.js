import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useTerminalSize } from '../ui.js';
import { t } from '../i18n.js';
import { Pane } from './design-system/Pane.js';
import { ListItem } from './design-system/ListItem.js';
import { HintLine } from './design-system/HintLine.js';
import { formatClock, formatDuration, truncateWidth, } from '../trace.js';
/** Rows of the timeline visible at once (the window scrolls with the cursor). */
export const TRACE_WINDOW = 12;
/** Per-kind glyph, CC-figure style (single terminal cell each). */
const KIND_ICON = {
    turn: '▶',
    step: '∙',
    user: '❯',
    assistant: '✻',
    thinking: '✻',
    tool: '⏺',
    todo: '✓',
};
/** Status-driven icon color; only tool brackets color by outcome. */
function iconColor(entry) {
    if (entry.kind === 'tool') {
        if (entry.status === 'error')
            return 'error';
        if (entry.status === 'running')
            return 'warning';
        return 'success';
    }
    if (entry.kind === 'user')
        return 'suggestion';
    if (entry.kind === 'todo')
        return 'success';
    return undefined;
}
/**
 * The `/trace` trajectory view (issue #80, TUI 对齐官方 web 端「轨迹」tab):
 * a read-only, scrollable one-line-per-event timeline of the session —
 * `HH:MM:SS  图标  摘要  (耗时)`. `entries` arrives pre-filtered from the
 * Chat screen (which owns the cursor, the `f` type filter and the /thinking
 * gate); this component only renders the cursor-centered window.
 */
export function TraceView({ entries, cursor, filter, }) {
    const { columns } = useTerminalSize();
    // Summary width budget: pane padding (2×2) + pointer column (2) + clock
    // (9) + icon (2) + duration suffix (~9) + gap slack.
    const summaryWidth = Math.max(16, columns - 32);
    const start = Math.max(0, Math.min(cursor - Math.floor(TRACE_WINDOW / 2), entries.length - TRACE_WINDOW));
    const visible = entries.slice(start, start + TRACE_WINDOW);
    return (_jsxs(Pane, { color: "permission", children: [_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { color: "remember", bold: true, children: t('trace-title') }), _jsx(Text, { dimColor: true, children: t('trace-subtitle', {
                                    filter: t(`trace-filter-${filter}`),
                                    count: entries.length,
                                }) })] }), visible.length === 0 ? (_jsx(ListItem, { isFocused: false, children: t('trace-empty') })) : (visible.map((entry, offset) => {
                        const index = start + offset;
                        const focused = index === cursor;
                        return (_jsx(ListItem, { isFocused: focused, styled: false, showScrollUp: offset === 0 && start > 0, showScrollDown: offset === visible.length - 1 &&
                                start + TRACE_WINDOW < entries.length, children: _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsxs(Box, { flexShrink: 0, flexDirection: "row", gap: 1, children: [_jsx(Text, { dimColor: true, children: formatClock(entry.time) }), _jsx(Text, { color: iconColor(entry), dimColor: entry.kind === 'thinking' || entry.kind === 'step', children: KIND_ICON[entry.kind] })] }), _jsx(Box, { flexGrow: 1, flexShrink: 1, marginLeft: 1, children: _jsx(Text, { wrap: "truncate", color: focused ? 'suggestion' : undefined, children: truncateWidth(entry.summary, summaryWidth) }) }), _jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { dimColor: true, children: entry.durationMs !== undefined
                                                ? `(${formatDuration(entry.durationMs)})`
                                                : entry.status === 'running'
                                                    ? '(…)'
                                                    : '' }) })] }) }, `${entry.seq}:${entry.kind}:${offset}`));
                    }))] }), _jsx(Text, { dimColor: true, italic: true, children: _jsx(HintLine, { text: t('hint-trace') }) })] }));
}
