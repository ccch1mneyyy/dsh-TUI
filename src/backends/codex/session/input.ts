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
 *   claims it); a turn that fails to start discards it.
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
import { t } from '../../../i18n.js'
import { errorText, rec, str, type Rec } from '../narrow.js'
import { CLIENT } from '../protocol/index.js'
import type { UserInput } from '../protocol/index.js'
import type { RpcClock } from '../rpc/client.js'

/** One submitted input this session still tracks. */
interface Entry {
  readonly id: string
  readonly text: string
  readonly input: readonly UserInput[]
  readonly placement: PendingItem['placement']
}

export interface InputQueueDeps {
  readonly threadId: string
  call<R = unknown>(method: string, params: unknown): Promise<R>
  emit(events: readonly AgentEvent[]): void
  debug(message: string): void
  /** Per-turn overrides (`turn/start` settings; C2 fills them). */
  overrides(): Rec
  closed(): boolean
  /** The open turn could not be settled by the server: close it here. */
  forceClose(): void
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
  /** A `turn/start` in flight: resolves with the turn id (undefined = it failed). */
  let starting: Promise<string | undefined> | undefined
  /** Inputs not sent yet (the client follow-up queue). */
  let queue: Entry[] = []
  /** Sent with `turn/start`, not yet claimed by their user message. */
  const started = new Map<string, Entry>()
  /** Sent with `turn/steer`, not yet claimed. */
  const steered = new Map<string, Entry>()
  /** Why the running turn is being cancelled (decides the fate of steers). */
  let cancelCause: CancelCause | undefined
  let forceTimer: unknown
  let steerFallbackSaid = false
  /** The connection is down: nothing is sent until it is back. */
  let offline = false

  const snapshot = (): PendingItem[] => [
    ...[...steered.values()].map(entry => ({ id: entry.id, text: entry.text, placement: 'steer' as const })),
    ...queue.map(entry => ({ id: entry.id, text: entry.text, placement: entry.placement })),
  ]
  const pendingEvent = (change: { claimed?: readonly string[]; discarded?: readonly string[] }): AgentEvent =>
    ({ type: 'pending.changed', items: snapshot(), ...change })

  const clearForceTimer = (): void => {
    if (forceTimer === undefined) return
    deps.clock.clearTimeout(forceTimer)
    forceTimer = undefined
  }

  /** Send one input as a new turn. */
  const startTurn = async (entry: Entry): Promise<{ readonly accepted: boolean; readonly reason?: string }> => {
    started.set(entry.id, entry)
    let resolveStart!: (id: string | undefined) => void
    starting = new Promise(resolve => { resolveStart = resolve })
    try {
      const answer = rec(await deps.call(CLIENT.turnStart, {
        threadId: deps.threadId,
        clientUserMessageId: entry.id,
        input: entry.input,
        ...deps.overrides(),
      }))
      const turnId = str(rec(answer?.turn)?.id)
      if (turnId !== undefined && activeTurnId === undefined) activeTurnId = turnId
      resolveStart(turnId ?? activeTurnId)
      return { accepted: true }
    } catch (error) {
      started.delete(entry.id)
      resolveStart(undefined)
      const reason = t('codex-turn-start-failed', { err: errorText(error) })
      deps.debug(`codex: turn/start failed (${errorText(error)})`)
      deps.emit([pendingEvent({ discarded: [entry.id] })])
      return { accepted: false, reason }
    } finally {
      starting = undefined
    }
  }

  /** Start the next queued input when the thread is idle. */
  const drain = (): void => {
    if (offline || deps.closed() || activeTurnId !== undefined || starting !== undefined) return
    const next = queue.shift()
    if (next === undefined) return
    void startTurn(next).then(result => {
      if (!result.accepted) deps.emit([{ type: 'notice', level: 'error', text: result.reason ?? t('codex-turn-start-failed', { err: '' }) }])
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
        deps.emit([{ type: 'notice', level: 'info', text: t('codex-steer-fallback') }])
      }
      drain()
      return { accepted: true }
    }
  }

  const interrupt = async (): Promise<boolean> => {
    const turnId = activeTurnId ?? await starting
    if (turnId === undefined) return true
    try {
      await deps.call(CLIENT.turnInterrupt, { threadId: deps.threadId, turnId })
    } catch (error) {
      deps.debug(`codex: turn/interrupt failed (${errorText(error)})`)
      return false
    }
    if (forceTimer === undefined) {
      forceTimer = deps.clock.setTimeout(() => {
        forceTimer = undefined
        if (activeTurnId !== turnId) return
        deps.emit([{ type: 'notice', level: 'warning', text: t('codex-cancel-forced') }])
        deps.forceClose()
        onTurnCompleted(turnId, true)
      }, deps.forceSettleMs)
    }
    return true
  }

  /** The turn ended: settle unclaimed inputs, then start the next queued one. */
  const onTurnCompleted = (turnId: string | undefined, interrupted: boolean): void => {
    if (turnId !== undefined && activeTurnId !== undefined && turnId !== activeTurnId) return
    clearForceTimer()
    activeTurnId = undefined
    const cause = cancelCause
    cancelCause = undefined
    const events: AgentEvent[] = []
    // A turn/start whose user message never showed: it did not run.
    if (started.size > 0) {
      const ids = [...started.keys()]
      started.clear()
      events.push(pendingEvent({ discarded: ids }))
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
        // Dropped by the interrupt (V6) but still wanted: run them next.
        queue = [...leftover.map(entry => ({ ...entry, placement: 'followup' as const })), ...queue]
      }
    }
    if (events.length > 0) deps.emit(events)
    drain()
  }

  return {
    get activeTurnId() { return activeTurnId },
    /** Whether a turn runs or is being started. */
    busy(): boolean { return activeTurnId !== undefined || starting !== undefined },

    async submit(input: AgentInput, placement: SubmitPlacement): Promise<{ readonly accepted: boolean; readonly reason?: string }> {
      if (deps.closed()) throw new Error(t('codex-session-closed'))
      if ((input.images ?? []).length > 0 || (input.blocks ?? []).some(block => block.type === 'image')) {
        throw new Error(t('codex-images-unsupported'))
      }
      const entry: Entry = { id: input.clientMessageId, text: input.text, input: userInputOf(input), placement: placement === 'steer' ? 'steer' : 'followup' }
      if (offline) {
        queue.push(entry)
        return { accepted: true }
      }
      if (activeTurnId === undefined && starting === undefined) return startTurn(entry)
      switch (placement) {
        case 'steer':
          return steer(entry)
        case 'now':
          queue.unshift(entry)
          void interrupt()
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
        if (!ok) return { stillQueued: cause === 'user' ? covered : [...steered.keys()], outcome: 'failed' }
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

    /** A user message carried this client id back: the input ran. */
    claim(clientId: string): AgentEvent | undefined {
      if (!started.delete(clientId) && !steered.delete(clientId)) return undefined
      return pendingEvent({ claimed: [clientId] })
    },

    onTurnStarted(turnId: string): void {
      activeTurnId = turnId
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
      activeTurnId = undefined
      const lost = [...started.keys(), ...steered.keys()]
      started.clear()
      steered.clear()
      return lost.length === 0 ? [] : [pendingEvent({ discarded: lost })]
    },
    connectionRestored(): void {
      offline = false
      drain()
    },

    /** Dispose: forget everything, stop the timer. */
    close(): void {
      clearForceTimer()
      queue = []
      started.clear()
      steered.clear()
    },
    /** Interrupt the running turn (best-effort, dispose path). */
    interrupt,
  }
}

export type InputQueue = ReturnType<typeof createInputQueue>
