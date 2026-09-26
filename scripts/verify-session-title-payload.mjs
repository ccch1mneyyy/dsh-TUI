#!/usr/bin/env node
/**
 * Regression: the `session/title` payload shape at BOTH TUI writers
 * (issue #1006).
 *
 * Why this exists: `appendSessionTitle` (offline `/fork` + `/resume` picker
 * rename) and the live `/rename` used to append `data: { title }` only. The
 * strict v4 reader requires `messageSeqs` (an array, empty exactly when
 * `source.kind === 'user'`) and a `source` on EVERY `session/title` event and
 * fails the WHOLE log closed otherwise, so every forked/renamed session
 * became unresumable ("stored log is corrupt: SessionFormatError: title
 * messageSeqs requires an array") while the TUI still reported success.
 *
 * Part 1 boots the REAL upstream storage stack (SessionStore + the jsonl
 * persistence backend) against a temp root and reads through the backend's
 * OWN strict path — the reader that rejected the reporter's log, independent
 * of the writer under test:
 *   1. the hand-crafted current-generation fixture opens (control);
 *   2. after the real `appendSessionTitle()` runs, the SAME session still
 *      opens and the new title is the last `session/title` event;
 *   3. red-state self-proof: the pre-fix payload (`{ title }` only) written
 *      into a byte-identical fixture IS rejected with the reporter's exact
 *      error — so a revert of the fix cannot pass this gate silently;
 *   4. the live-path payload builder (`userTitleData`, the data the channel
 *      hands to `session.append('session/title', …)`) also opens, carries an
 *      empty `messageSeqs`, and folds to a `kind: 'user'` title.
 *
 * Part 2 pins the shape contract itself: the builder is the single source for
 * both writers, so the assertions above cover the live path's payload too.
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-title-payload-'))
// The compat writer resolves its store through this override first.
process.env.DSH_TUI_SESSION_ROOT = root

const { appendSessionTitle, userTitleData } = await import('../lib/types/dsh-adapter/compat/sessionLog.js')

/**
 * Read every stored event of one session through the backend's strict path.
 * `load()` is the pre-0.1.5 API; 0.1.5 replaced it with open() + read().
 */
async function readAllEvents(persistence, id) {
  if (typeof persistence.load === 'function') {
    const loaded = await persistence.load(id)
    return loaded.events
  }
  const handle = await persistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

/** Write one compressed-generation log: header frame + one frame per event. */
function writeLog(id, records) {
  const dir = join(root, '--tmp-verify--', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`)
  writeFileSync(
    file,
    Buffer.concat(records.map(record => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8')))),
  )
  chmodSync(file, 0o600) // the backend's artifact mode
  return file
}

/** Append one more frame to a log the way `appendSessionTitle` does. */
function appendFrame(file, record) {
  const bytes = readFileSync(file)
  writeFileSync(file, Buffer.concat([bytes, zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'))]))
}

/** A current-generation header authored by the PRODUCTION encoder. */
function headerLine(id) {
  return sessionFormatCatalog.encodeCurrentHeader(
    {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: '/tmp/verify',
      isSeeded: false,
      delegationDepth: 0,
    },
    0,
  )
}

/** A stored session with one human message — the shortest valid log there is. */
function writeSession(id) {
  return writeLog(id, [
    headerLine(id),
    sessionFormatCatalog.encodeCurrentEvent({
      type: 'user/message',
      seq: 0,
      time: 2,
      surfaceOp: 'append',
      // A `user/message` row's data IS the message (other roles nest it
      // under data.message).
      data: { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, id: 'msg-1' },
    }),
  ])
}

const ctx = new Context()
await ctx.plugin(SessionStore)
const fork = ctx.plugin(Jsonl, { root })
if (fork && typeof fork.await === 'function') await fork.await()
else await fork
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence, 'sessionPersistence service mounted')

// --- 1. control: a clean fixture opens before any TUI write ----------------
const renamedId = 'aaaaaaaa-0000-0000-0000-00000000000a'
const renamedFile = writeSession(renamedId)
const before = await readAllEvents(persistence, renamedId)
assert.equal(before.length, 1, 'control fixture opens with its one event')

// --- 2. the real offline writer keeps it openable --------------------------
assert.equal(appendSessionTitle(renamedId, 'Fork: hello'), 'appended', 'appendSessionTitle reports appended')
const afterEvents = await readAllEvents(persistence, renamedId)
assert.equal(afterEvents.length, 2, 'renamed session still opens (issue #1006 regression)')
const appended = afterEvents.at(-1)
assert.equal(appended.type, 'session/title', 'the appended event is the title')
assert.equal(appended.data.title, 'Fork: hello', 'the appended title is the new name')
assert.deepEqual(appended.data.messageSeqs, [], 'a user rename cites no message')

// --- 3. red-state self-proof: the pre-fix payload really is fatal ----------
// Same fixture shape, one hand-written `{ title }`-only event — exactly the
// bytes the old writer produced.
const poisonedId = 'bbbbbbbb-0000-0000-0000-00000000000b'
const poisonedFile = writeSession(poisonedId)
appendFrame(poisonedFile, { type: 'session/title', seq: 1, time: 3, data: { title: 'Fork: hello' } })
await assert.rejects(
  () => readAllEvents(persistence, poisonedId),
  (error) => {
    assert.match(String(error.message), /title messageSeqs requires an array/)
    return true
  },
  'the strict reader must reject a `{ title }`-only event (otherwise this gate proves nothing)',
)

// --- 4. the live `/rename` payload (channel → session.append) --------------
const liveId = 'cccccccc-0000-0000-0000-00000000000c'
const liveFile = writeSession(liveId)
const liveData = userTitleData('manual name')
appendFrame(liveFile, { type: 'session/title', seq: 1, time: 3, data: liveData })
const liveEvents = await readAllEvents(persistence, liveId)
assert.equal(liveEvents.length, 2, 'a live /rename payload keeps the log openable')
assert.deepEqual(
  { title: liveEvents.at(-1).data.title, messageSeqs: liveEvents.at(-1).data.messageSeqs, source: liveEvents.at(-1).data.source },
  { title: 'manual name', messageSeqs: [], source: { kind: 'user' } },
  'the live payload is a user title with an empty messageSeqs',
)
assert.equal(sessionFormatCatalog.currentVersion, SESSION_FORMAT_VERSION, 'fixtures target the stack’s current format')
assert.deepEqual(userTitleData('x'), { title: 'x', messageSeqs: [], source: { kind: 'user' } }, 'one payload builder serves both writers')

rmSync(root, { recursive: true, force: true })
console.log('verify-session-title-payload: OK')
process.exit(0)
