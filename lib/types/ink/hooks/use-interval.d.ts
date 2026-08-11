/**
 * Returns the clock time, updating at the given interval.
 * Subscribes as non-keepAlive — won't keep the clock alive on its own,
 * but updates whenever a keepAlive subscriber (e.g. the spinner)
 * is driving the clock.
 *
 * Use this to drive pure time-based computations (shimmer position,
 * frame index) from the shared clock.
 * @param intervalMs - the minimum interval between updates, in milliseconds.
 * @returns the current clock time in milliseconds.
 */
export declare function useAnimationTimer(intervalMs: number): number;
/**
 * Interval hook backed by the shared Clock.
 *
 * Unlike `useInterval` from `usehooks-ts` (which creates its own setInterval),
 * this piggybacks on the single shared clock so all timers consolidate into
 * one wake-up. Pass `null` for intervalMs to pause.
 * @param callback - invoked each time the interval elapses.
 * @param intervalMs - the interval in milliseconds, or null to pause.
 */
export declare function useInterval(callback: () => void, intervalMs: number | null): void;
//# sourceMappingURL=use-interval.d.ts.map