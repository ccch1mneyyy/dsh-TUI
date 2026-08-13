// --
// Adapter interface for the layout engine (Yoga)
/** Edge names accepted by the layout engine's style setters. */
export const LayoutEdge = {
    All: 'all',
    Horizontal: 'horizontal',
    Vertical: 'vertical',
    Left: 'left',
    Right: 'right',
    Top: 'top',
    Bottom: 'bottom',
    Start: 'start',
    End: 'end',
};
/** Gutter axes accepted by the layout engine's gap setter. */
export const LayoutGutter = {
    All: 'all',
    Column: 'column',
    Row: 'row',
};
/** Display modes: flex lays out children, none hides the node. */
export const LayoutDisplay = {
    Flex: 'flex',
    None: 'none',
};
/** Main-axis directions for flex layout. */
export const LayoutFlexDirection = {
    Row: 'row',
    RowReverse: 'row-reverse',
    Column: 'column',
    ColumnReverse: 'column-reverse',
};
/** Cross-axis alignment values for flex items. */
export const LayoutAlign = {
    Auto: 'auto',
    Stretch: 'stretch',
    FlexStart: 'flex-start',
    Center: 'center',
    FlexEnd: 'flex-end',
};
/** Main-axis distribution values for flex containers. */
export const LayoutJustify = {
    FlexStart: 'flex-start',
    Center: 'center',
    FlexEnd: 'flex-end',
    SpaceBetween: 'space-between',
    SpaceAround: 'space-around',
    SpaceEvenly: 'space-evenly',
};
/** Wrapping modes for flex lines. */
export const LayoutWrap = {
    NoWrap: 'nowrap',
    Wrap: 'wrap',
    WrapReverse: 'wrap-reverse',
};
/** Positioning modes: relative keeps the node in flow, absolute takes it out. */
export const LayoutPositionType = {
    Relative: 'relative',
    Absolute: 'absolute',
};
/** Overflow modes: visible lets children expand the node, hidden and scroll constrain it. */
export const LayoutOverflow = {
    Visible: 'visible',
    Hidden: 'hidden',
    Scroll: 'scroll',
};
/** Width constraints passed to a measure function. */
export const LayoutMeasureMode = {
    Undefined: 'undefined',
    Exactly: 'exactly',
    AtMost: 'at-most',
};
