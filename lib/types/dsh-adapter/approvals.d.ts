/**
 * Approval store — the UI-side answerer half of the DSH approval seam
 * (`ctx.approval`). The harness's permission layer asks
 * `ApprovalService.request()`, which dispatches an `approval/request`
 * waterfall; the listener registered in plugin.ts parks the request here,
 * surfaces one ask at a time to the TUI (Claude Code style permission
 * prompt), and settles the harness promise when the user decides, the
 * asker's abort signal fires, or the plugin tears down.
 *
 * Queue semantics mirror QuestionStore: parallel tool calls can trigger
 * several asks before any answer is given, so asks are drained FIFO.
 * Outcomes are the protocol's closed set — `'allowed-once'` and
 * `'rejected'` from the panel, `'cancelled'` on abort/teardown; there is
 * no allow-always or feedback channel in the protocol.
 */
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
/** What the TUI renders while an approval is pending. */
export interface ApprovalSnapshot {
    /** Stable key so the panel remounts (fresh focus state) per request. */
    readonly key: string;
    readonly toolName: string;
    /** The asker's human-readable explanation, when given. */
    readonly reason?: string;
    /** The gated command, recovered from the paired tool/call event. */
    readonly command?: string;
}
/**
 * Approval store: parks asks from the harness's approval seam, surfaces
 * one at a time to the TUI, and settles each ask when the user decides or
 * the ask is withdrawn. The TUI subscribes for re-renders and decides via
 * {@link ApprovalStore.decide}.
 */
export declare class ApprovalStore {
    private readonly queue;
    private active;
    private readonly listeners;
    private seq;
    /**
     * Cached snapshot: useSyncExternalStore requires a stable reference while
     * nothing changed (a fresh object per call would loop re-renders).
     */
    private snapshotCache;
    /**
     * Subscribe to store changes (useSyncExternalStore contract).
     * @param listener - Called after every mutation that changes the snapshot.
     * @returns An unsubscribe function removing the listener.
     */
    subscribe(listener: () => void): () => void;
    /**
     * The approval the TUI should render now, or null when idle.
     * @returns The cached snapshot; the reference is stable between mutations.
     */
    getSnapshot(): ApprovalSnapshot | null;
    private emit;
    /** Rebuild the cached snapshot after any mutation of active. */
    private rebuildSnapshot;
    /**
     * Answerer entry point — called by the `approval/request` waterfall
     * listener when the ask concerns the agent this TUI owns.
     * @param req - The approval request (agent, tool, callId, reason, signal).
     * @returns A promise settling with the user's decision, or `'cancelled'`
     *   when the ask is withdrawn or the plugin tears down.
     */
    park(req: ApprovalRequest): Promise<ApprovalOutcome>;
    /** Advance to the next queued ask, if any. */
    private startNext;
    /**
     * The user decided on the current approval; settles it and drains the
     * next queued ask if any. No-op when nothing is pending.
     * @param outcome - `'allowed-once'` or `'rejected'`.
     */
    decide(outcome: 'allowed-once' | 'rejected'): void;
    /**
     * Settle the active and all queued asks (plugin teardown). The panel
     * unmounts as the snapshot clears.
     * @param outcome - The outcome every pending ask resolves with.
     */
    settleAll(outcome: ApprovalOutcome): void;
}
//# sourceMappingURL=approvals.d.ts.map