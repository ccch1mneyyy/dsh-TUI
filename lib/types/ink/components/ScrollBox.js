import { jsx as _jsx } from "react/jsx-runtime";
import { useImperativeHandle, useRef, useState } from 'react';
import { markScrollActivity } from '../../bootstrap/state.js';
import { markDirty, scheduleRenderFrom } from '../dom.js';
import { markCommitStart } from '../reconciler.js';
import Box from './Box.js';
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
function ScrollBox({ children, ref, stickyScroll, ...style }) {
    const domRef = useRef(null);
    // scrollTo/scrollBy bypass React: they mutate scrollTop on the DOM node,
    // mark it dirty, and call the root's throttled scheduleRender directly.
    // The Ink renderer reads scrollTop from the node — no React state needed,
    // no reconciler overhead per wheel event. The microtask defer coalesces
    // multiple scrollBy calls in one input batch (discreteUpdates) into one
    // render — otherwise scheduleRender's leading edge fires on the FIRST
    // event before subsequent events mutate scrollTop. scrollToBottom still
    // forces a React render: sticky is attribute-observed, no DOM-only path.
    const [, forceRender] = useState(0);
    const listenersRef = useRef(new Set());
    const renderQueuedRef = useRef(false);
    const notify = () => {
        for (const l of listenersRef.current)
            l();
    };
    function scrollMutated(el) {
        // Signal background intervals (IDE poll, LSP poll, GCS fetch, orphan
        // check) to skip their next tick — they compete for the event loop and
        // contributed to 1402ms max frame gaps during scroll drain.
        markScrollActivity();
        markDirty(el);
        markCommitStart();
        notify();
        if (renderQueuedRef.current)
            return;
        renderQueuedRef.current = true;
        queueMicrotask(() => {
            renderQueuedRef.current = false;
            scheduleRenderFrom(el);
        });
    }
    useImperativeHandle(ref, () => ({
        scrollTo(y) {
            const el = domRef.current;
            if (!el)
                return;
            // Explicit false overrides the DOM attribute so manual scroll
            // breaks stickiness. Render code checks ?? precedence.
            el.stickyScroll = false;
            el.pendingScrollDelta = undefined;
            el.scrollAnchor = undefined;
            el.scrollTop = Math.max(0, Math.floor(y));
            scrollMutated(el);
        },
        scrollToElement(el, offset = 0) {
            const box = domRef.current;
            if (!box)
                return;
            box.stickyScroll = false;
            box.pendingScrollDelta = undefined;
            box.scrollAnchor = {
                el,
                offset
            };
            scrollMutated(box);
        },
        scrollBy(dy) {
            const el = domRef.current;
            if (!el)
                return;
            el.stickyScroll = false;
            // Wheel input cancels any in-flight anchor seek — user override.
            el.scrollAnchor = undefined;
            // Accumulate in pendingScrollDelta; renderer drains it at a capped
            // rate so fast flicks show intermediate frames. Pure accumulator:
            // scroll-up followed by scroll-down naturally cancels.
            el.pendingScrollDelta = (el.pendingScrollDelta ?? 0) + Math.floor(dy);
            scrollMutated(el);
        },
        scrollToBottom() {
            const el = domRef.current;
            if (!el)
                return;
            el.pendingScrollDelta = undefined;
            el.stickyScroll = true;
            markDirty(el);
            notify();
            forceRender(n => n + 1);
        },
        getScrollTop() {
            return domRef.current?.scrollTop ?? 0;
        },
        getPendingDelta() {
            // Accumulated-but-not-yet-drained delta. useVirtualScroll needs
            // this to mount the union [committed, committed+pending] range —
            // otherwise intermediate drain frames find no children (blank).
            return domRef.current?.pendingScrollDelta ?? 0;
        },
        getScrollHeight() {
            return domRef.current?.scrollHeight ?? 0;
        },
        getFreshScrollHeight() {
            const content = domRef.current?.childNodes[0];
            return content?.yogaNode?.getComputedHeight() ?? domRef.current?.scrollHeight ?? 0;
        },
        getViewportHeight() {
            return domRef.current?.scrollViewportHeight ?? 0;
        },
        getViewportTop() {
            return domRef.current?.scrollViewportTop ?? 0;
        },
        isSticky() {
            const el = domRef.current;
            if (!el)
                return false;
            return el.stickyScroll ?? Boolean(el.attributes['stickyScroll']);
        },
        subscribe(listener) {
            listenersRef.current.add(listener);
            return () => listenersRef.current.delete(listener);
        },
        setClampBounds(min, max) {
            const el = domRef.current;
            if (!el)
                return;
            el.scrollClampMin = min;
            el.scrollClampMax = max;
        }
    }), 
    // notify/scrollMutated are inline (no useCallback) but only close over
    // refs + imports — stable. Empty deps avoids rebuilding the handle on
    // every render (which re-registers the ref = churn).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);
    // Structure: outer viewport (overflow:scroll, constrained height) >
    // inner content (flexGrow:1, flexShrink:0 — fills at least the viewport
    // but grows beyond it for tall content). flexGrow:1 lets children use
    // spacers to pin elements to the bottom of the scroll area. Yoga's
    // Overflow.Scroll prevents the viewport from growing to fit the content.
    // The renderer computes scrollHeight from the content box and culls
    // content's children based on scrollTop.
    //
    // stickyScroll is passed as a DOM attribute (via ink-box directly) so it's
    // available on the first render — ref callbacks fire after the initial
    // commit, which is too late for the first frame.
    return _jsx("ink-box", { ref: el => {
            domRef.current = el;
            if (el) {
                el.scrollTop ??= 0;
                // Renderer-side sticky restores (positional re-pin at the bottom)
                // must reach React subscribers too — see dom.ts onStickyRestore.
                el.onStickyRestore = notify;
            }
        }, style: {
            flexWrap: 'nowrap',
            flexDirection: style.flexDirection ?? 'row',
            flexGrow: style.flexGrow ?? 0,
            flexShrink: style.flexShrink ?? 1,
            ...style,
            overflowX: 'scroll',
            overflowY: 'scroll'
        }, ...stickyScroll ? {
            stickyScroll: true
        } : {}, children: _jsx(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 0, width: "100%", children: children }) });
}
export default ScrollBox;
