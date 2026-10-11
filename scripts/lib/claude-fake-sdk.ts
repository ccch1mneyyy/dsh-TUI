/**
 * A fake Claude Agent SDK `query()` for the Claude backend gates
 * (verify-claude-auth, verify-claude-controls): every call records its
 * options and returns a scriptable `Query` — the test pushes SDK messages,
 * reads the inputs the session pushed, and answers control requests from a
 * per-test table. No CLI, no network.
 *
 * Import from TypeScript scripts run with `node --import tsx/esm`.
 */
import { readFileSync, statSync } from 'node:fs'
import { getLang } from '../../src/i18n.js'
import type { ClaudeClock, ClaudeSessionDeps } from '../../src/backends/claude/session.js'

export type FakeQueryOptions = Record<string, unknown> & { readonly canUseTool?: unknown; readonly env?: Record<string, string> }

/** Control requests a test may answer (anything else rejects loudly). */
export type FakeControls = Partial<Record<string, (...args: never[]) => unknown>>

export interface FakeQuery {
  readonly options: FakeQueryOptions
  /** Every user message the session pushed (stdin). */
  readonly inputs: Record<string, unknown>[]
  /** Every control call: method name and arguments. */
  readonly calls: { method: string; args: unknown[] }[]
  readonly closed: boolean
  /** The flag settings as the CLI would read them when the query started:
   *  the file `options.settings` names (parsed), or an inline object. */
  readonly flagSettings: { readonly env?: Record<string, string> } | undefined
  /** The permission bits of that file (POSIX), when it was a file. */
  readonly flagSettingsMode: number | undefined
  emit(message: unknown): void
}

/** What `options.settings` holds right now (undefined when absent). */
function readFlagSettings(settings: unknown): { value: { readonly env?: Record<string, string> } | undefined; mode: number | undefined } {
  if (typeof settings !== 'string') return { value: settings as { readonly env?: Record<string, string> } | undefined, mode: undefined }
  return { value: JSON.parse(readFileSync(settings, 'utf8')) as { readonly env?: Record<string, string> }, mode: statSync(settings).mode & 0o777 }
}

/** The fake SDK: `queries` in creation order. */
export function fakeClaudeSdk(init: (index: number, options: FakeQueryOptions) => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({ capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }), controls: FakeControls = {}) {
  const queries: FakeQuery[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: FakeQueryOptions }) => {
    const index = queries.length
    const outbox: unknown[] = []
    const waiters: ((result: IteratorResult<unknown>) => void)[] = []
    const inputs: Record<string, unknown>[] = []
    const calls: { method: string; args: unknown[] }[] = []
    let ended = false
    const flag = readFlagSettings(params.options.settings)
    void (async () => { for await (const message of params.prompt) inputs.push(message) })()
    const flush = (): void => {
      while (waiters.length > 0 && (outbox.length > 0 || ended)) {
        const waiter = waiters.shift()!
        if (outbox.length > 0) waiter({ value: outbox.shift(), done: false })
        else waiter({ value: undefined, done: true })
      }
    }
    const control = (method: string) => (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args })
      const handler = controls[method] as ((...values: unknown[]) => unknown) | undefined
      if (handler === undefined) return Promise.reject(new Error(`fake query: no ${method}`))
      try {
        return Promise.resolve(handler(...args))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const fake = {
      options: params.options,
      inputs,
      calls,
      closed: false,
      flagSettings: flag.value,
      flagSettingsMode: flag.mode,
      emit(message: unknown) { outbox.push(message); flush() },
      // A throwing (or rejecting) `init` is a CLI that fails its handshake.
      initializationResult: (): Promise<unknown> => {
        try {
          return Promise.resolve(init(index, params.options))
        } catch (error) {
          return Promise.reject(error)
        }
      },
      interrupt: control('interrupt'),
      setModel: control('setModel'),
      setPermissionMode: control('setPermissionMode'),
      applyFlagSettings: control('applyFlagSettings'),
      supportedModels: control('supportedModels'),
      supportedCommands: control('supportedCommands'),
      mcpServerStatus: control('mcpServerStatus'),
      reconnectMcpServer: control('reconnectMcpServer'),
      toggleMcpServer: control('toggleMcpServer'),
      getContextUsage: control('getContextUsage'),
      accountInfo: control('accountInfo'),
      rewindFiles: control('rewindFiles'),
      stopTask: control('stopTask'),
      close() { fake.closed = true; ended = true; flush() },
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (outbox.length > 0) return Promise.resolve({ value: outbox.shift(), done: false })
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise(resolve => { waiters.push(resolve) })
          },
        }
      },
    }
    queries.push(fake)
    return fake
  }
  return { sdk: { query } as unknown as ClaudeSessionDeps['sdk'], queries }
}

/** A manual clock (no real timers). */
export function manualClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: ClaudeClock = {
    setTimeout(callback, ms) { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout(handle) { timers.delete(handle as number) },
  }
  return {
    clock,
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

/** The common session deps over a fake SDK. */
export function claudeDeps(sdk: ClaudeSessionDeps['sdk'], extra: Partial<ClaudeSessionDeps> = {}): ClaudeSessionDeps {
  return {
    sdk,
    cwd: '/fixture/project',
    sessionId: '00000000-0000-4000-8000-0000000000ab',
    start: { mode: 'default', source: 'default' },
    executable: { path: '/fixture/bin/claude', source: 'env' },
    env: { PATH: '/usr/bin' },
    // The fixture host answers like the real one (B-3): the language the
    // process pinned, so the backend's own copy and the host dictionary the
    // assertions compare against agree. No `dataDir`: a fixture that wants the
    // file-backed stores passes one (the backend keeps prefs in memory
    // otherwise, which is what these runs want anyway).
    host: { debug: () => undefined, locale: getLang },
    clock: manualClock().clock,
    ...extra,
  }
}

export const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
