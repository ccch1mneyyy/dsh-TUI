import type { DOMElement } from '../dom.js';
/**
 * Declares where the terminal cursor should be parked after each frame.
 *
 * Terminal emulators render IME preedit text at the physical cursor
 * position, and screen readers / screen magnifiers track the native
 * cursor — so parking it at the text input's caret makes CJK input
 * appear inline and lets accessibility tools follow the input.
 *
 * Returns a ref callback to attach to the Box that contains the input.
 * The declared (line, column) is interpreted relative to that Box's
 * nodeCache rect (populated by renderNodeToOutput).
 *
 * Timing: Both ref attach and useLayoutEffect fire in React's layout
 * phase — after resetAfterCommit calls scheduleRender. scheduleRender
 * defers onRender via queueMicrotask, so onRender runs AFTER layout
 * effects commit and reads the fresh declaration on the first frame
 * (no one-keystroke lag). Test env uses onImmediateRender (synchronous,
 * no microtask), so tests compensate by calling ink.onRender()
 * explicitly after render.
 * @param options - the declared cursor target: `line` and `column` give the
 *   position relative to the node, `active` controls whether the declaration
 *   is set or cleared.
 * @returns a ref callback to attach to the Box that contains the input.
 */
export declare function useDeclaredCursor(options: {
    line: number;
    column: number;
    active: boolean;
}): (element: DOMElement | null) => void;
//# sourceMappingURL=use-declared-cursor.d.ts.map