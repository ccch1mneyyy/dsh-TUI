import type { DOMElement } from './dom.js';
/**
 * Find the deepest DOM element whose rendered rect contains (col, row).
 *
 * Uses the nodeCache populated by renderNodeToOutput — rects are in screen
 * coordinates with all offsets (including scrollTop translation) already
 * applied. Children are traversed in reverse so later siblings (painted on
 * top) win. Nodes not in nodeCache (not rendered this frame, or lacking a
 * yogaNode) are skipped along with their subtrees.
 *
 * Returns the hit node even if it has no onClick — dispatchClick walks up
 * via parentNode to find handlers.
 * @param node - the subtree root to test.
 * @param col - the screen column to test.
 * @param row - the screen row to test.
 * @returns the deepest element whose rect contains (col, row), or null.
 */
export declare function hitTest(node: DOMElement, col: number, row: number): DOMElement | null;
/**
 * Hit-test the root at (col, row) and bubble a ClickEvent from the deepest
 * containing node up through parentNode. Only nodes with an onClick handler
 * fire. Stops when a handler calls stopImmediatePropagation(). Returns
 * true if at least one onClick handler fired.
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the click.
 * @param row - the screen row of the click.
 * @param cellIsBlank - whether the clicked cell is blank, reported on the event.
 * @returns true when at least one onClick handler fired.
 */
export declare function dispatchClick(root: DOMElement, col: number, row: number, cellIsBlank?: boolean): boolean;
/**
 * Fire onMouseEnter/onMouseLeave as the pointer moves. Like DOM
 * mouseenter/mouseleave: does NOT bubble — moving between children does
 * not re-fire on the parent. Walks up from the hit node collecting every
 * ancestor with a hover handler; diffs against the previous hovered set;
 * fires leave on the nodes exited, enter on the nodes entered.
 *
 * Mutates `hovered` in place so the caller (App instance) can hold it
 * across calls. Clears the set when the hit is null (cursor moved into a
 * non-rendered gap or off the root rect).
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the pointer.
 * @param row - the screen row of the pointer.
 * @param hovered - the previously hovered element set; updated in place.
 */
export declare function dispatchHover(root: DOMElement, col: number, row: number, hovered: Set<DOMElement>): void;
//# sourceMappingURL=hit-test.d.ts.map