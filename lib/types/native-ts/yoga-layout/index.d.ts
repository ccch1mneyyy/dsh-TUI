/**
 * Pure-TypeScript port of yoga-layout (Meta's flexbox engine).
 *
 * This matches the `yoga-layout/load` API surface used by src/ink/layout/yoga.ts.
 * The upstream C++ source is ~2500 lines in CalculateLayout.cpp alone; this port
 * is a simplified single-pass flexbox implementation that covers the subset of
 * features Ink actually uses:
 *   - flex-direction (row/column + reverse)
 *   - flex-grow / flex-shrink / flex-basis
 *   - align-items / align-self (stretch, flex-start, center, flex-end)
 *   - justify-content (all six values)
 *   - margin / padding / border / gap
 *   - width / height / min / max (point, percent, auto)
 *   - position: relative / absolute
 *   - display: flex / none
 *   - measure functions (for text nodes)
 *
 * Also implemented for spec parity (not used by Ink):
 *   - margin: auto (main + cross axis, overrides justify/align)
 *   - multi-pass flex clamping when children hit min/max constraints
 *   - flex-grow/shrink against container min/max when size is indefinite
 *
 * Also implemented for spec parity (not used by Ink):
 *   - flex-wrap: wrap / wrap-reverse (multi-line flex)
 *   - align-content (positions wrapped lines on cross axis)
 *
 * Also implemented for spec parity (not used by Ink):
 *   - display: contents (children lifted to grandparent, box removed)
 *
 * Also implemented for spec parity (not used by Ink):
 *   - baseline alignment (align-items/align-self: baseline)
 *
 * Not implemented (not used by Ink):
 *   - aspect-ratio
 *   - box-sizing: content-box
 *   - RTL direction (Ink always passes Direction.LTR)
 *
 * Upstream: https://github.com/facebook/yoga
 */
import { Align, BoxSizing, Dimension, Direction, Display, Edge, Errata, ExperimentalFeature, FlexDirection, Gutter, Justify, MeasureMode, Overflow, PositionType, Unit, Wrap } from './enums.js';
export { Align, BoxSizing, Dimension, Direction, Display, Edge, Errata, ExperimentalFeature, FlexDirection, Gutter, Justify, MeasureMode, Overflow, PositionType, Unit, Wrap, };
/**
 * A dimension value: a unit kind plus a numeric value. The numeric value is
 * NaN when the unit is undefined or auto.
 */
export type Value = {
    unit: Unit;
    value: number;
};
type Layout = {
    left: number;
    top: number;
    width: number;
    height: number;
    border: [number, number, number, number];
    padding: [number, number, number, number];
    margin: [number, number, number, number];
};
type Style = {
    direction: Direction;
    flexDirection: FlexDirection;
    justifyContent: Justify;
    alignItems: Align;
    alignSelf: Align;
    alignContent: Align;
    flexWrap: Wrap;
    overflow: Overflow;
    display: Display;
    positionType: PositionType;
    flexGrow: number;
    flexShrink: number;
    flexBasis: Value;
    margin: Value[];
    padding: Value[];
    border: Value[];
    position: Value[];
    gap: Value[];
    width: Value;
    height: Value;
    minWidth: Value;
    minHeight: Value;
    maxWidth: Value;
    maxHeight: Value;
};
/**
 * Measure function for text-like leaf nodes. Receives the available width
 * and height with their measure modes and returns the measured content size.
 */
export type MeasureFunction = (width: number, widthMode: MeasureMode, height: number, heightMode: MeasureMode) => {
    width: number;
    height: number;
};
/** A two-dimensional size in pixels. */
export type Size = {
    width: number;
    height: number;
};
/**
 * Yoga configuration: point scale factor, errata flags, and web-default
 * behavior. Mirrors the yoga-layout/load Config API.
 */
export type Config = {
    pointScaleFactor: number;
    errata: Errata;
    useWebDefaults: boolean;
    free(): void;
    isExperimentalFeatureEnabled(_: ExperimentalFeature): boolean;
    setExperimentalFeatureEnabled(_: ExperimentalFeature, __: boolean): void;
    setPointScaleFactor(factor: number): void;
    getErrata(): Errata;
    setErrata(errata: Errata): void;
    setUseWebDefaults(v: boolean): void;
};
/**
 * A node in the flexbox layout tree. Holds style inputs, computed layout
 * results, the parent/children tree, and layout caches. Mirrors the
 * yoga-layout/load Node API.
 */
export declare class Node {
    /** The node's input style values. */
    style: Style;
    /** The node's computed layout result: position, size, and resolved border, padding, and margin. */
    layout: Layout;
    /** The parent node, or null for a root node. */
    parent: Node | null;
    /** Child nodes in insertion order. */
    children: Node[];
    /** Measure function for text-like leaf nodes, or null when unset. */
    measureFunc: MeasureFunction | null;
    /** The config this node was created with. */
    config: Config;
    /** Whether this node or its subtree changed since the last layout. */
    isDirty_: boolean;
    /** Whether this node is its parent's baseline reference. */
    isReferenceBaseline_: boolean;
    /**
     * Per-layout scratch (not public API)
     * Flex-basis of this node for the current layout pass.
     */
    _flexBasis: number;
    /** Main size of this node for the current layout pass. */
    _mainSize: number;
    /** Cross size of this node for the current layout pass. */
    _crossSize: number;
    /** Index of the flex line this node was placed on. */
    _lineIndex: number;
    /**
     * Whether any margin edge is auto. Fast-path flag maintained by style
     * setters. Per CPU profile, the positioning loop calls isMarginAuto 6× and
     * resolveEdgeRaw(position) 4× per child per layout pass — ~11k calls for
     * the 1000-node bench, nearly all of which return false/undefined since
     * most nodes have no auto margins and no position insets. These flags let
     * us skip straight to the common case with a single branch.
     */
    _hasAutoMargin: boolean;
    /** Whether any position inset is set. */
    _hasPosition: boolean;
    /**
     * Whether any padding edge is set. Same pattern for the 3× resolveEdges4Into
     * calls at the top of every layoutNode(). In the 1000-node bench ~67% of
     * those calls operate on all-undefined edge arrays (most nodes have no
     * border; only cols have padding; only leaf cells have margin) — a
     * single-branch skip beats ~20 property reads + ~15 compares + 4 writes of
     * zeros.
     */
    _hasPadding: boolean;
    /** Whether any border edge is set. */
    _hasBorder: boolean;
    /** Whether any margin edge is set. */
    _hasMargin: boolean;
    /**
     * Cached available width of the last layout call. Dirty-flag layout cache:
     * mirrors upstream CalculateLayout.cpp's layoutNodeInternal, skipping a
     * subtree entirely when it's clean and we're asking the same question we
     * cached the answer to. Two slots since each node typically sees a measure
     * call (performLayout=false, from computeFlexBasis) followed by a layout
     * call (performLayout=true) with different inputs per parent pass — a
     * single slot thrashes. Re-layout bench (dirty one leaf, recompute root)
     * went 2.7x→1.1x with this: clean siblings skip straight through, only the
     * dirty chain recomputes.
     */
    _lW: number;
    /** Cached available height of the last layout call. */
    _lH: number;
    /** Cached width measure mode of the last layout call. */
    _lWM: MeasureMode;
    /** Cached height measure mode of the last layout call. */
    _lHM: MeasureMode;
    /** Cached owner width of the last layout call. */
    _lOW: number;
    /** Cached owner height of the last layout call. */
    _lOH: number;
    /** Whether width was forced on the last layout call. */
    _lFW: boolean;
    /** Whether height was forced on the last layout call. */
    _lFH: boolean;
    /**
     * Cached layout-pass output width restored on a cache hit. _hasL stores
     * INPUTS early (before compute) but layout.width/height are mutated by the
     * multi-entry cache and by subsequent compute calls with different inputs.
     * Without storing OUTPUTS, a _hasL hit returns whatever
     * layout.width/height happened to be left by the last call — the scrollbox
     * vpH=33→2624 bug. Store + restore outputs like the multi-entry cache does.
     */
    _lOutW: number;
    /** Cached layout-pass output height restored on a cache hit. */
    _lOutH: number;
    /** Whether the single-slot layout cache holds a valid entry. */
    _hasL: boolean;
    /** Cached available width of the last measure call. */
    _mW: number;
    /** Cached available height of the last measure call. */
    _mH: number;
    /** Cached width measure mode of the last measure call. */
    _mWM: MeasureMode;
    /** Cached height measure mode of the last measure call. */
    _mHM: MeasureMode;
    /** Cached owner width of the last measure call. */
    _mOW: number;
    /** Cached owner height of the last measure call. */
    _mOH: number;
    /** Cached measure-pass output width restored on a cache hit. */
    _mOutW: number;
    /** Cached measure-pass output height restored on a cache hit. */
    _mOutH: number;
    /** Whether the single-slot measure cache holds a valid entry. */
    _hasM: boolean;
    /**
     * Flex-basis of this node for the current layout pass, cached from
     * computeFlexBasis. For clean children, basis only depends on the
     * container's inner dimensions — if those haven't changed, skip the
     * layoutNode(performLayout=false) recursion entirely. This is the hot path
     * for scroll: 500-message content container is dirty, its 499 clean
     * children each get measured ~20× as the dirty chain's measure/layout
     * passes cascade. Basis cache short-circuits at the child boundary.
     */
    _fbBasis: number;
    /** Cached owner width the basis was computed against. */
    _fbOwnerW: number;
    /** Cached owner height the basis was computed against. */
    _fbOwnerH: number;
    /** Cached available main size the basis was computed against. */
    _fbAvailMain: number;
    /** Cached available cross size the basis was computed against. */
    _fbAvailCross: number;
    /** Cached cross measure mode the basis was computed against. */
    _fbCrossMode: MeasureMode;
    /**
     * Generation at which _fbBasis was written. Dirty nodes from a PREVIOUS
     * generation have stale cache (subtree changed), but within the SAME
     * generation the cache is fresh — the dirty chain's measure→layout
     * cascade invokes computeFlexBasis ≥2^depth times per calculateLayout on
     * fresh-mounted items, and the subtree doesn't change between calls.
     * Gating on generation instead of isDirty_ lets fresh mounts (virtual
     * scroll) cache-hit after first compute: 105k visits → ~10k.
     */
    _fbGen: number;
    /**
     * Input matrix of the multi-entry layout cache — stores (inputs → computed
     * w,h) so hits with different inputs than _hasL can restore the right
     * dimensions. Upstream yoga uses 16; 4 covers Ink's dirty-chain depth.
     * Packed as flat arrays to avoid per-entry object allocs. Slot i uses
     * indices [i*8, i*8+8) in _cIn (aW,aH,wM,hM,oW,oH,fW,fH) and [i*2, i*2+2)
     * in _cOut (w,h).
     */
    _cIn: Float64Array | null;
    /** Cached output width/height pairs, two slots per entry. */
    _cOut: Float64Array | null;
    /** Generation at which the multi-entry cache was last written. */
    _cGen: number;
    /** Number of populated cache slots. */
    _cN: number;
    /** LRU write index into the cache arrays. */
    _cWr: number;
    constructor(config?: Config);
    /**
     * Insert a child at the given index and mark this node dirty.
     * @param child - the child node to insert.
     * @param index - the position in the children array.
     */
    insertChild(child: Node, index: number): void;
    /**
     * Remove a child from this node and mark this node dirty. No-op when the
     * child is not a direct child.
     * @param child - the child node to remove.
     */
    removeChild(child: Node): void;
    /**
     * Get the child at the given index.
     * @param index - the child position.
     * @returns the child node.
     */
    getChild(index: number): Node;
    /**
     * Get the number of children.
     * @returns the child count.
     */
    getChildCount(): number;
    /**
     * Get the parent node.
     * @returns the parent, or null for a root node.
     */
    getParent(): Node | null;
    /**
     * Release this node's references and decrement the live-node counter.
     */
    free(): void;
    /**
     * Recursively free this node and all descendants.
     */
    freeRecursive(): void;
    /**
     * Reset this node to its default style, empty child list, and initial
     * layout-cache state.
     */
    reset(): void;
    /**
     * Mark this node and its ancestors dirty so the next layout recomputes them.
     */
    markDirty(): void;
    /**
     * Whether this node or its subtree needs re-layout.
     * @returns the dirty flag.
     */
    isDirty(): boolean;
    /**
     * Whether a new layout result is available. Always true in this port.
     * @returns true.
     */
    hasNewLayout(): boolean;
    /**
     * Mark the current layout as seen. No-op in this port.
     */
    markLayoutSeen(): void;
    /**
     * Set the measure function used to size this leaf node, and mark dirty.
     * @param fn - the measure function, or null to clear it.
     */
    setMeasureFunc(fn: MeasureFunction | null): void;
    /**
     * Clear the measure function and mark this node dirty.
     */
    unsetMeasureFunc(): void;
    /**
     * Get the computed left position.
     * @returns the left offset in pixels.
     */
    getComputedLeft(): number;
    /**
     * Get the computed top position.
     * @returns the top offset in pixels.
     */
    getComputedTop(): number;
    /**
     * Get the computed width.
     * @returns the width in pixels.
     */
    getComputedWidth(): number;
    /**
     * Get the computed height.
     * @returns the height in pixels.
     */
    getComputedHeight(): number;
    /**
     * Get the computed right inset: the parent's width minus this node's right
     * edge. Zero for a root node.
     * @returns the right inset in pixels.
     */
    getComputedRight(): number;
    /**
     * Get the computed bottom inset: the parent's height minus this node's
     * bottom edge. Zero for a root node.
     * @returns the bottom inset in pixels.
     */
    getComputedBottom(): number;
    /**
     * Get the full computed layout box.
     * @returns left, top, right, bottom, width, and height in pixels.
     */
    getComputedLayout(): {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
    /**
     * Get the computed border width for an edge.
     * @param edge - the edge to read.
     * @returns the border width in pixels.
     */
    getComputedBorder(edge: Edge): number;
    /**
     * Get the computed padding for an edge.
     * @param edge - the edge to read.
     * @returns the padding in pixels.
     */
    getComputedPadding(edge: Edge): number;
    /**
     * Get the computed margin for an edge.
     * @param edge - the edge to read.
     * @returns the margin in pixels.
     */
    getComputedMargin(edge: Edge): number;
    /**
     * Set the width from a number, an 'auto' or percent string, or undefined.
     * @param v - the width value.
     */
    setWidth(v: number | 'auto' | string | undefined): void;
    /**
     * Set the width as a percentage of the owner's width.
     * @param v - the percentage value.
     */
    setWidthPercent(v: number): void;
    /**
     * Set the width to auto.
     */
    setWidthAuto(): void;
    /**
     * Set the height from a number, an 'auto' or percent string, or undefined.
     * @param v - the height value.
     */
    setHeight(v: number | 'auto' | string | undefined): void;
    /**
     * Set the height as a percentage of the owner's height.
     * @param v - the percentage value.
     */
    setHeightPercent(v: number): void;
    /**
     * Set the height to auto.
     */
    setHeightAuto(): void;
    /**
     * Set the min width from a number, a percent string, or undefined.
     * @param v - the min width value.
     */
    setMinWidth(v: number | string | undefined): void;
    /**
     * Set the min width as a percentage of the owner's width.
     * @param v - the percentage value.
     */
    setMinWidthPercent(v: number): void;
    /**
     * Set the min height from a number, a percent string, or undefined.
     * @param v - the min height value.
     */
    setMinHeight(v: number | string | undefined): void;
    /**
     * Set the min height as a percentage of the owner's height.
     * @param v - the percentage value.
     */
    setMinHeightPercent(v: number): void;
    /**
     * Set the max width from a number, a percent string, or undefined.
     * @param v - the max width value.
     */
    setMaxWidth(v: number | string | undefined): void;
    /**
     * Set the max width as a percentage of the owner's width.
     * @param v - the percentage value.
     */
    setMaxWidthPercent(v: number): void;
    /**
     * Set the max height from a number, a percent string, or undefined.
     * @param v - the max height value.
     */
    setMaxHeight(v: number | string | undefined): void;
    /**
     * Set the max height as a percentage of the owner's height.
     * @param v - the percentage value.
     */
    setMaxHeightPercent(v: number): void;
    /**
     * Set the flex direction (main axis).
     * @param dir - the flex direction value.
     */
    setFlexDirection(dir: FlexDirection): void;
    /**
     * Set the flex grow factor.
     * @param v - the grow factor; undefined resets to 0.
     */
    setFlexGrow(v: number | undefined): void;
    /**
     * Set the flex shrink factor.
     * @param v - the shrink factor; undefined resets to 0.
     */
    setFlexShrink(v: number | undefined): void;
    /**
     * Set the flex shorthand. Positive values set grow to v and shrink to 1
     * with basis 0; negative values set shrink to -v; zero or undefined resets
     * both factors.
     * @param v - the flex value.
     */
    setFlex(v: number | undefined): void;
    /**
     * Set the flex basis from a number, an 'auto' or percent string, or
     * undefined.
     * @param v - the basis value.
     */
    setFlexBasis(v: number | 'auto' | string | undefined): void;
    /**
     * Set the flex basis as a percentage of the owner's main size.
     * @param v - the percentage value.
     */
    setFlexBasisPercent(v: number): void;
    /**
     * Set the flex basis to auto.
     */
    setFlexBasisAuto(): void;
    /**
     * Set the flex wrap mode.
     * @param wrap - the wrap value.
     */
    setFlexWrap(wrap: Wrap): void;
    /**
     * Set the align-items value for this container's children.
     * @param a - the alignment value.
     */
    setAlignItems(a: Align): void;
    /**
     * Set this node's align-self value.
     * @param a - the alignment value.
     */
    setAlignSelf(a: Align): void;
    /**
     * Set the align-content value for wrapped lines.
     * @param a - the alignment value.
     */
    setAlignContent(a: Align): void;
    /**
     * Set the justify-content value for the main axis.
     * @param j - the justification value.
     */
    setJustifyContent(j: Justify): void;
    /**
     * Set the display mode.
     * @param d - the display value.
     */
    setDisplay(d: Display): void;
    /**
     * Get the display mode.
     * @returns the display value.
     */
    getDisplay(): Display;
    /**
     * Set the position type.
     * @param t - the position type value.
     */
    setPositionType(t: PositionType): void;
    /**
     * Set a position inset from a number, a percent string, or undefined.
     * @param edge - the edge to set.
     * @param v - the inset value.
     */
    setPosition(edge: Edge, v: number | string | undefined): void;
    /**
     * Set a position inset as a percentage of the owner's size.
     * @param edge - the edge to set.
     * @param v - the percentage value.
     */
    setPositionPercent(edge: Edge, v: number): void;
    /**
     * Set a position inset to auto.
     * @param edge - the edge to set.
     */
    setPositionAuto(edge: Edge): void;
    /**
     * Set the overflow behavior.
     * @param o - the overflow value.
     */
    setOverflow(o: Overflow): void;
    /**
     * Set the text direction.
     * @param d - the direction value.
     */
    setDirection(d: Direction): void;
    /**
     * Set the box-sizing mode. Accepted for API parity; content-box is not
     * implemented in this port.
     * @param _ - the box-sizing value.
     */
    setBoxSizing(_: BoxSizing): void;
    /**
     * Set a margin from a number, an 'auto' or percent string, or undefined.
     * @param edge - the edge to set.
     * @param v - the margin value.
     */
    setMargin(edge: Edge, v: number | 'auto' | string | undefined): void;
    /**
     * Set a margin as a percentage of the owner's width.
     * @param edge - the edge to set.
     * @param v - the percentage value.
     */
    setMarginPercent(edge: Edge, v: number): void;
    /**
     * Set a margin to auto.
     * @param edge - the edge to set.
     */
    setMarginAuto(edge: Edge): void;
    /**
     * Set padding from a number, a percent string, or undefined.
     * @param edge - the edge to set.
     * @param v - the padding value.
     */
    setPadding(edge: Edge, v: number | string | undefined): void;
    /**
     * Set padding as a percentage of the owner's width.
     * @param edge - the edge to set.
     * @param v - the percentage value.
     */
    setPaddingPercent(edge: Edge, v: number): void;
    /**
     * Set a border width in points; undefined clears the edge.
     * @param edge - the edge to set.
     * @param v - the border width.
     */
    setBorder(edge: Edge, v: number | undefined): void;
    /**
     * Set a gap from a number, a percent string, or undefined.
     * @param gutter - the gutter axis to set.
     * @param v - the gap value.
     */
    setGap(gutter: Gutter, v: number | string | undefined): void;
    /**
     * Set a gap as a percentage of the owner's size.
     * @param gutter - the gutter axis to set.
     * @param v - the percentage value.
     */
    setGapPercent(gutter: Gutter, v: number): void;
    /**
     * Get the flex direction.
     * @returns the flex direction value.
     */
    getFlexDirection(): FlexDirection;
    /**
     * Get the justify-content value.
     * @returns the justification value.
     */
    getJustifyContent(): Justify;
    /**
     * Get the align-items value.
     * @returns the alignment value.
     */
    getAlignItems(): Align;
    /**
     * Get the align-self value.
     * @returns the alignment value.
     */
    getAlignSelf(): Align;
    /**
     * Get the align-content value.
     * @returns the alignment value.
     */
    getAlignContent(): Align;
    /**
     * Get the flex grow factor.
     * @returns the grow factor.
     */
    getFlexGrow(): number;
    /**
     * Get the flex shrink factor.
     * @returns the shrink factor.
     */
    getFlexShrink(): number;
    /**
     * Get the flex basis value.
     * @returns the flex basis.
     */
    getFlexBasis(): Value;
    /**
     * Get the flex wrap mode.
     * @returns the wrap value.
     */
    getFlexWrap(): Wrap;
    /**
     * Get the width value.
     * @returns the width style value.
     */
    getWidth(): Value;
    /**
     * Get the height value.
     * @returns the height style value.
     */
    getHeight(): Value;
    /**
     * Get the overflow behavior.
     * @returns the overflow value.
     */
    getOverflow(): Overflow;
    /**
     * Get the position type.
     * @returns the position type value.
     */
    getPositionType(): PositionType;
    /**
     * Get the text direction.
     * @returns the direction value.
     */
    getDirection(): Direction;
    /**
     * Copy another node's style into this node. Accepted for API parity; no-op
     * in this port.
     * @param _ - the source node.
     */
    copyStyle(_: Node): void;
    /**
     * Set a callback invoked when the node becomes dirty. Accepted for API
     * parity; no-op in this port.
     * @param _ - the callback.
     */
    setDirtiedFunc(_: unknown): void;
    /**
     * Clear the dirtied callback. Accepted for API parity; no-op in this port.
     */
    unsetDirtiedFunc(): void;
    /**
     * Set whether this node is its parent's baseline reference.
     * @param v - the reference-baseline flag.
     */
    setIsReferenceBaseline(v: boolean): void;
    /**
     * Whether this node is its parent's baseline reference.
     * @returns the reference-baseline flag.
     */
    isReferenceBaseline(): boolean;
    /**
     * Set the aspect ratio. Accepted for API parity; aspect-ratio is not
     * implemented in this port.
     * @param _ - the aspect ratio.
     */
    setAspectRatio(_: number | undefined): void;
    /**
     * Get the aspect ratio. Always NaN in this port.
     * @returns the aspect ratio.
     */
    getAspectRatio(): number;
    /**
     * Set whether this node always forms a containing block. Accepted for API
     * parity; no-op in this port.
     * @param _ - the flag.
     */
    setAlwaysFormsContainingBlock(_: boolean): void;
    /**
     * Run layout on this node's subtree. Resets the profiling counters, then
     * computes and writes layout results into this node and all descendants.
     * @param ownerWidth - the containing block's width; undefined when unbounded.
     * @param ownerHeight - the containing block's height; undefined when unbounded.
     * @param _direction - accepted for API parity; this port is always LTR.
     */
    calculateLayout(ownerWidth: number | undefined, ownerHeight: number | undefined, _direction?: Direction): void;
}
/**
 * Get the profiling counters accumulated since the last calculateLayout.
 * @returns the visited, measured, cacheHits, and live counts.
 */
export declare function getYogaCounters(): {
    visited: number;
    measured: number;
    cacheHits: number;
    live: number;
};
/**
 * The yoga-layout/load module API: factory functions for Config and Node.
 */
export type Yoga = {
    Config: {
        create(): Config;
        destroy(config: Config): void;
    };
    Node: {
        create(config?: Config): Node;
        createDefault(): Node;
        createWithConfig(config: Config): Node;
        destroy(node: Node): void;
    };
};
/**
 * The shared module instance returned by loadYoga and the default export.
 */
declare const YOGA_INSTANCE: Yoga;
/**
 * Resolve the yoga module instance, matching the yoga-layout/load API.
 * @returns a promise of the module API.
 */
export declare function loadYoga(): Promise<Yoga>;
export default YOGA_INSTANCE;
//# sourceMappingURL=index.d.ts.map