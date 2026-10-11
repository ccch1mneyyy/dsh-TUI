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
import { isBackendIdSyntax, type BackendId } from './agent/backend-manifest.js'
import { DATA_DIR } from './utils/paths.js'

/**
 * The backends that ship inside this package, in picker order. They are the
 * registry's seed and the vocabulary the launcher's messages use — **not** the
 * validation source any more: since P0 D1 any syntactically valid id may name a
 * plugin backend, and membership is decided by
 * `src/dsh-adapter/backend-registry.ts` (which the launcher cannot import when
 * it runs without compiled modules, hence the mirrored copy in `bin/dsh-tui.js`).
 */
export const BUILTIN_BACKEND_IDS = ['dsh', 'claude', 'codex'] as const

/**
 * An id that passed the id-syntax gate (the rule and the brand live in
 * `agent/backend-manifest.ts`, next to the manifest that declares it).
 *
 * It marks "validated input", which is what the session-ref and path builders
 * need. *Membership* ("is this backend installed?") is a runtime question:
 * `parseBackendChoice()` in the registry answers both halves, and the boot falls
 * back to dsh when the second half misses — exactly like an unknown value always
 * did (P0 D1).
 */
export type KernelBackendId = BackendId

/** The fallback every path lands on. `dsh` passes the syntax gate by
 *  construction and is always registered, so it needs no runtime check. */
export const DSH_BACKEND_ID = 'dsh' as KernelBackendId

/**
 * The first half of the parse: trim, lowercase, id syntax. Anything else (a
 * blank, a typo, `has:colon`, `a/b`) is undefined, which every caller reads as
 * "no choice made". The second half — is it registered? — belongs to the
 * registry, which is deliberately not imported here (this module is reachable
 * from the UI, which may not import the adapter).
 */
export function parseBackendId(value: unknown): KernelBackendId | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return isBackendIdSyntax(id) ? id : undefined
}

/** Stored shape. */
export interface KernelPrefsData {
  readonly backend?: KernelBackendId
}

/** Keep only a valid backend value; anything else reads as no preference. */
function parseKernelPrefs(parsed: unknown): KernelPrefsData {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const backend = parseBackendId((parsed as Record<string, unknown>).backend)
  return backend === undefined ? {} : { backend }
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
 * The package's own entry, which hosts every kernel by default (routing in
 * hostEntryRoute.ts). Kept here so src/update.ts does not pull that module in.
 * `DSH_TUI_HOST_ENTRY=0` keeps every kernel on `dsh --profile`.
 */
const HOST_ENTRY_ENV = 'DSH_TUI_HOST_ENTRY'
/** The entry's path, set by the launcher: every replacement
 *  relaunches through it (src/update.ts restartArgv). */
export const HOST_ENTRY_PATH_ENV = 'DSH_TUI_HOST_ENTRY_PATH'

export function hostEntryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOST_ENTRY_ENV] === '0'
}

/** Why the entry could not use the installed dsh; set by the entry, read and
 *  cleared once by the runtime (plugin.ts), also in a delegated `dsh --profile`. */
export const HOST_NOTICE_ENV = 'DSH_TUI_HOST_NOTICE'

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
  /**
   * Whether DSH_TUI_BACKEND names an *installed* backend. Absent means the
   * syntax gate alone, which is what callers without a registry (the
   * crash-retry regressions) can offer. The boot passes the registry's
   * `isRegisteredBackend`: an uninstalled plugin id must fall back to dsh
   * exactly like a typo does, instead of reaching `loadBackend()` and crashing
   * the boot on a pinned choice (P0 D1).
   */
  readonly envKnown?: ((id: string) => boolean) | undefined
  /** The kernel remembered in kernel.json. */
  readonly memory?: KernelBackendId | undefined
}): KernelBackendId {
  const handoff = parseBackendId(input.handoff)
  if (handoff !== undefined) return handoff
  const configured = parseBackendId(input.configured)
  if (configured !== undefined) return configured
  const env = parseBackendId(input.envRaw)
  if (env !== undefined && (input.envKnown === undefined || input.envKnown(env))) return env
  if (input.envRaw !== undefined && input.envRaw.trim() !== '') return DSH_BACKEND_ID
  return input.memory ?? DSH_BACKEND_ID
}

/**
 * The backend a **derived** resume target was read from (launcher → boot handoff).
 *
 * `DSH_TUI_RESUME_SESSION` alone cannot be trusted across backends. The launcher
 * derives a bare `--resume` target from the chosen backend's own
 * `backends/<id>/prefs.json` (`envFromLastRun` does the same from `last-run.json`),
 * and this boot may then land on a *different* backend: an uninstalled plugin id
 * falls back to dsh (P0 D1), and an unset `DSH_TUI_BACKEND` follows the remembered
 * kernel instead. Handing the id to whoever booted resumes the wrong backend's
 * session, or fails on one that never heard of it. This variable records the
 * source so the boot can refuse it.
 *
 * An id the user placed themselves (`--resume <id>`, a Config row, `/restart`)
 * carries no mark — where it belongs is theirs to decide, and the boot only says
 * what it knows. Boot deletes this from process.env as soon as it reads it,
 * exactly like {@link KERNEL_SWITCH_HANDOFF_ENV}.
 */
export const RESUME_BACKEND_ENV = 'DSH_TUI_RESUME_BACKEND'

/**
 * Marks a boot the launcher started as the safe-mode **retry** (`dsh-tui safe`
 * → option 1, and the first-run fallback that shares it).
 *
 * A retry derives its target from `last-run.json` — "the kernel and session that
 * were running when the crash happened" — and the recorded kernel may no longer
 * be in the registry, which is exactly the case {@link resolveResumeTarget}
 * revokes. Failing the boot there would close the user's last way back, so a
 * retry gets the tolerated branch instead: warn, then cold-start on the kernel
 * that did open. The launcher sets it for the whole retry env, the boot deletes
 * it as soon as it reads it (one-shot, like the mark above), and it never
 * reaches the plugin protocol — `lastSession` and this handoff are implementation
 * details, not a backend contract (roadmap §6 item 11).
 */
export const RESUME_RETRY_ENV = 'DSH_TUI_RESUME_RETRY'

/**
 * What the boot must do with the resume request it inherited.
 *
 * The four outcomes the decision names (roadmap §6 item 11): only the selected
 * backend is ever asked, a target is bound to the backend that derived it, and a
 * request that cannot be honored fails the boot instead of degrading into a cold
 * start or a session nobody asked for. `none` and `usable` are the two ordinary
 * outcomes; `revoked` carries everything the caller needs to report the refusal —
 * which backend the target came from, and whether the refusal is allowed to be
 * soft (safe-mode retry only).
 */
export type ResumeTarget =
  /** No resume request survives (nothing was asked for, or the id was blank). */
  | { readonly kind: 'none' }
  /** Hand this id to `backendChoice`, the backend this boot landed on. */
  | { readonly kind: 'usable'; readonly sessionId: string }
  /**
   * A **derived** target whose source backend is not the one this boot landed on.
   * `fatal` says how loud the refusal is: `true` fails the boot (the target is
   * neither carried across nor silently replaced by a new session), `false`
   * (safe-mode retry) only warns and lets the boot continue on `backendChoice`.
   */
  | { readonly kind: 'revoked'; readonly from: KernelBackendId; readonly fatal: boolean }

/**
 * Whether a resume target may be handed to the backend this boot landed on. A
 * derived target is usable only on the backend it came from; a revoked one is
 * dropped rather than carried over, which is why the result hands the source back
 * for the caller's refusal instead of returning nothing. Pure.
 */
export function resolveResumeTarget(input: {
  /** The id as given: DSH_TUI_RESUME_SESSION, else Config.sessionId. */
  readonly sessionId?: string | undefined
  /** RESUME_BACKEND_ENV, normalized. Absent = the user named the target. */
  readonly sourceBackend?: KernelBackendId | undefined
  /** The backend this boot landed on (plugin.ts `backendChoice`). */
  readonly backendChoice: KernelBackendId
  /** RESUME_RETRY_ENV: a safe-mode retry must survive a revoked target. */
  readonly retry?: boolean | undefined
}): ResumeTarget {
  const sessionId = input.sessionId?.trim()
  if (sessionId === undefined || sessionId === '') return { kind: 'none' }
  if (input.sourceBackend === undefined || input.sourceBackend === input.backendChoice) {
    return { kind: 'usable', sessionId }
  }
  return { kind: 'revoked', from: input.sourceBackend, fatal: input.retry !== true }
}
