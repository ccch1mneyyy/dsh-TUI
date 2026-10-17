#!/usr/bin/env node
/** Windows installer checks. --build DIR verifies payload; --makensis EXE also builds/runs an isolated test installer. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { extractContract, selectKernelVersion, DSH_PACKAGE, TUI_PACKAGE } from './windows/policy.mjs'
import { verifyPayload } from './windows/install-engine.mjs'
import { verifyArchive } from './windows/integrity.mjs'
import { archiveEntries, COMPONENTS } from './windows/archive.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const timings = {}
const timed = async (name, action) => {
  console.log(`[verify] ${name}…`)
  const started = performance.now()
  const result = await action()
  timings[name] = Math.round(performance.now() - started)
  console.log(`[verify] ${name}: ${(timings[name] / 1000).toFixed(1)}s`)
  return result
}
const option = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}
const build = option('--build')
const compiler = option('--makensis')
const exe = option('--exe')
const testTemp = join(build ?? join(root, '.tmp'), 'installer-tests')
mkdirSync(testTemp, { recursive: true })
if (!exe || build || compiler) {
  await timed('Installer regression tests', () => execFileSync(process.execPath, ['--test', join(root, 'scripts/windows/installer.test.mjs')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, TEMP: testTemp, TMP: testTemp },
  }))
}

if (build) {
  const metadata = JSON.parse(readFileSync(join(build, 'metadata.json'), 'utf8'))
  const expected = extractContract(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), readFileSync(join(root, 'src/dsh-adapter/contract.ts'), 'utf8'))
  for (const key of Object.keys(expected)) if (key !== 'kernelVersion') assert.deepEqual(metadata[key], expected[key], `Contract mismatch: ${key}`)
  assert.equal(selectKernelVersion([metadata.kernelVersion], expected), metadata.kernelVersion)
  await timed('Verify full offline payload', () => verifyPayload(join(build, 'payload'), metadata))
  await timed('Verify offline archives', () => {
    archiveEntries(metadata)
    for (const id of COMPONENTS) verifyArchive(join(build, `${id}.bin`), metadata.archives[id].sha256)
  })
  for (const [name, version] of [[DSH_PACKAGE, metadata.kernelVersion], [TUI_PACKAGE, metadata.tuiVersion], ['pnpm', metadata.pnpmVersion]]) {
    assert.equal(JSON.parse(readFileSync(join(build, 'payload/global/node_modules', name, 'package.json'), 'utf8')).version, version)
  }
  console.log(`Payload verified: ${Object.keys(metadata.files).length} files`)
}

if (compiler) {
  assert.ok(build, '--makensis requires --build')
  assert.equal(process.platform, 'win32', 'EXE smoke tests require Windows')
  // The verifier compiles its own TEST_ROOT binary. It never executes a supplied
  // production EXE, which could otherwise change the developer's real installation.
  // Emoji also catches ANSI path loss on Chinese Windows, where CJK alone passes.
  const smoke = join(build, `smoke ${randomUUID().slice(0, 8)} 中文 😀`)
  mkdirSync(smoke)
  const setup = join(smoke, 'test-setup.exe')
  await timed('Compile isolated test EXE', () => execFileSync(compiler, ['/V2', `/DBUILD_DIR=${build}`, `/DTEST_ROOT=${smoke}`, `/DOUTPUT_FILE=${setup}`, join(root, 'scripts/windows/installer.nsi')], { stdio: 'inherit', windowsHide: true }))
  const env = { ...process.env, USERPROFILE: join(smoke, 'user'), HOME: join(smoke, 'user'), APPDATA: join(smoke, 'roaming'), LOCALAPPDATA: join(smoke, 'local'), DSH_HOME: join(smoke, 'user/.dsh'), DEEPSEEK_API_KEY: '', CI: 'true' }
  const prefix = join(smoke, 'npm')
  // Windows environment keys are case-insensitive; native ConPTY must not receive
  // both Path and PATH, or it can inherit the developer's old command ordering.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  // A fresh machine must exercise the bundled bootstrap, not the developer's
  // Node. Later runs exercise reuse of the compatible installed runtime.
  env.Path = `${prefix};${join(process.env.SystemRoot, 'System32')};${process.env.SystemRoot}`
  mkdirSync(env.APPDATA, { recursive: true }); mkdirSync(env.LOCALAPPDATA, { recursive: true })
  const run = (file, args, stream = false) => execFileSync(file, args, { cwd: smoke, env, encoding: 'utf8', stdio: stream ? 'inherit' : 'pipe', windowsHide: true, timeout: 600_000 })
  await timed('Fresh install', () => run(setup, ['/S'], true))
  const node = join(prefix, 'node.exe')
  const dsh = join(prefix, 'node_modules', DSH_PACKAGE, 'lib/bin.js')
  const tui = join(prefix, 'node_modules', TUI_PACKAGE, 'bin/dsh-tui.js')
  const metadata = JSON.parse(readFileSync(join(build, 'metadata.json'), 'utf8'))
  assert.equal(run(node, [dsh, '--version']).trim(), metadata.kernelVersion)
  assert.match(run(node, [tui, '--version']), new RegExp(`profile: ${metadata.tuiVersion.replaceAll('.', '\\.')}`))
  const config = run(node, [dsh, '--profile', 'dsh-tui', '--dump-config'])
  assert.match(config, /dsh-tui/)
  writeFileSync(join(smoke, 'profile-config.txt'), config)
  console.log(run(node, [join(root, 'scripts/windows/smoke-terminal.mjs'), prefix]).trim())
  // Reproduce the reported 0.14 TUI / 0.1.5-rc.1 DSH mismatch. An older
  // compatible kernel must be replaced, not accepted merely as compatible.
  const kernelManifest = join(prefix, 'node_modules', DSH_PACKAGE, 'package.json')
  const original = readFileSync(kernelManifest, 'utf8')
  const sentinel = join(prefix, 'node_modules', DSH_PACKAGE, 'installer-smoke-sentinel')
  writeFileSync(kernelManifest, JSON.stringify({ ...JSON.parse(original), version: '0.1.5-rc.1' }))
  writeFileSync(sentinel, 'old-kernel')
  await timed('Upgrade older DSH RC', () => run(setup, ['/S'], true))
  assert.equal(run(node, [dsh, '--version']).trim(), metadata.kernelVersion)
  assert.equal(existsSync(sentinel), false)
  // Reinstall keeps the same bundled kernel; unused components are not extracted.
  writeFileSync(sentinel, 'keep-compatible-kernel')
  await timed('Reinstall with current kernel', () => run(setup, ['/S'], true))
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep-compatible-kernel')
  // A silent downgrade must refuse without touching the newer package.
  writeFileSync(kernelManifest, JSON.stringify({ ...JSON.parse(original), version: '99.0.0' }))
  await timed('Refuse silent downgrade', () => assert.throws(() => run(setup, ['/S']), error => error.status === 2))
  assert.equal(JSON.parse(readFileSync(kernelManifest, 'utf8')).version, '99.0.0')
  writeFileSync(kernelManifest, original)
  const protectedFile = join(env.DSH_HOME, 'installer-smoke-user-data')
  writeFileSync(protectedFile, 'preserve-user-data')
  const uninstaller = join(smoke, 'test-uninstall.exe')
  cpSync(join(smoke, 'metadata/unins000.exe'), uninstaller)
  await timed('Default uninstall', async () => {
    run(uninstaller, ['/S'], true)
    // NSIS may run its uninstaller from a temporary copy and return the original
    // process before that copy finishes. Receipt removal is the final success step.
    const uninstallDeadline = Date.now() + 60_000
    while (existsSync(join(smoke, 'metadata/installation.json'))) {
      if (Date.now() > uninstallDeadline) throw new Error(`Uninstaller did not finish: ${smoke}`)
      await delay(250)
    }
  })
  assert.equal(existsSync(join(prefix, 'dsh-tui.cmd')), false)
  assert.ok(existsSync(join(prefix, 'dsh.cmd')))
  assert.equal(readFileSync(protectedFile, 'utf8'), 'preserve-user-data')
  assert.ok(existsSync(join(env.DSH_HOME, 'profiles/dsh-tui/package.json')))
  writeFileSync(join(build, 'smoke-result.json'), `${JSON.stringify({ passed: true, root: smoke, timingsMs: timings, checks: ['fresh install', 'DSH version', 'TUI profile version', 'profile composition', 'older RC upgrade', 'compatible reinstall', 'silent downgrade refusal', 'default uninstall', 'user data preservation'] }, null, 2)}\n`)
  console.log(`EXE smoke checks passed: ${smoke}`)
}

if (exe) {
  const descriptor = openSync(exe, 'r')
  const header = Buffer.alloc(2)
  try { readSync(descriptor, header, 0, 2, 0) } finally { closeSync(descriptor) }
  assert.equal(header.toString('ascii'), 'MZ', 'Not a Windows executable')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(exe)) hash.update(chunk)
  const line = `${hash.digest('hex')}  ${exe.split(/[\\/]/).at(-1)}\n`
  writeFileSync(join(dirname(exe), 'SHA256SUMS'), line)
  console.log(line.trim())
}
