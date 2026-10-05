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
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import stripAnsi from 'strip-ansi'
import type { SdkInstallResult, SdkInstallTarget, SdkInstaller } from '../../agent/backend.js'
import { isStandaloneRuntime, profileWorkspaceYamlPath, resolveDshProfileName } from '../../update.js'
import { shellQuote } from '../../utils/shellQuote.js'
import { VALIDATED_SDK_VERSION } from './contract.js'

/** What `pnpm add` installs, at the validated pin (see contract.ts). */
export const CLAUDE_SDK_SPECIFIER = `@anthropic-ai/claude-agent-sdk@${VALIDATED_SDK_VERSION}`

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

/** Install the pinned SDK into the profile root. Resolve target failures are
 *  the caller's business (the wizard shows manual instructions for them). */
export function startClaudeSdkInstall(dir: string): SdkInstaller {
  let cancelled = false
  const { promise, cancel } = runPnpm(['add', CLAUDE_SDK_SPECIFIER], dir)
  const result = promise.then<SdkInstallResult>(run => {
    if (cancelled) return { kind: 'cancelled' }
    if (run.code === 0) return { kind: 'ok' }
    if (run.spawnError === 'ENOENT') return { kind: 'pnpm-missing' }
    return { kind: 'failed', exitCode: run.code ?? 1, tail: run.lines.slice(-10) }
  })
  return { result, cancel: () => { cancelled = true; cancel() } }
}
