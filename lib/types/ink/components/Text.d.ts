import type { ReactNode } from 'react';
import type { Color, Styles } from '../styles.js';
type BaseProps = {
    /**
     * Change text color. Accepts a raw color value (rgb, hex, ansi).
     */
    readonly color?: Color;
    /**
     * Same as `color`, but for background.
     */
    readonly backgroundColor?: Color;
    /**
     * Make the text italic.
     */
    readonly italic?: boolean;
    /**
     * Make the text underlined.
     */
    readonly underline?: boolean;
    /**
     * Make the text crossed with a line.
     */
    readonly strikethrough?: boolean;
    /**
     * Inverse background and foreground colors.
     */
    readonly inverse?: boolean;
    /**
     * This property tells Ink to wrap or truncate text if its width is larger than container.
     * If `wrap` is passed (by default), Ink will wrap text and split it into multiple lines.
     * If `truncate-*` is passed, Ink will truncate text instead, which will result in one line of text with the rest cut off.
     */
    readonly wrap?: Styles['textWrap'];
    readonly children?: ReactNode;
};
/**
 * Bold and dim are mutually exclusive in terminals.
 * This type ensures you can use one or the other, but not both.
 */
type WeightProps = {
    bold?: never;
    dim?: never;
} | {
    bold: boolean;
    dim?: never;
} | {
    dim: boolean;
    bold?: never;
};
export type Props = BaseProps & WeightProps;
/**
 * This component can display text, and change its style to make it colorful, bold, underline, italic or strikethrough.
 */
export default function Text(t0: any): any;
export {};
//# sourceMappingURL=Text.d.ts.map