/** Legacy preparation transactions without optional peers; local CLI fixtures, no network. */
import assert from 'node:assert/strict'
import { constants, existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-tui-legacy-lock-'))
const peerless = join(scratch, 'installed-package')
const host = join(scratch, 'legacy-host')
const home = join(scratch, 'home')
const dir = join(home, 'profiles/dsh-tui')
const lockFile = join(dir, '.dsh-tui/setup.json')
const originalPath = process.env.PATH
const shutdown = new AbortController()
const pending = []
let releaseOwner
const put = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
const copy = async (from, to) => { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to, constants.COPYFILE_EXCL) }
const track = promise => { pending.push(promise); void promise.catch(() => {}); return promise }
const waitFor = async condition => {
  const deadline = Date.now() + 30000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'the legacy CLI fixture must reach its checkpoint')
    await delay(20)
  }
}

try {
  await put(join(peerless, 'package.json'), { type: 'module' })
  for (const file of ['prepare.mjs', 'runtime-profile.mjs']) {
    await copy(join(root, 'src/dsh-adapter/market', file), join(peerless, 'src/dsh-adapter/market', file))
  }
  for (const file of [
    'updateProcess.js', 'windowsInstaller.js', 'utils/shellQuote.js',
    'dsh-adapter/host-dsh.js', 'dsh-adapter/host-contract.js', 'dsh-adapter/lite-profile.js', 'dsh-adapter/process-exit.js',
  ]) await copy(join(root, 'lib/types', file), join(peerless, 'lib/types', file))
  for (const file of ['windows-installer.ps1', 'windows-installer.cs']) await copy(join(root, 'assets', file), join(peerless, 'assets', file))
  const native = join(peerless, 'src/dsh-adapter/market')
  const { prepareRuntime, prepareInstalledRuntime, withRuntimeUpdate } = await import(pathToFileURL(join(native, 'prepare.mjs')).href)
  const { PACKAGE, RUNTIME_BUNDLE, digest, materializeRecipe, packageDirectory, readJson, runtimeBundleOrder, runtimeStatus } = await import(pathToFileURL(join(native, 'runtime-profile.mjs')).href)
  const packageRoot = packageDirectory(dir)
  const installAnchor = join(host, 'package.json')
  await put(installAnchor, { name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: 'cli.mjs' } })
  await put(join(host, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '')
  process.env.PATH = join(host, 'bin') + delimiter + (originalPath ?? '')
  for (const anchor of [installAnchor, join(native, 'prepare.mjs')]) {
    assert.throws(() => createRequire(anchor).resolve('@deepseek-ai/dsh-atomic-write'), { code: 'MODULE_NOT_FOUND' })
  }
  await put(join(host, 'cli.mjs'), `
    import assert from 'node:assert/strict'
    import { existsSync } from 'node:fs'
    import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
    import { dirname, join } from 'node:path'
    import { setTimeout as delay } from 'node:timers/promises'
    const [command, flag, profile, add, spec] = process.argv.slice(2)
    assert.deepEqual([command, flag, profile, add], ['plugin', '--profile', 'dsh-tui', 'add'])
    const home = process.env.DSH_HOME
    const dir = join(home, 'profiles', profile)
    assert.ok(existsSync(join(dir, '.dsh-tui/setup.json.lock')), 'the full legacy operation holds the shared setup lock')
    await appendFile(join(home, 'invocations'), spec + '\\n')
    if (existsSync(join(home, 'fail'))) process.exit(23)
    while (existsSync(join(home, 'hold'))) await delay(20)
    const installed = join(dir, 'node_modules', ${JSON.stringify(RUNTIME_BUNDLE)})
    await mkdir(dirname(installed), { recursive: true })
    await cp(spec.slice(5), installed, { recursive: true })
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.dependencies[${JSON.stringify(RUNTIME_BUNDLE)}] = spec
    if (!manifest.dsh.profile.bundles.includes(${JSON.stringify(RUNTIME_BUNDLE)})) manifest.dsh.profile.bundles.push(${JSON.stringify(RUNTIME_BUNDLE)})
    await writeFile(manifestPath, JSON.stringify(manifest))
  `)
  let version = '1.2.3'
  const template = async patch => {
    await put(join(packageRoot, 'package.json'), { name: PACKAGE, version, main: 'lib/types/index.js', dshTui: { runtimeBundle: './lib/tui-runtime' } })
    for (const file of ['lib/types/index.js', 'lib/types/dsh-adapter/host-entry.js', 'bin/dsh-tui.js']) await put(join(packageRoot, file), '')
    await put(join(packageRoot, 'lib/tui-runtime/cordis.patch.yml'), patch)
    await put(join(packageRoot, 'lib/tui-runtime/package.json'), {
      name: RUNTIME_BUNDLE, version, dependencies: { [PACKAGE]: version },
      dsh: { bundle: { patch: './cordis.patch.yml' } }, dshTui: { patchSha256: digest(patch) },
    })
  }
  const source = { home, cwd: root, installAnchor }
  const options = (signal = shutdown.signal, target = version) => ({ source, version: target, signal, writeProfileManifest: (dir, manifest) => put(join(dir, 'package.json'), manifest) })
  const prepare = (signal, target) => track(prepareInstalledRuntime(options(signal, target)))
  const invocations = async () => {
    try { return (await readFile(join(home, 'invocations'), 'utf8')).trim().split('\n').filter(Boolean).length }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  }
  await template('[]\n')
  await put(join(dir, 'package.json'), {
    dependencies: { [PACKAGE]: version, 'user-bundle': '1.0.0' }, custom: { retained: true },
    dsh: { profile: { bundles: ['base', PACKAGE, 'user-bundle'] } },
  })
  const userPatch = '# retained user patch\n'
  await put(join(dir, 'cordis.patch.yml'), userPatch)
  // Hold the first real child command while a second first launch contends.
  await put(join(home, 'hold'), '')
  const first = prepare()
  await waitFor(async () => await invocations() === 1)
  let secondFinished = false
  const second = prepare().then(value => { secondFinished = true; return value })
  await delay(150)
  assert.equal(secondFinished, false)
  assert.equal(await invocations(), 1, 'a second legacy launch cannot run a competing package command')
  await rm(join(home, 'hold'))
  assert.equal((await first).ready, true)
  assert.equal((await second).ready, true)
  assert.equal(await invocations(), 1, 'the waiter rereads readiness instead of reinstalling its recipe')
  assert.deepEqual(readJson(join(dir, 'package.json')).dsh.profile.bundles, ['base', RUNTIME_BUNDLE, 'user-bundle'])
  assert.deepEqual(readJson(join(dir, 'package.json')).custom, { retained: true })
  assert.equal(await readFile(join(dir, 'cordis.patch.yml'), 'utf8'), userPatch)

  // An official atomic holder must exclude the no-atomic legacy writer too.
  await template('- id: interrupted-rebuild\n')
  let entered
  const inside = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { releaseOwner = resolve })
  const official = track(withFileLock(lockFile, async () => { entered(); await held }, { waitMs: 0 }))
  await inside
  let staleFinished = false
  const stale = prepare(undefined, version).then(value => { staleFinished = true; return value })
  await delay(150)
  assert.equal(staleFinished, false)
  assert.equal(await invocations(), 1)
  version = '1.2.4'
  await template('- id: newer-runtime\n')
  const recipe = await materializeRecipe(dir, packageRoot)
  await cp(recipe, join(dir, 'node_modules', RUNTIME_BUNDLE), { recursive: true })
  const manifest = readJson(join(dir, 'package.json'))
  manifest.dependencies[PACKAGE] = version
  manifest.dependencies[RUNTIME_BUNDLE] = `file:${recipe}`
  manifest.dsh.profile.bundles = runtimeBundleOrder(manifest.dsh.profile.bundles)
  await put(join(dir, 'package.json'), manifest)
  assert.equal(runtimeStatus(dir).ready, true)
  releaseOwner()
  await official
  assert.equal((await stale).version, version, 'a stale request observes the newer committed runtime after acquiring the lock')
  assert.equal(await invocations(), 1)

  // Update owns the same lock; its explicit preparation capability does not reacquire it.
  await template('- id: update-rebuild\n')
  let escaped
  let competing
  let competingFinished = false
  await withRuntimeUpdate(dir, async transaction => {
    escaped = transaction
    await assert.rejects(withFileLock(lockFile, async () => assert.fail('official writer overlapped legacy update'), { waitMs: 0 }), /timed out waiting/)
    competing = prepare().then(value => { competingFinished = true; return value })
    await delay(150)
    assert.equal(competingFinished, false)
    assert.equal((await transaction.prepareInstalledRuntime(options())).ready, true)
    assert.equal(competingFinished, false)
    await assert.rejects(transaction.prepareInstalledRuntime({ ...options(), source: { ...source, home: join(scratch, 'other') } }), /different profile/)
  }, shutdown.signal)
  assert.equal((await competing).ready, true)
  assert.equal(await invocations(), 2)
  await assert.rejects(escaped.prepareInstalledRuntime(options()), /already ended/)

  // A cancelled waiter never deletes or enters another writer's lock, even if its record is stale.
  await put(`${lockFile}.lock`, '2147483647\n')
  const cancel = new AbortController()
  const cancelled = assert.rejects(prepare(cancel.signal), /abort/i)
  await delay(150)
  cancel.abort()
  await cancelled
  assert.equal(await readFile(`${lockFile}.lock`, 'utf8'), '2147483647\n')
  assert.equal(await invocations(), 2)
  await rm(`${lockFile}.lock`)

  // A failed package process releases the transaction and never reports readiness.
  await template('- id: failed-rebuild\n')
  await put(join(home, 'fail'), '')
  await assert.rejects(prepare(), /exit 23/)
  assert.equal(existsSync(`${lockFile}.lock`), false)
  assert.equal(runtimeStatus(dir).ready, false)
  await rm(join(home, 'fail'))
  assert.equal((await prepare()).ready, true)
  assert.equal(existsSync(`${lockFile}.lock`), false)

  // Use the real modern module/lock APIs with a Context seam to observe writes
  // cancelled during plugin startup, recipe I/O, or the final verification phase.
  for (const point of ['plugins', 'recipe', 'verifying']) {
    await template(`- id: cancelled-at-${point}\n`)
    const cancellation = new AbortController()
    const mutations = []
    let plugins = 0
    class Context {
      fiber = { dispose: async () => {} }
      provide() {}
      async plugin() { if (++plugins === 2 && point === 'plugins') cancellation.abort() }
      get() {
        const changed = target => { mutations.push({ target, aborted: cancellation.signal.aborted }); return { application: 'applied' } }
        return { cancelInstall: async () => {}, setBundleEnabled: async name => changed(name), installBundle: async spec => changed(spec) }
      }
    }
    await assert.rejects(prepareRuntime({
      Context, Loader: {}, source: { ...source, installAnchor: join(root, 'package.json') }, version, signal: cancellation.signal,
      onPhase: phase => {
        if (point === 'recipe' && phase === 'configuring') setImmediate(() => cancellation.abort())
        if (point === 'verifying' && phase === 'verifying') cancellation.abort()
      },
    }), { name: 'AbortError' })
    assert.equal(mutations.filter(mutation => mutation.aborted).length, 0, `${point}: cancellation precedes the next package mutation`)
    assert.equal(existsSync(`${lockFile}.lock`), false)
  }
  await put(join(packageRoot, 'package.json'), { name: PACKAGE, version })
  assert.equal(await withRuntimeUpdate(dir, transaction => transaction.prepareInstalledRuntime()), undefined, 'pre-market updates need no private runtime')
  console.log('legacy setup lock OK (no optional peers, concurrent preparation, official-lock interoperability, stale-version reread, nested preparation, cancellation boundaries and failure cleanup)')
} finally {
  shutdown.abort()
  releaseOwner?.()
  await rm(join(home, 'hold'), { force: true })
  await Promise.allSettled(pending)
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await rm(scratch, { recursive: true, force: true })
}
