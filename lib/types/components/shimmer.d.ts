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
/** Header blue-white ladder: brand → ice → pale → near-white flash. */
export declare const BRAND: Rgb;
export declare const ICE: Rgb;
export declare const PALE: Rgb;
export declare const FLASH: Rgb;
/**
 * Paint `word` with a 10-column highlight window sweeping across it (CC's
 * useShimmerAnimation non-requesting cadence: one column per 200ms frame,
 * highlight brightness pulsing on a 400ms sine).
 */
export declare function sweep(word: string, time: number, base: Rgb, highlight: Rgb): string;
//# sourceMappingURL=shimmer.d.ts.map