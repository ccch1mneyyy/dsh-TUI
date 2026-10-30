/**
 * Input placement, the client follow-up queue and cancel receipts of one
 * Codex thread (docs/codex-backend-design.md §5.7, D8, D9).
 *
 * - Idle: every placement starts a turn (`turn/start`).
 * - A turn running (or starting): `steer` joins it (`turn/steer` with the
 *   expected turn id; a turn that cannot take it falls back to the queue,
 *   said once); `turn` / `followup` wait in the client queue and start one
 *   at a time after `turn/completed`; `now` goes to the queue front and
 *   interrupts the running turn.
 * - Nothing is shown optimistically: an input becomes a user row when its
 *   `userMessage` item carries its client id back (then `pending.changed`
 *   claims it); a turn that fails to start discards it (a queued one is
 *   `dropped`: the channel holds it).
 * - Cancel: the queue lives in this process, so every receipt is
 *   `confirmed`. Codex drops a steer the turn has not taken yet when the
 *   turn is interrupted (C0 V6): a `user` cancel queues those again in
 *   order (they still run next), an `interrupt` cancel drops them with the
 *   queue (the channel docks its copies).
 * - An interrupt that never completes the turn is force-closed after
 *   `forceSettleMs` (a stuck relay, F29).
 */
import type { AgentEvent, PendingItem } from '../../../agent/events.js'
import type { AgentInput, CancelCause, CancelReceipt, SubmitPlacement } from '../../../agent/session.js'
import { codexText } from '../text.js'
import { errorText, rec, str, type Rec } from '../narrow.js'
import { CLIENT } from '../protocol/index.js'
import { codexImageInputs } from './images.js'
import type { UserInput } from '../protocol/index.js'
import { RPC_ERROR, rpcCode, type RpcClock } from '../rpc/client.js'

/** One submitted input this session still tracks. */
interface Entry {
  readonly id: string
  readonly text: string
  readonly input: readonly UserInput[]
  readonly placement: PendingItem['placement']
  /** Sent with `now`: it runs before anything else waiting, steers the
   *  interrupt dropped included. */
  readonly urgent?: true
}

export interface InputQueueDeps {
  readonly threadId: string
  call<R = unknown>(method: string, params: unknown): Promise<R>
  emit(events: readonly AgentEvent[]): void
  debug(message: string): void
  /** Per-turn overrides (`turn/start` settings; C2 fills them). */
  overrides(): Rec
  /** Retire a rejected experimental setting; never retry the user's input. */
  startFailed?(error: unknown, overrides: Rec): void
  closed(): boolean
  /** The open turn could not be settled by the server: close it here. */
  forceClose(turnId: string, reviewTurnId?: string): void
  readonly clock: RpcClock
  readonly forceSettleMs: number
}

/** The model-facing input of a submission: every text block as its own
 *  text input (the first is what the user typed), in block order. */
export function userInputOf(input: AgentInput): UserInput[] {
  const blocks = input.blocks ?? [{ type: 'text', text: input.text }]
  const out: UserInput[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') out.push({ type: 'text', text: block.text, text_elements: [] })
  }
  if (out.length === 0) out.push({ type: 'text', text: input.text, text_elements: [] })
  return out
}

export function createInputQueue(deps: InputQueueDeps) {
  /** The running turn (from its start answer or `turn/started`). */
  let activeTurnId: string | undefined
  /** Inline reviews can use a different id for items/completion than the
   *  one announced by `turn/started` (Codex 0.160.1). */
  let reviewTurnId: string | undefined
  /** A `turn/start` in flight: resolves with the turn id (undefined = it failed). */
  let starting: Promise<string | undefined> | undefined
  /** Reviews announce their interrupt id separately from their request id. */
  let resolveReviewStart: ((id: string | undefined) => void) | undefined
  /** Inputs not sent yet (the client follow-up queue). */
  let queue: Entry[] = []
  /** Sent with `turn/start`, not yet claimed by their user message. */
  const started = new Map<string, Entry>()
  /** Sent with `turn/steer`, not yet claimed. */
  const steered = new Map<string, Entry>()
  /** Why the running turn is being cancelled (decides the fate of steers). */
  let cancelCause: CancelCause | undefined
  /** A `turn/interrupt` is on the wire: a `turn/completed` that lands first is
   *  the server's own end, not this interrupt's (see `onTurnCompleted`). */
  let interruptInFlight = false
  let forceTimer: unknown
  let steerFallbackSaid = false
  /** The running turn showed a user message: what it started ran, echoed
   *  id or not (an id-less echo must not read as a refusal). */
  let userMessageSeen = false
  /** The connection is down: nothing is sent until it is back. */
  let offline = false
  /** The connection is gone FOR GOOD: submits fail fast instead of parking. */
  let dead = false

  const snapshot = (): PendingItem[] => [
    ...[...steered.values()].map(entry => ({ id: entry.id, text: entry.text, placement: 'steer' as const })),
    ...queue.map(entry => ({ id: entry.id, text: entry.text, placement: entry.placement })),
  ]
  const pendingEvent = (change: { claimed?: readonly string[]; discarded?: readonly string[]; dropped?: readonly string[] }): AgentEvent =>
    ({ type: 'pending.changed', items: snapshot(), ...change })

  const clearForceTimer = (): void => {
    if (forceTimer === undefined) return
    deps.clock.clearTimeout(forceTimer)
    forceTimer = undefined
  }

  const settleReviewStart = (id?: string): void => {
    if (resolveReviewStart === undefined) return
    resolveReviewStart(id)
    resolveReviewStart = undefined
    starting = undefined
  }

  /** Send one input as a new turn. A queued input a protocol-level refusal
   *  rejects is `dropped` (the channel holds it); a direct submit's refusal
   *  answers it. A timeout, a lost connection or an `internal`/unknown error
   *  is no refusal: the server may still run the turn, so the input stays a
   *  discard. */
  const startTurn = async (entry: Entry, queued = false): Promise<{ readonly accepted: boolean; readonly reason?: string; readonly dropped?: boolean }> => {
    started.set(entry.id, entry)
    let resolveStart!: (id: string | undefined) => void
    starting = new Promise(resolve => { resolveStart = resolve })
    const overrides = deps.overrides()
    try {
      const answer = rec(await deps.call(CLIENT.turnStart, {
        threadId: deps.threadId,
        clientUserMessageId: entry.id,
        input: entry.input,
        ...overrides,
      }))
      const turnId = str(rec(answer?.turn)?.id)
      if (turnId !== undefined && activeTurnId === undefined) activeTurnId = turnId
      resolveStart(turnId ?? activeTurnId)
      return { accepted: true }
    } catch (error) {
      deps.startFailed?.(error, overrides)
      started.delete(entry.id)
      resolveStart(undefined)
      const reason = codexText('codex-turn-start-failed', { err: errorText(error) })
      deps.debug(`codex: turn/start failed (${errorText(error)})`)
      // Only a protocol-level rejection proves the server did not take the
      // input. `internal` or an unknown code may answer a request it already
      // started, so holding that input could run it twice (#1651).
      const code = rpcCode(error)
      const refused = !offline
        && (code === RPC_ERROR.invalidRequest || code === RPC_ERROR.methodNotFound || code === RPC_ERROR.invalidParams)
      // A queued input has no caller left to read the result, so its refusal is
      // announced on the pending channel. A direct submit carries `dropped`
      // back instead: retiring its preview here would race that answer.
      if (refused && queued) deps.emit([pendingEvent({ dropped: [entry.id] })])
      else if (!refused) deps.emit([pendingEvent({ discarded: [entry.id] })])
      return { accepted: false, reason, ...(refused ? { dropped: true } : {}) }
    } finally {
      starting = undefined
    }
  }

  /** Start the next queued input when the thread is idle. */
  const drain = (): void => {
    if (offline || deps.closed() || activeTurnId !== undefined || starting !== undefined) return
    const next = queue.shift()
    if (next === undefined) return
    void startTurn(next, true).then(result => {
      if (!result.accepted) deps.emit([{ type: 'notice', level: 'error', text: result.reason ?? codexText('codex-turn-start-failed', { err: '' }) }])
      else drain()
    })
  }

  /** Join the running turn, or fall back to the queue. */
  const steer = async (entry: Entry): Promise<{ readonly accepted: boolean; readonly reason?: string }> => {
    const turnId = activeTurnId ?? await starting
    if (turnId === undefined) {
      queue.push(entry)
      drain()
      return { accepted: true }
    }
    steered.set(entry.id, entry)
    try {
      await deps.call(CLIENT.turnSteer, { threadId: deps.threadId, expectedTurnId: turnId, clientUserMessageId: entry.id, input: entry.input })
      return { accepted: true }
    } catch (error) {
      steered.delete(entry.id)
      deps.debug(`codex: turn/steer refused (${errorText(error)}); queued as a follow-up`)
      if (deps.closed()) throw error
      queue.push(entry)
      if (!steerFallbackSaid) {
        steerFallbackSaid = true
        deps.emit([{ type: 'notice', level: 'info', text: codexText('codex-steer-fallback') }])
      }
      drain()
      return { accepted: true }
    }
  }

  const interrupt = async (waitForReviewStart = true): Promise<boolean> => {
    // Dispose has already stopped notification delivery. It cannot wait for
    // a review lifecycle id that only a notification could resolve.
    const turnId = activeTurnId ?? (resolveReviewStart !== undefined && !waitForReviewStart ? undefined : await starting)
    if (turnId === undefined) {
      // No turn took it (its start failed): the next turn's end is not this
      // interrupt's.
      cancelCause = undefined
      return true
    }
    interruptInFlight = true
    try {
      await deps.call(CLIENT.turnInterrupt, { threadId: deps.threadId, turnId })
    } catch (error) {
      deps.debug(`codex: turn/interrupt failed (${errorText(error)})`)
      return false
    } finally {
      interruptInFlight = false
    }
    if (forceTimer === undefined) {
      forceTimer = deps.clock.setTimeout(() => {
        forceTimer = undefined
        if (activeTurnId !== turnId) return
        deps.emit([{ type: 'notice', level: 'warning', text: codexText('codex-cancel-forced') }])
        deps.forceClose(turnId, reviewTurnId)
        onTurnCompleted(turnId, true)
      }, deps.forceSettleMs)
    }
    return true
  }

  /** The turn ended: settle unclaimed inputs, then start the next queued one. */
  const onTurnCompleted = (turnId: string | undefined, interrupted: boolean): void => {
    if (turnId !== undefined && activeTurnId !== undefined && turnId !== activeTurnId && turnId !== reviewTurnId) return
    clearForceTimer()
    settleReviewStart()
    activeTurnId = undefined
    reviewTurnId = undefined
    // A `turn/completed` that lands while `turn/interrupt` is still unanswered
    // is the server's own end: the interrupt came too late to stop it, so the
    // turn is not this session's cancellation and unclaimed inputs stay
    // `dropped` (the channel holds them) instead of being thrown away.
    const cause = interruptInFlight && !interrupted ? undefined : cancelCause
    cancelCause = undefined
    const ran = userMessageSeen
    userMessageSeen = false
    const events: AgentEvent[] = []
    // A turn/start whose turn showed no user message: it did not run. Unless
    // this session cancelled the turn, the input is held (`dropped`).
    if (started.size > 0) {
      const ids = [...started.keys()]
      started.clear()
      events.push(pendingEvent(cause === undefined && !ran ? { dropped: ids } : { discarded: ids }))
    }
    if (steered.size > 0) {
      const leftover = [...steered.values()]
      steered.clear()
      if (!interrupted) {
        // A completed turn records the input it had not taken yet.
        events.push(pendingEvent({ claimed: leftover.map(entry => entry.id) }))
      } else if (cause === 'interrupt' || cause === 'switch' || cause === 'dispose') {
        events.push(pendingEvent({ discarded: leftover.map(entry => entry.id) }))
      } else {
        // Dropped by the interrupt (V6) but still wanted: run them next,
        // after an input sent with `now` (the reason for the interrupt).
        const urgent = queue.filter(entry => entry.urgent === true)
        const rest = queue.filter(entry => entry.urgent !== true)
        queue = [...urgent, ...leftover.map(entry => ({ ...entry, placement: 'followup' as const })), ...rest]
      }
    }
    if (events.length > 0) deps.emit(events)
    drain()
  }

  return {
    get activeTurnId() { return activeTurnId },
    /** Whether a turn runs or is being started. */
    busy(): boolean { return activeTurnId !== undefined || starting !== undefined },

    async submit(input: AgentInput, placement: SubmitPlacement, wireInput?: readonly UserInput[]): Promise<{ readonly accepted: boolean; readonly reason?: string; readonly dropped?: boolean }> {
      if (deps.closed()) throw new Error(codexText('codex-session-closed'))
      if (dead) throw new Error(codexText('codex-connection-dead'))
      if ((input.images ?? []).length === 0 && (input.blocks ?? []).some(block => block.type === 'image')) throw new Error(codexText('codex-image-unreadable', { name: input.clientMessageId }))
      const pictureInputs = await codexImageInputs(input.images ?? [])
      if (deps.closed()) throw new Error(codexText('codex-session-closed'))
      const entry: Entry = { id: input.clientMessageId, text: input.text, input: [...(wireInput ?? userInputOf(input)), ...pictureInputs], placement: placement === 'steer' ? 'steer' : 'followup' }
      if (offline) {
        queue.push(entry)
        return { accepted: true }
      }
      if (activeTurnId === undefined && starting === undefined) return startTurn(entry)
      switch (placement) {
        case 'steer':
          return steer(entry)
        case 'now':
          queue.unshift({ ...entry, urgent: true })
          // This session's own interrupt, like a user cancel: an input the
          // turn had not echoed yet is discarded, not held as dropped.
          cancelCause ??= 'user'
          void interrupt().then(ok => {
            // The turn goes on: its end must not be read as this interrupt's.
            if (!ok && cancelCause === 'user') cancelCause = undefined
          })
          return { accepted: true }
        default:
          queue.push(entry)
          return { accepted: true }
      }
    },

    async cancel(cause: CancelCause): Promise<CancelReceipt> {
      const covered = [...steered.keys(), ...queue.map(entry => entry.id)]
      const busy = activeTurnId !== undefined || starting !== undefined
      if (cause !== 'user') {
        const dropped = queue.map(entry => entry.id)
        queue = []
        if (dropped.length > 0) deps.emit([pendingEvent({ discarded: dropped })])
      }
      if (busy) {
        cancelCause = cause
        const ok = await interrupt()
        if (!ok) {
          // The turn goes on: its end must not be read as this cancel's.
          cancelCause = undefined
          return { stillQueued: cause === 'user' ? covered : [...steered.keys()], outcome: 'failed' }
        }
      }
      return cause === 'user'
        ? { stillQueued: [...steered.keys(), ...queue.map(entry => entry.id)], outcome: 'confirmed' }
        : { stillQueued: [], outcome: 'confirmed' }
    },

    /** Pull a queued input back before it is sent. */
    remove(id: string): boolean {
      const index = queue.findIndex(entry => entry.id === id)
      if (index === -1) return false
      queue.splice(index, 1)
      return true
    },

    /** The turn showed a user message; one carrying a client id back says
     *  that input ran. */
    claim(clientId: string | undefined): AgentEvent | undefined {
      userMessageSeen = true
      if (clientId === undefined) return undefined
      if (!started.delete(clientId) && !steered.delete(clientId)) return undefined
      return pendingEvent({ claimed: [clientId] })
    },

    onTurnStarted(turnId: string): void {
      activeTurnId = turnId
      settleReviewStart(turnId)
    },
    /** Reserve the turn before review/start reaches the server. The returned
     *  cleanup releases only this request's wait if its RPC fails. */
    beginReview(): () => void {
      const pending = new Promise<string | undefined>(resolve => { resolveReviewStart = resolve })
      starting = pending
      return () => {
        if (starting !== pending) return
        settleReviewStart()
        reviewTurnId = undefined
        cancelCause = undefined
        drain()
      }
    },
    onReviewStarted(turnId: string): void {
      reviewTurnId = turnId
      // review/start's id cannot be used by turn/interrupt. Keep submissions
      // queued and let an early Esc wait for the native lifecycle id.
      if (activeTurnId === undefined && starting === undefined) starting = new Promise(resolve => { resolveReviewStart = resolve })
    },
    onTurnCompleted,

    /** Re-queue a rejection's reason as the next turn (D10). */
    enqueueFollowup(id: string, text: string): void {
      queue.push({ id, text, input: [{ type: 'text', text, text_elements: [] }], placement: 'followup' })
      drain()
    },

    /** The connection dropped: the running turn is gone, the queue stays. */
    connectionLost(): readonly AgentEvent[] {
      offline = true
      clearForceTimer()
      settleReviewStart()
      activeTurnId = undefined
      reviewTurnId = undefined
      userMessageSeen = false
      const lost = [...started.keys(), ...steered.keys()]
      started.clear()
      steered.clear()
      return lost.length === 0 ? [] : [pendingEvent({ discarded: lost })]
    },
    connectionRestored(): void {
      offline = false
      dead = false
      drain()
    },
    /** The connection is gone for good: the parked queue never went out,
     *  so it is `dropped` (the channel holds it) and later submits fail fast
     *  instead of parking forever behind an offline flag nothing will ever
     *  clear. */
    permanentLoss(): readonly AgentEvent[] {
      offline = false
      dead = true
      const dropped = queue.map(entry => entry.id)
      queue = []
      return dropped.length === 0 ? [] : [pendingEvent({ dropped })]
    },

    /** Dispose: forget everything, stop the timer. */
    close(): void {
      clearForceTimer()
      settleReviewStart()
      queue = []
      started.clear()
      steered.clear()
      reviewTurnId = undefined
    },
    /** Interrupt the running turn (best-effort, dispose path). */
    interrupt,
  }
}

export type InputQueue = ReturnType<typeof createInputQueue>
