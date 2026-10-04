/**
 * Claude credentials against fake credential sources and a fake SDK (no CLI,
 * no network, no real token):
 *
 *  - precedence: a dsh-auth `anthropic` login wins (injected as
 *    `CLAUDE_CODE_OAUTH_TOKEN`, with `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`
 *    scrubbed from the child env), then the environment's own credentials,
 *    then the local `claude login`; a cloud provider is never overridden;
 *  - the dsh-auth source refreshes before spawn when the token is about to
 *    expire (under the credential file's lock, persisted), not otherwise;
 *    `force` always refreshes; no stored credential → none;
 *  - detection: env / dsh-auth / the CLI credentials file → ok; nothing →
 *    missing (unknown on macOS, whose login lives in the keychain);
 *  - an authentication failure (the probe-observed shape) renews the
 *    credential and resumes the same session once (same id, translator
 *    state kept, a reconnect notice), and a second failure sends the user to
 *    /login instead of looping; `/login`'s reconnect resets that;
 *  - no token text appears in any event, notice, status line or debug log;
 *  - the token is injected only on the first-party route: a custom
 *    `ANTHROPIC_BASE_URL` (environment or settings `env`), a Unix socket, any
 *    `CLAUDE_CODE_USE_*` routing flag, a gateway route, an `apiKeyHelper` or
 *    unreadable settings leave the environment untouched;
 *  - a renewal is compare-and-swap: only the refused token is refreshed;
 *  - a reconnect of a session the CLI never persisted creates it again
 *    (same id) instead of resuming, and falls back to that on "No
 *    conversation found"; a `/login` reconnect waits for the running turn;
 *    a late auth failure of the old CLI is ignored; inputs the old CLI never
 *    started are pushed again in order (or retired with a notice); a failed
 *    renewal shows the HTTP status only, and is logged by fixed category +
 *    HTTP status only: the refresh error's own text (an OAuth endpoint's
 *    response body can echo request material) never reaches a log, notice
 *    or event, on the startup path (backend.open over the real SDK loader,
 *    node as the fake executable: no claude binary, no credential read, no
 *    network) nor the reconnect path;
 *
 * Run: node --import tsx/esm scripts/verify-claude-auth.ts
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OAuthAccess, OAuthCredentialSource } from '../src/agent/backend.js'
import type { AgentEvent } from '../src/agent/events.js'
import { claudeConfigDirOf, claudeGlobalConfigPaths, detectClaudeAuth, fileGlobalConfigReader, isAuthFailure, refreshFailureStatus, resolveClaudeAuth } from '../src/backends/claude/auth.js'
import { openClaudeSession } from '../src/backends/claude/session.js'
import { createOAuthCredentialSource } from '../src/dsh-adapter/oauth-credential-source.js'
import { setLang, t } from '../src/i18n.js'
import { claudeDeps, fakeClaudeSdk, manualClock, tick } from './lib/claude-fake-sdk.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const TOKEN = 'sk-ant-oat01-FAKE-TOKEN-never-printed'
/** A promise's outcome, or `'timed out'` (a hang fails loudly, not forever). */
const within = <T>(promise: Promise<T>, ms = 3000): Promise<T | 'timed out'> =>
  Promise.race([promise, new Promise<'timed out'>(resolve => { setTimeout(() => resolve('timed out'), ms) })])
const fakeSource = (credential: OAuthAccess | undefined, onFresh: (rejected: string | undefined) => OAuthAccess | undefined = () => credential): OAuthCredentialSource & { calls: (string | undefined)[] } => {
  const calls: (string | undefined)[] = []
  return {
    calls,
    stored: () => Promise.resolve(credential !== undefined),
    fresh: options => {
      calls.push(options?.rejected)
      return Promise.resolve(onFresh(options?.rejected))
    },
  }
}
/** Effective settings with nothing route-relevant (the first-party route);
 *  no global config `env` (hermetic: the real ~/.claude.json is never read). */
const firstParty = { settings: () => Promise.resolve({}), globalConfig: () => undefined }

// ── precedence ────────────────────────────────────────────────────────
{
  const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-api-user', ANTHROPIC_AUTH_TOKEN: 'bearer-user' }
  const dsh = await resolveClaudeAuth(base, fakeSource({ access: TOKEN, expires: Date.now() + 3_600_000 }), firstParty)
  check('dsh-auth login wins: injected as CLAUDE_CODE_OAUTH_TOKEN', dsh.source === 'dsh-auth' && dsh.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN)
  check('dsh-auth login wins: the env API key and auth token are scrubbed', dsh.env.ANTHROPIC_API_KEY === undefined && dsh.env.ANTHROPIC_AUTH_TOKEN === undefined && dsh.env.PATH === '/usr/bin')
  check('the base env object is not mutated', base.ANTHROPIC_API_KEY === 'sk-ant-api-user')
  const key = await resolveClaudeAuth(base, fakeSource(undefined), firstParty)
  check('no dsh-auth login: ANTHROPIC_API_KEY passes through', key.source === 'api-key' && key.env.ANTHROPIC_API_KEY === 'sk-ant-api-user' && key.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
  check('ANTHROPIC_AUTH_TOKEN alone', (await resolveClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 'x' }, undefined)).source === 'auth-token')
  check('the user\'s own CLAUDE_CODE_OAUTH_TOKEN', (await resolveClaudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, undefined)).source === 'oauth-env')
  const local = await resolveClaudeAuth({ PATH: '/usr/bin' }, undefined)
  check('nothing injected: the local claude login', local.source === 'claude-login' && Object.keys(local.env).join() === 'PATH')
  const cloud = await resolveClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' }, fakeSource({ access: TOKEN, expires: Date.now() + 3_600_000 }), firstParty)
  check('a cloud provider is never overridden by a token', cloud.source === 'cloud' && cloud.cloud === 'bedrock' && cloud.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
  check('CLAUDE_CODE_USE_BEDROCK=0 is not a cloud selection', (await resolveClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: '0' }, undefined)).source === 'claude-login')
  const failing: OAuthCredentialSource = { stored: () => Promise.resolve(true), fresh: () => Promise.reject(new Error('refresh failed: 400')) }
  check('a failing refresh rejects (the caller decides)', await resolveClaudeAuth({}, failing, firstParty).then(() => false, () => true))
}

// ── the subscription token reaches the first-party route only ─────────
{
  const stored = { access: TOKEN, expires: Date.now() + 3_600_000 }
  const userEnv = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'user-gateway-key' }
  const refused = async (label: string, env: Record<string, string>, settings: () => Promise<Record<string, unknown> | undefined>, route: string): Promise<void> => {
    const source = fakeSource(stored)
    const plan = await resolveClaudeAuth({ ...userEnv, ...env }, source, { settings, globalConfig: () => undefined })
    check(`no injection: ${label}`, plan.source !== 'dsh-auth' && plan.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && !JSON.stringify(plan).includes(TOKEN), plan.route)
    check(`… the environment passes untouched: ${label}`, plan.env.ANTHROPIC_AUTH_TOKEN === 'user-gateway-key' && Object.entries({ ...userEnv, ...env }).every(([key, value]) => plan.env[key] === value))
    check(`… the token is never even read: ${label}`, source.calls.length === 0)
    check(`… the route is named: ${label}`, plan.route?.kind === route, plan.route)
  }
  const none = (): Promise<Record<string, unknown>> => Promise.resolve({})
  await refused('ANTHROPIC_BASE_URL to a third-party host', { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, none, 'custom-endpoint')
  await refused('ANTHROPIC_BASE_URL over plain http to the Anthropic host', { ANTHROPIC_BASE_URL: 'http://api.anthropic.com' }, none, 'custom-endpoint')
  await refused('ANTHROPIC_BASE_URL that is not a URL', { ANTHROPIC_BASE_URL: 'not a url' }, none, 'custom-endpoint')
  await refused('ANTHROPIC_BASE_URL in the settings env', {}, () => Promise.resolve({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }), 'custom-endpoint')
  await refused('a first-party env URL does not hide a settings env URL', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, () => Promise.resolve({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }), 'custom-endpoint')
  await refused('ANTHROPIC_UNIX_SOCKET', { ANTHROPIC_UNIX_SOCKET: '/tmp/claude.sock' }, none, 'unix-socket')
  await refused('CLAUDE_CODE_USE_MANTLE', { CLAUDE_CODE_USE_MANTLE: '1' }, none, 'cloud')
  await refused('CLAUDE_CODE_USE_ANTHROPIC_AWS', { CLAUDE_CODE_USE_ANTHROPIC_AWS: 'true' }, none, 'cloud')
  await refused('CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1' }, none, 'cloud')
  await refused('a future CLAUDE_CODE_USE_* routing flag', { CLAUDE_CODE_USE_SOMETHING_NEW: '1' }, none, 'cloud')
  await refused('a routing flag in the settings env', {}, () => Promise.resolve({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }), 'cloud')
  await refused('CLAUDE_CODE_USE_GATEWAY', { CLAUDE_CODE_USE_GATEWAY: '1' }, none, 'gateway')
  await refused('a gateway token descriptor', { CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '3' }, none, 'gateway')
  await refused('settings forceLoginMethod gateway', {}, () => Promise.resolve({ forceLoginMethod: 'gateway' }), 'gateway')
  await refused('settings forceLoginGatewayUrl', {}, () => Promise.resolve({ forceLoginGatewayUrl: 'https://gw.example.com' }), 'gateway')
  await refused('settings apiKeyHelper', {}, () => Promise.resolve({ apiKeyHelper: '/usr/local/bin/key' }), 'api-key-helper')
  await refused('settings that cannot be read', {}, () => Promise.reject(new Error('EACCES')), 'settings-unreadable')
  {
    const source = fakeSource(stored)
    const plan = await resolveClaudeAuth({ ...userEnv }, source)
    check('no settings reader: fail closed (no injection)', plan.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && source.calls.length === 0 && plan.route?.kind === 'settings-unreadable')
  }
  const named = await resolveClaudeAuth({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }, undefined, firstParty)
  check('the cloud label names the actual provider (not bedrock/vertex/foundry only)', named.source === 'cloud' && named.cloud === 'anthropic_aws')
  for (const [label, env] of [
    ['the first-party origin', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }],
    ['the first-party origin with a path', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }],
    ['a feature flag that is not a route', { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }],
    ['a disabled routing flag', { CLAUDE_CODE_USE_BEDROCK: '0' }],
  ] as const) {
    const plan = await resolveClaudeAuth({ ...userEnv, ...env }, fakeSource(stored), firstParty)
    check(`injected on the first-party route: ${label}`, plan.source === 'dsh-auth' && plan.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && plan.env.ANTHROPIC_AUTH_TOKEN === undefined)
  }
  // The global config's `env` (applied by the CLI before the settings
  // tiers) is a third source; an unreadable one fails closed.
  const viaGlobal = async (label: string, globalConfig: () => Record<string, unknown> | 'unreadable' | undefined, route: string, settings: () => Promise<Record<string, unknown>> = none): Promise<void> => {
    const source = fakeSource(stored)
    const plan = await resolveClaudeAuth({ ...userEnv }, source, { settings, globalConfig })
    check(`no injection: ${label}`, plan.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && source.calls.length === 0 && plan.route?.kind === route, plan.route)
  }
  await viaGlobal('ANTHROPIC_BASE_URL in the global config env', () => ({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }), 'custom-endpoint')
  await viaGlobal('a routing flag in the global config env', () => ({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'cloud')
  await viaGlobal('a global config that cannot be read', () => 'unreadable', 'settings-unreadable')
  // A managed policy helper injects what the resolver cannot see; the Files
  // API base URL carries the bearer too.
  await viaGlobal('a managed policyHelper', () => undefined, 'settings-unreadable', () => Promise.resolve({ policyHelper: { path: '/opt/policy' } }))
  await refused('CLAUDE_CODE_API_BASE_URL to a third-party host', { CLAUDE_CODE_API_BASE_URL: 'https://files.example.com' }, none, 'custom-endpoint')
  // Windows semantics: names are case-insensitive, so every spelling routes
  // and every spelling of a credential is scrubbed.
  await refused('a lower-case anthropic_base_url', { anthropic_base_url: 'https://evil.example.com' }, none, 'custom-endpoint')
  await refused('a mixed-case Anthropic_Unix_Socket', { Anthropic_Unix_Socket: '/tmp/s.sock' }, none, 'unix-socket')
  await refused('a lower-case routing flag', { claude_code_use_vertex: '1' }, none, 'cloud')
  await refused('a mixed-case base URL in the settings env', {}, () => Promise.resolve({ env: { Anthropic_Base_Url: 'https://evil.example.com' } }), 'custom-endpoint')
  await viaGlobal('a lower-case base URL in the global config env', () => ({ anthropic_base_url: 'https://evil.example.com' }), 'custom-endpoint')
  {
    const plan = await resolveClaudeAuth({ PATH: '/usr/bin', Anthropic_Api_Key: 'stale-key', anthropic_auth_token: 'stale-bearer', Claude_Code_Oauth_Token: 'stale-oauth' }, fakeSource(stored), firstParty)
    check('every spelling of a ranking credential is scrubbed under the dsh-auth login', plan.source === 'dsh-auth' && plan.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && Object.keys(plan.env).sort().join() === 'CLAUDE_CODE_OAUTH_TOKEN,PATH', Object.keys(plan.env))
    check('a mixed-case API key is still the environment\'s credential', (await resolveClaudeAuth({ Anthropic_Api_Key: 'k' }, undefined, firstParty)).source === 'api-key')
    check('detection sees a mixed-case credential', await detectClaudeAuth({ anthropic_api_key: 'k', CLAUDE_CONFIG_DIR: '/nonexistent' }, undefined, 'linux') === 'ok')
  }
  {
    // The file reader: every global config file the CLI may pick under its
    // own CLAUDE_CONFIG_DIR, absent = no source, unparseable = fail closed.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-global-'))
    try {
      const reader = fileGlobalConfigReader({ CLAUDE_CONFIG_DIR: dir })
      const absent = reader()
      check('global config: absent files are no source', Array.isArray(absent) && absent.length === 0 && (claudeGlobalConfigPaths({ CLAUDE_CONFIG_DIR: dir }) as string[]).includes(join(dir, '.claude.json')))
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ numStartups: 3, env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }))
      const source = fakeSource(stored)
      const plan = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir }, source, { settings: none })
      check('global config: its env routes the session off first-party (read from disk)', plan.route?.kind === 'custom-endpoint' && plan.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && source.calls.length === 0, plan.route)
      writeFileSync(join(dir, '.claude.json'), '{ not json')
      const broken = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir }, fakeSource(stored), { settings: none })
      check('global config: an unparseable file fails closed', broken.route?.kind === 'settings-unreadable' && broken.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ numStartups: 3 }))
      const plain = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir }, fakeSource(stored), { settings: none })
      check('global config: no env there keeps the first-party route', plain.source === 'dsh-auth' && plain.route?.kind === 'first-party')
      // The CLI picks its global config itself (`.config.json` wins when it
      // exists, a custom OAuth deployment reads `.claude-custom-oauth.json`),
      // so the gate reads them all.
      for (const file of ['.config.json', '.claude.json', '.claude-custom-oauth.json']) {
        writeFileSync(join(dir, '.claude.json'), JSON.stringify({ numStartups: 3 }))
        writeFileSync(join(dir, file), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://evil.example.com' } }))
        const source = fakeSource(stored)
        const routed = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir }, source, { settings: none })
        check(`global config: a base URL in ${file} routes off first-party (never read before review 1 for .config.json / .claude-custom-oauth.json)`, routed.route?.kind === 'custom-endpoint' && routed.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && source.calls.length === 0, routed.route)
        writeFileSync(join(dir, file), '{ broken')
        const broken = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir }, fakeSource(stored), { settings: none })
        check(`global config: an unreadable ${file} fails closed`, broken.route?.kind === 'settings-unreadable' && broken.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
        rmSync(join(dir, file), { force: true })
      }
      writeFileSync(join(dir, '.config.json'), JSON.stringify({ env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example.com' } }))
      const custom = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir }, fakeSource(stored), { settings: none })
      check('global config: a custom OAuth URL in a config file fails closed', custom.route?.kind === 'custom-oauth' && custom.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
      rmSync(join(dir, '.config.json'), { force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // CLAUDE_CODE_CUSTOM_OAUTH_URL anywhere fails closed.
  await refused('CLAUDE_CODE_CUSTOM_OAUTH_URL in the environment', { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example.com' }, none, 'custom-oauth')
  await refused('CLAUDE_CODE_CUSTOM_OAUTH_URL in the settings env', {}, () => Promise.resolve({ env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example.com' } }), 'custom-oauth')
  await viaGlobal('CLAUDE_CODE_CUSTOM_OAUTH_URL in a global config env', () => ({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example.com' }), 'custom-oauth')
  await viaGlobal('a non-first-party env in ANY of several global config files', () => [{}, { ANTHROPIC_UNIX_SOCKET: '/tmp/s' }], 'unix-socket')
  // The config directory as the CLI reads it: exact case on POSIX, any case
  // on Windows; spellings that disagree fail closed.
  check('config dir: the exact name on POSIX', claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '/a' }, 'linux') === '/a' && claudeConfigDirOf({}, 'linux') === undefined)
  check('config dir: a lower-case spelling the CLI ignores on POSIX is a conflict', claudeConfigDirOf({ claude_config_dir: '/b' }, 'linux') === 'conflict' && claudeGlobalConfigPaths({ claude_config_dir: '/b' }, 'linux') === 'conflict')
  check('config dir: spellings that disagree are a conflict (both platforms)', claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '/a', Claude_Config_Dir: '/b' }, 'linux') === 'conflict' && claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '/a', Claude_Config_Dir: '/b' }, 'win32') === 'conflict')
  check('config dir: spellings that agree are fine; Windows reads any case', claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '/a', claude_config_dir: '/a' }, 'linux') === '/a' && claudeConfigDirOf({ claude_config_dir: 'C:\\cfg' }, 'win32') === 'C:\\cfg')
  const paths = claudeGlobalConfigPaths({ CLAUDE_CONFIG_DIR: '/cfg' }, 'linux')
  check('the candidates: .config.json, .claude.json and .claude-custom-oauth.json', Array.isArray(paths) && JSON.stringify(paths) === JSON.stringify([join('/cfg', '.config.json'), join('/cfg', '.claude.json'), join('/cfg', '.claude-custom-oauth.json')]), paths)
  {
    const source = fakeSource(stored)
    const conflict = await resolveClaudeAuth({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/a', claude_config_dir: '/b' }, source, { settings: none })
    check('a config-dir conflict fails closed (the token is never read)', conflict.route?.kind === 'settings-unreadable' && conflict.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && source.calls.length === 0)
  }
  // The pin: an injected token travels with the first-party route pinned in
  // the flag-settings layer, and the child env loses every routing variable.
  {
    const pinned = await resolveClaudeAuth({ PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_USE_BEDROCK: '0', Claude_Code_Use_Vertex: 'false', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }, fakeSource(stored), firstParty)
    const pin = pinned.settings?.env ?? {}
    check('pin: the flag settings set the first-party base URL', pinned.source === 'dsh-auth' && pin.ANTHROPIC_BASE_URL === 'https://api.anthropic.com', pin)
    check('pin: … and blank the other routing variables (the known ones and those the env spells)', ['CLAUDE_CODE_API_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE'].every(key => pin[key] === '') && pin.CLAUDE_CODE_USE_POWERSHELL_TOOL === undefined, pin)
    check('pin: the child env drops them (feature flags stay)', Object.keys(pinned.env).sort().join() === 'CLAUDE_CODE_OAUTH_TOKEN,CLAUDE_CODE_USE_POWERSHELL_TOOL,PATH', Object.keys(pinned.env))
    const notInjected = await resolveClaudeAuth({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' }, undefined, firstParty)
    check('pin: only an injected token is pinned', notInjected.settings === undefined)
  }
  check('detection: any routing flag is a credential', await detectClaudeAuth({ CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CONFIG_DIR: '/nonexistent' }, undefined, 'linux') === 'ok')
  check('a refresh failure is reported by HTTP status only', refreshFailureStatus(new Error('400 Bad Request: {"error":"invalid_grant","token":"secret-body"}')) === '400' && refreshFailureStatus(Object.assign(new Error('x'), { status: 401 })) === '401' && refreshFailureStatus(new Error('socket hang up')) === undefined && refreshFailureStatus(Object.assign(new Error('x'), { status: 401.5 })) === undefined)
}

// ── the dsh-auth credential source (real credential file, fake refresh) ──
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-auth-'))
  const file = join(dir, 'dsh-auth', 'credentials.json')
  try {
    mkdirSync(join(dir, 'dsh-auth'), { recursive: true })
    const now = 1_000_000_000_000
    const write = (expires: number): void => writeFileSync(file, JSON.stringify({ version: 1, providers: { anthropic: { type: 'oauth', access: TOKEN, refresh: 'refresh-token', expires } } }))
    const refreshes: string[] = []
    const refresh = (_provider: string, credential: { access: string; refresh: string; expires: number }) => {
      refreshes.push(credential.refresh)
      return Promise.resolve({ type: 'oauth' as const, access: `${TOKEN}-renewed`, refresh: 'refresh-token-2', expires: now + 3_600_000 })
    }
    const source = createOAuthCredentialSource('anthropic', { file, now: () => now, refresh })
    check('no file: nothing stored', await source.stored() === false && await source.fresh() === undefined)
    write(now + 3_600_000)
    const fresh = await source.fresh()
    check('a fresh token is returned as is (no refresh)', fresh?.access === TOKEN && refreshes.length === 0)
    write(now + 60_000)
    const renewed = await source.fresh()
    check('a token about to expire is refreshed before spawn', renewed?.access === `${TOKEN}-renewed` && refreshes.length === 1)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { providers: { anthropic: { access: string; refresh: string } } }
    check('the refreshed credential is persisted under the file lock', persisted.providers.anthropic.access === `${TOKEN}-renewed` && persisted.providers.anthropic.refresh === 'refresh-token-2')
    await source.fresh({ rejected: 'some-older-token' })
    check('a refused token that was already rotated is not refreshed again (CAS)', refreshes.length === 1)
    const swapped = await source.fresh({ rejected: `${TOKEN}-renewed` })
    check('the refused token, still stored, is refreshed', refreshes.length === 2 && swapped?.access === `${TOKEN}-renewed`)
    await source.fresh()
    check('a plain fresh() never refreshes a fresh token', refreshes.length === 2)
    const other = createOAuthCredentialSource('openai', { file, now: () => now, refresh })
    check('another provider\'s login is not this one', await other.fresh() === undefined && await other.stored() === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── detection ─────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-config-'))
  try {
    const empty = join(dir, 'empty')
    const withLogin = join(dir, 'login')
    mkdirSync(empty)
    mkdirSync(withLogin)
    writeFileSync(join(withLogin, '.credentials.json'), '{}')
    check('detect: an env key → ok', await detectClaudeAuth({ ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: empty }, undefined, 'linux') === 'ok')
    check('detect: a stored dsh-auth login → ok', await detectClaudeAuth({ CLAUDE_CONFIG_DIR: empty }, fakeSource({ access: TOKEN, expires: 1 }), 'linux') === 'ok')
    check('detect: the CLI credentials file → ok', await detectClaudeAuth({ CLAUDE_CONFIG_DIR: withLogin }, undefined, 'linux') === 'ok')
    check('detect: nothing → missing', await detectClaudeAuth({ CLAUDE_CONFIG_DIR: empty }, fakeSource(undefined), 'linux') === 'missing')
    check('detect: nothing on macOS → unknown (keychain)', await detectClaudeAuth({ CLAUDE_CONFIG_DIR: empty }, undefined, 'darwin') === 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── failure shapes (as CLI 2.1.287 reports them) ──────────────────────
check('assistant authentication_failed is an auth failure', isAuthFailure({ type: 'assistant', error: 'authentication_failed', message: {} }))
check('result is_error "Failed to authenticate … 401" is an auth failure', isAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }))
check('result is_error "Please run /login" is an auth failure', isAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))
check('an ordinary error result is not', !isAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Overloaded' }) && !isAuthFailure({ type: 'assistant', error: 'rate_limit' }))

// ── auth failure → renew + resume once; a second failure → /login ─────
{
  const fake = fakeClaudeSdk()
  const debug: string[] = []
  let renewals = 0
  const renewalsAsked: (string | undefined)[] = []
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    host: { debug: message => { debug.push(message) } },
    auth: {
      plan,
      renew: renewal => {
        renewals += 1
        renewalsAsked.push(renewal.rejected)
        return Promise.resolve({ ...plan, env: { ...plan.env, CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}-${renewals}` } })
      },
    },
  }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const first = fake.queries[0]!
  check('the first query names the new session and runs on the injected token', first.options.sessionId === '00000000-0000-4000-8000-0000000000ab' && first.options.resume === undefined && first.options.env?.CLAUDE_CODE_OAUTH_TOKEN === TOKEN)
  check('… with the plan\'s route pin as the flag settings', (first.options.settings as { env?: Record<string, string> } | undefined)?.env?.ANTHROPIC_BASE_URL === 'https://api.anthropic.com', first.options.settings)
  const failTurn = async (query: typeof first): Promise<void> => {
    query.emit({ type: 'system', subtype: 'status', status: 'requesting' })
    query.emit({ type: 'assistant', error: 'authentication_failed', message: { id: `m-${fake.queries.length}`, model: 'haiku', content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }], usage: {} } })
    query.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', terminal_reason: 'api_error' })
    for (let i = 0; i < 10; i += 1) await tick()
  }
  await failTurn(first)
  check('an auth failure renews the credential once', renewals === 1)
  check('… naming the refused token (compare-and-swap renewal)', renewalsAsked[0] === TOKEN)
  check('… closes the old CLI and resumes the SAME session', first.closed && fake.queries.length === 2 && fake.queries[1]!.options.resume === '00000000-0000-4000-8000-0000000000ab' && fake.queries[1]!.options.sessionId === undefined)
  check('… on the renewed credential', fake.queries[1]!.options.env?.CLAUDE_CODE_OAUTH_TOKEN === `${TOKEN}-1`)
  check('… still pinned', (fake.queries[1]!.options.settings as { env?: Record<string, string> } | undefined)?.env?.ANTHROPIC_BASE_URL === 'https://api.anthropic.com')
  check('… and says it reconnected', events.some(event => event.type === 'notice' && event.text === t('claude-auth-reconnected')))
  check('the session is still the same live session', session.status !== 'disposed' && session.ref.sessionId === '00000000-0000-4000-8000-0000000000ab')
  const turnsBefore = events.filter(event => event.type === 'turn.start').length
  await failTurn(fake.queries[1]!)
  check('translator state survives the reconnect (turn numbering continues)', events.filter((event): event is Extract<AgentEvent, { type: 'turn.start' }> => event.type === 'turn.start').at(-1)?.turn === turnsBefore + 1)
  check('a second failure does not loop: no third CLI, no second renewal', fake.queries.length === 2 && renewals === 1)
  check('… it sends the user to /login', events.some(event => event.type === 'notice' && event.level === 'error' && event.text === t('claude-auth-failed-login')))
  await session.capabilities.auth!.reconnect()
  check('/login\'s reconnect renews and resumes again', renewals === 2 && fake.queries.length === 3 && fake.queries[2]!.options.resume === '00000000-0000-4000-8000-0000000000ab')
  check('… without forcing a refresh of what dsh-auth stored', renewalsAsked[1] === undefined)
  const status = await session.capabilities.auth!.status()
  check('the /login status names the source', status.lines.some(line => line === t('claude-auth-source', { source: t('claude-auth-source-dsh-auth-expires', { time: new Date(1).toISOString() }) })), status.lines)
  const diagnostics = session.capabilities.diagnostics!.lines()
  await session.dispose()
  const everything = JSON.stringify([events, debug, status, diagnostics])
  check('no token text in any event, notice, status line or debug log', !everything.includes(TOKEN) && !everything.includes('FAKE-TOKEN'))
}

// ── a successful turn resets the reconnect budget ─────────────────────
{
  const fake = fakeClaudeSdk()
  let renewals = 0
  const plan = { source: 'claude-login' as const, env: { PATH: '/usr/bin' } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => { renewals += 1; return Promise.resolve(plan) } } }))
  session.subscribe(() => undefined)
  const fail = async (index: number): Promise<void> => {
    const query = fake.queries[index]!
    query.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
    for (let i = 0; i < 10; i += 1) await tick()
  }
  await fail(0)
  fake.queries[1]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  await tick()
  await fail(1)
  check('after a successful turn, a new failure may reconnect again', renewals === 2 && fake.queries.length === 3)
  await session.dispose()
}

// ── a session the CLI never persisted is created again, not resumed ───
{
  const sessionId = '00000000-0000-4000-8000-0000000000ab'
  // The fake CLI knows a transcript only once a turn reported its result.
  const known = new Set<string>()
  const fake = fakeClaudeSdk((_index, options) => {
    if (typeof options.resume === 'string' && !known.has(options.resume)) throw new Error(`No conversation found with session ID: ${options.resume}`)
    return { capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }
  })
  // An injected (pinned) credential: every spawn of this block — the
  // create-again, the refused resume and its fallback — carries the pin.
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const pinnedAt = (index: number): boolean => (fake.queries[index]?.options.settings as { env?: Record<string, string> } | undefined)?.env?.ANTHROPIC_BASE_URL === 'https://api.anthropic.com'
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  await session.capabilities.auth!.reconnect()
  check('a fresh session reconnects by CREATING the same id (no resume)', fake.queries.length === 2 && fake.queries[1]!.options.sessionId === sessionId && fake.queries[1]!.options.resume === undefined && session.status !== 'disposed')
  // A turn result marks the session persisted, but this fake CLI still has
  // no transcript for it: the resume is refused and falls back to create.
  fake.queries[1]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  for (let i = 0; i < 5; i += 1) await tick()
  await session.capabilities.auth!.reconnect()
  check('a refused resume ("No conversation found") falls back to create', fake.queries.length === 4 && fake.queries[2]!.options.resume === sessionId && fake.queries[2]!.closed && fake.queries[3]!.options.sessionId === sessionId && fake.queries[3]!.options.resume === undefined)
  check('… the create-again, the refused resume and the fallback spawn all carry the route pin', pinnedAt(1) && pinnedAt(2) && pinnedAt(3))
  check('… and the session stays live', session.status !== 'disposed' && !events.some(event => event.type === 'session.status' && event.status === 'disposed'))
  known.add(sessionId)
  await session.capabilities.auth!.reconnect()
  check('a persisted session the CLI knows is resumed', fake.queries.length === 5 && fake.queries[4]!.options.resume === sessionId)
  check('… pinned too', pinnedAt(4))
  await session.dispose()
}

// ── reconnects never tear down a running turn or its queue ────────────
{
  const fake = fakeClaudeSdk()
  // A pinned dsh-auth plan: the `/login` reconnect and the auth-failure
  // reconnects must spawn with the route pin.
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const pinnedAt = (index: number): boolean => (fake.queries[index]?.options.settings as { env?: Record<string, string> } | undefined)?.env?.ANTHROPIC_BASE_URL === 'https://api.anthropic.com'
  let renewGate: (() => void) | undefined
  let renewals = 0
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    auth: {
      plan,
      renew: () => {
        renewals += 1
        if (renewals !== 3) return Promise.resolve(plan)
        return new Promise(resolve => { renewGate = () => resolve(plan) })
      },
    },
  }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  const notices = (): string[] => events.flatMap(event => event.type === 'notice' ? [event.text] : [])
  const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await tick() }
  await tick()
  const first = fake.queries[0]!
  await session.submit({ text: 'running turn', clientMessageId: 'u-1' }, 'followup')
  await settle()
  first.emit({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'started' })
  await settle()
  check('a turn is running', session.status === 'running')
  // `/login` during the turn: deferred, with a notice; a message sent
  // meanwhile waits and goes to the reconnected CLI.
  const login = session.capabilities.auth!.reconnect()
  await settle()
  check('/login during a running turn defers the reconnect, with a notice', fake.queries.length === 1 && notices().includes(t('claude-auth-reconnect-deferred')) && !first.closed)
  // While the reconnect is deferred the serving CLI keeps taking input (a
  // steer must not wait behind a turn's end).
  const sent = await within(session.submit({ text: 'sent while waiting', clientMessageId: 'u-2' }, 'followup'))
  await settle()
  check('… a message sent meanwhile goes to the serving CLI at once', sent !== 'timed out' && first.inputs.some(input => input.uuid === 'u-2'))
  first.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  await settle()
  check('… the reconnect still waits for the input queued behind the turn', fake.queries.length === 1 && !first.closed)
  first.emit({ type: 'command_lifecycle', command_uuid: 'u-2', state: 'started' })
  first.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done too' })
  await login
  await settle()
  const second = fake.queries[1]!
  check('… it reconnects once the turn and its queue ended', fake.queries.length === 2 && first.closed && second.inputs.length === 0)
  check('… the /login reconnect spawns with the route pin', pinnedAt(0) && pinnedAt(1))
  // An auth failure with inputs queued behind the failing turn: the ones the
  // old CLI never started are pushed again, in order, as plain pushes.
  await session.submit({ text: 'queued one', clientMessageId: 'u-3' }, 'followup')
  await session.submit({ text: 'queued two', clientMessageId: 'u-4' }, 'followup')
  await settle()
  second.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401' })
  await settle()
  const third = fake.queries[2]!
  const repushed = third.inputs.map(input => input.uuid)
  check('inputs the old CLI never started are pushed again, in order', JSON.stringify(repushed) === JSON.stringify(['u-3', 'u-4']), repushed)
  check('… as plain pushes to the idle CLI', third.inputs.every(input => input.priority === undefined))
  check('… their previews stay until the new CLI starts them', !events.some(event => event.type === 'pending.changed' && (event.discarded ?? []).some(id => id === 'u-3' || id === 'u-4')))
  third.emit({ type: 'command_lifecycle', command_uuid: 'u-3', state: 'started' })
  third.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  await settle()
  // An auth failure while a renewal is in flight: the old CLI's late
  // failing result must not read as a second failure.
  third.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401' })
  await settle()
  check('an auth failure starts a renewal', renewals === 3 && renewGate !== undefined)
  third.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401' })
  await settle()
  check('… a late failing result of the old CLI is ignored while renewing', !notices().includes(t('claude-auth-failed-login')))
  renewGate!()
  await settle()
  check('… and the reconnect completes once', fake.queries.length === 4 && notices().filter(text => text === t('claude-auth-reconnected')).length === 2)
  check('… every auth-failure reconnect is pinned as well', pinnedAt(2) && pinnedAt(3))
  await session.dispose()
}

// ── inputs that cannot be re-delivered are retired, the refresh error stays out of notices ──
{
  let fail = false
  const fake = fakeClaudeSdk(() => {
    if (fail) throw new Error('spawn failed')
    return { capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }
  })
  const plan = { source: 'claude-login' as const, env: { PATH: '/usr/bin' } }
  let renewalError: Error | undefined
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    auth: {
      plan,
      renew: () => renewalError === undefined ? Promise.resolve(plan) : Promise.reject(renewalError),
      failureNotice: () => t('claude-auth-refresh-failed', { detail: t('claude-auth-refresh-status', { status: '400' }) }),
    },
  }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  renewalError = new Error('400 Bad Request: {"error":"invalid_grant","echo":"refresh-token-body"}')
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 10; i += 1) await tick()
  const text = JSON.stringify(events)
  check('a failed renewal notice carries the HTTP status, never the error body', events.some(event => event.type === 'notice' && event.text === t('claude-auth-refresh-failed', { detail: t('claude-auth-refresh-status', { status: '400' }) })) && !text.includes('refresh-token-body'))
  await session.dispose()
  // A reconnect whose new CLI cannot start: what never started is retired.
  const dropping = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  const dropped: AgentEvent[] = []
  dropping.subscribe(batch => { dropped.push(...batch) })
  await tick()
  const query = fake.queries.at(-1)!
  await dropping.submit({ text: 'never started', clientMessageId: 'u-9' }, 'followup')
  for (let i = 0; i < 3; i += 1) await tick()
  fail = true
  query.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 10; i += 1) await tick()
  check('inputs a failed reconnect cannot deliver are retired with a notice', dropped.some(event => event.type === 'pending.changed' && (event.discarded ?? []).includes('u-9')) && dropped.some(event => event.type === 'notice' && event.text === t('claude-auth-inputs-dropped', { n: 1 })))
  await dropping.dispose()
}

// ── an auth failure stops the old CLI before renewing: its queue is re-pushed whole ──
{
  const fake = fakeClaudeSdk()
  // A pinned dsh-auth plan: the `/login` reconnect and the auth-failure
  // reconnects must spawn with the route pin.
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const pinnedAt = (index: number): boolean => (fake.queries[index]?.options.settings as { env?: Record<string, string> } | undefined)?.env?.ANTHROPIC_BASE_URL === 'https://api.anthropic.com'
  let renewGate: (() => void) | undefined
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => new Promise(resolve => { renewGate = () => resolve(plan) }) } }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await tick() }
  await tick()
  const first = fake.queries[0]!
  await session.submit({ text: 'failing turn', clientMessageId: 'u-1' }, 'followup')
  await settle()
  first.emit({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'started' })
  await session.submit({ text: 'queued two', clientMessageId: 'u-2' }, 'followup')
  await session.submit({ text: 'queued three', clientMessageId: 'u-3' }, 'followup')
  await settle()
  first.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401' })
  await settle()
  check('the old CLI is stopped BEFORE the renewal completes', first.closed && renewGate !== undefined && fake.queries.length === 1)
  // The stopped CLI's late frames (it had started u-2 and failed it) are
  // not the session's any more.
  first.emit({ type: 'command_lifecycle', command_uuid: 'u-2', state: 'started' })
  first.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401' })
  await settle()
  renewGate!()
  await settle()
  const second = fake.queries[1]!
  check('every input the old CLI had not started is re-pushed, in order', JSON.stringify(second.inputs.map(input => input.uuid)) === JSON.stringify(['u-2', 'u-3']), second.inputs.map(input => input.uuid))
  check('… no user row or second failure from the stopped CLI', !events.some(event => event.type === 'user.message' && event.id === 'u-2') && !events.some(event => event.type === 'notice' && event.text === t('claude-auth-failed-login')))
  check('… and the session never read the stop as a process exit', session.status !== 'disposed' && !events.some(event => event.type === 'notice' && event.text.includes(t('claude-process-ended'))))
  await session.dispose()
  check('every query this session opened is closed', fake.queries.every(query => query.closed))
}

// ── a dispose during a resume handshake leaves no CLI behind ──────────
{
  let refuse: (() => void) | undefined
  const fake = fakeClaudeSdk((_index, options) => {
    if (typeof options.resume === 'string') return new Promise((_resolve, reject) => { refuse = () => reject(new Error(`No conversation found with session ID: ${String(options.resume)}`)) })
    return { capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }
  })
  const plan = { source: 'claude-login' as const, env: { PATH: '/usr/bin' } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  session.subscribe(() => undefined)
  await tick()
  // Persisted (a result arrived): the next reconnect resumes.
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  for (let i = 0; i < 4; i += 1) await tick()
  const reconnect = session.capabilities.auth!.reconnect().catch(() => undefined)
  for (let i = 0; i < 6; i += 1) await tick()
  check('a resume handshake is in flight', fake.queries.length === 2 && refuse !== undefined)
  const disposed = session.dispose()
  refuse!()
  await reconnect
  await disposed
  for (let i = 0; i < 6; i += 1) await tick()
  check('the "No conversation found" fallback does not spawn after a dispose', fake.queries.length === 2)
  check('… every query the session opened is closed', fake.queries.every(query => query.closed))
}

// ── a deferred /login reconnect is bounded ────────────────────────────
{
  const fake = fakeClaudeSdk()
  const timer = manualClock()
  const plan = { source: 'claude-login' as const, env: { PATH: '/usr/bin' } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { clock: timer.clock, reconnectDeferMs: 120_000, auth: { plan, renew: () => Promise.resolve(plan) } }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await tick() }
  await tick()
  const first = fake.queries[0]!
  await session.submit({ text: 'a turn that never ends', clientMessageId: 'u-1' }, 'followup')
  await settle()
  first.emit({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'started' })
  await settle()
  const login = session.capabilities.auth!.reconnect()
  await settle()
  timer.advance(119_000)
  await settle()
  check('a deferred /login reconnect waits for the running turn…', fake.queries.length === 1 && !first.closed)
  timer.advance(1_000)
  const reconnected = await within(login)
  await settle()
  check('… at most 120 s, then reconnects anyway', reconnected !== 'timed out' && fake.queries.length === 2 && first.closed)
  check('… saying it interrupts the turn', events.some(event => event.type === 'notice' && event.text === t('claude-auth-reconnect-forced')) && events.some(event => event.type === 'turn.end' && event.reason.kind === 'aborted'))
  await session.dispose()
}

// ── a failed renewal is logged by category + HTTP status only (reconnect path) ──
{
  const fake = fakeClaudeSdk()
  const debug: string[] = []
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const SECRET = 'SYNTHETIC-SECRET-never-to-log'
  // A realistic refresh rejection: the HTTP body echoes request material.
  const renewal = Object.assign(new Error(`401 Unauthorized: {"error":"invalid_grant","client_secret":"${SECRET}"}`), { status: 401 })
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    host: { debug: message => { debug.push(message) } },
    auth: { plan, renew: () => Promise.reject(renewal) },
  }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 10; i += 1) await tick()
  const logged = debug.join('\n')
  check('reconnect: the renewal failure is logged as category + HTTP status only', logged.includes('reconnect failed (HTTP 401)'), logged)
  check('reconnect: the error body never reaches the debug log', !logged.includes(SECRET) && !logged.includes('invalid_grant'), logged)
  check('reconnect: nor any event or notice', !JSON.stringify(events).includes(SECRET) && !JSON.stringify(events).includes('invalid_grant'))
  await session.dispose()
  // A renewal failure with no HTTP status in it: the fixed category says
  // so instead of quoting the error's own text.
  const debug2: string[] = []
  const session2 = await openClaudeSession(claudeDeps(fake.sdk, {
    host: { debug: message => { debug2.push(message) } },
    auth: { plan, renew: () => Promise.reject(new Error('socket hang up')) },
  }))
  session2.subscribe(() => undefined)
  await tick()
  fake.queries.at(-1)!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 10; i += 1) await tick()
  const logged2 = debug2.join('\n')
  check('reconnect: a failure with no status is logged as the fixed category, not the error text', logged2.includes('reconnect failed') && !logged2.includes('socket hang up'), logged2)
  await session2.dispose()
  // `/login`'s reconnect rejects to the caller, which shows the message in a
  // toast: it must be the sanitized sentence, never the refresh error body.
  const debug3: string[] = []
  const refusedNotice = t('claude-auth-refresh-failed', { detail: t('claude-auth-refresh-status', { status: '401' }) })
  const session3 = await openClaudeSession(claudeDeps(fake.sdk, {
    host: { debug: message => { debug3.push(message) } },
    auth: { plan, renew: () => Promise.reject(renewal), failureNotice: () => refusedNotice },
  }))
  session3.subscribe(() => undefined)
  await tick()
  const rejection = await session3.capabilities.auth!.reconnect().then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
  check('/login reconnect: the rejection is the sanitized sentence, never the error body', rejection === refusedNotice, rejection)
  check('/login reconnect: logged as category + HTTP status only', debug3.join('\n').includes('reconnect failed (HTTP 401)') && !debug3.join('\n').includes(SECRET), debug3.join('\n'))
  await session3.dispose()
}

// ── a failed pre-start refresh is logged the same way (startup path) ──
// claudeBackend.open() over the real SDK loader with a rejecting dsh-auth
// source; only the startup catch's debug line is observable here (a start
// notice would need a live CLI handshake). The "CLI" is node itself
// (CLAUDE_CODE_EXECUTABLE): it rejects the SDK's args and exits at once.
// The composition runs in an isolated child that points HOME and the
// config dir at a temp directory before importing anything, so no module
// of this test process (and no cached data dir of the host user) is read.
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-startup-'))
  const SECRET = 'SYNTHETIC-SECRET-never-to-log'
  const backendUrl = new URL('../src/backends/claude/index.ts', import.meta.url).href
  const root = fileURLToPath(new URL('..', import.meta.url))
  // argv: backend URL, home, config dir, secret. The env is scrubbed of
  // every routing/credential variable before the first import.
  const child = [
    "const [backendUrl, home, configDir, secret] = process.argv.slice(2)",
    "process.env.HOME = home",
    "process.env.USERPROFILE = home",
    "process.env.CLAUDE_CONFIG_DIR = configDir",
    "for (const key of Object.keys(process.env)) {",
    "  const upper = key.toUpperCase()",
    "  if (upper.startsWith('ANTHROPIC_') || upper === 'CLAUDECODE' || (upper.startsWith('CLAUDE_CODE_') && upper !== 'CLAUDE_CODE_EXECUTABLE')) delete process.env[key]",
    "}",
    "process.env.CLAUDE_CODE_EXECUTABLE = process.execPath",
    "const renewal = Object.assign(new Error('401 Unauthorized: invalid_grant client_secret=' + secret), { status: 401 })",
    "const debug = []",
    "const report = outcome => console.log('@@RESULT@@' + JSON.stringify({ outcome, debug }))",
    "try {",
    "  const { claudeBackend } = await import(backendUrl)",
    "  const session = await claudeBackend.open({ kind: 'create', cwd: home }, {",
    "    cwd: home,",
    "    debug: message => { debug.push(message) },",
    "    warn: () => undefined,",
    "    oauthCredential: () => ({ stored: () => Promise.resolve(true), fresh: () => Promise.reject(renewal) }),",
    "  })",
    "  await session.dispose()",
    "  report('opened')",
    "} catch (error) {",
    "  report('rejected: ' + (error instanceof Error ? error.message : String(error)))",
    "}",
  ].join('\n')
  const probe = join(home, 'startup-probe.mjs')
  writeFileSync(probe, child)
  let stdout = ''
  let stderr = ''
  try {
    const ran = await new Promise<{ code: number | null }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx/esm', probe, backendUrl, home, join(home, '.claude'), SECRET], { cwd: root, timeout: 30_000 }, (error, out, err) => {
        stdout = String(out)
        stderr = String(err)
        resolve({ code: error === null ? 0 : (error.code ?? 1) })
      })
    })
    const lines = stdout.split('\r\n')
    const line = lines.find(l => l.startsWith('@@RESULT@@'))
    const parsed = line === undefined ? undefined : JSON.parse(line.slice('@@RESULT@@'.length)) as { outcome: string; debug: string[] }
    check('startup: the isolated child ran and reported', parsed !== undefined && ran.code === 0, { code: ran.code, stderr: stderr.slice(0, 300), stdout: stdout.slice(0, 300) })
    check('startup: the open rejects on the fake executable (nothing else ran)', parsed !== undefined && parsed.outcome.startsWith('rejected'), parsed?.outcome)
    const logged = parsed === undefined ? '' : parsed.debug.join('\n')
    check('startup: the pre-start refresh failure is logged as category + HTTP status only', logged.includes('dsh-auth refresh failed (HTTP 401)'), logged)
    check('startup: the error body never reaches the debug log', !logged.includes(SECRET) && !logged.includes('invalid_grant'), logged)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\nverify-claude-auth OK (${passed} checks)`)
process.exit(0)
