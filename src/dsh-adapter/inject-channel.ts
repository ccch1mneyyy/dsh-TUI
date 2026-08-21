/**
 * External injection channel — lets an out-of-process editor integration
 * (e.g. the `dsh.nvim` Neovim plugin) push text into the running TUI's
 * prompt input and, optionally, submit it. This is dsh-TUI's answer to
 * OpenCode's `POST /tui/publish` (`tui.prompt.append` / `tui.command.execute`),
 * but over a per-session local socket instead of an HTTP port: no port
 * allocation, no auth surface, and the endpoint is torn down with the
 * session.
 *
 * Transport: a Unix domain socket at `~/.dsh-tui/inject/<sessionId>.sock`
 * (a named pipe `\\.\pipe\dsh-tui-inject-<sessionId>` on Windows). Alongside
 * it the server maintains a discovery file `~/.dsh-tui/inject/servers.json`
 * listing every live session (`pid`, `sessionId`, `cwd`, `socketPath`) so a
 * client can pick the instance whose `cwd` overlaps the editor's project —
 * the same cwd-matching OpenCode's server discovery does.
 *
 * Wire format: newline-delimited JSON, one message per line. Messages:
 *   - `{ "type": "prompt.append", "text": "@src/foo.ts " }`
 *   - `{ "type": "command.execute", "command": "prompt.submit" }`
 * A trailing space in appended text (OpenCode's convention) leaves the input
 * unsubmitted; the client sends `prompt.submit` when it wants the turn sent.
 *
 * @module
 */

import { createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../utils/paths.js'

/** Directory holding per-session sockets and the discovery file. */
export const INJECT_DIR = join(DATA_DIR, 'inject')

/** Discovery file listing every live injection endpoint. */
export const SERVERS_FILE = join(INJECT_DIR, 'servers.json')

/**
 * A discovery record for one live session, written to {@link SERVERS_FILE}.
 * Clients read the array and match `cwd` against their own project root.
 */
export interface InjectServerRecord {
  /** Process id of the TUI holding this endpoint (staleness/liveness check). */
  readonly pid: number
  /** DSH session id this endpoint injects into. */
  readonly sessionId: string
  /** Session working directory, for client-side cwd matching. */
  readonly cwd: string
  /** Absolute socket path (Unix) or named-pipe path (Windows) to connect to. */
  readonly socketPath: string
  /** Epoch ms when the endpoint was opened (newest-wins tie-break for clients). */
  readonly startedAt: number
}

/**
 * A message accepted over the injection socket. `prompt.append` carries the
 * text to insert at the caret; `command.execute` names a TUI command
 * (currently only `prompt.submit`).
 */
export type InjectMessage =
  | { readonly type: 'prompt.append'; readonly text: string }
  | { readonly type: 'command.execute'; readonly command: 'prompt.submit' }

/** Host callbacks the channel drives when a validated message arrives. */
export interface InjectHandlers {
  /** Append `text` to the prompt input (does not submit). */
  append(text: string): void
  /** Submit the current prompt input as a turn. */
  submit(): void
}

/**
 * The Chat screen's fulfillment of {@link InjectHandlers}: the UI publishes a
 * controller each render so the adapter-owned socket can drive prompt append
 * and submit without the socket reaching into React state directly.
 */
export type InjectController = InjectHandlers

/**
 * The platform socket path for a session id. Windows named pipes live under
 * the `\\.\pipe\` namespace and ignore {@link INJECT_DIR}; the discovery file
 * still records the pipe path so clients connect to the right name.
 * @param sessionId - DSH session id.
 * @returns Connectable socket path or pipe name.
 */
export function socketPathFor(sessionId: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dsh-tui-inject-${sessionId}`
  }
  return join(INJECT_DIR, `${sessionId}.sock`)
}

/**
 * Parse and validate one line as an {@link InjectMessage}. Returns `null` for
 * anything malformed — the socket is a trust boundary (a foreign process
 * writes to it), so every field is checked rather than trusted.
 * @param line - One newline-delimited JSON line (already trimmed of the newline).
 * @returns The validated message, or `null` to ignore the line.
 */
export function parseInjectMessage(line: string): InjectMessage | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    // A foreign client sent a non-JSON line; ignore rather than crash.
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.type === 'prompt.append' && typeof msg.text === 'string') {
    return { type: 'prompt.append', text: msg.text }
  }
  if (msg.type === 'command.execute' && msg.command === 'prompt.submit') {
    return { type: 'command.execute', command: 'prompt.submit' }
  }
  return null
}

/**
 * Read the discovery file, dropping records whose process is gone. Returns an
 * empty array when the file is absent or unreadable.
 * @returns Live server records.
 */
function readServers(): InjectServerRecord[] {
  let text: string
  try {
    text = readFileSync(SERVERS_FILE, 'utf8')
  } catch {
    // No discovery file yet, or a concurrent writer replaced it mid-read.
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A partially written file; the current writer will overwrite it.
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is InjectServerRecord => {
    if (typeof entry !== 'object' || entry === null) return false
    const rec = entry as Record<string, unknown>
    return (
      typeof rec.pid === 'number' &&
      typeof rec.sessionId === 'string' &&
      typeof rec.cwd === 'string' &&
      typeof rec.socketPath === 'string' &&
      typeof rec.startedAt === 'number'
    )
  })
}

/**
 * Whether a process id is still alive. `process.kill(pid, 0)` sends no signal
 * but throws `ESRCH` when the process is gone; `EPERM` means it exists but is
 * owned by another user (still alive for our purposes).
 * @param pid - Process id to probe.
 * @returns True when the process appears to exist.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Rewrite the discovery file to `records`, best-effort. Never throws: a
 * failed discovery write must not take down the session.
 * @param records - The complete record set to persist.
 */
function writeServers(records: InjectServerRecord[]): void {
  try {
    mkdirSync(INJECT_DIR, { recursive: true })
    writeFileSync(SERVERS_FILE, JSON.stringify(records, null, 2), 'utf8')
  } catch {
    // Discovery is an optimization; the socket still works without the file.
  }
}

/** A running injection channel; call {@link InjectChannel.close} at teardown. */
export interface InjectChannel {
  /** Absolute socket path this channel listens on. */
  readonly socketPath: string
  /** Stop listening, remove this session's discovery record, and unlink the socket. */
  close(): void
}

/**
 * Open the injection channel for one session: bind the socket, register the
 * discovery record, and dispatch validated messages to `handlers`. Returns
 * `null` when the socket cannot be bound (another process owns a stale socket
 * that is genuinely in use, or the platform forbids it) — injection is an
 * optional integration, so a bind failure degrades to "no channel" rather
 * than failing the session.
 *
 * @param sessionId - DSH session id to expose.
 * @param cwd - Session working directory, recorded for client cwd matching.
 * @param handlers - Host callbacks invoked per validated message.
 * @param onError - Optional sink for non-fatal listen/socket errors.
 * @returns The live channel, or `null` if binding failed.
 */
export function openInjectChannel(
  sessionId: string,
  cwd: string,
  handlers: InjectHandlers,
  onError?: (message: string) => void,
): InjectChannel | null {
  const socketPath = socketPathFor(sessionId)

  try {
    mkdirSync(INJECT_DIR, { recursive: true })
  } catch {
    // Directory creation failing means we cannot host a Unix socket; on
    // Windows the pipe namespace does not need it, so fall through and let
    // listen() decide.
  }

  // A previous crash may have left a stale socket file. Removing it before
  // bind is safe on Unix; on Windows the pipe name is reclaimed by the OS.
  if (process.platform !== 'win32') {
    try {
      rmSync(socketPath, { force: true })
    } catch {
      // Nothing to remove, or a live socket we are about to fail binding —
      // listen() surfaces the real error below.
    }
  }

  let server: Server
  try {
    server = createServer((socket: Socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const message = parseInjectMessage(line)
          if (message?.type === 'prompt.append') {
            handlers.append(message.text)
          } else if (message?.type === 'command.execute') {
            handlers.submit()
          }
          newline = buffer.indexOf('\n')
        }
      })
      socket.on('error', () => {
        // A client that disconnects mid-write raises EPIPE/ECONNRESET here;
        // the per-connection error is not the session's concern.
      })
    })
  } catch (error) {
    onError?.(`inject channel: failed to create server: ${String(error)}`)
    return null
  }

  server.on('error', (error) => {
    onError?.(`inject channel: socket error: ${String(error)}`)
  })

  try {
    server.listen(socketPath)
  } catch (error) {
    onError?.(`inject channel: failed to listen on ${socketPath}: ${String(error)}`)
    return null
  }

  const record: InjectServerRecord = {
    pid: process.pid,
    sessionId,
    cwd,
    socketPath,
    startedAt: Date.now(),
  }
  const others = readServers().filter(
    (entry) => entry.sessionId !== sessionId && pidAlive(entry.pid),
  )
  writeServers([...others, record])

  return {
    socketPath,
    close(): void {
      try {
        server.close()
      } catch {
        // Already closed or never fully listened; nothing to undo.
      }
      const remaining = readServers().filter(
        (entry) => entry.sessionId !== sessionId && pidAlive(entry.pid),
      )
      writeServers(remaining)
      if (process.platform !== 'win32') {
        try {
          rmSync(socketPath, { force: true })
        } catch {
          // The socket file was already removed by close() on some platforms.
        }
      }
    },
  }
}
