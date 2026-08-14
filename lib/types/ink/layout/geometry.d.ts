/** A 2D point in grid coordinates. */
export type Point = {
    x: number;
    y: number;
};
/** A width and height in terminal cells. */
export type Size = {
    width: number;
    height: number;
};
/** A rectangle: an origin point plus a size. */
export type Rectangle = Point & Size;
/** Edge insets (padding, margin, border) */
export type Edges = {
    top: number;
    right: number;
    bottom: number;
    left: number;
};
/**
 * Create uniform edges with the same value on every side.
 * @param all - the value applied to all four sides.
 * @returns edges with every side set to `all`.
 */
export declare function edges(all: number): Edges;
/**
 * Create edges from vertical and horizontal values.
 * @param vertical - the value for the top and bottom sides.
 * @param horizontal - the value for the left and right sides.
 * @returns edges with the vertical value on top/bottom and the horizontal value on left/right.
 */
export declare function edges(vertical: number, horizontal: number): Edges;
/**
 * Create edges from four individual side values.
 * @param top - the value for the top side.
 * @param right - the value for the right side.
 * @param bottom - the value for the bottom side.
 * @param left - the value for the left side.
 * @returns edges with each side set to its own value.
 */
export declare function edges(top: number, right: number, bottom: number, left: number): Edges;
/**
 * Add two edge values side by side.
 * @param a - the first edges.
 * @param b - the second edges.
 * @returns edges whose each side is the sum of the corresponding sides of `a` and `b`.
 */
export declare function addEdges(a: Edges, b: Edges): Edges;
/** Zero edges constant */
export declare const ZERO_EDGES: Edges;
/**
 * Convert partial edges to full edges with defaults.
 * @param partial - edges with optional sides; omitted sides default to zero.
 * @returns full edges where every missing side is zero.
 */
export declare function resolveEdges(partial?: Partial<Edges>): Edges;
/**
 * Compute the smallest rectangle containing both input rectangles.
 * @param a - the first rectangle.
 * @param b - the second rectangle.
 * @returns the union of `a` and `b`.
 */
export declare function unionRect(a: Rectangle, b: Rectangle): Rectangle;
/**
 * Clamp a rectangle into a size's bounds, keeping it inside the grid.
 * @param rect - the rectangle to clamp.
 * @param size - the bounding grid size.
 * @returns the intersection of `rect` with the grid; empty when they do not overlap.
 */
export declare function clampRect(rect: Rectangle, size: Size): Rectangle;
/**
 * Test whether a point lies inside a size's bounds.
 * @param size - the grid size.
 * @param point - the point to test.
 * @returns true when `point` is inside `size` (edges exclusive).
 */
export declare function withinBounds(size: Size, point: Point): boolean;
/**
 * Clamp a value to an optional range.
 * @param value - the value to clamp.
 * @param min - the lower bound, or undefined for none.
 * @param max - the upper bound, or undefined for none.
 * @returns `value` clamped to [`min`, `max`].
 */
export declare function clamp(value: number, min?: number, max?: number): number;
//# sourceMappingURL=geometry.d.ts.map