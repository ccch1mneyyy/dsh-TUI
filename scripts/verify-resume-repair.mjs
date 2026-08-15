#!/usr/bin/env node
/**
 * Regression: pre-resume session-log repair (src/compat/sessionLog.ts).
 *
 * Builds a multi-frame zstd session log mixing known harness event types
 * with third-party ones (activity/status + a fictitious plugin type), runs
 * the repair against a temp DSH_CC_SESSION_ROOT, and asserts:
 *   1. unknown types get ignorable:true (the resume-blocking case);
 *   2. known types are never marked;
 *   3. already-ignorable events are untouched;
 *   4. a second repair pass is a no-op ('clean');
 *   5. a missing session reports 'unavailable' and touches nothing.
 * Exits non-zero on any assertion failure (CI gate).
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-repair-'))
process.env.DSH_CC_SESSION_ROOT = root

// Import AFTER the env override: the module resolves the root at call time,
// but keeping the order obvious protects against future module-level reads.
const { repairSessionLogForResume } = await import('../lib/types/compat/sessionLog.js')

const sessionId = '00000000-1111-2222-3333-444444444444'
const dir = join(root, '--work-space--', sessionId)
mkdirSync(dir, { recursive: true })
const file = join(dir, 'session.jsonl.zstd')

const header = { type: 'session', version: 0, id: sessionId, createdAt: 1, cwd: 'D:\\work', delegationDepth: 0, agentPreset: 'standard' }
const knownA = { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'standard' } }
const knownB = { type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'workspace' } }
const thirdParty = { type: 'activity/status', seq: 3, time: 4, data: { phase: 'thinking', line: '…' } }
const fictitious = { type: 'acme/telemetry', seq: 4, time: 5, data: {} }
const alreadyIgnorable = { type: 'acme/old', seq: 5, time: 6, data: {}, ignorable: true }

// The persistence layer appends one zstd frame per flush — reproduce that.
const frames = [
  [header],
  [knownA, knownB],
  [thirdParty, fictitious, alreadyIgnorable],
]
writeFileSync(file, Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))))

const decodeAll = () =>
  zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const outcome = await repairSessionLogForResume(sessionId)
assert.equal(outcome, 'repaired', 'first pass must repair')

const after = decodeAll()
assert.equal(after.length, 6, 'event count preserved')
const byType = Object.fromEntries(after.map((e) => [e.type, e]))
assert.equal(byType['activity/status'].ignorable, true, 'activity/status marked ignorable')
assert.equal(byType['acme/telemetry'].ignorable, true, 'fictitious third-party type marked')
assert.equal(byType['session'].ignorable, undefined, 'header untouched')
assert.equal(byType['permission/preset'].ignorable, undefined, 'known type untouched')
assert.equal(byType['sandbox/mode'].ignorable, undefined, 'known type untouched')
assert.equal(byType['acme/old'].ignorable, true, 'pre-marked event untouched')

// Probe coherence: whatever upstream's list says is the patch's own probe.
for (const e of after) {
  if (KNOWN_SESSION_EVENT_TYPES.has(e.type)) {
    assert.equal(e.ignorable, undefined, `known type ${e.type} must stay unmarked`)
  }
}

const second = await repairSessionLogForResume(sessionId)
assert.equal(second, 'clean', 'second pass is a no-op')

const missing = await repairSessionLogForResume('ffffffff-ffff-ffff-ffff-ffffffffffff')
assert.equal(missing, 'unavailable', 'missing session reports unavailable')

rmSync(root, { recursive: true, force: true })
console.log('verify-resume-repair: OK')
