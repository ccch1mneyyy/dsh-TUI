import type { DOMElement } from './dom.js';
import { FocusEvent } from './events/focus-event.js';
/**
 * DOM-like focus manager for the Ink terminal UI.
 *
 * Pure state — tracks activeElement and a focus stack. Has no reference
 * to the tree; callers pass the root when tree walks are needed.
 *
 * Stored on the root DOMElement so any node can reach it by walking
 * parentNode (like browser's `node.ownerDocument`).
 */
export declare class FocusManager {
    /** The element that currently has focus, or null when nothing is focused. */
    activeElement: DOMElement | null;
    private dispatchFocusEvent;
    private enabled;
    private focusStack;
    constructor(dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean);
    /**
     * Move focus to a node.
     * @param node - the element to focus.
     */
    focus(node: DOMElement): void;
    /** Drop focus from the active element, dispatching a blur event. */
    blur(): void;
    /**
     * Called by the reconciler when a node is removed from the tree.
     * Handles both the exact node and any focused descendant within
     * the removed subtree. Dispatches blur and restores focus from stack.
     * @param node - the removed element.
     * @param root - the tree root used to test whether elements are still mounted.
     */
    handleNodeRemoved(node: DOMElement, root: DOMElement): void;
    /**
     * Focus a node on mount when it requests auto-focus.
     * @param node - the element to focus.
     */
    handleAutoFocus(node: DOMElement): void;
    /**
     * Focus a node when it is clicked, provided it carries a numeric `tabIndex`.
     * @param node - the clicked element.
     */
    handleClickFocus(node: DOMElement): void;
    /** Re-enable focus tracking after a disable. */
    enable(): void;
    /** Disable focus tracking: focus requests are ignored until re-enabled. */
    disable(): void;
    /**
     * Move focus to the next tabbable element within the tree.
     * @param root - the tree root whose tabbable elements are cycled.
     */
    focusNext(root: DOMElement): void;
    /**
     * Move focus to the previous tabbable element within the tree.
     * @param root - the tree root whose tabbable elements are cycled.
     */
    focusPrevious(root: DOMElement): void;
    private moveFocus;
}
/**
 * Walk up to root and return it. The root is the node that holds
 * the FocusManager — like browser's `node.getRootNode()`.
 * @param node - the node to walk up from.
 * @returns the nearest ancestor holding a FocusManager.
 */
export declare function getRootNode(node: DOMElement): DOMElement;
/**
 * Walk up to root and return its FocusManager.
 * Like browser's `node.ownerDocument` — focus belongs to the root.
 * @param node - the node to walk up from.
 * @returns the root's FocusManager.
 */
export declare function getFocusManager(node: DOMElement): FocusManager;
//# sourceMappingURL=focus.d.ts.map