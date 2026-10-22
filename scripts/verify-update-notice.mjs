/** Run after compile: node scripts/verify-update-notice.mjs
 * Production runUpdate body with only lifecycle/installer dependencies stubbed.
 * Real child process exits immediately after the actual synchronous notice writer.
 * Installer termination itself is covered by verify-update-process/timeout.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode = process.argv[2]
if (mode) {
  const { writeHandoffNotice, logRestartEvent } = await import('../lib/types/update.js')
  const code = readFileSync(new URL('../lib/types/dsh-adapter/plugin.js', import.meta.url), 'utf8')
  const start = code.indexOf('function runUpdate(')
  const end = code.indexOf('/** Deferred runtime failures', start)
  assert.ok(start >= 0 && end > start)
  const seam = {}
  const invoke = new Function('disposeRootAndThen', 'logRestartEvent', 'writeHandoffNotice', 'preservedSessionTail', 't', 'superviseReplacement', 'updateTuiAndRestart', `${code.slice(start, end)}\nreturn runUpdate`)(
    (_ctx, done) => done(), logRestartEvent, writeHandoffNotice,
    (id, hint) => id === '' ? '\n' : ` Your session is preserved — resume with:\n${hint(id)}\n`,
    () => 'no profile', () => ({}),
    async (_id, _profile, _version, _kernel, _supervision, signal) => {
      if (mode === 'reject') throw new Error('fixture rejected')
      if (mode === 'cancel') {
        assert.equal(seam.request({ kind: 'signal', signal: 'SIGINT' }), 'supervising')
        assert.equal(signal.aborted, true)
        return { updateCode: 130, restartCode: 130 }
      }
      return { updateCode: 124, restartCode: 124 }
    },
  )
  invoke({}, mode === 'no-profile' ? undefined : 'dsh-tui', 'saved-session', undefined, 'dsh', id => `dsh-tui --resume ${id}`, seam)
} else {
  const root = mkdtempSync(join(tmpdir(), 'update-notice-'))
  try {
    for (const [scenario, expected] of [['timeout', 124], ['reject', 1], ['cancel', 130], ['no-profile', 1]]) {
      const result = spawnSync(process.execPath, [import.meta.filename, scenario], {
        env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: 'utf8', timeout: 10000,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, expected, result.stderr)
      assert.match(result.stderr, /installation starts/)
      assert.match(result.stderr, /Check\/repair/)
      assert.equal(result.stderr.match(/dsh-tui --resume saved-session/g)?.length, 2, 'start and failure recovery hints survive immediate exit')
    }
    console.log('PASS: actual runUpdate notice body flushes recovery command at start and timeout/reject/cancel/missing-profile exit; entry cancellation retains installer ownership')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
