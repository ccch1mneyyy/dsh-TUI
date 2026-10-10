/**
 * Listing-snapshot flow: the first-paint cache is scoped to ONE provider
 * configuration, survives a restart, and never becomes a second truth.
 *
 * The provider's own listing is stubbed with headers — reading logs and deriving
 * titles is verify-session-index's job. Proven here: the source-key scope
 * (root, encoding, backend), the disk generation, the enumeration-failure
 * rule, partial batches, the REAL Channel forwarding (metadata → readiness →
 * ChannelActionMethods), and a fresh process reading the cache with no
 * backend call at all.
 * Run: node scripts/verify-session-list-snapshot.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

// Double isolation BEFORE any lib import: DATA_DIR resolves from the home
// directory at import time, and the compat layer scans the session roots.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-list-snapshot-home-'))
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-list-snapshot-root-'))
for (const [key, value] of Object.entries({
  HOME: home, USERPROFILE: home,
  DSH_HOME: join(home, '.dsh'), DSH_TUI_SESSION_ROOT: root,
})) process.env[key] = value

let providerFork
let owner
try {
  const { readListingSnapshot } = await import('../lib/types/dsh-adapter/sessions/snapshot.js')
  const { listSummaries } = await import('../lib/types/dsh-adapter/sessions/list.js')
  const { createChannelOwner } = await import('../lib/types/dsh-adapter/channel/owner.js')
  const { createSessionMetadataActions } = await import('../lib/types/dsh-adapter/channel/session-metadata.js')
  const { createChannelActionMethods, createChannelActionReadiness } = await import('../lib/types/dsh-adapter/channel/action-readiness.js')
  const { default: Jsonl } = await import('@deepseek-ai/dsh-session-persistence-jsonl')

  let checks = 0
  function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks += 1 }
  function ok(name, value) { assert.ok(value, name); checks += 1 }

  const SNAPSHOT_DIR = join(home, '.dsh-tui', 'session-lists')
  const snapshotFiles = () => {
    try { return readdirSync(SNAPSHOT_DIR).filter(name => name.endsWith('.json')) } catch { return [] }
  }

  // The scope key is read off the provider the host actually mounts. A guessed
  // root (env var, well-known path) cannot scope a cache to one store.
  const providerCtx = new Context()
  providerFork = providerCtx.plugin(Jsonl, { root })
  await providerFork.await()
  const provider = providerCtx.get('sessionPersistence')
  check('the real jsonl provider names itself', provider.name, 'session-persistence-jsonl')
  ok('and exposes its configured root', typeof provider.config.root === 'string' && provider.config.root.length > 0)

  const header = (id, createdAt) => ({ id, cwd: '/proj', createdAt })
  const sourceOf = (config, headers) => ({ name: provider.name, config, list: async () => headers })
  const source = (headers, config = { root: provider.config.root }) => sourceOf(config, headers)
  const diskRows = (headers = [], config) => readListingSnapshot(source(headers, config))
  const wire = rows => JSON.parse(JSON.stringify(rows))

  // ── 1. A successful listing saves; the key is value-derived, not the object ──
  const rows = await listSummaries(source([header('a', 3), header('b', 2), header('c', 1)]))
  check('the listing returns every header', rows.map(row => row.id), ['a', 'b', 'c'])
  check('the snapshot round-trips through a fresh source object', diskRows(), wire(rows))
  check('one source key means one file', snapshotFiles().length, 1)

  // ── 2. A damaged or foreign snapshot is absent, never a crash ───────────────
  const file = join(SNAPSHOT_DIR, snapshotFiles()[0])
  const savedSource = JSON.parse(readFileSync(file, 'utf8')).source
  writeFileSync(file, '{"version":1,"source":"torn",')
  check('truncated JSON reads as unknown', diskRows(), undefined)
  writeFileSync(file, JSON.stringify({ version: 1, source: savedSource, rows: [{ id: 'a' }] }))
  check('a structurally invalid row is not a listing', diskRows(), undefined)
  writeFileSync(file, JSON.stringify({ version: 1, source: savedSource, rows: [{ ...rows[0], title: { text: 'bad source type', source: ['fallback'] } }] }))
  check('coercible title sources still fail structural validation', diskRows(), undefined)
  writeFileSync(file, JSON.stringify({ version: 1, source: 'x', rows: [] }))
  check('a snapshot recorded for another key is ignored', diskRows(), undefined)
  await listSummaries(source([header('a', 3), header('b', 2), header('c', 1)]))
  check('a later success restores it', diskRows().length, 3)

  // ── 3. The scope is the provider configuration ──────────────────────────────
  check('another root never reads this store', diskRows([], { root: join(root, 'other') }), undefined)
  if (process.platform === 'win32') check('case-sensitive Windows roots do not share a snapshot', diskRows([], { root: root.toUpperCase() }), undefined)
  check('another encoding never reads this store', readListingSnapshot(sourceOf({ root: provider.config.root, compression: 'none' }, [])), undefined)
  check('a relative root is refused', diskRows([], { root: 'sessions' }), undefined)
  check('an unknown backend is refused', readListingSnapshot({ name: 'session-persistence-sqlite', config: { root: provider.config.root }, list: async () => [] }), undefined)
  const filesBefore = snapshotFiles().length
  await listSummaries(sourceOf({ root: provider.config.root, compression: 'br' }, [header('br', 1)]))
  check('an unknown encoding is never written', snapshotFiles().length, filesBefore)

  // ── 4. A successful empty listing is an answer, not an absence ──────────────
  await listSummaries(source([]))
  check('an empty success clears the cached rows', diskRows(), [])

  // ── 5. A failed enumeration keeps the previous rows on disk ─────────────────
  await listSummaries(source([header('kept', 1)]))
  const kept = diskRows()
  await assert.rejects(listSummaries({ ...source([]), list: async () => { throw new Error('backend down') } }), /backend down/)
  check('a failed enumeration cannot erase the previous snapshot', diskRows(), kept)

  // ── 6. Two Context proxies sharing identity: the newest request wins ────────
  // beginListingSnapshot claims its disk generation before the first await, and
  // identity is the provider's own symbol, so both wrappers key one slot.
  const identity = Symbol('sessionPersistence')
  let releaseOlder
  const olderGate = new Promise(resolve => { releaseOlder = () => resolve([header('older', 1)]) })
  const older = { name: provider.name, config: { root: provider.config.root }, identity, list: () => olderGate }
  const newer = { name: provider.name, config: { root: provider.config.root }, identity, list: async () => [header('newer', 9)] }
  const late = listSummaries(older)
  const newest = await listSummaries(newer)
  check('the newest listing answers on its own', newest.map(row => row.id), ['newer'])
  releaseOlder()
  check('the late listing still returns its own rows', (await late).map(row => row.id), ['older'])
  check('but cannot overwrite the newer snapshot', diskRows().map(row => row.id), ['newer'])

  // ── 7. Partial batches stream to the screen and never to disk ───────────────
  const coldConfig = { root: join(root, 'cold') }
  const coldHeaders = Array.from({ length: 40 }, (_, index) => header(`cold-${index}`, index + 1))
  let partial
  let finished = false
  const cold = listSummaries(source(coldHeaders, coldConfig), undefined, undefined, batch => {
    partial = batch
    ok('partial rows arrive before the listing resolves', finished === false)
    check('a partial batch is never a snapshot', diskRows([], coldConfig), undefined)
  })
  cold.then(() => { finished = true })
  const coldRows = await cold
  check('the batch stops at the yield boundary', partial.length, 32)
  check('the finished listing carries every row', coldRows.length, 40)
  check('and only then reaches disk', diskRows([], coldConfig).length, 40)

  // The current workspace can have fewer than one batch, and older sessions
  // than every other project. Publish it before locating any foreign log.
  const priorityConfig = { root: join(root, 'workspace-priority') }
  const localHeaders = [header('workspace-old', 1), { ...header('workspace-new', 2), cwd: '/proj/' }]
  const foreignHeaders = Array.from({ length: 40 }, (_, index) => ({ ...header(`foreign-${index}`, 100 + index), cwd: '/proj/other' }))
  foreignHeaders[0] = { ...foreignHeaders[0], origin: 'subagent', parentSession: 'workspace-old' }
  const located = []
  const batches = []
  let foreignSawLocal = false
  const prioritized = await listSummaries({
    ...source([...foreignHeaders, ...localHeaders], priorityConfig),
    locate(meta) {
      located.push(meta.id)
      if (meta.id.startsWith('foreign-') && located.length === 3) foreignSawLocal = batches[0]?.length === 2
      return undefined
    },
  }, undefined, undefined, rows => {
    batches.push(rows)
    check('workspace partials never become a complete disk snapshot', diskRows([], priorityConfig), undefined)
  }, '/proj')
  check('current workspace logs resolve ahead of newer foreign logs', located.slice(0, 2), ['workspace-new', 'workspace-old'])
  check('a workspace smaller than 32 paints before any foreign log is resolved', foreignSawLocal, true)
  check('the first batch contains only the normalized current workspace', batches[0].map(row => row.id), ['workspace-new', 'workspace-old'])
  check('workspace-first rows still count children from every project', batches[0].find(row => row.id === 'workspace-old').childCount, 1)
  check('the complete result still includes every workspace in activity order', prioritized.length, 42)
  check('final ordering is not changed by workspace processing priority', prioritized[0].id, 'foreign-39')
  check('only the complete multi-workspace listing becomes the snapshot', diskRows([], priorityConfig).length, 42)

  // ── 8. The real Channel forwards the cache without a backend call ───────────
  let backendCalls = 0
  const live = { name: provider.name, config: { root: provider.config.root }, list: async () => { backendCalls += 1; return [header('live', 5)] } }
  await listSummaries(live)
  const callsAfterSave = backendCalls
  const agent = { id: 'live' }
  owner = createChannelOwner()
  const pushed = []
  let currentProvider = live
  const metadata = createSessionMetadataActions({ get: name => name === 'sessionPersistence' ? currentProvider : undefined }, {
    owner,
    binding: { capture: () => ({ agent, generation: 1 }), isCurrent: () => owner.current() },
    provider: () => 'deepseek', model: () => 'model', cwd: () => '/proj', emit: () => undefined,
    sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
    forgetAgentView: () => undefined, setPersistedSessions: rows => pushed.push(rows),
    skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: agent, cwd: '/proj' }),
  })
  const readiness = createChannelActionReadiness()
  readiness.install({ cachedSessions: metadata.cachedSessions, listSessions: metadata.listSessions })
  const actions = createChannelActionMethods(() => readiness.getReadyActions())
  check('cachedSessions() forwards through readiness to the snapshot', actions.cachedSessions().map(row => row.id), ['live'])
  check('with no backend call at all', backendCalls, callsAfterSave)
  check('and listSessions() still runs the real listing', (await actions.listSessions()).map(row => row.id), ['live'])
  check('the listing was pushed to the channel state', pushed.at(-1).map(row => row.id), ['live'])
  check('having called the backend exactly once more', backendCalls, callsAfterSave + 1)
  const liveList = live.list
  live.list = async () => coldHeaders
  let forwardedPartial
  await actions.listSessions(undefined, batch => { forwardedPartial = batch })
  check('partial rows traverse the real readiness delegate', forwardedPartial.length, 32)
  live.list = async () => [...foreignHeaders, ...localHeaders]
  let firstWorkspace
  await actions.listSessions(undefined, batch => { firstWorkspace ??= batch })
  check('the real metadata action forwards its current workspace to the listing', firstWorkspace.map(row => row.id), ['workspace-new', 'workspace-old'])
  live.list = liveList
  await actions.listSessions()

  currentProvider = { ...live, identity: Symbol('relative'), config: { root: 'relative' } }
  await actions.listSessions()
  check('unscopable sources retain same-instance memory rows', actions.cachedSessions().map(row => row.id), ['live'])
  currentProvider = { ...currentProvider, identity: Symbol('replacement') }
  check('a replacement service never inherits memory rows', actions.cachedSessions(), undefined)
  currentProvider = live

  const controller = new AbortController()
  await assert.rejects(() => listSummaries({
    ...source([]), identity: Symbol('cancellable'),
    list: async options => {
      check('handle-based providers receive options.signal', options.signal, controller.signal)
      controller.abort()
      return []
    },
  }, controller.signal), { name: 'AbortError' })
  check('cancellation preserves the last complete snapshot', diskRows().map(row => row.id), ['live'])

  // ── 9. A fresh process reads the same cache with no backend call ────────────
  // The child's stubbed listing never resolves: were the cache to need enumeration, the
  // process would hang and the spawn timeout would fail the check.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { readListingSnapshot } = await import(process.env.SNAPSHOT_MODULE)
  let calls = 0
  const source = { name: 'session-persistence-jsonl', config: { root: process.env.SNAPSHOT_ROOT }, list: () => { calls += 1; return new Promise(() => {}) } }
  const rows = readListingSnapshot(source)
  console.log(JSON.stringify({ ids: rows === undefined ? null : rows.map(row => row.id), calls }))
  `], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      SNAPSHOT_MODULE: new URL('../lib/types/dsh-adapter/sessions/snapshot.js', import.meta.url).href,
      SNAPSHOT_ROOT: provider.config.root,
    },
  })
  assert.equal(child.status, 0, child.stderr || String(child.error))
  const restarted = JSON.parse(child.stdout.trim().split('\n').at(-1))
  check('a restarted process reads the saved rows', restarted.ids, ['live'])
  check('without enumerating the backend', restarted.calls, 0)

  console.log(`verify-session-list-snapshot: ${checks} checks passed`)
} finally {
  owner?.dispose()
  await providerFork?.dispose()
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
