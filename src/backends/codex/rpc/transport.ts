/**
 * The `codex app-server` child process as a line transport
 * (docs/codex-backend-design.md §5.1): spawn, newline framing of stdout,
 * a write queue that honours back-pressure, stderr by line, one exit report.
 *
 * - stdout is split on `\n` by hand: a single line may be large (a whole
 *   thread page), but one longer than {@link MAX_LINE_BYTES} is dropped (and
 *   reported once through `onStderr`) instead of growing without bound.
 * - stderr never reaches the terminal: each line goes to `onStderr` (the
 *   host's debug log and deduplicated notices).
 * - `app-server proxy` carries the local daemon's WebSocket stream over
 *   stdio. Its HTTP upgrade and bounded frames use the same child pipes;
 *   closing this child disconnects our client and leaves the daemon running.
 * - `close()` ends stdin (the app-server exits on EOF, C0 V1), then escalates
 *   to SIGTERM and SIGKILL if the child lingers; it resolves once the child
 *   is gone. Safe to call twice.
 *
 * The hub only sees the {@link Transport} interface, so regressions inject an
 * in-process fake (scripts/lib/codex-fake-app-server.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex, Readable, Writable } from 'node:stream'
import WebSocket from 'ws'

/** 96 Mi code units: covers the declared 50 MiB image payload after base64. */
export const MAX_LINE_BYTES = 96 * 1024 * 1024

/** How the child ended (`error` = it never started, e.g. ENOENT). */
export interface TransportExit {
  readonly code: number | null
  readonly signal: string | null
  readonly error?: Error
}

export interface TransportOptions {
  /** The resolved executable (`rpc/binary.ts`). */
  readonly executable: string
  /** Arguments after the executable (`['app-server', ...overrides]`). */
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly onLine: (line: string) => void
  readonly onStderr: (line: string) => void
  readonly onExit: (info: TransportExit) => void
}

export interface Transport {
  /** Send one JSON-RPC message in the transport's framing. */
  write(line: string): void
  /** End the child (stdin EOF, then signals); resolves once it exited. */
  close(): Promise<void>
  readonly pid: number | undefined
}

/** Builds a transport (the hub's injection seam). */
export type TransportFactory = (options: TransportOptions) => Transport

/** Grace periods of {@link Transport.close}: EOF → SIGTERM → SIGKILL. */
export const CLOSE_GRACE_MS = 2000

/** A line splitter with the size bound (shared with the fake transport). */
export function createLineSplitter(onLine: (line: string) => void, onOversize: (bytes: number) => void, maxLine: number = MAX_LINE_BYTES): { push(chunk: string): void; end(): void } {
  let partial = ''
  let skipping = false
  return {
    push(chunk: string): void {
      let start = 0
      for (let index = chunk.indexOf('\n'); index !== -1; index = chunk.indexOf('\n', start)) {
        const piece = chunk.slice(start, index)
        start = index + 1
        if (skipping) {
          skipping = false
          partial = ''
          continue
        }
        const line = partial + piece
        partial = ''
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        if (line.length > maxLine) onOversize(line.length)
        else if (trimmed !== '') onLine(trimmed)
      }
      if (skipping) return
      partial += chunk.slice(start)
      if (partial.length > maxLine) {
        onOversize(partial.length)
        partial = ''
        skipping = true
      }
    },
    end(): void {
      if (!skipping && partial.trim() !== '') onLine(partial)
      partial = ''
      skipping = false
    },
  }
}

/** Windows runs a `.cmd`/`.bat` shim through `cmd.exe` (Node refuses to
 *  spawn one directly). */
function command(executable: string, args: readonly string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable)) {
    const quote = (value: string): string => /[\s"&|<>^]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', [executable, ...args].map(quote).join(' ')] }
  }
  return { file: executable, args: [...args] }
}

/** Spawn the app-server child. Never throws: a spawn failure is reported
 *  through `onExit` with `error` set. */
export function spawnTransport(options: TransportOptions): Transport {
  const { file, args } = command(options.executable, options.args)
  let child: ChildProcess
  let exited = false
  let closing: Promise<void> | undefined
  let websocket: WebSocket | undefined
  const queue: string[] = []
  let exitResolve: (() => void) | undefined
  const exitPromise = new Promise<void>(resolve => { exitResolve = resolve })
  const reportExit = (info: TransportExit): void => {
    if (exited) return
    exited = true
    queue.length = 0
    websocket?.terminate()
    exitResolve?.()
    options.onExit(info)
  }
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    queueMicrotask(() => reportExit({ code: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) }))
    return { write: () => undefined, close: () => Promise.resolve(), pid: undefined }
  }
  const stderr = createLineSplitter(line => options.onStderr(line), () => undefined)
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk))
  child.stderr?.on('end', () => stderr.end())
  // A broken pipe while writing is the child dying; its exit reports it.
  child.stdin?.on('error', () => undefined)
  child.on('error', error => reportExit({ code: null, signal: null, error }))
  child.on('exit', (code, signal) => reportExit({ code, signal }))

  let draining = false
  const flush = (): void => {
    if (exited || closing !== undefined || draining) return
    if (websocket !== undefined) {
      if (websocket.readyState !== WebSocket.OPEN || queue.length === 0) return
      draining = true
      websocket.send(queue.shift()!, error => {
        draining = false
        if (error) child.stdin?.end()
        else flush()
      })
      return
    }
    while (queue.length > 0 && !draining) {
      const line = queue.shift()!
      if (child.stdin?.write(line) === false) draining = true
    }
  }
  if (options.args[0] === 'app-server' && options.args[1] === 'proxy' && child.stdout !== null && child.stdin !== null) {
    const pipes = Duplex.fromWeb({ readable: Readable.toWeb(child.stdout), writable: Writable.toWeb(child.stdin) })
    // The URL supplies HTTP headers only: createConnection connects the
    // official proxy's pipes, never a TCP endpoint.
    websocket = new WebSocket('ws://localhost/', {
      createConnection: () => pipes,
      perMessageDeflate: false,
      maxPayload: MAX_LINE_BYTES,
    })
    websocket.on('open', flush)
    websocket.on('message', data => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      options.onLine(bytes.toString('utf8'))
    })
    websocket.on('error', () => {
      if (!exited && closing === undefined) options.onStderr('dsh-tui: Codex daemon proxy connection failed')
      child.stdin?.end()
    })
    websocket.on('close', () => { child.stdin?.end() })
  } else {
    const stdout = createLineSplitter(options.onLine, bytes => options.onStderr(`dsh-tui: dropped an app-server line of ${bytes} bytes`))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk))
    child.stdout?.on('end', () => stdout.end())
    child.stdin?.on('drain', () => { draining = false; flush() })
  }

  return {
    get pid() { return child.pid },
    write(line: string): void {
      if (exited || closing !== undefined || child.stdin === null || child.stdin.destroyed) return
      queue.push(websocket === undefined ? `${line}\n` : line)
      flush()
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing
      closing = (async () => {
        if (exited) return
        queue.length = 0
        if (websocket?.readyState === WebSocket.OPEN) websocket.close()
        else websocket?.terminate()
        try { child.stdin?.end() } catch { /* already closed */ }
        const waited = (ms: number): Promise<boolean> => Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>(resolve => { setTimeout(() => resolve(false), ms).unref() }),
        ])
        if (await waited(CLOSE_GRACE_MS)) return
        try { child.kill('SIGTERM') } catch { /* gone */ }
        if (await waited(CLOSE_GRACE_MS)) return
        try { child.kill('SIGKILL') } catch { /* gone */ }
        await waited(CLOSE_GRACE_MS)
      })()
      return closing
    },
  }
}
