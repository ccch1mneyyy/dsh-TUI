import Yoga, { Align, Direction, Display, Edge, FlexDirection, Gutter, Justify, MeasureMode, Overflow, PositionType, Wrap, } from '../../native-ts/yoga-layout/index.js';
import { LayoutDisplay, LayoutMeasureMode, } from './node.js';
// --
// Edge/Gutter mapping
const EDGE_MAP = {
    all: Edge.All,
    horizontal: Edge.Horizontal,
    vertical: Edge.Vertical,
    left: Edge.Left,
    right: Edge.Right,
    top: Edge.Top,
    bottom: Edge.Bottom,
    start: Edge.Start,
    end: Edge.End,
};
const GUTTER_MAP = {
    all: Gutter.All,
    column: Gutter.Column,
    row: Gutter.Row,
};
// --
// Yoga adapter
/**
 * Yoga-backed implementation of `LayoutNode`.
 *
 * Wraps a yoga-layout node, mapping layout enums to their Yoga counterparts
 * and translating measure-mode values across the adapter boundary. The
 * underlying Yoga instance is synchronous and available at import time.
 */
export class YogaLayoutNode {
    /** The underlying Yoga node this adapter wraps. */
    yoga;
    constructor(yoga) {
        this.yoga = yoga;
    }
    // Tree
    insertChild(child, index) {
        this.yoga.insertChild(child.yoga, index);
    }
    removeChild(child) {
        this.yoga.removeChild(child.yoga);
    }
    getChildCount() {
        return this.yoga.getChildCount();
    }
    getParent() {
        const p = this.yoga.getParent();
        return p ? new YogaLayoutNode(p) : null;
    }
    // Layout
    calculateLayout(width, _height) {
        this.yoga.calculateLayout(width, undefined, Direction.LTR);
    }
    setMeasureFunc(fn) {
        this.yoga.setMeasureFunc((w, wMode) => {
            const mode = wMode === MeasureMode.Exactly
                ? LayoutMeasureMode.Exactly
                : wMode === MeasureMode.AtMost
                    ? LayoutMeasureMode.AtMost
                    : LayoutMeasureMode.Undefined;
            return fn(w, mode);
        });
    }
    unsetMeasureFunc() {
        this.yoga.unsetMeasureFunc();
    }
    markDirty() {
        this.yoga.markDirty();
    }
    // Computed layout
    getComputedLeft() {
        return this.yoga.getComputedLeft();
    }
    getComputedTop() {
        return this.yoga.getComputedTop();
    }
    getComputedWidth() {
        return this.yoga.getComputedWidth();
    }
    getComputedHeight() {
        return this.yoga.getComputedHeight();
    }
    getComputedBorder(edge) {
        return this.yoga.getComputedBorder(EDGE_MAP[edge]);
    }
    getComputedPadding(edge) {
        return this.yoga.getComputedPadding(EDGE_MAP[edge]);
    }
    // Style setters
    setWidth(value) {
        this.yoga.setWidth(value);
    }
    setWidthPercent(value) {
        this.yoga.setWidthPercent(value);
    }
    setWidthAuto() {
        this.yoga.setWidthAuto();
    }
    setHeight(value) {
        this.yoga.setHeight(value);
    }
    setHeightPercent(value) {
        this.yoga.setHeightPercent(value);
    }
    setHeightAuto() {
        this.yoga.setHeightAuto();
    }
    setMinWidth(value) {
        this.yoga.setMinWidth(value);
    }
    setMinWidthPercent(value) {
        this.yoga.setMinWidthPercent(value);
    }
    setMinHeight(value) {
        this.yoga.setMinHeight(value);
    }
    setMinHeightPercent(value) {
        this.yoga.setMinHeightPercent(value);
    }
    setMaxWidth(value) {
        this.yoga.setMaxWidth(value);
    }
    setMaxWidthPercent(value) {
        this.yoga.setMaxWidthPercent(value);
    }
    setMaxHeight(value) {
        this.yoga.setMaxHeight(value);
    }
    setMaxHeightPercent(value) {
        this.yoga.setMaxHeightPercent(value);
    }
    setFlexDirection(dir) {
        const map = {
            row: FlexDirection.Row,
            'row-reverse': FlexDirection.RowReverse,
            column: FlexDirection.Column,
            'column-reverse': FlexDirection.ColumnReverse,
        };
        this.yoga.setFlexDirection(map[dir]);
    }
    setFlexGrow(value) {
        this.yoga.setFlexGrow(value);
    }
    setFlexShrink(value) {
        this.yoga.setFlexShrink(value);
    }
    setFlexBasis(value) {
        this.yoga.setFlexBasis(value);
    }
    setFlexBasisPercent(value) {
        this.yoga.setFlexBasisPercent(value);
    }
    setFlexWrap(wrap) {
        const map = {
            nowrap: Wrap.NoWrap,
            wrap: Wrap.Wrap,
            'wrap-reverse': Wrap.WrapReverse,
        };
        this.yoga.setFlexWrap(map[wrap]);
    }
    setAlignItems(align) {
        const map = {
            auto: Align.Auto,
            stretch: Align.Stretch,
            'flex-start': Align.FlexStart,
            center: Align.Center,
            'flex-end': Align.FlexEnd,
        };
        this.yoga.setAlignItems(map[align]);
    }
    setAlignSelf(align) {
        const map = {
            auto: Align.Auto,
            stretch: Align.Stretch,
            'flex-start': Align.FlexStart,
            center: Align.Center,
            'flex-end': Align.FlexEnd,
        };
        this.yoga.setAlignSelf(map[align]);
    }
    setJustifyContent(justify) {
        const map = {
            'flex-start': Justify.FlexStart,
            center: Justify.Center,
            'flex-end': Justify.FlexEnd,
            'space-between': Justify.SpaceBetween,
            'space-around': Justify.SpaceAround,
            'space-evenly': Justify.SpaceEvenly,
        };
        this.yoga.setJustifyContent(map[justify]);
    }
    setDisplay(display) {
        this.yoga.setDisplay(display === 'flex' ? Display.Flex : Display.None);
    }
    getDisplay() {
        return this.yoga.getDisplay() === Display.None
            ? LayoutDisplay.None
            : LayoutDisplay.Flex;
    }
    setPositionType(type) {
        this.yoga.setPositionType(type === 'absolute' ? PositionType.Absolute : PositionType.Relative);
    }
    setPosition(edge, value) {
        this.yoga.setPosition(EDGE_MAP[edge], value);
    }
    setPositionPercent(edge, value) {
        this.yoga.setPositionPercent(EDGE_MAP[edge], value);
    }
    setOverflow(overflow) {
        const map = {
            visible: Overflow.Visible,
            hidden: Overflow.Hidden,
            scroll: Overflow.Scroll,
        };
        this.yoga.setOverflow(map[overflow]);
    }
    setMargin(edge, value) {
        this.yoga.setMargin(EDGE_MAP[edge], value);
    }
    setPadding(edge, value) {
        this.yoga.setPadding(EDGE_MAP[edge], value);
    }
    setBorder(edge, value) {
        this.yoga.setBorder(EDGE_MAP[edge], value);
    }
    setGap(gutter, value) {
        this.yoga.setGap(GUTTER_MAP[gutter], value);
    }
    // Lifecycle
    free() {
        this.yoga.free();
    }
    freeRecursive() {
        this.yoga.freeRecursive();
    }
}
// --
// Instance management
//
// The TS yoga-layout port is synchronous — no WASM loading, no linear memory
// growth, so no preload/swap/reset machinery is needed. The Yoga instance is
// just a plain JS object available at import time.
/**
 * Create a new layout node backed by a fresh Yoga node.
 * @returns a `YogaLayoutNode` with no children, styles, or measure function.
 */
export function createYogaLayoutNode() {
    return new YogaLayoutNode(Yoga.Node.create());
}
