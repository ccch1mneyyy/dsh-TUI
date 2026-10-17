/** Optional keyless end-to-end test against an installed official DSH runtime. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = process.env.DST_TEST_DSH_BIN
if (!bin) throw new Error('Set DST_TEST_DSH_BIN to an installed DSH 0.2.0-rc.2 built JS bin')
const temporary = mkdtempSync(join(tmpdir(), 'dst-real-'))
const root = fileURLToPath(new URL('../../', import.meta.url))
const launcher = process.env.DST_TEST_CLI_BIN ?? join(root, 'bin/dsh-tui.js')
const provider = fileURLToPath(new URL('./fixtures/provider.mjs', import.meta.url))
const overlay = join(temporary, 'provider.json')
writeFileSync(overlay, JSON.stringify([
  { id: 'agent-default-model', config: { provider: 'dst-test', model: 'fixture' } },
  { id: 'session-title-llm', disabled: true },
  { insert: [{ id: 'dst-test-provider', name: provider }] },
]))
const run = args => {
  const result = spawnSync(process.execPath, [launcher, ...args, '--dsh-bin', bin, '--patch', overlay, '--json', '--timeout=30000'], {
    cwd: temporary, encoding: 'utf8', input: '', timeout: 45000,
    env: { ...process.env, DSH_HOME: join(temporary, 'home'), DSH_TUI_CLI_DSH_BIN: bin, DST_TEST_DSH_BIN: bin, DSH_TELEMETRY_DISABLED: '1' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout)
}
try {
  const first = run(['run', 'keyless first turn'])
  assert.equal(first.text, 'CLI_RUNTIME_OK 🐋')
  assert(first.sessionId)
  assert.equal(run(['run', '--session-id', first.sessionId, 'keyless second turn']).sessionId, first.sessionId)
  assert.equal(run(['run', '--continue', 'keyless third turn']).sessionId, first.sessionId)
  assert.equal(run(['session', 'list']).data[0].sessionId, first.sessionId)
  assert.equal(run(['session', 'show', first.sessionId]).data.session.id, first.sessionId)
  assert.match(run(['session', 'export', first.sessionId]).data, /CLI_RUNTIME_OK/u)
  assert(Array.isArray(run(['models', 'list']).data))
  assert(Array.isArray(run(['skills', 'list']).data))
  assert.equal(run(['mcp', 'status']).data.connectionHealth, 'unavailable')
  assert.equal(typeof run(['auth', 'status']).data.configured, 'boolean')
  console.log('PASS: real DSH profile, headless run/resume/continue, query/export/models/skills/MCP/auth (no model/network)')
} finally { rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }) }
