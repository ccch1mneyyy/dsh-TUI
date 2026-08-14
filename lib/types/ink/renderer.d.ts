import { type DOMElement } from './dom.js';
import type { Frame } from './frame.js';
import { type StylePool } from './screen.js';
/** Options controlling one renderer pass over the DOM tree. */
export type RenderOptions = {
    frontFrame: Frame;
    backFrame: Frame;
    isTTY: boolean;
    terminalWidth: number;
    terminalRows: number;
    altScreen: boolean;
    prevFrameContaminated: boolean;
};
/** Renders the DOM tree into a frame for the given options. */
export type Renderer = (options: RenderOptions) => Frame;
/**
 * Create the renderer function for a root DOM node. The returned renderer
 * reuses an Output across frames so its character cache persists.
 * @param node - the root DOM node to render.
 * @param stylePool - the style pool used for all frames.
 * @returns a function that renders one frame from the given options.
 */
export default function createRenderer(node: DOMElement, stylePool: StylePool): Renderer;
//# sourceMappingURL=renderer.d.ts.map