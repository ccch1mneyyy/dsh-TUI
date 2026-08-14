/**
 * Squash text nodes into styled segments, propagating styles down through the tree.
 * This allows structured styling without relying on ANSI string transforms.
 * @param node - the subtree root whose text nodes are collected.
 * @param inheritedStyles - styles inherited from ancestors, merged with the node's own.
 * @param inheritedHyperlink - the hyperlink inherited from ancestor ink-link elements.
 * @param out - the array segments are appended to; defaults to a fresh array.
 * @returns `out` containing one segment per non-empty text node.
 */
export function squashTextNodesToSegments(node, inheritedStyles = {}, inheritedHyperlink, out = []) {
    const mergedStyles = node.textStyles
        ? { ...inheritedStyles, ...node.textStyles }
        : inheritedStyles;
    for (const childNode of node.childNodes) {
        if (childNode === undefined) {
            continue;
        }
        if (childNode.nodeName === '#text') {
            if (childNode.nodeValue.length > 0) {
                out.push({
                    text: childNode.nodeValue,
                    styles: mergedStyles,
                    hyperlink: inheritedHyperlink,
                });
            }
        }
        else if (childNode.nodeName === 'ink-text' ||
            childNode.nodeName === 'ink-virtual-text') {
            squashTextNodesToSegments(childNode, mergedStyles, inheritedHyperlink, out);
        }
        else if (childNode.nodeName === 'ink-link') {
            const href = childNode.attributes['href'];
            squashTextNodesToSegments(childNode, mergedStyles, href || inheritedHyperlink, out);
        }
    }
    return out;
}
/**
 * Squash text nodes into a plain string (without styles).
 * Used for text measurement in layout calculations.
 * @param node - the subtree root whose text nodes are concatenated.
 * @returns the concatenated text content of every text node in the subtree.
 */
function squashTextNodes(node) {
    let text = '';
    for (const childNode of node.childNodes) {
        if (childNode === undefined) {
            continue;
        }
        if (childNode.nodeName === '#text') {
            text += childNode.nodeValue;
        }
        else if (childNode.nodeName === 'ink-text' ||
            childNode.nodeName === 'ink-virtual-text') {
            text += squashTextNodes(childNode);
        }
        else if (childNode.nodeName === 'ink-link') {
            text += squashTextNodes(childNode);
        }
    }
    return text;
}
export default squashTextNodes;
