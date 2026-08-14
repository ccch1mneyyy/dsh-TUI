import { type FocusMove, type SelectionState } from '../selection.js';
/**
 * Access to text selection operations on the Ink instance (fullscreen only).
 * Returns no-op functions when fullscreen mode is disabled.
 * @returns an object of selection operations bound to the Ink instance:
 *   copy, clear, query, subscribe, and scroll/keyboard manipulation.
 */
export declare function useSelection(): {
    copySelection: () => string;
    /** Copy without clearing the highlight (for copy-on-select). */
    copySelectionNoClear: () => string;
    clearSelection: () => void;
    hasSelection: () => boolean;
    /** Read the raw mutable selection state (for drag-to-scroll). */
    getState: () => SelectionState | null;
    /** Subscribe to selection mutations (start/update/finish/clear). */
    subscribe: (cb: () => void) => () => void;
    /** Shift the anchor row by dRow, clamped to [minRow, maxRow]. */
    shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void;
    /** Shift anchor AND focus by dRow (keyboard scroll: whole selection
     *  tracks content). Clamped points get col reset to the full-width edge
     *  since their content was captured by captureScrolledRows. Reads
     *  screen.width from the ink instance for the col-reset boundary. */
    shiftSelection: (dRow: number, minRow: number, maxRow: number) => void;
    /** Keyboard selection extension (shift+arrow): move focus, anchor fixed.
     *  Left/right wrap across rows; up/down clamp at viewport edges. */
    moveFocus: (move: FocusMove) => void;
    /** Capture text from rows about to scroll out of the viewport (call
     *  BEFORE scrollBy so the screen buffer still has the outgoing rows). */
    captureScrolledRows: (firstRow: number, lastRow: number, side: 'above' | 'below') => void;
    /** Set the selection highlight bg color (theme-piping; solid bg
     *  replaces the old SGR-7 inverse so syntax highlighting stays readable
     *  under selection). Call once on mount + whenever theme changes. */
    setSelectionBgColor: (color: string) => void;
};
/**
 * Reactive selection-exists state. Re-renders the caller when a text
 * selection is created or cleared. Always returns false outside
 * fullscreen mode (selection is only available in alt-screen).
 * @returns true when a text selection currently exists; false outside
 *   fullscreen mode.
 */
export declare function useHasSelection(): boolean;
//# sourceMappingURL=use-selection.d.ts.map