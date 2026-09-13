/**
 * verify-channel-trace-read — `channel.traceEvents()` 必须是零拷贝直通。
 *
 * 背景（用户报告：合并 #776 后长对话卡顿，冒字/滚动都卡）：ChannelUi 的
 * detached 读投影把整条会话事件日志也投影了一遍，而 dsh-session 每次
 * append 都换一个新的快照数组（snapshotEvents() 的冻结缓存），读投影因此
 * 无法按数组身份命中，每次调用都重建整条数组 —— 实测 322us @2k 事件、
 * 2.7ms @20k、65ms @200k。Chat 在**每次渲染**都调 `channel.traceEvents()`
 * 折叠 trajectory，44 万事件的会话于是每帧烧掉上百毫秒。
 *
 * 本回归钉住两条边界：
 *  1. traceEvents 直通：返回的元素必须是会话原始事件对象（不是 detached
 *     副本），且两次调用拿到同一批对象；lease/shadow 检查仍在该调用上生效。
 *  2. 其余属性仍走读投影：rows 必须是冻结副本、与后端数组不同一 —— 修复
 *     不得顺手把 detached 契约拆掉。
 *
 * Run: node --import tsx/esm scripts/verify-channel-trace-read.ts
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { mountChannelUi } from '../src/dsh-adapter/channel-ui.js'
import { registerTuiChannel } from '../src/adapter/channel/host-registry.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 40))

/**
 * Append-only live session: snapshotEvents() hands back a NEW array each call.
 * Upstream caches a FROZEN snapshot per append, so the fixture freezes too —
 * otherwise this script would pass even if traceEvents started handing out a
 * mutable session-owned array.
 */
function sessionWith(events: readonly unknown[]) {
  return {
    id: 'trace-read-session',
    seq: events.length,
    events,
    snapshotEvents: () => Object.freeze(events.slice()),
    requestHeader: () => undefined,
  }
}

function fixture(eventCount: number) {
  const events: Array<Record<string, unknown>> = []
  for (let i = 0; i < eventCount; i++) {
    events.push({
      type: 'assistant/chunk', seq: i, time: 1_700_000_000_000 + i,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: `字${i}` } },
    })
  }
  const services: Record<string, unknown> = {
    settings: { describe: () => [], get: () => ({}), mutate: async () => undefined },
    credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
    llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
    agents: { create: async () => { throw new Error('no create') } },
  }
  const ctx = {
    on: () => () => undefined,
    effect: () => undefined,
    get(name: string) { return services[name] },
    logger: { warn() {}, info() {}, debug() {} },
  }
  const agent = {
    id: 'trace-read-agent', status: 'idle',
    session: sessionWith(events),
    ctx: { on: () => () => undefined },
    followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true },
  }
  const raw = createChannel(ctx as never, agent as never, { model: 'm', provider: 'p', cwd: '/tmp', activity: false })
  return { ctx, raw, events }
}

// ── 1. traceEvents 直通（不投影、不深拷贝）──────────────────────────────
{
  const { ctx, raw, events } = fixture(5_000)
  const unregister = registerTuiChannel(ctx as never, raw as never)
  const mount = mountChannelUi(ctx as never, raw as never, undefined, 'new')
  const first = mount.channel.traceEvents()
  const second = mount.channel.traceEvents()

  assert.equal(first.length, events.length, 'traceEvents keeps the whole log')
  assert.notEqual(first, second, 'each call sees the session’s own fresh snapshot array')
  assert.equal(Object.isFrozen(first), true, 'traceEvents preserves the frozen session snapshot')
  assert.equal(first[0], events[0], 'event objects are handed through, not detached copies')
  assert.equal(first[events.length - 1], events[events.length - 1], 'tail event identity survives')
  assert.equal((first[0] as { data: unknown }).data, (events[0] as { data: unknown }).data, 'nested event data is not re-copied')
  assert.equal(second[0], events[0], 'a second read returns the same original objects (no per-call projection)')
  assert.notEqual(first[0], undefined, 'sanity: the log is non-empty')

  // The detached read projection still owns every other property.
  raw.rows.push({ id: 1, kind: 'assistant', text: 'hi' } as never)
  raw.emit()
  const rows = mount.channel.rows
  assert.notEqual(rows, raw.rows, 'rows stay detached from the live array')
  assert.notEqual(rows[0], raw.rows[0], 'rows stay detached row-by-row')
  assert.equal(Object.isFrozen(rows), true, 'projected rows array is frozen')
  assert.equal(Object.isFrozen(rows[0]), true, 'projected row is frozen')

  mount.dispose(); unregister(); raw.releaseContributions()
}

// ── 2. lease/shadow 仍守在该调用上：dispose 后保留句柄必须失效 ──────────
{
  const { ctx, raw } = fixture(64)
  const unregister = registerTuiChannel(ctx as never, raw as never)
  const mount = mountChannelUi(ctx as never, raw as never, undefined, 'new')
  const retained = mount.channel.traceEvents
  assert.equal(retained().length, 64, 'retained handle works while the lease is live')
  mount.dispose()
  assert.throws(() => retained(), /lifetime/, 'retained traceEvents handle dies with the lease')
  unregister(); raw.releaseContributions()
}

// ── 3. 空日志与单事件边界 ───────────────────────────────────────────────
{
  const { ctx, raw } = fixture(0)
  const unregister = registerTuiChannel(ctx as never, raw as never)
  const mount = mountChannelUi(ctx as never, raw as never, undefined, 'new')
  assert.deepEqual(mount.channel.traceEvents(), [], 'empty log projects as an empty array')
  mount.dispose(); unregister(); raw.releaseContributions()
}

await tick()
console.log('verify:channel-trace-read OK (traceEvents direct passthrough, rows still detached, lease gated)')
