import { type AnsiCode } from '@alcalzone/ansi-tokenize';
import { type Point, type Rectangle, type Size } from './layout/geometry.js';
/**
 * Pool of character strings shared across all screens.
 * With a shared pool, interned char IDs are valid across screens, so
 * blitRegion can copy IDs directly (no re-interning) and diffEach can
 * compare IDs as integers (no string lookup).
 */
export declare class CharPool {
    private strings;
    private stringMap;
    private ascii;
    /**
     * Intern a character string and return its stable pool index.
     * @param char - the character string to intern.
     * @returns the pool index for the string.
     */
    intern(char: string): number;
    /**
     * Return the character string for a pool index, or a space for an
     * out-of-range index.
     * @param index - the pool index to look up.
     * @returns the interned string.
     */
    get(index: number): string;
}
/**
 * Pool of hyperlink strings shared across all screens.
 * Index 0 represents "no hyperlink".
 */
export declare class HyperlinkPool {
    private strings;
    private stringMap;
    /**
     * Intern a hyperlink string and return its stable pool index.
     * @param hyperlink - the hyperlink to intern; undefined or empty maps to 0.
     * @returns the pool index for the hyperlink.
     */
    intern(hyperlink: string | undefined): number;
    /**
     * Return the hyperlink string for a pool index.
     * @param id - the pool index to look up.
     * @returns the interned hyperlink, or undefined for index 0.
     */
    get(id: number): string | undefined;
}
/**
 * Pool of interned ANSI style stacks. Each style maps to an ID whose bit 0
 * encodes whether the style is visible on space characters; IDs are valid
 * across all screens sharing this pool.
 */
export declare class StylePool {
    private ids;
    private styles;
    private transitionCache;
    /** Style ID of the empty style stack, used as the empty-cell style. */
    readonly none: number;
    constructor();
    /**
     * Intern a style and return its ID. Bit 0 of the ID encodes whether the
     * style has a visible effect on space characters (background, inverse,
     * underline, etc.). Foreground-only styles get even IDs; styles visible
     * on spaces get odd IDs. This lets the renderer skip invisible spaces
     * with a single bitmask check on the packed word.
     * @param styles - the ANSI code stack to intern.
     * @returns the interned style ID.
     */
    intern(styles: AnsiCode[]): number;
    /**
     * Recover the style stack from an encoded ID. Strips the bit-0 flag via
     * `>>> 1`.
     * @param id - the encoded style ID.
     * @returns the interned ANSI code stack, or an empty array for an unknown ID.
     */
    get(id: number): AnsiCode[];
    /**
     * Returns the pre-serialized ANSI string to transition from one style to
     * another. Cached by (fromId, toId) — zero allocations after first call
     * for a given pair.
     * @param fromId - the style ID to transition from.
     * @param toId - the style ID to transition to.
     * @returns the ANSI escape sequence applying the difference, or an empty
     *   string when both styles are equal.
     */
    transition(fromId: number, toId: number): string;
    /**
     * Intern a style that is `base + inverse`. Cached by base ID so
     * repeated calls for the same underlying style don't re-scan the
     * AnsiCode[] array. Used by the selection overlay.
     */
    private inverseCache;
    /**
     * Intern a style that is `base + inverse`, reusing the base style when it
     * is already inverted to avoid stacking SGR 7.
     * @param baseId - the style ID to overlay inverse onto.
     * @returns the ID of the inverted style.
     */
    withInverse(baseId: number): number;
    /** Inverse + bold + yellow-bg-via-fg-swap for the CURRENT search match.
     *  OTHER matches are plain inverse — bg inherits from the theme. Current
     *  gets a distinct yellow bg (via fg-then-inverse swap) plus bold weight
     *  so it stands out in a sea of inverse. Underline was too subtle. Zero
     *  reflow risk: all pure SGR overlays, per-cell, post-layout. The yellow
     *  overrides any existing fg (syntax highlighting) on those cells — fine,
     *  the "you are here" signal IS the point, syntax color can yield. */
    private currentMatchCache;
    /**
     * Intern a style marking the current search match: inverse plus bold and
     * a yellow background (via fg-then-inverse swap), distinct from the plain
     * inverse used for other matches.
     * @param baseId - the style ID to overlay match markers onto.
     * @returns the ID of the match style.
     */
    withCurrentMatch(baseId: number): number;
    /**
     * Selection overlay: REPLACE the cell's background with a solid color
     * while preserving its foreground (color, bold, italic, dim, underline).
     * Matches native terminal selection — a dedicated bg color, not SGR-7
     * inverse. Inverse swaps fg/bg per-cell, which fragments visually over
     * syntax-highlighted text (every fg color becomes a different bg stripe).
     *
     * Strips any existing bg (endCode 49m — REPLACES, so diff-added green
     * etc. don't bleed through) and any existing inverse (endCode 27m —
     * inverse on top of a solid bg would re-swap and look wrong).
     *
     * bg is set via setSelectionBg(); null → fallback to withInverse() so the
     * overlay still works before theme wiring sets a color (tests, first frame).
     * Cache is keyed by baseId only — setSelectionBg() clears it on change.
     */
    private selectionBgCode;
    private selectionBgCache;
    /**
     * Set the background color used by the selection overlay and clear the
     * overlay cache so the new color takes effect.
     * @param bg - the background ANSI code, or null to fall back to inverse.
     */
    setSelectionBg(bg: AnsiCode | null): void;
    /**
     * Intern a style with the selection background replacing the cell's own
     * background and inverse, preserving foreground attributes. Falls back to
     * withInverse() when no selection background is set.
     * @param baseId - the style ID to overlay the selection background onto.
     * @returns the ID of the selection style.
     */
    withSelectionBg(baseId: number): number;
}
/**
 * Cell width classification for handling double-wide characters (CJK, emoji,
 * etc.)
 *
 * We use explicit spacer cells rather than inferring width at render time. This
 * makes the data structure self-describing and simplifies cursor positioning
 * logic.
 *
 * @see https://mitchellh.com/writing/grapheme-clusters-in-terminals
 */
export declare const enum CellWidth {
    Narrow = 0,
    Wide = 1,
    SpacerTail = 2,
    SpacerHead = 3
}
/**
 * A hyperlink URI carried by a cell, or undefined when the cell has none.
 */
export type Hyperlink = string | undefined;
/**
 * Cell is a view type returned by cellAt(). Cells are stored as packed typed
 * arrays internally to avoid GC pressure from allocating objects per cell.
 */
export type Cell = {
    char: string;
    styleId: number;
    width: CellWidth;
    hyperlink: Hyperlink;
};
/**
 * Screen uses a packed Int32Array instead of Cell objects to eliminate GC
 * pressure. For a 200x120 screen, this avoids allocating 24,000 objects.
 *
 * Cell data is stored as 2 Int32s per cell in a single contiguous array:
 *   word0: charId (full 32 bits — index into CharPool)
 *   word1: styleId[31:17] | hyperlinkId[16:2] | width[1:0]
 *
 * This layout halves memory accesses in diffEach (2 int loads vs 4) and
 * enables future SIMD comparison via Bun.indexOfFirstDifference.
 */
export type Screen = Size & {
    cells: Int32Array;
    cells64: BigInt64Array;
    charPool: CharPool;
    hyperlinkPool: HyperlinkPool;
    emptyStyleId: number;
    /**
     * Bounding box of cells that were written to (not blitted) during rendering.
     * Used by diff() to limit iteration to only the region that could have changed.
     */
    damage: Rectangle | undefined;
    /**
     * Per-cell noSelect bitmap — 1 byte per cell, 1 = exclude from text
     * selection (copy + highlight). Used by <NoSelect> to mark gutters
     * (line numbers, diff sigils) so click-drag over a diff yields clean
     * copyable code. Fully reset each frame in resetScreen; blitRegion
     * copies it alongside cells so the blit optimization preserves marks.
     */
    noSelect: Uint8Array;
    /**
     * Per-ROW soft-wrap continuation marker. softWrap[r]=N>0 means row r
     * is a word-wrap continuation of row r-1 (the `\n` before it was
     * inserted by wrapAnsi, not in the source), and row r-1's written
     * content ends at absolute column N (exclusive — cells [0..N) are the
     * fragment, past N is unwritten padding). 0 means row r is NOT a
     * continuation (hard newline or first row). Selection copy checks
     * softWrap[r]>0 to join row r onto row r-1 without a newline, and
     * reads softWrap[r+1] to know row r's content end when row r+1
     * continues from it. The content-end column is needed because an
     * unwritten cell and a written-unstyled-space are indistinguishable in
     * the packed typed array (both all-zero) — without it we'd either drop
     * the word-separator space (trim) or include trailing padding (no
     * trim). This encoding (continuation-on-self, prev-content-end-here)
     * is chosen so shiftRows preserves the is-continuation semantics: when
     * row r scrolls off the top and row r+1 shifts to row r, sw[r] gets
     * old sw[r+1] — which correctly says the new row r is a continuation
     * of what's now in scrolledOffAbove. Reset each frame; copied by
     * blitRegion/shiftRows.
     */
    softWrap: Int32Array;
};
/**
 * Return whether the cell at a position is empty or unwritten, treating
 * out-of-bounds positions as empty.
 * @param screen - the screen to read.
 * @param x - the cell column.
 * @param y - the cell row.
 * @returns true when the cell is empty or out of bounds.
 */
export declare function isEmptyCellAt(screen: Screen, x: number, y: number): boolean;
/**
 * Check if a Cell (view object) represents an empty cell.
 * @param screen - the screen the cell belongs to, for its empty style ID.
 * @param cell - the cell view to inspect.
 * @returns true when the cell is a space with the empty style, narrow
 *   width, and no hyperlink.
 */
export declare function isCellEmpty(screen: Screen, cell: Cell): boolean;
/**
 * Create a new screen with packed cell storage backed by the given shared
 * pools. Non-integer or negative dimensions are clamped to valid integers.
 * @param width - the screen width in cells.
 * @param height - the screen height in rows.
 * @param styles - the shared style pool; its `none` ID becomes the empty style.
 * @param charPool - the shared character pool.
 * @param hyperlinkPool - the shared hyperlink pool.
 * @returns the new empty screen.
 */
export declare function createScreen(width: number, height: number, styles: StylePool, charPool: CharPool, hyperlinkPool: HyperlinkPool): Screen;
/**
 * Reset an existing screen for reuse, avoiding allocation of new typed arrays.
 * Resizes if needed and clears all cells to empty/unwritten state.
 *
 * For double-buffering, this allows swapping between front and back buffers
 * without allocating new Screen objects each frame.
 * @param screen - the screen to reset and resize.
 * @param width - the new width in cells.
 * @param height - the new height in rows.
 */
export declare function resetScreen(screen: Screen, width: number, height: number): void;
/**
 * Re-intern a screen's char and hyperlink IDs into new pools.
 * Used for generational pool reset — after migrating, the screen's
 * typed arrays contain valid IDs for the new pools, and the old pools
 * can be GC'd.
 *
 * O(width * height) but only called occasionally (e.g., between conversation turns).
 * @param screen - the screen whose char and hyperlink IDs to migrate.
 * @param charPool - the new character pool.
 * @param hyperlinkPool - the new hyperlink pool.
 */
export declare function migrateScreenPools(screen: Screen, charPool: CharPool, hyperlinkPool: HyperlinkPool): void;
/**
 * Get a Cell view at the given position. Returns a new object each call -
 * this is intentional as cells are stored packed, not as objects.
 * @param screen - the screen to read.
 * @param x - the cell column.
 * @param y - the cell row.
 * @returns the cell view, or undefined when the position is out of bounds.
 */
export declare function cellAt(screen: Screen, x: number, y: number): Cell | undefined;
/**
 * Get a Cell view by pre-computed array index. Skips bounds checks and
 * index computation — caller must ensure index is valid.
 * @param screen - the screen to read.
 * @param index - the linear cell index (row * width + column).
 * @returns the cell view.
 */
export declare function cellAtIndex(screen: Screen, index: number): Cell;
/**
 * Get a Cell at the given index, or undefined if it has no visible content.
 * Returns undefined for spacer cells (charId 1), empty unstyled spaces, and
 * fg-only styled spaces that match lastRenderedStyleId (cursor-forward
 * produces an identical visual result, avoiding a Cell allocation).
 *
 * @param cells - the packed cell words to read (2 Int32s per cell).
 * @param charPool - the character pool to resolve char IDs.
 * @param hyperlinkPool - the hyperlink pool to resolve hyperlink IDs.
 * @param index - the linear cell index (row * width + column).
 * @param lastRenderedStyleId - styleId of the last rendered cell on this
 *   line, or -1 if none yet.
 * @returns the cell view, or undefined when the cell has no visible content.
 */
export declare function visibleCellAtIndex(cells: Int32Array, charPool: CharPool, hyperlinkPool: HyperlinkPool, index: number, lastRenderedStyleId: number): Cell | undefined;
/**
 * Return the character at a position without building a Cell view.
 * @param screen - the screen to read.
 * @param x - the cell column.
 * @param y - the cell row.
 * @returns the character string, or undefined when out of bounds.
 */
export declare function charInCellAt(screen: Screen, x: number, y: number): string | undefined;
/**
 * Set a cell, optionally creating a spacer for wide characters.
 *
 * Wide characters (CJK, emoji) occupy 2 cells in the buffer:
 * 1. First cell: Contains the actual character with width = Wide
 * 2. Second cell: Spacer cell with width = SpacerTail (empty, not rendered)
 *
 * If the cell has width = Wide, this function automatically creates the
 * corresponding SpacerTail in the next column. This two-cell model keeps
 * the buffer aligned to visual columns, making cursor positioning
 * straightforward.
 *
 * TODO: When soft-wrapping is implemented, SpacerHead cells will be explicitly
 * placed by the wrapping logic at line-end positions where wide characters
 * wrap to the next line. This function doesn't need to handle SpacerHead
 * automatically - it will be set directly by the wrapping code.
 * @param screen - the screen to write into.
 * @param x - the cell column.
 * @param y - the cell row.
 * @param cell - the cell data to write.
 */
export declare function setCellAt(screen: Screen, x: number, y: number, cell: Cell): void;
/**
 * Replace the styleId of a cell in-place without disturbing char, width,
 * or hyperlink. Preserves empty cells as-is (char stays ' '). Tracks damage
 * for the cell so diffEach picks up the change.
 * @param screen - the screen to update.
 * @param x - the cell column.
 * @param y - the cell row.
 * @param styleId - the new style ID.
 */
export declare function setCellStyleId(screen: Screen, x: number, y: number, styleId: number): void;
/**
 * Bulk-copy a rectangular region from src to dst using TypedArray.set().
 * Single cells.set() call per row (or one call for contiguous blocks).
 * Damage is computed once for the whole region.
 *
 * Clamps negative regionX/regionY to 0 (matching clearRegion) — absolute-
 * positioned overlays in tiny terminals can compute negative screen coords.
 * maxX/maxY should already be clamped to both screen bounds by the caller.
 * @param dst - the destination screen.
 * @param src - the source screen.
 * @param regionX - the source region's left column.
 * @param regionY - the source region's top row.
 * @param maxX - the exclusive right edge of the region.
 * @param maxY - the exclusive bottom edge of the region.
 */
export declare function blitRegion(dst: Screen, src: Screen, regionX: number, regionY: number, maxX: number, maxY: number): void;
/**
 * Bulk-clear a rectangular region of the screen.
 * Uses BigInt64Array.fill() for fast row clears.
 * Handles wide character boundary cleanup at region edges.
 * @param screen - the screen to clear.
 * @param regionX - the region's left column.
 * @param regionY - the region's top row.
 * @param regionWidth - the region width in cells.
 * @param regionHeight - the region height in rows.
 */
export declare function clearRegion(screen: Screen, regionX: number, regionY: number, regionWidth: number, regionHeight: number): void;
/**
 * Shift full-width rows within [top, bottom] (inclusive, 0-indexed) by n.
 * n > 0 shifts UP (simulating CSI n S); n < 0 shifts DOWN (CSI n T).
 * Vacated rows are cleared. Does NOT update damage. Both cells and the
 * noSelect bitmap are shifted so text-selection markers stay aligned when
 * this is applied to next.screen during scroll fast path.
 * @param screen - the screen to shift.
 * @param top - the first row of the shifted range (inclusive).
 * @param bottom - the last row of the shifted range (inclusive).
 * @param n - the shift in rows; positive shifts up, negative shifts down.
 */
export declare function shiftRows(screen: Screen, top: number, bottom: number, n: number): void;
/**
 * The OSC 8 hyperlink escape prefix (`ESC ] 8 ;`) used for cheap pre-checks
 * before running the full OSC 8 regex.
 */
export declare const OSC8_PREFIX = "\u001B]8;";
/**
 * Extract the hyperlink URI from the first OSC 8 style in a style stack.
 * @param styles - the ANSI code stack to scan.
 * @returns the hyperlink URI, or null when no OSC 8 style is present.
 */
export declare function extractHyperlinkFromStyles(styles: AnsiCode[]): Hyperlink | null;
/**
 * Return the style stack with all OSC 8 hyperlink styles removed.
 * @param styles - the ANSI code stack to filter.
 * @returns a new stack without hyperlink styles.
 */
export declare function filterOutHyperlinkStyles(styles: AnsiCode[]): AnsiCode[];
/**
 * Returns an array of all changes between two screens. Used by tests.
 * Production code should use diffEach() to avoid allocations.
 * @param prev - the previous screen state.
 * @param next - the next screen state.
 * @returns one entry per changed cell: the point plus the removed and added
 *   cell views (undefined when that side has no cell).
 */
export declare function diff(prev: Screen, next: Screen): [point: Point, removed: Cell | undefined, added: Cell | undefined][];
type DiffCallback = (x: number, y: number, removed: Cell | undefined, added: Cell | undefined) => boolean | void;
/**
 * Like diff(), but calls a callback for each change instead of building an array.
 * Reuses two Cell objects to avoid per-change allocations. The callback must not
 * retain references to the Cell objects — their contents are overwritten each call.
 *
 * Returns true if the callback ever returned true (early exit signal).
 * @param prev - the previous screen state.
 * @param next - the next screen state.
 * @param cb - the per-change callback; returning true stops iteration.
 * @returns true when the callback requested an early exit.
 */
export declare function diffEach(prev: Screen, next: Screen, cb: DiffCallback): boolean;
/**
 * Mark a rectangular region as noSelect (exclude from text selection).
 * Clamps to screen bounds. Called from output.ts when a <NoSelect> box
 * renders. No damage tracking — noSelect doesn't affect terminal output,
 * only getSelectedText/applySelectionOverlay which read it directly.
 * @param screen - the screen to update.
 * @param x - the region's left column.
 * @param y - the region's top row.
 * @param width - the region width in cells.
 * @param height - the region height in rows.
 */
export declare function markNoSelectRegion(screen: Screen, x: number, y: number, width: number, height: number): void;
export {};
//# sourceMappingURL=screen.d.ts.map