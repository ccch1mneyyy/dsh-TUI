/**
 * The jump-back helper's one build step (D5): compile `activate.cs`
 * with the in-box .NET Framework `csc.exe` on first use, then reuse the
 * executable until either the source or the compiler moves.
 *
 * The package ships the C# source, not a binary (D5), so this module turns it
 * into `<DATA_DIR>/notify/helper/activate.exe` on the machine that needs it.
 * The cache key is the source's content hash plus the resolved compiler path,
 * recorded next to the executable in `activate.exe.hash`: an unchanged pair
 * reuses the executable without spawning anything, and a package update or a
 * different framework directory invalidates it.
 *
 * Every failure - a non-Windows host, a missing csc, an unreadable source, a
 * non-zero exit or the {@link COMPILE_TIMEOUT_MS} ceiling - answers undefined
 * and leaves the reason in the debug log. Jump-back is the only capability
 * that needs the helper, so the caller degrades to a plain toast while the
 * notification itself is unaffected. Nothing here writes the registry;
 * that is the lazy protocol step in `jumpback.ts` (D7).
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContent } from '../../terminal-utils/hash.js'
import { logForDebugging } from '../../utils/debug.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { DATA_DIR } from '../../utils/paths.js'

/**
 * The helper source beside this module. tsc keeps the directory layout, and
 * the build's copy step puts `activate.cs` next to the emitted JavaScript in
 * `lib/types/ink/notify-helper/`, so the same URL resolves in both trees.
 */
const HELPER_SOURCE = fileURLToPath(new URL('./activate.cs', import.meta.url))

const HELPER_DIR = join(DATA_DIR, 'notify', 'helper')
const HELPER_EXE = join(HELPER_DIR, 'activate.exe')
/** Remembers the (source hash, csc path) pair the executable was built from. */
const HELPER_HASH = `${HELPER_EXE}.hash`

/** csc takes ~0.3 s on a warm machine; ten seconds means stuck, not slow. */
const COMPILE_TIMEOUT_MS = 10_000

/**
 * A failed build is retried after this pause instead of on every completion:
 * an antivirus block or a broken framework does not heal within seconds, and
 * each retry would delay the next toast by up to the compile timeout.
 */
const FAILURE_COOLDOWN_MS = 5 * 60_000

/** A failed (source hash, compiler) pair and when it failed. */
let lastFailure: { key: string; at: number } | undefined

/** The in-box framework layouts, 64-bit first; both ship the same csc. */
const FRAMEWORK_DIRS = ['Framework64', 'Framework'] as const
const FRAMEWORK_VERSION = 'v4.0.30319'

/**
 * The assemblies the helper references. Both sit in the `WPF/` subdirectory of
 * the framework directory csc itself was found in, and neither needs
 * `System.Core` (verified when the source was written).
 */
const UI_AUTOMATION_ASSEMBLIES = ['UIAutomationClient.dll', 'UIAutomationTypes.dll'] as const

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The in-box compiler, or undefined when neither framework directory has one.
 * `WINDIR` is what Windows itself uses; `SystemRoot` is the same directory's
 * other spelling and covers stripped-down environments.
 * @returns the absolute csc path.
 */
function inBoxCsc(): string | undefined {
  const windowsRoot = process.env.WINDIR ?? process.env.SystemRoot
  if (windowsRoot === undefined || windowsRoot === '') return undefined
  return FRAMEWORK_DIRS
    .map(arch => join(windowsRoot, 'Microsoft.NET', arch, FRAMEWORK_VERSION, 'csc.exe'))
    .find(candidate => existsSync(candidate))
}

/**
 * `/target:winexe` keeps a console from flashing when Windows starts the helper
 * from a toast click (D5); the source must stay at C# 5 because this csc is the
 * .NET Framework 4.x in-box one.
 * @returns the argv to run.
 */
function cscArgs(csc: string, out: string): string[] {
  const references = UI_AUTOMATION_ASSEMBLIES.map(
    assembly => `/r:${join(dirname(csc), 'WPF', assembly)}`,
  )
  return ['/nologo', '/warn:4', '/target:winexe', `/out:${out}`, ...references, HELPER_SOURCE]
}

/**
 * A path no other csc run can share: the compiler writes here, and only a
 * completed build is moved onto the documented executable.
 */
function temporaryName(target: string, extension: string): string {
  return `${target}.${process.pid}-${randomBytes(4).toString('hex')}.${extension}`
}

/**
 * Move a finished artifact onto its documented path. A rename is atomic on the
 * same volume, so a reader never sees a half-written executable or hash.
 */
function replaceFile(temporary: string, target: string): void {
  renameSync(temporary, target)
}

/**
 * The csc path is in the key so a machine that acquires or switches framework
 * directories rebuilds rather than running an executable from another layout.
 * @returns the string stored in {@link HELPER_HASH}.
 */
function cacheKey(source: string, csc: string): string {
  return `${hashContent(source)}\n${csc}\n`
}

/**
 * @returns true when the executable and its matching key both exist.
 */
function cacheHit(key: string): boolean {
  if (!existsSync(HELPER_EXE)) return false
  try {
    return readFileSync(HELPER_HASH, 'utf8') === key
  } catch {
    return false
  }
}

async function compileIfNeeded(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    logForDebugging('notify helper: the in-box csc only exists on Windows', { platform: process.platform })
    return undefined
  }

  let source: string
  try {
    source = readFileSync(HELPER_SOURCE, 'utf8')
  } catch (error) {
    logForDebugging('notify helper: source unreadable', { source: HELPER_SOURCE, detail: detailOf(error) })
    return undefined
  }

  const csc = inBoxCsc()
  if (csc === undefined) {
    logForDebugging('notify helper: in-box csc not found', {
      windowsRoot: process.env.WINDIR ?? process.env.SystemRoot ?? '',
    })
    return undefined
  }

  const key = cacheKey(source, csc)
  if (cacheHit(key)) return HELPER_EXE
  if (lastFailure !== undefined && lastFailure.key === key
    && Date.now() - lastFailure.at < FAILURE_COOLDOWN_MS) {
    logForDebugging('notify helper: a recent build failure is still cooling down', { csc })
    return undefined
  }

  try {
    mkdirSync(HELPER_DIR, { recursive: true })
  } catch (error) {
    logForDebugging('notify helper: cache directory unusable', { dir: HELPER_DIR, detail: detailOf(error) })
    return undefined
  }

  const temporaryExe = temporaryName(HELPER_EXE, 'tmp.exe')
  const temporaryHash = temporaryName(HELPER_HASH, 'tmp')
  const result = await execFileNoThrow(csc, cscArgs(csc, temporaryExe), { timeout: COMPILE_TIMEOUT_MS })
  if (result.code !== 0) {
    // Only this run's temporary file is removed. A shared executable another
    // instance already finished must survive a failed retry here.
    try {
      rmSync(temporaryExe, { force: true })
    } catch {
      // Best effort: the next successful build leaves the same temp layout.
    }
    lastFailure = { key, at: Date.now() }
    const detail = result.code === null
      ? `timed out after ${COMPILE_TIMEOUT_MS} ms or was killed`
      : (result.stderr.trim() || result.stdout.trim()).slice(0, 500)
    logForDebugging('notify helper: csc failed', { csc, code: result.code, detail })
    return undefined
  }

  try {
    replaceFile(temporaryExe, HELPER_EXE)
  } catch (error) {
    try {
      rmSync(temporaryExe, { force: true })
    } catch {
      // The temp file is diagnostic litter at worst.
    }
    lastFailure = { key, at: Date.now() }
    logForDebugging('notify helper: compiled but the executable could not be installed', {
      exe: HELPER_EXE,
      detail: detailOf(error),
    })
    return undefined
  }

  try {
    writeFileSync(temporaryHash, key, 'utf8')
    replaceFile(temporaryHash, HELPER_HASH)
  } catch (error) {
    try {
      rmSync(temporaryHash, { force: true })
    } catch {
      // Best effort.
    }
    // The executable is usable; only the next call has to compile it again.
    logForDebugging('notify helper: compiled but the cache key was not written', {
      hash: HELPER_HASH,
      detail: detailOf(error),
    })
  }
  lastFailure = undefined
  logForDebugging('notify helper: compiled', { exe: HELPER_EXE, csc })
  return HELPER_EXE
}

/** The one compilation this process may be running; it coalesces callers. */
let inFlight: Promise<string | undefined> | undefined

/**
 * The compiled helper's path, compiling it first when the cache is cold.
 *
 * Concurrent callers in this process share one compilation, so a burst of
 * notifications cannot start two csc processes writing the same executable.
 * A failed run is not remembered: the next notification retries, which is the
 * recovery path after an antivirus block or a deleted cache.
 * @returns the executable path, or undefined when this machine cannot build it.
 */
export function ensureHelper(): Promise<string | undefined> {
  if (inFlight !== undefined) return inFlight
  const started = compileIfNeeded()
    .catch((error: unknown) => {
      logForDebugging('notify helper: compilation threw', { detail: detailOf(error) })
      return undefined
    })
    .finally(() => {
      inFlight = undefined
    })
  inFlight = started
  return started
}
