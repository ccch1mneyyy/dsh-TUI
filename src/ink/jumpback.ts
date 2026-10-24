/**
 * Jump-back orchestration (D4/D7/D8): the single place that asks whether this
 * pane can be promised a jump, registers the `dsh-tui:` protocol a toast click
 * comes back through, and keeps the documented marker files truthful. The UIA
 * work itself belongs to the helper under `notify-helper/`.
 *
 * Every system side effect sits behind the win32 guard and behind the injected
 * ports, so a POSIX process neither writes the registry nor leaves marker files.
 * Nothing here throws: a failure answers "not capable", the caller degrades to a
 * plain toast, and the stage and reason stay in the debug log (AC-3/AC-9).
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pidAlive } from '../sessionMounts.js'
import { logForDebugging } from '../utils/debug.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import type { ExecFileNoThrowResult } from '../utils/execFileNoThrow.js'
import { DATA_DIR } from '../utils/paths.js'
import { ensureHelper } from './notify-helper/compile.js'

/**
 * The URI scheme root (D7): Windows hands `dsh-tui:` to a handler only when this
 * key carries the named value `URL Protocol`; the click command sits below it.
 */
export const JUMP_BACK_PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-tui'

/**
 * The command a toast click runs (D7). It quotes both the helper and the data
 * directory: the shell starts the handler with none of our environment, so the
 * helper must be told where the profile lives explicitly.
 */
export const JUMP_BACK_PROTOCOL_COMMAND_KEY = `${JUMP_BACK_PROTOCOL_KEY}\\shell\\open\\command`

/** The named value that marks the scheme root as a URI handler; its data is empty (D7). */
const URL_PROTOCOL_VALUE = 'URL Protocol'

/** 16 lowercase hex characters; the title, the URI and the marker file all carry this (D2). */
const MARKER_PATTERN = /^[0-9a-f]{16}$/u

/**
 * A session id becomes a file name, so only characters that cannot introduce a
 * path separator are admitted. DSH ids are `session-<uuid>`; `.` and `..` are
 * harmless because `.json` is appended, so neither can name a directory.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u

/** True when the id can name a marker file; `writeMarker` enforces the same rule. */
export function isMarkerFileSession(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId)
}

/** The helper probes in ~0.5 s (D4); 1.5 s means stuck, not slow. */
const PROBE_TIMEOUT_MS = 1_500

/** `reg.exe` answers in milliseconds; a write that takes longer is stuck, not slow (D7). */
const REGISTRY_TIMEOUT_MS = 15_000

/** A marker file is stale after a week even when its pid still answers (D8). */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000

/** Why a probe did not promise a jump; each one is a degradation, never a throw. */
export type JumpBackProbeStage = 'not-win32' | 'marker' | 'helper' | 'probe' | 'unexpected'

/** The pre-toast answer (D4): capable only when the helper exited 0. */
export type JumpBackProbe =
  | { readonly capable: true, readonly helperPath: string }
  | { readonly capable: false, readonly stage: JumpBackProbeStage, readonly reason: string }

/**
 * The ports a regression injects: each production default is named in its
 * comment, so the suite drives the whole orchestration without the registry,
 * csc or the real profile directory.
 */
export interface JumpBackPorts {
  /** Platform override for the regression; production is `process.platform`. */
  platform?: NodeJS.Platform
  /** Environment for the `%WINDIR%` lookup; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Process runner for `reg.exe` and the helper; defaults to `execFileNoThrow`. */
  run?: typeof execFileNoThrow
  /** Clock for `startedAt` and the stale sweep; defaults to `Date.now`. */
  now?: () => number
  /** Data directory (`~/.dsh-tui` normally); defaults to {@link DATA_DIR}. */
  dataDir?: string
  /** Liveness for marker owners; defaults to {@link pidAlive} (D8 sweep and cleanup). */
  pidAlive?: (pid: number) => boolean
  /** Resolves the compiled helper; defaults to {@link ensureHelper}, the only compiler. */
  helperPath?: () => Promise<string | undefined>
}

/** The jump-back orchestration one process owns. */
export interface JumpBack {
  /** Decide before a toast whether a click can be promised to land on this pane (D4). */
  probe(marker: string): Promise<JumpBackProbe>
  /** Register the protocol key, or prove the cached registration is still ours (D7). */
  ensureProtocol(helperPath: string): Promise<boolean>
  /** Remove the protocol key; a missing key is not an error (D7). */
  unregisterProtocol(): Promise<void>
  /** Write the documented read-only marker file for one session (D8). */
  writeMarker(sessionId: string, marker: string): string | undefined
  /** Remove its marker files, and the key unless another live instance still needs it (D7). */
  cleanup(): Promise<void>
  /** Remove marker files whose owner is gone or older than a week (D8 startup cleanup). */
  sweepStale(): void
}

/**
 * Create the orchestration for one process.
 * @returns The jump-back orchestration.
 */
export function createJumpBack(ports: JumpBackPorts = {}): JumpBack {
  const platform = ports.platform ?? process.platform
  const env = ports.env ?? process.env
  const run = ports.run ?? execFileNoThrow
  const resolveHelper = ports.helperPath ?? ensureHelper
  const now = ports.now ?? Date.now
  const dataDir = ports.dataDir ?? DATA_DIR
  const markerDir = join(dataDir, 'notify', 'jumpback')
  const alive = ports.pidAlive ?? pidAlive

  /** Marker files this process wrote; the only ones cleanup may remove. */
  const written = new Set<string>()
  /** Whether this process registered the key; re-checked before every later promise (D7). */
  let registered = false
  /**
   * The helper this process registered (or found its own template for). Cleanup
   * uses it to recognise a shared key another instance wrote for every instance
   * under this profile, so the last one out can still release it.
   */
  let lastHelper: string | undefined
  /**
   * Whether this process ever took part in jump-back (registered or wrote a
   * marker). A default-off process stays untouched: cleanup must not even read
   * the registry for it, or the "no trace" promise grows a pair of queries.
   */
  let armed = false
  /** The one registration or re-check in flight, so concurrent notifications share it. */
  let pendingEnsure: Promise<boolean> | undefined

  const unavailable = (stage: JumpBackProbeStage, reason: string): JumpBackProbe => {
    logForDebugging('jumpback: probe unavailable', { stage, reason })
    return { capable: false, stage, reason }
  }

  async function probe(marker: string): Promise<JumpBackProbe> {
    try {
      // The platform gate comes first: a non-Windows process has no UIA to ask.
      if (platform !== 'win32') return unavailable('not-win32', `the platform is ${platform}`)
      if (!MARKER_PATTERN.test(marker)) {
        return unavailable('marker', 'expected 16 lowercase hex characters')
      }
      const helper = await resolveHelper()
      if (helper === undefined) return unavailable('helper', 'the helper could not be compiled')
      const result = await run(helper, ['--probe', marker, '-DataDir', dataDir], {
        timeout: PROBE_TIMEOUT_MS,
      })
      if (result.code !== 0) return unavailable('probe', probeFailure(result))
      logForDebugging('jumpback: the helper reports a reachable target', { marker })
      return { capable: true, helperPath: helper }
    } catch (error) {
      // A rejecting port must not reach the notification path (AC-3).
      return unavailable('unexpected', describe(error))
    }
  }

  async function register(helper: string): Promise<boolean> {
    if (platform !== 'win32') {
      logForDebugging('jumpback: protocol registration skipped', { reason: 'not-win32' })
      return false
    }
    const reg = regExe(env)
    if (reg === undefined) {
      logForDebugging('jumpback: protocol registration skipped', { reason: 'system-root-missing' })
      return false
    }
    if (helper === '' || helper.includes('"')) {
      // Recording an unquotable path would produce a handler that silently
      // never starts; refuse now so the click degrades to a plain toast.
      logForDebugging('jumpback: protocol registration refused', {
        reason: 'the helper path cannot be quoted',
        helper,
      })
      return false
    }
    // Windows needs both halves: the empty `URL Protocol` marker on the root and
    // the command below it. Either refusal means no click, and a half-written
    // key is never remembered as registered, so the next notification retries (D7).
    for (const value of registrationValues(helper, dataDir)) {
      const detail = await addRegistryValue(run, reg, value)
      if (detail !== undefined) {
        logForDebugging('jumpback: protocol registration failed', {
          key: value.key,
          value: value.name ?? '(default)',
          detail,
        })
        return false
      }
    }
    registered = true
    lastHelper = helper
    armed = true
    logForDebugging('jumpback: protocol registered', { key: JUMP_BACK_PROTOCOL_KEY })
    return true
  }

  function ensureProtocol(helper: string): Promise<boolean> {
    if (pendingEnsure !== undefined) return pendingEnsure
    // A write that succeeded earlier is not proof the key is still there: the
    // user, another instance or a crash may have deleted or rewritten it since.
    // Every later notification re-checks the pair and rewrites it on failure
    // (D7); a failed attempt is not cached, so the next notification retries
    // after a transient policy refusal.
    pendingEnsure = ensureCurrent(helper)
      .catch((error: unknown) => {
        logForDebugging('jumpback: protocol registration threw', { detail: describe(error) })
        return false
      })
      .finally(() => {
        pendingEnsure = undefined
      })
    return pendingEnsure
  }

  /**
   * Answer "is the promise still backed by the key?", writing the pair when it
   * is not. The first notification pays for two writes; later ones pay for two
   * `reg query` calls unless the key changed (D7).
   * @returns Whether both values now hold this process's template.
   */
  async function ensureCurrent(helper: string): Promise<boolean> {
    if (!registered) return register(helper)
    const reg = regExe(env)
    if (reg !== undefined && await registrationMatches(run, reg, helper, dataDir)) {
      lastHelper = helper
      armed = true
      return true
    }
    return register(helper)
  }

  async function unregisterProtocol(): Promise<void> {
    registered = false
    try {
      if (platform !== 'win32') return
      const reg = regExe(env)
      if (reg === undefined) {
        logForDebugging('jumpback: protocol unregistration skipped', { reason: 'system-root-missing' })
        return
      }
      // The whole scheme root goes, not just the command below it: leaving the
      // empty `dsh-tui` key behind would contradict "a normal exit leaves no
      // protocol key" and make the next default-off snapshot look wrong (D7).
      const result = await run(reg, ['delete', JUMP_BACK_PROTOCOL_KEY, '/f'], {
        timeout: REGISTRY_TIMEOUT_MS,
      })
      // A key another instance removed first is the normal multi-instance case;
      // the refusal costs nothing and is recorded for the post-mortem (D7).
      if (result.code !== 0) {
        logForDebugging('jumpback: protocol unregistration failed', {
          code: result.code,
          detail: firstOutputLine(result),
        })
      }
    } catch (error) {
      logForDebugging('jumpback: protocol unregistration threw', { detail: describe(error) })
    }
  }

  function writeMarker(sessionId: string, marker: string): string | undefined {
    if (platform !== 'win32') {
      logForDebugging('jumpback: marker file skipped', { reason: 'not-win32' })
      return undefined
    }
    if (!isMarkerFileSession(sessionId)) {
      logForDebugging('jumpback: marker file refused', { reason: 'unusable session id', sessionId })
      return undefined
    }
    if (!MARKER_PATTERN.test(marker)) {
      logForDebugging('jumpback: marker file refused', { reason: 'unusable marker', marker })
      return undefined
    }
    const path = join(markerDir, `${sessionId}.json`)
    try {
      const record = {
        schemaVersion: 1,
        marker,
        pid: process.pid,
        startedAt: new Date(now()).toISOString(),
      }
      mkdirSync(markerDir, { recursive: true })
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (error) {
      logForDebugging('jumpback: marker file unwritable', { path, detail: describe(error) })
      return undefined
    }
    written.add(path)
    armed = true
    logForDebugging('jumpback: marker file written', { path })
    return path
  }

  async function cleanup(): Promise<void> {
    // A registration still in flight may land after this check; waiting for it
    // makes "we do not leave a key behind" true even on a fast exit.
    if (pendingEnsure !== undefined) await pendingEnsure
    const reg = regExe(env)
    const helper = lastHelper ?? join(dataDir, 'notify', 'helper', 'activate.exe')
    // A process that never registered can still be the last one out: another
    // instance registered the same shared key for this profile. Recognise our
    // own template instead of trusting this object's `registered` flag, and
    // never remove a key that belongs to something else.
    const keyIsOurs = registered || (armed && platform === 'win32' && reg !== undefined
      && await registrationMatches(run, reg, helper, dataDir))
    if (keyIsOurs) {
      if (hasOtherLiveInstance()) {
        // The key is shared by every instance under this profile: removing it
        // would turn another live instance's next toast clicks into dead ones.
        // Its next notification re-checks and rewrites the pair if needed (D7).
        registered = false
        logForDebugging('jumpback: left the protocol key for a live instance', {
          key: JUMP_BACK_PROTOCOL_KEY,
          reason: 'another process still owns a marker file',
        })
      } else {
        await unregisterProtocol()
      }
    }
    for (const path of written) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        logForDebugging('jumpback: marker file removal failed', { path, detail: describe(error) })
      }
    }
    written.clear()
  }

  /**
   * List the marker directory, or undefined when there is nothing to read yet;
   * the startup sweep and the cleanup yield check share this one read (D8).
   * @returns The directory entries, or undefined when the directory is absent.
   */
  function markerEntries() {
    try {
      return readdirSync(markerDir, { withFileTypes: true })
    } catch (error) {
      // No directory yet is the normal first run; anything else is worth a line.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logForDebugging('jumpback: marker directory unreadable', { dir: markerDir, detail: describe(error) })
      }
      return undefined
    }
  }

  /**
   * Whether a marker file belongs to another process that is still alive: such
   * an instance still needs the shared key, so cleanup must not remove it. Files
   * this process wrote, unreadable files and dead pids do not block removal; the
   * stale sweep owns whatever is left behind.
   * @returns True when at least one other live pid owns a marker file.
   */
  function hasOtherLiveInstance(): boolean {
    const entries = markerEntries()
    if (entries === undefined) return false
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const record = readMarkerRecord(join(markerDir, entry.name))
      const pid = record?.pid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue
      if (alive(pid)) return true
    }
    return false
  }

  function sweepStale(): void {
    if (platform !== 'win32') return
    try {
      removeStaleMarkers()
    } catch (error) {
      // The sweep is housekeeping: a surprise in it must not take startup down.
      logForDebugging('jumpback: stale marker sweep failed', { detail: describe(error) })
    }
  }

  function removeStaleMarkers(): void {
    const entries = markerEntries()
    if (entries === undefined) return
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(markerDir, entry.name)
      const record = readMarkerRecord(path)
      if (record === undefined) continue
      const pid = record.pid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        logForDebugging('jumpback: marker file left in place', { path, reason: 'no usable pid' })
        continue
      }
      if (!alive(pid)) {
        removeStale(path, 'the owning process is gone')
        continue
      }
      const started = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN
      if (Number.isFinite(started) && now() - started > STALE_AFTER_MS) {
        removeStale(path, 'older than 7 days')
      } else if (!Number.isFinite(started)) {
        logForDebugging('jumpback: marker file left in place', { path, reason: 'no usable startedAt' })
      }
    }
  }

  return {
    probe,
    ensureProtocol,
    unregisterProtocol,
    writeMarker,
    cleanup,
    sweepStale,
  }
}

/** One `REG_SZ` value of the two-value registration contract (D7). */
interface RegistryValue {
  readonly key: string
  readonly name: string | null
  readonly data: string
}

/**
 * The two values a full registration writes (D7), each with the data this
 * process would leave behind. The pair doubles as the template every later
 * notification checks against.
 * @returns The root marker and the command, in the order they are written.
 */
function registrationValues(helper: string, dataDir: string): readonly RegistryValue[] {
  return [
    { key: JUMP_BACK_PROTOCOL_KEY, name: URL_PROTOCOL_VALUE, data: '' },
    { key: JUMP_BACK_PROTOCOL_COMMAND_KEY, name: null, data: `"${helper}" --activate "%1" -DataDir "${dataDir}"` },
  ]
}

/**
 * Whether both values still hold this process's template: a missing value, a
 * command rewritten to another helper, half a root key or unreadable output all
 * answer false, so the caller rewrites the pair instead of trusting the cache (D7).
 * @returns True only when both values match the template exactly.
 */
async function registrationMatches(
  run: typeof execFileNoThrow,
  reg: string,
  helper: string,
  dataDir: string,
): Promise<boolean> {
  for (const value of registrationValues(helper, dataDir)) {
    if (await readRegistryValue(run, reg, value) !== value.data) return false
  }
  return true
}

/**
 * Read one value back with `reg query`. A gone value (non-zero exit) or output
 * this parser cannot read answers undefined; both mean "not provably ours",
 * never "probably fine" (D7).
 * @returns The data string, or undefined when the value is not provably there.
 */
async function readRegistryValue(
  run: typeof execFileNoThrow,
  reg: string,
  value: RegistryValue,
): Promise<string | undefined> {
  const nameArgs = value.name === null ? ['/ve'] : ['/v', value.name]
  const result = await run(reg, ['query', value.key, ...nameArgs], { timeout: REGISTRY_TIMEOUT_MS })
  if (result.code !== 0) return undefined
  return parseRegistryValue(result.stdout, value.name)
}

/**
 * The data of one value from `reg query` output. The line carries the type
 * token, so the label before it is skipped for the default value (Windows
 * localises `(Default)`) and compared exactly for the named root marker (so a
 * data line cannot be mistaken for the value).
 * @param name - The value name, or null for the key's default value.
 * @returns The data string, or undefined when no value line is present.
 */
function parseRegistryValue(stdout: string, name: string | null): string | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    const typeAt = trimmed.indexOf('REG_SZ')
    if (typeAt === -1) continue
    if (name !== null && trimmed.slice(0, typeAt).trim() !== name) continue
    return trimmed.slice(typeAt + 'REG_SZ'.length).trimStart()
  }
  return undefined
}

/**
 * Write one `REG_SZ` value with `reg.exe add`. The named value and the default
 * share one argv shape; `name === null` means the default value (`/ve`), the
 * form verified against a real registry (D7).
 * @returns undefined on success, or the line a failure left for the log.
 */
async function addRegistryValue(
  run: typeof execFileNoThrow,
  reg: string,
  value: RegistryValue,
): Promise<string | undefined> {
  const nameArgs = value.name === null ? ['/ve'] : ['/v', value.name]
  const result = await run(reg, ['add', value.key, ...nameArgs, '/t', 'REG_SZ', '/d', value.data, '/f'], {
    timeout: REGISTRY_TIMEOUT_MS,
  })
  if (result.code === 0) return undefined
  const detail = firstOutputLine(result)
  return detail === '' ? `exited with code ${result.code}` : detail
}

/**
 * The in-box registry tool under `%WINDIR%`, or undefined when the environment
 * names no Windows directory. Resolved by absolute path, never through `PATH`
 * (the same rule the toast transport follows for its own registry writes).
 * @returns The absolute `reg.exe` path, or undefined.
 */
function regExe(env: Record<string, string | undefined>): string | undefined {
  const root = env.WINDIR ?? env.SystemRoot
  if (root === undefined || root === '') return undefined
  return join(root, 'System32', 'reg.exe')
}

/**
 * Parse one marker file. Unreadable and unshaped files are left in place: not
 * being able to read a file is not proof that its owner is gone, and a newer
 * process may still know the format (D8).
 * @returns The record, or undefined when it cannot be interpreted.
 */
function readMarkerRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      logForDebugging('jumpback: marker file left in place', { path, reason: 'not a JSON object' })
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    logForDebugging('jumpback: marker file left in place', { path, detail: describe(error) })
    return undefined
  }
}

/** Remove one stale marker file; a removal that fails only leaves the file. */
function removeStale(path: string, reason: string): void {
  try {
    rmSync(path, { force: true })
    logForDebugging('jumpback: removed a stale marker file', { path, reason })
  } catch (error) {
    logForDebugging('jumpback: stale marker file removal failed', { path, detail: describe(error) })
  }
}

/** Why the probe did not answer 0: a timeout or the helper's own exit code. */
function probeFailure(result: ExecFileNoThrowResult): string {
  if (result.code === null) {
    return `the helper timed out after ${PROBE_TIMEOUT_MS} ms or was killed`
  }
  const detail = firstOutputLine(result)
  return detail === ''
    ? `the helper exited with code ${result.code}`
    : `the helper exited with code ${result.code}: ${detail}`
}

/** The first line a failed command printed, the only clue a debug log can carry. */
function firstOutputLine(result: ExecFileNoThrowResult): string {
  for (const stream of [result.stderr, result.stdout]) {
    const line = stream.trim().split(/\r?\n/u)[0]
    if (line !== '') return line.slice(0, 300)
  }
  return ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
