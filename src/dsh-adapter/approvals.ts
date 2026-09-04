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

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { snapshotLiveSessionEvents } from './compat/liveSession.js'

/** What the TUI renders while an approval is pending. */
export interface ApprovalSnapshot {
  /** Stable key so the panel remounts (fresh focus state) per request. */
  readonly key: string
  readonly toolName: string
  /** The asker's human-readable explanation, when given. */
  readonly reason?: string
  /** The gated command, recovered from the paired tool/call event. */
  readonly command?: string
  /**
   * The request is not anchored to a live tool call of this session (no or
   * unknown callId, the paired call already settled, or the callId is
   * already in flight or consumed by another ask — a genuine approval is
   * asked exactly once per call). A duplicate callId marks EVERY ask on it
   * (the pre-existing one included — attacker-first order) so the verdict
   * can never invert onto the genuine ask). The approval waterfall is an in-process event
   * any plugin can dispatch, so the panel renders a loud warning instead of
   * presenting the text as the agent's own pending command. Verdicts that
   * depend on the session log are re-checked while the ask is queued or on
   * the panel, so they may also appear late — once a same-callId sibling
   * ask is allowed and its tool/result lands (P-4). The in-flight dedup
   * verdict, by contrast, is determined at park() and needs no result to
   * land.
   */
  readonly external?: true
  /**
   * The asking agent's session id — `String(channel.agentId)` for the
   * attached session, something else for a background session's ask (the
   * agent view parks those too, so unattended sessions surface as
   * "needs input" instead of hanging on a fail-closed answer).
   */
  readonly agentId: string
}

/**
 * Internal mutable twin of the snapshot body. `external` is a point-in-time
 * verdict (is the paired tool call still unresolved?) that later re-checks
 * may set — see {@link ApprovalStore.refreshActiveExternal}.
 */
interface PendingSnapshot {
  toolName: string
  reason?: string
  command?: string
  external?: true
  agentId: string
}

/** One queued or active approval ask. */
interface PendingApproval {
  readonly key: string
  /**
   * The original request, kept so the source badge can be re-checked while
   * this ask sits in the queue or on the panel (the session log keeps
   * appending after park()).
   */
  readonly request: ApprovalRequest
  snapshot: PendingSnapshot
  resolve: (outcome: ApprovalOutcome) => void
  onAbort: () => void
}

const COMMAND_CLIP = 500

/**
 * Recover the gated command from the session log: the approval request
 * links to an already-presented tool call via `callId`, so the arguments
 * are not duplicated on the request. Mirrors the web client's `commandOf`.
 * @param req - The pending approval request.
 * @returns The `command` argument when present, else the raw arguments
 *   string (clipped), else undefined when the call cannot be found.
 */
function commandOf(req: ApprovalRequest): string | undefined {
  if (req.callId === undefined) return undefined
  const events = snapshotLiveSessionEvents(req.agent.session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event: SessionEvent = events[i]!
    if (event.type !== 'tool/call') continue
    if (String(event.data.callId) !== String(req.callId)) continue
    const raw = event.data.arguments
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = parsed.command
        if (typeof command === 'string') return command
      }
    } catch {
      // Not JSON — fall through to the raw string.
    }
    return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`
  }
  return undefined
}

/**
 * Whether the approval is anchored to a live, unresolved tool call of the
 * session. The permission layer gates a call BEFORE it executes: at gating
 * time the paired tool/call event exists and no tool/result for that callId
 * has landed yet. A request without a callId, with a callId matching no
 * event, or referencing an already-settled call therefore did not come from
 * the agent's live execution — most plausibly a forged waterfall dispatch
 * replaying real session text.
 */
function isLiveToolApproval(req: ApprovalRequest): boolean {
  if (req.callId === undefined) return false
  const events = snapshotLiveSessionEvents(req.agent.session)
  let callIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event: SessionEvent = events[i]!
    if (event.type !== 'tool/call') continue
    if (String(event.data.callId) !== String(req.callId)) continue
    callIndex = i
    break
  }
  if (callIndex === -1) return false
  for (let i = callIndex + 1; i < events.length; i += 1) {
    const event: SessionEvent = events[i]!
    if (event.type !== 'tool/result') continue
    const resultCallId = (event.data.message as { source?: { callId?: unknown } } | undefined)?.source?.callId
    if (String(resultCallId) === String(req.callId)) return false
  }
  return true
}

/** Composite consumed-set key: one agent domain per entry (see
 * ApprovalStore.consumedCallIds). */
function consumedKey(agentId: unknown, callId: unknown): string {
  return `${String(agentId)}::${String(callId)}`
}

/**
 * Approval store: parks asks from the harness's approval seam, surfaces
 * one at a time to the TUI, and settles each ask when the user decides or
 * the ask is withdrawn. The TUI subscribes for re-renders and decides via
 * {@link ApprovalStore.decide}.
 */
export class ApprovalStore {
  private readonly queue: PendingApproval[] = []
  private active: PendingApproval | undefined
  private readonly listeners = new Set<() => void>()
  private seq = 0
  /**
   * Cached snapshot: useSyncExternalStore requires a stable reference while
   * nothing changed (a fresh object per call would loop re-renders).
   */
  private snapshotCache: ApprovalSnapshot | null = null
  /**
   * Length of the session log at the last liveness evaluation of the active
   * ask. Events only append, so an unchanged length means no verdict can
   * have flipped — re-checks below this guard are skipped.
   */
  private externalCheckedAtEvents = -1
  private notifyQueued = false
  /**
   * CallIds whose approval ask already settled (decided or cancelled).
   * Together with the in-flight set this closes the park-after-decide gap:
   * the first ask leaves the queue while its tool is still executing (the
   * callId still reads live), so a twin parked in that window would dodge
   * both the in-flight dedup and the liveness check. A consumed callId
   * never legitimately comes back: the permission layer asks once per call.
   * Fails toward the badge — a hypothetical genuine re-ask after a cancel
   * shows the warning, never the reverse. Evicted when the paired
   * tool/result lands (after that the liveness check marks the twin
   * anyway), keeping the set bounded to in-flight tool executions.
   * Keys are agent-scoped (`agentId::callId`): the store outlives agent
   * switches (/resume, /new) and low-entropy callIds (provider fallback
   * `call-<index>`) repeat across sessions — a bare-callId key would badge
   * the next session's genuine ask with the previous session's residue.
   */
  private readonly consumedCallIds = new Set<string>()

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
   * The approval the TUI should render now, or null when idle. Re-checks the
   * active ask's source badge against the current session log (see
   * {@link refreshActiveExternal}) so a badge that flips while the ask is on
   * the panel surfaces without waiting for another store mutation.
   * @returns The cached snapshot; the reference is stable between mutations.
   */
  getSnapshot(): ApprovalSnapshot | null {
    this.refreshActiveExternal()
    return this.snapshotCache
  }

  /**
   * Session ids of every agent with a parked ask (active plus queued) — the
   * agent view's "needs input" signal. Deduplicated, in park order.
   * @returns One id per asking agent, or an empty array when none waits.
   */
  pendingAgentIds(): readonly string[] {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const ask of [...(this.active === undefined ? [] : [this.active]), ...this.queue]) {
      const id = ask.snapshot.agentId
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    return ids
  }

  /**
   * The first parked ask's detail for one agent — the agent view's row
   * summary while it needs input (the question it is blocked on).
   * @param agentId - The asking session's id.
   * @returns The ask's reason / gated command / tool name, or undefined
   *   when the agent has no parked ask.
   */
  pendingAgentDetail(
    agentId: string,
  ): Pick<ApprovalSnapshot, 'toolName'> & Partial<Pick<ApprovalSnapshot, 'reason' | 'command'>> | undefined {
    for (const ask of [...(this.active === undefined ? [] : [this.active]), ...this.queue]) {
      if (ask.snapshot.agentId !== agentId) continue
      const { toolName, reason, command } = ask.snapshot
      return { toolName, ...(reason === undefined ? {} : { reason }), ...(command === undefined ? {} : { command }) }
    }
    return undefined
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Notify on a microtask so a re-check triggered inside getSnapshot
   * (during a React render) never fires listeners synchronously mid-render. */
  private scheduleNotify(): void {
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      this.emit()
    })
  }

  /** Rebuild the cached snapshot after any mutation of active. */
  private rebuildSnapshot(): void {
    const pending = this.active
    this.snapshotCache = pending === undefined
      ? null
      : { key: pending.key, ...pending.snapshot }
  }

  /**
   * Re-run the source-badge verdict for the active ask (P-4).
   *
   * The external flag computed at park() is only a point-in-time verdict. A
   * forger can dispatch a second request carrying the SAME callId as a
   * genuinely pending one — both look live at park time; once the first is
   * allowed and its tool/result lands, the twin surfaces with a callId that
   * no longer has an unresolved call and must not keep the unmarked panel
   * data. Re-checked when an ask becomes active (promotion), whenever the
   * snapshot is read (the result usually lands AFTER the twin was promoted),
   * and on every session `tool/result` notification (see
   * {@link noteSessionEvent}). The session log only appends, so the verdict
   * can only flip live→external, never back — the badge may appear late but
   * never falsely.
   */
  private refreshActiveExternal(): void {
    const pending = this.active
    if (pending === undefined || pending.snapshot.external === true) return
    const events = snapshotLiveSessionEvents(pending.request.agent.session)
    if (events.length === this.externalCheckedAtEvents) return
    this.externalCheckedAtEvents = events.length
    if (isLiveToolApproval(pending.request)) return
    pending.snapshot.external = true
    this.rebuildSnapshot()
    this.scheduleNotify()
  }

  /**
   * Session-event notification inlet (wired by plugin.ts to the
   * `session/event` firehose). React does not know the session log
   * appended: a badge flip that only happens inside getSnapshot() surfaces
   * solely when something ELSE re-renders the panel (a streaming spinner,
   * say) — a silent render loop leaves the unmarked panel on screen. A
   * landed `tool/result` is the only event type that can flip the active
   * verdict live→external, so everything else is dropped here; the internal
   * length memo then skips the recheck whenever the event belongs to a
   * different session than the active ask's. The notification the SDK
   * fires arrives after the event is already in the live session log, so the
   * recheck sees the settled result.
   * @param event - The appended session event.
   */
  noteSessionEvent(event: SessionEvent): void {
    if (event.type !== 'tool/result') return
    // Hygiene for {@link consumedCallIds}: once the paired result landed,
    // the liveness check marks any future twin on its own, so the consumed
    // entry can go.
    const resultCallId = (event.data.message as { source?: { callId?: unknown } } | undefined)?.source?.callId
    if (resultCallId !== undefined) {
      // Composite keys carry an agent prefix; a landed result retires the
      // callId in every agent domain (suffix match — only ever removes).
      const suffix = `::${String(resultCallId)}`
      for (const entry of this.consumedCallIds) {
        if (entry.endsWith(suffix)) this.consumedCallIds.delete(entry)
      }
    }
    this.refreshActiveExternal()
  }

  /**
   * Whether another ask with this callId is already parked (active or
   * queued). A genuine approval is raised once per gated tool call — the
   * permission layer asks, waits, and never re-asks for the same callId —
   * so a second ask reusing an in-flight callId is a forged twin dispatched
   * through the in-process waterfall. This is a DETERMINISTIC verdict: it
   * needs no tool/result to land, unlike {@link isLiveToolApproval}, whose
   * twin-reveal window (result lands only after the first ask is allowed
   * and the tool runs) is exactly when promotion-time rechecks still see no
   * result. Derived from the live active+queue set on each park(), so
   * settled asks free their callId automatically.
   */
  private isCallIdInFlight(req: ApprovalRequest): boolean {
    if (req.callId === undefined) return false
    const key = String(req.callId)
    const occupies = (pending: PendingApproval): boolean =>
      pending.request.callId !== undefined && String(pending.request.callId) === key
    return (this.active !== undefined && occupies(this.active)) || this.queue.some(occupies)
  }

  /**
   * Answerer entry point — called by the `approval/request` waterfall
   * listener for every ask in this process: the attached session's and any
   * background session's alike, so an unattended session surfaces as
   * "needs input" instead of failing closed with nobody to answer it.
   * @param req - The approval request (agent, tool, callId, reason, signal).
   * @returns A promise settling with the user's decision, or `'cancelled'`
   *   when the ask is withdrawn or the plugin tears down.
   */
  park(req: ApprovalRequest): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>(resolve => {
      const command = commandOf(req)
      // Source badge: park() is reached through the approval/request
      // waterfall, which any in-process plugin can dispatch — the agent-id
      // gate in plugin.ts says whose SESSION it names, not that a live tool
      // call actually raised it. Mark everything not anchored to an
      // unresolved tool call, plus any ask reusing a callId that is already
      // in flight or already consumed (a legitimate call is asked about
      // exactly once). A duplicate callId marks EVERY ask on it ambiguous
      // (attacker-first: a forged ask parked before the genuine one looks
      // clean on its own — see markCallIdAmbiguous), so the panel can warn.
      const duplicate = this.isCallIdInFlight(req)
      if (duplicate) this.markCallIdAmbiguous(req.callId)
      const external = !isLiveToolApproval(req) || duplicate
        || (req.callId !== undefined && this.consumedCallIds.has(consumedKey(req.agent.id, req.callId)))
      const pending: PendingApproval = {
        key: String(++this.seq),
        request: req,
        snapshot: {
          agentId: String(req.agent.id),
          toolName: req.toolName,
          ...(req.reason !== undefined ? { reason: req.reason } : {}),
          ...(command !== undefined ? { command } : {}),
          ...(external ? { external: true } : {}),
        },
        resolve,
        onAbort: () => {
          // A REAL controller.abort() sets `aborted` BEFORE dispatching the
          // event; a forged signal.dispatchEvent(new Event('abort')) fires
          // the listener with `aborted` still false. A forged abort must
          // not dequeue the genuine panel (abort-then-spoof: the attacker
          // empties the real ask in the same synchronous stack it parks a
          // same-callId twin, which then looks live) — badge it instead.
          if (req.signal !== undefined && !req.signal.aborted) {
            pending.snapshot.external = true
            this.rebuildSnapshot()
            this.scheduleNotify()
            return
          }
          if (this.active === pending) {
            this.active = undefined
            this.rebuildSnapshot()
            pending.resolve('cancelled')
            this.startNext()
            return
          }
          const at = this.queue.indexOf(pending)
          if (at >= 0) this.queue.splice(at, 1)
          pending.resolve('cancelled')
        },
      }
      req.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.queue.push(pending)
      this.startNext()
    })
  }

  /** Advance to the next queued ask, if any. The promoted ask's source
   * badge is re-checked against the log that has kept appending since it
   * was parked (P-4: a same-callId twin parked while live may surface long
   * after its call settled). */
  private startNext(): void {
    if (this.active !== undefined || this.queue.length === 0) return
    this.active = this.queue.shift()
    // Fresh active: force a fresh verdict regardless of the length memo.
    this.externalCheckedAtEvents = -1
    this.refreshActiveExternal()
    this.rebuildSnapshot()
    this.emit()
  }

  /**
   * The user decided on the current approval; settles it and drains the
   * next queued ask if any. No-op when nothing is pending.
   * @param outcome - `'allowed-once'` or `'rejected'`.
   */
  decide(outcome: 'allowed-once' | 'rejected'): void {
    const pending = this.active
    if (pending === undefined) return
    this.noteConsumed(pending)
    this.active = undefined
    this.rebuildSnapshot()
    pending.resolve(outcome)
    this.startNext()
    this.emit()
  }

  /**
   * Settle the active and all queued asks (plugin teardown). The panel
   * unmounts as the snapshot clears.
   * @param outcome - The outcome every pending ask resolves with.
   */
  settleAll(outcome: ApprovalOutcome): void {
    const active = this.active
    this.active = undefined
    if (active !== undefined) this.noteConsumed(active)
    this.rebuildSnapshot()
    active?.resolve(outcome)
    for (const pending of this.queue.splice(0)) {
      this.noteConsumed(pending)
      pending.resolve(outcome)
    }
    this.emit()
  }

  /**
   * Record a settling ask's callId as consumed (see {@link consumedCallIds}).
   * @param pending - The ask leaving the active/queue set.
   */
  private noteConsumed(pending: PendingApproval): void {
    const { callId } = pending.request
    if (callId !== undefined) this.consumedCallIds.add(consumedKey(pending.request.agent.id, callId))
  }

  /**
   * A same-callId duplicate just parked: every pending ask on that callId is
   * now source-ambiguous. The forged-first order parks the fake ask clean
   * (isLive true, no duplicate visible yet) and the genuine follow-up would
   * carry the only badge — an inverted verdict. Flip them all, then rebuild
   * + notify so an on-screen panel updates immediately. refreshActiveExternal
   * early-returns on an existing external verdict, so the marking is
   * monotonic and never erased. Deliberately badges instead of cancelling:
   * cancelling both would hand the attacker a force-cancel primitive
   * against genuine approvals.
   * @param callId - The duplicated call id (non-undefined by construction).
   */
  private markCallIdAmbiguous(callId: unknown): void {
    const key = String(callId)
    const same = (pending: PendingApproval): boolean =>
      pending.request.callId !== undefined && String(pending.request.callId) === key
    let flipped = false
    if (this.active !== undefined && same(this.active) && this.active.snapshot.external !== true) {
      this.active.snapshot.external = true
      flipped = true
    }
    for (const pending of this.queue) {
      if (same(pending) && pending.snapshot.external !== true) {
        pending.snapshot.external = true
        flipped = true
      }
    }
    if (flipped) {
      this.rebuildSnapshot()
      this.scheduleNotify()
    }
  }
}
