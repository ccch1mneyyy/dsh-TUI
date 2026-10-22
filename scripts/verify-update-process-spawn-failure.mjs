/** Cross-platform Windows runner setup-failure regression; Node 24, no dependencies.
 * Run: node scripts/verify-update-process-spawn-failure.mjs
 * Executes the actual source runner with isolated builtin failure seams. This
 * does not execute Win32 APIs or replace native Windows acceptance.
 */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const repository = resolve(dirname(script), '..')
const cases = ['spawn-throw', 'config-write', 'asset-resolution', 'spawn-cleanup', 'config-cleanup']
const report = (name, details) => console.log(JSON.stringify({ case: name, ...details }))

async function worker(root, name) {
  const { runWindowsInstaller } = await import(pathToFileURL(join(root, 'windowsInstaller.js')).href)
  const original = {
    spawn: childProcess.spawn,
    mkdtempSync: fs.mkdtempSync,
    writeFileSync: fs.writeFileSync,
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
  }
  const controller = new AbortController()
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const listeners = () => signals.map(signal => process.rawListeners(signal))
  const beforeListeners = listeners()
  const beforeAbort = getEventListeners(controller.signal, 'abort')
  // Initialize output handles before measuring resource counts.
  process.stdout.write('')
  process.stderr.write('')
  const resources = () => process.getActiveResourcesInfo().filter(kind => ['ProcessWrap', 'PipeWrap', 'Timeout'].includes(kind)).sort()
  const beforeResources = resources()
  let directory
  let spawnCalls = 0
  let removalCalls = 0
  let timerCalls = 0
  let settlements = 0
  const events = []
  const cleanupFails = name.endsWith('-cleanup')
  const writeFails = name.startsWith('config-')
  try {
    fs.mkdtempSync = prefix => {
      directory = original.mkdtempSync(prefix)
      return directory
    }
    fs.writeFileSync = (...args) => {
      original.writeFileSync(...args)
      if (writeFails) throw new Error('controlled config write failure')
    }
    fs.existsSync = path => {
      if (name === 'asset-resolution') throw new Error('controlled asset resolution failure')
      return original.existsSync(path)
    }
    fs.rmSync = (...args) => {
      removalCalls++
      if (cleanupFails) throw new Error('controlled temporary removal failure')
      return original.rmSync(...args)
    }
    childProcess.spawn = () => {
      spawnCalls++
      throw new Error('spawn UNKNOWN')
    }
    globalThis.setTimeout = (...args) => {
      timerCalls++
      return original.setTimeout(...args)
    }
    globalThis.setInterval = (...args) => {
      timerCalls++
      return original.setInterval(...args)
    }
    syncBuiltinESMExports()
    const result = await runWindowsInstaller('installer.exe', [], {
      category: name,
      signal: controller.signal,
      onEvent: event => events.push(event),
      onStdout: () => assert.fail('unlaunched installer produced stdout'),
      onStderr: () => assert.fail('unlaunched installer produced stderr'),
    }, 10000).then(code => {
      settlements++
      return code
    }, error => assert.fail('runner rejected instead of resolving nonzero: ' + error))
    assert.equal(result, 127)
    assert.equal(settlements, 1, 'one resolved result')
    assert.equal(events.filter(event => event.stage === 'close').length, 1, 'one close event')
    assert.equal(events.at(-1)?.stage, 'close', 'close follows diagnostics')
    assert.equal(events.filter(event => event.stage === 'error').length, 1)
    assert.match(events.find(event => event.stage === 'error').message, writeFails ? /config write failure/u : name === 'asset-resolution' ? /asset resolution failure/u : /spawn UNKNOWN/u)
    assert.equal(events.some(event => event.stage === 'start'), false)
    assert.ok(events.every(event => event.pid === undefined && event.lastOutputAt === undefined), 'no invented process identity or output')
    assert.ok(events.every(event => !/cleanup confirmed|membership verified/iu.test(event.message ?? '')), 'no claimed native ownership or confirmed cleanup')
    assert.equal(spawnCalls, writeFails || name === 'asset-resolution' ? 0 : 1)
    assert.equal(removalCalls, 1, 'temporary control directory removal attempted once')
    assert.equal(original.existsSync(directory), cleanupFails, 'temporary directory removed unless removal explicitly failed')
    assert.equal(events.filter(event => event.stage === 'cleanup-error').length, cleanupFails ? 1 : 0)
    if (cleanupFails) assert.match(events.find(event => event.stage === 'cleanup-error').message, /Temporary installer control files could not be removed:.*controlled temporary removal failure/u)
    assert.deepEqual(listeners(), beforeListeners, 'no signal listener leak')
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), beforeAbort, 'no abort listener leak')
    assert.equal(timerCalls, 0, 'no timers created before successful spawn')
    assert.deepEqual(resources(), beforeResources, 'no process, pipe or timer resource leak')
    controller.abort()
    assert.equal(events.filter(event => event.stage === 'close').length, 1, 'abort after failure cannot settle again')
    report(name, { status: 'PASS', result, spawnCalls, removalCalls, timerCalls, events })
  } finally {
    childProcess.spawn = original.spawn
    for (const key of ['mkdtempSync', 'writeFileSync', 'existsSync', 'rmSync']) fs[key] = original[key]
    globalThis.setTimeout = original.setTimeout
    globalThis.setInterval = original.setInterval
    syncBuiltinESMExports()
    if (directory) original.rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--worker') {
  await worker(process.argv[3], process.argv[4])
} else {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-windows-setup-regression-'))
  let failed = 0
  try {
    fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
    for (const relative of ['windowsInstaller', 'utils/shellQuote']) {
      const destination = join(root, relative + '.js')
      fs.mkdirSync(dirname(destination), { recursive: true })
      fs.writeFileSync(destination, stripTypeScriptTypes(fs.readFileSync(join(repository, 'src', relative + '.ts'), 'utf8'), { mode: 'strip' }))
    }
    for (const name of cases) {
      const child = childProcess.spawnSync(process.execPath, [script, '--worker', root, name], { encoding: 'utf8', timeout: 10000 })
      process.stdout.write(child.stdout ?? '')
      process.stderr.write(child.stderr ?? '')
      if (child.error || child.status !== 0) {
        failed++
        report(name, { status: 'FAIL', exitCode: child.status, error: child.error?.message })
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  report('windows-setup-failures', { status: failed ? 'FAIL' : 'PASS', cases: cases.length, failed, nativeWindows: false })
  process.exitCode = failed ? 1 : 0
}
