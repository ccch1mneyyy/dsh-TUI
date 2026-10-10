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

/**
 * The session-policy vocabulary the deferral holds back: the facts a fresh
 * session may already carry without being published. Exported as the ONE
 * definition of that set — the four seeded channel actions replay exactly
 * these into an unseeded child, and appending any other type would start the
 * deferral and publish the very shell the unseeded branch exists to avoid
 * (`latestPolicyFacts`, `unspoken-sessions.ts`).
 *
 * This set is the policy ATOMS only. The policy plane a switch leaves behind
 * is wider — see {@link isPolicyPlaneActivity}.
 */
export const INITIAL_POLICY_EVENTS: ReadonlySet<string> = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'plan/mode'])

/** The command envelope a session-policy switch runs through. */
const POLICY_ACTIVITY_EVENTS: ReadonlySet<string> = new Set(['command/run', 'command/done'])

/**
 * Whether a message's `source` marks it as typed by the person at the
 * keyboard — `digest.ts:66-70`, verbatim: plugin injections, instruction
 * snapshots, skill catalogues and sub-agent reports all arrive as user-role
 * messages too, and counting them would spare every shell there is.
 *
 * Defined HERE because the deferral needs it too and `unspoken-sessions.ts`
 * already imports this module (the reverse import would be a cycle); the cut
 * verdict and the exit sweep import it back, so "a person spoke here" keeps one
 * definition across the deferral, the verdict and the sweep.
 */
export function isHumanSource(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as Record<string, unknown>)['kind'] === 'user'
}

/**
 * Whether one event is policy-plane bookkeeping the deferral holds back rather
 * than something a person can see: the initialization atoms, the command
 * ENVELOPE a policy switch runs through, and the inbox splice that carries only
 * its notice.
 *
 * Why the envelope counts: switching the permission preset (Shift+Tab,
 * `/permission`, or the official switch the TUI drives) executes the registry
 * command the host exposes for it (`mode-permission.ts`'s
 * `executeRegistryCommand('permission', …)`), and the command service logs
 * `command/run` + `command/done` around it. Those types are outside
 * {@link INITIAL_POLICY_EVENTS}, so the deferral used to start on the first of
 * them and publish a permission-only shell — measured on a real tree
 * (2026-10-10): an idle fresh session that only switched preset stored an
 * 11-event log, which is the 「未命名」 row this change exists to remove.
 *
 * Both safe directions are kept: a splice that carries a HUMAN message is
 * conversation and publishes (the live prompt delivers the typed message
 * through exactly that event), and an unreadable splice payload publishes too —
 * "the log does not say" must never become "the log says no" (the same widening
 * `conversationEvidence` applies on the sweep side).
 *
 * @param event - One session event, in arrival order.
 * @returns True when the deferral must keep waiting for conversation.
 */
export function isPolicyPlaneActivity(event: SessionEvent): boolean {
  if (INITIAL_POLICY_EVENTS.has(event.type) || POLICY_ACTIVITY_EVENTS.has(event.type)) return true
  if (event.type !== 'agent/inbox/spliced') return false
  const inserted = (event.data as { readonly inserted?: unknown } | undefined)?.inserted
  if (!Array.isArray(inserted)) return false
  for (const message of inserted) {
    if (message === null || typeof message !== 'object') continue
    const entry = message as Record<string, unknown>
    if (entry['role'] === 'user' && isHumanSource(entry['source'])) return false
  }
  return true
}

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
    // Counterpart of guardedClose: a flush does not publish a session either
    // while it only holds initialization. Host consumers checkpoint a session
    // without any real work — the projection cache flushes from its
    // `session/created` hook and from its own event throttle — and an
    // unconditional drain here re-materialized exactly the permission-only
    // shell the deferral exists to keep out of JSONL. The listener still
    // participates, so `ctx.sessions.flush()` keeps reporting a durability
    // listener; it just has nothing to record before the first real event.
    if (!started) return
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
    if (subject !== session || (!started && isPolicyPlaneActivity(event))) return
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
