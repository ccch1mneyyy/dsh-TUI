/**
 * Tracks the transition to red when tokens stop flowing (ported from the
 * leak's `Spinner/useStalledAnimation.ts`). Driven by the parent's animation
 * clock time instead of independent intervals, so it slows down when the
 * terminal is blurred.
 * @param time - Parent animation clock time in ms.
 * @param currentResponseLength - Chars streamed this turn; growth resets the stall timer.
 * @param hasActiveTools - True while tools are running; tool activity never stalls.
 * @param reducedMotion - True to apply intensity changes instantly instead of smoothing.
 * @returns Whether the response is stalled, plus the 0–1 stalled intensity.
 */
export declare function useStalledAnimation(time: number, currentResponseLength: number, hasActiveTools?: boolean, reducedMotion?: boolean): {
    isStalled: boolean;
    stalledIntensity: number;
};
//# sourceMappingURL=useStalledAnimation.d.ts.map