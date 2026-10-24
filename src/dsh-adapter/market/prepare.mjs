/** Official package operations, isolated from the running application's Loader and events. */
import { mkdir, open, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import {
  compareVersions, liveRuntimeProcesses, materializeRecipe, ownedDirectory, PACKAGE,
  packageDirectory, PROFILE, readJson, RESCUE_PROFILE, RUNTIME_BUNDLE, runtimeBundleOrder,
  runtimeStatus, runtimeTemplate,
} from './runtime-profile.mjs'

/** Resolve public management APIs from the same installation that owns the caller. */
export async function managementModules(installAnchor, { optional = false } = {}) {
  const require = createRequire(installAnchor)
  let paths
  try {
    paths = [
      '@deepseek-ai/dsh-plugin-manager',
      '@deepseek-ai/dsh-plugin-manager/operations',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-typert-protocol',
    ].map(spec => require.resolve(spec))
  } catch (error) {
    if (optional && ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) return undefined
    throw error
  }
  const [manager, operations, atomic, typert] = await Promise.all(paths.map(path => import(pathToFileURL(path).href)))
  const available = typeof manager.default === 'function'
    && ['installBundle', 'setBundleEnabled', 'cancelInstall'].every(method => typeof manager.default.prototype?.[method] === 'function')
    && ['runPluginCommand', 'saveManifest'].every(method => typeof operations[method] === 'function')
    && ['withFileLock', 'writeFileAtomic'].every(method => typeof atomic[method] === 'function')
    && ['Remote', 'bindTypertRemote'].every(method => typeof typert[method] === 'function')
  if (!available) {
    if (optional) return undefined
    throw new Error('This DSH host does not expose the TUI profile management APIs; start with dsh-tui instead')
  }
  return { PluginManager: manager.default, ...operations, ...atomic }
}

/** The same exclusive-create protocol on hosts predating dsh-atomic-write. */
async function withLegacyFileLock(filename, operation, { signal, waitMs }) {
  const path = `${filename}.lock`
  const deadline = Date.now() + waitMs
  let handle
  while (handle === undefined) {
    signal?.throwIfAborted()
    try { handle = await open(path, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' && !(error.code === 'EPERM' && existsSync(path))) throw error
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for TUI profile preparation at ${path}; if its owner has exited, remove this stale lock and retry`)
      }
      // Never steal an old lock: a paused installer may still own its files.
      await delay(100, undefined, { signal })
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`)
    signal?.throwIfAborted()
    return await operation()
  } finally {
    try { await handle.close() }
    finally { await rm(path, { force: true }) }
  }
}

async function setupLock(installAnchor) {
  let atomicPath
  for (const anchor of [installAnchor, import.meta.url]) {
    if (anchor === undefined) continue
    try {
      atomicPath = createRequire(anchor).resolve('@deepseek-ai/dsh-atomic-write')
      break
    } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  }
  if (atomicPath === undefined && installAnchor === undefined) {
    // Optional peers need not be installed beside a published TUI. In /update
    // the application resolver has already been disposed; rescue never had it.
    // Resolve from the actual DSH CLI installation, as the runtime lease does.
    const { findHostDsh } = await import(new URL('../../../lib/types/dsh-adapter/host-dsh.js', import.meta.url).href)
    const found = findHostDsh()
    if (found.packageDir !== undefined) {
      try { atomicPath = createRequire(join(found.packageDir, 'package.json')).resolve('@deepseek-ai/dsh-atomic-write') }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
    }
  }
  const atomic = atomicPath === undefined ? undefined : await import(pathToFileURL(atomicPath).href)
  return typeof atomic?.withFileLock === 'function' ? atomic.withFileLock : withLegacyFileLock
}

async function withSetupLock(profileDir, operation, signal, lock) {
  signal?.throwIfAborted()
  const owned = ownedDirectory(profileDir)
  await mkdir(owned, { recursive: true, mode: 0o700 })
  return (lock ?? await setupLock())(join(owned, 'setup.json'), async () => {
    signal?.throwIfAborted()
    return operation()
  }, { signal, waitMs: 120000 })
}

function profileDirectory({ source, profile = PROFILE }) {
  if (profile !== PROFILE && profile !== RESCUE_PROFILE) throw new Error('Unsupported TUI profile')
  return join(source.home, 'profiles', profile)
}

/** Hold the startup lock before any package mutation, including retries and repair. */
export async function withRuntimeUpdate(profileDir, operation, signal) {
  return withSetupLock(profileDir, async () => {
    signal?.throwIfAborted()
    if ((await liveRuntimeProcesses(profileDir)).length > 0) {
      throw new Error('Close the other running TUI sessions before updating or rebuilding this profile')
    }
    signal?.throwIfAborted()
    let active = true
    const transaction = {
      async prepareInstalledRuntime(options) {
        if (!active) throw new Error('The TUI update transaction has already ended')
        if (options === undefined) {
          const installed = packageDirectory(profileDir)
          const manifest = readJson(join(installed, 'package.json'))
          if (manifest === undefined) throw new Error('Cannot find the installed TUI package after updating')
          if (manifest.dshTui?.runtimeBundle === undefined) return undefined
          const { manifest: target } = runtimeTemplate(installed)
          const { findHostDsh, loadHostProfileManagement } = await import(pathToFileURL(join(installed, 'lib/types/dsh-adapter/host-dsh.js')).href)
          const found = findHostDsh()
          if (found.packageDir === undefined) throw new Error(`Cannot prepare the updated TUI without its DSH host: ${found.reason}`)
          const host = await loadHostProfileManagement(found.packageDir)
          options = {
            ...host,
            source: { home: dirname(dirname(profileDir)), cwd: process.cwd(), installAnchor: join(found.packageDir, 'package.json') },
            version: target.version, profile: basename(profileDir),
          }
        }
        if (resolve(profileDirectory(options)) !== resolve(profileDir)) throw new Error('The TUI update transaction owns a different profile')
        return prepareInstalledRuntimeLocked({ ...options, signal: options.signal ?? signal }, profileDir)
      },
    }
    try { return await operation(transaction) }
    finally { active = false }
  }, signal)
}

/** Prepare an installed package without requiring the newer in-process host boot APIs. */
export async function prepareInstalledRuntime(options) {
  const dir = profileDirectory(options)
  options.signal?.throwIfAborted()
  return withSetupLock(dir, () => prepareInstalledRuntimeLocked(options, dir), options.signal, await setupLock(options.source.installAnchor))
}

async function prepareInstalledRuntimeLocked({ Context, Loader, writeProfileManifest, source, version, profile = PROFILE, signal }, dir) {
  signal?.throwIfAborted()
  const status = runtimeStatus(dir)
  if (status.ready && compareVersions(status.version, version) >= 0) return status
  const modules = await managementModules(source.installAnchor, { optional: true })
  if (modules !== undefined) {
    return prepareRuntimeLocked({ Context, Loader, source, version, profile, signal }, dir, modules)
  }
  // Older DSH exposes profile writers and its CLI, but not the market APIs.
  // Keep using its public package operation; only replace our bundle layer.
  if (status.version !== version) throw new Error('Install the matching TUI package before preparing this legacy profile')
  if ((await liveRuntimeProcesses(dir)).length > 0) throw new Error('Close the running TUI before preparing or updating its environment')
  const recipe = await materializeRecipe(dir, packageDirectory(dir))
  const hostManifest = readJson(source.installAnchor)
  const bin = typeof hostManifest?.bin === 'string' ? hostManifest.bin : hostManifest?.bin?.dsh
  if (typeof bin !== 'string') throw new Error('The installed DSH package has no CLI entry')
  const { runInstallerProcess } = await import(new URL('../../../lib/types/updateProcess.js', import.meta.url).href)
  const code = await runInstallerProcess(process.execPath, [join(dirname(source.installAnchor), bin), 'plugin', '--profile', profile, 'add', `file:${recipe}`], {
    category: 'tui-legacy-runtime', signal, env: { ...process.env, DSH_HOME: source.home },
    onStdout: text => process.stdout.write(text), onStderr: text => process.stderr.write(text),
  })
  if (code !== 0) throw new Error(`TUI runtime installation failed (exit ${code})`)
  signal?.throwIfAborted()
  const current = readJson(join(dir, 'package.json'))
  current.dsh.profile.bundles = runtimeBundleOrder(current.dsh?.profile?.bundles)
  await writeProfileManifest(dir, current)
  const prepared = runtimeStatus(dir)
  if (!prepared.ready) throw new Error(prepared.problem ?? 'The legacy TUI profile did not become ready')
  return prepared
}

function assertChange(result, stage) {
  if (result.application === 'failed' || result.application === 'cancelled') {
    const log = result.packageResult?.logPath
    throw new Error(`TUI ${stage} ${result.application}${log ? `; diagnostic log: ${log}` : ''}`)
  }
}

/**
 * Prepare one application-owned profile. The outer setup lock differs from the
 * official package.json lock: package operations must acquire the latter themselves.
 */
export async function prepareRuntime(options) {
  const dir = profileDirectory(options)
  const modules = await managementModules(options.source.installAnchor)
  return withSetupLock(dir, () => prepareRuntimeLocked(options, dir, modules), options.signal, modules.withFileLock)
}

async function prepareRuntimeLocked({ Context, Loader, source, version, profile = PROFILE, signal, registries, onPhase = () => {} }, dir, modules) {
  const target = {
    ...source, name: profile, dir, patchPath: join(dir, 'cordis.patch.yml'),
    startedBundles: [], overlays: [],
  }
  signal?.throwIfAborted()
  let status = runtimeStatus(dir)
  if (status.ready && compareVersions(status.version, version) >= 0) return status
  if (status.version !== undefined && compareVersions(status.version, version) > 0) {
    throw new Error('A newer TUI is installed but incomplete; repair it using that version instead of downgrading')
  }
  if ((await liveRuntimeProcesses(dir)).length > 0) throw new Error('Close the running TUI before preparing or updating its environment')
  const invocation = source.packageManager ?? { command: 'pnpm' }
  if (readJson(join(dir, 'package.json')) === undefined) {
    onPhase('initializing')
    signal?.throwIfAborted()
    const initialized = await modules.runPluginCommand({ ...target, profile }, ['--version'], {
      ...invocation, execution: 'service', outputBytes: 16384, signal,
      idleTimeoutMs: 600000, activateNewBundles: false,
    })
    if (initialized.exitCode !== 0) throw new Error(`Cannot initialize the TUI profile; diagnostic log: ${initialized.logPath}`)
  }
  const root = new Context()
  root.provide('profileContext', target)
  try {
    await root.plugin(Loader)
    await root.plugin(modules.PluginManager, {
      registry: registries?.registry ?? registries?.resolved ?? undefined,
      fallbackRegistries: registries?.fallbackRegistries ?? [],
    })
    const manager = root.get('pluginManager')
    const requestId = `dsh-tui-prepare-${process.pid}`
    const cancel = () => { void manager.cancelInstall(requestId).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      let complete = false
      try { complete = runtimeTemplate(packageDirectory(dir)).manifest.version === version } catch { /* install the compiled artifact */ }
      if (!complete) {
        onPhase('installing-runtime')
        signal?.throwIfAborted()
        const result = await manager.installBundle(`${PACKAGE}@${version}`, { requestId, saveExact: true })
        assertChange(result, 'runtime installation')
      } else {
        signal?.throwIfAborted()
        assertChange(await manager.setBundleEnabled(PACKAGE, true), 'runtime selection')
      }
      signal?.throwIfAborted()
      if (runtimeTemplate(packageDirectory(dir)).manifest.version !== version) throw new Error('The installed TUI runtime version does not match the requested release')
      onPhase('configuring')
      signal?.throwIfAborted()
      const recipe = await materializeRecipe(dir, packageDirectory(dir))
      signal?.throwIfAborted()
      // A stable file: dependency survives pruning or deleting node_modules.
      const manifest = readJson(join(dir, 'package.json'))
      const recorded = manifest.dependencies?.[RUNTIME_BUNDLE]
      const installed = readJson(join(dir, 'node_modules', ...RUNTIME_BUNDLE.split('/'), 'package.json'))
      if (installed?.version !== version || typeof recorded !== 'string'
        || !recorded.startsWith('file:') || resolve(dir, recorded.slice(5)) !== resolve(recipe)) {
        assertChange(await manager.installBundle(`file:${recipe}`, { requestId, saveExact: true }), 'profile configuration')
      }
      // Read again under the shared official writer lock, retaining every user field.
      await modules.withFileLock(join(dir, 'package.json'), async () => {
        signal?.throwIfAborted()
        const current = readJson(join(dir, 'package.json'))
        const previous = current.dsh?.profile?.bundles
        const next = runtimeBundleOrder(previous)
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          current.dsh.profile.bundles = next
          await modules.saveManifest(dir, current)
        }
      }, { signal, waitMs: 120000 })
      onPhase('verifying')
      signal?.throwIfAborted()
      // The official no-HMR branch composes the saved bundle/profile/home layers.
      assertChange(await manager.setBundleEnabled(RUNTIME_BUNDLE, true), 'configuration validation')
      status = runtimeStatus(dir)
      if (!status.ready || status.version !== version) throw new Error(status.problem ?? 'The TUI environment did not become ready')
      return status
    } finally { signal?.removeEventListener('abort', cancel) }
  } finally { await root.fiber.dispose() }
}
