import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { t } from '../i18n.js';
import { Text, useAnimationFrame } from '../ui.js';
import { resolvePreset } from './activityFrames.js';
import { BRAND, FLASH, ICE, sweep } from './shimmer.js';
import { getTheme } from '../theme.js';
import { useTheme } from './design-system/ThemeProvider.js';
import { parseRGB } from './Spinner/spinnerUtils.js';
/**
 * Context-pressure percentage (0–100) from the last usage snapshot, or
 * undefined when unknown — shared by the spinner-line and status-line
 * placements of the working-activity line (pi working-activity style:
 * amber ≥ 80%, red ≥ 95%).
 */
export function contextPressurePct(usage, contextWindow) {
    if (usage === undefined || contextWindow === undefined || contextWindow <= 0) {
        return undefined;
    }
    const occupied = usage.input + usage.cacheRead + usage.cacheWrite;
    return Math.round((occupied / contextWindow) * 100);
}
/**
 * The working-activity line, rendered either in the spinner slot (while a
 * turn runs — replacing the CC random-verb spinner) or on the status bar
 * (the turn-summary card once idle). pi working-activity style: an animated
 * indicator frame, an ice-blue shimmer sweep over the line, an amber/red
 * `⚠ ctx N%` pressure prefix, and a trailing token suffix for the spinner
 * placement. Done summaries render statically in the brand mist blue.
 */
export function ActivityLine({ activity, activityFrames, warnPct, warnDanger, suffix, }) {
    // 60ms frames: the shimmer sweep advances one column per frame (3.3× the
    // ported 200ms cadence — the slow crawl read as lag).
    const [, time] = useAnimationFrame(60);
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    const preset = React.useMemo(() => resolvePreset(activityFrames), [activityFrames]);
    const frameIndex = Math.floor(time / preset.intervalMs) % preset.frames.length;
    const frame = preset.frames[frameIndex] ?? '·';
    const color = activity.phase === 'done' || activity.phase === 'tool'
        ? 'claude'
        : 'claudeBlue_FOR_SYSTEM_SPINNER';
    const baseRGB = activity.phase === 'tool'
        ? (parseRGB(theme.claude) ?? BRAND)
        : (parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE);
    return (_jsxs(Text, { wrap: "truncate", children: [activity.phase !== 'done' && (_jsxs(Text, { color: color, children: [frame, " "] })), warnPct !== undefined && warnPct >= 80 && (_jsxs(Text, { color: warnDanger ? 'error' : 'warning', children: [t('activity-ctx-warn'), warnPct, "% \u00B7", ' '] })), activity.phase === 'done' ? (_jsx(Text, { color: color, children: activity.line })) : (_jsx(Text, { children: sweep(activity.line, time, baseRGB, FLASH, 60) })), suffix !== undefined && _jsx(Text, { dimColor: true, children: suffix })] }));
}
