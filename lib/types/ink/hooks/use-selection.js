import { useContext, useMemo, useSyncExternalStore } from 'react';
import StdinContext from '../components/StdinContext.js';
import instances from '../instances.js';
import { shiftAnchor, } from '../selection.js';
/**
 * Access to text selection operations on the Ink instance (fullscreen only).
 * Returns no-op functions when fullscreen mode is disabled.
 */
export function useSelection() {
    // Look up the Ink instance via stdout — same pattern as instances map.
    // StdinContext is available (it's always provided), and the Ink instance
    // is keyed by stdout which we can get from process.stdout since there's
    // only one Ink instance per process in practice.
    useContext(StdinContext); // anchor to App subtree for hook rules
    const ink = instances.get(process.stdout);
    // Memoize so callers can safely use the return value in dependency arrays.
    // ink is a singleton per stdout — stable across renders.
    return useMemo(() => {
        if (!ink) {
            return {
                copySelection: () => '',
                copySelectionNoClear: () => '',
                clearSelection: () => { },
                hasSelection: () => false,
                getState: () => null,
                subscribe: () => () => { },
                shiftAnchor: () => { },
                shiftSelection: () => { },
                moveFocus: () => { },
                captureScrolledRows: () => { },
                setSelectionBgColor: () => { },
            };
        }
        return {
            copySelection: () => ink.copySelection(),
            copySelectionNoClear: () => ink.copySelectionNoClear(),
            clearSelection: () => ink.clearTextSelection(),
            hasSelection: () => ink.hasTextSelection(),
            getState: () => ink.selection,
            subscribe: (cb) => ink.subscribeToSelectionChange(cb),
            shiftAnchor: (dRow, minRow, maxRow) => shiftAnchor(ink.selection, dRow, minRow, maxRow),
            shiftSelection: (dRow, minRow, maxRow) => ink.shiftSelectionForScroll(dRow, minRow, maxRow),
            moveFocus: (move) => ink.moveSelectionFocus(move),
            captureScrolledRows: (firstRow, lastRow, side) => ink.captureScrolledRows(firstRow, lastRow, side),
            setSelectionBgColor: (color) => ink.setSelectionBgColor(color),
        };
    }, [ink]);
}
const NO_SUBSCRIBE = () => () => { };
const ALWAYS_FALSE = () => false;
/**
 * Reactive selection-exists state. Re-renders the caller when a text
 * selection is created or cleared. Always returns false outside
 * fullscreen mode (selection is only available in alt-screen).
 */
export function useHasSelection() {
    useContext(StdinContext);
    const ink = instances.get(process.stdout);
    return useSyncExternalStore(ink ? ink.subscribeToSelectionChange : NO_SUBSCRIBE, ink ? ink.hasTextSelection : ALWAYS_FALSE);
}
//# sourceMappingURL=use-selection.js.map