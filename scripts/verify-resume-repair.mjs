#!/usr/bin/env node
/**
 * Regression: pre-resume session-log repair (src/compat/sessionLog.ts).
 *
 * Builds a multi-frame zstd session log mixing known harness event types
 * with third-party ones (activity/status + a fictitious plugin type), runs
 * the repair against a temp DSH_TUI_SESSION_ROOT, and asserts:
 *   1. unknown types get ignorable:true (the resume-blocking case);
 *   2. known types are never marked;
 *   3. already-ignorable events are untouched;
 *   4. a second repair pass is a no-op ('clean');
 *   5. a missing session reports 'unavailable' and touches nothing.
 *   6. the profile's shared $DSH_HOME/sessions root is scanned by default.
 * Exits non-zero on any assertion failure (CI gate).
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-repair-'))
process.env.DSH_TUI_SESSION_ROOT = root

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

// 多帧日志必须逐帧解码——单帧 decompress 只出第一帧，静默漏掉后续事件。
const decodeAll = () =>
  splitFrames(readFileSync(file)).flatMap((f) =>
    zstdDecompressSync(f).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  )

const outcome = await repairSessionLogForResume(sessionId)
assert.equal(outcome, 'repaired', 'first pass must repair')

// Frame layout is load-bearing: the backend asserts frame 0 holds EXACTLY
// the header line (assertZstdHeaderFrame; listings read only that frame).
// A repair that collapses frames breaks /resume listing for EVERY session.
const ZSTD_MAGIC = 0xfd2fb528
const splitFrames = (buf) => {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  return offsets.map((start, i) => buf.subarray(start, i + 1 < offsets.length ? offsets[i + 1] : buf.length))
}
const repairedBuf = readFileSync(file)
const repairedFrames = splitFrames(repairedBuf)
assert.equal(repairedFrames.length, 3, 'frame count preserved (no collapsing)')
const frame0Lines = zstdDecompressSync(repairedFrames[0]).toString('utf8').split('\n').filter(Boolean)
assert.equal(frame0Lines.length, 1, 'frame 0 must hold exactly the header line')
assert.equal(JSON.parse(frame0Lines[0]).type, 'session', 'frame 0 is the header')
// Frames whose lines were untouched are copied back byte-identically.
const originalFrames = splitFrames(Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))))
assert.deepEqual(repairedFrames[0], originalFrames[0], 'header frame bytes untouched')
assert.deepEqual(repairedFrames[1], originalFrames[1], 'known-only frame bytes untouched')

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

const bytesBeforeSecond = readFileSync(file)
const second = await repairSessionLogForResume(sessionId)
assert.equal(second, 'clean', 'second pass is a no-op')
assert.deepEqual(readFileSync(file), bytesBeforeSecond, 'second pass leaves bytes identical')

const missing = await repairSessionLogForResume('ffffffff-ffff-ffff-ffff-ffffffffffff')
assert.equal(missing, 'unavailable', 'missing session reports unavailable')

// Profile installs default to $DSH_HOME/sessions, not the legacy
// ~/.dsh-cc/sessions. Exercise that path without an explicit root override.
delete process.env.DSH_CC_SESSION_ROOT
process.env.DSH_HOME = join(root, 'dsh-home')
const sharedSessionId = '11111111-2222-3333-4444-555555555555'
const sharedDir = join(process.env.DSH_HOME, 'sessions', '--shared-workspace--', sharedSessionId)
mkdirSync(sharedDir, { recursive: true })
const sharedFile = join(sharedDir, 'session.jsonl.zstd')
writeFileSync(sharedFile, Buffer.concat([
  zstdCompressSync(Buffer.from(JSON.stringify({ ...header, id: sharedSessionId }) + '\n', 'utf8')),
  zstdCompressSync(Buffer.from(JSON.stringify(thirdParty) + '\n', 'utf8')),
]))
assert.equal(repairSessionLogForResume(sharedSessionId), 'repaired', 'shared DSH_HOME root repaired')
const sharedEvent = JSON.parse(zstdDecompressSync(splitFrames(readFileSync(sharedFile))[1]).toString('utf8'))
assert.equal(sharedEvent.ignorable, true, 'shared-root activity/status marked ignorable')

rmSync(root, { recursive: true, force: true })
console.log('verify-resume-repair: OK')
