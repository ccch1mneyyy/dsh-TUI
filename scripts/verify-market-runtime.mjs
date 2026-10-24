/** Native profile preparation regressions; compile first for the existing installer runner. */
import assert from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { apply as applyLease } from '../src/dsh-adapter/market/lease.mjs'
import { managementModules, prepareInstalledRuntime, withRuntimeUpdate } from '../src/dsh-adapter/market/prepare.mjs'
import { digest, liveRuntimeProcesses, materializeRecipe, ownedDirectory, PACKAGE, packageDirectory, PROFILE, readJson, recipeDirectory, RUNTIME_BUNDLE, runtimeStatus } from '../src/dsh-adapter/market/runtime-profile.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-tui-market-runtime-'))
const put = async (path, content) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}
const home = join(scratch, 'home with spaces 中文')
const dir = join(home, 'profiles', PROFILE)
const packageRoot = packageDirectory(dir)
const version = '1.2.3'
const installAnchor = join(scratch, 'old-host', 'package.json')
const source = { home, cwd: root, installAnchor }
const runWithoutHost = () => promisify(execFile)(process.execPath, [join(root, 'src/dsh-adapter/market/cli.mjs')], {
  env: { ...process.env, DSH_HOME: home, PATH: '', Path: '' },
})
let writes = 0
const prepare = signal => prepareInstalledRuntime({
  source, version, signal,
  writeProfileManifest: async (directory, manifest) => { writes++; await put(join(directory, 'package.json'), manifest) },
})
const template = async patch => {
  await put(join(packageRoot, 'lib/tui-runtime/cordis.patch.yml'), patch)
  await put(join(packageRoot, 'lib/tui-runtime/package.json'), {
    name: RUNTIME_BUNDLE, version, dependencies: { [PACKAGE]: version },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, dshTui: { patchSha256: digest(patch) },
  })
}

try {
  let provided
  await applyLease({ get: () => undefined, provide: (name, value) => { provided = { name, value } },
    get baseUrl() { throw new Error('direct composition must not resolve profile modules') } })
  assert.deepEqual(provided, { name: 'tuiRuntimeLease', value: {} })
  await put(installAnchor, { type: 'module', bin: { dsh: 'cli.mjs' } })
  assert.equal(await managementModules(installAnchor, { optional: true }), undefined)
  await put(join(packageRoot, 'package.json'), {
    name: PACKAGE, version, main: 'lib/types/index.js', dshTui: { runtimeBundle: './lib/tui-runtime' },
  })
  for (const path of ['lib/types/index.js', 'lib/types/dsh-adapter/host-entry.js', 'bin/dsh-tui.js']) await put(join(packageRoot, path), '')
  await template('[]\n')
  const first = await materializeRecipe(dir, packageRoot)
  assert.equal(first, await materializeRecipe(dir, packageRoot), 'same inputs reuse the immutable recipe')
  assert.throws(() => recipeDirectory(dir, version, '../escape'), /digest is invalid/)
  assert.throws(() => recipeDirectory(dir, '../escape', digest('[]')), /exact release version/)

  await put(join(dir, 'package.json'), {
    name: 'user-profile', private: true, dependencies: { [PACKAGE]: version, 'user-bundle': '1.0.0' },
    scripts: { user: 'retained' }, dsh: { profile: { bundles: ['base', PACKAGE, 'user-bundle'], user: true } },
  })
  const userPatch = '- id: dsh-tui\n  config:\n    user: retained\n'
  await put(join(dir, 'cordis.patch.yml'), userPatch)
  await put(join(dirname(installAnchor), 'cli.mjs'), `
    import assert from 'node:assert/strict'
    import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
    import { join, dirname } from 'node:path'
    const [command, flag, profile, add, spec] = process.argv.slice(2)
    assert.deepEqual([command, flag, profile, add], ['plugin', '--profile', ${JSON.stringify(PROFILE)}, 'add'])
    assert.ok(spec.startsWith('file:'))
    const dir = join(process.env.DSH_HOME, 'profiles', profile)
    const installed = join(dir, 'node_modules', ${JSON.stringify(RUNTIME_BUNDLE)})
    await mkdir(dirname(installed), { recursive: true })
    await cp(spec.slice(5), installed, { recursive: true })
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.dependencies[${JSON.stringify(RUNTIME_BUNDLE)}] = spec
    if (!manifest.dsh.profile.bundles.includes(${JSON.stringify(RUNTIME_BUNDLE)})) manifest.dsh.profile.bundles.push(${JSON.stringify(RUNTIME_BUNDLE)})
    await writeFile(path, JSON.stringify(manifest))
    await appendFile(join(process.env.DSH_HOME, 'invocations'), 'installed\\n')
  `)
  assert.equal((await prepare()).ready, true)
  assert.equal(runtimeStatus(dir).ready, true)
  const installed = readJson(join(dir, 'package.json'))
  assert.deepEqual(installed.dsh.profile.bundles, ['base', RUNTIME_BUNDLE, 'user-bundle'])
  assert.equal(installed.scripts.user, 'retained')
  assert.equal(installed.dsh.profile.user, true)
  assert.equal(installed.dependencies['user-bundle'], '1.0.0')
  assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), userPatch)
  assert.equal((await prepare()).ready, true)
  assert.equal(writes, 1, 'a ready legacy profile does not rerun package operations')
  assert.equal(await readFile(join(home, 'invocations'), 'utf8'), 'installed\n')
  await runWithoutHost()
  assert.equal(writes, 1, 'a ready profile does not need host probing before backend fallback')

  await template('- id: rebuilt\n')
  assert.equal(runtimeStatus(dir).ready, false)
  await runWithoutHost()
  assert.equal(runtimeStatus(dir).ready, false, 'without a host, native preparation leaves the backend fallback in charge')
  assert.equal((await prepare()).ready, true, 'a same-version patch rebuild can be prepared')
  const second = runtimeStatus(dir).recipe
  assert.notEqual(second, first)
  assert.equal(await readFile(join(first, 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.equal(writes, 2)
  await applyLease({ get: () => ({ dir, installAnchor }), provide: (name, value) => { provided = { name, value } } })
  assert.deepEqual(provided, { name: 'tuiRuntimeLease', value: { profileDir: dir } })
  assert.equal(existsSync(join(ownedDirectory(dir), 'running.json')), false, 'legacy hosts without atomic APIs do not invent a managed lease')

  const acquire = async () => {
    let dispose
    await applyLease({ get: () => ({ dir, installAnchor: join(root, 'package.json') }), provide() {}, effect: register => { dispose = register() } })
    return dispose
  }
  const firstOwner = await acquire()
  const secondOwner = await acquire()
  assert.equal((await liveRuntimeProcesses(dir)).length, 2, 'two sessions in the same process have distinct leases')
  let mutations = 0
  await assert.rejects(withRuntimeUpdate(dir, () => { mutations++ }), /Close the other running TUI/)
  await firstOwner()
  await assert.rejects(withRuntimeUpdate(dir, () => { mutations++ }), /Close the other running TUI/)
  assert.equal(mutations, 0, 'disposing the updating session does not release another session')
  await secondOwner()
  assert.deepEqual(await liveRuntimeProcesses(dir), [])

  // Published installs may omit optional peers. After root disposal there is
  // no application resolver; the guard must use the actual host installation.
  const peerless = join(scratch, 'installed-without-peers')
  const native = join(peerless, 'src/dsh-adapter/market')
  const compiled = join(peerless, 'lib/types/dsh-adapter')
  await mkdir(native, { recursive: true })
  await mkdir(compiled, { recursive: true })
  await put(join(peerless, 'package.json'), { type: 'module' })
  for (const file of ['prepare.mjs', 'runtime-profile.mjs']) await copyFile(join(root, 'src/dsh-adapter/market', file), join(native, file))
  for (const file of ['host-dsh.js', 'host-contract.js', 'lite-profile.js', 'process-exit.js']) await copyFile(join(root, 'lib/types/dsh-adapter', file), join(compiled, file))
  assert.throws(() => createRequire(join(native, 'prepare.mjs')).resolve('@deepseek-ai/dsh-atomic-write'), { code: 'MODULE_NOT_FOUND' })
  const lockHost = join(scratch, 'host-with-atomic')
  await put(join(lockHost, 'package.json'), { name: '@deepseek-ai/dsh', type: 'module' })
  await put(join(lockHost, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '')
  await symlink(join(root, 'node_modules'), join(lockHost, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const originalPath = process.env.PATH
  process.env.PATH = join(lockHost, 'bin')
  try {
    const { withRuntimeUpdate: installedGuard } = await import(pathToFileURL(join(native, 'prepare.mjs')).href)
    assert.equal(await installedGuard(dir, () => {
      assert.equal(existsSync(join(ownedDirectory(dir), 'setup.json.lock')), true)
      return 'host lock held'
    }), 'host lock held')
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }

  // The marker dies with the real owner, even when its PID is later reused.
  const childFile = join(scratch, 'lease-child.mjs')
  await put(childFile, `
    import { apply } from ${JSON.stringify(pathToFileURL(join(root, 'src/dsh-adapter/market/lease.mjs')).href)}
    await apply({ get: () => (${JSON.stringify({ dir, installAnchor: join(root, 'package.json') })}), provide() {}, effect() {} })
    process.send('ready')
    setInterval(() => {}, 1000)
  `)
  const owner = fork(childFile, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let childError = ''
  owner.stderr.on('data', chunk => { childError += chunk })
  try {
    const ready = await Promise.race([
      once(owner, 'message'),
      once(owner, 'exit').then(([code]) => { throw new Error(`lease owner exited ${code}: ${childError}`) }),
    ])
    assert.deepEqual(ready, ['ready', undefined])
    const [entry] = await liveRuntimeProcesses(dir)
    assert.equal(entry.pid, owner.pid)
    await assert.rejects(withRuntimeUpdate(dir, () => { mutations++ }), /Close the other running TUI/)
    if (process.platform !== 'win32') {
      const manifestBeforePause = await readFile(join(dir, 'package.json'), 'utf8')
      let disposeWhilePaused
      owner.kill('SIGSTOP')
      try {
        await assert.rejects(withRuntimeUpdate(dir, () => { mutations++ }), /Cannot verify TUI process/)
        assert.equal(mutations, 0, 'a paused owner cannot authorize package writes')
        assert.deepEqual(readJson(join(ownedDirectory(dir), 'running.json')), [entry], 'a failed update leaves ownership records intact')
        disposeWhilePaused = await acquire()
        const running = readJson(join(ownedDirectory(dir), 'running.json'))
        assert.equal(running.length, 2, 'another session can register beside a paused owner')
        assert.deepEqual(running.find(record => record.token === entry.token), entry, 'registration preserves the unverified owner')
        await disposeWhilePaused()
        disposeWhilePaused = undefined
        assert.deepEqual(readJson(join(ownedDirectory(dir), 'running.json')), [entry], 'session exit removes only its own lease while another owner is paused')
        assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), manifestBeforePause, 'paused-owner checks and lease bookkeeping never change the profile manifest')
      } finally {
        owner.kill('SIGCONT')
        await disposeWhilePaused?.()
      }
      assert.deepEqual(await liveRuntimeProcesses(dir), [entry], 'a resumed owner is verifiable again')
      const resumedPeer = await acquire()
      await resumedPeer()
      assert.deepEqual(readJson(join(ownedDirectory(dir), 'running.json')), [entry], 'normal cleanup after resume retains the original session')
    }
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    // Recreate the dangerous state: the recorded PID exists, but its owner died.
    await put(join(ownedDirectory(dir), 'running.json'), [{ ...entry, pid: process.pid }])
    assert.deepEqual(await liveRuntimeProcesses(dir), [], 'a reused live PID cannot inherit a dead lease')
    const afterDeath = await acquire()
    const afterDeathRecords = readJson(join(ownedDirectory(dir), 'running.json'))
    assert.equal(afterDeathRecords.length, 1, 'lease bookkeeping still removes a confirmed dead owner')
    assert.notEqual(afterDeathRecords[0].token, entry.token)
    await afterDeath()
    assert.deepEqual(readJson(join(ownedDirectory(dir), 'running.json')), [])
    assert.equal(await withRuntimeUpdate(dir, () => ++mutations), 1)
    const unrelated = createServer(socket => { socket.on('error', () => {}); socket.end('different-owner\n') })
    await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve))
    try {
      await put(join(ownedDirectory(dir), 'running.json'), [{ ...entry, pid: process.pid, port: unrelated.address().port }])
      assert.deepEqual(await liveRuntimeProcesses(dir), [], 'even a reused live port must prove the original token')
    } finally { await new Promise(resolve => unrelated.close(resolve)) }
    const sockets = new Set()
    const silent = createServer(socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
    try {
      const unverified = { ...entry, pid: process.pid, port: silent.address().port }
      await put(join(ownedDirectory(dir), 'running.json'), [unverified])
      assert.deepEqual(await liveRuntimeProcesses(dir, { keepUnverified: true }), [unverified], 'bookkeeping retains a silent service instead of discarding uncertain ownership')
      await assert.rejects(withRuntimeUpdate(dir, () => { mutations++ }), /Cannot verify TUI process/)
      assert.equal(mutations, 1, 'a silent service still blocks package mutations')
      assert.deepEqual(readJson(join(ownedDirectory(dir), 'running.json')), [unverified])
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => silent.close(resolve))
    }
    await put(join(ownedDirectory(dir), 'running.json'), [{ pid: process.pid, token: 'old-pid-only-record' }])
    assert.deepEqual(await liveRuntimeProcesses(dir), [], 'unverifiable old PID-only records cannot lock a profile forever')
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL') }

  let releaseUpdate
  let enteredUpdate
  const entered = new Promise(resolve => { enteredUpdate = resolve })
  const hold = new Promise(resolve => { releaseUpdate = resolve })
  const updating = withRuntimeUpdate(dir, async () => { enteredUpdate(); await hold })
  await entered
  const abort = new AbortController()
  const cancelled = assert.rejects(withRuntimeUpdate(dir, () => { mutations++ }, abort.signal), /cancelled while locked/)
  abort.abort(new Error('cancelled while locked'))
  await cancelled
  let started = false
  const starting = acquire().then(dispose => { started = true; return dispose })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(started, false, 'a fresh TUI cannot lease the profile while its packages are being replaced')
  releaseUpdate()
  await updating
  const dispose = await starting
  assert.equal(mutations, 1, 'waiting cancellation never reaches the mutating operation')
  assert.equal((await liveRuntimeProcesses(dir)).length, 1)
  await template('- id: next-rebuild\n')
  await assert.rejects(prepare(), /Close the running TUI/)
  await dispose()
  assert.deepEqual(await liveRuntimeProcesses(dir), [])
  await assert.rejects(withRuntimeUpdate(dir, () => { throw new Error('install failed') }), /install failed/)
  assert.equal(existsSync(join(ownedDirectory(dir), 'setup.json.lock')), false, 'failure releases the startup lock')
  await assert.rejects(applyLease({ get: () => ({ dir, installAnchor: join(root, 'package.json') }), provide() {}, effect() {} }), /incomplete/)

  await put(join(dirname(installAnchor), 'cli.mjs'), 'process.exit(23)\n')
  await assert.rejects(prepare(), /exit 23/)
  assert.equal(writes, 2, 'a failed package command must not select the new runtime')
  assert.equal(runtimeStatus(dir).ready, false)
  const aborted = new AbortController()
  aborted.abort(new Error('cancelled before preparing'))
  await assert.rejects(prepare(aborted.signal), /cancelled before preparing/)
  assert.equal(writes, 2)
  await put(join(dirname(installAnchor), 'cli.mjs'), `
    import { writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    await writeFile(join(process.env.DSH_HOME, 'started'), '')
    setInterval(() => {}, 1000)
  `)
  const cancellation = new AbortController()
  const cancelling = assert.rejects(prepare(cancellation.signal), /exit 130/)
  const deadline = Date.now() + 10000
  try {
    while (!existsSync(join(home, 'started'))) {
      assert.ok(Date.now() < deadline, 'legacy installer must start before cancellation')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { cancellation.abort(new Error('cancel active preparation')) }
  await cancelling
  assert.equal(writes, 2, 'cancellation must not be reported as a prepared profile')
  assert.equal(runtimeStatus(dir).ready, false)
  console.log('market runtime OK (direct/legacy/managed leases, paused-owner bookkeeping, conservative update guards, content-addressed recipes, legacy layer ordering, warm reuse, install failure and cancellation)')
} finally { await rm(scratch, { recursive: true, force: true }) }
