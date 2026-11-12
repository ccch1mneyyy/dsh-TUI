import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, chmod, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { main } from '../entry.mjs'
import { parse, errorFormat } from '../args.mjs'
import { createDshAdapter } from '../adapters/dsh/index.mjs'
import { locateDsh } from '../adapters/dsh/locate.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const launcher = join(root, 'bin/dsh-tui.js')
const temp = await mkdtemp(join(tmpdir(), 'dst-edge-'))
const pkg = join(temp, 'host')
await mkdir(pkg)
const fixture = join(pkg, 'bin.mjs')
await copyFile(fileURLToPath(new URL('./fixtures/dsh.mjs', import.meta.url)), fixture)
await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: { dsh: './bin.mjs' }, type: 'module' }))
after(() => rm(temp, { recursive: true, force: true, maxRetries: 3 }))
function sink() {
  let value = ''
  const stream = new Writable({ write(chunk, encoding, callback) { value += chunk; callback() } })
  return { stream, text: () => value }
}
function io(input = []) {
  const out = sink(), err = sink()
  return { value: { stdin: Readable.from(input), stdout: out.stream, stderr: err.stream }, text: out.text, error: err.text }
}
async function launch(args, env = {}, input = '') {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: root, env: { ...process.env, DSH_TUI_CLI_DSH_BIN: fixture, DSH_HOME: join(temp, 'home'), USERPROFILE: temp, HOME: temp, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  if (input !== null) child.stdin.end(input)
  const out = sink(), err = sink()
  child.stdout.pipe(out.stream); child.stderr.pipe(err.stream)
  const result = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout: out.text(), stderr: err.text() })) })
  return { child, result }
}

test('parser failures keep JSON selection without treating literal flag values as options', async () => {
  assert.equal(errorFormat(['run', '--session-id', '--json']), 'text')
  assert.equal(errorFormat(['run', '--', '--json']), 'text')
  const { result } = await launch(['run', '--bogus', '--json'])
  const response = await result
  assert.equal(response.code, 2)
  assert.equal(JSON.parse(response.stdout).error.code, 'INVALID_ARGUMENT')
  assert.throws(() => parse(['cli', 'typo']), /Unknown CLI command/u)
})

test('large stdin fails before adapter side effects', async () => {
  const streams = io([Buffer.alloc(8 * 1024 * 1024 + 1, 65)])
  let calls = 0
  const code = await main(['run', '--json'], { io: streams.value, adapter: { async *execute() { calls++ } } })
  assert.equal(code, 2)
  assert.equal(calls, 0)
  assert.equal(JSON.parse(streams.text()).error.code, 'INPUT_LIMIT')
})

test('deadline includes waiting for stdin', async () => {
  const streams = io()
  streams.value.stdin = new Readable({ read() {} })
  const code = await main(['run', '--json', '--timeout=30'], { io: streams.value })
  assert.equal(code, 124)
  assert.equal(JSON.parse(streams.text()).error.code, 'TIMEOUT')
})

test('injected cancellation stops exactly one owned process and returns 130', async () => {
  const streams = io([])
  let started
  const ready = new Promise(resolve => { started = resolve })
  const adapter = {
    async *execute(request, { signal }) {
      started()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      signal.throwIfAborted()
    },
  }
  const run = main(['run', 'q', '--json'], { io: streams.value, adapter })
  await ready
  process.emit('SIGINT')
  assert.equal(await run, 130)
  assert.equal(JSON.parse(streams.text()).error.code, 'INTERRUPTED')
})

test('a broken output pipe cancels the operation without error text on stdout', async () => {
  const streams = io([])
  streams.value.stdout = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('pipe closed'), { code: 'EPIPE' })) } })
  let disposed = false
  const adapter = { async *execute() {
    try { yield { type: 'session', sessionId: 's' }; throw new Error('must not request another event') }
    finally { disposed = true }
  } }
  assert.equal(await main(['run', 'q', '--output-format=stream-json'], { io: streams.value, adapter }), 1)
  assert(disposed)
})

test('empty input, unavailable runtime and missing cwd have stable failures', async () => {
  for (const [args, expected] of [[['run', '--json'], 'INVALID_ARGUMENT'], [['run', 'q', '--cwd', join(temp, 'missing'), '--json'], 'INVALID_ARGUMENT'], [['run', 'q', '--dsh-bin', join(temp, 'absent.js'), '--json'], 'ADAPTER_UNAVAILABLE']]) {
    const { result } = await launch(args)
    assert.equal(JSON.parse((await result).stdout).error.code, expected)
  }
})

test('locator follows npm shim without executing it; explicit bin is package-owned', async () => {
  const bin = join(temp, 'bin')
  await mkdir(bin)
  const shim = join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  await writeFile(shim, `#!/bin/sh\nnode "${fixture}" "$@"\n`)
  await chmod(shim, 0o755)
  assert.equal(locateDsh({ cwd: root }, { PATH: bin }).version, '0.2.0-rc.2')
  // Windows sync realpath can retain 8.3 names; resolve both sides with the same API.
  assert.equal(await realpath(locateDsh({ cwd: root, dshBin: fixture }, {}).path), await realpath(fixture))
  const stray = join(temp, 'unowned.mjs')
  await writeFile(stray, '')
  assert.throws(() => locateDsh({ cwd: root, dshBin: stray }, {}), /belong to/u)
})

test('direct CLI entry runs through a symlinked parent path', async () => {
  const linkedRoot = join(temp, 'linked-root')
  await symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const result = spawnSync(process.execPath, [join(linkedRoot, 'cli/entry.mjs'), '--help'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /dst run/u)
  assert.equal(result.stderr, '')
})

test('unvalidated versions fail before starting a task; native forwarding is retained', async () => {
  let launches = 0
  const adapter = createDshAdapter({ locate: () => ({ path: fixture, version: '99.0.0' }), start: () => { launches++; throw new Error('unexpected') } })
  const streams = io([])
  assert.equal(await main(['run', 'q', '--json'], { adapter, io: streams.value }), 3)
  assert.equal(launches, 0)
})

test('every validated version passes the contract gate and reports itself', async () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']) {
    let launches = 0
    const adapter = createDshAdapter({ locate: () => ({ path: fixture, version }), start: () => { launches++; throw new Error('launched') } })
    const described = io([])
    assert.equal(await main(['capabilities', '--json'], { adapter, io: described.value }), 0)
    const capabilities = JSON.parse(described.text())
    assert.deepEqual([capabilities.runtimeVersion, capabilities.validated], [version, true])
    const streams = io([])
    await main(['run', 'q', '--json'], { adapter, io: streams.value })
    assert.equal(launches, 1, version)
    assert.notEqual(JSON.parse(streams.text()).error.code, 'ADAPTER_UNAVAILABLE', version)
  }
})

test('migrated single-file global launcher uses updated profile CLI and preserves old help', async () => {
  const home = join(temp, 'migration-home')
  const global = join(temp, 'global')
  await mkdir(join(global, 'bin'), { recursive: true })
  await copyFile(launcher, join(global, 'bin/dsh-tui.js'))
  await writeFile(join(global, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.15.0', type: 'module' }))
  const profile = join(home, 'profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/cli')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'entry.mjs'), 'export async function main(args) { console.log(JSON.stringify(args)); return 17 }')
  const execute = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(global, 'bin/dsh-tui.js'), ...args], { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; child.stdout.on('data', chunk => { out += chunk }); child.on('error', reject); child.on('close', code => resolve({ code, out }))
  })
  assert.equal((await execute(['cli', 'anything'])).code, 17)
  await rm(profile, { recursive: true })
  assert.equal((await execute(['cli', '--help'])).code, 3)
  assert.equal((await execute(['--help'])).code, 0)
})
