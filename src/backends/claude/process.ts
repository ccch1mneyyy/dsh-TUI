/**
 * The `claude` child process as this backend starts it (design §4.2, §4.3):
 * which executable, with which environment, and where its stderr goes.
 *
 * - Executable: `CLAUDE_CODE_EXECUTABLE` → `claude` on PATH → the SDK's own
 *   bundled binary (left to the SDK by passing no path). The PATH binary wins
 *   over the bundled one so the session shares the user's interactive CLI
 *   version and session store.
 * - Environment: the SDK's `env` option REPLACES the child environment, so it
 *   is built from `process.env`, tagged with the client app and the session
 *   state events this backend reads, and scrubbed of the variables a parent
 *   Claude Code terminal exports (dsh-tui may itself run inside one; the
 *   child must not believe it is a nested entrypoint or join that session).
 * - stderr: never inherited (it would tear the alternate screen); every line
 *   goes to the debug log and to the host's deduplicated notice reporter.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { installedTuiVersion } from '../../update.js'

/** Where the executable came from (`/doctor`). */
export type ClaudeExecutableSource = 'env' | 'path' | 'bundled'

export interface ClaudeExecutable {
  /** Absolute path, or undefined to let the SDK use its bundled binary. */
  readonly path: string | undefined
  readonly source: ClaudeExecutableSource
}

/** Variables a parent Claude Code session exports that must not leak. */
const SCRUBBED_EXACT = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'] as const
const SCRUBBED_PREFIX = 'CLAUDE_CODE_MESSAGING_'

/** Look `name` up on PATH with the platform's own tool; undefined if absent. */
function which(name: string): Promise<string | undefined> {
  const tool = process.platform === 'win32' ? 'where' : 'which'
  return new Promise(resolve => {
    try {
      execFile(tool, [name], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return }
        const first = String(stdout).split(/\r?\n/u).map(line => line.trim()).find(line => line !== '')
        resolve(first === undefined || !existsSync(first) ? undefined : first)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/** Resolve the executable (never throws; the SDK binary is the fallback). */
export async function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeExecutable> {
  const configured = env.CLAUDE_CODE_EXECUTABLE
  if (configured !== undefined && configured !== '' && existsSync(configured)) return { path: configured, source: 'env' }
  const onPath = await which('claude')
  if (onPath !== undefined) return { path: onPath, source: 'path' }
  return { path: undefined, source: 'bundled' }
}

/** The child environment (design §4.3 `env` row). */
export function buildClaudeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if ((SCRUBBED_EXACT as readonly string[]).includes(key) || key.startsWith(SCRUBBED_PREFIX)) continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `dsh-tui/${installedTuiVersion() ?? 'dev'}`
  // `system/session_state_changed` is the authoritative idle signal; the CLI
  // only emits it when asked (Phase 0 probe P3-1).
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
  return env
}

/** Run `<executable> --version` and pull out the version (best-effort). */
export function readClaudeVersion(executable: string): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(executable, ['--version'], { timeout: 10000, windowsHide: true, env: buildClaudeEnv() }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return }
        resolve(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/u.exec(String(stdout))?.[0])
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * The SDK `stderr` callback: chunks are split into lines; each non-empty line
 * goes to `line` (the host's debug log + deduplicating notice reporter).
 */
export function createStderrSink(line: (text: string) => void): (data: string) => void {
  let partial = ''
  return data => {
    const lines = (partial + data).split(/\r?\n/u)
    partial = lines.pop() ?? ''
    for (const text of lines) if (text.trim() !== '') line(text)
  }
}
