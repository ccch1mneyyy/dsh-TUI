#!/usr/bin/env node
/**
 * Real launcher + isolated installed profile + real child processes. The inert
 * entry controls its outcome; the observer records spawn calls synchronously
 * and invokes the original spawn. No compiled modules or host are required.
 *
 * Run: node scripts/verify-launcher-probe.mjs [path/to/bin/dsh-tui.js]
 * Cleanup fault injection: add --cleanup-self-test before the optional path;
 * it deliberately times out, records cleanup, and must still exit nonzero.
 * This checks routing/work count, not startup timing. POSIX only: every launcher
 * owns a process group with bounded cleanup. Windows needs a separate tree gate.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cleanupSelfTest = process.argv[2] === '--cleanup-self-test'
const sourceBin = resolve(process.argv[cleanupSelfTest ? 3 : 2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-tui.js'))
const source = readFileSync(sourceBin, 'utf8')
if (process.platform === 'win32') {
  console.error('This fixture requires POSIX process-group cleanup; Windows verification is not implemented.')
  process.exit(2)
}
const tmp = mkdtempSync(join(tmpdir(), 'verify-launcher-probe-'))
const home = join(tmp, 'home')
const dshHome = join(home, 'dsh')
const pkg = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const bin = join(pkg, 'bin', 'dsh-tui.js')
const entry = join(pkg, 'lib', 'types', 'dsh-adapter', 'host-entry.js')
const stubs = join(tmp, 'stub-bin')
const emptyPath = join(tmp, 'empty-path')
const observer = join(tmp, 'observe.cjs')
const dsh = join(tmp, 'dsh.cjs')
let failures = 0
let passed = 0
const pollCell = new Int32Array(new SharedArrayBuffer(4))

function groupExists(pid) {
  try { process.kill(-pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

// The detached launcher is the group leader. A timeout killing that leader
// alone does not own its descendants; cleanup always checks the whole group.
function cleanupGroup(pid) {
  const actions = []
  if (!Number.isInteger(pid) || pid <= 0) return { actions, residualGroup: false }
  assert.notEqual(pid, process.pid, 'launcher must own a distinct process group')
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!groupExists(pid)) break
    try { process.kill(-pid, signal); actions.push(signal) } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    const deadline = Date.now() + 1000
    while (groupExists(pid) && Date.now() < deadline) Atomics.wait(pollCell, 0, 0, 10)
  }
  return { actions, residualGroup: groupExists(pid) }
}

function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (ok) passed++
  else failures++
}

try {
  for (const dir of [dirname(bin), dirname(entry), stubs, emptyPath]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.0.0-fixture', type: 'module' }))
  writeFileSync(bin, source)
  writeFileSync(observer, `const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawn;
cp.spawn = function (...args) {
  const child = Reflect.apply(original, this, args);
  fs.appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({kind:'spawn', file:args[0], args:args[1], pid:child.pid ?? null})+'\\n');
  return child;
};
require('node:module').syncBuiltinESMExports();
`)
  // The old eager probe could finish after an immediate successful entry. Its
  // synchronous spawn record is the oracle; this wait only lets already-owned
  // fixture children finish before the entry ends, without a fixed sleep.
  writeFileSync(entry, `import { appendFileSync, readFileSync } from 'node:fs';
const events = readFileSync(process.env.PROBE_EVENTS, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
const deadline = Date.now() + 5000;
for (const event of events) {
  if (event.kind !== 'spawn' || event.pid === null || event.pid === process.pid) continue;
  for (;;) {
    try { process.kill(event.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    if (Date.now() > deadline) throw new Error('fixture child did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({kind:'entry', pid:process.pid})+'\\n');
if (process.env.PROBE_ENTRY_HANG === '1') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (process.env.PROBE_ENTRY_MESSAGE) process.stderr.write(process.env.PROBE_ENTRY_MESSAGE+'\\n');
if (process.env.PROBE_ENTRY_SIGNAL) process.kill(process.pid, process.env.PROBE_ENTRY_SIGNAL);
else
process.exit(Number(process.env.PROBE_ENTRY_EXIT ?? 0));
`)
  writeFileSync(dsh, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({kind:'dsh', pid:process.pid, args})+'\\n');
process.exit(Number(args[0] === '--version' ? process.env.PROBE_VERSION_EXIT ?? 0 : process.env.PROBE_PROFILE_EXIT ?? 0));
`)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(join(stubs, 'dsh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(dsh)} "$@"\n`)
  chmodSync(join(stubs, 'dsh'), 0o755)

  function run(name, extraEnv = {}, missing = false, expectedSignal = null, timeout = 10000) {
    const journal = join(tmp, `${name}.jsonl`)
    const stdoutFile = join(tmp, `${name}.stdout`)
    const stderrFile = join(tmp, `${name}.stderr`)
    writeFileSync(journal, '')
    const stdoutFd = openSync(stdoutFile, 'w')
    const stderrFd = openSync(stderrFile, 'w')
    let result
    try {
      result = spawnSync(process.execPath, ['--require', observer, bin, 'fixture prompt'], {
        cwd: tmp,
        env: {
          HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
          PATH: missing ? emptyPath : stubs,
          DSH_TUI_LANG: 'en', PROBE_EVENTS: journal, ...extraEnv,
        },
        // Files avoid an orphan's inherited stdout pipe keeping spawnSync
        // open after the leader dies. SIGKILL makes that timeout bounded too.
        stdio: ['ignore', stdoutFd, stderrFd], timeout, killSignal: 'SIGKILL', detached: true,
      })
    } finally {
      closeSync(stdoutFd)
      closeSync(stderrFd)
    }
    // Before parsing/asserting, so those failures cannot skip child cleanup.
    let cleanup
    try { cleanup = cleanupGroup(result.pid) } catch (error) {
      cleanup = { actions: [], residualGroup: true, error: error.message }
    }
    const events = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    const probeSpawns = events.filter(e => e.kind === 'spawn' && (e.file === 'dsh --version' || e.file === 'dsh' && e.args?.[0] === '--version'))
    const versions = events.filter(e => e.kind === 'dsh' && e.args[0] === '--version')
    const profiles = events.filter(e => e.kind === 'dsh' && e.args[0] === '--profile')
    const entries = events.filter(e => e.kind === 'entry')
    const stdout = readFileSync(stdoutFile, 'utf8')
    const stderr = readFileSync(stderrFile, 'utf8')
    console.log(JSON.stringify({ name, status: result.status, signal: result.signal, error: result.error?.message, stdout, stderr, cleanup, events }))
    // Cleanup never turns a timeout or leftover-child failure into a pass.
    assert.equal(result.error, undefined, `${name}: child process failed or timed out`)
    assert.equal(cleanup.error, undefined, `${name}: process-group cleanup failed`)
    assert.equal(result.signal, expectedSignal, `${name}: unexpected signal`)
    assert.deepEqual(cleanup.actions, [], `${name}: descendants remained after launcher exit`)
    assert.equal(cleanup.residualGroup, false, `${name}: process group remains after cleanup`)
    return { ...result, stdout, stderr, probeSpawns, versions, profiles, entries }
  }

  if (cleanupSelfTest) {
    run('cleanup-timeout', { PROBE_ENTRY_HANG: '1' }, false, null, 1000)
    throw new Error('cleanup fault injection unexpectedly completed')
  }

  let r = run('entry-success')
  check('entry success: actual entry exits 0', r.status === 0 && r.entries.length === 1 && r.stderr === '')
  check('entry success: no version probe or profile child', r.probeSpawns.length === 0 && r.versions.length === 0 && r.profiles.length === 0)

  r = run('entry-signal', { PROBE_ENTRY_SIGNAL: 'SIGTERM' }, false, 'SIGTERM')
  check('entry signal: SIGTERM is mirrored without a version probe', r.status === null && r.entries.length === 1 && r.probeSpawns.length === 0 && r.versions.length === 0 && r.profiles.length === 0)

  r = run('legacy', { DSH_TUI_HOST_ENTRY: '0', PROBE_PROFILE_EXIT: '7' })
  check('legacy: exactly one actual version probe', r.probeSpawns.length === 1 && r.versions.length === 1)
  check('legacy: profile argv and nonzero exit preserved', r.status === 7 && r.entries.length === 0 && r.profiles.length === 1 && JSON.stringify(r.profiles[0].args) === JSON.stringify(['--profile', 'dsh-tui', '--', 'fixture prompt']))

  r = run('entry-failure', { PROBE_ENTRY_EXIT: '23', PROBE_ENTRY_MESSAGE: 'fixture entry failed' })
  check('entry failure: exactly one actual diagnostic probe', r.probeSpawns.length === 1 && r.versions.length === 1 && r.profiles.length === 0)
  check('entry failure: original status and safe guidance preserved', r.status === 23 && r.entries.length === 1 && r.stderr.includes('fixture entry failed') && r.stderr.includes('dsh-tui safe'))

  r = run('entry-missing-cli', { PROBE_ENTRY_EXIT: '23', PROBE_ENTRY_MESSAGE: 'fixture entry failed' }, true)
  check('failed entry without CLI: exactly one failed probe attempt', r.probeSpawns.length === 1 && r.versions.length === 0 && r.profiles.length === 0)
  check('failed entry without CLI: original diagnostic/status only', r.status === 23 && r.entries.length === 1 && r.stderr === 'fixture entry failed\n')

  r = run('legacy-missing-cli', { DSH_TUI_HOST_ENTRY: '0' }, true)
  check('legacy without CLI: one attempt, no entry/profile', r.probeSpawns.length === 1 && r.versions.length === 0 && r.profiles.length === 0 && r.entries.length === 0)
  check('legacy without CLI: installation guidance and exit 1', r.status === 1 && r.stderr.includes('dsh CLI not found') && r.stderr.includes('npm install -g @deepseek-ai/dsh'))

  r = run('legacy-broken-cli', { DSH_TUI_HOST_ENTRY: '0', PROBE_VERSION_EXIT: '9' })
  check('legacy broken CLI: failed version stops before profile', r.status === 1 && r.probeSpawns.length === 1 && r.versions.length === 1 && r.profiles.length === 0 && r.entries.length === 0 && r.stderr.includes('dsh CLI not found'))

  console.log(JSON.stringify({ result: failures === 0 ? 'PASS_SCOPED' : 'FAIL', platform: process.platform, node: process.version, sourceBin, sourceSha256: createHash('sha256').update(source).digest('hex'), passed, failures, scope: 'actual launcher child routing and probe count; inert entry and CLI stubs; no host performance or Windows claim from another platform' }))
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
