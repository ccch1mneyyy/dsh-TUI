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
 *  - no token text appears in any event, notice, status line or debug log;
 *  - the token is injected ONLY on the first-party route: a custom
 *    `ANTHROPIC_BASE_URL` (environment or settings `env`), a Unix socket, any
 *    `CLAUDE_CODE_USE_*` routing flag, a gateway route, an `apiKeyHelper` or
 *    unreadable settings leave the environment untouched (review item 2);
 *  - a renewal is compare-and-swap: only the refused token is refreshed;
 *  - a reconnect of a session the CLI never persisted creates it again
 *    (same id) instead of resuming, and falls back to that on "No
 *    conversation found"; a `/login` reconnect waits for the running turn;
 *    a late auth failure of the old CLI is ignored; inputs the old CLI never
 *    started are pushed again in order (or retired with a notice); a failed
 *    renewal shows the HTTP status only.
 *
 * Run: node --import tsx/esm scripts/verify-claude-auth.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthAccess, OAuthCredentialSource } from '../src/agent/backend.js'
import type { AgentEvent } from '../src/agent/events.js'
import { detectClaudeAuth, isAuthFailure, refreshFailureStatus, resolveClaudeAuth } from '../src/backends/claude/auth.js'
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
/** Effective settings with nothing route-relevant (the first-party route). */
const firstParty = { settings: () => Promise.resolve({}) }

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

// ── the subscription token reaches the first-party route only (item 2) ──
{
  const stored = { access: TOKEN, expires: Date.now() + 3_600_000 }
  const userEnv = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'user-gateway-key' }
  const refused = async (label: string, env: Record<string, string>, settings: () => Promise<Record<string, unknown> | undefined>, route: string): Promise<void> => {
    const source = fakeSource(stored)
    const plan = await resolveClaudeAuth({ ...userEnv, ...env }, source, { settings })
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
  check('detection: any routing flag is a credential', await detectClaudeAuth({ CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CONFIG_DIR: '/nonexistent' }, undefined, 'linux') === 'ok')
  check('a refresh failure is reported by HTTP status only', refreshFailureStatus(new Error('400 Bad Request: {"error":"invalid_grant","token":"secret-body"}')) === '400' && refreshFailureStatus(Object.assign(new Error('x'), { status: 401 })) === '401' && refreshFailureStatus(new Error('socket hang up')) === undefined)
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
  const renewalsAsked: (string | undefined)[] = []
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }
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

// ── a session the CLI never persisted is created again, not resumed (item 1) ──
{
  const sessionId = '00000000-0000-4000-8000-0000000000ab'
  // The fake CLI knows a transcript only once a turn reported its result.
  const known = new Set<string>()
  const fake = fakeClaudeSdk((_index, options) => {
    if (typeof options.resume === 'string' && !known.has(options.resume)) throw new Error(`No conversation found with session ID: ${options.resume}`)
    return { capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }
  })
  const plan = { source: 'claude-login' as const, env: { PATH: '/usr/bin' } }
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
  check('… and the session stays live', session.status !== 'disposed' && !events.some(event => event.type === 'session.status' && event.status === 'disposed'))
  known.add(sessionId)
  await session.capabilities.auth!.reconnect()
  check('a persisted session the CLI knows is resumed', fake.queries.length === 5 && fake.queries[4]!.options.resume === sessionId)
  await session.dispose()
}

// ── reconnects never tear down a running turn or its queue (item 4) ───
{
  const fake = fakeClaudeSdk()
  const plan = { source: 'claude-login' as const, env: { PATH: '/usr/bin' } }
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
  const later = session.submit({ text: 'sent while waiting', clientMessageId: 'u-2' }, 'followup')
  await settle()
  check('… a message sent meanwhile is held for the new CLI', !first.inputs.some(input => input.uuid === 'u-2'))
  first.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  await login
  await later
  await settle()
  const second = fake.queries[1]!
  check('… it reconnects once the turn ended', fake.queries.length === 2 && first.closed)
  check('… and the held message reaches the new CLI', second.inputs.some(input => input.uuid === 'u-2'))
  second.emit({ type: 'command_lifecycle', command_uuid: 'u-2', state: 'started' })
  await settle()
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

console.log(`\nverify-claude-auth OK (${passed} checks)`)
process.exit(0)
