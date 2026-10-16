/** Real pinned app-server, isolated homes, no turn/start and no provider charge.
 * Run: CODEX_EXECUTABLE=<0.160.1> node --import tsx/esm scripts/verify-codex-offline.ts */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolated = mkdtempSync(join(tmpdir(), 'codex-offline-ui-'))
process.env.HOME = isolated
process.env.USERPROFILE = isolated
process.env.DSH_HOME = join(isolated, '.dsh')
process.env.DSH_TUI_LANG = 'en'
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']) delete process.env[key]
const { liveCodexHome, assertCheapRequest } = await import('./lib/codex-cheap-only.mjs')
const sandbox = liveCodexHome({ provider: false })
process.env.CODEX_HOME = sandbox.home
process.env.CODEX_SQLITE_HOME = sandbox.home
const { prepareCodexRuntime, codexBackend, openCodexBackendSession } = await import('../src/backends/codex/backend.js')
const { openCodexSession } = await import('../src/backends/codex/session/session.js')
const { closeAllCodexHubs } = await import('../src/backends/codex/rpc/hub.js')
const { memoryCodexPrefs } = await import('../src/backends/codex/prefs.js')
const { getLang } = await import('../src/i18n.js')
const { CLIENT } = await import('../src/backends/codex/protocol/index.js')
const { rec, str } = await import('../src/backends/codex/narrow.js')
let checks = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); checks += 1; console.log('PASS ' + label) }
let session: Awaited<ReturnType<typeof openCodexSession>> | undefined
let release: (() => void) | undefined
let catalogSession: Awaited<ReturnType<typeof openCodexBackendSession>> | undefined
let rewindSource: Awaited<ReturnType<typeof openCodexSession>> | undefined
let rewindTarget: Awaited<ReturnType<typeof openCodexSession>> | undefined
let alternate: ReturnType<typeof liveCodexHome> | undefined
try {
  const runtime = await prepareCodexRuntime({ kind: 'create', cwd: sandbox.cwd }, { cwd: sandbox.cwd, debug: () => undefined, warn: () => undefined, locale: () => 'en' })
  release = runtime.release
  check('real pinned executable version', runtime.executable.version === '0.160.1')
  check('handshake isolates the Codex home', runtime.hub.info?.codexHome === sandbox.home)
  const call = runtime.hub.call.bind(runtime.hub)
  runtime.hub.call = async (method, params, options) => {
    assertCheapRequest('verify-codex-offline', method, params)
    assert.notEqual(method, CLIENT.turnStart, 'offline smoke never starts a model turn')
    return call(method, params, options)
  }
  session = await openCodexSession({ ...runtime, target: { kind: 'create', cwd: sandbox.cwd }, prefs: memoryCodexPrefs(), host: { debug: () => undefined, locale: getLang } })
  release = undefined
  check('real native thread created', session.ref.sessionId !== '' && session.ref.backendId === 'codex')
  const id = session.ref.sessionId
  check('model catalog available without login', (await session.capabilities.models!.list()).length > 0)
  check('raw context is honest before a model turn', (await session.capabilities.context!.usage('full')).used === 0)
  await session.capabilities.modes!.set('read-only')
  await session.capabilities.modes!.set('plan')
  check('Plan keeps read-only permissions in its cycle', session.capabilities.modes!.current() === 'plan' && session.capabilities.modes!.cycle!()[0]?.id === 'read-only')
  await session.capabilities.rename!.rename('offline smoke')
  const read = rec(await runtime.hub.call(CLIENT.threadRead, { threadId: id, includeTurns: false }))
  check('real native rename persists', str(rec(read?.thread)?.name) === 'offline smoke')
  const host = { cwd: sandbox.cwd, debug: () => undefined, warn: () => undefined, locale: () => 'en' as const }
  catalogSession = await openCodexBackendSession({ kind: 'create', cwd: sandbox.cwd }, host)
  const methods: string[] = []
  const listedCall = runtime.hub.call.bind(runtime.hub)
  runtime.hub.call = async (method, params, options) => {
    methods.push(method)
    return listedCall(method, params, options)
  }
  const catalog = codexBackend.catalog!
  await catalog.list({ cwd: sandbox.cwd }, () => {})
  assert.ok(methods.length > 0 && methods.every(method => method === CLIENT.threadList), JSON.stringify({ label: 'catalog hub reuse', methods }))
  check('real catalog reuses the active session hub without config/auth preparation', true)
  methods.length = 0
  await catalog.list({ allProjects: true }, () => {})
  check('real global catalog borrows the same hub without restarting auth', methods.length > 0 && methods.every(method => method === CLIENT.threadList))
  alternate = liveCodexHome({ provider: false })
  process.env.CODEX_HOME = alternate.home
  process.env.CODEX_SQLITE_HOME = alternate.home
  check('changing the native home cannot reuse another store catalog', (await catalog.list({ allProjects: true }, () => {})).length === 0)
  process.env.CODEX_HOME = sandbox.home
  process.env.CODEX_SQLITE_HOME = sandbox.home
  await catalogSession.dispose()
  catalogSession = undefined
  const fork = rec(await runtime.hub.call(CLIENT.threadFork, { threadId: id, ephemeral: true, excludeTurns: true }))
  const forkId = str(rec(fork?.thread)?.id)
  check('real ephemeral fork is not durable', forkId !== undefined && rec(fork?.thread)?.ephemeral === true && rec(fork?.thread)?.path === null)
  if (forkId !== undefined) await runtime.hub.call(CLIENT.threadUnsubscribe, { threadId: forkId })
  // Seed a durable native turn without making a model request. An empty
  // thread/start cannot be resumed after unsubscribe until it is persisted.
  const sourceId = randomUUID()
  const turnId = randomUUID()
  const timestamp = new Date().toISOString()
  const folder = join(sandbox.home, 'sessions', ...timestamp.slice(0, 10).split('-'))
  mkdirSync(folder, { recursive: true })
  const rows = [
    { type: 'session_meta', payload: { id: sourceId, session_id: sourceId, timestamp, cwd: sandbox.cwd, originator: 'dsh-tui-offline-rewind', cli_version: '0.160.1', source: 'cli', model_provider: 'openai', history_mode: 'legacy', base_instructions: { text: 'Offline fixture; no model call.' } } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 128000 } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first saved question', images: [], local_images: [], text_elements: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first saved question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'saved answer' }], phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'saved answer', phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'saved answer' } },
  ]
  writeFileSync(join(folder, 'rollout-' + timestamp.slice(0, 19).replaceAll(':', '-') + '-' + sourceId + '.jsonl'), rows.map(row => JSON.stringify({ timestamp, ...row })).join('\n') + '\n', { mode: 0o600 })
  const openSaved = (sessionId: string) => openCodexSession({ ...runtime, release: runtime.hub.retain(), target: { kind: 'resume', sessionId }, prefs: memoryCodexPrefs(), host: { debug: () => undefined, locale: getLang } })
  rewindSource = await openSaved(sourceId)
  const seed = await rewindSource.history()
  const first = seed.find(event => event.type === 'user.message')
  assert.ok(first?.type === 'user.message' && first.anchor !== undefined)
  const outcome = await rewindSource.capabilities.rewind!.rewind(first.anchor, 'conversation')
  assert.equal(outcome.kind, 'rewound')
  assert.ok(outcome.kind === 'rewound' && outcome.session.sessionId !== sourceId)
  rewindTarget = await openSaved(outcome.session.sessionId)
  check('real first-message rewind reopens an empty fork with the same cwd', (await rewindTarget.history()).length === 0 && rewindTarget.cwd === sandbox.cwd)
  await rewindSource.dispose()
  rewindSource = await openSaved(sourceId)
  check('real first-message rewind preserves the original transcript', (await rewindSource.history()).some(event => event.type === 'user.message' && event.text === 'first saved question'))
  await session.dispose()
  session = undefined
  const resumed = rec(await runtime.hub.call(CLIENT.threadResume, { threadId: id, excludeTurns: true, initialTurnsPage: { limit: 20, sortDirection: 'desc', itemsView: 'full' } }))
  check('real thread can resume with full paginated history', str(rec(resumed?.thread)?.id) === id && rec(resumed?.initialTurnsPage) !== undefined)
  await runtime.hub.call(CLIENT.threadUnsubscribe, { threadId: id })
  await runtime.hub.call(CLIENT.threadArchive, { threadId: id })
  console.log(`verify-codex-offline OK (${checks} checks; no model turns)`)
} finally {
  await session?.dispose()
  await catalogSession?.dispose()
  await rewindTarget?.dispose()
  await rewindSource?.dispose()
  release?.()
  await closeAllCodexHubs()
  alternate?.cleanup()
  sandbox.cleanup()
  rmSync(isolated, { recursive: true, force: true })
}
