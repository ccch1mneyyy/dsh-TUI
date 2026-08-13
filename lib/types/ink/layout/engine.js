import { createYogaLayoutNode } from './yoga.js';
/**
 * Create a new layout node backed by the Yoga adapter.
 * @returns an empty layout node with no children, styles, or measure function.
 */
export function createLayoutNode() {
    return createYogaLayoutNode();
}
