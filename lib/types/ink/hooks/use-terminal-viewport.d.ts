import type { DOMElement } from '../dom.js';
type ViewportEntry = {
    /**
     * Whether the element is currently within the terminal viewport
     */
    isVisible: boolean;
};
/**
 * Hook to detect if a component is within the terminal viewport.
 *
 * Returns a callback ref and a viewport entry object.
 * Attach the ref to the component you want to track.
 *
 * The entry is updated during the layout phase (useLayoutEffect) so callers
 * always read fresh values during render. Visibility changes do NOT trigger
 * re-renders on their own — callers that re-render for other reasons (e.g.
 * animation ticks, state changes) will pick up the latest value naturally.
 * This avoids infinite update loops when combined with other layout effects
 * that also call setState.
 *
 * @example
 * const [ref, entry] = useTerminalViewport()
 * return <Box ref={ref}><Animation enabled={entry.isVisible}>...</Animation></Box>
 * @returns a tuple of a ref callback to attach to the tracked element and the
 *   current viewport entry object.
 */
export declare function useTerminalViewport(): [
    ref: (element: DOMElement | null) => void,
    entry: ViewportEntry
];
export {};
//# sourceMappingURL=use-terminal-viewport.d.ts.map