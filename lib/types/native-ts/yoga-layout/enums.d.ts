/**
 * Yoga enums — ported from yoga-layout/src/generated/YGEnums.ts
 * Kept as `const` objects (not TS enums) per repo convention.
 * Values match upstream exactly so callers don't change.
 */
/**
 * Align values for align-items, align-self, and align-content.
 */
export declare const Align: {
    readonly Auto: 0;
    readonly FlexStart: 1;
    readonly Center: 2;
    readonly FlexEnd: 3;
    readonly Stretch: 4;
    readonly Baseline: 5;
    readonly SpaceBetween: 6;
    readonly SpaceAround: 7;
    readonly SpaceEvenly: 8;
};
/** Union type of the Align values. */
export type Align = (typeof Align)[keyof typeof Align];
/**
 * Box-sizing modes: border-box or content-box.
 */
export declare const BoxSizing: {
    readonly BorderBox: 0;
    readonly ContentBox: 1;
};
/** Union type of the BoxSizing values. */
export type BoxSizing = (typeof BoxSizing)[keyof typeof BoxSizing];
/**
 * Dimension axes: width or height.
 */
export declare const Dimension: {
    readonly Width: 0;
    readonly Height: 1;
};
/** Union type of the Dimension values. */
export type Dimension = (typeof Dimension)[keyof typeof Dimension];
/**
 * Text direction: inherit, LTR, or RTL.
 */
export declare const Direction: {
    readonly Inherit: 0;
    readonly LTR: 1;
    readonly RTL: 2;
};
/** Union type of the Direction values. */
export type Direction = (typeof Direction)[keyof typeof Direction];
/**
 * Display modes: flex, none, or contents.
 */
export declare const Display: {
    readonly Flex: 0;
    readonly None: 1;
    readonly Contents: 2;
};
/** Union type of the Display values. */
export type Display = (typeof Display)[keyof typeof Display];
/**
 * Edges and edge groups for per-edge style properties.
 */
export declare const Edge: {
    readonly Left: 0;
    readonly Top: 1;
    readonly Right: 2;
    readonly Bottom: 3;
    readonly Start: 4;
    readonly End: 5;
    readonly Horizontal: 6;
    readonly Vertical: 7;
    readonly All: 8;
};
/** Union type of the Edge values. */
export type Edge = (typeof Edge)[keyof typeof Edge];
/**
 * Errata flag bitmask for known yoga spec deviations.
 */
export declare const Errata: {
    readonly None: 0;
    readonly StretchFlexBasis: 1;
    readonly AbsolutePositionWithoutInsetsExcludesPadding: 2;
    readonly AbsolutePercentAgainstInnerSize: 4;
    readonly All: 2147483647;
    readonly Classic: 2147483646;
};
/** Union type of the Errata values. */
export type Errata = (typeof Errata)[keyof typeof Errata];
/**
 * Experimental feature flags.
 */
export declare const ExperimentalFeature: {
    readonly WebFlexBasis: 0;
};
/** Union type of the ExperimentalFeature values. */
export type ExperimentalFeature = (typeof ExperimentalFeature)[keyof typeof ExperimentalFeature];
/**
 * Flex container main-axis directions.
 */
export declare const FlexDirection: {
    readonly Column: 0;
    readonly ColumnReverse: 1;
    readonly Row: 2;
    readonly RowReverse: 3;
};
/** Union type of the FlexDirection values. */
export type FlexDirection = (typeof FlexDirection)[keyof typeof FlexDirection];
/**
 * Gutter axes for gap properties: column, row, or all.
 */
export declare const Gutter: {
    readonly Column: 0;
    readonly Row: 1;
    readonly All: 2;
};
/** Union type of the Gutter values. */
export type Gutter = (typeof Gutter)[keyof typeof Gutter];
/**
 * Justify-content values for distributing free space along the main axis.
 */
export declare const Justify: {
    readonly FlexStart: 0;
    readonly Center: 1;
    readonly FlexEnd: 2;
    readonly SpaceBetween: 3;
    readonly SpaceAround: 4;
    readonly SpaceEvenly: 5;
};
/** Union type of the Justify values. */
export type Justify = (typeof Justify)[keyof typeof Justify];
/**
 * Measure modes for the available size passed to layout: undefined, exactly,
 * or at most.
 */
export declare const MeasureMode: {
    readonly Undefined: 0;
    readonly Exactly: 1;
    readonly AtMost: 2;
};
/** Union type of the MeasureMode values. */
export type MeasureMode = (typeof MeasureMode)[keyof typeof MeasureMode];
/**
 * Overflow behavior: visible, hidden, or scroll.
 */
export declare const Overflow: {
    readonly Visible: 0;
    readonly Hidden: 1;
    readonly Scroll: 2;
};
/** Union type of the Overflow values. */
export type Overflow = (typeof Overflow)[keyof typeof Overflow];
/**
 * Positioning modes: static, relative, or absolute.
 */
export declare const PositionType: {
    readonly Static: 0;
    readonly Relative: 1;
    readonly Absolute: 2;
};
/** Union type of the PositionType values. */
export type PositionType = (typeof PositionType)[keyof typeof PositionType];
/**
 * Dimension value units: undefined, point, percent, or auto.
 */
export declare const Unit: {
    readonly Undefined: 0;
    readonly Point: 1;
    readonly Percent: 2;
    readonly Auto: 3;
};
/** Union type of the Unit values. */
export type Unit = (typeof Unit)[keyof typeof Unit];
/**
 * Flex-wrap behavior: no-wrap, wrap, or wrap-reverse.
 */
export declare const Wrap: {
    readonly NoWrap: 0;
    readonly Wrap: 1;
    readonly WrapReverse: 2;
};
/** Union type of the Wrap values. */
export type Wrap = (typeof Wrap)[keyof typeof Wrap];
//# sourceMappingURL=enums.d.ts.map