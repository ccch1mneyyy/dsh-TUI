/**
 * End-to-end engine alignment regression for #1844 part 2 (real compiled lib,
 * real child processes, a fake registry via global fetch, a fake npm):
 *
 * - resolveUpdatePlan() reads the target TUI's enumerated dsh range, picks the
 *   highest PUBLISHED version in it, never the alpha line, and never downgrades
 *   an engine ahead of the window;
 * - a TUI that is already latest does NOT short-circuit: the plan still carries
 *   the engine step (constraint #2) and the launcher step (constraint #3);
 * - updateTui() installs the engine through runInstallerProcess with the
 *   detected npm prefix, re-reads the manifest and reports verified;
 * - an engine failure is non-fatal when the current combination is still in
 *   range, and a blocked plan (new TUI + engine outside its line) never starts
 *   an installer nor restarts;
 * - the offline/idle and disabled paths degrade without inventing versions.
 *
 * Run after a build: node scripts/verify-update-host.mjs
 * No network, no real profile, no real global prefix.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'verify-update-host-'))
const HOME_BACKUP = process.env.HOME
const USERPROFILE_BACKUP = process.env.USERPROFILE
const DSH_HOME_BACKUP = process.env.DSH_HOME
const PATH_BACKUP = process.env.PATH
const REGISTRY_BACKUP = process.env.NPM_CONFIG_REGISTRY
const LAUNCHER_PATH_BACKUP = process.env.DSH_TUI_LAUNCHER_PATH
const LAUNCHER_VERSION_BACKUP = process.env.DSH_TUI_LAUNCHER_VERSION
const ENGINE_SWITCH_BACKUP = process.env.DSH_TUI_UPDATE_ENGINE
const LAUNCHER_SWITCH_BACKUP = process.env.DSH_TUI_UPDATE_LAUNCHER
const originalFetch = globalThis.fetch

const repoVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const RANGE = '0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// Redirect before importing the compiled module: utils/paths.js resolves
// DATA_DIR from the home dir at import time.
const fakeHome = join(root, 'home')
mkdirSync(fakeHome, { recursive: true })
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_HOME = join(root, 'dsh-home')

const update = await import('../lib/types/update.js')

/** Lay out one fake npm global prefix with a dsh package at `version`. */
function makeHostPrefix(name, version) {
  const prefix = join(root, name)
  const packageDir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  return { prefix, packageDir }
}

/** A fake npm that "installs" by rewriting the target manifest. */
function makeFakeNpm(name, behaviour) {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  const calls = join(bin, 'calls.jsonl')
  writeFileSync(join(bin, 'behaviour.json'), JSON.stringify(behaviour))
  writeFileSync(join(bin, 'fake-npm.mjs'), `
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const dir = ${JSON.stringify(bin)}
const args = process.argv.slice(2)
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')
const behaviour = JSON.parse(readFileSync(join(dir, 'behaviour.json'), 'utf8'))
if (behaviour.destroy === true) {
  const prefixIndex = args.indexOf('--prefix')
  const prefix = prefixIndex === -1 ? undefined : args[prefixIndex + 1]
  if (prefix !== undefined) rmSync(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true, force: true })
  process.exit(behaviour.exit ?? 1)
}
if (behaviour.exit !== 0) process.exit(behaviour.exit)
if (behaviour.noop === true) process.exit(0)
const prefixIndex = args.indexOf('--prefix')
const prefix = prefixIndex === -1 ? undefined : args[prefixIndex + 1]
const spec = args.at(-1) ?? ''
const version = spec.slice(spec.lastIndexOf('@') + 1)
if (prefix === undefined) process.exit(2)
const manifest = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
`)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), '@echo off\r\nnode "%~dp0fake-npm.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n')
  } else {
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec node ${JSON.stringify(join(bin, 'fake-npm.mjs'))} "$@"\n`)
    chmodSync(join(bin, 'npm'), 0o755)
  }
  return { bin, calls }
}

/**
 * Lay out pnpm 11's global project the way pnpm really does: the global
 * `node_modules/@deepseek-ai/dsh` symlink points into a VERSION-PINNED
 * `.pnpm/@deepseek-ai+dsh@<ver>/...` directory. The realpath therefore embeds
 * the version — the reason verification must not read the pre-install dir.
 */
function makePnpmPrefix(name, version) {
  const home = join(root, name)
  const globalNodeModules = join(home, 'global', '5', 'node_modules')
  const pinned = join(globalNodeModules, '.pnpm', `@deepseek-ai+dsh@${version}`, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pinned, { recursive: true })
  writeFileSync(join(pinned, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  const link = join(globalNodeModules, '@deepseek-ai', 'dsh')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(pinned, link, process.platform === 'win32' ? 'junction' : 'dir')
  return { home, packageDir: link, pinned }
}

/**
 * A fake pnpm that "installs" into `$PNPM_HOME/global/5/node_modules` and
 * prunes the previous version-pinned `.pnpm` directory, like a real global
 * upgrade re-pointing the symlink and cleaning the old store entry.
 */
function makeFakePnpm(name) {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  const calls = join(bin, 'calls.jsonl')
  writeFileSync(join(bin, 'fake-pnpm.mjs'), `
import { appendFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const dir = ${JSON.stringify(bin)}
const args = process.argv.slice(2)
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, pnpmHome: process.env.PNPM_HOME ?? null }) + '\\n')
const spec = args.at(-1) ?? ''
const version = spec.slice(spec.lastIndexOf('@') + 1)
const home = process.env.PNPM_HOME
if (!home) process.exit(3)
const globalNodeModules = join(home, 'global', '5', 'node_modules')
const link = join(globalNodeModules, '@deepseek-ai', 'dsh')
let previous
try { previous = realpathSync(link) } catch {}
const pinned = join(globalNodeModules, '.pnpm', '@deepseek-ai+dsh@' + version, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(pinned, { recursive: true })
writeFileSync(join(pinned, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
rmSync(link, { force: true })
symlinkSync(pinned, link, ${JSON.stringify(process.platform === 'win32' ? 'junction' : 'dir')})
// Prune the old version-pinned directory (real pnpm drops it from the store).
if (previous !== undefined && previous !== pinned) {
  try { rmSync(dirname(dirname(dirname(previous))), { recursive: true, force: true }) } catch {}
}
`)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0fake-pnpm.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n')
  } else {
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexec node ${JSON.stringify(join(bin, 'fake-pnpm.mjs'))} "$@"\n`)
    chmodSync(join(bin, 'pnpm'), 0o755)
  }
  return { bin, calls }
}

/**
 * A fake `dsh` that must never run the profile installer for an engine-only
 * plan. `--version` is the post-install PATH cross-check, not a profile
 * install: answer it with `reportedVersion` and leave the marker alone.
 */
function makeFakeDsh(name, reportedVersion = '0.2.1-rc.5') {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  const marker = join(bin, 'called')
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'dsh.cmd'), '@echo off\r\nif "%1"=="--version" (\r\n  echo dsh ' + reportedVersion + '\r\n  exit /b 0\r\n)\r\necho dsh>>"' + marker + '"\r\nexit /b 0\r\n')
  } else {
    writeFileSync(join(bin, 'dsh'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "dsh ${reportedVersion}"; exit 0; fi\necho dsh >> "${marker}"\nexit 0\n`)
    chmodSync(join(bin, 'dsh'), 0o755)
  }
  return { bin, marker }
}

function readCalls(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

const versionsByUrl = new Map()
const fetchUrls = []
function installFakeRegistry(routes) {
  versionsByUrl.clear()
  fetchUrls.length = 0
  for (const [suffix, body] of Object.entries(routes)) versionsByUrl.set(suffix, body)
  globalThis.fetch = async url => {
    const text = String(url)
    fetchUrls.push(text)
    for (const [suffix, body] of versionsByUrl) {
      if (text.endsWith(suffix)) return Response.json(body)
    }
    return new Response('not found', { status: 404 })
  }
}

function withEnv(overrides, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

try {
  // ---- 1. TUI already latest: engine + launcher steps are still planned ----
  const host14 = makeHostPrefix('prefix-a', '0.2.1-rc.4')
  const fakeDsh = makeFakeDsh('fake-dsh-a')
  const npmOk = makeFakeNpm('fake-npm-a', { exit: 0 })
  process.env.PATH = `${fakeDsh.bin}${delimiter}${npmOk.bin}${delimiter}${PATH_BACKUP}`
  installFakeRegistry({
    '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
    '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.3': {}, '0.2.1-rc.4': {}, '0.2.1-rc.5': {}, '0.2.2-alpha.2': {} } },
  })
  await withEnv({ NPM_CONFIG_REGISTRY: 'https://fixture.invalid' }, async () => {
    const plan = await update.resolveUpdatePlan({
      hostPackageDir: host14.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: TUI already latest is not a short-circuit', plan.tui.kind === 'latest' && plan.host.kind === 'install', JSON.stringify(plan.host))
    check('plan: engine target is the highest published in range', plan.host.kind === 'install' && plan.host.to === '0.2.1-rc.5')
    check('plan: unvalidated alpha is never selected', plan.host.kind === 'install' && plan.host.to !== '0.2.2-alpha.2')
    check('plan: engine command pins the detected npm prefix', plan.host.kind === 'install'
      && plan.host.command.file === 'npm'
      && plan.host.command.args.includes(host14.prefix)
      && plan.host.command.args.at(-1) === '@deepseek-ai/dsh@0.2.1-rc.5')
    check('plan: compatible after the planned install', plan.compatible === true && plan.blocked === false)
    check('plan: state is ready, layers name the TUI + engine', update.updatePlanState(plan) === 'ready'
      && update.updatePlanLayers(plan).some(layer => layer.startsWith('dsh 0.2.1-rc.4 → 0.2.1-rc.5')))
    // The target IS the installed TUI, so its range comes from the local
    // manifest: no second TUI-manifest request may be made.
    check('plan: installed TUI range is read locally, not refetched', !fetchUrls.some(url => url.includes(`/@deepseek-harness-tui/dsh-tui/${repoVersion}`)), fetchUrls.join(' '))

    // ---- 2. Engine execution through the real installer path ----
    const outcome = await update.updateTui('fixture-profile', plan)
    const calls = readCalls(npmOk.calls)
    check('execute: engine install ran with the planned argv', calls.length === 1 && calls[0].at(-1) === '@deepseek-ai/dsh@0.2.1-rc.5', JSON.stringify(calls))
    check('execute: manifest advanced and verified', outcome.code === 0 && outcome.host?.code === 0 && outcome.host?.verified === true
      && outcome.host?.installed === '0.2.1-rc.5' && outcome.host?.to === '0.2.1-rc.5', JSON.stringify(outcome.host))
    check('execute: TUI already latest means no pnpm installer', !existsSync(fakeDsh.marker), 'fake dsh was invoked')
    check('execute: suite reported compatible and the TUI stamp is not armed', outcome.compatible === true && outcome.tuiChanged === false)

    // ---- 2b. pnpm global layout: the manager-driven path ----
    const pnpmPrefix = makePnpmPrefix('pnpm-prefix-a', '0.2.1-rc.4')
    const fakePnpm = makeFakePnpm('fake-pnpm-a')
    process.env.PNPM_HOME = pnpmPrefix.home
    process.env.PATH = `${fakeDsh.bin}${delimiter}${fakePnpm.bin}${delimiter}${PATH_BACKUP}`
    const pnpmPlan = await update.resolveUpdatePlan({
      hostPackageDir: pnpmPrefix.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: pnpm global layout plans pnpm add -g with PNPM_HOME', pnpmPlan.host.kind === 'install'
      && pnpmPlan.host.command.file === 'pnpm'
      && pnpmPlan.host.command.env?.PNPM_HOME === pnpmPrefix.home
      && pnpmPlan.host.command.args.join(' ') === 'add -g @deepseek-ai/dsh@0.2.1-rc.5', JSON.stringify(pnpmPlan.host))
    const pnpmOutcome = await update.updateTui('fixture-profile', pnpmPlan)
    const pnpmCalls = readCalls(fakePnpm.calls)
    check('execute: pnpm install runs in the detected PNPM_HOME', pnpmCalls.length === 1
      && pnpmCalls[0].pnpmHome === pnpmPrefix.home && pnpmCalls[0].args.join(' ') === 'add -g @deepseek-ai/dsh@0.2.1-rc.5', JSON.stringify(pnpmCalls))
    const newPinned = join(pnpmPrefix.home, 'global', '5', 'node_modules', '.pnpm', '@deepseek-ai+dsh@0.2.1-rc.5', 'node_modules', '@deepseek-ai', 'dsh')
    check('execute: pnpm upgrade re-points and prunes the version-pinned dir', !existsSync(pnpmPrefix.pinned) && existsSync(newPinned))
    check('execute: pnpm install verified despite the pruned pre-install realpath', pnpmOutcome.code === 0
      && pnpmOutcome.host?.verified === true && pnpmOutcome.host?.installed === undefined, JSON.stringify(pnpmOutcome.host))
    check('execute: pnpm install never touched npm', readCalls(npmOk.calls).length === 1)
    delete process.env.PNPM_HOME

    // ---- 2b2. fresh post-install resolution: both profile layouts ----
    // import.meta.resolve caches for the process, so verification must read
    // these paths from disk: the profile's own node_modules first, then the
    // shared `<DSH_HOME>/profiles/node_modules` fallback beside the profile.
    const freshRoot = join(root, 'fresh-layout')
    const freshProfile = join(freshRoot, 'profiles', 'dsh-tui')
    const freshTui = join(freshProfile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    const writeHostPkg = (dir, version) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    }
    mkdirSync(freshTui, { recursive: true })
    writeFileSync(join(freshTui, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: repoVersion }))
    const ownHost = join(freshProfile, 'node_modules', '@deepseek-ai', 'dsh')
    writeHostPkg(ownHost, '0.2.1-rc.4')
    check('fresh resolve: the profile-local host wins',
      update.installedKernelDirFresh(freshTui) === realpathSync(ownHost),
      String(update.installedKernelDirFresh(freshTui)))
    rmSync(join(freshProfile, 'node_modules', '@deepseek-ai'), { recursive: true, force: true })
    const sharedHost = join(freshRoot, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
    writeHostPkg(sharedHost, '0.2.1-rc.5')
    check('fresh resolve: the shared profiles/node_modules tree is the fallback',
      update.installedKernelDirFresh(freshTui) === realpathSync(sharedHost),
      String(update.installedKernelDirFresh(freshTui)))
    rmSync(sharedHost, { recursive: true, force: true })
    check('fresh resolve: no host in either layout is undefined',
      update.installedKernelDirFresh(freshTui) === undefined
        && update.installedKernelDirFresh(undefined) === undefined)

    // ---- 2c. verification terms: refreshed resolution, PATH, manifest ----
    // installHostStep is driven directly so each term can be injected; the
    // pre-install manifest stays at rc.4 (or is pruned), which is exactly the
    // pnpm shape the gate must not trust.
    const hostC = makeHostPrefix('prefix-c', '0.2.1-rc.4')
    const npmNoop = makeFakeNpm('fake-npm-c', { exit: 0, noop: true })
    const stepC = {
      kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: hostC.packageDir,
      command: { file: 'npm', args: ['install', '-g', '--prefix', hostC.prefix, '@deepseek-ai/dsh@0.2.1-rc.5'] },
      manual: [`npm install -g --prefix ${hostC.prefix} @deepseek-ai/dsh@0.2.1-rc.5`],
    }
    const runStep = resolveInstalled => update.installHostStep(stepC, {
      env: process.env, onCleanupError: () => {}, ...(resolveInstalled === undefined ? {} : { resolveInstalled }),
    })
    process.env.PATH = `${fakeDsh.bin}${delimiter}${npmNoop.bin}${delimiter}${PATH_BACKUP}`
    const resolvedNew = await runStep(() => '0.2.1-rc.5')
    check('verify: refreshed resolution + matching PATH verifies', resolvedNew.verified === true && resolvedNew.cliVersion === '0.2.1-rc.5')
    const resolvedStale = await runStep(() => '0.2.1-rc.4')
    check('verify: stale post-install resolution fails even when PATH reports the target', resolvedStale.verified === false)
    const wrongCli = makeFakeDsh('fake-dsh-c', '0.2.1-rc.4')
    process.env.PATH = `${wrongCli.bin}${delimiter}${npmNoop.bin}${delimiter}${PATH_BACKUP}`
    const cliMismatch = await runStep(() => '0.2.1-rc.5')
    check('verify: a PATH still running the old dsh fails verification', cliMismatch.verified === false && cliMismatch.cliVersion === '0.2.1-rc.4')
    // No dsh on PATH at all: the explicit manifest read is the last gate.
    process.env.PATH = `${npmNoop.bin}${delimiter}${dirname(process.execPath)}`
    const manifestOld = await runStep(undefined)
    check('verify: manifest fallback refuses a no-op install', manifestOld.verified === false && manifestOld.cliVersion === undefined)
    const npmAdvance = makeFakeNpm('fake-npm-d', { exit: 0 })
    process.env.PATH = `${npmAdvance.bin}${delimiter}${dirname(process.execPath)}`
    const manifestNew = await runStep(undefined)
    check('verify: manifest fallback accepts a real advance', manifestNew.verified === true)

    // ---- 3. Engine failure: compatible → keep going, incompatible → stop ----
    const host14b = makeHostPrefix('prefix-b', '0.2.1-rc.4')
    const npmFail = makeFakeNpm('fake-npm-b', { exit: 1 })
    process.env.PATH = `${npmFail.bin}${delimiter}${PATH_BACKUP}`
    const failingPlan = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    const tolerated = await update.updateTui('fixture-profile', failingPlan)
    check('execute: compatible engine failure keeps the update restartable', tolerated.code === 0 && tolerated.host?.code === 1 && tolerated.host?.verified === false)
    check('execute: failure outcome names the repair command', tolerated.host?.manual.includes('npm install -g --prefix'))

    // ---- 4. Blocked plan: never touch an installer or the TUI ----
    const callsBeforeRefusal = readCalls(npmFail.calls).length
    const blockedPlan = { ...failingPlan, blocked: true, compatible: false }
    const refused = await update.updateTui('fixture-profile', blockedPlan)
    check('execute: a blocked plan refuses before any installer', refused.code === 1 && refused.compatible === false)
    check('execute: blocked plan ran no npm call', readCalls(npmFail.calls).length === callsBeforeRefusal, JSON.stringify(readCalls(npmFail.calls)))

    // ---- 5. Offline engine lookup degrades to idle, not empty ----
    globalThis.fetch = async url => {
      const text = String(url)
      fetchUrls.push(text)
      if (text.endsWith('/@deepseek-harness-tui/dsh-tui/latest')) return Response.json({ version: repoVersion })
      throw new Error('offline')
    }
    const offline = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: offline engine lookup is unavailable/offline', offline.host.kind === 'unavailable' && offline.host.reason === 'offline')
    check('plan: TUI latest + offline engine is idle, not falsely empty', update.updatePlanState(offline) === 'idle')
    check('plan: a direct dsh --profile launch has no launcher step, not an unresolved one',
      offline.launcher.kind === 'none' && offline.launcher.reason === 'absent', JSON.stringify(offline.launcher))

    // ---- 6. Launcher layer: copy planned, and the switch disables it ----
    const launcherDir = join(root, 'global', 'lib', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    mkdirSync(join(launcherDir, 'bin'), { recursive: true })
    writeFileSync(join(launcherDir, 'bin', 'dsh-tui.js'), '// old launcher\n')
    writeFileSync(join(launcherDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.17.0' }))
    const launcherEnv = {
      ...process.env,
      DSH_TUI_LAUNCHER_PATH: join(launcherDir, 'bin', 'dsh-tui.js'),
      DSH_TUI_LAUNCHER_VERSION: '0.17.0',
    }
    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.5': {} } },
    })
    const launcherPlan = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir, installedHost: '0.2.1-rc.5', env: launcherEnv,
    })
    check('plan: a lagging global launcher is planned for copy', launcherPlan.launcher.kind === 'copy' && launcherPlan.launcher.version === repoVersion
      && launcherPlan.launcher.from === '0.17.0', JSON.stringify(launcherPlan.launcher))
    check('plan: launcher-only work still makes the plan ready', update.updatePlanState(launcherPlan) === 'ready'
      && update.updatePlanLayers(launcherPlan).some(layer => layer.startsWith('launcher 0.17.0')))

    const disabledLauncher = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir, installedHost: '0.2.1-rc.5',
      env: { ...launcherEnv, DSH_TUI_UPDATE_LAUNCHER: '0' },
    })
    check('plan: DSH_TUI_UPDATE_LAUNCHER=0 disables the launcher layer', disabledLauncher.launcher.kind === 'none' && disabledLauncher.launcher.reason === 'disabled')

    // Launcher-only execution: no TUI installer, no engine installer, just the
    // atomic shim overwrite (the plan state was ready above).
    process.env.PATH = `${fakeDsh.bin}${delimiter}${npmOk.bin}${delimiter}${PATH_BACKUP}`
    process.env.DSH_TUI_LAUNCHER_PATH = join(launcherDir, 'bin', 'dsh-tui.js')
    process.env.DSH_TUI_LAUNCHER_VERSION = '0.17.0'
    const callsBeforeLauncher = readCalls(npmOk.calls).length
    const launcherOutcome = await update.updateTui('fixture-profile', launcherPlan)
    check('execute: launcher-only plan copies the shim and restarts cleanly', launcherOutcome.code === 0
      && launcherOutcome.launcher?.kind === 'copied' && launcherOutcome.tuiChanged === false
      && launcherOutcome.host === undefined, JSON.stringify(launcherOutcome.launcher))
    check('execute: launcher-only plan ran no TUI or engine installer',
      !existsSync(fakeDsh.marker) && readCalls(npmOk.calls).length === callsBeforeLauncher)
    check('execute: the global launcher manifest now matches the profile',
      JSON.parse(readFileSync(join(launcherDir, 'package.json'), 'utf8')).version === repoVersion)
    delete process.env.DSH_TUI_LAUNCHER_PATH
    delete process.env.DSH_TUI_LAUNCHER_VERSION

    // ---- 7. TUI update whose engine line cannot be installed is blocked ----
    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: '9.9.9' },
      '/@deepseek-harness-tui/dsh-tui/9.9.9': { version: '9.9.9', peerDependencies: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.5' } },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.4': {} } },
    })
    const blockedByRange = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: new TUI + no installable engine in range is blocked', blockedByRange.blocked === true
      && blockedByRange.compatible === false && update.updatePlanState(blockedByRange) === 'blocked', JSON.stringify(blockedByRange.host))
    check('plan: refusal names the target range and a manual command', blockedByRange.hostRange === '0.2.1-rc.5'
      && update.hostStepManual(blockedByRange.host).includes('@deepseek-ai/dsh@0.2.1-rc.5'), update.hostStepManual(blockedByRange.host))

    // Engine disabled by env: the step must still carry the target/command so
    // the refusal can explain what to run (never silently bless the pair).
    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: '9.9.9' },
      '/@deepseek-harness-tui/dsh-tui/9.9.9': { version: '9.9.9', peerDependencies: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.5' } },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.5': {} } },
    })
    const disabledEngine = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined, DSH_TUI_UPDATE_ENGINE: '0' },
    })
    check('plan: engine switch off still reports target + manual command', disabledEngine.host.kind === 'none'
      && disabledEngine.host.reason === 'disabled' && disabledEngine.host.to === '0.2.1-rc.5'
      && (disabledEngine.host.manual ?? []).length > 0, JSON.stringify(disabledEngine.host))
    check('plan: disabled engine + incompatible pair is blocked', disabledEngine.blocked === true && update.updatePlanState(disabledEngine) === 'blocked')

    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.5': {} } },
    })
    const idleDisabled = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined, DSH_TUI_UPDATE_ENGINE: '0' },
    })
    check('plan: disabled engine + TUI latest is idle, never "already aligned"', idleDisabled.host.kind === 'none'
      && idleDisabled.host.reason === 'disabled' && update.updatePlanState(idleDisabled) === 'idle')
    delete process.env.DSH_TUI_UPDATE_ENGINE

    // ---- 8. TUI moved + engine install failed + old engine outside range ----
    // The preflight would not have blocked (an install step existed), so the
    // execution layer itself must refuse the restart once that step fails.
    process.env.PATH = `${fakeDsh.bin}${delimiter}${npmFail.bin}${delimiter}${PATH_BACKUP}`
    const fatalPlan = {
      tui: { kind: 'update', current: repoVersion, latest: repoVersion },
      host: {
        kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: host14b.packageDir,
        command: { file: 'npm', args: ['install', '-g', '--prefix', host14b.prefix, '@deepseek-ai/dsh@0.2.1-rc.5'] },
        manual: [`npm install -g --prefix ${host14b.prefix} @deepseek-ai/dsh@0.2.1-rc.5`],
      },
      launcher: { kind: 'none', reason: 'disabled' },
      compatible: true, hostRange: '0.2.1-rc.5', currentHost: '0.2.1-rc.4', blocked: false,
    }
    const fatal = await update.updateTui('fixture-profile', fatalPlan)
    check('execute: moved TUI + failed engine below the line refuses the restart', fatal.code === 1
      && fatal.compatible === false && fatal.host?.code === 1 && fatal.tuiChanged === true, JSON.stringify({ code: fatal.code, host: fatal.host }))
    check('execute: the fatal path did run the profile installer first', existsSync(fakeDsh.marker))

    // ---- 8b. a failed install that DESTROYED the engine must not restart ----
    // Simulates npm replacing/removing the global package before failing
    // (EPERM on a loaded native module, ENOSPC, a killed child). No dsh on
    // PATH and no readable manifest: restarting would hand the user a missing
    // engine, so the update must stop with the repair command.
    const hostE = makeHostPrefix('prefix-e', '0.2.1-rc.4')
    const npmDestroy = makeFakeNpm('fake-npm-e', { exit: 1, destroy: true })
    process.env.PATH = `${npmDestroy.bin}${delimiter}${dirname(process.execPath)}`
    const destroyPlan = {
      tui: { kind: 'latest', current: repoVersion },
      host: {
        kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: hostE.packageDir,
        command: { file: 'npm', args: ['install', '-g', '--prefix', hostE.prefix, '@deepseek-ai/dsh@0.2.1-rc.5'] },
        manual: [`npm install -g --prefix ${hostE.prefix} @deepseek-ai/dsh@0.2.1-rc.5`],
      },
      launcher: { kind: 'none', reason: 'disabled' },
      compatible: true, hostRange: '0.2.1-rc.5', currentHost: '0.2.1-rc.4', blocked: false,
    }
    let refusalText = ''
    const captureStderr = async fn => {
      const original = process.stderr.write
      process.stderr.write = chunk => { refusalText += String(chunk); return true }
      try { return await fn() } finally { process.stderr.write = original }
    }
    const destroyed = await captureStderr(() => update.updateTui('fixture-profile', destroyPlan))
    check('execute: a destroyed engine after a failed step refuses the restart', destroyed.code === 1
      && destroyed.compatible === false && destroyed.host?.verified === false && !existsSync(hostE.packageDir),
      JSON.stringify({ code: destroyed.code, host: destroyed.host }))
    // Plan §10: a refusal names the current version, the target range AND the
    // command — the unsafe-refusal used to print only the command.
    check('execute: the unsafe refusal names the range and the repair command',
      refusalText.includes('0.2.1-rc.5') && refusalText.includes('npm install -g --prefix'),
      refusalText.slice(0, 240))

    // ---- 9. dsh-tui update: the same plan, per-layer output, exit codes ----
    if (process.platform === 'win32') {
      console.log('SKIP the cliUpdate cases on win32: findHostDsh needs a POSIX dsh link')
    } else {
      const { setLang, getLang } = await import('../lib/types/i18n.js')
      const previousLang = getLang()
      setLang('en')
      const cliPrefix = makeHostPrefix('prefix-cli', '0.2.1-rc.4')
      mkdirSync(join(cliPrefix.packageDir, 'lib'), { recursive: true })
      writeFileSync(join(cliPrefix.packageDir, 'lib', 'bin.js'),
        "#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('dsh 0.2.1-rc.4'); process.exit(0) }\nprocess.exit(0)\n")
      chmodSync(join(cliPrefix.packageDir, 'lib', 'bin.js'), 0o755)
      const cliBin = join(root, 'cli-bin')
      mkdirSync(cliBin, { recursive: true })
      symlinkSync(join(cliPrefix.packageDir, 'lib', 'bin.js'), join(cliBin, 'dsh'))
      const npmCli = makeFakeNpm('fake-npm-cli', { exit: 0, noop: true })
      process.env.PATH = `${cliBin}${delimiter}${npmCli.bin}${delimiter}${PATH_BACKUP}`
      process.env.NPM_CONFIG_REGISTRY = 'https://fixture.invalid'
      const capture = async fn => {
        let out = ''
        let err = ''
        const stdoutWrite = process.stdout.write
        const stderrWrite = process.stderr.write
        process.stdout.write = chunk => { out += String(chunk); return true }
        process.stderr.write = chunk => { err += String(chunk); return true }
        try {
          return { code: await fn(), out, err }
        } finally {
          process.stdout.write = stdoutWrite
          process.stderr.write = stderrWrite
        }
      }

      installFakeRegistry({
        '/@deepseek-harness-tui/dsh-tui/latest': { version: '9.9.9' },
        '/@deepseek-harness-tui/dsh-tui/9.9.9': { version: '9.9.9', peerDependencies: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.5' } },
        '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.4': {} } },
      })
      const blockedCalls = readCalls(npmCli.calls).length
      const blocked = await capture(() => update.cliUpdate('fixture-profile'))
      check('cli: a blocked plan exits 1 and names the manual command', blocked.code === 1
        && blocked.err.includes('Update cancelled') && blocked.err.includes('@deepseek-ai/dsh@0.2.1-rc.5')
        && readCalls(npmCli.calls).length === blockedCalls, JSON.stringify({ code: blocked.code, err: blocked.err.slice(0, 200) }))

      installFakeRegistry({
        '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
        '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.4': {}, '0.2.1-rc.5': {} } },
      })
      const unverified = await capture(() => update.cliUpdate('fixture-profile'))
      check('cli: an unverified engine install exits 1 with the repair command', unverified.code === 1
        && unverified.err.includes('PATH') && unverified.err.includes('npm install -g --prefix')
        && unverified.err.includes('engine not aligned'), JSON.stringify({ code: unverified.code, out: unverified.out.slice(0, 200), err: unverified.err.slice(0, 300) }))
      setLang(previousLang)
      delete process.env.NPM_CONFIG_REGISTRY
    }
  })
} finally {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries({
    HOME: HOME_BACKUP, USERPROFILE: USERPROFILE_BACKUP, DSH_HOME: DSH_HOME_BACKUP, PATH: PATH_BACKUP,
    NPM_CONFIG_REGISTRY: REGISTRY_BACKUP, DSH_TUI_LAUNCHER_PATH: LAUNCHER_PATH_BACKUP,
    DSH_TUI_LAUNCHER_VERSION: LAUNCHER_VERSION_BACKUP, DSH_TUI_UPDATE_ENGINE: ENGINE_SWITCH_BACKUP,
    DSH_TUI_UPDATE_LAUNCHER: LAUNCHER_SWITCH_BACKUP,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
