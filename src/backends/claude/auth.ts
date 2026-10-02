/**
 * Claude credentials for the CLI child (docs/agent-backend-design.md §4.12,
 * decision D-AUTH): which credential the session runs on, and the child
 * environment that selects it.
 *
 * Precedence:
 *  (a) the dsh-auth `anthropic` subscription login (the TUI's own `/login`) →
 *      `CLAUDE_CODE_OAUTH_TOKEN=<access>`, refreshed before spawn when it is
 *      about to expire. When (a) is used, `ANTHROPIC_API_KEY` and
 *      `ANTHROPIC_AUTH_TOKEN` are REMOVED from the child environment: the CLI
 *      ranks those above an OAuth token, and a stale key exported in the
 *      shell would silently override the login the user made in the TUI;
 *  (b) the user's own environment — `ANTHROPIC_API_KEY` /
 *      `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`, or a cloud provider
 *      (any `CLAUDE_CODE_USE_<PROVIDER>` routing flag) — passed through;
 *  (c) nothing injected: the CLI discovers the local `claude login`.
 *
 * (a) applies ONLY on the first-party route (`claudeRouteOf`): with a custom
 * `ANTHROPIC_BASE_URL`, a Unix socket, a cloud or gateway route, an
 * `apiKeyHelper`, or unreadable settings, the environment passes through
 * untouched and the token is never read — the CLI would otherwise send the
 * claude.ai token to that host.
 *
 * The host supplies the dsh-auth credential through `ClaudeCredentialSource`
 * (the backend never reads the credential file or runs an OAuth flow
 * itself). Token material never reaches a log, notice, trace or event: this
 * module only ever puts it into the child environment it returns.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OAuthCredentialSource } from '../../agent/backend.js'
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
}

/** The settings slice the route depends on (`resolveSettings().effective`). */
export interface ClaudeRouteSettings {
  readonly env?: Readonly<Record<string, unknown>>
  readonly apiKeyHelper?: unknown
  readonly forceLoginMethod?: unknown
  readonly forceLoginGatewayUrl?: unknown
}

/** Reads the effective user/project/local settings (the CLI applies their
 *  `env`); a rejection means the route cannot be determined. */
export type ClaudeSettingsReader = () => Promise<ClaudeRouteSettings | undefined>

const set = (env: Readonly<Record<string, unknown>>, key: string): boolean => typeof env[key] === 'string' && env[key] !== ''
const truthy = (env: Readonly<Record<string, unknown>>, key: string): boolean =>
  set(env, key) && env[key] !== '0' && String(env[key]).toLowerCase() !== 'false'

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
  for (const key of Object.keys(env)) {
    if (!key.startsWith(USE_PREFIX)) continue
    const name = key.slice(USE_PREFIX.length)
    if (name === '' || NON_ROUTING_USE_FLAGS.has(name) || !truthy(env, key)) continue
    return name.toLowerCase()
  }
  return undefined
}

/** The origin host of a configured URL (never its path, query or userinfo). */
function originHost(value: string): string {
  try {
    return new URL(value).host || '?'
  } catch {
    return '?'
  }
}

/**
 * The route one environment selects. `sources` are checked one by one (the
 * process environment and the settings `env`): a non-first-party value in
 * either wins, whichever the CLI would let override the other.
 */
export function claudeRouteOf(sources: readonly Readonly<Record<string, unknown>>[], settings: ClaudeRouteSettings): ClaudeRoute {
  for (const env of sources) {
    const provider = cloudProviderOf(env)
    if (provider === 'gateway') return { kind: 'gateway' }
    if (provider !== undefined) return { kind: 'cloud', provider }
  }
  for (const env of sources) {
    if (set(env, 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR')) return { kind: 'gateway' }
    if (set(env, 'ANTHROPIC_UNIX_SOCKET')) return { kind: 'unix-socket' }
    if (set(env, 'ANTHROPIC_BASE_URL')) {
      const value = String(env.ANTHROPIC_BASE_URL)
      let origin: string | undefined
      try { origin = new URL(value).origin } catch { origin = undefined }
      if (origin !== FIRST_PARTY_ORIGIN) return { kind: 'custom-endpoint', host: originHost(value) }
    }
  }
  if (settings.forceLoginMethod === 'gateway' || (typeof settings.forceLoginGatewayUrl === 'string' && settings.forceLoginGatewayUrl !== '')) return { kind: 'gateway' }
  if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== null && settings.apiKeyHelper !== '') return { kind: 'api-key-helper' }
  return { kind: 'first-party' }
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
    /** The access token the CLI just refused (a reconnect): refresh unless
     *  dsh-auth already holds a different one. */
    readonly rejected?: string
  } = {},
): Promise<ClaudeAuthPlan> {
  const env = { ...base }
  let route: ClaudeRoute
  if (options.settings === undefined) {
    route = { kind: 'settings-unreadable' }
  } else {
    try {
      const settings = await options.settings() ?? {}
      const settingsEnv = typeof settings.env === 'object' && settings.env !== null ? settings.env : {}
      route = claudeRouteOf([env, settingsEnv], settings)
    } catch {
      route = { kind: 'settings-unreadable' }
    }
  }
  if (route.kind === 'cloud') return { source: 'cloud', cloud: route.provider, route, env }
  if (route.kind === 'first-party') {
    const stored = credentials === undefined ? undefined : await credentials.fresh(options.rejected === undefined ? {} : { rejected: options.rejected })
    if (stored !== undefined && stored.access !== '') {
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      env.CLAUDE_CODE_OAUTH_TOKEN = stored.access
      return { source: 'dsh-auth', route, expiresAt: stored.expires, env }
    }
  }
  if (set(env, 'ANTHROPIC_API_KEY')) return { source: 'api-key', route, env }
  if (set(env, 'ANTHROPIC_AUTH_TOKEN')) return { source: 'auth-token', route, env }
  if (set(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return { source: 'oauth-env', route, env }
  return { source: 'claude-login', route, env }
}

/**
 * A credential refresh failure as the user sees it: a fixed sentence with at
 * most the HTTP status (an OAuth endpoint's error body can echo request
 * material); the full error belongs in the debug log only.
 */
export function refreshFailureStatus(error: unknown): string | undefined {
  const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined
  const direct = value?.status ?? (typeof value?.response === 'object' && value.response !== null ? (value.response as Record<string, unknown>).status : undefined)
  if (typeof direct === 'number' && direct >= 100 && direct <= 599) return String(direct)
  const text = error instanceof Error ? error.message : String(error)
  const match = /\b(?:HTTP|status)\D{0,3}([1-5]\d\d)\b/iu.exec(text) ?? /(?<![\d.])([45]\d\d)(?![\d.])/u.exec(text)
  return match?.[1]
}

/** The CLI's authentication-failure signatures (design §4.13). */
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
  const present = (key: string): boolean => (env[key] ?? '') !== ''
  if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(present) || cloudProviderOf(env) !== undefined) return 'ok'
  try {
    if (await credentials?.stored() === true) return 'ok'
  } catch {
    // An unreadable credential file is the host's to report; keep looking.
  }
  const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(homeDir(), '.claude')
  if (existsSync(join(configDir, '.credentials.json'))) return 'ok'
  return platform === 'darwin' ? 'unknown' : 'missing'
}
