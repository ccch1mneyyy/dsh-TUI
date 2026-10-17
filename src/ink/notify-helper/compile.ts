/**
 * Compile-and-cache for the toast jump-back handler (DESIGN D5/D9).
 *
 * A clicked toast hands control to a protocol handler, and there is no
 * build-time Windows SDK here to ship one: the in-box csc.exe builds
 * `activate.cs` into `<DATA_DIR>/notify/activate.exe` the first time a
 * jump-back is possible, and every later call reuses that product. The source
 * is resolved next to this module, so the two files must travel together: tsc
 * emits this module into `lib/types/ink/notify-helper/`, and
 * `scripts/copy-notify-helper.mjs` drops `activate.cs` beside it, because the
 * packaged tree does not include `src/`.
 *
 * The cache decision is deliberately boring, because the product lives in a
 * user directory that antivirus and manual cleanup also write to:
 *   - the packaged source is copied to `<DATA_DIR>/notify/activate.cs` only
 *     when its bytes changed, and the copy's timestamp is what the exe is
 *     compared against, so a dsh-tui upgrade recompiles even though the
 *     packaged file the npm tarball delivered carries its own mtime;
 *   - an exe at least as new as that copy is reused as is;
 *   - anything else (missing, older, deleted between runs) compiles again.
 *
 * Nothing here throws: a helper that cannot be produced degrades the
 * jump-back only (the toast still shows), and R3 wants the cause in the log
 * rather than in an exception the caller has to guess at.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logForDebugging } from '../../utils/debug.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../../utils/execFileNoThrow.js'
import { DATA_DIR } from '../../utils/paths.js'

/** The C# source this module compiles. */
const SOURCE_FILE_NAME = 'activate.cs'

/** The in-box .NET Framework 4.x directory under `%WINDIR%` (compile measured 303-658 ms). */
const FRAMEWORK_SEGMENTS = ['Microsoft.NET', 'Framework64', 'v4.0.30319']

/**
 * UIA assemblies, taken from the framework's own WPF directory. csc does not
 * resolve them by simple name from the GAC - a first real compile answered
 * "error CS0006: metadata file 'UIAutomationClient.dll' could not be found" -
 * so they are referenced by full path. The CLR still loads them from the GAC
 * at run time.
 */
const UIA_ASSEMBLIES = ['UIAutomationClient.dll', 'UIAutomationTypes.dll']

/** Generous ceiling: a cold compile measured under a second. */
const COMPILE_TIMEOUT_MS = 30_000

/** Where the helper's files live: `<DATA_DIR>/notify/` (D9). */
export interface HelperPaths {
  dir: string
  sourceCopyPath: string
  exePath: string
}

/** The in-box toolchain: the compiler plus the UIA assemblies it must be given. */
export interface NotifyCompiler {
  cscPath: string
  references: string[]
}

/** Why the helper could not be produced; the caller logs it, nothing throws. */
export type ActivateHelperFailure =
  | 'not-win32'
  | 'source-missing'
  | 'source-unreadable'
  | 'cache-unusable'
  | 'csc-missing'
  | 'compile-failed'
  | 'unexpected'

export type ActivateHelperResult =
  | { ok: true, exePath: string, sourcePath: string, reused: boolean }
  | { ok: false, reason: ActivateHelperFailure, detail?: string }

/** The process runner, narrowed to what {@link ensureActivateHelper} needs. */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: ExecFileNoThrowOptions,
) => Promise<ExecFileNoThrowResult>

/** Every port is injectable so the regression never spawns csc or touches `~/.dsh-tui`. */
export interface EnsureActivateHelperOptions {
  dataDir?: string
  sourcePath?: string
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  run?: RunCommand
  log?: (message: string, fields?: Record<string, unknown>) => void
}

/**
 * Where the helper's files live: `<DATA_DIR>/notify/` (D9). The single
 * construction site for these paths - the transport registers the very
 * `exePath` this returns as the URI protocol handler.
 * @param dataDir TUI data directory, defaults to `~/.dsh-tui`.
 */
export function helperPaths(dataDir: string = DATA_DIR): HelperPaths {
  const dir = join(dataDir, 'notify')
  return {
    dir,
    sourceCopyPath: join(dir, SOURCE_FILE_NAME),
    exePath: join(dir, 'activate.exe'),
  }
}

/**
 * The in-box toolchain: the compiler plus the UIA assemblies it must be given,
 * or null when there is no `%WINDIR%` to find them under.
 * @param env Environment to read.
 */
export function compilerFor(env: Record<string, string | undefined> = process.env): NotifyCompiler | null {
  const windir = env.windir
  if (windir === undefined || windir === '') return null
  const frameworkDir = join(windir, ...FRAMEWORK_SEGMENTS)
  return {
    cscPath: join(frameworkDir, 'csc.exe'),
    references: UIA_ASSEMBLIES.map(name => join(frameworkDir, 'WPF', name)),
  }
}

/**
 * Make sure `<DATA_DIR>/notify/activate.exe` matches the packaged `activate.cs`.
 *
 * @param options Cache root, source override, platform, environment, runner, log.
 * @returns `reused` tells the caller whether this call compiled; a failure
 *   never rejects.
 */
export async function ensureActivateHelper(options: EnsureActivateHelperOptions = {}): Promise<ActivateHelperResult> {
  const platform = options.platform ?? process.platform
  // D12: non-win32 never compiles anything - callers guard as well, and this
  // keeps a mistaken import from spawning a compiler or touching the cache.
  if (platform !== 'win32') return { ok: false, reason: 'not-win32' }

  const run = options.run ?? execFileNoThrow
  const log = options.log ?? logForDebugging
  const paths = helperPaths(options.dataDir ?? DATA_DIR)
  const sourcePath = options.sourcePath ?? fileURLToPath(new URL(`./${SOURCE_FILE_NAME}`, import.meta.url))
  const fail = (reason: ActivateHelperFailure, detail?: string): ActivateHelperResult => {
    log('notify helper unavailable', detail === undefined ? { reason } : { reason, detail })
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
  }

  let source
  try {
    source = await readFile(sourcePath)
  } catch (error) {
    return fail(errnoCode(error) === 'ENOENT' ? 'source-missing' : 'source-unreadable', describe(error))
  }

  let copyTime
  try {
    const cached = await readFile(paths.sourceCopyPath).catch(() => null)
    // Rewriting the copy is also what invalidates a product built from an
    // older package: its timestamp lands after the exe's.
    if (cached === null || !cached.equals(source)) {
      await mkdir(paths.dir, { recursive: true })
      await writeFile(paths.sourceCopyPath, source)
    }
    copyTime = (await stat(paths.sourceCopyPath)).mtimeMs
  } catch (error) {
    return fail('cache-unusable', describe(error))
  }

  const exeTime = await mtimeMsOrNull(paths.exePath)
  if (exeTime !== null && exeTime >= copyTime) {
    return { ok: true, exePath: paths.exePath, sourcePath: paths.sourceCopyPath, reused: true }
  }

  const compiler = compilerFor(options.env ?? process.env)
  if (compiler === null) return fail('csc-missing', '%WINDIR% is not set, so the in-box compiler cannot be located')
  const args = [
    '/nologo',
    // A GUI subsystem product, not a console one: a console-subsystem
    // activate.exe made every click on a toast flash a console window for about
    // half a second (UAT 2026-10-16, product measured PE Subsystem 3, and the
    // helper's own log listed activate.exe among the visible windows).
    // `winexe` means no console is ever allocated - which also means the C#
    // side's diagnostics can only reach a file, and activate.cs writes them to
    // activate.log for exactly that reason.
    '/target:winexe',
    `/out:${paths.exePath}`,
    ...compiler.references.map(reference => `/reference:${reference}`),
    paths.sourceCopyPath,
  ]
  try {
    const result = await run(compiler.cscPath, args, { timeout: COMPILE_TIMEOUT_MS })
    if (result.code !== 0) {
      // csc reports its errors on stdout; stderr carries the spooler's own
      // failures (a blocked or missing compiler, for instance).
      const cause = firstLine(result.stdout) || firstLine(result.stderr) || `csc exited with code ${result.code}`
      return fail('compile-failed', cause)
    }
    if ((await mtimeMsOrNull(paths.exePath)) === null) {
      return fail('compile-failed', 'csc reported success but wrote no activate.exe')
    }
  } catch (error) {
    return fail('unexpected', describe(error))
  }
  return { ok: true, exePath: paths.exePath, sourcePath: paths.sourceCopyPath, reused: false }
}

async function mtimeMsOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

function firstLine(text: unknown): string {
  const line = typeof text === 'string' ? text.trim().split(/\r?\n/u)[0] : ''
  return line ?? ''
}

/**
 * The errno behind a rejected filesystem call, when it carries one. Any thrown
 * value with a string `code` counts, not just `Error` instances: the caller
 * only needs to tell "no such file" apart from every other read failure.
 */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
