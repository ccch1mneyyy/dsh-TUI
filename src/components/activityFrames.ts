/**
 * Working-activity indicator presets — thin re-export of the single source
 * of truth in the `dsh-working-activity` package (`src/frames.ts`). The TUI
 * keeps this shim so existing importers (`/activity` picker, status line,
 * channel, activity prefs) resolve the same names without moving; all preset
 * data (the pi-extension union, 35 presets) lives upstream.
 * @module dsh-tui/components/activityFrames
 */

import { FRAME_PRESETS as upstreamPresets, type FramePreset } from 'dsh-working-activity/frames'
export type { FramePreset }

export const DEFAULT_PRESET = 'moon8'

/**
 * Read compatibility for saved preferences; the picker only offers current
 * names. `claude` is a pre-rename preset id (kept upstream by
 * dsh-working-activity for its own history): saved choices normalize to the
 * moon8 default instead of rendering the retired brand preset.
 */
export function normalizeActivityPreset(name: string | undefined): string | undefined {
  return name === 'claude' ? DEFAULT_PRESET : name
}

export const FRAME_PRESETS: Record<string, FramePreset> = Object.fromEntries(
  Object.entries(upstreamPresets).filter(([name]) => normalizeActivityPreset(name) === name),
)
export const PRESET_NAMES: readonly string[] = ['random', ...Object.keys(FRAME_PRESETS)]

export function isPresetName(name: string): boolean {
  const current = normalizeActivityPreset(name)!
  return current === 'random' || Object.hasOwn(FRAME_PRESETS, current)
}

export function resolvePreset(name: string | undefined): FramePreset {
  const current = normalizeActivityPreset(name)
  const names = Object.keys(FRAME_PRESETS)
  return FRAME_PRESETS[current === 'random' ? names[Math.floor(Math.random() * names.length)] : current ?? DEFAULT_PRESET]
    ?? FRAME_PRESETS[DEFAULT_PRESET]
}
