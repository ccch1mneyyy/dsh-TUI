/**
 * Codex backend detection (docs/codex-backend-design.md §5.4): is a usable
 * `codex` installed, is it a supported version, and is there a credential
 * it could use — all without starting the app-server or touching the
 * network. Never throws.
 *
 * The credential check is cheap and conservative: an API key in the
 * environment, a `$CODEX_HOME/auth.json`, or a config that routes to a
 * provider of its own count as present; a keychain store is `unknown`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BackendDetection, BackendHost } from '../../agent/backend.js'
import { t } from '../../i18n.js'
import { codexVersionDrift, codexVersionSupported, MIN_CODEX_VERSION } from './contract.js'
import { errorText } from './narrow.js'
import { resolveCodexExecutable } from './rpc/binary.js'

/** The Codex home the app-server will use (`CODEX_HOME`, else `~/.codex`). */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.codex')
}

/** Whether a credential is visible without a network call. */
export function detectCodexAuth(env: NodeJS.ProcessEnv = process.env): 'ok' | 'missing' | 'unknown' {
  if ((env.OPENAI_API_KEY ?? '') !== '' || (env.CODEX_API_KEY ?? '') !== '') return 'ok'
  const home = codexHomeDir(env)
  if (existsSync(join(home, 'auth.json'))) return 'ok'
  let config = ''
  try {
    config = readFileSync(join(home, 'config.toml'), 'utf8')
  } catch {
    config = ''
  }
  // A provider of its own (a relay, a local model) needs no OpenAI login.
  const provider = /^\s*model_provider\s*=\s*["']([^"']+)["']/mu.exec(config)?.[1]
  if (provider !== undefined && provider !== 'openai') return 'ok'
  if (/^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']/mu.test(config)) return 'unknown'
  return 'missing'
}

export async function detectCodex(host: BackendHost, env: NodeJS.ProcessEnv = process.env): Promise<BackendDetection> {
  try {
    const executable = await resolveCodexExecutable(env)
    if (executable === undefined) return { installed: false, hint: t('codex-not-installed') }
    const version = executable.version
    if (!codexVersionSupported(version)) {
      return { installed: false, ...(version === undefined ? {} : { version }), hint: t('codex-too-old', { version: version ?? '', min: MIN_CODEX_VERSION }) }
    }
    const auth = detectCodexAuth(env)
    const drift = codexVersionDrift(version)
    return {
      installed: true,
      auth,
      ...(version === undefined ? {} : { version }),
      ...(drift === undefined ? {} : { drift }),
      ...(auth === 'missing' ? { hint: t('codex-auth-missing-hint') } : {}),
    }
  } catch (error) {
    host.debug(`codex: detection failed (${errorText(error)})`)
    return { installed: false }
  }
}
