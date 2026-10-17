/** Run with node --test scripts/windows/installer.test.mjs; no real user state is used. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, statSync, rmSync, chmodSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { extractContract, kernelAction, selectKernelVersion, compatibleKernelVersions, newerKernelVersions, assertKernelVersion, tuiNeedsDowngrade, mergeProfile, updatePath, supportsNode } from './policy.mjs'
import { FileTransaction, recoverTransaction } from './transaction.mjs'
import { normalizeBundledWorkspaceReferences } from './payload-lock.mjs'
import { installPayload, prepareStage, uninstallPackages } from './install-engine.mjs'
import { collectPackageTree } from './package-tree.mjs'
import { sha256File, verifyArchive } from './integrity.mjs'
import { archiveEntries, buildArchives, extractArchives } from './archive.mjs'

const metadata = {
  tuiVersion: '0.14.0', kernelVersion: '0.2.0-rc.2',
  kernelMinimum: '0.1.0-rc.6', kernelMaximum: '0.2.0-rc.2',
  kernelPeerRange: '^0.1.0-rc.6 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2',
}

test('Node reuse requires the supported version range and x64 native-module architecture', () => {
  const range = '^22.19 || >=24'
  for (const [version, architecture, expected] of [
    ['22.19.0', 'x64', true], ['24.16.0', 'x64', true],
    ['22.18.0', 'x64', false], ['23.0.0', 'x64', false], ['20.19.0', 'x64', false],
    ['24.16.0', 'ia32', false], ['24.16.0', 'arm64', false], ['invalid', 'x64', false],
  ]) assert.equal(supportsNode(version, architecture, range), expected, `${version} ${architecture}`)
})

test('version gates distinguish missing, old, compatible, ahead, and unsupported prereleases', () => {
  for (const [installed, expected] of [
    [undefined, 'install'], ['0.1.0-rc.5', 'upgrade'], ['0.1.0-rc.6', 'upgrade'],
    ['0.1.5-rc.1', 'upgrade'], ['0.2.0-rc.1', 'upgrade'], ['0.2.0-rc.2', 'keep'],
    ['0.2.0-rc.10', 'downgrade'], ['0.2.0', 'downgrade'], ['0.1.6-alpha.1', 'upgrade'],
  ]) assert.equal(kernelAction(installed, metadata), expected, String(installed))
  assert.throws(() => kernelAction('damaged', metadata), /version/i)
  assert.equal(tuiNeedsDowngrade('0.14.1', metadata), true)
  assert.equal(tuiNeedsDowngrade('0.14.0', metadata), false)
})

test('kernel selection chooses the newest published compatible RC without opting into alpha', () => {
  assert.equal(selectKernelVersion(['0.1.5-rc.1', '0.2.1-alpha.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.10'], metadata), '0.2.0-rc.2')
  assert.equal(selectKernelVersion(['0.2.0-rc.1'], metadata), '0.2.0-rc.1')
  assert.throws(() => selectKernelVersion(['0.2.1-alpha.2', '0.2.0-rc.10'], metadata), /compatible RC/)
  assert.throws(() => selectKernelVersion('0.2.0-rc.2', metadata), /version list/)
})

test('kernel auto-detection ranks compatible RCs and flags newer unvalidated ones', () => {
  const versions = ['0.1.0-rc.5', '0.1.0-rc.6', '0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.3.0-rc.1', '0.1.0-alpha.1']
  const compatible = compatibleKernelVersions(versions, metadata)
  assert.equal(compatible[0], '0.2.0-rc.2')
  assert.ok(compatible.every(value => value.includes('-rc.')))
  assert.ok(!compatible.includes('0.1.0-rc.5'))
  assert.ok(!compatible.includes('0.1.0-alpha.1'))
  assert.equal(selectKernelVersion(versions, metadata), '0.2.0-rc.2')
  assert.deepEqual(newerKernelVersions(versions, metadata), ['0.3.0-rc.1', '0.2.0-rc.3'])
  assert.equal(assertKernelVersion('0.1.7-rc.2', metadata), '0.1.7-rc.2')
  assert.throws(() => assertKernelVersion('0.2.0-rc.3', metadata), /outside the validated range/)
  assert.throws(() => assertKernelVersion('0.2.0', metadata), /not an RC release/)
  assert.throws(() => selectKernelVersion(['0.0.1-rc.1'], metadata), /No published compatible RC/)
})

test('the bundled brand assets stay valid multi-size ICO and BMP files', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const ico = readFileSync(join(here, 'assets/dsh-tui.ico'))
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field')
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type field')
  const count = ico.readUInt16LE(4)
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const sizes = new Set()
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16
    const width = ico[base] || 256
    const height = ico[base + 1] || 256
    const bytes = ico.readUInt32LE(base + 8)
    const offset = ico.readUInt32LE(base + 12)
    assert.ok(offset + bytes <= ico.length, `ICO entry ${i} overruns the file`)
    assert.equal(width, height, `ICO entry ${i} is not square`)
    assert.ok(!ico.subarray(offset, offset + 8).equals(pngSignature), 'ICO entries stay uncompressed BMP for NSIS')
    assert.equal(ico.readUInt32LE(offset), 40, 'ICO entry carries a BITMAPINFOHEADER')
    sizes.add(width)
  }
  assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256])
  const frames = ['zh', 'en'].flatMap(locale => Array.from({ length: 16 }, (_, step) => `dsh-tui-welcome-${locale}-${String(step).padStart(2, '0')}.bmp`))
  for (const [file, width, height] of [['dsh-tui-header.bmp', 150, 57], ...frames.map(frame => [frame, 164, 314])]) {
    const bmp = readFileSync(join(here, 'assets', file))
    assert.equal(bmp.toString('ascii', 0, 2), 'BM', file)
    assert.equal(bmp.readUInt32LE(14), 40, `${file} uses BITMAPINFOHEADER`)
    assert.equal(bmp.readInt32LE(18), width, file)
    assert.equal(bmp.readInt32LE(22), height, file)
    assert.equal(bmp.readUInt16LE(28), 24, `${file} stays 24-bit`)
  }
  // The animation is only real when the README timeline actually redraws: the
  // whale blinks on step 1, wags its tail from step 7, and the star tile cycles.
  const digest = frame => createHash('sha256').update(readFileSync(join(here, 'assets', frame))).digest('hex')
  const [zh, en] = [frames.slice(0, 16).map(digest), frames.slice(16).map(digest)]
  assert.ok(new Set(zh).size >= 8, `the 16 frames must animate (only ${new Set(zh).size} distinct)`)
  assert.notEqual(zh[0], zh[1], 'the whale blinks on step 1')
  assert.notEqual(zh[7], zh[10], 'the tail wags between step 7 and step 10')
  assert.notEqual(zh[1], zh[5], 'the star tile changes between step 1 and step 5')
  assert.notEqual(zh[1], en[1], 'the star tile follows the README language')
  assert.notEqual(zh[9], en[9], 'the thank-you tile follows the README language')
  const nsi = readFileSync(join(here, 'installer.nsi'), 'utf8')
  for (const asset of ['assets\\dsh-tui.ico', 'assets\\dsh-tui-header.bmp', ...frames.map(frame => `assets\\${frame}`)]) assert.ok(nsi.includes(asset), `installer.nsi references ${asset}`)
  assert.ok(nsi.includes('MUI_PAGE_WELCOME'), 'welcome page present')
  assert.ok(nsi.includes('Page custom ConfirmPageShow ConfirmPageLeave'), 'confirmation page present')
})

test('payload builds refresh an older RC lock while explicit locks remain reproducible', { skip: process.platform !== 'win32' }, () => {
  for (const locked of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-installer-build-'))
    const out = join(root, 'out')
    const locks = join(root, 'locks')
    mkdirSync(join(out, 'packages/dsh'), { recursive: true }); mkdirSync(locks)
    const lock = { packages: { '': { dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.1' } }, 'node_modules/@deepseek-ai/dsh': { version: '0.1.5-rc.1' } } }
    writeFileSync(join(out, 'packages/dsh/package-lock.json'), JSON.stringify(lock))
    writeFileSync(join(locks, 'dsh.json'), JSON.stringify(lock))
    const npmCli = join(root, 'npm-probe.cjs')
    // Replace only the npm boundary; execute the real builder through version
    // resolution and lock preparation, then stop before downloading packages.
    writeFileSync(npmCli, `
      const fs = require('node:fs')
      const args = process.argv.slice(2)
      fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify(args) + '\\n')
      if (args[0] === 'view') console.log(JSON.stringify(['0.1.5-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2']))
      else if (args[0] === 'install') {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
        const version = pkg.dependencies['@deepseek-ai/dsh']
        fs.writeFileSync('package-lock.json', JSON.stringify({packages:{'':pkg,'node_modules/@deepseek-ai/dsh':{version}}}))
      } else { console.error('npm probe stopped before package installation'); process.exit(19) }
    `)
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./build-installer-payload.mjs', import.meta.url)), '--out', out, '--npm-cli', npmCli, ...(locked ? ['--locks', locks] : [])], { stdio: 'pipe' }), error => error.stderr.toString().includes('npm probe stopped before package installation'))
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls.map(args => args[0]), locked ? ['ci'] : ['view', 'install', 'ci'])
    assert.equal(JSON.parse(readFileSync(join(out, 'packages/dsh/package.json'))).dependencies['@deepseek-ai/dsh'], locked ? '0.1.5-rc.1' : '0.2.0-rc.2')
    assert.equal(JSON.parse(readFileSync(join(out, 'packages/dsh/package-lock.json'))).packages['node_modules/@deepseek-ai/dsh'].version, locked ? '0.1.5-rc.1' : '0.2.0-rc.2')
  }
})

test('contract extraction derives bounds and rejects a primary outside the peer range', () => {
  const source = "export const UPSTREAM_VALIDATED_VERSION = '0.2.0-rc.2'\nexport const UPSTREAM_VALIDATED_VERSIONS = ['0.1.0-rc.6', '0.2.0-rc.2'] as const"
  const pkg = { version: '0.14.0', engines: { node: '^22.19 || >=24' }, peerDependencies: { '@deepseek-ai/dsh-agent': metadata.kernelPeerRange } }
  assert.equal(extractContract(pkg, source).kernelMaximum, '0.2.0-rc.2')
  assert.throws(() => extractContract({ ...pkg, peerDependencies: { '@deepseek-ai/dsh-agent': '0.1.0-rc.6' } }, source), /primary/i)
})

test('profile merge preserves other plugins and metadata without duplicating bundles', () => {
  const original = { name: 'custom', private: true, dependencies: { other: '^1', '@deepseek-harness-tui/dsh-tui': '0.11.2' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'other'], extra: true } } }
  const merged = mergeProfile(original, '0.14.0')
  assert.equal(original.dependencies['@deepseek-harness-tui/dsh-tui'], '0.11.2')
  assert.equal(merged.dependencies.other, '^1')
  assert.equal(merged.name, 'custom')
  assert.equal(merged.dsh.profile.extra, true)
  assert.deepEqual(merged.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'other', '@deepseek-harness-tui/dsh-tui'])
  assert.deepEqual(mergeProfile(merged, '0.14.0'), merged)
  assert.throws(() => mergeProfile({ dsh: { profile: { bundles: 'broken' } } }, '0.14.0'), /bundles/)
})

test('PATH edits keep unrelated entries, recognize spelling variants, and retain shared commands', () => {
  const prefix = 'C:\\Users\\A\\AppData\\Roaming\\npm'
  assert.deepEqual(updatePath('C:\\Tool;', prefix, 'add'), { value: `C:\\Tool;${prefix}`, changed: true })
  assert.equal(updatePath(`"${prefix.toUpperCase()}\\";C:\\Tool`, prefix, 'add').changed, false)
  assert.equal(updatePath(`C:\\Tool;${prefix}`, prefix, 'remove', false, false).changed, false)
  assert.equal(updatePath(`C:\\Tool;${prefix}`, prefix, 'remove', true, true).changed, false)
  assert.equal(updatePath(`C:\\Tool;${prefix};C:\\Other`, prefix, 'remove', true, false).value, 'C:\\Tool;C:\\Other')
})

test('failed replacements restore files and leave unrelated user data intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-transaction-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const target = join(root, 'owned'); writeFileSync(target, 'before')
  writeFileSync(join(root, 'credentials'), 'keep')
  const source = join(stage, 'new'); writeFileSync(source, 'after')
  const tx = new FileTransaction(stage, [root])
  tx.replace(source, target)
  assert.equal(readFileSync(target, 'utf8'), 'after')
  assert.throws(() => tx.replace(join(stage, 'missing'), join(root, 'second')))
  tx.rollback()
  assert.equal(readFileSync(target, 'utf8'), 'before')
  assert.equal(readFileSync(join(root, 'credentials'), 'utf8'), 'keep')
})

test('a persisted interrupted transaction can be recovered by a new process', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-recovery-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const source = join(stage, 'new'); writeFileSync(source, 'after')
  const target = join(root, 'new-file')
  new FileTransaction(stage, [root]).replace(source, target)
  recoverTransaction(stage, [root])
  assert.equal(existsSync(target), false)
})

test('transaction refuses paths outside its authorized roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-bounds-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const source = join(stage, 'new'); writeFileSync(source, 'after')
  const tx = new FileTransaction(stage, [root])
  assert.throws(() => tx.replace(source, join(root, '..', 'outside')), /outside/i)
})

test('transaction refuses a parent junction pointing outside the installation', () => {
  const container = mkdtempSync(join(tmpdir(), 'dsh-installer-junction-'))
  const root = join(container, 'owned'); mkdirSync(root)
  const outside = join(container, 'external'); mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'user-data')
  symlinkSync(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  const stage = join(root, 'stage'); mkdirSync(stage)
  const source = join(stage, 'incoming'); writeFileSync(source, 'replacement')
  const tx = new FileTransaction(stage, [root])
  assert.throws(() => tx.replace(source, join(root, 'redirect/keep')), /outside/)
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'user-data')
})

test('bundled workspace references bind to shipped siblings without changing archive integrity', () => {
  const lock = { packages: {
    'node_modules/tui': { version: '1.0.0', integrity: 'archive-integrity' },
    'node_modules/tui/node_modules/@std/core': { version: '0.1.0', inBundle: true },
    'node_modules/tui/node_modules/@std/command': { version: '0.1.0', inBundle: true, dependencies: { '@std/core': 'workspace:*' } },
  } }
  normalizeBundledWorkspaceReferences(lock)
  assert.equal(lock.packages['node_modules/tui/node_modules/@std/command'].dependencies['@std/core'], '0.1.0')
  assert.equal(lock.packages['node_modules/tui'].integrity, 'archive-integrity')
  assert.throws(() => normalizeBundledWorkspaceReferences({ packages: { 'node_modules/unbundled': { dependencies: { unknown: 'workspace:*' } } } }), /Unsupported workspace/)
})

function installationFixture(staged = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-integration-'))
  const prefix = join(root, 'npm'); mkdirSync(prefix)
  const userHome = join(root, 'user')
  const profile = join(userHome, '.dsh/profiles/dsh-tui')
  const metadataDir = join(root, 'metadata')
  const target = { prefix, userHome, profile, metadataDir, stage: join(prefix, '_stage_tui'), roots: [prefix, join(userHome, '.dsh/profiles'), metadataDir] }
  const context = { fileOnly: true, work: root }
  prepareStage(target, context)
  const payload = staged ? join(target.stage, 'payload') : join(root, 'payload')
  const files = {}
  const put = (name, data) => {
    const path = join(payload, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data)
    files[name] = createHash('sha256').update(data).digest('hex')
  }
  for (const [name, commands, packageVersion] of [
    ['@deepseek-ai/dsh', ['dsh'], '0.2.0-rc.2'],
    ['@deepseek-harness-tui/dsh-tui', ['dsh-tui', 'dst'], '0.14.0'],
    ['pnpm', ['pnpm', 'pnpx'], '11.21.0'],
  ]) {
    put(`global/node_modules/${name}/package.json`, JSON.stringify({ name, version: packageVersion, bin: Object.fromEntries(commands.map(command => [command, 'bin.js'])) }))
    put(`global/node_modules/${name}/bin.js`, '#!/usr/bin/env node\n')
    for (const command of commands) for (const suffix of ['', '.cmd', '.ps1']) put(`global/${command}${suffix}`, `node_modules/${name}/bin.js`)
  }
  put('node/node.exe', 'fixture-runtime')
  put('global/node_modules/@deepseek-harness-tui/dsh-tui/runtime/node/index.js', 'nested node entry')
  put('node/LICENSE', 'fixture-license')
  put('node/node_modules/npm/package.json', '{"name":"npm","version":"11.13.0"}')
  const fullMetadata = { ...metadata, schemaVersion: 1, nodeRange: '^22.19 || >=24', files }
  return { root, target, payload, metadata: fullMetadata, context }
}

test('staged packages are promoted without copying while the profile remains an independent copy', () => {
  const { target, payload, metadata, context } = installationFixture(true)
  const files = ['node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-harness-tui/dsh-tui/bin.js', 'node_modules/pnpm/package.json']
  const identities = files.map(file => statSync(join(payload, 'global', file), { bigint: true }).ino)
  installPayload(target, payload, metadata, {}, context)
  for (const [index, file] of files.entries()) assert.equal(statSync(join(target.prefix, file), { bigint: true }).ino, identities[index], file)
  const globalTui = join(target.prefix, files[1])
  const profileTui = join(target.profile, files[1])
  assert.equal(readFileSync(globalTui, 'utf8'), readFileSync(profileTui, 'utf8'))
  writeFileSync(profileTui, 'profile-local update')
  assert.equal(readFileSync(globalTui, 'utf8'), '#!/usr/bin/env node\n')
  assert.equal(existsSync(target.stage), false)
})

test('a failed staged install restores existing packages after promotion', () => {
  const { target, payload, metadata, context } = installationFixture(true)
  const kernel = join(target.prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  const tui = join(target.prefix, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json')
  for (const [file, name] of [[kernel, '@deepseek-ai/dsh'], [tui, '@deepseek-harness-tui/dsh-tui']]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ name, version: '0.0.1', custom: 'preserved' }))
  }
  const originals = [kernel, tui].map(file => readFileSync(file, 'utf8'))
  context.system = action => {
    if (action === 'inspect') return { path: '', pathContainsPrefix: false, running: [], nodePaths: [], registration: null }
    if (action === 'register') throw new Error('registration failed after promotion')
    return { ok: true }
  }
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /registration failed after promotion/)
  for (const [index, file] of [kernel, tui].entries()) assert.equal(readFileSync(file, 'utf8'), originals[index])
  assert.equal(existsSync(join(target.prefix, 'dsh-tui.cmd')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
  prepareStage(target, context)
  assert.equal(existsSync(join(target.stage, 'transaction.json')), false)
})

test('an inspect result that carries no real dsh command never reaches path resolution', () => {
  // Windows PowerShell 5.1 serialized a missing dsh.cmd as {} — truthy in JS — so a
  // fresh machine aborted in ensureCommandLocation before writing a single file.
  for (const dshPath of [{}, null, '', '   ', [], 0]) {
    const { target, payload, metadata, context } = installationFixture(true)
    context.system = action => action === 'inspect'
      ? { path: '', pathContainsPrefix: false, running: [], nodePaths: [], dshPath, registration: null }
      : { ok: true }
    installPayload(target, payload, metadata, {}, context)
    assert.ok(existsSync(join(target.prefix, 'dsh-tui.cmd')), `dshPath=${JSON.stringify(dshPath)}`)
  }
  const { target, payload, metadata, context } = installationFixture(true)
  context.system = action => action === 'inspect'
    ? { path: '', pathContainsPrefix: false, running: [], nodePaths: [], dshPath: join('D:', 'elsewhere', 'dsh.cmd'), registration: null }
    : { ok: true }
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /takes precedence on PATH/)
})

test('the environment broadcast compiles outside a working directory that shadows System.dll', { skip: process.platform !== 'win32' }, () => {
  // $PLUGINSDIR ships the NSIS System plug-in as a native System.dll. Add-Type
  // resolves reference assemblies from the process working directory, so
  // compiling there aborted every fresh install (D2) before PATH was written.
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-dir-'))
  cpSync(join(process.env.SystemRoot, 'System32/version.dll'), join(root, 'System.dll'))
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition 'public static class DshProbe {}'"], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.notEqual(probe.status, 0, 'the shadowing System.dll must break Add-Type, or this test proves nothing')
  assert.match(`${probe.stdout}${probe.stderr}`, /System\.dll|Add-Type/)
  const request = join(root, 'system-path.json')
  const response = join(root, 'system-path-result.json')
  writeFileSync(request, '{}')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dirname(fileURLToPath(import.meta.url)), 'windows-system.ps1'), '-Action', 'notify-environment', '-InputFile', request, '-OutputFile', response], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(response, 'utf8').replace(/^\uFEFF/, '')), { ok: true, notified: true })
})

test('the engine drives PATH and registration through the system helper in order', () => {
  const { target, payload, metadata, context } = installationFixture()
  const calls = []
  context.system = (action, data) => {
    calls.push({ action, data })
    if (action === 'inspect') return { path: '', pathContainsPrefix: false, running: [], nodePaths: [], dshPath: null, registration: null }
    return { ok: true, notified: true }
  }
  installPayload(target, payload, metadata, {}, context)
  assert.deepEqual(calls.map(call => call.action), ['inspect', 'path', 'register'])
  assert.deepEqual(calls[1].data, { expected: '', value: target.prefix })
  assert.deepEqual(calls[2].data, { version: '0.14.0', metadataDir: target.metadataDir })
  assert.equal(JSON.parse(readFileSync(join(target.metadataDir, 'installation.json'))).addedPath, true)
})

test('the PATH action round-trips through the real user registry when enabled', { skip: process.platform !== 'win32' || process.env.DSH_INSTALLER_SYSTEM_TESTS !== '1' }, () => {
  // The only CI coverage of the registry half of the installer. The isolated EXE
  // runs with --file-only and never spawns PowerShell, which is why D1 and D2 both
  // reached real machines, so this is opt-in: a local run must never touch the
  // developer's own PATH (DSH_INSTALLER_SYSTEM_TESTS=1 in the Windows CI job).
  const root = mkdtempSync(join(tmpdir(), 'dsh-path-action-'))
  const prefix = join(root, 'npm')
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'windows-system.ps1')
  const invoke = (action, request) => {
    const requestFile = join(root, `${action}.json`)
    const responseFile = join(root, `${action}-result.json`)
    writeFileSync(requestFile, JSON.stringify(request))
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action, '-InputFile', requestFile, '-OutputFile', responseFile], { encoding: 'utf8', windowsHide: true })
    const response = existsSync(responseFile) ? JSON.parse(readFileSync(responseFile, 'utf8').replace(/^\uFEFF/, '')) : undefined
    return { status: result.status, response, stderr: result.stderr }
  }
  const ok = (action, request) => {
    const { status, response, stderr } = invoke(action, request)
    assert.equal(status, 0, `${action} failed: ${stderr}`)
    return response
  }
  const current = () => ok('inspect', { prefix }).path
  const original = current()
  assert.equal(typeof original, 'string')
  const appended = `${original}${original && !original.endsWith(';') ? ';' : ''}${prefix}`
  try {
    const applied = ok('path', { expected: original, value: appended })
    assert.equal(applied.ok, true)
    assert.equal(applied.notified, true, 'the broadcast must survive the plug-in directory')
    assert.equal(ok('inspect', { prefix }).pathContainsPrefix, true)
    // A stale expected value must abort instead of clobbering a PATH that moved.
    assert.notEqual(invoke('path', { expected: `${appended};C:\\dsh-stale`, value: original }).status, 0)
    assert.equal(current(), appended)
  } finally {
    assert.equal(ok('path', { expected: appended, value: original }).ok, true)
  }
  assert.equal(ok('inspect', { prefix }).pathContainsPrefix, false)
})

test('offline install seeds the profile and default uninstall preserves kernel and all user assets', () => {
  const fixture = installationFixture()
  const { target, payload, metadata, context } = fixture
  const credential = join(target.userHome, '.dsh/.credentials.yaml')
  mkdirSync(join(credential, '..'), { recursive: true }); writeFileSync(credential, 'private-test-value')
  installPayload(target, payload, metadata, {}, context)
  assert.equal(JSON.parse(readFileSync(join(target.profile, 'package.json'))).dependencies['@deepseek-harness-tui/dsh-tui'], '0.14.0')
  assert.ok(existsSync(join(target.prefix, 'dsh-tui.cmd')))
  assert.match(readFileSync(join(target.profile, 'pnpm-workspace.yaml'), 'utf8'), /nodeLinker: hoisted\nautoInstallPeers: false/)
  assert.equal(existsSync(target.stage), false)
  uninstallPackages(target, metadata, false, false, context)
  assert.equal(existsSync(join(target.prefix, 'dsh-tui.cmd')), false)
  assert.ok(existsSync(join(target.prefix, 'dsh.cmd')))
  assert.ok(existsSync(join(target.profile, 'package.json')))
  assert.equal(readFileSync(credential, 'utf8'), 'private-test-value')
})

test('the bundled DSH version is retained byte for byte while profile plugins and patch files survive', () => {
  const { target, payload, metadata, context } = installationFixture()
  const kernelFile = join(target.prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  mkdirSync(join(kernelFile, '..'), { recursive: true })
  const original = '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2","custom":"retain"}'
  writeFileSync(kernelFile, original)
  mkdirSync(target.profile, { recursive: true })
  writeFileSync(join(target.profile, 'package.json'), JSON.stringify({ dependencies: { 'other-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'other-plugin'] } } }))
  writeFileSync(join(target.profile, 'cordis.patch.yml'), '# user patch\n[]\n')
  installPayload(target, payload, metadata, {}, context)
  assert.equal(readFileSync(kernelFile, 'utf8'), original)
  assert.equal(readFileSync(join(target.profile, 'cordis.patch.yml'), 'utf8'), '# user patch\n[]\n')
  assert.equal(JSON.parse(readFileSync(join(target.profile, 'package.json'))).dependencies['other-plugin'], '1.0.0')
})

test('an older compatible kernel is upgraded to the bundled RC', () => {
  const { target, payload, metadata, context } = installationFixture(true)
  const kernel = join(target.prefix, 'node_modules/@deepseek-ai/dsh')
  mkdirSync(kernel, { recursive: true })
  writeFileSync(join(kernel, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.1"}')
  writeFileSync(join(kernel, 'old-kernel-file'), 'old')
  installPayload(target, payload, metadata, {}, context)
  assert.equal(JSON.parse(readFileSync(join(kernel, 'package.json'))).version, '0.2.0-rc.2')
  assert.equal(existsSync(join(kernel, 'old-kernel-file')), false)
  assert.equal(JSON.parse(readFileSync(join(target.metadataDir, 'installation.json'))).kernelVersion, '0.2.0-rc.2')
})

test('archive install skips retained kernel, Node and pnpm trees', { skip: process.platform !== 'win32' }, () => {
  const { target, payload, metadata, context } = installationFixture()
  const kernel = join(target.prefix, 'node_modules/@deepseek-ai/dsh')
  mkdirSync(kernel, { recursive: true })
  const manifest = '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2","custom":"keep"}'
  writeFileSync(join(kernel, 'package.json'), manifest)
  writeFileSync(join(target.prefix, 'pnpm.cmd'), 'existing pnpm')
  context.system = action => action === 'inspect'
    ? { path: '', pathContainsPrefix: false, running: [], nodePaths: [process.execPath], registration: null }
    : { ok: true }
  // These unused trees deliberately differ from the manifest: extracting them
  // would either fail verification or overwrite components that must be kept.
  for (const file of ['global/node_modules/@deepseek-ai/dsh/package.json', 'global/node_modules/pnpm/package.json', 'node/node.exe']) writeFileSync(join(payload, file), 'unused component')
  execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-cf', join(target.stage, 'payload.tar'), '-C', payload, '.'])
  metadata.archiveSha256 = sha256File(join(target.stage, 'payload.tar'))
  installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context)
  assert.equal(readFileSync(join(kernel, 'package.json'), 'utf8'), manifest)
  assert.equal(readFileSync(join(target.prefix, 'pnpm.cmd'), 'utf8'), 'existing pnpm')
  assert.equal(existsSync(join(target.prefix, 'node.exe')), false)
  assert.ok(existsSync(join(target.profile, 'node_modules/@deepseek-harness-tui/dsh-tui/bin.js')))
  assert.equal(readFileSync(join(target.profile, 'node_modules/@deepseek-harness-tui/dsh-tui/runtime/node/index.js'), 'utf8'), 'nested node entry')
  assert.equal(existsSync(target.stage), false)
})

test('archive install rejects a corrupt selected component before replacing packages', { skip: process.platform !== 'win32' }, () => {
  const { target, payload, metadata, context } = installationFixture()
  writeFileSync(join(payload, 'global/node_modules/@deepseek-harness-tui/dsh-tui/bin.js'), 'corrupt')
  execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-cf', join(target.stage, 'payload.tar'), '-C', payload, '.'])
  assert.throws(() => installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context), /checksum mismatch/)
  assert.equal(existsSync(join(target.prefix, 'node_modules')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
})

test('verified archives detect corruption before extraction or replacing an existing installation', { skip: process.platform !== 'win32' }, () => {
  const { target, payload, metadata, context } = installationFixture()
  const archive = join(target.stage, 'payload.tar')
  execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-cf', archive, '-C', payload, '.'])
  metadata.archiveSha256 = sha256File(archive)
  const original = '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.1"}'
  const installed = join(target.prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  mkdirSync(join(installed, '..'), { recursive: true }); writeFileSync(installed, original)
  const corrupt = readFileSync(archive)
  corrupt[Math.floor(corrupt.length / 2)] ^= 1
  writeFileSync(archive, corrupt)
  assert.throws(() => installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context), /archive checksum mismatch/)
  assert.equal(readFileSync(installed, 'utf8'), original)
  assert.equal(existsSync(join(target.stage, 'payload')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
})

test('verified archives install with independent profile files and reject incomplete or extra entries', { skip: process.platform !== 'win32' }, () => {
  for (const variant of ['valid', 'missing', 'extra']) {
    const { target, payload, metadata, context } = installationFixture()
    const archive = join(target.stage, 'payload.tar')
    if (variant === 'extra') writeFileSync(join(payload, 'unexpected.js'), 'extra')
    if (variant === 'missing') metadata.files['global/missing.js'] = createHash('sha256').update('missing').digest('hex')
    execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-cf', archive, '-C', payload, '.'])
    metadata.archiveSha256 = sha256File(archive)
    const install = () => installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context)
    if (variant !== 'valid') {
      assert.throws(install, variant === 'missing' ? /file count mismatch/ : /Unexpected payload entry/)
      assert.equal(existsSync(join(target.prefix, 'node_modules')), false)
    } else {
      install()
      const file = 'node_modules/@deepseek-harness-tui/dsh-tui/bin.js'
      writeFileSync(join(target.profile, file), 'local profile update')
      assert.equal(readFileSync(join(target.prefix, file), 'utf8'), '#!/usr/bin/env node\n')
      assert.equal(existsSync(target.stage), false)
    }
  }
})

test('archive checksum validation rejects missing or malformed hashes and handles multiple read chunks', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-hash-'))
  const archive = join(root, 'payload.tar')
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 29, 0x5a)
  writeFileSync(archive, bytes)
  const expected = createHash('sha256').update(bytes).digest('hex')
  assert.equal(sha256File(archive), expected)
  verifyArchive(archive, expected)
  for (const digest of [undefined, '', '0'.repeat(63), 'z'.repeat(64)]) assert.throws(() => verifyArchive(archive, digest), /Invalid payload archive checksum/)
})

test('archive extraction refuses a pre-existing payload junction before writing files', { skip: process.platform !== 'win32' }, () => {
  const { root, target, payload, metadata, context } = installationFixture()
  execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-cf', join(target.stage, 'payload.tar'), '-C', payload, '.'])
  const outside = join(root, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'user data')
  symlinkSync(outside, join(target.stage, 'payload'), 'junction')
  assert.throws(() => installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context), /fresh payload directory/)
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'user data')
  assert.equal(existsSync(join(outside, 'global')), false)
})

test('checksum failure occurs before replacing an existing package', () => {
  const { target, payload, metadata, context } = installationFixture()
  writeFileSync(join(payload, 'global/dsh.cmd'), 'corrupt')
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /checksum mismatch/)
  assert.equal(existsSync(join(target.prefix, 'node_modules')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
})

function indexedFixture() {
  const fixture = installationFixture()
  const { payload, metadata, target } = fixture
  // Exercise more than one worker, zero-byte files and reads over chunk boundaries.
  const extras = { 'global/node_modules/@deepseek-harness-tui/dsh-tui/large.bin': Buffer.alloc(1024 * 1024 + 37, 0x6b), 'global/empty': Buffer.alloc(0) }
  extras[`global/node_modules/@deepseek-harness-tui/dsh-tui/${'long path 中文 😀 '.repeat(5).trimEnd()}/${'nested '.repeat(12).trimEnd()}/文件 😀.js`] = Buffer.from('unicode and long paths')
  for (let index = 0; index < 300; index++) extras[`global/node_modules/@deepseek-harness-tui/dsh-tui/nested/${index}.js`] = Buffer.from(String(index))
  for (const [name, bytes] of Object.entries(extras)) {
    const file = join(payload, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, bytes)
    metadata.files[name] = createHash('sha256').update(bytes).digest('hex')
  }
  metadata.archiveFormat = 'indexed-v1'
  metadata.archives = buildArchives(payload, metadata.files, target.stage)
  return fixture
}

test('indexed components install every byte and make an independent profile in the same extraction', () => {
  const { target, metadata, context } = indexedFixture()
  installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context)
  const prefix = 'global/node_modules/@deepseek-harness-tui/dsh-tui/'
  for (const [name, hash] of Object.entries(metadata.files)) {
    if (!name.startsWith(prefix)) continue
    for (const root of [target.prefix, target.profile]) assert.equal(sha256File(join(root, 'node_modules/@deepseek-harness-tui/dsh-tui', name.slice(prefix.length))), hash, name)
  }
  const file = 'node_modules/@deepseek-harness-tui/dsh-tui/bin.js'
  writeFileSync(join(target.profile, file), 'profile update')
  assert.equal(readFileSync(join(target.prefix, file), 'utf8'), '#!/usr/bin/env node\n')
  assert.equal(existsSync(target.stage), false)
})

test('indexed extraction needs no archive for retained components', () => {
  const { target, metadata, context } = indexedFixture()
  const kernel = join(target.prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  const original = '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2","keep":true}'
  mkdirSync(join(kernel, '..'), { recursive: true }); writeFileSync(kernel, original)
  writeFileSync(join(target.prefix, 'pnpm.cmd'), 'existing pnpm')
  context.system = action => action === 'inspect' ? { path: '', pathContainsPrefix: false, running: [], nodePaths: [process.execPath], registration: null } : { ok: true }
  for (const id of ['dsh', 'node', 'pnpm']) rmSync(join(target.stage, `${id}.bin`))
  installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context)
  assert.equal(readFileSync(kernel, 'utf8'), original)
  assert.equal(readFileSync(join(target.prefix, 'pnpm.cmd'), 'utf8'), 'existing pnpm')
  assert.equal(existsSync(join(target.prefix, 'node.exe')), false)
})

test('indexed corruption is rejected before replacing old packages and removes the partial profile copy', () => {
  const { target, metadata, context } = indexedFixture()
  const archive = join(target.stage, 'tui.bin')
  const corrupt = readFileSync(archive); corrupt[corrupt.length - 1] ^= 1; writeFileSync(archive, corrupt)
  const file = join(target.prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  const old = '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.1"}'
  mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, old)
  assert.throws(() => installPayload(target, join(target.stage, 'payload'), metadata, { extract: true }, context), /checksum mismatch/)
  assert.equal(readFileSync(file, 'utf8'), old)
  const journal = JSON.parse(readFileSync(join(target.stage, 'transaction.json'), 'utf8'))
  assert.equal(journal.state, 'rolled-back')
  assert.equal(existsSync(join(target.userHome, '.dsh/profiles', `.dsh-tui-install-${journal.id}`)), false)
})

test('indexed archive indexes reject unsafe paths, collisions, missing files and invalid sizes', () => {
  const { metadata } = indexedFixture()
  for (const change of [
    value => { value.archives.common.files[0].name = '../escape' },
    value => { value.archives.common.files[0].name = 'global/file:stream' },
    value => { value.archives.common.files[0].name = 'global/CON' },
    value => { value.archives.common.files[0].name = 'global/trailing space ' },
    value => { value.archives.tui.files[0].size = -1 },
    value => { value.archives.tui.files[0].size = Number.MAX_SAFE_INTEGER },
    value => { value.archives.tui.files.pop() },
    value => { value.archives.tui.files.push(value.archives.tui.files[0]) },
  ]) {
    const invalid = structuredClone(metadata); change(invalid)
    assert.throws(() => archiveEntries(invalid), /Invalid archive|file count/)
  }
})

test('indexed extraction rejects truncated inputs and pre-existing output links without writing through them', async () => {
  const { root, target, metadata } = indexedFixture()
  const outside = join(root, 'outside'); mkdirSync(outside)
  const output = join(target.stage, 'payload')
  symlinkSync(outside, output, process.platform === 'win32' ? 'junction' : 'dir')
  const plan = { metadata, selected: ['tui'], stage: target.stage, payload: output, roots: target.roots }
  await assert.rejects(extractArchives(plan), /EEXIST/)
  assert.equal(existsSync(join(outside, 'global')), false)
  // Removing a link never recurses into its target.
  rmSync(output)
  writeFileSync(join(target.stage, 'tui.bin'), 'truncated')
  await assert.rejects(extractArchives(plan), /size mismatch/)
  assert.equal(existsSync(output), false)
})

test('interrupted indexed extraction cleans its detached profile staging directory on recovery', () => {
  const { target, context } = installationFixture()
  const tx = new FileTransaction(target.stage, target.roots); tx.save()
  const scratch = join(target.userHome, '.dsh/profiles', `.dsh-tui-install-${tx.journal.id}`, 'tui')
  mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'partial'), 'partial')
  prepareStage(target, context)
  assert.equal(existsSync(scratch), false)
  assert.equal(existsSync(join(target.stage, 'transaction.json')), false)
})

test('parallel committed cleanup preserves link targets and handles read-only files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-cleanup-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const packageRoot = join(root, 'package'); mkdirSync(packageRoot)
  const outside = join(root, 'external'); mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'user data')
  symlinkSync(outside, join(packageRoot, 'plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  for (let index = 0; index < 300; index++) writeFileSync(join(packageRoot, `${index}.js`), String(index))
  chmodSync(join(packageRoot, '0.js'), 0o444)
  const tx = new FileTransaction(stage, [root]); tx.replace(undefined, packageRoot); tx.commit()
  assert.equal(existsSync(`${packageRoot}.dsh-tui-backup-${tx.journal.id}`), false)
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'user data')
  recoverTransaction(stage, [root])
})

test('a locked backup keeps the committed journal and cleanup resumes after release', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-locked-cleanup-'))
  const stage = join(root, 'stage'); mkdirSync(stage)
  const old = join(root, 'package'); mkdirSync(old)
  for (let index = 0; index < 300; index++) writeFileSync(join(old, `${index}.js`), String(index))
  const replacement = join(stage, 'incoming'); mkdirSync(replacement)
  writeFileSync(join(replacement, 'new'), 'new package')
  const tx = new FileTransaction(stage, [root]); tx.replace(replacement, old)
  const backup = `${old}.dsh-tui-backup-${tx.journal.id}`
  const locker = join(root, 'lock.ps1')
  writeFileSync(locker, 'param([string]$File)\n$handle = [IO.File]::Open($File, "Open", "Read", "None")\n[Console]::WriteLine("locked")\n[Console]::Out.Flush()\n[Console]::ReadLine() | Out-Null\n$handle.Dispose()\n')
  const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', locker, join(backup, '0.js')], { windowsHide: true })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null) child.kill() })
  try {
    const [data] = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Unable to lock fixture') })])
    assert.match(String(data), /locked/)
    const warnings = []
    t.mock.method(console, 'warn', message => warnings.push(message))
    tx.commit()
    assert.ok(warnings.some(message => message.includes('Backup cleanup deferred')))
    assert.equal(JSON.parse(readFileSync(join(stage, 'transaction.json'), 'utf8')).state, 'committed')
    assert.ok(existsSync(join(backup, '0.js')))
    assert.equal(readFileSync(join(old, 'new'), 'utf8'), 'new package')
  } finally { child.stdin.end('\n'); await exited }
  recoverTransaction(stage, [root])
  assert.equal(existsSync(backup), false)
  assert.equal(readFileSync(join(old, 'new'), 'utf8'), 'new package')
})

test('a late metadata write failure rolls back packages and profile manifest', () => {
  const { target, payload, metadata, context } = installationFixture()
  mkdirSync(target.profile, { recursive: true })
  const original = '{"name":"existing-profile","dependencies":{"other":"1"}}'
  writeFileSync(join(target.profile, 'package.json'), original)
  writeFileSync(target.metadataDir, 'a file blocks the metadata directory')
  assert.throws(() => installPayload(target, payload, metadata, {}, context))
  assert.equal(existsSync(join(target.prefix, 'dsh.cmd')), false)
  assert.equal(readFileSync(join(target.profile, 'package.json'), 'utf8'), original)
  assert.equal(readFileSync(target.metadataDir, 'utf8'), 'a file blocks the metadata directory')
})

test('full uninstall requires confirmation for other profiles and never removes their data', () => {
  const { target, payload, metadata, context } = installationFixture()
  installPayload(target, payload, metadata, {}, context)
  const otherProfile = join(target.userHome, '.dsh/profiles/web/package.json')
  mkdirSync(join(otherProfile, '..'), { recursive: true }); writeFileSync(otherProfile, '{"name":"web"}')
  assert.throws(() => uninstallPackages(target, metadata, true, false, context), /Other profiles/)
  assert.ok(existsSync(join(target.prefix, 'dsh.cmd')))
  uninstallPackages(target, metadata, true, true, context)
  assert.equal(existsSync(join(target.prefix, 'dsh.cmd')), false)
  assert.equal(readFileSync(otherProfile, 'utf8'), '{"name":"web"}')
  assert.ok(existsSync(join(target.profile, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json')))
})

test('hoisted peers move with the kernel and remain resolvable from its dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-tree-'))
  const modules = join(root, 'input/node_modules')
  const put = (name, text) => { const file = join(modules, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
  put('@test/kernel/index.cjs', "module.exports=require('plugin')")
  put('plugin/index.js', "module.exports=require('@test/peer')")
  put('@test/peer/index.js', "module.exports='shared-peer'")
  const output = join(root, 'output/node_modules/@test/kernel')
  collectPackageTree(modules, '@test/kernel', output)
  const { createRequire } = await import('node:module')
  assert.equal(createRequire(join(output, 'index.cjs'))('./index.cjs'), 'shared-peer')
  assert.ok(existsSync(join(modules, '@test/peer/index.js')))
})

test('runtime packages omit declarations and source maps but keep executable sources, resources and compiler libraries', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-runtime-'))
  const modules = join(root, 'input/node_modules')
  const keep = ['@test/app/index.js', '@test/app/source.ts', '@test/app/loader.mts', '@test/app/native.node', '@test/app/font.map', '@test/app/LICENSE', 'typescript/lib/lib.es2024.d.ts']
  const omit = ['@test/app/index.d.ts', '@test/app/index.d.ts.map', '@test/app/index.js.map', '@test/app/loader.d.mts', '@test/app/loader.d.cts', '@test/app/source.ts.map', '@test/app/loader.mjs.map']
  for (const name of [...keep, ...omit]) {
    const file = join(modules, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, name)
  }
  const output = join(root, 'output/node_modules/@test/app')
  collectPackageTree(modules, '@test/app', output)
  for (const name of keep) {
    const relative = name.startsWith('@test/app/') ? name.slice('@test/app/'.length) : `node_modules/${name}`
    assert.equal(readFileSync(join(output, relative), 'utf8'), name)
  }
  for (const name of omit) assert.equal(existsSync(join(output, name.slice('@test/app/'.length))), false, name)
  for (const name of omit) assert.ok(existsSync(join(modules, name)), 'build inputs remain untouched')
})

test('downgrade rejection leaves installed bytes untouched', () => {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-harness-tui/dsh-tui']) {
    const { target, payload, metadata, context } = installationFixture()
    const file = join(target.prefix, 'node_modules', name, 'package.json')
    mkdirSync(join(file, '..'), { recursive: true })
    const content = JSON.stringify({ name, version: '9.0.0' })
    writeFileSync(file, content)
    assert.throws(() => installPayload(target, payload, metadata, {}, context), /confirmations/)
    assert.equal(readFileSync(file, 'utf8'), content)
    assert.equal(existsSync(join(target.profile, 'package.json')), false)
  }
})

for (const indexed of [false, true]) test(`registration failure restores files, PATH and registration (${indexed ? 'indexed' : 'directory'} payload)`, () => {
  const { target, payload, metadata, context } = indexed ? indexedFixture() : installationFixture()
  const oldFiles = [
    ['node_modules/@deepseek-ai/dsh/package.json', target.prefix, '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.1"}'],
    ['node_modules/@deepseek-harness-tui/dsh-tui/package.json', target.profile, '{"name":"@deepseek-harness-tui/dsh-tui","version":"0.13.0"}'],
    ['package.json', target.profile, '{"name":"existing-profile","dependencies":{"custom":"1"}}'],
    ['cordis.patch.yml', target.profile, 'user patch'],
  ]
  for (const [file, base, contents] of oldFiles) {
    const path = join(base, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, contents)
  }
  const originalRegistration = [{ name: 'DisplayVersion', value: 'old', kind: 1 }]
  const system = { path: 'C:\\Other', pathContainsPrefix: false, running: [], nodePaths: [], registration: originalRegistration }
  context.system = (action, data) => {
    if (action === 'inspect') return structuredClone(system)
    if (action === 'path') { assert.equal(system.path, data.expected); system.path = data.value }
    if (action === 'register') { system.registration = []; throw new Error('simulated registry failure') }
    if (action === 'restore-registration') system.registration = data.registration
    return { ok: true }
  }
  assert.throws(() => installPayload(target, indexed ? join(target.stage, 'payload') : payload, metadata, { extract: indexed }, context), /simulated registry failure/)
  assert.equal(system.path, 'C:\\Other')
  assert.deepEqual(system.registration, originalRegistration)
  assert.equal(existsSync(join(target.prefix, 'dsh.cmd')), false)
  for (const [file, base, contents] of oldFiles) assert.equal(readFileSync(join(base, file), 'utf8'), contents, file)
  prepareStage(target, context)
  assert.equal(existsSync(join(target.stage, 'transaction.json')), false)
})

test('an existing compatible Node runtime is reused without installing another copy', () => {
  const { target, payload, metadata, context } = installationFixture()
  context.system = action => action === 'inspect'
    ? { path: '', pathContainsPrefix: false, running: [], nodePaths: [process.execPath], registration: null }
    : { ok: true }
  installPayload(target, payload, metadata, {}, context)
  assert.equal(existsSync(join(target.prefix, 'node.exe')), false)
  assert.equal(existsSync(join(target.prefix, 'node_modules/npm')), false)
  assert.equal(JSON.parse(readFileSync(join(target.metadataDir, 'installation.json'))).installNode, false)
  assert.ok(existsSync(join(target.prefix, 'dsh-tui.cmd')))
})

test('a running application blocks replacement before any package is installed', () => {
  const { target, payload, metadata, context } = installationFixture()
  context.system = () => ({ path: '', pathContainsPrefix: false, running: [1234], nodePaths: [], registration: null })
  assert.throws(() => installPayload(target, payload, metadata, {}, context), /Close dsh.*1234/)
  assert.equal(existsSync(join(target.prefix, 'node_modules')), false)
  assert.equal(existsSync(join(target.profile, 'package.json')), false)
})