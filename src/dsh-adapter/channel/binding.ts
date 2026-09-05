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
  const disposed = new WeakSet<AgentHandle>()

  const dispose = (candidate: AgentHandle): void => {
    if (disposed.has(candidate)) return
    disposed.add(candidate)
    void candidate.dispose().catch(() => undefined)
  }
  const disposePending = (candidate: AgentHandle): void => {
    if (!pending.delete(candidate)) return
    dispose(candidate)
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
  const assertPrepared = (candidate: AgentHandle, capture: BindingCapture): void => {
    if (pending.get(candidate) !== capture || !isCaptureCurrent(capture)) {
      disposePending(candidate)
      throw new Error('dsh-tui: Channel binding changed before adoption')
    }
  }
  const settlePrevious = (previous: BindingCommit, disposition: PreviousDisposition): void => {
    // Parking deliberately transfers ownership to the caller's background
    // ledger. Disposal is centralised here so no adoption tail can double-call
    // an old handle while its transaction is being revoked.
    if (disposition === 'dispose' && previous.handle !== undefined && previous.handle !== currentHandle) {
      dispose(previous.handle)
    }
  }

  owner.own(clearSubscriptions)
  owner.own(() => { for (const candidate of [...pending.keys()]) disposePending(candidate) })

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
      dispose(candidate)
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

    /** Create a candidate without giving it authority over the live binding. */
    async prepare(capture: BindingCapture, create: () => Promise<AgentHandle>): Promise<AgentHandle> {
      owner.assertActive()
      if (!isCaptureCurrent(capture)) throw new Error('dsh-tui: Channel binding changed before preparation')
      const candidate = await create()
      if (!isCaptureCurrent(capture)) {
        dispose(candidate)
        throw new Error('dsh-tui: Channel binding changed during preparation')
      }
      pending.set(candidate, capture)
      // Owner disposal may synchronously occur through embedding hooks while
      // ownership is registered; verify the pending entry itself as well.
      if (!isCaptureCurrent(capture) || pending.get(candidate) !== capture) {
        disposePending(candidate)
        throw new Error('dsh-tui: Channel binding changed during preparation')
      }
      return candidate
    },

    /** Dispose an uncommitted candidate exactly once. Live handles are inert. */
    async abandon(candidate: AgentHandle): Promise<void> { disposePending(candidate) },

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
