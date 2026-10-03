/**
 * The profile-level renderer decision (`~/.dsh-tui/renderer.json`), recorded
 * by the plugin so the `dst` preload can mount the boot slot with the same
 * renderer.
 *
 * `fullscreen` and `terminalImages` are fixed per Ink instance and per root
 * wrap, so a boot slot mounted with the wrong pair has to be disposed and
 * re-mounted when dsh is up — a visible switch, another OSC 11 probe and the
 * boot screen's state thrown away. The preload runs before dsh composes the
 * profile and cannot read its cordis.yml; the settings.yaml user layer it CAN
 * read (and that layer wins over cordis.yml on both sides). What is missing
 * is the cordis.yml answer, which is what the plugin records here: the
 * decision it makes when settings.yaml is silent, per profile (two profiles
 * can disagree, and alternating between them must not flip-flop).
 *
 * Best effort in both directions: an unreadable file means "unknown" (the
 * preload falls back to the schema defaults, exactly as before this file
 * existed) and a failed write only costs the next start one re-mount.
 *
 * @module @deepseek-harness-tui/dsh-tui/rendererPrefs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const FILE_NAME = 'renderer.json'

/** The two renderer options a mounted Ink instance cannot change. */
export interface RendererDecision {
  readonly fullscreen: boolean
  readonly terminalImages: boolean
}

/** Profile name → decision; the empty key stands for "no `--profile`". */
type RendererFile = { profiles: Record<string, RendererDecision> }

const keyOf = (profile: string | undefined): string => profile ?? ''

function readFile(dir: string): RendererFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8'))
    const profiles = parsed !== null && typeof parsed === 'object'
      ? (parsed as { profiles?: unknown }).profiles
      : undefined
    if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) return { profiles: {} }
    const result: Record<string, RendererDecision> = {}
    for (const [key, value] of Object.entries(profiles as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const { fullscreen, terminalImages } = value as Record<string, unknown>
      if (typeof fullscreen === 'boolean' && typeof terminalImages === 'boolean') {
        result[key] = { fullscreen, terminalImages }
      }
    }
    return { profiles: result }
  } catch {
    return { profiles: {} }
  }
}

/**
 * The decision last recorded for `profile`, or undefined when none is.
 * @param profile - `--profile` name (undefined for a bare launch).
 * @param dir - Prefs directory (injectable for tests).
 */
export function readRendererDecision(profile: string | undefined, dir: string = DATA_DIR): RendererDecision | undefined {
  return readFile(dir).profiles[keyOf(profile)]
}

/**
 * Record the decision for `profile`; a no-op when it is already recorded.
 * @returns True when the file holds `decision` afterwards.
 */
export function writeRendererDecision(profile: string | undefined, decision: RendererDecision, dir: string = DATA_DIR): boolean {
  const file = readFile(dir)
  const key = keyOf(profile)
  const current = file.profiles[key]
  if (current?.fullscreen === decision.fullscreen && current.terminalImages === decision.terminalImages) return true
  try {
    mkdirSync(dir, { recursive: true })
    const next: RendererFile = {
      profiles: { ...file.profiles, [key]: { fullscreen: decision.fullscreen, terminalImages: decision.terminalImages } },
    }
    writeFileSync(join(dir, FILE_NAME), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
