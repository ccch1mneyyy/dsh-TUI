import { ClickEvent } from './events/click-event.js';
import { nodeCache } from './node-cache.js';
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
 */
export function hitTest(node, col, row) {
    const rect = nodeCache.get(node);
    if (!rect)
        return null;
    if (col < rect.x ||
        col >= rect.x + rect.width ||
        row < rect.y ||
        row >= rect.y + rect.height) {
        return null;
    }
    // Later siblings paint on top; reversed traversal returns topmost hit.
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child.nodeName === '#text')
            continue;
        const hit = hitTest(child, col, row);
        if (hit)
            return hit;
    }
    return node;
}
/**
 * Hit-test the root at (col, row) and bubble a ClickEvent from the deepest
 * containing node up through parentNode. Only nodes with an onClick handler
 * fire. Stops when a handler calls stopImmediatePropagation(). Returns
 * true if at least one onClick handler fired.
 */
export function dispatchClick(root, col, row, cellIsBlank = false) {
    let target = hitTest(root, col, row) ?? undefined;
    if (!target)
        return false;
    // Click-to-focus: find the closest focusable ancestor and focus it.
    // root is always ink-root, which owns the FocusManager.
    if (root.focusManager) {
        let focusTarget = target;
        while (focusTarget) {
            if (typeof focusTarget.attributes['tabIndex'] === 'number') {
                root.focusManager.handleClickFocus(focusTarget);
                break;
            }
            focusTarget = focusTarget.parentNode;
        }
    }
    const event = new ClickEvent(col, row, cellIsBlank);
    let handled = false;
    while (target) {
        const handler = target._eventHandlers?.onClick;
        if (handler) {
            handled = true;
            const rect = nodeCache.get(target);
            if (rect) {
                event.localCol = col - rect.x;
                event.localRow = row - rect.y;
            }
            handler(event);
            if (event.didStopImmediatePropagation())
                return true;
        }
        target = target.parentNode;
    }
    return handled;
}
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
 */
export function dispatchHover(root, col, row, hovered) {
    const next = new Set();
    let node = hitTest(root, col, row) ?? undefined;
    while (node) {
        const h = node._eventHandlers;
        if (h?.onMouseEnter || h?.onMouseLeave)
            next.add(node);
        node = node.parentNode;
    }
    for (const old of hovered) {
        if (!next.has(old)) {
            hovered.delete(old);
            // Skip handlers on detached nodes (removed between mouse events)
            if (old.parentNode) {
                ;
                old._eventHandlers?.onMouseLeave?.();
            }
        }
    }
    for (const n of next) {
        if (!hovered.has(n)) {
            hovered.add(n);
            n._eventHandlers?.onMouseEnter?.();
        }
    }
}
//# sourceMappingURL=hit-test.js.map