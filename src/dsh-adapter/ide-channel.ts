/**
 * IDE selection channel (PR-B groundwork): the dsh-tui side of a loopback
 * WebSocket link with a companion IDE extension (dsh-tui-vscode). The
 * extension broadcasts caret-selection changes; the TUI consumes them to
 * attach `<attached-file …>` blocks at submit time (ADR-001).
 *
 * Discovery has two paths (DESIGN D4):
 *   1. env direct — DSH_TUI_IDE_PORT + DSH_TUI_IDE_TOKEN, injected when the
 *      extension spawns this TUI itself;
 *   2. lock scan — `~/.dsh-tui/ide/*.lock` files written by the extension
 *      ({port, token, workspaceFolders, pid}); locks whose workspaceFolders
 *      match the session cwd connect first.
 *
 * Both paths fail → silent degradation (AC-4): no error, no retry,
 * connected=false, every other TUI feature unaffected. The client is Node's
 * native WebSocket global (engines ^22.19 || >=24, D5) — zero dependencies
 * and no auto-reconnect (degrade-on-drop is the design).
 *
 * Protocol constants here are a cross-repo contract (the extension's server
 * side implements the mirror); changing them requires updating both ends
 * plus ADR-001 (DESIGN §9.5).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../utils/paths.js'

/** Env var carrying the extension's loopback WS port (spawn-injected). */
export const IDE_PORT_ENV = 'DSH_TUI_IDE_PORT'
/** Env var carrying the extension's handshake token (spawn-injected). */
export const IDE_TOKEN_ENV = 'DSH_TUI_IDE_TOKEN'

/** Handshake frame the client must send as its very first message. */
const HELLO_METHOD = 'ide/hello'
/** Selection notification method broadcast by the extension. */
const SELECTION_METHOD = 'selection_changed'
/** Total connection budget across all candidates, in milliseconds. */
const CONNECT_BUDGET_MS = 300

/** Where the extension advertises its loopback server (`~/.dsh-tui/ide`). */
export function ideLockDir(dataDir: string = DATA_DIR): string {
  return join(dataDir, 'ide')
}

/** Connection target resolved from the spawn environment. */
export type IdeChannelConfig = {
  port: number
  token: string
}

/**
 * Parse the direct-connect environment. Returns undefined when the pair is
 * absent or malformed — port must be an integer within 1..65535 and the
 * token non-empty — so a bad env degrades to lock discovery instead of
 * throwing.
 */
export function envDirect(env: NodeJS.ProcessEnv): IdeChannelConfig | undefined {
  const portRaw = env[IDE_PORT_ENV]
  const token = env[IDE_TOKEN_ENV]
  if (typeof portRaw !== 'string' || portRaw === '') return undefined
  if (typeof token !== 'string' || token === '') return undefined
  const port = Number(portRaw)
  if (!Number.isSafeInteger(port)) return undefined
  if (port < 1 || port > 65535) return undefined
  return { port, token }
}

/**
 * A parsed `*.lock` file: the extension's advertisement of its loopback
 * server. workspaceFolders holds the absolute paths of its open workspace
 * roots.
 */
export type LockEntry = {
  port: number
  token: string
  workspaceFolders: string[]
  pid: number
}

/** Coordinate snapshot carried by a `selection_changed` notification. */
export type SelectionSnapshot = {
  /** Workspace-relative or absolute file path, as the extension reports it. */
  path: string
  /** First selected line, 0-based. */
  startLine: number
  /** Last selected line, 0-based inclusive. */
  endLine: number
  /** True when the editor selection collapsed to nothing. */
  isEmpty: boolean
}

/**
 * Normalize a path for comparison: backslashes folded to forward slashes,
 * trailing slashes stripped, case folded when the platform's filesystem is
 * case-insensitive (same semantics as channel.ts normalizeCwd — sessions.ts
 * precedent). Exported so verifiers can pin the Windows behavior.
 */
export function normalizeIdePath(path: string, caseInsensitive: boolean): string {
  const normalized = path === '/' ? '/' : path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function platformCaseInsensitive(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/**
 * Read and parse one lock file. Returns undefined for unreadable or
 * malformed content (broken JSON, wrong field types) — a single bad lock
 * must never break the whole scan.
 */
export function readLockEntry(file: string): LockEntry | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const port = record.port
  const token = record.token
  const folders = record.workspaceFolders
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  if (typeof token !== 'string' || token === '') return undefined
  if (!Array.isArray(folders) || !folders.every(folder => typeof folder === 'string')) {
    return undefined
  }
  const pid = record.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) return undefined
  return { port, token, workspaceFolders: folders, pid }
}

/**
 * True when a process id is currently alive (used to skip stale locks whose
 * owning extension already exited). `process.kill(pid, 0)` probes existence
 * without signalling; a missing process throws ESRCH and reads as dead.
 * Same user, so no permission false-negatives for the loopback's own locks.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Scan a lock directory and order the candidates: locks whose
 * workspaceFolders contain the session cwd come first, everything else
 * after; ties keep directory order (stable sort). Malformed locks are
 * skipped. Never throws — an unreadable directory degrades to an empty list.
 *
 * `pid` is part of the lock contract and reserved for future disambiguation
 * (DESIGN R5); matching currently relies on workspaceFolders only.
 */
export function pickLockCandidates(lockDir: string, cwd: string, pid?: number): LockEntry[] {
  void pid
  let names: string[]
  try {
    names = readdirSync(lockDir)
      .filter(name => name.endsWith('.lock'))
      .sort()
  } catch {
    return []
  }
  const caseInsensitive = platformCaseInsensitive()
  const cwdNorm = normalizeIdePath(cwd, caseInsensitive)
  const entries: Array<{ entry: LockEntry; matchLength: number }> = []
  for (const name of names) {
    const entry = readLockEntry(join(lockDir, name))
    // Stale lock: the extension that wrote it has already exited — a dead
    // process can no longer own the handshake token, so never dial it
    // (maintainer review round 2: stale locks could otherwise win discovery).
    if (entry === undefined || !isProcessAlive(entry.pid)) continue
    // Boundary-checked prefix: `/repo/a` must NOT match a cwd of `/repo/abc`
    // (another workspace's window), only `/repo/a` itself or a path under it.
    // Without the separator guard the wrong window's lock is dialed first and
    // its selections attach here. The POSIX root `/` matches every absolute
    // cwd WITHOUT a `//` boundary. `matchLength` records the longest matching
    // workspace root so candidates rank most-specific-first below.
    let matchLength = 0
    for (const folder of entry.workspaceFolders) {
      const root = normalizeIdePath(folder, caseInsensitive)
      if (root === '') continue
      const hits = root === '/'
        ? cwdNorm.startsWith('/')
        : cwdNorm === root || cwdNorm.startsWith(`${root}/`)
      if (hits && root.length > matchLength) matchLength = root.length
    }
    entries.push({ entry, matchLength })
  }
  // Most-specific-first: a `/repo` workspace lock must precede the root `/`
  // fallback when both match the same cwd (coderabbit review), while
  // unmatched locks trail every match.
  return entries
    .sort(
      (left, right) =>
        Number(right.matchLength > 0) - Number(left.matchLength > 0)
        || right.matchLength - left.matchLength,
    )
    .map(item => item.entry)
}

/**
 * Validate one inbound notification as a `selection_changed` frame. Returns
 * undefined for anything else — wrong method, malformed envelope, missing or
 * out-of-range coordinates (endLine >= startLine >= 0, non-empty path).
 */
export function parseSelectionChanged(message: unknown): SelectionSnapshot | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const record = message as Record<string, unknown>
  if (record.method !== SELECTION_METHOD) return undefined
  const params = record.params
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined
  const payload = params as Record<string, unknown>
  const path = payload.path
  const startLine = payload.startLine
  const endLine = payload.endLine
  const isEmpty = payload.isEmpty
  if (typeof path !== 'string' || path === '') return undefined
  if (typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 0) {
    return undefined
  }
  if (typeof endLine !== 'number' || !Number.isSafeInteger(endLine) || endLine < startLine) {
    return undefined
  }
  if (typeof isEmpty !== 'boolean') return undefined
  return { path, startLine, endLine, isEmpty }
}

type SelectionListener = (snapshot: SelectionSnapshot) => void

/**
 * What one consumed selection contributed to a submitted message, recorded
 * next to the user row so the transcript can render a "Selected N lines
 * from <file>" indicator (T06). `lines` is the number of lines actually
 * attached after clamping — the truth the model received, not the request.
 */
export type SelectionAttachedInfo = {
  lines: number
  path: string
}

/**
 * Connection lifecycle (DESIGN §3): idle → connecting (env first, then lock
 * candidates under one shared budget) → connected, or silently disconnected.
 * Once connected, an error or drop degrades to disconnected — no retry.
 * The latest non-empty selection stays available after consumption so
 * consecutive submits can reuse it; an isEmpty notification clears it.
 */
export class IdeChannel {
  private socket: WebSocket | null = null
  private pendingSocket: WebSocket | null = null
  private state: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle'
  private current: SelectionSnapshot | undefined = undefined
  /** Bumped on every connect attempt and on stop(): in-flight dials check it
   *  in `finish`, so a stopped channel can never be revived by a late onopen
   *  (maintainer review round 2 — stop() must cancel pending dials). */
  private generation = 0
  private readonly listeners = new Set<SelectionListener>()

  /** True only while the loopback link is up. */
  get connected(): boolean {
    return this.state === 'connected'
  }

  /** Latest non-empty selection, or undefined (never consumed-clearing). */
  get selection(): SelectionSnapshot | undefined {
    return this.current
  }

  /**
   * Subscribe to every selection notification, including empty ones.
   * @returns An unsubscribe handle.
   */
  onSelection(listener: SelectionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Discover and connect. All arguments are injectable so callers (and
   * verifiers) can pin the environment, lock directory and session cwd;
   * defaults read the live process values. Resolves without throwing in
   * every outcome — check `connected` afterwards.
   */
  async start(
    env: NodeJS.ProcessEnv = process.env,
    lockDir: string = ideLockDir(),
    cwd: string = process.cwd(),
  ): Promise<void> {
    if (this.state !== 'idle') return
    this.generation++
    const targets: IdeChannelConfig[] = []
    const direct = envDirect(env)
    if (direct !== undefined) targets.push(direct)
    for (const lock of pickLockCandidates(lockDir, cwd)) {
      targets.push({ port: lock.port, token: lock.token })
    }
    if (targets.length === 0) {
      this.state = 'disconnected'
      return
    }
    this.state = 'connecting'
    const deadline = Date.now() + CONNECT_BUDGET_MS
    for (const target of targets) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      if (await this.tryConnect(target, remaining)) return
    }
    this.state = 'disconnected'
  }

  /** Drop the link (if any) and mark the channel disconnected. Cancels any
   *  dial still pending: the generation bump invalidates its finish, and the
   *  pending socket is aborted so a late onopen can never re-connect. */
  stop(): void {
    this.generation++
    this.teardown()
    this.state = 'disconnected'
  }

  private teardown(): void {
    const socket = this.socket
    this.socket = null
    const pending = this.pendingSocket
    this.pendingSocket = null
    if (socket !== null) {
      this.detach(socket)
      this.abort(socket)
    }
    if (pending !== null && pending !== socket) {
      this.detach(pending)
      this.abort(pending)
    }
  }

  private detach(socket: WebSocket): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  /** Close without waiting; closing a CONNECTING socket cancels the dial. */
  private abort(socket: WebSocket): void {
    try {
      socket.close()
    } catch {
      // Already closed or half-open — degradation must never throw.
    }
  }

  /**
   * Dial one candidate and perform the token handshake. Resolves true only
   * when the socket is OPEN and `ide/hello` has been sent; anything slower
   * than `timeoutMs` or any error resolves false and cleans up.
   */
  private tryConnect(target: IdeChannelConfig, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false
      const gen = this.generation
      let socket: WebSocket
      try {
        socket = new WebSocket(`ws://127.0.0.1:${target.port}`)
      } catch {
        resolve(false)
        return
      }
      // Track the in-flight dial so stop() can abort it directly (not just
      // via the generation guard) — cancel the CONNECTING socket to unblock
      // the promise instead of letting it spin until the budget ends.
      this.pendingSocket = socket
      const finish = (opened: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // A stop() between dial and open bumped the generation: this dial
        // belongs to a cancelled session — drop it, never become connected.
        if (gen !== this.generation) {
          this.detach(socket)
          this.abort(socket)
          resolve(false)
          return
        }
        if (this.pendingSocket === socket) this.pendingSocket = null
        if (!opened) {
          this.detach(socket)
          this.abort(socket)
          resolve(false)
          return
        }
        this.socket = socket
        this.state = 'connected'
        this.attachMessageHandler(socket)
        resolve(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ method: HELLO_METHOD, params: { token: target.token } }))
          finish(true)
        } catch {
          finish(false)
        }
      }
      socket.onerror = () => finish(false)
      socket.onclose = () => finish(false)
    })
  }

  private attachMessageHandler(socket: WebSocket): void {
    socket.onmessage = event => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        return
      }
      const snapshot = parseSelectionChanged(parsed)
      if (snapshot === undefined) return
      this.current = snapshot.isEmpty ? undefined : snapshot
      for (const listener of [...this.listeners]) listener(snapshot)
    }
    socket.onclose = () => this.degradeToDisconnected(socket)
    socket.onerror = () => this.degradeToDisconnected(socket)
  }

  private degradeToDisconnected(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.detach(socket)
    this.state = 'disconnected'
    // A dead connection's selection is stale: clear the cached snapshot and
    // tell subscribers — the badge and submit auto-attach must not keep
    // using whatever was selected before the disconnect.
    const stale = this.current
    this.current = undefined
    if (stale !== undefined) {
      for (const listener of [...this.listeners]) listener({ ...stale, isEmpty: true })
    }
  }
}
