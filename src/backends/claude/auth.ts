/**
 * Claude credentials for the CLI child: which credential the session runs
 * on, and the child environment that selects it.
 *
 * Precedence:
 *  (a) the dsh-auth `anthropic` subscription login (the TUI's own `/login`) →
 *      `CLAUDE_CODE_OAUTH_TOKEN=<access>`, refreshed before spawn when it is
 *      about to expire. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are
 *      then removed from the child environment: the CLI ranks them above an
 *      OAuth token, and a stale key in the shell would silently win;
 *  (b) the user's own environment (`ANTHROPIC_API_KEY` /
 *      `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`, or a cloud
 *      provider's `CLAUDE_CODE_USE_<PROVIDER>` flag), passed through;
 *  (c) nothing injected: the CLI finds the local `claude login`.
 *
 * (a) applies only on the first-party route (`claudeRouteOf`). A custom
 * `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_API_BASE_URL`, a Unix socket, a cloud or
 * gateway route, a custom OAuth endpoint, an `apiKeyHelper`, a managed
 * `policyHelper` or unreadable settings leave the environment untouched and
 * the token unread: the CLI would send the claude.ai token to that host. The
 * route is read from every place the CLI takes its environment from: the
 * process environment, every global config file it may pick
 * (`<config>/.config.json`, `.claude.json`, `.claude-custom-oauth.json`; one
 * that is not first-party or cannot be read fails closed), and the settings'
 * `env`. `<config>` is the CLI's own `CLAUDE_CONFIG_DIR` (exact case on POSIX,
 * any case on Windows; spellings that disagree fail closed). Other names
 * match case-insensitively (Windows semantics): a broader match only ever
 * fails closed.
 *
 * When the token IS injected the route is also pinned: the flag-settings
 * layer (the SDK `settings` option, the highest user-controlled tier) sets
 * `ANTHROPIC_BASE_URL` to the first-party origin and blanks the other
 * routing variables, and the child environment drops them, so a source the
 * gate missed still cannot send the token elsewhere
 * (scripts/probes/claude-auth-pin-probe.mjs checks this offline).
 *
 * An active channel profile pins its connection the same way. The CLI
 * applies a settings file's `env` over the environment it inherited, so a
 * channel that carries the credential names all three credential keys in the
 * flag layer: its own token as `ANTHROPIC_AUTH_TOKEN` and an empty string for
 * the others (an empty flag-tier value suppresses what user settings still
 * hold), plus the routing blanks; the child environment loses the
 * conflicting spellings. A custom endpoint with no credential is refused
 * before the spawn (no anonymous relay request, no ambient identity riding
 * the channel endpoint), and so is an `apiKeyHelper` in readable settings.
 *
 * The managed (policy) tier outranks the flag tier and the SDK's
 * `managedSettings` cannot carry `env`, so the pin does not cover it: the
 * gate reads the on-disk policy tier when the session opens and fails closed
 * on a non-first-party route there. Managed settings that change the route
 * while a session runs are only seen at the next spawn.
 *
 * The host supplies the dsh-auth credential through `ClaudeCredentialSource`
 * (the backend never reads the credential file or runs an OAuth flow
 * itself). Token material never reaches a log, notice, trace or event: this
 * module only puts it into the child environment (and the flag settings) it
 * returns.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OAuthCredentialSource } from '../../agent/backend.js'
import { t } from '../../i18n.js'
import { homeDir } from '../../utils/paths.js'

/** The dsh-auth provider id whose login this backend uses. */
export const CLAUDE_OAUTH_PROVIDER = 'anthropic'

/** Where the session's credential comes from. */
export type ClaudeAuthSource = 'dsh-auth' | 'api-key' | 'auth-token' | 'oauth-env' | 'cloud' | 'claude-login'

/**
 * Where the CLI sends its API traffic, as far as this module can tell. The
 * dsh-auth subscription token is a claude.ai credential: it is only ever
 * injected for the first-party Anthropic API. Every other route — a custom
 * `ANTHROPIC_BASE_URL` (an LLM gateway, a third-party Anthropic-compatible
 * API), a Unix socket, a cloud provider, a Cloud gateway sign-in, an
 * `apiKeyHelper`, or settings that cannot be read — gets the environment
 * untouched (fail closed: a token sent to the wrong host is a leak).
 */
export type ClaudeRoute =
  | { readonly kind: 'first-party' }
  | { readonly kind: 'cloud'; readonly provider: string }
  | { readonly kind: 'custom-endpoint'; readonly host: string }
  /** `CLAUDE_CODE_CUSTOM_OAUTH_URL` (a custom OAuth deployment). */
  | { readonly kind: 'custom-oauth' }
  | { readonly kind: 'unix-socket' }
  | { readonly kind: 'gateway' }
  | { readonly kind: 'api-key-helper' }
  | { readonly kind: 'settings-unreadable' }

/** What the spawn uses: the source and the full child environment. */
export interface ClaudeAuthPlan {
  readonly source: ClaudeAuthSource
  /** The cloud provider when `source === 'cloud'` (lower case, as named by
   *  its `CLAUDE_CODE_USE_<PROVIDER>` flag). */
  readonly cloud?: string
  /** The route the CLI runs on; absent = first-party (or not determined). */
  readonly route?: ClaudeRoute
  /** dsh-auth: when the injected token expires (epoch ms). */
  readonly expiresAt?: number
  readonly env: Record<string, string>
  /**
   * dsh-auth: the flag-settings layer that pins the route to the first-party
   * API (the SDK `settings` option); absent on every other source.
   */
  readonly settings?: { readonly env: Readonly<Record<string, string>> }
}

/**
 * The active channel profile's connection (channels.ts), resolved for one
 * spawn: the endpoint, the token (already read from the credential store)
 * and the channel-private env. The spawn env carries it and the flag layer
 * restates it, so a settings-file env (cc-switch's `ANTHROPIC_BASE_URL`, an
 * old token) cannot override it. A profile with neither endpoint nor token
 * (a model mapping with private env) pins no credential.
 */
export interface ClaudeChannelConnectionInput {
  readonly baseUrl?: string
  readonly token?: string
  readonly env?: Readonly<Record<string, string>>
}

/** The settings slice the route depends on (`resolveSettings().effective`). */
export interface ClaudeRouteSettings {
  readonly env?: Readonly<Record<string, unknown>>
  readonly apiKeyHelper?: unknown
  readonly forceLoginMethod?: unknown
  readonly forceLoginGatewayUrl?: unknown
  /** A managed policy subprocess that may inject settings (and `env`) the
   *  resolver cannot see: the route is then unknown. */
  readonly policyHelper?: unknown
}

/**
 * The global config files' `env` (see {@link claudeGlobalConfigPaths}): one
 * `env` per existing file (or a single one); none → undefined / `[]`; any file
 * that exists but cannot be read or parsed, or a config directory the CLI's
 * choice of cannot be established → `'unreadable'` (the route is then
 * unknown: fail closed).
 */
export type ClaudeGlobalConfigReader = () => Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[] | 'unreadable' | undefined

/** Reads the effective user/project/local settings (the CLI applies their
 *  `env`); a rejection means the route cannot be determined. */
export type ClaudeSettingsReader = () => Promise<ClaudeRouteSettings | undefined>

/**
 * Every non-empty string value of `key` in `env`, the name matched
 * case-insensitively: Windows environment names are case-insensitive, so
 * `anthropic_base_url` IS `ANTHROPIC_BASE_URL` there. Every spelling counts.
 */
function valuesOf(env: Readonly<Record<string, unknown>>, key: string): string[] {
  const upper = key.toUpperCase()
  const values: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === upper && typeof value === 'string' && value !== '') values.push(value)
  }
  return values
}
const set = (env: Readonly<Record<string, unknown>>, key: string): boolean => valuesOf(env, key).length > 0
const isTruthy = (value: string): boolean => value !== '0' && value.toLowerCase() !== 'false'
/** Remove every spelling of `key` (case-insensitive, see {@link valuesOf}). */
function deleteAll(env: Record<string, string>, key: string): void {
  const upper = key.toUpperCase()
  for (const name of Object.keys(env)) if (name.toUpperCase() === upper) delete env[name]
}

/** `CLAUDE_CODE_USE_*` flags that select a feature, not an API route. */
const NON_ROUTING_USE_FLAGS: ReadonlySet<string> = new Set(['POWERSHELL_TOOL', 'NATIVE_FILE_SEARCH', 'COWORK_PLUGINS'])
const USE_PREFIX = 'CLAUDE_CODE_USE_'
/** The only origin the subscription token may travel to. */
const FIRST_PARTY_ORIGIN = 'https://api.anthropic.com'

/**
 * The provider a truthy `CLAUDE_CODE_USE_<X>` routing flag selects, if any
 * (BEDROCK, VERTEX, FOUNDRY, ANTHROPIC_AWS, ANTHROPIC_GOOGLE_CLOUD, MANTLE,
 * GATEWAY, and any future one: the prefix is matched generically).
 */
export function cloudProviderOf(env: Readonly<Record<string, unknown>>): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (!upper.startsWith(USE_PREFIX)) continue
    const name = upper.slice(USE_PREFIX.length)
    if (name === '' || NON_ROUTING_USE_FLAGS.has(name) || typeof value !== 'string' || value === '' || !isTruthy(value)) continue
    return name.toLowerCase()
  }
  return undefined
}

/** The origin host of a configured URL (never its path, query or userinfo). */
export function originHost(value: string): string {
  try {
    return new URL(value).host || '?'
  } catch {
    return '?'
  }
}

/** Variables naming where the CLI sends requests that carry the bearer:
 *  the API itself, and the Files API (`CLAUDE_CODE_API_BASE_URL`). */
const BASE_URL_KEYS: readonly string[] = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_API_BASE_URL']

/**
 * The route one environment selects. `sources` are checked one by one (the
 * process environment, the global config `env`, the settings `env`): a
 * non-first-party value in any wins, whichever the CLI would let override
 * the others. Names match case-insensitively (see {@link valuesOf}).
 */
export function claudeRouteOf(sources: readonly Readonly<Record<string, unknown>>[], settings: ClaudeRouteSettings): ClaudeRoute {
  // A custom OAuth deployment changes where the token is sent and which
  // global config file the CLI reads: never inject under one.
  if (sources.some(env => set(env, 'CLAUDE_CODE_CUSTOM_OAUTH_URL'))) return { kind: 'custom-oauth' }
  for (const env of sources) {
    const provider = cloudProviderOf(env)
    if (provider === 'gateway') return { kind: 'gateway' }
    if (provider !== undefined) return { kind: 'cloud', provider }
  }
  for (const env of sources) {
    if (set(env, 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR')) return { kind: 'gateway' }
    if (set(env, 'ANTHROPIC_UNIX_SOCKET')) return { kind: 'unix-socket' }
    for (const key of BASE_URL_KEYS) {
      for (const value of valuesOf(env, key)) {
        let origin: string | undefined
        try { origin = new URL(value).origin } catch { origin = undefined }
        if (origin !== FIRST_PARTY_ORIGIN) return { kind: 'custom-endpoint', host: originHost(value) }
      }
    }
  }
  if (settings.forceLoginMethod === 'gateway' || (typeof settings.forceLoginGatewayUrl === 'string' && settings.forceLoginGatewayUrl !== '')) return { kind: 'gateway' }
  if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== null && settings.apiKeyHelper !== '') return { kind: 'api-key-helper' }
  return { kind: 'first-party' }
}

/**
 * The CLI's config directory variable as the CLI itself reads it: the exact
 * name `CLAUDE_CONFIG_DIR` on POSIX (environment names are case-sensitive
 * there), any spelling on Windows. `'conflict'` when another spelling names a
 * different directory than the one the CLI uses (the gate cannot know which
 * files the CLI reads: fail closed).
 */
export function claudeConfigDirOf(env: Readonly<Record<string, unknown>>, platform: NodeJS.Platform = process.platform): string | undefined | 'conflict' {
  const all = valuesOf(env, 'CLAUDE_CONFIG_DIR')
  const exact = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : undefined
  const chosen = platform === 'win32' ? all[0] : exact
  return all.some(value => value !== chosen) ? 'conflict' : chosen
}

/**
 * Every global config file the CLI may read its `env` from: `.config.json`
 * in the config directory (it wins when it exists), and `.claude.json` /
 * `.claude-custom-oauth.json` in `CLAUDE_CONFIG_DIR`, else the home
 * directory. The gate reads them all (any one may be the file in effect).
 */
export function claudeGlobalConfigPaths(env: Readonly<Record<string, unknown>>, platform: NodeJS.Platform = process.platform): string[] | 'conflict' {
  const dir = claudeConfigDirOf(env, platform)
  if (dir === 'conflict') return 'conflict'
  const configDir = dir ?? join(homeDir(), '.claude')
  const base = dir ?? homeDir()
  return [join(configDir, '.config.json'), join(base, '.claude.json'), join(base, '.claude-custom-oauth.json')]
}

/** One global config file's `env`: undefined when it does not exist. */
function readConfigEnv(path: string): Readonly<Record<string, unknown>> | 'unreadable' | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
    const configEnv = (parsed as Record<string, unknown>).env
    if (configEnv === undefined || configEnv === null) return {}
    return typeof configEnv === 'object' && !Array.isArray(configEnv) ? configEnv as Record<string, unknown> : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** Read every global config file's `env` from disk (see {@link ClaudeGlobalConfigReader}). */
export function fileGlobalConfigReader(env: Readonly<Record<string, unknown>>, platform: NodeJS.Platform = process.platform): ClaudeGlobalConfigReader {
  return () => {
    const paths = claudeGlobalConfigPaths(env, platform)
    if (paths === 'conflict') return 'unreadable'
    const envs: Readonly<Record<string, unknown>>[] = []
    for (const path of paths) {
      const read = readConfigEnv(path)
      if (read === 'unreadable') return 'unreadable'
      if (read !== undefined) envs.push(read)
    }
    return envs
  }
}

/** Routing variables the pin neutralises (blank in the flag settings, gone
 *  from the child environment): every other place the CLI could be told to
 *  send the credential — the Files API, a Unix socket, a cloud provider, a
 *  Cloud gateway, a custom OAuth deployment — plus `ANTHROPIC_CUSTOM_HEADERS`,
 *  which can carry its own Authorization. */
const PINNED_BLANK: readonly string[] = [
  'CLAUDE_CODE_API_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_CUSTOM_HEADERS',
]

/** The three credential keys the CLI merges from every tier it reads
 *  (process env, global config, settings files). When a channel owns the
 *  credential the flag layer names each one: an empty string suppresses
 *  the value a lower tier still holds. */
const CREDENTIAL_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

/**
 * Every routing variable to neutralise for one environment: the known
 * names above plus every routing `CLAUDE_CODE_USE_*` spelling it carries
 * (a future flag routes too — blank it, never pass it through). The set is
 * collected BEFORE the child env drops the spellings, so the flag layer
 * can re-state exactly what the environment spelled.
 */
function routingKeysOf(env: Readonly<Record<string, string>>): Set<string> {
  const blank = new Set(PINNED_BLANK)
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase()
    if (upper.startsWith(USE_PREFIX) && !NON_ROUTING_USE_FLAGS.has(upper.slice(USE_PREFIX.length))) blank.add(upper)
  }
  return blank
}

/**
 * The route pin of an injected subscription token: the flag-settings layer
 * sets the first-party base URL and blanks every other routing variable
 * ({@link routingKeysOf}); the child environment loses them all.
 */
function pinFirstParty(env: Record<string, string>): { readonly env: Readonly<Record<string, string>> } {
  const blank = routingKeysOf(env)
  for (const key of [...blank, ...BASE_URL_KEYS]) deleteAll(env, key)
  const pinned: Record<string, string> = { ANTHROPIC_BASE_URL: FIRST_PARTY_ORIGIN }
  for (const key of blank) pinned[key] = ''
  return { env: pinned }
}

/**
 * The credential plan for one spawn. The dsh-auth login is injected only
 * when the effective route is the first-party Anthropic API (see
 * {@link ClaudeRoute}); any other route keeps the environment exactly as it
 * is. Then the environment's own credentials, then the local login. A
 * failing dsh-auth refresh propagates: starting on a token known to be dead
 * would only fail later with a worse message.
 */
export async function resolveClaudeAuth(
  base: Record<string, string>,
  credentials: OAuthCredentialSource | undefined,
  options: {
    /** The effective Claude settings; absent = the route is unknown, and no
     *  token is injected (fail closed). */
    readonly settings?: ClaudeSettingsReader
    /** The global config's `env` (default: read from disk for `base`). */
    readonly globalConfig?: ClaudeGlobalConfigReader
    /** The access token the CLI just refused (a reconnect): refresh unless
     *  dsh-auth already holds a different one. */
    readonly rejected?: string
    /** The active channel profile's connection. When it shapes the spawn,
     *  the dsh-auth login is never injected alongside it, the environment's
     *  conflicting spellings are replaced and the flag layer restates the
     *  connection. */
    readonly channel?: ClaudeChannelConnectionInput
  } = {},
): Promise<ClaudeAuthPlan> {
  const env = { ...base }
  // The channel connection wins over the ambient environment: its base URL
  // and token replace any spelling there (a stale shell export must not
  // split the pair), and the channel-private env goes on top. The flag
  // layer repeats the connection (and, when the channel carries the
  // credential, every credential key and routing blank); other settings
  // keys still apply.
  const channel = options.channel
  const channelShapesSpawn = channel !== undefined
    && (channel.baseUrl !== undefined || channel.token !== undefined
      || (channel.env !== undefined && Object.keys(channel.env).length > 0))
  // Only a channel with an endpoint and/or a token replaces the ambient
  // credentials; an env-only profile leaves them as they are.
  const channelCarriesCredential = channel !== undefined
    && (channel.baseUrl !== undefined || channel.token !== undefined)
  let channelRouting: ReadonlySet<string> | undefined
  if (channel !== undefined && channelShapesSpawn) {
    if (channel.baseUrl !== undefined) {
      // The endpoint replaces every spelling; the Files API URL goes too.
      for (const key of BASE_URL_KEYS) deleteAll(env, key)
      env.ANTHROPIC_BASE_URL = channel.baseUrl
    }
    if (channelCarriesCredential) {
      // Ambient credentials belong to another endpoint, and ambient routing
      // variables would send the channel's credential elsewhere (a cloud
      // provider, a socket, a custom OAuth deployment, a headers override):
      // all go, in every casing. That alone is not enough, because the CLI
      // applies settings env over the process env; the flag layer below
      // restates the blanks.
      channelRouting = routingKeysOf(env)
      for (const key of [...channelRouting, ...CREDENTIAL_KEYS]) deleteAll(env, key)
      if (channel.token !== undefined) env.ANTHROPIC_AUTH_TOKEN = channel.token
    }
    for (const [key, value] of Object.entries(channel.env ?? {})) env[key] = value
  }
  let route: ClaudeRoute
  let routeSettings: ClaudeRouteSettings | undefined
  if (options.settings === undefined) {
    route = { kind: 'settings-unreadable' }
  } else {
    try {
      const settings = await options.settings() ?? {}
      routeSettings = settings
      const settingsEnv = typeof settings.env === 'object' && settings.env !== null ? settings.env : {}
      const global = (options.globalConfig ?? fileGlobalConfigReader(env))()
      const globalEnvs = global === undefined ? [] : global === 'unreadable' ? 'unreadable' : Array.isArray(global) ? global : [global as Readonly<Record<string, unknown>>]
      // A policy helper injects settings the resolver never sees; an
      // unreadable global config hides its `env`: either way the route is
      // unknown.
      route = globalEnvs === 'unreadable' || (settings.policyHelper !== undefined && settings.policyHelper !== null)
        ? { kind: 'settings-unreadable' }
        : claudeRouteOf([env, ...globalEnvs, settingsEnv], settings)
    } catch {
      route = { kind: 'settings-unreadable' }
    }
  }
  if (channel !== undefined && channelShapesSpawn) {
    // An `apiKeyHelper` in settings: the CLI would send the helper's
    // x-api-key alongside the channel credential, and no flag-tier env value
    // can neutralise a settings field. Refuse rather than send either
    // credential to the other's host.
    if (channelCarriesCredential && routeSettings !== undefined
      && routeSettings.apiKeyHelper !== undefined && routeSettings.apiKeyHelper !== null && routeSettings.apiKeyHelper !== '') {
      throw new ClaudeChannelConflictError(t('claude-channel-helper-conflict'))
    }
    // The channel's own credential decides the source label; the dsh-auth
    // branch below is deliberately unreachable while a channel connection
    // is active (a channel naming the first-party origin with its own token
    // still wins: the profile, not the subscription, is the user's pick).
    const source: ClaudeAuthSource = channel.token !== undefined ? 'auth-token'
      : set(env, 'ANTHROPIC_API_KEY') ? 'api-key'
        : set(env, 'ANTHROPIC_AUTH_TOKEN') ? 'auth-token'
          : set(env, 'CLAUDE_CODE_OAUTH_TOKEN') ? 'oauth-env'
            : 'claude-login'
    // The flag layer: the endpoint, and when the channel carries the
    // credential every credential key (its token, or '' to suppress a lower
    // tier's value) plus the routing blanks. The channel's own env wins
    // last: a profile may model its credential or routing there.
    const pinned: Record<string, string> = {
      ...(channel.baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: channel.baseUrl }),
      ...(channelCarriesCredential ? {
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: channel.token ?? '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
      } : {}),
    }
    if (channelRouting !== undefined) for (const key of channelRouting) pinned[key] = ''
    for (const [key, value] of Object.entries(channel.env ?? {})) pinned[key] = value
    return { source, route, env, settings: { env: pinned } }
  }
  if (route.kind === 'cloud') return { source: 'cloud', cloud: route.provider, route, env }
  if (route.kind === 'first-party') {
    const stored = credentials === undefined ? undefined : await credentials.fresh(options.rejected === undefined ? {} : { rejected: options.rejected })
    if (stored !== undefined && stored.access !== '') {
      // Every spelling: on Windows `Anthropic_Api_Key` IS the key the CLI
      // would rank above the injected token.
      deleteAll(env, 'ANTHROPIC_API_KEY')
      deleteAll(env, 'ANTHROPIC_AUTH_TOKEN')
      deleteAll(env, 'CLAUDE_CODE_OAUTH_TOKEN')
      const settings = pinFirstParty(env)
      env.CLAUDE_CODE_OAUTH_TOKEN = stored.access
      return { source: 'dsh-auth', route, expiresAt: stored.expires, env, settings }
    }
  }
  if (set(env, 'ANTHROPIC_API_KEY')) return { source: 'api-key', route, env }
  if (set(env, 'ANTHROPIC_AUTH_TOKEN')) return { source: 'auth-token', route, env }
  if (set(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return { source: 'oauth-env', route, env }
  return { source: 'claude-login', route, env }
}

/**
 * A channel connection the session must not run on: thrown to refuse the
 * start (or the reconnect). The message is the user-facing sentence (what
 * conflicts, where to fix it), never a credential value; callers do not
 * fall back to ambient credentials or an anonymous request.
 */
export class ClaudeChannelConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeChannelConflictError'
  }
}

/**
 * Whether an active channel names a non-first-party endpoint without any
 * credential of its own (no token, no credential key in its `env`). Such a
 * spawn is refused: the relay request would go out anonymous at best, at
 * worst carrying a local login or helper identity the user never chose for
 * that host. A profile that really wants a tokenless gateway says so with a
 * credential key in its `env`.
 */
export function channelMissingCredential(channel: ClaudeChannelConnectionInput): boolean {
  if (channel.baseUrl === undefined) return false
  let custom = true
  try { custom = new URL(channel.baseUrl).origin !== FIRST_PARTY_ORIGIN } catch { custom = true }
  if (!custom) return false
  if (channel.token !== undefined && channel.token !== '') return false
  return !CREDENTIAL_KEYS.some(key => set(channel.env ?? {}, key))
}

/**
 * A credential refresh failure as the user sees it: a fixed sentence with at
 * most the HTTP status (an OAuth endpoint's error body can echo request
 * material, so the error's own text is never logged — see
 * {@link refreshFailureDebugDetail}).
 */
export function refreshFailureStatus(error: unknown): string | undefined {
  const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined
  const direct = value?.status ?? (typeof value?.response === 'object' && value.response !== null ? (value.response as Record<string, unknown>).status : undefined)
  if (typeof direct === 'number' && Number.isInteger(direct) && direct >= 100 && direct <= 599) return String(direct)
  const text = error instanceof Error ? error.message : String(error)
  const match = /\b(?:HTTP|status)\D{0,3}([1-5]\d\d)\b/iu.exec(text) ?? /(?<![\d.])([45]\d\d)(?![\d.])/u.exec(text)
  return match?.[1]
}

/**
 * The debug-log detail of a failed credential refresh: a fixed failure
 * category plus at most the HTTP status ({@link refreshFailureStatus}).
 * The error's own text — a real refresh rejection carries the OAuth
 * endpoint's response body, which can echo request material — never
 * reaches a log, notice, trace or event (the module contract above).
 */
export function refreshFailureDebugDetail(error: unknown): string {
  const status = refreshFailureStatus(error)
  return status === undefined ? 'status unknown' : `HTTP ${status}`
}

/** The CLI's authentication-failure signatures. */
const LOGIN_REQUIRED = /Please run \/login|Not logged in|Invalid API key|Failed to authenticate|OAuth (access )?token (is invalid|has expired|expired)|authentication_error/iu

/** Whether one SDK message says the credential was refused. */
export function isAuthFailure(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const value = message as Record<string, unknown>
  if (value.type === 'assistant' && value.error === 'authentication_failed') return true
  if (value.type === 'result' && value.is_error === true) {
    const text = typeof value.result === 'string' ? value.result : ''
    const errors = Array.isArray(value.errors) ? value.errors.filter((line): line is string => typeof line === 'string').join('\n') : ''
    return LOGIN_REQUIRED.test(text) || LOGIN_REQUIRED.test(errors)
  }
  return false
}

/**
 * Whether a credential is available without spawning the CLI (`detect()`):
 * a stored dsh-auth login, an Anthropic or cloud credential in the
 * environment, or the CLI's own credentials file. On macOS the CLI keeps its
 * login in the keychain, which cannot be read here: `unknown`, not `missing`.
 */
export async function detectClaudeAuth(
  env: Readonly<Record<string, string | undefined>>,
  credentials: OAuthCredentialSource | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<'ok' | 'missing' | 'unknown'> {
  const present = (key: string): boolean => set(env, key)
  if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(present) || cloudProviderOf(env) !== undefined) return 'ok'
  try {
    if (await credentials?.stored() === true) return 'ok'
  } catch {
    // An unreadable credential file is the host's to report; keep looking.
  }
  const dir = claudeConfigDirOf(env, platform)
  const configDir = dir === undefined || dir === 'conflict' ? join(homeDir(), '.claude') : dir
  if (existsSync(join(configDir, '.credentials.json'))) return 'ok'
  return platform === 'darwin' ? 'unknown' : 'missing'
}
