import React from 'react';
import type { SpinnerMode } from './Spinner/spinnerMode.js';
/**
 * The working spinner block shown between the transcript and the prompt
 * input while a turn is in flight. Ported from the leak's `Spinner.tsx`
 * (SpinnerWithVerb path) with the swarm/teammate/effort/tips branches
 * removed; the channel feeds the mode, token count and thinking status.
 *
 * Random verb is picked once per turn (per mount of the spinner).
 */
export declare function WorkingSpinner({ mode, hasActiveTools, responseLengthRef, loadingStartTimeRef, totalPausedMsRef, pauseStartTimeRef, thinkingStatus, }: {
    mode: SpinnerMode;
    hasActiveTools: boolean;
    responseLengthRef: React.RefObject<number>;
    loadingStartTimeRef: React.RefObject<number>;
    totalPausedMsRef: React.RefObject<number>;
    pauseStartTimeRef: React.RefObject<number | null>;
    thinkingStatus: 'thinking' | number | null;
}): React.ReactNode;
/**
 * Tracks thinking status: 'thinking' while the model is streaming reasoning,
 * then the duration in ms for a minimum 2s display (avoids UI jank). Ported
 * from the leak's SpinnerWithVerb effect.
 */
export declare function useThinkingStatus(isThinking: boolean): 'thinking' | number | null;
//# sourceMappingURL=WorkingSpinner.d.ts.map