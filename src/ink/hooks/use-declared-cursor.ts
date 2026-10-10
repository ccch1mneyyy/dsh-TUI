import { useCallback, useContext, useLayoutEffect, useRef, type RefCallback } from 'react'
import CursorDeclarationContext, { NativeCursorContext } from '../components/CursorDeclarationContext.js'
import type { DOMElement } from '../dom.js'

/**
 * Declares where the terminal cursor should be parked after each frame.
 *
 * Terminal emulators render IME preedit text at the physical cursor
 * position, and screen readers / screen magnifiers track the native
 * cursor — so parking it at the text input's caret makes CJK input
 * appear inline and lets accessibility tools follow the input.
 *
 * Returns a ref callback to attach to the Box that contains the input.
 * The declared (line, column) is interpreted relative to that Box's
 * nodeCache rect (populated by renderNodeToOutput).
 *
 * Timing: Both ref attach and useLayoutEffect declare in React's layout
 * phase — after resetAfterCommit calls scheduleRender. scheduleRender
 * defers onRender via queueMicrotask, so onRender runs AFTER layout
 * effects commit and reads the fresh declaration on the first frame
 * (no one-keystroke lag). Test env uses onImmediateRender (synchronous,
 * no microtask), so tests compensate by calling ink.onRender()
 * explicitly after render.
 * @param options - the declared cursor target: `line` and `column` give the
 *   position relative to the node, `active` controls whether the declaration
 *   is set or cleared. `visible` opts a text input into the native caret;
 *   focus anchors remain hidden unless accessibility mode is enabled.
 *   `steady` parks a non-blinking marker for structural focus (list rows,
 *   picker tabs) instead of the terminal's own caret behaviour.
 * @returns a ref callback to attach to the Box that contains the input.
 */
export function useDeclaredCursor(options: {
  line: number
  column: number
  active: boolean
  visible?: boolean
  steady?: boolean
}): RefCallback<DOMElement> {
  const { line, column, active, visible = false, steady = false } = options
  const setCursorDeclaration = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)

  const setNode = useCallback<RefCallback<DOMElement>>(node => {
    nodeRef.current = node
    if (node === null) return
    // A store-driven editor layer can attach after the caller's layout
    // effect, so claim its cursor as soon as the node is attached.
    if (active) {
      setCursorDeclaration({ relativeX: column, relativeY: line, node, visible, steady })
    }
    // React 19 binds this cleanup to the attached node. A withdrawn editor
    // must not erase the inline node that has already taken over this ref.
    return () => {
      setCursorDeclaration(null, node)
      if (nodeRef.current === node) nodeRef.current = null
    }
  }, [active, column, line, setCursorDeclaration, steady, visible])

  // When active, set unconditionally. When inactive, clear conditionally
  // (only if the currently-declared node is ours). The node-identity check
  // handles two hazards:
  //   1. A memo()ized active instance elsewhere (e.g. the search input in
  //      a memo'd Footer) doesn't re-render this commit — an inactive
  //      instance re-rendering here must not clobber it.
  //   2. Sibling handoff (menu focus moving between list items) — when
  //      focus moves opposite to sibling order, the newly-inactive item's
  //      effect runs AFTER the newly-active item's set. Without the node
  //      check it would clobber.
  // No dep array: must re-declare every commit so the active instance
  // re-claims the declaration after another instance's unmount-cleanup or
  // sibling handoff nulls it.
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (active && node) {
      setCursorDeclaration({ relativeX: column, relativeY: line, node, visible, steady })
    } else {
      setCursorDeclaration(null, node)
    }
  })

  // Withdraw on hook unmount as well: its ref may live in an independently
  // committed editor layer that has not detached yet.
  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current)
    }
  }, [setCursorDeclaration])

  return setNode
}

/** Use a native caret in a TTY renderer, retaining painted carets in snapshots. */
export function useNativeCursor(): boolean {
  return useContext(NativeCursorContext)
}
