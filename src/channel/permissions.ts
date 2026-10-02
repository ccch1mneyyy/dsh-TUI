/**
 * The shared permission prompt surface (docs/agent-backend-design.md §4.7,
 * §8.4): one view shape the approval panel renders for every backend, the
 * small interface Chat drives it through, and `PermissionStore` — the FIFO
 * store a non-DSH session's `permission.request` events park in.
 *
 * Queue semantics mirror the DSH `ApprovalStore`: parallel tool calls can
 * raise several prompts before any answer, so they drain first in, first out
 * with exactly one on the panel. A prompt settles exactly once:
 *  - `decide` — the user picked an option on the panel (allow once / allow
 *    always / reject, the reject optionally carrying the user's reason);
 *  - `withdraw` — the backend took the prompt back (its own cancellation:
 *    interrupt, turn end, process exit) → `cancelled`;
 *  - `withdrawSession` / `settleAll` — the session left the binding or the
 *    host tears down → `cancelled`.
 * Only a user decision reaches the backend: a withdrawn prompt was already
 * answered on the backend side, so answering it again would be a second,
 * conflicting verdict.
 *
 * Backend-neutral: no vendor types, no DSH imports (`verify:boundary`).
 */
import type { PermissionDecision } from '../agent/capabilities.js'
import type { PermissionOptionView, PermissionOutcome, PermissionRequestView } from '../agent/events.js'

/** What the approval panel renders for the active prompt. */
export interface PermissionPanelSnapshot {
  /** Stable key so the panel remounts (fresh focus state) per prompt. */
  readonly key: string
  /** The tool (or its short display name) the prompt gates. */
  readonly toolName: string
  /**
   * The asking session's id. A prompt from a session other than the attached
   * one (a DSH background session in the agent view) is labelled as such.
   */
  readonly agentId: string
  /** Full prompt sentence, when the backend renders one. */
  readonly title?: string
  /** One-line rendering of the gated action (command, file, URL). */
  readonly command?: string
  /** Why the backend asks. */
  readonly reason?: string
  /** What granting would allow. */
  readonly description?: string
  /** The path outside the allowed directories that triggered the ask. */
  readonly blockedPath?: string
  /** The asking subagent (a delegated agent inside the attached session). */
  readonly subagentId?: string
  /** DSH source badge: the ask is not anchored to a live tool call. */
  readonly external?: true
  /** The choices, in the backend's order; absent = allow once / reject. */
  readonly options?: readonly PermissionOptionView[]
  /** Reject first, and no single keystroke approves. */
  readonly defaultToNo?: boolean
  /** No persistent "don't ask again" choice may be shown. */
  readonly suppressAlwaysAllow?: boolean
  /** A user ask rule forced this prompt (no "don't ask again" either). */
  readonly matchedAskRule?: boolean
  /** Typing on the panel composes a reason sent back with a rejection. */
  readonly feedback?: boolean
}

/** The panel's outcome vocabulary (the DSH protocol's two plus allow-always). */
export type PermissionPanelOutcome = 'allowed-once' | 'allowed-always' | 'rejected'

/** The option the user picked, with the reason typed for a rejection. */
export interface PermissionPanelDecision {
  readonly optionId: string
  readonly kind: PermissionOptionView['kind']
  readonly feedback?: string
}

/**
 * The store interface the approval panel host (Chat, the session
 * supervisor) drives: the DSH `ApprovalStore` and `PermissionStore` both
 * implement it, so one panel renders either.
 */
export interface PermissionPanelSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): PermissionPanelSnapshot | null
  /** Settle the active prompt with the user's choice. */
  decide(outcome: PermissionPanelOutcome, decision?: PermissionPanelDecision): void
}

/** The two choices every prompt without backend options offers. */
export const DEFAULT_PERMISSION_OPTIONS: readonly PermissionOptionView[] = Object.freeze([
  Object.freeze({ id: 'allow-once', kind: 'allow-once' as const }),
  Object.freeze({ id: 'reject', kind: 'reject' as const }),
])

/** The panel outcome of an option kind. */
export function panelOutcomeOf(kind: PermissionOptionView['kind']): PermissionPanelOutcome {
  return kind === 'allow-once' ? 'allowed-once' : kind === 'allow-always' ? 'allowed-always' : 'rejected'
}

/**
 * The options a panel may show for one prompt, in display order: an
 * allow-always option is dropped when the prompt forbids it (suppressed, or
 * forced by an ask rule — defence in depth: backends already omit it), and
 * `defaultToNo` moves the rejections to the front.
 */
export function visiblePermissionOptions(snapshot: Pick<PermissionPanelSnapshot, 'options' | 'defaultToNo' | 'suppressAlwaysAllow' | 'matchedAskRule'>): readonly PermissionOptionView[] {
  const all = snapshot.options ?? DEFAULT_PERMISSION_OPTIONS
  const allowed = snapshot.suppressAlwaysAllow === true || snapshot.matchedAskRule === true
    ? all.filter(option => option.kind !== 'allow-always')
    : all
  if (snapshot.defaultToNo !== true) return allowed
  return [...allowed.filter(option => option.kind === 'reject'), ...allowed.filter(option => option.kind !== 'reject')]
}

/** One parked prompt: the backend's view plus how its settlement is reported. */
export interface PermissionAsk {
  /** The session that raised it (`AgentSessionRef.sessionId`). */
  readonly sessionId: string
  readonly request: PermissionRequestView
  /**
   * Called exactly once. `decision` is present only for a user decision
   * (allow-once / allow-always / rejected); `cancelled` carries none.
   */
  settle(outcome: PermissionOutcome, decision?: PermissionDecision): void
}

interface Parked {
  readonly key: string
  readonly ask: PermissionAsk
}

/** Composite identity: request ids are only unique within one session. */
const idOf = (sessionId: string, requestId: string): string => `${sessionId}\u0000${requestId}`

/**
 * FIFO permission store for backend sessions (the shared half of design
 * §4.7). Chat renders `getSnapshot()` through the approval panel; the
 * channel parks and withdraws as the session's events arrive.
 */
export class PermissionStore implements PermissionPanelSource {
  private readonly queue: Parked[] = []
  private active: Parked | undefined
  private readonly listeners = new Set<() => void>()
  private seq = 0
  /** Stable reference between mutations (useSyncExternalStore contract). */
  private snapshotCache: PermissionPanelSnapshot | null = null

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): PermissionPanelSnapshot | null {
    return this.snapshotCache
  }

  /** Every parked prompt (active first), in the backend's own shape. */
  pending(): readonly PermissionRequestView[] {
    return this.all().map(parked => parked.ask.request)
  }

  /** Session ids with a parked prompt, deduplicated, in park order. */
  pendingAgentIds(): readonly string[] {
    return [...new Set(this.all().map(parked => parked.ask.sessionId))]
  }

  /** The first parked prompt's summary for one session. */
  pendingAgentDetail(sessionId: string): { readonly toolName: string; readonly reason?: string; readonly command?: string } | undefined {
    const parked = this.all().find(entry => entry.ask.sessionId === sessionId)
    if (parked === undefined) return undefined
    const { toolName, reason, command } = parked.ask.request
    return { toolName, ...(reason === undefined ? {} : { reason }), ...(command === undefined ? {} : { command }) }
  }

  /** Park one prompt; it surfaces once every earlier prompt settled. A
   *  duplicate (same session and request id) is refused as cancelled. */
  park(ask: PermissionAsk): void {
    const id = idOf(ask.sessionId, ask.request.requestId)
    if (this.find(id) !== undefined) {
      ask.settle('cancelled')
      return
    }
    this.queue.push({ key: String(++this.seq), ask })
    this.startNext()
  }

  /**
   * The user decided on the active prompt. The outcome's option comes from
   * `decision` when given (it names which allow-always option and carries a
   * rejection's reason); a bare outcome picks the first option of its kind.
   */
  decide(outcome: PermissionPanelOutcome, decision?: PermissionPanelDecision): void {
    const parked = this.active
    if (parked === undefined) return
    const kind = decision?.kind ?? (outcome === 'allowed-once' ? 'allow-once' : outcome === 'allowed-always' ? 'allow-always' : 'reject')
    const options = parked.ask.request.options
    // A choice the prompt never offered is refused (fail closed): only the
    // rejection is always available.
    const offered = kind === 'reject' || options.some(option => option.kind === kind && (decision === undefined || option.id === decision.optionId))
    const verdict: PermissionDecision = !offered || kind === 'reject'
      ? { kind: 'reject', ...(decision?.feedback === undefined || decision.feedback.trim() === '' ? {} : { message: decision.feedback.trim() }) }
      : kind === 'allow-always'
        ? { kind: 'allow-always', ...(decision === undefined ? {} : { optionId: decision.optionId }) }
        : { kind: 'allow-once' }
    this.active = undefined
    this.rebuild()
    this.settle(parked, verdict.kind === 'allow-once' ? 'allow-once' : verdict.kind === 'allow-always' ? 'allow-always' : 'rejected', verdict)
    this.startNext()
    this.emit()
  }

  /** The backend withdrew one prompt (its own cancellation). */
  withdraw(sessionId: string, requestId: string): boolean {
    const parked = this.find(idOf(sessionId, requestId))
    if (parked === undefined) return false
    this.remove(parked)
    this.settle(parked, 'cancelled')
    return true
  }

  /** A session left the binding: withdraw every prompt it parked. */
  withdrawSession(sessionId: string): void {
    for (const parked of this.all().filter(entry => entry.ask.sessionId === sessionId)) {
      this.remove(parked)
      this.settle(parked, 'cancelled')
    }
  }

  /** Withdraw everything (host teardown). */
  settleAll(): void {
    const parked = this.all()
    this.active = undefined
    this.queue.length = 0
    this.rebuild()
    for (const entry of parked) this.settle(entry, 'cancelled')
    this.emit()
  }

  private all(): Parked[] {
    return [...(this.active === undefined ? [] : [this.active]), ...this.queue]
  }

  private find(id: string): Parked | undefined {
    return this.all().find(entry => idOf(entry.ask.sessionId, entry.ask.request.requestId) === id)
  }

  private remove(parked: Parked): void {
    if (this.active === parked) {
      this.active = undefined
      this.rebuild()
      this.startNext()
      this.emit()
      return
    }
    const at = this.queue.indexOf(parked)
    if (at >= 0) this.queue.splice(at, 1)
  }

  /** A settle callback that throws must not wedge the queue. */
  private settle(parked: Parked, outcome: PermissionOutcome, decision?: PermissionDecision): void {
    try {
      parked.ask.settle(outcome, decision)
    } catch {
      // The panel already moved on; the owner reports its own failure.
    }
  }

  private startNext(): void {
    if (this.active !== undefined || this.queue.length === 0) return
    this.active = this.queue.shift()
    this.rebuild()
    this.emit()
  }

  private rebuild(): void {
    const parked = this.active
    if (parked === undefined) {
      this.snapshotCache = null
      return
    }
    const request = parked.ask.request
    this.snapshotCache = {
      key: parked.key,
      toolName: request.displayName ?? request.toolName,
      agentId: parked.ask.sessionId,
      options: request.options,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.command === undefined ? {} : { command: request.command }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.blockedPath === undefined ? {} : { blockedPath: request.blockedPath }),
      ...(request.agentId === undefined ? {} : { subagentId: request.agentId }),
      ...(request.defaultToNo === true ? { defaultToNo: true } : {}),
      ...(request.suppressAlwaysAllow === true ? { suppressAlwaysAllow: true } : {}),
      ...(request.matchedAskRule === undefined ? {} : { matchedAskRule: true }),
      ...(request.feedback === true ? { feedback: true } : {}),
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
