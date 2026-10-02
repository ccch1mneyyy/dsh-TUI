/**
 * Claude credentials (docs/agent-backend-design.md §4.12, D-AUTH) against fake
 * credential sources and a FAKE SDK — no CLI, no network, no real token:
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
 *    credential and resumes the SAME session once — same id, translator
 *    state kept, a reconnect notice — and a second failure sends the user to
 *    /login instead of looping; `/login`'s reconnect resets that;
 *  - no token text appears in any event, notice, status line or debug log.
 *
 * Run: node --import tsx/esm scripts/verify-claude-auth.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthAccess, OAuthCredentialSource } from '../src/agent/backend.js'
import type { AgentEvent } from '../src/agent/events.js'
import { detectClaudeAuth, isAuthFailure, resolveClaudeAuth } from '../src/backends/claude/auth.js'
import { openClaudeSession } from '../src/backends/claude/session.js'
import { createOAuthCredentialSource } from '../src/dsh-adapter/oauth-credential-source.js'
import { setLang, t } from '../src/i18n.js'
import { claudeDeps, fakeClaudeSdk, tick } from './lib/claude-fake-sdk.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const TOKEN = 'sk-ant-oat01-FAKE-TOKEN-never-printed'
const fakeSource = (credential: OAuthAccess | undefined, onFresh: (force: boolean) => OAuthAccess | undefined = () => credential): OAuthCredentialSource & { calls: boolean[] } => {
  const calls: boolean[] = []
  return {
    calls,
    stored: () => Promise.resolve(credential !== undefined),
    fresh: options => {
      calls.push(options?.force === true)
      return Promise.resolve(onFresh(options?.force === true))
    },
  }
}

// ── precedence ────────────────────────────────────────────────────────
{
  const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-api-user', ANTHROPIC_AUTH_TOKEN: 'bearer-user' }
  const dsh = await resolveClaudeAuth(base, fakeSource({ access: TOKEN, expires: Date.now() + 3_600_000 }))
  check('dsh-auth login wins: injected as CLAUDE_CODE_OAUTH_TOKEN', dsh.source === 'dsh-auth' && dsh.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN)
  check('dsh-auth login wins: the env API key and auth token are scrubbed', dsh.env.ANTHROPIC_API_KEY === undefined && dsh.env.ANTHROPIC_AUTH_TOKEN === undefined && dsh.env.PATH === '/usr/bin')
  check('the base env object is not mutated', base.ANTHROPIC_API_KEY === 'sk-ant-api-user')
  const key = await resolveClaudeAuth(base, fakeSource(undefined))
  check('no dsh-auth login: ANTHROPIC_API_KEY passes through', key.source === 'api-key' && key.env.ANTHROPIC_API_KEY === 'sk-ant-api-user' && key.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
  check('ANTHROPIC_AUTH_TOKEN alone', (await resolveClaudeAuth({ ANTHROPIC_AUTH_TOKEN: 'x' }, undefined)).source === 'auth-token')
  check('the user\'s own CLAUDE_CODE_OAUTH_TOKEN', (await resolveClaudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, undefined)).source === 'oauth-env')
  const local = await resolveClaudeAuth({ PATH: '/usr/bin' }, undefined)
  check('nothing injected: the local claude login', local.source === 'claude-login' && Object.keys(local.env).join() === 'PATH')
  const cloud = await resolveClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' }, fakeSource({ access: TOKEN, expires: Date.now() + 3_600_000 }))
  check('a cloud provider is never overridden by a token', cloud.source === 'cloud' && cloud.cloud === 'bedrock' && cloud.env.CLAUDE_CODE_OAUTH_TOKEN === undefined)
  check('CLAUDE_CODE_USE_BEDROCK=0 is not a cloud selection', (await resolveClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: '0' }, undefined)).source === 'claude-login')
  const failing: OAuthCredentialSource = { stored: () => Promise.resolve(true), fresh: () => Promise.reject(new Error('refresh failed: 400')) }
  check('a failing refresh rejects (the caller decides)', await resolveClaudeAuth({}, failing).then(() => false, () => true))
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
    await source.fresh({ force: true })
    check('force always refreshes', refreshes.length === 2)
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

// ── failure shapes (P-AUTH-1 probe) ───────────────────────────────────
check('assistant authentication_failed is an auth failure', isAuthFailure({ type: 'assistant', error: 'authentication_failed', message: {} }))
check('result is_error "Failed to authenticate … 401" is an auth failure', isAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }))
check('result is_error "Please run /login" is an auth failure', isAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))
check('an ordinary error result is not', !isAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Overloaded' }) && !isAuthFailure({ type: 'assistant', error: 'rate_limit' }))

// ── auth failure → renew + resume once; a second failure → /login ─────
{
  const fake = fakeClaudeSdk()
  const debug: string[] = []
  let renewals = 0
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    host: { debug: message => { debug.push(message) } },
    auth: {
      plan,
      renew: () => {
        renewals += 1
        return Promise.resolve({ ...plan, env: { ...plan.env, CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}-${renewals}` } })
      },
    },
  }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const first = fake.queries[0]!
  check('the first query names the new session and runs on the injected token', first.options.sessionId === '00000000-0000-4000-8000-0000000000ab' && first.options.resume === undefined && first.options.env?.CLAUDE_CODE_OAUTH_TOKEN === TOKEN)
  const failTurn = async (query: typeof first): Promise<void> => {
    query.emit({ type: 'system', subtype: 'status', status: 'requesting' })
    query.emit({ type: 'assistant', error: 'authentication_failed', message: { id: `m-${fake.queries.length}`, model: 'haiku', content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }], usage: {} } })
    query.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', terminal_reason: 'api_error' })
    for (let i = 0; i < 10; i += 1) await tick()
  }
  await failTurn(first)
  check('an auth failure renews the credential once', renewals === 1)
  check('… closes the old CLI and resumes the SAME session', first.closed && fake.queries.length === 2 && fake.queries[1]!.options.resume === '00000000-0000-4000-8000-0000000000ab' && fake.queries[1]!.options.sessionId === undefined)
  check('… on the renewed credential', fake.queries[1]!.options.env?.CLAUDE_CODE_OAUTH_TOKEN === `${TOKEN}-1`)
  check('… and says it reconnected', events.some(event => event.type === 'notice' && event.text === t('claude-auth-reconnected')))
  check('the session is still the same live session', session.status !== 'disposed' && session.ref.sessionId === '00000000-0000-4000-8000-0000000000ab')
  const turnsBefore = events.filter(event => event.type === 'turn.start').length
  await failTurn(fake.queries[1]!)
  check('translator state survives the reconnect (turn numbering continues)', events.filter((event): event is Extract<AgentEvent, { type: 'turn.start' }> => event.type === 'turn.start').at(-1)?.turn === turnsBefore + 1)
  check('a second failure does not loop: no third CLI, no second renewal', fake.queries.length === 2 && renewals === 1)
  check('… it sends the user to /login', events.some(event => event.type === 'notice' && event.level === 'error' && event.text === t('claude-auth-failed-login')))
  await session.capabilities.auth!.reconnect()
  check('/login\'s reconnect renews and resumes again', renewals === 2 && fake.queries.length === 3 && fake.queries[2]!.options.resume === '00000000-0000-4000-8000-0000000000ab')
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

console.log(`\nverify-claude-auth OK (${passed} checks)`)
process.exit(0)
