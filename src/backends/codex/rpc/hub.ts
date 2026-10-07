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
 *   listeners. Unknown children wait, including approvals, while thread/read
 *   resolves their parent chain. True orphans receive an error.
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
import { t } from '../../../i18n.js'
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

/** A bounded hub diagnostic, broadcast and replayed to every attached sink. */
export interface HubDiagnostic {
  readonly kind: 'debug' | 'stderr'
  readonly message: string
}

/** What a session attaches for its thread. */
export interface ThreadSink {
  notification(method: string, params: Rec): void
  serverRequest(request: HubServerRequest): void
  /** The child went away; `permanent` = no restart will follow. */
  connectionLost(error: Error, permanent: boolean): void
  /** A restarted child finished its handshake: resubscribe. */
  connectionRestored(): void
  /** Startup diagnostics are replayed on attach; subsequent ones fan out. */
  diagnostic?(entry: HubDiagnostic): void
}

export interface HubSettings {
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** Credential mode and channel-private env participate in hub identity. */
  readonly credentialMode?: 'codex' | 'external' | 'channel' | 'native-fallback'
  readonly injectedEnvKeys?: readonly string[]
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
  /** Last 200 diagnostics, including stderr emitted before a session attached. */
  readonly diagnostics: readonly HubDiagnostic[]
  /** One-time startup finding survives diagnostic-history eviction. */
  readonly bubblewrapMissing: boolean
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
const ROUTE_BUFFER_LIMIT = 1000
const DIAGNOSTIC_LIMIT = 200

type BufferedMessage =
  | { readonly kind: 'notification'; readonly method: string; readonly params: Rec }
  | { readonly kind: 'request'; readonly request: HubServerRequest }

/** Environment keys that change what a child does (the fingerprint input). */
const RELEVANT_ENV = /^(?:CODEX_|OPENAI_|DSH_TUI_CODEX_)/u

/** A stable digest of what makes two hubs interchangeable (values hashed,
 *  never kept). */
export function hubFingerprint(settings: HubSettings): string {
  const injected = new Set(settings.injectedEnvKeys ?? [])
  const env = Object.entries(settings.env).filter(([key]) => RELEVANT_ENV.test(key) || injected.has(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify({ executable: settings.executable, args: settings.args, env, credentialMode: settings.credentialMode })).digest('hex').slice(0, 16)
}

/** The thread a message concerns, when it names one. */
export function threadOf(params: Rec): string | undefined {
  return str(params.threadId) ?? str(rec(params.thread)?.id) ?? str(params.conversationId)
}

/** Create a hub (no registry: tests and the registry below). */
export function createCodexHub(settings: HubSettings, deps: CodexHubDeps = {}): CodexHub {
  const logDebug = deps.debug ?? (() => undefined)
  const clock = deps.clock ?? REAL_CLOCK
  const factory = deps.transportFactory ?? spawnTransport
  const delays = deps.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
  const fingerprint = hubFingerprint(settings)
  const sinks = new Map<string, ThreadSink>()
  const routes = new Map<string, string>()
  const parents = new Map<string, string | undefined>()
  const parentReads = new Map<string, Promise<string | undefined>>()
  const buffered = new Map<string, { readonly generation: number; readonly messages: BufferedMessage[] }>()
  const diagnostics: HubDiagnostic[] = []
  let bubblewrapMissing = false
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

  const report = (entry: HubDiagnostic): void => {
    if (entry.kind === 'stderr' && /bubblewrap/iu.test(entry.message)) bubblewrapMissing = true
    diagnostics.push(entry)
    if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift()
    for (const sink of new Set(sinks.values())) {
      try { sink.diagnostic?.(entry) } catch { logDebug('codex hub: diagnostic callback threw') }
    }
  }
  const debug = (message: string): void => {
    logDebug(message)
    report({ kind: 'debug', message })
  }

  const sinkOf = (threadId: string | undefined): ThreadSink | undefined => {
    const seen = new Set<string>()
    while (threadId !== undefined && !seen.has(threadId)) {
      const sink = sinks.get(threadId)
      if (sink !== undefined) return sink
      seen.add(threadId)
      threadId = routes.get(threadId) ?? parents.get(threadId)
    }
    return undefined
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

  const deliver = (sink: ThreadSink, message: BufferedMessage): void => {
    try {
      if (message.kind === 'notification') sink.notification(message.method, message.params)
      else if (message.request.live()) sink.serverRequest(message.request)
    } catch (error) {
      debug(`codex hub: sink callback threw (${errorText(error)})`)
      if (message.kind === 'request') message.request.respondError(RPC_ERROR.internal, 'dsh-tui failed to handle the request')
    }
  }

  const flush = (threadId: string, sink: ThreadSink): void => {
    const queue = buffered.get(threadId)
    if (queue === undefined) return
    // Keep the queue registered during callbacks: reentrant arrivals append
    // after what was already waiting instead of overtaking it.
    while (queue.messages.length > 0) deliver(sink, queue.messages.shift()!)
    if (buffered.get(threadId) === queue) buffered.delete(threadId)
  }

  const flushKnownRoutes = (): void => {
    for (const threadId of buffered.keys()) {
      const sink = sinkOf(threadId)
      if (sink !== undefined) flush(threadId, sink)
    }
  }

  const readParent = (threadId: string, gen: number): Promise<string | undefined> => {
    const existing = parentReads.get(threadId)
    if (existing !== undefined) return existing
    const reading = ready.then(async () => {
      if (generation !== gen || state === 'closed') return undefined
      const answer = rec(await client?.call(CLIENT.threadRead, { threadId, includeTurns: false }, { timeoutMs: 5000 }))
      const parent = str(rec(answer?.thread)?.parentThreadId)
      if (generation === gen) parents.set(threadId, parent)
      return parent
    }).catch(() => {
      if (generation === gen && state !== 'closed') {
        parents.set(threadId, undefined)
        debug(`codex hub: could not read the parent of thread ${threadId}`)
      }
      return undefined
    })
    parentReads.set(threadId, reading)
    void reading.then(() => { if (parentReads.get(threadId) === reading) parentReads.delete(threadId) })
    return reading
  }

  const resolveSink = async (threadId: string, gen: number): Promise<ThreadSink | undefined> => {
    const seen = new Set<string>()
    let current: string | undefined = threadId
    while (current !== undefined && generation === gen && state !== 'closed') {
      const sink = sinkOf(current)
      if (sink !== undefined) return sink
      if (seen.has(current)) return undefined
      seen.add(current)
      current = routes.get(current) ?? (parents.has(current) ? parents.get(current) : await readParent(current, gen))
    }
    return undefined
  }

  const routeMessage = (threadId: string, message: BufferedMessage): void => {
    let queue = buffered.get(threadId)
    if (queue === undefined) {
      const sink = sinkOf(threadId)
      if (sink !== undefined) { deliver(sink, message); return }
      queue = { generation, messages: [] }
      buffered.set(threadId, queue)
      const waiting = queue
      void resolveSink(threadId, generation).then(sink => {
        if (buffered.get(threadId) !== waiting || waiting.generation !== generation || state === 'closed') return
        if (sink !== undefined) { flush(threadId, sink); return }
        buffered.delete(threadId)
        let warned = false
        for (const held of waiting.messages) {
          if (held.kind === 'notification') {
            debug(`codex hub: dropped ${held.method} for unattached thread ${threadId}`)
          } else if (held.request.live()) {
            held.request.respondError(RPC_ERROR.internal, 'dsh-tui could not route the subagent request')
            warned = true
          }
        }
        if (warned) handleNotification(NOTIFY.warning, { message: t('codex-orphan-request'), threadId: null })
      })
    }
    queue.messages.push(message)
    if (queue.messages.length > ROUTE_BUFFER_LIMIT) {
      // Approvals must survive the lookup. Only notifications may be shed;
      // an all-request queue remains until the bounded parent lookup ends.
      const oldest = queue.messages.findIndex(entry => entry.kind === 'notification')
      if (oldest !== -1) {
        queue.messages.splice(oldest, 1)
        debug(`codex hub: route buffer overflow for thread ${threadId}; dropped oldest notification`)
      }
    }
  }

  const handleRequest = (connection: RpcClient, gen: number, id: RequestId, method: string, params: Rec): undefined => {
    const redelivered = pendingServer.has(id)
    let answered = false
    const live = (): boolean => client === connection && generation === gen && state !== 'closed' && pendingServer.has(id)
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
    if (threadId !== undefined && method !== SERVER_REQUEST.currentTime) {
      routeMessage(threadId, { kind: 'request', request })
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
      routeMessage(threadId, { kind: 'notification', method, params })
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
    buffered.clear()
    parentReads.clear()
    let connection!: RpcClient
    const child = factory({
      executable: settings.executable,
      args: settings.args,
      env: settings.env,
      cwd: settings.cwd,
      onLine: line => { if (client === connection) connection.receive(line) },
      onStderr: line => {
        logDebug(`[codex-stderr] ${line}`)
        report({ kind: 'stderr', message: line })
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
    buffered.clear()
    parentReads.clear()
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
    get diagnostics() { return diagnostics.slice() },
    get bubblewrapMissing() { return bubblewrapMissing },

    async call<R = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<R> {
      if (state === 'closed') throw new CodexRpcError('the Codex connection is closed', RPC_ERROR.internal)
      await ready
      const connection = client
      if (connection === undefined) throw new CodexRpcError('the Codex connection is not up', RPC_ERROR.internal)
      return connection.call<R>(method, params, options)
    },

    attach(threadId, sink) {
      sinks.set(threadId, sink)
      for (const entry of diagnostics.slice()) {
        try { sink.diagnostic?.(entry) } catch { logDebug('codex hub: diagnostic callback threw') }
      }
      flushKnownRoutes()
      return () => {
        if (sinks.get(threadId) !== sink) return
        sinks.delete(threadId)
        for (const [from, to] of [...routes]) if (to === threadId) routes.delete(from)
      }
    },

    route(threadId, toThreadId) {
      routes.set(threadId, toThreadId)
      flushKnownRoutes()
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
        buffered.clear()
        parentReads.clear()
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
