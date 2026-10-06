/**
 * `CodexHub`: one `codex app-server` child and one JSON-RPC connection shared
 * by every Codex thread of this TUI process (docs/codex-backend-design.md
 * D2, §5.3).
 *
 * - Handshake: `initialize` (client info, experimental API, the high-rate
 *   notifications this backend never reads opted out) then `initialized`.
 *   `ready` settles with the server's answer.
 * - Routing: a notification or server request carrying a thread id goes to
 *   the sink attached for that thread (or for the thread it was routed to,
 *   a subagent's parent); one without a thread id goes to the global
 *   listeners. Nothing unrouted is answered on a session's behalf except
 *   with an error, so the server never waits forever.
 * - Server requests are identified per connection generation: their ids
 *   restart with every child (`codex:<generation>:<id>`). A request whose
 *   id is still pending arrives again when a running thread is rejoined
 *   (C0 V5); it is routed once more flagged `redelivered`.
 * - Lifetime: `retain()` counts users; the last release starts a 30 s idle
 *   timer that closes the child (a new retain cancels it). An unexpected
 *   exit rejects every pending request, tells every sink, and restarts with
 *   backoff (0.5 s, 2 s, 5 s); the sinks hear `connectionRestored` after the
 *   new handshake and resubscribe themselves. Three failed restarts are
 *   permanent.
 * - Instances: settings (executable, arguments, the Codex-relevant
 *   environment) form a fingerprint; equal fingerprints share a hub.
 */
import { createHash } from 'node:crypto'
import { CLIENT, NOTIFY, OPT_OUT_NOTIFICATIONS, SERVER_REQUEST } from '../protocol/index.js'
import type { InitializeParams } from '../protocol/index.js'
import { errorText, rec, str, type Rec } from '../narrow.js'
import { createRpcClient, CodexRpcError, REAL_CLOCK, RPC_ERROR, type CallOptions, type RequestId, type RpcClient, type RpcClock } from './client.js'
import { spawnTransport, type Transport, type TransportExit, type TransportFactory } from './transport.js'

/** The server's handshake answer. */
export interface InitializeInfo {
  readonly userAgent: string
  readonly codexHome: string
  readonly platformFamily: string
  readonly platformOs: string
  /** Which connection generation answered (1 = the first child). */
  readonly generation: number
}

/** One server request as a session sees it. */
export interface HubServerRequest {
  /** `codex:<generation>:<id>`: unique across restarts. */
  readonly key: string
  readonly id: RequestId
  readonly generation: number
  readonly method: string
  readonly params: Rec
  /** The same request arrived again (a rejoin redelivered it). */
  readonly redelivered: boolean
  respond(result: unknown): void
  respondError(code: number, message: string): void
  /** Whether the connection it came on is still the live one. */
  live(): boolean
}

/** What a session attaches for its thread. */
export interface ThreadSink {
  notification(method: string, params: Rec): void
  serverRequest(request: HubServerRequest): void
  /** The child went away; `permanent` = no restart will follow. */
  connectionLost(error: Error, permanent: boolean): void
  /** A restarted child finished its handshake: resubscribe. */
  connectionRestored(): void
}

export interface HubSettings {
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

export interface CodexHubDeps {
  readonly transportFactory?: TransportFactory
  readonly clock?: RpcClock
  readonly debug?: (message: string) => void
  /** One child stderr line (never the terminal). */
  readonly stderr?: (line: string) => void
  /** Idle time before an unused hub closes (default 30 s). */
  readonly idleMs?: number
  /** Restart backoff; its length is the attempt budget. */
  readonly restartDelaysMs?: readonly number[]
  /** `clientInfo.version` (the dsh-tui version). */
  readonly clientVersion?: string
  /** Bound on the `initialize` answer. */
  readonly handshakeTimeoutMs?: number
}

export type HubState = 'starting' | 'ready' | 'restarting' | 'failed' | 'closed'

export interface CodexHub {
  /** The current connection's handshake. */
  readonly ready: Promise<InitializeInfo>
  readonly info: InitializeInfo | undefined
  readonly generation: number
  readonly state: HubState
  readonly fingerprint: string
  /** A request on the live connection (waits for its handshake). */
  call<R = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<R>
  attach(threadId: string, sink: ThreadSink): () => void
  /** Deliver another thread's traffic to the sink of `toThreadId` (a
   *  subagent's thread to its parent session). */
  route(threadId: string, toThreadId: string): () => void
  onGlobal(listener: (method: string, params: Rec) => void): () => void
  /** A handler for thread-less server requests (`account/…`). */
  onGlobalRequest(method: string, handler: (request: HubServerRequest) => void): () => void
  retain(): () => void
  close(): Promise<void>
}

const DEFAULT_IDLE_MS = 30_000
const DEFAULT_RESTART_DELAYS_MS: readonly number[] = [500, 2000, 5000]
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000

/** Environment keys that change what a child does (the fingerprint input). */
const RELEVANT_ENV = /^(?:CODEX_|OPENAI_|DSH_TUI_CODEX_)/u

/** A stable digest of what makes two hubs interchangeable (values hashed,
 *  never kept). */
export function hubFingerprint(settings: HubSettings): string {
  const env = Object.entries(settings.env).filter(([key]) => RELEVANT_ENV.test(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify({ executable: settings.executable, args: settings.args, env })).digest('hex').slice(0, 16)
}

/** The thread a message concerns, when it names one. */
export function threadOf(params: Rec): string | undefined {
  return str(params.threadId) ?? str(rec(params.thread)?.id) ?? str(params.conversationId)
}

/** Create a hub (no registry: tests and the registry below). */
export function createCodexHub(settings: HubSettings, deps: CodexHubDeps = {}): CodexHub {
  const debug = deps.debug ?? (() => undefined)
  const clock = deps.clock ?? REAL_CLOCK
  const factory = deps.transportFactory ?? spawnTransport
  const delays = deps.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
  const fingerprint = hubFingerprint(settings)
  const sinks = new Map<string, ThreadSink>()
  const routes = new Map<string, string>()
  const globals = new Set<(method: string, params: Rec) => void>()
  const globalRequests = new Map<string, (request: HubServerRequest) => void>()
  let state: HubState = 'starting'
  let generation = 0
  let info: InitializeInfo | undefined
  let client: RpcClient | undefined
  let transport: Transport | undefined
  let ready!: Promise<InitializeInfo>
  let retainers = 0
  let idleTimer: unknown
  let restartAttempt = 0
  let restartTimer: unknown
  let closing: Promise<void> | undefined
  /** Server requests of the live generation not answered yet. */
  const pendingServer = new Map<RequestId, HubServerRequest>()

  const sinkOf = (threadId: string | undefined): ThreadSink | undefined => {
    if (threadId === undefined) return undefined
    return sinks.get(threadId) ?? (routes.has(threadId) ? sinks.get(routes.get(threadId)!) : undefined)
  }
  const eachSink = (visit: (sink: ThreadSink) => void): void => {
    for (const sink of [...new Set(sinks.values())]) {
      try {
        visit(sink)
      } catch (error) {
        debug(`codex hub: sink callback threw (${errorText(error)})`)
      }
    }
  }

  const handleRequest = (connection: RpcClient, gen: number, id: RequestId, method: string, params: Rec): undefined => {
    const redelivered = pendingServer.has(id)
    let answered = false
    const live = (): boolean => client === connection && generation === gen && state !== 'closed'
    const request: HubServerRequest = {
      key: `codex:${gen}:${String(id)}`,
      id,
      generation: gen,
      method,
      params,
      redelivered,
      respond(result: unknown): void {
        if (answered || !live()) return
        answered = true
        pendingServer.delete(id)
        connection.respond(id, result)
      },
      respondError(code: number, message: string): void {
        if (answered || !live()) return
        answered = true
        pendingServer.delete(id)
        connection.respondError(id, code, message)
      },
      live,
    }
    if (!redelivered) pendingServer.set(id, request)
    const threadId = threadOf(params)
    const sink = sinkOf(threadId)
    if (sink !== undefined) {
      try {
        sink.serverRequest(request)
      } catch (error) {
        debug(`codex hub: ${method} sink threw (${errorText(error)})`)
        request.respondError(RPC_ERROR.internal, 'dsh-tui failed to handle the request')
      }
      return undefined
    }
    const global = globalRequests.get(method)
    if (global !== undefined) {
      global(request)
      return undefined
    }
    if (method === SERVER_REQUEST.currentTime) {
      request.respond({ currentTimeAt: Math.floor(Date.now() / 1000) })
      return undefined
    }
    debug(`codex hub: no handler for server request ${method}${threadId === undefined ? '' : ` (thread ${threadId})`}`)
    request.respondError(threadId === undefined ? RPC_ERROR.methodNotFound : RPC_ERROR.internal, `dsh-tui does not handle ${method}`)
    return undefined
  }

  const handleNotification = (method: string, params: Rec): void => {
    if (method === NOTIFY.serverRequestResolved) {
      const resolved = params.requestId
      if (typeof resolved === 'number' || typeof resolved === 'string') pendingServer.delete(resolved)
    }
    const threadId = threadOf(params)
    if (threadId !== undefined) {
      const sink = sinkOf(threadId)
      if (sink === undefined) {
        debug(`codex hub: dropped ${method} for unattached thread ${threadId}`)
        return
      }
      try {
        sink.notification(method, params)
      } catch (error) {
        debug(`codex hub: ${method} sink threw (${errorText(error)})`)
      }
      return
    }
    for (const listener of [...globals]) {
      try {
        listener(method, params)
      } catch (error) {
        debug(`codex hub: global ${method} listener threw (${errorText(error)})`)
      }
    }
  }

  /** Start one child and its handshake. */
  const connect = (): Promise<InitializeInfo> => {
    const gen = ++generation
    pendingServer.clear()
    let connection!: RpcClient
    const child = factory({
      executable: settings.executable,
      args: settings.args,
      env: settings.env,
      cwd: settings.cwd,
      onLine: line => { if (client === connection) connection.receive(line) },
      onStderr: line => {
        debug(`[codex-stderr] ${line}`)
        deps.stderr?.(line)
      },
      onExit: exit => onExit(connection, exit),
    })
    connection = createRpcClient({ write: line => child.write(line), debug, clock })
    client = connection
    transport = child
    connection.onNotification(handleNotification)
    connection.onServerRequest((id, method, params) => handleRequest(connection, gen, id, method, params))
    const params: InitializeParams = {
      clientInfo: { name: 'dsh-tui', title: 'dsh-TUI', version: deps.clientVersion ?? 'dev' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [...OPT_OUT_NOTIFICATIONS] },
    }
    return connection.call<unknown>(CLIENT.initialize, params, { timeoutMs: deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS }).then(answer => {
      const result = rec(answer) ?? {}
      connection.notify(CLIENT.initialized)
      const next: InitializeInfo = {
        userAgent: str(result.userAgent) ?? '',
        codexHome: str(result.codexHome) ?? '',
        platformFamily: str(result.platformFamily) ?? '',
        platformOs: str(result.platformOs) ?? '',
        generation: gen,
      }
      if (client === connection && state !== 'closed') {
        info = next
        state = 'ready'
      }
      return next
    })
  }

  const fail = (error: Error): void => {
    state = 'failed'
    eachSink(sink => sink.connectionLost(error, true))
  }

  const restart = (lastError: Error): void => {
    if (state === 'closed') return
    if (restartAttempt >= delays.length) {
      fail(lastError)
      return
    }
    const delay = delays[restartAttempt]!
    restartAttempt += 1
    state = 'restarting'
    debug(`codex hub: restarting the app-server in ${delay} ms (attempt ${restartAttempt}/${delays.length})`)
    restartTimer = clock.setTimeout(() => {
      restartTimer = undefined
      if (state === 'closed') return
      const attempt = connect()
      ready = attempt
      attempt.then(() => {
        if (state === 'closed') return
        restartAttempt = 0
        eachSink(sink => sink.connectionRestored())
      }, (error: unknown) => {
        debug(`codex hub: restart handshake failed (${errorText(error)})`)
        // The child may still be up but useless: stop it, then retry.
        void transport?.close()
      })
      // A restart that never settles must not leave callers waiting forever.
      attempt.catch(() => undefined)
    }, delay)
  }

  const onExit = (connection: RpcClient, exit: TransportExit): void => {
    if (client !== connection) return
    const reason = exit.error !== undefined
      ? new CodexRpcError(`codex app-server could not start: ${exit.error.message}`, RPC_ERROR.internal)
      : new CodexRpcError(`codex app-server exited (${exit.signal ?? `code ${String(exit.code)}`})`, RPC_ERROR.internal)
    connection.close(reason)
    pendingServer.clear()
    if (state === 'closed') return
    debug(`codex hub: ${reason.message}`)
    const wasReady = state === 'ready'
    // A child that never finished its first handshake does not restart:
    // the open that waits on `ready` reports the failure.
    if (generation === 1 && !wasReady && info === undefined) {
      state = 'failed'
      return
    }
    if (wasReady) eachSink(sink => sink.connectionLost(reason, false))
    restart(reason)
  }

  const scheduleIdle = (): void => {
    if (idleTimer !== undefined) clock.clearTimeout(idleTimer)
    idleTimer = clock.setTimeout(() => {
      idleTimer = undefined
      if (retainers === 0) void hub.close()
    }, deps.idleMs ?? DEFAULT_IDLE_MS)
  }

  ready = connect()
  ready.catch((error: unknown) => {
    debug(`codex hub: handshake failed (${errorText(error)})`)
    if (state === 'starting') state = 'failed'
  })

  const hub: CodexHub = {
    get ready() { return ready },
    get info() { return info },
    get generation() { return generation },
    get state() { return state },
    fingerprint,

    async call<R = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<R> {
      if (state === 'closed') throw new CodexRpcError('the Codex connection is closed', RPC_ERROR.internal)
      await ready
      const connection = client
      if (connection === undefined) throw new CodexRpcError('the Codex connection is not up', RPC_ERROR.internal)
      return connection.call<R>(method, params, options)
    },

    attach(threadId, sink) {
      sinks.set(threadId, sink)
      return () => {
        if (sinks.get(threadId) === sink) sinks.delete(threadId)
        for (const [from, to] of [...routes]) if (to === threadId) routes.delete(from)
      }
    },

    route(threadId, toThreadId) {
      routes.set(threadId, toThreadId)
      return () => { if (routes.get(threadId) === toThreadId) routes.delete(threadId) }
    },

    onGlobal(listener) {
      globals.add(listener)
      return () => { globals.delete(listener) }
    },

    onGlobalRequest(method, handler) {
      globalRequests.set(method, handler)
      return () => { if (globalRequests.get(method) === handler) globalRequests.delete(method) }
    },

    retain() {
      retainers += 1
      if (idleTimer !== undefined) {
        clock.clearTimeout(idleTimer)
        idleTimer = undefined
      }
      let released = false
      return () => {
        if (released) return
        released = true
        retainers -= 1
        if (retainers === 0 && state !== 'closed') scheduleIdle()
      }
    },

    close(): Promise<void> {
      if (closing !== undefined) return closing
      state = 'closed'
      if (idleTimer !== undefined) clock.clearTimeout(idleTimer)
      if (restartTimer !== undefined) clock.clearTimeout(restartTimer)
      const connection = client
      const child = transport
      closing = (async () => {
        connection?.close(new CodexRpcError('the Codex connection is closed', RPC_ERROR.internal))
        pendingServer.clear()
        await child?.close()
      })()
      registry.delete(fingerprint)
      return closing
    },
  }
  return hub
}

/** Live hubs by fingerprint (one per distinct child configuration). */
const registry = new Map<string, CodexHub>()

/** The process-wide hub for these settings (created on first use). */
export function acquireCodexHub(settings: HubSettings, deps: CodexHubDeps = {}): CodexHub {
  const fingerprint = hubFingerprint(settings)
  const existing = registry.get(fingerprint)
  if (existing !== undefined && existing.state !== 'closed' && existing.state !== 'failed') return existing
  if (existing !== undefined) void existing.close()
  const hub = createCodexHub(settings, deps)
  registry.set(fingerprint, hub)
  return hub
}

/** Close every hub (the process exit path; tests). */
export async function closeAllCodexHubs(): Promise<void> {
  await Promise.all([...registry.values()].map(hub => hub.close()))
  registry.clear()
}

/** Parse a JSON-RPC answer's error message for a user (no params). */
export const rpcErrorText = (error: unknown): string => error instanceof CodexRpcError ? error.message : errorText(error)
