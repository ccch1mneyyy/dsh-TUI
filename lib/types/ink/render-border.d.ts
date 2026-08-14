import { type Boxes, type BoxStyle } from 'cli-boxes';
import type { DOMNode } from './dom.js';
import type Output from './output.js';
/** Options for embedding a text label into a border line. */
export type BorderTextOptions = {
    content: string;
    position: 'top' | 'bottom';
    align: 'start' | 'end' | 'center';
    offset?: number;
};
/** Built-in border styles beyond those provided by cli-boxes. */
export declare const CUSTOM_BORDER_STYLES: {
    readonly dashed: {
        readonly top: "╌";
        readonly left: "╎";
        readonly right: "╎";
        readonly bottom: "╌";
        readonly topLeft: " ";
        readonly topRight: " ";
        readonly bottomLeft: " ";
        readonly bottomRight: " ";
    };
};
/** A border style: a cli-boxes key, a custom style key, or an explicit box style. */
export type BorderStyle = keyof Boxes | keyof typeof CUSTOM_BORDER_STYLES | BoxStyle;
/**
 * Render the node's border, including any embedded border text, into the
 * output buffer when a border style is set.
 * @param x - the border's left column.
 * @param y - the border's top row.
 * @param node - the node whose border style to render.
 * @param output - the output buffer receiving the border writes.
 */
declare const renderBorder: (x: number, y: number, node: DOMNode, output: Output) => void;
export default renderBorder;
//# sourceMappingURL=render-border.d.ts.map