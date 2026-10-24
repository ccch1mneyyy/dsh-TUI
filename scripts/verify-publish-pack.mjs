#!/usr/bin/env node
/** Real npm pack destination regression; no build, dependency install or network required. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const cases = [
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
  console.log(`publish pack OK (${cases.length} real npm destinations, including spaces and Unicode)`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
