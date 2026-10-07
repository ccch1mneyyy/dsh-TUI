/** Real 0.160.1 daemon writer handoff in isolated homes on Unix.
 * Seeds a synthetic transcript; no login, turn/start or provider charge.
 * Run: CODEX_EXECUTABLE=<0.160.1> node --import tsx/esm scripts/verify-codex-daemon-offline.ts */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveCodexHome, assertCheapRequest, LIVE_MODELS } from './lib/codex-cheap-only.mjs'
import { settled } from './lib/term-test.mjs'

assert.notEqual(process.platform, 'win32', 'this offline regression requires Unix sockets')
const sandbox = liveCodexHome({ provider: false })
process.env.HOME = sandbox.home
process.env.USERPROFILE = sandbox.home
process.env.CODEX_HOME = sandbox.home
process.env.CODEX_SQLITE_HOME = sandbox.home
process.env.DSH_TUI_LANG = 'en'
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']) delete process.env[key]
const { buildCodexEnv, resolveCodexExecutable } = await import('../src/backends/codex/rpc/binary.js')
const { createCodexHub, closeAllCodexHubs } = await import('../src/backends/codex/rpc/hub.js')
const { spawnTransport } = await import('../src/backends/codex/rpc/transport.js')
const { openCodexBackendSession } = await import('../src/backends/codex/backend.js')
const { memoryCodexPrefs } = await import('../src/backends/codex/prefs.js')
const { memoryCodexChannels } = await import('../src/backends/codex/channels.js')
const { CLIENT } = await import('../src/backends/codex/protocol/index.js')
const env = buildCodexEnv()
const executable = await resolveCodexExecutable(env)
assert.equal(executable?.version, '0.160.1', 'offline daemon regression uses the pinned executable')
assert.ok(executable)
const id = randomUUID()
const turn = randomUUID()
const timestamp = new Date().toISOString()
const rows = [
  { type: 'session_meta', payload: { id, session_id: id, timestamp, cwd: sandbox.cwd, originator: 'dsh-tui-offline-daemon', cli_version: '0.160.1', source: 'cli', model_provider: 'openai', history_mode: 'legacy', base_instructions: { text: 'Offline fixture; no model call.' } } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 128000 } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'offline saved question', images: [], local_images: [], text_elements: [] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'offline saved question' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'offline saved answer' }], phase: 'final_answer' } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'offline saved answer', phase: 'final_answer' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'offline saved answer' } },
]
const folder = join(sandbox.home, 'sessions', ...timestamp.slice(0, 10).split('-'))
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, 'rollout-' + timestamp.slice(0, 19).replaceAll(':', '-') + '-' + id + '.jsonl'), rows.map(row => JSON.stringify({ timestamp, ...row })).join('\n') + '\n', { mode: 0o600 })
const socket = join(sandbox.home, 'test-control.sock')
const server = spawn(executable.path, ['app-server', '--listen', 'unix://' + socket], { env, cwd: sandbox.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.resume()
server.stderr.resume()
let writerConflict = false
let proxies = 0
const factory: import('../src/backends/codex/rpc/transport.js').TransportFactory = options => {
  if (options.args[1] === 'proxy') proxies += 1
  const transport = spawnTransport({
    ...options,
    args: options.args[1] === 'proxy' ? [...options.args, '--sock', socket] : options.args,
    onLine: line => {
      if (/already has an active writer/u.test(line)) writerConflict = true
      options.onLine(line)
    },
  })
  return {
    ...transport,
    write: line => {
      const message = JSON.parse(line)
      assertCheapRequest('verify-codex-daemon-offline', message.method, message.params)
      assert.notEqual(message.method, CLIENT.turnStart, 'offline regression never starts a model turn')
      transport.write(line)
    },
  }
}
let owner: ReturnType<typeof createCodexHub> | undefined
let session: Awaited<ReturnType<typeof openCodexBackendSession>> | undefined
let checks = 0
const check = (label: string, ok: boolean): void => { assert.ok(ok, label); checks += 1; console.log('PASS ' + label) }
try {
  check('isolated background server listens on its own socket', await settled(() => existsSync(socket), { timeoutMs: 5000 }))
  owner = createCodexHub({ executable: executable.path, args: ['app-server', 'proxy'], env, cwd: sandbox.cwd }, { transportFactory: factory, handshakeTimeoutMs: 5000 })
  await owner.ready
  check('production stdio proxy initializes in the isolated home', owner.info?.codexHome === sandbox.home)
  await owner.call(CLIENT.threadResume, { threadId: id, excludeTurns: true, initialTurnsPage: { limit: 20, sortDirection: 'desc', itemsView: 'full' }, model: LIVE_MODELS[0], config: { model_reasoning_effort: 'low' } })
  await owner.call(CLIENT.threadUnsubscribe, { threadId: id })
  await owner.close()
  check('closing the frontend leaves the background server alive', server.exitCode === null && server.signalCode === null)
  session = await openCodexBackendSession({ kind: 'resume', sessionId: id }, { cwd: sandbox.cwd, debug: () => undefined, warn: () => undefined }, { env, executable, channels: memoryCodexChannels(), prefs: memoryCodexPrefs({ model: LIVE_MODELS[0], effort: 'low' }), hubDeps: { transportFactory: factory } })
  const history = await session.history()
  check('private writer conflict triggers an automatic native daemon handoff', writerConflict && proxies === 2 && session.ref.sessionId === id && session.status === 'idle')
  check('handoff preserves the saved user message', history.some(event => event.type === 'user.message' && event.text === 'offline saved question'))
  check('handoff preserves the saved assistant message', history.some(event => event.type === 'assistant.message' && event.blocks.some(block => block.type === 'text' && block.text === 'offline saved answer')))
  check('handoff preserves the recorded working directory', session.cwd === sandbox.cwd)
  await session.dispose()
  session = undefined
  await closeAllCodexHubs()
  check('disposing dsh-TUI closes its proxies and leaves the daemon alive', server.exitCode === null && server.signalCode === null)
  console.log(`verify-codex-daemon-offline OK (${checks} checks; no model turns)`)
} finally {
  await session?.dispose()
  await owner?.close()
  await closeAllCodexHubs()
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit')
    server.kill('SIGTERM')
    await exited
  }
  sandbox.cleanup()
}
