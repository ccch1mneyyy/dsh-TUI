import React, { type PropsWithChildren, type Ref } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { Styles } from '../styles.js';
export type ScrollBoxHandle = {
    scrollTo: (y: number) => void;
    scrollBy: (dy: number) => void;
    /**
     * Scroll so `el`'s top is at the viewport top (plus `offset`). Unlike
     * scrollTo which bakes a number that's stale by the time the throttled
     * render fires, this defers the position read to render time —
     * render-node-to-output reads `el.yogaNode.getComputedTop()` in the
     * SAME Yoga pass that computes scrollHeight. Deterministic. One-shot.
     */
    scrollToElement: (el: DOMElement, offset?: number) => void;
    scrollToBottom: () => void;
    getScrollTop: () => number;
    getPendingDelta: () => number;
    getScrollHeight: () => number;
    /**
     * Like getScrollHeight, but reads Yoga directly instead of the cached
     * value written by render-node-to-output (throttled, up to 16ms stale).
     * Use when you need a fresh value in useLayoutEffect after a React commit
     * that grew content. Slightly more expensive (native Yoga call).
     */
    getFreshScrollHeight: () => number;
    getViewportHeight: () => number;
    /**
     * Absolute screen-buffer row of the first visible content line (inside
     * padding). Used for drag-to-scroll edge detection.
     */
    getViewportTop: () => number;
    /**
     * True when scroll is pinned to the bottom. Set by scrollToBottom, the
     * initial stickyScroll attribute, and by the renderer when positional
     * follow fires (scrollTop at prevMax, content grows). Cleared by
     * scrollTo/scrollBy. Stable signal for "at bottom" that doesn't depend on
     * layout values (unlike scrollTop+viewportH >= scrollHeight).
     */
    isSticky: () => boolean;
    /**
     * Subscribe to imperative scroll changes (scrollTo/scrollBy/scrollToBottom).
     * Does NOT fire for stickyScroll updates done by the Ink renderer — those
     * happen during Ink's render phase after React has committed. Callers that
     * care about the sticky case should treat "at bottom" as a fallback.
     */
    subscribe: (listener: () => void) => () => void;
    /**
     * Set the render-time scrollTop clamp to the currently-mounted children's
     * coverage span. Called by useVirtualScroll after computing its range;
     * render-node-to-output clamps scrollTop to [min, max] so burst scrollTo
     * calls that race past React's async re-render show the edge of mounted
     * content instead of blank spacer. Pass undefined to disable (sticky,
     * cold start).
     */
    setClampBounds: (min: number | undefined, max: number | undefined) => void;
};
export type ScrollBoxProps = Except<Styles, 'textWrap' | 'overflow' | 'overflowX' | 'overflowY'> & {
    ref?: Ref<ScrollBoxHandle>;
    /**
     * When true, automatically pins scroll position to the bottom when content
     * grows. Unset manually via scrollTo/scrollBy to break the stickiness.
     */
    stickyScroll?: boolean;
};
/**
 * A Box with `overflow: scroll` and an imperative scroll API.
 *
 * Children are laid out at their full Yoga-computed height inside a
 * constrained container. At render time, only children intersecting the
 * visible window (scrollTop..scrollTop+height) are rendered (viewport
 * culling). Content is translated by -scrollTop and clipped to the box bounds.
 *
 * Works best inside a fullscreen (constrained-height root) Ink tree.
 */
declare function ScrollBox({ children, ref, stickyScroll, ...style }: PropsWithChildren<ScrollBoxProps>): React.ReactNode;
export default ScrollBox;
//# sourceMappingURL=ScrollBox.d.ts.map