/**
 * /update must not retry, remove stale files, repair, or restart after cleanup
 * becomes unconfirmed or cancellation is requested. The real runtime guard must
 * exclude live leases and hold one lock through all profile mutations. Runs the
 * real updater from a disposable transpiled source copy; installer, spawn,
 * filesystem boundaries and fetch are controlled. Only local lease sockets are
 * opened; no installer, replacement process, or real user profile is touched.
 * Run: node scripts/verify-update-cleanup.mjs
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import ts from 'typescript'

const repo = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(repo, 'src')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-update-cleanup-'))
const pkg = join(scratch, 'package')
const modules = join(pkg, 'lib', 'types')
const savedEnvironment = new Map(['DSH_HOME', 'DSH_TUI_STANDALONE', 'DSH_TUI_STANDALONE_BINARY', 'DSH_TUI_STANDALONE_CACHE', 'DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_HOST_ENTRY', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]))
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
  delete process.env.DSH_TUI_HOST_ENTRY_PATH
  delete process.env.DSH_TUI_HOST_ENTRY
  symlinkSync(join(repo, 'node_modules'), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const native = join(pkg, 'src', 'dsh-adapter', 'market')
  mkdirSync(native, { recursive: true })
  const imports = {}
  for (const name of ['prepare', 'runtime-profile']) {
    copyFileSync(join(sourceRoot, 'dsh-adapter', 'market', `${name}.mjs`), join(native, `${name}.mjs`))
    imports[`#tui-market/${name}`] = `./src/dsh-adapter/market/${name}.mjs`
  }
  const manifest = join(pkg, 'package.json')
  const writeVersion = version => writeFileSync(manifest, JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version, type: 'module', imports }))
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
let plan = []
export const calls = []
export function configure(steps) { plan = steps; calls.length = 0 }
export async function runInstallerProcess(command, args, options) {
  const step = plan[calls.length]
  calls.push({ command, args: [...args] })
  if (!step) throw new Error('Unexpected installer invocation: ' + JSON.stringify(args))
  await step.onRun?.(options)
  if (step.code === 0 && !step.cleanup) {
    const source = fileURLToPath(new URL('../../', import.meta.url))
    const current = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const profile = args[args.indexOf('--profile') + 1]
    const target = join(process.env.DSH_HOME, 'profiles', profile, 'node_modules', current.name)
    mkdirSync(join(target, 'bin'), { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: current.name, version: step.version ?? current.version, type: 'module' }))
    const bin = join(source, 'bin/dsh-tui.js')
    writeFileSync(join(target, 'bin/dsh-tui.js'), existsSync(bin) ? readFileSync(bin) : '// installed launcher')
    await step.onInstalled?.(target, options)
  }
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
export let lastSpawn
export function reset() { spawnCount = 0; lastSpawn = undefined }
export function spawn(command, args, options) {
  spawnCount++
  lastSpawn = { command, args, options }
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
let onMutation
export function configure(hook) { onRead = hook }
export function observeMutations(hook) { onMutation = hook }
export function readFileSync(...args) {
  const value = fs.readFileSync(...args)
  onRead?.(...args)
  return value
}
${['writeFileSync', 'rmSync', 'renameSync'].map(name => `
export function ${name}(...args) {
  onMutation?.('${name}', ...args)
  return fs.${name}(...args)
}`).join('\n')}
`)
  const filesystem = await import(pathToFileURL(join(modules, 'filesystem-stub.js')).href)
  const updater = await import(pathToFileURL(join(modules, 'update.js')).href)
  const runner = await import(pathToFileURL(join(modules, 'installer-stub.js')).href)
  const replacement = await import(pathToFileURL(join(modules, 'replacement-stub.js')).href)
  process.stderr.write = function (chunk) { diagnostics += String(chunk); stderrHook?.(String(chunk)); return true }
  const profileDir = profile => join(process.env.DSH_HOME, 'profiles', profile)
  const setupFile = profile => join(profileDir(profile), '.dsh-tui', 'setup.json')
  async function assertReleased(profile) {
    const file = setupFile(profile)
    assert.equal(existsSync(`${file}.lock`), false, `${profile}: setup lock released`)
    let entered = false
    await withFileLock(file, async () => { entered = true }, { waitMs: 0 })
    assert.equal(entered, true, `${profile}: next writer can acquire immediately`)
  }
  async function leaseMarker(profile) {
    const token = randomUUID()
    const server = createServer(socket => { socket.on('error', () => {}); socket.end(`${token}\n`) })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const owned = dirname(setupFile(profile))
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'running.json'), JSON.stringify([{ pid: process.pid, token, port: server.address().port }]))
    return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }

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
    await assertReleased(profile)
    process.stdout.write(`PASS: ${test.name}\n`)
  }
  // Aborts are injected at external boundaries, with production policy intact.
  const failures = []
  async function check(name, body) {
    try { await body(); process.stdout.write(`PASS: ${name}\n`) }
    catch (error) { failures.push(error); process.stdout.write(`FAIL: ${name}: ${error.message}\n`) }
    finally {
      filesystem.configure(undefined)
      filesystem.observeMutations(undefined)
      stderrHook = undefined
      globalThis.fetch = originalFetch
      process.argv = [...originalArgv]
      delete process.env.DSH_TUI_STANDALONE
      delete process.env.DSH_TUI_STANDALONE_BINARY
      delete process.env.DSH_TUI_HOST_ENTRY_PATH
      delete process.env.DSH_TUI_HOST_ENTRY
      delete globalThis[Symbol.for('dsh-tui-update-cleanup-prepare')]
    }
  }
  const cancelled = (result, name) => {
    assert.deepEqual(result, { updateCode: 130, restartCode: 130 }, name)
    assert.equal(replacement.spawnCount, 0, `${name}: replacement not started`)
  }
  await check('live runtime blocks before installer, workspace writes, or cleanup', async () => {
    const profile = 'live-runtime'
    writeVersion('1.2.3')
    replacement.reset()
    diagnostics = ''
    const close = await leaseMarker(profile)
    const workspace = join(profileDir(profile), 'pnpm-workspace.yaml')
    const marker = join(updater.profilePackageDir(profile), 'sentinel')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, 'running runtime')
    writeFileSync(workspace, 'packages: []\n# preserve this user workspace\n')
    const before = readFileSync(workspace)
    const mutations = []
    filesystem.observeMutations((operation, path) => {
      if (typeof path === 'string' && path.startsWith(`${profileDir(profile)}${sep}`)) mutations.push({ operation, path })
    })
    runner.configure([{ code: 1, stderr: collision }])
    try {
      const result = await updater.updateTuiAndRestart('fixture-session', profile, '9.9.9')
      assert.deepEqual(result, { updateCode: 1, restartCode: 1 })
      assert.equal(runner.calls.length, 0, 'live runtime excludes even the first installer')
      assert.deepEqual(mutations, [], 'guard precedes workspace policy and stale cleanup')
      assert.deepEqual(readFileSync(workspace), before)
      assert.equal(readFileSync(marker, 'utf8'), 'running runtime')
      assert.equal(replacement.spawnCount, 0)
      assert.match(diagnostics, /Close the other running TUI sessions/)
      await assertReleased(profile)
    } finally { await close() }
  })
  await check('stale lease with a still-live PID and closed socket permits update', async () => {
    const profile = 'stale-runtime'
    writeVersion('1.2.3')
    replacement.reset()
    const close = await leaseMarker(profile)
    await close()
    runner.configure([{ code: 0 }])
    const result = await updater.updateTuiAndRestart('fixture-session', profile, '1.2.3')
    assert.deepEqual(result, { updateCode: 0, restartCode: 0 })
    assert.equal(runner.calls.length, 1, 'PID existence alone does not retain a dead runtime lease')
    assert.equal(replacement.spawnCount, 1)
    await assertReleased(profile)
  })
  await check('one real setup lock spans policy writes, retry, stale cleanup, and repair', async () => {
    const profile = 'lock-span'
    const dir = profileDir(profile)
    writeVersion('1.2.3')
    replacement.reset()
    const packageDir = updater.profilePackageDir(profile)
    const stagingDir = join(dirname(packageDir), 'dsh-tui_tmp_123_0')
    for (const path of [packageDir, stagingDir]) {
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'sentinel'), 'old install')
    }
    const observations = []
    const observe = stage => {
      const stat = statSync(`${setupFile(profile)}.lock`, { bigint: true })
      observations.push({ stage, identity: [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs] })
    }
    filesystem.observeMutations((operation, path) => {
      if (typeof path === 'string' && path.startsWith(`${dir}${sep}`)) observe(`${operation}:${relative(dir, path)}`)
    })
    const onRun = async () => {
      observe(`installer ${runner.calls.length}`)
      await assert.rejects(withFileLock(setupFile(profile), async () => assert.fail('competing writer entered during update'), { waitMs: 0 }), /timed out waiting for the writer lock/)
    }
    runner.configure([
      { code: 1, stderr: transient, onRun },
      { code: 1, stderr: collision, onRun },
      { code: 0, onRun },
      { code: 0, async onRun() { await onRun(); writeVersion('9.9.9') } },
    ])
    const result = await updater.updateTuiAndRestart('fixture-session', profile, '9.9.9')
    assert.deepEqual(result, { updateCode: 0, restartCode: 0 })
    assert.equal(runner.calls.length, 4)
    assert.equal(runner.calls[3].args.at(-1), 'install', 'last operation is version repair')
    assert.ok(observations.some(entry => entry.stage === 'writeFileSync:pnpm-workspace.yaml'), 'workspace policy actually changed')
    assert.equal(observations.filter(entry => entry.stage.startsWith('rmSync:')).length, 2, 'actual stale install and staging cleanup observed')
    for (const entry of observations) assert.deepEqual(entry.identity, observations[0].identity, `same uninterrupted lock at ${entry.stage}`)
    assert.equal(existsSync(join(packageDir, 'sentinel')), false, 'the new install did not retain stale package contents')
    assert.equal(existsSync(stagingDir), false)
    await assertReleased(profile)
  })
  await check('normal update still restarts', async () => {
    writeVersion('1.2.3')
    runner.configure([{ code: 0 }])
    replacement.reset()
    const result = await updater.updateTuiAndRestart('fixture-session', 'normal', '1.2.3')
    assert.deepEqual(result, { updateCode: 0, restartCode: 0 })
    assert.equal(replacement.spawnCount, 1)
    await assertReleased('normal')
  })
  for (const entryPresent of [true, false]) {
    await check(entryPresent ? 'restart selects the new profile entry while the old store remains' : 'missing new entry prevents restarting the old store', async () => {
      const profile = `entry-${entryPresent}`
      writeVersion('1.2.3')
      replacement.reset()
      const oldEntry = join(pkg, 'lib/types/dsh-adapter/host-entry.js')
      mkdirSync(dirname(oldEntry), { recursive: true })
      writeFileSync(oldEntry, '// retained old store entry')
      process.env.DSH_TUI_HOST_ENTRY_PATH = oldEntry
      process.argv = [process.execPath, oldEntry, '--profile', profile, '--fullscreen']
      const newEntry = join(updater.profilePackageDir(profile), 'lib/types/dsh-adapter/host-entry.js')
      runner.configure([{ code: 0, onInstalled() {
        if (entryPresent) { mkdirSync(dirname(newEntry), { recursive: true }); writeFileSync(newEntry, '// new entry') }
      } }])
      const result = await updater.updateTuiAndRestart('fixture-session', profile, '1.2.3')
      assert.deepEqual(result, { updateCode: 0, restartCode: entryPresent ? 0 : 1 })
      assert.equal(replacement.spawnCount, entryPresent ? 1 : 0)
      if (entryPresent) {
        assert.equal(replacement.lastSpawn.args[0], newEntry)
        assert.equal(replacement.lastSpawn.options.env.DSH_TUI_HOST_ENTRY_PATH, newEntry)
        assert.ok(replacement.lastSpawn.args.includes('--fullscreen'))
        assert.ok(!replacement.lastSpawn.args.includes(oldEntry))
      }
      assert.equal(readFileSync(oldEntry, 'utf8'), '// retained old store entry')
      await assertReleased(profile)
    })
  }
  for (const cancel of [false, true]) {
    await check(cancel ? 'cancel preparation releases the setup lock without restart' : 'preparation failure rejects a successful public install without restart', async () => {
      const profile = 'dsh-tui'
      writeVersion('1.2.3')
      replacement.reset()
      const controller = new AbortController()
      globalThis[Symbol.for('dsh-tui-update-cleanup-prepare')] = async () => {
        assert.ok(existsSync(`${setupFile(profile)}.lock`), 'preparation still holds the update lock')
        await assert.rejects(withFileLock(setupFile(profile), async () => assert.fail('preparation released the update lock'), { waitMs: 0 }), /timed out waiting for the writer lock/)
        if (cancel) { controller.abort(); return {} }
        throw new Error('fixture host preparation failed')
      }
      runner.configure([{ code: 0, onInstalled(target) {
        const current = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
        current.main = './index.js'
        current.dshTui = { runtimeBundle: './lib/tui-runtime' }
        writeFileSync(join(target, 'package.json'), JSON.stringify(current))
        writeFileSync(join(target, 'index.js'), 'export {}')
        mkdirSync(join(target, 'lib/tui-runtime'), { recursive: true })
        mkdirSync(join(target, 'lib/types/dsh-adapter'), { recursive: true })
        writeFileSync(join(target, 'lib/types/dsh-adapter/host-entry.js'), 'export {}')
        writeFileSync(join(target, 'lib/types/dsh-adapter/host-dsh.js'), `
export function findHostDsh() { return { packageDir: ${JSON.stringify(target)} } }
export const loadHostProfileManagement = (...args) => globalThis[Symbol.for('dsh-tui-update-cleanup-prepare')](...args)
`)
        const patch = '[]\n'
        writeFileSync(join(target, 'lib/tui-runtime/cordis.patch.yml'), patch)
        writeFileSync(join(target, 'lib/tui-runtime/package.json'), JSON.stringify({
          name: '@deepseek-harness-tui/dsh-tui-runtime', version: '1.2.3',
          dependencies: { '@deepseek-harness-tui/dsh-tui': '1.2.3' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
          dshTui: { patchSha256: createHash('sha256').update(patch).digest('hex') },
        }))
      } }])
      const result = await updater.updateTuiAndRestart('fixture-session', profile, '1.2.3', undefined, {}, controller.signal)
      assert.deepEqual(result, { updateCode: cancel ? 130 : 1, restartCode: cancel ? 130 : 1 })
      assert.equal(runner.calls.length, 1)
      assert.equal(replacement.spawnCount, 0)
      assert.equal(controller.signal.aborted, cancel)
      await assertReleased(profile)
      rmSync(updater.profilePackageDir(profile), { recursive: true, force: true })
    })
  }
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
            if (path !== join(updater.profilePackageDir(`cancel-${stage.replaceAll(' ', '-')}`), 'package.json')) return
            reads++
            if (stage === 'version verification' && reads === 1) controller.abort()
            if (stage === 'before launcher migration' && reads === 2) controller.abort()
          })
        },
      }])
      const profile = `cancel-${stage.replaceAll(' ', '-')}`
      const result = await updater.updateTuiAndRestart('fixture-session', profile, target, undefined, {}, controller.signal)
      assert.equal(controller.signal.aborted, true, 'the intended cancellation boundary was reached')
      cancelled(result, stage)
      assert.equal(runner.calls.length, 1, 'cancel prevents retry and repair')
      if (stage === 'before launcher migration') assert.equal(readFileSync(launcher, 'utf8'), 'old launcher')
      await assertReleased(profile)
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
