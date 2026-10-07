/** Real pinned app-server, isolated homes, no turn/start and no provider charge.
 * Run: CODEX_EXECUTABLE=<0.160.1> node --import tsx/esm scripts/verify-codex-offline.ts */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
const { prepareCodexRuntime } = await import('../src/backends/codex/backend.js')
const { openCodexSession } = await import('../src/backends/codex/session/session.js')
const { closeAllCodexHubs } = await import('../src/backends/codex/rpc/hub.js')
const { memoryCodexPrefs } = await import('../src/backends/codex/prefs.js')
const { CLIENT } = await import('../src/backends/codex/protocol/index.js')
const { rec, str } = await import('../src/backends/codex/narrow.js')
let checks = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); checks += 1; console.log('PASS ' + label) }
let session: Awaited<ReturnType<typeof openCodexSession>> | undefined
let release: (() => void) | undefined
try {
  const runtime = await prepareCodexRuntime({ kind: 'create', cwd: sandbox.cwd }, { cwd: sandbox.cwd, debug: () => undefined, warn: () => undefined })
  release = runtime.release
  check('real pinned executable version', runtime.executable.version === '0.160.1')
  check('handshake isolates the Codex home', runtime.hub.info?.codexHome === sandbox.home)
  const call = runtime.hub.call.bind(runtime.hub)
  runtime.hub.call = async (method, params, options) => {
    assertCheapRequest('verify-codex-offline', method, params)
    assert.notEqual(method, CLIENT.turnStart, 'offline smoke never starts a model turn')
    return call(method, params, options)
  }
  session = await openCodexSession({ ...runtime, target: { kind: 'create', cwd: sandbox.cwd }, prefs: memoryCodexPrefs(), host: { debug: () => undefined } })
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
  const fork = rec(await runtime.hub.call(CLIENT.threadFork, { threadId: id, ephemeral: true, excludeTurns: true }))
  const forkId = str(rec(fork?.thread)?.id)
  check('real ephemeral fork is not durable', forkId !== undefined && rec(fork?.thread)?.ephemeral === true && rec(fork?.thread)?.path === null)
  if (forkId !== undefined) await runtime.hub.call(CLIENT.threadUnsubscribe, { threadId: forkId })
  await session.dispose()
  session = undefined
  const resumed = rec(await runtime.hub.call(CLIENT.threadResume, { threadId: id, excludeTurns: true, initialTurnsPage: { limit: 20, sortDirection: 'desc', itemsView: 'full' } }))
  check('real thread can resume with full paginated history', str(rec(resumed?.thread)?.id) === id && rec(resumed?.initialTurnsPage) !== undefined)
  await runtime.hub.call(CLIENT.threadUnsubscribe, { threadId: id })
  await runtime.hub.call(CLIENT.threadArchive, { threadId: id })
  console.log(`verify-codex-offline OK (${checks} checks; no model turns)`)
} finally {
  await session?.dispose()
  release?.()
  await closeAllCodexHubs()
  sandbox.cleanup()
  rmSync(isolated, { recursive: true, force: true })
}
