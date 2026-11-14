/**
 * npm prefix / pnpm group ownership and engine replacement -> profile restart.
 * Real files, installer children and restart children; only the package manager
 * and registry are fixtures. No network, real global prefix or user profile.
 * Run: node --import tsx/esm scripts/verify-update-restart-entry.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectHostInstall, planHostStep } from '../src/updateHost.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-update-restart-')))
const hostName = '@deepseek-ai/dsh'
const before = '0.2.1-rc.5'
const after = '0.2.2-rc.2'
const range = `${before} || ${after}`
const repo = resolve(import.meta.dirname, '..')
const updateUrl = pathToFileURL(join(repo, 'src', 'update.ts')).href
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
let failures = 0

function check(name: string, run: () => void): void {
  try { run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
}

function manifest(dir: string, value: object): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value))
}

function host(dir: string, version = before): string {
  manifest(dir, { name: hostName, version, bin: { dsh: 'lib/bin.js' } })
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'bin.js'), `if (process.argv[2] === '--version') { console.log('dsh ${version}'); process.exit(0) }\n`)
  return dir
}

function step(install: ReturnType<typeof detectHostInstall>) {
  return planHostStep({ current: before, range, available: [before, after], install, packageName: hostName })
}

function fixtureEnv(scratch: string, bins: string[], config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, '.dsh'),
    PATH: [...bins, dirname(process.execPath)].join(delimiter), DSH_TUI_RESTART_FIXTURE: config,
    DSH_TUI_LANG: 'en', DSH_TUI_UPDATE_TIMEOUT_MS: '15000' }
  for (const key of Object.keys(env)) {
    if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(key)) delete env[key]
  }
  for (const key of ['DSH_TUI_LAUNCHER_PATH', 'DSH_TUI_LAUNCHER_VERSION', 'DSH_TUI_LAUNCHER_ABSENT', 'DSH_TUI_UPDATE_ENGINE', 'DSH_TUI_UPDATE_LAUNCHER', 'DSH_TUI_DSH_PM', 'DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_HOST_ENTRY', 'DSH_TUI_UPDATED_DSH_FROM', 'DSH_TUI_UPDATED_FROM', 'DSH_TUI_STANDALONE', 'DSH_TUI_STANDALONE_BINARY']) delete env[key]
  return env
}

function shim(bin: string, name: string, script: string): void {
  mkdirSync(bin, { recursive: true })
  const file = join(bin, process.platform === 'win32' ? `${name}.cmd` : name)
  writeFileSync(file, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  if (process.platform !== 'win32') chmodSync(file, 0o755)
}

try {
  // These literals are the filesystem layout, not output derived by the detector.
  for (const slot of ['5', 'v11']) {
    const home = join(root, `layout-${slot}`)
    const group = slot === '5' ? join(home, 'global', slot) : join(home, 'global', slot, '6-install-entity')
    const pkg = host(join(group, 'node_modules', '@deepseek-ai', 'dsh'))
    manifest(group, { dependencies: { [hostName]: before } })
    const detected = detectHostInstall(pkg, {})
    check(`${slot}: singleton group identifies the manifest-owning directory`, () => {
      assert.equal(detected.groupRoot, realpathSync(group))
      assert.equal(detected.pnpmHome, home)
      assert.equal(step(detected).kind, 'install')
    })
    manifest(group, { dependencies: { [hostName]: before, 'other-cli': '1.0.0' } })
    check(`${slot}: a multi-member group is never replaced`, () => {
      const planned = step(detectHostInstall(pkg, {}))
      assert.equal(planned.kind, 'unavailable')
      if (planned.kind === 'unavailable') assert.equal(planned.reason, 'group-unproven')
    })
    if (slot === 'v11') {
      manifest(group, { dependencies: { [hostName]: before } })
      const alias = join(dirname(group), 'hash-alias')
      symlinkSync(group, alias, directoryLink)
      check('v11: an alias resolves to the real singleton group', () => {
        const aliased = detectHostInstall(join(alias, 'node_modules', '@deepseek-ai', 'dsh'), {})
        assert.equal(aliased.groupRoot, realpathSync(group))
        assert.equal(step(aliased).kind, 'install')
      })
    }
  }

  const manager = join(root, 'fake-pnpm.cjs')
  writeFileSync(manager, `
const fs = require('node:fs')
const path = require('node:path')
const fixture = JSON.parse(fs.readFileSync(process.env.DSH_TUI_RESTART_FIXTURE, 'utf8'))
const { root, home, oldGroup, newGroup, newPkg, record, version, exitCode, invalidEntry } = fixture
if (path.dirname(oldGroup) !== path.join(home, 'global', 'v11') || !oldGroup.startsWith(root + path.sep)) throw Error('unsafe old group')
const name = '@deepseek-ai/dsh'
fs.mkdirSync(path.join(newPkg, 'lib'), { recursive: true })
fs.writeFileSync(path.join(newPkg, 'package.json'), JSON.stringify({ name, version, bin: { dsh: invalidEntry ? '../outside.js' : 'lib/bin.js' } }))
fs.writeFileSync(path.join(newPkg, 'lib', 'bin.js'), [
  "if (process.argv[2] === '--version') { console.log('dsh " + version + "'); process.exit(0) }",
  "require('node:fs').writeFileSync(" + JSON.stringify(record) + ", JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, resume: process.env.DSH_TUI_RESUME_SESSION, engineFrom: process.env.DSH_TUI_UPDATED_DSH_FROM, promptSent: process.env.DSH_TUI_LAUNCH_PROMPT_SENT }))",
].join('\\n'))
fs.mkdirSync(path.join(newGroup, 'node_modules', '@deepseek-ai'), { recursive: true })
fs.writeFileSync(path.join(newGroup, 'package.json'), JSON.stringify({ dependencies: { [name]: version } }))
fs.symlinkSync(newPkg, path.join(newGroup, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
const bin = path.join(home, 'bin')
const entry = path.join(newGroup, 'node_modules', name, 'lib', 'bin.js')
fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), process.platform === 'win32'
  ? '@echo off\\r\\n"' + process.execPath + '" "' + entry + '" %*\\r\\n'
  : '#!/bin/sh\\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(entry) + ' "$@"\\n')
if (process.platform !== 'win32') fs.chmodSync(path.join(bin, 'dsh'), 0o755)
fs.rmSync(oldGroup, { recursive: true, force: true })
process.exit(exitCode)
`)

  for (const [label, disabled, exitCode, invalidEntry, customScript] of [
    ['direct profile', false, 0, false, false],
    ['host-entry disabled with custom host flags', true, 0, false, false],
    ['tolerated installer failure after group replacement', false, 1, false, false],
    ['an unproven replacement entry refuses restart', false, 0, true, false],
    ['a custom source launcher is not redirected to dsh', false, 0, false, true],
  ] as const) {
    const scratch = join(root, `restart-${disabled}-${exitCode}-${invalidEntry}-${customScript}`)
    const home = join(scratch, 'pnpm')
    const oldGroup = join(home, 'global', 'v11', '6-old')
    const newGroup = join(home, 'global', 'v11', '7-new')
    const oldPkg = host(join(home, 'store', 'v11', 'links', '@deepseek-ai', 'dsh', before, 'old', 'node_modules', '@deepseek-ai', 'dsh'))
    const newPkg = join(home, 'store', 'v11', 'links', '@deepseek-ai', 'dsh', after, 'new', 'node_modules', '@deepseek-ai', 'dsh')
    const oldLogical = join(oldGroup, 'node_modules', '@deepseek-ai', 'dsh')
    const oldBin = join(oldLogical, 'lib', 'bin.js')
    mkdirSync(dirname(oldLogical), { recursive: true })
    symlinkSync(oldPkg, oldLogical, directoryLink)
    manifest(oldGroup, { dependencies: { [hostName]: before } })
    const bin = join(home, 'bin')
    shim(bin, 'dsh', oldBin)
    shim(bin, 'pnpm', manager)
    const record = join(scratch, 'replacement.json')
    const config = join(scratch, 'fixture.json')
    writeFileSync(config, JSON.stringify({ root, home, oldGroup, newGroup, newPkg, record, version: after, exitCode, invalidEntry }))
    const originalScript = customScript ? join(scratch, 'custom-launcher.cjs') : oldBin
    if (customScript) writeFileSync(originalScript, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, resume: process.env.DSH_TUI_RESUME_SESSION, engineFrom: process.env.DSH_TUI_UPDATED_DSH_FROM, promptSent: process.env.DSH_TUI_LAUNCH_PROMPT_SENT, custom: true }))\n`)
    const args = ['--profile', 'fixture-profile', '--patch', './overlay with spaces.yml', '--from-default-profile', 'default', '--', 'literal app prompt']
    const driver = join(scratch, 'driver.mjs')
    writeFileSync(driver, `
import assert from 'node:assert/strict'
import { updateTuiAndRestart, resolveUpdatePlan } from ${JSON.stringify(updateUrl)}
// This driver asserts the returned codes, so it must keep the supervised spawn
// fallback: an in-place execve would replace the process before the assertions
// run. Real in-place restarts are covered by verify-restart-process.ts.
process.execve = undefined
process.argv = [process.execPath, ${JSON.stringify(originalScript)}, ...${JSON.stringify(args)}]
globalThis.fetch = async url => {
  if (String(url).endsWith('/@deepseek-harness-tui/dsh-tui/latest')) return Response.json({ version: ${JSON.stringify(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version)} })
  if (String(url).endsWith('/@deepseek-ai/dsh')) return Response.json({ versions: { ${JSON.stringify(before)}: {}, ${JSON.stringify(after)}: {} } })
  throw Error('unexpected registry route ' + url)
}
const plan = await resolveUpdatePlan({ hostPackageDir: ${JSON.stringify(oldPkg)}, installedHost: ${JSON.stringify(before)} })
assert.equal(plan.host.kind, 'install')
const result = await updateTuiAndRestart('saved-session', 'fixture-profile', plan, 'dsh')
assert.deepEqual(result, ${JSON.stringify(invalidEntry ? { updateCode: 1, restartCode: 1 } : { updateCode: 0, restartCode: 0 })})
`)
    const env = fixtureEnv(scratch, [bin], config)
    if (disabled) { env.DSH_TUI_HOST_ENTRY = '0'; env.DSH_TUI_HOST_ENTRY_PATH = join(scratch, 'not-the-dsh-entry.js') }
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--stack-trace-limit=37', driver], { cwd: repo, env, encoding: 'utf8', timeout: 30000 })
    check(`${label}: actual update/restart preserves the launch contract`, () => {
      assert.equal(child.status, 0, child.stdout + child.stderr)
      assert.equal(existsSync(oldBin), false, 'the old logical group entry must really be gone')
      if (invalidEntry) {
        assert.equal(existsSync(record), false, 'an unproven entry must not spawn any replacement')
        assert.match(child.stderr, /Repair the engine first:/)
        return
      }
      const captured = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; execArgv: string[]; resume: string; engineFrom?: string; promptSent: string; custom?: boolean }
      assert.equal(captured.custom === true, customScript, 'only the original custom launcher writes this marker')
      assert.deepEqual(captured.argv, args, 'preserve host options and app arguments verbatim')
      assert.deepEqual(captured.execArgv, ['--import', 'tsx/esm', '--stack-trace-limit=37'])
      assert.equal(captured.resume, 'saved-session')
      assert.equal(captured.promptSent, '1')
      assert.equal(captured.engineFrom, exitCode === 0 ? before : undefined)
    })
  }

  const npmManager = join(root, 'fake-npm.cjs')
  writeFileSync(npmManager, `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const fixture = JSON.parse(fs.readFileSync(process.env.DSH_TUI_RESTART_FIXTURE, 'utf8'))
const { root, prefix, pkg, target, landed, cliVersion, mode, calls, record } = fixture
assert.deepEqual(process.argv.slice(2), ['install', '-g', '--prefix', prefix, '@deepseek-ai/dsh@' + target])
assert.equal(pkg, path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
assert.ok(fs.realpathSync(pkg).startsWith(root + path.sep))
fs.writeFileSync(calls, JSON.stringify(process.argv.slice(2)))
if (mode === 'failure') process.exit(1)
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: landed, bin: { dsh: 'lib/bin.js' } }))
fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), [
  "if (process.argv[2] === '--version') { console.log('dsh " + cliVersion + "'); process.exit(0) }",
  "require('node:fs').writeFileSync(" + JSON.stringify(record) + ", JSON.stringify({ entry: process.argv[1], version: " + JSON.stringify(cliVersion) + ", argv: process.argv.slice(2), execArgv: process.execArgv, resume: process.env.DSH_TUI_RESUME_SESSION, engineFrom: process.env.DSH_TUI_UPDATED_DSH_FROM, promptSent: process.env.DSH_TUI_LAUNCH_PROMPT_SENT }))",
].join('\\n'))
if (mode === 'removed') {
  assert.equal(fs.realpathSync(pkg), pkg)
  fs.rmSync(pkg, { recursive: true, force: true })
}
`)

  for (const [label, mode, landed, pathVersion, disabled, safe] of [
    ['absolute A with older PATH B', 'update', after, '0.1.7-rc.2', false, true],
    ['disabled host-entry with older PATH B', 'update', after, '0.1.7-rc.2', true, true],
    ['failed install keeps the original A', 'failure', before, '0.1.7-rc.2', false, true],
    ['a target-version B cannot replace a missing A', 'removed', after, after, false, false],
    ['a same-prefix downgrade is refused', 'update', '0.2.1-rc.4', after, false, false],
    ['an ahead but unsupported engine is refused', 'update', '0.2.2-rc.4', after, false, false],
    ['an entry reporting a downgrade is refused', 'cli-mismatch', after, '0.1.7-rc.2', false, false],
  ] as const) {
    const scratch = join(root, `npm-${mode}-${landed}-${disabled}`)
    const prefix = join(scratch, 'prefix A', 'npm')
    const pkg = host(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    const originalEntry = join(pkg, 'lib', 'bin.js')
    const pathPrefix = join(scratch, 'prefix B', 'npm')
    const pathPkg = host(join(pathPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'), pathVersion)
    const pathManifest = readFileSync(join(pathPkg, 'package.json'), 'utf8')
    const record = join(scratch, 'replacement.json')
    writeFileSync(originalEntry, readFileSync(originalEntry, 'utf8') + `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ entry: process.argv[1], version: ${JSON.stringify(before)}, argv: process.argv.slice(2), execArgv: process.execArgv, resume: process.env.DSH_TUI_RESUME_SESSION, engineFrom: process.env.DSH_TUI_UPDATED_DSH_FROM, promptSent: process.env.DSH_TUI_LAUNCH_PROMPT_SENT }))\n`)
    // Also record an accidental B replacement; its --version probe stays inert.
    const pathEntry = join(pathPkg, 'lib', 'bin.js')
    writeFileSync(pathEntry, readFileSync(pathEntry, 'utf8') + `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ entry: process.argv[1], version: ${JSON.stringify(pathVersion)} }))\n`)
    const bin = join(scratch, 'fake-bin')
    const pathBin = join(pathPrefix, 'bin')
    shim(bin, 'npm', npmManager)
    shim(pathBin, 'dsh', pathEntry)

    // A real source package copy is needed: symlinking src would resolve its
    // import.meta.url back to the checkout and bypass standard profile links.
    const profiles = join(scratch, '.dsh', 'profiles')
    const tui = join(profiles, 'fixture-profile', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
    cpSync(join(repo, 'src'), join(tui, 'src'), { recursive: true })
    cpSync(join(repo, 'package.json'), join(tui, 'package.json'))
    // The real Windows installer supervisor resolves both files beside this copy.
    mkdirSync(join(tui, 'assets'), { recursive: true })
    for (const extension of ['ps1', 'cs']) {
      cpSync(join(repo, 'assets', `windows-installer.${extension}`), join(tui, 'assets', `windows-installer.${extension}`))
    }
    symlinkSync(join(repo, 'node_modules'), join(tui, 'node_modules'), directoryLink)
    const fallback = join(profiles, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dirname(fallback), { recursive: true })
    symlinkSync(pkg, fallback, directoryLink)

    const calls = join(scratch, 'install.json')
    const config = join(scratch, 'fixture.json')
    writeFileSync(config, JSON.stringify({ root, prefix, pkg, target: after, landed,
      cliVersion: mode === 'cli-mismatch' ? '0.2.1-rc.4' : landed, mode, calls, record }))
    const args = ['--profile', 'fixture-profile', '--patch', './overlay with spaces.yml', '--from-default-profile', 'default', '--', 'literal app prompt']
    const driver = join(scratch, 'driver.mjs')
    writeFileSync(driver, `
import assert from 'node:assert/strict'
import { resolveUpdatePlan, updateTuiAndRestart } from ${JSON.stringify(pathToFileURL(join(tui, 'src', 'update.ts')).href)}
// Same as the direct-profile driver above: assert the returned codes instead
// of letting an in-place execve replace this process with the fixture.
process.execve = undefined
process.argv = [process.execPath, ${JSON.stringify(originalEntry)}, ...${JSON.stringify(args)}]
globalThis.fetch = async url => {
  if (String(url).endsWith('/@deepseek-harness-tui/dsh-tui/latest')) return Response.json({ version: ${JSON.stringify(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version)} })
  if (String(url).endsWith('/@deepseek-ai/dsh')) return Response.json({ versions: { ${JSON.stringify(before)}: {}, ${JSON.stringify(after)}: {} } })
  throw Error('unexpected registry route ' + url)
}
const plan = await resolveUpdatePlan()
assert.equal(plan.tui.kind, 'latest')
assert.equal(plan.currentHost, ${JSON.stringify(before)})
assert.equal(plan.host.kind, 'install')
assert.equal(plan.host.packageDir, ${JSON.stringify(pkg)})
assert.deepEqual(plan.host.command, { file: 'npm', args: ['install', '-g', '--prefix', ${JSON.stringify(prefix)}, ${JSON.stringify(`${hostName}@${after}`)}] })
const result = await updateTuiAndRestart('saved-session', 'fixture-profile', plan, 'dsh')
assert.deepEqual(result, ${JSON.stringify(safe ? { updateCode: 0, restartCode: 0 } : { updateCode: 1, restartCode: 1 })})
`)
    const env = fixtureEnv(scratch, [bin, pathBin], config)
    if (disabled) { env.DSH_TUI_HOST_ENTRY = '0'; env.DSH_TUI_HOST_ENTRY_PATH = join(scratch, 'unused-host-entry.js') }
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--stack-trace-limit=37', driver], { cwd: repo, env, encoding: 'utf8', timeout: 30000 })
    check(`${label}: actual npm install/restart stays on A or safely refuses`, () => {
      assert.equal(child.status, 0, child.stdout + child.stderr)
      assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), ['install', '-g', '--prefix', prefix, `${hostName}@${after}`])
      assert.equal(readFileSync(join(pathPkg, 'package.json'), 'utf8'), pathManifest, 'the installer must not modify B')
      if (!safe) {
        assert.equal(existsSync(record), false, 'no unsafe replacement process may start')
        assert.match(child.stderr, /Repair the engine first:/)
        return
      }
      const captured = JSON.parse(readFileSync(record, 'utf8')) as { entry: string; version: string; argv: string[]; execArgv: string[]; resume: string; engineFrom?: string; promptSent: string }
      assert.equal(captured.entry, originalEntry, 'PATH B must never replace the absolute A entry')
      assert.equal(captured.version, landed)
      assert.deepEqual(captured.argv, args)
      assert.deepEqual(captured.execArgv, ['--import', 'tsx/esm', '--stack-trace-limit=37'])
      assert.equal(captured.resume, 'saved-session')
      assert.equal(captured.promptSent, '1')
      assert.equal(captured.engineFrom, undefined, 'a PATH mismatch or failed install is not a verified suite advance')
    })
  }
} finally {
  // Only remove the exact temporary fixture owned by this script.
  assert.equal(dirname(root), realpathSync(tmpdir()))
  assert.ok(basename(root).startsWith('verify-update-restart-'))
  rmSync(root, { recursive: true, force: true })
}
assert.equal(failures, 0, `${failures} updater restart/ownership regressions failed`)
console.log('npm/pnpm engine ownership and direct-profile restart checks passed')
