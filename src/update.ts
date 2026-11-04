import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// Per-function imports: this file loads before the first frame.
import gt from 'semver/functions/gt.js'
import gte from 'semver/functions/gte.js'
import lt from 'semver/functions/lt.js'
import valid from 'semver/functions/valid.js'
import validRange from 'semver/ranges/valid.js'
import { shellQuote } from './utils/shellQuote.js'
import { DATA_DIR } from './utils/paths.js'
import { stripResumeArgs } from './sessionHistory.js'
import { HOST_ENTRY_PATH_ENV, KERNEL_SWITCH_HANDOFF_ENV, RESUME_BACKEND_ENV, RESUME_RETRY_ENV, hostEntryDisabled, parseBackendId, type KernelBackendId } from './kernelPrefs.js'
import { classifyReplacementOutcome, formatHandoffNotice, handoffEventTag, writeHandoffStage } from './handoffEvents.js'
import { HANDOFF_ACK_FD_ENV, HANDOFF_ATTEMPT_ENV, HANDOFF_SCREEN_ENV, parseHandoffAckLine } from './handoffAck.js'
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, DISABLE_WIN32_INPUT_MODE } from './ink/termio/csi.js'
import { DBP, DFE, DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from './ink/termio/dec.js'
import { detachHandoffStdin } from './ink/stdin-handoff.js'
import { runInstallerProcess } from './updateProcess.js'
import { UPSTREAM_HOST_PACKAGE, UPSTREAM_HOST_PEER_PACKAGE, installedKernelPackageDir, installedKernelVersion } from './dsh-adapter/contract.js'
import { DSH_PM_ENV, PNPM_RELEASE_AGE_ENV, detectHostInstall, hostCompatibility, hostManualCommands, parseHostLineRange, planHostStep, shellEnvPrefix, type HostStep } from './updateHost.js'
import { t } from './i18n.js'

// Re-exported for scripts/verify-update.mjs and the bin launcher, which reads
// the compiled copy at lib/types/utils/shellQuote.js.
export { shellQuote }
export { detachHandoffStdin }

const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const GITHUB_REPO = 'ccch1mneyyy/dsh-TUI'
const UPDATE_CHECK_TIMEOUT_MS = 4000
const STANDALONE_DOWNLOAD_TIMEOUT_MS = 300000
/**
 * Hard cap on a single release asset the updater will accept, checked against
 * the declared content-length BEFORE the body is buffered, and enforced as a
 * mid-stream abort while the body downloads (a chunked response with no
 * content-length header is interrupted at the cap instead of buffered whole —
 * a hostile mirror must not be able to pin the process in an unbounded
 * arrayBuffer() and OOM it).
 */
const MAX_ASSET_BYTES = 512 * 1024 * 1024
/** The SHA256SUMS manifest itself is plain text; anything past this is broken. */
const MAX_CHECKSUM_MANIFEST_BYTES = 1024 * 1024
/** env marker set on the /update restart; the new process verifies it at boot. */
const UPDATED_FROM_ENV = 'DSH_TUI_UPDATED_FROM'
/**
 * Engine counterpart of DSH_TUI_UPDATED_FROM: set only when the dsh engine
 * actually changed, so a "TUI was already latest, only the engine moved"
 * update does not trip the TUI version-advance check (#1844 plan §3.6).
 */
const UPDATED_DSH_FROM_ENV = 'DSH_TUI_UPDATED_DSH_FROM'
/** `DSH_TUI_UPDATE_ENGINE=0` pins the engine: plan the step, never run it. */
export const UPDATE_ENGINE_ENV = 'DSH_TUI_UPDATE_ENGINE'
/**
 * The global launcher's own bin path, exported by shims >= 0.19.0 beside
 * DSH_TUI_LAUNCHER_VERSION. Inside the TUI argv[1] is the PROFILE copy, so
 * without this marker /update can only *see* that the launcher lags, never
 * reach the install it would have to align (issue #1844).
 */
export const GLOBAL_LAUNCHER_PATH_ENV = 'DSH_TUI_LAUNCHER_PATH'
/** Launcher generation marker (shims >= 0.8.3); also the PATH-fallback identity. */
export const GLOBAL_LAUNCHER_VERSION_ENV = 'DSH_TUI_LAUNCHER_VERSION'
/**
 * One-shot marker for "this launch chain has no global launcher": set on a
 * restart whose plan resolved no launcher (a direct `dsh --profile` boot), so
 * the replacement does not warn about an install that does not exist.
 * Never reuse DSH_TUI_LAUNCHER_VERSION for this - a stale version marker would
 * make the next plan's PATH fallback adopt an unrelated global launcher.
 */
export const LAUNCHER_ABSENT_ENV = 'DSH_TUI_LAUNCHER_ABSENT'
/** `DSH_TUI_UPDATE_LAUNCHER=0` skips the launcher step (pinned installs, diagnosis). */
export const UPDATE_LAUNCHER_ENV = 'DSH_TUI_UPDATE_LAUNCHER'
/**
 * env marker set on the /restart replacement: its boot logs to restart.log
 * (ordinary launches stay silent, so the file is restart-only evidence).
 */
const RESTART_CHILD_ENV = 'DSH_TUI_RESTART_CHILD'

/**
 * env marker on every replacement (/restart, /update, kernel switch): it is
 * started with the original app arguments, so a command-line prompt in them
 * was already sent by the first process and must not be sent again.
 */
export const LAUNCH_PROMPT_SENT_ENV = 'DSH_TUI_LAUNCH_PROMPT_SENT'

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

/**
 * `~/.dsh-tui/last-run.json`: which kernel and session the most recent TUI
 * instance ran, written at boot (plugin.ts) and refreshed by the exit funnel.
 * The launcher's safe-mode retry reads it. After a kernel switch the
 * launcher's own env still names the original backend, so retrying from that
 * env would reopen the old kernel, or hand a DSH session id to a Claude boot.
 * kernel.json has the backend but not the session or when it was written.
 */
export interface LastRunRecord {
  /** The kernel THIS instance ran on (Config domain: KernelBackendId). */
  readonly backendId: KernelBackendId
  /** The resumable session id on that backend; '' = nothing resumable (the
   *  retry cold-starts the backend instead of resuming across domains). */
  readonly sessionId: string
  /** The session's working directory (diagnostics; the retry keeps the
   *  launch cwd, it does not chdir from this field). */
  readonly cwd: string
  /** Which boot wrote this record (pid+clock id; diagnostics and
   *  generation comparisons). */
  readonly attemptId: string
  /** epoch-ms stamp (added by writeLastRunRecord): the launcher compares it
   *  against its own start to tell this-chain records from a previous
   *  launch's leftovers. */
  readonly updatedAt: number
  /** Writer pid (diagnostics). */
  readonly pid?: number
}

const LAST_RUN_FILE = join(DATA_DIR, 'last-run.json')

/** Windows rename retry cell (kernelPrefs writeKernelPrefs precedent). */
const lastRunWaitCell = new Int32Array(new SharedArrayBuffer(4))

/**
 * Stamp the last-run record atomically (tmp + rename, so the launcher's read
 * never sees half a file). Best effort, never throws: a failed stamp only
 * degrades the launcher's retry to its legacy sniffing path.
 * @param record - Identity without updatedAt (stamped here, one clock).
 * @param file - Path override (verify scripts point at a temp dir).
 */
export function writeLastRunRecord(
  record: Omit<LastRunRecord, 'updatedAt'>,
  file: string = LAST_RUN_FILE,
): void {
  const temporary = join(dirname(file), `.last-run.${process.pid}.${Date.now()}.tmp`)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const updatedAt = Date.now()
    writeFileSync(temporary, `${JSON.stringify({ ...record, updatedAt }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, file)
        return
      } catch (error) {
        const code = typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code) : ''
        if (process.platform !== 'win32' || attempt >= 7 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
        Atomics.wait(lastRunWaitCell, 0, 0, 2 ** attempt)
      }
    }
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The previous record stays; no safe remedy.
    }
    writeRestartLine(`last-run record write failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Read the last-run record; unreadable/invalid/missing yields undefined (the
 * caller falls back to its legacy behavior). Never throws.
 * @param file - Path override (verify scripts point at a temp dir).
 */
export function readLastRunRecord(file: string = LAST_RUN_FILE): LastRunRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    // The syntax gate only: this module is also loaded by the launcher's retry
    // path, which must not pull the registry (and cannot, without compiled
    // modules). A record naming an uninstalled plugin reads back fine — the boot
    // then falls back to dsh with a warning, like any unknown value (P0 D1).
    const backendId = parseBackendId(record.backendId)
    if (backendId === undefined) return undefined
    if (typeof record.sessionId !== 'string' || typeof record.cwd !== 'string' || typeof record.attemptId !== 'string') return undefined
    if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined
    return {
      backendId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      attemptId: record.attemptId,
      updatedAt: record.updatedAt,
      ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
    }
  } catch {
    return undefined
  }
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

/**
 * Hand the terminal back after a kernel-switch replacement that cannot clean
 * up after itself: one that died before its first frame (this process still
 * holds the alternate screen) or one killed by a signal. Besides leaving the
 * alternate screen it turns off the input modes the replacement may already
 * have enabled; each reset is harmless if the mode was never on. Written
 * synchronously to fd 1 so the failure notice that follows lands on the main
 * screen.
 */
export function restoreHandoffScreen(): void {
  const reset = DISABLE_MOUSE_TRACKING + DISABLE_MODIFY_OTHER_KEYS + DISABLE_KITTY_KEYBOARD
    + DISABLE_WIN32_INPUT_MODE + DFE + DBP + SHOW_CURSOR + EXIT_ALT_SCREEN + '\r\n'
  try {
    writeFileSync(1, reset)
  } catch {
    try {
      process.stdout.write(reset)
    } catch {
      // Even a dead stdout must not block the exit path.
    }
  }
}

export interface TuiUpdateInfo {
  current: string
  latest: string
  isStandalone?: boolean
  downloadUrl?: string
  /** SHA256SUMS manifest URL when the release publishes one; absent = the update warning path. */
  checksumUrl?: string
}

/** What a fresh registry lookup says about this install. */
export type TuiUpdateTarget =
  | { kind: 'update'; current: string; latest: string; authoritative?: string; isStandalone?: boolean; downloadUrl?: string; checksumUrl?: string }
  | { kind: 'latest'; current: string; isStandalone?: boolean }
  | { kind: 'unknown'; isStandalone?: boolean }

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
async function fetchLatestVersion(registryBase: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(`${registryBase}/${PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/json' },
      signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
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
 * Detect whether the current process is running in standalone / portable package mode.
 *
 * @returns `true` when running inside a standalone binary distribution, `false` otherwise.
 */
export function isStandaloneRuntime(): boolean {
  return (
    process.env.DSH_TUI_STANDALONE === '1' ||
    process.env.DSH_TUI_STANDALONE_BINARY !== undefined ||
    (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.includes('dsh-tui-standalone'))
  )
}

/**
 * Get the path to the current standalone executable binary.
 *
 * @returns The resolved executable path from environment or `process.execPath`.
 */
export function getStandaloneBinaryPath(): string {
  return process.env.DSH_TUI_STANDALONE_BINARY ?? process.execPath
}

/**
 * Get the expected release asset file name for the current platform and architecture.
 *
 * @param platform - Node.js platform identifier (e.g. `'linux'`, `'win32'`, `'darwin'`).
 * @param arch - Node.js architecture identifier (e.g. `'x64'`, `'arm64'`).
 * @returns The archive file name matching the target platform.
 */
export function getStandaloneAssetName(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') {
    return 'dsh-tui-standalone-win-x64.zip'
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'dsh-tui-standalone-darwin-arm64.tar.gz'
      : 'dsh-tui-standalone-darwin-x64.tar.gz'
  }
  return arch === 'arm64'
    ? 'dsh-tui-standalone-linux-arm64.tar.gz'
    : 'dsh-tui-standalone-linux-x64.tar.gz'
}

/** Options for {@link fetchGithubLatestRelease} — injectable for tests. */
export interface GithubReleaseQuery {
  /** GitHub API base; defaults to `https://api.github.com`. */
  apiBaseUrl?: string
  /** Fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Cancellation shared with the update that requested this release. */
  signal?: AbortSignal
}

/**
 * Locate the release's checksum manifest among its assets: the aggregator
 * `SHA256SUMS` file first, then a single-asset `<asset>.sha256` sidecar —
 * and nothing else. A name-blind `endsWith('.sha256')` fallback (removed,
 * external review) could claim ANOTHER asset's sidecar (e.g. the win zip's
 * digest next to a linux update), whose mismatch then fail-closed innocent
 * users' updates; an unrecognized layout resolves to undefined so the
 * transition-period warning path applies instead.
 * @param assets - Parsed release asset objects.
 * @param assetName - The main asset whose sidecar, if any, is exact-named.
 * @returns The manifest's browser_download_url, or undefined when the release
 *   publishes none (the transition-period warning path).
 */
function findChecksumAssetUrl(assets: unknown[], assetName: string): string | undefined {
  const urlOf = (a: unknown): a is Record<string, unknown> =>
    isRecord(a) && typeof a.name === 'string' && typeof a.browser_download_url === 'string'
  const byName = (name: string): unknown => assets.find(a => urlOf(a) && a.name === name)
  const sums = byName('SHA256SUMS')
  if (sums !== undefined) return (sums as Record<string, unknown>).browser_download_url as string
  const exact = byName(`${assetName}.sha256`)
  return exact === undefined ? undefined : (exact as Record<string, unknown>).browser_download_url as string
}

/**
 * Fixed-name SHA256SUMS download URL for a release version — the
 * mirror-fallback counterpart of {@link findChecksumAssetUrl}: when the
 * GitHub API is unreachable and the version came from a registry, there is no
 * asset list to parse, so the manifest is probed at its conventional name on
 * the same direct-download host (release-bundle.yml publishes it as
 * `SHA256SUMS` next to every asset).
 */
export function releaseChecksumUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/SHA256SUMS`
}

/**
 * Probe whether a release publishes a checksum manifest at a URL. Only an OK
 * response resolves to the URL — a 404 (the release predates the checksum
 * workflow) or any network failure resolves to undefined so the update keeps
 * the transition-period warning path instead of being blocked (new releases
 * always ship the manifest; old ones must keep updating).
 */
async function probeChecksumManifestUrl(url: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'dsh-tui-updater' },
      redirect: 'follow',
      signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    })
    return response.ok ? url : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetch latest release info from GitHub Releases API for the standalone asset.
 *
 * @param options - Injectable API base / fetch for tests.
 * @returns Release version tag, matching asset download URL, and the
 *   SHA256SUMS manifest URL when the release ships one, or `undefined` on any
 *   failure.
 */
export async function fetchGithubLatestRelease(options: GithubReleaseQuery = {}): Promise<{ version: string; downloadUrl?: string; checksumUrl?: string } | undefined> {
  if (options.signal?.aborted) return undefined
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await doFetch(`${options.apiBaseUrl ?? 'https://api.github.com'}/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github.v3+json', 'user-agent': 'dsh-tui-updater' },
      signal: options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]),
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    if (!isRecord(payload) || typeof payload.tag_name !== 'string') return undefined
    const rawTag = payload.tag_name.replace(/^v/, '')
    const version = valid(rawTag)
    if (version === null) return undefined
    const assetName = getStandaloneAssetName()
    let downloadUrl: string | undefined
    let checksumUrl: string | undefined
    if (Array.isArray(payload.assets)) {
      const asset = (payload.assets as unknown[]).find(
        (a: unknown) => isRecord(a) && a.name === assetName && typeof a.browser_download_url === 'string',
      ) as Record<string, unknown> | undefined
      if (asset !== undefined && typeof asset.browser_download_url === 'string') {
        downloadUrl = asset.browser_download_url
      }
      checksumUrl = findChecksumAssetUrl(payload.assets as unknown[], assetName)
    }
    if (downloadUrl === undefined) {
      downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${assetName}`
    }
    return checksumUrl === undefined ? { version, downloadUrl } : { version, downloadUrl, checksumUrl }
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Verify a downloaded release asset against its SHA256SUMS manifest text
 * (fail-closed in every ambiguous shape: a malformed line, a missing entry
 * for the asset, or multiple bare digests all reject — a release that
 * publishes a manifest has declared checksums mandatory for its assets).
 * Both the GNU `hex␣␣name` and `hex␣*name` (binary-mode) line forms parse,
 * and a single bare `hex` line (a `<asset>.sha256` sidecar) applies to the
 * one asset it accompanies.
 *
 * Trust boundary (explicit scope note): the manifest is fetched from the
 * SAME release as the asset, so what this check defends against is
 * download-domain hijacking, cache poisoning, and asset/manifest mix-ups —
 * any tampering that changes the asset without also controlling the
 * release's published checksums. It does NOT defend against a fully
 * compromised release source (attacker publishes matching checksums for
 * malicious bytes): that requires a signature chain (minisign/cosign with
 * the public key built into the binary) — a declared follow-up item, out
 * of this change's scope.
 *
 * @param buffer - The downloaded asset bytes.
 * @param manifestText - SHA256SUMS file content.
 * @param assetName - Asset file name to look up in the manifest.
 * @returns true only when the manifest names the asset and the digest matches.
 */
export function verifyAssetChecksum(buffer: Buffer, manifestText: string, assetName: string): boolean {
  const named = new Map<string, string>()
  let bareHex: string | undefined
  for (const rawLine of manifestText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})(?:[ \t]+[ *]?(.*\S))?$/.exec(line)
    if (match === null) return false
    const hex = match[1].toLowerCase()
    const name = match[2]
    if (name === undefined) {
      if (bareHex !== undefined) return false
      bareHex = hex
    } else {
      named.set(name, hex)
    }
  }
  const expected = named.get(assetName) ?? (named.size === 0 ? bareHex : undefined)
  if (expected === undefined) return false
  return createHash('sha256').update(buffer).digest('hex') === expected
}

/**
 * Escape a value for embedding in a PowerShell single-quoted literal: only
 * `''` needs escaping there (same convention as `buildPsScript` in
 * src/utils/clipboard.ts). Extract/archive paths derive from environment
 * variables (`DSH_TUI_STANDALONE_CACHE`), so an unescaped `'` closes the
 * literal and turns the rest of the path into executable command text.
 * @param value - Raw string to embed between single quotes.
 * @returns The value with every `'` doubled.
 */
export function escapePsSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * How the Windows half of the standalone updater extracts the downloaded zip:
 * prefer the bsdtar `tar.exe` Windows 10 1809+ ships (it reads zip, and the
 * array argv never goes through a shell, so there is no quoting surface at
 * all), and only fall back to `Expand-Archive` when tar is missing — with
 * both paths escaped as single-quoted literals. Extracted as a pure function
 * so scripts/verify-update-extract.tsx can pin the no-injection contract.
 * @param downloadPath - Path of the downloaded archive (attacker-influenced
 *   via cache-dir environment variables).
 * @param extractDir - Destination directory for extraction.
 * @param tarAvailable - Whether `tar --version` ran successfully (probed once
 *   per update with {@link windowsTarAvailable}).
 * @returns The child command plus its argv — array form for both tools.
 */
export type WindowsExtractPlan =
  | { tool: 'tar'; args: string[] }
  | { tool: 'powershell'; args: string[] }

export function windowsExtractPlan(downloadPath: string, extractDir: string, tarAvailable: boolean): WindowsExtractPlan {
  if (tarAvailable) {
    return { tool: 'tar', args: ['-xf', downloadPath, '-C', extractDir] }
  }
  return {
    tool: 'powershell',
    args: [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${escapePsSingleQuoted(downloadPath)}' -DestinationPath '${escapePsSingleQuoted(extractDir)}' -Force`,
    ],
  }
}

/** Probe for the Windows 10+ built-in bsdtar (missing on older LTSC images). */
function windowsTarAvailable(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** What {@link validateExtractedTree} says about an extracted release tree. */
export interface ExtractedTreeCheck {
  ok: boolean
  /** First offending entry (path + why) when ok is false. */
  reason?: string
}

/**
 * Zip-slip / symlink guard between extraction and replacement (security
 * review, medium): walk the freshly extracted tree WITHOUT following links
 * and require every entry to be a regular file or directory whose resolved
 * path stays inside the extract dir. GNU tar happily materializes symlink
 * members pointing outside (verified: `link.txt -> /etc/passwd` lands on
 * disk), and the follow-up copyFileSync would then read/write through the
 * link; `../` members are also refused by tar/unzip themselves, but the
 * prefix check here keeps the guard local and future-proof against a
 * different extractor. The node-tar strict equivalent (preservePaths: false +
 * strict) is in standalone/entry.mjs — this covers the system-tool paths
 * entry.mjs cannot. Symlinks are rejected outright (defense in depth: a
 * "harmless" in-tree link is still indistinguishable from a hostile one at
 * this layer), as are fifo/socket/device entries — and hard links (red-team
 * review): GNU tar refusing external linkname targets is extractor behavior,
 * not a guarantee this code may lean on (busybox tar and friends land hard
 * links verbatim), so any regular file with nlink > 1 is refused — a landed
 * hard link aliases a file this walk never enumerated.
 * @param extractDir - Directory the archive was extracted into.
 * @returns ok plus the first offending entry's path.
 */
export function validateExtractedTree(extractDir: string): ExtractedTreeCheck {
  const root = resolve(extractDir)
  const walk = (dir: string): ExtractedTreeCheck => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return { ok: false, reason: `unreadable directory ${dir}: ${error instanceof Error ? error.message : String(error)}` }
    }
    for (const entry of entries) {
      const full = resolve(join(dir, entry.name))
      if (full !== root && !full.startsWith(root + sep)) {
        return { ok: false, reason: `entry escapes the extract directory: ${full}` }
      }
      if (entry.isSymbolicLink()) {
        return { ok: false, reason: `symbolic link in release archive: ${full}` }
      }
      if (entry.isDirectory()) {
        const sub = walk(full)
        if (!sub.ok) return sub
      } else if (!entry.isFile()) {
        return { ok: false, reason: `non-regular entry in release archive: ${full}` }
      } else {
        // Hard-link guard (see header): a regular file with more than one
        // name on disk aliases something this enumeration never saw.
        try {
          if (lstatSync(full).nlink > 1) {
            return { ok: false, reason: `hard link in release archive (nlink=${lstatSync(full).nlink}): ${full}` }
          }
        } catch (error) {
          return { ok: false, reason: `entry not statable: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }
    return { ok: true }
  }
  return walk(root)
}

/**
 * Fetch and size-cap a release's SHA256SUMS manifest. Any failure throws —
 * a release that declares a manifest must actually be verifiable (fail
 * closed), so the update never silently falls back to unverified bytes.
 *
 * The cap is enforced the same two-part way as the main asset download
 * (see {@link downloadAndReplaceStandaloneBinary}): the declared
 * content-length rejects before a byte is buffered, and the body is read
 * through a streaming loop that aborts the connection the moment the
 * running total passes the cap — a chunked response with no (or a lying)
 * content-length header is interrupted at the cap instead of buffered
 * whole by response.text() before the check runs.
 * @param checksumUrl - Browser download URL of the manifest.
 * @param maxManifestBytes - Size cap (default
 *   {@link MAX_CHECKSUM_MANIFEST_BYTES}); tests inject a small value.
 * @returns The manifest text.
 */
async function fetchChecksumManifest(
  checksumUrl: string,
  maxManifestBytes: number = MAX_CHECKSUM_MANIFEST_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), STANDALONE_DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(checksumUrl, {
      headers: { 'user-agent': 'dsh-tui-updater' },
      redirect: 'follow',
      signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    })
    if (!response.ok) {
      throw new Error(`checksum manifest fetch failed: HTTP ${response.status} ${response.statusText}`)
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxManifestBytes) {
      throw new Error(`checksum manifest declares ${declared} bytes, over the ${maxManifestBytes} cap`)
    }
    if (response.body === null) {
      throw new Error('checksum manifest response has no body stream')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      received += value.byteLength
      if (received > maxManifestBytes) {
        controller.abort()
        try { await reader.cancel() } catch { /* already aborted */ }
        throw new Error(`checksum manifest streamed past ${received} bytes, over the ${maxManifestBytes} cap`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, received).toString('utf8')
  } finally {
    clearTimeout(timeout)
  }
}

/** Options for {@link downloadAndReplaceStandaloneBinary} — injectable for tests. */
export interface StandaloneDownloadOptions {
  /**
   * Override the asset size cap (default {@link MAX_ASSET_BYTES}). Tests
   * inject a small value so the mid-stream abort path runs in milliseconds.
   */
  maxAssetBytes?: number
  /**
   * Override the checksum-manifest size cap (default
   * {@link MAX_CHECKSUM_MANIFEST_BYTES}). Tests inject a small value so the
   * manifest's own mid-stream abort path runs against a local unbounded
   * server stream.
   */
  maxChecksumManifestBytes?: number
  /** Cancel both the archive and checksum transfer before replacement. */
  signal?: AbortSignal
}

/**
 * Download the new standalone release binary package and atomically replace the running binary.
 *
 * Integrity (security review, high): when the caller resolved a SHA256SUMS
 * manifest URL for the release, the downloaded bytes must match the manifest
 * digest before anything is extracted or replaced — a mismatch (or an
 * unreadable/malformed manifest) deletes the downloaded file and fails the
 * update closed. Releases without any manifest still update, but the progress
 * channel carries an explicit "no checksum" warning.
 * TODO(next major): make the manifest mandatory — a release that publishes no
 * checksums will then be refused outright instead of warned about.
 *
 * @param downloadUrl - Direct URL to download the release archive.
 * @param onProgress - Optional callback invoked with progress status strings.
 * @param checksumUrl - SHA256SUMS manifest URL for the release, when known.
 * @param options - Injectable download limits (tests pass a small cap).
 * @returns Object indicating success or an error message on failure.
 */
export async function downloadAndReplaceStandaloneBinary(
  downloadUrl: string,
  onProgress?: (text: string) => void,
  checksumUrl?: string,
  options: StandaloneDownloadOptions = {},
): Promise<{ success: boolean; error?: string }> {
  const maxAssetBytes = options.maxAssetBytes ?? MAX_ASSET_BYTES
  const controller = new AbortController()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  const timeout = setTimeout(() => controller.abort(), STANDALONE_DOWNLOAD_TIMEOUT_MS)
  const tempDir = join(
    process.env.DSH_TUI_STANDALONE_CACHE ?? join(homedir(), '.cache', 'dsh-tui-standalone'),
    `.update-${Date.now()}-${process.pid}`,
  )
  try {
    signal.throwIfAborted()
    const currentBinary = getStandaloneBinaryPath()
    const targetDir = dirname(currentBinary)
    const assetName = getStandaloneAssetName()
    const isZip = assetName.endsWith('.zip')
    mkdirSync(tempDir, { recursive: true })
    const downloadPath = join(tempDir, assetName)

    onProgress?.(`downloading: ${downloadUrl}`)
    const response = await fetch(downloadUrl, {
      headers: { 'user-agent': 'dsh-tui-updater' },
      redirect: 'follow',
      signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    // Size cap, part 1: the declared length rejects before a single body byte
    // is buffered. Part 2 (the streaming loop below) aborts a chunked
    // response mid-transfer at the same cap — a stream without a
    // content-length header never gets buffered whole.
    const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declaredLength) && declaredLength > maxAssetBytes) {
      throw new Error(`release asset declares ${declaredLength} bytes, over the ${maxAssetBytes} download cap`)
    }
    if (response.body === null) {
      throw new Error('release asset response has no body stream')
    }
    // Size cap, part 2: stream the body and abort the connection the moment
    // the running total passes the cap. The read-then-check pattern this
    // replaces buffered the whole transfer first (a 96MB headerless response
    // was measured resident at ~3x before the check ran), so a hostile
    // unbounded stream could OOM the process; now the excess is never read.
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      received += value.byteLength
      if (received > maxAssetBytes) {
        controller.abort()
        try { await reader.cancel() } catch { /* already aborted */ }
        throw new Error(`release asset streamed past ${received} bytes, over the ${maxAssetBytes} download cap`)
      }
      chunks.push(Buffer.from(value))
    }
    const buffer = Buffer.concat(chunks, received)
    writeFileSync(downloadPath, buffer)

    if (checksumUrl === undefined) {
      // Transition period: releases published before the checksum workflow
      // carry no manifest. Continue, but say so — silent degradation is how
      // the unverified-download window survived review in the first place.
      onProgress?.('warning: release publishes no SHA256SUMS — asset integrity cannot be verified (this will become a hard failure in the next major version)')
    } else {
      onProgress?.('verifying checksum…')
      const manifest = await fetchChecksumManifest(
        checksumUrl,
        options.maxChecksumManifestBytes ?? MAX_CHECKSUM_MANIFEST_BYTES,
        signal,
      )
      if (!verifyAssetChecksum(buffer, manifest, assetName)) {
        // Fail closed: never leave a mismatching (potentially hostile) asset
        // on disk for a later retry to pick up, and never extract it.
        try { rmSync(downloadPath, { force: true }) } catch { /* already gone */ }
        throw new Error('SHA256 checksum mismatch: downloaded asset does not match the release SHA256SUMS manifest')
      }
      onProgress?.('checksum verified')
    }

    onProgress?.('extracting…')
    signal.throwIfAborted()
    const extractDir = join(tempDir, 'extracted')
    mkdirSync(extractDir, { recursive: true })

    if (isZip) {
      if (process.platform === 'win32') {
        // Array argv both ways: tar.exe (Win10+ bsdtar) has no shell quoting
        // surface, and the Expand-Archive fallback escapes both paths as
        // single-quoted literals — the paths derive from user environment
        // variables, so a raw `'` must never reach the command text.
        const plan = windowsExtractPlan(downloadPath, extractDir, windowsTarAvailable())
        execFileSync(plan.tool, plan.args)
      } else {
        execFileSync('unzip', ['-o', downloadPath, '-d', extractDir])
      }
    } else {
      execFileSync('tar', ['-xzf', downloadPath, '-C', extractDir])
    }

    // Zip-slip / symlink guard (see validateExtractedTree): nothing from the
    // archive may be followed out of the extract dir before the replace.
    const treeCheck = validateExtractedTree(extractDir)
    if (!treeCheck.ok) {
      throw new Error(`unsafe release archive rejected: ${treeCheck.reason ?? 'unknown extraction anomaly'}`)
    }

    const binaryName = process.platform === 'win32' ? 'dsh-tui.exe' : 'dsh-tui'
    const newBinaryPath = join(extractDir, binaryName)
    if (!existsSync(newBinaryPath)) {
      throw new Error('No executable binary found in release archive')
    }
    // The replacement source itself must be a plain regular file — a symlink
    // or device at exactly the expected name is the sharpest zip-slip probe
    // (copyFileSync would follow it).
    let newBinaryStat
    try {
      newBinaryStat = lstatSync(newBinaryPath)
    } catch {
      throw new Error(`expected binary entry unreadable: ${newBinaryPath}`)
    }
    if (!newBinaryStat.isFile()) {
      throw new Error(`expected binary entry is not a regular file: ${newBinaryPath}`)
    }

    onProgress?.('replacing binary…')
    signal.throwIfAborted()
    if (process.platform !== 'win32') {
      try { chmodSync(newBinaryPath, 0o755) } catch {}
    }

    if (process.platform === 'win32') {
      const oldBinary = `${currentBinary}.old`
      try { rmSync(oldBinary, { force: true }) } catch {}
      renameSync(currentBinary, oldBinary)
      try {
        copyFileSync(newBinaryPath, currentBinary)
      } catch (copyError) {
        // Restore the original executable if copying the new binary failed.
        try { renameSync(oldBinary, currentBinary) } catch {}
        throw copyError
      }
    } else {
      const stagedTarget = join(targetDir, `.dsh-tui-new-${process.pid}`)
      copyFileSync(newBinaryPath, stagedTarget)
      chmodSync(stagedTarget, 0o755)
      renameSync(stagedTarget, currentBinary)
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
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
export async function resolveTuiUpdateTarget(signal?: AbortSignal): Promise<TuiUpdateTarget> {
  if (signal?.aborted) return { kind: 'unknown' }
  const current = installedTuiVersion()
  const currentVersion = current === undefined ? null : valid(current)
  if (currentVersion === null) return { kind: 'unknown' }

  if (isStandaloneRuntime()) {
    const ghRelease = await fetchGithubLatestRelease({ signal })
    if (signal?.aborted) return { kind: 'unknown' }
    const latest = ghRelease?.version ?? (await fetchLatestVersion(resolveRegistryBase(), signal))
    if (signal?.aborted) return { kind: 'unknown' }
    if (latest === undefined) return { kind: 'unknown' }
    if (!gt(latest, currentVersion)) return { kind: 'latest', current: currentVersion, isStandalone: true }
    const downloadUrl = ghRelease?.downloadUrl ?? `https://github.com/${GITHUB_REPO}/releases/download/v${latest}/${getStandaloneAssetName()}`
    // Mirror fallback (GitHub API timed out, version came from a registry):
    // the asset list — and with it the manifest URL — is lost, so probe the
    // fixed-name SHA256SUMS on the same direct-download host. Found → the
    // download verifies exactly like the primary path (a tampered asset is
    // refused); 404/absent → the transition warning path stays for releases
    // that predate the checksum workflow (every new release ships one —
    // release-bundle.yml generates it alongside the assets).
    const checksumUrl = ghRelease !== undefined
      ? ghRelease.checksumUrl
      : await probeChecksumManifestUrl(releaseChecksumUrl(latest), signal)
    return checksumUrl === undefined
      ? { kind: 'update', current: currentVersion, latest, isStandalone: true, downloadUrl }
      : { kind: 'update', current: currentVersion, latest, isStandalone: true, downloadUrl, checksumUrl }
  }

  const registryBase = resolveRegistryBase()
  const [latest, official] = await Promise.all([
    fetchLatestVersion(registryBase, signal),
    registryBase === DEFAULT_REGISTRY ? undefined : fetchLatestVersion(DEFAULT_REGISTRY, signal),
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
  // Callers start this during the first render; the first `fetch()` loads
  // undici synchronously, so yield first and let that cost land after the frame.
  await new Promise<void>(resolve => setImmediate(resolve))
  const target = await resolveTuiUpdateTarget()
  return target.kind === 'update'
    ? {
        current: target.current,
        latest: target.latest,
        isStandalone: target.isStandalone,
        downloadUrl: target.downloadUrl,
        checksumUrl: target.checksumUrl,
      }
    : undefined
}

interface ProcessOptions {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Needed only for .cmd launchers on Windows (they cannot spawn directly). */
  shell?: boolean
  /**
   * Receives each stderr chunk while output still flows to the terminal, so
   * the caller can classify failures (issue #225's transient-race retry).
   */
  onStderr?: (chunk: string) => void
  /** Cleanup uncertainty forbids another installer or a replacement process. */
  onCleanupError?: () => void
  /**
   * The runner itself stopped the process tree (signal, Ctrl+C, timeout kill).
   * A child that exits 130/143/129 on its own is a real failure: its exit code
   * is indistinguishable from a stop, so only this event proves cancellation.
   */
  onCancel?: () => void
  /** Installer category recorded on every lifecycle event (restart.log). */
  category?: string
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
  return runInstallerProcess(command, args, {
    ...options,
    category: options.category ?? 'profile-install',
    onStdout: text => { process.stdout.write(text) },
    onStderr: text => {
      process.stderr.write(text)
      options.onStderr?.(text)
    },
    onEvent: event => {
      if (event.stage === 'cleanup-error') options.onCleanupError?.()
      if (event.stage === 'cancel') options.onCancel?.()
      logRestartEvent('update installer', { ...event })
      if (event.stage === 'timeout' || event.stage === 'cancel' || event.stage === 'cleanup-error' || event.stage === 'error') {
        writeHandoffNotice(`dsh-tui: installer ${event.stage}; category=${event.category} pid=${event.pid ?? 'unavailable'} last-output=${event.lastOutputAt === undefined ? 'none' : new Date(event.lastOutputAt).toISOString()}${event.message === undefined ? '' : `: ${event.message}`}\n`)
        // The profile installer is the only step whose failure leaves an
        // unusable install; the launcher step is best effort and the update
        // still restarts, and the engine step is verified separately (a
        // compatible combination may still restart, see updateTui).
        writeHandoffNotice(event.category === 'launcher-install'
          ? 'The global launcher may still be outdated; align it manually if a later launch reports it.\n'
          : event.category === 'host-install'
            ? 'The dsh engine install may be partial; /update will verify it before restarting.\n'
            : 'Installation may be partial. Check/repair the profile before resuming; no automatic restart.\n')
      }
    },
  })
}

/** Build the profile-manager command, preferring a preflight-pinned version. */
export function tuiUpdatePluginArgs(profile: string, targetVersion?: string): string[] {
  return targetVersion === undefined
    ? ['plugin', '--profile', profile, 'update', '--latest', PACKAGE_NAME]
    : ['plugin', '--profile', profile, 'update', `${PACKAGE_NAME}@${targetVersion}`]
}

/**
 * Postinstall-only transitive dependencies of the dsh profile chain
 * (dsh-llm-pi-ai → @earendil-works/pi-ai → @google/genai + protobufjs, plus the
 * esbuild/koffi peers of that chain): pnpm ≥11 refuses to run their build
 * scripts unless the workspace allowlists them, and a profile that never
 * opted in fails the WHOLE install with ERR_PNPM_IGNORED_BUILDS. None of
 * these scripts is needed at runtime (the repo root allowBuilds them all to
 * `false`), so the update flow pre-seeds the profile's pnpm-workspace.yaml
 * with explicit `false` entries — an explicit decision pnpm honors silently.
 */
const PROFILE_ALLOW_BUILDS: Readonly<Record<string, false>> = {
  '@google/genai': false,
  esbuild: false,
  koffi: false,
  protobufjs: false,
}

/** The profile's pnpm-workspace.yaml (`$DSH_HOME ?? ~/.dsh` layout). */
export function profileWorkspaceYamlPath(profile: string): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'profiles', profile, 'pnpm-workspace.yaml')
}

/** What ensureProfileAllowBuilds did to the profile workspace file. */
export interface AllowBuildsOutcome {
  /** Keys already present before this run (left untouched). */
  existing: string[]
  /** Keys this run appended. */
  added: string[]
}

/** YAML key spelling for an allowBuilds entry (scoped names need quotes). */
function allowBuildsKeyLine(key: string): string {
  const needsQuotes = key.includes('@') || key.includes('/')
  return `  ${needsQuotes ? `'${key}'` : key}: false`
}

/**
 * Make sure the profile's pnpm-workspace.yaml carries explicit `false`
 * allowBuilds entries for the dsh-tui chain's postinstall-only deps, so a
 * pnpm ≥11 update is not killed by ERR_PNPM_IGNORED_BUILDS. Best effort and
 * idempotent: existing entries are never overwritten (an explicit user
 * decision wins), a missing `allowBuilds:` block is appended, and a missing
 * file is created. Returns undefined when the profile directory is absent or
 * the file could not be updated — the caller still runs pnpm, whose own
 * ERR_PNPM_IGNORED_BUILDS diagnostic stays the visible fallback.
 */
export function ensureProfileAllowBuilds(profile: string): AllowBuildsOutcome | undefined {
  return ensureWorkspaceAllowBuilds(profileWorkspaceYamlPath(profile))
}

/** Path-based core of {@link ensureProfileAllowBuilds} for callers that hold
 *  the profile directory itself (the Claude SDK installer's heal pass). */
export function ensureWorkspaceAllowBuilds(yamlPath: string): AllowBuildsOutcome | undefined {
  try {
    if (!existsSafe(dirname(yamlPath))) return undefined
    let text = ''
    try {
      text = readFileSync(yamlPath, 'utf8')
    } catch {
      // Missing file — start from an empty document; writeFileSync creates it.
    }
    const lines = text.split(/\r?\n/u)
    let blockStart = -1
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line !== '' && line === line.trimStart() && /^allowBuilds:/u.test(line)) {
        blockStart = i
        break
      }
    }
    const present = new Set<string>()
    if (blockStart !== -1) {
      for (let i = blockStart + 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === '' || line === line.trimStart()) break // dedent = block ends
        const keyMatch = /^\s+('?)(.+?)\1:\s/u.exec(line)
        if (keyMatch !== null) present.add(keyMatch[2])
      }
    }
    const added = Object.keys(PROFILE_ALLOW_BUILDS).filter(key => !present.has(key))
    if (added.length === 0) return { existing: [...present], added }
    const insert = added.map(allowBuildsKeyLine)
    if (blockStart !== -1) {
      // Append after the block's last existing entry (before the next
      // top-level key), so existing entries keep their position.
      let blockEnd = blockStart + 1
      for (let i = blockStart + 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === '' || line === line.trimStart()) break
        blockEnd = i + 1
      }
      lines.splice(blockEnd, 0, ...insert)
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      lines.push('allowBuilds:', ...insert)
    }
    writeFileSync(yamlPath, `${lines.join('\n')}\n`)
    return { existing: [...present], added }
  } catch {
    return undefined
  }
}

/** What ensureProfileReleaseAgeExclude did to the profile workspace file. */
export interface ReleaseAgeExcludeOutcome {
  /** Final exclude entries after the run (ours plus preserved foreign ones). */
  entries: string[]
  /** True when the file was written (entry added or stale entry replaced). */
  changed: boolean
}

/**
 * pnpm ≥11 delays installs of packages published within `minimumReleaseAge`
 * (24h by default) — on release day that gate refuses the very version
 * `/update` is installing (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION), which
 * reads to the user as a broken update until the window passes. Pre-seed the
 * profile's pnpm-workspace.yaml with release-age exclusions scoped to this
 * package at the exact versions pnpm verifies before it can swap the package:
 * the target version itself, plus `alsoExempt` — the pre-update `updatedFrom`,
 * read from the running package's own manifest (normally the version the
 * profile lockfile pins). Two releases inside the 24h window leave the OLD
 * lockfile entry inside it too, and pnpm fails the whole policy check on that
 * entry before replacing the package (issue #1205), so exempting only the
 * target is not enough. Same best-effort,
 * idempotent pattern as {@link ensureProfileAllowBuilds}: entries for this
 * package track exactly the versions the current update needs (older own
 * entries are dropped instead of accumulating), foreign entries are
 * preserved, a missing `minimumReleaseAgeExclude` block is appended, a
 * missing file is created, and an absent profile directory resolves to
 * undefined — the caller still runs pnpm, whose own diagnostic stays the
 * visible fallback. Both versions share ONE entry, `pkg@<target> || <from>`:
 * pnpm 11.5.x–11.7.x honour only the FIRST entry per package (later entries
 * for the same package are ignored), so two entries leave the old lockfile
 * version unexempted there whatever their order — the `pnpm update` dsh runs
 * for `/update` fails on it (issue #1605) — while 11.10+ applies every entry.
 * A version union is read whole by both. Both exemptions come from the
 * manifest, not from `pnpm-lock.yaml`: a profile whose manifest and lockfile
 * diverged keeps the lockfile's entry unexempted.
 *
 * @param profile - The dsh profile whose workspace file is seeded.
 * @param version - The update target (exact version).
 * @param alsoExempt - Optional second version to keep exempt, normally the
 *   pre-update `updatedFrom`; ignored when empty or equal to `version`.
 */
export function ensureProfileReleaseAgeExclude(
  profile: string,
  version: string,
  alsoExempt?: string,
): ReleaseAgeExcludeOutcome | undefined {
  const yamlPath = profileWorkspaceYamlPath(profile)
  try {
    if (!existsSafe(dirname(yamlPath))) return undefined
    let text = ''
    try {
      text = readFileSync(yamlPath, 'utf8')
    } catch {
      // Missing file — start from an empty document; writeFileSync creates it.
    }
    const entry = `${PACKAGE_NAME}@${version}`
    const keep = alsoExempt !== undefined && alsoExempt !== '' && alsoExempt !== version
      ? [`${entry} || ${alsoExempt}`]
      : [entry]
    const lines = text.split(/\r?\n/u)
    let blockStart = -1
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line !== '' && line === line.trimStart() && /^minimumReleaseAgeExclude:/u.test(line)) {
        blockStart = i
        break
      }
    }
    /** Item text of a list line, unquoted (`- 'x@1'` / `- x@1` → `x@1`). */
    const itemOf = (line: string): string => line.trim().replace(/^-\s*/u, '').replace(/^'(.*)'$/u, '$1')
    /** Foreign exclusion lines, preserved verbatim and in file order. */
    const foreignLines: string[] = []
    /** Keep-set entries already present in the block. */
    const present: string[] = []
    let droppedStale = false
    let blockEnd = -1
    if (blockStart !== -1) {
      blockEnd = blockStart + 1
      for (let i = blockStart + 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === '' || line === line.trimStart()) break // dedent = block ends
        blockEnd = i + 1
        const item = itemOf(line)
        if (!item.startsWith(`${PACKAGE_NAME}@`)) {
          foreignLines.push(line)
        } else if (keep.includes(item)) {
          present.push(item)
        } else {
          // Own entries for older targets: dropped (no accumulation).
          droppedStale = true
        }
      }
    }
    const missing = keep.filter(item => !present.includes(item))
    if (!droppedStale && missing.length === 0) {
      return { entries: [...foreignLines.map(itemOf), ...present], changed: false }
    }
    // Own entries are re-rendered from the keep set instead of copied as
    // found, so a pre-#1605 two-entry pair collapses into the single union.
    const insert = foreignLines.concat(keep.map(item => `  - '${item}'`))
    if (blockStart !== -1) {
      lines.splice(blockStart + 1, blockEnd - blockStart - 1, ...insert)
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      lines.push('minimumReleaseAgeExclude:', ...insert)
    }
    writeFileSync(yamlPath, `${lines.join('\n')}\n`)
    return { entries: insert.map(itemOf), changed: true }
  } catch {
    return undefined
  }
}

/** What ensureWorkspaceStoreDir did to the profile workspace file. */
export interface StoreDirOutcome {
  /** True when the file was written (the pin was appended). */
  readonly changed: boolean
}

/**
 * pnpm resolves its content-addressable store from the environment when no
 * explicit setting exists: a pnpm run under a redirected \u0060XDG_DATA_HOME\u0060
 * (sandbox, relay, container) silently records THAT location in the
 * profile's \u0060node_modules/.modules.yaml\u0060, and every later pnpm run in the
 * profile — dsh's own updates, plugin installs, the Claude SDK wizard —
 * dies with ERR_PNPM_UNEXPECTED_STORE until node_modules is rebuilt by
 * hand. Pin \u0060storeDir\u0060 in the profile's pnpm-workspace.yaml so all of them
 * resolve the same store whatever the environment says. The value is
 * relative on purpose: pnpm resolves it against the workspace file\u0027s
 * directory, landing on \u0060<dsh home>/.pnpm-store\u0060 beside the profiles root
 * for every user and surviving a relocated \u0060DSH_HOME\u0060. Same best-effort,
 * idempotent pattern as {@link ensureProfileAllowBuilds}: an existing
 * top-level \u0060storeDir:\u0060 is never overwritten (an explicit user decision
 * wins), a missing file is created, and any failure resolves to undefined —
 * pnpm's own diagnostic stays the visible fallback, and the installer's
 * store-mismatch self-heal catches what a failed pin leaves behind.
 */
export function ensureWorkspaceStoreDir(yamlPath: string): StoreDirOutcome | undefined {
  try {
    if (!existsSafe(dirname(yamlPath))) return undefined
    let text = ''
    try {
      text = readFileSync(yamlPath, 'utf8')
    } catch {
      // Missing file — start from an empty document; writeFileSync creates it.
    }
    const lines = text.split(/\r?\n/u)
    for (const line of lines) {
      if (line !== '' && line === line.trimStart() && /^storeDir:/u.test(line)) {
        return { changed: false }
      }
    }
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
    lines.push('storeDir: ../../.pnpm-store')
    writeFileSync(yamlPath, `${lines.join('\n')}\n`)
    return { changed: true }
  } catch {
    return undefined
  }
}
function existsSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Native backends ship as platform-specific optional dependencies, and pnpm's
 * lockfile records EVERY platform's entry by design. Some pnpm update paths
 * materialize all of them — maintainer-group report 2026-09-11: a 0.10.0 →
 * 0.10.1 update downloaded ~90MB of win32/darwin/musl/riscv64/s390x/ppc64
 * sharp binaries on a linux-x64 box; a 0.15 → 0.16 dsh-tui update then pulled
 * seven foreign `@anthropic-ai/claude-agent-sdk-*` bundles (~230MB each,
 * ~1.6GB) the same way. The fix keeps `ignoredOptionalDependencies` patterns
 * for every OTHER platform in the profile: pnpm skips ignored optionals
 * entirely (no download, no node_modules entry), while the current platform's
 * packages — the only ones these backends load — stay untouched.
 *
 * Each table mirrors its package's published platform matrix for the pinned
 * version. A suffix the package adds later only costs the saving for that
 * platform, never a broken install: an unknown suffix is simply not listed
 * here, so it is never ignored.
 */
const SHARP_WRAPPER_SUFFIXES = [
  'darwin-arm64', 'darwin-x64', 'freebsd-wasm32', 'linux-arm', 'linux-arm64',
  'linux-ppc64', 'linux-riscv64', 'linux-s390x', 'linux-x64',
  'linuxmusl-arm64', 'linuxmusl-x64',
  'win32-arm64', 'win32-ia32', 'win32-x64',
] as const
const SHARP_LIBVIPS_SUFFIXES = [
  'darwin-arm64', 'darwin-x64', 'linux-arm', 'linux-arm64',
  'linux-ppc64', 'linux-riscv64', 'linux-s390x', 'linux-x64',
  'linuxmusl-arm64', 'linuxmusl-x64',
] as const

/**
 * The @img suffix of the RUNNING platform: musl linux maps to linuxmusl, and
 * FreeBSD — which has no native @img build — maps to the only form it can load.
 * Without that mapping a FreeBSD update would ignore `@img/sharp-freebsd-wasm32`
 * and leave sharp with nothing to load.
 */
export function sharpCurrentSuffix(platform: string, cpu: string, libc: string): string {
  if (platform === 'freebsd') return 'freebsd-wasm32'
  const os = platform === 'linux' && libc === 'musl' ? 'linuxmusl' : platform
  return `${os}-${cpu}`
}

/**
 * Deliberate omission: sharp's registry matrix (0.35.3) also carries the
 * platform-agnostic `wasm32` fallback (~9MB unpacked) plus
 * `webcontainers-wasm32`. They carry no os constraint, so they resolve on
 * every platform — including architectures with no native @img build at all
 * (loong64 etc.), where wasm is the only working form. They are therefore
 * NOT ignored: updates keep downloading them, trading ~9MB for not breaking
 * sharp on fallback-only architectures.
 */

/** Patterns for every @img platform package EXCEPT the running one. */
export function ignoredSharpOptionalPatterns(platform: string, cpu: string, libc: string): string[] {
  const current = sharpCurrentSuffix(platform, cpu, libc)
  return [
    ...SHARP_WRAPPER_SUFFIXES.filter(s => s !== current).map(s => `@img/sharp-${s}`),
    ...SHARP_LIBVIPS_SUFFIXES.filter(s => s !== current).map(s => `@img/sharp-libvips-${s}`),
  ]
}

/**
 * `@anthropic-ai/claude-agent-sdk` carries the Claude CLI as one native bundle
 * per platform in its optionalDependencies. The SDK is an on-demand backend —
 * the kernel picker adds it to a profile only when the user picks Claude — but
 * once it IS there, an update re-resolves it through the same pnpm path that
 * materializes every platform's optional (see the sharp report above), so the
 * same ignore list keeps only this platform's bundle. Suffixes mirror the
 * pinned SDK version's published matrix, musl variants included.
 */
const CLAUDE_SDK_PREFIX = '@anthropic-ai/claude-agent-sdk-'
const CLAUDE_SDK_SUFFIXES = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl',
  'win32-arm64', 'win32-x64',
] as const

/** The SDK bundle suffix of the RUNNING platform (musl linux adds `-musl`). */
export function claudeSdkCurrentSuffix(platform: string, cpu: string, libc: string): string {
  const musl = platform === 'linux' && libc === 'musl'
  return `${platform}-${cpu}${musl ? '-musl' : ''}`
}

/** Patterns for every SDK bundle EXCEPT the running one. */
export function ignoredClaudeSdkOptionalPatterns(platform: string, cpu: string, libc: string): string[] {
  const current = claudeSdkCurrentSuffix(platform, cpu, libc)
  return CLAUDE_SDK_SUFFIXES.filter(s => s !== current).map(s => `${CLAUDE_SDK_PREFIX}${s}`)
}

/** Patterns for every known native package this platform does not load. */
export function ignoredForeignPlatformPatterns(platform: string, cpu: string, libc: string): string[] {
  return [
    ...ignoredSharpOptionalPatterns(platform, cpu, libc),
    ...ignoredClaudeSdkOptionalPatterns(platform, cpu, libc),
  ]
}

/**
 * Libc verdict for an explicit platform, so the whole matrix is testable on any
 * host. Node's report wins when present: a stray musl loader (Debian's musl
 * package, cross-compile toolchains) on a glibc system must NOT flip the
 * verdict, or the current platform's own packages would land in the ignore
 * list. The loader-path probe only answers when the report is unavailable (the
 * same fallback sharp's detect-libc uses); a non-Linux platform is always glibc.
 */
export function detectLibc(
  platform: string,
  report: { header?: { glibcVersionRuntime?: string } } | undefined,
  muslLoaderPresent: boolean,
): 'glibc' | 'musl' {
  if (platform !== 'linux') return 'glibc'
  if (report?.header?.glibcVersionRuntime !== undefined) return 'glibc'
  return muslLoaderPresent ? 'musl' : 'glibc'
}

/** The running libc, via detectLibc's precedence (report first, paths last). */
function isMuslRuntime(): boolean {
  const report = (process.report as NodeJS.ProcessReport | undefined)?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined
  return detectLibc(
    process.platform,
    report,
    existsSafe('/lib/ld-musl-x86_64.so.1') || existsSafe('/lib/ld-musl-aarch64.so.1') || existsSafe('/etc/alpine-release'),
  ) === 'musl'
}

/** Every native package this module's tables cover (sharp wrappers/libvips and SDK bundles). */
const MANAGED_OPTIONAL_PATTERNS: ReadonlySet<string> = new Set([
  ...SHARP_WRAPPER_SUFFIXES.map(s => `@img/sharp-${s}`),
  ...SHARP_LIBVIPS_SUFFIXES.map(s => `@img/sharp-libvips-${s}`),
  ...CLAUDE_SDK_SUFFIXES.map(s => `${CLAUDE_SDK_PREFIX}${s}`),
])

/**
 * The package name a list entry names, whatever spelling pnpm accepts: an
 * optional leading `-`, either quote style, and a trailing comment outside the
 * quotes. Returns undefined for a line that carries no scalar (a nested key),
 * which callers must treat as "not ours". Comparing names rather than raw
 * lines is what keeps a hand-edited block (`- "@img/sharp-…" # keep`, a blank
 * line inside the list) from being mistaken for a user entry and preserved —
 * that mistake would leave THIS platform's own package ignored.
 */
function optionalDependencyNameOf(line: string): string | undefined {
  const body = line.trim().replace(/^-\s*/u, '')
  if (body === '') return undefined
  const quote = body.startsWith("'") || body.startsWith('"') ? body[0] : undefined
  if (quote !== undefined) {
    const end = body.indexOf(quote, 1)
    return end === -1 ? undefined : body.slice(1, end)
  }
  const commentAt = body.search(/\s#/u)
  const name = (commentAt === -1 ? body : body.slice(0, commentAt)).trim()
  return name === '' ? undefined : name
}

/** What ensurePlatformFilterAt did to a profile workspace file. */
export interface PlatformFilterOutcome {
  /** The foreign-platform ignore patterns the file now carries. */
  entries: string[]
  /** True when the file was written (filter added or refreshed). */
  changed: boolean
}

/**
 * Keep an `ignoredOptionalDependencies:` block in a profile's
 * pnpm-workspace.yaml listing every native package this platform does not
 * load — the foreign-platform sharp natives and Claude SDK bundles — so an
 * update (or an on-demand kernel install) stops downloading them. The list is
 * recomputed on every run: it is a fact about the machine running pnpm, so a
 * profile carried to another platform (WSL, a musl container, a new cpu) gets
 * a fresh list instead of a stale one that would skip the packages that
 * machine needs. Entries this module's own tables cover are rewritten (by
 * package name, so quoted forms, trailing comments and blank lines inside the
 * block all still refresh); every other entry — a user's `fsevents`, a native
 * package a backend adds later, a user's own `@img/sharp-wasm32` exemption —
 * is preserved verbatim, same as in {@link ensureProfileAllowBuilds}. Best
 * effort and idempotent: the file is written only when the resulting block
 * actually differs, a missing `ignoredOptionalDependencies:` block is
 * appended, and an absent directory resolves to undefined — the caller still
 * runs pnpm, only the download-size win is lost. A document this function
 * cannot rewrite safely (a flow-style value, a duplicated key, which is
 * already invalid YAML) is left untouched rather than half-rewritten. Residual
 * caveat shared by any persisted machine fact: a second platform using the
 * same profile without running either path keeps this platform's list, so its
 * own binaries stay skipped until the next update or install there.
 */
export function ensurePlatformFilterAt(yamlPath: string): PlatformFilterOutcome | undefined {
  try {
    if (!existsSafe(dirname(yamlPath))) return undefined
    let text = ''
    try {
      text = readFileSync(yamlPath, 'utf8')
    } catch {
      // Missing file — start from an empty document; writeFileSync creates it.
    }
    const lines = text === '' ? [] : text.split(/\r?\n/u)
    let blockStart = -1
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === '' || line !== line.trimStart() || !/^ignoredOptionalDependencies:/u.test(line)) continue
      // A value on the key line itself (flow style `[a, b]`) is a list this
      // block rewriter would duplicate rather than refresh, and a second such
      // key is already invalid YAML — leave both alone, losing only the saving.
      const rest = line.slice(line.indexOf(':') + 1).trim()
      if ((rest !== '' && !rest.startsWith('#')) || blockStart !== -1) return undefined
      blockStart = i
    }
    const foreign: string[] = []
    let blockEnd = blockStart === -1 ? -1 : blockStart + 1
    if (blockStart !== -1) {
      for (let i = blockStart + 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (line.trim() === '') continue // blank lines inside a block list don't end it
        if (line === line.trimStart()) break // dedent = block ends
        blockEnd = i + 1
        const name = optionalDependencyNameOf(line)
        // Entries from our own tables (possibly computed for another platform)
        // are dropped here and recomputed below; everything else is preserved.
        if (name === undefined || !MANAGED_OPTIONAL_PATTERNS.has(name)) foreign.push(line)
      }
    }
    const patterns = ignoredForeignPlatformPatterns(process.platform, process.arch, isMuslRuntime() ? 'musl' : 'glibc')
    const insert = foreign.concat(patterns.map(p => `  - '${p}'`))
    if (blockStart !== -1 && lines.slice(blockStart + 1, blockEnd).join('\n') === insert.join('\n')) {
      return { entries: patterns, changed: false }
    }
    if (blockStart !== -1) {
      lines.splice(blockStart + 1, blockEnd - blockStart - 1, ...insert)
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      lines.push('ignoredOptionalDependencies:', ...insert)
    }
    writeFileSync(yamlPath, `${lines.join('\n')}\n`)
    return { entries: patterns, changed: true }
  } catch {
    return undefined
  }
}

/** {@link ensurePlatformFilterAt} for a profile's own workspace file. */
export function ensureProfilePlatformFilter(profile: string): PlatformFilterOutcome | undefined {
  return ensurePlatformFilterAt(profileWorkspaceYamlPath(profile))
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

/** A globally installed dsh-tui launcher, located and classified by layout. */
export interface GlobalLauncherTarget {
  /** The bin path that was resolved (the launcher process's argv[1]). */
  readonly binPath: string
  /** The launcher package directory, when the bin could be followed to it. */
  readonly packageDir: string | undefined
  /** Manifest version; undefined when unreadable or absent. */
  readonly version: string | undefined
  /**
   * `pnpm` = a pnpm install (its global group must also be proven before an
   * install); `npm` = a package with a matching npm-global bin link or shim;
   * `unknown` = a local or otherwise unproven install, which is never rewritten.
   */
  readonly layout: 'npm' | 'pnpm' | 'unknown'
  /** PNPM_HOME to drive `pnpm add -g`; derived from the layout when unset. */
  readonly pnpmHome: string | undefined
}

/** What the manifest at `dir` says, or undefined when it is not this package. */
function launcherManifest(dir: string): { readonly version: string | undefined } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!isRecord(parsed) || parsed.name !== PACKAGE_NAME) return undefined
    return { version: typeof parsed.version === 'string' ? (valid(parsed.version) ?? undefined) : undefined }
  } catch {
    return undefined
  }
}

/** True when `dir` is an installed package (inside a node_modules tree). */
function isInstalledPackageDir(dir: string): boolean {
  return /(?:^|[\\/])node_modules(?:[\\/]|$)/u.test(dir)
}

/**
 * Follow a launcher bin to the package directory it belongs to. `realpath`
 * collapses the npm bin symlink (`<prefix>/bin/dsh-tui`) onto the js file it
 * names; from either a bin file or an already-resolved package dir the walk
 * up accepts only a manifest of OUR package INSIDE a node_modules tree. That
 * last constraint is what keeps the resolver from treating a source checkout,
 * an `npm link` target or an unrelated ancestor directory as the global
 * install it may overwrite (issue #1844 review). npm's Windows layout is
 * probed beside every level, because there the shim sits directly in the
 * prefix (`%APPDATA%\npm\dsh-tui.cmd`) while the package lives in
 * `node_modules`. pnpm's global layout is probed the same way: its bins live
 * in `<pnpm home>/bin` while the packages sit in a sibling `global/` subtree.
 *
 * @param path - A launcher bin path or a launcher package directory.
 * @returns The real package directory, or undefined when it cannot be proven.
 */
function launcherTargetDir(path: string): string | undefined {
  // Callers may hand over the package directory itself (`alignGlobalLauncher`).
  // The install-root check runs on the RESOLVED path: a linked package dir
  // (`node_modules/@scope/name` → a checkout) must not pass on its logical name.
  // A named package that is not installed fails closed instead of walking on to
  // some other install that happens to sit above it.
  const direct = resolve(path)
  if (launcherManifest(direct) !== undefined) {
    try {
      const resolved = realpathSync(direct)
      return isInstalledPackageDir(resolved) ? resolved : undefined
    } catch {
      return undefined
    }
  }
  let real: string
  try {
    real = realpathSync(direct)
  } catch {
    return undefined
  }
  let dir = dirname(real)
  for (let depth = 0; depth < 8; depth++) {
    for (const candidate of [
      dir,
      join(dir, PACKAGE_NAME),
      join(dir, 'node_modules', PACKAGE_NAME),
      join(dir, 'lib', 'node_modules', PACKAGE_NAME),
      ...pnpmGlobalPackages(dir),
    ]) {
      if (launcherManifest(candidate) === undefined) continue
      let resolved: string
      try {
        resolved = realpathSync(candidate)
      } catch {
        return undefined
      }
      // A linked checkout resolves out of node_modules — never rewrite it.
      return isInstalledPackageDir(resolved) ? resolved : undefined
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * The pnpm global slots beside `dir`, as package candidates. pnpm puts global
 * bins in `<pnpm home>/bin` but the packages in a sibling `global/<n>/…`
 * (pnpm 11) or `global/v<n>/<hash>/…` (pnpm 12) subtree, so on Windows the
 * `.cmd` shim has no ancestor `node_modules` for the walk to find. Only the
 * shim's own prefix is read (bounded, never PATH or PNPM_HOME).
 */
function pnpmGlobalPackages(dir: string): string[] {
  let slots: string[]
  try {
    slots = readdirSync(join(dir, 'global')).filter(name => /^v?\d+$/u.test(name)).slice(0, 8)
  } catch {
    return []
  }
  const packages: string[] = []
  for (const slot of slots) {
    const slotDir = join(dir, 'global', slot)
    packages.push(join(slotDir, 'node_modules', PACKAGE_NAME))
    let groups: string[]
    try {
      groups = readdirSync(slotDir).filter(name => name !== 'node_modules').slice(0, 8)
    } catch {
      continue
    }
    for (const group of groups) packages.push(join(slotDir, group, 'node_modules', PACKAGE_NAME))
  }
  return packages
}

/**
 * The pnpm global install group a path belongs to, from the layout alone:
 * `<pnpm home>/global/<n>/node_modules/…` (pnpm 11 slots) or
 * `<pnpm home>/global/v<n>/<group>/node_modules/…` (pnpm 12's isolated
 * groups). Derived BEFORE realpath: a shim's argv[1] still names the group
 * even when the package itself resolves into a store rooted elsewhere.
 */
function pnpmGlobalGroupRoot(path: string): string | undefined {
  const match = /^(.*?[\\/]global[\\/](?:v?\d+))(?:[\\/]([^\\/]+))?[\\/]node_modules[\\/]/u.exec(resolve(path))
  if (match === null || match[1] === '') return undefined
  return match[2] === undefined ? match[1] : join(match[1], match[2])
}

/** The PNPM_HOME named by a `<home>/global/<slot>…` path. */
function pnpmHomeOf(path: string): string | undefined {
  const match = /^(.*?)[\\/]global[\\/](?:v?\d+)(?:[\\/]|$)/u.exec(resolve(path))
  return match === null || match[1] === '' ? undefined : match[1]
}

/**
 * The PNPM_HOME a launcher SHIM was installed from: pnpm writes global bins to
 * `<home>` (pnpm 11) or `<home>/bin` (pnpm 12, and Windows) beside the
 * `<home>/global/` subtree that holds the packages. With a real store link the
 * package realpath keeps no `global/` segment, so the shim is the only
 * surviving evidence — and desktop launchers, cron and supervisor-started
 * processes often inherit no PNPM_HOME at all (#1847 review).
 *
 * Only a home whose group actually owns `packageDir` is accepted, so an
 * unrelated `bin` directory on PATH is never mistaken for a pnpm home.
 */
function pnpmHomeOfBin(binPath: string, packageDir: string): string | undefined {
  let dir = dirname(resolve(binPath))
  for (let depth = 0; depth < 2; depth++) {
    if (findPnpmGroupRoot(dir, packageDir) !== undefined) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** A matching external npm bin proves more than an arbitrary node_modules path. */
function isNpmGlobalPackageDir(packageDir: string, platform: NodeJS.Platform): boolean {
  const modulesDir = dirname(dirname(packageDir))
  const prefix = platform === 'win32' ? dirname(modulesDir) : dirname(dirname(modulesDir))
  if (packageDir !== join(prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules', PACKAGE_NAME)) return false
  const bin = join(packageDir, 'bin', 'dsh-tui.js')
  for (const name of ['dsh-tui', 'dst']) {
    try {
      if (platform === 'win32') {
        // npm's cmd-shim points from the global prefix into its node_modules;
        // local npm/npx bins instead live inside node_modules/.bin.
        const shim = readFileSync(join(prefix, `${name}.cmd`), 'utf8').replaceAll('\\', '/')
        const target = `node_modules/${PACKAGE_NAME}/bin/dsh-tui.js`
        if (shim.includes(`%dp0%/${target}`) || shim.includes(`%~dp0/${target}`)) return true
      } else if (realpathSync(join(prefix, 'bin', name)) === realpathSync(bin)) {
        return true
      }
    } catch {
      // A missing or foreign external bin does not prove a global install.
    }
  }
  return false
}

/** Classify only a proven global installation as writable. */
function launcherLayout(
  packageDir: string,
  binPath?: string,
  platform: NodeJS.Platform = process.platform,
): Pick<GlobalLauncherTarget, 'layout' | 'pnpmHome'> {
  // The logical bin/group owns the install, even when its shared store lives
  // under another PNPM_HOME. Store containment is never ownership evidence.
  const groupRoot = (binPath === undefined ? undefined : pnpmGlobalGroupRoot(binPath))
    ?? pnpmGlobalGroupRoot(packageDir)
  if (groupRoot !== undefined) {
    try {
      if (realpathSync(join(groupRoot, 'node_modules', PACKAGE_NAME)) === packageDir) {
        return { layout: 'pnpm', pnpmHome: pnpmHomeOf(groupRoot) }
      }
    } catch {
      // The logical group cannot be verified; do not choose another home.
    }
    return { layout: 'unknown', pnpmHome: undefined }
  }
  const binHome = binPath === undefined ? undefined : pnpmHomeOfBin(binPath, packageDir)
  if (binHome !== undefined) return { layout: 'pnpm', pnpmHome: binHome }
  // A store link must never enter the npm file-copy path. Without its owning
  // global group the subsequent installer step will refuse it as unresolved.
  if (/[\\/]v\d+[\\/]links[\\/]/u.test(packageDir)) return { layout: 'pnpm', pnpmHome: undefined }
  if (/[\\/]\.pnpm[\\/]/u.test(packageDir)) return { layout: 'unknown', pnpmHome: undefined }
  return { layout: isNpmGlobalPackageDir(packageDir, platform) ? 'npm' : 'unknown', pnpmHome: undefined }
}

/** Describe one launcher bin path, or undefined when it is not this package. */
function describeLauncher(binPath: string, platform: NodeJS.Platform = process.platform): GlobalLauncherTarget | undefined {
  const packageDir = launcherTargetDir(binPath)
  if (packageDir === undefined) return undefined
  return {
    binPath,
    packageDir,
    version: launcherManifest(packageDir)?.version,
    ...launcherLayout(packageDir, binPath, platform),
  }
}

/** Each command name has its own PATH lookup; extensions are variants of it. */
function launcherBinNames(platform: NodeJS.Platform): string[][] {
  return ['dsh-tui', 'dst'].map(name => platform === 'win32' ? [`${name}.cmd`, `${name}.ps1`, name] : [name])
}

/**
 * Find the global launcher this process runs under. New shims export their
 * own bin path. Older shims export only a version, not the invoked alias:
 * each alias must resolve to the same package at exactly that version, or
 * the installation is ambiguous and must remain untouched.
 *
 * @returns the located launcher, or undefined (no launcher / can't prove which).
 */
export function resolveGlobalLauncherTarget(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GlobalLauncherTarget | undefined {
  const explicit = env[GLOBAL_LAUNCHER_PATH_ENV]
  if (explicit !== undefined && explicit !== '') return describeLauncher(explicit, platform)

  const expected = env[GLOBAL_LAUNCHER_VERSION_ENV]
  if (expected === undefined || valid(expected) === null) return undefined
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(dir => dir !== '')
  let selected: GlobalLauncherTarget | undefined
  for (const names of launcherBinNames(platform)) {
    const candidate = dirs.flatMap(dir => names.map(name => join(dir, name))).find(path => existsSync(path))
    if (candidate === undefined) continue
    const target = describeLauncher(candidate, platform)
    if (target?.version !== expected || target.packageDir === undefined) return undefined
    if (selected !== undefined && selected.packageDir !== target.packageDir) return undefined
    selected ??= target
  }
  return selected
}

/** The launcher package this process was loaded from (undefined in source layouts). */
function ownLauncherPackageDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relativePath of ['../..', '..']) {
    try {
      const candidate = resolve(here, relativePath)
      if (launcherManifest(candidate) !== undefined) return realpathSync(candidate)
    } catch {
      // The compiled-package layout may be missing in a source checkout.
    }
  }
  return undefined
}

/**
 * The launcher bin this process was started from, when argv[1] really is one.
 * The historical contract only trusted a `dsh-tui.js` argv[1]: a
 * `dsh --profile` boot has dsh's own bin there, and a real install's package
 * may sit beside a global dsh-tui that is NOT the launcher of this chain.
 */
function launcherArgvBin(): string | undefined {
  const path = process.argv[1]
  if (path === undefined || path === '') return undefined
  try {
    return basename(realpathSync(path)) === 'dsh-tui.js' ? path : undefined
  } catch {
    return undefined
  }
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
 * The destination is given explicitly by /update (issue #1844: inside the TUI
 * argv[1] is the profile copy, so the old argv[1] rule could never find the
 * global install). Without an argument the historical argv[1] behaviour is
 * kept for callers that run in the launcher's own process.
 *
 * Never downgrades: a destination at or ahead of this copy stays untouched
 * (only an unreadable version is repaired, since it cannot be proven newer).
 * Source checkouts, `npm link` targets and direct `dsh --profile` boots
 * resolve nothing — the migration is a silent no-op there. Write failures
 * (permissions, locked files) are equally silent: the launcher-alignment
 * warning remains the fallback diagnosis.
 *
 * @param target - Launcher bin path or package dir; defaults to argv[1].
 * @returns true when the global launcher files were replaced.
 */
export function migrateGlobalLauncher(target?: string): boolean {
  const launcherBin = target ?? launcherArgvBin()
  if (launcherBin === undefined) return false
  // Accept it only when it is OUR package and not the copy we are running
  // from (junction layouts collapse both onto the same real path — copying
  // onto ourselves would be a no-op at best).
  const destination = launcherTargetDir(launcherBin)
  if (destination === undefined) return false
  // pnpm keeps installs in a store behind symlinks; replacing files there
  // desyncs the next install, so only a manager-driven update is allowed.
  // Reuse the one layout classifier instead of a second copy of its patterns:
  // a layout added to `launcherLayout` must not leave this write guard behind.
  if (launcherLayout(destination, launcherBin).layout !== 'npm') return false
  const here = dirname(fileURLToPath(import.meta.url))
  let own: { dir: string; bin: Buffer; manifest: Buffer; version: string } | undefined
  // These are the same two layouts accepted by installedTuiVersion(). Read
  // both source files before replacing either destination file.
  for (const relativePath of ['../..', '..']) {
    try {
      const candidate = resolve(here, relativePath)
      const manifest = readFileSync(join(candidate, 'package.json'))
      const parsed: unknown = JSON.parse(manifest.toString('utf8'))
      if (!isRecord(parsed) || parsed.name !== PACKAGE_NAME) continue
      const version = typeof parsed.version === 'string' ? valid(parsed.version) : null
      // Without a comparable version the downgrade rule cannot be honoured.
      if (version === null) continue
      const bin = readFileSync(join(candidate, 'bin', 'dsh-tui.js'))
      if (bin.length === 0) continue
      own = { dir: realpathSync(candidate), bin, manifest, version }
      break
    } catch {
      // A missing or invalid compiled root may still be a source checkout.
    }
  }
  if (!own) return false
  // Fail closed when the real paths cannot establish distinct roots.
  if (own.dir === destination) return false
  const destinationVersion = launcherManifest(destination)?.version
  if (destinationVersion !== undefined && !isVersionNewer(own.version, destinationVersion)) return false
  try {
    // Each rename is atomic, not the pair. A partial migration returns false
    // and can be retried; the standalone bin is safe in either case. The
    // destination's mode is carried onto the staged file: a fresh inode would
    // otherwise land as 0644 under the default umask, and the npm bin symlink
    // pointing here would stop being executable (EACCES on the next launch).
    const replace = (path: string, content: Buffer, fallbackMode: number): void => {
      const staged = `${path}.dsh-tui-migrate`
      let mode = fallbackMode
      try {
        mode = statSync(path).mode & 0o777
      } catch {
        // Missing destination: the caller's fallback is the contract.
      }
      writeFileSync(staged, content, { mode })
      // writeFileSync filters the mode through umask; restore the exact bits
      // before the atomic rename so the executable bit cannot be lost.
      if (process.platform !== 'win32') chmodSync(staged, mode)
      renameSync(staged, path)
    }
    replace(join(destination, 'bin', 'dsh-tui.js'), own.bin, 0o755)
    replace(join(destination, 'package.json'), own.manifest, 0o644)
    return true
  } catch {
    // Keep the alignment warning as the permission/locked-file fallback.
    return false
  }
}

/** What the launcher step of an update could do. */
export interface LauncherAlignOutcome {
  readonly kind: 'copied' | 'installed' | 'none' | 'failed'
  readonly reason: 'absent' | 'aligned' | 'newer' | 'unresolved' | 'disabled' | 'cancelled' | 'copy' | 'install'
  /** The version this step aimed for (present on success and repair failures). */
  readonly version?: string
  /** Exact manual command to print when the step could not run. */
  readonly command?: string
  /**
   * Set when the installer's process tree could not be proven stopped. The
   * update must not report success or start a replacement in that state.
   */
  readonly cleanupUnconfirmed?: boolean
}

/**
 * pnpm flags every launcher (re)install carries, executed and printed alike.
 *
 * A GLOBAL install of the launcher has no use for its peers: every
 * `@deepseek-ai/*` peer is provided by the profile at runtime (the global copy
 * is a shim that delegates there), while pnpm's peer auto-install chases them
 * into the `@deepseek-ai/*` packages themselves, whose peer ranges point at a
 * stable 0.1.x line that is not published. The result is
 * `ERR_PNPM_NO_MATCHING_VERSION` on every attempt — so a peer-less install is
 * the only shape that works on a real registry (#1847 review). This flag is
 * safe only for a launcher-only group: applying it to other CLIs can remove
 * their required auto-installed peers. npm uses `--legacy-peer-deps`.
 */
const PNPM_LAUNCHER_FLAGS: readonly string[] = ['--config.auto-install-peers=false']

/**
 * The child environment that makes `pnpm add -g` land in `pnpmHome`: PNPM_HOME
 * itself, plus the home's own bin directories APPENDED to PATH. pnpm refuses a
 * global install whose bin dir is not on PATH
 * (`ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`) — exactly the state of a process that
 * inherited no pnpm shell setup (a desktop launcher or cron), which is the case
 * the shim-derived home exists for. Appending rather than prepending keeps the
 * user's own pnpm resolution in charge.
 */
function pnpmHomeEnv(env: NodeJS.ProcessEnv, pnpmHome: string): NodeJS.ProcessEnv {
  const key = env.PATH === undefined && env.Path !== undefined ? 'Path' : 'PATH'
  const current = env[key]
  const dirs = [join(pnpmHome, 'bin'), pnpmHome]
  return {
    PNPM_HOME: pnpmHome,
    [key]: current === undefined || current === '' ? dirs.join(delimiter) : [current, ...dirs].join(delimiter),
  }
}

/** The manual launcher command for a layout (the documented fallback, §10). */
function launcherManualCommand(layout: 'npm' | 'pnpm', version: string, specs?: readonly string[]): string {
  if (layout === 'npm') return `npm install -g --legacy-peer-deps ${PACKAGE_NAME}@${version}`
  // Only a proven launcher-only group has a safe one-shot repair command.
  // Rebuilding a larger group with launcher-specific peer suppression can
  // break its other CLIs even when their direct versions stay unchanged.
  const add = `pnpm add -g ${PNPM_LAUNCHER_FLAGS.join(' ')}`
  return specs !== undefined
    ? `${shellEnvPrefix(PNPM_RELEASE_AGE_ENV)}${add} ${specs.join(',')}`
    : `pnpm list -g --depth 0\n  Inspect the install group before aligning ${PACKAGE_NAME}@${version}. Preserve every member and its installed peers; use a separate global prefix if reinstalling the launcher alone.`
}

/**
 * Locate the pnpm global group whose `node_modules` realpath is `packageDir`.
 * The bin path usually names the group directly; this walk covers older
 * shims and the Windows `.cmd` layout, where only the package realpath is
 * known. Bounded to the global slots pnpm itself creates.
 */
function findPnpmGroupRoot(pnpmHome: string, packageDir: string): string | undefined {
  let slots: string[]
  try {
    slots = readdirSync(join(pnpmHome, 'global')).filter(name => /^v?\d+$/u.test(name)).slice(0, 8)
  } catch {
    return undefined
  }
  for (const slot of slots) {
    const slotDir = join(pnpmHome, 'global', slot)
    const candidates = [slotDir]
    try {
      for (const name of readdirSync(slotDir)) {
        if (name !== 'node_modules' && candidates.length < 9) candidates.push(join(slotDir, name))
      }
    } catch {
      continue
    }
    for (const root of candidates) {
      try {
        if (realpathSync(join(root, 'node_modules', PACKAGE_NAME)) === packageDir) return root
      } catch {
        // Not this group.
      }
    }
  }
  return undefined
}

/**
 * A dependency spec that can be re-created from the registry by package name
 * and version. Dist-tags, aliases (`npm:`), local links (`file:`/`link:`),
 * Git and tarball sources are not reproducible from the install state, so a
 * group containing one cannot be rebuilt safely.
 */
function isRegistryVersionSpec(spec: unknown): spec is string {
  return typeof spec === 'string' && spec.trim() !== '' && validRange(spec) !== null
}

/**
 * The install spec for a proven launcher-only pnpm global group.
 * `pnpm add -g` replaces the whole group (pnpm 11+), and re-adding siblings
 * without auto-installing peers cannot preserve their runtime dependencies.
 * Multi-member or unprovable groups stay untouched instead of reconstructing
 * a dependency closure from their direct package versions.
 */
function pnpmGroupSpecs(target: GlobalLauncherTarget, version: string): string[] | undefined {
  const groupRoot = pnpmGlobalGroupRoot(target.binPath)
    ?? (target.packageDir === undefined ? undefined : pnpmGlobalGroupRoot(target.packageDir))
    ?? (target.pnpmHome === undefined || target.packageDir === undefined
      ? undefined
      : findPnpmGroupRoot(target.pnpmHome, target.packageDir))
  if (groupRoot === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(groupRoot, 'package.json'), 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed.dependencies)) return undefined
    const names = Object.keys(parsed.dependencies)
    if (names.length !== 1 || names[0] !== PACKAGE_NAME) return undefined
    // A local, alias, Git or tarball source is not a registry install we may
    // replace by name, even when it is the group's only direct dependency.
    if (!isRegistryVersionSpec(parsed.dependencies[PACKAGE_NAME])) return undefined
    return [`${PACKAGE_NAME}@${version}`]
  } catch {
    return undefined
  }
}

/**
 * Align the global launcher with this (already updated) profile copy.
 *
 * npm layouts get the atomic file overwrite `migrateGlobalLauncher` has always
 * done. pnpm installs are updated with `pnpm add -g`: their bin is a shim over
 * the store, and writing through the store's symlinks would corrupt the next
 * install's bookkeeping.
 *
 * Best effort by design — a failure here only means the next launch still
 * reports the old launcher, so it returns a printable command instead of
 * failing the update.
 *
 * @param ownVersion - Version this profile now runs; the launcher target.
 * @param options - Environment override and cancellation signal.
 * @returns What happened, for the caller's message.
 */
export async function alignGlobalLauncher(
  ownVersion: string | undefined = installedTuiVersion(),
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<LauncherAlignOutcome> {
  const env = options.env ?? process.env
  if (env[UPDATE_LAUNCHER_ENV] === '0') return { kind: 'none', reason: 'disabled' }
  // Launchers >= 0.19.0 export their own bin path; 0.8.3–0.18.0 export only the
  // version (PATH fallback). With neither marker (an older shim, or the
  // headless CLI's own process) argv[1] IS the launcher bin — the historical
  // contract, and `launcherArgvBin` refuses anything else (a `dsh --profile`
  // boot's dsh bin, say) so a neighbouring global dsh-tui is never rewritten
  // by a launch that never went through it.
  const marked = env[GLOBAL_LAUNCHER_PATH_ENV] !== undefined || env[GLOBAL_LAUNCHER_VERSION_ENV] !== undefined
  let target: GlobalLauncherTarget | undefined
  if (marked) {
    target = resolveGlobalLauncherTarget(env)
  } else {
    const argvBin = launcherArgvBin()
    target = argvBin === undefined ? undefined : describeLauncher(argvBin)
  }
  const targetVersion = ownVersion === undefined ? null : valid(ownVersion)
  if (target === undefined || targetVersion === null) return { kind: 'none', reason: 'unresolved' }
  // Running from the launcher's own process (headless `dsh-tui update` invoked
  // from the profile copy, or a source checkout): there is no second install.
  if (target.packageDir !== undefined && target.packageDir === ownLauncherPackageDir()) {
    return { kind: 'none', reason: 'absent' }
  }
  if (target.version === targetVersion) return { kind: 'none', reason: 'aligned' }
  // Never downgrade: an install ahead of this copy is the user's explicit
  // choice (a newer line); only report the drift.
  if (target.version !== undefined && !isVersionNewer(targetVersion, target.version)) {
    return { kind: 'none', reason: 'newer' }
  }
  // A project-local pnpm (or dlx) install: neither a file copy nor a global
  // pnpm install would touch the copy that actually runs.
  if (target.layout === 'unknown') return { kind: 'none', reason: 'unresolved' }
  if (options.signal?.aborted) return { kind: 'none', reason: 'cancelled' }
  if (target.layout === 'pnpm') {
    // The launcher-specific peer flags are safe only for a proven singleton
    // group. Leave every multi-member or unprovable group untouched rather
    // than silently removing a sibling CLI or one of its required peers.
    const specs = pnpmGroupSpecs(target, targetVersion)
    const command = launcherManualCommand('pnpm', targetVersion, specs)
    if (specs === undefined) return { kind: 'failed', reason: 'unresolved', version: targetVersion, command }
    let cancelled = false
    let cleanupUnconfirmed = false
    const code = await runProcess('pnpm', ['add', '-g', ...PNPM_LAUNCHER_FLAGS, specs.join(',')], {
      shell: process.platform === 'win32',
      category: 'launcher-install',
      env: {
        ...env,
        ...PNPM_RELEASE_AGE_ENV,
        ...(target.pnpmHome === undefined ? {} : pnpmHomeEnv(env, target.pnpmHome)),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onCancel: () => { cancelled = true },
      onCleanupError: () => { cleanupUnconfirmed = true },
    })
    // A surviving installer may still rewrite the global install; never let
    // the update claim success or restart over it, even if the exit code
    // looked clean.
    if (cleanupUnconfirmed) {
      return { kind: 'failed', reason: 'install', version: targetVersion, command, cleanupUnconfirmed: true }
    }
    // A cancelled install is not a failure to report a repair command for. The
    // exit code alone cannot tell the two apart (an installer may exit 130 on
    // its own), so only the runner's own stop event counts.
    if (cancelled) return { kind: 'none', reason: 'cancelled' }
    if (code !== 0) return { kind: 'failed', reason: 'install', version: targetVersion, command }
    return { kind: 'installed', reason: 'install', version: targetVersion }
  }
  const command = launcherManualCommand('npm', targetVersion)
  if (target.packageDir === undefined) return { kind: 'failed', reason: 'unresolved', command }
  return migrateGlobalLauncher(target.packageDir)
    ? { kind: 'copied', reason: 'copy', version: targetVersion }
    : { kind: 'failed', reason: 'copy', version: targetVersion, command }
}

/**
 * The launcher generation marker the replacement process should carry after
 * this update: the one it inherited describes the OUTER shim that started this
 * chain, which this update may just have brought up to date. Only a completed
 * copy/install counts — a skipped or failed step leaves the inherited value
 * alone so the boot-time warning stays truthful (#1844 review).
 *
 * @param launcher - The launcher step's outcome, when it ran.
 * @returns Marker overrides for `restartChildEnv`.
 */
export function launcherRestartEnv(launcher: LauncherAlignOutcome | undefined): Record<string, string> {
  if (launcher === undefined || launcher.version === undefined) return {}
  if (launcher.kind !== 'copied' && launcher.kind !== 'installed') return {}
  const env: Record<string, string> = { [GLOBAL_LAUNCHER_VERSION_ENV]: launcher.version }
  // pnpm re-creates the global slot on every install (verified on 11.21.0:
  // `global/v11/6-…` becomes `7-…` and the old slot is pruned), so the bin
  // path this chain inherited now points at a deleted directory. Blank it:
  // the resolver treats "" as "no explicit path" and re-locates the launcher
  // through PATH, where the refreshed version marker must match exactly.
  if (launcher.kind === 'installed') env[GLOBAL_LAUNCHER_PATH_ENV] = ''
  return env
}

/** What the launcher layer of a plan needs. */
export type LauncherStep =
  | {
    readonly kind: 'none'
    readonly reason: 'aligned' | 'absent' | 'newer' | 'disabled' | 'unresolved'
    readonly from?: string
  }
  | {
    readonly kind: 'copy'
    readonly version: string
    readonly from: string | undefined
    /** The launcher package directory the atomic shim overwrite targets. */
    readonly path: string
  }
  | {
    readonly kind: 'install'
    readonly version: string
    readonly from: string | undefined
    readonly command: { readonly file: string; readonly args: readonly string[] }
  }

/**
 * One `/update` decision, computed before the TUI is torn down.
 *
 * The TUI layer reuses `resolveTuiUpdateTarget`; the engine layer is derived
 * from the TARGET TUI's enumerated `dsh-app-boot` peer range (never from the
 * running TUI's compiled constant, which may lag one release); the launcher
 * layer only reports what the existing alignment path can reach.
 */
export interface UpdatePlan {
  readonly tui: TuiUpdateTarget
  readonly host: HostStep
  readonly launcher: LauncherStep
  /** Engine usable after the plan runs; undefined = cannot tell. */
  readonly compatible: boolean | undefined
  /** The target TUI's peer range, for refusal messages. */
  readonly hostRange: string | undefined
  /** The engine version the plan was computed from. */
  readonly currentHost: string | undefined
  /**
   * The TUI would change while the engine is outside its supported line and
   * the step cannot install it: refuse before tearing the TUI down, because
   * the result may not boot.
   */
  readonly blocked: boolean
}

/** Read one installed package's version without throwing. */
function readPackageVersion(dir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!isRecord(parsed) || typeof parsed.version !== 'string') return undefined
    return valid(parsed.version) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Positive loadability proof for an installed host package: the manifest must
 * be this package AND its declared `bin.dsh` entry must exist inside the
 * directory. A readable `package.json` alone is what a half-written install
 * leaves behind, so it cannot gate a restart.
 */
function hostPackageLoadable(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!isRecord(parsed) || parsed.name !== UPSTREAM_HOST_PACKAGE || !isRecord(parsed.bin)) return false
    const entry = parsed.bin.dsh
    if (typeof entry !== 'string' || entry === '') return false
    const resolved = resolve(dir, entry)
    const root = resolve(dir)
    return resolved.startsWith(root + sep) && existsSync(resolved)
  } catch {
    return false
  }
}

/** This package's installed directory (compiled package or source checkout). */
function installedTuiPackageDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relativePath of ['../..', '..']) {
    const candidate = resolve(here, relativePath)
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'))
      if (isRecord(parsed) && parsed.name === PACKAGE_NAME) return candidate
    } catch {
      // Try the next layout.
    }
  }
  return undefined
}

/**
 * The profile's `@deepseek-ai/dsh` directory, read straight from disk.
 *
 * `installedKernelPackageDir()` goes through `import.meta.resolve`, whose
 * result Node caches for the life of the process. After a pnpm update
 * re-points the store link, the cached URL still names the OLD (often pruned)
 * store directory, so a successful engine install would verify as failed and
 * an unloadable-engine check would read a path that no longer exists. This
 * walks the two layout candidates instead: the profile's own node_modules and
 * the shared `<DSH_HOME>/profiles/node_modules` fallback tree beside it.
 *
 * @param tuiDir - This package's directory; defaults to the running copy.
 *   A seam for the regression, which builds both layouts on disk.
 * @returns The real directory of the installed host package, or undefined.
 */
export function installedKernelDirFresh(tuiDir: string | undefined = installedTuiPackageDir()): string | undefined {
  if (tuiDir === undefined) return undefined
  const nodeModules = resolve(tuiDir, '..', '..')
  for (const candidate of [
    join(nodeModules, '@deepseek-ai', 'dsh'),
    // The shared fallback tree is a sibling of the profile directory:
    // `<DSH_HOME>/profiles/node_modules`, i.e. two levels above node_modules.
    resolve(nodeModules, '..', '..', 'node_modules', '@deepseek-ai', 'dsh'),
  ]) {
    if (readPackageVersion(candidate) === undefined) continue
    try {
      return realpathSync(candidate)
    } catch {
      return candidate
    }
  }
  return undefined
}

/** One peer range out of a package manifest, when readable. */
function readPeerRange(dir: string | undefined, peer: string): string | undefined {
  if (dir === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed.peerDependencies)) return undefined
    const range = parsed.peerDependencies[peer]
    return typeof range === 'string' ? range : undefined
  } catch {
    return undefined
  }
}

/** JSON GET with the short update-check timeout; undefined on any failure. */
async function fetchRegistryJson(url: string, accept: string, signal?: AbortSignal): Promise<unknown | undefined> {
  if (signal?.aborted) return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { accept },
      signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** The peer range a specific published package version declares. */
async function fetchPackagePeerRange(
  registryBase: string,
  packageName: string,
  version: string,
  peer: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const payload = await fetchRegistryJson(`${registryBase}/${packageName}/${version}`, 'application/json', signal)
  if (!isRecord(payload) || !isRecord(payload.peerDependencies)) return undefined
  const range = payload.peerDependencies[peer]
  return typeof range === 'string' ? range : undefined
}

/** Every published version of a package (abbreviated packument). */
async function fetchPackageVersions(
  registryBase: string,
  packageName: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const payload = await fetchRegistryJson(
    `${registryBase}/${packageName}`,
    'application/vnd.npm.install-v1+json',
    signal,
  )
  if (!isRecord(payload) || !isRecord(payload.versions)) return undefined
  return Object.keys(payload.versions)
}

/**
 * The target TUI's engine range. When the target IS the installed version the
 * local manifest answers without a network round trip (the "TUI already
 * latest, only the engine lags" case must work offline-ish and fast).
 */
async function readTargetHostRange(
  registryBase: string,
  targetVersion: string,
  installedTui: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (installedTui !== undefined && targetVersion === installedTui) {
    return readPeerRange(installedTuiPackageDir(), UPSTREAM_HOST_PEER_PACKAGE)
  }
  return fetchPackagePeerRange(registryBase, PACKAGE_NAME, targetVersion, UPSTREAM_HOST_PEER_PACKAGE, signal)
}

/**
 * The host package dir when module resolution cannot see it (an exotic
 * profile layout). Loaded lazily: a normal profile resolves through
 * `installedKernelPackageDir()` and never pays for the PATH walk.
 */
async function findHostDshPackageDir(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { findHostDsh } = await import('./dsh-adapter/host-dsh.js')
    const located = findHostDsh(env)
    return 'packageDir' in located ? located.packageDir : undefined
  } catch {
    return undefined
  }
}

/** Predict the launcher step with the same resolver the alignment uses. */
function planLauncherStep(input: {
  readonly env: NodeJS.ProcessEnv
  readonly targetVersion: string
}): LauncherStep {
  const env = input.env
  if (env[UPDATE_LAUNCHER_ENV] === '0') return { kind: 'none', reason: 'disabled' }
  const marked = env[GLOBAL_LAUNCHER_PATH_ENV] !== undefined || env[GLOBAL_LAUNCHER_VERSION_ENV] !== undefined
  let target: GlobalLauncherTarget | undefined
  if (marked) {
    target = resolveGlobalLauncherTarget(env)
  } else {
    // The headless `dsh-tui update` process IS the launcher: argv[1] is its bin.
    const argvBin = launcherArgvBin()
    target = argvBin === undefined ? undefined : describeLauncher(argvBin)
  }
  if (target === undefined) {
    // A launch that carried neither marker and whose argv[1] is not a launcher
    // bin is a direct `dsh --profile` boot: this installation has no launcher
    // to align (plan §3.5), so it must not degrade the preflight to "idle".
    return { kind: 'none', reason: marked ? 'unresolved' : 'absent' }
  }
  if (target.packageDir !== undefined && target.packageDir === ownLauncherPackageDir()) {
    return { kind: 'none', reason: 'absent' }
  }
  if (target.version === input.targetVersion) return { kind: 'none', reason: 'aligned', from: target.version }
  // Never downgrade a launcher ahead of this profile (the user chose a newer line).
  if (target.version !== undefined && !isVersionNewer(input.targetVersion, target.version)) {
    return { kind: 'none', reason: 'newer', from: target.version }
  }
  if (target.packageDir === undefined || target.layout === 'unknown') {
    return { kind: 'none', reason: 'unresolved', from: target.version }
  }
  if (target.layout === 'pnpm') {
    // Match the execution path: `pnpm add -g <one package>` replaces the whole
    // isolated group, so the plan may only promise an install when every
    // member can be named (issue #1844 review R2).
    const specs = pnpmGroupSpecs(target, input.targetVersion)
    if (specs === undefined) return { kind: 'none', reason: 'unresolved', from: target.version }
    return {
      kind: 'install',
      version: input.targetVersion,
      from: target.version,
      command: { file: 'pnpm', args: ['add', '-g', specs.join(',')] },
    }
  }
  return { kind: 'copy', version: input.targetVersion, from: target.version, path: target.packageDir }
}

/**
 * Compute the whole `/update` plan without writing anything.
 *
 * Only the TUI lookup is sequential (the engine range belongs to the target
 * TUI version); the target manifest and the engine packument then run in
 * parallel, each bounded by the existing 4s update-check timeout. A failed
 * lookup degrades that layer only — it never blocks the command for longer
 * than the network allows and never fabricates a version.
 *
 * @param input - Cancellation, a pre-resolved host package dir (the entry has
 *   one), an override for the installed engine version (tests), and the env.
 */
export async function resolveUpdatePlan(input: {
  readonly signal?: AbortSignal
  readonly hostPackageDir?: string
  readonly installedHost?: string
  readonly env?: NodeJS.ProcessEnv
} = {}): Promise<UpdatePlan> {
  const env = input.env ?? process.env
  const tui = await resolveTuiUpdateTarget(input.signal)
  if (isStandaloneRuntime()) {
    // The portable binary carries its own runtime; engine/launcher layers do
    // not exist there (the standalone branch of updateTui keeps self-updating).
    return {
      tui,
      host: { kind: 'none', reason: 'disabled' },
      // The portable binary has no global launcher to align, so this is
      // "absent" (settled) - "disabled" would claim a switch was ignored.
      launcher: { kind: 'none', reason: 'absent' },
      compatible: undefined,
      hostRange: undefined,
      currentHost: undefined,
      blocked: false,
    }
  }
  // Without a target TUI version there is no range to plan an engine against;
  // keep the existing `--latest` fallback instead of guessing a line.
  if (tui.kind === 'unknown') {
    return {
      tui,
      host: { kind: 'none', reason: 'unknown-range' },
      launcher: { kind: 'none', reason: 'unresolved' },
      compatible: undefined,
      hostRange: undefined,
      currentHost: input.installedHost,
      blocked: false,
    }
  }
  const targetVersion = tui.kind === 'update' ? tui.latest : tui.current
  const registryBase = resolveRegistryBase()
  const hostPackageDir = input.hostPackageDir ?? installedKernelPackageDir() ?? await findHostDshPackageDir(env)
  const install = hostPackageDir === undefined ? undefined : detectHostInstall(hostPackageDir, env)
  const currentHost = input.installedHost ?? install?.version
  const [hostRange, available] = await Promise.all([
    readTargetHostRange(registryBase, targetVersion, installedTuiVersion(), input.signal),
    fetchPackageVersions(registryBase, UPSTREAM_HOST_PACKAGE, input.signal),
  ])
  const host = planHostStep({
    current: currentHost,
    range: hostRange,
    available,
    install,
    packageName: UPSTREAM_HOST_PACKAGE,
    disabled: env[UPDATE_ENGINE_ENV] === '0',
  })
  const compatible = hostCompatibility({ current: currentHost, allowed: parseHostLineRange(hostRange), step: host })
  return {
    tui,
    host,
    launcher: planLauncherStep({ env, targetVersion }),
    compatible,
    hostRange,
    currentHost,
    // The only combination /update must refuse: the TUI is about to move to a
    // line this engine is outside of, and the engine cannot be aligned first.
    blocked: tui.kind === 'update' && compatible === false,
  }
}

export type UpdatePlanState = 'empty' | 'ready' | 'blocked' | 'idle'

/** How the preflight should treat a plan (empty = nothing to do at all). */
export function updatePlanState(plan: UpdatePlan): UpdatePlanState {
  if (plan.blocked) return 'blocked'
  if (
    plan.tui.kind === 'update'
    || plan.tui.kind === 'unknown'
    || plan.host.kind === 'install'
    || plan.launcher.kind === 'copy'
    || plan.launcher.kind === 'install'
  ) return 'ready'
  const hostSettled = plan.host.kind === 'none'
    && (plan.host.reason === 'newest'
      || plan.host.reason === 'newer-than-validated'
      // A disabled step that carries a target means an upgrade WOULD have run;
      // calling that "already aligned" would be a lie.
      || (plan.host.reason === 'disabled' && plan.host.to === undefined))
  const launcherSettled = plan.launcher.kind === 'none'
    && plan.launcher.reason !== 'unresolved'
    // DSH_TUI_UPDATE_LAUNCHER=0 resolved nothing: reporting the set as aligned
    // would be the same lie the engine branch above refuses to tell.
    && plan.launcher.reason !== 'disabled'
  return plan.tui.kind === 'latest' && hostSettled && launcherSettled ? 'empty' : 'idle'
}

/** Human layer summary, e.g. `dsh-tui 0.18.0 → 0.19.0 · dsh 0.2.1-rc.5 → 0.2.1-rc.6`. */
export function updatePlanLayers(plan: UpdatePlan): string[] {
  const layers: string[] = []
  if (plan.tui.kind === 'update') layers.push(`dsh-tui ${plan.tui.current} → ${plan.tui.latest}`)
  // Only a step that will actually run belongs in the promise. `none` with a
  // target is a disabled or never-downgrade case: the summary must not claim
  // an engine change (and must not read like the downgrade we never do).
  if (plan.host.kind === 'install') layers.push(`dsh ${plan.host.from ?? '?'} → ${plan.host.to}`)
  if (plan.launcher.kind === 'copy' || plan.launcher.kind === 'install') {
    layers.push(`launcher ${plan.launcher.from ?? '?'} → ${plan.launcher.version}`)
  }
  return layers
}

/** The installed set, for the "already aligned" notice. */
export function updatePlanSuite(plan: UpdatePlan): string {
  const tui = plan.tui.kind === 'latest' ? plan.tui.current : installedTuiVersion()
  return [
    tui === undefined ? undefined : `dsh-tui ${tui}`,
    plan.currentHost === undefined ? undefined : `dsh ${plan.currentHost}`,
  ].filter((part): part is string => part !== undefined).join(' · ')
}

/** Why the launcher layer did not run, or undefined when it settled. */
export function describeLauncherStepReason(step: LauncherStep): string | undefined {
  if (step.kind !== 'none') return undefined
  if (step.reason === 'unresolved') return t('update-launcher-unresolved')
  if (step.reason === 'disabled') return t('update-launcher-disabled')
  return undefined
}

/** Translate why the engine layer cannot be automated right now. */
export function describeHostStepReason(step: HostStep): string {
  if (step.kind === 'install') return t('update-host-pending')
  if (step.kind === 'none') {
    switch (step.reason) {
      case 'disabled': return t('update-host-disabled')
      case 'unknown-current': return t('update-host-unknown-current')
      case 'unknown-range': return t('update-host-unknown-range')
      case 'newer-than-validated': return t('update-host-newer')
      case 'newest': return ''
    }
  }
  switch (step.reason) {
    case 'offline': return t('update-host-offline')
    case 'no-version': return t('update-host-no-version')
    case 'no-installer': return t('update-host-no-installer')
    case 'not-writable': return t('update-host-not-writable')
    case 'group-unproven': return t('update-host-group-unproven')
  }
}

/** The manual command a blocked or failed engine step points at. */
export function hostStepManual(step: HostStep): string {
  if (step.kind === 'install') return step.manual[0] ?? ''
  if (step.kind === 'unavailable') return step.manual[0] ?? ''
  if (step.kind === 'none' && step.manual !== undefined) return step.manual[0] ?? ''
  return ''
}

/** The blocked-plan refusal: full report text plus one short toast line. */
export interface BlockedUpdateMessages {
  /** Complete explanation and manual command (stderr / durable transcript). */
  readonly report: string
  /** One-line summary for the composer toast, which renders a single row. */
  readonly toast: string
}

/**
 * Build a blocked-plan refusal once, so the CLI, the stderr path and the
 * in-TUI report cannot drift. The report carries every actionable detail; the
 * toast is deliberately short because the composer renders one truncated row
 * and would otherwise hide the command behind the explanation.
 *
 * @param plan - A plan whose `blocked` flag is set.
 */
export function blockedUpdateMessages(plan: UpdatePlan): BlockedUpdateMessages {
  const tui = plan.tui.kind === 'update' ? plan.tui.latest : '?'
  return {
    report: t('update-plan-blocked', {
      tui,
      range: plan.hostRange ?? '?',
      current: plan.currentHost ?? '?',
      reason: describeHostStepReason(plan.host),
      command: hostStepManual(plan.host),
    }),
    toast: t('update-plan-blocked-toast', { tui }),
  }
}

/** What the engine execution produced, for the outcome and the CLI print. */
export interface HostUpdateOutcome {
  readonly from: string | undefined
  readonly to: string
  readonly code: number
  readonly verified: boolean
  /** The runner stopped the installer tree (user cancel), not a real failure. */
  readonly cancelled: boolean
  readonly installed?: string
  /** Version the `dsh` on PATH reports (undefined when it cannot run). */
  readonly cliVersion?: string
  /** Exact manual command to print when the step failed. */
  readonly manual: string
}

/**
 * The version `dsh --version` reports, i.e. what the NEXT launch would run.
 * Spawn failures are not evidence of a wrong install (a bare `dsh` may be a
 * wrapper, or absent in a sandbox), so they return undefined and the
 * manifest read remains the gate. Windows shells the `.cmd` shim the same way
 * the profile installer does.
 */
function probePathDshVersion(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const output = process.platform === 'win32'
      ? execFileSync(`dsh ${shellQuote(['--version']).join(' ')}`, [], {
        encoding: 'utf8', timeout: 15000, env, shell: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      : execFileSync('dsh', ['--version'], {
        encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', 'pipe', 'ignore'],
      })
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output)
    return match === null ? undefined : valid(match[1]) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Run one planned engine install and verify the version actually landed.
 *
 * The pre-install `packageDir` is the RIGHT target to write but the WRONG
 * place to read back on pnpm: a global project resolves through a
 * version-pinned store path (`…/global/<n>/node_modules/.pnpm/@deepseek-ai+dsh@<old>/…`),
 * which the successful upgrade prunes or leaves at the old version. The gate
 * therefore re-resolves the host through the profile (what the next boot
 * imports) and through `dsh --version` on PATH; the explicit-dir read is the
 * fallback only when neither can answer.
 *
 * @param step - A `host` step with kind `install`.
 * @param options - Environment, cancellation and cleanup uncertainty.
 */
export async function installHostStep(
  step: Extract<HostStep, { kind: 'install' }>,
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly signal?: AbortSignal
    readonly onCleanupError: () => void
    /**
     * Test seam: the post-install host resolution. Production omits it and
     * resolves through the profile's module fallback; the regression injects
     * old/new shapes to prove each verification term.
     */
    readonly resolveInstalled?: () => string | undefined
  },
): Promise<HostUpdateOutcome> {
  const manual = step.manual[0] ?? ''
  const command = step.command
  let cancelled = false
  const code = await runProcess(command.file, command.args, {
    // npm's Windows entry is a .cmd shim; the node restart path never uses
    // shell, but an installer does (same rule as `dsh plugin`).
    shell: process.platform === 'win32',
    category: 'host-install',
    env: command.env === undefined ? options.env : { ...options.env, ...command.env },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onCleanupError: options.onCleanupError,
    onCancel: () => { cancelled = true },
  })
  if (code !== 0) return { from: step.from, to: step.to, code, verified: false, cancelled, manual }
  const manifestVersion = readPackageVersion(step.packageDir)
  const resolveInstalled = options.resolveInstalled ?? (() => {
    const refreshedDir = installedKernelDirFresh()
    return refreshedDir === undefined ? undefined : detectHostInstall(refreshedDir, options.env).version
  })
  const resolved = resolveInstalled()
  const cliVersion = probePathDshVersion(options.env)
  const gate = resolved ?? cliVersion
  const verified = gate === undefined
    ? manifestVersion === step.to
    : gate === step.to
      && (resolved === undefined || resolved === step.to)
      && (cliVersion === undefined || cliVersion === step.to)
  return {
    from: step.from,
    to: step.to,
    code,
    verified,
    cancelled,
    ...(manifestVersion === undefined ? {} : { installed: manifestVersion }),
    ...(cliVersion === undefined ? {} : { cliVersion }),
    manual,
  }
}

/**
 * Positive proof that a FAILED engine step did not destroy the engine: the
 * next launch must have something to load. A readable manifest is NOT proof —
 * an interrupted install routinely leaves one behind while the entry point or
 * a dependency is already gone. Evidence is the `bin.dsh` entry resolving
 * inside the package (or the same for the profile's fresh resolution), or a
 * `dsh --version` that actually runs.
 *
 * @param step - The install step that failed.
 * @param result - What the failed step produced.
 * @param env - Environment used for the bounded PATH probe.
 */
function engineSurvivesFailure(
  step: Extract<HostStep, { kind: 'install' }>,
  result: HostUpdateOutcome,
  env: NodeJS.ProcessEnv,
): boolean {
  if (result.cliVersion !== undefined) return true
  if (hostPackageLoadable(step.packageDir)) return true
  const refreshedDir = installedKernelDirFresh()
  if (refreshedDir !== undefined && hostPackageLoadable(refreshedDir)) return true
  return probePathDshVersion(env) !== undefined
}

/**
 * Whether a FAILED engine step still permits the restart (§3.4 matrix).
 *
 * The plan's `compatible` field is "after the planned install" — true by
 * construction whenever an install step exists — so the failure decision must
 * look at the engine that is actually there: only a TUI that moved onto a line
 * the pre-update engine is outside of forbids the restart. An engine ahead of
 * the window is kept (never downgraded); an unknown range cannot justify a
 * refusal.
 */
export function engineFailureAllowsRestart(input: {
  readonly tuiChanged: boolean
  readonly currentHost: string | undefined
  readonly hostRange: string | undefined
}): boolean {
  if (!input.tuiChanged) return true
  const compatibility = hostCompatibility({
    current: input.currentHost,
    allowed: parseHostLineRange(input.hostRange),
    step: { kind: 'none', reason: 'disabled' },
  })
  return compatibility !== false
}

/** Outcome of the install-only half of an update (no restart). */
export interface TuiUpdateOutcome {
  /** 0 = the profile now runs the intended version; non-zero = failed. */
  code: number
  /** Version installed before the update ran (the #307 stamp). */
  updatedFrom: string
  /** Version installed after the update ran, when readable. */
  installed?: string
  /** What the global-launcher step did (undefined when it never ran). */
  launcher?: LauncherAlignOutcome
  /** What the engine step did (undefined when it never ran). */
  host?: HostUpdateOutcome
  /** The TUI layer was attempted; only then does DSH_TUI_UPDATED_FROM apply. */
  tuiChanged?: boolean
  /** The engine is usable after this run (false = drift or repair pending). */
  compatible?: boolean
}

/** What the profile-installer half produced. */
interface TuiInstallResult {
  readonly code: number
  readonly installed?: string
}

/**
 * The existing `dsh plugin update` pipeline, unchanged: pre-seed the profile
 * workspace, run the installer with its retry/EEXIST recovery, refuse the
 * 0.7.0–0.7.1 boot-deadlock range and verify the version actually advanced.
 *
 * @param updatedFrom - Version captured before the installer ran (release-age
 *   exclusion and the #307 stamp).
 */
async function installProfileTui(
  profile: string,
  targetVersion: string | undefined,
  signal: AbortSignal | undefined,
  updatedFrom: string,
): Promise<TuiInstallResult> {
  const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const updateArgs = tuiUpdatePluginArgs(profile, targetVersion)
  // pnpm ≥11 hard-fails installs whose dependency tree carries un-allowlisted
  // build scripts (ERR_PNPM_IGNORED_BUILDS). The host's pi-ai adapter pulls in
  // postinstall-only deps (@google/genai/protobufjs), so pre-seed
  // the profile workspace with explicit `false` entries before pnpm runs.
  const allowBuilds = ensureProfileAllowBuilds(profile)
  if (allowBuilds !== undefined && allowBuilds.added.length > 0) {
    process.stderr.write(
      `dsh-tui: pre-seeded profile pnpm allowBuilds (${allowBuilds.added.join(', ')}) — ` +
        'postinstall-only deps are explicitly ignored\n',
    )
  }
  // Foreign-platform natives are pure download waste (sharp ~90MB, the Claude
  // SDK's bundles ~1.6GB on the maintainer report); keep the profile's ignore
  // list matching THIS machine (each update recomputes it) so pnpm never
  // fetches them. The SDK is never ADDED here — it only enters a profile
  // through the kernel picker's guided install, and then only for the
  // platform it runs on.
  const platformFilter = ensureProfilePlatformFilter(profile)
  if (platformFilter !== undefined && platformFilter.changed) {
    process.stderr.write(
      `dsh-tui: platform filter updated (${platformFilter.entries.length} foreign-platform patterns ignored) — ` +
        `this profile's install keeps only the current platform's natives\n`,
    )
  }
  // pnpm ≥11's minimumReleaseAge (24h by default) refuses installs of
  // packages published within the window — on release day that gate rejects
  // the exact version /update pins, surfacing as a failed update that heals
  // itself a day later. Two releases inside the window (issue #1205) trip the
  // same gate on the OLD lockfile entry pnpm verifies before the swap, so
  // both the target and the still-installed updatedFrom are exempted.
  if (targetVersion !== undefined) {
    const releaseAge = ensureProfileReleaseAgeExclude(
      profile,
      targetVersion,
      updatedFrom === '' ? undefined : updatedFrom,
    )
    if (releaseAge !== undefined && releaseAge.changed) {
      const exempted = updatedFrom !== '' && updatedFrom !== targetVersion
        ? `${PACKAGE_NAME}@${targetVersion} || ${updatedFrom}`
        : `${PACKAGE_NAME}@${targetVersion}`
      process.stderr.write(
        `dsh-tui: pre-seeded profile release-age exclusion (${exempted}) — ` +
          'freshly published versions install without the 24h supply-chain delay\n',
      )
    }
  }
  let updateStderr = ''
  const capture = (chunk: string): void => { updateStderr += chunk }
  let cleanupUnconfirmed = false
  const onCleanupError = (): void => { cleanupUnconfirmed = true }
  const installerOptions = { shell: true, onStderr: capture, signal, onCleanupError }
  let updateCode = await runProcess(dsh, updateArgs, installerOptions)
  // Exit codes alone cannot prove ownership cleanup: a supervisor failure can
  // use the same code/stderr as a retryable installer failure. Never overlap
  // a surviving installer with a retry, stale-file removal, repair or restart.
  if (cleanupUnconfirmed) return { code: updateCode || 1 }
  if (signal?.aborted) return { code: 130 }
  // Transient Windows tmp-rename race (issue #225): retry the identical
  // command once — it succeeds on a clean second run, and only the
  // `_tmp_<pid>` race signature qualifies, never a real resolution error.
  if (![0, 124, 129, 130, 143].includes(updateCode) && isTransientUpdateFailure(updateStderr)) {
    process.stderr.write('dsh-tui: transient pnpm failure (Windows tmp-rename race) — retrying once…\n')
    updateStderr = ''
    updateCode = await runProcess(dsh, updateArgs, installerOptions)
    if (cleanupUnconfirmed) return { code: updateCode || 1 }
    if (signal?.aborted) return { code: 130 }
  }
  // Deterministic Linux tmp-rename race (issue #479): EEXIST never clears on
  // a plain retry (the staging-dir collision reproduces every run), and a
  // transient retry that failed again means the same leftover state. Both
  // recover by removing the stale install + staging dirs, then rerunning —
  // the field-verified workaround that takes pnpm down its fresh-install
  // path instead of renaming over the collision.
  if (![0, 124, 129, 130, 143].includes(updateCode) && (isEexistTmpRenameFailure(updateStderr) || isTransientUpdateFailure(updateStderr))) {
    const flavor = isEexistTmpRenameFailure(updateStderr) ? 'EEXIST, issue #479' : 'retry failed, issue #225'
    const removal = removeStalePackageInstall(profile)
    const stagingNote = removal.tmpDirs.length > 0 ? ` + ${removal.tmpDirs.length} staging dir(s)` : ''
    process.stderr.write(
      `dsh-tui: pnpm tmp-rename race (${flavor}) — cleared the stale install ` +
        `(package dir: ${removal.packageDir}${stagingNote}) and rerunning the update…\n`,
    )
    updateStderr = ''
    updateCode = await runProcess(dsh, updateArgs, installerOptions)
    if (cleanupUnconfirmed) return { code: updateCode || 1 }
    if (signal?.aborted) return { code: 130 }
  }
  if (updateCode !== 0) return { code: updateCode }

  // A --latest fallback (preflight failed) on a stale mirror can still land
  // on the 0.7.0–0.7.1 hard-inject range — restarting into it under an older
  // global-launcher patch is the permanent boot deadlock of issues
  // #183/#307. Refuse the restart when the version JUST moved there; a user
  // who was already on it keeps their restart (their combo demonstrably
  // boots) and gets the repair hint on the next /update instead.
  const installedNow = installedTuiVersion()
  if (signal?.aborted) return { code: 130 }
  if (installedNow !== undefined && installedNow !== updatedFrom && isBootDeadlockTarget(installedNow)) {
    process.stderr.write(
      `dsh-tui: update landed on ${installedNow}, which can permanently deadlock boot under older launcher patches ` +
        `(#183/#307) — NOT restarting into it. Repair with:\n` +
        `  dsh plugin --profile ${profile} add ${PACKAGE_NAME}@latest\n` +
        `(if the mirror has not synced the latest release yet, retry later)\n`,
    )
    return { code: 1, installed: installedNow }
  }

  // Post-update verification (issue #225): pnpm can report success yet leave
  // the profile half-updated (manifest old / lockfile new). Verify against
  // the preflight target; a full `install` reconciles lockfile →
  // node_modules, and if the mismatch survives, stop before restarting into
  // a mixed state and hand the user the exact repair command instead.
  if (targetVersion !== undefined) {
    let installed = installedTuiVersion()
    if (signal?.aborted) return { code: 130 }
    if (installed !== targetVersion) {
      const repairCode = await runProcess(dsh, ['plugin', '--profile', profile, 'install'], { shell: true, signal, onCleanupError })
      if (cleanupUnconfirmed) return { code: repairCode || 1 }
      if (signal?.aborted) return { code: 130 }
      if (repairCode !== 0) return { code: repairCode }
      installed = installedTuiVersion()
    }
    if (installed !== targetVersion) {
      process.stderr.write(
        `dsh-tui: update completed but the profile still runs ${installed ?? 'an unreadable version'} ` +
          `(expected ${targetVersion}) — the profile is half-updated. Repair manually with:\n` +
          `  dsh plugin --profile ${profile} add ${PACKAGE_NAME}@${targetVersion}\n`,
      )
      return { code: 1, installed }
    }
  }

  return { code: 0, installed: installedTuiVersion() }
}

/**
 * Whether the completed update should run the launcher alignment step.
 *
 * A plan that already proved there is no launcher (`absent`, e.g. a direct
 * `dsh --profile` boot) must not call the resolver again: it would report
 * `unresolved`, lose the one-shot LAUNCHER_ABSENT marker and print a bogus
 * warning after the restart. A disabled step stays skipped too; planned
 * copy/install work always runs, and a moved TUI re-resolves everything else.
 *
 * @param plan - The preflight plan.
 * @param tuiChanged - Whether the TUI layer actually moved.
 */
export function shouldAlignLauncher(plan: UpdatePlan, tuiChanged: boolean): boolean {
  if (plan.launcher.kind === 'copy' || plan.launcher.kind === 'install') return true
  if (plan.launcher.kind !== 'none') return false
  if (plan.launcher.reason === 'disabled' || plan.launcher.reason === 'absent') return false
  return tuiChanged
}

/**
 * Install-only half of `/update`: run `dsh plugin add` (unless the TUI is
 * already at the target), align the dsh engine, then align the global
 * launcher. No restart — `updateTuiAndRestart` layers the session-preserving
 * restart on top, and the `dsh-tui update` CLI stops here.
 *
 * The order is fixed (TUI → engine → launcher): the profile installer is the
 * largest failure surface, and leaving the engine untouched until it finishes
 * keeps a failed update in "old TUI + old engine", a combination that is known
 * to boot. A new TUI explicitly supports the older engine lines in its peer
 * range, so "new TUI + old engine" is still bootable when the engine step
 * fails (the caller then decides whether to restart, see `compatible`).
 *
 * @param profile - The dsh profile to update.
 * @param plan - The preflight plan. Both production callers (plugin's
 *   `/update` and the CLI) always compute one; there is no planless mode.
 * @returns The update exit code plus the before/after versions and each step.
 */
export async function updateTui(
  profile: string,
  plan: UpdatePlan,
  signal?: AbortSignal,
): Promise<TuiUpdateOutcome> {
  // Stamp the pre-update version BEFORE pnpm runs: it reads this package's
  // manifest from disk, which the update replaces on the fly — a
  // post-update read already sees the NEW version, and the restarted
  // process then compares new-vs-new and false-alarms "version did not
  // advance" on every successful update (issue #307's screenshots).
  const updatedFrom = installedTuiVersion() ?? ''
  const targetVersion = plan.tui.kind === 'update' ? plan.tui.latest : undefined
  const tuiAlreadyLatest = plan.tui.kind === 'latest'
  if (signal?.aborted) return { code: 130, updatedFrom, compatible: plan.compatible }
  // A blocked plan must never move the TUI; the preflight already refuses it,
  // but a direct caller gets the same guarantee here.
  if (plan.blocked) {
    // Nothing has run yet here: the preflight refuses before the tree is torn
    // down, and a direct caller gets the same guarantee. `update-suite-
    // incompatible` describes a TUI that already moved, which would be a lie.
    process.stderr.write(`\n${blockedUpdateMessages(plan).report}\n`)
    return { code: 1, updatedFrom, tuiChanged: false, compatible: false }
  }

  if (isStandaloneRuntime()) {
    if (tuiAlreadyLatest) return { code: 0, updatedFrom, installed: updatedFrom, tuiChanged: false, compatible: plan.compatible }
    const target = plan.tui.kind === 'update' ? plan.tui : await resolveTuiUpdateTarget(signal)
    if (signal?.aborted) return { code: 130, updatedFrom }
    const latestVersion = targetVersion ?? (target.kind === 'update' ? target.latest : undefined)
    const downloadUrl = (target.kind === 'update' && target.downloadUrl)
      ? target.downloadUrl
      : (latestVersion ? `https://github.com/${GITHUB_REPO}/releases/download/v${latestVersion}/${getStandaloneAssetName()}` : undefined)
    const checksumUrl = target.kind === 'update' ? target.checksumUrl : undefined

    if (downloadUrl === undefined || latestVersion === undefined) {
      process.stderr.write('dsh-tui: 无法解析便携包更新下载地址\n')
      return { code: 1, updatedFrom }
    }

    process.stderr.write(`dsh-tui: 正在更新便携包 (${updatedFrom || 'current'} → ${latestVersion})…\n`)
    const result = await downloadAndReplaceStandaloneBinary(downloadUrl, msg => {
      process.stderr.write(`dsh-tui: ${msg}\n`)
    }, checksumUrl, { signal })
    if (signal?.aborted) return { code: 130, updatedFrom }
    if (!result.success) {
      process.stderr.write(`dsh-tui: 便携包更新失败: ${result.error ?? '未知错误'}\n`)
      return { code: 1, updatedFrom }
    }
    return { code: 0, updatedFrom, installed: latestVersion, tuiChanged: true, compatible: plan.compatible }
  }

  let installed = updatedFrom
  if (tuiAlreadyLatest) {
    // Constraints #2/#3: an already-current TUI does not short-circuit the
    // engine and launcher layers.
    process.stderr.write(`${t('update-tui-already-current', { version: updatedFrom || 'unknown' })}\n`)
  } else {
    const result = await installProfileTui(profile, targetVersion, signal, updatedFrom)
    if (result.code !== 0) {
      return {
        code: result.code,
        updatedFrom,
        ...(result.installed === undefined ? {} : { installed: result.installed }),
        tuiChanged: false,
        compatible: plan.compatible,
      }
    }
    installed = result.installed ?? installedTuiVersion() ?? updatedFrom
  }
  // DSH_TUI_UPDATED_FROM is only meaningful when the TUI itself moved (#307's
  // false alarm otherwise: "TUI latest, engine-only update" would restart with
  // the same version stamped). An `unknown` plan (the `--latest` fallback) can
  // still land on a new version, so that branch compares what actually landed.
  const tuiChanged = plan.tui.kind === 'update'
    ? true
    : plan.tui.kind === 'unknown'
      ? installed !== updatedFrom
      : false

  // Step 2: the engine. It runs after the profile installer (safety order) and
  // before the launcher so the restarted process boots the aligned host.
  let host: HostUpdateOutcome | undefined
  let cleanupUnconfirmed = false
  const onCleanupError = (): void => { cleanupUnconfirmed = true }
  if (plan.host.kind === 'install') {
    if (signal?.aborted) return { code: 130, updatedFrom, installed, tuiChanged, compatible: plan.compatible }
    process.stderr.write(`${t('update-engine-starting', { from: plan.host.from ?? 'unknown', to: plan.host.to })}\n`)
    host = await installHostStep(plan.host, { env: process.env, signal, onCleanupError })
    if (cleanupUnconfirmed) {
      // Ownership of the installer tree is unconfirmed: never open another
      // installer and never restart into a half-written prefix.
      return { code: host.code || 1, updatedFrom, installed, host, tuiChanged, compatible: false }
    }
    if (signal?.aborted) return { code: 130, updatedFrom, installed, host, tuiChanged, compatible: plan.compatible }
    // The CLI path has no AbortSignal: Ctrl+C reaches the owned installer,
    // which stops the tree and reports it as a cancel event. A child that
    // exits 130/143/129 on its own is a genuine failure and keeps its repair
    // copy. Running the launcher step after the user asked to stop would write
    // to the global prefix anyway.
    if (host.cancelled) {
      return { code: 130, updatedFrom, installed, host, tuiChanged, compatible: plan.compatible }
    }
    if (host.code !== 0 || !host.verified) {
      const expected = plan.host.to
      const actual = host.installed ?? readPackageVersion(plan.host.packageDir) ?? 'unknown'
      const cliMismatch = host.cliVersion !== undefined && host.cliVersion !== expected
      process.stderr.write(`\n${cliMismatch
        ? t('update-engine-path-mismatch', { cli: host.cliVersion ?? 'unknown', expected, command: host.manual })
        : host.code === 0
          ? t('update-engine-unverified', { expected, installed: actual, command: host.manual })
          : t('update-engine-failed', { code: String(host.code), command: host.manual })}\n`)
      // A failed installer may have removed/replaced the global package before
      // exiting (EPERM on a loaded native module, ENOSPC, a killed child). Never
      // restart into an engine that cannot be proven loadable.
      if (!engineSurvivesFailure(plan.host, host, process.env)) {
        // The plan §10 rule for refusal copy: current version, target range,
        // why it cannot be automatic, and the command — all four.
        process.stderr.write(`\n${t('update-engine-unsafe-restart', {
          current: plan.currentHost ?? host.installed ?? 'unknown',
          range: plan.hostRange ?? 'unknown',
          command: host.manual,
        })}\n`)
        return { code: 1, updatedFrom, installed, host, tuiChanged, compatible: false }
      }
      // The PLAN's `compatible` says "after the planned install", which is
      // true by construction when a step exists. The restart decision must
      // look at the engine that is ACTUALLY there after the failure: if the
      // pre-update engine was already outside the new TUI's line, a new TUI
      // plus that engine may not boot.
      if (!engineFailureAllowsRestart({
        tuiChanged,
        currentHost: plan.currentHost,
        hostRange: plan.hostRange,
      })) {
        // New TUI + engine outside its line: refuse the restart instead of
        // handing the user a combination that may not boot.
        const repin = updatedFrom === ''
          ? undefined
          : `dsh plugin --profile ${profile} add ${PACKAGE_NAME}@${updatedFrom}`
        const commands = [host.manual, repin].filter((command): command is string => command !== undefined && command !== '')
        process.stderr.write(`\n${t('update-suite-incompatible', {
          current: plan.currentHost ?? actual,
          range: plan.hostRange ?? '?',
          commands: commands.join('\n  '),
        })}\n`)
        return { code: 1, updatedFrom, installed, host, tuiChanged, compatible: false }
      }
    }
  }

  // Step 3: the global launcher. Re-resolve after the install so the step sees
  // the version that actually landed; skip only when the plan proved there is
  // nothing to align (or the layer is switched off) AND the TUI did not move
  // under the plan.
  const shouldAlign = shouldAlignLauncher(plan, tuiChanged)
  let launcher: LauncherAlignOutcome | undefined
  if (signal?.aborted) return { code: 130, updatedFrom, installed, ...(host === undefined ? {} : { host }), tuiChanged, compatible: plan.compatible }
  if (shouldAlign) {
    launcher = await alignGlobalLauncher(installed === '' ? undefined : installed, { signal })
  } else if (plan.launcher.kind === 'none') {
    launcher = { kind: 'none', reason: plan.launcher.reason }
  }
  // A launcher installer whose process tree could not be proven stopped may
  // still be writing the global install. Do not report success and do not
  // restart into a replacement while that is possible.
  if (launcher?.cleanupUnconfirmed === true) {
    process.stderr.write(
      'dsh-tui: the global launcher installer could not be confirmed stopped — not restarting. ' +
        `Inspect the global install, then update it manually with:\n  ${launcher.command ?? launcherManualCommand('npm', installed || 'latest')}\n`,
    )
    return { code: 1, updatedFrom, installed, ...(host === undefined ? {} : { host }), tuiChanged, compatible: false }
  }
  // The installer runner stops its own tree on SIGINT/SIGTERM without aborting
  // the caller's signal, so an interrupted launcher step must end the update as
  // an interrupt — otherwise the CLI exits 0 and the TUI restarts even though
  // the user interrupted the install.
  if (launcher?.reason === 'cancelled') {
    return { code: 130, updatedFrom, installed, ...(host === undefined ? {} : { host }), tuiChanged, compatible: plan.compatible }
  }
  if (launcher?.kind === 'copied') {
    process.stderr.write('dsh-tui: global launcher aligned to the delegating shim (no manual npm i -g needed anymore).\n')
  } else if (launcher?.kind === 'installed') {
    process.stderr.write(`dsh-tui: global launcher updated with pnpm add -g (${launcher.version ?? 'unknown'}).\n`)
  } else if (launcher?.kind === 'failed') {
    process.stderr.write(
      `dsh-tui: global launcher could not be aligned automatically (${launcher.reason}); update it manually with:\n` +
        `  ${launcher.command ?? launcherManualCommand('npm', installed || 'latest')}\n`,
    )
  }

  const compatible = host !== undefined && host.code === 0 && host.verified
    ? true
    : plan.compatible
  return {
    code: signal?.aborted ? 130 : 0,
    updatedFrom,
    installed,
    ...(host === undefined ? {} : { host }),
    ...(launcher === undefined ? {} : { launcher }),
    tuiChanged,
    ...(compatible === undefined ? {} : { compatible }),
  }
}

/**
 * The replacement's env markers for one completed update, pure.
 *
 * `DSH_TUI_UPDATED_FROM` only when the TUI itself moved (#307's new-vs-new
 * false alarm); `DSH_TUI_UPDATED_DSH_FROM` only for a verified engine advance;
 * the launcher generation marker only when the alignment actually completed.
 *
 * @param outcome - The install-only outcome.
 */
export function restartEnvFor(outcome: Pick<TuiUpdateOutcome, 'updatedFrom' | 'tuiChanged' | 'host' | 'launcher'>): Record<string, string> {
  const env: Record<string, string> = {}
  if (outcome.tuiChanged === true) env[UPDATED_FROM_ENV] = outcome.updatedFrom
  const host = outcome.host
  if (host !== undefined && host.code === 0 && host.verified && host.from !== undefined && isVersionNewer(host.to, host.from)) {
    env[UPDATED_DSH_FROM_ENV] = host.from
  }
  Object.assign(env, launcherRestartEnv(outcome.launcher))
  if (outcome.launcher?.kind === 'none' && outcome.launcher.reason === 'absent') env[LAUNCHER_ABSENT_ENV] = '1'
  return env
}

/**
 * Update the installed dsh-tui package and restart the same launcher while
 * preserving the active session. The TUI must already be unmounted before
 * this is called so pnpm output cannot corrupt the rendered terminal frame.
 *
 * When the preflight resolved a plan, pass it here: its TUI target pins the
 * exact version (no second registry round trip), and its engine/launcher
 * layers run after the profile installer.
 *
 * @param sessionId - Session to resume in the replacement process.
 * @param profile - The dsh profile this TUI was launched with; updating any
 *   other profile would leave the running install untouched.
 * @param plan - The preflight plan computed before the tree was torn down.
 * @param kernel - The kernel this process runs (TuiRestartOptions.kernel).
 * @returns Exit codes for the update run and the replacement process.
 */
export async function updateTuiAndRestart(
  sessionId: string,
  profile: string,
  plan: UpdatePlan,
  kernel?: KernelBackendId,
  /** The standalone entry's supervision hooks (TuiRestartOptions.onSpawn / onTerminationSignal). */
  supervision: Pick<TuiRestartOptions, 'onSpawn' | 'onTerminationSignal'> = {},
  signal?: AbortSignal,
): Promise<TuiUpdateResult> {
  const outcome = await updateTui(profile, plan, signal)
  if (outcome.code !== 0) return { updateCode: outcome.code, restartCode: outcome.code }
  if (signal?.aborted) return { updateCode: 130, restartCode: 130 }

  // Restart through the same hardened handoff as /restart (issues
  // #284/#307/#483): wait for the replacement's natural exit (the outer
  // interpreter must not reclaim the console under it), re-assert the
  // stdin detach from a watchdog so a revived pump cannot swallow the
  // child's keypresses, and capture a fast-death stderr report. The old
  // plain inherit spawn raced the interpreter for input on Windows
  // Terminal (issue #483: "cannot type anything after /update").
  //
  // The launcher generation marker inherited from the OLD outer shim is
  // refreshed when this update aligned the launcher: the replacement would
  // otherwise print "launcher still outdated" about an install it just
  // brought up to date (#1844 review). The TUI and engine stamps are applied
  // only to the layer that actually moved, so a "TUI latest, engine-only"
  // update cannot trip the TUI version-advance check (§3.6).
  const restartEnv = restartEnvFor(outcome)
  const restartCode = await restartTui(sessionId, {
    env: restartEnv,
    kind: 'update',
    ...(kernel === undefined ? {} : { kernel }),
    ...supervision,
  })
  return { updateCode: 0, restartCode }
}

/**
 * Headless `dsh-tui update`: the `/update` decision flow (preflight, deadlock
 * refusal, mirror-lag note, `--latest` fallback) followed by the install-only
 * half — no TUI, no restart. The bin launcher dynamic-imports this from the
 * profile copy's compiled lib.
 *
 * @param profile - The dsh profile to update.
 * @returns Process exit code: 0 on success or already-latest, 1 otherwise.
 */
export async function cliUpdate(profile: string): Promise<number> {
  const plan = await resolveUpdatePlan()
  const state = updatePlanState(plan)
  if (state === 'blocked') {
    process.stderr.write(`${blockedUpdateMessages(plan).report}\n`)
    return 1
  }
  if (state === 'empty') {
    process.stdout.write(`${t('update-plan-empty', { layers: updatePlanSuite(plan) })}\n`)
    return 0
  }
  if (state === 'idle') {
    process.stdout.write(`${t('update-plan-idle', {
      current: plan.tui.kind === 'latest' ? plan.tui.current : installedTuiVersion() ?? 'unknown',
      reason: describeLauncherStepReason(plan.launcher) ?? describeHostStepReason(plan.host),
    })}\n`)
    return 0
  }

  if (isStandaloneRuntime()) {
    if (plan.tui.kind === 'unknown') {
      process.stderr.write('dsh-tui: version check failed (offline or unreachable registry).\n')
      return 1
    }
    if (plan.tui.kind === 'update') {
      process.stdout.write(`dsh-tui: updating standalone binary ${plan.tui.current} → ${plan.tui.latest}…\n`)
    }
    const outcome = await updateTui(profile, plan)
    if (outcome.code === 0) {
      process.stdout.write(`dsh-tui: standalone binary updated successfully (${outcome.updatedFrom || 'current'} → ${outcome.installed}).\n`)
    }
    return outcome.code
  }

  if (plan.tui.kind === 'update') {
    // Mirror the /update refusal exactly: 0.7.0–0.7.1 hard-inject the
    // workspaces row and permanently deadlock boot under older launcher
    // patches (#183/#307), so never install that range.
    if (isBootDeadlockTarget(plan.tui.latest)) {
      process.stderr.write(
        `dsh-tui: refusing to update onto ${plan.tui.latest} — that range can permanently deadlock boot ` +
          `(#183/#307). Latest on the official registry: ${plan.tui.authoritative ?? plan.tui.latest}. ` +
          `If you use a mirror, retry after it syncs.\n`,
      )
      return 1
    }
    if (plan.tui.authoritative !== undefined) {
      process.stdout.write(
        `dsh-tui: note — your registry serves ${plan.tui.latest} while npmjs.org has ${plan.tui.authoritative} (mirror lag).\n`,
      )
    }
    process.stdout.write(`dsh-tui: updating ${plan.tui.current} → ${plan.tui.latest}…\n`)
  } else if (plan.tui.kind === 'unknown') {
    process.stdout.write('dsh-tui: version check failed (offline or unreadable install) — falling back to `--latest`.\n')
  }
  const layers = updatePlanLayers(plan)
  if (layers.length > 0) process.stdout.write(`${t('update-cli-starting', { layers: layers.join(' · ') })}\n`)

  const outcome = await updateTui(profile, plan)
  if (outcome.code === 0 && plan.tui.kind !== 'latest') {
    if (plan.tui.kind === 'unknown' && outcome.installed !== undefined && outcome.installed === outcome.updatedFrom) {
      // A preflight-less run can "succeed" as a pnpm no-op: say so instead of
      // printing a vacuous `updated X → X`.
      process.stdout.write(
        `dsh-tui: version did not advance (still ${outcome.installed}) — already the latest, or the registry has no newer release yet.\n`,
      )
    } else {
      process.stdout.write(`dsh-tui: TUI ${outcome.updatedFrom || '(unknown)'} → ${outcome.installed ?? '(unreadable)'}.\n`)
    }
  } else if (outcome.code === 0) {
    process.stdout.write(`dsh-tui: TUI already ${outcome.installed ?? outcome.updatedFrom}.\n`)
  }
  if (outcome.host !== undefined) {
    if (outcome.host.code === 0 && outcome.host.verified) {
      process.stdout.write(`dsh-tui: engine ${outcome.host.from ?? '(unknown)'} → ${outcome.host.to}.\n`)
    } else {
      process.stderr.write(`dsh-tui: engine not aligned — ${outcome.host.manual}\n`)
    }
  }
  if (outcome.launcher?.kind === 'copied' || outcome.launcher?.kind === 'installed') {
    process.stdout.write(`dsh-tui: launcher → ${outcome.launcher.version ?? 'current'}.\n`)
  } else if (outcome.launcher?.kind === 'failed') {
    process.stderr.write(`dsh-tui: launcher not aligned — ${outcome.launcher.command ?? ''}\n`)
  }
  if (outcome.code !== 0) return outcome.code
  // Verification failure is a non-zero exit even when the TUI itself updated
  // and the current combination still boots (§3.4).
  if (outcome.host !== undefined && (outcome.host.code !== 0 || !outcome.host.verified)) return 1
  // Launcher alignment stays best effort for the RESTART (it only affects the
  // next launch), but this command's exit status is the whole set's verdict:
  // reporting success while a layer was not aligned is what automation reads.
  if (outcome.launcher?.kind === 'failed') return 1
  return 0
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
 * @param sessionId - Session to resume in the replacement process; empty
 *   starts fresh. Ignored when `options.backend` switches kernels.
 * @param options - `kind: 'update'` drops the /restart boot-diagnosis
 *   marker and tags restart.log events for the update flow; `env` adds
 *   marker variables for the replacement (e.g. DSH_TUI_UPDATED_FROM);
 *   `backend` switches the replacement onto that kernel.
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
  /**
   * A kernel switch from the launchpad selector. restart.log events use the
   * backend-switch tag; the replacement gets DSH_TUI_BACKEND and the one-shot
   * KERNEL_SWITCH_HANDOFF_ENV set to the chosen kernel (the latter beats a
   * Config row that pins the other one), and no DSH_TUI_RESUME_SESSION: the
   * new kernel starts a new session.
   */
  backend?: KernelBackendId
  /**
   * The chosen kernel's display name (its manifest's short label), resolved by
   * the caller from the registry entry: THIS module prints it and has no registry
   * of its own (`bin/dsh-tui.js` shares that constraint). Absent → the raw id,
   * which is what an unregistered/uninstalled backend would show anyway.
   */
  backendName?: string
  /**
   * 'alt' (fullscreen kernel switch only): this process keeps the alternate
   * screen open through the spawn, the replacement adopts it without a
   * second 1049h, and its first flushed frame (ACKed on fd 3) hands the
   * screen over; see src/handoffAck.ts. /restart, /update and inline
   * sessions go back to the main screen before the spawn as before.
   */
  handoffScreen?: 'alt'
  /**
   * The kernel this process runs. A plain /restart or /update passes it in
   * the one-shot KERNEL_SWITCH_HANDOFF_ENV so the replacement reopens the
   * session on the same kernel even when a Config row names the other one
   * (as it does after a kernel switch). Ignored when `backend` is set.
   */
  kernel?: KernelBackendId
  /** The replacement was spawned (the standalone entry forwards SIGTERM to it). */
  onSpawn?: (child: { kill(signal: NodeJS.Signals): boolean }) => void
  /**
   * The replacement ended by a signal: called before any outcome notice, so a
   * standalone-entry supervisor can end by the same signal. Returning normally
   * continues with the usual outcome handling.
   */
  onTerminationSignal?: (signal: NodeJS.Signals) => void
}

/**
 * The replacement's env, pure: the resume marker, the /restart child stamp,
 * the caller's extra markers and the kernel-switch overrides. Exported for
 * scripts/verify-launchpad, which feeds it through the boot resolver.
 */
export function restartChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  sessionId: string,
  kind: 'restart' | 'update',
  options: TuiRestartOptions,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...parentEnv,
    // The replacement resumes the current session through the launcher
    // contract (DSH_TUI_RESUME_SESSION; see src/sessionHistory.ts).
    DSH_TUI_RESUME_SESSION: sessionId,
    // Marks the replacement so its own boot logs to restart.log without
    // noisy logging on every ordinary launch (/restart only).
    ...(kind === 'restart' ? { [RESTART_CHILD_ENV]: '1' } : {}),
    [LAUNCH_PROMPT_SENT_ENV]: '1',
    ...options.env,
  }
  // The Config schema preserves '', so an absent session must be represented
  // by removing the marker, including one inherited from the previous launch.
  if (sessionId === '') delete childEnv.DSH_TUI_RESUME_SESSION
  // A stale handoff override never leaks into a plain replacement: the var is
  // one-shot (consumed at this process's own boot), and a child that is NOT
  // switching kernels keeps this process's kernel by config/env/memory as
  // usual.
  delete childEnv[KERNEL_SWITCH_HANDOFF_ENV]
  // Same for the alt-screen handoff markers: a replacement must not adopt a
  // screen or ACK pipe from an earlier attempt. restartTui sets them again
  // when it opens a handoff.
  delete childEnv[HANDOFF_SCREEN_ENV]
  delete childEnv[HANDOFF_ACK_FD_ENV]
  delete childEnv[HANDOFF_ATTEMPT_ENV]
  // A derived resume target's provenance is never inherited: whatever survives
  // here was built by THIS process, and on a kernel switch even the target itself
  // goes (below). Keeping a stale mark would make the replacement revoke a target
  // nobody derived (see resolveResumeTarget in kernelPrefs.ts).
  delete childEnv[RESUME_BACKEND_ENV]
  // Same for the safe-mode retry marker: "this boot is a retry" describes the
  // process the launcher spawned, not the replacement it spawns now. The boot
  // consumes it on read anyway — this keeps a replacement honest even if one is
  // ever built from an env that still carries it.
  delete childEnv[RESUME_RETRY_ENV]
  if (options.backend === undefined && options.kernel !== undefined) childEnv[KERNEL_SWITCH_HANDOFF_ENV] = options.kernel
  if (options.backend !== undefined) {
    childEnv.DSH_TUI_BACKEND = options.backend
    // DSH_TUI_BACKEND alone loses to a Config row (config > env > memory),
    // so the switch also sets the one-shot variable that ranks above config.
    childEnv[KERNEL_SWITCH_HANDOFF_ENV] = options.backend
    // A kernel switch never resumes: the id of THIS backend's session means
    // nothing to the next one, and an inherited marker (this process may
    // itself be a /restart child) would send the new kernel looking for it —
    // deleted outright, not blanked (the launcher row maps '' to
    // config.sessionId='', not to "absent").
    delete childEnv.DSH_TUI_RESUME_SESSION
  }
  return childEnv
}

/**
 * The replacement's argv after `process.execPath`, pure: the same script and
 * arguments again, except that a replacement started outside the entry goes
 * to `hostEntry` with the app arguments (the entry hosts every kernel).
 */
export function restartArgv(input: {
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
  /** Whether this is a kernel switch (resume flags are dropped). */
  readonly switching: boolean
  /** The replacement opens a fresh session (no session id to hand over, e.g.
   *  after /new): inherited resume flags name the previous one and are dropped. */
  readonly fresh?: boolean
  readonly hostEntry: string | undefined
}): string[] {
  const strip = (args: readonly string[]): string[] => input.switching || input.fresh === true ? stripResumeArgs(args) : [...args]
  const script = input.argv[1]
  if (input.hostEntry !== undefined && script !== input.hostEntry) {
    // The app arguments: everything after dsh's own `--`.
    const separator = input.argv.indexOf('--', 2)
    const appArgs = separator === -1 ? [] : input.argv.slice(separator + 1)
    return [...input.execArgv, input.hostEntry, ...strip(appArgs)]
  }
  return [...input.execArgv, ...strip(input.argv.slice(1))]
}

export async function restartTui(sessionId: string, options: TuiRestartOptions = {}): Promise<number> {
  const kind = options.kind ?? 'restart'
  const tag = options.backend !== undefined ? 'backend-switch' : kind === 'update' ? 'update-restart' : 'restart'
  const hostEntry = process.env[HOST_ENTRY_PATH_ENV]
  const argv = restartArgv({
    execArgv: process.execArgv,
    argv: process.argv,
    switching: options.backend !== undefined,
    fresh: sessionId === '',
    hostEntry: hostEntry === undefined || hostEntry === '' || hostEntryDisabled() ? undefined : hostEntry,
  })
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
  // Fullscreen kernel switch: keep the alternate screen until the replacement
  // reports its first flushed frame on the ACK pipe (see handoffScreen).
  const handoff = options.handoffScreen === 'alt' && options.backend !== undefined
  const attemptId = handoff ? 'hs-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 8) : undefined
  // Ctrl+C while the replacement boots reaches this process too: same process
  // group, and nothing has the terminal in raw mode yet. Dying here would
  // leave behind the alternate screen this process still holds; the
  // replacement gets the same signal, and its close below restores the screen.
  const ignoreInterrupt = (): void => {}
  if (handoff) process.on('SIGINT', ignoreInterrupt)
  // "Starting X…" goes out before the spawn, waiting for the write callback
  // so it lands before the replacement draws anything.
  if (options.backend !== undefined) {
    await writeHandoffStage(
      process.stdout,
      formatHandoffNotice('stage-start', { name: options.backendName ?? options.backend, color: process.stdout.isTTY === true }) + '\n',
    )
    logRestartEvent(handoffEventTag('stage-start'), { backend: options.backend, ...(attemptId === undefined ? {} : { attemptId }) })
  }
  return new Promise(resolve => {
    const childEnv = restartChildEnv(process.env, sessionId, kind, options)
    if (handoff) {
      // stdio[3] is the ACK pipe; the env tells the replacement its fd and the attempt id.
      childEnv[HANDOFF_SCREEN_ENV] = 'alt'
      childEnv[HANDOFF_ACK_FD_ENV] = '3'
      childEnv[HANDOFF_ATTEMPT_ENV] = attemptId!
      logRestartEvent('handoff: alt-screen bracket held for the replacement', { attemptId })
    }
    // Reassert after root disposal: even a late drain must not restart the
    // parent's native stdin read before the replacement probes the terminal.
    detachHandoffStdin()
    const child = spawn(process.execPath, argv, {
      env: childEnv,
      // stdin/stdout stay inherited so the replacement owns the console the
      // moment it boots; stderr is captured so a boot failure is reportable
      // through THIS process (the terminal may already be mid-handoff when
      // the child dies, and a raw inherit write can vanish). fd 3 is the
      // one-way ACK pipe (replacement → supervisor): adopted / first frame.
      stdio: handoff ? ['inherit', 'inherit', 'pipe', 'pipe'] : ['inherit', 'inherit', 'pipe'],
    })
    let ackAdoptedAt: number | undefined
    let ackReadyAt: number | undefined
    const ackStream = handoff ? (child.stdio[3] ?? undefined) as import('node:stream').Readable | undefined : undefined
    if (ackStream !== undefined) {
      ackStream.setEncoding('utf8')
      let pending = ''
      ackStream.on('data', (chunk: string) => {
        pending += chunk
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline < 0) break
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          const ack = parseHandoffAckLine(line)
          if (ack === null || ack.attemptId !== attemptId) continue
          if (ack.kind === 'adopted' && ackAdoptedAt === undefined) {
            ackAdoptedAt = Date.now()
            logRestartEvent('handoff/screen-adopted', { attemptId, backend: options.backend })
          }
          if (ack.kind === 'ready' && ackReadyAt === undefined) {
            ackReadyAt = Date.now()
            // ready means the replacement's first frame was flushed, not just
            // that it mounted or is still alive.
            logRestartEvent(handoffEventTag('first-frame'), { attemptId, backend: options.backend, elapsedMs: ackReadyAt - startedAt })
          }
        }
      })
      ackStream.on('error', () => {
        // The supervisor outlives the pipe by contract; a broken pipe here
        // means the replacement never speaks the protocol (e.g. an older
        // build) — the close handler's no-ready branch still restores the
        // screen, so the bracket can never be orphaned.
      })
      const ackWatch = setTimeout(() => {
        if (ackReadyAt === undefined) {
          logRestartEvent('handoff/first-frame watch', { attemptId, note: 'no first-frame ACK within 30s (diagnosis only, never a success/failure fact)' })
        }
      }, 30000)
      ackWatch.unref()
    }
    logRestartEvent(`${tag}: replacement spawned`, { childPid: child.pid, ...(options.backend === undefined ? {} : { backend: options.backend }) })
    options.onSpawn?.(child)
    // Handoff watchdog (field evidence 2026-08-24: restarted TUI mounts but
    // takes no input). Two jobs, both diagnosis-grade:
    // 1. SAMPLE this process's stdin state every second — if anything
    //    re-attaches a reader after the funnel's detachStdinForHandoff, the
    //    sample (taken before the re-assert below) shows it in the log.
    // 2. RE-ASSERT the detach — never DESTROY the stream: destroying it
    //    resets the shared pty and stomps the replacement's raw mode (see
    //    detachHandoffStdin for the mechanism and trade-offs). This process
    //    must never read the shared console again — every keypress belongs to
    //    the replacement, and a resumed pump here is exactly the "restarted
    //    TUI sees dropped or swallowed input" failure (#284/#307).
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
        detachHandoffStdin(stdin)
      } catch {
        // Diagnosis/mitigation only.
      }
      if (watchdogTicks === 15) {
        clearInterval(watchdog)
        logRestartEvent('parent: stdin detached after watchdog (kept raw, not destroyed)')
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
      process.removeListener('SIGINT', ignoreInterrupt)
      logRestartEvent(`${tag}: spawn error`, { message: error.message })
      if (options.backend !== undefined) {
        // Nothing took the screen over: restore it before the notice.
        if (handoff) restoreHandoffScreen()
        // A spawn failure is a failed switch (yellow, with the safe-mode hint),
        // not a crash.
        logRestartEvent(handoffEventTag('failed'), { reason: 'spawn-error', message: error.message })
        writeHandoffNotice(
          formatHandoffNotice('failed', {
            name: options.backendName ?? options.backend,
            reason: 'spawn-error',
            safeHint: true,
            color: process.stderr.isTTY === true,
          }) + `\n${error.message}\n`,
        )
      } else {
        writeHandoffNotice(`dsh-tui: failed to spawn the restart: ${error.message}\n`)
      }
      resolve(127)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      process.removeListener('SIGINT', ignoreInterrupt)
      const elapsedMs = Date.now() - startedAt
      logRestartEvent(`${tag}: replacement exited`, {
        code: code ?? null,
        signal: signal ?? null,
        elapsedMs,
      })
      // A replacement that took the screen over and died by a signal: the hook
      // may end this process by that signal. Before a handoff's first frame this
      // process still holds the screen, so the failure path below restores it.
      if (signal !== null && options.onTerminationSignal !== undefined && (!handoff || ackReadyAt !== undefined)) {
        options.onTerminationSignal(signal)
      }
      if (options.backend !== undefined) {
        // Kernel switch outcome: success is quiet (restart.log only), a
        // replacement that never came up is a yellow failure with the session
        // kept and the safe-mode hint, and a later nonzero exit is a red
        // crash. With the ACK pipe the first frame decides which of the two
        // failures it was; see classifyReplacementOutcome.
        const outcome = classifyReplacementOutcome({
          closed: true, code, signal, elapsedMs,
          ...(handoff ? { firstFrameAcked: ackReadyAt !== undefined } : {}),
        })
        logRestartEvent(handoffEventTag(outcome.kind), {
          ...(outcome.kind === 'crashed' ? { code: outcome.code } : outcome.kind === 'failed' ? { reason: outcome.reason } : {}),
          ...(attemptId === undefined ? {} : { attemptId }),
        })
        if (outcome.kind === 'failed') {
          // Before ready this process still holds the alternate screen:
          // restore it first so the notice lands on the main screen. After
          // ready the replacement's own exit cleanup closed it.
          if (handoff && ackReadyAt === undefined) restoreHandoffScreen()
          const suffix = childStderr.trim() === '' ? '' : `\n${childStderr.trimEnd()}`
          writeHandoffNotice(
            formatHandoffNotice('failed', {
              name: options.backendName ?? options.backend,
              reason: outcome.reason,
              safeHint: true,
              color: process.stderr.isTTY === true,
            }) + `${suffix}\n`,
          )
        } else if (outcome.kind === 'crashed') {
          // A signal death after the first frame skipped the replacement's
          // own exit cleanup, so the screen and input modes are still its.
          if (handoff && signal !== null) restoreHandoffScreen()
          writeHandoffNotice(
            '\n' + formatHandoffNotice('crashed', {
              name: options.backendName ?? options.backend,
              code: outcome.code,
              safeHint: true,
              color: process.stderr.isTTY === true,
            }) + '\n',
          )
        }
      } else if (elapsedMs < 4000) {
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
