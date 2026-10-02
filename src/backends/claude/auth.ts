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
 *      (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`) — passed through;
 *  (c) nothing injected: the CLI discovers the local `claude login`.
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

/** What the spawn uses: the source and the full child environment. */
export interface ClaudeAuthPlan {
  readonly source: ClaudeAuthSource
  /** The cloud provider when `source === 'cloud'`. */
  readonly cloud?: 'bedrock' | 'vertex' | 'foundry'
  /** dsh-auth: when the injected token expires (epoch ms). */
  readonly expiresAt?: number
  readonly env: Record<string, string>
}

const set = (env: Record<string, string>, key: string): boolean => (env[key] ?? '') !== ''
const truthy = (env: Record<string, string>, key: string): boolean => set(env, key) && env[key] !== '0' && env[key]!.toLowerCase() !== 'false'

/** The cloud provider the environment selects, if any. */
export function cloudProviderOf(env: Record<string, string>): ClaudeAuthPlan['cloud'] {
  if (truthy(env, 'CLAUDE_CODE_USE_BEDROCK')) return 'bedrock'
  if (truthy(env, 'CLAUDE_CODE_USE_VERTEX')) return 'vertex'
  if (truthy(env, 'CLAUDE_CODE_USE_FOUNDRY')) return 'foundry'
  return undefined
}

/**
 * The credential plan for one spawn. A cloud provider wins over everything
 * (the CLI ignores Anthropic credentials there, so injecting a token would
 * only mislead `/login`); then dsh-auth; then the environment; then the
 * local login. A failing dsh-auth refresh propagates: starting on a token
 * known to be dead would only fail later with a worse message.
 */
export async function resolveClaudeAuth(
  base: Record<string, string>,
  credentials: OAuthCredentialSource | undefined,
  options: { readonly force?: boolean } = {},
): Promise<ClaudeAuthPlan> {
  const env = { ...base }
  const cloud = cloudProviderOf(env)
  if (cloud !== undefined) return { source: 'cloud', cloud, env }
  const stored = credentials === undefined ? undefined : await credentials.fresh(options)
  if (stored !== undefined && stored.access !== '') {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    env.CLAUDE_CODE_OAUTH_TOKEN = stored.access
    return { source: 'dsh-auth', expiresAt: stored.expires, env }
  }
  if (set(env, 'ANTHROPIC_API_KEY')) return { source: 'api-key', env }
  if (set(env, 'ANTHROPIC_AUTH_TOKEN')) return { source: 'auth-token', env }
  if (set(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return { source: 'oauth-env', env }
  return { source: 'claude-login', env }
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
  if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(present)) return 'ok'
  try {
    if (await credentials?.stored() === true) return 'ok'
  } catch {
    // An unreadable credential file is the host's to report; keep looking.
  }
  const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(homeDir(), '.claude')
  if (existsSync(join(configDir, '.credentials.json'))) return 'ok'
  return platform === 'darwin' ? 'unknown' : 'missing'
}
