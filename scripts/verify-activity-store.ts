/**
 * Activity store regression: the TUI's read side of the `workingActivity`
 * session projection.
 *
 * The line used to be derived by a tracker inside this app; it is now read from
 * the plugin's projection, so these cases pin everything the display relies on
 * that the host does NOT guarantee for us:
 *
 * 1. **Session keying.** A value is published per session, and the UI shows one
 *    session — an event for another session must never move this line (the
 *    behaviour a single "last event wins" tracker got wrong).
 * 2. **Change notification.** Renders subscribe; a repeated reference must not
 *    emit, and every real change must.
 * 3. **Defensive narrowing.** The feed is host-wide and its values are
 *    `unknown`; a malformed or foreign value is dropped instead of reaching a
 *    renderer half-formed.
 * 4. **Bind-time baseline.** A projection only pushes on change, so a resumed
 *    or reattached session reads the current value once when it binds.
 * 5. **Live re-reads.** The elapsed text cannot advance without one.
 * 6. **Tick policy.** Armed only while something counts time; the cleanup
 *    rides the injected fiber.
 * 7. **Single-current store.** Binding a session prunes every other id, so a
 *    session the user switched away from can neither fill the store nor keep
 *    the tick armed.
 * 8. **Read failures.** Warned once per session, and a permanently failing
 *    read drops the value so the tick disarms.
 * 9. **Attach gate.** `activity: false` (a static config-time switch) attaches
 *    nothing at all.
 * 10. **Real host re-render.** The REAL registry + REAL projection re-render
 *     the value on every read, which is the exact feature the tick exists for.
 * 11. **User preferences.** The parsed `~/.dsh-tui/working-activity.json`
 *     reaches the mounted plugin config under the row's explicit values.
 * @module dsh-tui/scripts/verify-activity-store
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACTIVITY_PROJECTION_KEY,
  ActivityStore,
  asActivityView,
  attachActivityProjection,
  createActivityFeed,
  createActivityStore,
  seedActivity,
  type ActivityView,
  type ProjectionRegistryLike,
} from '../src/dsh-adapter/activity-store.js'

/** One well-formed value, with overrides. */
function view(overrides: Partial<ActivityView> = {}): ActivityView {
  return {
    phase: 'thinking',
    line: '想一想 · 总3s',
    live: true,
    toolCount: 0,
    phaseStartedAt: 1_700_000_000_000,
    turnStartedAt: 1_699_999_999_000,
    updatedAt: 1_700_000_000_500,
    lang: 'zh',
    ...overrides,
  }
}

/** A registry stand-in with a controllable change feed. */
function fakeRegistry(): ProjectionRegistryLike & {
  emit: (id: string, key: string, value: unknown) => void
  listeners: number
  baseline: unknown
} {
  const listeners = new Set<(session: { id: unknown }, key: string, value: unknown, seq: number) => void>()
  const state = {
    listeners: 0,
    emit: (id: string, key: string, value: unknown): void => {
      for (const listener of [...listeners]) listener({ id }, key, value, 0)
    },
    onChanged(listener: (session: { id: unknown }, key: string, value: unknown, seq: number) => void) {
      listeners.add(listener)
      state.listeners = listeners.size
      return () => { listeners.delete(listener); state.listeners = listeners.size }
    },
    snapshot(_session: unknown, keys?: readonly string[]) {
      const wanted = keys ?? [ACTIVITY_PROJECTION_KEY]
      const values: Record<string, unknown> = {}
      for (const key of wanted) if (key === ACTIVITY_PROJECTION_KEY) values[key] = state.baseline
      return { values }
    },
    baseline: undefined as unknown,
  }
  return state as unknown as ProjectionRegistryLike & {
    emit: (id: string, key: string, value: unknown) => void
    listeners: number
    baseline: unknown
  }
}

// ── 1. session keying ───────────────────────────────────────────────────────
{
  const store = new ActivityStore()
  const a = view({ line: 'A 的行' })
  const b = view({ line: 'B 的行' })
  store.update('session-a', a)
  store.update('session-b', b)
  assert.equal(store.get('session-a')?.line, 'A 的行')
  assert.equal(store.get('session-b')?.line, 'B 的行')

  // A later event for B (the shape that used to steal the line) leaves A alone.
  store.update('session-b', view({ line: 'B 又动了' }))
  assert.equal(store.get('session-a')?.line, 'A 的行')
  assert.equal(store.get(undefined), undefined)
  assert.equal(store.get('session-c'), undefined)
}

// ── 2. change notification ──────────────────────────────────────────────────
{
  const store = new ActivityStore()
  let emitted = 0
  const off = store.subscribe(() => { emitted += 1 })
  const first = view()
  store.update('s', first)
  assert.equal(emitted, 1)
  // Same reference (the feed re-publishing an unchanged value) must not emit.
  store.update('s', first)
  assert.equal(emitted, 1)
  store.update('s', view({ line: '新的一行' }))
  assert.equal(emitted, 2)
  store.clear('s')
  assert.equal(emitted, 3)
  // Clearing an absent session is not a change.
  store.clear('s')
  assert.equal(emitted, 3)
  off()
  store.update('s', view())
  assert.equal(emitted, 3, 'unsubscribed listeners must not be called')
}

// ── 3. defensive narrowing ──────────────────────────────────────────────────
{
  assert.equal(asActivityView(view())?.phase, 'thinking')
  for (const bad of [undefined, null, 'line', 42, [], {}, { phase: 'thinking' }, { phase: 'nope', line: 'x' }]) {
    assert.equal(asActivityView(bad), undefined, `must reject ${JSON.stringify(bad)}`)
  }

  const store = new ActivityStore()
  const feed = createActivityFeed(store)
  feed({ id: 's' }, 'someOtherUnit', view({ line: '别人的' }))
  assert.equal(store.get('s'), undefined, 'another unit must not fill this store')
  feed({ id: 's' }, ACTIVITY_PROJECTION_KEY, { phase: 'thinking' })
  assert.equal(store.get('s'), undefined, 'a malformed value must not fill this store')
  feed({ id: 's' }, ACTIVITY_PROJECTION_KEY, view({ line: '我的' }))
  assert.equal(store.get('s')?.line, '我的')
}

// ── 4. bind-time baseline ───────────────────────────────────────────────────
{
  const registry = fakeRegistry()
  const store = new ActivityStore()
  registry.baseline = view({ line: '恢复出来的行', phase: 'done', live: false })
  seedActivity(registry, store, { id: 'session-r' })
  assert.equal(store.get('session-r')?.line, '恢复出来的行')

  // A session whose value no longer exists clears rather than keeping a stale
  // line from whatever was on screen before.
  const empty = fakeRegistry()
  const store2 = new ActivityStore()
  store2.update('session-r', view({ line: '陈旧的' }))
  seedActivity(empty, store2, { id: 'session-r' })
  assert.equal(store2.get('session-r'), undefined)

  // A registry that throws, or is absent, must not fail a session bind.
  const throwing: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot: () => { throw new Error('boom') },
  }
  const store3 = new ActivityStore()
  seedActivity(throwing, store3, { id: 'session-x' })
  seedActivity(undefined, store3, { id: 'session-x' })
  seedActivity(registry, store3, undefined)
  assert.equal(store3.get('session-x'), undefined)
}

// ── 5. live re-reads: the elapsed text cannot advance without one ───────────
{
  /** A registry that re-renders on every read, like the host does. */
  function countingRegistry(): { registry: ProjectionRegistryLike; reads: string[] } {
    let renders = 0
    const reads: string[] = []
    return {
      reads,
      registry: {
        onChanged: () => () => undefined,
        snapshot(session: unknown) {
          const id = String((session as { id: unknown }).id)
          reads.push(id)
          renders += 1
          return { values: { [ACTIVITY_PROJECTION_KEY]: view({ line: `第 ${renders} 次读取`, live: true }) } }
        },
      },
    }
  }

  const { registry, reads } = countingRegistry()
  const store = new ActivityStore()
  store.attachRegistry(registry)
  store.remember('session-a', { id: 'session-a' })
  store.remember('session-b', { id: 'session-b' })
  store.update('session-a', view({ line: 'A 在跑工具', live: true }))
  store.update('session-b', view({ line: 'B 已完成', live: false, phase: 'done' }))

  assert.equal(store.hasLive(), true, 'a live value means something is still counting')
  store.refreshLive()
  assert.equal(store.get('session-a')?.line, '第 1 次读取', 'the live value is re-read from the host')
  assert.deepEqual(reads, ['session-a'], 'a settled value is not re-read: its text cannot change')

  store.update('session-a', view({ line: 'A 完成', live: false, phase: 'done' }))
  assert.equal(store.hasLive(), false, 'nothing live → nothing to tick')
}

// ── 6. the tick is armed only while something counts time ───────────────────
{
  const registry: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot: (session: unknown) => ({
      values: { [ACTIVITY_PROJECTION_KEY]: view({ line: `tick ${String((session as { id: unknown }).id)}`, live: true }) },
    }),
  }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let armed = 0
  let cleared = 0
  let fire: (() => void) | undefined
  let innerEffects = 0
  let outerEffects = 0
  // A controllable timer: the wiring's policy is what is under test, not node.
  globalThis.setInterval = ((callback: () => void) => {
    armed += 1
    fire = callback
    return { unref: () => undefined } as unknown as NodeJS.Timeout
  }) as typeof setInterval
  globalThis.clearInterval = (() => { cleared += 1 }) as typeof clearInterval

  try {
    const ctx = {
      inject: (_deps: unknown, callback: (projectionCtx: unknown) => void) => {
        callback({
          sessionProjections: registry,
          effect: (factory: () => () => void) => { innerEffects += 1; return factory() },
        })
      },
      effect: () => { outerEffects += 1; return () => undefined },
    } as never
    const store = new ActivityStore()
    attachActivityProjection(ctx, store)
    assert.equal(armed, 0, 'an empty store owns no timer')
    // The cleanup rides the INJECTED fiber: a service re-provide re-runs the
    // inject callback, and only a fiber-owned disposer stops the previous
    // feed/timer pair instead of stacking another.
    assert.equal(innerEffects, 1, 'the feed cleanup is registered on the injected ctx')
    assert.equal(outerEffects, 0, 'the outer ctx owns no activity cleanup')

    store.remember('session-a', { id: 'session-a' })
    store.update('session-a', view({ line: '跑工具', live: true }))
    assert.equal(armed, 1, 'a live value arms exactly one timer')

    fire?.()
    assert.match(store.get('session-a')?.line ?? '', /^tick session-a$/, 'the tick re-reads the live value')

    store.update('session-a', view({ line: '收工', live: false, phase: 'done' }))
    assert.equal(cleared, 1, 'a settled value disarms the timer instead of polling forever')
    assert.equal(armed, 1, 'no second timer is armed after settling')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

// ── 7. single-current: switching sessions prunes the old id and disarms ─────
{
  // The baseline a bind reads: one live session, then a settled one.
  const registry = fakeRegistry()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let armed = 0
  let cleared = 0
  globalThis.setInterval = ((callback: () => void) => {
    armed += 1
    return { unref: () => undefined } as unknown as NodeJS.Timeout
  }) as typeof setInterval
  globalThis.clearInterval = (() => { cleared += 1 }) as typeof clearInterval

  try {
    const ctx = {
      inject: (_deps: unknown, callback: (projectionCtx: unknown) => void) => {
        callback({ sessionProjections: registry, effect: (factory: () => () => void) => factory() })
      },
      effect: (factory: () => () => void) => factory(),
    } as never
    const store = new ActivityStore()
    attachActivityProjection(ctx, store)

    // Bind session A: it becomes the current one and its live line arms the
    // tick.
    registry.baseline = view({ line: 'A 在跑', live: true })
    store.seed({ id: 'session-a' })
    assert.equal(store.get('session-a')?.line, 'A 在跑')
    assert.equal(armed, 1, 'the current session is live → the tick is armed')

    // A feed event for session B (the session the user switched away from is
    // the shape that used to park itself in the store forever) is dropped.
    const feed = createActivityFeed(store)
    feed({ id: 'session-b' }, ACTIVITY_PROJECTION_KEY, view({ line: 'B 抢线', live: true }))
    assert.equal(store.get('session-b'), undefined, 'a non-current session cannot fill the store')
    assert.equal(store.hasLive(), true, 'only the current session counts')

    // Switch to B, whose line is settled: A is pruned and nothing is live, so
    // the tick disarms instead of polling A forever.
    registry.baseline = view({ line: 'B 收工了', phase: 'done', live: false })
    store.seed({ id: 'session-b' })
    assert.equal(store.get('session-a'), undefined, 'switching sessions prunes the previous id')
    assert.equal(store.get('session-b')?.line, 'B 收工了')
    assert.equal(store.hasLive(), false, 'a settled current session leaves nothing live')
    assert.equal(cleared, 1, 'the tick disarms when the only live value was pruned')
    assert.equal(armed, 1, 'no second timer is armed for a settled line')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

// ── 8. read failures: warn once, then drop the value so the tick disarms ────
{
  const warns: string[] = []
  const store = new ActivityStore(message => { warns.push(message) })
  const failing: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot: () => { throw new Error('registry gone') },
  }
  // A live value is what makes the tick read at all.
  store.remember('session-f', { id: 'session-f' })
  store.update('session-f', view({ line: '还在跑', live: true }))

  seedActivity(failing, store, { id: 'session-f' })
  seedActivity(failing, store, { id: 'session-f' })
  assert.equal(warns.length, 1, 'the first failure warns exactly once')
  assert.match(warns[0] ?? '', /session-f.*registry gone/, 'the warning names the session and the cause')
  assert.notEqual(store.get('session-f'), undefined, 'two failures do not yet drop the value')

  seedActivity(failing, store, { id: 'session-f' })
  assert.equal(store.get('session-f'), undefined, 'three consecutive failures clear the value')
  assert.equal(store.hasLive(), false, 'nothing live → the tick disarms instead of polling forever')
  assert.equal(warns.length, 1, 'still exactly one warning')

  // A successful read resets the consecutive count: the value can come back,
  // and a NEW failure streak does not re-warn the same session.
  const recovering = fakeRegistry()
  recovering.baseline = view({ line: '回来了', live: true })
  seedActivity(recovering, store, { id: 'session-f' })
  assert.equal(store.get('session-f')?.line, '回来了', 'a recovered read refills the value')
  seedActivity(failing, store, { id: 'session-f' })
  seedActivity(failing, store, { id: 'session-f' })
  seedActivity(failing, store, { id: 'session-f' })
  assert.equal(store.get('session-f'), undefined, 'the second streak clears again')
  assert.equal(warns.length, 1, 'a session is warned about once, across streaks')
}

// ── 9. `activity: false` attaches nothing ───────────────────────────────────
{
  let attached = 0
  const ctx = {
    inject: () => { attached += 1 },
    effect: () => () => undefined,
  } as never
  const store = createActivityStore(ctx, false)
  assert.equal(attached, 0, 'a hidden line attaches no feed, no registry, no tick')
  // Seeding still cannot crash: without a registry the read is a no-op.
  store.seed({ id: 'session-h' })
  assert.equal(store.hasLive(), false)
}

// ── 10. the REAL registry + REAL projection re-render on read ───────────────
{
  const [{ Context }, SessionProjectionRegistry, { Session }, { createActivityProjection }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/dsh-session'),
    import('dsh-working-activity/src/projection.ts'),
  ])
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry.default)
  const registry = ctx.get('sessionProjections') as ProjectionRegistryLike & {
    register(definition: unknown): () => void
  }
  registry.register(createActivityProjection({
    trackerConfig: { phrases: true, detailLimit: 40, showIdle: false },
    // Pinned so the elapsed copy is deterministic (`总2s` → `总3s`).
    lang: () => 'zh',
  }))

  const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms) })
  // A turn that started ~2s ago: the host renders elapsed time from the stamps
  // when the value is READ, which is why the tick exists.
  const session = Session.create('22222222-0000-4000-8000-000000000002', [
    { type: 'turn/start', seq: 0, time: Date.now() - 2_000, data: { turn: 0 } },
  ])
  const store = new ActivityStore()
  store.attachRegistry(registry)
  store.seed(session)
  const elapsed = (value: ActivityView | undefined): number => {
    const match = /总(\d+)s/u.exec(value?.line ?? '')
    assert.ok(match !== undefined, `the line carries elapsed time (got: ${value?.line ?? 'none'})`)
    assert.equal(value?.live, true, 'a running turn counts time')
    return Number(match[1])
  }
  const first = elapsed(store.get(String(session.id)))
  // 固定窗:pacing 两次读取间隔须跨过整秒边界，才能证明“读即重渲染”让秒数前进
  await sleep(1_100)
  store.seed(session)
  const second = elapsed(store.get(String(session.id)))
  assert.ok(second > first, `a re-read advances the elapsed text (总${first}s → 总${second}s)`)
}

// ── 11. user preferences reach the mounted plugin config ────────────────────
{
  const { mergeActivityPreferences } = await import('../src/activityPrefs.js')
  const { FEATURE_FLAGS, featureOn, parseWorkingActivityConfig } = await import('dsh-working-activity/config')

  const file = parseWorkingActivityConfig(JSON.stringify({
    mode: 'minimal',
    features: { rareEggs: true },
    customPhrases: ['加把劲'],
    customActions: { bash: ['跑命令'] },
    showTokPerSec: true,
    workRemindAt: 2,
  })).config

  /** Every flag the plugin honours except `phrases` (top-level switch). */
  const foldable = FEATURE_FLAGS.filter(name => name !== 'phrases')
  /**
   * The features object the merge should produce: what the file implies via
   * `featureOn` (so whatever semantics the installed plugin version carries),
   * with the row's explicit entries on top.
   */
  const fileImplied = (rowFeatures: Record<string, boolean> = {}): Record<string, boolean> =>
    Object.fromEntries(foldable.map(name => [name, rowFeatures[name] ?? featureOn(file, name)]))

  // A schema-default row (what apply() receives when the yml sets none of
  // these keys): the file fills everything — every flag the PLUGIN honours,
  // so a plugin-side switch cannot grow a stale gap at this seam.
  const defaults = {
    phrases: true,
    publish: false,
    publishIntervalMs: 500,
    customPhrases: [] as string[],
    showTokPerSec: false,
    workRemindAt: 0,
    customActions: {} as Record<string, string[]>,
  }
  const merged = mergeActivityPreferences(defaults, file)
  assert.equal(merged.phrases, false, '`mode: minimal` turns phrases off (featureOn parity)')
  assert.deepEqual(merged.features, fileImplied())
  assert.deepEqual(merged.customPhrases, ['加把劲'])
  assert.deepEqual(merged.customActions, { bash: ['跑命令'] })
  assert.equal(merged.showTokPerSec, true)
  assert.equal(merged.workRemindAt, 2)

  // Explicit row values keep winning over the file.
  const explicit = mergeActivityPreferences({
    ...defaults,
    phrases: false,
    features: { weekend: true },
    customPhrases: ['行里的'],
    showTokPerSec: true,
    workRemindAt: 5,
  }, file)
  assert.equal(explicit.phrases, false)
  assert.deepEqual(
    explicit.features,
    fileImplied({ weekend: true }),
    'row entries win per flag, the file fills the rest',
  )
  assert.deepEqual(explicit.customPhrases, ['行里的'])
  assert.equal(explicit.workRemindAt, 5)

  // No file: the row config passes through untouched.
  assert.equal(mergeActivityPreferences(defaults, undefined), defaults)

  // And the mount point really mounts with the merge (publish forced off
  // last, so no row can turn it back on).
  const mount = readFileSync(new URL('../src/working-activity.ts', import.meta.url), 'utf8')
  assert.match(
    mount,
    /\.\.\.mergeActivityPreferences\(config, readActivityConfig\(\)\), publish: false/,
    'working-activity.ts mounts the merged config with publish forced off',
  )
}

console.log('verify-activity-store: OK (session keying, change feed, narrowing, bind baseline, live re-reads, tick policy, single-current, read failures, attach gate, real-host re-render, user preferences)')
