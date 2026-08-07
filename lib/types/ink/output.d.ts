import { type Rectangle } from './layout/geometry.js';
import { type Screen, type StylePool } from './screen.js';
/**
 * A grapheme cluster with precomputed terminal width, styleId, and hyperlink.
 * Built once per unique line (cached via charCache), so the per-char hot loop
 * is just property reads + setCellAt — no stringWidth, no style interning,
 * no hyperlink extraction per frame.
 *
 * styleId is safe to cache: StylePool is session-lived (never reset).
 * hyperlink is stored as a string (not interned ID) since hyperlinkPool
 * resets every 5 min; setCellAt interns it per-frame (cheap Map.get).
 */
type ClusteredChar = {
    value: string;
    width: number;
    styleId: number;
    hyperlink: string | undefined;
};
/**
 * Bounded cache of line → clustered characters. Enforces all three guards
 * (line-length threshold, entry count, byte budget) at insertion time, so
 * no caller can accidentally grow it unboundedly.
 */
export declare class CharCache {
    private map;
    private chars;
    get(line: string): ClusteredChar[] | undefined;
    set(line: string, characters: ClusteredChar[]): void;
    /** Retained-key character total, exposed for diagnostics/tests. */
    get retainedChars(): number;
    get size(): number;
}
/**
 * Collects write/blit/clear/clip operations from the render tree, then
 * applies them to a Screen buffer in `get()`. The Screen is what gets
 * diffed against the previous frame to produce terminal updates.
 */
type Options = {
    width: number;
    height: number;
    stylePool: StylePool;
    /**
     * Screen to render into. Will be reset before use.
     * For double-buffering, pass a reusable screen. Otherwise create a new one.
     */
    screen: Screen;
};
export type Operation = WriteOperation | ClipOperation | UnclipOperation | BlitOperation | ClearOperation | NoSelectOperation | ShiftOperation;
type WriteOperation = {
    type: 'write';
    x: number;
    y: number;
    text: string;
    /**
     * Per-line soft-wrap flags, parallel to text.split('\n'). softWrap[i]=true
     * means line i is a continuation of line i-1 (the `\n` before it was
     * inserted by word-wrap, not in the source). Index 0 is always false.
     * Undefined means the producer didn't track wrapping (e.g. fills,
     * raw-ansi) — the screen's per-row bitmap is left untouched.
     */
    softWrap?: boolean[];
};
type ClipOperation = {
    type: 'clip';
    clip: Clip;
};
export type Clip = {
    x1: number | undefined;
    x2: number | undefined;
    y1: number | undefined;
    y2: number | undefined;
};
type UnclipOperation = {
    type: 'unclip';
};
type BlitOperation = {
    type: 'blit';
    src: Screen;
    x: number;
    y: number;
    width: number;
    height: number;
};
type ShiftOperation = {
    type: 'shift';
    top: number;
    bottom: number;
    n: number;
};
type ClearOperation = {
    type: 'clear';
    region: Rectangle;
    /**
     * Set when the clear is for an absolute-positioned node's old bounds.
     * Absolute nodes overlay normal-flow siblings, so their stale paint is
     * what an earlier sibling's clean-subtree blit wrongly restores from
     * prevScreen. Normal-flow siblings' clears don't have this problem —
     * their old position can't have been painted on top of a sibling.
     */
    fromAbsolute?: boolean;
};
type NoSelectOperation = {
    type: 'noSelect';
    region: Rectangle;
};
export default class Output {
    width: number;
    height: number;
    private readonly stylePool;
    private screen;
    private readonly operations;
    private charCache;
    constructor(options: Options);
    /**
     * Reuse this Output for a new frame. Zeroes the screen buffer, clears
     * the operation list (backing storage is retained), and caps charCache
     * growth. Preserving charCache across frames is the main win — most
     * lines don't change between renders, so tokenize + grapheme clustering
     * becomes a cache hit.
     */
    reset(width: number, height: number, screen: Screen): void;
    /**
     * Copy cells from a source screen region (blit = block image transfer).
     */
    blit(src: Screen, x: number, y: number, width: number, height: number): void;
    /**
     * Shift full-width rows within [top, bottom] by n. n > 0 = up. Mirrors
     * what DECSTBM + SU/SD does to the terminal. Paired with blit() to reuse
     * prevScreen content during pure scroll, avoiding full child re-render.
     */
    shift(top: number, bottom: number, n: number): void;
    /**
     * Clear a region by writing empty cells. Used when a node shrinks to
     * ensure stale content from the previous frame is removed.
     */
    clear(region: Rectangle, fromAbsolute?: boolean): void;
    /**
     * Mark a region as non-selectable (excluded from fullscreen text
     * selection copy + highlight). Used by <NoSelect> to fence off
     * gutters (line numbers, diff sigils). Applied AFTER blit/write so
     * the mark wins regardless of what's blitted into the region.
     */
    noSelect(region: Rectangle): void;
    write(x: number, y: number, text: string, softWrap?: boolean[]): void;
    clip(clip: Clip): void;
    unclip(): void;
    get(): Screen;
}
export {};
//# sourceMappingURL=output.d.ts.map