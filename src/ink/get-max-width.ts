import type { LayoutNode } from './layout/node.js'

/**
 * Return the text constraint that produced the laid-out height. Pixel-grid
 * rounding can widen the painted box; wrapping at that rounded width would
 * produce fewer rows than Yoga reserved and leave blank space at the bottom.
 * The layout engine retains this constraint through its cache-hit paths.
 * @param yogaNode - a laid-out text node with a measure function.
 * @returns content width, already excluding padding and border.
 */
const getMaxWidth = (yogaNode: LayoutNode): number => {
  return yogaNode.getComputedMeasureWidth()
}

export default getMaxWidth
