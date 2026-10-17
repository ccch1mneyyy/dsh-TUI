import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../args.mjs'
import { manage } from '../adapters/dsh/management-plugin.mjs'
import { records } from '../process.mjs'
import { Readable, Writable } from 'node:stream'
import { execute } from '../engine.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const launcher = join(root, 'bin', 'dsh-tui.js')
const sandbox = await mkdtemp(join(tmpdir(), 'dst-cli-suite-'))
const fixture = join(sandbox, 'dsh', 'bin.mjs')
await mkdir(join(sandbox, 'dsh'))
await copyFile(fileURLToPath(new URL('./fixtures/dsh.mjs', import.meta.url)), fixture)
await writeFile(join(sandbox, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: { dsh: './bin.mjs' }, type: 'module' }))
after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 3 }))

async function run(args, input = '', env = {}) {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: root, env: { ...process.env, DSH_TUI_CLI_DSH_BIN: fixture, DSH_HOME: join(sandbox, 'home'), HOME: sandbox, USERPROFILE: sandbox, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)) })
  return { exit, stdout, stderr }
}

function context(services) { return { get: key => services[key] } }

test('grammar keeps literal words and rejects accidental unused/run options', () => {
  assert.equal(parse(['-p', '--', '--model', 'literal']).prompt, '--model literal')
  assert.equal(parse(['run', '--cwd=.', '--timeout', '1']).timeout, 1)
  for (const args of [['run', '--bogus'], ['run', '--timeout=-1'], ['run', '--session-id'], ['run', '--continue', '--session-id=x'], ['models', 'list', '--model=x'], ['skills', '--provider=x'], ['run', '--model=x']]) assert.throws(() => parse(args), args.join(' '))
  assert.deepEqual(parse(['dsh', '--profile', 'future', '--brand-new=x']).args, ['--profile', 'future', '--brand-new=x'])
})

test('help works without a DSH installation/profile and imports no renderer', async () => {
  const result = await run(['cli', '--help'], '', { DSH_TUI_CLI_DSH_BIN: '' })
  assert.equal(result.exit, 0)
  assert.match(result.stdout, /schemaVersion: 1/u)
  assert.equal(result.stderr, '')
})

test('process round trip merges prompt/stdin literally, handles Unicode chunks', async () => {
  const result = await run(['-p', '任务 & %PATH% "测试"', '--json'], '🐋管道\r\n', { FAKE_DSH_MODE: 'split' })
  assert.equal(result.exit, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).text, '任务 & %PATH% "测试"\n\n🐋管道\r\n')
  assert.equal(result.stderr, '')
})

test('prompt never appears in DSH process argv; model overlay is structured', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dst-test-'))
  try {
    const path = join(temporary, 'args.json')
    const result = await run(['run', 'private-task', '--provider=p', '--model=m', '--json'], '', { FAKE_DSH_ARGS: path })
    assert.equal(result.exit, 0, result.stderr)
    const args = JSON.parse(await readFile(path, 'utf8'))
    assert(!args.includes('private-task'))
    assert.equal(args.at(-1), '-')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('stream output is versioned and ends with a verified result', async () => {
  const result = await run(['run', 'ok', '--output-format=stream-json'])
  assert.equal(result.exit, 0)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert(events.every(event => event.schemaVersion === 1))
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).ok, true)
})

for (const [mode, code] of [['invalid', 4], ['partial', 4], ['missing', 4], ['after-final', 4], ['outcome-error', 4], ['nonzero', 1], ['error', 1]]) {
  test(`backend ${mode} never publishes success or retries`, async () => {
    const result = await run(['run', 'ok', '--json'], '', { FAKE_DSH_MODE: mode })
    assert.equal(result.exit, code, result.stdout + result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert(!result.stdout.includes('secret-should-not-be-reflected'))
  })
}

test('deadline kills/reaps a hanging process and reports 124', async () => {
  const result = await run(['run', 'ok', '--json', '--timeout=600'], '', { FAKE_DSH_MODE: 'hang' })
  assert.equal(result.exit, 124, result.stderr + result.stdout)
  assert.equal(JSON.parse(result.stdout).error.code, 'TIMEOUT')
})

test('management commands and continue use the separate DSH plugin protocol', async () => {
  const list = await run(['session', 'list', '--json'])
  assert.equal(list.exit, 0)
  assert.equal(JSON.parse(list.stdout).data[0].sessionId, 'existing')
  const resumed = await run(['run', '--continue', 'again', '--json'])
  assert.equal(resumed.exit, 0, resumed.stderr + resumed.stdout)
  assert.equal(JSON.parse(resumed.stdout).text, 'again')
})

test('native passthrough retains argv/exit code and never bootstraps TUI', async () => {
  const result = await run(['dsh', 'echo', 'spaces and 中文', '--new-flag=%x%'], '', { FAKE_EXIT: '7' })
  assert.equal(result.exit, 7)
  assert.deepEqual(JSON.parse(result.stdout), ['spaces and 中文', '--new-flag=%x%'])
})

test('session list/read/export delegate to public services', async () => {
  const snapshot = { session: { id: 's', cwd: 'here', createdAt: 1 }, events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } }] }
  const ctx = context({ sessionQuery: {
    listSessions: async () => [{ header: snapshot.session, persisted: true, live: false }],
    readSession: async () => snapshot, readSurface: async () => snapshot,
  } })
  assert.equal((await manage(ctx, { kind: 'session', action: 'list', cwd: 'here' }))[0].sessionId, 's')
  assert.equal(await manage(ctx, { kind: 'session', action: 'show', sessionId: 's' }), snapshot)
  assert.match(await manage(ctx, { kind: 'session', action: 'export', sessionId: 's' }), /answer/u)
  assert.equal((await manage(ctx, { kind: 'session', action: 'continue', cwd: 'here' })).sessionId, 's')
  snapshot.session.agentPreset = 'standard'
  await assert.rejects(manage(ctx, { kind: 'session', action: 'continue', cwd: 'here' }), /No compatible/u)
})

test('read commands whitelist credential output and label MCP observation honestly', async () => {
  const ctx = context({
    credentials: { describe: async () => ({ configured: true, writable: false, source: 'env', value: 'DO_NOT_EMIT' }) },
    tools: { schemas: () => [{ name: 'mcp__server__read' }, { name: 'bash' }] },
    llm: { listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm', name: 'Model', private: 'secret' }] },
    skills: { list: async () => [{ name: 'skill', description: 'd', provider: 'filesystem' }] },
  })
  const auth = await manage(ctx, { kind: 'auth' })
  assert(!JSON.stringify(auth).includes('DO_NOT_EMIT'))
  assert.equal((await manage(ctx, { kind: 'mcp' })).connectionHealth, 'unavailable')
  assert.deepEqual(await manage(ctx, { kind: 'models' }), [{ provider: 'p', models: [{ id: 'm', name: 'Model' }] }])
  assert.equal((await manage(ctx, { kind: 'skills' }))[0].name, 'skill')
  await assert.rejects(manage(context({}), { kind: 'mcp' }), /Missing service/u)
})

test('replacement adapter runs once and preserves the same result contract', async () => {
  let calls = 0, text = ''
  const adapter = { async *execute() {
    calls++
    yield { type: 'session', sessionId: 's' }
    yield { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }
    yield { type: 'final', ok: true, text: 'answer' }
  } }
  const io = { stdin: Readable.from([]), stdout: new Writable({ write(chunk, encoding, callback) { text += chunk; callback() } }) }
  assert.equal(await execute(parse(['run', 'q', '--json']), adapter, io, new AbortController().signal), 0)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(text).text, 'answer')
})

test('framing handles multi-record chunk, byte limits, UTF-8 and incomplete EOF', async () => {
  const lines = []
  for await (const line of records(Readable.from([Buffer.from('甲\n乙\n')]), 10)) lines.push(line)
  assert.deepEqual(lines, ['甲', '乙'])
  await assert.rejects(async () => { for await (const line of records(Readable.from([Buffer.from('123456')]), 3)) void line }, /byte limit/u)
  await assert.rejects(async () => { for await (const line of records(Readable.from([Buffer.from('{}')])) ) void line }, /incomplete/u)
})
