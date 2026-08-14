/**
 * A 5-row block font for the header tagline, painted with a horizontal
 * color gradient plus a moving highlight window (the same sweep cadence as
 * the wordmark shimmer — see the `stepMs` parameter). Glyphs are 5 columns wide so curves
 * and diagonals stay legible; only the letters the tagline needs are
 * defined, and unknown characters fall back to a hollow box so a typo
 * fails visibly instead of crashing the splash.
 */
export interface Rgb {
    r: number;
    g: number;
    b: number;
}
/**
 * Render `text` in the 5-row block font. The gradient runs `from` → `to`
 * across the full line width; a SWEEP_WINDOW-wide highlight mixed toward
 * `flash` travels left to right (one column per `stepMs`, matching the
 * wordmark shimmer's cadence). Returns 5 ANSI rows.
 * @param text - Text to render; only D, E, P, S, K, H, A, R, N have glyphs, unknown letters fall back to a hollow box.
 * @param time - Elapsed time in milliseconds; drives the sweep position and the brightness pulse.
 * @param from - Gradient start color at the left edge.
 * @param to - Gradient end color at the right edge.
 * @param flash - Highlight color mixed into the moving sweep window.
 * @param stepMs - Milliseconds per column of sweep advance (default 60).
 * @returns Five ANSI rows, one per block-font line.
 */
export declare function renderBigText(text: string, time: number, from: Rgb, to: Rgb, flash: Rgb, stepMs?: number): string[];
//# sourceMappingURL=bigfont.d.ts.map