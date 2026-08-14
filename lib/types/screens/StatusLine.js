import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useTerminalSize, useTheme } from '../ui.js';
import { formatTokens } from '../cc/format.js';
import { Byline } from '../components/design-system/Byline.js';
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js';
import { renderContextBar, renderTpsGauge, renderTpsSparkline, speedColor, } from './StatusMetrics.js';
/**
 * The footer under the prompt input, in Claude Code's PromptInputFooter
 * layout: the segmented context progress bar on its own first line, the
 * status line below (left group: model · tokens · think level · cache · tps
 * gauge/sparkline; right group: git · cwd · title, right-aligned), and the
 * mode/hint line last. The right side of the footer shows the latest
 * transient notification (errors in red, warnings in amber — CC style).
 */
export function StatusLine({ channel, selectionActive = false, helpOpen = false, }) {
    const { columns } = useTerminalSize();
    const [themeName] = useTheme();
    const usage = channel.lastUsage;
    const contextParts = [];
    if (channel.reasoningEffort !== undefined) {
        contextParts.push(_jsx(Text, { color: "inactiveShimmer", children: channel.reasoningEffort }, "effort"));
    }
    if (usage !== undefined && usage.cacheRead > 0) {
        // Cache hit rate of the context fed to the model (read / total), one
        // decimal — the absolute read count lives in the context bar's system
        // segment, the rate is the glanceable health signal.
        const total = usage.input + usage.cacheRead + usage.cacheWrite;
        const rate = total > 0 ? (usage.cacheRead / total) * 100 : 0;
        contextParts.push(_jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "cache " }), _jsxs(Text, { color: "inactiveShimmer", children: [rate.toFixed(1), "%"] })] }, "cache"));
    }
    // TPS readout sits right after the model so a crowded footer truncates
    // the trailing fields (tokens/think/cache), never the speedometer. One
    // number only: the live value (gauge while streaming, sparkline of past
    // turns once samples exist) — no μ/p95 clutter.
    const tpsParts = [];
    if (channel.tps !== undefined) {
        if (channel.working && channel.tpsSamples.length === 0) {
            tpsParts.push(_jsxs(Text, { children: [renderTpsGauge(channel.tps, channel.tps), ' ', _jsxs(Text, { dimColor: true, children: [Math.round(channel.tps), " tps"] })] }, "tps"));
        }
        else if (channel.tpsSamples.length > 0) {
            const peak = Math.max(...channel.tpsSamples.map(sample => sample.tps), channel.tps);
            tpsParts.push(_jsxs(Text, { children: [channel.working
                        ? renderTpsGauge(channel.tps, peak)
                        : renderTpsSparkline(channel.tpsSamples), ' ', speedColor(channel.tps, `${Math.round(channel.tps)}`), " tps"] }, "tps"));
        }
        else {
            tpsParts.push(_jsxs(Text, { dimColor: true, children: [Math.round(channel.tps), " t/s"] }, "tps"));
        }
    }
    // Left group: every field sits at soft white (inactiveShimmer) instead of
    // the previous uniform dim grey — readable against dark terminals.
    const leftParts = [
        _jsx(Text, { color: "inactiveShimmer", children: channel.model }, "model"),
        ...tpsParts,
        ...contextParts,
        _jsxs(Text, { color: "inactiveShimmer", children: [formatTokens(channel.tokens.input), "\u2192", formatTokens(channel.tokens.output)] }, "tokens"),
    ];
    // Right group: git branch in muted steel blue, cwd a soft white, the
    // session title dimmest (it truncates first anyway).
    const rightParts = [
        ...(channel.gitBranch
            ? [
                _jsx(Text, { color: "professionalBlue", children: channel.gitBranch }, "git"),
            ]
            : []),
        _jsx(Text, { color: "inactiveShimmer", children: basename(channel.cwd) }, "cwd"),
        ...(channel.sessionTitle
            ? [
                _jsx(Text, { dimColor: true, children: channel.sessionTitle }, "title"),
            ]
            : []),
    ];
    // Row 3: the mode hint — and, while idle, the working-activity turn
    // summary (the live working line itself moves to the spinner slot above
    // the input while a turn runs, so the two never duplicate).
    const hint = selectionActive
        ? 'esc to return to input'
        : channel.working
            ? 'esc to interrupt'
            : !helpOpen
                ? '? for shortcuts'
                : '';
    const activity = channel.workingActivity;
    const showActivity = !channel.working &&
        activity !== undefined &&
        activity.line !== '' &&
        activity.phase !== 'idle';
    const barWidth = columns - 4;
    let bar = null;
    // Theme-aware free segment: the light palette's near-white fill (#E8E8E8)
    // reads as a glaring white band on dark terminals — swap it for a deep
    // blue-gray there while keeping the light palette as-is (dark-ansi carries
    // `ansi:` color names, so map by theme name rather than palette tokens).
    const barColors = themeName === 'light'
        ? undefined
        : { freeFill: '#2E3440', freeText: '#8D95A6' };
    if (channel.contextBarEnabled && barWidth >= 14 && channel.contextWindow !== undefined) {
        bar = renderContextBar(channel.contextSegments, usage !== undefined ? usage.input + usage.cacheRead + usage.cacheWrite : 0, channel.contextWindow, barWidth, barColors);
    }
    return (_jsx(Box, { paddingX: 2, children: _jsxs(Box, { flexDirection: "column", width: "100%", children: [bar ? _jsx(Text, { children: bar }) : null, _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", gap: 2, children: [_jsx(Text, { wrap: "truncate", children: _jsx(Byline, { children: leftParts }) }), _jsx(Box, { justifyContent: "flex-end", flexShrink: 2, children: _jsx(Text, { wrap: "truncate", children: _jsx(Byline, { children: rightParts }) }) })] }), _jsxs(Box, { height: 1, overflow: "hidden", flexDirection: "row", justifyContent: "space-between", gap: 2, children: [showActivity && activity !== undefined ? (_jsx(ActivityLine, { activity: activity, activityFrames: channel.activityFrames, warnPct: contextPressurePct(usage, channel.contextWindow), warnDanger: (contextPressurePct(usage, channel.contextWindow) ?? 0) >= 95 })) : hint ? (_jsx(Text, { color: "inactiveShimmer", children: hint })) : null, showActivity && hint ? (_jsx(Text, { color: "inactiveShimmer", wrap: "truncate", children: hint })) : null] })] }) }));
}
function basename(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? path;
}
