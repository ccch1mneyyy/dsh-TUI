import type { FocusManager } from './focus.js'
import { createLayoutNode } from './layout/engine.js'
import type { LayoutNode } from './layout/node.js'
import { LayoutDisplay, LayoutMeasureMode } from './layout/node.js'
import measureText from './measure-text.js'
import { addPendingClear, nodeCache } from './node-cache.js'
import squashTextNodes from './squash-text-nodes.js'
import type { Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrap-text.js'

type InkNode = {
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode
  style: Styles
}

/**
 * Node name of a text node in the ink DOM.
 */
export type TextName = '#text'
/**
 * Names of the element node kinds the ink DOM supports.
 */
export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-progress'
  | 'ink-raw-ansi'

/**
 * Union of every node name in the ink DOM: element names plus `#text`.
 */
export type NodeNames = ElementNames | TextName

/**
 * An element node in the ink DOM: a named, styled container holding child
 * nodes, attributes, layout state, and render hooks.
 */
export type DOMElement = {
  nodeName: ElementNames
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  textStyles?: TextStyles

  // Internal properties
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void
  // Used to skip empty renders during React 19's effect double-invoke in test mode
  hasRenderedContent?: boolean

  // When true, this node needs re-rendering
  dirty: boolean
  // Set by the reconciler's hideInstance/unhideInstance; survives style updates.
  isHidden?: boolean
  // Event handlers set by the reconciler for the capture/bubble dispatcher.
  // Stored separately from attributes so handler identity changes don't
  // mark dirty and defeat the blit optimization.
  _eventHandlers?: Record<string, unknown>

  // Scroll state for overflow: 'scroll' boxes. scrollTop is the number of
  // rows the content is scrolled down by. scrollHeight/scrollViewportHeight
  // are computed at render time and stored for imperative access. stickyScroll
  // auto-pins scrollTop to the bottom when content grows.
  scrollTop?: number
  // Accumulated scroll delta not yet applied to scrollTop. The renderer
  // drains this at SCROLL_MAX_PER_FRAME rows/frame so fast flicks show
  // intermediate frames instead of one big jump. Direction reversal
  // naturally cancels (pure accumulator, no target tracking).
  pendingScrollDelta?: number
  // Render-time clamp bounds for virtual scroll. useVirtualScroll writes
  // the currently-mounted children's coverage span; render-node-to-output
  // clamps scrollTop to stay within it. Prevents blank screen when
  // scrollTo's direct write races past React's async re-render — instead
  // of painting spacer (blank), the renderer holds at the edge of mounted
  // content until React catches up (next commit updates these bounds and
  // the clamp releases). Undefined = no clamp (sticky-scroll, cold start).
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  // maxScroll of the most recent TRUSTED (non-shrink) frame. Virtualization
  // can transiently shrink scrollHeight; a positional at-bottom check must
  // not compare against a maxScroll computed from such an artifact frame,
  // or a mid-scroll position is mistaken for "at bottom" and yanked to the
  // bottom/top. Shrink frames keep the last trusted value; only real
  // growth (or a settled measurement) refreshes it.
  scrollPrevMax?: number
  stickyScroll?: boolean
  // Renderer → React notification channel, set by ScrollBox to its
  // subscriber-notify. Invoked when the RENDERER restores stickyScroll on
  // its own (positional re-pin at the bottom) — imperative scrolls already
  // notify via scrollMutated, but renderer-side restores would otherwise
  // leave useSyncExternalStore snapshots stale (the new-messages pill
  // never clears).
  onStickyRestore?: () => void
  // Set by ScrollBox.scrollToElement; render-node-to-output reads
  // el.yogaNode.getComputedTop() (FRESH — same Yoga pass as scrollHeight)
  // and sets scrollTop = top + offset, then clears this. Unlike an
  // imperative scrollTo(N) which bakes in a number that's stale by the
  // time the throttled render fires, the element ref defers the position
  // read to paint time. One-shot.
  scrollAnchor?: { el: DOMElement; offset: number }
  // Only set on ink-root. The document owns focus — any node can
  // reach it by walking parentNode, like browser getRootNode().
  focusManager?: FocusManager
  // React component stack captured at createInstance time (reconciler.ts),
  // e.g. ['ToolUseLoader', 'Messages', 'REPL']. Only populated when
  // CLAUDE_CODE_DEBUG_REPAINTS is set. Used by findOwnerChainAtRow to
  // attribute scrollback-diff full-resets to the component that caused them.
  debugOwnerChain?: string[]
} & InkNode

/**
 * A text leaf node in the ink DOM holding a single string value.
 */
export type TextNode = {
  nodeName: TextName
  nodeValue: string
} & InkNode

/**
 * Discriminated union of ink DOM nodes, resolving a node-name-bearing type
 * to TextNode for `#text` and DOMElement otherwise.
 */
export type DOMNode<T = { nodeName: NodeNames }> = T extends {
  nodeName: infer U
}
  ? U extends '#text'
    ? TextNode
    : DOMElement
  : never

/**
 * Attribute values storable on an ink DOM element.
 */
export type DOMNodeAttribute = boolean | string | number

/**
 * Create an element node of the given kind, allocating its yoga layout node
 * unless the kind renders without layout (`ink-virtual-text`, `ink-link`,
 * `ink-progress`).
 * @param nodeName - the element kind to create.
 * @returns the new element node.
 */
export const createNode = (nodeName: ElementNames): DOMElement => {
  const needsYogaNode =
    nodeName !== 'ink-virtual-text' &&
    nodeName !== 'ink-link' &&
    nodeName !== 'ink-progress'
  const node: DOMElement = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: needsYogaNode ? createLayoutNode() : undefined,
    dirty: false,
  }

  if (nodeName === 'ink-text') {
    node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node))
  } else if (nodeName === 'ink-raw-ansi') {
    node.yogaNode?.setMeasureFunc(measureRawAnsiNode.bind(null, node))
  }

  return node
}

/**
 * Append a child element to a parent, moving it from its current parent if
 * any and keeping the yoga tree in sync.
 * @param node - the parent element.
 * @param childNode - the element to append.
 */
export const appendChildNode = (
  node: DOMElement,
  childNode: DOMElement,
): void => {
  if (childNode.parentNode) {
    removeChildNode(childNode.parentNode, childNode)
  }

  childNode.parentNode = node
  node.childNodes.push(childNode)

  if (childNode.yogaNode) {
    node.yogaNode?.insertChild(
      childNode.yogaNode,
      node.yogaNode.getChildCount(),
    )
  }

  markDirty(node)
}

/**
 * Insert a child before an existing sibling, moving it from its current
 * parent if any and keeping the yoga tree in sync. Nodes without a yoga
 * node do not affect yoga indices.
 * @param node - the parent element.
 * @param newChildNode - the node to insert.
 * @param beforeChildNode - the sibling the new node is inserted before;
 *   when absent from the parent, the new node is appended.
 */
export const insertBeforeNode = (
  node: DOMElement,
  newChildNode: DOMNode,
  beforeChildNode: DOMNode,
): void => {
  if (newChildNode.parentNode) {
    removeChildNode(newChildNode.parentNode, newChildNode)
  }

  newChildNode.parentNode = node

  const index = node.childNodes.indexOf(beforeChildNode)

  if (index >= 0) {
    // Calculate yoga index BEFORE modifying childNodes.
    // We can't use DOM index directly because some children (like ink-progress,
    // ink-link, ink-virtual-text) don't have yogaNodes, so DOM indices don't
    // match yoga indices.
    let yogaIndex = 0
    if (newChildNode.yogaNode && node.yogaNode) {
      for (let i = 0; i < index; i++) {
        if (node.childNodes[i]?.yogaNode) {
          yogaIndex++
        }
      }
    }

    node.childNodes.splice(index, 0, newChildNode)

    if (newChildNode.yogaNode && node.yogaNode) {
      node.yogaNode.insertChild(newChildNode.yogaNode, yogaIndex)
    }

    markDirty(node)
    return
  }

  node.childNodes.push(newChildNode)

  if (newChildNode.yogaNode) {
    node.yogaNode?.insertChild(
      newChildNode.yogaNode,
      node.yogaNode.getChildCount(),
    )
  }

  markDirty(node)
}

/**
 * Remove a child node from a parent, clearing its yoga node, cached rects,
 * and parent reference.
 * @param node - the parent element.
 * @param removeNode - the child node to remove.
 */
export const removeChildNode = (
  node: DOMElement,
  removeNode: DOMNode,
): void => {
  if (removeNode.yogaNode) {
    removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode)
  }

  // Collect cached rects from the removed subtree so they can be cleared
  collectRemovedRects(node, removeNode)

  removeNode.parentNode = undefined

  const index = node.childNodes.indexOf(removeNode)
  if (index >= 0) {
    node.childNodes.splice(index, 1)
  }

  markDirty(node)
}

function collectRemovedRects(
  parent: DOMElement,
  removed: DOMNode,
  underAbsolute = false,
): void {
  if (removed.nodeName === '#text') return
  const elem = removed
  // If this node or any ancestor in the removed subtree was absolute,
  // its painted pixels may overlap non-siblings — flag for global blit
  // disable. Normal-flow removals only affect direct siblings, which
  // hasRemovedChild already handles.
  const isAbsolute = underAbsolute || elem.style.position === 'absolute'
  const cached = nodeCache.get(elem)
  if (cached) {
    addPendingClear(parent, cached, isAbsolute)
    nodeCache.delete(elem)
  }
  for (const child of elem.childNodes) {
    collectRemovedRects(parent, child, isAbsolute)
  }
}

/**
 * Set an attribute on an element, skipping `children` and unchanged values
 * so unrelated renders do not mark the node dirty.
 * @param node - the element to update.
 * @param key - the attribute name.
 * @param value - the attribute value.
 */
export const setAttribute = (
  node: DOMElement,
  key: string,
  value: DOMNodeAttribute,
): void => {
  // Skip 'children' - React handles children via appendChild/removeChild,
  // not attributes. React always passes a new children reference, so
  // tracking it as an attribute would mark everything dirty every render.
  if (key === 'children') {
    return
  }
  // Skip if unchanged
  if (node.attributes[key] === value) {
    return
  }
  node.attributes[key] = value
  markDirty(node)
}

/**
 * Replace an element's style, skipping the write when the new style is
 * shallow-equal to the current one to avoid needless dirty marks.
 * @param node - the node to update.
 * @param style - the new style object.
 */
export const setStyle = (node: DOMNode, style: Styles): void => {
  // Compare style properties to avoid marking dirty unnecessarily.
  // React creates new style objects on every render even when unchanged.
  if (stylesEqual(node.style, style)) {
    return
  }
  node.style = style
  markDirty(node)
}

/**
 * Replace an element's text styles, skipping the write when the new styles
 * are shallow-equal to the current ones to avoid needless dirty marks.
 * @param node - the element to update.
 * @param textStyles - the new text styles.
 */
export const setTextStyles = (
  node: DOMElement,
  textStyles: TextStyles,
): void => {
  // Same dirty-check guard as setStyle: React (and buildTextStyles in Text.tsx)
  // allocate a new textStyles object on every render even when values are
  // unchanged, so compare by value to avoid markDirty -> yoga re-measurement
  // on every Text re-render.
  if (shallowEqual(node.textStyles, textStyles)) {
    return
  }
  node.textStyles = textStyles
  markDirty(node)
}

function stylesEqual(a: Styles, b: Styles): boolean {
  return shallowEqual(a, b)
}

function shallowEqual<T extends object>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  // Fast path: same object reference (or both undefined)
  if (a === b) return true
  if (a === undefined || b === undefined) return false

  // Get all keys from both objects
  const aKeys = Object.keys(a) as (keyof T)[]
  const bKeys = Object.keys(b) as (keyof T)[]

  // Different number of properties
  if (aKeys.length !== bKeys.length) return false

  // Compare each property
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }

  return true
}

/**
 * Create a text node holding the given string.
 * @param text - the text content.
 * @returns the new text node.
 */
export const createTextNode = (text: string): TextNode => {
  const node: TextNode = {
    nodeName: '#text',
    nodeValue: text,
    yogaNode: undefined,
    parentNode: undefined,
    style: {},
  }

  setTextNodeValue(node, text)

  return node
}

/**
 * Per-node incremental wrap cache for measureTextNode. A streaming text
 * node grows by append every chunk; without a cache each yoga pass re-wraps
 * the full text (wrapAnsi tokenizes + measures every word — the dominant
 * SLOW_YOGA cost at 20ms+ per frame on long code blocks).
 *
 * Greedy wrapping has no cross-line state, so a text's wrapped height equals
 * the sum of its logical lines' wrapped heights. We therefore commit
 * completed logical lines (everything before the last '\n') into `headHeight`
 * and only re-wrap the growing tail line each pass — O(current line) instead
 * of O(whole text). Cache validity requires same width/wrap mode and the
 * cached text to be a pure prefix of the new text.
 */
type MeasureWrapCache = {
  /** Full text as measured last time (post tab-expansion). */
  text: string
  width: number
  wrap: NonNullable<Styles['textWrap']>
  /** Wrapped height of text.slice(0, tailStart) — the committed head. */
  headHeight: number
  /** Start offset of the uncommitted tail (just past the last '\n'). */
  tailStart: number
  /** Wrapped height of text.slice(tailStart). */
  tailHeight: number
  /** Last returned dimensions. */
  result: { width: number; height: number }
}
const measureWrapCache = new WeakMap<DOMNode, MeasureWrapCache>()

const measureTextNode = function (
  node: DOMNode,
  width: number,
  widthMode: LayoutMeasureMode,
): { width: number; height: number } {
  const rawText =
    node.nodeName === '#text' ? node.nodeValue : squashTextNodes(node)

  // Expand tabs for measurement (worst case: 8 spaces each).
  // Actual tab expansion happens in output.ts based on screen position.
  const text = expandTabs(rawText)

  const dimensions = measureText(text, width)

  // Text fits into container, no need to wrap
  if (dimensions.width <= width) {
    return dimensions
  }

  // This is happening when <Box> is shrinking child nodes and layout asks
  // if we can fit this text node in a <1px space, so we just say "no"
  if (dimensions.width >= 1 && width > 0 && width < 1) {
    return dimensions
  }

  // For text with embedded newlines (pre-wrapped content), avoid re-wrapping
  // at measurement width when layout is asking for intrinsic size (Undefined mode).
  // This prevents height inflation during min/max size checks.
  //
  // However, when layout provides an actual constraint (Exactly or AtMost mode),
  // we must respect it and measure at that width. Otherwise, if the actual
  // rendering width is smaller than the natural width, the text will wrap to
  // more lines than layout expects, causing content to be truncated.
  if (text.includes('\n') && widthMode === LayoutMeasureMode.Undefined) {
    const effectiveWidth = Math.max(width, dimensions.width)
    return measureText(text, effectiveWidth)
  }

  const textWrap = node.style.textWrap ?? 'wrap'

  // Incremental path: same node, same width/wrap, text grew by append.
  const cached = measureWrapCache.get(node)
  if (cached !== undefined && cached.width === width && cached.wrap === textWrap) {
    if (cached.text === text) {
      // Same-frame repeat measure (yoga min/max probing) — free.
      return cached.result
    }
    if (text.startsWith(cached.text)) {
      const tail = text.slice(cached.tailStart)
      const tailWrapped = wrapText(tail, width, textWrap)
      const tailDim = measureText(tailWrapped, width)
      // Commit fully-terminated logical lines into the head so the tail
      // stays bounded at one line of source text.
      const lastNewline = tail.lastIndexOf('\n')
      let { headHeight, tailStart } = cached
      let tailHeight = tailDim.height
      if (lastNewline > 0) {
        const committed = wrapText(tail.slice(0, lastNewline + 1), width, textWrap)
        headHeight += measureText(committed, width).height
        tailStart += lastNewline + 1
        tailHeight = measureText(wrapText(tail.slice(lastNewline + 1), width, textWrap), width).height
      }
      const result = {
        width: Math.max(cached.result.width, tailDim.width),
        height: headHeight + tailHeight,
      }
      measureWrapCache.set(node, {
        text,
        width,
        wrap: textWrap,
        headHeight,
        tailStart,
        tailHeight,
        result,
      })
      return result
    }
    // Text replaced or shrunk (node reuse for a different message): fall
    // through to the full path and overwrite the cache below.
  }

  const wrappedText = wrapText(text, width, textWrap)
  const fullResult = measureText(wrappedText, width)

  // Seed the incremental cache: commit everything before the last newline.
  const lastNewline = text.lastIndexOf('\n')
  const tailStart = lastNewline === -1 ? 0 : lastNewline + 1
  const headHeight =
    tailStart === 0
      ? 0
      : measureText(wrapText(text.slice(0, tailStart), width, textWrap), width).height
  measureWrapCache.set(node, {
    text,
    width,
    wrap: textWrap,
    headHeight,
    tailStart,
    tailHeight: fullResult.height - headHeight,
    result: fullResult,
  })

  return fullResult
}

// ink-raw-ansi nodes hold pre-rendered ANSI strings with known dimensions.
// No stringWidth, no wrapping, no tab expansion — the producer (e.g. ColorDiff)
// already wrapped to the target width and each line is exactly one terminal row.
const measureRawAnsiNode = function (node: DOMElement): {
  width: number
  height: number
} {
  return {
    width: node.attributes['rawWidth'] as number,
    height: node.attributes['rawHeight'] as number,
  }
}

/**
 * Mark a node and all its ancestors as dirty for re-rendering.
 * Also marks yoga dirty for text remeasurement if this is a text node.
 * @param node - the node whose dirty chain to mark; a no-op when undefined.
 */
export const markDirty = (node?: DOMNode): void => {
  let current: DOMNode | undefined = node
  let markedYoga = false

  while (current) {
    if (current.nodeName !== '#text') {
      ;(current).dirty = true
      // Only mark yoga dirty on leaf nodes that have measure functions
      if (
        !markedYoga &&
        (current.nodeName === 'ink-text' ||
          current.nodeName === 'ink-raw-ansi') &&
        current.yogaNode
      ) {
        current.yogaNode.markDirty()
        markedYoga = true
      }
    }
    current = current.parentNode
  }
}

/**
 * Walk to the root and call its onRender (the throttled scheduleRender).
 * Use for DOM-level mutations (scrollTop changes) that should trigger an
 * Ink frame without going through React's reconciler. Pair with markDirty()
 * so the renderer knows which subtree to re-evaluate.
 * @param node - the node to walk up from; a no-op when undefined.
 */
export const scheduleRenderFrom = (node?: DOMNode): void => {
  let cur: DOMNode | undefined = node
  while (cur?.parentNode) cur = cur.parentNode
  if (cur && cur.nodeName !== '#text') (cur).onRender?.()
}

/**
 * Replace a text node's value, skipping the write when unchanged and
 * marking the node dirty otherwise.
 * @param node - the text node to update.
 * @param text - the new text value; non-strings are stringified.
 */
export const setTextNodeValue = (node: TextNode, text: string): void => {
  if (typeof text !== 'string') {
    text = String(text)
  }

  // Skip if unchanged
  if (node.nodeValue === text) {
    return
  }

  node.nodeValue = text
  markDirty(node)
}

function isDOMElement(node: DOMElement | TextNode): node is DOMElement {
  return node.nodeName !== '#text'
}

/**
 * Clear yogaNode references on a node and its whole subtree before freeing.
 * freeRecursive() frees the node and ALL its children, so every reference
 * must be cleared to prevent dangling pointers.
 * @param node - the node whose subtree to clear.
 */
export const clearYogaNodeReferences = (node: DOMElement | TextNode): void => {
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      clearYogaNodeReferences(child)
    }
  }
  node.yogaNode = undefined
}

/**
 * Find the React component stack responsible for content at screen row `y`.
 *
 * DFS the DOM tree accumulating yoga offsets. Returns the debugOwnerChain of
 * the deepest node whose bounding box contains `y`. Called from ink.tsx when
 * log-update triggers a full reset, to attribute the flicker to its source.
 *
 * Only useful when CLAUDE_CODE_DEBUG_REPAINTS is set (otherwise chains are
 * undefined and this returns []).
 * @param root - the ink-root element to search from.
 * @param y - the screen row to locate.
 * @returns the debugOwnerChain of the deepest node containing `y`, or an
 *   empty array when none is recorded.
 */
export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  let best: string[] = []
  walk(root, 0)
  return best

  function walk(node: DOMElement, offsetY: number): void {
    const yoga = node.yogaNode
    if (!yoga || yoga.getDisplay() === LayoutDisplay.None) return

    const top = offsetY + yoga.getComputedTop()
    const height = yoga.getComputedHeight()
    if (y < top || y >= top + height) return

    if (node.debugOwnerChain) best = node.debugOwnerChain

    for (const child of node.childNodes) {
      if (isDOMElement(child)) walk(child, top)
    }
  }
}
