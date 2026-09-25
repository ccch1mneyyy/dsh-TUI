import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ChannelOwner } from './owner.js'

export interface BindingCapture {
  readonly agent: Agent
  readonly generation: number
}

export interface BindingCommit {
  readonly agent: Agent
  readonly handle: AgentHandle | undefined
  readonly generation: number
}

type PreviousDisposition = 'dispose' | 'park'

/**
 * Sole writer of the attached Agent/handle identity and binding generation.
 *
 * A prepared handle remains owned by this cell until its synchronous adoption
 * tail returns.  The tail is deliberately callback-shaped: it cannot leave a
 * committed identity waiting for a microtask watchdog to infer whether setup
 * completed, and a throw always revokes the transaction immediately.
 */
export function createChannelBinding(initial: Agent, handle: AgentHandle | undefined, owner: ChannelOwner) {
  let currentAgent = initial
  let currentHandle = handle
  let generation = 0
  let started = false
  let subscriptions: (() => void)[] = []
  let handoff: symbol | undefined
  const pending = new Map<AgentHandle, BindingCapture>()
  /**
   * The in-flight (or finished) close of a handle this cell owns, keyed by the
   * handle. A Promise rather than a "has it started" flag, because the callers
   * that matter need to know when the handle has actually STOPPED writing: a
   * ledger reservation is only safe to give back after that, and a second
   * `dispose()` must not start a parallel close.
   */
  const closing = new WeakMap<AgentHandle, Promise<void>>()
  const closingSessions = new Map<string, Promise<void>>()

  /** Close `candidate` exactly once; the result resolves however it ends. */
  const dispose = (candidate: AgentHandle): Promise<void> => {
    const started = closing.get(candidate)
    if (started !== undefined) return started
    // Kicked off SYNCHRONOUSLY: revocation is part of a synchronous transaction
    // boundary, and a caller that abandons a candidate may check it right away.
    // Only the waiting is deferred, never the call.
    let close: Promise<void>
    try {
      close = Promise.resolve(candidate.dispose()).catch(() => undefined)
    } catch {
      close = Promise.resolve()
    }
    closing.set(candidate, close)
    const id = String(candidate.agent.session.id)
    closingSessions.set(id, close)
    void close.then(() => {
      if (closingSessions.get(id) === close) closingSessions.delete(id)
    })
    return close
  }
  const disposePending = (candidate: AgentHandle): Promise<void> | undefined => {
    if (pending.delete(candidate)) return dispose(candidate)
    // Already un-pended (a revocation path took it out from under the caller):
    // hand back the close that is already running, so a caller that HAS to
    // wait — one about to give a ledger reservation back — still can.
    return closing.get(candidate)
  }
  const clearSubscriptions = (afterEach?: () => void): unknown => {
    const active = subscriptions.splice(0)
    let failure: unknown
    // A bad unsubscriber must not prevent the rest of a binding's cleanup.
    for (const unsubscribe of active) {
      try { unsubscribe() } catch (error) { failure ??= error }
      // Every unsubscriber is external code and can revoke the owner or try a
      // rival handoff. Record that state before running the next cleanup.
      try { afterEach?.() } catch (error) { failure ??= error }
    }
    return failure
  }
  const isCaptureCurrent = (capture: BindingCapture): boolean =>
    owner.current() && capture.agent === currentAgent && capture.generation === generation
  /**
   * Start a close without waiting for it. The callers below are synchronous
   * transaction boundaries — they must not turn into awaits — but the close
   * itself stays observable through {@link dispose}, so a caller that DOES have
   * to wait (an `abandon` handing a ledger reservation back) still can.
   */
  const startClose = (close: Promise<void> | undefined): void => {
    void close
  }
  const assertPrepared = (candidate: AgentHandle, capture: BindingCapture): void => {
    if (pending.get(candidate) !== capture || !isCaptureCurrent(capture)) {
      startClose(disposePending(candidate))
      throw new Error('dsh-tui: Channel binding changed before adoption')
    }
  }
  const settlePrevious = (previous: BindingCommit, disposition: PreviousDisposition): void => {
    // Parking deliberately transfers ownership to the caller's background
    // ledger. Disposal is centralised here so no adoption tail can double-call
    // an old handle while its transaction is being revoked. Neither path waits:
    // an ordinary session switch must not block on the handle it just left.
    if (disposition === 'dispose' && previous.handle !== undefined && previous.handle !== currentHandle) {
      startClose(dispose(previous.handle))
    }
  }

  owner.own(clearSubscriptions)
  owner.own(() => { for (const candidate of [...pending.keys()]) startClose(disposePending(candidate)) })

  const adopt = <T>(
    candidate: AgentHandle,
    capture: BindingCapture,
    tail: (previous: BindingCommit, disposition: (next: PreviousDisposition) => void) => T,
  ): T => {
    if (handoff !== undefined) {
      // Mark the outer transaction superseded as well as rejecting this one;
      // letting its tail return success after a reentrant handoff attempt
      // would publish a binding whose cleanup authority was contested.
      handoff = undefined
      disposePending(candidate)
      throw new Error('dsh-tui: Channel binding handoff is already in progress')
    }
    assertPrepared(candidate, capture)
    const token = Symbol('channel-binding-handoff')
    handoff = token
    const previous: BindingCommit = { agent: currentAgent, handle: currentHandle, generation }
    let disposition: PreviousDisposition | undefined
    const decidePrevious = (next: PreviousDisposition): void => {
      if (disposition === undefined || disposition === next) { disposition = next; return }
      throw new Error('dsh-tui: Channel binding previous disposition changed')
    }
    let succeeded = false
    try {
      const cleanupFailure = clearSubscriptions(() => {
        if (handoff !== token || !isCaptureCurrent(capture) || pending.get(candidate) !== capture) {
          throw new Error('dsh-tui: Channel binding changed before adoption')
        }
      })
      if (cleanupFailure !== undefined) throw cleanupFailure
      // Unsubscription is external code: it can revoke the owner or attempt a
      // rival adoption. Never write a candidate after either event.
      if (handoff !== token) throw new Error('dsh-tui: Channel binding handoff was superseded')
      assertPrepared(candidate, capture)
      pending.delete(candidate)
      currentAgent = candidate.agent
      currentHandle = candidate
      generation += 1
      const result = tail(previous, decidePrevious)
      // Tail callbacks include notifier/listener code and therefore remain a
      // synchronous reentrancy boundary even though they contain no await.
      if (handoff !== token || !owner.current() || currentHandle !== candidate) {
        throw new Error('dsh-tui: Channel binding changed during adoption')
      }
      succeeded = true
      return result
    } catch (error) {
      // This candidate is transaction-owned, unlike the baseline live handle
      // which ordinary UI owner teardown only unsubscribes from.
      if (currentHandle === candidate) {
        currentHandle = undefined
      }
      startClose(dispose(candidate))
      owner.dispose()
      throw error
    } finally {
      settlePrevious(previous, succeeded ? disposition ?? 'dispose' : 'dispose')
      if (handoff === token) handoff = undefined
    }
  }

  const switchTo = <T>(
    agent: Agent,
    nextHandle: AgentHandle | undefined,
    tail: (previous: BindingCommit, disposition: (next: PreviousDisposition) => void) => T,
  ): T => {
    owner.assertActive()
    if (handoff !== undefined) {
      handoff = undefined
      throw new Error('dsh-tui: Channel binding handoff is already in progress')
    }
    const token = Symbol('channel-binding-handoff')
    handoff = token
    const previous: BindingCommit = { agent: currentAgent, handle: currentHandle, generation }
    let disposition: PreviousDisposition | undefined
    const decidePrevious = (next: PreviousDisposition): void => {
      if (disposition === undefined || disposition === next) { disposition = next; return }
      throw new Error('dsh-tui: Channel binding previous disposition changed')
    }
    let succeeded = false
    try {
      const cleanupFailure = clearSubscriptions(() => {
        if (handoff !== token || !owner.current()) throw new Error('dsh-tui: Channel binding changed during adoption')
      })
      if (cleanupFailure !== undefined) throw cleanupFailure
      if (handoff !== token || !owner.current()) throw new Error('dsh-tui: Channel binding changed during adoption')
      currentAgent = agent
      currentHandle = nextHandle
      generation += 1
      const result = tail(previous, decidePrevious)
      if (handoff !== token || !owner.current() || currentAgent !== agent || currentHandle !== nextHandle) {
        throw new Error('dsh-tui: Channel binding changed during adoption')
      }
      succeeded = true
      return result
    } catch (error) {
      // An already-live agent is not a prepared candidate.  Revocation leaves
      // its owner to decide disposal, preserving the baseline teardown rule.
      owner.dispose()
      throw error
    } finally {
      settlePrevious(previous, succeeded ? disposition ?? 'dispose' : 'dispose')
      if (handoff === token) handoff = undefined
    }
  }

  return {
    get agent() { return currentAgent },
    get handle() { return currentHandle },
    get generation() { return generation },
    capture(): BindingCapture { return { agent: currentAgent, generation } },
    isCurrent(capture: BindingCapture) { return isCaptureCurrent(capture) },

    /**
     * Create a candidate without giving it authority over the live binding.
     *
     * When the capture went stale the candidate is closed and the rejection
     * WAITS for that close. The caller's `abandon(handle)` can no longer see the
     * handle — it was never in `pending` — so waiting here is the only way the
     * handle is known to have stopped writing before the caller gives its
     * ledger reservation back.
     */
    async prepare(capture: BindingCapture, create: () => Promise<AgentHandle>): Promise<AgentHandle> {
      owner.assertActive()
      if (!isCaptureCurrent(capture)) throw new Error('dsh-tui: Channel binding changed before preparation')
      const candidate = await create()
      if (!isCaptureCurrent(capture)) {
        await dispose(candidate)
        throw new Error('dsh-tui: Channel binding changed during preparation')
      }
      pending.set(candidate, capture)
      // Owner disposal may synchronously occur through embedding hooks while
      // ownership is registered; verify the pending entry itself as well.
      if (!isCaptureCurrent(capture) || pending.get(candidate) !== capture) {
        await disposePending(candidate)
        throw new Error('dsh-tui: Channel binding changed during preparation')
      }
      return candidate
    },

    /**
     * Dispose an uncommitted candidate exactly once and WAIT for the close.
     *
     * Waiting is the point: callers use this on the path where they are about
     * to give a cross-process ledger reservation back, and that reservation may
     * only be released once the handle has actually stopped writing. A live
     * handle that this cell never owned is inert here.
     */
    async abandon(candidate: AgentHandle): Promise<void> {
      await disposePending(candidate)
    },

    /** A registry may retain an agent while its async handle close drains. */
    async waitForDisposal(sessionId: string): Promise<void> {
      await closingSessions.get(sessionId)
    },

    /** Perform one explicit synchronous prepared-handle adoption transaction. */
    adopt,
    /** Perform one explicit synchronous already-live-agent adoption transaction. */
    switchTo,

    // bindAgent is still responsible for constructing the typed subscriptions.
    // Initial activation establishes generation 1; later rebinds have already
    // advanced the generation inside their adoption transaction.
    bind() {
      owner.assertActive()
      if (!started) {
        started = true
        generation += 1
      }
      return generation
    },
    subscribe(dispose: () => void) { subscriptions.push(dispose) },
    clearSubscriptions,
  }
}

export type ChannelBinding = ReturnType<typeof createChannelBinding>
