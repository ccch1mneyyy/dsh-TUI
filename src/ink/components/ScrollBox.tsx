import React, { type PropsWithChildren, type Ref, useCallback, useImperativeHandle, useRef, useState } from 'react';
import type { Except } from 'type-fest';
import { FRAME_INTERVAL_MS } from '../constants.js';
import { markScrollActivity } from '../../bootstrap/state.js';
import type { DOMElement } from '../dom.js';
import { markDirty, scheduleRenderFrom } from '../dom.js';
import { noteFrameCause } from '../geometry-trace.js';
import { markCommitStart } from '../reconciler.js';
import { swallowNestedUpdateOverflow } from '../update-overflow-guard.js';
import type { WheelEvent } from '../events/wheel-event.js';
import type { Styles } from '../styles.js';
import Box from './Box.js';
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
function ScrollBox({
  children,
  ref,
  stickyScroll,
  ...style
}: PropsWithChildren<ScrollBoxProps>): React.ReactNode {
  const domRef = useRef<DOMElement>(null);
  // scrollTo/scrollBy bypass React: they mutate scrollTop on the DOM node,
  // mark it dirty, and call the root's throttled scheduleRender directly.
  // The Ink renderer reads scrollTop from the node — no React state needed,
  // no reconciler overhead per wheel event. The microtask defer coalesces
  // multiple scrollBy calls in one input batch (discreteUpdates) into one
  // render — otherwise scheduleRender's leading edge fires on the FIRST
  // event before subsequent events mutate scrollTop. scrollToBottom still
  // forces a React render: sticky is attribute-observed, no DOM-only path.
  const [, forceRender] = useState(0);
  const listenersRef = useRef(new Set<() => void>());
  const renderQueuedRef = useRef(false);
  // The imperative handle, kept in a ref so the onWheel handler below can
  // call scrollBy through the full public path (clamp bounds, sticky
  // clearing, subscriber notify) instead of duplicating its logic.
  const handleRef = useRef<ScrollBoxHandle | null>(null);
  const notify = () => {
    // #185 self-heal: scroll subscribers drive React state (setScrollTick);
    // a thrown overflow here resets React's nested counter — absorb it.
    for (const l of listenersRef.current) {
      try {
        l();
      } catch (error) {
        if (!swallowNestedUpdateOverflow(error, 'scrollbox.notify')) throw error;
      }
    }
  };
  // Input-edge intent coalescing (Qwen Code's 16ms wheel merge, Crush's
  // pre-queue filter): subscribers drive React state (MessageList's mount
  // window, Chat's sticky flag, the timeline rail), so notifying per wheel
  // EVENT runs a full React commit per event — a fast flick is 10-30
  // events, each re-running the offsets/window/timeline loops on a big
  // session. The scrollTop mutation and the ink render are already
  // frame-throttled; this aligns the React commits to the same frame
  // budget. Both edges defer to a microtask: the remaining input events of
  // the same stdin batch then land BEFORE any commit, and one commit
  // covers the whole batch (the sync leading edge used to run a full
  // commit inside the wheel dispatch itself — pure input latency).
  const notifyQueuedRef = useRef(false);
  const lastNotifyAtRef = useRef(-Infinity);
  const notifyCoalesced = () => {
    const since = performance.now() - lastNotifyAtRef.current;
    if (!notifyQueuedRef.current && since >= FRAME_INTERVAL_MS) {
      notifyQueuedRef.current = true;
      lastNotifyAtRef.current = performance.now();
      queueMicrotask(() => {
        notifyQueuedRef.current = false;
        notify();
      });
      return;
    }
    if (notifyQueuedRef.current) return;
    notifyQueuedRef.current = true;
    setTimeout(() => {
      notifyQueuedRef.current = false;
      lastNotifyAtRef.current = performance.now();
      notify();
    }, Math.max(0, FRAME_INTERVAL_MS - since));
  };
  function scrollMutated(el: DOMElement): void {
    // Signal background intervals (IDE poll, LSP poll, GCS fetch, orphan
    // check) to skip their next tick — they compete for the event loop and
    // contributed to 1402ms max frame gaps during scroll drain.
    markScrollActivity();
    noteFrameCause('scroll');
    markDirty(el);
    markCommitStart();
    notifyCoalesced();
    if (renderQueuedRef.current) return;
    renderQueuedRef.current = true;
    queueMicrotask(() => {
      renderQueuedRef.current = false;
      scheduleRenderFrom(el);
    });
  }
  useImperativeHandle(ref, (): ScrollBoxHandle => {
    const handle: ScrollBoxHandle = {
    scrollTo(y: number) {
      const el = domRef.current;
      if (!el) return;
      // Explicit false overrides the DOM attribute so manual scroll
      // breaks stickiness. Render code checks ?? precedence.
      el.stickyScroll = false;
      el.pendingScrollDelta = undefined;
      el.scrollAnchor = undefined;
      el.scrollTop = Math.max(0, Math.floor(y));
      scrollMutated(el);
    },
    scrollToElement(el: DOMElement, offset = 0) {
      const box = domRef.current;
      if (!box) return;
      box.stickyScroll = false;
      box.pendingScrollDelta = undefined;
      box.scrollAnchor = {
        el,
        offset
      };
      scrollMutated(box);
    },
    scrollBy(dy: number) {
      const el = domRef.current;
      if (!el) return;
      const dyFloor = Math.floor(dy);
      // Wheel-down / scroll-down while the view is already AT the bottom is
      // pure overscroll: nothing left to reveal. Ignore it entirely — no
      // sticky clear, no pending delta, no dirty mark, no subscriber
      // notify. The old path ran every notch through sticky-break → drain →
      // re-pin, which (with streaming content) flip-flopped the sticky flag
      // frame by frame, remounted the virtualization window (isSticky is
      // React state), flashed the "↓ back to bottom" pill while the user
      // WAS at the bottom, let the drain overshoot past maxScroll on
      // measure frames, and repainted the transcript per notch (flicker).
      // Gate:
      //  - sticky === true: the renderer keeps scrollTop pinned at
      //    maxScroll each frame — a wheel-down must never unpin it
      //    (leaving the bottom is wheel-UP's job).
      //  - else positionally at the bottom or past it (a shrink-frozen
      //    scrollTop can sit above the cached maxScroll): scrollTop >=
      //    maxScroll with no in-flight scroll-UP (pending >= 0).
      //    pending < 0 means an earlier wheel-up hasn't drained yet: a
      //    down-notch must land so the accumulator cancels (scroll-up
      //    followed by scroll-down naturally cancels — see the
      //    accumulation comment below).
      //  - Notches from ABOVE (scrollTop < maxScroll) are NOT gated —
      //    including the landing notch that would finish the final row:
      //    ±1-row callers (panel ↑/↓ keys) and scrollTo/seek landings can
      //    rest at maxScroll - 1, and gating there would leave the last
      //    row unreachable and never trigger the renderer's at-bottom
      //    re-pin (which requires scrollTop >= maxScroll). The landing
      //    notch drains to the bottom and the re-pin restores sticky /
      //    clears the new-messages pill on that frame. No epsilon is
      //    needed — the whole chain is integer rows.
      if (dyFloor > 0) {
        const sticky = el.stickyScroll ?? Boolean(el.attributes['stickyScroll']);
        const pending = el.pendingScrollDelta ?? 0;
        const maxScroll = Math.max(
          0,
          (el.scrollHeight ?? 0) - (el.scrollViewportHeight ?? 0),
        );
        if (sticky || ((el.scrollTop ?? 0) >= maxScroll && pending >= 0)) {
          return;
        }
      }
      el.stickyScroll = false;
      // Wheel input cancels any in-flight anchor seek — user override.
      el.scrollAnchor = undefined;
      // Accumulate in pendingScrollDelta; renderer drains it at a capped
      // rate so fast flicks show intermediate frames. Pure accumulator:
      // scroll-up followed by scroll-down naturally cancels.
      el.pendingScrollDelta = (el.pendingScrollDelta ?? 0) + dyFloor;
      scrollMutated(el);
    },
    scrollToBottom() {
      const el = domRef.current;
      if (!el) return;
      el.scrollAnchor = undefined;
      const viewportH = el.scrollViewportHeight ?? 0;
      const maxScroll = Math.max(0, (el.scrollHeight ?? 0) - viewportH);
      const distance = maxScroll - (el.scrollTop ?? 0);
      if (distance > viewportH && viewportH > 0) {
        // FAR jump: drain instead of teleport. The viewport would land on
        // rows that were never mounted — their spacer heights are
        // DEFAULT_ROW_HEIGHT estimates, so the topPad swallows the view
        // (blank transcript) AND it is a fixed point: unmounted rows never
        // measure, nothing retried until the next wheel event. The drain
        // walks the exact wheel path instead: proportional steps, the
        // virtualization window follows per commit (it mounts the union of
        // committed + pending), the visual clamp pins to the mounted edge
        // while rows measure as they enter — no blank at any distance. The
        // renderer's at-bottom re-pin restores sticky when it lands
        // (stickyScroll=false + pending undefined + scrollTop >= maxScroll).
        el.stickyScroll = false;
        el.pendingScrollDelta = (el.pendingScrollDelta ?? 0) + distance;
        scrollMutated(el);
        return;
      }
      el.pendingScrollDelta = undefined;
      el.stickyScroll = true;
      // DOM-direct pre-write of the target (near jumps only): the notify
      // below triggers MessageList's window recompute, and its React commit
      // must read the NEW scrollTop — the old order (notify first, renderer
      // moves scrollTop later) left the window one commit behind. The
      // renderer's sticky branch re-pins scrollTop to the exact fresh
      // maxScroll next frame, so a stale cached height costs one frame.
      el.scrollTop = maxScroll;
      scrollMutated(el);
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
      const content = domRef.current?.childNodes[0] as DOMElement | undefined;
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
      if (!el) return false;
      return el.stickyScroll ?? Boolean(el.attributes['stickyScroll']);
    },
    subscribe(listener: () => void) {
      listenersRef.current.add(listener);
      return () => listenersRef.current.delete(listener);
    },
    setClampBounds(min, max) {
      const el = domRef.current;
      if (!el) return;
      el.scrollClampMin = min;
      el.scrollClampMax = max;
    }
  };
  handleRef.current = handle;
  return handle;
  },
  // notify/scrollMutated are inline (no useCallback) but only close over
  // refs + imports — stable. Empty deps avoids rebuilding the handle on
  // every render (which re-registers the ref = churn).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);

  // Position-routed wheel events (pointer over this box) scroll THIS box
  // through the public scrollBy path — clamp bounds, sticky clearing, and
  // subscriber notify all apply. Horizontal wheel (deltaX) has no renderer
  // support yet (no scrollLeft in the DOM model) and is ignored.
  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.deltaY !== 0) handleRef.current?.scrollBy(e.deltaY);
  }, []);

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
  return <ink-box ref={el => {
    domRef.current = el;
    if (el) {
      el.scrollTop ??= 0;
      // Renderer-side sticky restores (positional re-pin at the bottom)
      // must reach React subscribers too — see dom.ts onStickyRestore.
      el.onStickyRestore = notify;
    }
  }} onWheel={handleWheel} style={{
    flexWrap: 'nowrap',
    flexDirection: style.flexDirection ?? 'row',
    flexGrow: style.flexGrow ?? 0,
    flexShrink: style.flexShrink ?? 1,
    ...style,
    overflowX: 'scroll',
    overflowY: 'scroll'
  }} {...stickyScroll ? {
    stickyScroll: true
  } : {}}>
      <Box flexDirection="column" flexGrow={1} flexShrink={0} width="100%">
        {children}
      </Box>
    </ink-box>;
}
export default ScrollBox;
