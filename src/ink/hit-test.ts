import type { DOMElement } from './dom.js'
import { ClickEvent } from './events/click-event.js'
import { ContextMenuEvent } from './events/context-menu-event.js'
import type { DragEvent } from './events/drag-event.js'
import type { EventHandlerProps } from './events/event-handlers.js'
import { PointerEvent } from './events/pointer-event.js'
import { WheelEvent } from './events/wheel-event.js'
import { logError } from '../utils/log.js'
import { nodeCache } from './node-cache.js'
import { getAbsoluteHitList } from './render-node-to-output.js'
import { dispatcher } from './reconciler.js'

/**
 * Find the deepest DOM element whose rendered rect contains (col, row).
 *
 * Uses the nodeCache populated by renderNodeToOutput — rects are in screen
 * coordinates with all offsets (including scrollTop translation) already
 * applied. Children are traversed in reverse so later siblings (painted on
 * top) win. Nodes not in nodeCache (not rendered this frame, or lacking a
 * yogaNode) are skipped along with their subtrees.
 *
 * Ancestor containment is NOT required: an unclipped node's children can
 * paint (and receive hits) outside the parent's rect — negative margins
 * (the PageMargin bleed row: the transcript gutter rail sits at the
 * terminal edge while its ancestors end at the content column) and plain
 * overflow. Pruning at such a node would leave the overflow region dead to
 * the mouse. Only clipped nodes (overflow hidden/scroll) confine their
 * subtree and prune. Each node still gates on its OWN rect, so the walk
 * stays cheap whenever the point falls inside a clipped subtree (the
 * transcript ScrollBox prunes everything below it).
 *
 * Returns the hit node even if it has no onClick — dispatchClick walks up
 * via parentNode to find handlers.
 * @param node - the subtree root to test.
 * @param col - the screen column to test.
 * @param row - the screen row to test.
 * @returns the deepest element whose rect contains (col, row), or null.
 */
export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  const rect = nodeCache.get(node)
  if (!rect) return null
  const inside =
    col >= rect.x &&
    col < rect.x + rect.width &&
    row >= rect.y &&
    row < rect.y + rect.height
  if (!inside) {
    const style = node.style
    const overflowX = style.overflowX ?? style.overflow
    const overflowY = style.overflowY ?? style.overflow
    const clipped =
      overflowX === 'hidden' ||
      overflowX === 'scroll' ||
      overflowY === 'hidden' ||
      overflowY === 'scroll'
    // Clipped nodes confine their subtree: no child can sit at a point
    // outside the clip. Unclipped nodes do not — descend anyway and let
    // each child's own rect decide (see the overflow note above).
    if (clipped) return null
  }
  // Later siblings paint on top; reversed traversal returns topmost hit.
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const hit = hitTest(child, col, row)
    if (hit) return hit
  }
  return inside ? node : null
}

// Full-tree hit-test call counter. Regression tests (verify-hover-coalesce)
// reset it and assert the no-interest fast path actually skips work. Benign
// in production — a monotonic counter, never read on hot paths.
let hitTestWithOverlaysCount = 0

/**
 * Number of hitTestWithOverlays calls since the last reset (or module load).
 * @returns the call count.
 */
export function getHitTestWithOverlaysCount(): number {
  return hitTestWithOverlaysCount
}

/** Reset the hitTestWithOverlays call counter (test instrumentation). */
export function resetHitTestWithOverlaysCount(): void {
  hitTestWithOverlaysCount = 0
}

/**
 * hitTest, but overlay-aware: absolute-positioned nodes can paint OUTSIDE
 * every ancestor's rect (OverlayAbove's `bottom:'100%'` pickers float over
 * the transcript), so the plain containment recursion never reaches them —
 * a click on the picker lands in the ScrollBox's rows instead. Check the
 * frame's absolute hit list FIRST, in reverse paint order (later = visually
 * on top), then fall back to the in-flow tree.
 * @param root - the tree root for the in-flow fallback.
 * @param col - the screen column to test.
 * @param row - the screen row to test.
 * @returns the deepest element at (col, row), or null.
 */
export function hitTestWithOverlays(
  root: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  hitTestWithOverlaysCount++
  const overlays = getAbsoluteHitList()
  for (let i = overlays.length - 1; i >= 0; i--) {
    const { node, rect } = overlays[i]!
    if (
      col >= rect.x &&
      col < rect.x + rect.width &&
      row >= rect.y &&
      row < rect.y + rect.height
    ) {
      // hitTest re-checks containment via nodeCache and descends normally;
      // nested absolutes deeper inside are themselves in the list and were
      // already offered (later paint order) above.
      const hit = hitTest(node, col, row)
      if (hit) return hit
    }
  }
  return hitTest(root, col, row)
}

/**
 * Hit-test the root at (col, row) and bubble a ClickEvent from the deepest
 * containing node up through parentNode. Only nodes with an onClick handler
 * fire. Stops when a handler calls stopImmediatePropagation(). Returns
 * true if at least one onClick handler fired.
 *
 * Each handler call is isolated: a throwing handler is logged and the
 * bubbling continues, so one broken onClick cannot swallow the click from
 * its ancestors or the rest of the input batch.
 *
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the click.
 * @param row - the screen row of the click.
 * @param cellIsBlank - whether the clicked cell is blank, reported on the event.
 * @param button - raw SGR release byte (carries shift/alt/ctrl modifier bits).
 * @returns true when at least one onClick handler fired.
 */
export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
  button = 0,
): boolean {
  let target: DOMElement | undefined =
    hitTestWithOverlays(root, col, row) ?? undefined
  if (!target) return false

  // Click-to-focus: find the closest focusable ancestor and focus it.
  // root is always ink-root, which owns the FocusManager.
  if (root.focusManager) {
    let focusTarget: DOMElement | undefined = target
    while (focusTarget) {
      if (typeof focusTarget.attributes['tabIndex'] === 'number') {
        root.focusManager.handleClickFocus(focusTarget)
        break
      }
      focusTarget = focusTarget.parentNode
    }
  }
  const event = new ClickEvent(col, row, cellIsBlank, { button })
  let handled = false
  while (target) {
    const handler = target._eventHandlers?.onClick as
      | ((event: ClickEvent) => void)
      | undefined
    if (handler) {
      handled = true
      const rect = nodeCache.get(target)
      if (rect) {
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      } else {
        event.localCol = 0
        event.localRow = 0
      }
      try {
        handler(event)
      } catch (error) {
        logError(error)
      }
      if (event.didStopImmediatePropagation()) return true
    }
    target = target.parentNode
  }
  return handled
}

/**
 * Hit-test the root at (col, row) and bubble a ContextMenuEvent from the
 * deepest containing node up through parentNode. Only nodes with an
 * onContextMenu handler fire. Stops when a handler calls
 * stopImmediatePropagation(). Returns true if at least one onContextMenu
 * handler fired.
 *
 * Unlike dispatchClick this does NOT move focus: the menu is a press-time
 * affordance and the target's own handler decides whether focus follows.
 * Handler isolation matches dispatchClick — a throwing handler is logged
 * and the bubbling continues.
 *
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the press.
 * @param row - the screen row of the press.
 * @param button - raw SGR press byte (low bits 2 = right button, carries
 *   shift/alt/ctrl modifier bits).
 * @returns true when at least one onContextMenu handler fired.
 */
export function dispatchContextMenu(
  root: DOMElement,
  col: number,
  row: number,
  button = 0,
): boolean {
  const target = hitTestWithOverlays(root, col, row)
  if (!target) return false
  const event = new ContextMenuEvent(col, row, { button })
  let node: DOMElement | undefined = target
  let handled = false
  while (node) {
    const handler = node._eventHandlers?.onContextMenu as
      | ((event: ContextMenuEvent) => void)
      | undefined
    if (handler) {
      handled = true
      const rect = nodeCache.get(node)
      if (rect) {
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      } else {
        event.localCol = 0
        event.localRow = 0
      }
      try {
        handler(event)
      } catch (error) {
        logError(error)
      }
      if (event.didStopImmediatePropagation()) return true
    }
    node = node.parentNode
  }
  return handled
}

/**
 * Find the drag target at (col, row): hit-test the root (overlay-aware,
 * like dispatchClick), then walk the ancestor chain from the deepest hit
 * node and return the FIRST node carrying an onDragStart handler. That
 * node is captured as the drag session target — subsequent dragmove/
 * dragend events bubble from it even when the pointer leaves its rect.
 *
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the press.
 * @param row - the screen row of the press.
 * @returns the deepest node with an onDragStart handler, or null when no
 *   ancestor of the hit node is a drag target.
 */
export function findDragTarget(
  root: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  let node: DOMElement | undefined =
    hitTestWithOverlays(root, col, row) ?? undefined
  while (node) {
    if (node._eventHandlers?.onDragStart) return node
    node = node.parentNode
  }
  return null
}

/**
 * Bubble a drag event (dragstart/dragmove/dragend) from the captured
 * drag session target up through parentNode. The handler prop is looked
 * up per event type (onDragStart/onDragMove/onDragEnd). Stops when a
 * handler calls stopImmediatePropagation(). Handler isolation matches
 * dispatchClick — a throwing handler is logged and the bubbling
 * continues.
 *
 * Unlike dispatchClick the target comes from the drag session captured
 * at press time, NOT a fresh hit-test: like DOM element capture, the
 * drag source keeps receiving events for the whole gesture.
 *
 * @param target - the captured drag session target node.
 * @param event - the drag event to dispatch.
 */
export function dispatchDragEvent(
  target: DOMElement,
  event: DragEvent,
): void {
  // Use the shared dispatcher so target/currentTarget/eventPhase,
  // stopPropagation, exception isolation, and React update priority match the
  // rest of the terminal event model. Motion is continuous; lifecycle edges
  // are discrete user actions.
  if (event.type === 'dragmove') dispatcher.dispatchContinuous(target, event)
  else dispatcher.dispatchDiscrete(target, event)
}

/**
 * Fire onMouseLeave on every tracked hover node, then empty the set.
 *
 * The pointer-state resets (alt-screen swap, terminal resize) drop the hover
 * set because the geometry it was computed against is gone. But the React
 * components behind those nodes still hold their `hovered=true` state: a bare
 * `set.clear()` never tells them the pointer "left", so every row crossed
 * before the reset keeps its highlight forever — the next motion event only
 * fires enter on the new row (the old nodes are no longer in the set, so no
 * diff ever produces their leave). Firing leave first is what makes the
 * reset invisible to the rows.
 *
 * @param hovered - the tracked hover set; emptied in place.
 * @param col - pointer column for the synthetic leave events (-1 = unknown).
 * @param row - pointer row for the synthetic leave events.
 */
export function clearHovered(
  hovered: Set<DOMElement>,
  col = -1,
  row = -1,
): void {
  for (const node of hovered) {
    hovered.delete(node)
    // Detached nodes (screen already swapped out from under us) can no
    // longer re-render — skip them; their component state dies with the
    // subtree anyway.
    if (!node.parentNode) continue
    const handler = (node._eventHandlers as EventHandlerProps | undefined)
      ?.onMouseLeave
    if (handler) {
      try {
        handler(new PointerEvent('hover', col, row, { action: 'move' }))
      } catch (error) {
        logError(error)
      }
    }
  }
}

/**
 * Route a wheel event to the ScrollBox (or any onWheel handler) under the
 * pointer. Dispatches through the shared Dispatcher at continuous priority
 * so the event bubbles from the deepest hit node and React schedules any
 * state updates at the right lane.
 *
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the wheel event.
 * @param row - the screen row of the wheel event.
 * @param deltaY - rows to scroll (positive = scroll down).
 * @param deltaX - columns to scroll (positive = right; informational).
 * @param button - raw SGR byte (carries modifier bits).
 * @returns true when an onWheel handler existed under the pointer.
 */
export function dispatchWheel(
  root: DOMElement,
  col: number,
  row: number,
  deltaY: number,
  deltaX = 0,
  button = 0,
): boolean {
  const target = hitTestWithOverlays(root, col, row)
  if (!target) return false
  // Does any ancestor (target inclusive) carry an onWheel handler?
  let node: DOMElement | undefined = target
  let hasHandler = false
  while (node && !hasHandler) {
    hasHandler = Boolean(node._eventHandlers?.onWheel)
    node = node.parentNode
  }
  if (!hasHandler) return false
  const event = new WheelEvent(col, row, deltaY, deltaX, { button })
  dispatcher.dispatchContinuous(target, event)
  return true
}

// ── No-interest rect fast path (hover perf) ─────────────────────────
// When a hover hit confirms that its ancestor chain is inert and the hit is
// a leaf region with no overlapping interested sibling/absolute layer, that
// node's rect is cached here.
// Subsequent motion events inside the rect skip the full-tree hit-test:
// hover is a state diff and an inert region cannot produce enter/leave, so
// the result is identical while the rect is valid. The cache is STRICTLY
// per-frame: invalidateNoInterestRect() runs at every React commit
// (ink.tsx onComputeLayout — handlers attach/detach during re-renders) and
// at the top of every render pass (renderer.ts — scroll drains and other
// geometry changes without commits). Pointer-state resets (resize,
// alt-screen swap) invalidate it too. A point outside the rect re-enters
// the normal hit-test immediately, so leaving the region can never miss a
// handler.
type NoInterestRect = { x: number; y: number; width: number; height: number }
// Per-root: multiple Ink instances can coexist in tests/embedders and must
// never reuse geometry from another tree.
let noInterestRects = new WeakMap<DOMElement, NoInterestRect>()

/**
 * Optional hover-interest probe consulted when deciding whether a region is
 * hover-inert. A tooltip system registers a predicate here so tooltip-
 * bearing nodes are never skipped by the no-interest fast path. Null (the
 * default) means only React enter/leave handlers count.
 */
let hoverInterestProbe: ((node: DOMElement) => boolean) | null = null

/**
 * Install or clear the hover-interest probe.
 * @param probe - the interest predicate, or null to clear it.
 */
export function setHoverInterestProbe(
  probe: ((node: DOMElement) => boolean) | null,
): void {
  hoverInterestProbe = probe
}

/**
 * Drop the cached no-interest rect. Call at every render commit and at the
 * start of every render pass (see the cache doc above); also call from
 * pointer-state resets. Idempotent and effectively free.
 */
export function invalidateNoInterestRect(): void {
  noInterestRects = new WeakMap()
}

/** Whether a node participates in hover semantics (handler or tooltip probe). */
function hasHoverInterest(node: DOMElement): boolean {
  const h = node._eventHandlers as EventHandlerProps | undefined
  if (h?.onMouseEnter || h?.onMouseLeave) return true
  return hoverInterestProbe?.(node) === true
}

/**
 * Fail-fast subtree scan for an overlapping sibling/absolute candidate.
 * Text children are skipped like hitTest does.
 */
function subtreeHasHoverInterest(node: DOMElement): boolean {
  for (const childNode of node.childNodes) {
    if (childNode.nodeName === '#text') continue
    const child = childNode as DOMElement
    if (hasHoverInterest(child) || subtreeHasHoverInterest(child)) return true
  }
  return false
}

function hasElementChildren(node: DOMElement): boolean {
  return node.childNodes.some(child => child.nodeName !== '#text')
}

function rectsOverlap(left: NoInterestRect, right: NoInterestRect): boolean {
  return !(
    right.x >= left.x + left.width ||
    right.x + right.width <= left.x ||
    right.y >= left.y + left.height ||
    right.y + right.height <= left.y
  )
}

/** Whether a hover-interested in-flow sibling can win inside the candidate. */
function overlappingSiblingHasHoverInterest(hit: DOMElement, rect: NoInterestRect): boolean {
  let branch: DOMElement = hit
  for (let parent = hit.parentNode; parent; parent = parent.parentNode) {
    for (const siblingNode of parent.childNodes) {
      if (siblingNode === branch || siblingNode.nodeName === '#text') continue
      const sibling = siblingNode as DOMElement
      const siblingRect = nodeCache.get(sibling)
      if (
        siblingRect &&
        rectsOverlap(rect, siblingRect) &&
        (hasHoverInterest(sibling) || subtreeHasHoverInterest(sibling))
      ) {
        return true
      }
    }
    branch = parent
  }
  return false
}

/** Whether a hover-interested absolute layer overlaps a candidate inert rect. */
function overlappingAbsoluteHasHoverInterest(rect: NoInterestRect): boolean {
  for (const entry of getAbsoluteHitList()) {
    const overlay = entry.rect
    if (!rectsOverlap(rect, overlay)) continue
    if (subtreeHasHoverInterest(entry.node)) return true
    for (let node: DOMElement | undefined = entry.node; node; node = node.parentNode) {
      if (hasHoverInterest(node)) return true
    }
  }
  return false
}

/**
 * Fire onMouseEnter/onMouseLeave as the pointer moves. Like DOM
 * mouseenter/mouseleave: does NOT bubble — moving between children does
 * not re-fire on the parent. Walks up from the hit node collecting every
 * ancestor with a hover handler; diffs against the previous hovered set;
 * fires leave on the nodes exited, enter on the nodes entered.
 *
 * Handlers receive a PointerEvent ('hover') with the pointer position;
 * existing `() => void` handlers simply ignore the argument. Each call is
 * isolated so one throwing handler cannot break the rest of the diff.
 *
 * Mutates `hovered` in place so the caller (App instance) can hold it
 * across calls. Clears the set when the hit is null (cursor moved into a
 * non-rendered gap or off the root rect).
 * @param root - the tree root to hit-test.
 * @param col - the screen column of the pointer.
 * @param row - the screen row of the pointer.
 * @param hovered - the previously hovered element set; updated in place.
 */
export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
): void {
  const next = new Set<DOMElement>()
  const cached = noInterestRects.get(root)
  if (
    cached &&
    col >= cached.x &&
    col < cached.x + cached.width &&
    row >= cached.y &&
    row < cached.y + cached.height
  ) {
    // Pointer still inside the last confirmed hover-inert rect: skip the
    // full-tree hit-test. `next` stays empty — exactly what a real
    // hit-test would produce while the rect is valid (the handler topology
    // is frozen between commits and every commit/frame invalidates the
    // cache). The diff below still runs, firing any pending leaves
    // defensively (hovered is empty here by construction — the rect is
    // only cached right after the diff emptied it).
  } else {
    let hit: DOMElement | undefined =
      hitTestWithOverlays(root, col, row) ?? undefined
    // Chain walk collects the enter/leave set AND decides cache
    // eligibility: the rect is only trusted when no node in the hit chain
    // has any hover interest.
    let chainInert = true
    for (let node = hit; node; node = node.parentNode) {
      const h = node._eventHandlers as EventHandlerProps | undefined
      if (h?.onMouseEnter || h?.onMouseLeave) {
        next.add(node)
        chainInert = false
      } else if (hasHoverInterest(node)) {
        // Tooltip interest without enter/leave handlers: keeps the region
        // out of the no-interest cache without joining the hovered set.
        chainInert = false
      }
    }
    if (chainInert && hit) {
      const rect = nodeCache.get(hit)
      // Cache only a leaf hit region. An empty container with element
      // descendants may cover a huge area; recursively scanning that subtree
      // on every motion is O(tree), while caching it can hide a descendant.
      // Overlapping interested siblings/absolute layers also disqualify the
      // rect because they can become the topmost hit elsewhere inside it.
      if (
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        !hasElementChildren(hit) &&
        !overlappingSiblingHasHoverInterest(hit, rect) &&
        !overlappingAbsoluteHasHoverInterest(rect)
      ) {
        // Copy the fields — nodeCache entries are replaced per frame and
        // the cache dies at the frame boundary anyway, but never alias.
        noInterestRects.set(root, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
      }
    }
  }
  for (const old of hovered) {
    if (!next.has(old)) {
      hovered.delete(old)
      // Skip handlers on detached nodes (removed between mouse events)
      if (old.parentNode) {
        const handler = (old._eventHandlers as EventHandlerProps | undefined)
          ?.onMouseLeave
        if (handler) {
          try {
            handler(new PointerEvent('hover', col, row, { action: 'move' }))
          } catch (error) {
            logError(error)
          }
        }
      }
    }
  }
  for (const n of next) {
    if (!hovered.has(n)) {
      hovered.add(n)
      const handler = (n._eventHandlers as EventHandlerProps | undefined)
        ?.onMouseEnter
      if (handler) {
        try {
          handler(new PointerEvent('hover', col, row, { action: 'move' }))
        } catch (error) {
          logError(error)
        }
      }
    }
  }
}
