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
const COMMAND_CLIP = 500;
/**
 * Recover the gated command from the session log: the approval request
 * links to an already-presented tool call via `callId`, so the arguments
 * are not duplicated on the request. Mirrors the web client's `commandOf`.
 * @param req - The pending approval request.
 * @returns The `command` argument when present, else the raw arguments
 *   string (clipped), else undefined when the call cannot be found.
 */
function commandOf(req) {
    if (req.callId === undefined)
        return undefined;
    const events = req.agent.session.events;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event.type !== 'tool/call')
            continue;
        if (String(event.data.callId) !== String(req.callId))
            continue;
        const raw = event.data.arguments;
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
                const command = parsed.command;
                if (typeof command === 'string')
                    return command;
            }
        }
        catch {
            // Not JSON — fall through to the raw string.
        }
        return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
    }
    return undefined;
}
/**
 * Approval store: parks asks from the harness's approval seam, surfaces
 * one at a time to the TUI, and settles each ask when the user decides or
 * the ask is withdrawn. The TUI subscribes for re-renders and decides via
 * {@link ApprovalStore.decide}.
 */
export class ApprovalStore {
    queue = [];
    active;
    listeners = new Set();
    seq = 0;
    /**
     * Cached snapshot: useSyncExternalStore requires a stable reference while
     * nothing changed (a fresh object per call would loop re-renders).
     */
    snapshotCache = null;
    /**
     * Subscribe to store changes (useSyncExternalStore contract).
     * @param listener - Called after every mutation that changes the snapshot.
     * @returns An unsubscribe function removing the listener.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * The approval the TUI should render now, or null when idle.
     * @returns The cached snapshot; the reference is stable between mutations.
     */
    getSnapshot() {
        return this.snapshotCache;
    }
    emit() {
        for (const listener of this.listeners)
            listener();
    }
    /** Rebuild the cached snapshot after any mutation of active. */
    rebuildSnapshot() {
        const pending = this.active;
        this.snapshotCache = pending === undefined
            ? null
            : { key: pending.key, ...pending.snapshot };
    }
    /**
     * Answerer entry point — called by the `approval/request` waterfall
     * listener when the ask concerns the agent this TUI owns.
     * @param req - The approval request (agent, tool, callId, reason, signal).
     * @returns A promise settling with the user's decision, or `'cancelled'`
     *   when the ask is withdrawn or the plugin tears down.
     */
    park(req) {
        return new Promise(resolve => {
            const command = commandOf(req);
            const pending = {
                key: String(++this.seq),
                snapshot: {
                    toolName: req.toolName,
                    ...(req.reason !== undefined ? { reason: req.reason } : {}),
                    ...(command !== undefined ? { command } : {}),
                },
                resolve,
                onAbort: () => {
                    if (this.active === pending) {
                        this.active = undefined;
                        this.rebuildSnapshot();
                        pending.resolve('cancelled');
                        this.startNext();
                        return;
                    }
                    const at = this.queue.indexOf(pending);
                    if (at >= 0)
                        this.queue.splice(at, 1);
                    pending.resolve('cancelled');
                },
            };
            req.signal?.addEventListener('abort', pending.onAbort, { once: true });
            this.queue.push(pending);
            this.startNext();
        });
    }
    /** Advance to the next queued ask, if any. */
    startNext() {
        if (this.active !== undefined || this.queue.length === 0)
            return;
        this.active = this.queue.shift();
        this.rebuildSnapshot();
        this.emit();
    }
    /**
     * The user decided on the current approval; settles it and drains the
     * next queued ask if any. No-op when nothing is pending.
     * @param outcome - `'allowed-once'` or `'rejected'`.
     */
    decide(outcome) {
        const pending = this.active;
        if (pending === undefined)
            return;
        this.active = undefined;
        this.rebuildSnapshot();
        pending.resolve(outcome);
        this.startNext();
        this.emit();
    }
    /**
     * Settle the active and all queued asks (plugin teardown). The panel
     * unmounts as the snapshot clears.
     * @param outcome - The outcome every pending ask resolves with.
     */
    settleAll(outcome) {
        const active = this.active;
        this.active = undefined;
        this.rebuildSnapshot();
        active?.resolve(outcome);
        for (const pending of this.queue.splice(0))
            pending.resolve(outcome);
        this.emit();
    }
}
