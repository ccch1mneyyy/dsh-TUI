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
import { fileURLToPath } from 'node:url'

// Real path: macOS tmpdir() is a symlink, and the host detection reports realpaths.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-update-host-')))
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
// A shell spawned from a dsh-tui session carries the session's launcher
// markers; every fixture here resolves its own target, so inherited values
// would make the update write to the developer's REAL global launcher while
// the assertions still passed. Restored in the finally block.
for (const key of ['DSH_TUI_LAUNCHER_PATH', 'DSH_TUI_LAUNCHER_VERSION', 'DSH_TUI_UPDATE_LAUNCHER', 'DSH_TUI_UPDATE_ENGINE']) {
  delete process.env[key]
}

const repoVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
// The R4 CLI fixture lets its fake dsh rewrite this package's version to the
// update target (the post-install check reads the real package root); restore
// it even if a check fails.
const tuiPackagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const tuiPackageBackup = readFileSync(tuiPackagePath, 'utf8')
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

const hostEntry = `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
if (process.argv.includes('--version')) console.log('dsh ' + JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version)
`

/** Put only this fixture's dsh on PATH, with a link or Windows shim. */
function linkHostBin(packageDir, bin) {
  mkdirSync(bin, { recursive: true })
  const entry = join(packageDir, 'lib', 'bin.js')
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
  } else {
    symlinkSync(entry, join(bin, 'dsh'))
  }
  return bin
}

/**
 * Lay out one fake npm global prefix with a dsh package at `version`.
 * `bin: false` leaves the manifest without its entry point — the shape a
 * partial install leaves behind.
 */
function makeHostPrefix(name, version, options = {}) {
  const prefix = join(root, name)
  const packageDir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' },
  }))
  if (options.bin !== false) {
    // `brokenDependency` keeps the entry file and manifest but removes a
    // module the entry imports — the shape a killed install leaves behind.
    writeFileSync(join(packageDir, 'lib', 'bin.js'), options.brokenDependency === true
      ? "require('./missing-dependency.js')\n"
      : hostEntry)
    chmodSync(join(packageDir, 'lib', 'bin.js'), 0o755)
  }
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
if (behaviour.removePath !== undefined) rmSync(behaviour.removePath, { force: true })
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
writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version }))
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
  mkdirSync(join(home, 'global', '5'), { recursive: true })
  writeFileSync(join(home, 'global', '5', 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } }))
  const pinned = join(globalNodeModules, '.pnpm', `@deepseek-ai+dsh@${version}`, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pinned, { recursive: true })
  writeFileSync(join(pinned, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
  mkdirSync(join(pinned, 'lib'), { recursive: true })
  writeFileSync(join(pinned, 'lib', 'bin.js'), hostEntry)
  chmodSync(join(pinned, 'lib', 'bin.js'), 0o755)
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
function makeFakePnpm(name, { keepPrevious = false, exitCode = 0 } = {}) {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  const calls = join(bin, 'calls.jsonl')
  writeFileSync(join(bin, 'fake-pnpm.mjs'), `
import { appendFileSync, chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const dir = ${JSON.stringify(bin)}
const args = process.argv.slice(2)
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, pnpmHome: process.env.PNPM_HOME ?? null, releaseAge: process.env.PNPM_CONFIG_MINIMUM_RELEASE_AGE ?? null, path: process.env.PATH ?? null }) + '\\n')
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
writeFileSync(join(pinned, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
mkdirSync(join(pinned, 'lib'), { recursive: true })
writeFileSync(join(pinned, 'lib', 'bin.js'), ${JSON.stringify(hostEntry)})
chmodSync(join(pinned, 'lib', 'bin.js'), 0o755)
rmSync(link, { force: true })
symlinkSync(pinned, link, ${JSON.stringify(process.platform === 'win32' ? 'junction' : 'dir')})
// Prune the old version-pinned directory (real pnpm drops it from the store).
if (!${JSON.stringify(keepPrevious)} && previous !== undefined && previous !== pinned) {
  try { rmSync(dirname(dirname(dirname(previous))), { recursive: true, force: true }) } catch {}
}
process.exit(${JSON.stringify(exitCode)})
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

/**
 * A `dsh` that exists on PATH but cannot start, e.g. an install whose
 * dependency tree is half-written. The probe must read this as negative proof,
 * not as "no dsh installed".
 */
function makeFailingDsh(name) {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'dsh.cmd'), '@echo off\r\necho Error: missing dependency 1>&2\r\nexit /b 1\r\n')
  } else {
    writeFileSync(join(bin, 'dsh'), '#!/bin/sh\necho "Error: missing dependency" >&2\nexit 1\n')
    chmodSync(join(bin, 'dsh'), 0o755)
  }
  return { bin }
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
    check('execute: pnpm install runs in the detected PNPM_HOME with its bin dirs on PATH', pnpmCalls.length === 1
      && pnpmCalls[0].pnpmHome === pnpmPrefix.home
      && pnpmCalls[0].args.join(' ') === 'add -g @deepseek-ai/dsh@0.2.1-rc.5'
      && String(pnpmCalls[0].path ?? '').includes(join(pnpmPrefix.home, 'bin'))
      && String(pnpmCalls[0].path ?? '').includes(pnpmPrefix.home), JSON.stringify(pnpmCalls))
    // pnpm >= 11 delays just-published versions; the waiver must reach the child.
    check('execute: engine install carries the release-age waiver',
      pnpmCalls[0]?.releaseAge === '0', JSON.stringify(pnpmCalls[0]))
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

    // ---- 2d. A found-but-broken dsh is negative proof, not "no evidence" ----
    // The installer exits 0 and the manifest reaches the target, but the CLI
    // that will actually launch cannot start: the update must not report a
    // verified engine, arm the success stamp, or restart (#1849 review R1).
    const brokenCli = makeFailingDsh('fake-dsh-broken')
    process.env.PATH = `${brokenCli.bin}${delimiter}${npmAdvance.bin}${delimiter}${dirname(process.execPath)}`
    const brokenCliStep = await runStep(undefined)
    check('verify: a dsh that exists but cannot run fails verification', brokenCliStep.verified === false
      && brokenCliStep.installed === '0.2.1-rc.5', JSON.stringify(brokenCliStep))
    // Boot picks `dsh` by existence, so one it cannot execute is a broken engine,
    // not an absent one. Windows has no execute bit to take away.
    if (process.platform !== 'win32') {
      // A real `dsh` beside node would answer for these entries: the probe walks
      // past what it cannot run. Keep only node on the tail of PATH.
      const nodeOnly = join(root, 'node-only')
      mkdirSync(nodeOnly, { recursive: true })
      symlinkSync(process.execPath, join(nodeOnly, 'node'))
      const unrunnable = makeFakeDsh('fake-dsh-not-executable')
      chmodSync(join(unrunnable.bin, 'dsh'), 0o644)
      process.env.PATH = `${unrunnable.bin}${delimiter}${npmAdvance.bin}${delimiter}${nodeOnly}`
      const unrunnableStep = await runStep(undefined)
      check('verify: a dsh without execute permission is negative proof', unrunnableStep.verified === false,
        JSON.stringify(unrunnableStep))
      // The bin link an interrupted install leaves behind its removed package.
      const dangling = join(root, 'fake-dsh-dangling')
      mkdirSync(dangling, { recursive: true })
      symlinkSync(join(dangling, 'removed-engine'), join(dangling, 'dsh'))
      process.env.PATH = `${dangling}${delimiter}${npmAdvance.bin}${delimiter}${nodeOnly}`
      const danglingStep = await runStep(undefined)
      check('verify: a dangling dsh link is negative proof', danglingStep.verified === false, JSON.stringify(danglingStep))
      process.env.PATH = `${brokenCli.bin}${delimiter}${npmAdvance.bin}${delimiter}${dirname(process.execPath)}`
    }
    check('verify: a broken CLI arms no engine success stamp',
      update.restartEnvFor({ updatedFrom: repoVersion, tuiChanged: false, host: brokenCliStep }).DSH_TUI_UPDATED_DSH_FROM === undefined)
    const brokenCliPlan = {
      tui: { kind: 'latest', current: repoVersion },
      host: {
        kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: hostC.packageDir,
        command: { file: 'npm', args: ['install', '-g', '--prefix', hostC.prefix, '@deepseek-ai/dsh@0.2.1-rc.5'] },
        manual: [`npm install -g --prefix ${hostC.prefix} @deepseek-ai/dsh@0.2.1-rc.5`],
      },
      launcher: { kind: 'none', reason: 'disabled' },
      compatible: true, hostRange: RANGE, currentHost: '0.2.1-rc.4', blocked: false,
    }
    let brokenCliSpawned = false
    const brokenCliRestart = await update.updateTuiAndRestart(
      'fixture-session', 'fixture-profile', brokenCliPlan, undefined,
      { onSpawn: () => { brokenCliSpawned = true } },
    )
    check('execute: an unverified engine never starts a replacement', brokenCliRestart.updateCode === 1
      && brokenCliRestart.restartCode === 1 && brokenCliSpawned === false,
    JSON.stringify(brokenCliRestart))

    // ---- 3. Engine failure: compatible → keep going, incompatible → stop ----
    const host14b = makeHostPrefix('prefix-b', '0.2.1-rc.4')
    const npmFail = makeFakeNpm('fake-npm-b', { exit: 1 })
    process.env.PATH = `${npmFail.bin}${delimiter}${dirname(process.execPath)}`
    const failingPlan = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    const tolerated = await update.updateTui('fixture-profile', failingPlan)
    check('execute: compatible engine failure keeps the update restartable', tolerated.code === 0 && tolerated.host?.code === 1 && tolerated.host?.verified === false)
    check('execute: failure outcome names the repair command', tolerated.host?.manual.includes('npm install -g --prefix'))

    // ---- 3b. A partial install keeps the manifest but loses the entry ----
    // `engineSurvivesFailure` must not treat a readable package.json as proof.
    const hostPartial = makeHostPrefix('prefix-partial', '0.2.1-rc.4', { bin: false })
    const npmPartial = makeFakeNpm('fake-npm-partial', { exit: 1 })
    process.env.PATH = `${npmPartial.bin}${delimiter}${dirname(process.execPath)}`
    const partialPlan = await update.resolveUpdatePlan({
      hostPackageDir: hostPartial.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    const partial = await update.updateTui('fixture-profile', partialPlan)
    check('execute: a manifest-only survivor after a failed engine install refuses the restart', partial.code === 1
      && partial.host?.verified === false, JSON.stringify({ code: partial.code, host: partial.host }))

    // ---- 3b2. Entry exists but a dependency it imports is gone ----
    // The exact R1 shape: `bin.dsh` and the manifest survive a killed install,
    // while a module the entry loads is already missing. File existence must
    // not stand in for a runtime probe.
    const hostBrokenDeps = makeHostPrefix('prefix-broken-deps', '0.2.1-rc.4', { brokenDependency: true })
    const npmBrokenDeps = makeFakeNpm('fake-npm-broken-deps', { exit: 1 })
    process.env.PATH = `${npmBrokenDeps.bin}${delimiter}${dirname(process.execPath)}`
    const brokenDepsPlan = await update.resolveUpdatePlan({
      hostPackageDir: hostBrokenDeps.packageDir,
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    let replacementSpawned = false
    const brokenDeps = await update.updateTuiAndRestart(
      'fixture-session', 'fixture-profile', brokenDepsPlan, undefined,
      { onSpawn: () => { replacementSpawned = true } },
    )
    check('execute: an entry that cannot load its dependency refuses the restart', brokenDeps.updateCode === 1
      && brokenDeps.restartCode === 1 && replacementSpawned === false,
    JSON.stringify({ updateCode: brokenDeps.updateCode, restartCode: brokenDeps.restartCode, replacementSpawned }))

    // The contrasting control: a complete, running old engine may still
    // restart after the failed step (`tolerated` above), so the new probe did
    // not simply turn every failure into a refusal.
    check('execute: the broken-dependency refusal is not the general failure path',
      tolerated.code === 0 && brokenDeps.updateCode === 1)

    // ---- 3b3. A running store copy cannot testify for a re-pointed link ----
    // The installer fails after the profile link already points at the
    // half-written tree, while the previous store copy still runs. Only the
    // entry the next boot follows may vouch for survival (#1849 review R1).
    const oldStore = makeHostPrefix('prefix-old-store', '0.2.1-rc.4')
    const newBroken = makeHostPrefix('prefix-new-broken', '0.2.1-rc.5', { brokenDependency: true })
    const npmStillFails = makeFakeNpm('fake-npm-link', { exit: 1 })
    process.env.PATH = `${npmStillFails.bin}${delimiter}${dirname(process.execPath)}`
    const linkPlan = {
      tui: { kind: 'latest', current: repoVersion },
      host: {
        kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: oldStore.packageDir,
        command: { file: 'npm', args: ['install', '-g', '--prefix', oldStore.prefix, '@deepseek-ai/dsh@0.2.1-rc.5'] },
        manual: [`npm install -g --prefix ${oldStore.prefix} @deepseek-ai/dsh@0.2.1-rc.5`],
      },
      launcher: { kind: 'none', reason: 'disabled' },
      compatible: true, hostRange: RANGE, currentHost: '0.2.1-rc.4', blocked: false,
    }
    const repointed = await update.updateTui('fixture-profile', linkPlan, undefined, {
      nextLaunchDir: () => newBroken.packageDir,
    })
    check('execute: a store copy that still runs cannot vouch for the re-pointed link', repointed.code === 1
      && repointed.host?.code === 1, JSON.stringify({ code: repointed.code, host: repointed.host }))
    const stillLinked = await update.updateTui('fixture-profile', linkPlan, undefined, {
      nextLaunchDir: () => oldStore.packageDir,
    })
    check('execute: the same failure stays restartable while the link still runs', stillLinked.code === 0
      && stillLinked.host?.code === 1, JSON.stringify({ code: stillLinked.code, host: stillLinked.host }))

    // ---- 3b4. Every entry the next boot can follow has to testify ----
    // The default launch boots the first `dsh` on PATH and `dsh --profile` the
    // profile link, so neither may vouch for the other.
    const brokenPathDsh = makeFailingDsh('fake-dsh-path-broken')
    process.env.PATH = `${brokenPathDsh.bin}${delimiter}${npmStillFails.bin}${delimiter}${dirname(process.execPath)}`
    const linkRunsPathBroken = await update.updateTui('fixture-profile', linkPlan, undefined, {
      nextLaunchDir: () => oldStore.packageDir,
    })
    check('execute: a link that runs cannot vouch for a broken dsh on PATH', linkRunsPathBroken.code === 1
      && linkRunsPathBroken.host?.code === 1, JSON.stringify({ code: linkRunsPathBroken.code, host: linkRunsPathBroken.host }))

    // A failed install that takes the PATH `dsh` with it: the link still runs,
    // but the default launch has nothing left to boot. PATH without a `dsh` from
    // the start stays restartable (the check above).
    const doomedDsh = makeFakeDsh('fake-dsh-removed')
    const npmRemovesDsh = makeFakeNpm('fake-npm-removes-dsh', {
      exit: 1, removePath: join(doomedDsh.bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
    })
    process.env.PATH = `${doomedDsh.bin}${delimiter}${npmRemovesDsh.bin}${delimiter}${dirname(process.execPath)}`
    const removedPathDsh = await update.updateTui('fixture-profile', linkPlan, undefined, {
      nextLaunchDir: () => oldStore.packageDir,
    })
    check('execute: a link that runs cannot vouch for a dsh the install removed', removedPathDsh.code === 1
      && removedPathDsh.host?.code === 1, JSON.stringify({ code: removedPathDsh.code, host: removedPathDsh.host }))

    // Installer exit 0: the same terms decide `verified`, each against a link
    // that is NOT the installer's own directory.
    const npmLinkNoop = makeFakeNpm('fake-npm-link-noop', { exit: 0, noop: true })
    const linkStep = next => update.installHostStep(linkPlan.host, {
      env: process.env, onCleanupError: () => {}, nextLaunchDir: () => next,
    })
    process.env.PATH = `${npmLinkNoop.bin}${delimiter}${dirname(process.execPath)}`
    const brokenLink = await linkStep(newBroken.packageDir)
    check('verify: a link at the target that cannot start is negative proof', brokenLink.verified === false,
      JSON.stringify(brokenLink))
    process.env.PATH = `${fakeDsh.bin}${delimiter}${npmLinkNoop.bin}${delimiter}${dirname(process.execPath)}`
    const staleLink = await linkStep(oldStore.packageDir)
    check('verify: PATH at the target cannot outvote a stale running link', staleLink.verified === false
      && staleLink.cliVersion === '0.2.1-rc.5', JSON.stringify(staleLink))
    const nextLink = makeHostPrefix('prefix-next-link', '0.2.1-rc.5')
    const goodLink = await linkStep(nextLink.packageDir)
    check('verify: a running link and PATH both at the target verify', goodLink.verified === true, JSON.stringify(goodLink))

    // pnpm prunes the directory it started from: the verdict must come from the
    // link beside it, whichever way that link went.
    const pnpmLinked = makePnpmPrefix('pnpm-next-link', '0.2.1-rc.4')
    const pnpmLinkedStep = {
      kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: pnpmLinked.packageDir,
      command: {
        file: 'pnpm', args: ['add', '-g', '@deepseek-ai/dsh@0.2.1-rc.5'], env: { PNPM_HOME: pnpmLinked.home },
      },
      manual: ['pnpm add -g @deepseek-ai/dsh@0.2.1-rc.5'],
    }
    const pnpmLinkBin = makeFakePnpm('fake-pnpm-next-link')
    process.env.PATH = `${pnpmLinkBin.bin}${delimiter}${dirname(process.execPath)}`
    const pnpmNextRuns = await update.installHostStep(pnpmLinkedStep, {
      env: process.env, onCleanupError: () => {}, nextLaunchDir: () => nextLink.packageDir,
    })
    check('verify: a pnpm install follows a separate profile link', pnpmNextRuns.code === 0
      && pnpmNextRuns.verified === true, JSON.stringify(pnpmNextRuns))
    const pnpmNextBroken = await update.installHostStep(pnpmLinkedStep, {
      env: process.env, onCleanupError: () => {}, nextLaunchDir: () => newBroken.packageDir,
    })
    check('verify: a pnpm install cannot outrun a broken profile link', pnpmNextBroken.code === 0
      && pnpmNextBroken.verified === false, JSON.stringify(pnpmNextBroken))

    // ---- R4. A retained store keeps the shared fallback pinned to the old host ----
    const retained = makePnpmPrefix('pnpm-retained', '0.2.1-rc.4')
    const retainedBin = linkHostBin(retained.packageDir, join(retained.home, 'bin'))
    const pnpmRetains = makeFakePnpm('fake-pnpm-retains', { keepPrevious: true })
    const retainedTui = join(root, 'retained-profile', 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    mkdirSync(retainedTui, { recursive: true })
    const retainedLink = join(root, 'retained-profile', 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dirname(retainedLink), { recursive: true })
    symlinkSync(retained.pinned, retainedLink, process.platform === 'win32' ? 'junction' : 'dir')
    const retainedStep = {
      kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: retained.pinned,
      command: { file: 'pnpm', args: ['add', '-g', '@deepseek-ai/dsh@0.2.1-rc.5'], env: { PNPM_HOME: retained.home } },
      manual: ['pnpm add -g @deepseek-ai/dsh@0.2.1-rc.5'],
    }
    const retainedOptions = {
      env: process.env, onCleanupError: () => {}, tuiDir: retainedTui,
      nextLaunchDir: () => update.installedKernelDirFresh(retainedTui),
    }
    process.env.PATH = `${retainedBin}${delimiter}${pnpmRetains.bin}${delimiter}${dirname(process.execPath)}`
    const refreshedFallback = await update.installHostStep(retainedStep, retainedOptions)
    if (process.platform === 'win32') {
      check('R4: Windows leaves the old junction intact rather than replacing it non-atomically',
        refreshedFallback.verified === false && refreshedFallback.cliVersion === '0.2.1-rc.5'
          && realpathSync(retainedLink) === realpathSync(retained.pinned), JSON.stringify(refreshedFallback))
    } else {
      check('R4: a successful pnpm install refreshes its stale shared fallback and verifies',
        refreshedFallback.verified === true && refreshedFallback.cliVersion === '0.2.1-rc.5'
          && realpathSync(retainedLink) === realpathSync(retained.packageDir), JSON.stringify(refreshedFallback))
    }
    check('R4: refreshing the fallback leaves the old store package intact',
      JSON.parse(readFileSync(join(retained.pinned, 'package.json'), 'utf8')).version === '0.2.1-rc.4')

    // A different PNPM_HOME at the target version must not repair this one.
    rmSync(retainedLink)
    symlinkSync(retained.pinned, retainedLink, process.platform === 'win32' ? 'junction' : 'dir')
    const localHost = join(dirname(dirname(retainedTui)), '@deepseek-ai', 'dsh')
    mkdirSync(dirname(localHost), { recursive: true })
    symlinkSync(retained.pinned, localHost, process.platform === 'win32' ? 'junction' : 'dir')
    const explicitDependency = await update.installHostStep(retainedStep, retainedOptions)
    check('R4: an explicit profile-local dependency is never rewritten or bypassed',
      explicitDependency.verified === false && realpathSync(localHost) === realpathSync(retained.pinned)
        && realpathSync(retainedLink) === realpathSync(retained.pinned), JSON.stringify(explicitDependency))
    rmSync(localHost)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(dirname(retainedLink), 0o555)
      try {
        const unwritableFallback = await update.installHostStep(retainedStep, retainedOptions)
        check('R4: a failed atomic refresh preserves the old link and refuses verification',
          unwritableFallback.verified === false && realpathSync(retainedLink) === realpathSync(retained.pinned), JSON.stringify(unwritableFallback))
      } finally {
        chmodSync(dirname(retainedLink), 0o755)
      }
    }
    const foreignHost = makePnpmPrefix('pnpm-foreign', '0.2.1-rc.5')
    const foreignBin = linkHostBin(foreignHost.packageDir, join(foreignHost.home, 'bin'))
    process.env.PATH = `${foreignBin}${delimiter}${pnpmRetains.bin}${delimiter}${dirname(process.execPath)}`
    const foreignFallback = await update.installHostStep(retainedStep, retainedOptions)
    check('R4: an unrelated PATH host cannot rewrite or verify the old fallback',
      foreignFallback.verified === false && realpathSync(retainedLink) === realpathSync(retained.pinned), JSON.stringify(foreignFallback))

    // The shared node_modules entry may be a real package, not our runtime link.
    rmSync(retainedLink)
    mkdirSync(join(retainedLink, 'lib'), { recursive: true })
    writeFileSync(join(retainedLink, 'package.json'), readFileSync(join(retained.pinned, 'package.json')))
    writeFileSync(join(retainedLink, 'lib', 'bin.js'), hostEntry)
    process.env.PATH = `${retainedBin}${delimiter}${pnpmRetains.bin}${delimiter}${dirname(process.execPath)}`
    const directoryFallback = await update.installHostStep(retainedStep, retainedOptions)
    check('R4: a real fallback directory is left untouched and unverified',
      directoryFallback.verified === false && realpathSync(retainedLink) === retainedLink
        && JSON.parse(readFileSync(join(retainedLink, 'package.json'), 'utf8')).version === '0.2.1-rc.4', JSON.stringify(directoryFallback))

    // ---- 3c. A pnpm group with another CLI is never replaced ----
    const multiHome = join(root, 'pnpm-multi')
    const multiGlobal = join(multiHome, 'global', '5', 'node_modules')
    const multiDsh = join(multiGlobal, '.pnpm', '@deepseek-ai+dsh@0.2.1-rc.4', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(multiDsh, { recursive: true })
    writeFileSync(join(multiDsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.4' }))
    mkdirSync(join(multiGlobal, '@deepseek-ai'), { recursive: true })
    symlinkSync(multiDsh, join(multiGlobal, '@deepseek-ai', 'dsh'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(multiHome, 'global', '5', 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4', '@scope/other-cli': '1.0.0' },
    }))
    const fakePnpmMulti = makeFakePnpm('fake-pnpm-multi')
    process.env.PNPM_HOME = multiHome
    process.env.PATH = `${fakeDsh.bin}${delimiter}${fakePnpmMulti.bin}${delimiter}${PATH_BACKUP}`
    const multiPlan = await update.resolveUpdatePlan({
      hostPackageDir: join(multiGlobal, '@deepseek-ai', 'dsh'),
      installedHost: '0.2.1-rc.4',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: a pnpm group with another CLI is refused before installing', multiPlan.host.kind === 'unavailable'
      && multiPlan.host.reason === 'group-unproven', JSON.stringify(multiPlan.host))
    check('plan: that refusal prints inspection guidance, not a lone pnpm add',
      (multiPlan.host.manual?.[0] ?? '').startsWith('pnpm list -g'), (multiPlan.host.manual?.[0] ?? '').slice(0, 120))
    const multiCallsBefore = readCalls(fakePnpmMulti.calls).length
    const multiOutcome = await update.updateTui('fixture-profile', multiPlan)
    check('execute: the refused group runs no pnpm installer', readCalls(fakePnpmMulti.calls).length === multiCallsBefore
      && multiOutcome.host === undefined, JSON.stringify({ code: multiOutcome.code, host: multiOutcome.host }))
    delete process.env.PNPM_HOME

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
    const launcherPrefix = join(root, 'global')
    // A global package is only writable with a matching external npm bin link
    // or shim; any install shape the update cannot prove is left untouched.
    const launcherDir = join(launcherPrefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    mkdirSync(join(launcherDir, 'bin'), { recursive: true })
    writeFileSync(join(launcherDir, 'bin', 'dsh-tui.js'), '// old launcher\n')
    writeFileSync(join(launcherDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.17.0' }))
    if (process.platform === 'win32') {
      writeFileSync(join(launcherPrefix, 'dsh-tui.cmd'), '@echo off\r\n"%~dp0\\node_modules\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js" %*\r\n')
    } else {
      mkdirSync(join(launcherPrefix, 'bin'), { recursive: true })
      symlinkSync(join(launcherDir, 'bin', 'dsh-tui.js'), join(launcherPrefix, 'bin', 'dsh-tui'))
    }
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
    // A layer that was skipped proves nothing about alignment: with a lagging
    // launcher behind the switch the CLI must not claim the set is current.
    check('plan: a disabled, lagging launcher is not "already aligned"',
      update.updatePlanState(disabledLauncher) === 'idle',
      update.updatePlanState(disabledLauncher))

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

    // ---- R5. Engine advanced + launcher copy failed must never restart ----
    const r5Host = makeHostPrefix('prefix-r5', '0.2.1-rc.4')
    const r5HostBin = linkHostBin(r5Host.packageDir, join(r5Host.prefix, 'bin'))
    const r5LauncherDir = join(r5Host.prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    const r5LauncherBin = join(r5LauncherDir, 'bin', 'dsh-tui.js')
    // A directory at the destination makes the atomic copy fail on every OS.
    mkdirSync(r5LauncherBin, { recursive: true })
    writeFileSync(join(r5LauncherDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.17.0' }))
    if (process.platform === 'win32') {
      writeFileSync(join(r5Host.prefix, 'dsh-tui.cmd'), '@echo off\r\n"%~dp0\\node_modules\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js" %*\r\n')
    } else {
      symlinkSync(r5LauncherBin, join(r5Host.prefix, 'bin', 'dsh-tui'))
    }
    const r5Plan = {
      tui: { kind: 'latest', current: repoVersion },
      host: {
        kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: r5Host.packageDir,
        command: { file: 'npm', args: ['install', '-g', '--prefix', r5Host.prefix, '@deepseek-ai/dsh@0.2.1-rc.5'] },
        manual: [`npm install -g --prefix ${r5Host.prefix} @deepseek-ai/dsh@0.2.1-rc.5`],
      },
      launcher: { kind: 'copy', version: repoVersion, from: '0.17.0', path: r5LauncherDir },
      compatible: true, hostRange: RANGE, currentHost: '0.2.1-rc.4', blocked: false,
    }
    await withEnv({
      DSH_TUI_LAUNCHER_PATH: r5LauncherBin, DSH_TUI_LAUNCHER_VERSION: '0.17.0',
      PATH: `${r5HostBin}${delimiter}${npmFail.bin}${delimiter}${dirname(process.execPath)}`,
    }, async () => {
      const failureWrite = process.stderr.write
      let failureText = ''
      let unchangedEngine
      try {
        process.stderr.write = chunk => { failureText += String(chunk); return true }
        unchangedEngine = await update.updateTui('fixture-profile', r5Plan)
      } finally {
        process.stderr.write = failureWrite
      }
      const { t: failureMessage } = await import('../lib/types/i18n.js')
      check('R5: recording a failed install version does not claim the engine landed',
        failureText.includes(failureMessage('update-engine-failed', { code: '1', command: r5Plan.host.manual[0] })), failureText)
      check('R5: a launcher failure with the engine unchanged stays best effort',
        unchangedEngine.code === 0 && unchangedEngine.host?.code === 1 && unchangedEngine.launcher?.kind === 'failed', JSON.stringify(unchangedEngine))

      process.env.PATH = `${r5HostBin}${delimiter}${npmOk.bin}${delimiter}${dirname(process.execPath)}`
      const replacementMarker = join(root, 'r5-replacement-called')
      const replacement = join(root, 'r5-replacement.cjs')
      writeFileSync(replacement, `require('node:fs').writeFileSync(${JSON.stringify(replacementMarker)}, 'started')\n`)
      const originalArgv = process.argv
      const stderrWrite = process.stderr.write
      let stderr = ''
      let spawned = false
      const { getLang, setLang } = await import('../lib/types/i18n.js')
      const language = getLang()
      let refused
      try {
        setLang('en')
        process.argv = [process.execPath, replacement]
        process.stderr.write = chunk => { stderr += String(chunk); return true }
        refused = await update.updateTuiAndRestart('fixture-session', 'fixture-profile', r5Plan, undefined, {
          onSpawn: () => { spawned = true },
        })
      } finally {
        process.argv = originalArgv
        process.stderr.write = stderrWrite
        setLang(language)
      }
      check('R5: engine advance plus launcher failure refuses the replacement',
        refused.updateCode === 1 && refused.restartCode === 1 && !spawned && !existsSync(replacementMarker), JSON.stringify(refused))
      check('R5: the refusal explains the changed engine and prints the launcher repair command',
        stderr.includes('not restarting') && stderr.includes('0.2.1-rc.5')
          && stderr.includes(`npm install -g --legacy-peer-deps @deepseek-harness-tui/dsh-tui@${repoVersion}`), stderr)

      // An installer exit code does not undo a version already on disk. The
      // old plan must still refuse this changed pair even without `verified`.
      process.env.PATH = `${r5HostBin}${delimiter}${npmFail.bin}${delimiter}${dirname(process.execPath)}`
      const advancedDespiteFailure = await update.updateTui('fixture-profile', r5Plan)
      check('R5: an advanced manifest still blocks restart when the installer exits non-zero',
        advancedDespiteFailure.code === 1 && advancedDespiteFailure.host?.code === 1
          && advancedDespiteFailure.launcher?.kind === 'failed', JSON.stringify(advancedDespiteFailure))
      const pnpmR5 = makePnpmPrefix('pnpm-r5-partial', '0.2.1-rc.4')
      const pnpmR5Bin = linkHostBin(pnpmR5.packageDir, join(pnpmR5.home, 'bin'))
      const pnpmPartial = makeFakePnpm('fake-pnpm-r5-partial', { keepPrevious: true, exitCode: 1 })
      process.env.PATH = `${pnpmR5Bin}${delimiter}${pnpmPartial.bin}${delimiter}${dirname(process.execPath)}`
      const pnpmPartialOutcome = await update.updateTui('fixture-profile', {
        ...r5Plan,
        host: {
          kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: pnpmR5.pinned,
          command: { file: 'pnpm', args: ['add', '-g', '@deepseek-ai/dsh@0.2.1-rc.5'], env: { PNPM_HOME: pnpmR5.home } },
          manual: ['pnpm add -g @deepseek-ai/dsh@0.2.1-rc.5'],
        },
      })
      check('R5: a failed pnpm install observes the new PATH instead of its retained old store',
        pnpmPartialOutcome.code === 1 && pnpmPartialOutcome.host?.code === 1
          && pnpmPartialOutcome.host?.verified === false && pnpmPartialOutcome.host?.cliVersion === '0.2.1-rc.5'
          && pnpmPartialOutcome.launcher?.kind === 'failed'
          && JSON.parse(readFileSync(join(pnpmR5.pinned, 'package.json'), 'utf8')).version === '0.2.1-rc.4', JSON.stringify(pnpmPartialOutcome))
      process.env.PATH = `${r5HostBin}${delimiter}${npmOk.bin}${delimiter}${dirname(process.execPath)}`
      rmSync(r5LauncherBin, { recursive: true })
      writeFileSync(r5LauncherBin, '// old launcher\n')
      const aligned = await update.updateTui('fixture-profile', r5Plan)
      check('R5: a successfully aligned launcher keeps an engine advance restartable',
        aligned.code === 0 && aligned.host?.verified === true && aligned.launcher?.kind === 'copied', JSON.stringify(aligned))
    })

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

    // An installable engine does NOT make the plan executable: the official
    // manager validates the new TUI against the RUNNING engine, so the engine
    // step can only succeed BEFORE the TUI. Refuse up front, with a command
    // that goes first, instead of tearing the tree down for a rejected
    // install (#1849 review R2).
    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: '9.9.9' },
      '/@deepseek-harness-tui/dsh-tui/9.9.9': { version: '9.9.9', peerDependencies: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.6' } },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.5': {}, '0.2.1-rc.6': {} } },
    })
    const engineFirst = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.5',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: a TUI that needs a newer engine is blocked even though the engine is installable',
      engineFirst.host.kind === 'install' && engineFirst.host.to === '0.2.1-rc.6'
        && engineFirst.compatible === true && engineFirst.blocked === true
        && update.updatePlanState(engineFirst) === 'blocked',
      JSON.stringify({ host: engineFirst.host, blocked: engineFirst.blocked }))
    const engineFirstReport = update.blockedUpdateMessages(engineFirst).report
    check('plan: that refusal asks to upgrade the engine first and prints the command',
      engineFirstReport.includes('@deepseek-ai/dsh@0.2.1-rc.6')
        && (engineFirstReport.includes('Upgrade the engine first') || engineFirstReport.includes('先升级引擎')),
      engineFirstReport)
    const engineFirstOutcome = await update.updateTui('fixture-profile', engineFirst)
    check('execute: the engine-first refusal opens no installer and moves no TUI', engineFirstOutcome.code === 1
      && !existsSync(fakeDsh.marker), JSON.stringify({ code: engineFirstOutcome.code }))

    // An engine ABOVE the target TUI's line is outside it like an older one:
    // the official manager's exact satisfies() rejects it, so the preflight
    // must refuse before the TUI is torn down (#1849 review, R1 fix).
    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: '9.9.9' },
      '/@deepseek-harness-tui/dsh-tui/9.9.9': { version: '9.9.9', peerDependencies: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.5' } },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.5': {}, '0.2.2-rc.2': {} } },
    })
    const aheadEngine = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.2-rc.2',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: a TUI that would reject a newer engine is blocked', aheadEngine.blocked === true
      && aheadEngine.host.kind === 'none' && aheadEngine.host.reason === 'newer-than-validated'
      && aheadEngine.compatible === true && update.updatePlanState(aheadEngine) === 'blocked',
    JSON.stringify({ host: aheadEngine.host, blocked: aheadEngine.blocked }))
    const aheadMessages = update.blockedUpdateMessages(aheadEngine)
    check('plan: the newer-engine refusal says wait for a TUI release, not install/downgrade',
      aheadMessages.report.includes('0.2.2-rc.2') && aheadMessages.report.includes('0.2.1-rc.5')
        && !aheadMessages.report.includes('npm install') && !aheadMessages.report.includes('pnpm add')
        && (aheadMessages.report.includes('does not declare support') || aheadMessages.report.includes('尚未声明支持'))
        && (aheadMessages.title.includes('does not declare support') || aheadMessages.title.includes('尚未声明支持')),
      aheadMessages.report)
    check('plan: the above-line toast does not claim the TUI needs a newer dsh',
      !aheadMessages.toast.includes('needs a newer dsh') && !aheadMessages.toast.includes('需要更新的 dsh'),
      aheadMessages.toast)
    const aheadOutcome = await update.updateTui('fixture-profile', aheadEngine)
    check('execute: the newer-engine refusal opens no installer and moves no TUI', aheadOutcome.code === 1
      && !existsSync(fakeDsh.marker), JSON.stringify({ code: aheadOutcome.code }))

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

    // The #1849 review case: the TUI is current, the registry has a newer
    // engine outside its declared line. This is a wait, not a refusal and not
    // "everything aligned". Use a release beyond the newly supported 0.2.2 line.
    installFakeRegistry({
      '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
      '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.5': {}, '0.3.0-rc.1': {} } },
    })
    const waitingEngine = await update.resolveUpdatePlan({
      hostPackageDir: host14b.packageDir,
      installedHost: '0.2.1-rc.5',
      env: { ...process.env, DSH_TUI_LAUNCHER_PATH: undefined },
    })
    check('plan: a newer engine outside the TUI line is idle, not already aligned',
      update.updatePlanState(waitingEngine) === 'idle'
        && waitingEngine.host.kind === 'none' && waitingEngine.host.newerPublished === '0.3.0-rc.1',
      JSON.stringify(waitingEngine.host))
    const waitingNotice = update.idleReportMessages(waitingEngine)
    check('plan: the idle report says the newer engine waits for a TUI release',
      waitingNotice !== undefined && waitingNotice.report.includes('0.3.0-rc.1')
        && (waitingNotice.report.includes('adds support') || waitingNotice.report.includes('适配')),
      waitingNotice?.report ?? 'undefined')

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
    // English so the assertion can key on wording unique to the unsafe
    // refusal. The preceding `update-engine-failed` line already carries the
    // command and the target version, so asserting those alone would stay
    // green with the current/range interpolation removed (a false green).
    const { setLang: setNoticeLang, getLang: getNoticeLang } = await import('../lib/types/i18n.js')
    const previousNoticeLang = getNoticeLang()
    setNoticeLang('en')
    const destroyed = await captureStderr(() => update.updateTui('fixture-profile', destroyPlan))
    setNoticeLang(previousNoticeLang)
    check('execute: a destroyed engine after a failed step refuses the restart', destroyed.code === 1
      && destroyed.compatible === false && destroyed.host?.verified === false && destroyed.host?.cancelled === false
      && !existsSync(hostE.packageDir),
      JSON.stringify({ code: destroyed.code, host: destroyed.host }))
    // Plan §10: a refusal names the current version, the target range AND the
    // command — the unsafe refusal used to print only the command.
    check('execute: the unsafe refusal names the current version, range and repair command',
      refusalText.includes('Current dsh: 0.2.1-rc.4')
        && refusalText.includes('target range: 0.2.1-rc.5')
        && refusalText.includes('npm install -g --prefix'),
      refusalText.slice(0, 320))

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
      check('cli: a blocked plan exits 1 and asks to wait for the unpublished release', blocked.code === 1
        && blocked.err.includes('Update cancelled') && blocked.err.includes('not published yet')
        && !blocked.err.includes('npm install -g')
        && readCalls(npmCli.calls).length === blockedCalls, JSON.stringify({ code: blocked.code, err: blocked.err.slice(0, 300) }))

      installFakeRegistry({
        '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
        '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.4': {}, '0.2.1-rc.5': {} } },
      })
      const unverified = await capture(() => update.cliUpdate('fixture-profile'))
      check('cli: an unverified engine install exits 1 with the repair command', unverified.code === 1
        && unverified.err.includes('PATH') && unverified.err.includes('npm install -g --prefix')
        && unverified.err.includes('engine not aligned'), JSON.stringify({ code: unverified.code, out: unverified.out.slice(0, 200), err: unverified.err.slice(0, 300) }))

      // ---- 9b. idle + manual-only engine: full guidance, still exit 0 ----
      // A TUI that is already current leaves the engine step as the only
      // blocker. The report must carry the computed command, not just the
      // short reason the toast shows.
      mkdirSync(join(multiDsh, 'lib'), { recursive: true })
      writeFileSync(join(multiDsh, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
      chmodSync(join(multiDsh, 'lib', 'bin.js'), 0o755)
      writeFileSync(join(multiDsh, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh', version: '0.2.1-rc.4', bin: { dsh: 'lib/bin.js' },
      }))
      mkdirSync(join(multiHome, 'bin'), { recursive: true })
      symlinkSync(join(multiDsh, 'lib', 'bin.js'), join(multiHome, 'bin', 'dsh'))
      process.env.PATH = `${join(multiHome, 'bin')}${delimiter}${dirname(process.execPath)}`
      installFakeRegistry({
        '/@deepseek-harness-tui/dsh-tui/latest': { version: repoVersion },
        '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.4': {}, '0.2.1-rc.5': {} } },
      })
      const manualIdle = await capture(() => update.cliUpdate('fixture-profile'))
      check('cli: an unprovable pnpm group prints the full manual guidance', manualIdle.code === 0
        && manualIdle.out.includes('pnpm list -g --depth 0')
        && manualIdle.out.includes('@deepseek-ai/dsh@0.2.1-rc.5'),
      JSON.stringify({ code: manualIdle.code, out: manualIdle.out.slice(0, 400) }))

      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const readonlyPrefix = join(root, 'prefix-readonly-cli')
        const readonlyPkg = join(readonlyPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
        mkdirSync(join(readonlyPkg, 'lib'), { recursive: true })
        writeFileSync(join(readonlyPkg, 'package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh', version: '0.2.1-rc.4', bin: { dsh: 'lib/bin.js' },
        }))
        writeFileSync(join(readonlyPkg, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
        chmodSync(join(readonlyPkg, 'lib', 'bin.js'), 0o755)
        const readonlyBin = join(root, 'readonly-bin')
        mkdirSync(readonlyBin, { recursive: true })
        symlinkSync(join(readonlyPkg, 'lib', 'bin.js'), join(readonlyBin, 'dsh'))
        process.env.PATH = `${readonlyBin}${delimiter}${dirname(process.execPath)}`
        chmodSync(readonlyPrefix, 0o555)
        try {
          const readonlyIdle = await capture(() => update.cliUpdate('fixture-profile'))
          check('cli: an unwritable npm prefix prints the full manual guidance', readonlyIdle.code === 0
            && readonlyIdle.out.includes('sudo npm install -g --prefix')
            && readonlyIdle.out.includes('@deepseek-ai/dsh@0.2.1-rc.5'),
          JSON.stringify({ code: readonlyIdle.code, out: readonlyIdle.out.slice(0, 400) }))
        } finally {
          chmodSync(readonlyPrefix, 0o755)
        }
      }

      // ---- 9c. TUI update + unalignable engine: guidance and a non-zero CLI ----
      // The engine stays inside the target line, so the TUI update itself is
      // safe; but the engine layer was planned and cannot be automated. The
      // CLI must report the guidance and exit non-zero instead of a silent
      // success (R4 of the second review).
      const tuiTarget = '9.9.9'
      writeFileSync(join(multiDsh, 'lib', 'bin.js'), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('dsh 0.2.1-rc.4'); process.exit(0) }
if (args[0] === 'plugin') {
  const pkg = process.env.FAKE_TUI_PACKAGE_JSON
  const spec = args.at(-1) ?? ''
  const target = spec.slice(spec.lastIndexOf('@') + 1)
  if (pkg && target) {
    const manifest = JSON.parse(readFileSync(pkg, 'utf8'))
    manifest.version = target
    writeFileSync(pkg, JSON.stringify(manifest, null, 2) + '\\n')
  }
  process.exit(0)
}
process.exit(0)
`)
      chmodSync(join(multiDsh, 'lib', 'bin.js'), 0o755)
      process.env.PATH = `${join(multiHome, 'bin')}${delimiter}${dirname(process.execPath)}`
      process.env.FAKE_TUI_PACKAGE_JSON = tuiPackagePath
      installFakeRegistry({
        '/@deepseek-harness-tui/dsh-tui/latest': { version: tuiTarget },
        [`/@deepseek-harness-tui/dsh-tui/${tuiTarget}`]: { version: tuiTarget, peerDependencies: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.4 || 0.2.1-rc.5' } },
        '/@deepseek-ai/dsh': { versions: { '0.2.1-rc.4': {}, '0.2.1-rc.5': {} } },
      })
      const r4CallsBefore = readCalls(fakePnpmMulti.calls).length
      const r4 = await capture(() => update.cliUpdate('fixture-profile'))
      check('cli: a TUI update with an unalignable engine reports the manual guidance and exits 1',
        r4.code === 1 && r4.out.includes(tuiTarget) && r4.err.includes('pnpm list -g --depth 0')
          && r4.err.includes('@deepseek-ai/dsh@0.2.1-rc.5') && !r4.err.includes('already current'),
        JSON.stringify({ code: r4.code, out: r4.out.slice(0, 300), err: r4.err.slice(0, 500) }))
      check('cli: the unalignable engine layer runs no pnpm installer',
        readCalls(fakePnpmMulti.calls).length === r4CallsBefore)
      writeFileSync(tuiPackagePath, tuiPackageBackup)
      delete process.env.FAKE_TUI_PACKAGE_JSON
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
  writeFileSync(tuiPackagePath, tuiPackageBackup)
  rmSync(root, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
