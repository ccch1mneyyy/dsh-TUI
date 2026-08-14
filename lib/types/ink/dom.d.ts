import type { FocusManager } from './focus.js';
import type { LayoutNode } from './layout/node.js';
import type { Styles, TextStyles } from './styles.js';
type InkNode = {
    parentNode: DOMElement | undefined;
    yogaNode?: LayoutNode;
    style: Styles;
};
/**
 * Node name of a text node in the ink DOM.
 */
export type TextName = '#text';
/**
 * Names of the element node kinds the ink DOM supports.
 */
export type ElementNames = 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text' | 'ink-link' | 'ink-progress' | 'ink-raw-ansi';
/**
 * Union of every node name in the ink DOM: element names plus `#text`.
 */
export type NodeNames = ElementNames | TextName;
/**
 * An element node in the ink DOM: a named, styled container holding child
 * nodes, attributes, layout state, and render hooks.
 */
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
    onStickyRestore?: () => void;
    scrollAnchor?: {
        el: DOMElement;
        offset: number;
    };
    focusManager?: FocusManager;
    debugOwnerChain?: string[];
} & InkNode;
/**
 * A text leaf node in the ink DOM holding a single string value.
 */
export type TextNode = {
    nodeName: TextName;
    nodeValue: string;
} & InkNode;
/**
 * Discriminated union of ink DOM nodes, resolving a node-name-bearing type
 * to TextNode for `#text` and DOMElement otherwise.
 */
export type DOMNode<T = {
    nodeName: NodeNames;
}> = T extends {
    nodeName: infer U;
} ? U extends '#text' ? TextNode : DOMElement : never;
/**
 * Attribute values storable on an ink DOM element.
 */
export type DOMNodeAttribute = boolean | string | number;
/**
 * Create an element node of the given kind, allocating its yoga layout node
 * unless the kind renders without layout (`ink-virtual-text`, `ink-link`,
 * `ink-progress`).
 * @param nodeName - the element kind to create.
 * @returns the new element node.
 */
export declare const createNode: (nodeName: ElementNames) => DOMElement;
/**
 * Append a child element to a parent, moving it from its current parent if
 * any and keeping the yoga tree in sync.
 * @param node - the parent element.
 * @param childNode - the element to append.
 */
export declare const appendChildNode: (node: DOMElement, childNode: DOMElement) => void;
/**
 * Insert a child before an existing sibling, moving it from its current
 * parent if any and keeping the yoga tree in sync. Nodes without a yoga
 * node do not affect yoga indices.
 * @param node - the parent element.
 * @param newChildNode - the node to insert.
 * @param beforeChildNode - the sibling the new node is inserted before;
 *   when absent from the parent, the new node is appended.
 */
export declare const insertBeforeNode: (node: DOMElement, newChildNode: DOMNode, beforeChildNode: DOMNode) => void;
/**
 * Remove a child node from a parent, clearing its yoga node, cached rects,
 * and parent reference.
 * @param node - the parent element.
 * @param removeNode - the child node to remove.
 */
export declare const removeChildNode: (node: DOMElement, removeNode: DOMNode) => void;
/**
 * Set an attribute on an element, skipping `children` and unchanged values
 * so unrelated renders do not mark the node dirty.
 * @param node - the element to update.
 * @param key - the attribute name.
 * @param value - the attribute value.
 */
export declare const setAttribute: (node: DOMElement, key: string, value: DOMNodeAttribute) => void;
/**
 * Replace an element's style, skipping the write when the new style is
 * shallow-equal to the current one to avoid needless dirty marks.
 * @param node - the node to update.
 * @param style - the new style object.
 */
export declare const setStyle: (node: DOMNode, style: Styles) => void;
/**
 * Replace an element's text styles, skipping the write when the new styles
 * are shallow-equal to the current ones to avoid needless dirty marks.
 * @param node - the element to update.
 * @param textStyles - the new text styles.
 */
export declare const setTextStyles: (node: DOMElement, textStyles: TextStyles) => void;
/**
 * Create a text node holding the given string.
 * @param text - the text content.
 * @returns the new text node.
 */
export declare const createTextNode: (text: string) => TextNode;
/**
 * Mark a node and all its ancestors as dirty for re-rendering.
 * Also marks yoga dirty for text remeasurement if this is a text node.
 * @param node - the node whose dirty chain to mark; a no-op when undefined.
 */
export declare const markDirty: (node?: DOMNode) => void;
/**
 * Walk to the root and call its onRender (the throttled scheduleRender).
 * Use for DOM-level mutations (scrollTop changes) that should trigger an
 * Ink frame without going through React's reconciler. Pair with markDirty()
 * so the renderer knows which subtree to re-evaluate.
 * @param node - the node to walk up from; a no-op when undefined.
 */
export declare const scheduleRenderFrom: (node?: DOMNode) => void;
/**
 * Replace a text node's value, skipping the write when unchanged and
 * marking the node dirty otherwise.
 * @param node - the text node to update.
 * @param text - the new text value; non-strings are stringified.
 */
export declare const setTextNodeValue: (node: TextNode, text: string) => void;
/**
 * Clear yogaNode references on a node and its whole subtree before freeing.
 * freeRecursive() frees the node and ALL its children, so every reference
 * must be cleared to prevent dangling pointers.
 * @param node - the node whose subtree to clear.
 */
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
 * @param root - the ink-root element to search from.
 * @param y - the screen row to locate.
 * @returns the debugOwnerChain of the deepest node containing `y`, or an
 *   empty array when none is recorded.
 */
export declare function findOwnerChainAtRow(root: DOMElement, y: number): string[];
export {};
//# sourceMappingURL=dom.d.ts.map