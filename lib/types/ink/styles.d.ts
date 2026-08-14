import { type LayoutNode } from './layout/node.js';
import type { BorderStyle, BorderTextOptions } from './render-border.js';
/** Template-literal type for rgb(r,g,b) color strings. */
export type RGBColor = `rgb(${number},${number},${number})`;
/** Template-literal type for hex color strings like `#ff8800`. */
export type HexColor = `#${string}`;
/** Template-literal type for 256-color strings like `ansi256(174)`. */
export type Ansi256Color = `ansi256(${number})`;
/** Named ANSI color strings, optionally bright variants. */
export type AnsiColor = 'ansi:black' | 'ansi:red' | 'ansi:green' | 'ansi:yellow' | 'ansi:blue' | 'ansi:magenta' | 'ansi:cyan' | 'ansi:white' | 'ansi:blackBright' | 'ansi:redBright' | 'ansi:greenBright' | 'ansi:yellowBright' | 'ansi:blueBright' | 'ansi:magentaBright' | 'ansi:cyanBright' | 'ansi:whiteBright';
/** Raw color value - not a theme key */
export type Color = RGBColor | HexColor | Ansi256Color | AnsiColor;
/**
 * Structured text styling properties.
 * Used to style text without relying on ANSI string transforms.
 * Colors are raw values - theme resolution happens at the component layer.
 */
export type TextStyles = {
    readonly color?: Color;
    readonly backgroundColor?: Color;
    readonly dim?: boolean;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    readonly inverse?: boolean;
};
/**
 * Layout and text styles applied to an element: text wrapping, positioning,
 * margins, padding, flex properties, dimensions, borders, gaps, and overflow.
 * All properties are optional; unset ones keep their defaults.
 */
export type Styles = {
    readonly textWrap?: 'wrap' | 'wrap-trim' | 'end' | 'middle' | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start';
    readonly position?: 'absolute' | 'relative';
    readonly top?: number | `${number}%`;
    readonly bottom?: number | `${number}%`;
    readonly left?: number | `${number}%`;
    readonly right?: number | `${number}%`;
    /**
     * Size of the gap between an element's columns.
     */
    readonly columnGap?: number;
    /**
     * Size of the gap between element's rows.
     */
    readonly rowGap?: number;
    /**
     * Size of the gap between an element's columns and rows. Shorthand for `columnGap` and `rowGap`.
     */
    readonly gap?: number;
    /**
     * Margin on all sides. Equivalent to setting `marginTop`, `marginBottom`, `marginLeft` and `marginRight`.
     */
    readonly margin?: number;
    /**
     * Horizontal margin. Equivalent to setting `marginLeft` and `marginRight`.
     */
    readonly marginX?: number;
    /**
     * Vertical margin. Equivalent to setting `marginTop` and `marginBottom`.
     */
    readonly marginY?: number;
    /**
     * Top margin.
     */
    readonly marginTop?: number;
    /**
     * Bottom margin.
     */
    readonly marginBottom?: number;
    /**
     * Left margin.
     */
    readonly marginLeft?: number;
    /**
     * Right margin.
     */
    readonly marginRight?: number;
    /**
     * Padding on all sides. Equivalent to setting `paddingTop`, `paddingBottom`, `paddingLeft` and `paddingRight`.
     */
    readonly padding?: number;
    /**
     * Horizontal padding. Equivalent to setting `paddingLeft` and `paddingRight`.
     */
    readonly paddingX?: number;
    /**
     * Vertical padding. Equivalent to setting `paddingTop` and `paddingBottom`.
     */
    readonly paddingY?: number;
    /**
     * Top padding.
     */
    readonly paddingTop?: number;
    /**
     * Bottom padding.
     */
    readonly paddingBottom?: number;
    /**
     * Left padding.
     */
    readonly paddingLeft?: number;
    /**
     * Right padding.
     */
    readonly paddingRight?: number;
    /**
     * This property defines the ability for a flex item to grow if necessary.
     * See [flex-grow](https://css-tricks.com/almanac/properties/f/flex-grow/).
     */
    readonly flexGrow?: number;
    /**
     * It specifies the “flex shrink factor”, which determines how much the flex item will shrink relative to the rest of the flex items in the flex container when there isn’t enough space on the row.
     * See [flex-shrink](https://css-tricks.com/almanac/properties/f/flex-shrink/).
     */
    readonly flexShrink?: number;
    /**
     * It establishes the main-axis, thus defining the direction flex items are placed in the flex container.
     * See [flex-direction](https://css-tricks.com/almanac/properties/f/flex-direction/).
     */
    readonly flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
    /**
     * It specifies the initial size of the flex item, before any available space is distributed according to the flex factors.
     * See [flex-basis](https://css-tricks.com/almanac/properties/f/flex-basis/).
     */
    readonly flexBasis?: number | string;
    /**
     * It defines whether the flex items are forced in a single line or can be flowed into multiple lines. If set to multiple lines, it also defines the cross-axis which determines the direction new lines are stacked in.
     * See [flex-wrap](https://css-tricks.com/almanac/properties/f/flex-wrap/).
     */
    readonly flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
    /**
     * The align-items property defines the default behavior for how items are laid out along the cross axis (perpendicular to the main axis).
     * See [align-items](https://css-tricks.com/almanac/properties/a/align-items/).
     */
    readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch';
    /**
     * It makes possible to override the align-items value for specific flex items.
     * See [align-self](https://css-tricks.com/almanac/properties/a/align-self/).
     */
    readonly alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto';
    /**
     * It defines the alignment along the main axis.
     * See [justify-content](https://css-tricks.com/almanac/properties/j/justify-content/).
     */
    readonly justifyContent?: 'flex-start' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly' | 'center';
    /**
     * Width of the element in spaces.
     * You can also set it in percent, which will calculate the width based on the width of parent element.
     */
    readonly width?: number | string;
    /**
     * Height of the element in lines (rows).
     * You can also set it in percent, which will calculate the height based on the height of parent element.
     */
    readonly height?: number | string;
    /**
     * Sets a minimum width of the element.
     */
    readonly minWidth?: number | string;
    /**
     * Sets a minimum height of the element.
     */
    readonly minHeight?: number | string;
    /**
     * Sets a maximum width of the element.
     */
    readonly maxWidth?: number | string;
    /**
     * Sets a maximum height of the element.
     */
    readonly maxHeight?: number | string;
    /**
     * Set this property to `none` to hide the element.
     */
    readonly display?: 'flex' | 'none';
    /**
     * Add a border with a specified style.
     * If `borderStyle` is `undefined` (which it is by default), no border will be added.
     */
    readonly borderStyle?: BorderStyle;
    /**
     * Determines whether top border is visible.
     *
     * @default true
     */
    readonly borderTop?: boolean;
    /**
     * Determines whether bottom border is visible.
     *
     * @default true
     */
    readonly borderBottom?: boolean;
    /**
     * Determines whether left border is visible.
     *
     * @default true
     */
    readonly borderLeft?: boolean;
    /**
     * Determines whether right border is visible.
     *
     * @default true
     */
    readonly borderRight?: boolean;
    /**
     * Change border color.
     * Shorthand for setting `borderTopColor`, `borderRightColor`, `borderBottomColor` and `borderLeftColor`.
     */
    readonly borderColor?: Color;
    /**
     * Change top border color.
     * Accepts raw color values (rgb, hex, ansi).
     */
    readonly borderTopColor?: Color;
    /**
     * Change bottom border color.
     * Accepts raw color values (rgb, hex, ansi).
     */
    readonly borderBottomColor?: Color;
    /**
     * Change left border color.
     * Accepts raw color values (rgb, hex, ansi).
     */
    readonly borderLeftColor?: Color;
    /**
     * Change right border color.
     * Accepts raw color values (rgb, hex, ansi).
     */
    readonly borderRightColor?: Color;
    /**
     * Dim the border color.
     * Shorthand for setting `borderTopDimColor`, `borderBottomDimColor`, `borderLeftDimColor` and `borderRightDimColor`.
     *
     * @default false
     */
    readonly borderDimColor?: boolean;
    /**
     * Dim the top border color.
     *
     * @default false
     */
    readonly borderTopDimColor?: boolean;
    /**
     * Dim the bottom border color.
     *
     * @default false
     */
    readonly borderBottomDimColor?: boolean;
    /**
     * Dim the left border color.
     *
     * @default false
     */
    readonly borderLeftDimColor?: boolean;
    /**
     * Dim the right border color.
     *
     * @default false
     */
    readonly borderRightDimColor?: boolean;
    /**
     * Add text within the border. Only applies to top or bottom borders.
     */
    readonly borderText?: BorderTextOptions;
    /**
     * Background color for the box. Fills the interior with background-colored
     * spaces and is inherited by child text nodes as their default background.
     */
    readonly backgroundColor?: Color;
    /**
     * Fill the box's interior (padding included) with spaces before
     * rendering children, so nothing behind it shows through. Like
     * `backgroundColor` but without emitting any SGR — the terminal's
     * default background is used. Useful for absolute-positioned overlays
     * where Box padding/gaps would otherwise be transparent.
     */
    readonly opaque?: boolean;
    /**
     * Behavior for an element's overflow in both directions.
     * 'scroll' constrains the container's size (children do not expand it)
     * and enables scrollTop-based virtualized scrolling at render time.
     *
     * @default 'visible'
     */
    readonly overflow?: 'visible' | 'hidden' | 'scroll';
    /**
     * Behavior for an element's overflow in horizontal direction.
     *
     * @default 'visible'
     */
    readonly overflowX?: 'visible' | 'hidden' | 'scroll';
    /**
     * Behavior for an element's overflow in vertical direction.
     *
     * @default 'visible'
     */
    readonly overflowY?: 'visible' | 'hidden' | 'scroll';
    /**
     * Exclude this box's cells from text selection in fullscreen mode.
     * Cells inside this region are skipped by both the selection highlight
     * and the copied text — useful for fencing off gutters (line numbers,
     * diff sigils) so click-drag over a diff yields clean copyable code.
     * Only affects alt-screen text selection; no-op otherwise.
     *
     * `'from-left-edge'` extends the exclusion from column 0 to the box's
     * right edge for every row it occupies — this covers any upstream
     * indentation (tool message prefix, tree lines) so a multi-row drag
     * doesn't pick up leading whitespace from middle rows.
     */
    readonly noSelect?: boolean | 'from-left-edge';
};
/**
 * Apply a style diff to a layout node, delegating each property group to its
 * Yoga setter. The node's styles must already be applied elsewhere; `style`
 * may be a diff containing only changed properties.
 * @param node - the layout node to style.
 * @param style - the styles to apply; defaults to an empty object.
 * @param resolvedStyle - the node's full current styles, used to resolve border side values.
 */
declare const styles: (node: LayoutNode, style?: Styles, resolvedStyle?: Styles) => void;
export default styles;
//# sourceMappingURL=styles.d.ts.map