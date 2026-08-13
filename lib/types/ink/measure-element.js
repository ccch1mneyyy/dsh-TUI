/**
 * Measure the rendered dimensions of a Box element.
 * @param node - the DOM element to measure.
 * @returns the element's computed width and height, or zeros before layout.
 */
const measureElement = (node) => ({
    width: node.yogaNode?.getComputedWidth() ?? 0,
    height: node.yogaNode?.getComputedHeight() ?? 0,
});
export default measureElement;
