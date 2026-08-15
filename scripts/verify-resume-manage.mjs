#!/usr/bin/env node
/**
 * Regression: /resume session management (issue #112) — the storage-level
 * half of picker delete/rename (src/compat/sessionLog.ts).
 *
 * Builds a multi-frame zstd session log under a temp DSH_TUI_SESSION_ROOT
 * and asserts:
 *   1. appendSessionTitle adds ONE zstd frame whose event continues the
 *      seq sequence, leaving every existing byte untouched (the frame-0
 *      header invariant the backend's list() depends on);
 *   2. the new title is what readSessionTitleFromLog reports afterwards
 *      (last session/title wins), so the picker shows the rename;
 *   3. a second rename appends another frame and wins over the first;
 *   4. deleteSessionLog removes the whole session directory, after which
 *      both operations report 'unavailable' and touch nothing;
 *   5. unknown session ids report 'unavailable' from the start;
 *   6. hostile ids (path separators, dots, spaces) are rejected BEFORE any
 *      filesystem effect — deleteSessionLog does a recursive rm, so a
 *      traversal like '../../victim' must never resolve outside the root;
 *   7. a symlinked workspace directory pointing outside the root is refused
 *      too — containment is checked with realpath on BOTH sides, not
 *      lexical resolve (which a <root>/<ws symlink>/<id> layout defeats).
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-manage-'))
process.env.DSH_TUI_SESSION_ROOT = root

// Import AFTER the env override: the module resolves roots at call time,
// but keeping the order obvious protects against future module-level reads.
const { appendSessionTitle, deleteSessionLog, readSessionTitleFromLog } =
  await import('../lib/types/dsh-adapter/compat/sessionLog.js')

const sessionId = '00000000-1111-2222-3333-444444444444'
const dir = join(root, '--work-space--', sessionId)
mkdirSync(dir, { recursive: true })
const file = join(dir, 'session.jsonl.zstd')

const header = { type: 'session', version: 0, id: sessionId, createdAt: 1, cwd: 'D:\\work', delegationDepth: 0 }
const first = { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'original question' }] } }
const autoTitle = { type: 'session/title', seq: 1, time: 2, data: { title: 'auto title', messageSeqs: [0], source: { kind: 'fallback' } } }

// The persistence layer appends one zstd frame per flush — reproduce that.
const frames = [[header], [first, autoTitle]]
writeFileSync(file, Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))))

const ZSTD_MAGIC = 0xfd2fb528
const splitFrames = (buf) => {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  return offsets.map((start, i) => buf.subarray(start, i + 1 < offsets.length ? offsets[i + 1] : buf.length))
}
const decodeAll = () =>
  splitFrames(readFileSync(file)).flatMap((f) =>
    zstdDecompressSync(f).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  )

// Baseline: the auto title wins before any rename.
assert.equal(readSessionTitleFromLog(sessionId)?.title, 'auto title', 'baseline title')
assert.equal(readSessionTitleFromLog(sessionId)?.hasUserMessage, true, 'baseline user message')

// ── Rename ──────────────────────────────────────────────────────────────
const bytesBefore = readFileSync(file)
assert.equal(appendSessionTitle(sessionId, 'renamed by user'), 'appended', 'rename appends')

const afterBuf = readFileSync(file)
const afterFrames = splitFrames(afterBuf)
assert.equal(afterFrames.length, 3, 'rename adds exactly one frame')
// Existing bytes are a strict prefix — the header frame and every earlier
// event keep their exact bytes (listings read frame 0 only).
assert.deepEqual(afterBuf.subarray(0, bytesBefore.length), bytesBefore, 'existing bytes untouched')

const events = decodeAll()
assert.equal(events.length, 4, 'event count grows by one')
const appended = events[3]
assert.equal(appended.type, 'session/title', 'appended event type')
assert.equal(appended.seq, 2, 'seq continues the contiguity contract (maxSeq + 1)')
assert.equal(typeof appended.time, 'number', 'time is a number')
assert.equal(appended.data.title, 'renamed by user', 'appended title payload')

assert.equal(readSessionTitleFromLog(sessionId)?.title, 'renamed by user', 'last title wins')

// A second rename stacks another frame and overrides the first.
assert.equal(appendSessionTitle(sessionId, 'second name'), 'appended', 'second rename appends')
assert.equal(splitFrames(readFileSync(file)).length, 4, 'second rename adds another frame')
assert.equal(decodeAll()[4].seq, 3, 'second rename seq continues')
assert.equal(readSessionTitleFromLog(sessionId)?.title, 'second name', 'second rename wins')

// ── Delete ──────────────────────────────────────────────────────────────
assert.equal(deleteSessionLog(sessionId), 'deleted', 'delete removes the session')
assert.equal(existsSync(dir), false, 'session directory is gone')
assert.equal(deleteSessionLog(sessionId), 'unavailable', 're-delete reports unavailable')
assert.equal(appendSessionTitle(sessionId, 'ghost'), 'unavailable', 'rename after delete reports unavailable')
assert.equal(existsSync(dir), false, 'failed rename recreates nothing')
assert.equal(readSessionTitleFromLog(sessionId), undefined, 'title read after delete is undefined')

// Unknown ids never touch the filesystem.
const unknown = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
assert.equal(deleteSessionLog(unknown), 'unavailable', 'unknown delete reports unavailable')
assert.equal(appendSessionTitle(unknown, 'ghost'), 'unavailable', 'unknown rename reports unavailable')

// ── Path traversal: the id reaches path.join() and deleteSessionLog does a
// recursive rm on the resolved parent — hostile ids must be rejected as
// 'unavailable' before any filesystem effect. ────────────────────────────
const victim = mkdtempSync(join(tmpdir(), 'dsh-tui-victim-'))
writeFileSync(join(victim, 'keep.txt'), 'do not delete')
for (const hostile of ['../../' + victim.split('/').pop(), '..', '.', 'a/b', 'a\\b', '', 'with space', 'id.json', '.hidden']) {
  assert.equal(deleteSessionLog(hostile), 'unavailable', `delete rejects hostile id ${JSON.stringify(hostile)}`)
  assert.equal(appendSessionTitle(hostile, 'x'), 'unavailable', `rename rejects hostile id ${JSON.stringify(hostile)}`)
  assert.equal(readSessionTitleFromLog(hostile), undefined, `title read rejects hostile id ${JSON.stringify(hostile)}`)
}
assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not delete', 'victim directory survives')
rmSync(victim, { recursive: true, force: true })

// ── Symlinked workspace: a whitelisted id under <root>/<ws symlink> points
// OUTSIDE the root. Lexical resolve() passes; only realpath containment
// stops the recursive rm from deleting outside data. ─────────────────────
const outside = mkdtempSync(join(tmpdir(), 'dsh-tui-outside-'))
const linkedId = 'deadbeefcafe'
const linkedDir = join(outside, linkedId)
mkdirSync(linkedDir, { recursive: true })
writeFileSync(join(linkedDir, 'session.jsonl.zstd'), Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))))
writeFileSync(join(outside, 'keep.txt'), 'do not delete')
// 'junction' is Windows-admin-free and ignored on POSIX.
symlinkSync(outside, join(root, 'ws-link'), 'junction')
assert.equal(deleteSessionLog(linkedId), 'unavailable', 'delete through a symlinked workspace is refused')
assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'do not delete', 'outside data survives the symlink delete')
assert.equal(existsSync(join(linkedDir, 'session.jsonl.zstd')), true, 'outside session log survives')
rmSync(join(root, 'ws-link'), { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })

rmSync(root, { recursive: true, force: true })
console.log('verify-resume-manage: OK')
