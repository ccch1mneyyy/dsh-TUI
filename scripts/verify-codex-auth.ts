/** Credential-free C2 platform composition: real hub/auth/channel/runtime,
 * only the external app-server and host token source are scripted. Covers
 * route matrix, JWT identity, CAS/8s cancellation, degradation, secret-safe
 * /login methods, channel persistence/argv and per-field start precedence.
 * Run: node --import tsx/esm scripts/verify-codex-auth.ts */
import './lib/default-lang-zh.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredentialSource } from '../src/agent/backend.js'
import type { AgentEvent, QuestionRequestView } from '../src/agent/events.js'
import { prepareCodexRuntime } from '../src/backends/codex/backend.js'
import { acquireCodexAuth, createCodexAuth, externalTokensOf } from '../src/backends/codex/auth/external-tokens.js'
import { createCodexAuthCapability } from '../src/backends/codex/auth/status.js'
import { codexAuthRoute } from '../src/backends/codex/auth/route.js'
import { codexChannelLaunch, createCodexChannelsRuntime, fileCodexChannels, memoryCodexChannels, validateCodexBaseUrl } from '../src/backends/codex/channels.js'
import { detectCodexAuth } from '../src/backends/codex/detect.js'
import { fileCodexPrefs, memoryCodexPrefs, resolveCodexStartOptions } from '../src/backends/codex/prefs.js'
import { closeAllCodexHubs, createCodexHub, type HubSettings } from '../src/backends/codex/rpc/hub.js'
import type { RpcClock } from '../src/backends/codex/rpc/client.js'
import { channelTokenRef, fileChannelTokens, memoryChannelTokens } from '../src/backends/shared/channel-tokens.js'
import { createFakeAppServer } from './lib/codex-fake-app-server.js'

let passed = 0
const check = (label: string, ok: boolean): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
const SETTINGS: HubSettings = { executable: '/fake/codex', args: ['app-server'], env: {}, cwd: '/TMP/project' }
const jwt = (signature: string, id = 'account-public-id', plan: string | null = 'plus'): string => Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: plan } })).toString('base64url') + '.' + signature
const TOKEN_A = jwt('alpha-private-sentinel')
const TOKEN_B = jwt('beta-private-sentinel')
const TOKEN_C = jwt('gamma-private-sentinel', 'rotated-public-id', 'team')
const API_KEY = 'private-api-key-sentinel'
const safe = (values: unknown): boolean => ![TOKEN_A, TOKEN_B, TOKEN_C, API_KEY, 'alpha-private-sentinel', 'beta-private-sentinel', 'gamma-private-sentinel'].some(secret => JSON.stringify(values).includes(secret))

function manualClock(): RpcClock & { advance(ms: number): void } {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    setTimeout: (callback, ms) => { const id = ++next; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
    advance: ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() } },
  }
}
function fixture(clock?: RpcClock) {
  const fake = createFakeAppServer()
  fake.on('account/read', () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }))
  fake.on('config/read', () => ({ config: { model_provider: 'openai' } }))
  fake.on('account/login/start', params => ({ type: params.type }))
  fake.on('account/login/cancel', () => ({}))
  const debug: string[] = []
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory, ...(clock === undefined ? {} : { clock }), debug: line => debug.push(line) })
  return { fake, hub, debug }
}

// Every blocked route is independent; no token source is needed to inspect it.
const routes: readonly [string, Record<string, unknown> | undefined, Record<string, string | undefined>, boolean, boolean][] = [
  ['defaults', {}, {}, false, true],
  ['official provider', { model_provider: 'openai' }, {}, false, true],
  ['official URLs', { openai_base_url: 'https://api.openai.com/v1', chatgpt_base_url: 'https://chatgpt.com/backend-api/codex' }, {}, false, true],
  ['official env URL', {}, { OPENAI_BASE_URL: 'https://api.openai.com:443/v1' }, false, true],
  ['unused custom provider', { model_providers: { relay: { base_url: 'https://relay.invalid' } } }, {}, false, true],
  ['config/read unavailable', undefined, {}, false, false],
  ['active channel', {}, {}, true, false],
  ['custom provider', { model_provider: 'relay' }, {}, false, false],
  ['malformed provider id', { model_provider: 7 }, {}, false, false],
  ['openai provider base override', { model_providers: { openai: { base_url: 'https://relay.invalid/v1' } } }, {}, false, false],
  ['even an official openai provider base override', { model_providers: { openai: { base_url: 'https://api.openai.com/v1' } } }, {}, false, false],
  ['malformed provider definition', { model_providers: { openai: 'bad' } }, {}, false, false],
  ['custom openai_base_url', { openai_base_url: 'https://relay.invalid' }, {}, false, false],
  ['custom chatgpt_base_url', { chatgpt_base_url: 'https://relay.invalid' }, {}, false, false],
  ['http official host', { openai_base_url: 'http://api.openai.com' }, {}, false, false],
  ['official-lookalike suffix', { openai_base_url: 'https://api.openai.com.relay.invalid' }, {}, false, false],
  ['nonstandard port', { openai_base_url: 'https://api.openai.com:444/v1' }, {}, false, false],
  ['URL userinfo', { openai_base_url: 'https://user:private@api.openai.com' }, {}, false, false],
  ['query override', { chatgpt_base_url: 'https://chatgpt.com/?token=private' }, {}, false, false],
  ['custom environment URL', {}, { OPENAI_BASE_URL: 'https://relay.invalid' }, false, false],
  ['case-insensitive environment override', {}, { Openai_Base_Url: 'https://relay.invalid' }, false, false],
]
for (const [name, config, env, channel, expected] of routes) check('route: ' + name, codexAuthRoute(config, env, channel).firstParty === expected)
check('route diagnostics expose host only', codexAuthRoute({ model_provider: 'relay', model_providers: { relay: { base_url: 'https://private@relay.invalid/v1?token=private' } } }).host === 'relay.invalid')

const urls: readonly [string, boolean][] = [
  ['https://relay.invalid/v1', true], ['http://localhost:8080/v1', true], ['http://127.0.0.1:8080/v1', true],
  ['http://relay.invalid/v1', false], ['https://user:private@relay.invalid/v1', false],
  ['https://relay.invalid/v1?key=private', false], ['https://relay.invalid/v1#private', false],
  ['https://relay.invalid/v1?', false], ['https://relay.invalid/v1#', false],
  ['https://relay.invalid/sk-private', false], ['https://relay.invalid/key=private', false],
  ['https://relay.invalid/sk%2dprivate', false], ['https://relay.invalid/abcdefghijklmnopqrstuvwx', false],
  ['https://relay.invalid/aB0cD1eF2gH3iJ4kL5mN6oP7', false], ['file:///TMP/server', false],
]
for (const [value, expected] of urls) {
  let accepted = true
  try { validateCodexBaseUrl(value) } catch { accepted = false }
  check('channel URL validation case ' + urls.indexOf(urls.find(row => row[0] === value)!), accepted === expected)
}

// Channel state uses the actual shared token interface, never a private file.
{
  const tokens = memoryChannelTokens()
  const store = memoryCodexChannels()
  const channels = createCodexChannelsRuntime({ store, tokens })
  const view = channels.capability.save({ id: 'relay', name: 'Relay', baseUrl: 'https://relay.invalid/v1', token: API_KEY, models: { requested: 'served' }, env: { LOG_LEVEL: 'quiet' } })
  channels.capability.setActive('relay')
  const profile = channels.active()!
  const launch = channels.launch()
  check('channel: profile stores only a namespaced token ref', profile.tokenRef === channelTokenRef('codex-relay') && !JSON.stringify(store.read()).includes(API_KEY))
  check('channel: exact mapping and empty tiers reuse the shared view', view.models[0]?.from === 'requested' && view.models[0]?.to === 'served' && view.tiers.length === 0 && view.connection?.hasToken === true)
  check('channel: token travels only in child env, provider is Responses', Object.values(launch.env).includes(API_KEY) && !launch.args.some(arg => arg.includes(API_KEY)) && launch.args.some(arg => arg.endsWith('.wire_api="responses"')))
  check('channel: private env participates in launch identity', launch.injectedEnvKeys.includes('LOG_LEVEL'))
  let refused = false
  try { channels.capability.save({ id: 'bad', name: 'Bad', baseUrl: 'https://relay.invalid/?token=private', token: TOKEN_A }) } catch { refused = true }
  check('channel: invalid URL is rejected before token persistence', refused && !tokens.declared(channelTokenRef('codex-bad')))
  refused = false
  try { channels.capability.save({ id: 'env-secret', name: 'Bad', env: { CUSTOM_API_KEY: API_KEY } }) } catch { refused = true }
  check('channel: inline credential env is never persisted', refused && !store.read().channels.some(row => row.id === 'env-secret'))
  const fingerprint = view.connection?.fingerprint
  const rotated = channels.capability.save({ id: 'relay', name: 'Relay', token: TOKEN_B })
  check('channel: token rotation changes fingerprint without exposing values', rotated.connection?.fingerprint !== fingerprint && safe(channels.capability.list()))
  store.save({ id: 'same-token', name: 'Shared', baseUrl: 'https://relay.invalid/v1', tokenRef: profile.tokenRef })
  channels.capability.remove('relay')
  check('channel: another referent keeps a shared token', tokens.read(profile.tokenRef!) === TOKEN_B)
  store.save({ id: 'manual', name: 'Manual', baseUrl: 'https://relay.invalid/v1', tokenRef: 'HOST_OWNED_REF' })
  tokens.write('HOST_OWNED_REF', TOKEN_C)
  channels.capability.remove('manual')
  check('channel: removing a hand-written ref leaves host-owned credentials alone', tokens.read('HOST_OWNED_REF') === TOKEN_C)
  check('channel: tokenless HTTPS refuses instead of falling back to OAuth', (() => { try { codexChannelLaunch({ id: 'none', name: 'None', baseUrl: 'https://relay.invalid/v1' }, tokens); return false } catch { return true } })())
  check('channel: local anonymous Responses endpoint is supported', codexChannelLaunch({ id: 'local', name: 'Local', baseUrl: 'http://localhost:8080/v1' }).provider === 'dshtui-local')
  check('detect: active channel wins over ambient keys', detectCodexAuth({ OPENAI_API_KEY: API_KEY }, { channel: { id: 'bad', name: 'Bad', baseUrl: 'https://relay.invalid/v1' }, tokens }) === 'missing')
  channels.refreshConfig({ model_provider: 'relay', model_providers: { relay: { base_url: 'https://import.invalid/v1', env_key: 'CUSTOM_TOKEN', wire_api: 'responses' } } })
  const imported = createCodexChannelsRuntime({ store, tokens, config: { model_provider: 'relay', model_providers: { relay: { base_url: 'https://import.invalid/v1', env_key: 'CUSTOM_TOKEN', wire_api: 'responses' } } }, env: { CUSTOM_TOKEN: TOKEN_A } })
  check('channel: import reads current provider env_key and keeps only its ref', imported.capability.importFromSettings()?.connection?.hasToken === true && safe(imported.capability.peekSettingsImport()) && !JSON.stringify(store.read()).includes(TOKEN_A))
  imported.refreshConfig({ model_provider: 'dshtui-relay', model_providers: { 'dshtui-relay': { base_url: 'https://relay.invalid/v1', env_key: 'CUSTOM_TOKEN' } } })
  check('channel: own injected provider is never re-imported as user config', imported.capability.peekSettingsImport() === undefined)
}

// Damaged optional state is kept aside; no Codex configuration is written.
{
  const dir = mkdtempSync(join(tmpdir(), 'codex-platform-state-'))
  try {
    writeFileSync(join(dir, 'channels.json'), '{ damaged')
    const store = fileCodexChannels(dir)
    store.save({ id: 'local', name: 'Local', baseUrl: 'http://localhost:8080/v1' })
    check('channel file: damaged input is preserved before atomic save', readdirSync(dir).some(name => name.startsWith('channels.json.damaged-')) && store.read().channels[0]?.id === 'local')
    const prefs = fileCodexPrefs(dir)
    prefs.write({ mode: 'read-only', plan: true, model: 'chosen', effort: 'low' })
    prefs.write({ plan: false })
    check('prefs: Plan is persistent and independent of permission mode', prefs.read().plan === false && prefs.read().mode === 'read-only')
    check('prefs/channel files have no credential or Codex config payload', !readFileSync(join(dir, 'channels.json'), 'utf8').includes(API_KEY) && !readdirSync(dir).includes('config.toml'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
check('settings: successful empty config falls back to auto', JSON.stringify(resolveCodexStartOptions({}, {})) === JSON.stringify({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }))
check('settings: config approval and sandbox are preserved independently', JSON.stringify(resolveCodexStartOptions({}, { approval_policy: 'never' })) === JSON.stringify({ sandbox: 'workspace-write' }) && JSON.stringify(resolveCodexStartOptions({}, { sandbox_mode: 'read-only' })) === JSON.stringify({ approvalPolicy: 'on-request' }))
check('settings: no config/read is not proof of absent user choices', Object.keys(resolveCodexStartOptions({ plan: true })).length === 0)
check('settings: remembered fields win without copying config fields', JSON.stringify(resolveCodexStartOptions({ mode: 'full-access', model: 'chosen', effort: 'low' }, { approval_policy: 'on-request', sandbox_mode: 'read-only', model: 'user-config', model_reasoning_effort: 'high' })) === JSON.stringify({ approvalPolicy: 'never', sandbox: 'danger-full-access', model: 'chosen', config: { model_reasoning_effort: 'low' } }))
const memPrefs = memoryCodexPrefs({ mode: 'auto', plan: true })
memPrefs.write({ mode: 'read-only' })
check('prefs: changing permissions does not toggle Plan', memPrefs.read().plan === true && memPrefs.read().mode === 'read-only')

// Managed auth: actual wire parameters, once-per-hub, CAS and safe status.
{
  const { fake, hub, debug } = fixture()
  let stored = TOKEN_A
  let refreshes = 0
  const calls: { rejected?: string; signal?: AbortSignal }[] = []
  const credential: OAuthCredentialSource = {
    stored: async () => true,
    fresh: async (options?: { rejected?: string; signal?: AbortSignal }) => { calls.push(options ?? {}); if (options?.rejected === stored) { refreshes += 1; stored = TOKEN_B } return { access: stored, expires: Date.now() + 60_000 } },
  }
  const deps = { hub, cwd: SETTINGS.cwd, config: {}, credential, debug: (line: string) => debug.push(line) }
  const auth = acquireCodexAuth(deps)
  const notices: unknown[] = []
  auth.subscribe(notice => notices.push(notice))
  await Promise.all([auth.start(), auth.start()])
  const login = fake.requests.find(row => row.method === 'account/login/start')!
  check('OAuth: JWT account and plan become external-token login parameters', login.params.type === 'chatgptAuthTokens' && login.params.accessToken === TOKEN_A && login.params.chatgptAccountId === 'account-public-id' && login.params.chatgptPlanType === 'plus')
  check('OAuth: all sessions of a hub share one managed login', acquireCodexAuth(deps) === auth && fake.requests.filter(row => row.method === 'account/login/start').length === 1)
  stored = TOKEN_C
  const rotated = await fake.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'account-public-id' })
  check('refresh: rejected token is passed for CAS; a rotated stored login wins', calls.at(-1)?.rejected === TOKEN_A && refreshes === 0 && (rotated.result as { accessToken?: string }).accessToken === TOKEN_C)
  const refreshed = await fake.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'rotated-public-id' })
  check('refresh: unchanged rejected token refreshes once', calls.at(-1)?.rejected === TOKEN_C && refreshes === 1 && (refreshed.result as { accessToken?: string }).accessToken === TOKEN_B)
  check('refresh: each call receives an AbortSignal', calls.every(row => row.signal instanceof AbortSignal))
  check('auth status and diagnostics never expose sentinel token material', safe([debug, notices, await auth.status(), await auth.account(), hub.diagnostics]))
  await hub.close()
}

// Every route denial avoids touching the managed credential source.
for (const config of [undefined, { model_provider: 'relay' }, { model_providers: { openai: { base_url: 'https://relay.invalid' } } }]) {
  const { hub, fake } = fixture()
  let touched = 0
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config, credential: { stored: async () => true, fresh: async () => { touched += 1; return { access: TOKEN_A, expires: 0 } } } })
  await auth.start()
  check('OAuth: blocked route does not refresh or inject', touched === 0 && !fake.requests.some(row => row.method === 'account/login/start'))
  await hub.close()
}
{
  const { hub, fake } = fixture()
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {}, credential: { stored: async () => true, fresh: async () => ({ access: 'invalid-private-sentinel', expires: 0 }) } })
  await auth.start()
  check('OAuth: malformed JWT degrades to native login without injection', auth.source === 'api-key' && !fake.requests.some(row => row.method === 'account/login/start'))
  check('JWT claims: missing account id is not injectable', externalTokensOf({ access: Buffer.from('{}').toString('base64url') + '.' + Buffer.from('{}').toString('base64url') + '.sentinel', expires: 0 }) === undefined)
  await hub.close()
}
{
  const { hub, fake, debug } = fixture()
  let freshCalls = 0
  fake.on('account/login/start', params => { fake.notify('account/login/completed', { loginId: null, success: false, error: params.accessToken }); return { type: params.type } })
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {}, credential: { stored: async () => true, fresh: async () => { freshCalls += 1; return { access: TOKEN_A, expires: 0 } } }, debug: line => debug.push(line) })
  const notices: unknown[] = []
  auth.subscribe(notice => notices.push(notice))
  await auth.start()
  const failure = await fake.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' })
  check('OAuth: asynchronous login/completed failure stops injection without pretending native recovery', auth.source === 'unknown' && auth.managedFailed && freshCalls === 1 && failure.error?.code === -32000)
  check('OAuth: degradation never invokes logout or echoes provider error bodies', !fake.requests.some(row => row.method === 'account/logout') && notices.length > 0 && safe([notices, debug, await auth.status()]))
  await hub.close()
}

// Refresh failures (including a provider that ignores abort) settle by 8s.
{
  const clock = manualClock()
  const { hub, fake, debug } = fixture(clock)
  let calls = 0
  let signal: AbortSignal | undefined
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {}, clock, credential: {
    stored: async () => true,
    fresh: (options?: { rejected?: string; signal?: AbortSignal }) => { calls += 1; signal = options?.signal; return calls === 1 ? Promise.resolve({ access: TOKEN_A, expires: 0 }) : new Promise(() => undefined) },
  }, debug: line => debug.push(line) })
  const notices: unknown[] = []
  auth.subscribe(notice => notices.push(notice))
  await auth.start()
  const pending = fake.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' })
  await tick()
  clock.advance(7999)
  await tick()
  check('refresh budget: request waits below eight seconds', fake.responses.size === 0 && signal?.aborted === false)
  clock.advance(1)
  await tick()
  check('refresh budget: eight seconds aborts source and answers -32000', (await pending).error?.code === -32000 && signal?.aborted === true)
  check('refresh budget: failure notice includes login guidance without token material', notices.some(notice => JSON.stringify(notice).includes('/login')) && safe([notices, debug]))
  await hub.close()
}
{
  const { hub, fake, debug } = fixture()
  let calls = 0
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {}, credential: { stored: async () => true, fresh: async () => { calls += 1; if (calls > 1) throw new Error(TOKEN_A); return { access: TOKEN_A, expires: 0 } } }, debug: line => debug.push(line) })
  const notices: unknown[] = []
  auth.subscribe(notice => notices.push(notice))
  await auth.start()
  const failed = await fake.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' })
  check('refresh error: fixed failure text never exposes thrown credential bodies', failed.error?.code === -32000 && safe([failed, notices, debug]))
  await hub.close()
}

const latestQuestion = (events: readonly AgentEvent[]): QuestionRequestView => {
  const event = [...events].reverse().find(event => event.type === 'question.request')
  assert.ok(event?.type === 'question.request', 'a login question exists')
  return event.request
}
// The actual login capability closes every emitted ask; no answer event.
{
  const { hub, fake, debug } = fixture()
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {} })
  const events: AgentEvent[] = []
  const bridge = createCodexAuthCapability(auth, batch => events.push(...batch))
  const flow = bridge.capability.login(async () => true)
  let question = latestQuestion(events)
  check('login: all three methods are offered with a built-in OAuth presenter', question.questions[0]?.options.length === 3)
  bridge.respondQuestion(question.requestId, { answers: [{ selected: [question.questions[0]!.options[2]!.label] }] })
  await tick()
  question = latestQuestion(events)
  check('login API key: question masks input and names Codex credential storage', question.questions[0]?.secret === true && question.questions[0]?.detail?.includes('Codex') === true)
  bridge.respondQuestion(question.requestId, { answers: [{ selected: [], custom: API_KEY }] })
  await flow
  check('login API key: native persistence call receives the key only through RPC', fake.requests.some(row => row.method === 'account/login/start' && row.params.type === 'apiKey' && row.params.apiKey === API_KEY))
  check('login API key: no answer record/event/notice/debug contains the sentinel', safe([events, debug]) && events.filter(event => event.type === 'question.settled').length === 2)
  bridge.dispose()
  await hub.close()
}
{
  const { hub, fake } = fixture()
  fake.on('account/login/start', () => ({ type: 'chatgptDeviceCode', loginId: 'device-id', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' }))
  const auth = createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {} })
  const events: AgentEvent[] = []
  const bridge = createCodexAuthCapability(auth, batch => events.push(...batch))
  const flow = bridge.capability.login()
  const selection = latestQuestion(events)
  bridge.respondQuestion(selection.requestId, { answers: [{ selected: [selection.questions[0]!.options[0]!.label] }] })
  await tick()
  const device = latestQuestion(events)
  check('login device: validation URL and user code reach the shared question view', device.questions[0]?.link === 'https://auth.openai.com/codex/device' && device.questions[0]?.question.includes('ABCD-EFGH') === true)
  fake.notify('account/login/completed', { loginId: 'not-this-login', success: true })
  check('login device: another login notification does not settle this prompt', !events.some(event => event.type === 'question.settled' && event.requestId === device.requestId))
  fake.notify('account/login/completed', { loginId: 'device-id', success: true })
  await flow
  check('login device: success settles its prompt and reports native login', events.some(event => event.type === 'question.settled' && event.requestId === device.requestId) && auth.source === 'codex-login')
  bridge.dispose()
  await hub.close()
}
{
  const { hub, fake } = fixture()
  fake.on('account/login/start', () => ({ type: 'chatgptDeviceCode', loginId: 'cancel-device', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD' }))
  const events: AgentEvent[] = []
  const bridge = createCodexAuthCapability(createCodexAuth({ hub, cwd: SETTINGS.cwd, config: {} }), batch => events.push(...batch))
  const flow = bridge.capability.login()
  const selection = latestQuestion(events)
  bridge.respondQuestion(selection.requestId, { answers: [{ selected: [selection.questions[0]!.options[0]!.label] }] })
  await tick()
  const device = latestQuestion(events)
  bridge.cancelQuestion(device.requestId)
  await flow
  check('login device: cancellation targets only this login id', fake.requests.some(row => row.method === 'account/login/cancel' && row.params.loginId === 'cancel-device'))
  const resumed = bridge.capability.login()
  bridge.withdrawAll()
  await resumed
  check('login: connection-loss withdrawal permits a later login', events.filter(event => event.type === 'question.request').length === 3 && bridge.respondQuestion('not-ours', { answers: [] }) === false)
  bridge.dispose()
  await hub.close()
}

// The public backend runtime actually carries all three platform dependencies.
{
  const fake = createFakeAppServer()
  fake.on('config/read', () => ({ config: { model_provider: 'dshtui-relay' } }))
  let touched = 0
  const tokens = memoryChannelTokens({ [channelTokenRef('codex-relay')]: TOKEN_A })
  const channels = memoryCodexChannels({ active: 'relay', channels: [{ id: 'relay', name: 'Relay', baseUrl: 'https://relay.invalid/v1', tokenRef: channelTokenRef('codex-relay') }] })
  const debug: string[] = []
  const runtime = await prepareCodexRuntime({ kind: 'create', cwd: SETTINGS.cwd }, { cwd: SETTINGS.cwd, debug: line => debug.push(line), warn: () => undefined, tokenStore: tokens, oauthCredential: () => ({ stored: async () => true, fresh: async () => { touched += 1; return { access: TOKEN_B, expires: 0 } } }) }, { channels, env: {}, executable: { path: '/fake/backend-channel', source: 'env', version: '0.160.1' }, hubDeps: { transportFactory: fake.transportFactory } })
  check('backend: active channel wires provider/env/runtime and bypasses OAuth', runtime.auth.source === 'channel' && runtime.channels.active()?.id === 'relay' && runtime.config?.model_provider === 'dshtui-relay' && touched === 0 && Object.values(fake.spawns[0]!.env).includes(TOKEN_A))
  check('backend: startup argv and diagnostics keep token material private', !fake.spawns[0]!.args.some(arg => arg.includes(TOKEN_A)) && safe(debug))
  runtime.release()
  await closeAllCodexHubs()
}
{
  const fake = createFakeAppServer()
  fake.on('thread/read', () => ({ thread: { cwd: '/TMP/recorded-project' } }))
  fake.on('config/read', () => ({ config: { model_provider: 'relay', model_providers: { relay: { base_url: 'https://relay.invalid/v1' } } } }))
  fake.on('account/read', () => ({ account: null, requiresOpenaiAuth: false }))
  let touched = 0
  const runtime = await prepareCodexRuntime({ kind: 'resume', sessionId: 'thread-id' }, { cwd: SETTINGS.cwd, debug: () => undefined, warn: () => undefined, oauthCredential: () => ({ stored: async () => true, fresh: async () => { touched += 1; return { access: TOKEN_A, expires: 0 } } }) }, { channels: memoryCodexChannels(), env: {}, executable: { path: '/fake/backend-resume', source: 'env', version: '0.160.1' }, hubDeps: { transportFactory: fake.transportFactory } })
  check('backend: resume route is checked in the recorded thread cwd', runtime.cwd === '/TMP/recorded-project' && fake.requests.find(row => row.method === 'config/read')?.params.cwd === '/TMP/recorded-project')
  check('backend: native-only route cannot reuse an OAuth-eligible hub', touched === 0 && fake.spawns.length === 2 && runtime.auth.route.firstParty === false)
  runtime.release()
  await closeAllCodexHubs()
}

// A provider env_key the launching shell never exported is resolved from the
// DSH credential store and injected into a fresh child (the keyless hub is
// never reused); an exported key needs no second child at all.
{
  const fake = createFakeAppServer()
  fake.on('config/read', () => ({ config: { model_provider: 'deepseek', model_providers: { deepseek: { base_url: 'https://api.deepseek.com/v1', env_key: 'DEEPSEEK_API_KEY' } } } }))
  fake.on('account/read', () => ({ account: null, requiresOpenaiAuth: false }))
  const debug: string[] = []
  const runtime = await prepareCodexRuntime({ kind: 'create', cwd: SETTINGS.cwd }, { cwd: SETTINGS.cwd, debug: line => debug.push(line), warn: () => undefined, tokenStore: memoryChannelTokens({ DEEPSEEK_API_KEY: API_KEY }) }, { channels: memoryCodexChannels(), env: {}, executable: { path: '/fake/backend-envkey', source: 'env', version: '0.160.1' }, hubDeps: { transportFactory: fake.transportFactory } })
  check('backend: missing provider env_key is injected from the credential store', fake.spawns.length === 2 && fake.spawns[0]!.env.DEEPSEEK_API_KEY === undefined && fake.spawns[1]!.env.DEEPSEEK_API_KEY === API_KEY)
  check('backend: env_key injection names the variable without leaking its value', debug.some(line => line.includes('DEEPSEEK_API_KEY')) && safe(debug))
  runtime.release()
  await closeAllCodexHubs()
  const exported = await prepareCodexRuntime({ kind: 'create', cwd: SETTINGS.cwd }, { cwd: SETTINGS.cwd, debug: () => undefined, warn: () => undefined, tokenStore: memoryChannelTokens({ DEEPSEEK_API_KEY: API_KEY }) }, { channels: memoryCodexChannels(), env: { DEEPSEEK_API_KEY: API_KEY }, executable: { path: '/fake/backend-envkey', source: 'env', version: '0.160.1' }, hubDeps: { transportFactory: fake.transportFactory } })
  check('backend: an exported provider env_key reuses the first child', fake.spawns.length === 3 && fake.spawns[2]!.env.DEEPSEEK_API_KEY === API_KEY)
  exported.release()
  await closeAllCodexHubs()
  // Nothing can supply the key here, and Codex will reject the turn itself:
  // the session still opens, carrying the reason as a start notice.
  const keyless = await prepareCodexRuntime({ kind: 'create', cwd: SETTINGS.cwd }, { cwd: SETTINGS.cwd, debug: () => undefined, warn: () => undefined, tokenStore: memoryChannelTokens() }, { channels: memoryCodexChannels(), env: {}, executable: { path: '/fake/backend-envkey', source: 'env', version: '0.160.1' }, hubDeps: { transportFactory: fake.transportFactory } })
  check('backend: an unsupplied provider env_key opens with the reason instead of a bare turn failure', fake.spawns.length === 4 && fake.spawns[3]!.env.DEEPSEEK_API_KEY === undefined && (keyless.startNotices ?? []).some(line => line.includes('DEEPSEEK_API_KEY') && line.includes('deepseek')) && safe(keyless.startNotices))
  keyless.release()
  await closeAllCodexHubs()
}

// A `DSH_HOME` override must not orphan a key stored where both READMEs name
// it: reads fall back to the default `~/.dsh` store while writes stay in the
// active home.
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-creds-default-'))
  const active = mkdtempSync(join(tmpdir(), 'dsh-creds-active-'))
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(join(home, '.dsh', '.credentials.yaml'), `refs:\n  DEEPSEEK_API_KEY: ${API_KEY}\n`)
  const previousHome = process.env.HOME
  const previousDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = active
  try {
    const store = fileChannelTokens()
    check('store: the default ~/.dsh store backs an active home that lacks the ref', store.read('DEEPSEEK_API_KEY') === API_KEY && store.declared('DEEPSEEK_API_KEY') && store.read('ABSENT_REF') === undefined)
    store.write('CHANNEL_PROBE_TOKEN', API_KEY)
    check('store: a write still targets the active home', readFileSync(join(active, '.credentials.yaml'), 'utf8').includes('CHANNEL_PROBE_TOKEN') && !readFileSync(join(home, '.dsh', '.credentials.yaml'), 'utf8').includes('CHANNEL_PROBE_TOKEN'))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    rmSync(home, { recursive: true, force: true })
    rmSync(active, { recursive: true, force: true })
  }
}

{
  const fake = createFakeAppServer()
  fake.on('config/read', () => ({ config: {} }))
  fake.on('account/read', () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }))
  fake.on('account/login/start', params => {
    fake.notify('account/login/completed', { loginId: null, success: params.accessToken === TOKEN_C, error: params.accessToken === TOKEN_C ? null : params.accessToken })
    return { type: params.type }
  })
  let current = TOKEN_A
  let reads = 0
  const runtime = await prepareCodexRuntime({ kind: 'create', cwd: SETTINGS.cwd }, {
    cwd: SETTINGS.cwd, debug: () => undefined, warn: () => undefined,
    oauthCredential: () => ({ stored: async () => true, fresh: async () => { reads += 1; return { access: current, expires: 0 } } }),
  }, { channels: memoryCodexChannels(), env: {}, executable: { path: '/fake/backend-managed-failure', source: 'env', version: '0.160.1' }, hubDeps: { transportFactory: fake.transportFactory } })
  check('backend: observed managed startup failure acquires a different clean hub', fake.spawns.length === 2 && runtime.auth.source === 'api-key' && !runtime.auth.managedFailed && reads === 1)
  check('backend: fallback reports the failed managed login without logout or automatic retry', runtime.startNotices?.length === 1 && !fake.requests.some(request => request.method === 'account/logout') && fake.requests.filter(request => request.method === 'account/login/start').length === 1)
  current = TOKEN_C
  await runtime.auth.reconnect()
  check('backend: explicit login on a first-party fallback can install a newly rotated token', runtime.auth.source === 'dsh-auth' && reads === 2 && fake.requests.filter(request => request.method === 'account/login/start').at(-1)?.params.accessToken === TOKEN_C)
  runtime.release()
  await closeAllCodexHubs()
}

console.log('\nverify-codex-auth OK (' + passed + ' checks)')
