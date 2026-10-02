import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentSession } from '../../agent/session.js'
import type { ChannelOwner } from './owner.js'

export interface BindingCapture {
  readonly session: AgentSession
  /** DSH convenience: the captured session's agent; undefined off DSH. */
  readonly agent: Agent | undefined
  readonly generation: number
}

export interface BindingCommit {
  readonly session: AgentSession
  readonly agent: Agent | undefined
  readonly handle: AgentHandle | undefined
  readonly generation: number
}

/** The DSH agent a session drives, if it is a DSH session (convenience view). */
const agentOf = (session: AgentSession): Agent | undefined => session.capabilities.native.dsh?.agent
/** The DSH lifetime handle a session owns, if any (DSH convenience view). */
const handleOf = (session: AgentSession): AgentHandle | undefined => session.capabilities.native.dsh?.handle

type PreviousDisposition = 'dispose' | 'park'

/**
 * Sole writer of the attached session identity and binding generation.
 *
 * The cell holds an `AgentSession` of any backend and every identity rule
 * below is decided on that session object (plus the generation, which every
 * adoption advances). `agent`/`handle` are DSH convenience views of
 * `capabilities.native.dsh` for the DSH specialists — `undefined` on a
 * non-DSH session; a DSH session's lifetime is still keyed by its handle, so
 * two wrappers of one owned agent close it once. A prepared session remains
 * owned by this cell until its synchronous adoption tail returns. The tail
 * is deliberately callback-shaped: it cannot leave a committed identity
 * waiting for a microtask watchdog to infer whether setup completed, and a
 * throw always revokes the transaction immediately.
 */
export function createChannelBinding(initial: AgentSession, owner: ChannelOwner) {
  let currentSession = initial
  let currentHandle = handleOf(initial)
  let generation = 0
  let started = false
  let subscriptions: (() => void)[] = []
  let handoff: symbol | undefined
  const pending = new Map<AgentSession, BindingCapture>()
  /**
   * The in-flight (or finished) close of a session this cell owns, keyed by
   * its lifetime (the DSH handle; the session itself for a handle-less one). A
   * Promise rather than a "has it started" flag, because the callers that
   * matter need to know when the handle has actually STOPPED writing: a ledger
   * reservation is only safe to give back after that, and a second `dispose()`
   * must not start a parallel close.
   */
  const closing = new WeakMap<object, Promise<void>>()
  const closingSessions = new Map<string, Promise<void>>()

  /** Close `candidate` exactly once; the result resolves however it ends. */
  const dispose = (candidate: AgentSession): Promise<void> => {
    const lifetime: object = handleOf(candidate) ?? candidate
    const started = closing.get(lifetime)
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
    closing.set(lifetime, close)
    const id = candidate.ref.sessionId
    closingSessions.set(id, close)
    void close.then(() => {
      if (closingSessions.get(id) === close) closingSessions.delete(id)
    })
    return close
  }
  const disposePending = (candidate: AgentSession): Promise<void> | undefined => {
    if (pending.delete(candidate)) return dispose(candidate)
    // Already un-pended (a revocation path took it out from under the caller):
    // hand back the close that is already running, so a caller that HAS to
    // wait — one about to give a ledger reservation back — still can.
    return closing.get(handleOf(candidate) ?? candidate)
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
    owner.current() && capture.session === currentSession && capture.generation === generation
  /**
   * Start a close without waiting for it. The callers below are synchronous
   * transaction boundaries — they must not turn into awaits — but the close
   * itself stays observable through {@link dispose}, so a caller that DOES have
   * to wait (an `abandon` handing a ledger reservation back) still can.
   */
  const startClose = (close: Promise<void> | undefined): void => {
    void close
  }
  const assertPrepared = (candidate: AgentSession, capture: BindingCapture): void => {
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
    // A DSH session's lifetime is its handle (a borrowed registry agent has
    // none and is never closed here); a non-DSH session owns its own
    // lifetime, so the cell closes the session object it replaced.
    const owned = previous.handle !== undefined
      ? previous.handle !== currentHandle
      : previous.agent === undefined && previous.session !== currentSession
    if (disposition === 'dispose' && owned) {
      startClose(dispose(previous.session))
    }
  }

  owner.own(clearSubscriptions)
  owner.own(() => { for (const candidate of [...pending.keys()]) startClose(disposePending(candidate)) })

  const adopt = <T>(
    candidate: AgentSession,
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
    const previous: BindingCommit = { session: currentSession, agent: agentOf(currentSession), handle: currentHandle, generation }
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
      currentSession = candidate
      currentHandle = handleOf(candidate)
      generation += 1
      const result = tail(previous, decidePrevious)
      // Tail callbacks include notifier/listener code and therefore remain a
      // synchronous reentrancy boundary even though they contain no await.
      if (handoff !== token || !owner.current() || currentSession !== candidate) {
        throw new Error('dsh-tui: Channel binding changed during adoption')
      }
      succeeded = true
      return result
    } catch (error) {
      // This candidate is transaction-owned, unlike the baseline live handle
      // which ordinary UI owner teardown only unsubscribes from.
      if (currentSession === candidate) {
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
    next: AgentSession,
    tail: (previous: BindingCommit, disposition: (next: PreviousDisposition) => void) => T,
  ): T => {
    owner.assertActive()
    if (handoff !== undefined) {
      handoff = undefined
      throw new Error('dsh-tui: Channel binding handoff is already in progress')
    }
    const nextHandle = handleOf(next)
    const token = Symbol('channel-binding-handoff')
    handoff = token
    const previous: BindingCommit = { session: currentSession, agent: agentOf(currentSession), handle: currentHandle, generation }
    let disposition: PreviousDisposition | undefined
    const decidePrevious = (nextDisposition: PreviousDisposition): void => {
      if (disposition === undefined || disposition === nextDisposition) { disposition = nextDisposition; return }
      throw new Error('dsh-tui: Channel binding previous disposition changed')
    }
    let succeeded = false
    try {
      const cleanupFailure = clearSubscriptions(() => {
        if (handoff !== token || !owner.current()) throw new Error('dsh-tui: Channel binding changed during adoption')
      })
      if (cleanupFailure !== undefined) throw cleanupFailure
      if (handoff !== token || !owner.current()) throw new Error('dsh-tui: Channel binding changed during adoption')
      currentSession = next
      currentHandle = nextHandle
      generation += 1
      const result = tail(previous, decidePrevious)
      if (handoff !== token || !owner.current() || currentSession !== next || currentHandle !== nextHandle) {
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
    get session() { return currentSession },
    /** DSH convenience: `capabilities.native.dsh.agent` of the bound session;
     *  undefined when the bound session is not a DSH session. */
    get agent(): Agent | undefined { return agentOf(currentSession) },
    /** DSH convenience: the bound session's lifetime handle, if it owns one. */
    get handle() { return currentHandle },
    get generation() { return generation },
    capture(): BindingCapture { return { session: currentSession, agent: agentOf(currentSession), generation } },
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
    async prepare(capture: BindingCapture, create: () => Promise<AgentSession>): Promise<AgentSession> {
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
    async abandon(candidate: AgentSession): Promise<void> {
      await disposePending(candidate)
    },

    /** A registry may retain an agent while its async handle close drains. */
    async waitForDisposal(sessionId: string): Promise<void> {
      await closingSessions.get(sessionId)
    },

    /** Perform one explicit synchronous prepared-handle adoption transaction. */
    adopt,
    /** Perform one explicit synchronous already-live-session adoption transaction. */
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

/** A capture taken through the DSH view: its agent is always present. */
export interface DshBindingCapture extends BindingCapture {
  readonly agent: Agent
}

/**
 * The binding as the DSH specialists see it: `agent` (and every capture's
 * agent) is the bound DSH agent. The specialists attach only when the bound
 * session is a DSH session (design §3.5), so reading `agent` through this
 * view on a non-DSH binding is a wiring bug and throws loudly instead of
 * handing a specialist `undefined`.
 */
/** A commit seen through the DSH view: the replaced session's agent. */
export interface DshBindingCommit extends BindingCommit {
  readonly agent: Agent
}

type Disposition = (next: PreviousDisposition) => void

export type DshChannelBinding = Omit<ChannelBinding, 'agent' | 'capture' | 'adopt' | 'switchTo'> & {
  readonly agent: Agent
  capture(): DshBindingCapture
  adopt<T>(candidate: AgentSession, capture: BindingCapture, tail: (previous: DshBindingCommit, disposition: Disposition) => T): T
  switchTo<T>(next: AgentSession, tail: (previous: DshBindingCommit, disposition: Disposition) => T): T
}

/** Wrap a binding for the DSH specialists (a live view, not a snapshot). */
export function dshChannelBinding(binding: ChannelBinding): DshChannelBinding {
  const require = (agent: Agent | undefined): Agent => {
    if (agent === undefined) {
      const ref = binding.session.ref
      throw new Error(`dsh-tui: session ${ref.backendId}:${ref.sessionId} is not a DSH session`)
    }
    return agent
  }
  return {
    get session() { return binding.session },
    get agent() { return require(binding.agent) },
    get handle() { return binding.handle },
    get generation() { return binding.generation },
    capture(): DshBindingCapture {
      const capture = binding.capture()
      return { ...capture, agent: require(capture.agent) }
    },
    isCurrent: capture => binding.isCurrent(capture),
    prepare: (capture, create) => binding.prepare(capture, create),
    abandon: candidate => binding.abandon(candidate),
    waitForDisposal: sessionId => binding.waitForDisposal(sessionId),
    adopt: (candidate, capture, tail) => binding.adopt(candidate, capture, (previous, disposition) =>
      tail({ ...previous, agent: require(previous.agent) }, disposition)),
    switchTo: (next, tail) => binding.switchTo(next, (previous, disposition) =>
      tail({ ...previous, agent: require(previous.agent) }, disposition)),
    bind: () => binding.bind(),
    subscribe: dispose => binding.subscribe(dispose),
    clearSubscriptions: afterEach => binding.clearSubscriptions(afterEach),
  }
}
