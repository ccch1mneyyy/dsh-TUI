/**
 * Landing-screen preference for the TUI's workspace home screen.
 *
 * A one-key preference under `~/.dsh-tui/home.json`, deliberately NOT a cordis
 * config value: "has this installation shown the user the workspace home on a
 * fresh launch yet" is per-machine UI state, like the lang and tray
 * preferences next to it — not a deployment choice a cordis.yml row should own.
 *
 * The rule it enables is one-shot: the FIRST ordinary launch (no explicit
 * `--resume`, no workspace target) lands on the workspace home instead of a
 * blank conversation, because that is the launch where "which project am I
 * working on" has no answer yet. After that the chat screen is the landing
 * surface again, and the home screen stays reachable as a screen.
 *
 * A preference file that cannot be read or written is never fatal: the worst
 * outcome is one extra home screen, or a chat screen where the home was
 * expected. Both are recoverable with a single keypress.
 *
 * @module @deepseek-harness-tui/dsh-tui/homePrefs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldOfferOnboarding } from './onboardingPrefs.js'
import { DATA_DIR } from './utils/paths.js'

const PREFS_FILE = join(DATA_DIR, 'home.json')

interface HomePrefs {
  /** True once the workspace home has been shown as the landing screen. */
  seen?: boolean
}

/** Read the persisted landing preference; an unreadable file reads as unset. */
export function readHomePrefs(): HomePrefs {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const seen = (parsed as { seen?: unknown }).seen
    return typeof seen === 'boolean' ? { seen } : {}
  } catch {
    return {}
  }
}

/**
 * Record that the workspace home has been shown.
 *
 * @returns True when the preference was durably written; false when the data
 *   directory is not writable (the caller stays silent — see the module note).
 */
export function markHomeSeen(): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(PREFS_FILE, `${JSON.stringify({ ...readHomePrefs(), seen: true }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** What a launch said about where it wants to land. */
export interface HomeLandingInputs {
  /** `readHomePrefs().seen === true`. */
  readonly homeSeen: boolean
  /** An explicit resume target (`--resume` / `-c` / the launcher's env handoff). */
  readonly launchSessionId: string | undefined
  /** An explicit workspace target (cordis.yml `workspace` / the launcher's env handoff). */
  readonly requestedWorkspace: string | undefined
  /** The first prompt from app argv (`''` when none). */
  readonly initialPrompt: string
}

/**
 * Whether this launch lands on the workspace home screen.
 *
 * Only an ORDINARY launch is eligible: an explicit resume, an explicit
 * workspace target, and a first prompt all mean the user already said where
 * they want to be, and covering that with a browser would be the TUI
 * second-guessing them.
 *
 * The one rule both launch paths use — the plugin at mount, and the `dst`
 * preload before dsh runs (src/preboot/mount.ts) — so the boot phase's first
 * frame is already the page the live session shows: a flip at the handoff
 * would cover what the user typed and turn the next keys into home shortcuts.
 */
export function decideOpenHomeOnBoot(inputs: HomeLandingInputs): boolean {
  return !inputs.homeSeen
    && inputs.launchSessionId === undefined
    && inputs.requestedWorkspace === undefined
    && inputs.initialPrompt === ''
}

/**
 * 落地页 / 首启引导该不该在这次启动出现。
 *
 * 只看「用户有没有说要回到哪儿」：`--resume` 目标与首句都算他知道自己要去哪。
 * **工作区目标不算**——`dst` 默认把 cwd 当工作区目标喂进来，算进去就等于在本机
 * 最主流的启动方式下把这两个屏永久关掉（实测事故）。home（会话与工作区）还多认
 * 一条「没说在哪儿干活」，见 decideOpenHomeOnBoot。
 *
 * @param input.launchSessionId - 本次要恢复的会话（--resume / DSH_TUI_RESUME_SESSION）。
 * @param input.initialPrompt - 命令行里带的首句提示词（无则空串）。
 * @returns true 表示这次是「普通启动」。
 */
export function isLandingLaunch(input: { launchSessionId?: string; initialPrompt: string }): boolean {
  return input.launchSessionId === undefined && input.initialPrompt === ''
}

/**
 * Whether this launch starts on the launchpad.
 *
 * The launchpad is NOT one-shot the way the workspace home is: every
 * ordinary launch starts on it, because it is where the first sentence gets
 * typed rather than a tutorial that retires itself. `DSH_TUI_NO_LAUNCHPAD=1`
 * is the escape hatch (an automation that wants the old blank conversation
 * and no dialog in front of it).
 *
 * Shared by the plugin and the `dst` preload, like decideOpenHomeOnBoot:
 * Chat seeds the launchpad once, so the boot frame must already agree.
 */
export function decideLaunchpadOnBoot(
  input: { launchSessionId?: string; initialPrompt: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isLandingLaunch(input) && env.DSH_TUI_NO_LAUNCHPAD !== '1'
}

/**
 * Whether this launch opens the first-run guide. Gated on its own preference
 * (not on the home's `seen`): the two answer different questions, and an
 * install that already knows its workspace may still never have configured a
 * key. Shared by the plugin and the `dst` preload.
 */
export function decideOnboardingOnBoot(input: { launchSessionId?: string; initialPrompt: string }): boolean {
  return isLandingLaunch(input) && shouldOfferOnboarding()
}
