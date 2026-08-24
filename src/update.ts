import { spawn } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gte, gt, lt, valid } from 'semver'
import { shellQuote } from './utils/shellQuote.js'
import { DATA_DIR } from './utils/paths.js'

// Re-exported for scripts/verify-update.mjs and the bin launcher, which reads
// the compiled copy at lib/types/utils/shellQuote.js.
export { shellQuote }

const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_CHECK_TIMEOUT_MS = 4000
/** env marker set on the /update restart; the new process verifies it at boot. */
const UPDATED_FROM_ENV = 'DSH_TUI_UPDATED_FROM'
/**
 * env marker set on the /restart replacement: its boot logs to restart.log
 * (ordinary launches stay silent, so the file is restart-only evidence).
 */
const RESTART_CHILD_ENV = 'DSH_TUI_RESTART_CHILD'

/**
 * Field-diagnosis log for the /restart terminal handoff, appended by BOTH
 * processes: the exiting TUI logs the funnel path, the spawned replacement
 * logs its boot progress, and every line carries pid + timestamp — so a
 * handoff that dies at any stage (loader entry, TTY gate, session resume,
 * even after the parent's survival window) leaves breadcrumbs on disk even
 * when nothing reaches the already-confused terminal. Diagnosis only: every
 * write is best effort and must never break the handoff itself.
 */
const RESTART_LOG = join(DATA_DIR, 'restart.log')
/** Cap so a long debugging streak cannot grow the log unbounded. */
const RESTART_LOG_MAX_BYTES = 256 * 1024

function writeRestartLine(line: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(RESTART_LOG, `${new Date().toISOString()} pid=${process.pid} ${line}\n`)
  } catch {
    // Diagnosis only.
  }
}

/**
 * Append a /restart handoff event to ~/.dsh-tui/restart.log.
 * @param event - Short stable event name.
 * @param data - Small JSON-safe detail (never credentials or session text).
 */
export function logRestartEvent(event: string, data?: Record<string, unknown>): void {
  writeRestartLine(`${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`)
}

/** Start a fresh, clearly delimited /restart attempt block in the log. */
export function beginRestartAttempt(sessionId: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    let size = 0
    try {
      size = statSync(RESTART_LOG).size
    } catch {
      size = 0
    }
    if (size > RESTART_LOG_MAX_BYTES) writeFileSync(RESTART_LOG, '')
  } catch {
    // Diagnosis only.
  }
  writeRestartLine(`--- /restart attempt session=${sessionId} ---`)
}

/**
 * Write a handoff notice to stderr synchronously: process.exit() right after
 * an async stream write skips the flush, and a vanished diagnosis is
 * indistinguishable from a silent failure.
 */
export function writeHandoffNotice(text: string): void {
  try {
    writeFileSync(2, text)
  } catch {
    process.stderr.write(text)
  }
}

export interface TuiUpdateInfo {
  current: string
  latest: string
}

/** What a fresh registry lookup says about this install. */
export type TuiUpdateTarget =
  | { kind: 'update'; current: string; latest: string; authoritative?: string }
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

/**
 * Versions whose compiled plugin hard-injects `tuiWorkspaces`
 * ('0.7.0'–'0.7.1'; removed in 0.7.2). Installing one while the globally
 * installed launcher copy predates the `dsh-tui-workspaces` patch row
 * deadlocks boot forever at "pending (waiting for service: tuiWorkspaces)"
 * (issues #183/#307) — and /update reaching such a target is exactly how
 * stale-mirror installs stranded users. /update must refuse them.
 * @param version - the candidate install target.
 * @returns true for the known boot-deadlock version range.
 */
export function isBootDeadlockTarget(version: string): boolean {
  const v = valid(version)
  return v !== null && gte(v, '0.7.0') && lt(v, '0.7.2')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fetch `latest` from a registry; undefined on any failure. */
async function fetchLatestVersion(registryBase: string): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(`${registryBase}/${PACKAGE_NAME}/latest`, {
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
 *
 * The configured registry decides the install target (pnpm must be able to
 * fetch it), but when that registry is a mirror it can lag behind npmjs —
 * issue #307's users were pinned onto stale versions this way. A
 * best-effort npmjs.org check runs in parallel and surfaces as
 * `authoritative` when it knows a strictly newer release, so callers can
 * say "installing X now, official latest is Y" instead of silently
 * upgrading to yesterday's version.
 */
export async function resolveTuiUpdateTarget(): Promise<TuiUpdateTarget> {
  const current = installedTuiVersion()
  const currentVersion = current === undefined ? null : valid(current)
  if (currentVersion === null) return { kind: 'unknown' }

  const registryBase = resolveRegistryBase()
  const [latest, official] = await Promise.all([
    fetchLatestVersion(registryBase),
    registryBase === DEFAULT_REGISTRY ? undefined : fetchLatestVersion(DEFAULT_REGISTRY),
  ])
  if (latest === undefined) return { kind: 'unknown' }
  if (!gt(latest, currentVersion)) return { kind: 'latest', current: currentVersion }
  const authoritative = official !== undefined && gt(official, latest) ? official : undefined
  return { kind: 'update', current: currentVersion, latest, ...(authoritative === undefined ? {} : { authoritative }) }
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
 * The pnpm Linux flavor of the tmp-rename race (issue #479): the very same
 * `importPackage` staging path, but overlayfs surfaces the second swap of an
 * already-replaced package dir as EEXIST — deterministically, on every run,
 * never transiently. A plain retry of the identical command ALWAYS fails the
 * same way (the leftover `_tmp_<pid>_<threadId>` staging dir keeps colliding),
 * so this signature must route to the recovery path
 * (removeStalePackageInstall + rerun), not to the plain retry.
 */
export function isEexistTmpRenameFailure(stderr: string): boolean {
  return /EEXIST/i.test(stderr) && /_tmp_\d+/i.test(stderr)
}

/**
 * The dsh profile layout places plugin packages under
 * `$DSH_HOME ?? ~/.dsh` — the same root dsh itself resolves
 * (`dshHomePath is $DSH_HOME ?? ~/.dsh`, and packaged presets resolve
 * identically). /update's recovery path needs this location to clear a
 * half-updated install pnpm can no longer swap in place (issue #479).
 */
export function profilePackageDir(profile: string): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'profiles', profile, 'node_modules', PACKAGE_NAME)
}

/** What removeStalePackageInstall actually cleared from disk. */
export interface StaleInstallRemoval {
  /**
   * `removed` — the package dir (or its junction/symlink link) is gone;
   * `absent` — it was not there to begin with (custom profile roots just
   * miss); `failed` — an error other than ENOENT blocked the removal.
   */
  packageDir: 'removed' | 'absent' | 'failed'
  /** Leftover pnpm staging dirs (`dsh-tui_tmp_<pid>_<threadId>`) removed. */
  tmpDirs: string[]
}

/**
 * Recovery for the pnpm tmp-rename races (issues #225/#479): remove the
 * profile's installed copy of this package plus the sibling `_tmp_`
 * staging dirs a crashed swap leaves behind, so the next installer run
 * takes the fresh-install path instead of renaming over the collision.
 * Field-verified workaround (issue #479): `rm -rf <pkg dir>` + rerun
 * succeeds where ten plain retries fail.
 *
 * A junction/symlink at the package dir is UNLINKED only — the link is
 * removed, the target tree (a dev checkout it may point at) is never
 * traversed or deleted. Best effort throughout: this runs inside a
 * failure-recovery branch, so an unusable result simply falls through to
 * the rerun and the manual repair hint.
 */
export function removeStalePackageInstall(profile: string): StaleInstallRemoval {
  const pkgDir = profilePackageDir(profile)
  const scopeDir = dirname(pkgDir)
  const removal: StaleInstallRemoval = { packageDir: 'absent', tmpDirs: [] }
  try {
    const stats = lstatSync(pkgDir)
    // lstat reports junctions AND symlinks as isSymbolicLink — remove the
    // link itself, never what it points at.
    if (stats.isSymbolicLink() || stats.isDirectory()) {
      rmSync(pkgDir, { recursive: true, force: true })
      removal.packageDir = 'removed'
    }
  } catch (error) {
    removal.packageDir = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed'
  }
  try {
    for (const name of readdirSync(scopeDir)) {
      if (!/^dsh-tui_tmp_\d+_\d+$/.test(name)) continue
      const staging = join(scopeDir, name)
      try {
        rmSync(staging, { recursive: true, force: true })
        removal.tmpDirs.push(name)
      } catch {
        // Staging leftovers are best effort; the package dir removal is
        // the load-bearing half of the recovery.
      }
    }
  } catch {
    // Unreadable scope dir — nothing more to clear.
  }
  return removal
}

/**
 * Best-effort migrate the GLOBAL launcher to the delegating shim (0.8.7):
 * after a successful profile update, copy this package's `bin/dsh-tui.js`
 * and `package.json` over the global install so the launcher can never lag
 * the profile again — the shim delegates all logic to the profile copy it
 * just updated. Single-file-safe by contract: the new bin imports nothing
 * from lib/ (see its header), so overwriting it inside an older global
 * install cannot dangle a missing helper.
 *
 * Locating the global dir relies on argv[1] being the global `dsh-tui.js`
 * (true when booted through the `dsh-tui` command). Source checkouts and
 * direct `dsh --profile` boots resolve nothing — the migration is a silent
 * no-op there. Write failures (permissions, locked files) are equally
 * silent: the launcher-alignment warning remains the fallback diagnosis.
 *
 * @returns true when the global launcher files were replaced.
 */
export function migrateGlobalLauncher(): boolean {
  const launcherBin = process.argv[1]
  if (launcherBin === undefined || !launcherBin.endsWith('dsh-tui.js')) return false
  // Walk up from the bin to the containing package; accept it only when it
  // is OUR package and not the profile copy we are running from (junction
  // layouts collapse both onto the same real path — copying onto ourselves
  // would be a no-op at best).
  let dir = dirname(resolve(launcherBin))
  const ownDir = dirname(dirname(fileURLToPath(import.meta.url)))
  for (let depth = 0; depth < 4; depth++) {
    const manifest = join(dir, 'package.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).name === PACKAGE_NAME
      ) {
        let same = false
        try {
          same = realpathSync(dir) === realpathSync(ownDir)
        } catch {
          same = resolve(dir) === resolve(ownDir)
        }
        if (same) return false
        // tmp + rename keeps each file atomic; a crash mid-migration leaves
        // either the old or the new file, never a truncated one.
        const replace = (target: string, source: string): void => {
          const staged = `${target}.dsh-tui-migrate`
          writeFileSync(staged, readFileSync(source))
          renameSync(staged, target)
        }
        replace(join(dir, 'bin', 'dsh-tui.js'), join(ownDir, 'bin', 'dsh-tui.js'))
        replace(manifest, join(ownDir, 'package.json'))
        return true
      }
    } catch {
      // Unreadable manifest at this level — keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
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
  // Stamp the pre-update version BEFORE pnpm runs: it reads this package's
  // manifest from disk, which the update replaces on the fly — a
  // post-update read already sees the NEW version, and the restarted
  // process then compares new-vs-new and false-alarms "version did not
  // advance" on every successful update (issue #307's screenshots).
  const updatedFrom = installedTuiVersion() ?? ''
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
  // Deterministic Linux tmp-rename race (issue #479): EEXIST never clears on
  // a plain retry (the staging-dir collision reproduces every run), and a
  // transient retry that failed again means the same leftover state. Both
  // recover by removing the stale install + staging dirs, then rerunning —
  // the field-verified workaround that takes pnpm down its fresh-install
  // path instead of renaming over the collision.
  if (updateCode !== 0 && (isEexistTmpRenameFailure(updateStderr) || isTransientUpdateFailure(updateStderr))) {
    const flavor = isEexistTmpRenameFailure(updateStderr) ? 'EEXIST, issue #479' : 'retry failed, issue #225'
    const removal = removeStalePackageInstall(profile)
    const stagingNote = removal.tmpDirs.length > 0 ? ` + ${removal.tmpDirs.length} staging dir(s)` : ''
    process.stderr.write(
      `dsh-tui: pnpm tmp-rename race (${flavor}) — cleared the stale install ` +
        `(package dir: ${removal.packageDir}${stagingNote}) and rerunning the update…\n`,
    )
    updateStderr = ''
    updateCode = await runProcess(dsh, updateArgs, { shell: true, onStderr: capture })
  }
  if (updateCode !== 0) return { updateCode, restartCode: updateCode }

  // A --latest fallback (preflight failed) on a stale mirror can still land
  // on the 0.7.0–0.7.1 hard-inject range — restarting into it under an older
  // global-launcher patch is the permanent boot deadlock of issues
  // #183/#307. Refuse the restart when the version JUST moved there; a user
  // who was already on it keeps their restart (their combo demonstrably
  // boots) and gets the repair hint on the next /update instead.
  const installedNow = installedTuiVersion()
  if (installedNow !== undefined && installedNow !== updatedFrom && isBootDeadlockTarget(installedNow)) {
    process.stderr.write(
      `dsh-tui: update landed on ${installedNow}, which can permanently deadlock boot under older launcher patches ` +
        `(#183/#307) — NOT restarting into it. Repair with:\n` +
        `  dsh plugin --profile ${profile} add ${PACKAGE_NAME}@latest\n` +
        `(if the mirror has not synced the latest release yet, retry later)\n`,
    )
    return { updateCode: 1, restartCode: 1 }
  }

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

  // Launcher migration (0.8.7): the freshly installed profile carries the
  // delegating shim — stamp it over the global launcher so this is the LAST
  // time the outer copy can lag. Best-effort; the alignment warning stays as
  // the fallback when the copy is impossible.
  if (migrateGlobalLauncher()) {
    process.stderr.write('dsh-tui: global launcher aligned to the delegating shim (no manual npm i -g needed anymore).\n')
  }

  // Restart through the same hardened handoff as /restart (issues
  // #284/#307/#483): wait for the replacement's natural exit (the outer
  // interpreter must not reclaim the console under it), re-assert the
  // stdin detach from a watchdog so a revived pump cannot swallow the
  // child's keypresses, and capture a fast-death stderr report. The old
  // plain inherit spawn raced the interpreter for input on Windows
  // Terminal (issue #483: "cannot type anything after /update").
  const restartCode = await restartTui(sessionId, {
    env: { [UPDATED_FROM_ENV]: updatedFrom },
    kind: 'update',
  })
  return { updateCode, restartCode }
}

/**
 * Restart the running TUI in place and resume the active session — the
 * `/update` restart path minus the pnpm step, for `/restart`. Spawns the
 * same node process with the original argv and the dual-written resume
 * contract, so a fresh process re-boots the same profile and attaches the
 * same session. No installation is touched, so it works on any launch
 * (profile, source checkout, `--config` overlay). `/update` reuses this
 * handoff for its own restart tail (`kind: 'update'`): the keyboard-race
 * hardening below is exactly the failure its users reported (issue #483:
 * update restarts into a TUI that takes no input).
 *
 * The TUI must already be unmounted before this is called (same terminal
 * handoff contract as `updateTuiAndRestart`): the caller runs this from the
 * exit funnel's done callback, after finishExit detached the terminal and
 * the readable stdin pump.
 *
 * This waits for the replacement's natural exit: the outer command
 * interpreter that ran `dsh-tui` reclaims the console the moment the
 * launch chain (cmd → wrapper → this process) unwinds, and an orphaned
 * replacement still attached to the console then fights the interpreter's
 * own prompt and line reader for every keypress (field evidence
 * 2026-08-24: healthy child mounted the UI, the old process exited on a
 * 4s survival timer, the interpreter printed its prompt over the TUI and
 * the DA response bytes landed on the prompt line). Waiting is safe
 * because finishExit already paused and unref'd this process's stdin —
 * the child is the console's only key reader (issues #284/#307).
 *
 * The 4s survival window remains a DIAGNOSIS marker only: a replacement
 * that dies within it never painted the TUI, and its captured stderr is
 * reported synchronously (a raw inherit write can vanish mid-handoff). A
 * late exit is quiet — by then the user owned a working TUI session.
 *
 * @param sessionId - Session to resume in the replacement process.
 * @param options - `kind: 'update'` drops the /restart boot-diagnosis
 *   marker and tags restart.log events for the update flow; `env` adds
 *   marker variables for the replacement (e.g. DSH_TUI_UPDATED_FROM).
 * @returns 0 when the replacement ran and exited cleanly, 127 when it
 *   failed to start, otherwise the child's own exit code.
 */
export interface TuiRestartOptions {
  /** Extra env markers for the replacement process (/update's stamp). */
  env?: Record<string, string>
  /**
   * 'update' reuses this handoff after an install: no
   * DSH_TUI_RESTART_CHILD marker (that flag is /restart-only boot
   * diagnostics) and restart.log events carry the update-restart tag.
   */
  kind?: 'restart' | 'update'
}

export async function restartTui(sessionId: string, options: TuiRestartOptions = {}): Promise<number> {
  const kind = options.kind ?? 'restart'
  const tag = kind === 'update' ? 'update-restart' : 'restart'
  const argv = [...process.execArgv, ...process.argv.slice(1)]
  logRestartEvent(`${tag}: spawning replacement`, {
    node: process.execPath,
    argv,
    cwd: process.cwd(),
    stdinTty: process.stdin.isTTY === true,
    stdoutTty: process.stdout.isTTY === true,
    stderrTty: process.stderr.isTTY === true,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    dshHome: process.env.DSH_HOME ?? null,
  })
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn(process.execPath, argv, {
      env: {
        ...process.env,
        // Dual-write the resume contract (issue #120): the cordis layer of a
        // still-old TUI build reads only DSH_CC_RESUME_SESSION.
        DSH_TUI_RESUME_SESSION: sessionId,
        DSH_CC_RESUME_SESSION: sessionId,
        // Marks the replacement so its own boot logs to restart.log without
        // noisy logging on every ordinary launch (/restart only).
        ...(kind === 'restart' ? { [RESTART_CHILD_ENV]: '1' } : {}),
        ...options.env,
      },
      // stdin/stdout stay inherited so the replacement owns the console the
      // moment it boots; stderr is captured so a boot failure is reportable
      // through THIS process (the terminal may already be mid-handoff when
      // the child dies, and a raw inherit write can vanish).
      stdio: ['inherit', 'inherit', 'pipe'],
    })
    logRestartEvent(`${tag}: replacement spawned`, { childPid: child.pid })
    // Handoff watchdog (field evidence 2026-08-24: restarted TUI mounts but
    // takes no input). Two jobs, both diagnosis-grade:
    // 1. SAMPLE this process's stdin state every second — if anything
    //    re-attaches a reader after the funnel's detachStdinForHandoff, the
    //    sample (taken before the re-assert below) shows it in the log.
    // 2. RE-ASSERT the detach and finally destroy the stream: this process
    //    must never read the shared console again — every keypress belongs
    //    to the replacement, and a resumed pump here is exactly the
    //    "restarted TUI sees dropped or swallowed input" failure (#284/#307).
    let watchdogTicks = 0
    const watchdog = setInterval(() => {
      watchdogTicks += 1
      const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean }
      logRestartEvent('parent: stdin watchdog', {
        tick: watchdogTicks,
        readableListeners: stdin.listenerCount('readable'),
        dataListeners: stdin.listenerCount('data'),
        paused: stdin.isPaused,
        raw: stdin.isRaw === true,
        buffered: stdin.readableLength,
      })
      try {
        stdin.removeAllListeners('readable')
        stdin.removeAllListeners('data')
        stdin.pause()
      } catch {
        // Diagnosis/mitigation only.
      }
      if (watchdogTicks === 15) {
        clearInterval(watchdog)
        try {
          // Terminal safeguard: a destroyed stream can never be resumed by
          // any late re-attachment. The child holds its own inherited
          // handle, so closing ours does not affect it.
          process.stdin.destroy()
          logRestartEvent('parent: stdin destroyed after watchdog')
        } catch {
          // Best effort.
        }
      }
    }, 1000)
    watchdog.unref()
    let childStderr = ''
    let loggedStderrBytes = 0
    child.stderr?.on('data', (chunk: Buffer) => {
      childStderr += chunk.toString('utf8')
      // Mirror chunks to the log capped: the full text still reaches the
      // terminal report below, and unbounded output must not grow the file.
      if (loggedStderrBytes < 4096) {
        loggedStderrBytes += chunk.length
        logRestartEvent(`${tag}: replacement stderr`, { text: chunk.toString('utf8').slice(0, 2048) })
      }
    })
    // Diagnosis marker only — never resolves: after the window the child owns
    // the terminal, and this process must keep the launch chain open until
    // the replacement exits (see the header comment).
    const timer = setTimeout(() => {
      logRestartEvent(`${tag}: survival window passed, following the replacement until it exits`)
    }, 4000)
    timer.unref()
    child.once('error', error => {
      clearTimeout(timer)
      logRestartEvent(`${tag}: spawn error`, { message: error.message })
      writeHandoffNotice(`dsh-tui: failed to spawn the restart: ${error.message}\n`)
      resolve(127)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - startedAt
      logRestartEvent(`${tag}: replacement exited`, {
        code: code ?? null,
        signal: signal ?? null,
        elapsedMs,
      })
      if (elapsedMs < 4000) {
        // Fast death: the TUI never came up. Synchronous stderr write —
        // process.exit() right after an async stream write skips the flush,
        // and a vanished diagnosis is indistinguishable from silent failure.
        const suffix = childStderr.trim() === '' ? '' : `\n${childStderr.trimEnd()}`
        writeHandoffNotice(
          `dsh-tui: restart child exited during the handoff (code ${code ?? 'null'}` +
            `${signal === undefined || signal === null ? '' : `, signal ${signal}`}) — the TUI did not come up.` +
            `${suffix}\nYour session is preserved; resume with the launcher or retry the command.\n`,
        )
      } else if (code !== 0 && code !== null) {
        // Late nonzero exit: the session ended abnormally, say so briefly.
        writeHandoffNotice(`\ndsh-tui: the restarted session exited with code ${code}.\n`)
      }
      resolve(code ?? 1)
    })
  })
}
