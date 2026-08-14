/**
 * Ask-user-question store — the UI-side half of the DSH user-interaction
 * seam (`ctx.userQuestions`). The harness's model-facing
 * `ask_user_question` tool calls `UserQuestionService.ask()`, which
 * forwards to the provider registered here; this store parks the request,
 * surfaces one question at a time to the TUI (Claude Code style
 * questionnaire), and settles the harness promise when the user answers,
 * cancels, or the owning tool's abort signal fires.
 *
 * Queue semantics mirror the official dsh-tui chat/questions machine: asks
 * arrive one at a time in practice (the tool blocks until answered), but
 * concurrent asks from subagents are drained FIFO.
 */
import { type AskUserQuestionAnswer, type AskUserQuestionItem, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
/** One answered question as the panel submits it: selected option labels
 *  plus optional free-text (the dsh protocol's "Other" answer). */
export interface QuestionSelection {
    readonly selected: string[];
    readonly custom?: string;
}
/** What the TUI renders while a question is pending. */
export interface QuestionSnapshot {
    /** Stable key so the panel remounts (fresh selection state) per question. */
    readonly key: string;
    readonly question: AskUserQuestionItem;
    /** 1-based position within the batch. */
    readonly position: number;
    /** Total questions in the batch. */
    readonly total: number;
    /** Questions answered before the current one. */
    readonly answered: number;
}
/** Completed batch summary, pushed into the transcript by the caller. */
export interface QuestionSummary {
    readonly title: string;
    readonly lines: readonly string[];
}
/**
 * Ask-user-question store: parks asks from the harness's user-interaction
 * seam, surfaces one question at a time to the TUI, and settles each ask
 * when the user answers or the batch is interrupted. The TUI subscribes for
 * re-renders and answers via {@link QuestionStore.answerCurrent}.
 */
export declare class QuestionStore {
    private readonly queue;
    private active;
    private readonly listeners;
    private batchSeq;
    /** Completed batch summaries, drained by the TUI into the transcript. */
    private summaries;
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
     * The question the TUI should render now, or null when idle.
     * @returns The cached snapshot; the reference is stable between mutations.
     */
    getSnapshot(): QuestionSnapshot | null;
    /**
     * Take (and clear) every completed batch summary for the transcript.
     * @returns The summaries collected since the last take.
     */
    takeSummaries(): QuestionSummary[];
    private emit;
    /** Rebuild the cached snapshot after any mutation of active/index. */
    private rebuildSnapshot;
    /**
     * Provider entry point — called by `ctx.userQuestions.ask()` when the
     * model runs the `ask_user_question` tool.
     * @param request - The ask request: questions plus optional abort signal.
     * @returns A promise settling with the collected answers when the user
     *   submits the batch, or rejecting when the ask is interrupted.
     */
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
    /** Advance to the next queued ask, if any. */
    private startNext;
    /**
     * The user submitted an answer for the current question; advances the
     * batch and settles it once every question is answered.
     * @param selection - Selected option labels plus optional custom text.
     */
    answerCurrent(selection: QuestionSelection): void;
    /** The user interrupted the questionnaire (Esc / Ctrl+C). */
    cancelCurrent(): void;
    /** Reject the active and all queued asks (plugin teardown). */
    rejectAll(): void;
    private fail;
}
//# sourceMappingURL=questions.d.ts.map