import React from 'react';
import type { ActivityStatus } from '../channel.js';
/**
 * Context-pressure percentage (0–100) from the last usage snapshot, or
 * undefined when unknown — shared by the spinner-line and status-line
 * placements of the working-activity line (pi working-activity style:
 * amber ≥ 80%, red ≥ 95%).
 */
export declare function contextPressurePct(usage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
} | undefined, contextWindow: number | undefined): number | undefined;
/**
 * The working-activity line, rendered either in the spinner slot (while a
 * turn runs — replacing the CC random-verb spinner) or on the status bar
 * (the turn-summary card once idle). pi working-activity style: an animated
 * indicator frame, an ice-blue shimmer sweep over the line, an amber/red
 * `⚠ ctx N%` pressure prefix, and a trailing token suffix for the spinner
 * placement. Done summaries render statically in the brand mist blue.
 */
export declare function ActivityLine({ activity, activityFrames, warnPct, warnDanger, suffix, }: {
    activity: ActivityStatus;
    activityFrames: string | undefined;
    warnPct?: number;
    warnDanger?: boolean;
    suffix?: string;
}): React.ReactNode;
//# sourceMappingURL=ActivityLine.d.ts.map