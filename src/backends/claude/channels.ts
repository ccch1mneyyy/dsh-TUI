/**
 * The Claude backend's channel profiles (`~/.dsh-tui/backends/claude/
 * channels.json`): the relay channels the user routes through, each with the
 * model mapping that says what a requested id actually runs. First-class user
 * data on purpose — the settings-env tier heuristics (modelEnv.ts) guess the
 * mapping from ANTHROPIC_*_MODEL; a profile states it.
 *
 * Shape:
 *
 * ```json
 * {
 *   "active": "zhipu",
 *   "channels": [
 *     {
 *       "id": "zhipu",
 *       "name": "智谱",
 *       "baseUrl": "https://open.bigmodel.cn/api/anthropic",
 *       "tokenRef": "CHANNEL_OPEN_BIGMODEL_CN_TOKEN",
 *       "env": { "ANTHROPIC_LOG": "debug" },
 *       "models": { "claude-opus-5-5[1m]": "glm-5.3[1M]" },
 *       "tiers": { "opus": "glm-5.3[1M]", "haiku": "glm-5.3-flash" }
 *     }
 *   ]
 * }
 * ```
 *
 * `models` is an exact id → actual map (matched exactly, then
 * base-normalized like model-names.json); `tiers` maps a tier keyword
 * (haiku/opus/sonnet/fable, plus `default` for the ANTHROPIC_MODEL
 * fallback) to the model that serves it — the env heuristics promoted to
 * user data. Both fields are optional.
 *
 * A profile can also carry the session's connection: `baseUrl` is the
 * relay endpoint the CLI child is pointed at, `tokenRef` names its
 * credential in the DSH credential store (`~/.dsh/.credentials.yaml`, as
 * /provider does; channels.json never holds a token) and `env` holds
 * channel-private variables. The active profile's connection is injected at
 * spawn (auth.ts: the child env plus the SDK `settings` flag layer, which
 * outranks the CLI settings `env`).
 *
 * Best-effort like every `~/.dsh-tui` preference (prefs.ts): a missing or
 * corrupt file reads as no channels (a corrupt one is moved aside by the
 * next save, never overwritten), a failed write is reported to the caller's
 * debug log and the session carries on. The id is a stable slug of the name,
 * so a re-import (or a hand edit) refreshes the same row.
 */
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { channelProfileSlug } from '../shared/channel-slug.js'
import { writeFileAtomic } from '../shared/atomic-file.js'

/** One relay channel. */
export interface ClaudeChannelProfile {
  /** Stable slug of the name (the file's join key). */
  readonly id: string
  /** Human-facing label (picker rows, notices). */
  readonly name: string
  /** Exact requested-id → actual model (optional). */
  readonly models?: Readonly<Record<string, string>>
  /** Tier keyword → actual model (optional; `default` = the any-model rule). */
  readonly tiers?: Readonly<Record<string, string>>
  /** The relay endpoint the CLI child is pointed at (optional). */
  readonly baseUrl?: string
  /** The credential-store ref holding the channel token (optional; never
   *  the token itself). */
  readonly tokenRef?: string
  /** Channel-private env layered under baseUrl/token at spawn (optional). */
  readonly env?: Readonly<Record<string, string>>
}

/** What persists. */
export interface ClaudeChannelsData {
  /** The id of the channel whose mapping is live; absent = none. */
  readonly active?: string
  readonly channels: readonly ClaudeChannelProfile[]
}

/** Read / switch / upsert access (injectable: tests use an in-memory store). */
export interface ClaudeChannels {
  read(): ClaudeChannelsData
  /** Make `id` the active channel (a no-op when no such channel exists). */
  setActive(id: string): void
  /** Insert or refresh one profile by id (a re-import refreshes in place). */
  save(profile: ClaudeChannelProfile): void
  /** Drop one profile by id; a dangling `active` goes
   *  with it (no channel left active until the next pick). */
  remove(id: string): void
}

const FILE = 'channels.json'

/** The stable id of a channel name (shared with the /channel wizard). */
export const channelSlug = channelProfileSlug

/** Narrow one parsed object to a string→string record (empty keys/values drop). */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && key.trim() !== '' && entry.trim() !== '') out[key.trim()] = entry.trim()
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** Narrow a parsed document to what persists (anything else reads as absent). */
export function parseChannels(parsed: unknown): ClaudeChannelsData {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { channels: [] }
  const record = parsed as Record<string, unknown>
  const channels: ClaudeChannelProfile[] = []
  for (const raw of Array.isArray(record.channels) ? record.channels : []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id.trim() === '') continue
    const id = entry.id.trim()
    if (channels.some(channel => channel.id === id)) continue
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
    const models = stringMap(entry.models)
    const tiers = stringMap(entry.tiers)
    const baseUrl = typeof entry.baseUrl === 'string' && entry.baseUrl.trim() !== '' ? entry.baseUrl.trim() : undefined
    const tokenRef = typeof entry.tokenRef === 'string' && entry.tokenRef.trim() !== '' ? entry.tokenRef.trim() : undefined
    const channelEnv = stringMap(entry.env)
    channels.push({
      id, name,
      ...(models === undefined ? {} : { models }),
      ...(tiers === undefined ? {} : { tiers }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(tokenRef === undefined ? {} : { tokenRef }),
      ...(channelEnv === undefined ? {} : { env: channelEnv }),
    })
  }
  const active = typeof record.active === 'string' && channels.some(channel => channel.id === record.active)
    ? record.active
    : undefined
  return { channels, ...(active === undefined ? {} : { active }) }
}

/** The channel whose mapping is live (undefined when none is active). */
export function activeProfileOf(data: ClaudeChannelsData): ClaudeChannelProfile | undefined {
  return data.active === undefined ? undefined : data.channels.find(channel => channel.id === data.active)
}

/** Apply `setActive` (pure): a no-op for an id the file does not hold. */
function activated(current: ClaudeChannelsData, id: string): ClaudeChannelsData {
  return current.channels.some(channel => channel.id === id) ? { ...current, active: id } : current
}

/** Apply `save` (pure): an upsert by id that keeps the roster order. */
function saved(current: ClaudeChannelsData, profile: ClaudeChannelProfile): ClaudeChannelsData {
  const index = current.channels.findIndex(channel => channel.id === profile.id)
  return { ...current, channels: index === -1 ? [...current.channels, profile] : current.channels.map((channel, at) => at === index ? profile : channel) }
}

/** Apply `remove` (pure): the row goes, and `active` with it when it
 *  named the removed channel (nothing else changes). */
function removed(current: ClaudeChannelsData, id: string): ClaudeChannelsData {
  const channels = current.channels.filter(channel => channel.id !== id)
  if (channels.length === current.channels.length) return current
  const active = current.active === id ? undefined : current.active
  return { channels, ...(active === undefined ? {} : { active }) }
}

/** The file-backed profiles under `<dir>` (the host's `dataDir` for this
 *  backend). The directory is required: a backend never picks a location of
 *  its own under the host's data directory (D2, B-3). */
export function fileClaudeChannels(dir: string, debug: (message: string) => void = () => undefined): ClaudeChannels {
  const path = join(dir, FILE)
  /** The document, and whether a file is there that could not be read or
   *  parsed (it reads as no channels). */
  const load = (): { readonly data: ClaudeChannelsData; readonly damaged: boolean } => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { data: { channels: [] }, damaged: code !== 'ENOENT' && code !== 'ENOTDIR' }
    }
    try {
      return { data: parseChannels(JSON.parse(text)), damaged: false }
    } catch {
      return { data: { channels: [] }, damaged: true }
    }
  }
  const read = (): ClaudeChannelsData => load().data
  const commit = (next: ClaudeChannelsData): void => {
    try {
      writeFileAtomic(dir, FILE, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      debug(`claude: channels write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return {
    read,
    setActive: id => {
      const current = read()
      if (current.active === id) return
      if (!current.channels.some(channel => channel.id === id)) {
        debug(`claude: channels setActive ignored unknown id ${id}`)
        return
      }
      commit(activated(current, id))
    },
    save: profile => {
      const current = load()
      if (current.damaged) {
        // A damaged file (a hand edit gone wrong) still holds the user's
        // profiles: it moves aside instead of being replaced by this save.
        const aside = `${path}.damaged-${Date.now()}`
        try {
          renameSync(path, aside)
          debug(`claude: channels.json could not be read; kept as ${aside}`)
        } catch (error) {
          debug(`claude: channels.json could not be read nor moved aside (${error instanceof Error ? error.message : String(error)}); not saving`)
          return
        }
      }
      commit(saved(current.data, profile))
    },
    remove: id => {
      const current = read()
      if (!current.channels.some(channel => channel.id === id)) {
        debug(`claude: channels remove ignored unknown id ${id}`)
        return
      }
      commit(removed(current, id))
    },
  }
}

/** An in-memory store (tests, embedders without a home directory). */
export function memoryClaudeChannels(initial: ClaudeChannelsData = { channels: [] }): ClaudeChannels & { readonly data: ClaudeChannelsData } {
  let data: ClaudeChannelsData = parseChannels(initial)
  return {
    get data() { return data },
    read: () => data,
    setActive: id => { data = activated(data, id) },
    save: profile => { data = saved(data, profile) },
    remove: id => { data = removed(data, id) },
  }
}

/** The tier env keys the import reads (modelEnv.ts's TIER_ENV_KEYS, restated
 *  for the env→tiers promotion; `default` carries ANTHROPIC_MODEL). */
const IMPORT_TIER_KEYS: readonly (readonly [tier: string, envKey: string])[] = [
  ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
]

const pickEnv = (env: Record<string, string | undefined>, key: string): string | undefined => {
  const value = env[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The channel profile hiding in the CLI settings `env`: the ANTHROPIC_BASE_URL
 * host names it, the ANTHROPIC_DEFAULT_*_MODEL (+ ANTHROPIC_MODEL) values
 * become its tiers. Exact `models` are never guessed — those stay the user's
 * own hand-written entries, and a re-import of the same id keeps them.
 * Undefined when the env holds neither a base URL nor any model value.
 */
export function importFromSettingsEnv(
  env: Record<string, string | undefined>,
  existing?: ClaudeChannelProfile,
): ClaudeChannelProfile | undefined {
  const baseUrl = pickEnv(env, 'ANTHROPIC_BASE_URL')
  let host: string | undefined
  if (baseUrl !== undefined) {
    try {
      host = new URL(baseUrl).host || undefined
    } catch {
      host = undefined
    }
  }
  const tiers: Record<string, string> = {}
  for (const [tier, envKey] of IMPORT_TIER_KEYS) {
    const model = pickEnv(env, envKey)
    if (model !== undefined) tiers[tier] = model
  }
  const fallback = pickEnv(env, 'ANTHROPIC_MODEL')
  if (fallback !== undefined) tiers.default = fallback
  if (host === undefined && Object.keys(tiers).length === 0) return undefined
  const name = host ?? pickEnv(env, 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME') ?? 'settings'
  const id = channelSlug(name)
  // A refresh of the same channel keeps the user's exact models and the
  // connection fields the env cannot speak to (the import only owns what it
  // can honestly derive: name + tiers + a parseable base URL — an invalid
  // one names the channel but never becomes the connection).
  const keeps = existing !== undefined && existing.id === id
  const models = keeps ? existing.models : undefined
  const importedBaseUrl = host === undefined ? undefined : baseUrl
  const keptBaseUrl = keeps && importedBaseUrl === undefined ? existing.baseUrl : undefined
  const tokenRef = keeps ? existing.tokenRef : undefined
  const channelEnv = keeps ? existing.env : undefined
  return {
    id, name,
    ...(models === undefined ? {} : { models }),
    ...(Object.keys(tiers).length === 0 ? {} : { tiers }),
    ...(importedBaseUrl === undefined && keptBaseUrl === undefined ? {} : { baseUrl: importedBaseUrl ?? keptBaseUrl }),
    ...(tokenRef === undefined ? {} : { tokenRef }),
    ...(channelEnv === undefined ? {} : { env: channelEnv }),
  }
}

/** The channel token in the CLI settings env: the value of
 *  `ANTHROPIC_AUTH_TOKEN`, for the caller to move into the credential store
 *  — the profile itself only ever records the derived `tokenRef`. */
export function importTokenFromSettingsEnv(env: Record<string, string | undefined>): string | undefined {
  return pickEnv(env, 'ANTHROPIC_AUTH_TOKEN')
}

/** A channel profile's connection carries anything spawn-shaping. */
export function hasChannelConnection(profile: ClaudeChannelProfile | undefined): boolean {
  return profile !== undefined && (profile.baseUrl !== undefined || profile.tokenRef !== undefined
    || (profile.env !== undefined && Object.keys(profile.env).length > 0))
}
