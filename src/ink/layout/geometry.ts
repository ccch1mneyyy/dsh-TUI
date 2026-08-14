/** A 2D point in grid coordinates. */
export type Point = {
  x: number
  y: number
}

/** A width and height in terminal cells. */
export type Size = {
  width: number
  height: number
}

/** A rectangle: an origin point plus a size. */
export type Rectangle = Point & Size

/** Edge insets (padding, margin, border) */
export type Edges = {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Create uniform edges with the same value on every side.
 * @param all - the value applied to all four sides.
 * @returns edges with every side set to `all`.
 */
export function edges(all: number): Edges
/**
 * Create edges from vertical and horizontal values.
 * @param vertical - the value for the top and bottom sides.
 * @param horizontal - the value for the left and right sides.
 * @returns edges with the vertical value on top/bottom and the horizontal value on left/right.
 */
export function edges(vertical: number, horizontal: number): Edges
/**
 * Create edges from four individual side values.
 * @param top - the value for the top side.
 * @param right - the value for the right side.
 * @param bottom - the value for the bottom side.
 * @param left - the value for the left side.
 * @returns edges with each side set to its own value.
 */
export function edges(
  top: number,
  right: number,
  bottom: number,
  left: number,
): Edges
export function edges(a: number, b?: number, c?: number, d?: number): Edges {
  if (b === undefined) {
    return { top: a, right: a, bottom: a, left: a }
  }
  if (c === undefined) {
    return { top: a, right: b, bottom: a, left: b }
  }
  return { top: a, right: b, bottom: c, left: d! }
}

/**
 * Add two edge values side by side.
 * @param a - the first edges.
 * @param b - the second edges.
 * @returns edges whose each side is the sum of the corresponding sides of `a` and `b`.
 */
export function addEdges(a: Edges, b: Edges): Edges {
  return {
    top: a.top + b.top,
    right: a.right + b.right,
    bottom: a.bottom + b.bottom,
    left: a.left + b.left,
  }
}

/** Zero edges constant */
export const ZERO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * Convert partial edges to full edges with defaults.
 * @param partial - edges with optional sides; omitted sides default to zero.
 * @returns full edges where every missing side is zero.
 */
export function resolveEdges(partial?: Partial<Edges>): Edges {
  return {
    top: partial?.top ?? 0,
    right: partial?.right ?? 0,
    bottom: partial?.bottom ?? 0,
    left: partial?.left ?? 0,
  }
}

/**
 * Compute the smallest rectangle containing both input rectangles.
 * @param a - the first rectangle.
 * @param b - the second rectangle.
 * @returns the union of `a` and `b`.
 */
export function unionRect(a: Rectangle, b: Rectangle): Rectangle {
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x + a.width, b.x + b.width)
  const maxY = Math.max(a.y + a.height, b.y + b.height)
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Clamp a rectangle into a size's bounds, keeping it inside the grid.
 * @param rect - the rectangle to clamp.
 * @param size - the bounding grid size.
 * @returns the intersection of `rect` with the grid; empty when they do not overlap.
 */
export function clampRect(rect: Rectangle, size: Size): Rectangle {
  const minX = Math.max(0, rect.x)
  const minY = Math.max(0, rect.y)
  const maxX = Math.min(size.width - 1, rect.x + rect.width - 1)
  const maxY = Math.min(size.height - 1, rect.y + rect.height - 1)
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX + 1),
    height: Math.max(0, maxY - minY + 1),
  }
}

/**
 * Test whether a point lies inside a size's bounds.
 * @param size - the grid size.
 * @param point - the point to test.
 * @returns true when `point` is inside `size` (edges exclusive).
 */
export function withinBounds(size: Size, point: Point): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < size.width &&
    point.y < size.height
  )
}

/**
 * Clamp a value to an optional range.
 * @param value - the value to clamp.
 * @param min - the lower bound, or undefined for none.
 * @param max - the upper bound, or undefined for none.
 * @returns `value` clamped to [`min`, `max`].
 */
export function clamp(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min
  if (max !== undefined && value > max) return max
  return value
}
