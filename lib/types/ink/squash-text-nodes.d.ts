import type { DOMElement } from './dom.js';
import type { TextStyles } from './styles.js';
/**
 * A segment of text with its associated styles.
 * Used for structured rendering without ANSI string transforms.
 */
export type StyledSegment = {
    text: string;
    styles: TextStyles;
    hyperlink?: string;
};
/**
 * Squash text nodes into styled segments, propagating styles down through the tree.
 * This allows structured styling without relying on ANSI string transforms.
 * @param node - the subtree root whose text nodes are collected.
 * @param inheritedStyles - styles inherited from ancestors, merged with the node's own.
 * @param inheritedHyperlink - the hyperlink inherited from ancestor ink-link elements.
 * @param out - the array segments are appended to; defaults to a fresh array.
 * @returns `out` containing one segment per non-empty text node.
 */
export declare function squashTextNodesToSegments(node: DOMElement, inheritedStyles?: TextStyles, inheritedHyperlink?: string, out?: StyledSegment[]): StyledSegment[];
/**
 * Squash text nodes into a plain string (without styles).
 * Used for text measurement in layout calculations.
 * @param node - the subtree root whose text nodes are concatenated.
 * @returns the concatenated text content of every text node in the subtree.
 */
declare function squashTextNodes(node: DOMElement): string;
export default squashTextNodes;
//# sourceMappingURL=squash-text-nodes.d.ts.map