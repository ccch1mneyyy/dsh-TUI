/** Backend-neutral first paint through the real core channel, isolated HOME.
 * No CLI, personal session store or network. Async gates are deterministic.
 * Run: node --import tsx/esm scripts/verify-backend-list-snapshot.ts */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionCatalog } from '../src/agent/backend.js'
import type { AgentSession } from '../src/agent/session.js'
import type { SessionSummary } from '../src/adapter/ports/channel-session.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-backend-list-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
const [{ createChannel }, { readListingSnapshot }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/sessions/listSnapshot.js'),
])
let checks = 0
function check(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name)
  checks += 1
  console.log('PASS ' + name)
}
function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const row = (id: string, backendId: string): SessionSummary => ({
  id, backendId, cwd: home, kind: { kind: 'root' }, title: { text: id, source: 'prompt' },
  createdAt: 1, updatedAt: 2, bytes: undefined, hasPrompt: true, childCount: 0,
  agentPreset: undefined, model: undefined, label: undefined, branch: undefined,
})
const ids = (rows: readonly SessionSummary[] | undefined) => rows?.map(row => row.id)
const channels: ReturnType<typeof createChannel>[] = []
function channel(backendId: string, catalog: SessionCatalog) {
  const session: AgentSession = {
    ref: { backendId, sessionId: 'current' }, cwd: home, status: 'idle', capabilities: { native: {} },
    history: async () => [], subscribe: () => () => {}, submit: async () => ({ accepted: true }),
    cancel: async () => ({ stillQueued: [] }), dispose: async () => {},
  }
  const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } } as never
  const result = createChannel(ctx, session, { cwd: home, model: 'fixture', provider: '', sessionCatalog: catalog })
  channels.push(result)
  return result
}

try {
  for (const backendId of ['claude', 'codex']) {
    let key = JSON.stringify([backendId, home])
    let stored = [row('old', backendId)]
    let failure = false
    const catalog: SessionCatalog = {
      snapshotKey: () => key,
      list: async scope => { if (scope?.allProjects && failure) throw new Error('store unavailable'); return stored },
      rename: async (id, title) => { stored = stored.map(row => row.id === id ? { ...row, title: { text: title, source: 'renamed' } } : row) },
      delete: async id => { stored = stored.filter(row => row.id !== id) },
    }
    const first = channel(backendId, catalog)
    check(backendId + ': cold cache is unknown', first.cachedSessions(), undefined)
    await first.listSessions()
    const restarted = channel(backendId, { ...catalog })
    check(backendId + ': fresh channel reads the durable first-paint snapshot without listing', ids(restarted.cachedSessions()), ['old'])
    stored = [row('fresh', backendId)]
    check(backendId + ': refresh replaces stale titles and deletions from the backend', ids(await restarted.listSessions()), ['fresh'])
    check(backendId + ': snapshot follows the authoritative refresh', ids(readListingSnapshot(key)), ['fresh'])
    const other = channel(backendId === 'claude' ? 'codex' : 'claude', { ...catalog, snapshotKey: () => JSON.stringify(['other-backend', backendId, home]) })
    check(backendId + ': another backend/store never sees these rows', other.cachedSessions(), undefined)
    await restarted.renameSessionTo('fresh', 'Renamed')
    check(backendId + ': successful rename updates disk first paint', readListingSnapshot(key)?.[0]?.title.text, 'Renamed')
    await restarted.deleteSession('fresh')
    check(backendId + ': successful deletion updates disk first paint', ids(readListingSnapshot(key)), [])
    stored = [row('kept', backendId)]
    await restarted.listSessions()
    failure = true
    stored = [row('partial', backendId)]
    await restarted.listSessions()
    check(backendId + ': failed global read keeps the previous complete disk snapshot', ids(readListingSnapshot(key)), ['kept'])
    check(backendId + ': failed global read keeps the complete memory snapshot', ids(restarted.cachedSessions()), ['kept'])
    key = JSON.stringify([backendId, home, 'different-store'])
    check(backendId + ': store replacement invalidates same-channel memory', restarted.cachedSessions(), undefined)
    failure = false
    stored = []
    await restarted.listSessions()
    check(backendId + ': an empty completed listing is cached distinctly from unknown', restarted.cachedSessions(), [])
  }

  // A slow page is useful immediately, but cannot masquerade as a complete
  // listing or overwrite the last successful snapshot.
  const key = JSON.stringify(['codex', home, 'paging'])
  const pending = gate<readonly SessionSummary[]>()
  const began = gate<void>()
  let calls = 0
  const catalog: SessionCatalog = {
    snapshotKey: () => key,
    list: async (_scope, onPartial) => {
      calls += 1
      if (calls > 1) return [row('first-page', 'codex'), row('last-page', 'codex')]
      onPartial?.([row('first-page', 'codex')])
      began.resolve()
      return pending.promise
    },
  }
  const paged = channel('codex', catalog)
  const partials: string[][] = []
  const listing = paged.listSessions(undefined, rows => { partials.push(ids(rows)!) })
  await began.promise
  check('cold paging: first-page callback reaches the real channel before completion', partials, [['first-page']])
  check('cold paging: partial rows do not become a memory snapshot', paged.cachedSessions(), undefined)
  check('cold paging: partial rows do not become a disk snapshot', readListingSnapshot(key), undefined)
  pending.resolve([row('first-page', 'codex')])
  await listing
  check('cold paging: final snapshot has all pages', ids(readListingSnapshot(key)), ['first-page', 'last-page'])

  // Reloads overlap: the newest one wins in memory and on disk, including
  // across distinct channel instances sharing the same native store.
  const slow = gate<readonly SessionSummary[]>()
  const started = gate<void>()
  let count = 0
  const racing: SessionCatalog = {
    snapshotKey: () => JSON.stringify(['claude', home, 'racing']),
    list: async scope => {
      if (!scope?.allProjects && ++count === 1) { started.resolve(); return slow.promise }
      return [row('newest', 'claude')]
    },
  }
  const raced = channel('claude', racing)
  const oldListing = raced.listSessions()
  await started.promise
  await raced.listSessions()
  slow.resolve([row('late', 'claude')])
  check('overlapping reload: an obsolete read cannot publish', await oldListing, [])
  check('overlapping reload: the latest memory snapshot survives', ids(raced.cachedSessions()), ['newest'])
  check('overlapping reload: the latest disk snapshot survives', ids(readListingSnapshot(racing.snapshotKey!()!)), ['newest'])
  const crossKey = JSON.stringify(['codex', home, 'cross-channel'])
  const earlier = gate<readonly SessionSummary[]>()
  const scanning = gate<void>()
  const olderChannel = channel('codex', {
    snapshotKey: () => crossKey,
    list: async scope => {
      if (scope?.allProjects) { scanning.resolve(); return earlier.promise }
      return [row('old-channel', 'codex')]
    },
  })
  const newerChannel = channel('codex', { snapshotKey: () => crossKey, list: async () => [row('new-channel', 'codex')] })
  const pendingOlder = olderChannel.listSessions()
  await scanning.promise
  await newerChannel.listSessions()
  earlier.resolve([row('old-channel', 'codex')])
  await pendingOlder
  check('cross-channel reload: older completion cannot overwrite the newer store snapshot', ids(readListingSnapshot(crossKey)), ['new-channel'])

  // The declared key is the one place a relative configured root could point
  // first paint at another store, so the real backends answer instead of a
  // fixture. Path case stays part of the key: Windows can host case-sensitive
  // directories, and an alias miss is safer than another store's rows.
  {
    const { codexBackend } = await import('../src/backends/codex/backend.js')
    const { claudeBackend } = await import('../src/backends/claude/backend.js')
    const { readListingSnapshot: readProviderSnapshot } = await import('../src/dsh-adapter/sessions/snapshot.js')
    const saved = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    }
    const keyOf = (backend: { catalog?: SessionCatalog }): string | undefined => backend.catalog?.snapshotKey?.()
    try {
      process.env.CODEX_HOME = join(home, '.codex')
      check('codex: an absolute CODEX_HOME yields a store-scoped key', typeof keyOf(codexBackend), 'string')
      process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
      check('claude: an absolute CLAUDE_CONFIG_DIR yields a store-scoped key', typeof keyOf(claudeBackend), 'string')
      process.env.CODEX_HOME = join('relative', 'codex')
      check('codex: a relative CODEX_HOME declines the snapshot', keyOf(codexBackend), undefined)
      delete process.env.CODEX_HOME
      process.env.CODEX_SQLITE_HOME = join('relative', 'sqlite')
      check('codex: a relative CODEX_SQLITE_HOME declines the snapshot', keyOf(codexBackend), undefined)
      delete process.env.CODEX_SQLITE_HOME
      process.env.CLAUDE_CONFIG_DIR = join('relative', 'claude')
      check('claude: a relative CLAUDE_CONFIG_DIR declines the snapshot', keyOf(claudeBackend), undefined)
      process.env.CLAUDE_CONFIG_DIR = 'C:\\Stores\\Claude'
      const exactCase = keyOf(claudeBackend)
      process.env.CLAUDE_CONFIG_DIR = 'c:\\stores\\claude'
      check('claude: the key keeps the exact path case', keyOf(claudeBackend) !== exactCase, true)
      check('dsh: a relative provider root declines the snapshot', readProviderSnapshot({ name: 'session-persistence-jsonl', config: { root: join('relative', 'root') } }), undefined)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
  console.log(`verify-backend-list-snapshot OK (${checks} checks)`)
} finally {
  for (const item of channels) item.releaseContributions()
  rmSync(home, { recursive: true, force: true })
}
