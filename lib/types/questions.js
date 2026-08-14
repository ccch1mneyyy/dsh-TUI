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
import { t } from './i18n.js';
import { UserQuestionError, } from '@deepseek-ai/dsh-user-questions';
const ASK_ABORTED = 'ASK_ABORTED';
/** Truncate a long answer line for the transcript summary. */
function clip(text, max = 140) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}…`;
}
function buildSummary(pending) {
    const lines = pending.answers.map(answer => {
        const question = pending.request.questions.find(q => q.id === answer.id);
        const labels = answer.selected.join('、');
        const text = answer.custom !== undefined && answer.custom !== ''
            ? labels === '' ? answer.custom : `${labels}：${answer.custom}`
            : labels;
        return `· ${question?.question ?? answer.id} → ${clip(text)}`;
    });
    const total = pending.request.questions.length;
    return {
        title: t('questionnaire-answered', { total }),
        lines,
    };
}
/**
 * Ask-user-question store: parks asks from the harness's user-interaction
 * seam, surfaces one question at a time to the TUI, and settles each ask
 * when the user answers or the batch is interrupted. The TUI subscribes for
 * re-renders and answers via {@link QuestionStore.answerCurrent}.
 */
export class QuestionStore {
    queue = [];
    active;
    listeners = new Set();
    batchSeq = 0;
    /** Completed batch summaries, drained by the TUI into the transcript. */
    summaries = [];
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
     * The question the TUI should render now, or null when idle.
     * @returns The cached snapshot; the reference is stable between mutations.
     */
    getSnapshot() {
        return this.snapshotCache;
    }
    /**
     * Take (and clear) every completed batch summary for the transcript.
     * @returns The summaries collected since the last take.
     */
    takeSummaries() {
        const summaries = this.summaries;
        this.summaries = [];
        return summaries;
    }
    emit() {
        for (const listener of this.listeners)
            listener();
    }
    /** Rebuild the cached snapshot after any mutation of active/index. */
    rebuildSnapshot() {
        const pending = this.active;
        if (pending === undefined) {
            this.snapshotCache = null;
            return;
        }
        const question = pending.request.questions[pending.index];
        this.snapshotCache = question === undefined ? null : {
            key: `${pending.batchId}-${pending.index}`,
            question,
            position: pending.index + 1,
            total: pending.request.questions.length,
            answered: pending.answers.length,
        };
    }
    /**
     * Provider entry point — called by `ctx.userQuestions.ask()` when the
     * model runs the `ask_user_question` tool.
     * @param request - The ask request: questions plus optional abort signal.
     * @returns A promise settling with the collected answers when the user
     *   submits the batch, or rejecting when the ask is interrupted.
     */
    ask(request) {
        return new Promise((resolve, reject) => {
            const pending = {
                request,
                batchId: ++this.batchSeq,
                index: 0,
                answers: [],
                resolve,
                reject,
                onAbort: () => {
                    if (this.active === pending) {
                        this.active = undefined;
                        this.rebuildSnapshot();
                        this.fail(pending);
                        this.startNext();
                        this.emit();
                        return;
                    }
                    const at = this.queue.indexOf(pending);
                    if (at >= 0)
                        this.queue.splice(at, 1);
                    this.fail(pending);
                },
            };
            request.signal?.addEventListener('abort', pending.onAbort, { once: true });
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
     * The user submitted an answer for the current question; advances the
     * batch and settles it once every question is answered.
     * @param selection - Selected option labels plus optional custom text.
     */
    answerCurrent(selection) {
        const pending = this.active;
        const question = pending?.request.questions[pending.index];
        if (pending === undefined || question === undefined)
            return;
        pending.answers.push({
            id: question.id,
            selected: [...selection.selected],
            ...(selection.custom !== undefined && selection.custom !== ''
                ? { custom: selection.custom }
                : {}),
        });
        pending.index += 1;
        if (pending.index >= pending.request.questions.length) {
            // Batch complete: settle the harness promise, remember a transcript
            // summary, and drain the next queued ask if any.
            this.active = undefined;
            pending.resolve({ answers: [...pending.answers] });
            this.summaries.push(buildSummary(pending));
            this.startNext();
        }
        this.rebuildSnapshot();
        this.emit();
    }
    /** The user interrupted the questionnaire (Esc / Ctrl+C). */
    cancelCurrent() {
        const pending = this.active;
        if (pending === undefined)
            return;
        this.active = undefined;
        this.rebuildSnapshot();
        this.fail(pending);
        this.startNext();
        this.emit();
    }
    /** Reject the active and all queued asks (plugin teardown). */
    rejectAll() {
        const active = this.active;
        this.active = undefined;
        this.rebuildSnapshot();
        if (active !== undefined)
            this.fail(active);
        for (const pending of this.queue.splice(0))
            this.fail(pending);
        this.emit();
    }
    fail(pending) {
        pending.reject(new UserQuestionError('ask_user_question was interrupted before the user answered', ASK_ABORTED));
    }
}
