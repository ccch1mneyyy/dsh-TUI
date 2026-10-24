/**
 * In-process progress for the first-run guide, at module scope.
 *
 * Not a persisted preference and deliberately not part of `onboardingPrefs`
 * (that file owns the one-shot accounting, and a process that dies mid-guide
 * must not burn the installation's only first run). This store exists for one
 * mechanical reason:
 *
 *   The question and approval panels share the interrupt lane with every
 *   full-screen surface — while a panel is pending the screen is UNMOUNTED
 *   and remounted once the answer lands (`Chat.tsx`, the `interruptPanel &&
 *   screenOpen` branch; `screenOpen` includes `onboardingOpen`). An access
 *   step that opens a panel (API-key entry, an OAuth device code or authorize
 *   URL) therefore loses all of its React state at exactly the moment the
 *   flow has something to report back.
 *
 * So the guide keeps the mechanical facts here: which step and row the user
 * was on, the catalog snapshot taken BEFORE the action (the diff baseline for
 * `onboardingProviderPlan`), the action that is in flight, and the one-line
 * notice to restore. Everything else stays in component state.
 *
 * Lifecycle: written on change, read on mount, cleared when the guide closes
 * either way (finish or skip) — a stale draft must never steer the next
 * `/setup`. The slot is in-process only: nothing is serialized, so there is no
 * stored shape to parse or normalize, and a fresh process starts at step 0.
 *
 * @module @deepseek-harness-tui/dsh-tui/onboardingDraft
 */
import type { ProviderModelRef } from './components/onboardingProviderPlan.js'

/**
 * The access action whose result the guide is waiting for.
 *
 * `id` is what makes completions unambiguous: closing the guide clears the
 * draft but cannot cancel the provider flow, so a leftover promise can finish
 * after the user reopened `/setup` and started a NEW action. Without an id that
 * late callback would overwrite the new `pending` record with its own
 * `completed` one — the guide would settle the abandoned action and the live
 * one would lose its result.
 */
export interface OnboardingPendingAction {
  /** Monotonic id allocated when the action starts (see {@link nextOnboardingActionId}). */
  readonly id: number
  readonly kind: 'sign-in' | 'add-provider'
  /** Provider id for `sign-in`; absent for the add-provider wizard. */
  readonly provider?: string | undefined
}

/**
 * How an in-flight access action ended. The neutral three-way vocabulary the
 * guide consumes; the adapter's richer outcome union is mapped onto it at the
 * write site.
 */
export type OnboardingCompletionStatus = 'completed' | 'cancelled' | 'failed'

/** The finished action's result, written by whoever ran it. */
export interface OnboardingCompletion extends OnboardingPendingAction {
  readonly status: OnboardingCompletionStatus
}

/** Mechanical guide progress (see the module doc for why it exists). */
export interface OnboardingDraft {
  /** Zero-based step index, already clamped by the caller. */
  readonly step: number
  /** Focus row inside the current step/layer. */
  readonly focus: number
  /**
   * Stable focus identity for step 1's action list (`'signin' | 'add' | …`).
   * The list grows asynchronously, so an index alone would restore the wrong
   * action: the same index means a different row once sign-in/add are present.
   */
  readonly focusId: string | undefined
  /**
   * Catalog snapshot taken before the in-flight action; the diff baseline.
   * Empty when no action has run, which makes the first diff "everything is
   * new" — only reachable if a caller reads the plan without an action, and
   * the callers never do.
   */
  readonly baseline: readonly ProviderModelRef[]
  /**
   * The action in flight. Stays set for the WHOLE run — a question panel can
   * close between two questions (model discovery, profile write) and remount
   * the guide while the flow is still working, and settling then would read a
   * catalog that has not changed yet and drop the result.
   */
  readonly pending: OnboardingPendingAction | undefined
  /**
   * Set by the runner when the action ends. Settling requires this: the
   * remount that happens mid-run must wait for it, and a late completion must
   * still be able to reach the instance that is on screen.
   */
  readonly completed: OnboardingCompletion | undefined
  /** Notice line to restore after a remount. */
  readonly notice: string | undefined
}

/** What `readOnboardingDraft` answers when nothing is in flight. */
export const EMPTY_ONBOARDING_DRAFT: OnboardingDraft = {
  step: 0,
  focus: 0,
  focusId: undefined,
  baseline: [],
  pending: undefined,
  completed: undefined,
  notice: undefined,
}

let current: OnboardingDraft | undefined
let actionSeq = 0
const listeners = new Set<() => void>()

/**
 * Allocate the id for a starting action.
 *
 * @returns A positive, strictly increasing id (1-based).
 */
export function nextOnboardingActionId(): number {
  actionSeq += 1
  return actionSeq
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A listener must never break the write that notified it.
    }
  }
}

/**
 * Observe draft writes. The guide subscribes so a completion that lands while
 * it is mounted (or after a remount) settles there, instead of being lost to
 * the instance that started the action.
 *
 * @param listener - Called after every write and clear.
 * @returns Unsubscribe.
 */
export function subscribeOnboardingDraft(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Read the draft in flight.
 *
 * @returns The stored draft, or `undefined` when the guide has no progress to
 *   restore (first mount, or after {@link clearOnboardingDraft}).
 */
export function readOnboardingDraft(): OnboardingDraft | undefined {
  return current
}

/**
 * Merge a patch into the draft, creating it on first write.
 *
 * @param patch - Fields to replace.
 * @returns The stored draft after the write.
 */
export function writeOnboardingDraft(patch: Partial<OnboardingDraft>): OnboardingDraft {
  current = { ...(current ?? EMPTY_ONBOARDING_DRAFT), ...patch }
  emit()
  return current
}

/** Drop the draft; called on both guide exits (finish and skip). */
export function clearOnboardingDraft(): void {
  current = undefined
  emit()
}
