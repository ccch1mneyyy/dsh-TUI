/**
 * An in-process fake `codex app-server` for the Codex backend regressions
 * (docs/codex-backend-design.md §10.1). It implements the backend's
 * `Transport` (src/backends/codex/rpc/transport.ts) and plugs into the hub
 * through its transport factory: no process, no network.
 *
 * - Scripted methods: `on(method, handler)` answers a client request (return
 *   a result, throw {@link FakeRpcError} for a JSON-RPC error, return
 *   {@link NO_REPLY} to answer later with `reply(id, …)`); unhandled requests
 *   get `-32601`. `initialize` has a default answer.
 * - Server traffic: `notify(method, params)`; `request(method, params)` sends
 *   a server request and resolves with the client's answer.
 * - Replay of a recorded wire fixture (`scripts/fixtures/codex/wire/*.jsonl`):
 *   recorded client requests are matched in order against the live client's
 *   requests of the same method (recorded ids map to live ids); recorded
 *   responses answer the live request; recorded server requests are sent and
 *   the replay waits for the client's answer before continuing; thread ids
 *   can be remapped. Methods with a scripted handler stay out of the replay.
 * - Faults: `crash()` (the child "exits"), `stderr(line)`, `raw(line)`
 *   (malformed input), a per-message replay delay; two concurrent replays
 *   on different threads interleave while each keeps its own order.
 * - Every client message is recorded (`requests`, `notifications`,
 *   `responses`) for assertions.
 */
import type { Transport, TransportExit, TransportOptions } from '../../src/backends/codex/rpc/transport.js'

type Rec = Record<string, unknown>
type Id = number | string

/** A JSON-RPC error a scripted handler throws. */
export class FakeRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
  }
}

/** A handler result meaning "answer later through `reply`". */
export const NO_REPLY: unique symbol = Symbol('no-reply')

export type FakeHandler = (params: Rec, request: { readonly id: Id; readonly method: string }) => unknown

export interface RecordedRequest {
  readonly id: Id
  readonly method: string
  readonly params: Rec
  /** Which transport generation (spawn count) received it. */
  readonly generation: number
}

/** One line of a wire fixture. */
export interface WireEntry {
  readonly t?: number
  readonly dir: 'in' | 'out'
  readonly msg: Rec
}

export interface ReplayOptions {
  /** Recorded thread id → live thread id (applied to every replayed message). */
  readonly threadMap?: Readonly<Record<string, string>>
  /** Recorded client methods the live client never sends (skipped). */
  readonly skipClientMethods?: readonly string[]
  /** Delay between replayed server messages (ms); 0 = next macrotask. */
  readonly delayMs?: number
  /** Stop before the first entry matching this (e.g. the probe's trailing reads). */
  readonly until?: (entry: WireEntry) => boolean
  /** Bound on waiting for one live client message (ms). */
  readonly waitMs?: number
}

export interface FakeAppServer {
  /** The hub's transport factory. */
  readonly transportFactory: (options: TransportOptions) => Transport
  /** Every transport created (a restart creates another). */
  readonly spawns: readonly TransportOptions[]
  readonly requests: readonly RecordedRequest[]
  readonly notifications: readonly { readonly method: string; readonly params: Rec }[]
  /** The client's answers to server requests, by server request id. */
  readonly responses: ReadonlyMap<Id, { readonly result?: unknown; readonly error?: Rec }>
  on(method: string, handler: FakeHandler): void
  off(method: string): void
  reply(id: Id, result: unknown): void
  replyError(id: Id, code: number, message: string): void
  notify(method: string, params?: Rec): void
  request(method: string, params?: Rec): Promise<{ readonly result?: unknown; readonly error?: Rec }>
  /** Send a raw line (malformed input tests). */
  raw(line: string): void
  stderr(line: string): void
  /** The child exits unexpectedly (pending client requests get no answer). */
  crash(info?: Partial<TransportExit>): void
  /** Wait for the next client request of `method` (already-seen ones count). */
  waitForRequest(method: string, options?: { readonly after?: number; readonly timeoutMs?: number }): Promise<RecordedRequest>
  /** Replay a recording's server side against the live client. */
  replay(entries: readonly WireEntry[], options?: ReplayOptions): Promise<void>
  /** Whether a transport is currently connected. */
  readonly connected: boolean
  /** Whether the client closed its transport. */
  readonly closed: boolean
}

/** Parse a `.jsonl` wire fixture. */
export function parseWire(text: string): WireEntry[] {
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as WireEntry)
}

const DEFAULT_INITIALIZE = {
  userAgent: 'dsh-tui/0.160.1 (fake; x86_64)',
  codexHome: '/TMP/home',
  platformFamily: 'unix',
  platformOs: 'linux',
}

const tick = (ms = 0): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** Replace recorded thread ids in a message (deep). */
function remap(value: unknown, map: Readonly<Record<string, string>> | undefined): unknown {
  if (map === undefined || Object.keys(map).length === 0) return value
  if (typeof value === 'string') return Object.hasOwn(map, value) ? map[value] : value
  if (Array.isArray(value)) return value.map(item => remap(item, map))
  if (typeof value === 'object' && value !== null) {
    const out: Rec = {}
    for (const [key, item] of Object.entries(value)) out[key] = remap(item, map)
    return out
  }
  return value
}

export function createFakeAppServer(options: { readonly initialize?: Rec | false } = {}): FakeAppServer {
  const handlers = new Map<string, FakeHandler>()
  const spawns: TransportOptions[] = []
  const requests: RecordedRequest[] = []
  const notifications: { method: string; params: Rec }[] = []
  const responses = new Map<Id, { result?: unknown; error?: Rec }>()
  const responseWaiters = new Map<Id, ((answer: { result?: unknown; error?: Rec }) => void)[]>()
  const requestWaiters = new Set<() => void>()
  /** Live client requests the replay may claim (no scripted handler). */
  const unclaimed: RecordedRequest[] = []
  let current: { options: TransportOptions; generation: number; alive: boolean } | undefined
  let closed = false
  let nextServerId = 0

  if (options.initialize !== false) {
    const answer = options.initialize ?? DEFAULT_INITIALIZE
    handlers.set('initialize', () => answer)
  }

  const send = (message: Rec): void => {
    const target = current
    if (target === undefined || !target.alive) return
    target.options.onLine(JSON.stringify(message))
  }
  const wakeRequests = (): void => { for (const wake of [...requestWaiters]) wake() }

  const handleRequest = (request: RecordedRequest): void => {
    const handler = handlers.get(request.method)
    if (handler === undefined) {
      unclaimed.push(request)
      wakeRequests()
      // Nothing claims it within a tick: answer like an unknown method,
      // unless a replay is waiting for exactly this method.
      setTimeout(() => {
        const index = unclaimed.indexOf(request)
        if (index === -1 || replaying > 0) return
        unclaimed.splice(index, 1)
        send({ id: request.id, error: { code: -32601, message: `fake app-server: no handler for ${request.method}` } })
      }, 0)
      return
    }
    wakeRequests()
    Promise.resolve()
      .then(() => handler(request.params, { id: request.id, method: request.method }))
      .then(result => {
        if (result === NO_REPLY) return
        send({ id: request.id, result: result ?? {} })
      }, (error: unknown) => {
        const code = error instanceof FakeRpcError ? error.code : -32603
        const data = error instanceof FakeRpcError ? error.data : undefined
        send({ id: request.id, error: { code, message: error instanceof Error ? error.message : String(error), ...(data === undefined ? {} : { data }) } })
      })
  }

  const receive = (generation: number, line: string): void => {
    let message: Rec
    try {
      message = JSON.parse(line) as Rec
    } catch {
      throw new Error(`fake app-server: client wrote a non-JSON line: ${line.slice(0, 120)}`)
    }
    const method = typeof message.method === 'string' ? message.method : undefined
    const id = message.id as Id | undefined
    if (method !== undefined && id !== undefined) {
      const request = { id, method, params: (message.params ?? {}) as Rec, generation }
      requests.push(request)
      handleRequest(request)
      return
    }
    if (method !== undefined) {
      notifications.push({ method, params: (message.params ?? {}) as Rec })
      return
    }
    if (id !== undefined) {
      const answer = { ...(message.result === undefined ? {} : { result: message.result }), ...(message.error === undefined ? {} : { error: message.error as Rec }) }
      responses.set(id, answer)
      for (const waiter of responseWaiters.get(id) ?? []) waiter(answer)
      responseWaiters.delete(id)
    }
  }

  let replaying = 0

  const transportFactory = (transportOptions: TransportOptions): Transport => {
    spawns.push(transportOptions)
    closed = false
    const generation = spawns.length
    const state = { options: transportOptions, generation, alive: true }
    current = state
    return {
      pid: 4000 + generation,
      write(line: string): void {
        if (!state.alive) return
        // Asynchronous like a pipe: the client never re-enters itself.
        queueMicrotask(() => { if (state.alive) receive(generation, line) })
      },
      close(): Promise<void> {
        if (!state.alive) return Promise.resolve()
        state.alive = false
        closed = true
        queueMicrotask(() => transportOptions.onExit({ code: 0, signal: null }))
        return Promise.resolve()
      },
    }
  }

  const waitForRequest = (method: string, waitOptions: { readonly after?: number; readonly timeoutMs?: number } = {}): Promise<RecordedRequest> => {
    const after = waitOptions.after ?? 0
    const find = (): RecordedRequest | undefined => requests.slice(after).find(request => request.method === method)
    const hit = find()
    if (hit !== undefined) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requestWaiters.delete(wake)
        reject(new Error(`fake app-server: no ${method} request within ${waitOptions.timeoutMs ?? 2000} ms`))
      }, waitOptions.timeoutMs ?? 2000)
      const wake = (): void => {
        const found = find()
        if (found === undefined) return
        clearTimeout(timer)
        requestWaiters.delete(wake)
        resolve(found)
      }
      requestWaiters.add(wake)
    })
  }

  /** Claim the oldest unclaimed live request of `method`. */
  const claim = (method: string, waitMs: number): Promise<RecordedRequest> => {
    const take = (): RecordedRequest | undefined => {
      const index = unclaimed.findIndex(request => request.method === method)
      return index === -1 ? undefined : unclaimed.splice(index, 1)[0]
    }
    const hit = take()
    if (hit !== undefined) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requestWaiters.delete(wake)
        reject(new Error(`fake app-server replay: the client never sent ${method} (waited ${waitMs} ms)`))
      }, waitMs)
      const wake = (): void => {
        const found = take()
        if (found === undefined) return
        clearTimeout(timer)
        requestWaiters.delete(wake)
        resolve(found)
      }
      requestWaiters.add(wake)
    })
  }

  const request = (method: string, params: Rec = {}): Promise<{ result?: unknown; error?: Rec }> => {
    const id = nextServerId++
    const answer = new Promise<{ result?: unknown; error?: Rec }>(resolve => {
      const list = responseWaiters.get(id) ?? []
      list.push(resolve)
      responseWaiters.set(id, list)
    })
    send({ method, id, params })
    return answer
  }

  const replay = async (entries: readonly WireEntry[], replayOptions: ReplayOptions = {}): Promise<void> => {
    const map = replayOptions.threadMap
    const skip = new Set(replayOptions.skipClientMethods ?? [])
    const waitMs = replayOptions.waitMs ?? 3000
    const delay = replayOptions.delayMs ?? 0
    /** Recorded client request id → live id (for the recorded response). */
    const clientIds = new Map<Id, Id>()
    /** Recorded server request id → the live answer promise. */
    const serverAnswers = new Map<Id, Promise<unknown>>()
    replaying += 1
    try {
      for (const entry of entries) {
        if (replayOptions.until?.(entry) === true) break
        const message = remap(entry.msg, map) as Rec
        const method = typeof message.method === 'string' ? message.method : undefined
        const id = message.id as Id | undefined
        if (entry.dir === 'out') {
          if (method !== undefined && id !== undefined) {
            if (skip.has(method) || handlers.has(method)) continue
            const live = await claim(method, waitMs)
            clientIds.set(id, live.id)
          } else if (method === undefined && id !== undefined) {
            // The recorded client answered a server request: wait for ours.
            await serverAnswers.get(id)
          }
          continue
        }
        await tick(delay)
        if (method !== undefined && id !== undefined) {
          serverAnswers.set(id, request(method, (message.params ?? {}) as Rec))
        } else if (method !== undefined) {
          send(message)
        } else if (id !== undefined) {
          const live = clientIds.get(id)
          if (live === undefined) continue
          send({ ...message, id: live })
        }
      }
    } finally {
      replaying -= 1
    }
  }

  return {
    transportFactory,
    get spawns() { return spawns },
    get requests() { return requests },
    get notifications() { return notifications },
    get responses() { return responses },
    get connected() { return current?.alive === true },
    get closed() { return closed },
    on(method, handler) { handlers.set(method, handler) },
    off(method) { handlers.delete(method) },
    reply(id, result) { send({ id, result }) },
    replyError(id, code, message) { send({ id, error: { code, message } }) },
    notify(method, params = {}) { send({ method, params }) },
    request,
    raw(line) {
      const target = current
      if (target?.alive === true) target.options.onLine(line)
    },
    stderr(line) { current?.options.onStderr(line) },
    crash(info = {}) {
      const target = current
      if (target === undefined || !target.alive) return
      target.alive = false
      queueMicrotask(() => target.options.onExit({ code: info.code ?? 1, signal: info.signal ?? null, ...(info.error === undefined ? {} : { error: info.error }) }))
    },
    waitForRequest,
    replay,
  }
}
