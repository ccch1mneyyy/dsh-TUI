/**
 * Text selection state for fullscreen mode.
 *
 * Tracks a linear selection in screen-buffer coordinates (0-indexed col/row).
 * Selection is line-based: cells from (startCol, startRow) through
 * (endCol, endRow) inclusive, wrapping across line boundaries. This matches
 * terminal-native selection behavior (not rectangular/block).
 *
 * The selection is stored as ANCHOR (where the drag started) + FOCUS (where
 * the cursor is now). The rendered highlight normalizes to start ≤ end.
 */
import type { Screen, StylePool } from './screen.js';
type Point = {
    col: number;
    row: number;
};
/**
 * Selection state for fullscreen mode: the anchor/focus cell pair plus
 * the off-screen row accumulators captured during drag-to-scroll.
 */
export type SelectionState = {
    /** Where the mouse-down occurred. Null when no selection. */
    anchor: Point | null;
    /** Current drag position (updated on mouse-move while dragging). */
    focus: Point | null;
    /** True between mouse-down and mouse-up. */
    isDragging: boolean;
    /** For word/line mode: the initial word/line bounds from the first
     *  multi-click. Drag extends from this span to the word/line at the
     *  current mouse position so the original word/line stays selected
     *  even when dragging backward past it. Null ⇔ char mode. The kind
     *  tells extendSelection whether to snap to word or line boundaries. */
    anchorSpan: {
        lo: Point;
        hi: Point;
        kind: 'word' | 'line';
    } | null;
    /** Text from rows that scrolled out ABOVE the viewport during
     *  drag-to-scroll. The screen buffer only holds the current viewport,
     *  so without this accumulator, dragging down past the bottom edge
     *  loses the top of the selection once the anchor clamps. Prepended
     *  to the on-screen text by getSelectedText. Reset on start/clear. */
    scrolledOffAbove: string[];
    /** Symmetric: rows scrolled out BELOW when dragging up. Appended. */
    scrolledOffBelow: string[];
    /** Soft-wrap bits parallel to scrolledOffAbove — true means the row
     *  is a continuation of the one before it (the `\n` was inserted by
     *  word-wrap, not in the source). Captured alongside the text at
     *  scroll time since the screen's softWrap bitmap shifts with content.
     *  getSelectedText uses these to join wrapped rows back into logical
     *  lines. */
    scrolledOffAboveSW: boolean[];
    /** Parallel to scrolledOffBelow. */
    scrolledOffBelowSW: boolean[];
    /** Pre-clamp anchor row. Set when shiftSelection clamps anchor so a
     *  reverse scroll can restore the true position and pop accumulators.
     *  Without this, PgDn (clamps anchor) → PgUp leaves anchor at the wrong
     *  row AND scrolledOffAbove stale — highlight ≠ copy. Undefined when
     *  anchor is in-bounds (no clamp debt). Cleared on start/clear. */
    virtualAnchorRow?: number;
    /** Same for focus. */
    virtualFocusRow?: number;
    /** True if the mouse-down that started this selection had the alt
     *  modifier set (SGR button bit 0x08). On macOS xterm.js this is a
     *  signal that VS Code's macOptionClickForcesSelection is OFF — if it
     *  were on, xterm.js would have consumed the event for native selection
     *  and we'd never receive it. Used by the footer to show the right hint. */
    lastPressHadAlt: boolean;
};
/**
 * Create a new selection state with no active selection.
 * @returns the empty selection state.
 */
export declare function createSelectionState(): SelectionState;
/**
 * Begin a new drag selection at (col, row): set the anchor, mark the
 * state as dragging, and clear every accumulator. Focus stays null until
 * the first drag motion, so a bare click never highlights a cell.
 * @param s - the selection state to mutate.
 * @param col - anchor column in screen-buffer coordinates.
 * @param row - anchor row in screen-buffer coordinates.
 */
export declare function startSelection(s: SelectionState, col: number, row: number): void;
/**
 * Track the drag position: update focus to (col, row). No-op while not
 * dragging, and the first motion at the anchor cell is ignored so a bare
 * click never becomes a one-cell selection.
 * @param s - the selection state to mutate.
 * @param col - current mouse column.
 * @param row - current mouse row.
 */
export declare function updateSelection(s: SelectionState, col: number, row: number): void;
/**
 * End a drag: clear the dragging flag while keeping anchor/focus so the
 * highlight stays visible and the text can be copied. Call
 * clearSelection to drop the selection after copy or on Esc.
 * @param s - the selection state to mutate.
 */
export declare function finishSelection(s: SelectionState): void;
/**
 * Reset the selection to the empty state: no anchor, focus, span, or
 * scrolled-off accumulators.
 * @param s - the selection state to mutate.
 */
export declare function clearSelection(s: SelectionState): void;
/**
 * Select the word at (col, row) by scanning the screen buffer for the
 * bounds of the same-class character run. Mutates the selection in place.
 * No-op if the click is out of bounds or lands on a noSelect cell.
 * Sets isDragging=true and anchorSpan so a subsequent drag extends the
 * selection word-by-word (native macOS behavior).
 * @param s - the selection state to mutate.
 * @param screen - the screen buffer to scan for word bounds.
 * @param col - click column.
 * @param row - click row.
 */
export declare function selectWordAt(s: SelectionState, screen: Screen, col: number, row: number): void;
/**
 * Scan the screen buffer for a plain-text URL at (col, row). Mirrors the
 * terminal's native Cmd+Click URL detection, which fullscreen mode's mouse
 * tracking intercepts. Called from getHyperlinkAt as a fallback when the
 * cell has no OSC 8 hyperlink.
 * @param screen - the screen buffer to scan.
 * @param col - click column.
 * @param row - click row.
 * @returns the URL at the click position, or undefined when the cell is
 *   not part of a plain-text URL.
 */
export declare function findPlainTextUrlAt(screen: Screen, col: number, row: number): string | undefined;
/**
 * Select the entire row. Sets isDragging=true and anchorSpan so a
 * subsequent drag extends the selection line-by-line. The anchor/focus
 * span from col 0 to width-1; getSelectedText handles noSelect skipping
 * and trailing-whitespace trimming so the copied text is just the visible
 * line content.
 * @param s - the selection state to mutate.
 * @param screen - the screen buffer providing the row width.
 * @param row - the row to select.
 */
export declare function selectLineAt(s: SelectionState, screen: Screen, row: number): void;
/**
 * Extend a word/line-mode selection to the word/line at (col, row). The
 * anchor span (the original multi-clicked word/line) stays selected; the
 * selection grows from that span to the word/line at the current mouse
 * position. Word mode falls back to the raw cell when the mouse is over a
 * noSelect cell or out of bounds, so dragging into gutters still extends.
 * @param s - the selection state to mutate.
 * @param screen - the screen buffer to scan for word bounds.
 * @param col - current mouse column.
 * @param row - current mouse row.
 */
export declare function extendSelection(s: SelectionState, screen: Screen, col: number, row: number): void;
/** Semantic keyboard focus moves. See moveSelectionFocus in ink.tsx for
 *  how screen bounds + row-wrap are applied. */
export type FocusMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd';
/**
 * Set focus to (col, row) for keyboard selection extension (shift+arrow).
 * Anchor stays fixed; selection grows or shrinks depending on where focus
 * moves relative to anchor. Drops to char mode (clears anchorSpan) —
 * native macOS does this too: shift+arrow after a double-click word-select
 * extends char-by-char from the word edge, not word-by-word. Scrolled-off
 * accumulators are preserved: keyboard-extending a drag-scrolled selection
 * keeps the off-screen rows. Caller supplies coords already clamped/wrapped.
 * @param s - the selection state to mutate.
 * @param col - focus column.
 * @param row - focus row.
 */
export declare function moveFocus(s: SelectionState, col: number, row: number): void;
/**
 * Shift anchor AND focus by dRow, clamped to [minRow, maxRow]. Used for
 * keyboard scroll (PgUp/PgDn/ctrl+u/d/b/f): the whole selection must track
 * the content, unlike drag-to-scroll where focus stays at the mouse. Any
 * point that hits a clamp bound gets its col reset to the full-width edge —
 * its original content scrolled off-screen and was captured by
 * captureScrolledRows, so the col constraint was already consumed. Keeping
 * it would truncate the NEW content now at that screen row. Clamp col is 0
 * for dRow<0 (scrolling down, top leaves, 'above' semantics) or width-1 for
 * dRow>0 (scrolling up, bottom leaves, 'below' semantics).
 *
 * If both ends overshoot the SAME viewport edge (select text → Home/End/g/G
 * jumps far enough that both are out of view), clear — otherwise both clamp
 * to the same corner cell and a ghost 1-cell highlight lingers, and
 * getSelectedText returns one unrelated char from that corner. Symmetric
 * with shiftSelectionForFollow's top-edge check, but bidirectional: keyboard
 * scroll can jump either way.
 * @param s - the selection state to mutate.
 * @param dRow - signed row offset to shift by.
 * @param minRow - lowest allowed row (viewport top).
 * @param maxRow - highest allowed row (viewport bottom).
 * @param width - screen width, used for the clamp-edge column.
 */
export declare function shiftSelection(s: SelectionState, dRow: number, minRow: number, maxRow: number, width: number): void;
/**
 * Shift the anchor row by dRow, clamped to [minRow, maxRow]. Used during
 * drag-to-scroll: when the ScrollBox scrolls by N rows, the content that
 * was under the anchor is now at a different viewport row, so the anchor
 * must follow it. Focus is left unchanged (it stays at the mouse position).
 * @param s - the selection state to mutate.
 * @param dRow - signed row offset to shift by.
 * @param minRow - lowest allowed row (viewport top).
 * @param maxRow - highest allowed row (viewport bottom).
 */
export declare function shiftAnchor(s: SelectionState, dRow: number, minRow: number, maxRow: number): void;
/**
 * Shift the whole selection (anchor + focus + anchorSpan) by dRow, clamped
 * to [minRow, maxRow]. Used when sticky/auto-follow scrolls the ScrollBox
 * while a selection is active — native terminal behavior is for the
 * highlight to walk up the screen with the text (not stay at the same
 * screen position).
 *
 * Differs from shiftAnchor: during drag-to-scroll, focus tracks the live
 * mouse position and only anchor follows the text. During streaming-follow,
 * the selection is text-anchored at both ends — both must move. The
 * isDragging check in ink.tsx picks which shift to apply.
 *
 * If both ends would shift strictly BELOW minRow (unclamped), the selected
 * text has scrolled entirely off the top. Clear it — otherwise a single
 * inverted cell lingers at the viewport top as a ghost (native terminals
 * drop the selection when it leaves scrollback). Landing AT minRow is
 * still valid: that cell holds the correct text. Returns true if the
 * selection was cleared so the caller can notify React-land subscribers
 * (useHasSelection) — the caller is inside onRender so it can't use
 * notifySelectionChange (recursion), must fire listeners directly.
 * @param s - the selection state to mutate.
 * @param dRow - signed row offset to shift by.
 * @param minRow - lowest allowed row (viewport top).
 * @param maxRow - highest allowed row (viewport bottom).
 * @returns true when the selection was cleared because it scrolled
 *   entirely off the top, false otherwise.
 */
export declare function shiftSelectionForFollow(s: SelectionState, dRow: number, minRow: number, maxRow: number): boolean;
/**
 * True when a selection is active, meaning both anchor and focus are set.
 * @param s - the selection state to inspect.
 * @returns true when a selection is active.
 */
export declare function hasSelection(s: SelectionState): boolean;
/**
 * Normalized selection bounds: start is always before end in reading order.
 * Returns null if no active selection.
 * @param s - the selection state to inspect.
 * @returns the normalized start/end cells, or null when there is no
 *   active selection.
 */
export declare function selectionBounds(s: SelectionState): {
    start: {
        col: number;
        row: number;
    };
    end: {
        col: number;
        row: number;
    };
} | null;
/**
 * Check if a cell at (col, row) is within the current selection range.
 * Used by the renderer to apply inverse style.
 * @param s - the selection state to inspect.
 * @param col - cell column.
 * @param row - cell row.
 * @returns true when the cell lies inside the selection range.
 */
export declare function isCellSelected(s: SelectionState, col: number, row: number): boolean;
/**
 * Extract text from the screen buffer within the selection range.
 * Rows are joined with newlines unless the screen's softWrap bitmap
 * marks a row as a word-wrap continuation — those rows are concatenated
 * onto the previous row so the copied text matches the logical source
 * line, not the visual wrapped layout. Trailing whitespace on the last
 * fragment of each logical line is trimmed. Wide-char spacer cells are
 * skipped. Rows that scrolled out of the viewport during drag-to-scroll
 * are joined back in from the scrolledOffAbove/Below accumulators along
 * with their captured softWrap bits.
 * @param s - the selection state to read.
 * @param screen - the screen buffer to extract from.
 * @returns the selected text, or an empty string when no selection is
 *   active.
 */
export declare function getSelectedText(s: SelectionState, screen: Screen): string;
/**
 * Capture text from rows about to scroll out of the viewport during
 * drag-to-scroll, BEFORE scrollBy overwrites them. Only the rows that
 * intersect the selection are captured, using the selection's col bounds
 * for the anchor-side boundary row. After capturing the anchor row, the
 * anchor.col AND anchorSpan cols are reset to the full-width boundary so
 * subsequent captures and the final getSelectedText don't re-apply a stale
 * col constraint to content that's no longer under the original anchor.
 * Both span cols are reset (not just the near side): after a blocked
 * reversal the drag can flip direction, and extendSelection then reads the
 * OPPOSITE span side — which would otherwise still hold the original word
 * boundary and truncate one subsequently-captured row.
 *
 * side='above': rows scrolling out the top (dragging down, anchor=start).
 * side='below': rows scrolling out the bottom (dragging up, anchor=end).
 * @param s - the selection state to update.
 * @param screen - the screen buffer to read rows from.
 * @param firstRow - first viewport row that is about to scroll out.
 * @param lastRow - last viewport row that is about to scroll out.
 * @param side - which viewport edge the rows scroll out of.
 */
export declare function captureScrolledRows(s: SelectionState, screen: Screen, firstRow: number, lastRow: number, side: 'above' | 'below'): void;
/**
 * Apply the selection overlay directly to the screen buffer by changing
 * the style of every cell in the selection range. Called after the
 * renderer produces the Frame but before the diff — the normal diffEach
 * then picks up the restyled cells as ordinary changes, so LogUpdate
 * stays a pure diff engine with no selection awareness.
 *
 * Uses a SOLID selection background (theme-provided via StylePool.
 * setSelectionBg) that REPLACES each cell's bg while PRESERVING its fg —
 * matches native terminal selection. Previously SGR-7 inverse (swapped
 * fg/bg per cell), which fragmented badly over syntax-highlighted text:
 * every distinct fg color became a different bg stripe.
 *
 * Uses StylePool caches so on drag the only work per cell is a Map
 * lookup + packed-int write.
 * @param screen - the screen buffer to restyle.
 * @param selection - the selection whose range to highlight.
 * @param stylePool - the style pool providing the selection background.
 */
export declare function applySelectionOverlay(screen: Screen, selection: SelectionState, stylePool: StylePool): void;
export {};
//# sourceMappingURL=selection.d.ts.map