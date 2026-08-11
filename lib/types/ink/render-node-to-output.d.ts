import type { DOMElement } from './dom.js';
import type Output from './output.js';
import type { Screen } from './screen.js';
import { type StyledSegment } from './squash-text-nodes.js';
import type { Color } from './styles.js';
/** Reset the per-frame layout-shift flag. */
export declare function resetLayoutShifted(): void;
/**
 * Whether any node's layout position or size shifted this frame, or a child was removed.
 * @returns true when the full-damage path is needed this frame.
 */
export declare function didLayoutShift(): boolean;
/**
 * DECSTBM scroll optimization hint: when a ScrollBox's scrollTop changed
 * between frames and nothing else moved, log-update.ts can emit a hardware
 * scroll (DECSTBM + SU/SD) instead of rewriting the whole viewport.
 * top/bottom are 0-indexed inclusive screen rows; delta > 0 means content
 * moved up (scrollTop increased, CSI n S).
 */
export type ScrollHint = {
    top: number;
    bottom: number;
    delta: number;
};
/** Reset the scroll hint for the next frame and rotate the absolute-rect buffers. */
export declare function resetScrollHint(): void;
/**
 * The scroll hint captured this frame, or null.
 * @returns the scroll hint, or null when none was captured.
 */
export declare function getScrollHint(): ScrollHint | null;
/** Clear the pending scroll drain node for the next frame. */
export declare function resetScrollDrainNode(): void;
/**
 * The ScrollBox node still draining pending scroll delta, or null.
 * @returns the draining ScrollBox node, or null.
 */
export declare function getScrollDrainNode(): DOMElement | null;
/**
 * At-bottom follow scroll recorded this frame: the scroll delta and
 * viewport bounds, consumed by ink.tsx to translate the active text
 * selection so the highlight stays anchored to the text.
 */
export type FollowScroll = {
    delta: number;
    viewportTop: number;
    viewportBottom: number;
};
/**
 * Read and clear the follow-scroll event recorded this frame.
 * @returns the follow-scroll delta and viewport bounds, or null.
 */
export declare function consumeFollowScroll(): FollowScroll | null;
/**
 * Build a mapping from each character position in the plain text to its segment index.
 * Returns an array where charToSegment[i] is the segment index for character i.
 * @param segments - the styled segments whose characters to map.
 * @returns an array mapping each plain-text character index to its segment index.
 */
declare function buildCharToSegmentMap(segments: StyledSegment[]): number[];
/**
 * Apply styles to wrapped text by mapping each character back to its original segment.
 * This preserves per-segment styles even when text wraps across lines.
 * @param wrappedPlain - the wrapped plain text to style.
 * @param segments - the original styled segments.
 * @param charToSegment - character-to-segment index map for the original plain text.
 * @param originalPlain - the original unwrapped plain text.
 * @param trimEnabled - Whether whitespace trimming is enabled (wrap-trim mode).
 *   When true, we skip whitespace in the original that was trimmed from the output.
 *   When false (wrap mode), all whitespace is preserved so no skipping is needed.
 * @returns the styled wrapped text.
 */
declare function applyStylesToWrappedText(wrappedPlain: string, segments: StyledSegment[], charToSegment: number[], originalPlain: string, trimEnabled?: boolean): string;
/**
 * Render a laid-out node subtree into the output buffer.
 * After yoga lays out the tree, each node is painted to the output object,
 * which later gets written to the terminal.
 * @param node - the DOM node to render.
 * @param output - the output buffer receiving paint operations.
 * @param options - render options: the child coordinate offset, the
 *   previous frame's screen for blitting, whether to skip the node's own
 *   blit, and the inherited background color.
 */
declare function renderNodeToOutput(node: DOMElement, output: Output, options: {
    offsetX?: number;
    offsetY?: number;
    prevScreen: Screen | undefined;
    skipSelfBlit?: boolean;
    inheritedBackgroundColor?: Color;
}): void;
export { buildCharToSegmentMap, applyStylesToWrappedText };
export default renderNodeToOutput;
//# sourceMappingURL=render-node-to-output.d.ts.map