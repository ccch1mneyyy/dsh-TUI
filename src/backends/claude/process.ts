/**
 * The `claude` child process as this backend starts it (design §4.2, §4.3):
 * which executable, with which environment, and where its stderr goes.
 *
 * - Executable: `CLAUDE_CODE_EXECUTABLE` → the first `claude` on PATH that
 *   actually launches → the SDK's own bundled binary (left to the SDK by
 *   passing no path). A PATH binary wins over the bundled one so the session
 *   shares the user's interactive CLI version and session store, but merely
 *   existing is not enough to win: an npm install also ships shims this
 *   process cannot spawn (on Windows the extensionless POSIX `sh` script
 *   `where` reports first, and a `.cmd` Node refuses to run without a
 *   shell), and handing one to the SDK fails the whole start with its own
 *   misleading "native binary … failed to launch" error.
 * - Environment: the SDK's `env` option REPLACES the child environment, so it
 *   is built from `process.env`, tagged with the client app and the session
 *   state events this backend reads, and scrubbed of the variables a parent
 *   Claude Code terminal exports (dsh-tui may itself run inside one; the
 *   child must not believe it is a nested entrypoint or join that session).
 * - stderr: never inherited (it would tear the alternate screen); every line
 *   goes to the debug log and to the host's deduplicated notice reporter.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, sep } from 'node:path'
import { installedTuiVersion } from '../../update.js'

/** Where the executable came from (`/doctor`). */
export type ClaudeExecutableSource = 'env' | 'path' | 'bundled'

export interface ClaudeExecutable {
  /** Absolute path, or undefined to let the SDK use its bundled binary. */
  readonly path: string | undefined
  readonly source: ClaudeExecutableSource
}

/**
 * Variables a parent Claude Code session exports that must not leak. The CLI
 * reads several of them at start: `CLAUDE_CODE_CHILD_SESSION` and
 * `CLAUDE_CODE_SESSION_ATTENDED` would make our child run as the parent's
 * child session; the pid, exec path, effort, invoked skills, agent marker
 * and trace parent would attribute it to the parent's process and trace.
 */
const SCRUBBED_EXACT = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'AI_AGENT',
  'TRACEPARENT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'CLAUDE_CODE_INVOKED_SKILLS',
] as const
const SCRUBBED_PREFIX = 'CLAUDE_CODE_MESSAGING_'

/** Every existing `name` on PATH, in the platform tool's own order. */
function whichAll(name: string): Promise<string[]> {
  const win = process.platform === 'win32'
  const tool = win ? 'where' : 'which'
  const args = win ? [name] : ['-a', name]
  return new Promise(resolve => {
    try {
      execFile(tool, args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
        // `where` exits non-zero when nothing matches; `which -a` may too.
        if (error !== null && String(stdout).trim() === '') { resolve([]); return }
        resolve(String(stdout).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && existsSync(line)))
      })
    } catch {
      resolve([])
    }
  })
}

/**
 * The real binary an unspawnable PATH shim forwards to, if it names one.
 *
 * npm publishes a package's bin as wrappers around the truth: an
 * extensionless POSIX `sh` script, a `.cmd` and a `.ps1`. On Windows the
 * first two are what `where` reports and neither can be handed to
 * CreateProcess — but each ends in the absolute path of the real
 * executable, which is exactly what an interactive `claude` runs, so
 * following it keeps the user's own CLI instead of silently switching to
 * the SDK's bundled copy. The shim is read bounded, `%~dp0` and
 * `$basedir` are expanded, and every candidate still has to launch to win.
 */
function shimTarget(shim: string): string | undefined {
  let text: string
  try {
    text = readFileSync(shim, 'latin1').slice(0, 64 * 1024)
  } catch {
    return undefined
  }
  const dir = dirname(shim)
  const expanded = text
    .replace(/%~dp0%?/giu, dir + sep)
    .replace(/\$\{?basedir\}?/gu, dir)
  for (const match of expanded.match(/"[^"\r\n]*?\.exe"|'[^'\r\n]*?\.exe'|[^\s"']*?\.exe/giu) ?? []) {
    const candidate = match.replace(/^["']|["']$/gu, '').trim()
    if (isAbsolute(candidate) && existsSync(candidate)) return normalize(candidate)
  }
  return undefined
}

/** Resolve the executable (never throws; the SDK binary is the fallback). */
export async function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeExecutable> {
  const configured = env.CLAUDE_CODE_EXECUTABLE
  if (configured !== undefined && configured !== '' && existsSync(configured)) return { path: configured, source: 'env' }
  // A candidate that cannot report its version cannot be spawned either (a
  // hung one is cut off by the probe's timeout), so a dead shim never
  // shadows a working copy further down PATH — or the bundled binary. An
  // explicit `CLAUDE_CODE_EXECUTABLE` above stays unvalidated on purpose:
  // a typo the user made should fail loudly, not silently.
  for (const candidate of await whichAll('claude')) {
    if (await readClaudeVersion(candidate) !== undefined) return { path: candidate, source: 'path' }
    const target = shimTarget(candidate)
    if (target !== undefined && await readClaudeVersion(target) !== undefined) return { path: target, source: 'path' }
  }
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
