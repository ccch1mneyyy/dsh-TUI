/**
 * The Windows toast transport (DESIGN D3/D4/D8/D10/D11/D12): the only place the
 * renderer talks to the Windows shell about task-completion notifications.
 *
 * It answers three questions, and a caller should not need anything else:
 *   - can this process show a native toast?      {@link windowsToastAvailability}
 *   - show one                                  {@link notifyWindowsToast}
 *   - is an external notifier already doing it? {@link shouldYieldToExternalNotifier}
 *
 * Every system side effect sits behind the win32 guard and behind the injected
 * ports, so a POSIX process that reaches this module anyway neither writes the
 * registry nor builds the helper nor spawns anything (AC-7/D12). Reaching it is
 * the unusual case: nothing imports it at load time - the host loads it for the
 * first toast and the title hook for the first Windows title - so a POSIX process
 * does not load it at all.
 *
 * Showing is in-box PowerShell 5.1 + WinRT, one process per notification (D3):
 * the ~3 s cold start of `powershell.exe` is the accepted cost of adding no
 * resident helper (R1). That process is started without a console of this one's
 * ({@link toastHostSpawnOptions}), because a PowerShell host renames the console
 * it runs on, and the session's tab title is how a click finds its way back
 * (UAT-M4). The process is not kept alive for the click either -
 * Windows activates the `dsh-tui:` URI handler instead (D4), so nothing here
 * waits for the user.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logForDebugging } from '../utils/debug.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../utils/execFileNoThrow.js'
import { ensureActivateHelper } from './notify-helper/compile.js'
import type { ActivateHelperResult, EnsureActivateHelperOptions, RunCommand } from './notify-helper/compile.js'
import { stringWidth } from './stringWidth.js'
import { truncateToWidth } from './truncateToWidth.js'
import { DATA_DIR } from '../utils/paths.js'

/** The AppUserModelID the toast is shown under (spike H, 2026-10-16). */
export const TOAST_AUMID = 'dsh-tui'

/** The URI scheme a clicked toast activates (D4). */
export const NOTIFY_SCHEME = 'dsh-tui'

/**
 * The AUMID key. Writing it is what makes the toast display at all: an
 * unregistered AUMID answers `Show()` in 15 ms without an error and shows
 * nothing (E2), which is why "registration succeeded" - not `Show()` - is the
 * success signal this module reports (D11).
 */
export const AUMID_REGISTRY_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${TOAST_AUMID}`

/**
 * The icon the AUMID registers, and the two depths it can be found at: tsc
 * emits this module into `lib/types/ink/` (the packaged tree) while the source
 * sits at `src/ink/` (the repo), so the same pair of relative paths
 * `components/maidPortrait.tsx` resolves its art with. `assets` is in the
 * package's `files`, so an installed package really ships it.
 *
 * The shell resolves `IconUri` with no working directory of ours, and the UAT
 * (2026-10-16) found the previous value - in-box `powershell.exe`, an executable
 * with no icon index - rendering no icon at all. A path that does not exist is
 * therefore worse than no icon: it leaves nothing to diagnose.
 */
const TOAST_ICON_CANDIDATES = [
  '../../../assets/whale-girl/whale-girl.png',
  '../../assets/whale-girl/whale-girl.png',
]

/**
 * The image file this package ships for the toast, or undefined when the
 * install has none (a pruned tree, a layout change) - {@link registerAumid}
 * then registers no icon rather than a broken one.
 */
function shippedToastIcon(): string | undefined {
  return TOAST_ICON_CANDIDATES
    .map(relative => fileURLToPath(new URL(relative, import.meta.url)))
    .find(candidate => existsSync(candidate))
}

/** The protocol handler key; the `shell\open\command` under it runs the helper. */
export const PROTOCOL_REGISTRY_KEY = `HKCU\\Software\\Classes\\${NOTIFY_SCHEME}`

/** Marks the key as a protocol handler. Windows checks that it exists, not what it holds. */
const URL_PROTOCOL_VALUE = 'URL Protocol'

/**
 * The packages whose presence in a profile's `dependencies` means another
 * notifier already covers task completions, so this transport stands down
 * (D8/AC-6). This constant is the only place those names live - to support one
 * more external notifier, add its package name here. The match is an exact
 * dependency key, so list the spelling a profile actually pins: real profiles
 * pin the scoped name.
 */
export const EXTERNAL_NOTIFIER_PACKAGES: readonly string[] = [
  '@baobaolaodie/cc-dsh-notifier',
  'cc-dsh-notifier',
]

/** `reg.exe` answers in milliseconds; a write that takes longer is stuck, not slow. */
const REGISTRY_TIMEOUT_MS = 15_000

/** Why nothing can be delivered when `%WINDIR%` is missing; the one wording for both answers. */
const SYSTEM_ROOT_MISSING_DETAIL = '%WINDIR% is not set, so reg.exe and powershell.exe cannot be located'

/** PowerShell's cold start measures 3.1-3.4 s and the toast body 0.8-1.1 s (spike C/E1). */
const TOAST_TIMEOUT_MS = 30_000

/**
 * The toast body, run by in-box PowerShell 5.1 (D3). Two details are load
 * bearing and were both measured on a real machine:
 *   - the three WinRT types have to be loaded explicitly. Windows PowerShell
 *     does not project them on demand, and `New-Object` otherwise fails with
 *     "Cannot find type [Windows.Data.Xml.Dom.XmlDocument]";
 *   - the XML arrives on stdin and is decoded as UTF-8 explicitly, because
 *     `[Console]::In` decodes with the console code page (CP936 on this
 *     machine), which mangles every non-ASCII summary.
 */
const TOAST_SCRIPT = `$ErrorActionPreference='Stop'
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$i=[Console]::OpenStandardInput()
$m=New-Object System.IO.MemoryStream
$i.CopyTo($m)
$x=[System.Text.Encoding]::UTF8.GetString($m.ToArray())
$d=New-Object Windows.Data.Xml.Dom.XmlDocument
$d.LoadXml($x)
$t=New-Object Windows.UI.Notifications.ToastNotification $d
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_AUMID}').Show($t)`

// --- how the toast host is started (T-FIX-05) ----------------------------------

/** How much of a host's output is kept; the bound `execFileNoThrow` applies too. */
const MAX_CAPTURE_BYTES = 64 * 1024

/**
 * How the toast host is started: as a console application with no console.
 *
 * Showing a toast means running in-box `powershell.exe` (D3), and a PowerShell
 * host sets the console title as it starts. A child that inherits this process's
 * console therefore renames the session's tab - measured 2026-10-16, before and
 * after one toast: `✦ 🐋 [dsh-tui:42672]` became `Windows PowerShell` - and a
 * click on the toast then finds no tab carrying the marker (UAT-M4).
 *
 * `windowsHide` is what keeps that console away: Windows starts the child with
 * CREATE_NO_WINDOW, so it has none of its own to retitle, while the pipes below
 * still carry its XML and its failure text. Both halves were measured on a real
 * machine (2026-10-16): the host runs - a write to disk and its stdout arrive,
 * exit 0, 2.1 s for the real toast body whose `Show()` did not throw - and the
 * console title is left alone, against the same measurement with today's options,
 * which clobbered it with `Windows PowerShell`.
 *
 * `detached: true` (DETACHED_PROCESS) was measured and rejected: the title
 * survived there too, but the host exited after ~0.4 s without running the script
 * at all - a silent no-op that would trade a dead click for a toast that never
 * appears. Do not swap one for the other without repeating that measurement.
 * @returns The spawn options the toast host is started with.
 */
export function toastHostSpawnOptions(): SpawnOptions {
  return {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }
}

/**
 * Run the toast host under {@link toastHostSpawnOptions}, with `execFileNoThrow`'s
 * contract: never throws, bounded output, and a timeout. `code` is 1 when the
 * host could not be started at all.
 *
 * A spawn of its own rather than that helper, because the console has to be kept
 * from this one child: `reg.exe` and the helper compiler share the caller's
 * console with no consequence, and `execFileNoThrow` - which they use - inherits
 * it, with no option to say otherwise.
 * @param file - The in-box host to run.
 * @param args - Its argv.
 * @param options - The stdin payload and the timeout, as `execFileNoThrow` takes them.
 * @returns What the host answered.
 */
function spawnConsoleLess(file: string, args: readonly string[], options?: ExecFileNoThrowOptions): Promise<ExecFileNoThrowResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { ...toastHostSpawnOptions(), timeout: options?.timeout })
    } catch {
      resolve({ code: 1, stdout: '', stderr: '' })
      return
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const stdoutTotal = { value: 0 }
    const stderrTotal = { value: 0 }
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    }
    const collect = (chunks: Buffer[], total: { value: number }) => (chunk: Buffer): void => {
      if (total.value >= MAX_CAPTURE_BYTES) return
      const part = chunk.subarray(0, MAX_CAPTURE_BYTES - total.value)
      chunks.push(part)
      total.value += part.length
    }
    child.stdout?.on('data', collect(stdoutChunks, stdoutTotal))
    child.stderr?.on('data', collect(stderrChunks, stderrTotal))
    child.stdin?.on('error', () => {})
    child.on('error', () => finish(1))
    child.on('close', code => finish(code))
    if (options?.input !== undefined) child.stdin?.write(options.input)
    child.stdin?.end()
  })
}

// --- the pure layer (D10) ------------------------------------------------------

/**
 * The session marker `[dsh-tui:<pid>]` and its ONE construction site: the title
 * hook appends it to the terminal title, and `notify-helper/activate.cs` matches
 * it as an opaque substring of a Windows Terminal tab name. Both depend on this
 * format - formatting it a second time anywhere would break the click.
 * @param pid The TUI process whose window a click should come back to.
 * @returns The marker as it appears in the title.
 */
export function markerFor(pid: number): string {
  return `[dsh-tui:${pid}]`
}

/**
 * The URI a clicked toast activates (D4). The marker is percent-encoded, so
 * `[dsh-tui:2718]` travels as `%5Bdsh-tui%3A2718%5D`; the helper reverses it
 * with `Uri.UnescapeDataString`.
 * @param marker A marker from {@link markerFor}.
 * @returns The `launch` URI for the toast.
 */
export function activationUri(marker: string): string {
  return `${NOTIFY_SCHEME}:activate?m=${encodeURIComponent(marker)}`
}

/**
 * Escape the four characters that would otherwise end a text node or an
 * attribute value (AC-8). A summary is arbitrary model output, so nothing may
 * reach the XML unescaped.
 * @param text Raw text from the renderer.
 * @returns The same text, safe inside XML text and double-quoted attributes.
 */
export function escapeXmlText(text: string): string {
  // `&` first: escaping it after `&lt;` would double-escape the entities.
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** The parts of a task-completion toast. */
export interface ToastContent {
  /** First line; the renderer passes its localized title (AC-1). */
  title: string
  /** Second line: the single-line summary. Omitted when empty, clipped by {@link clampSummary}. */
  message?: string
  /** Session marker for the click; without it the toast has no activation. */
  marker?: string
}

/**
 * How much summary the toast body may carry, in display columns. Windows clips
 * the body itself at around four rendered lines and stops mid-sentence with no
 * ellipsis at all - the UAT screenshot (2026-10-16) ended on "…(和 Claude (" -
 * so the budget has to be ours. Two of the roughly 43-column lines that
 * screenshot rendered is ~86 columns; 80 leaves margin for the wider glyphs of
 * other locales and is measured with {@link stringWidth}, the display width the
 * terminal side uses, so a CJK summary is not silently given twice the room of
 * a Latin one.
 */
const TOAST_MESSAGE_MAX_WIDTH = 80

/**
 * Clip a summary to {@link TOAST_MESSAGE_MAX_WIDTH}, with an ellipsis that says
 * the text continues. The ellipsis is one of those columns, so the text keeps
 * the rest. Cuts by display width, so it never stops between the two halves of
 * a wide glyph.
 * @param message The single-line summary from the renderer.
 * @returns The summary, whole or clipped.
 */
function clampSummary(message: string): string {
  if (stringWidth(message) <= TOAST_MESSAGE_MAX_WIDTH) return message
  return `${truncateToWidth(message, TOAST_MESSAGE_MAX_WIDTH - 1)}…`
}

/**
 * Build the ToastGeneric document (D10). The activation is `protocol` with a
 * `launch` URI, because PowerShell cannot receive the click in-process (E3).
 * @param content Title, summary and the marker to come back to.
 * @returns The XML handed to `XmlDocument.LoadXml` on the PowerShell side.
 */
export function toastXml(content: ToastContent): string {
  const activation = content.marker === undefined
    ? ''
    : ` activationType="protocol" launch="${escapeXmlText(activationUri(content.marker))}"`
  const texts = [`<text>${escapeXmlText(content.title)}</text>`]
  if (content.message !== undefined && content.message !== '') {
    texts.push(`<text>${escapeXmlText(clampSummary(content.message))}</text>`)
  }
  return `<toast${activation}><visual><binding template="ToastGeneric">${texts.join('')}</binding></visual></toast>`
}

/**
 * The command line Windows runs for a `dsh-tui:...` activation. `-DataDir` is
 * not optional: the shell starts the handler without this process's
 * environment, so a handler without it logs into the user's real
 * `%USERPROFILE%\.dsh-tui` even during an isolated run.
 * @param exePath The compiled activation helper's product.
 * @param dataDir The data directory the handler must use.
 * @returns The command line for `shell\open\command`.
 */
export function protocolCommand(exePath: string, dataDir: string): string {
  return `"${exePath}" "%1" -DataDir "${dataDir}"`
}

// --- the port types -----------------------------------------------------------

/** One HKCU value write; the default port shells out to in-box `reg.exe`. */
export interface RegistryPort {
  /**
   * @param key One of this module's own keys.
   * @param name Value name, or null for the key's default value.
   * @param value The string to store.
   * @returns Success, or the reason the write was refused. Never throws.
   */
  setValue(key: string, name: string | null, value: string): Promise<RegistryWriteResult>
}

export type RegistryWriteResult = { ok: true } | { ok: false, detail: string }

/** The in-box tools this transport drives, resolved from `%WINDIR%`. */
interface NotifyTools {
  /** `reg.exe`, the only registry writer. */
  reg: string
  /** `powershell.exe`, which renders the toast through WinRT. */
  powershell: string
}

/** Every port is injectable so the regression never writes the registry or spawns. */
export interface WindowsToastTransportOptions {
  /** Where the helper and its cache live; defaults to `~/.dsh-tui` (D9). */
  dataDir?: string
  /** The pid the title marker carries; defaults to this process (D7). */
  pid?: number
  /** Platform override for the regression; production is `process.platform`. */
  platform?: NodeJS.Platform
  /** Environment for the `%WINDIR%` lookups; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Registry port; defaults to in-box `reg.exe` on this module's own HKCU keys. */
  registry?: RegistryPort
  /**
   * Where the toast's icon comes from; defaults to {@link shippedToastIcon},
   * which looks for the file the package ships. `undefined` registers no icon
   * at all rather than a path the shell cannot read.
   */
  iconPath?: () => string | undefined
  /** Helper build port; defaults to compile.ts's `ensureActivateHelper`. */
  ensureHelper?: (options: EnsureActivateHelperOptions) => Promise<ActivateHelperResult>
  /**
   * Process runner for `reg.exe` and the helper compiler; defaults to
   * `execFileNoThrow`. Not the toast host's: that one must not inherit this
   * console, so it has {@link WindowsToastTransportOptions.runToastHost}.
   */
  run?: RunCommand
  /**
   * Process runner for the toast host; defaults to the console-less spawn
   * ({@link toastHostSpawnOptions}). A port of its own because "which runner"
   * is exactly the difference between a session whose tab keeps its marker and
   * one whose click lands nowhere (UAT-M4).
   */
  runToastHost?: RunCommand
  /** Clock, so the log can report how long the toast spawn took (R1); defaults to `Date.now`. */
  now?: () => number
  /** Log sink; defaults to `logForDebugging`. */
  log?: (message: string, fields?: Record<string, unknown>) => void
}

export type WindowsToastFailure =
  | 'not-win32'
  /** No `%WINDIR%`, so neither in-box tool can be located. */
  | 'system-root-missing'
  /** D11: the toast cannot display, so the caller has to ring the bell instead (AC-5). */
  | 'aumid-registration-failed'
  /** The toast process failed; the caller rings the bell rather than going silent. */
  | 'toast-failed'
  | 'unexpected'

export type WindowsToastAvailability =
  | { available: true }
  | { available: false, reason: 'yielded' | WindowsToastFailure, detail?: string }

export type WindowsToastResult =
  | { status: 'shown', marker: string | null }
  /** An external notifier owns task completions: no toast and no bell (AC-6). */
  | { status: 'yielded' }
  /** Nothing was delivered: the caller falls back to the bell, never to silence. */
  | { status: 'unavailable', reason: WindowsToastFailure, detail?: string }

export interface WindowsToastInput {
  /** The localized title (AC-1). */
  title: string
  /** Single-line summary; empty shows the title alone. */
  message?: string
  /** `<dshHome>/profiles/<profile>/package.json`, for the dedup read (D8). */
  profilePackageJsonPath?: string
}

/** The two overrides a caller may need before a notification exists. */
export interface WindowsToastAvailabilityQuery {
  /** Platform override for a regression; defaults to the transport's platform. */
  platform?: NodeJS.Platform
  /** The profile document to check for an external notifier (D8). */
  profilePackageJsonPath?: string
}

export interface WindowsToastTransport {
  /** Side-effect free: registration stays lazy, so this never touches the registry. */
  available(query?: WindowsToastAvailabilityQuery): WindowsToastAvailability
  /** Dedup, register, show. Never rejects: the caller treats this as fire-and-forget. */
  notify(input: WindowsToastInput): Promise<WindowsToastResult>
}

// --- the dedup decision (D8/AC-6) ---------------------------------------------

/**
 * Whether a profile that already runs an external notifier owns task-completion
 * notifications. The caller passes the path, so this module never has to guess
 * where a profile lives.
 *
 * A document that is missing or unreadable answers "no": an unreadable profile
 * is not evidence of another notifier, and guessing "yes" would drop the
 * notification silently.
 * @param profilePackageJsonPath `<dshHome>/profiles/<profile>/package.json`.
 * @returns true when one of {@link EXTERNAL_NOTIFIER_PACKAGES} is a dependency.
 */
export function shouldYieldToExternalNotifier(profilePackageJsonPath: string): boolean {
  let document: unknown
  try {
    document = JSON.parse(readFileSync(profilePackageJsonPath, 'utf8'))
  } catch {
    return false
  }
  if (typeof document !== 'object' || document === null) return false
  const dependencies = (document as { dependencies?: unknown }).dependencies
  if (typeof dependencies !== 'object' || dependencies === null) return false
  return EXTERNAL_NOTIFIER_PACKAGES.some(name => Object.hasOwn(dependencies, name))
}

// --- the transport ------------------------------------------------------------

/** A registration that succeeded, plus the tool a toast is spawned from. */
type Registration =
  | { ok: true, jumpBack: boolean, tools: NotifyTools }
  | { ok: false, reason: WindowsToastFailure, detail?: string }

/**
 * Create a transport with its own registration state. Production shares one
 * instance through {@link windowsToastAvailability}/{@link notifyWindowsToast},
 * because "the AUMID is registered" is a per-process fact (D11).
 * @param options Ports and paths; every one of them has a production default.
 * @returns The transport.
 */
export function createWindowsToastTransport(options: WindowsToastTransportOptions = {}): WindowsToastTransport {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run = options.run ?? execFileNoThrow
  const toastHost = options.runToastHost ?? spawnConsoleLess
  const log = options.log ?? logForDebugging
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const tools = toolsFor(env)
  const registry = options.registry ?? regExeRegistry(run, tools)
  const icon = options.iconPath ?? shippedToastIcon
  const ensureHelper = options.ensureHelper ?? ensureActivateHelper
  const dataDir = (): string => options.dataDir ?? DATA_DIR

  let settled: Registration | undefined
  let pending: Promise<Registration> | undefined

  const fail = (reason: WindowsToastFailure, detail?: string): Registration => {
    log('windows toast unavailable', detail === undefined ? { reason } : { reason, detail })
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
  }

  const unavailable = (reason: WindowsToastFailure, detail?: string): WindowsToastResult =>
    detail === undefined ? { status: 'unavailable', reason } : { status: 'unavailable', reason, detail }

  function available(query: WindowsToastAvailabilityQuery = {}): WindowsToastAvailability {
    if ((query.platform ?? platform) !== 'win32') return { available: false, reason: 'not-win32' }
    if (query.profilePackageJsonPath !== undefined && shouldYieldToExternalNotifier(query.profilePackageJsonPath)) {
      return { available: false, reason: 'yielded' }
    }
    // The same two refusals `register()` makes, in the same order: without an
    // in-box host to render the toast there is nothing to register, so a caller
    // asking for the title marker must not be told the toast is possible.
    if (tools === null) return { available: false, reason: 'system-root-missing', detail: SYSTEM_ROOT_MISSING_DETAIL }
    // Once a registration has failed it is final for this process (D11), and a
    // caller asking for the title marker has to see that too.
    if (settled !== undefined && !settled.ok) {
      return settled.detail === undefined
        ? { available: false, reason: settled.reason }
        : { available: false, reason: settled.reason, detail: settled.detail }
    }
    return { available: true }
  }

  function resolve(): Promise<Registration> {
    // One attempt per process: a policy that refuses the key will refuse it
    // again, and retrying it per notification would only add a round trip.
    pending ??= register()
      .catch((error: unknown) => fail('unexpected', describe(error)))
      .then(result => {
        settled = result
        return result
      })
    return pending
  }

  async function register(): Promise<Registration> {
    // D12: the platform gate comes before every other check, so a POSIX process
    // that reached this module still cannot write a key or build the helper.
    if (platform !== 'win32') return fail('not-win32')
    if (tools === null) return fail('system-root-missing', SYSTEM_ROOT_MISSING_DETAIL)
    const aumidFailure = await registerAumid(registry, icon(), log)
    if (aumidFailure !== undefined) return fail('aumid-registration-failed', aumidFailure)

    const helper = await ensureHelper({ dataDir: dataDir(), platform, env, run, log })
    if (!helper.ok) {
      // R3: the toast is still worth showing - only the jump-back is lost.
      log('windows toast: no jump-back handler, the toast still shows', { reason: helper.reason, detail: helper.detail })
      return { ok: true, jumpBack: false, tools }
    }
    const protocolFailure = await registerProtocol(registry, helper.exePath, dataDir())
    if (protocolFailure !== undefined) {
      log('windows toast: the URI handler was not registered, a click cannot come back', { detail: protocolFailure })
      return { ok: true, jumpBack: false, tools }
    }
    return { ok: true, jumpBack: true, tools }
  }

  async function show(input: WindowsToastInput, marker: string | null, powershell: string): Promise<WindowsToastResult> {
    const xml = toastXml({ title: input.title, message: input.message, marker: marker ?? undefined })
    const started = now()
    const result = await toastHost(powershell, ['-NoProfile', '-Command', TOAST_SCRIPT], { input: xml, timeout: TOAST_TIMEOUT_MS })
    if (result.code !== 0) {
      // The caller answers an `unavailable` with the bell, so the cause is the
      // only thing that explains why both a toast and a bell were needed.
      const detail = failureCause(result)
      log('windows toast failed to appear', { detail })
      return unavailable('toast-failed', detail)
    }
    log('windows toast shown', { ms: now() - started, jumpBack: marker !== null })
    return { status: 'shown', marker }
  }

  return {
    available,
    async notify(input: WindowsToastInput): Promise<WindowsToastResult> {
      try {
        const judgement = available({ profilePackageJsonPath: input.profilePackageJsonPath })
        if (!judgement.available) {
          if (judgement.reason === 'yielded') return { status: 'yielded' }
          return unavailable(judgement.reason, judgement.detail)
        }
        const registration = await resolve()
        if (!registration.ok) return unavailable(registration.reason, registration.detail)
        const marker = registration.jumpBack ? markerFor(pid) : null
        return await show(input, marker, registration.tools.powershell)
      } catch (error) {
        // The caller's path is fire-and-forget (the renderer cannot await a
        // notification), so a rejection here would surface as an unhandled one.
        log('windows toast failed', { detail: describe(error) })
        return unavailable('unexpected', describe(error))
      }
    },
  }
}

/**
 * The in-box tools under `%WINDIR%`, or null when there is no system root to
 * find them under. Resolved by absolute path, never through `PATH`.
 */
function toolsFor(env: Record<string, string | undefined>): NotifyTools | null {
  const windir = env.windir
  if (windir === undefined || windir === '') return null
  return {
    reg: join(windir, 'System32', 'reg.exe'),
    powershell: join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  }
}

/**
 * Create the AUMID key the shell needs before it will display anything (D11).
 *
 * DisplayName goes first because it is the write that creates the key. The
 * order cannot be repaired afterwards: the shell fixes an AUMID's identity the
 * first time it sees a notification for it, and never re-reads the key. The
 * 2026-10-16 UAT still showed the bare AUMID `dsh-tui` above a toast whose key
 * held `DisplayName` = `dsh-TUI` - and the notification database dates that
 * first sighting eight hours before this write first existed
 * (`NotificationHandler`, primary id `dsh-tui`, created 2026-10-15 21:33:04,
 * never modified). What this can promise is the order: every process writes
 * both values before its first `Show()`.
 *
 * @param registry The HKCU writer.
 * @param iconUri The image file to register, or undefined to register none.
 * @param log Where a refusal that costs only the icon is reported.
 * @returns Why the key could not be registered, or undefined on success.
 */
async function registerAumid(
  registry: RegistryPort,
  iconUri: string | undefined,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<string | undefined> {
  const display = await registry.setValue(AUMID_REGISTRY_KEY, 'DisplayName', 'dsh-TUI')
  if (!display.ok) return `DisplayName: ${display.detail}`
  if (iconUri === undefined) {
    // An icon is decoration: the toast renders without one, and a path the
    // shell cannot read renders nothing either - with nothing left to
    // diagnose. So a missing file registers no value instead of a bad one.
    log('windows toast: no icon file to register, the toast shows without one')
    return undefined
  }
  // IconUri only decorates the entry in Settings > Notifications, so a refusal
  // there costs the icon, not the toast.
  const icon = await registry.setValue(AUMID_REGISTRY_KEY, 'IconUri', iconUri)
  if (!icon.ok) log('windows toast: the AUMID icon was refused, the toast is unaffected', { detail: icon.detail })
  return undefined
}

/**
 * Point the `dsh-tui:` scheme at the compiled helper (D4).
 * @returns Why the handler could not be registered, or undefined on success.
 */
async function registerProtocol(registry: RegistryPort, exePath: string, dataDir: string): Promise<string | undefined> {
  const mark = await registry.setValue(PROTOCOL_REGISTRY_KEY, URL_PROTOCOL_VALUE, '')
  if (!mark.ok) return `${URL_PROTOCOL_VALUE}: ${mark.detail}`
  const handler = await registry.setValue(`${PROTOCOL_REGISTRY_KEY}\\shell\\open\\command`, null, protocolCommand(exePath, dataDir))
  return handler.ok ? undefined : `command: ${handler.detail}`
}

/**
 * The production registry port: one `reg.exe add` per value, always against the
 * key it is given - which is always one of this module's own HKCU keys.
 */
function regExeRegistry(run: RunCommand, tools: NotifyTools | null): RegistryPort {
  return {
    async setValue(key, name, value) {
      if (tools === null) return { ok: false, detail: '%WINDIR% is not set, so reg.exe cannot be located' }
      const args = ['add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', value, '/f']
      const result = await run(tools.reg, args, { timeout: REGISTRY_TIMEOUT_MS })
      // `reg.exe` is chatty about success too; only a non-zero exit matters.
      return result.code === 0 ? { ok: true } : { ok: false, detail: failureCause(result) }
    },
  }
}

/** The first line of a failed command's output, the only clue the caller gets. */
function failureCause(result: { code: number | null, stdout: string, stderr: string }): string {
  for (const stream of [result.stderr, result.stdout]) {
    const line = stream.trim().split(/\r?\n/u)[0]
    if (line !== '') return line
  }
  return `exited with code ${result.code}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- the shared instance ------------------------------------------------------

let shared: WindowsToastTransport | undefined

/**
 * Ask whether a native toast is possible, without any side effect. The title
 * hook reads this before it writes the `[dsh-tui:<pid>]` marker: a marker that
 * promises a jump-back must not appear while the transport cannot deliver.
 * @param query Platform override and/or the profile document (D8).
 * @returns Whether a toast can be attempted, and why not when it cannot.
 */
export function windowsToastAvailability(query: WindowsToastAvailabilityQuery = {}): WindowsToastAvailability {
  return (shared ??= createWindowsToastTransport()).available(query)
}

/**
 * Show one task-completion toast: stand down for an external notifier, register
 * once, then spawn the in-box host. Never rejects, and an unavailable transport
 * is reported so the caller can ring the bell instead (AC-5).
 * @param input Title, summary and the profile document for the dedup read.
 * @returns What happened, in terms the caller can act on.
 */
export function notifyWindowsToast(input: WindowsToastInput): Promise<WindowsToastResult> {
  return (shared ??= createWindowsToastTransport()).notify(input)
}
