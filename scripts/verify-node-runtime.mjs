#!/usr/bin/env node
// Run: node scripts/verify-node-runtime.mjs (real launcher, simulated version inputs).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = mkdtempSync(join(tmpdir(), 'dsh-node-runtime #-'))
try {
  mkdirSync(join(fixture, 'bin'))
  copyFileSync(join(root, 'bin/dsh-tui.js'), join(fixture, 'bin/dsh-tui.js'))
  const manifest = (range, name = '@deepseek-harness-tui/dsh-tui') => writeFileSync(join(fixture, 'package.json'), JSON.stringify({
    name, version: '0.0.0', type: 'module', engines: { node: range },
  }))
  for (const command of ['dsh', 'pnpm']) {
    const path = join(fixture, 'bin', command)
    writeFileSync(path, '#!/bin/sh\nprintf "11.21.0\\n"\n')
    chmodSync(path, 0o755)
    writeFileSync(`${path}.cmd`, '@echo off\r\necho 11.21.0\r\n')
  }
  const run = (version, command) => {
    // Simulates the diagnostic inputs only; this does not run a Node 23 binary.
    const preload = join(fixture, 'version.mjs')
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}})\nObject.defineProperty(process, 'version', {value: ${JSON.stringify(`v${version}`)}})\n`)
    return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(fixture, 'bin/dsh-tui.js'), command], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: fixture, USERPROFILE: fixture, DSH_HOME: join(fixture, 'home'), DSH_TUI_LANG: 'en',
        PATH: [join(fixture, 'bin'), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : [])].join(delimiter) },
    })
  }
  manifest('^22.19 || >=24')
  for (const [version, supported] of [['22.18.9', false], ['22.19.0', true], ['22.20.0', true], ['23.11.0', false], ['24.0.0', true], ['24.0.0-rc.1', false], ['25.0.0', true]]) {
    const doctor = run(version, 'doctor')
    assert.ifError(doctor.error)
    assert.equal(doctor.status, supported ? 0 : 1, `${version}: ${doctor.stderr}`)
    assert.match(doctor.stdout, supported ? /✓ node:/u : /✗ node:/u, doctor.stderr)
    if (!supported) {
      for (const command of ['', 'cli', 'safe', 'update', 'migrate']) {
        const start = run(version, command)
        assert.equal(start.status, 1)
        assert.match(start.stderr, /Node .*unsupported/u)
        assert.doesNotMatch(start.stderr, /CLI_ENTRY_MISSING|delete.*profile/u)
      }
    }
  }
  for (const command of ['help', '--help', '-h', 'version', '--version', '-v']) {
    assert.equal(run('23.11.0', command).status, 0)
  }
  for (const range of [undefined, '', '^0.2', '>=24 <25', 'garbage', '^22.19 || unknown']) {
    manifest(range)
    const start = run('24.0.0', 'cli')
    assert.equal(start.status, 3, `unknown range must reach CLI: ${range}: ${start.stderr}`)
    assert.match(start.stderr, /CLI_ENTRY_MISSING/u)
    const doctor = run('24.0.0', 'doctor')
    assert.equal(doctor.status, 1)
    assert.match(doctor.stdout, /Cannot determine Node/u)
    assert.doesNotMatch(doctor.stdout, /is unsupported/u)
  }
  for (const range of ['>=24', '>=1']) {
    manifest(range, 'unrelated-package')
    assert.equal(run('22.19.0', 'cli').status, 3, 'foreign manifest must not block launch')
    assert.match(run('22.19.0', 'doctor').stdout, /Cannot determine Node/u)
  }
  // A supported runtime must preserve the real loader's Error.cause chain.
  manifest('^22.19 || >=24')
  mkdirSync(join(fixture, 'cli'))
  writeFileSync(join(fixture, 'cli/entry.mjs'), "throw new Error('fixture loader failure', { cause: new Error('fixture root cause') })\n")
  const failure = run(process.versions.node, 'cli')
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /fixture loader failure/u)
  assert.match(failure.stderr, /fixture root cause/u)
  assert.doesNotMatch(failure.stderr, /unsupported|delete.*profile/u)
  console.log('Node runtime diagnostics OK (simulated version inputs)')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
