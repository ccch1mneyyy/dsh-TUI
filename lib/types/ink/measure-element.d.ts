import type { DOMElement } from './dom.js';
type Output = {
    /**
     * Element width.
     */
    width: number;
    /**
     * Element height.
     */
    height: number;
};
/**
 * Measure the rendered dimensions of a Box element.
 * @param node - the DOM element to measure.
 * @returns the element's computed width and height, or zeros before layout.
 */
declare const measureElement: (node: DOMElement) => Output;
export default measureElement;
//# sourceMappingURL=measure-element.d.ts.map