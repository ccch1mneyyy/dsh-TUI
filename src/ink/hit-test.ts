import type { DOMElement } from './dom.js'
import { ClickEvent } from './events/click-event.js'
import { ContextMenuEvent } from './events/context-menu-event.js'
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
  if (
    col < rect.x ||
    col >= rect.x + rect.width ||
    row < rect.y ||
    row >= rect.y + rect.height
  ) {
    return null
  }
  // Later siblings paint on top; reversed traversal returns topmost hit.
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const hit = hitTest(child, col, row)
    if (hit) return hit
  }
  return node
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
  let node: DOMElement | undefined =
    hitTestWithOverlays(root, col, row) ?? undefined
  while (node) {
    const h = node._eventHandlers as EventHandlerProps | undefined
    if (h?.onMouseEnter || h?.onMouseLeave) next.add(node)
    node = node.parentNode
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
