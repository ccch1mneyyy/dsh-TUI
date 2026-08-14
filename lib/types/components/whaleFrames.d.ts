/**
 * Pixel-whale animation frames for the startup splash, converted from
 * the hand-drawn Excel art in `whale_frames.zip` (25x40 cells, palette
 * alphabet shared with Whale.tsx: D outline, B body, L belly, W mouth,
 * `.` transparent). `OPENING_SEQUENCE` plays once at startup: blink,
 * water-spout bloom, tail wag, then the header settles static.
 */
/** One animation frame: 25 sprite rows of 40 palette characters. */
export interface WhaleFrame {
    /** Frame label from the source art (Chinese names kept for traceability). */
    readonly name: string;
    readonly rows: readonly string[];
}
/** The 13 hand-drawn frames. */
export declare const WHALE_FRAMES: readonly WhaleFrame[];
/** One step of the opening animation: frame index + dwell time. */
export interface OpeningStep {
    /** Index into WHALE_FRAMES. */
    readonly frame: number;
    /** How long the frame stays on screen, in milliseconds. */
    readonly ms: number;
}
/** Startup sequence (~3.4s), ending on the standard pose. */
export declare const OPENING_SEQUENCE: readonly OpeningStep[];
//# sourceMappingURL=whaleFrames.d.ts.map