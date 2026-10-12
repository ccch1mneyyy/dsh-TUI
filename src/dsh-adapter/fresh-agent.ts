import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentSetup, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { snapshotLiveSessionEvents } from './compat/liveSession.js'
import { concreteService } from './host-access.js'

interface SessionWriter {
  readonly id: string
  append(events: readonly SessionEvent[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface JsonlPersistence {
  readonly name: string
  readonly ctx: Context
  create(header: SessionHeader, options?: unknown): Promise<SessionWriter>
  readonly open: unknown
}

type AgentCreator = { create(options: CreateAgentOptions): Promise<AgentHandle> }
type FilteredSession = Session & { [Context.filter]?: (ctx: Context) => boolean }

const captures = new WeakMap<JsonlPersistence, {
  receivers: Map<string, (writer: SessionWriter) => void>
  restore(): void
}>()

/** Capture only this factory's public write handle; concurrent creates share one tap. */
function captureWriter(source: JsonlPersistence, id: string, receive: (writer: SessionWriter) => void): () => void {
  let capture = captures.get(source)
  if (capture === undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(source, 'create')
    const create = source.create
    const receivers = new Map<string, (writer: SessionWriter) => void>()
    const tapped: JsonlPersistence['create'] = async function (this: JsonlPersistence, header, options) {
      const writer = await create.call(this, header, options)
      receivers.get(writer.id)?.(writer)
      return writer
    }
    source.create = tapped
    capture = {
      receivers,
      restore() {
        if (source.create === tapped) {
          if (descriptor === undefined) delete (source as Partial<JsonlPersistence>).create
          else Object.defineProperty(source, 'create', descriptor)
        }
        captures.delete(source)
      },
    }
    captures.set(source, capture)
  }
  if (capture.receivers.has(id)) throw new Error(`dsh-tui: fresh session "${id}" is already being created`)
  capture.receivers.set(id, receive)
  return () => {
    capture.receivers.delete(id)
    if (capture.receivers.size === 0) capture.restore()
  }
}

const INITIAL_POLICY_EVENTS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'plan/mode'])
const unstoredSessions = new WeakSet<Session>()

/** Initialization-only fresh session with no persistence requested yet. */
export function isUnstoredFreshSession(session: Session | undefined): boolean {
  return session !== undefined && unstoredSessions.has(session)
}

/** Keep initial policy facts live, but route them to JSONL only with subsequent work. */
function deferInitialPolicy(ctx: Context, session: FilteredSession, writer: SessionWriter, source: JsonlPersistence): void {
  if (session.seq !== 0) return
  const providerFiber = concreteService(source.ctx.fiber)
  const descriptor = Object.getOwnPropertyDescriptor(session, Context.filter)
  const originalFilter = session[Context.filter]
  const flush = writer.flush
  const close = writer.close
  let deferred = true
  let started = false
  let failed = false
  let storedCount = 0
  let draining: Promise<void> | undefined
  const start = (): void => {
    started = true
    unstoredSessions.delete(session)
  }
  const filter = (listener: Context): boolean =>
    (originalFilter?.call(session, listener) ?? true) &&
    (!deferred || concreteService(listener.fiber) !== providerFiber)
  let stopEvents: (() => void) | undefined
  let stopFlush: (() => void) | undefined
  const release = (): void => {
    deferred = false
    stopEvents?.()
    stopFlush?.()
    if (session[Context.filter] === filter) {
      if (descriptor === undefined) delete session[Context.filter]
      else Object.defineProperty(session, Context.filter, descriptor)
    }
    if (writer.flush === guardedFlush) writer.flush = flush
    if (writer.close === guardedClose) writer.close = close
  }
  // Live routing stays paused throughout the asynchronous handoff. Any events
  // arriving during append are part of the next suffix, never duplicated by
  // the backend's own router. A failed suffix remains available for a flush retry.
  const drain = (): Promise<void> => draining ??= (async () => {
    while (deferred) {
      const events = snapshotLiveSessionEvents(session)
      const suffix = events.slice(storedCount)
      if (suffix.length === 0) { release(); break }
      await writer.append(suffix)
      storedCount = events.length
    }
  })().finally(() => { draining = undefined })

  const guardedFlush = async (): Promise<void> => {
    start()
    await drain()
    await flush.call(writer)
  }
  const guardedClose = async (): Promise<void> => {
    // The provider can unload before the Agent scope. Its handle close must
    // wait for the suffix still being handed off, while idle policy is discarded.
    const failures: unknown[] = []
    try { if (started) await drain() } catch (error) { failures.push(error) }
    try { await close.call(writer) } catch (error) { failures.push(error) }
    finally { release() }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `dsh-tui: fresh session "${session.id}" close failed`)
  }

  ctx.effect(() => {
    unstoredSessions.add(session)
    session[Context.filter] = filter
    writer.flush = guardedFlush
    writer.close = guardedClose
    return async () => {
      try { if (started) await drain() }
      finally { release() }
    }
  }, 'dsh-tui fresh session policy')
  stopEvents = ctx.on('session/event', (subject, event) => {
    if (subject !== session || (!started && INITIAL_POLICY_EVENTS.has(event.type))) return
    start()
    if (failed || draining !== undefined) return
    void drain().catch((error: unknown) => {
      failed = true
      ctx.logger.warn(`dsh-tui: fresh session "${session.id}" write failed (events retained for flush): ${String(error)}`)
    })
  }, { prepend: true })
  stopFlush = ctx.on('session/flush', subject => subject === session ? writer.flush() : undefined)
}

/**
 * Startup and `/new` use an unseeded DSH session. Permission initialization
 * alone must not publish a stored conversation; all facts still belong to
 * the real Session, and the official JSONL writer owns their eventual storage.
 */
export async function createFreshAgent(ctx: Context, agents: AgentCreator, options: CreateAgentOptions): Promise<AgentHandle> {
  const service = ctx.get('sessionPersistence') as JsonlPersistence | undefined
  // Legacy id-addressed stores and custom providers retain their own routing.
  if (service?.name !== 'session-persistence-jsonl' || typeof service.open !== 'function') return agents.create(options)
  const source = concreteService(service)
  let writer: SessionWriter | undefined
  const stopCapture = captureWriter(source, String(options.sessionId), value => { writer = value })
  const setup: AgentSetup = async (agentCtx, agent) => {
    const commit = await options.setup?.(agentCtx, agent)
    const defer = (): void => {
      if (writer !== undefined) deferInitialPolicy(agentCtx, agent.session, writer, source)
    }
    if (commit === undefined) { defer(); return }
    // Setup history belongs to the factory's pre-publication append. Install
    // the gate only after the original commit has finished composing it.
    return { commit() { commit.commit(); defer() } }
  }
  try {
    return await agents.create({ ...options, setup })
  } finally {
    stopCapture()
  }
}
