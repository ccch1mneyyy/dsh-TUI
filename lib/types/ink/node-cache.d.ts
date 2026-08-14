import type { DOMElement } from './dom.js';
import type { Rectangle } from './layout/geometry.js';
/**
 * Cached layout bounds for each rendered node (used for blit + clearing).
 * `top` is the yoga-local getComputedTop() — stored so ScrollBox viewport
 * culling can skip yoga reads for clean children whose position hasn't
 * shifted (O(dirty) instead of O(mounted) first-pass).
 */
export type CachedLayout = {
    x: number;
    y: number;
    width: number;
    height: number;
    top?: number;
};
/** Layout bounds cached per rendered node, used for blitting and clearing. */
export declare const nodeCache: WeakMap<DOMElement, CachedLayout>;
/** Rects of removed children that need clearing on next render */
export declare const pendingClears: WeakMap<DOMElement, Rectangle[]>;
/**
 * Register a removed child's rect for clearing on the next render, and
 * flag the next frame when the removed node was absolutely positioned.
 * @param parent - the parent whose removed child rect to record.
 * @param rect - the removed child's last known bounds.
 * @param isAbsolute - whether the removed child was absolutely positioned; disables blit next frame.
 */
export declare function addPendingClear(parent: DOMElement, rect: Rectangle, isAbsolute: boolean): void;
/**
 * Read and clear the absolute-removal flag set by addPendingClear.
 * @returns whether an absolutely positioned node was removed since the last render.
 */
export declare function consumeAbsoluteRemovedFlag(): boolean;
//# sourceMappingURL=node-cache.d.ts.map