/**
 * The channel's real model names, from the environment the CLI child runs
 * with. Relay channels sell cosmetic tier names ("Opus 5.5 (1M)") while
 * routing the request to a different model — and the runtime stream cannot
 * correct the display, because such relays echo the requested name back in
 * `message_start.model` (observed on a bigmodel.cn anthropic-compat channel:
 * a `claude-opus-5-5` request echoed `claude-opus-5-5` while the same channel
 * leaked the real `glm-5.3-flash` on the haiku tier). The user's own
 * ANTHROPIC_*_MODEL mapping in the settings `env` is the only honest source,
 * so the model list surfaces it: when a row's requested id maps to a
 * different configured model, the label becomes the actual model and the
 * cosmetic name moves into the description. Real Claude setups (no such
 * env, or a mapping that resolves to the same model) render exactly as
 * before.
 *
 * @module dsh-tui/backends/claude/modelEnv
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** tier keyword → the env keys naming its configured model. */
const TIER_ENV_KEYS: readonly (readonly [tier: string, modelKey: string, nameKey: string])[] = [
  ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
  ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
  ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
  ['fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'],
]

/** Compare ids without the `[1m]` context-window suffix or letter case. */
const baseOf = (id: string): string => id.replace(/\[(1m)\]$/i, '').toLowerCase()

/** The truth API the model list consumes (structural: no import cycle). */
export interface ModelEnvTruth {
  /** The model the channel actually routes `requestedId` to, when the
   *  configuration says it differs; undefined = display as-is. */
  actualFor(requestedId: string): string | undefined
}

/**
 * The active channel profile's mapping (channels.ts): `models` are exact
 * requested-id → actual entries (matched exactly, then base-normalized);
 * `tiers` map a tier keyword (haiku/opus/sonnet/fable, plus the reserved
 * `default` for the any-model rule) to the model serving it — the settings
 * env heuristics promoted to the user's own data, so they outrank both the
 * legacy model-names.json and the env itself.
 */
export interface ChannelModelSource {
  readonly models?: Readonly<Record<string, string>>
  readonly tiers?: Readonly<Record<string, string>>
}

const pick = (env: Record<string, string | undefined>, key: string): string | undefined => {
  const value = env[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read the env the CLI applies from `<configDir>/settings.json` (best-effort:
 *  absent/unreadable/malformed means no values, never an error). */
export function readSettingsEnvForModels(configDir: string): Record<string, string | undefined> {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { env?: unknown }
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) return {}
    const out: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The user-maintained local map, `<DATA_DIR>/backends/claude/model-names.json`
 * (`{ "claude-opus-5-5[1m]": "glm-5.3[1M]", ... }`): ids a relay channel
 * disguises → the name to display. Optional and additive on top of the
 * settings env tiers; checked first so a hand-written entry always wins
 * (the /provider-style escape hatch when the channel tool renames its env
 * shape). Best-effort: absent/unreadable/malformed reads as no entries.
 */
export function readLocalModelNames(dir: string): Readonly<Record<string, string>> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'model-names.json'), 'utf8')) as unknown
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key.trim() !== '' && typeof value === 'string' && value.trim() !== '') out[key.trim()] = value.trim()
    }
    return out
  } catch {
    return {}
  }
}

/** Build the channel-model truth from the tier env the caller resolved
 *  (mergedModelEnv — the CLI's own three-layer order, see there) plus the
 *  optional local model-names.json map, which outranks it — and the active
 *  channel profile (channels.ts), which outranks everything. */
export function readModelEnvTruth(
  env: Record<string, string | undefined>,
  localNames: Readonly<Record<string, string>> = {},
  channel?: ChannelModelSource,
): ModelEnvTruth {
  return {
    actualFor(requestedId: string): string | undefined {
      if (requestedId === '') return undefined
      // The active channel profile is the user's own data: its exact models
      // map wins over every heuristic below (like model-names.json, an
      // explicit entry is always honored — even one mapping an id to itself).
      const channelModels = channel?.models
      if (channelModels !== undefined) {
        const exact = channelModels[requestedId]
        if (exact !== undefined) return exact
      }
      const base = baseOf(requestedId)
      if (channelModels !== undefined) {
        for (const [key, value] of Object.entries(channelModels)) {
          if (baseOf(key) === base) return value
        }
      }
      // Then the profile's tier rules — the env heuristics promoted to user
      // data, guarded the same way (a tier mapping to the requested model
      // itself changes nothing; the lower sources still get their say).
      const channelTiers = channel?.tiers
      if (channelTiers !== undefined) {
        for (const [tier, actual] of Object.entries(channelTiers)) {
          if (tier !== 'default' && base.includes(tier)) {
            return baseOf(actual) !== base ? actual : undefined
          }
        }
        const fallback = channelTiers.default
        if (fallback !== undefined) {
          return base !== 'default' && baseOf(fallback) !== base ? fallback : undefined
        }
      }
      const local = localNames[requestedId]
      if (local !== undefined) return local
      for (const [key, value] of Object.entries(localNames)) {
        if (baseOf(key) === base) return value
      }
      const id = base
      for (const [tier, modelKey, nameKey] of TIER_ENV_KEYS) {
        if (id.includes(tier)) {
          const actual = pick(env, modelKey) ?? pick(env, nameKey)
          return actual !== undefined && baseOf(actual) !== id ? actual : undefined
        }
      }
      const fallback = pick(env, 'ANTHROPIC_MODEL')
      return fallback !== undefined && id !== 'default' && baseOf(fallback) !== id ? fallback : undefined
    },
  }
}

/** The model slots the CLI's env routing reads: `ANTHROPIC_MODEL` pins
 *  every tier, `ANTHROPIC_DEFAULT_<TIER>_MODEL` one tier's slot. */
const SLOT_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_MODEL',
  ...TIER_ENV_KEYS.map(([, modelKey]) => modelKey),
]

/**
 * Whether the env the CLI child runs with already routes to `model`
 * through its model slots: some slot's value — compared as base ids,
 * `[1M]`-style suffixes and letter case ignored — names the same model.
 * The session's explicit `model` query parameter can then be omitted:
 * the CLI's SDK path (2.1.284+) resolves an explicit model against the
 * bundled official catalog and fail-fasts a non-official name (a relay
 * model) as `[claude-code:unrecognized_model]`, while the same name in
 * an env slot routes fine — the parameter would only add a failing
 * catalog check on top of routing that already serves that model.
 */
export function envSlotsServeModel(
  env: Record<string, string | undefined>,
  model: string,
): boolean {
  if (model === '') return false
  const base = baseOf(model)
  for (const key of SLOT_ENV_KEYS) {
    const slot = pick(env, key)
    if (slot !== undefined && baseOf(slot) === base) return true
  }
  return false
}

/** The env the CLI child actually applies, in the CLI's own order: keys
 *  the TUI put in the flag layer (`injectedKeys`: the channel connection,
 *  the first-party pin) > the settings file's `env` > the inherited env.
 *  The CLI applies the settings `env` over the environment it inherited, so
 *  an inherited key only fills gaps. Empty live values never clobber
 *  anything. */
export function mergedModelEnv(
  configDir: string,
  liveEnv: Readonly<Record<string, string | undefined>>,
  injectedKeys?: ReadonlySet<string>,
): Record<string, string | undefined> {
  const merged = readSettingsEnvForModels(configDir)
  for (const [key, value] of Object.entries(liveEnv)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    if (injectedKeys?.has(key) === true) merged[key] = value
    else if (!Object.hasOwn(merged, key)) merged[key] = value
  }
  return merged
}

/** The env "import from settings" reads: the settings file plus the
 *  inherited environment (settings first), without the TUI's own
 *  injections. Reading those back would import the channel the TUI itself
 *  activated: switch settings to relay B, import, get relay A back. */
export function importedModelEnv(
  configDir: string,
  liveEnv: Readonly<Record<string, string | undefined>>,
  injectedKeys?: ReadonlySet<string>,
): Record<string, string | undefined> {
  const merged = readSettingsEnvForModels(configDir)
  for (const [key, value] of Object.entries(liveEnv)) {
    if (injectedKeys?.has(key) === true) continue
    if (typeof value === 'string' && value.trim() !== '' && !Object.hasOwn(merged, key)) merged[key] = value
  }
  return merged
}

/** One-shot wiring for the session: settings env of `configDir` + live env
 *  (the CLI's flag > settings > inherited order), the optional local
 *  model-names.json map, and the active channel profile. */
export function modelTruthFrom(
  configDir: string,
  liveEnv: Readonly<Record<string, string | undefined>>,
  localNames: Readonly<Record<string, string>> = {},
  channel?: ChannelModelSource,
  injectedKeys?: ReadonlySet<string>,
): ModelEnvTruth {
  return readModelEnvTruth(mergedModelEnv(configDir, liveEnv, injectedKeys), localNames, channel)
}
