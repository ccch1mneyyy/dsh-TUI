/** Layout bounds cached per rendered node, used for blitting and clearing. */
export const nodeCache = new WeakMap();
/** Rects of removed children that need clearing on next render */
export const pendingClears = new WeakMap();
/**
 * Set when a pendingClear is added for an absolute-positioned node.
 * Signals renderer to disable blit for the next frame: the removed node
 * may have painted over non-siblings (e.g. an overlay over a ScrollBox
 * earlier in tree order), so their blits from prevScreen would restore
 * the overlay's pixels. Normal-flow removals are already handled by
 * hasRemovedChild at the parent level; only absolute positioning paints
 * cross-subtree. Reset at the start of each render.
 */
let absoluteNodeRemoved = false;
/**
 * Register a removed child's rect for clearing on the next render, and
 * flag the next frame when the removed node was absolutely positioned.
 * @param parent - the parent whose removed child rect to record.
 * @param rect - the removed child's last known bounds.
 * @param isAbsolute - whether the removed child was absolutely positioned; disables blit next frame.
 */
export function addPendingClear(parent, rect, isAbsolute) {
    const existing = pendingClears.get(parent);
    if (existing) {
        existing.push(rect);
    }
    else {
        pendingClears.set(parent, [rect]);
    }
    if (isAbsolute) {
        absoluteNodeRemoved = true;
    }
}
/**
 * Read and clear the absolute-removal flag set by addPendingClear.
 * @returns whether an absolutely positioned node was removed since the last render.
 */
export function consumeAbsoluteRemovedFlag() {
    const had = absoluteNodeRemoved;
    absoluteNodeRemoved = false;
    return had;
}
