import type { Diff, Frame } from './frame.js';
import { type StylePool } from './screen.js';
type Options = {
    isTTY: boolean;
    stylePool: StylePool;
};
/**
 * Converts frame diffs into terminal write patches. Holds per-instance
 * state (previous output, style pool, TTY mode) across frames.
 */
export declare class LogUpdate {
    private readonly options;
    private state;
    constructor(options: Options);
    /**
     * Request a one-shot viewport re-anchor on the next main-screen frame.
     *
     * The main-screen diff engine addresses rows purely relative to where it
     * left the cursor — it has no absolute anchor and no way to notice when a
     * third party moved it. A subprocess writing directly to the tty (an MCP
     * server's stderr, a stray native log line — issue #17) advances the
     * cursor and scrolls the terminal; every subsequent diff then lands N
     * rows off, garbling the UI (missing labels, shifted rows — issue #16)
     * until some full repaint happens to run. There is nothing to detect
     * after the fact (a newline-terminated write parks the cursor back at
     * the bottom column 0, exactly where the engine expects it), so the
     * recovery is a blind idempotent repaint: rebuild the viewport from the
     * physical cursor position, which re-syncs the virtual↔physical mapping
     * no matter how far they had drifted. Wired to the stdin-gap reassert
     * (>5s idle then a keypress) — the same trigger that re-asserts DEC
     * modes after tmux attach / ssh reconnect.
     */
    requestViewportReanchor(): void;
    /**
     * Render the terminal state for a finished run, for streams that no
     * longer support string output.
     * @param prevFrame - the previously rendered frame.
     * @returns the patches that restore the terminal to the previous frame's state.
     */
    renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff;
    /** Drop the previous-output state after the process resumes from suspension (SIGCONT) so terminal content is not clobbered. */
    reset(): void;
    private renderFullFrame;
    private getRenderOpsForDone;
    /**
     * Diff the previous and next frames and produce the patches that update
     * the terminal from one to the other.
     * @param prev - the previously rendered frame.
     * @param next - the frame to render.
     * @param altScreen - whether the frame renders to the alternate screen.
     * @param decstbmSafe - whether the DECSTBM scroll sequence can be made atomic (DEC 2026 / BSU/ESU).
     * @returns the terminal write patches.
     */
    render(prev: Frame, next: Frame, altScreen?: boolean, decstbmSafe?: boolean): Diff;
}
export {};
//# sourceMappingURL=log-update.d.ts.map