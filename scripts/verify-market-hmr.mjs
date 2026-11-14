/**
 * First direct-profile startup through real official HMR, Loader and package
 * management. Preinstalled tiny bundles keep this bounded and network-free.
 * Run: node --expose-internals scripts/verify-market-hmr.mjs
 */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import * as ProfileManager from '../src/dsh-adapter/market/manager.mjs'
import { digest, materializeRecipe, PACKAGE, PROFILE, RUNTIME_BUNDLE, runtimeStatus } from '../src/dsh-adapter/market/runtime-profile.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
// Resolve the real public management APIs without requiring a global dsh CLI.
const installAnchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-plugin-manager/package.json')
const scratch = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-tui-market-hmr-')))
const language = process.env.DSH_TUI_LANG
const report = process.stderr.write.bind(process.stderr)
const watchdog = setTimeout(() => {
  report('market HMR verification exceeded its 30 second deadline\n')
  process.exit(1)
}, 30000)
const put = async (filename, value) => {
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
const waitFor = async condition => {
  const deadline = Date.now() + 10000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'direct-profile startup must mount the runtime or report the required restart')
    await delay(10)
  }
}

async function scenario(mode) {
  const home = join(scratch, mode)
  const dir = join(home, 'profiles', PROFILE)
  const packageRoot = join(dir, 'node_modules', PACKAGE)
  const runtimeRoot = join(dir, 'node_modules', RUNTIME_BUNDLE)
  initProfile(dir, [PACKAGE])
  await put(join(dir, 'cordis.yml'), '[]\n')
  await put(join(dir, 'cordis.patch.yml'), '[]\n')
  await put(join(packageRoot, 'package.json'), {
    name: PACKAGE, version: '1.0.0', type: 'module', main: './lib/types/index.js',
    dependencies: { 'fixture-helper': '1.0.0' },
    dsh: { bundle: { patch: './market.patch.yml' } }, dshTui: { runtimeBundle: './lib/tui-runtime' },
  })
  await put(join(packageRoot, 'market.patch.yml'), [{ insert: [
    { id: 'dsh-tui-profile-manager', name: 'cordis:market-manager', inject: ['loader'] },
  ] }])
  await put(join(packageRoot, 'node_modules/fixture-helper/package.json'), { name: 'fixture-helper', version: '1.0.0', main: './index.js' })
  await put(join(packageRoot, 'node_modules/fixture-helper/index.js'), 'module.exports = 1\n')
  for (const file of ['lib/types/index.js', 'lib/types/dsh-adapter/host-entry.js', 'bin/dsh-tui.js']) {
    await put(join(packageRoot, file), 'export {}\n')
  }
  const patch = JSON.stringify([{ insert: [{ id: 'runtime-probe', name: 'cordis:runtime-probe' }] }])
  await put(join(packageRoot, 'lib/tui-runtime/cordis.patch.yml'), patch)
  await put(join(packageRoot, 'lib/tui-runtime/package.json'), {
    name: RUNTIME_BUNDLE, version: '1.0.0', dependencies: { [PACKAGE]: '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, dshTui: { patchSha256: digest(patch) },
  })
  const recipe = await materializeRecipe(dir, packageRoot)
  await cp(recipe, runtimeRoot, { recursive: true })
  // A tarball public install and a registry dependency can have identical
  // versions at different paths. The retained helper mapping then moves too.
  if (mode === 'package-moved') await cp(packageRoot, join(runtimeRoot, 'node_modules', PACKAGE), { recursive: true })
  await put(join(dir, 'package.json'), {
    name: 'hmr-fixture-profile', private: true,
    dependencies: { [PACKAGE]: '1.0.0', [RUNTIME_BUNDLE]: `file:${recipe}` },
    dsh: { profile: { bundles: [PACKAGE] } },
  })
  const profile = loadProfileDirectory('dsh', dir, installAnchor)
  const source = { name: PROFILE, dir, home, cwd: root, patchPath: profile.patchPath, installAnchor, startedBundles: [PACKAGE], overlays: [] }
  const resolution = await createRuntimeResolution({ installAnchor, profile, home })
  const callbacks = new Set()
  let committed = false
  let mounted = false
  let exitCode
  let insideExclusive = false
  const preparationPhases = []
  const reconciled = []
  let diagnostics = ''
  let ctx
  const stderr = process.stderr.write
  process.env.DSH_TUI_LANG = mode === 'pending' ? 'zh' : 'en'
  process.stderr.write = (chunk, encoding, callback) => {
    diagnostics += String(chunk)
    if (typeof encoding === 'function') encoding()
    else callback?.()
    return true
  }
  try {
    ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', source, profile), async host => {
      host.provide('profileContext', source)
      host.provide('appReady', { onReady(callback) {
        if (committed) { callback(); return () => {} }
        callbacks.add(callback)
        return () => callbacks.delete(callback)
      } })
      host.provide('appExit', code => { exitCode = code })
      host.on('tui-profile/state', state => { preparationPhases.push({ phase: state.phase, insideExclusive }) })
      host.loader.builtins['market-manager'] = ProfileManager
      host.loader.builtins['runtime-probe'] = { apply() { mounted = true } }
      await host.plugin(PluginPackages, { resolution })
      await host.plugin(Timer)
      await host.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    })
    const hmr = ctx.get('hmr')
    const exclusive = hmr.runExclusive.bind(hmr)
    hmr.runExclusive = operation => exclusive(async () => {
      insideExclusive = true
      try { return await operation() }
      finally { insideExclusive = false }
    })
    const reconcile = hmr.reconcileProfile.bind(hmr)
    hmr.reconcileProfile = async (...args) => {
      const prepared = runtimeStatus(dir).ready
      const result = await reconcile(...args)
      if (!prepared) return result
      // Only the pending outcome is a seam: the actual recomposition has
      // already removed/disposed the manager and mounted the runtime probe.
      if (mode === 'pending') {
        assert.equal(ctx.get('tuiProfileManager'), undefined)
        result.pending.push({ url: pathToFileURL(join(packageRoot, 'index.mjs')).href, reason: 'module-comparison' })
      }
      reconciled.push(result)
      return result
    }
    assert.equal(runtimeStatus(dir).ready, false)
    committed = true
    for (const callback of [...callbacks]) callback()
    callbacks.clear()
    await waitFor(() => exitCode !== undefined || (mode === 'same-path' && reconciled.length > 0 && mounted))
    assert.ok(reconciled.length > 0, `preparation must reach reconciliation: ${diagnostics}`)
    assert.equal(runtimeStatus(dir).ready, true)
    assert.ok(preparationPhases.some(state => state.phase === 'configuring'))
    assert.ok(preparationPhases.every(state => state.insideExclusive), 'the whole preparation runs inside HMR exclusivity')
    if (mode === 'same-path') {
      assert.equal(exitCode, undefined)
      assert.equal(ctx.get('tuiProfileManager'), undefined, 'successful recomposition disposes the old manager without deadlocking')
      assert.equal(reconciled[0].restartReason, undefined)
      assert.deepEqual(reconciled[0].pending, [])
      assert.equal(diagnostics, '')
    } else {
      assert.equal(exitCode, 1, 'a restart requirement must terminate the empty first launch')
      assert.equal(mounted, mode === 'pending')
      if (mode === 'package-moved') assert.equal(reconciled[0].restartReason, 'package-moved')
      assert.match(diagnostics, /DSH_HOME/)
      assert.ok(diagnostics.includes(`dsh --profile ${PROFILE}`))
      assert.match(diagnostics, mode === 'pending' ? /需要重启.*module-comparison/ : /requires a restart.*package-moved/)
    }
  } finally {
    try { await ctx?.fiber.dispose() }
    finally { process.stderr.write = stderr }
  }
  console.log(`PASS: direct-profile HMR ${mode}`)
}

try {
  for (const mode of ['same-path', 'package-moved', 'pending']) await scenario(mode)
} finally {
  clearTimeout(watchdog)
  if (language === undefined) delete process.env.DSH_TUI_LANG
  else process.env.DSH_TUI_LANG = language
  await rm(scratch, { recursive: true, force: true })
}
