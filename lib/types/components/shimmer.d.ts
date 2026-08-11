/**
 * Shared shimmer utilities: the blue-white color ladder of the header and a
 * moving-highlight text painter used by the header wordmark/tagline and the
 * working-activity status line.
 */
export interface Rgb {
    r: number;
    g: number;
    b: number;
}
/** Header blue-white ladder: brand → ice → pale → soft ice flash.
 *  FLASH stays visibly blue (never pure white) — the highlight reads as a
 *  mist-brightened crest, not a white strobe. */
export declare const BRAND: Rgb;
/** Header ladder ice blue (`#93BEFF`). */
export declare const ICE: Rgb;
/** Header ladder pale blue (`#D7E4FF`). */
export declare const PALE: Rgb;
/** Soft ice flash blue (`#C6D8F8`); stays visibly blue, never pure white. */
export declare const FLASH: Rgb;
/**
 * Paint `word` with a 10-column highlight window sweeping across it. The
 * window advances one column per `stepMs` and the brightness pulse follows
 * the same cadence (period 2π·stepMs·... — one full sine per ~6 steps).
 * CC's original cadence was 200ms/column; callers pass 60 for the lively
 * sweep.
 * @param word - Text to paint.
 * @param time - Elapsed time in milliseconds; drives the sweep position and the brightness pulse.
 * @param base - Color for cells outside the highlight window.
 * @param highlight - Color mixed into the sweeping highlight window.
 * @param stepMs - Milliseconds per column of sweep advance (default 60).
 * @returns The ANSI bold-colored word with the moving highlight.
 */
export declare function sweep(word: string, time: number, base: Rgb, highlight: Rgb, stepMs?: number): string;
//# sourceMappingURL=shimmer.d.ts.map