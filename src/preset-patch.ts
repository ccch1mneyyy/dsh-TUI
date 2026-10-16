/**
 * Declarative row config for the agent presets dsh-tui registers
 * (`standard`, `ptc`, `minimal`, `cordis`, `liangshen`). Rows inside a preset
 * live in its own realm, out of reach of an id-targeted cordis patch; a row
 * naming this module replaces their `config` by id instead. The row itself
 * does nothing when it activates. Usage: seam VII of
 * tui-profile/docs/plugin-admission-and-development.md.
 *
 * @module
 */

export const name = 'dsh-tui-preset-patch'

/** Module name a preset-patch row uses. */
export const PRESET_PATCH_MODULE = '@deepseek-harness-tui/dsh-tui/preset-patch'

/** The config of one preset-patch row. */
export interface PresetPatchConfig {
  /** Preset id, e.g. `standard`. */
  preset: string
  /** Row id inside the preset → replacement `config` for that row. */
  config: Record<string, unknown>
}

export function apply(): void {}
