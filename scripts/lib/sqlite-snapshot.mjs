import { chmodSync } from 'node:fs'

/** Official SQLite online backup includes committed WAL without writing the source.
 * Capability detection precedes opening it, including on unsupported/custom builds.
 */
export async function backupSqliteSnapshot(from, to, sqlite = undefined) {
  const api = sqlite ?? await import('node:sqlite')
  if (typeof api.backup !== 'function' || typeof api.DatabaseSync !== 'function') {
    throw new Error('SQLite migration requires node:sqlite backup(); use an official Node 22.19+ or Node 24+ build with this API')
  }
  const source = new api.DatabaseSync(from, { readOnly: true })
  try {
    await api.backup(source, to)
    chmodSync(to, 0o600)
  } finally {
    source.close()
  }
}
