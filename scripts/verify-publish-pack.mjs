#!/usr/bin/env node
/** Real npm pack destination/bundle regressions; --bundles-only selects the nonempty bundle boundary. No install/network. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

// Inspect regular files in this fixture's local npm tar; the original tar is
// retained too when an evidence directory is requested by the outer runner.
function tarFiles(path) {
  const bytes = gunzipSync(readFileSync(path))
  const files = new Map()
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0]
    const prefix = field(345, 500)
    const name = (prefix ? prefix + '/' : '') + field(0, 100)
    const size = Number.parseInt(field(124, 136).trim() || '0', 8)
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length, 'valid local tar member bounds')
    if (header[156] === 0 || header[156] === 48) {
      assert.ok(!files.has(name), `no duplicate member: ${name}`)
      files.set(name, bytes.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-publish-pack-'))
const repo = join(scratch, 'source 包')
const caller = join(scratch, 'caller')
try {
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(caller)
  for (const name of ['with-publish-manifest.mjs', 'publish-manifest.mjs', 'dev-command.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(repo, 'scripts', name))
  }
  const source = {
    name: 'dsh-tui-pack-fixture', version: '1.0.0', type: 'module', files: ['index.js'],
    devDependencies: {}, dshTui: { runtimeDependencies: [], optionalDependencies: [], bundledDependencies: [] },
  }
  writeFileSync(join(repo, 'package.json'), JSON.stringify(source))
  writeFileSync(join(repo, 'index.js'), 'export const packaged = true\n')
  const absolute = join(scratch, 'absolute 输出 包')
  const relative = 'relative 输出 包'
  const cases = process.argv.includes('--bundles-only') ? [] : [
    ['equals current directory', ['--pack-destination=.'], repo],
    ['default', [], repo],
    ['split relative', ['--pack-destination', relative], join(repo, relative)],
    ['equals relative', [`--pack-destination=${relative}`], join(repo, relative)],
    ['split absolute', ['--pack-destination', absolute], absolute],
    ['equals absolute', [`--pack-destination=${absolute}`], absolute],
    ['last destination wins', ['--pack-destination', relative, `--pack-destination=${absolute}`], absolute],
  ]
  for (const [label, args, destination] of cases) {
    mkdirSync(destination, { recursive: true })
    const packed = spawnSync(process.execPath, [join(repo, 'scripts/with-publish-manifest.mjs'), 'npm', 'pack', '--json', ...args], {
      cwd: caller, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    })
    assert.ifError(packed.error)
    assert.equal(packed.status, 0, `${label}: ${packed.stderr}`)
    const reports = JSON.parse(packed.stdout)
    const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
    const tarball = join(destination, report.filename)
    assert.ok(existsSync(tarball), `${label}: successful pack must retain ${tarball} after staging cleanup`)
    assert.deepEqual([...readFileSync(tarball).subarray(0, 2)], [0x1f, 0x8b], `${label}: real gzip tarball`)
    assert.equal(report.dshTuiManifest.name, source.name)
    assert.equal(report.dshTuiManifest.devDependencies, undefined)
    assert.deepEqual(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')), source)
    rmSync(tarball)
    console.log(`PASS: ${label}`)
  }
  // Unlike the destination-only fixture, real bundled manifests contain
  // internal workspace references; inspect the tar bytes, not just the root.
  const names = ['core', 'command']
  const packages = new Map()
  const links = new Map()
  for (const name of names) {
    const directory = join(repo, 'vendor/dsh-std/packages', name)
    mkdirSync(directory, { recursive: true })
    const pkg = {
      name: `@dsh-std/${name}`, version: '0.1.0', type: 'module', files: ['index.js'], main: 'index.js',
      dependencies: { 'unrelated-runtime': '^2.0.0', ...(name === 'command' ? { '@dsh-std/core': 'workspace:*' } : {}) },
      optionalDependencies: { 'unrelated-optional': '~3.0.0', ...(name === 'command' ? { '@dsh-std/core': 'workspace:*' } : {}) },
      peerDependencies: { 'unrelated-peer': '>=4', ...(name === 'command' ? { '@dsh-std/core': 'workspace:*' } : {}) },
    }
    const data = JSON.stringify(pkg)
    writeFileSync(join(directory, 'package.json'), data)
    writeFileSync(join(directory, 'index.js'), 'export const value = 42\n')
    packages.set(name, data)
    mkdirSync(join(repo, 'node_modules/@dsh-std'), { recursive: true })
    const link = join(repo, 'node_modules/@dsh-std', name)
    symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
    links.set(name, readlinkSync(link))
  }
  const nested = join(repo, 'vendor/dsh-std/packages/command/node_modules/@dsh-std/core')
  mkdirSync(join(repo, 'vendor/dsh-std/packages/command/node_modules/@dsh-std'), { recursive: true })
  symlinkSync(join(repo, 'vendor/dsh-std/packages/core'), nested, process.platform === 'win32' ? 'junction' : 'dir')
  const nestedTarget = readlinkSync(nested)
  const bundledSource = structuredClone(source)
  bundledSource.dshTui.bundledDependencies = names.map(name => `@dsh-std/${name}`)
  bundledSource.dshTui.runtimeDependencies = [...bundledSource.dshTui.bundledDependencies, 'unrelated-root-runtime']
  bundledSource.devDependencies = Object.fromEntries(bundledSource.dshTui.bundledDependencies.map(name => [name, 'workspace:*']))
  bundledSource.devDependencies['unrelated-root-runtime'] = '^7.0.0'
  const bundledSourceBytes = JSON.stringify(bundledSource)
  writeFileSync(join(repo, 'package.json'), bundledSourceBytes)
  const checkCheckout = (commandBytes = packages.get('command')) => {
    assert.equal(readFileSync(join(repo, 'package.json'), 'utf8'), bundledSourceBytes, 'source root remains unchanged')
    for (const name of names) {
      assert.equal(readFileSync(join(repo, 'vendor/dsh-std/packages', name, 'package.json'), 'utf8'), name === 'command' ? commandBytes : packages.get(name), 'vendor bytes remain unchanged')
      assert.equal(readlinkSync(join(repo, 'node_modules/@dsh-std', name)), links.get(name), 'workspace link remains unchanged')
    }
    assert.equal(readlinkSync(nested), nestedTarget, 'nested source link remains unchanged')
  }
  const runBundleCase = label => {
    const packed = spawnSync(process.execPath, [join(repo, 'scripts/with-publish-manifest.mjs'), 'npm', 'pack', '--json'], {
      cwd: caller, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    })
    const evidence = process.env.DSH_TUI_PUBLISH_PACK_EVIDENCE_DIR
    const output = evidence ? join(evidence, label) : undefined
    if (output) {
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, 'stdout.log'), packed.stdout ?? '')
      writeFileSync(join(output, 'stderr.log'), packed.stderr ?? '')
      writeFileSync(join(output, 'process.json'), JSON.stringify({ status: packed.status, signal: packed.signal, error: packed.error?.message }, null, 2) + '\n')
    }
    assert.ifError(packed.error)
    let tarball
    if (packed.status === 0) {
      const reports = JSON.parse(packed.stdout)
      const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
      tarball = join(repo, report.filename)
      if (output) copyFileSync(tarball, join(output, report.filename))
    }
    return { packed, tarball }
  }
  const positive = runBundleCase('nonempty-bundles')
  assert.equal(positive.packed.status, 0, positive.packed.stderr)
  const packedFiles = tarFiles(positive.tarball)
  const packedRoot = JSON.parse(packedFiles.get('package/package.json').toString('utf8'))
  assert.deepEqual(packedRoot.dependencies, { 'unrelated-root-runtime': '^7.0.0' })
  assert.deepEqual(packedRoot.optionalDependencies, { '@dsh-std/core': '0.1.0', '@dsh-std/command': '0.1.0' })
  assert.equal(packedRoot.devDependencies, undefined)
  for (const name of names) {
    const packedManifest = JSON.parse(packedFiles.get(`package/node_modules/@dsh-std/${name}/package.json`).toString('utf8'))
    const expected = JSON.parse(packages.get(name))
    if (name === 'command') {
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) expected[section]['@dsh-std/core'] = '0.1.0'
    }
    assert.deepEqual(packedManifest, expected, `${name}: the packed physical manifest has exact sibling versions and preserves unrelated ranges`)
  }
  assert.ok([...packedFiles.keys()].every(path => !path.startsWith('package/vendor/') && path.split('/node_modules/').length <= 2), 'no source vendor or nested workspace trees in the tar')
  checkCheckout()
  rmSync(positive.tarball)
  console.log('PASS: nonempty bundle manifests in real npm tar, source and workspace links unchanged')
  const commandManifestPath = join(repo, 'vendor/dsh-std/packages/command/package.json')
  for (const [label, dependency, range] of [
    ['unsupported-range', '@dsh-std/core', 'workspace:^'],
    ['unbundled-target', '@dsh-std/not-bundled', 'workspace:*'],
  ]) {
    const invalid = JSON.parse(packages.get('command'))
    invalid.dependencies[dependency] = range
    const bytes = JSON.stringify(invalid)
    writeFileSync(commandManifestPath, bytes)
    const result = runBundleCase(label)
    assert.notEqual(result.packed.status, 0, `${label}: unsupported workspace edges must fail before packing`)
    assert.match(result.packed.stderr, /Unsupported bundled workspace dependency/u)
    checkCheckout(bytes)
    writeFileSync(commandManifestPath, packages.get('command'))
    console.log(`PASS: ${label} rejected without changing source or links`)
  }
  console.log(`publish pack OK (${cases.length} destination cases; nonempty bundle tar and two rejection cases)`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
