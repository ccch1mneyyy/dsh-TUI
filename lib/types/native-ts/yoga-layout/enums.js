/**
 * Yoga enums — ported from yoga-layout/src/generated/YGEnums.ts
 * Kept as `const` objects (not TS enums) per repo convention.
 * Values match upstream exactly so callers don't change.
 */
/**
 * Align values for align-items, align-self, and align-content.
 */
export const Align = {
    Auto: 0,
    FlexStart: 1,
    Center: 2,
    FlexEnd: 3,
    Stretch: 4,
    Baseline: 5,
    SpaceBetween: 6,
    SpaceAround: 7,
    SpaceEvenly: 8,
};
/**
 * Box-sizing modes: border-box or content-box.
 */
export const BoxSizing = {
    BorderBox: 0,
    ContentBox: 1,
};
/**
 * Dimension axes: width or height.
 */
export const Dimension = {
    Width: 0,
    Height: 1,
};
/**
 * Text direction: inherit, LTR, or RTL.
 */
export const Direction = {
    Inherit: 0,
    LTR: 1,
    RTL: 2,
};
/**
 * Display modes: flex, none, or contents.
 */
export const Display = {
    Flex: 0,
    None: 1,
    Contents: 2,
};
/**
 * Edges and edge groups for per-edge style properties.
 */
export const Edge = {
    Left: 0,
    Top: 1,
    Right: 2,
    Bottom: 3,
    Start: 4,
    End: 5,
    Horizontal: 6,
    Vertical: 7,
    All: 8,
};
/**
 * Errata flag bitmask for known yoga spec deviations.
 */
export const Errata = {
    None: 0,
    StretchFlexBasis: 1,
    AbsolutePositionWithoutInsetsExcludesPadding: 2,
    AbsolutePercentAgainstInnerSize: 4,
    All: 2147483647,
    Classic: 2147483646,
};
/**
 * Experimental feature flags.
 */
export const ExperimentalFeature = {
    WebFlexBasis: 0,
};
/**
 * Flex container main-axis directions.
 */
export const FlexDirection = {
    Column: 0,
    ColumnReverse: 1,
    Row: 2,
    RowReverse: 3,
};
/**
 * Gutter axes for gap properties: column, row, or all.
 */
export const Gutter = {
    Column: 0,
    Row: 1,
    All: 2,
};
/**
 * Justify-content values for distributing free space along the main axis.
 */
export const Justify = {
    FlexStart: 0,
    Center: 1,
    FlexEnd: 2,
    SpaceBetween: 3,
    SpaceAround: 4,
    SpaceEvenly: 5,
};
/**
 * Measure modes for the available size passed to layout: undefined, exactly,
 * or at most.
 */
export const MeasureMode = {
    Undefined: 0,
    Exactly: 1,
    AtMost: 2,
};
/**
 * Overflow behavior: visible, hidden, or scroll.
 */
export const Overflow = {
    Visible: 0,
    Hidden: 1,
    Scroll: 2,
};
/**
 * Positioning modes: static, relative, or absolute.
 */
export const PositionType = {
    Static: 0,
    Relative: 1,
    Absolute: 2,
};
/**
 * Dimension value units: undefined, point, percent, or auto.
 */
export const Unit = {
    Undefined: 0,
    Point: 1,
    Percent: 2,
    Auto: 3,
};
/**
 * Flex-wrap behavior: no-wrap, wrap, or wrap-reverse.
 */
export const Wrap = {
    NoWrap: 0,
    Wrap: 1,
    WrapReverse: 2,
};
