/**
 * JSON-RPC 2.0 over the app-server's newline-delimited stdio
 * (docs/codex-backend-design.md §5.2). Transport-agnostic: the hub feeds
 * every received line to `receive` and writes through `write`.
 *
 * - Requests get increasing integer ids and a per-method timeout (a timeout
 *   rejects with `CodexRpcError(-32000)` and never kills the process: the
 *   server may still answer, and a late answer is dropped).
 * - Server requests (a message with both `id` and `method`) go to the one
 *   registered handler; it returns the result (or a promise of it), or
 *   `undefined` to answer later through `respond` (a parked approval).
 * - A line that does not parse, an unknown notification and a response to
 *   an id nobody waits for are debug-logged and dropped, never thrown.
 * - `close(reason)` rejects every pending request with `reason`.
 *
 * Diagnostics never carry request parameters: the credential-bearing
 * methods (`account/login/start`) would otherwise leak token material into
 * the debug log.
 */
import { errorText, rec, str, type Rec } from '../narrow.js'

export type RequestId = number | string

/** JSON-RPC error codes the backend distinguishes. */
export const RPC_ERROR = {
  timeout: -32000,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

/** A JSON-RPC error answer (or a local timeout / closed connection). */
export class CodexRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

/** The JSON-RPC code of an error, when it is one. */
export const rpcCode = (error: unknown): number | undefined => error instanceof CodexRpcError ? error.code : undefined

/** Timer seam (tests inject a manual clock). */
export interface RpcClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const REAL_CLOCK: RpcClock = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref()
    return handle
  },
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Default request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Methods that wait for the model or the disk longer than the default. */
const METHOD_TIMEOUTS: Readonly<Record<string, number>> = {
  'turn/start': 60_000,
  'turn/steer': 60_000,
  'thread/resume': 60_000,
  'thread/compact/start': 120_000,
}

export interface CallOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** A server → client request handler (see the module comment). */
export type ServerRequestHandler = (id: RequestId, method: string, params: Rec) => Promise<unknown> | unknown

export interface RpcClient {
  call<R = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<R>
  notify(method: string, params?: unknown): void
  onNotification(listener: (method: string, params: Rec) => void): () => void
  onServerRequest(handler: ServerRequestHandler): void
  respond(id: RequestId, result: unknown): void
  respondError(id: RequestId, code: number, message: string): void
  /** Feed one received line. */
  receive(line: string): void
  /** Reject every pending request; later calls reject at once. */
  close(reason: Error): void
  readonly closed: boolean
  /** Requests still waiting for an answer. */
  readonly pending: number
}

export function createRpcClient(options: {
  readonly write: (line: string) => void
  readonly debug: (message: string) => void
  readonly clock?: RpcClock
}): RpcClient {
  const clock = options.clock ?? REAL_CLOCK
  const pending = new Map<RequestId, { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: unknown; detach?: () => void }>()
  const listeners = new Set<(method: string, params: Rec) => void>()
  let handler: ServerRequestHandler | undefined
  let nextId = 1
  let closedWith: Error | undefined

  const send = (message: Rec): void => {
    if (closedWith !== undefined) return
    try {
      options.write(JSON.stringify(message))
    } catch (error) {
      options.debug(`codex rpc: write failed (${errorText(error)})`)
    }
  }

  const settle = (id: RequestId): ReturnType<typeof pending.get> => {
    const entry = pending.get(id)
    if (entry === undefined) return undefined
    pending.delete(id)
    clock.clearTimeout(entry.timer)
    entry.detach?.()
    return entry
  }

  const answerServerRequest = (id: RequestId, method: string, params: Rec): void => {
    if (handler === undefined) {
      send({ id, error: { code: RPC_ERROR.methodNotFound, message: `dsh-tui does not handle ${method}` } })
      return
    }
    let outcome: unknown
    try {
      outcome = handler(id, method, params)
    } catch (error) {
      options.debug(`codex rpc: server request ${method} handler threw (${errorText(error)})`)
      send({ id, error: { code: RPC_ERROR.internal, message: 'dsh-tui failed to handle the request' } })
      return
    }
    if (outcome === undefined) return
    void Promise.resolve(outcome).then(result => {
      if (result !== undefined) send({ id, result })
    }, (error: unknown) => {
      const code = error instanceof CodexRpcError ? error.code : RPC_ERROR.internal
      send({ id, error: { code, message: error instanceof Error ? error.message : 'dsh-tui failed to handle the request' } })
    })
  }

  return {
    get closed() { return closedWith !== undefined },
    get pending() { return pending.size },

    call<R = unknown>(method: string, params?: unknown, callOptions: CallOptions = {}): Promise<R> {
      if (closedWith !== undefined) return Promise.reject(closedWith)
      if (callOptions.signal?.aborted === true) return Promise.reject(new CodexRpcError(`${method} aborted`, RPC_ERROR.timeout))
      const id = nextId++
      return new Promise<R>((resolve, reject) => {
        const timeoutMs = callOptions.timeoutMs ?? METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS
        const timer = clock.setTimeout(() => {
          if (settle(id) === undefined) return
          options.debug(`codex rpc: ${method} #${id} timed out after ${timeoutMs} ms`)
          reject(new CodexRpcError(`${method} timed out`, RPC_ERROR.timeout))
        }, timeoutMs)
        let detach: (() => void) | undefined
        if (callOptions.signal !== undefined) {
          const signal = callOptions.signal
          const onAbort = (): void => {
            if (settle(id) === undefined) return
            reject(new CodexRpcError(`${method} aborted`, RPC_ERROR.timeout))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          detach = () => { signal.removeEventListener('abort', onAbort) }
        }
        pending.set(id, { method, resolve: value => resolve(value as R), reject, timer, ...(detach === undefined ? {} : { detach }) })
        send(params === undefined ? { id, method } : { id, method, params })
      })
    },

    notify(method: string, params?: unknown): void {
      send(params === undefined ? { method } : { method, params })
    },

    onNotification(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    onServerRequest(next) {
      handler = next
    },

    respond(id, result) {
      send({ id, result })
    },

    respondError(id, code, message) {
      send({ id, error: { code, message } })
    },

    receive(line: string): void {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        options.debug(`codex rpc: dropped a line that is not JSON (${line.length} chars)`)
        return
      }
      const message = rec(parsed)
      if (message === undefined) {
        options.debug('codex rpc: dropped a non-object message')
        return
      }
      const method = str(message.method)
      const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined
      if (method !== undefined && id !== undefined) {
        answerServerRequest(id, method, rec(message.params) ?? {})
        return
      }
      if (method !== undefined) {
        const params = rec(message.params) ?? {}
        for (const listener of [...listeners]) {
          try {
            listener(method, params)
          } catch (error) {
            options.debug(`codex rpc: ${method} listener threw (${errorText(error)})`)
          }
        }
        return
      }
      if (id === undefined) {
        options.debug('codex rpc: dropped a message with neither id nor method')
        return
      }
      const entry = settle(id)
      if (entry === undefined) {
        options.debug(`codex rpc: dropped an answer to unknown request #${String(id)}`)
        return
      }
      const error = rec(message.error)
      if (error !== undefined) {
        const code = typeof error.code === 'number' ? error.code : RPC_ERROR.internal
        entry.reject(new CodexRpcError(str(error.message) ?? `${entry.method} failed`, code, error.data))
        return
      }
      entry.resolve(message.result)
    },

    close(reason: Error): void {
      if (closedWith !== undefined) return
      closedWith = reason
      for (const id of [...pending.keys()]) settle(id)?.reject(reason)
    },
  }
}
