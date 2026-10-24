/**
 * ctx.tuiSessionData regression (plugin UI kit design §3): the session-on-
 * screen projection watch and the host session list, on a real Cordis
 * composition with a fake projection registry and fake session services.
 *
 * Projection watch:
 *  - root-context calls and foreign identities are refused (warn + undefined);
 *  - no registry → `read()` stays undefined, also after a bind;
 *  - the registry's arrival reads the bound session's baseline; a watch made
 *    after the bind seeds at once; `/new`/`/resume`-style rebinding clears
 *    the old value first, then reads the new session's baseline;
 *  - a background session's push is ignored; the value reference is stable
 *    while unchanged (other keys, reseeds) and `subscribe`/`read` work
 *    unbound (`useSyncExternalStore`);
 *  - one change-feed listener per registry, whatever the key count;
 *  - `plugin-manager/changed` reads a unit that came later; the registry's
 *    departure clears the value;
 *  - shared keys are ref-counted; a fiber unload releases its watches (and the
 *    shared store with the last one); ledger bind/release records;
 *  - budgets: 8 watches per activation, 64 keys process-wide, invalid keys —
 *    refused with a `failed` ledger record for the budgets;
 *  - a throwing listener does not starve the others;
 *  - the channel's DSH bind calls `seedProjections` (the binding path the
 *    team and occupancy stores use).
 *
 * Session list:
 *  - rows from `sessionQuery.listSessions()`: attached sessions always, cold
 *    ones with a workspace; title from the `title` projection, else the cwd
 *    basename; running from `agents`; requested projections from the live
 *    registry's cached cut / the persisted projection cache, absent
 *    otherwise; newest activity first;
 *  - lazy first read on subscribe, `refresh()` re-reads (bursts coalesce
 *    into one trailing read per interval, reads never overlap), fiber unload
 *    releases, 2 per activation;
 *  - the `sessionPersistence` fallback merges unsaved live sessions; no host
 *    services → []; a failing projection read costs that row its values only.
 *
 * Run: node --import tsx/esm scripts/verify-session-data.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { TuiEffectLedgerRuntime } from '../src/dsh-adapter/effect-ledger.js'
import {
  createSessionListWatch,
  getHostSessionProjectionHub,
  listSessionRows,
  MAX_PROJECTION_KEYS_TOTAL,
  MAX_PROJECTION_WATCHES_PER_ACTIVATION,
  SESSION_LIST_MIN_INTERVAL_MS,
  TuiSessionDataRuntime,
  type TuiProjectionWatch,
  type TuiSessionListRow,
  type TuiSessionListWatch,
} from '../src/dsh-adapter/session-data.js'
import { createSessionProjectionHub, sessionProjectionHubFor } from '../src/dsh-adapter/session-projection-hub.js'
import { createChannel } from '../src/dsh-adapter/channel.js'

let passed = 0
function pass(name: string): void {
  passed += 1
  console.log('PASS ' + name)
}

const flush = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

/** Resolve once `done()` holds or `ms` have passed; callers assert after. */
async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  const deadline = performance.now() + ms
  while (!done() && performance.now() < deadline) await new Promise(resolve => { setTimeout(resolve, 5) })
}

// ── fakes ───────────────────────────────────────────────────────────────────

type FeedListener = (session: { readonly id: unknown }, key: string, value: unknown, seq: number) => void

/** A projection registry with the slice the TUI reads, plus test controls. */
function createFakeRegistry() {
  const values = new Map<string, Map<string, unknown>>()
  const feed = new Set<FeedListener>()
  let seq = 0
  let snapshots = 0
  const idOf = (session: unknown): string => String((session as { id: unknown }).id)
  const pick = (session: unknown, keys?: readonly string[]): Record<string, unknown> => {
    const own = values.get(idOf(session)) ?? new Map<string, unknown>()
    const out: Record<string, unknown> = {}
    for (const [key, value] of own) if (keys === undefined || keys.includes(key)) out[key] = value
    return out
  }
  return {
    registry: {
      onChanged(listener: FeedListener) {
        feed.add(listener)
        return () => { feed.delete(listener) }
      },
      snapshot(session: unknown, keys?: readonly string[]) {
        snapshots += 1
        return { values: pick(session, keys) }
      },
      cachedSnapshot(session: unknown, keys?: readonly string[]) {
        const block = pick(session, keys)
        return Object.keys(block).length === 0 ? undefined : { asOfSeq: seq, values: block }
      },
    },
    /** Change a value without the feed (a unit that registered later). */
    set(sessionId: string, key: string, value: unknown): void {
      let own = values.get(sessionId)
      if (own === undefined) values.set(sessionId, own = new Map())
      if (value === undefined) own.delete(key)
      else own.set(key, value)
    },
    publish(sessionId: string, key: string, value: unknown): void {
      this.set(sessionId, key, value)
      seq += 1
      for (const listener of [...feed]) listener({ id: sessionId }, key, value, seq)
    },
    get feedSize() { return feed.size },
    get snapshots() { return snapshots },
  }
}

function session(id: string, header: Record<string, unknown> = {}): { id: string; header: Record<string, unknown> } {
  return { id, header: { id, cwd: `/work/${id}`, createdAt: 1_000, ...header } }
}

interface Activation {
  readonly ctx: Context
  dispose(): Promise<void>
}

async function activation(root: Context, name: string): Promise<Activation> {
  let captured: Context | undefined
  const fiber = root.plugin({ name, apply(ctx: Context) { captured = ctx } }) as unknown as { await(): Promise<unknown>; dispose(): unknown }
  await fiber.await()
  if (captured === undefined) throw new Error(`activation ${name} did not apply`)
  return { ctx: captured, dispose: async () => { await Promise.resolve(fiber.dispose()) } }
}

async function provider(root: Context, name: string, service: string, value: unknown): Promise<{ dispose(): Promise<void> }> {
  const fiber = root.plugin({ name, apply(ctx: Context) { ctx.provide(service, value) } }) as unknown as { await(): Promise<unknown>; dispose(): unknown }
  await fiber.await()
  return { dispose: async () => { await Promise.resolve(fiber.dispose()) } }
}

const sessionData = (ctx: Context): TuiSessionDataRuntime => ctx.get('tuiSessionData') as TuiSessionDataRuntime

const ledgerDir = mkdtempSync(join(tmpdir(), 'dsh-tui-session-data-'))
const ledgerFile = join(ledgerDir, 'ledger.jsonl')
type LedgerLine = { operation?: string; resource?: { kind?: string; id?: string }; result?: string; errorCode?: string }
function ledgerRecords(): LedgerLine[] {
  try {
    return readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerLine)
  } catch {
    return []
  }
}

try {
  // ── projection watch ─────────────────────────────────────────────────────
  const root = new Context()
  const warnings: string[] = []
  ;(root.logger as unknown as { warn: (...args: unknown[]) => void }).warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  await root.plugin(TuiEffectLedgerRuntime, { file: ledgerFile })
  await root.plugin(TuiSessionDataRuntime)
  const hub = getHostSessionProjectionHub(sessionData(root))
  assert.ok(hub !== undefined, 'the service exposes its hub to the host')
  assert.equal(sessionProjectionHubFor(root), hub, 'the hub is the composition root\'s')

  {
    let refused: unknown = 'not called'
    try {
      refused = sessionData(root).watchProjection('contextTimeline')
    } catch (error) {
      refused = error
    }
    assert.equal(refused, undefined, 'a root-context call is refused with undefined')
    assert.ok(warnings.some(line => line.includes('requires a live non-root plugin activation')))
  }
  pass('root-context calls are refused (warn + undefined)')

  const a = await activation(root, 'plugin-a')
  const b = await activation(root, 'plugin-b')
  assert.equal(sessionData(a.ctx).watchProjection('contextTimeline', b.ctx), undefined, 'a foreign identity is refused')
  pass('a foreign activation identity is refused')

  // No registry yet: nothing to read, before or after a bind.
  const watch = sessionData(a.ctx).watchProjection('contextTimeline', a.ctx)
  assert.ok(watch !== undefined)
  assert.equal(watch.key, 'contextTimeline')
  assert.equal(watch.sessionId, undefined, 'no session bound yet')
  assert.equal(watch.read(), undefined)
  const sessionA = session('s-a')
  const sessionB = session('s-b')
  const seen: unknown[] = []
  // Unbound methods: the useSyncExternalStore call shape.
  const { subscribe, read } = watch
  const unsubscribe = subscribe(() => { seen.push(read()) })
  hub.seed(sessionA)
  assert.equal(watch.sessionId, 's-a', 'the bind names the session on screen')
  assert.equal(read(), undefined, 'no registry → undefined after a bind')
  assert.ok(ledgerRecords().some(record => record.operation === 'bind' && record.result === 'applied' && record.resource?.id === 'projection:contextTimeline'), 'ledger bind record')
  pass('no projection registry → read() is undefined (also after a bind)')

  // The registry arrives late and seeds the bound session's baseline.
  const fake = createFakeRegistry()
  const timelineA = { events: [1, 2, 3] }
  fake.set('s-a', 'contextTimeline', timelineA)
  fake.set('s-b', 'contextTimeline', { events: [9] })
  const registryRow = await provider(root, 'fake-projections', 'sessionProjections', fake.registry)
  await flush()
  assert.equal(read(), timelineA, 'the registry\'s arrival reads the bound session\'s baseline')
  assert.equal(fake.feedSize, 1, 'one change-feed listener')
  pass('a registry arriving after the bind reads the baseline')

  // Identity stability: a reseed and another key's push keep the reference.
  const before = seen.length
  hub.reseed()
  fake.publish('s-a', 'otherKey', { x: 1 })
  assert.equal(read(), timelineA, 'same reference')
  assert.equal(seen.length, before, 'no notification without a change')
  // Background session: dropped.
  fake.publish('s-b', 'contextTimeline', { events: [10] })
  assert.equal(read(), timelineA, 'a background session\'s push does not overwrite the screen')
  assert.equal(seen.length, before, 'and does not notify')
  // The bound session's push lands.
  const timelineA2 = { events: [1, 2, 3, 4] }
  fake.publish('s-a', 'contextTimeline', timelineA2)
  assert.equal(read(), timelineA2)
  assert.equal(seen.at(-1), timelineA2)
  pass('value reference stable while unchanged; background pushes ignored; own pushes land')

  // A watch made after the bind seeds at once.
  const late = sessionData(b.ctx).watchProjection('contextHeaders')
  fake.set('s-a', 'contextHeaders', ['h1'])
  assert.ok(late !== undefined)
  assert.equal(late.sessionId, 's-a')
  // The key's store was created before the value existed: reseed reads it
  // the way a profile write does.
  ;(root as unknown as { emit(name: string): void }).emit('plugin-manager/changed')
  assert.deepEqual(late.read(), ['h1'], 'plugin-manager/changed reads a unit that came later')
  const absent = sessionData(a.ctx).watchProjection('absentKey')
  assert.ok(absent !== undefined)
  assert.equal(absent.read(), undefined, 'an unregistered key reads undefined')
  fake.set('s-a', 'seededKey', 'baseline')
  const seeded = sessionData(a.ctx).watchProjection('seededKey')
  assert.equal(seeded?.read(), 'baseline', 'a store created after the bind seeds from the last bound session')
  assert.equal(fake.feedSize, 1, 'still one change-feed listener for every key')
  pass('watches made after the bind seed immediately; one feed listener for all keys')

  // /new or /resume: the old value clears first, then the new baseline.
  seen.length = 0
  hub.seed(sessionB)
  assert.equal(watch.sessionId, 's-b')
  assert.equal(seen[0], undefined, 'the old value clears first')
  assert.deepEqual(seen.at(-1), { events: [10] }, 'then the new session\'s baseline')
  assert.deepEqual(read(), { events: [10] })
  fake.publish('s-a', 'contextTimeline', { events: ['stale'] })
  assert.deepEqual(read(), { events: [10] }, 'the previous session is now a background session')
  // A session without a value: undefined, with the id change still notified.
  const sessionC = session('s-c')
  seen.length = 0
  hub.seed(sessionC)
  assert.equal(read(), undefined)
  assert.equal(watch.sessionId, 's-c')
  assert.ok(seen.length >= 1, 'a rebind notifies')
  hub.seed(sessionA)
  pass('rebinding follows the new session and clears the old value first')

  // Listener isolation.
  let healthy = 0
  const offBad = watch.subscribe(() => { throw new Error('boom') })
  const offGood = watch.subscribe(() => { healthy += 1 })
  fake.publish('s-a', 'contextTimeline', { events: ['isolation'] })
  assert.equal(healthy, 1, 'the healthy listener still runs')
  assert.ok(warnings.some(line => line.includes('listener for "contextTimeline" failed')), 'the throwing listener is reported')
  offBad()
  offGood()
  pass('a throwing listener does not starve the others')

  // Shared keys are ref-counted.
  const shared = sessionData(b.ctx).watchProjection('contextTimeline')
  assert.ok(shared !== undefined)
  assert.equal(shared.read(), watch.read(), 'two watchers of one key read the same value')
  const keysBefore = hub.size
  unsubscribe()
  await a.dispose()
  assert.equal(watch.read(), undefined, 'a released watch reads undefined')
  assert.equal(watch.sessionId, undefined)
  assert.equal(typeof watch.subscribe(() => {}), 'function', 'subscribe after release is a no-op')
  assert.ok(hub.has('contextTimeline'), 'the other watcher keeps the shared store')
  assert.ok(!hub.has('absentKey') && !hub.has('seededKey'), 'keys only the unloaded activation held are dropped')
  assert.ok(hub.size < keysBefore)
  assert.deepEqual(shared.read(), { events: ['isolation'] }, 'the remaining watcher still reads')
  assert.ok(ledgerRecords().some(record => record.operation === 'release' && record.resource?.id === 'projection:contextTimeline'), 'ledger release record')
  await b.dispose()
  assert.equal(hub.size, 0, 'the last watcher leaving drops every store')
  pass('shared keys are ref-counted; a fiber unload releases its watches and the last one the store')

  // Budgets and key validation.
  {
    const c = await activation(root, 'plugin-c')
    const own: (TuiProjectionWatch | undefined)[] = []
    for (let index = 0; index < MAX_PROJECTION_WATCHES_PER_ACTIVATION; index += 1) own.push(sessionData(c.ctx).watchProjection(`k${index}`))
    assert.ok(own.every(item => item !== undefined), '8 watches admitted')
    assert.equal(sessionData(c.ctx).watchProjection('k-extra'), undefined, 'the 9th is refused')
    assert.ok(ledgerRecords().some(record => record.result === 'failed' && record.errorCode === 'SESSION_DATA_BUDGET_EXCEEDED' && record.resource?.id === 'projection:k-extra'))
    for (const bad of ['', 'x'.repeat(129), 'bad\u001bkey', 42, null]) {
      assert.equal(sessionData(c.ctx).watchProjection(bad as never), undefined, `invalid key ${JSON.stringify(bad)} refused`)
    }
    await c.dispose()
    assert.equal(hub.size, 0)
    // 64 distinct keys process-wide.
    const many: Activation[] = []
    for (let index = 0; index < MAX_PROJECTION_KEYS_TOTAL / MAX_PROJECTION_WATCHES_PER_ACTIVATION; index += 1) {
      const holder = await activation(root, `holder-${index}`)
      many.push(holder)
      for (let slot = 0; slot < MAX_PROJECTION_WATCHES_PER_ACTIVATION; slot += 1) {
        assert.ok(sessionData(holder.ctx).watchProjection(`g${index}-${slot}`) !== undefined)
      }
    }
    assert.equal(hub.size, MAX_PROJECTION_KEYS_TOTAL)
    const extra = await activation(root, 'holder-extra')
    assert.equal(sessionData(extra.ctx).watchProjection('g-new'), undefined, 'a 65th distinct key is refused')
    assert.ok(ledgerRecords().some(record => record.result === 'failed' && record.resource?.id === 'projection:g-new'))
    assert.ok(sessionData(extra.ctx).watchProjection('g0-0') !== undefined, 'an already-watched key is still shared')
    // The budget spans composition roots: a second root has its own hub but
    // no second allowance of keys.
    const otherRoot = new Context()
    await otherRoot.plugin(TuiSessionDataRuntime)
    const elsewhere = await activation(otherRoot, 'holder-elsewhere')
    assert.equal(sessionData(elsewhere.ctx).watchProjection('g-other-root'), undefined, 'a 65th distinct key in another root is refused')
    assert.ok(sessionData(elsewhere.ctx).watchProjection('g1-0') !== undefined, 'a key watched in another root is still admitted')
    for (const holder of [...many, extra]) await holder.dispose()
    assert.equal(hub.size, 0)
    assert.ok(sessionData(elsewhere.ctx).watchProjection('g-other-root') !== undefined, 'released keys free the budget for every root')
    await elsewhere.dispose()
  }
  pass('budgets: 8 watches per activation, 64 keys process-wide (across roots), invalid keys refused')

  // The registry leaving clears the value.
  {
    const d = await activation(root, 'plugin-d')
    const leaving = sessionData(d.ctx).watchProjection('contextTimeline')
    assert.deepEqual(leaving?.read(), { events: ['isolation'] })
    let notified = 0
    leaving?.subscribe(() => { notified += 1 })
    await registryRow.dispose()
    await flush()
    assert.equal(leaving?.read(), undefined, 'the registry\'s departure clears the value')
    assert.ok(notified >= 1, 'and notifies')
    assert.equal(fake.feedSize, 0, 'the feed listener is released')
    await d.dispose()
  }
  pass('the registry leaving clears the value and releases the feed')

  // The channel's DSH bind seeds the hub (the team/occupancy binding path).
  {
    const bindHub = createSessionProjectionHub()
    const bindFake = createFakeRegistry()
    bindFake.set('s1', 'contextTimeline', 'from-bind')
    const injection: Record<string, unknown> = {
      sessionProjections: bindFake.registry,
      inject(_names: unknown, callback: (ctx: unknown) => void) { callback(injection) },
      effect() { return undefined },
      on() { return () => undefined },
      logger: { warn() {} },
    }
    bindHub.connect(injection as never)
    const lease = bindHub.acquire('contextTimeline')
    const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {} } }
    const agent = {
      id: 'a1',
      status: 'idle',
      session: { id: 's1', seq: 0, events: [], header: { cwd: '/tmp' } },
      ctx: { on: () => () => {} },
      followup() {},
      steer() {},
      cancel() {},
      inbox: { remove: () => true },
    }
    const channel = createChannel(ctx as never, agent as never, {
      model: 'model', provider: 'provider', cwd: '/tmp', activity: false,
      seedProjections: bound => bindHub.seed(bound),
    })
    assert.equal(bindHub.boundId, 's1', 'the channel bind seeded the hub')
    assert.equal(lease.read(), 'from-bind', 'with the bound session\'s baseline')
    channel.releaseContributions()
    lease.release()
  }
  pass('the channel\'s DSH bind calls seedProjections')

  // ── session list ─────────────────────────────────────────────────────────
  const listRoot = new Context()
  const listWarnings: string[] = []
  ;(listRoot.logger as unknown as { warn: (...args: unknown[]) => void }).warn = (...args: unknown[]) => { listWarnings.push(args.map(String).join(' ')) }
  const live = session('live-1', { cwd: '/work/alpha', createdAt: 5_000 })
  const liveNoCwd = session('live-2', { cwd: undefined, createdAt: 1_500 })
  const records = [
    { header: live.header, live: true, persisted: true },
    { header: liveNoCwd.header, live: true, persisted: false },
    { header: { id: 'cold-1', cwd: '/work/beta', createdAt: 3_000 }, live: false, persisted: true },
    { header: { id: 'cold-2', cwd: undefined, createdAt: 9_000 }, live: false, persisted: true },
    { header: { id: 'child-1', cwd: '/work/beta', createdAt: 4_000, parentSession: 'cold-1', origin: 'subagent' }, live: false, persisted: true },
  ]
  let listCalls = 0
  listRoot.provide('sessionQuery', { listSessions: async () => { listCalls += 1; return records.map(record => ({ ...record })) } })
  listRoot.provide('sessions', {
    get: (id: string) => (id === live.id ? live : id === liveNoCwd.id ? liveNoCwd : undefined),
    list: () => [live, liveNoCwd],
  })
  listRoot.provide('agents', { get: (id: string) => (id === live.id ? { status: 'running' } : { status: 'idle' }) })
  const listRegistry = createFakeRegistry()
  listRegistry.set('live-1', 'title', 'Live\u0007 title\nhere')
  listRegistry.set('live-1', 'contextHeaders', { live: true })
  listRegistry.set('live-1', 'sessionListMetadata', { blank: false, lastPromptAt: 8_000 })
  listRoot.provide('sessionProjections', listRegistry.registry)
  const cacheReads: string[] = []
  listRoot.provide('sessionProjectionCache', {
    cachedSnapshot(header: { id: string }, keys?: readonly string[]) {
      cacheReads.push(header.id)
      if (header.id === 'cold-1') return { asOfSeq: 3, values: { title: 'Cold title', contextHeaders: { cold: true }, unrelated: 1 } }
      // A partial snapshot: a requested key answered, no title of its own.
      if (header.id === 'child-1') return { asOfSeq: 2, values: { contextHeaders: { child: true } } }
      return undefined
    },
    cachedPredecessorTitle(header: { id: string }) {
      return header.id === 'child-1' ? { asOfSeq: 1, values: { title: 'Child (predecessor)' } } : undefined
    },
  })
  await listRoot.plugin(TuiEffectLedgerRuntime, { file: ledgerFile })
  await listRoot.plugin(TuiSessionDataRuntime)
  const e = await activation(listRoot, 'plugin-e')
  const list = sessionData(e.ctx).watchSessionList({ projections: ['contextHeaders'] })
  assert.ok(list !== undefined)
  assert.deepEqual(list.read(), [], 'nothing before the first read')
  assert.equal(listCalls, 0, 'no read before a subscriber')
  const loaded = new Promise<void>(resolve => {
    const off = list.subscribe(() => { off(); resolve() })
  })
  await loaded
  const rows = list.read()
  assert.equal(listCalls, 1, 'the first subscriber triggers one read')
  assert.deepEqual(rows.map(row => row.id), ['live-1', 'child-1', 'cold-1', 'live-2'], 'newest activity first; cold-2 has no workspace')
  const byId = new Map(rows.map(row => [row.id, row] as const))
  const liveRow = byId.get('live-1') as TuiSessionListRow
  assert.equal(liveRow.title, 'Live title here', 'durable title, sanitized')
  assert.equal(liveRow.running, true)
  assert.equal(liveRow.updatedAt, 8_000, 'the last human prompt')
  assert.equal(liveRow.cwd, '/work/alpha')
  assert.deepEqual(liveRow.projections, { contextHeaders: { live: true } }, 'requested keys only, from the live registry')
  const coldRow = byId.get('cold-1') as TuiSessionListRow
  assert.equal(coldRow.title, 'Cold title')
  assert.equal(coldRow.running, false)
  assert.deepEqual(coldRow.projections, { contextHeaders: { cold: true } }, 'from the persisted projection cache')
  const childRow = byId.get('child-1') as TuiSessionListRow
  assert.equal(childRow.parentId, 'cold-1')
  assert.equal(childRow.title, 'Child (predecessor)', 'a partial snapshot still takes the predecessor title')
  assert.deepEqual(childRow.projections, { contextHeaders: { child: true } }, 'the partial snapshot answers its keys')
  const noCwd = byId.get('live-2') as TuiSessionListRow
  assert.equal(noCwd.title, 'live-2', 'id fallback without title or workspace')
  assert.deepEqual(noCwd.projections, {}, 'a key no source answers is absent')
  assert.ok(!cacheReads.includes('live-1') && !cacheReads.includes('live-2'), 'attached sessions never read the persisted cache')
  assert.ok(Object.isFrozen(rows) && Object.isFrozen(liveRow), 'rows are frozen')
  assert.equal(list.read(), rows, 'the array reference is stable until the next read')
  pass('session list rows: sessionQuery listing, titles, running, requested projections, order')

  // refresh() re-reads.
  records.push({ header: { id: 'cold-3', cwd: '/work/gamma', createdAt: 20_000 }, live: false, persisted: true })
  const refreshed = new Promise<void>(resolve => {
    const off = list.subscribe(() => { off(); resolve() })
  })
  const refreshAskedAt = performance.now()
  list.refresh()
  await refreshed
  assert.equal(list.read()[0]?.id, 'cold-3', 'refresh picks up a new session')
  assert.equal(listCalls, 2, 'the re-subscribe and the refresh, both inside the interval, coalesce into one read')
  assert.ok(performance.now() - refreshAskedAt >= SESSION_LIST_MIN_INTERVAL_MS / 2, 'the trailing read waited for the interval')
  pass('refresh() re-reads the listing (one trailing read per burst)')

  // Coalescing, on the watch itself with a short interval and a load the
  // test resolves by hand.
  {
    const interval = 40
    let loads = 0
    const signals: AbortSignal[] = []
    const pending: Array<(rows: readonly TuiSessionListRow[]) => void> = []
    const load = (signal: AbortSignal): Promise<readonly TuiSessionListRow[]> => {
      loads += 1
      signals.push(signal)
      return new Promise(resolve => { pending.push(resolve) })
    }
    const { watch, dispose } = createSessionListWatch(load, () => {}, () => {}, interval)
    let emits = 0
    const off = watch.subscribe(() => { emits += 1 })
    assert.equal(loads, 1, 'the first subscriber reads at once')
    for (let index = 0; index < 50; index += 1) watch.refresh()
    assert.equal(loads, 1, 'refreshes during a read neither start another nor abort it')
    assert.equal(signals[0]?.aborted, false)
    const firstStarted = performance.now()
    pending.shift()!([])
    await flush()
    assert.equal(emits, 1, 'the read in flight still lands')
    await waitUntil(() => loads === 2, 1_000)
    assert.ok(performance.now() - firstStarted >= interval * 0.5, 'the trailing read keeps the interval')
    assert.equal(loads, 2, 'fifty refreshes cost one trailing read')
    pending.shift()!([])
    await flush()
    await waitUntil(() => false, interval * 3)
    assert.equal(loads, 2, 'no further read without a further refresh')

    // A listener that refreshes on every list change is bounded by the interval.
    let chatty = 0
    const offChatty = watch.subscribe(() => { chatty += 1; watch.refresh() })
    watch.refresh()
    const chattyStarted = performance.now()
    const settleAll = setInterval(() => { while (pending.length > 0) pending.shift()!([]) }, 2)
    await waitUntil(() => chatty >= 4, interval * 12)
    clearInterval(settleAll)
    const chattyLoads = loads - 2
    const allowed = Math.ceil((performance.now() - chattyStarted) / interval) + 1
    assert.ok(chatty >= 2 && chattyLoads >= 2, `the watch keeps refreshing (${chattyLoads} reads)`)
    assert.ok(chattyLoads <= allowed, `a refresh-on-change listener cannot read faster than the interval (${chattyLoads} > ${allowed})`)
    offChatty()
    off()
    while (pending.length > 0) pending.shift()!([])
    await waitUntil(() => false, interval * 2)
    // The last unsubscribe aborts the read in flight and drops the trailing one.
    const beforeLast = loads
    const offLast = watch.subscribe(() => {})
    assert.equal(loads, beforeLast + 1, 'a new first subscriber reads (the interval has passed)')
    watch.refresh()
    offLast()
    assert.equal(signals.at(-1)?.aborted, true, 'the read in flight is aborted')
    while (pending.length > 0) pending.shift()!([])
    await waitUntil(() => false, interval * 3)
    assert.equal(loads, beforeLast + 1, 'the pending trailing read is dropped with the last subscriber')
    // A host that ignores the abort: the aborted read keeps the slot until it
    // settles, so a new subscriber's read follows it instead of overlapping.
    const beforeSlow = loads
    const offSlow = watch.subscribe(() => {})
    assert.equal(loads, beforeSlow + 1)
    offSlow()
    await waitUntil(() => false, interval * 2)
    let slowEmits = 0
    const offAgain = watch.subscribe(() => { slowEmits += 1 })
    await waitUntil(() => false, interval * 2)
    assert.equal(loads, beforeSlow + 1, 'no second listing while the aborted one still runs')
    pending.shift()!([{ id: 'stale' } as never])
    await waitUntil(() => loads === beforeSlow + 2, 1_000)
    assert.equal(loads, beforeSlow + 2, 'the new subscriber\'s read starts once the aborted one settles')
    assert.equal(slowEmits, 0, 'the aborted read\'s rows are discarded')
    assert.ok(!watch.read().some(row => row.id === 'stale'))
    pending.shift()!([])
    await flush()
    assert.equal(slowEmits, 1, 'and the fresh read lands')
    offAgain()
    dispose()
    const disposedLoads = loads
    watch.refresh()
    await waitUntil(() => false, interval * 3)
    assert.equal(loads, disposedLoads, 'a disposed watch never reads again')
  }
  pass('session list refresh bursts coalesce into one trailing read per interval')

  // Budget and release.
  const second = sessionData(e.ctx).watchSessionList()
  assert.ok(second !== undefined)
  assert.equal(sessionData(e.ctx).watchSessionList(), undefined, 'a third list watch is refused')
  assert.ok(ledgerRecords().some(record => record.result === 'failed' && record.resource?.id === 'session-list'))
  assert.equal(sessionData(e.ctx).watchSessionList({ projections: [''] }), undefined, 'invalid projection keys are refused')
  assert.equal(sessionData(e.ctx).watchSessionList('nope' as never), undefined, 'invalid options are refused')
  await e.dispose()
  assert.deepEqual(list.read(), [], 'a released list reads []')
  pass('session list: 2 per activation, validation, fiber unload releases')

  // Persistence fallback, empty composition, failing projection reads.
  {
    const unsaved = session('fresh', { cwd: '/work/fresh', createdAt: 7_000 })
    const rowsFromStore = await listSessionRows({
      persistence: { listSnapshots: async () => [{ header: { id: 'stored', cwd: '/work/stored', createdAt: 2_000 }, revision: 'r1' }] },
      sessions: { get: (id: string) => (id === 'fresh' ? unsaved : undefined), list: () => [unsaved] },
    }, ['k'], new AbortController().signal)
    assert.deepEqual(rowsFromStore.map(row => row.id), ['fresh', 'stored'], 'persistence headers plus unsaved live sessions')
    assert.equal(rowsFromStore[1]?.title, 'stored', 'the workspace basename')
    assert.deepEqual(await listSessionRows({}, ['k'], new AbortController().signal), [], 'no host services → []')
    const failures: string[] = []
    const rowsWithFailure = await listSessionRows({
      query: { listSessions: async () => [{ header: { id: 'x', cwd: '/w/x', createdAt: 1 } }, { header: { id: 'y', cwd: '/w/y', createdAt: 2 } }] },
      projectionCache: {
        cachedSnapshot: (header: unknown) => {
          if ((header as { id: string }).id === 'y') throw new Error('corrupt row')
          return { values: { k: 'x-value' } }
        },
      },
    }, ['k'], new AbortController().signal, (_error, sessionId) => { failures.push(sessionId) })
    assert.deepEqual(rowsWithFailure.map(row => [row.id, row.projections]), [['y', {}], ['x', { k: 'x-value' }]], 'a failing read costs that row its values only')
    assert.deepEqual(failures, ['y'])
    // `__proto__` is a valid key: it must come back as an own data property,
    // never through the inherited setter (which would drop it and swap the
    // row's prototype for the value).
    const protoValue = { inherited: true }
    const [protoRow] = await listSessionRows({
      query: { listSessions: async () => [{ header: { id: 'p', cwd: '/w/p', createdAt: 1 } }] },
      projectionCache: { cachedSnapshot: () => ({ values: JSON.parse('{"__proto__":{"inherited":true}}') as Record<string, unknown> }) },
    }, ['__proto__'], new AbortController().signal)
    const protoProjections = protoRow!.projections as Record<string, unknown>
    assert.ok(Object.hasOwn(protoProjections, '__proto__'), 'a requested __proto__ is an own key')
    assert.deepEqual(protoProjections['__proto__'], protoValue)
    assert.equal(Object.getPrototypeOf(protoProjections), Object.prototype, 'the record keeps its prototype')
    assert.equal((protoProjections as { inherited?: unknown }).inherited, undefined, 'no field the caller never requested')
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(listSessionRows({ query: { listSessions: async () => [] } }, [], aborted.signal), /superseded/)
  }
  pass('session list: persistence fallback, empty composition, failing projection reads, abort')

  // A composition without the DSH kernel: the list is empty and nothing throws.
  {
    const bare = new Context()
    await bare.plugin(TuiSessionDataRuntime)
    const f = await activation(bare, 'plugin-f')
    const bareList = sessionData(f.ctx).watchSessionList() as TuiSessionListWatch
    const bareWatch = sessionData(f.ctx).watchProjection('contextTimeline') as TuiProjectionWatch
    const done = new Promise<void>(resolve => { bareList.subscribe(resolve) })
    await done
    assert.deepEqual(bareList.read(), [])
    assert.equal(bareWatch.read(), undefined)
    assert.equal(bareWatch.sessionId, undefined)
    await f.dispose()
  }
  pass('without the DSH kernel: list [] and watch undefined')

  assert.equal(warnings.filter(line => line.includes('projection read failed')).length, 0, 'no read failures on the happy path')
  assert.equal(listWarnings.filter(line => line.includes('session list read failed')).length, 0)
} finally {
  rmSync(ledgerDir, { recursive: true, force: true })
}

console.log(`verify-session-data OK (${passed} groups)`)
