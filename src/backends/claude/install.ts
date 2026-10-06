/**
 * One-shot installer for the optional `@anthropic-ai/claude-agent-sdk` peer.
 *
 * Runs `pnpm add <sdk>@<pin>` in the DSH profile root — the install dir whose
 * `node_modules` the backend's dynamic import resolves through. Everything the
 * child prints is piped and captured, never inherited: an inherit-stdio child
 * may only run after the Ink frame is unmounted (the update.ts contract); a
 * captured one may run under the live TUI, which is what the kernel-picker
 * install wizard needs. Only the tail of the captured output is surfaced, on
 * failure.
 *
 * The pinned SDK version is old enough that pnpm's minimumReleaseAge gate
 * never blocks it; if the pin ever moves to a version published within the
 * gate's window, the install needs a `minimumReleaseAgeExclude` entry
 * (generalize `ensureProfileReleaseAgeExclude` in update.ts then).
 *
 * The store directory is always passed explicitly. Left to itself pnpm
 * resolves the store by probing whether it can hard-link from the project
 * into `$HOME` — that answer flips between environments (a terminal that can
 * link, a sandbox or a workspace mounted beside `$HOME` that cannot), while
 * `node_modules/.modules.yaml` remembers the store the profile was last
 * installed from. The next `pnpm add` then dies on
 * `ERR_PNPM_UNEXPECTED_STORE` before it touches anything, which is what the
 * wizard used to surface as an opaque failure. Resolving the store once —
 * the recorded one when the profile has been installed before — and naming
 * it on the command line pins installs to a single store for good.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'
import type { SdkInstallResult, SdkInstallTarget, SdkInstaller } from '../../agent/backend.js'
import { isStandaloneRuntime, profileWorkspaceYamlPath, resolveDshProfileName } from '../../update.js'
import { shellQuote } from '../../utils/shellQuote.js'
import { VALIDATED_SDK_VERSION } from './contract.js'

/** What `pnpm add` installs, at the validated pin (see contract.ts). */
export const CLAUDE_SDK_SPECIFIER = `@anthropic-ai/claude-agent-sdk@${VALIDATED_SDK_VERSION}`

/** The flag every install names its store with (see {@link resolveSdkStoreDir}). */
export const SDK_STORE_DIR_FLAG = '--store-dir'

/** `pnpm add` for the pinned SDK, store included: the one command the wizard
 *  runs and the one it tells the user to run by hand. */
export function claudeSdkAddArgs(storeDir: string): readonly string[] {
  return ['add', CLAUDE_SDK_SPECIFIER, SDK_STORE_DIR_FLAG, storeDir]
}

/** The store directory a profile's `node_modules` was last linked from.
 *  `.modules.yaml` is pnpm's own record, written on every install; the
 *  newline anchor keeps `storeDir` from matching a longer key, and the quote
 *  is optional because pnpm emits one only when the path needs it. */
function recordedStoreDir(dir: string): string | undefined {
  let text: string
  try {
    text = readFileSync(join(dir, 'node_modules', '.modules.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const recorded = /^storeDir: "?([^"\n]+)"?$/mu.exec(text)
  return recorded?.[1]
}

/**
 * The content-addressable store an install into `dir` must use.
 *
 * A profile that has been installed before keeps the store its `node_modules`
 * was linked from, so an upgrade never trips pnpm's store check; the answer is
 * read from pnpm's own record instead of re-derived, because re-deriving is
 * exactly what flips between environments. A profile without `node_modules`
 * yet gets the DSH-owned store beside it — shared by every profile under the
 * same profiles directory, and inside the workspace, so a sandbox that cannot
 * hard-link into `$HOME` can still write it (`~/.dsh/profiles/.pnpm-store` for
 * the usual layout).
 */
export function resolveSdkStoreDir(dir: string): string {
  const recorded = recordedStoreDir(dir)
  if (recorded !== undefined && recorded !== '') return recorded
  const parent = dirname(dir)
  return parent === dir ? join(dir, '.pnpm-store') : join(parent, '.pnpm-store')
}

export type { SdkInstallTarget, SdkInstallResult, SdkInstaller } from '../../agent/backend.js'

/** Resolve the install target for the CURRENT launch (never throws). The
 *  non-profile kinds carry the reason for the wizard's manual-instructions
 *  panel: standalone builds swap a whole binary (update.ts owns that path),
 *  and source checkouts / `--config` launches have no profile to add into. */
export function resolveSdkInstallTarget(argv: readonly string[] = process.argv): SdkInstallTarget {
  if (isStandaloneRuntime()) return { kind: 'standalone' }
  const profile = resolveDshProfileName(argv)
  return profile === undefined ? { kind: 'no-profile' } : { kind: 'profile', dir: dirname(profileWorkspaceYamlPath(profile)) }
}

interface CapturedRun {
  readonly code: number | undefined
  /** The spawn `error.code` (e.g. 'ENOENT' when pnpm is not on PATH). */
  readonly spawnError?: string
  readonly lines: readonly string[]
}

/** Run pnpm with captured output. On Windows the arguments fold into the
 *  command string and go through the shell — pnpm is a `.cmd` shim there and
 *  Node ≥22 refuses to spawn `.cmd` directly (DEP0190) — the same escape
 *  update.ts's runProcess uses. */
function runPnpm(args: readonly string[], cwd: string): { readonly promise: Promise<CapturedRun>; readonly cancel: () => void } {
  const windows = process.platform === 'win32'
  const [command, spawnArgs]: [string, string[]] = windows
    ? [`pnpm ${shellQuote(args).join(' ')}`, []]
    : ['pnpm', [...args]]
  const child = spawn(command, spawnArgs, {
    cwd,
    shell: windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks: string[] = []
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { chunks.push(chunk) })
  }
  const promise = new Promise<CapturedRun>(resolve => {
    const finish = (code: number | undefined, spawnError?: string): void => {
      // pnpm progress frames redraw with \r — split on all line breaks, strip
      // the ANSI layer, drop the empty frames the redraws leave behind.
      const lines = chunks.join('').split(/\r\n|\r|\n/u).map(line => stripAnsi(line).trim()).filter(line => line !== '')
      resolve({ code, spawnError, lines })
    }
    child.once('error', error => finish(undefined, (error as NodeJS.ErrnoException).code))
    child.once('close', code => finish(code ?? undefined))
  })
  return { promise, cancel: () => { child.kill() } }
}

/** Whether `pnpm` runs at all (the wizard's preflight). */
export async function checkPnpmAvailable(): Promise<boolean> {
  const { promise } = runPnpm(['--version'], homedir())
  const run = await promise
  return run.code === 0 && run.spawnError === undefined
}

/** Install the pinned SDK into the profile root, against the store that
 *  profile already uses (see {@link resolveSdkStoreDir}). Resolve target
 *  failures are the caller's business (the wizard shows manual instructions
 *  for them). */
export function startClaudeSdkInstall(dir: string): SdkInstaller {
  let cancelled = false
  const storeDir = resolveSdkStoreDir(dir)
  const { promise, cancel } = runPnpm(claudeSdkAddArgs(storeDir), dir)
  const result = promise.then<SdkInstallResult>(run => {
    if (cancelled) return { kind: 'cancelled' }
    if (run.code === 0) return { kind: 'ok' }
    if (run.spawnError === 'ENOENT') return { kind: 'pnpm-missing' }
    if (run.lines.some(line => line.includes('UNEXPECTED_STORE') || line.includes('Unexpected store location')))
      return { kind: 'store-mismatch', storeDir }
    return { kind: 'failed', exitCode: run.code ?? 1, tail: run.lines.slice(-10) }
  })
  return { result, cancel: () => { cancelled = true; cancel() }, storeDir }
}
