import { type Node as YogaNode } from '../../native-ts/yoga-layout/index.js';
import { type LayoutAlign, LayoutDisplay, type LayoutEdge, type LayoutFlexDirection, type LayoutGutter, type LayoutJustify, type LayoutMeasureFunc, type LayoutNode, type LayoutOverflow, type LayoutPositionType, type LayoutWrap } from './node.js';
/**
 * Yoga-backed implementation of `LayoutNode`.
 *
 * Wraps a yoga-layout node, mapping layout enums to their Yoga counterparts
 * and translating measure-mode values across the adapter boundary. The
 * underlying Yoga instance is synchronous and available at import time.
 */
export declare class YogaLayoutNode implements LayoutNode {
    /** The underlying Yoga node this adapter wraps. */
    readonly yoga: YogaNode;
    constructor(yoga: YogaNode);
    insertChild(child: LayoutNode, index: number): void;
    removeChild(child: LayoutNode): void;
    getChildCount(): number;
    getParent(): LayoutNode | null;
    calculateLayout(width?: number, _height?: number): void;
    setMeasureFunc(fn: LayoutMeasureFunc): void;
    unsetMeasureFunc(): void;
    markDirty(): void;
    getComputedLeft(): number;
    getComputedTop(): number;
    getComputedWidth(): number;
    getComputedHeight(): number;
    getComputedBorder(edge: LayoutEdge): number;
    getComputedPadding(edge: LayoutEdge): number;
    setWidth(value: number): void;
    setWidthPercent(value: number): void;
    setWidthAuto(): void;
    setHeight(value: number): void;
    setHeightPercent(value: number): void;
    setHeightAuto(): void;
    setMinWidth(value: number): void;
    setMinWidthPercent(value: number): void;
    setMinHeight(value: number): void;
    setMinHeightPercent(value: number): void;
    setMaxWidth(value: number): void;
    setMaxWidthPercent(value: number): void;
    setMaxHeight(value: number): void;
    setMaxHeightPercent(value: number): void;
    setFlexDirection(dir: LayoutFlexDirection): void;
    setFlexGrow(value: number): void;
    setFlexShrink(value: number): void;
    setFlexBasis(value: number): void;
    setFlexBasisPercent(value: number): void;
    setFlexWrap(wrap: LayoutWrap): void;
    setAlignItems(align: LayoutAlign): void;
    setAlignSelf(align: LayoutAlign): void;
    setJustifyContent(justify: LayoutJustify): void;
    setDisplay(display: LayoutDisplay): void;
    getDisplay(): LayoutDisplay;
    setPositionType(type: LayoutPositionType): void;
    setPosition(edge: LayoutEdge, value: number): void;
    setPositionPercent(edge: LayoutEdge, value: number): void;
    setOverflow(overflow: LayoutOverflow): void;
    setMargin(edge: LayoutEdge, value: number): void;
    setPadding(edge: LayoutEdge, value: number): void;
    setBorder(edge: LayoutEdge, value: number): void;
    setGap(gutter: LayoutGutter, value: number): void;
    free(): void;
    freeRecursive(): void;
}
/**
 * Create a new layout node backed by a fresh Yoga node.
 * @returns a `YogaLayoutNode` with no children, styles, or measure function.
 */
export declare function createYogaLayoutNode(): LayoutNode;
//# sourceMappingURL=yoga.d.ts.map