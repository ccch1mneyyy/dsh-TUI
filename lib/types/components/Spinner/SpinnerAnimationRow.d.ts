import React from 'react';
import type { Theme } from '../../theme.js';
import type { SpinnerMode } from './spinnerMode.js';
export type SpinnerAnimationRowProps = {
    mode: SpinnerMode;
    reducedMotion: boolean;
    hasActiveTools: boolean;
    /** Raw response length (chars) — feeds the animated token counter. */
    responseLengthRef: React.RefObject<number>;
    /** Stable within a turn. */
    message: string;
    messageColor: keyof Theme;
    shimmerColor: keyof Theme;
    loadingStartTimeRef: React.RefObject<number>;
    totalPausedMsRef: React.RefObject<number>;
    pauseStartTimeRef: React.RefObject<number | null>;
    spinnerSuffix?: string | null;
    verbose: boolean;
    columns: number;
    /** 'thinking' while reasoning streams; number = duration (ms) after it ends. */
    thinkingStatus: 'thinking' | number | null;
};
/**
 * The 50ms-animated portion of the working spinner, ported from the leak's
 * `Spinner/SpinnerAnimationRow.tsx` with the swarm/teammate/effort branches
 * removed. Owns `useAnimationFrame(50)` and all values derived from the
 * animation clock (frame, glimmer, token counter animation, elapsed time,
 * stalled intensity, thinking shimmer).
 */
export declare function SpinnerAnimationRow({ mode, reducedMotion, hasActiveTools, responseLengthRef, message, messageColor, shimmerColor, loadingStartTimeRef, totalPausedMsRef, pauseStartTimeRef, spinnerSuffix, verbose, columns, thinkingStatus, }: SpinnerAnimationRowProps): React.ReactNode;
//# sourceMappingURL=SpinnerAnimationRow.d.ts.map