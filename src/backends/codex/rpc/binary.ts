/**
 * The `codex` executable and the environment its app-server runs in
 * (docs/codex-backend-design.md §5.1, §5.4).
 *
 * - Executable: `CODEX_EXECUTABLE` (taken as given, so a typo fails loudly)
 *   → the first `codex` on PATH whose `--version` answers → not installed.
 *   On Windows the npm shims (`codex.cmd`) run through `cmd.exe`.
 * - Environment: `process.env` minus what a parent Codex session exports
 *   to its shells (C0 V2: dsh-tui may itself run inside one, and the child
 *   must not believe it is that thread's tool process) and minus the npm
 *   launcher's own markers (the binary we spawn sets its own). The user's
 *   own Codex settings (`CODEX_HOME`, `CODEX_API_KEY`, `CODEX_SQLITE_HOME`,
 *   certificates, `OPENAI_*`) pass through untouched.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseCodexVersion } from '../contract.js'

/** Where the executable came from (`/doctor`). */
export type CodexExecutableSource = 'env' | 'path'

export interface CodexExecutable {
  readonly path: string
  readonly source: CodexExecutableSource
}

/** Variables a parent Codex thread exports to its tool processes (V2). */
const SCRUBBED_EXACT: readonly string[] = [
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_VERSION',
  'CODEX_CI',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_MANAGED_PACKAGE_ROOT',
]
const SCRUBBED_PREFIXES: readonly string[] = ['CODEX_MANAGED_BY_', 'CODEX_NETWORK_PROXY_']

/** Whether a variable is one the child must not inherit. */
export function scrubbedCodexVariable(name: string): boolean {
  const upper = name.toUpperCase()
  return SCRUBBED_EXACT.includes(upper) || SCRUBBED_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/** The app-server child environment. */
export function buildCodexEnv(base: NodeJS.ProcessEnv = process.env, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || scrubbedCodexVariable(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/** Run `<executable> --version` (bounded); the parsed version or undefined. */
export function readCodexVersion(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const shim = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable)
  return new Promise(resolve => {
    try {
      execFile(shim ? (process.env.ComSpec ?? 'cmd.exe') : executable, shim ? ['/d', '/s', '/c', `"${executable}" --version`] : ['--version'], {
        timeout: 10_000,
        windowsHide: true,
        env: buildCodexEnv(env),
      }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return }
        resolve(parseCodexVersion(String(stdout)))
      })
    } catch {
      resolve(undefined)
    }
  })
}

/** Every existing `codex` on PATH, in the platform tool's order. */
function whichAll(name: string): Promise<string[]> {
  const win = process.platform === 'win32'
  return new Promise(resolve => {
    try {
      execFile(win ? 'where' : 'which', win ? [name] : ['-a', name], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error !== null && String(stdout).trim() === '') { resolve([]); return }
        resolve(String(stdout).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && existsSync(line)))
      })
    } catch {
      resolve([])
    }
  })
}

/** Resolve the executable and its version; undefined when none is usable. */
export async function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): Promise<(CodexExecutable & { readonly version: string | undefined }) | undefined> {
  const configured = env.CODEX_EXECUTABLE
  if (configured !== undefined && configured !== '') {
    return { path: configured, source: 'env', version: await readCodexVersion(configured, env) }
  }
  // A candidate that cannot report its version cannot be spawned either
  // (a dead npm shim, an extensionless script on Windows).
  const candidates = await whichAll('codex')
  const ordered = process.platform === 'win32'
    ? [...candidates.filter(path => /\.(?:exe|cmd)$/iu.test(path)), ...candidates.filter(path => !/\.(?:exe|cmd)$/iu.test(path))]
    : candidates
  for (const candidate of ordered) {
    const version = await readCodexVersion(candidate, env)
    if (version !== undefined) return { path: candidate, source: 'path', version }
  }
  return undefined
}
