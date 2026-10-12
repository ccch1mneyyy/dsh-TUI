/**
 * The `codex` executable and the environment its app-server runs in
 * (docs/codex-backend-design.md §5.1, §5.4).
 *
 * - Executable: `CODEX_EXECUTABLE` (taken as given, so a typo fails loudly)
 *   → the first `codex` on PATH whose `--version` answers → not installed.
 *   On Windows npm shims resolve to the native codex.exe so cmd.exe never
 *   reparses app-server arguments.
 * - Environment: `process.env` minus what a parent Codex session exports
 *   to its shells (C0 V2: dsh-tui may itself run inside one, and the child
 *   must not believe it is that thread's tool process) and minus the npm
 *   launcher's own markers (the binary we spawn sets its own). The user's
 *   own Codex settings (`CODEX_HOME`, `CODEX_API_KEY`, `CODEX_SQLITE_HOME`,
 *   certificates, `OPENAI_*`) pass through untouched.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
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

/** The npm launcher's platform packages and target triples (its
 *  `bin/codex.js` maps the same way). */
const NPM_TARGETS: Readonly<Record<string, { readonly triple: string; readonly pkg: string }>> = {
  'linux-x64': { triple: 'x86_64-unknown-linux-musl', pkg: 'codex-linux-x64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-musl', pkg: 'codex-linux-arm64' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', pkg: 'codex-darwin-x64' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', pkg: 'codex-darwin-arm64' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', pkg: 'codex-win32-x64' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', pkg: 'codex-win32-arm64' },
}

/**
 * The native binary behind an npm `codex` shim (`codex.cmd`, `codex.ps1`,
 * the extensionless script), or undefined. A shim runs `node …/@openai/codex/
 * bin/codex.js`, which locates `vendor/<triple>/bin/codex[.exe]` (older
 * packages use `codex/` instead of `bin/`) of the
 * platform package and spawns it; spawning that binary directly avoids
 * `cmd.exe` re-parsing the `-c key="value"` arguments. Pure over its I/O
 * seams (unit-tested with a fake tree).
 */
export function resolveNpmShim(shim: string, io: {
  readonly platform: string
  readonly arch: string
  readonly exists: (path: string) => boolean
  readonly read: (path: string) => string | undefined
}): string | undefined {
  const target = NPM_TARGETS[`${io.platform}-${io.arch}`]
  if (target === undefined) return undefined
  const text = io.read(shim)
  if (text === undefined || !/@openai[\\/]codex[\\/]bin[\\/]codex\.js/iu.test(text)) return undefined
  const paths = io.platform === 'win32' ? win32 : posix
  const shimDir = paths.dirname(shim)
  const match = /["']([^"'\r\n]*@openai[\\/]codex[\\/]bin[\\/]codex\.js)["']|(\S*@openai[\\/]codex[\\/]bin[\\/]codex\.js)/iu.exec(text)
  const launcher = (match?.[1] ?? match?.[2])?.replace(/%~?dp0%?|\$\{?basedir\}?|\$PSScriptRoot/giu, shimDir)
  const roots = [
    ...(launcher === undefined ? [] : [paths.dirname(paths.dirname(paths.resolve(shimDir, launcher)))]),
    paths.join(shimDir, 'node_modules', '@openai', 'codex'),
  ]
  const binary = io.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const root of roots) {
    const scope = paths.dirname(root)
    for (const vendor of [paths.join(root, 'node_modules', '@openai', target.pkg, 'vendor'), paths.join(scope, target.pkg, 'vendor'), paths.join(root, 'vendor')]) {
      for (const subdir of ['bin', 'codex']) {
        const candidate = paths.join(vendor, target.triple, subdir, binary)
        if (io.exists(candidate)) return candidate
      }
    }
  }
  return undefined
}

/** The binary to spawn for a resolved path: an npm shim's native binary
 *  when one is found, else the path itself. */
export function spawnablePath(path: string): string {
  if (process.platform !== 'win32' && !/\.(?:cmd|bat|ps1)$/iu.test(path)) return path
  const native = resolveNpmShim(path, {
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
    read: file => { try { return readFileSync(file, 'utf8').slice(0, 64 * 1024) } catch { return undefined } },
  })
  return native ?? path
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
    const path = spawnablePath(configured)
    return { path, source: 'env', version: await readCodexVersion(path, env) }
  }
  // A candidate that cannot report its version cannot be spawned either
  // (a dead npm shim, an extensionless script on Windows).
  const candidates = await whichAll('codex')
  const ordered = process.platform === 'win32'
    ? [...candidates.filter(path => /\.(?:exe|cmd)$/iu.test(path)), ...candidates.filter(path => !/\.(?:exe|cmd)$/iu.test(path))]
    : candidates
  for (const listed of ordered) {
    const candidate = spawnablePath(listed)
    const version = await readCodexVersion(candidate, env)
    if (version !== undefined) return { path: candidate, source: 'path', version }
  }
  return undefined
}
