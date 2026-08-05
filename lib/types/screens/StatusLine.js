import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text, useTerminalSize, useAnimationFrame } from '../ui.js';
import { formatTokens } from '../cc/format.js';
import { Byline } from '../components/design-system/Byline.js';
import { resolvePreset } from '../components/activityFrames.js';
import { BRAND, FLASH, ICE, sweep } from '../components/shimmer.js';
import { getTheme } from '../theme.js';
import { useTheme } from '../components/design-system/ThemeProvider.js';
import { parseRGB } from '../components/Spinner/spinnerUtils.js';
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
    // messages once samples exist) — no μ/p95 clutter.
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
    // Row 3: the mode hint — and, while dsh-working-activity publishes, the
    // live working line (thinking copy / running tool / turn summary) on the
    // left with the hint staying visible on the right. Phase colors: done
    // summaries land in success green, running tools in brand blue, waiting/
    // thinking in ice blue.
    const hint = selectionActive
        ? 'esc to return to input'
        : channel.working
            ? 'esc to interrupt'
            : !helpOpen
                ? '? for shortcuts'
                : '';
    const activity = channel.workingActivity;
    const activityLine = activity !== undefined && activity.line !== '' && activity.phase !== 'idle'
        ? activity.line
        : undefined;
    const activityColor = activity?.phase === 'done'
        ? 'success'
        : activity?.phase === 'tool'
            ? 'claude'
            : 'claudeBlue_FOR_SYSTEM_SPINNER';
    // Animated working line (pi working-activity style): the indicator preset
    // ticks on its own cadence and the line text carries a white shimmer
    // sweep. Both share the same animation clock, driven by the ref below.
    const [animationRef, time] = useAnimationFrame(200);
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    const preset = React.useMemo(() => resolvePreset(channel.activityFrames), [channel.activityFrames]);
    const frameIndex = Math.floor(time / preset.intervalMs) % preset.frames.length;
    const frame = preset.frames[frameIndex] ?? '·';
    const baseRGB = activity?.phase === 'tool'
        ? (parseRGB(theme.claude) ?? BRAND)
        : (parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE);
    const phase = activity?.phase;
    // Context pressure prefix (pi working-activity style): ⚠ 上下文N% · in
    // amber ≥80%, red ≥95% — only while the working line is visible.
    const occupied = usage !== undefined ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
    const contextPct = activityLine !== undefined &&
        channel.contextWindow !== undefined &&
        channel.contextWindow > 0
        ? Math.round((occupied / channel.contextWindow) * 100)
        : undefined;
    const warnDanger = contextPct !== undefined && contextPct >= 95;
    const warnVisible = contextPct !== undefined && contextPct >= 80;
    const barWidth = columns - 4;
    let bar = null;
    if (barWidth >= 14 && channel.contextWindow !== undefined) {
        bar = renderContextBar(channel.contextSegments, occupied, channel.contextWindow, barWidth);
    }
    return (_jsx(Box, { paddingX: 2, ref: animationRef, children: _jsxs(Box, { flexDirection: "column", width: "100%", children: [bar ? _jsx(Text, { children: bar }) : null, _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", gap: 2, children: [_jsx(Text, { wrap: "truncate", children: _jsx(Byline, { children: leftParts }) }), _jsx(Box, { justifyContent: "flex-end", flexShrink: 2, children: _jsx(Text, { wrap: "truncate", children: _jsx(Byline, { children: rightParts }) }) })] }), _jsxs(Box, { height: 1, overflow: "hidden", flexDirection: "row", justifyContent: "space-between", gap: 2, children: [activityLine !== undefined ? (_jsxs(Text, { wrap: "truncate", children: [phase !== 'done' && (_jsxs(Text, { color: activityColor, children: [frame, " "] })), warnVisible && contextPct !== undefined && (_jsxs(Text, { color: warnDanger ? 'error' : 'warning', children: ["\u26A0 \u4E0A\u4E0B\u6587", contextPct, "% \u00B7", ' '] })), phase === 'done' ? (_jsx(Text, { color: activityColor, children: activityLine })) : (_jsx(Text, { children: sweep(activityLine, time, baseRGB, FLASH) }))] })) : hint ? (_jsx(Text, { color: "inactiveShimmer", children: hint })) : null, activityLine !== undefined && hint ? (_jsx(Text, { color: "inactiveShimmer", wrap: "truncate", children: hint })) : null] })] }) }));
}
function basename(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] ?? path;
}
