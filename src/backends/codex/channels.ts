/** Codex Responses-API channels. Only token refs persist here; token I/O
 * comes from BackendHost.tokenStore and the backend-neutral shared seam.
 * Provider overrides stay in argv (§5.11): hosts are process-list-visible. */
import { createHash } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionCapabilities, ChannelProfileView } from '../../agent/capabilities.js'
import { channelProfileSlug } from '../../channel/channel-slug.js'
import { t } from '../../i18n.js'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomic } from '../shared/atomic-file.js'
import { channelTokenRef, type ChannelTokenStore } from '../shared/channel-tokens.js'
import { rec, str, type Rec } from './narrow.js'

export interface CodexChannelProfile {
  readonly id: string
  readonly name: string
  readonly baseUrl?: string
  readonly tokenRef?: string
  /** File input is validated at save/start; only Responses is supported. */
  readonly wireApi?: string
  readonly env?: Readonly<Record<string, string>>
  readonly models?: Readonly<Record<string, string>>
}
export interface CodexChannelsData {
  readonly active?: string
  readonly channels: readonly CodexChannelProfile[]
}
export interface CodexChannels {
  read(): CodexChannelsData
  setActive(id: string): void
  save(profile: CodexChannelProfile): void
  remove(id: string): void
}
export interface CodexChannelLaunch {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly injectedEnvKeys: readonly string[]
  readonly provider?: string
}
export interface CodexChannelsRuntime {
  readonly capability: NonNullable<SessionCapabilities['channels']>
  active(): CodexChannelProfile | undefined
  refreshConfig(config?: Rec): void
  launch(): CodexChannelLaunch
}

export const channelSlug = channelProfileSlug
export const CODEX_CHANNEL_TOKEN_ENV = 'DSH_TUI_CODEX_CHANNEL_TOKEN'
const FILE = 'channels.json'
const derivedRef = (id: string): string => channelTokenRef('codex-' + id)
const credentialEnv = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/iu

/** Reject credential-bearing URLs before either persistence or spawn. */
export function validateCodexBaseUrl(value: string): string {
  const fail = (): never => { throw new Error(t('codex-channel-url-invalid')) }
  const input = value.trim()
  if (input === '' || /[\s\\]/u.test(input) || input.includes('?') || input.includes('#')) return fail()
  let url: URL
  try { url = new URL(input) } catch { return fail() }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')))
    || url.username !== '' || url.password !== '') return fail()
  for (const encoded of url.pathname.split('/')) {
    let segment: string
    try { segment = decodeURIComponent(encoded) } catch { return fail() }
    if (/^(?:sk-|(?:api[_-]?key|key|token|secret)=)/iu.test(segment)
      || /^[A-Za-z0-9_]{24,}$/u.test(segment)
      || (/^[A-Za-z0-9_-]{24,}$/u.test(segment) && /[0-9A-Z_]/u.test(segment))
      || /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(segment)) return fail()
  }
  return url.href
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const entries = rec(value)
  if (entries === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) if (key.trim() !== '' && typeof value === 'string' && value.trim() !== '') out[key.trim()] = value.trim()
  return Object.keys(out).length === 0 ? undefined : out
}

/** Invalid endpoint rows remain selected so launch refuses, never silently
 * switching a hand-edited active connection to ambient OAuth credentials. */
export function parseCodexChannels(value: unknown): CodexChannelsData {
  const data = rec(value)
  const channels: CodexChannelProfile[] = []
  for (const raw of Array.isArray(data?.channels) ? data.channels : []) {
    const row = rec(raw)
    const id = str(row?.id)?.trim()
    if (id === undefined || !/^[a-z0-9][a-z0-9_-]*$/iu.test(id) || channels.some(profile => profile.id === id)) continue
    channels.push({
      id, name: str(row?.name)?.trim() || id,
      ...(typeof row?.baseUrl === 'string' && row.baseUrl !== '' ? { baseUrl: row.baseUrl.trim() } : {}),
      ...(typeof row?.tokenRef === 'string' && row.tokenRef !== '' ? { tokenRef: row.tokenRef } : {}),
      wireApi: str(row?.wireApi) ?? 'responses',
      ...(stringMap(row?.env) === undefined ? {} : { env: stringMap(row?.env) }),
      ...(stringMap(row?.models) === undefined ? {} : { models: stringMap(row?.models) }),
    })
  }
  const active = str(data?.active)
  return { channels, ...(channels.some(profile => profile.id === active) ? { active } : {}) }
}

function checked(profile: CodexChannelProfile): CodexChannelProfile {
  if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(profile.id)) throw new Error(t('codex-channel-id-invalid'))
  if (profile.wireApi !== undefined && profile.wireApi !== 'responses') throw new Error(t('codex-channel-wire-api-invalid'))
  for (const key of Object.keys(profile.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || credentialEnv.test(key)) throw new Error(t('codex-channel-env-invalid'))
  }
  return {
    id: profile.id, name: profile.name.trim() || profile.id, wireApi: 'responses',
    ...(profile.baseUrl === undefined ? {} : { baseUrl: validateCodexBaseUrl(profile.baseUrl) }),
    ...(profile.tokenRef === undefined ? {} : { tokenRef: profile.tokenRef }),
    ...(profile.env === undefined ? {} : { env: { ...profile.env } }),
    ...(profile.models === undefined ? {} : { models: { ...profile.models } }),
  }
}
const upsert = (data: CodexChannelsData, profile: CodexChannelProfile): CodexChannelsData => ({
  ...data, channels: data.channels.some(row => row.id === profile.id) ? data.channels.map(row => row.id === profile.id ? profile : row) : [...data.channels, profile],
})
const without = (data: CodexChannelsData, id: string): CodexChannelsData => ({
  channels: data.channels.filter(row => row.id !== id), ...(data.active === undefined || data.active === id ? {} : { active: data.active }),
})
export const activeProfileOf = (data: CodexChannelsData): CodexChannelProfile | undefined => data.channels.find(row => row.id === data.active)
export const hasChannelConnection = (profile: CodexChannelProfile | undefined): boolean => profile !== undefined && (profile.baseUrl !== undefined || profile.tokenRef !== undefined || Object.keys(profile.env ?? {}).length > 0)

/** Same atomic/upsert/damaged-file semantics as the mature Claude store. */
export function fileCodexChannels(dir = join(DATA_DIR, 'backends', 'codex'), debug: (message: string) => void = () => undefined): CodexChannels {
  const path = join(dir, FILE)
  const load = (): { data: CodexChannelsData; damaged: boolean } => {
    try { return { data: parseCodexChannels(JSON.parse(readFileSync(path, 'utf8'))), damaged: false } }
    catch (error) { return { data: { channels: [] }, damaged: !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') } }
  }
  const commit = (data: CodexChannelsData): void => {
    try { writeFileAtomic(dir, FILE, JSON.stringify(data, null, 2) + '\n') }
    catch { debug('codex: channels write failed') }
  }
  return {
    read: () => load().data,
    setActive: id => { const data = load().data; if (data.active !== id && data.channels.some(row => row.id === id)) commit({ ...data, active: id }) },
    save: profile => {
      const valid = checked(profile)
      const current = load()
      if (current.damaged) {
        try { renameSync(path, path + '.damaged-' + Date.now()) }
        catch { debug('codex: damaged channels file could not be moved aside; not saving'); return }
      }
      commit(upsert(current.data, valid))
    },
    remove: id => { const data = load().data; if (data.channels.some(row => row.id === id)) commit(without(data, id)) },
  }
}
export function memoryCodexChannels(initial: CodexChannelsData = { channels: [] }): CodexChannels {
  let data = parseCodexChannels(initial)
  return {
    read: () => data,
    setActive: id => { if (data.channels.some(row => row.id === id)) data = { ...data, active: id } },
    save: profile => { data = upsert(data, checked(profile)) },
    remove: id => { data = without(data, id) },
  }
}

/** The token only goes into the child environment, never an argv override. */
export function codexChannelLaunch(profile: CodexChannelProfile | undefined, tokens?: ChannelTokenStore): CodexChannelLaunch {
  if (!hasChannelConnection(profile) || profile === undefined) return { args: [], env: {}, injectedEnvKeys: [] }
  if (profile.baseUrl === undefined) throw new Error(t('codex-channel-url-required'))
  const valid = checked(profile)
  const token = valid.tokenRef === undefined ? undefined : tokens?.read(valid.tokenRef)
  if (token === undefined && new URL(valid.baseUrl!).protocol !== 'http:') throw new Error(t('codex-channel-token-missing', { name: valid.name }))
  const provider = 'dshtui-' + valid.id
  const overrides: Readonly<Record<string, string | boolean>> = {
    model_provider: provider,
    ['model_providers.' + provider + '.name']: valid.name,
    ['model_providers.' + provider + '.base_url']: valid.baseUrl!,
    ['model_providers.' + provider + '.wire_api']: 'responses',
    ['model_providers.' + provider + '.requires_openai_auth']: false,
    ...(token === undefined ? {} : { ['model_providers.' + provider + '.env_key']: CODEX_CHANNEL_TOKEN_ENV }),
  }
  const env = { ...valid.env, ...(token === undefined ? {} : { [CODEX_CHANNEL_TOKEN_ENV]: token }) }
  return { args: Object.entries(overrides).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]), env, injectedEnvKeys: Object.keys(env), provider }
}

function settingsImport(config: Rec | undefined, env: Readonly<Record<string, string | undefined>>): { profile: CodexChannelProfile; token?: string } | undefined {
  const provider = str(config?.model_provider)
  if (provider === undefined || provider === 'openai' || provider.startsWith('dshtui-')) return undefined
  const row = rec(rec(config?.model_providers)?.[provider])
  if (typeof row?.base_url !== 'string' || (row.wire_api != null && row.wire_api !== 'responses')) return undefined
  let baseUrl: string
  try { baseUrl = validateCodexBaseUrl(row.base_url) } catch { return undefined }
  const name = new URL(baseUrl).host
  const key = str(row.env_key)
  const token = key === undefined ? undefined : Object.entries(env).find(([name, value]) => name.toUpperCase() === key.toUpperCase() && value !== undefined && value !== '')?.[1]
  return { profile: { id: channelSlug(name), name, baseUrl, wireApi: 'responses' }, ...(token === undefined ? {} : { token }) }
}

/** Synchronous channel capability over a config/read snapshot. The TUI's
 * own dshtui-* provider is not re-imported as if it were user settings. */
export function createCodexChannelsRuntime(deps: {
  readonly store: CodexChannels
  readonly tokens?: ChannelTokenStore
  readonly config?: Rec
  readonly env?: Readonly<Record<string, string | undefined>>
}): CodexChannelsRuntime {
  let config = deps.config
  const { store, tokens } = deps
  const view = (profile: CodexChannelProfile): ChannelProfileView => {
    let baseUrl: string | undefined
    try { if (profile.baseUrl !== undefined) baseUrl = validateCodexBaseUrl(profile.baseUrl) } catch { /* unsafe URL never reaches a view */ }
    const token = profile.tokenRef === undefined ? undefined : tokens?.read(profile.tokenRef)
    const env = Object.entries(profile.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
    return {
      id: profile.id, name: profile.name, models: Object.entries(profile.models ?? {}).map(([from, to]) => ({ from, to })), tiers: [],
      ...(!hasChannelConnection(profile) ? {} : { connection: { ...(baseUrl === undefined ? {} : { baseUrl }), hasToken: profile.tokenRef !== undefined && (tokens?.declared(profile.tokenRef) ?? false), envKeys: Object.keys(profile.env ?? {}), fingerprint: createHash('sha256').update(JSON.stringify([profile.baseUrl, token, env])).digest('hex').slice(0, 16) } }),
    }
  }
  const shared = (ref: string, except: string): boolean => store.read().channels.some(row => row.id !== except && row.tokenRef === ref)
  const capability: NonNullable<SessionCapabilities['channels']> = {
    list: () => store.read().channels.map(view),
    activeId: () => store.read().active,
    setActive: id => store.setActive(id),
    save: input => {
      const current = store.read().channels.find(row => row.id === input.id)
      const profile = checked({
        id: input.id, name: input.name,
        ...(input.baseUrl === undefined ? (current?.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }) : input.baseUrl === '' ? {} : { baseUrl: input.baseUrl }),
        ...(current?.tokenRef === undefined ? {} : { tokenRef: current.tokenRef }),
        ...(input.env === undefined ? (current?.env === undefined ? {} : { env: current.env }) : { env: input.env }),
        ...(input.models === undefined ? (current?.models === undefined ? {} : { models: current.models }) : { models: input.models }),
      })
      let tokenRef = profile.tokenRef
      if (input.token !== undefined) {
        if (tokens === undefined) throw new Error(t('codex-channel-store-unavailable'))
        if (input.token === '') {
          if (tokenRef !== undefined && !shared(tokenRef, input.id) && tokenRef === derivedRef(input.id)) tokens.erase(tokenRef)
          tokenRef = undefined
        } else {
          tokenRef ??= derivedRef(input.id)
          tokens.write(tokenRef, input.token)
          if (tokens.read(tokenRef) !== input.token) throw new Error(t('codex-channel-token-write-failed'))
        }
      }
      const { tokenRef: _oldRef, ...rest } = profile
      const saved = { ...rest, ...(tokenRef === undefined ? {} : { tokenRef }) }
      store.save(saved)
      return view(saved)
    },
    remove: id => {
      const current = store.read().channels.find(row => row.id === id)
      if (current === undefined) return false
      if (current.tokenRef === derivedRef(id) && !shared(current.tokenRef, id)) tokens?.erase(current.tokenRef)
      store.remove(id)
      return true
    },
    importFromSettings: () => {
      const draft = settingsImport(config, deps.env ?? {})
      if (draft === undefined || draft.token === undefined || tokens === undefined) return undefined
      return capability.save({ ...draft.profile, token: draft.token })
    },
    peekSettingsImport: () => {
      const draft = settingsImport(config, deps.env ?? {})
      return draft === undefined ? undefined : { baseUrl: draft.profile.baseUrl, tiers: {} }
    },
  }
  return { capability, active: () => activeProfileOf(store.read()), refreshConfig: value => { config = value }, launch: () => codexChannelLaunch(activeProfileOf(store.read()), tokens) }
}
