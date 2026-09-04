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

import type { Agent } from '@deepseek-ai/dsh-agent'
import { t } from '../i18n.js'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

/** One answered question as the panel submits it: selected option labels
 *  plus optional free-text (the dsh protocol's "Other" answer). */
export interface QuestionSelection {
  readonly selected: string[]
  readonly custom?: string
}

/**
 * In-progress answer state kept while navigating between questions. Drafts
 * are deliberately separate from committed answers: leaving a question
 * should preserve what the user typed without making it count as answered.
 */
export type QuestionDraft = QuestionSelection

/** One queued or active ask, with its running answers. */
interface PendingQuestion {
  readonly request: AskUserQuestionRequest
  /** Stable identity for the batch (panel remount key). */
  readonly batchId: number
  /** Index of the question currently shown (0-based). */
  index: number
  /** Committed answers by question index; an empty slot is not answered. */
  readonly answers: Array<AskUserQuestionAnswerItem | undefined>
  /** Uncommitted panel state by question index, used when navigating back. */
  readonly drafts: Array<QuestionDraft | undefined>
  /**
   * Redact answer text in the transcript summary (e.g. a wizard asking for
   * an API key): the summary lines show `••••••` instead of the raw text so
   * secrets never reach the transcript or an `/export` dump.
   */
  readonly redact?: boolean
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: unknown) => void
  onAbort: () => void
}

/** What the TUI renders while a question is pending. */
export interface QuestionSnapshot {
  /** Stable key so the panel remounts (fresh selection state) per question. */
  readonly key: string
  readonly question: AskUserQuestionItem
  /** 1-based position within the batch. */
  readonly position: number
  /** Total questions in the batch. */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  /** Previously saved answer or draft for the current question. */
  readonly draft?: QuestionDraft
  /** Whether Esc should navigate to the previous question. */
  readonly canGoBack: boolean
}

/** Completed batch summary, pushed into the transcript by the caller. */
export interface QuestionSummary {
  readonly title: string
  readonly lines: readonly string[]
}

const ASK_ABORTED = 'ASK_ABORTED'
/**
 * User-initiated cancel (Esc / Ctrl+C in the panel). dsh-plan-mode keys on
 * this code to report "the user dismissed the plan review to speak instead"
 * rather than the generic abort message, so user cancels must be told apart
 * from harness aborts (signal fired) and teardown rejects.
 */
const ASK_CANCELLED = 'ASK_CANCELLED'
/**
 * User-initiated "Exit planning" in the plan-review panel. The question is
 * rejected with this code (not resolved), so dsh-plan-mode's exit tool
 * surfaces our stop-here message instead of reading the choice as
 * keep-planning feedback.
 */
const PLAN_REVIEW_EXITED = 'PLAN_REVIEW_EXITED'

/** Truncate a long answer line for the transcript summary. */
function clip(text: string, max = 140): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function copyDraft(draft: QuestionDraft): QuestionDraft {
  return {
    selected: [...draft.selected],
    ...(draft.custom !== undefined ? { custom: draft.custom } : {}),
  }
}

function selectionFromAnswer(answer: AskUserQuestionAnswerItem): QuestionDraft {
  return copyDraft(answer)
}

function buildSummary(pending: PendingQuestion): QuestionSummary {
  const lines = pending.request.questions.flatMap((question, index) => {
    const answer = pending.answers[index]
    if (answer === undefined) return []
    const text = pending.redact
      ? '••••••'
      : (() => {
          const labels = answer.selected.join('、')
          return answer.custom !== undefined && answer.custom !== ''
            ? labels === '' ? answer.custom : `${labels}：${answer.custom}`
            : labels
        })()
    return `· ${question.question} → ${clip(text)}`
  })
  const total = pending.request.questions.length
  return {
    title: t('questionnaire-answered', { total }),
    lines,
  }
}

/**
 * Ask-user-question store: parks asks from the harness's user-interaction
 * seam, surfaces one question at a time to the TUI, and settles each ask
 * when the user answers or the batch is interrupted. The TUI subscribes for
 * re-renders and answers via {@link QuestionStore.answerCurrent}.
 */
export class QuestionStore {
  private readonly queue: PendingQuestion[] = []
  private active: PendingQuestion | undefined
  private readonly listeners = new Set<() => void>()
  private batchSeq = 0
  /** Completed batch summaries, drained by the TUI into the transcript. */
  private summaries: QuestionSummary[] = []
  /**
   * Cached snapshot: useSyncExternalStore requires a stable reference while
   * nothing changed (a fresh object per call would loop re-renders).
   */
  private snapshotCache: QuestionSnapshot | null = null
  /**
   * Installed by the TUI plugin once the live channel exists. "Exit
   * planning" must do more than reject the ask: the rejection comes back as
   * a failed `exit_plan_mode` tool result, and a model that keeps stepping
   * after that failure can still execute the unapproved plan. The hook lets
   * the store abort the calling agent's turn the moment the user exits the
   * review, before the agent loop can submit another tool call. When no
   * hook is installed, `exitPlanReview` cancels the agent directly.
   */
  private exitPlanReviewHandler: ((agent: Agent) => void) | undefined
  /**
   * Installed by the TUI plugin: routes the plan-mode half of "Exit
   * planning" through dsh-plan-mode's controller (`planMode.set(agent,
   * false)`), which owns the pending-intent queue. A direct `plan/mode`
   * append cannot cancel a queued `/plan on`; that stale intent would win
   * at the next accepted pre-step and silently re-enter plan mode. When no
   * handler is installed (scripts, bare embeds), the raw event append is
   * the fallback.
   */
  private planModeOffHandler: ((agent: Agent) => void) | undefined

  /**
   * Install (or clear) the "Exit planning" turn-abort hook.
   * @param handler - Called with the live agent that owns the plan review;
   *   expected to cancel that agent's active turn.
   */
  setExitPlanReviewHandler(handler: ((agent: Agent) => void) | undefined): void {
    this.exitPlanReviewHandler = handler
  }

  /**
   * Install (or clear) the hook that turns real plan mode off for the
   * calling agent. The handler must prefer dsh-plan-mode's controller over
   * appending `plan/mode` itself so queued pending intents are replaced,
   * not merely raced by a logged event.
   * @param handler - Called with the agent whose plan review the user exited.
   */
  setPlanModeOffHandler(handler: ((agent: Agent) => void) | undefined): void {
    this.planModeOffHandler = handler
  }

  /**
   * Subscribe to store changes (useSyncExternalStore contract).
   * @param listener - Called after every mutation that changes the snapshot.
   * @returns An unsubscribe function removing the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The question the TUI should render now, or null when idle.
   * @returns The cached snapshot; the reference is stable between mutations.
   */
  getSnapshot(): QuestionSnapshot | null {
    return this.snapshotCache
  }

  /**
   * Take (and clear) every completed batch summary for the transcript.
   * @returns The summaries collected since the last take.
   */
  takeSummaries(): QuestionSummary[] {
    const summaries = this.summaries
    this.summaries = []
    return summaries
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Rebuild the cached snapshot after any mutation of active/index. */
  private rebuildSnapshot(): void {
    const pending = this.active
    if (pending === undefined) {
      this.snapshotCache = null
      return
    }
    const question = pending.request.questions[pending.index]
    const savedDraft = pending.drafts[pending.index]
    const savedAnswer = pending.answers[pending.index]
    this.snapshotCache = question === undefined ? null : {
      key: `${pending.batchId}-${pending.index}`,
      question,
      position: pending.index + 1,
      total: pending.request.questions.length,
      answered: pending.index,
      ...(savedDraft !== undefined
        ? { draft: savedDraft }
        : savedAnswer !== undefined
          ? { draft: selectionFromAnswer(savedAnswer) }
          : {}),
      canGoBack: pending.index > 0,
    }
  }

  /**
   * Provider entry point — called by `ctx.userQuestions.ask()` when the
   * model runs the `ask_user_question` tool, and by local wizards (e.g.
   * `/provider`) driving the same panel.
   * @param request - The ask request: questions plus optional abort signal.
   * @param options - `redact` hides answer text from the transcript summary
   *   (use for batches that collect secrets such as API keys).
   * @returns A promise settling with the collected answers when the user
   *   submits the batch, or rejecting when the ask is interrupted.
   */
  ask(request: AskUserQuestionRequest,
      options?: { redact?: boolean }): Promise<AskUserQuestionAnswer> {
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const pending: PendingQuestion = {
        request,
        batchId: ++this.batchSeq,
        index: 0,
        answers: new Array<AskUserQuestionAnswerItem | undefined>(request.questions.length),
        drafts: new Array<QuestionDraft | undefined>(request.questions.length),
        ...(options?.redact ? { redact: true } : {}),
        resolve,
        reject,
        onAbort: () => {
          if (this.active === pending) {
            this.active = undefined
            this.rebuildSnapshot()
            this.fail(pending)
            this.startNext()
            this.emit()
            return
          }
          const at = this.queue.indexOf(pending)
          if (at >= 0) this.queue.splice(at, 1)
          this.fail(pending)
        },
      }
      request.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.queue.push(pending)
      this.startNext()
    })
  }

  /** Advance to the next queued ask, if any. */
  private startNext(): void {
    if (this.active !== undefined || this.queue.length === 0) return
    this.active = this.queue.shift()
    this.rebuildSnapshot()
    this.emit()
  }

  /**
   * The user submitted an answer for the current question; replaces any
   * previous answer at that position, advances the batch, and settles it once
   * every question is answered.
   * @param selection - Selected option labels plus optional custom text.
   */
  answerCurrent(selection: QuestionSelection): void {
    const pending = this.active
    const question = pending?.request.questions[pending.index]
    if (pending === undefined || question === undefined) return
    const answer: AskUserQuestionAnswerItem = {
      id: question.id,
      selected: [...selection.selected],
      ...(selection.custom !== undefined && selection.custom !== ''
        ? { custom: selection.custom }
        : {}),
    }
    pending.answers[pending.index] = answer
    pending.drafts[pending.index] = copyDraft(selection)
    pending.index += 1
    if (pending.index >= pending.request.questions.length) {
      // Batch complete: settle the harness promise, remember a transcript
      // summary, and drain the next queued ask if any.
      const answers = pending.answers.filter(isDefined)
      this.active = undefined
      pending.resolve({ answers })
      this.summaries.push(buildSummary(pending))
      this.startNext()
    }
    this.rebuildSnapshot()
    this.emit()
  }

  /**
   * Navigate to the previous question without cancelling the batch. The
   * caller supplies the panel's current draft so partially typed text can be
   * restored when the user returns.
   */
  backCurrent(draft?: QuestionDraft): void {
    const pending = this.active
    if (pending === undefined || pending.index <= 0) return
    if (draft !== undefined) {
      pending.drafts[pending.index] = copyDraft(draft)
    }
    pending.index -= 1
    this.rebuildSnapshot()
    this.emit()
  }

  /** The user interrupted the questionnaire (Esc / Ctrl+C). */
  cancelCurrent(): void {
    const pending = this.active
    if (pending === undefined) return
    this.active = undefined
    this.rebuildSnapshot()
    this.cancel(pending)
    this.startNext()
    this.emit()
  }

  /**
   * The user chose the plan-review panel's "Exit planning" row: leave plan
   * mode WITHOUT approving the plan. The installed {@link planModeOffHandler}
   * routes this through dsh-plan-mode's `planMode.set(agent, false)`, which
   * owns the pending-intent queue — appending `active: false` to the session
   * directly would leave a queued `/plan on` in place, and that stale intent
   * would win at the next accepted pre-step and silently re-enter plan mode.
   * The raw `plan/mode` append is kept as the no-handler fallback (scripts,
   * bare embeds); the channel's `session/event` arm then clears the
   * `/planPrompt` switch once the plan-mode exit is committed. The pending
   * ask is rejected with {@link PLAN_REVIEW_EXITED} so the model-facing
   * `exit_plan_mode` tool reports "stop here" instead of treating the
   * selection as keep-planning feedback — and the installed handler aborts
   * the calling agent's turn, because a rejected tool result alone does not
   * stop the agent loop from continuing the unapproved plan.
   */
  exitPlanReview(): void {
    const pending = this.active
    const question = pending?.request.questions[pending.index]
    if (pending === undefined || question === undefined) return
    if (question.intent?.kind !== 'plan-review') return
    const agent = pending.request.agent
    const abortTurn = (): void => {
      if (agent === undefined) return
      try {
        const handler = this.exitPlanReviewHandler
        if (handler !== undefined) handler(agent)
        else agent.cancel({ kind: 'user' }, { keepInbox: true })
      } catch {
        // Best-effort abort: the rejection below already carries the stop
        // instruction, but a handler failure must never let the panel stay
        // parked or resurrect the unapproved plan.
      }
    }
    if (agent !== undefined) {
      try {
        const planModeOff = this.planModeOffHandler
        if (planModeOff !== undefined) {
          planModeOff(agent)
        } else {
          ;(agent.session as unknown as {
            append(type: string, data: Record<string, unknown>): unknown
          }).append('plan/mode', { active: false })
        }
      } catch (error) {
        // Never leave the panel parked: settle the ask with the real reason.
        this.active = undefined
        this.rebuildSnapshot()
        pending.reject(error)
        this.startNext()
        this.emit()
        abortTurn()
        return
      }
    }
    this.active = undefined
    this.rebuildSnapshot()
    pending.reject(new UserQuestionError(
      'The user chose Exit planning: the plan was NOT approved and plan mode is off (this also clears the /planPrompt injection when present). Stop here and wait for the user’s next message.',
      PLAN_REVIEW_EXITED,
    ))
    this.startNext()
    this.emit()
    abortTurn()
  }

  /** Reject the active and all queued asks (plugin teardown). */
  rejectAll(): void {
    const active = this.active
    this.active = undefined
    this.rebuildSnapshot()
    if (active !== undefined) this.fail(active)
    for (const pending of this.queue.splice(0)) this.fail(pending)
    this.emit()
  }

  /** User-initiated cancel — the asker learns the user wants to speak. */
  private cancel(pending: PendingQuestion): void {
    pending.reject(new UserQuestionError(
      'the user cancelled ask_user_question',
      ASK_CANCELLED,
    ))
  }

  /** Harness-side interruption — abort signal fired or plugin teardown. */
  private fail(pending: PendingQuestion): void {
    pending.reject(new UserQuestionError(
      'ask_user_question was interrupted before the user answered',
      ASK_ABORTED,
    ))
  }
}
