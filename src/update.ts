import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gt, valid } from 'semver'
import { shellQuote } from './utils/shellQuote.js'

// Re-exported for scripts/verify-update.mjs and the bin launcher, which reads
// the compiled copy at lib/types/utils/shellQuote.js.
export { shellQuote }

const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_CHECK_TIMEOUT_MS = 4000
/** env marker set on the /update restart; the new process verifies it at boot. */
const UPDATED_FROM_ENV = 'DSH_TUI_UPDATED_FROM'

export interface TuiUpdateInfo {
  current: string
  latest: string
}

/** What a fresh registry lookup says about this install. */
export type TuiUpdateTarget =
  | { kind: 'update'; current: string; latest: string }
  | { kind: 'latest'; current: string }
  | { kind: 'unknown' }

export interface TuiUpdateResult {
  /** Exit code of the `dsh plugin update` run (0 = the package was updated). */
  updateCode: number
  /**
   * Exit code of the restarted TUI process. Equals `updateCode` when the
   * failure happened before a restart was attempted.
   */
  restartCode: number
}

/** Read the version from either the compiled package or the source checkout. */
export function installedTuiVersion(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relativePath of ['../../package.json', '../package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(here, relativePath), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const packageJson = parsed as Record<string, unknown>
        const version = packageJson.version
        if (packageJson.name === PACKAGE_NAME && typeof version === 'string' && valid(version) !== null) {
          return version
        }
      }
    } catch {
      // Try the source-layout fallback after the compiled-layout path.
    }
  }
  return undefined
}

/**
 * The profile this TUI was booted with (`dsh --profile <name>`), read from
 * the launcher argv the process inherited. dsh sets no profile env var, and
 * its launcher parses its own flags first, so the first `--profile` token in
 * argv is the launcher's. Undefined for non-profile launches (source
 * checkouts, `--config` overlays) — there is no profile installation for
 * `/update` to act on, so the command must stay disabled there.
 */
export function resolveDshProfileName(argv: readonly string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      const value = argv[i + 1]
      return value !== undefined && value !== '' && !value.startsWith('-') ? value : undefined
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      return value !== '' ? value : undefined
    }
  }
  return undefined
}

/**
 * Resolve the registry base URL the way npm/pnpm would: `NPM_CONFIG_REGISTRY`
 * (both spellings) over the `registry=` line in ~/.npmrc over npmjs.org, so
 * mirror users see the same `latest` their package manager would install.
 */
export function resolveRegistryBase(): string {
  const fromEnv = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.replace(/\/+$/, '')
  try {
    const npmrc = readFileSync(join(homedir(), '.npmrc'), 'utf8')
    const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc)
    if (match !== null) return match[1].replace(/\/+$/, '')
  } catch {
    // No readable user .npmrc — the default registry applies.
  }
  return DEFAULT_REGISTRY
}

/** True when `current` is a strictly newer valid version than `previous`. */
export function isVersionNewer(current: string, previous: string): boolean {
  const a = valid(current)
  const b = valid(previous)
  return a !== null && b !== null && gt(a, b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fetch `latest` from the configured registry; undefined on any failure. */
async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(`${resolveRegistryBase()}/${PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    const latest = isRecord(payload) && typeof payload.version === 'string'
      ? valid(payload.version)
      : null
    return latest ?? undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Classify this install against a fresh registry lookup: an update is
 * available, the install is already latest, or the answer is unknown
 * (offline / registry error / unreadable own version).
 */
export async function resolveTuiUpdateTarget(): Promise<TuiUpdateTarget> {
  const current = installedTuiVersion()
  const currentVersion = current === undefined ? null : valid(current)
  if (currentVersion === null) return { kind: 'unknown' }

  const latest = await fetchLatestVersion()
  if (latest === undefined) return { kind: 'unknown' }
  if (!gt(latest, currentVersion)) return { kind: 'latest', current: currentVersion }
  return { kind: 'update', current: currentVersion, latest }
}

/**
 * Check npm for a newer published TUI version. Network and registry errors
 * are intentionally treated as "no result" so an offline launch never delays
 * or blocks the interactive TUI.
 */
export async function checkForTuiUpdate(): Promise<TuiUpdateInfo | undefined> {
  const target = await resolveTuiUpdateTarget()
  return target.kind === 'update' ? { current: target.current, latest: target.latest } : undefined
}

interface ProcessOptions {  env?: NodeJS.ProcessEnv
  /** Needed only for .cmd launchers on Windows (they cannot spawn directly). */
  shell?: boolean
  /**
   * Receives each stderr chunk while output still flows to the terminal, so
   * the caller can classify failures (issue #225's transient-race retry).
   */
  onStderr?: (chunk: string) => void
}

/**
 * Run a child process with its output attached to the user's terminal. The
 * shell is opt-in per call: `dsh.cmd` needs it, but the node restart must
 * never go through cmd.exe — the standard install path
 * `C:\Program Files\nodejs\node.exe` splits on the space and the replacement
 * process never starts, leaving an updated package and a dead TUI.
 */
function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<number> {
  return new Promise(resolve => {
    let settled = false
    const useShell = options.shell === true && process.platform === 'win32'
    // DEP0190 (issue #148): Node ≥22 warns on `shell: true` with a non-empty
    // args array even when every arg is escaped — the check is syntactic.
    // Fold the shell-quoted args into the command string instead (an empty
    // args array does not trigger the warning); future Node majors may turn
    // the deprecation into a hard error.
    const [runCommand, runArgs]: [string, readonly string[]] = useShell
      ? [`${command} ${shellQuote(args).join(' ')}`, []]
      : [command, args]
    const child = spawn(runCommand, runArgs as string[], {
      env: options.env,
      stdio: options.onStderr === undefined ? 'inherit' : ['inherit', 'inherit', 'pipe'],
      shell: useShell,
    })
    if (options.onStderr !== undefined && child.stderr !== null) {
      const onStderr = options.onStderr
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        process.stderr.write(text)
        onStderr(text)
      })
    }
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.once('error', error => {
      process.stderr.write(`dsh-tui: failed to run ${command}: ${error.message}\n`)
      finish(127)
    })
    child.once('close', code => finish(code ?? 1))
  })
}

/** Build the profile-manager command, preferring a preflight-pinned version. */
export function tuiUpdatePluginArgs(profile: string, targetVersion?: string): string[] {
  return targetVersion === undefined
    ? ['plugin', '--profile', profile, 'update', '--latest', PACKAGE_NAME]
    : ['plugin', '--profile', profile, 'update', `${PACKAGE_NAME}@${targetVersion}`]
}

/**
 * The pnpm Windows tmp-rename race signature (issue #225): pnpm swaps a
 * package directory via a `<name>_tmp_<pid>` staging dir, and a file lock or
 * AV scan makes the scandir/rename fail with ENOENT/EPERM/EBUSY. The failure
 * is transient — the identical command succeeds on retry — but the crashed
 * run leaves a half-updated profile (manifest pins the old version while the
 * lockfile already carries the new snapshot), which presents as "update did
 * nothing" (#209). Genuine resolution errors never carry the `_tmp_<pid>`
 * token, so matching both keeps the retry from masking real failures.
 */
export function isTransientUpdateFailure(stderr: string): boolean {
  return /ENOENT|EPERM|EBUSY/i.test(stderr) && /_tmp_\d+/i.test(stderr)
}

/**
 * Update the installed dsh-tui package and restart the same launcher while
 * preserving the active session. The TUI must already be unmounted before
 * this is called so pnpm output cannot corrupt the rendered terminal frame.
 *
 * When the preflight registry check resolved an exact target, pass that
 * version to pnpm instead of resolving `latest` a second time. This avoids a
 * stale mirror/dist-tag response between the check and install. If preflight
 * failed, retain the `--latest` fallback: a plain `pnpm update` stays inside
 * the manifest range and can restart unchanged across minor releases.
 *
 * @param sessionId - Session to resume in the replacement process.
 * @param profile - The dsh profile this TUI was launched with; updating any
 *   other profile would leave the running install untouched.
 * @param targetVersion - Exact version returned by the preflight registry
 *   check, or undefined when that check failed and pnpm should resolve latest.
 * @returns Exit codes for the update run and the replacement process.
 */
export async function updateTuiAndRestart(
  sessionId: string,
  profile: string,
  targetVersion?: string,
): Promise<TuiUpdateResult> {
  const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const updateArgs = tuiUpdatePluginArgs(profile, targetVersion)
  let updateStderr = ''
  const capture = (chunk: string): void => { updateStderr += chunk }
  let updateCode = await runProcess(dsh, updateArgs, { shell: true, onStderr: capture })
  // Transient Windows tmp-rename race (issue #225): retry the identical
  // command once — it succeeds on a clean second run, and only the
  // `_tmp_<pid>` race signature qualifies, never a real resolution error.
  if (updateCode !== 0 && isTransientUpdateFailure(updateStderr)) {
    process.stderr.write('dsh-tui: transient pnpm failure (Windows tmp-rename race) — retrying once…\n')
    updateStderr = ''
    updateCode = await runProcess(dsh, updateArgs, { shell: true, onStderr: capture })
  }
  if (updateCode !== 0) return { updateCode, restartCode: updateCode }

  // Post-update verification (issue #225): pnpm can report success yet leave
  // the profile half-updated (manifest old / lockfile new). Verify against
  // the preflight target; a full `install` reconciles lockfile →
  // node_modules, and if the mismatch survives, stop before restarting into
  // a mixed state and hand the user the exact repair command instead.
  if (targetVersion !== undefined) {
    let installed = installedTuiVersion()
    if (installed !== targetVersion) {
      await runProcess(dsh, ['plugin', '--profile', profile, 'install'], { shell: true })
      installed = installedTuiVersion()
    }
    if (installed !== targetVersion) {
      process.stderr.write(
        `dsh-tui: update completed but the profile still runs ${installed ?? 'an unreadable version'} ` +
          `(expected ${targetVersion}) — the profile is half-updated. Repair manually with:\n` +
          `  dsh plugin --profile ${profile} add ${PACKAGE_NAME}@${targetVersion}\n`,
      )
      return { updateCode: 1, restartCode: 1 }
    }
  }

  const restartCode = await runProcess(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    env: {
      ...process.env,
      // Dual-write the resume contract (issue #120): the cordis layer of a
      // still-old TUI build reads only DSH_CC_RESUME_SESSION.
      DSH_TUI_RESUME_SESSION: sessionId,
      DSH_CC_RESUME_SESSION: sessionId,
      [UPDATED_FROM_ENV]: installedTuiVersion() ?? '',
    },
  })
  return { updateCode, restartCode }
}
