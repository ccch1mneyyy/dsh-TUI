/** Run after compile: node scripts/verify-update-timeout.mjs
 * Actual updateTuiAndRestart + fake dsh installer. Isolated HOME/profile only.
 */
if (process.env.DSH_TUI_UPDATED_FROM !== undefined) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.UPDATE_REPLACEMENT_MARKER, 'unexpected replacement')
  process.exit(0)
}
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'update-timeout-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'dsh')
// Include the real PowerShell/Add-Type cold start on Windows.
const timeoutMs = process.platform === 'win32' ? 15000 : 300
process.env.DSH_TUI_UPDATE_TIMEOUT_MS = String(timeoutMs)
process.env.UPDATE_REPLACEMENT_MARKER = join(root, 'replacement')
const bin = join(root, 'bin')
mkdirSync(bin)
const calls = join(root, 'calls')
writeFileSync(join(bin, 'fake.mjs'), `
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(calls)}, 'call\\n')
console.log('Done in 0.1s')
console.error("ENOENT: no such file or directory, scandir '/profile/dsh-tui_tmp_123_1/node_modules'")
setInterval(() => {}, 1000)
`)
if (process.platform === 'win32') {
  writeFileSync(join(bin, 'dsh.cmd'), '@echo off\r\nnode "%~dp0fake.mjs" %*\r\n')
} else {
  writeFileSync(join(bin, 'dsh'), '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n')
  chmodSync(join(bin, 'dsh'), 0o755)
}
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
try {
  const { updateTuiAndRestart } = await import('../lib/types/update.js')
  const started = Date.now()
  const result = await updateTuiAndRestart('preserved-session', 'dsh-tui')
  assert.deepEqual(result, { updateCode: 124, restartCode: 124 })
  assert.ok(Date.now() - started < timeoutMs + 12000, 'bounded timeout and cleanup')
  assert.equal(existsSync(process.env.UPDATE_REPLACEMENT_MARKER), false)
  assert.equal(readFileSync(calls, 'utf8'), 'call\n', 'timeout must never enter transient-race retry')
  const log = readFileSync(join(root, '.dsh-tui', 'restart.log'), 'utf8')
  assert.match(log, /"stage":"start"/)
  assert.match(log, /"stage":"timeout"/)
  assert.match(log, /"pid":\d+/)
  assert.match(log, /"lastOutputAt":\d+/)
  assert.match(log, /"category":"profile-install"/)
  assert.doesNotMatch(log, /restartTui/)
  const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const block = plugin.slice(plugin.indexOf('function runUpdate('), plugin.indexOf('/** Deferred runtime failures'))
  assert.doesNotMatch(block, /process\.stderr\.write/, 'every exit notice uses synchronous handoff writer')
  assert.match(block, /installation starts[\s\S]*?\$\{recovery\}/)
  assert.match(block, /update failed \(exit[\s\S]*?preservedSessionTail/)
  assert.match(block, /cancellation\.abort\(\)[\s\S]*?return 'supervising'/, 'entry signal waits for installer tree cleanup')
  console.log('PASS: real update Done->hang returns124, no retry/replacement, PID/category/last-output log; synchronous recovery notice wiring')
} finally { rmSync(root, { recursive: true, force: true }) }
