/**
 * The kernel last picked in the launchpad kernel selector, at
 * `~/.dsh-tui/kernel.json` (`{ "backend": "claude" }`). It is only the
 * default for the next launch: `dsh-tui --backend`, the Config row and
 * DSH_TUI_BACKEND all win over it. Boot only reads it; the selector's accept
 * path is the only writer, so an explicit `--backend` launch does not change
 * it.
 *
 * Best effort like the other ~/.dsh-tui preferences: a missing or broken file
 * reads as no preference, and writes go through a temp file + rename so a
 * reader sees the old or the new document, never half of one.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** Kernels the TUI can run on (the Config.backend values). */
export const KERNEL_IDS = ['dsh', 'claude', 'codex'] as const
export type KernelBackendId = typeof KERNEL_IDS[number]

export function isKernelId(value: unknown): value is KernelBackendId {
  return typeof value === 'string' && (KERNEL_IDS as readonly string[]).includes(value)
}

/**
 * Per-kernel facts: the picker label, the product a version belongs to, and
 * whether the host can install a missing kernel itself (the Claude SDK
 * wizard); the others only say how (their detection hint).
 */
export const KERNEL_INFO: Record<KernelBackendId, { labelKey: string; product: string; installable: boolean }> = {
  dsh: { labelKey: 'kernel-label-dsh', product: 'dsh-core', installable: false },
  claude: { labelKey: 'kernel-label-claude', product: 'claude-code', installable: true },
  codex: { labelKey: 'kernel-label-codex', product: 'codex-cli', installable: false },
}

/** Brand names used by kernel chips and notices. */
export function kernelDisplayName(id: string): string {
  return id === 'dsh' ? 'DSH' : id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : id
}

/** Stored shape. */
export interface KernelPrefsData {
  readonly backend?: KernelBackendId
}

/** Keep only a valid backend value; anything else reads as no preference. */
function parseKernelPrefs(parsed: unknown): KernelPrefsData {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const backend = (parsed as Record<string, unknown>).backend
  return isKernelId(backend) ? { backend } : {}
}

/** Read the preference; missing, broken or unreadable means none. Never throws. */
export function readKernelPrefs(file: string = join(DATA_DIR, 'kernel.json')): KernelPrefsData {
  try {
    return parseKernelPrefs(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

/** Makes every temp file name unique within this process. */
let temporarySequence = 0
/** Wait cell for the Windows rename retry below. */
const waitCell = new Int32Array(new SharedArrayBuffer(4))

/** Rename the temp file over the target. Windows can refuse with a
 *  transient EPERM/EBUSY while another process reads the file, so those are
 *  retried briefly; any other error throws and leaves the old file alone. */
function renameIntoPlace(temporary: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, target)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code) : ''
      if (process.platform !== 'win32' || attempt >= 7 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      Atomics.wait(waitCell, 0, 0, 2 ** attempt)
    }
  }
}

/** Write the preference atomically; a failure goes to the debug log, never throws. */
export function writeKernelPrefs(
  data: KernelPrefsData,
  file: string = join(DATA_DIR, 'kernel.json'),
  debug: (message: string) => void = () => undefined,
): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameIntoPlace(temporary, file)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The old file is still intact; nothing else to do.
    }
    debug(`dsh-tui: kernel prefs write failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** Same rules as dsh-adapter's normalizeBackendChoice (kept local so this
 *  module does not import the adapter): trimmed, case-insensitive; empty or
 *  unknown gives undefined. */
function normalizeBackend(value: string | undefined): KernelBackendId | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return isKernelId(id) ? id : undefined
}

/**
 * The kernel this one boot must land on, set by a kernel switch (restartTui's
 * backend option) and by the launcher's crash retry. Boot deletes it from
 * process.env as soon as it reads it. Unlike DSH_TUI_BACKEND it ranks above
 * the Config row: with `backend: dsh` in the config, a switch to claude would
 * otherwise restart straight back onto dsh. Ordinary launches keep
 * config > env > remembered choice.
 */
export const KERNEL_SWITCH_HANDOFF_ENV = 'DSH_TUI_BACKEND_HANDOFF'

/**
 * The kernel boot runs on (plugin.ts backendChoice): a valid switch handoff
 * first, then the Config row, then DSH_TUI_BACKEND, then the remembered
 * choice, else dsh. An invalid DSH_TUI_BACKEND still means dsh, which is what
 * the boot warning says, rather than falling through to the remembered
 * choice; an invalid handoff value is ignored. Pure.
 */
export function resolveRememberedBackend(input: {
  /** KERNEL_SWITCH_HANDOFF_ENV, normalized; undefined on ordinary launches. */
  readonly handoff?: KernelBackendId | undefined
  /** Config.backend (normalized by the schema). */
  readonly configured?: KernelBackendId | undefined
  /** process.env.DSH_TUI_BACKEND as given. */
  readonly envRaw?: string | undefined
  /** The kernel remembered in kernel.json. */
  readonly memory?: KernelBackendId | undefined
}): KernelBackendId {
  if (isKernelId(input.handoff)) return input.handoff
  if (isKernelId(input.configured)) return input.configured
  const env = normalizeBackend(input.envRaw)
  if (env !== undefined) return env
  if (input.envRaw !== undefined && input.envRaw.trim() !== '') return 'dsh'
  return input.memory ?? 'dsh'
}
