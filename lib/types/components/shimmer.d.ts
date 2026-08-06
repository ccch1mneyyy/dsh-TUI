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
export declare const ICE: Rgb;
export declare const PALE: Rgb;
export declare const FLASH: Rgb;
/**
 * Paint `word` with a 10-column highlight window sweeping across it. The
 * window advances one column per `stepMs` and the brightness pulse follows
 * the same cadence (period 2π·stepMs·... — one full sine per ~6 steps).
 * CC's original cadence was 200ms/column; callers pass 100 for a livelier
 * sweep.
 */
export declare function sweep(word: string, time: number, base: Rgb, highlight: Rgb, stepMs?: number): string;
//# sourceMappingURL=shimmer.d.ts.map