import type { Cursor } from './cursor.js';
import type { Size } from './layout/geometry.js';
import type { ScrollHint } from './render-node-to-output.js';
import { type CharPool, type HyperlinkPool, type Screen, type StylePool } from './screen.js';
/**
 * A complete rendered frame: the painted screen buffer plus the viewport
 * size and cursor position for this render.
 */
export type Frame = {
    readonly screen: Screen;
    readonly viewport: Size;
    readonly cursor: Cursor;
    /** DECSTBM scroll optimization hint (alt-screen only, null otherwise). */
    readonly scrollHint?: ScrollHint | null;
    /** A ScrollBox has remaining pendingScrollDelta — schedule another frame. */
    readonly scrollDrainPending?: boolean;
};
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
export declare function emptyFrame(rows: number, columns: number, stylePool: StylePool, charPool: CharPool, hyperlinkPool: HyperlinkPool): Frame;
/** The reason a full screen clear is triggered: viewport resize, content overflowing the terminal, or an explicit clear. */
export type FlickerReason = 'resize' | 'offscreen' | 'clear';
/**
 * Timing and flicker telemetry for one rendered frame, reported through
 * the onFrame option when frame-timing instrumentation is enabled.
 */
export type FrameEvent = {
    durationMs: number;
    /** Phase breakdown in ms + patch count. Populated when the ink instance
     *  has frame-timing instrumentation enabled (via onFrame wiring). */
    phases?: {
        /** createRenderer output: DOM → yoga layout → screen buffer */
        renderer: number;
        /** LogUpdate.render(): screen diff → Patch[] (the hot path this PR optimizes) */
        diff: number;
        /** optimize(): patch merge/dedupe */
        optimize: number;
        /** writeDiffToTerminal(): serialize patches → ANSI → stdout */
        write: number;
        /** Pre-optimize patch count (proxy for how much changed this frame) */
        patches: number;
        /** yoga calculateLayout() time (runs in resetAfterCommit, before onRender) */
        yoga: number;
        /** React reconcile time: scrollMutated → resetAfterCommit. 0 if no commit. */
        commit: number;
        /** layoutNode() calls this frame (recursive, includes cache-hit returns) */
        yogaVisited: number;
        /** measureFunc (text wrap/width) calls — the expensive part */
        yogaMeasured: number;
        /** early returns via _hasL single-slot cache */
        yogaCacheHits: number;
        /** total yoga Node instances alive (create - free). Growth = leak. */
        yogaLive: number;
    };
    flickers: Array<{
        desiredHeight: number;
        availableHeight: number;
        reason: FlickerReason;
    }>;
};
/** A single terminal write operation emitted for one frame. */
export type Patch = {
    type: 'stdout';
    content: string;
} | {
    type: 'clear';
    count: number;
} | {
    type: 'clearTerminal';
    reason: FlickerReason;
    debug?: {
        triggerY: number;
        prevLine: string;
        nextLine: string;
    };
} | {
    type: 'cursorHide';
} | {
    type: 'cursorShow';
} | {
    type: 'cursorMove';
    x: number;
    y: number;
} | {
    type: 'cursorTo';
    col: number;
} | {
    type: 'carriageReturn';
} | {
    type: 'hyperlink';
    uri: string;
} | {
    type: 'styleStr';
    str: string;
};
/** The ordered list of patches that update the terminal for one frame. */
export type Diff = Patch[];
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
export declare function shouldClearScreen(prevFrame: Frame, frame: Frame): FlickerReason | undefined;
//# sourceMappingURL=frame.d.ts.map