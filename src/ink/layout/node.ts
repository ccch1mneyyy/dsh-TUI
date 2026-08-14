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
} as const
/** Union of `LayoutEdge` values. */
export type LayoutEdge = (typeof LayoutEdge)[keyof typeof LayoutEdge]

/** Gutter axes accepted by the layout engine's gap setter. */
export const LayoutGutter = {
  All: 'all',
  Column: 'column',
  Row: 'row',
} as const
/** Union of `LayoutGutter` values. */
export type LayoutGutter = (typeof LayoutGutter)[keyof typeof LayoutGutter]

/** Display modes: flex lays out children, none hides the node. */
export const LayoutDisplay = {
  Flex: 'flex',
  None: 'none',
} as const
/** Union of `LayoutDisplay` values. */
export type LayoutDisplay = (typeof LayoutDisplay)[keyof typeof LayoutDisplay]

/** Main-axis directions for flex layout. */
export const LayoutFlexDirection = {
  Row: 'row',
  RowReverse: 'row-reverse',
  Column: 'column',
  ColumnReverse: 'column-reverse',
} as const
/** Union of `LayoutFlexDirection` values. */
export type LayoutFlexDirection =
  (typeof LayoutFlexDirection)[keyof typeof LayoutFlexDirection]

/** Cross-axis alignment values for flex items. */
export const LayoutAlign = {
  Auto: 'auto',
  Stretch: 'stretch',
  FlexStart: 'flex-start',
  Center: 'center',
  FlexEnd: 'flex-end',
} as const
/** Union of `LayoutAlign` values. */
export type LayoutAlign = (typeof LayoutAlign)[keyof typeof LayoutAlign]

/** Main-axis distribution values for flex containers. */
export const LayoutJustify = {
  FlexStart: 'flex-start',
  Center: 'center',
  FlexEnd: 'flex-end',
  SpaceBetween: 'space-between',
  SpaceAround: 'space-around',
  SpaceEvenly: 'space-evenly',
} as const
/** Union of `LayoutJustify` values. */
export type LayoutJustify = (typeof LayoutJustify)[keyof typeof LayoutJustify]

/** Wrapping modes for flex lines. */
export const LayoutWrap = {
  NoWrap: 'nowrap',
  Wrap: 'wrap',
  WrapReverse: 'wrap-reverse',
} as const
/** Union of `LayoutWrap` values. */
export type LayoutWrap = (typeof LayoutWrap)[keyof typeof LayoutWrap]

/** Positioning modes: relative keeps the node in flow, absolute takes it out. */
export const LayoutPositionType = {
  Relative: 'relative',
  Absolute: 'absolute',
} as const
/** Union of `LayoutPositionType` values. */
export type LayoutPositionType =
  (typeof LayoutPositionType)[keyof typeof LayoutPositionType]

/** Overflow modes: visible lets children expand the node, hidden and scroll constrain it. */
export const LayoutOverflow = {
  Visible: 'visible',
  Hidden: 'hidden',
  Scroll: 'scroll',
} as const
/** Union of `LayoutOverflow` values. */
export type LayoutOverflow =
  (typeof LayoutOverflow)[keyof typeof LayoutOverflow]

/** Measures a leaf node's content size given a width and its measure mode. */
export type LayoutMeasureFunc = (
  width: number,
  widthMode: LayoutMeasureMode,
) => { width: number; height: number }

/** Width constraints passed to a measure function. */
export const LayoutMeasureMode = {
  Undefined: 'undefined',
  Exactly: 'exactly',
  AtMost: 'at-most',
} as const
/** Union of `LayoutMeasureMode` values. */
export type LayoutMeasureMode =
  (typeof LayoutMeasureMode)[keyof typeof LayoutMeasureMode]

/**
 * Adapter interface for the layout engine (Yoga): tree manipulation, layout
 * computation, computed-geometry reads, style setters, and lifecycle.
 */
export type LayoutNode = {
  // Tree
  insertChild(child: LayoutNode, index: number): void
  removeChild(child: LayoutNode): void
  getChildCount(): number
  getParent(): LayoutNode | null

  // Layout computation
  calculateLayout(width?: number, height?: number): void
  setMeasureFunc(fn: LayoutMeasureFunc): void
  unsetMeasureFunc(): void
  markDirty(): void

  // Layout reading (post-layout)
  getComputedLeft(): number
  getComputedTop(): number
  getComputedWidth(): number
  getComputedHeight(): number
  getComputedBorder(edge: LayoutEdge): number
  getComputedPadding(edge: LayoutEdge): number

  // Style setters
  setWidth(value: number): void
  setWidthPercent(value: number): void
  setWidthAuto(): void
  setHeight(value: number): void
  setHeightPercent(value: number): void
  setHeightAuto(): void
  setMinWidth(value: number): void
  setMinWidthPercent(value: number): void
  setMinHeight(value: number): void
  setMinHeightPercent(value: number): void
  setMaxWidth(value: number): void
  setMaxWidthPercent(value: number): void
  setMaxHeight(value: number): void
  setMaxHeightPercent(value: number): void
  setFlexDirection(dir: LayoutFlexDirection): void
  setFlexGrow(value: number): void
  setFlexShrink(value: number): void
  setFlexBasis(value: number): void
  setFlexBasisPercent(value: number): void
  setFlexWrap(wrap: LayoutWrap): void
  setAlignItems(align: LayoutAlign): void
  setAlignSelf(align: LayoutAlign): void
  setJustifyContent(justify: LayoutJustify): void
  setDisplay(display: LayoutDisplay): void
  getDisplay(): LayoutDisplay
  setPositionType(type: LayoutPositionType): void
  setPosition(edge: LayoutEdge, value: number): void
  setPositionPercent(edge: LayoutEdge, value: number): void
  setOverflow(overflow: LayoutOverflow): void
  setMargin(edge: LayoutEdge, value: number): void
  setPadding(edge: LayoutEdge, value: number): void
  setBorder(edge: LayoutEdge, value: number): void
  setGap(gutter: LayoutGutter, value: number): void

  // Lifecycle
  free(): void
  freeRecursive(): void
}
