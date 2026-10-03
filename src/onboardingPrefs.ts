/**
 * First-run onboarding state, at `~/.dsh-tui/onboarding.json`.
 *
 * Deliberately NOT a cordis config value: "has this installation already
 * walked the user through setup" is per-machine UI state, like the lang and
 * home preferences next to it — not a deployment choice a cordis.yml row
 * should own. A repo-wide pinned config would make the wizard either always
 * fire or never fire, and neither is what "first run" means.
 *
 * Two fields, and the split matters:
 *
 *   - `completed` — the user reached the end and pressed 完成. Written on the
 *     way OUT, never at boot: a process that dies before the first frame
 *     (a config error, a crash during render) must not burn the
 *     installation's only first run. Same rule as homePrefs' `seen`.
 *   - `version` — the wizard revision that was completed. A future wizard
 *     that adds a step can re-fire on installs sitting on an older revision
 *     without needing a second file. Absent/0 means "completed by a build
 *     that did not stamp one", which the caller reads as "completing, but
 *     worth re-offering if it ever grows a new step".
 *
 * Best effort, like every other pref here: a missing, unreadable or corrupt
 * file simply means "not done yet". The worst outcome of a broken pref file
 * is one extra wizard — recoverable with a single Esc.
 *
 * @module @deepseek-harness-tui/dsh-tui/onboardingPrefs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const FILE = 'onboarding.json'

/**
 * The wizard revision this build writes. Bump it when a step is ADDED (not
 * when copy changes): installs completed at an older revision become
 * eligible again, which is the point — a new domain is worth one more pass.
 */
export const ONBOARDING_VERSION = 1

/** Persisted first-run state. */
export interface OnboardingPrefs {
  /** True once the wizard ran to completion on this installation. */
  completed: boolean
  /** The wizard revision that was completed (0 when an older build did not stamp one). */
  version: number
}

/** Not-done-yet, the answer for every unreadable file. */
export const ONBOARDING_UNSEEN: OnboardingPrefs = { completed: false, version: 0 }

/**
 * Parse a persisted onboarding record. Pure, so the shape rules are testable
 * without a filesystem: anything that is not an object with a literal
 * `completed: true` reads as unseen.
 *
 * @param text - Raw file contents.
 * @returns The normalized record.
 */
export function parseOnboardingPrefs(text: string): OnboardingPrefs {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ONBOARDING_UNSEEN
    const raw = parsed as Record<string, unknown>
    const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version > 0
      ? Math.floor(raw.version)
      : 0
    return { completed: raw.completed === true, version }
  } catch {
    return ONBOARDING_UNSEEN
  }
}

/**
 * Read the persisted onboarding state.
 *
 * @param dir - Prefs directory (injectable for tests).
 * @returns The normalized record; unseen when the file is absent or unreadable.
 */
export function readOnboardingPrefs(dir: string = DATA_DIR): OnboardingPrefs {
  try {
    return parseOnboardingPrefs(readFileSync(join(dir, FILE), 'utf8'))
  } catch {
    return ONBOARDING_UNSEEN
  }
}

/**
 * Record that the wizard completed (best effort).
 *
 * @param version - The wizard revision being stamped.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the record was durably written; false when the data
 *   directory is not writable. The caller stays silent either way — the
 *   preference is a convenience, not a promise.
 */
export function markOnboardingDone(version: number = ONBOARDING_VERSION, dir: string = DATA_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, FILE),
      `${JSON.stringify({ completed: true, version }, null, 2)}\n`,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * Whether this install should be offered the wizard on an ordinary launch.
 *
 * The single place the "should it fire" question is answered, so the host
 * boot decision and any future `/setup` entry point cannot drift apart.
 *
 * @param prefs - The record read at boot (or a fixture in a test).
 * @returns True when the wizard has never been completed at this revision.
 */
export function shouldOfferOnboarding(prefs: OnboardingPrefs = readOnboardingPrefs()): boolean {
  return !prefs.completed || prefs.version < ONBOARDING_VERSION
}
