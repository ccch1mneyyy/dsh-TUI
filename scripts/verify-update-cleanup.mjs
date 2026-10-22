/**
 * /update must not retry, remove stale files, repair, or restart after cleanup
 * becomes unconfirmed or cancellation is requested. Runs the real updater from a disposable transpiled
 * source copy; installer, spawn, filesystem boundaries and fetch are controlled.
 * No network, installer, replacement process, or real user profile is touched.
 * Run: node scripts/verify-update-cleanup.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repo = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(repo, 'src')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-update-cleanup-'))
const pkg = join(scratch, 'package')
const modules = join(pkg, 'lib', 'types')
const savedEnvironment = new Map(['DSH_HOME', 'DSH_TUI_STANDALONE', 'DSH_TUI_STANDALONE_BINARY', 'DSH_TUI_STANDALONE_CACHE', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]))
const originalStderr = process.stderr.write
const originalFetch = globalThis.fetch
const originalArgv = [...process.argv]
let stderrHook
let diagnostics = ''

try {
  mkdirSync(modules, { recursive: true })
  mkdirSync(join(scratch, 'home'), { recursive: true })
  process.env.HOME = join(scratch, 'home')
  process.env.USERPROFILE = join(scratch, 'home')
  process.env.DSH_HOME = join(scratch, 'profiles-home')
  delete process.env.DSH_TUI_STANDALONE
  delete process.env.DSH_TUI_STANDALONE_BINARY
  symlinkSync(join(repo, 'node_modules'), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const manifest = join(pkg, 'package.json')
  const writeVersion = version => writeFileSync(manifest, JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version, type: 'module' }))
  writeVersion('1.2.3')

  // Transpile the actual dependency closure without changing generated lib/.
  // Replacing imports in this disposable copy creates no production test hook.
  const visited = new Set()
  function copyModule(source) {
    if (visited.has(source)) return
    visited.add(source)
    const output = join(modules, relative(sourceRoot, source).replace(/\.tsx?$/, '.js'))
    let code = ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      fileName: source,
    }).outputText
    if (source === join(sourceRoot, 'update.ts')) {
      assert.ok(code.includes("from './updateProcess.js'"))
      code = code.replace("from './updateProcess.js'", "from './installer-stub.js'")
      code = code.replace("from 'node:child_process'", "from './replacement-stub.js'")
      code = code.replace("from 'node:fs'", "from './filesystem-stub.js'")
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, code)
    for (const imported of ts.preProcessFile(code, true, true).importedFiles) {
      const name = imported.fileName
      if (!name.startsWith('.') || name.endsWith('-stub.js')) continue
      const base = resolve(dirname(source), name)
      const candidate = base.replace(/\.js$/, '.ts')
      const dependency = existsSync(candidate) ? candidate : base.replace(/\.js$/, '.tsx')
      assert.ok(existsSync(dependency), `runtime source dependency exists: ${name}`)
      copyModule(dependency)
    }
  }
  copyModule(join(sourceRoot, 'update.ts'))
  writeFileSync(join(modules, 'installer-stub.js'), `
let plan = []
export const calls = []
export function configure(steps) { plan = steps; calls.length = 0 }
export async function runInstallerProcess(command, args, options) {
  const step = plan[calls.length]
  calls.push({ command, args: [...args] })
  if (!step) throw new Error('Unexpected installer invocation: ' + JSON.stringify(args))
  step.onRun?.(options)
  if (step.stderr) options.onStderr?.(step.stderr)
  if (step.cleanup) options.onEvent?.({ category: options.category, stage: 'cleanup-error', code: step.code, message: 'fixture: owned job cleanup unconfirmed' })
  options.onEvent?.({ category: options.category, stage: 'close', code: step.code })
  return step.code
}
`)
  writeFileSync(join(modules, 'replacement-stub.js'), `
export { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
export let spawnCount = 0
export function reset() { spawnCount = 0 }
export function spawn() {
  spawnCount++
  const child = new EventEmitter()
  child.pid = 999999
  child.stderr = new EventEmitter()
  queueMicrotask(() => child.emit('close', 0, null))
  return child
}
`)
  writeFileSync(join(modules, 'filesystem-stub.js'), `
export * from 'node:fs'
import * as fs from 'node:fs'
let onRead
export function configure(hook) { onRead = hook }
export function readFileSync(...args) {
  const value = fs.readFileSync(...args)
  onRead?.(...args)
  return value
}
`)
  const filesystem = await import(pathToFileURL(join(modules, 'filesystem-stub.js')).href)
  const updater = await import(pathToFileURL(join(modules, 'update.js')).href)
  const runner = await import(pathToFileURL(join(modules, 'installer-stub.js')).href)
  const replacement = await import(pathToFileURL(join(modules, 'replacement-stub.js')).href)
  process.stderr.write = function (chunk) { diagnostics += String(chunk); stderrHook?.(String(chunk)); return true }

  const transient = 'ENOENT: scandir dsh-tui_tmp_123_0\n'
  const collision = 'EEXIST: rename dsh-tui_tmp_123_0\n'
  const cases = [
    { name: 'native failure plus transient stderr', steps: [{ code: 127, stderr: transient, cleanup: true }] },
    { name: 'native failure plus collision stderr', steps: [{ code: 127, stderr: collision, cleanup: true }] },
    { name: 'unexpected success cannot enter repair', target: '9.9.9', steps: [{ code: 0, stderr: collision, cleanup: true }] },
    { name: 'unexpected success cannot restart', target: '1.2.3', steps: [{ code: 0, cleanup: true }] },
    { name: 'uncertainty on plain retry prevents stale removal', steps: [{ code: 1, stderr: transient }, { code: 127, stderr: transient, cleanup: true }] },
    { name: 'uncertainty on stale recovery prevents repair', target: '9.9.9', recovery: true, steps: [{ code: 1, stderr: collision }, { code: 0, cleanup: true }] },
    { name: 'uncertainty during repair prevents replacement', target: '9.9.9', repair: true, steps: [{ code: 0 }, { code: 0, cleanup: true }] },
  ]
  for (const [index, test] of cases.entries()) {
    writeVersion('1.2.3')
    diagnostics = ''
    const profile = `cleanup-${index}`
    const packageDir = updater.profilePackageDir(profile)
    const stagingDir = join(dirname(packageDir), 'dsh-tui_tmp_123_0')
    const markers = [join(packageDir, 'sentinel'), join(stagingDir, 'sentinel')]
    const seedMarkers = () => {
      for (const marker of markers) {
        mkdirSync(dirname(marker), { recursive: true })
        writeFileSync(marker, 'preserve while ownership is uncertain')
      }
    }
    seedMarkers()
    // A stale recovery is allowed before uncertainty; recreate sentinels at
    // that installer invocation to prove no subsequent destructive pass runs.
    if (test.recovery) test.steps[1].onRun = seedMarkers
    if (test.repair) test.steps[1].onRun = () => writeVersion('9.9.9')
    runner.configure(test.steps)
    const result = await updater.updateTuiAndRestart('fixture-session', profile, test.target)
    assert.notEqual(result.updateCode, 0, test.name)
    assert.notEqual(result.restartCode, 0, `${test.name}: nonzero restart result`)
    assert.equal(runner.calls.length, test.steps.length, `${test.name}: no additional installer`)
    assert.equal(replacement.spawnCount, 0, `${test.name}: no replacement`)
    assert.ok(markers.every(marker => existsSync(marker)), `${test.name}: no stale removal after cleanup uncertainty`)
    assert.match(readFileSync(join(scratch, 'home', '.dsh-tui', 'restart.log'), 'utf8'), /cleanup-error/, `${test.name}: cleanup diagnostic recorded`)
    if (test.steps.length === 1) assert.doesNotMatch(diagnostics, /retrying once|rerunning the update/)
    if (test.repair) assert.equal(runner.calls[1].args.at(-1), 'install')
    else assert.ok(runner.calls.every(call => call.args.includes('update')), `${test.name}: no repair invocation`)
    process.stdout.write(`PASS: ${test.name}\n`)
  }
  // Aborts are injected at external boundaries, with production policy intact.
  const failures = []
  async function check(name, body) {
    try { await body(); process.stdout.write(`PASS: ${name}\n`) }
    catch (error) { failures.push(error); process.stdout.write(`FAIL: ${name}: ${error.message}\n`) }
    finally {
      filesystem.configure(undefined)
      stderrHook = undefined
      globalThis.fetch = originalFetch
      process.argv = [...originalArgv]
      delete process.env.DSH_TUI_STANDALONE
      delete process.env.DSH_TUI_STANDALONE_BINARY
    }
  }
  const cancelled = (result, name) => {
    assert.deepEqual(result, { updateCode: 130, restartCode: 130 }, name)
    assert.equal(replacement.spawnCount, 0, `${name}: replacement not started`)
  }
  await check('normal update still restarts', async () => {
    writeVersion('1.2.3')
    runner.configure([{ code: 0 }])
    replacement.reset()
    const result = await updater.updateTuiAndRestart('fixture-session', 'normal', '1.2.3')
    assert.deepEqual(result, { updateCode: 0, restartCode: 0 })
    assert.equal(replacement.spawnCount, 1)
  })
  for (const stage of ['installer running', 'last installer success', 'before retry', 'version verification', 'before launcher migration', 'after launcher migration', 'before restart']) {
    await check(`cancel ${stage}`, async () => {
      writeVersion('1.2.3')
      replacement.reset()
      const controller = new AbortController()
      let reads = 0
      const target = stage === 'version verification' ? '9.9.9' : '1.2.3'
      const launcherDir = join(scratch, 'global', stage.replaceAll(' ', '-'))
      const launcher = join(launcherDir, 'bin', 'dsh-tui.js')
      mkdirSync(dirname(launcher), { recursive: true })
      mkdirSync(join(pkg, 'bin'), { recursive: true })
      writeFileSync(join(pkg, 'bin', 'dsh-tui.js'), 'new launcher')
      writeFileSync(launcher, 'old launcher')
      writeFileSync(join(launcherDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '1.0.0' }))
      process.argv[1] = launcher
      if (stage === 'after launcher migration' || stage === 'before restart') stderrHook = text => {
        if (!text.includes('global launcher aligned')) return
        // A queued abort runs after synchronous update completion and before
        // updateTuiAndRestart resumes its await to start the replacement.
        if (stage === 'before restart') queueMicrotask(() => controller.abort())
        else controller.abort()
      }
      runner.configure([{
        code: stage === 'installer running' ? 130 : stage === 'before retry' ? 1 : 0,
        ...(stage === 'before retry' ? { stderr: transient } : {}),
        onRun(options) {
          assert.equal(options.signal, controller.signal, 'installer receives caller signal')
          if (['installer running', 'last installer success', 'before retry'].includes(stage)) controller.abort()
          else filesystem.configure(path => {
            if (path !== manifest) return
            reads++
            if (stage === 'version verification' && reads === 1) controller.abort()
            if (stage === 'before launcher migration' && reads === 2) controller.abort()
          })
        },
      }])
      const result = await updater.updateTuiAndRestart('fixture-session', `cancel-${stage.replaceAll(' ', '-')}`, target, undefined, {}, controller.signal)
      assert.equal(controller.signal.aborted, true, 'the intended cancellation boundary was reached')
      cancelled(result, stage)
      assert.equal(runner.calls.length, 1, 'cancel prevents retry and repair')
      if (stage === 'before launcher migration') assert.equal(readFileSync(launcher, 'utf8'), 'old launcher')
    })
  }

  // Only the signal received by fetch can release these pending operations.
  // The watchdog bounds the old implementation rather than waiting 300s.
  for (const stage of ['release lookup', 'asset headers', 'asset body', 'checksum headers', 'checksum body']) {
    await check(`cancel standalone ${stage}`, async () => {
      writeVersion('1.2.3')
      runner.configure([])
      replacement.reset()
      const controller = new AbortController()
      const binary = join(scratch, 'standalone-binary')
      writeFileSync(binary, 'unchanged executable')
      process.env.DSH_TUI_STANDALONE = '1'
      process.env.DSH_TUI_STANDALONE_BINARY = binary
      const cache = join(scratch, `cache-${stage.replaceAll(' ', '-')}`)
      process.env.DSH_TUI_STANDALONE_CACHE = cache
      const asset = updater.getStandaloneAssetName()
      let observedAbort = false
      let watchdog
      let requested = 0
      const waitForAbort = signal => new Promise((resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('fixture watchdog: caller cancellation not consumed')), 300)
        const abort = () => { observedAbort = true; clearTimeout(watchdog); reject(new DOMException('Cancelled', 'AbortError')) }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        queueMicrotask(() => controller.abort())
      })
      const hangingBody = signal => ({
        ok: true, headers: new Headers(),
        body: { getReader: () => ({ read: () => waitForAbort(signal), cancel: async () => {} }) },
      })
      globalThis.fetch = async (url, options) => {
        requested++
        if (stage === 'release lookup') return waitForAbort(options.signal)
        if (String(url).endsWith('/releases/latest')) return Response.json({ tag_name: 'v9.9.9', assets: [
          { name: asset, browser_download_url: `https://fixture.invalid/${asset}` },
          { name: 'SHA256SUMS', browser_download_url: 'https://fixture.invalid/SHA256SUMS' },
        ] })
        if (stage === 'asset headers' || (stage === 'checksum headers' && String(url).endsWith('SHA256SUMS'))) return waitForAbort(options.signal)
        if (stage === 'asset body' || String(url).endsWith('SHA256SUMS')) return hangingBody(options.signal)
        return new Response('archive bytes never extracted: checksum download is cancelled')
      }
      const result = await updater.updateTuiAndRestart('fixture-session', 'standalone', '9.9.9', undefined, {}, controller.signal)
      clearTimeout(watchdog)
      assert.ok(requested >= (stage === 'release lookup' ? 1 : 2), 'real release lookup/download ran')
      assert.equal(observedAbort, true, 'caller cancellation promptly reaches the pending transfer')
      cancelled(result, stage)
      assert.equal(readFileSync(binary, 'utf8'), 'unchanged executable')
      assert.equal(runner.calls.length, 0)
      assert.deepEqual(existsSync(cache) ? (await import('node:fs')).readdirSync(cache) : [], [], 'single cleanup path removes temporary download')
    })
  }
  assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'))
} finally {
  globalThis.fetch = originalFetch
  process.argv = originalArgv
  process.stderr.write = originalStderr
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
}
