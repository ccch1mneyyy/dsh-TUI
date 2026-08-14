/**
 * Child-process stderr guard (issue #17).
 *
 * MCP servers spawned through `@deepseek-ai/dsh-mcp-client` run under the MCP
 * SDK's `StdioClientTransport`, whose stderr defaults to `'inherit'`
 * (`stdio: ['pipe', 'pipe', server.stderr ?? 'inherit']`). An inherited fd 2
 * is written by the CHILD process straight to the terminal device — those
 * bytes never pass through this process's patched `process.stderr.write`
 * (see `ink.tsx` patchStderr), so they land at the parked cursor, scroll the
 * alt-screen, and interleave with the diff renderer's absolute-coordinate
 * writes. A server in a reconnect loop (e.g. a proxy repeatedly printing
 * `Error: Non-HTTPS URLs ...` + its usage line) turns that into the
 * overlapping garbage shown in the issue screenshot.
 *
 * The guard patches `child_process.spawn` and rewrites requests whose stderr
 * would be inherited (`'inherit'` as the whole-stdio string, stdio array slot
 * 2, or raw fd 2) to a pipe, then drains the pipe line by line into a sink.
 * Only fd 2 is touched; stdin/stdout keep their requested modes, so MCP's
 * JSON-RPC stdio channel is unaffected.
 *
 * Reachability note: the MCP SDK spawns via `cross-spawn`, which reads
 * `child_process.spawn` off the CJS exports object at call time, so this
 * patch covers it (verified by scripts/verify-child-stderr.tsx). A consumer
 * holding a snapshotted ESM named import (`import { spawn } from
 * 'node:child_process'`) would bypass the patch — no known consumer in the
 * dependency tree does that.
 */

import childProcess from 'node:child_process'
import { t } from './i18n.js'

/** Strip ANSI escape sequences (CSI/OSC) so raw child output can't inject
 *  cursor moves or colors into the notification area. */
// eslint-disable-next-line no-control-regex -- intentional: matching terminal escape sequences
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * Rewrite spawn options so an inherited stderr (fd 2) becomes a pipe.
 * Returns the adjusted options, or undefined when stderr is not inherited
 * (default/'pipe'/'ignore'/explicit stream) and the spawn needs no takeover.
 */
function redirectInheritedStderr(options: childProcess.SpawnOptions): childProcess.SpawnOptions | undefined {
  const stdio = options.stdio
  if (stdio === undefined || stdio === null) return undefined
  if (typeof stdio === 'string') {
    // The string form applies to all three fds; keep stdin/stdout inherited.
    if (stdio !== 'inherit') return undefined
    return { ...options, stdio: ['inherit', 'inherit', 'pipe'] }
  }
  if (Array.isArray(stdio)) {
    // A short array leaves fd 2 at the 'pipe' default — already safe.
    const stderr = stdio[2]
    if (stderr !== 'inherit' && stderr !== 2) return undefined
    const next = [...stdio]
    next[2] = 'pipe'
    return { ...options, stdio: next }
  }
  return undefined
}

/** Drain a piped stderr stream, forwarding complete lines (and the unterminated tail) to the sink. */
function drainLines(stream: NodeJS.ReadableStream, sink: (line: string) => void): void {
  let pending = ''
  stream.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString()
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      sink(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (pending.length > 0) sink(pending)
  })
  stream.on('error', () => {
    // A broken stderr pipe must never take the TUI down.
  })
}

/**
 * Take over inherited child stderr for the TUI's lifetime: any `spawn` whose
 * stderr would hit the terminal directly is piped and drained into `sink`
 * instead. Returns a restore function that reverts the patch; in-flight
 * children keep their (already piped) streams.
 */
export function installChildStderrGuard(sink: (line: string) => void): () => void {
  const original = childProcess.spawn
  const patched = function (
    command: string,
    argsOrOptions?: readonly string[] | childProcess.SpawnOptions | null,
    maybeOptions?: childProcess.SpawnOptions | null,
  ): childProcess.ChildProcess {
    let args: readonly string[]
    let options: childProcess.SpawnOptions
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions as readonly string[]
      options = maybeOptions ?? {}
    } else {
      args = []
      // Array.isArray doesn't exclude `readonly string[]` in the else branch.
      options = (argsOrOptions as childProcess.SpawnOptions | null | undefined) ?? maybeOptions ?? {}
    }
    const redirected = redirectInheritedStderr(options)
    const child = original.call(childProcess, command, args as string[], redirected ?? options)
    if (redirected !== undefined && child.stderr !== null) {
      drainLines(child.stderr, sink)
    }
    return child
  }
  childProcess.spawn = patched as typeof childProcess.spawn
  return () => {
    if (childProcess.spawn === patched) {
      childProcess.spawn = original
    }
  }
}

/** Notification callback signature — structurally `Channel['notify']`. */
export interface ChildStderrNotify {
  (text: string, options?: { color?: 'error' | 'warning' | 'success'; timeoutMs?: number }): void
}

export interface ChildStderrReporterOptions {
  /** Quiet window that batches a burst of repeats into one notice (default 1500ms). */
  debounceMs?: number
  /** After a notice, the same line stays silent for this long (default 30s). */
  cooldownMs?: number
  /** Single-line length cap; longer lines are truncated with an ellipsis (default 200). */
  maxLineLength?: number
}

export interface ChildStderrReporter {
  /** Feed one raw stderr line. */
  push(line: string): void
  /** Cancel pending debounce timers (teardown). */
  dispose(): void
}

/**
 * Turn a raw child-stderr line stream into bounded, deduplicated
 * notifications: identical lines inside a short debounce window collapse into
 * one "（重复 N 次）" notice, and a line that was just shown stays silent for
 * a cooldown so a failing reconnect loop can't spam the status area.
 */
export function createChildStderrReporter(
  notify: ChildStderrNotify,
  options: ChildStderrReporterOptions = {},
): ChildStderrReporter {
  const debounceMs = options.debounceMs ?? 1500
  const cooldownMs = options.cooldownMs ?? 30_000
  const maxLineLength = options.maxLineLength ?? 200
  interface Group {
    count: number
    timer: NodeJS.Timeout
  }
  const groups = new Map<string, Group>()
  const mutedUntil = new Map<string, number>()

  return {
    push(raw) {
      const cleaned = raw.replace(ANSI_PATTERN, '').trim()
      if (cleaned.length === 0) return
      const line = cleaned.length > maxLineLength ? `${cleaned.slice(0, maxLineLength)}…` : cleaned
      const existing = groups.get(line)
      if (existing !== undefined) {
        existing.count += 1
        clearTimeout(existing.timer)
        existing.timer = setTimeout(flush, debounceMs)
        return
      }
      groups.set(line, { count: 1, timer: setTimeout(flush, debounceMs) })

      function flush(): void {
        const group = groups.get(line)
        if (group === undefined) return
        groups.delete(line)
        // A burst inside the cooldown window is counted but stays silent.
        if ((mutedUntil.get(line) ?? 0) > Date.now()) return
        mutedUntil.set(line, Date.now() + cooldownMs)
        const text =
          group.count > 1
            ? t('child-stderr-line-repeat', { line, count: group.count })
            : t('child-stderr-line', { line })
        notify(text, { color: 'error', timeoutMs: 8000 })
      }
    },
    dispose() {
      for (const group of groups.values()) clearTimeout(group.timer)
      groups.clear()
    },
  }
}
