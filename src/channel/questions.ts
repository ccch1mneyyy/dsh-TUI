/**
 * Ask-user-question store — the UI-side half of every structured ask: the
 * DSH user-interaction seam (`ctx.userQuestions`, the model-facing
 * `ask_user_question` tool), local wizards (`/provider`, `/login`) and a
 * non-DSH session's `question.request` events (Claude `AskUserQuestion`,
 * `ExitPlanMode`) all park here. The store surfaces one question at a time to
 * the TUI questionnaire and settles the asker's promise when the user
 * answers, cancels, or the asker's abort signal fires.
 *
 * Queue semantics mirror the official dsh-tui chat/questions machine: asks
 * arrive one at a time in practice (the tool blocks until answered), but
 * concurrent asks from subagents are drained FIFO.
 *
 * This store owns the INTERACTION only. The answered-questionnaire transcript
 * record is a projection fact: it is folded from the persisted tool result
 * (`channel/question-record.ts`, issue #1009), never pushed from here, so it
 * survives `/resume`, rewind and replay.
 *
 * Backend-neutral (`verify:boundary`): the request/answer shapes are the
 * store's own (structurally the DSH protocol's, so `src/dsh-adapter/` passes
 * its official types straight through), and the interruption error is
 * injected — the DSH store rejects with the protocol's `UserQuestionError`
 * (`src/dsh-adapter/questions.ts`), which dsh-plan-mode keys on.
 */

import {
  assertCapabilityShadowPolicy,
  defaultAdapterRuntime,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import type { PlanReviewIntentView } from '../agent/events.js'

/** One option of a question. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question as the panel renders it. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
  /** Presentation intent: `plan-review` switches to the decision card. */
  readonly intent?: PlanReviewIntentView & { readonly callId?: string }
  /** Hide the trailing free-text row for pure option questions (wizards). */
  readonly hideCustomInput?: boolean
  /** Pre-checked option labels / default-focused option. */
  readonly defaultSelected?: readonly string[]
  /** A URL the question is about: shown under it as a link (OSC 8 where
   *  the terminal supports hyperlinks). */
  readonly link?: string
}

/** One ask: a batch of questions plus its cancellation lifetime. */
export interface QuestionRequest {
  readonly questions: readonly QuestionItem[]
  readonly signal?: AbortSignal
}

/** One committed answer. */
export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** The answers of one ask, one per question. */
export interface QuestionAnswer {
  answers: QuestionAnswerItem[]
}

/** One answered question as the panel submits it: selected option labels
 *  plus optional free-text (the protocol's "Other" answer). */
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

/** Why an ask rejected: the user dismissed it, or it was interrupted. */
export type QuestionInterruption = 'ASK_CANCELLED' | 'ASK_ABORTED'

/** The default interruption error (a host may inject its protocol's own). */
export class QuestionInterruptedError extends Error {
  readonly code: QuestionInterruption
  constructor(message: string, code: QuestionInterruption) {
    super(message)
    this.name = 'QuestionInterruptedError'
    this.code = code
  }
}

/** Whether `error` is an ask rejected by the user or by an abort (either
 *  store's interruption error carries the code). */
export function isQuestionInterruption(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 'ASK_CANCELLED' || code === 'ASK_ABORTED'
}

/** The ask surface the channel and wizards drive. */
export interface QuestionStoreLike {
  ask(request: QuestionRequest, options?: { redact?: boolean }): Promise<QuestionAnswer>
}

/** One queued or active ask, with its running answers. */
interface PendingQuestion {
  readonly request: QuestionRequest
  /** Stable identity for the batch (panel remount key). */
  readonly batchId: number
  /** Index of the question currently shown (0-based). */
  index: number
  /** Committed answers by question index; an empty slot is not answered. */
  readonly answers: Array<QuestionAnswerItem | undefined>
  /** Uncommitted panel state by question index, used when navigating back. */
  readonly drafts: Array<QuestionDraft | undefined>
  /**
   * Redact answer text in the answered-questionnaire transcript record (e.g.
   * a wizard asking for an API key): the record lines show `••••••` instead
   * of the raw text so secrets never reach the transcript or an `/export`
   * dump. Only LOCAL wizards set it — the model-side ask carries no such flag.
   */
  readonly redact?: boolean
  resolve: (answer: QuestionAnswer) => void
  reject: (error: unknown) => void
  onAbort: () => void
}

/** What the TUI renders while a question is pending. */
export interface QuestionSnapshot {
  /** Stable key so the panel remounts (fresh selection state) per question. */
  readonly key: string
  readonly question: QuestionItem
  /** 1-based position within the batch. */
  readonly position: number
  /** Total questions in the batch. */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  /** Previously saved answer or draft for the current question. */
  readonly draft?: QuestionDraft
  /** Whether Esc / ← should navigate to the previous question. */
  readonly canGoBack: boolean
  /** Whether → should navigate to the next question without submitting. */
  readonly canGoForward: boolean
}

/** Constructor options of {@link QuestionStore}. */
export interface QuestionStoreOptions {
  readonly runtime?: AdapterRuntimeOptions
  /** The error an interrupted ask rejects with (default {@link QuestionInterruptedError}). */
  readonly interruption?: (message: string, code: QuestionInterruption) => Error
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

function selectionFromAnswer(answer: QuestionAnswerItem): QuestionDraft {
  return copyDraft(answer)
}

/**
 * Ask-user-question store: parks asks, surfaces one question at a time to
 * the TUI, and settles each ask when the user answers or the batch is
 * interrupted. The TUI subscribes for re-renders and answers via
 * {@link QuestionStore.answerCurrent}.
 */
export class QuestionStore implements QuestionStoreLike {
  /** The adapter runtime the shadow-policy guard is evaluated against. */
  protected readonly runtime: AdapterRuntimeOptions
  private readonly interruption: (message: string, code: QuestionInterruption) => Error

  constructor(options: QuestionStoreOptions = {}) {
    this.runtime = options.runtime ?? defaultAdapterRuntime()
    this.interruption = options.interruption ?? ((message, code) => new QuestionInterruptedError(message, code))
  }
  private readonly queue: PendingQuestion[] = []
  private active: PendingQuestion | undefined
  private readonly listeners = new Set<() => void>()
  private batchSeq = 0
  /**
   * Cached snapshot: useSyncExternalStore requires a stable reference while
   * nothing changed (a fresh object per call would loop re-renders).
   */
  private snapshotCache: QuestionSnapshot | null = null

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
   * Whether a panel callback still belongs to the question it was rendered
   * for. One stdin batch can deliver → and then Enter to the panel that
   * was mounted for the first key, after the store has already moved.
   */
  stillCurrent(key: string): boolean {
    return this.snapshotCache?.key === key
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
      canGoForward: pending.index + 1 < pending.request.questions.length,
    }
  }

  /**
   * Asker entry point — the DSH `ask_user_question` provider, local wizards
   * (e.g. `/provider`) and the channel's backend question bridge.
   * @param request - The ask request: questions plus optional abort signal.
   * @param options - `redact` hides answer text from the answered-questionnaire
   *   transcript record (use for batches that collect secrets such as API keys).
   * @returns A promise settling with the collected answers when the user
   *   submits the batch, or rejecting when the ask is interrupted.
   */
  ask(request: QuestionRequest,
      options?: { redact?: boolean }): Promise<QuestionAnswer> {
    assertCapabilityShadowPolicy('host.presentation.ask', this.runtime.mode, this.runtime.slices)
    return new Promise<QuestionAnswer>((resolve, reject) => {
      const pending: PendingQuestion = {
        request,
        batchId: ++this.batchSeq,
        index: 0,
        answers: new Array<QuestionAnswerItem | undefined>(request.questions.length),
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
   * previous answer at that position, advances to the next unanswered
   * question, and settles the batch once every question is answered.
   * @param selection - Selected option labels plus optional custom text.
   */
  answerCurrent(selection: QuestionSelection): void {
    const pending = this.active
    const question = pending?.request.questions[pending.index]
    if (pending === undefined || question === undefined) return
    const answer: QuestionAnswerItem = {
      id: question.id,
      selected: [...selection.selected],
      ...(selection.custom !== undefined && selection.custom !== ''
        ? { custom: selection.custom }
        : {}),
    }
    pending.answers[pending.index] = answer
    pending.drafts[pending.index] = copyDraft(selection)
    // The answers array is sparse until each question is committed. `every`
    // skips holes, so a peek-ahead answer would look complete and settle
    // early. Read every index explicitly.
    const complete = pending.request.questions.every((_, index) => pending.answers[index] !== undefined)
    if (complete) {
      // Batch complete: settle the asker's promise and drain the next queued
      // ask if any. Filling the last gap after a → peek counts — the user
      // should not have to walk onto an already-answered tail just to submit.
      // The transcript record is NOT written here — it is projected from the
      // persisted tool result (issue #1009), so it survives `/resume`,
      // rewind and every replay.
      const answers = pending.answers.filter(isDefined)
      this.active = undefined
      pending.resolve({ answers })
      this.startNext()
    } else {
      const after = pending.request.questions.findIndex((_, index) => index > pending.index && pending.answers[index] === undefined)
      const firstGap = pending.request.questions.findIndex((_, index) => pending.answers[index] === undefined)
      pending.index = after >= 0 ? after : firstGap
    }
    this.rebuildSnapshot()
    this.emit()
  }

  /**
   * Navigate to the next question without committing the current one. The
   * caller supplies the panel's draft so a peek forward does not discard
   * in-progress text. No-op on the last question — Enter still owns submit.
   */
  forwardCurrent(draft?: QuestionDraft): void {
    const pending = this.active
    if (pending === undefined || pending.index + 1 >= pending.request.questions.length) return
    if (draft !== undefined) {
      pending.drafts[pending.index] = copyDraft(draft)
    }
    pending.index += 1
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
    pending.reject(this.interruption('the user cancelled ask_user_question', 'ASK_CANCELLED'))
  }

  /** Asker-side interruption — abort signal fired or plugin teardown. */
  private fail(pending: PendingQuestion): void {
    pending.reject(this.interruption('ask_user_question was interrupted before the user answered', 'ASK_ABORTED'))
  }
}
