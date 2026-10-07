/** Native daemon resume: real backend/session/hub, scripted app servers.
 * Covers idle-writer handoff, history, working directories, credential
 * isolation, unavailable proxies, rejected resumes and retain cleanup.
 * Run: node --import tsx/esm scripts/verify-codex-daemon-resume.ts */
import './lib/default-lang-zh.mjs'
import assert from 'node:assert/strict'
import { openCodexBackendSession } from '../src/backends/codex/backend.js'
import { memoryCodexChannels } from '../src/backends/codex/channels.js'
import { memoryCodexPrefs } from '../src/backends/codex/prefs.js'
import { closeAllCodexHubs } from '../src/backends/codex/rpc/hub.js'
import { channelTokenRef, memoryChannelTokens } from '../src/backends/shared/channel-tokens.js'
import { createFakeAppServer, FakeRpcError } from './lib/codex-fake-app-server.js'
import { manualClock } from './lib/codex-session-harness.js'

const CWD = '/TMP/project'
const THREAD = 'retained-thread'
const API_KEY = 'private-api-key-sentinel'
const TOKEN = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url') + '.private-token-sentinel'
let passed = 0
const check = (label: string, ok: boolean): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const cases: readonly {
  readonly label: string
  readonly status?: string
  readonly loaded?: boolean
  readonly firstParty?: boolean
  readonly managed?: boolean
  readonly channel?: boolean
  readonly unavailable?: boolean
  readonly writerConflict?: boolean
  readonly preserveCwd?: boolean
  readonly resumeFailure?: boolean
  readonly opens?: boolean
}[] = [
  { label: 'idle native daemon', status: 'idle', opens: true },
  { label: 'native first-party credentials without stored OAuth', status: 'idle', firstParty: true, opens: true },
  { label: 'recorded cwd after private metadata lookup fails', status: 'idle', preserveCwd: true, opens: true },
  { label: 'daemon with a different thread', loaded: false },
  { label: 'daemon with a running turn', status: 'active' },
  { label: 'daemon with an approval pending', status: 'active' },
  { label: 'daemon with unknown thread status' },
  { label: 'unsupported or unavailable proxy', unavailable: true },
  { label: 'managed subscription credentials', status: 'idle', firstParty: true, managed: true },
  { label: 'explicit channel connection', status: 'idle', channel: true },
  { label: 'non-writer resume failure', status: 'idle', writerConflict: false },
  { label: 'daemon rejects resume after its idle probe', status: 'idle', resumeFailure: true },
]
for (const test of cases) {
  const privateServer = createFakeAppServer()
  const daemon = createFakeAppServer()
  const clock = manualClock()
  const cwd = test.preserveCwd ? '/TMP/recorded-project' : CWD
  const config = test.firstParty ? {} : { model_provider: 'relay' }
  const message = test.writerConflict === false ? 'no rollout found for thread id ' + THREAD : 'thread ' + THREAD + ' already has an active writer'
  privateServer.on('config/read', () => ({ config }))
  privateServer.on('account/read', () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }))
  privateServer.on('account/login/start', params => ({ type: params.type }))
  privateServer.on('thread/read', () => { throw new FakeRpcError(-32600, 'metadata unavailable') })
  privateServer.on('thread/resume', () => { throw new FakeRpcError(-32600, message) })
  const thread = { id: THREAD, cwd, status: test.status === undefined ? {} : { type: test.status, ...(test.label.includes('approval') ? { activeFlags: ['waitingOnApproval'] } : {}) } }
  daemon.on('thread/loaded/list', () => ({ data: test.loaded === false ? ['other-thread'] : [THREAD], nextCursor: null }))
  daemon.on('thread/read', () => ({ thread }))
  daemon.on('config/read', () => ({ config }))
  daemon.on('account/read', () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }))
  daemon.on('thread/resume', () => {
    if (test.resumeFailure) throw new FakeRpcError(-32600, 'retained thread disappeared')
    return {
      thread, cwd, model: 'gpt-fixture', modelProvider: 'relay', reasoningEffort: 'low',
      approvalPolicy: 'on-request', sandbox: { type: 'readOnly' },
      initialTurnsPage: { data: [{ id: 'saved-turn', status: 'completed', items: [
        { type: 'userMessage', id: 'saved-user', content: [{ type: 'text', text: 'persisted question' }] },
        { type: 'agentMessage', id: 'saved-answer', text: 'persisted answer', phase: 'final_answer' },
      ] }], nextCursor: null },
    }
  })
  daemon.on('thread/unsubscribe', () => ({ status: 'unsubscribed' }))
  daemon.on('model/list', () => ({ data: [], nextCursor: null }))
  daemon.on('collaborationMode/list', () => ({ data: [] }))
  daemon.on('thread/backgroundTerminals/list', () => ({ data: [], nextCursor: null }))
  daemon.on('thread/goal/get', () => ({ goal: null }))
  if (test.unavailable) daemon.on('initialize', () => { throw new FakeRpcError(-32601, 'proxy unavailable') })
  let credentialReads = 0
  const channels = test.channel ? memoryCodexChannels({ active: 'relay', channels: [{ id: 'relay', name: 'Relay', baseUrl: 'https://relay.invalid/v1', tokenRef: channelTokenRef('codex-relay') }] }) : memoryCodexChannels()
  const debug: string[] = []
  let session: Awaited<ReturnType<typeof openCodexBackendSession>> | undefined
  let error: unknown
  try {
    session = await openCodexBackendSession({ kind: 'resume', sessionId: THREAD, ...(test.preserveCwd ? {} : { cwd }) }, {
      cwd: '/TMP/launcher', debug: line => debug.push(line), warn: () => undefined,
      tokenStore: memoryChannelTokens({ [channelTokenRef('codex-relay')]: API_KEY }),
      ...(test.firstParty ? { oauthCredential: () => ({ stored: async () => test.managed === true, fresh: async () => { credentialReads += 1; return test.managed ? { access: TOKEN, expires: 0 } : undefined } }) } : {}),
    }, {
      executable: { path: '/fake/daemon-' + test.label, source: 'env', version: '0.160.1' },
      env: {}, channels, prefs: memoryCodexPrefs(),
      hubDeps: { clock, transportFactory: options => options.args[1] === 'proxy' ? daemon.transportFactory(options) : privateServer.transportFactory(options) },
    })
  } catch (caught) { error = caught }
  try {
    const expectedError = test.resumeFailure ? 'retained thread disappeared' : message
    check(test.label + ': outcome', test.opens ? session?.ref.sessionId === THREAD && error === undefined : error instanceof Error && error.cause instanceof Error && error.cause.message === expectedError)
    const blocked = test.managed || test.channel || test.writerConflict === false
    check(test.label + ': eligible native conflict only', daemon.spawns.length === (blocked ? 0 : 1) && daemon.requests.filter(row => row.method === 'thread/resume').length === (test.opens || test.resumeFailure ? 1 : 0))
    check(test.label + ': no shared credential injection or replacement thread', !daemon.requests.some(row => row.method === 'account/login/start') && ![...privateServer.requests, ...daemon.requests].some(row => row.method === 'thread/start') && ![TOKEN, API_KEY].some(secret => JSON.stringify(debug).includes(secret)))
    if (session !== undefined) {
      const history = await session.history()
      check(test.label + ': durable history survives handoff', history.some(event => event.type === 'user.message' && event.text === 'persisted question') && history.some(event => event.type === 'assistant.message' && event.blocks.some(block => block.type === 'text' && block.text === 'persisted answer')))
      check(test.label + ': configuration uses the resumed directory', session.cwd === cwd && daemon.requests.find(row => row.method === 'config/read')?.params.cwd === cwd)
      await session.dispose()
      session = undefined
    }
    if (test.firstParty) check(test.label + ': proxy does not read host credentials', credentialReads === 1)
    clock.advance(30_000)
    check(test.label + ': both retains are released', privateServer.closed && (blocked || daemon.closed))
  } finally {
    await session?.dispose()
    await closeAllCodexHubs()
  }
}

console.log('\nverify-codex-daemon-resume OK (' + passed + ' checks)')
