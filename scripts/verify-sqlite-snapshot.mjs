/** Run on BOTH official supported runtimes:
 * node scripts/verify-sqlite-snapshot.mjs
 * Real WAL/read-only backup; disposable databases, no user data.
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupSqliteSnapshot } from './lib/sqlite-snapshot.mjs'
const root = mkdtempSync(join(tmpdir(), 'sqlite-snapshot-'))
let opened = false
await assert.rejects(backupSqliteSnapshot('unused', 'unused', {
  DatabaseSync: class { constructor() { opened = true } },
}), /requires node:sqlite backup/)
assert.equal(opened, false, 'missing capability rejected before source open')
let closed = false
await assert.rejects(backupSqliteSnapshot('unused', 'unused', {
  DatabaseSync: class { close() { closed = true } },
  backup: async () => { throw new Error('fixture failure') },
}), /fixture failure/)
assert.equal(closed, true, 'backup failure closes source')
const source = join(root, 'source.sqlite')
const writer = new DatabaseSync(source)
try {
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events (seq INTEGER PRIMARY KEY, text TEXT)')
  const insert = writer.prepare('INSERT INTO events VALUES (?, ?)')
  for (let i = 0; i < 100; i++) insert.run(i, `event-${i}`)
  const before = [source, `${source}-wal`].map(path => readFileSync(path))
  writer.exec('BEGIN; INSERT INTO events VALUES (100, \'uncommitted\')')
  const to = join(root, "snapshot's.sqlite")
  await backupSqliteSnapshot(source, to)
  for (const [index, path] of [source, `${source}-wal`].entries()) {
    assert.deepEqual(readFileSync(path), before[index], `source ${path} unchanged`)
  }
  const copy = new DatabaseSync(to, { readOnly: true })
  try {
    assert.deepEqual(copy.prepare('SELECT * FROM events ORDER BY seq').all(), writer.prepare('SELECT * FROM events WHERE seq < 100 ORDER BY seq').all())
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM events').get().n, 100)
  } finally { copy.close() }
  writer.exec('ROLLBACK')
  console.log(`PASS: ${process.version} committed WAL snapshot, uncommitted exclusion, source DB/WAL unchanged, failure close`)
} finally {
  writer.close()
  rmSync(root, { recursive: true, force: true })
}
