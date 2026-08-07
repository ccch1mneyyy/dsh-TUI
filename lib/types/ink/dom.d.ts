import type { FocusManager } from './focus.js';
import type { LayoutNode } from './layout/node.js';
import type { Styles, TextStyles } from './styles.js';
type InkNode = {
    parentNode: DOMElement | undefined;
    yogaNode?: LayoutNode;
    style: Styles;
};
export type TextName = '#text';
export type ElementNames = 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text' | 'ink-link' | 'ink-progress' | 'ink-raw-ansi';
export type NodeNames = ElementNames | TextName;
export type DOMElement = {
    nodeName: ElementNames;
    attributes: Record<string, DOMNodeAttribute>;
    childNodes: DOMNode[];
    textStyles?: TextStyles;
    onComputeLayout?: () => void;
    onRender?: () => void;
    onImmediateRender?: () => void;
    hasRenderedContent?: boolean;
    dirty: boolean;
    isHidden?: boolean;
    _eventHandlers?: Record<string, unknown>;
    scrollTop?: number;
    pendingScrollDelta?: number;
    scrollClampMin?: number;
    scrollClampMax?: number;
    scrollHeight?: number;
    scrollViewportHeight?: number;
    scrollViewportTop?: number;
    scrollPrevMax?: number;
    stickyScroll?: boolean;
    scrollAnchor?: {
        el: DOMElement;
        offset: number;
    };
    focusManager?: FocusManager;
    debugOwnerChain?: string[];
} & InkNode;
export type TextNode = {
    nodeName: TextName;
    nodeValue: string;
} & InkNode;
export type DOMNode<T = {
    nodeName: NodeNames;
}> = T extends {
    nodeName: infer U;
} ? U extends '#text' ? TextNode : DOMElement : never;
export type DOMNodeAttribute = boolean | string | number;
export declare const createNode: (nodeName: ElementNames) => DOMElement;
export declare const appendChildNode: (node: DOMElement, childNode: DOMElement) => void;
export declare const insertBeforeNode: (node: DOMElement, newChildNode: DOMNode, beforeChildNode: DOMNode) => void;
export declare const removeChildNode: (node: DOMElement, removeNode: DOMNode) => void;
export declare const setAttribute: (node: DOMElement, key: string, value: DOMNodeAttribute) => void;
export declare const setStyle: (node: DOMNode, style: Styles) => void;
export declare const setTextStyles: (node: DOMElement, textStyles: TextStyles) => void;
export declare const createTextNode: (text: string) => TextNode;
/**
 * Mark a node and all its ancestors as dirty for re-rendering.
 * Also marks yoga dirty for text remeasurement if this is a text node.
 */
export declare const markDirty: (node?: DOMNode) => void;
export declare const scheduleRenderFrom: (node?: DOMNode) => void;
export declare const setTextNodeValue: (node: TextNode, text: string) => void;
export declare const clearYogaNodeReferences: (node: DOMElement | TextNode) => void;
/**
 * Find the React component stack responsible for content at screen row `y`.
 *
 * DFS the DOM tree accumulating yoga offsets. Returns the debugOwnerChain of
 * the deepest node whose bounding box contains `y`. Called from ink.tsx when
 * log-update triggers a full reset, to attribute the flicker to its source.
 *
 * Only useful when CLAUDE_CODE_DEBUG_REPAINTS is set (otherwise chains are
 * undefined and this returns []).
 */
export declare function findOwnerChainAtRow(root: DOMElement, y: number): string[];
export {};
//# sourceMappingURL=dom.d.ts.map