/** Run after compile: node scripts/verify-update-process.mjs
 * Real disposable installer children/grandchildren. No network or live profile.
 * POSIX process-group regression; native Windows Job Object coverage is
 * scripts/verify-update-process-windows.mjs (also has its own focused workflow).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInstallerProcess, updateTimeoutMs, DEFAULT_UPDATE_TIMEOUT_MS } from '../lib/types/updateProcess.js'
import { settled } from './lib/term-test.mjs'
if (process.platform === 'win32') {
  await import('./verify-update-process-windows.mjs')
  process.exit(process.exitCode ?? 0)
}
const root = mkdtempSync(join(tmpdir(), 'installer-process-'))
const fixture = join(root, 'installer.mjs')
writeFileSync(fixture, `
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const [mode, marker] = process.argv.slice(2)
if (mode === 'stdin') {
  console.log('received:' + readFileSync(0, 'utf8').trim())
} else if (mode === 'fragmented') {
  const bytes = Buffer.from('中文 café 😀')
  process.stdout.write(bytes.subarray(0, 1))
  process.stderr.write(bytes.subarray(0, 2))
  setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stderr.write(bytes.subarray(2)) }, 80)
} else if (mode === 'grandchild') {
  process.on('SIGTERM', () => {})
  writeFileSync(marker, String(process.pid))
  setInterval(() => {}, 1000)
} else if (mode === 'tree') {
  const grandchild = spawn(process.execPath, [import.meta.filename, 'grandchild', marker], { stdio: 'inherit' })
  console.log('Done')
  setInterval(() => {}, 1000)
} else if (mode === 'hang') {
  console.log('Done')
  process.stderr.write('last diagnostic\\n')
  setInterval(() => {}, 1000)
} else if (mode === 'long') {
  let count = 0
  const interval = setInterval(() => { console.log('progress'); if (++count === 8) clearInterval(interval) }, 30)
} else if (mode === 'nonzero') {
  console.log('Done')
  process.exitCode = 7
} else if (mode === 'race') {
  setTimeout(() => process.exit(0), 80)
} else console.log('Done')
`)
const running = []
const isAlive = pid => {
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/stat`)) {
    if (readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z') return false
  }
  try { process.kill(pid, 0); return true } catch { return false }
}
async function run(mode, extra = {}) {
  const events = []
  let output = ''
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal))
  const result = await runInstallerProcess(process.execPath, [fixture, mode, join(root, mode + '.pid')], {
    category: 'fixture-install', timeoutMs: 1500, terminationGraceMs: 80,
    onEvent: event => events.push(event), onStdout: text => { output += text }, onStderr: text => { output += text }, ...extra,
  })
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal)), before, 'signal listeners released')
  assert.equal(events.filter(event => event.stage === 'close').length, 1, 'single settlement')
  return { result, events, output }
}
try {
  assert.equal(updateTimeoutMs('invalid'), DEFAULT_UPDATE_TIMEOUT_MS)
  assert.equal(updateTimeoutMs('0'), DEFAULT_UPDATE_TIMEOUT_MS)
  assert.equal(updateTimeoutMs('120000'), 120000)
  assert.equal((await run('normal')).result, 0)
  let unicodeStdout = ''
  let unicodeStderr = ''
  assert.equal((await run('fragmented', { onStdout: text => { unicodeStdout += text }, onStderr: text => { unicodeStderr += text } })).result, 0)
  assert.equal(unicodeStdout, '中文 café 😀', 'stdout preserves split UTF8 bytes')
  assert.equal(unicodeStderr, '中文 café 😀', 'stderr preserves split UTF8 bytes')
  const stdinWrapper = join(root, 'stdin-wrapper.mjs')
  writeFileSync(stdinWrapper, `
import { runInstallerProcess } from ${JSON.stringify(new URL('../lib/types/updateProcess.js', import.meta.url).href)}
process.exitCode = await runInstallerProcess(process.execPath, [${JSON.stringify(fixture)}, 'stdin'], {
  category: 'stdin-fixture', timeoutMs: 1500, onStdout: text => process.stdout.write(text),
})
`)
  const stdinResult = spawnSync(process.execPath, [stdinWrapper], { input: 'accepted\n', encoding: 'utf8', timeout: 3000 })
  assert.ifError(stdinResult.error)
  assert.equal(stdinResult.status, 0, stdinResult.stderr)
  assert.match(stdinResult.stdout, /received:accepted/u, 'installer retains inherited stdin')
  assert.equal((await run('nonzero')).result, 7, 'Done never overrides exit code')
  assert.equal((await run('long')).result, 0, 'normal long/outputting install survives')
  const hung = await run('hang', { timeoutMs: 300 })
  assert.equal(hung.result, 124)
  assert.match(hung.output, /Done/)
  const timeout = hung.events.find(event => event.stage === 'timeout')
  assert.ok(timeout.pid > 0 && timeout.lastOutputAt > 0)
  assert.equal(timeout.category, 'fixture-install')
  const tree = await run('tree', { timeoutMs: 500 })
  assert.equal(tree.result, 124)
  const grandchildPid = Number(readFileSync(join(root, 'tree.pid'), 'utf8'))
  running.push(grandchildPid)
  assert.ok(await settled(() => !isAlive(grandchildPid)), 'TERM-resistant grandchild terminated with owned tree')
  const controller = new AbortController()
  const cancelled = await run('hang', { signal: controller.signal, onStdout: () => controller.abort() })
  assert.equal(cancelled.result, 130)
  const preAborted = new AbortController()
  preAborted.abort()
  const preEvents = []
  assert.equal(await runInstallerProcess(process.execPath, [fixture], { category: 'cancel-before-start', signal: preAborted.signal, onEvent: event => preEvents.push(event) }), 130)
  assert.equal(preEvents.some(event => event.stage === 'start'), false)
  const errors = []
  assert.equal(await runInstallerProcess(join(root, 'missing'), [], { category: 'missing', onEvent: event => errors.push(event) }), 127)
  assert.equal(errors.filter(event => event.stage === 'close').length, 1)
  for (let i = 0; i < 3; i++) {
    const race = await run('race', { timeoutMs: 100 })
    assert.ok([0, 124].includes(race.result))
  }
  console.log(`PASS: ${process.platform} actual child/grandchild timeout/cancel/error/nonzero/races; one settlement and signal cleanup`)
} finally {
  for (const pid of running) if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
  rmSync(root, { recursive: true, force: true })
}
