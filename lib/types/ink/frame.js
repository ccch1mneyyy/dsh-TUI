import { createScreen, } from './screen.js';
/**
 * Create an empty frame with a zero-size screen, the given viewport, and a
 * visible cursor at the origin.
 * @param rows - the viewport height in rows.
 * @param columns - the viewport width in columns.
 * @param stylePool - the style pool backing the new screen.
 * @param charPool - the character pool backing the new screen.
 * @param hyperlinkPool - the hyperlink pool backing the new screen.
 * @returns a frame with an empty screen and the given viewport.
 */
export function emptyFrame(rows, columns, stylePool, charPool, hyperlinkPool) {
    return {
        screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
        viewport: { width: columns, height: rows },
        cursor: { x: 0, y: 0, visible: true },
    };
}
/**
 * Determines whether the screen should be cleared based on the current and previous frame.
 * Returns the reason for clearing, or undefined if no clear is needed.
 *
 * Screen clearing is triggered when:
 * 1. Terminal has been resized (viewport dimensions changed) → 'resize'
 * 2. Current frame screen height exceeds available terminal rows → 'offscreen'
 * 3. Previous frame screen height exceeded available terminal rows → 'offscreen'
 * @param prevFrame - the previously rendered frame.
 * @param frame - the frame about to be rendered.
 * @returns the clearing reason, or undefined when no clear is needed.
 */
export function shouldClearScreen(prevFrame, frame) {
    const didResize = frame.viewport.height !== prevFrame.viewport.height ||
        frame.viewport.width !== prevFrame.viewport.width;
    if (didResize) {
        return 'resize';
    }
    const currentFrameOverflows = frame.screen.height >= frame.viewport.height;
    const previousFrameOverflowed = prevFrame.screen.height >= prevFrame.viewport.height;
    if (currentFrameOverflows || previousFrameOverflowed) {
        return 'offscreen';
    }
    return undefined;
}
