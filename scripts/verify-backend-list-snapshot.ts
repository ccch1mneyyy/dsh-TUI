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
import type { ChannelStartup } from '../src/dsh-adapter/channel/state.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-backend-list-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
const [{ createChannel }, { beginListingSnapshot, readListingSnapshot }, { createStartingSession }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/sessions/listSnapshot.js'),
  import('../src/agent/starting-session.js'),
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
function fakeSession(backendId: string, sessionId = 'current', cwd = home): AgentSession {
  return {
    ref: { backendId, sessionId }, cwd, status: 'idle', capabilities: { native: {} },
    history: async () => [], subscribe: () => () => {}, submit: async () => ({ accepted: true }),
    cancel: async () => ({ stillQueued: [] }), dispose: async () => {},
  }
}
function channel(backendId: string, catalog: SessionCatalog, startup?: Promise<ChannelStartup>) {
  const session = startup === undefined ? fakeSession(backendId) : createStartingSession(backendId, home)
  const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } } as never
  const result = createChannel(ctx, session, { cwd: home, model: 'fixture', provider: '', sessionCatalog: catalog, ...(startup === undefined ? {} : { startup }) })
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

  for (const backendId of ['claude', 'codex']) {
    const local = row('current-workspace', backendId)
    const foreign = { ...row('newer-elsewhere', backendId), cwd: join(home, 'elsewhere'), updatedAt: 999 }
    const global = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    const scopes: string[] = []
    const scoped = channel(backendId, {
      list: async (scope, onPartial) => {
        scopes.push(scope?.allProjects ? 'all' : scope?.cwd ?? '')
        if (scope?.allProjects) { onPartial?.([foreign]); began.resolve(); return global.promise }
        onPartial?.([local])
        return [local]
      },
    })
    const partials: string[][] = []
    const listing = scoped.listSessions(undefined, rows => { partials.push(ids(rows)!) })
    await began.promise
    check(backendId + ': the current workspace is queried before all projects', scopes, [home, 'all'])
    check(backendId + ': the first rows are local even when another workspace is newer', partials[0], ['current-workspace'])
    check(backendId + ': global partial pages keep the already-loaded workspace', partials.at(-1), ['newer-elsewhere', 'current-workspace'])
    check(backendId + ': workspace progress is not a complete snapshot', scoped.cachedSessions(), undefined)
    global.resolve([foreign, local])
    check(backendId + ': completion includes both workspaces', ids(await listing), ['newer-elsewhere', 'current-workspace'])
  }

  for (const backendId of ['claude', 'codex']) {
    const key = JSON.stringify([backendId, home, 'preload'])
    beginListingSnapshot(key)([row('cached-old', backendId)])
    const local = { ...row('native-new', backendId), updatedAt: 999 }
    const foreign = { ...row('foreign', backendId), cwd: join(home, 'elsewhere') }
    const workspace = gate<readonly SessionSummary[]>()
    const global = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    const allBegan = gate<void>()
    const scopes: string[] = []
    const preloaded = channel(backendId, {
      snapshotKey: () => key,
      list: async (scope, onPartial) => {
        scopes.push(scope?.allProjects ? 'all' : scope?.cwd ?? '')
        if (scope?.allProjects) { allBegan.resolve(); return global.promise }
        onPartial?.([local])
        began.resolve()
        return workspace.promise
      },
    })
    await began.promise
    check(backendId + ': startup preloads cwd without opening the browser', scopes, [home])
    const batches: string[][] = []
    const browser = preloaded.listSessions(undefined, rows => { batches.push(ids(rows)!) })
    const reopened = preloaded.listSessions()
    check(backendId + ': a browser opened during preload receives earlier progress immediately', batches, [['native-new']])
    check(backendId + ': opening and reopening the browser reuse the pending cwd read', scopes, [home])
    check(backendId + ': partial preload preserves the complete disk snapshot', ids(readListingSnapshot(key)), ['cached-old'])
    workspace.resolve([local])
    await allBegan.promise
    check(backendId + ': preload fills other workspaces after cwd', scopes, [home, 'all'])
    global.resolve([local, foreign])
    check(backendId + ': browser and preload share the final result', ids(await browser), ['native-new', 'foreign'])
    check(backendId + ': a concurrent reopen receives the same final result', ids(await reopened), ['native-new', 'foreign'])
    check(backendId + ': successful preload refreshes disk and memory caches', [ids(readListingSnapshot(key)), ids(preloaded.cachedSessions())], [['native-new', 'foreign'], ['native-new', 'foreign']])
  }

  {
    const key = JSON.stringify(['codex', home, 'preload-failure'])
    beginListingSnapshot(key)([row('kept', 'codex')])
    const failed = gate<void>()
    let attempts = 0
    const retry = channel('codex', {
      snapshotKey: () => key,
      list: async () => {
        if (++attempts === 1) { failed.resolve(); throw new Error('offline') }
        return [row('retried', 'codex')]
      },
    })
    await failed.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    check('failed preload preserves the previous disk snapshot', ids(readListingSnapshot(key)), ['kept'])
    check('opening the browser retries a failed preload', ids(await retry.listSessions()), ['retried'])
    check('failed preload does not strand a pending request', attempts, 3)
  }

  {
    const key = JSON.stringify(['codex', home, 'disposed-preload'])
    const local = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    let reads = 0
    const disposed = channel('codex', {
      snapshotKey: () => key,
      list: async () => { reads++; began.resolve(); return local.promise },
    })
    await began.promise
    disposed.releaseContributions()
    local.resolve([row('late', 'codex')])
    await new Promise<void>(resolve => setImmediate(resolve))
    check('disposing during preload prevents the global read and disk write', [reads, readListingSnapshot(key)], [1, undefined])
  }

  for (const backendId of ['claude', 'codex']) {
    const opened = gate<ChannelStartup>()
    const local = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    const scopes: string[] = []
    const key = JSON.stringify([backendId, home, 'startup-same-cwd'])
    const summary = row('loaded-while-starting', backendId)
    const starting = channel(backendId, {
      snapshotKey: () => key,
      list: async (scope, onPartial) => {
        scopes.push(scope?.allProjects ? 'all' : scope?.cwd ?? '')
        if (scope?.allProjects) return [summary]
        onPartial?.([summary])
        began.resolve()
        return local.promise
      },
    }, opened.promise)
    await began.promise
    check(backendId + ': catalog preload begins while the backend is still opening', starting.ready, false)
    const batches: string[][] = []
    const browser = starting.listSessions(undefined, rows => { batches.push(ids(rows)!) })
    opened.resolve({ session: fakeSession(backendId, 'opened'), history: [] })
    await new Promise<void>(resolve => setImmediate(resolve))
    check(backendId + ': startup adopts the real session without duplicating cwd reads', [starting.ready, scopes], [true, [home]])
    local.resolve([summary])
    check(backendId + ': a browser opened before adoption receives the complete pending result', ids(await browser), [summary.id])
    check(backendId + ': startup adoption keeps preload progress and its disk write valid', [batches[0], scopes, ids(readListingSnapshot(key))], [[summary.id], [home, 'all'], [summary.id]])
  }

  for (const backendId of ['claude', 'codex']) {
    const opened = gate<ChannelStartup>()
    const oldLocal = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    const refreshed = gate<void>()
    const cwd = join(home, 'recorded')
    const key = JSON.stringify([backendId, home, 'startup-new-cwd'])
    const summary = { ...row('recorded-workspace', backendId), cwd }
    const scopes: string[] = []
    const starting = channel(backendId, {
      snapshotKey: () => key,
      list: async scope => {
        scopes.push(scope?.allProjects ? 'all' : scope?.cwd ?? '')
        if (scope?.cwd === home) { began.resolve(); return oldLocal.promise }
        if (scope?.allProjects) refreshed.resolve()
        return [summary]
      },
    }, opened.promise)
    await began.promise
    const obsolete = starting.listSessions()
    opened.resolve({ session: fakeSession(backendId, 'resumed', cwd), history: [] })
    await refreshed.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    check(backendId + ': a recorded cwd discovered at startup gets its own preload', [starting.cwd, scopes], [cwd, [home, cwd, 'all']])
    oldLocal.resolve([row('old-launch-workspace', backendId)])
    check(backendId + ': the previous workspace read is revoked after adoption', await obsolete, [])
    check(backendId + ': a late launch-workspace page cannot replace the recorded-workspace cache', [ids(starting.cachedSessions()), ids(readListingSnapshot(key))], [[summary.id], [summary.id]])
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

  // Overlapping reads share work; a mutation invalidates that work so a late
  // page cannot overwrite the refreshed title or revive a deleted row.
  const slow = gate<readonly SessionSummary[]>()
  const started = gate<void>()
  let count = 0
  const racing: SessionCatalog = {
    snapshotKey: () => JSON.stringify(['claude', home, 'racing']),
    list: async scope => {
      if (!scope?.allProjects && ++count === 1) { started.resolve(); return slow.promise }
      return [row('newest', 'claude')]
    },
    rename: async () => {},
  }
  const raced = channel('claude', racing)
  const oldListing = raced.listSessions()
  await started.promise
  const joinedListing = raced.listSessions()
  check('overlapping reloads share the pending catalog read', count, 1)
  await raced.renameSessionTo('late', 'Renamed')
  await raced.listSessions()
  slow.resolve([row('late', 'claude')])
  check('overlapping reload: an obsolete read cannot publish', await oldListing, [])
  check('overlapping reload: subscribers to the obsolete read are fenced too', await joinedListing, [])
  check('overlapping reload: the latest memory snapshot survives', ids(raced.cachedSessions()), ['newest'])
  check('overlapping reload: the latest disk snapshot survives', ids(readListingSnapshot(racing.snapshotKey!()!)), ['newest'])

  {
    let sourceKey = JSON.stringify(['codex', home, 'old-store'])
    const oldKey = sourceKey
    const slowStore = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    const replaced = channel('codex', {
      snapshotKey: () => sourceKey,
      list: async () => {
        if (sourceKey === oldKey) { began.resolve(); return slowStore.promise }
        return [row('new-store', 'codex')]
      },
    })
    const oldStore = replaced.listSessions()
    await began.promise
    sourceKey = JSON.stringify(['codex', home, 'replacement-store'])
    check('changing stores starts a separate read instead of joining the old store', ids(await replaced.listSessions()), ['new-store'])
    slowStore.resolve([row('old-store', 'codex')])
    check('an old store completion is fenced after replacement', await oldStore, [])
    check('an old store cannot overwrite the replacement cache', ids(readListingSnapshot(sourceKey)), ['new-store'])
    check('a revoked store read cannot write its snapshot', readListingSnapshot(oldKey), undefined)
  }

  {
    const key = JSON.stringify(['codex', home, 'delete-during-preload'])
    const victim = row('deleted', 'codex')
    beginListingSnapshot(key)([victim])
    const slowDelete = gate<readonly SessionSummary[]>()
    const began = gate<void>()
    const deleted = channel('codex', {
      snapshotKey: () => key,
      list: async () => { began.resolve(); return slowDelete.promise },
      delete: async () => {},
    })
    const obsolete = deleted.listSessions()
    await began.promise
    await deleted.deleteSession(victim.id)
    slowDelete.resolve([victim])
    check('deleting during a pending read revokes its completion', await obsolete, [])
    check('a late page cannot revive a deleted cached session', [ids(deleted.cachedSessions()), ids(readListingSnapshot(key))], [[], []])
  }

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
      process.env.CLAUDE_CONFIG_DIR = join(home, 'Stores', 'Claude')
      const exactCase = keyOf(claudeBackend)
      process.env.CLAUDE_CONFIG_DIR = join(home, 'stores', 'claude')
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
