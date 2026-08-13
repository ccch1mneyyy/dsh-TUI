import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from '../ui.js';
/** Maximum todo rows shown before the overflow line. */
const MAX_TODOS = 8;
const PHASE_LABEL = {
    active: '● active',
    paused: '⏸ paused',
    blocked: '⛔ blocked',
    complete: '✓ complete',
};
function PhaseBadge({ phase, roundsStarted, maxGoalRounds, }) {
    const color = phase === 'active'
        ? 'success'
        : phase === 'paused'
            ? 'warning'
            : phase === 'blocked'
                ? 'error'
                : undefined;
    return (_jsxs(Text, { color: color, dimColor: phase === 'complete', children: [PHASE_LABEL[phase], " \u00B7 ", roundsStarted, "/", maxGoalRounds] }));
}
function TodoGlyph({ status }) {
    switch (status) {
        case 'in_progress':
            return _jsx(Text, { color: "suggestion", children: "\u25CF " });
        case 'completed':
            return _jsx(Text, { dimColor: true, children: "\u2713 " });
        default:
            return _jsx(Text, { dimColor: true, children: "\u25CB " });
    }
}
/**
 * Mind-map style branch prefix: `├─` for every row but the last, which
 * closes with `└─`. The whole panel reads as one tree — the goal is the
 * root and each todo hangs off it.
 */
function BranchPrefix({ last }) {
    return _jsx(Text, { dimColor: true, children: last ? '└─ ' : '├─ ' });
}
/**
 * Live goal + todo panel above the prompt input. Data rides on the channel:
 * `channel.goal` is folded from `goal/change` context events and
 * `channel.todos` from `todo/write` whole-list snapshots, so every model
 * update re-renders this panel in real time (no polling). Renders nothing
 * while both slots are empty.
 */
export function GoalTodoPanel({ channel }) {
    const goal = channel.goal;
    const todos = channel.todos ?? [];
    if (goal === undefined && todos.length === 0)
        return null;
    const visible = todos.slice(0, MAX_TODOS);
    const hidden = todos.length - visible.length;
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, children: [goal !== undefined && (_jsxs(Box, { flexDirection: "column", marginBottom: todos.length > 0 ? 1 : 0, children: [_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: "suggestion", children: "\uD83C\uDFAF " }), _jsx(Box, { flexGrow: 1, flexShrink: 1, children: _jsx(Text, { bold: true, wrap: "truncate", children: goal.objective }) }), _jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(PhaseBadge, { phase: goal.phase, roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds }) })] }), goal.phase === 'blocked' && goal.blockedReason !== undefined && (_jsxs(Box, { flexDirection: "row", marginTop: 1, children: [_jsx(Text, { dimColor: true, children: "\u2502 " }), _jsx(Text, { color: "error", wrap: "truncate", children: goal.blockedReason.message })] }))] })), todos.length > 0 && (_jsxs(Box, { flexDirection: "column", children: [visible.map((todo, index) => {
                        const last = index === visible.length - 1 && hidden === 0;
                        return (_jsxs(Box, { flexDirection: "row", children: [_jsx(BranchPrefix, { last: last }), _jsx(TodoGlyph, { status: todo.status }), _jsx(Text, { wrap: "truncate", dimColor: todo.status === 'completed', children: todo.content })] }, index));
                    }), hidden > 0 && (_jsxs(Box, { flexDirection: "row", children: [_jsx(BranchPrefix, { last: true }), _jsxs(Text, { dimColor: true, children: ["\u2026 ", hidden, " more"] })] }))] }))] }));
}
