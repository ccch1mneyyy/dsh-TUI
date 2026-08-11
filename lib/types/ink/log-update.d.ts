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