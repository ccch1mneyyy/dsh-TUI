/**
 * 占用单一真源回归（PR2）。
 *
 * 断言两件事，缺一不可：
 *   A. 投影存在（正常部署：dsh-base 在宿主平面挂 token-meter）时，占用 =
 *      `contextPressure` 的 `projectedTokens ?? pressureTokens`，`contextWindow`
 *      取投影值；它与会话累计的未缓存输入**解耦**；投影变更会推动 channel
 *      重发；非 completed 的 turn/end 也会评估上下文告警；压缩检查点不再用
 *      chars/4 改写占用。
 *   B. 投影缺席（裸 cordis.yml，无 token-meter）时，回退到上一次成功请求的
 *      provider 采样，且软失败不抛；两者都缺时读数为 undefined（此时官方
 *      也是什么都不渲染）。
 *
 * Run: node --import tsx/esm scripts/verify-context-occupancy.ts
 */
import assert from 'node:assert/strict'
import { ContextOccupancyStore, CONTEXT_BREAKDOWN_PROJECTION_KEY, CONTEXT_PRESSURE_PROJECTION_KEY, attachContextPressureProjection, resolveContextBreakdown, resolveContextOccupancy } from '../src/dsh-adapter/context-occupancy.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { estimateTokens } from '../src/dsh-adapter/channel/usage.js'
import { contextPressurePct } from '../src/components/ActivityLine.js'
import { attributeBarTokens, barSegments, channelContextOccupancy, contextBarColumns, USED_SEGMENTS } from '../src/screens/StatusMetrics.js'

// ── 解析口径（官方 precedence，逐个分支）────────────────────────────────
assert.deepEqual(
  resolveContextOccupancy(
    { pressureTokens: 70_000, projectedTokens: 82_000, contextWindow: 100_000 },
    { input: 1, cacheRead: 0, cacheWrite: 0 },
    200_000,
  ),
  { usedTokens: 82_000, contextWindow: 100_000, source: 'projection' },
  'projectedTokens 优先，窗口取投影值',
)
assert.deepEqual(
  resolveContextOccupancy({ pressureTokens: 70_000 }, undefined, 100_000),
  { usedTokens: 70_000, contextWindow: 100_000, source: 'projection' },
  '无 projectedTokens 时退回 pressureTokens，窗口回退 request/context',
)
assert.deepEqual(
  resolveContextOccupancy(
    { contextWindow: 128_000 },
    { input: 70_000, cacheRead: 6_000, cacheWrite: 6_000 },
    100_000,
  ),
  { usedTokens: 82_000, contextWindow: 128_000, source: 'sample' },
  '投影只有容量时，分子回退采样、分母仍用投影容量',
)
assert.deepEqual(
  resolveContextOccupancy(undefined, { input: 70_000, cacheRead: 6_000, cacheWrite: 6_000 }, 100_000),
  { usedTokens: 82_000, contextWindow: 100_000, source: 'sample' },
  '无投影时回退到上次请求的计费采样（含 cache 读写）',
)
assert.equal(resolveContextOccupancy(undefined, undefined, 100_000), undefined, '两者都缺 → 无读数')
assert.equal(resolveContextOccupancy(undefined, { input: 1, cacheRead: 0, cacheWrite: 0 }, undefined)?.contextWindow, undefined)

// ── 投影接缝：registry onChanged 是唯一推送，快照只在绑定时读一次 ─────────
type ChangeListener = (session: unknown, key: string, value: unknown, seq: number) => void

function makeRegistry() {
  const listeners = new Set<ChangeListener>()
  const values = new Map<string, unknown>()
  return {
    listeners,
    publish(session: { id: unknown }, key: string, value: unknown): void {
      values.set(`${String(session.id)}\u0000${key}`, value)
      for (const listener of [...listeners]) listener(session, key, value, 1)
    },
    snapshotCalls: 0,
    snapshot(session: unknown, keys?: readonly string[]): { readonly values: Record<string, unknown> } {
      this.snapshotCalls += 1
      const out: Record<string, unknown> = {}
      for (const key of keys ?? []) {
        const value = values.get(`${String((session as { id: unknown }).id)}\u0000${key}`)
        if (value !== undefined) out[key] = value
      }
      return { values: out }
    },
    onChanged(listener: ChangeListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// 服务缺席：读不到、也不抛。
{
  const store = new ContextOccupancyStore()
  store.seed({ id: 's1' })
  assert.equal(store.read('s1'), undefined, '无 registry 时软失败为空值')
}

// store 自身的 seed/update/订阅语义。
{
  const registry = makeRegistry()
  const store = new ContextOccupancyStore()
  store.attachRegistry(registry)
  const view = { pressureTokens: 70_000, projectedTokens: 82_000, contextWindow: 100_000 }
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, view)
  store.seed({ id: 's1' })
  assert.equal(registry.snapshotCalls, 1, '绑定只读一次快照')
  assert.equal(store.read('s1'), view, '绑定读到的就是投影值')
  let wakeups = 0
  const off = store.subscribe(() => { wakeups += 1 })
  store.update('s2', CONTEXT_PRESSURE_PROJECTION_KEY, { pressureTokens: 1 })
  assert.equal(wakeups, 0, '其它 session 的值不进入当前读数')
  store.update('s1', CONTEXT_PRESSURE_PROJECTION_KEY, view)
  assert.equal(wakeups, 0, '同一个 wire 引用不产生变更')
  const smaller = { pressureTokens: 70_000, projectedTokens: 20_000, contextWindow: 100_000 }
  store.update('s1', CONTEXT_PRESSURE_PROJECTION_KEY, smaller)
  assert.equal(store.read('s1'), smaller)
  assert.equal(wakeups, 1, '当前 session 的新值通知订阅者')
  off()
  store.update('s1', CONTEXT_PRESSURE_PROJECTION_KEY, { pressureTokens: 5 })
  assert.equal(wakeups, 1, '退订后不再通知')
}

// 构成（contextBreakdown）：同一个 unit 的另一个 key，与占用各存一份、各自
// 变更测试；缺席（老 meter）与半填值都不得影响占用那条路径。
{
  const registry = makeRegistry()
  const store = new ContextOccupancyStore()
  store.attachRegistry(registry)
  const pressure = { pressureTokens: 300_000, projectedTokens: 307_000, contextWindow: 1_000_000 }
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, pressure)
  store.seed({ id: 's1' })
  assert.equal(store.readBreakdown('s1'), undefined, '老 meter 不发布构成 → 读不到，占用照旧')
  assert.equal(store.read('s1'), pressure)

  const breakdown = { systemTokens: 1_400, toolsTokens: 19_000, messageTokens: 200_000 }
  let wakeups = 0
  const off = store.subscribe(() => { wakeups += 1 })
  store.update('s1', CONTEXT_BREAKDOWN_PROJECTION_KEY, breakdown)
  assert.equal(store.readBreakdown('s1'), breakdown, '构成按自己的 key 存')
  assert.equal(store.read('s1'), pressure, '构成变更不动占用')
  assert.equal(wakeups, 1, '构成变更也要通知（条的构成跟着变）')
  store.update('s1', CONTEXT_BREAKDOWN_PROJECTION_KEY, breakdown)
  assert.equal(wakeups, 1, '同一个 wire 引用不产生变更')
  store.update('s2', CONTEXT_BREAKDOWN_PROJECTION_KEY, breakdown)
  assert.equal(wakeups, 1, '其它 session 的构成不进当前读数')
  off()

  // 半填值：已知字段保留，缺失字段归一成 0（不能整条丢弃）。
  assert.deepEqual(
    resolveContextBreakdown({ toolsTokens: 19_000 }),
    { systemTokens: 0, toolsTokens: 19_000, messageTokens: 0 },
  )
  assert.equal(resolveContextBreakdown(undefined), undefined)

  // 重新绑定别的 session：两张表都按当前 id 剪枝。
  store.seed({ id: 's2' })
  assert.equal(store.readBreakdown('s1'), undefined, '换绑后旧 session 的构成被剪掉')
  assert.equal(store.read('s1'), undefined, '换绑后旧 session 的占用同样被剪掉')
}

// inject 接缝：只认本 key，清理挂在注入 fiber 上，服务缺席不抛。
{
  const registry = makeRegistry()
  const cleanups: (() => void)[] = []
  const warnings: string[] = []
  const injectionCtx: Record<string, unknown> = {
    sessionProjections: registry,
    inject(_names: unknown, callback: (ctx: unknown) => void) { callback(injectionCtx) },
    effect(setup: () => () => void) { cleanups.push(setup()) },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  const store = new ContextOccupancyStore(message => { warnings.push(message) })
  attachContextPressureProjection(injectionCtx as never, store)
  assert.equal(registry.listeners.size, 1, '注入回调里恰好订阅一次变更流')
  store.seed({ id: 's1' })
  registry.publish({ id: 's1' }, 'tokenUsage', { uncachedInputTokens: 1 })
  assert.equal(store.read('s1'), undefined, '其它投影 key 的变化被丢弃（不触发 snapshot）')
  assert.equal(registry.snapshotCalls, 1, '变更流不读快照')
  registry.publish({ id: 's2' }, CONTEXT_PRESSURE_PROJECTION_KEY, { pressureTokens: 9 })
  assert.equal(store.read('s1'), undefined, '其它 session 的变化被丢弃')
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, { pressureTokens: 9, contextWindow: 100 })
  assert.deepEqual(store.read('s1'), { pressureTokens: 9, contextWindow: 100 })
  for (const cleanup of cleanups) cleanup()
  assert.equal(registry.listeners.size, 0, 'effect 清理解绑变更流')

  // 服务缺席：注册回调直接返回，不订阅、不抛。
  const bare: Record<string, unknown> = {
    inject(_names: unknown, callback: (ctx: unknown) => void) { callback(bare) },
    effect() { return undefined },
    logger: { warn() {} },
  }
  const bareStore = new ContextOccupancyStore()
  attachContextPressureProjection(bare as never, bareStore)
  bareStore.seed({ id: 's1' })
  assert.equal(bareStore.read('s1'), undefined, '无 sessionProjections 服务时保持为空且不抛')
}

/**
 * A registry + store wired exactly the way the composition root wires them
 * (`attachContextPressureProjection`), so `registry.publish` reaches the store
 * the way the host's real change feed does.
 */
function makeWiredStore() {
  const registry = makeRegistry()
  const cleanups: (() => void)[] = []
  const injectionCtx: Record<string, unknown> = {
    sessionProjections: registry,
    inject(_names: unknown, callback: (ctx: unknown) => void) { callback(injectionCtx) },
    effect(setup: () => () => void) { cleanups.push(setup()) },
    logger: { warn() {} },
  }
  const store = new ContextOccupancyStore()
  attachContextPressureProjection(injectionCtx as never, store)
  return { registry, store, cleanups }
}

// ── channel 层：投影在场 ────────────────────────────────────────────────
function makeFixture() {
  const listeners = new Map<string, (...args: never[]) => void>()
  const ctx = {
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    get() { return undefined },
    logger: { warn() {} },
  }
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
  return { ctx, agent, listeners }
}

const isLowContext = (item: { text: string }): boolean => /Context low|上下文即将耗尽/u.test(item.text)

{
  const { registry, store } = makeWiredStore()
  // 官方语义：provider 采样 82k，投影把 surface 变化算进来；窗口来自投影。
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, {
    pressureTokens: 82_000, projectedTokens: 82_000, contextWindow: 100_000,
  })
  const { ctx, agent, listeners } = makeFixture()
  const channel = createChannel(ctx as never, agent as never, {
    model: 'model', provider: 'provider', cwd: '/tmp', activity: false,
    contextPressure: store,
    seedContextOccupancy: session => store.seed(session),
  })
  assert.equal(store.read('s1')?.projectedTokens, 82_000, '绑定用 seedContextOccupancy 读了基线')
  assert.equal(channel.contextOccupancy?.source, 'projection')
  assert.equal(channel.contextOccupancy?.usedTokens, 82_000)
  assert.equal(channel.contextOccupancy?.contextWindow, 100_000)

  // 与「会话累计未缓存输入」解耦：累计量再大也不改变占用百分比。
  channel.tokens.input = 647_808
  assert.equal(contextPressurePct(channelContextOccupancy(channel)), 82, '占用百分比 = 投影值 / 投影容量')
  assert.equal(Math.round((channel.tokens.input / 100_000) * 100), 648, '累计未缓存输入是另一个量（648% 的荒谬读数不再上屏）')

  // 投影变更 → channel 重发（页脚/告警立刻看到新值）。
  const before = channel.version
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, {
    pressureTokens: 82_000, projectedTokens: 96_000, contextWindow: 100_000,
  })
  assert.ok(channel.version > before, '投影变更会 bump channel version')
  assert.equal(channel.contextOccupancy?.usedTokens, 96_000)

  // 非 completed 的 turn/end 也评估告警：分子来自投影，channel 里根本没有采样。
  assert.equal(channel.lastUsage, undefined)
  const emit = (event: unknown): void => {
    const handler = listeners.get('session/event')
    assert.ok(handler !== undefined, 'channel 订阅了 session/event')
    ;(handler as unknown as (session: unknown, event: unknown) => void)(agent.session, event)
  }
  emit({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  emit({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'error', error: { name: 'Error', message: 'context length exceeded' } } } })
  assert.equal(channel.notifications.filter(isLowContext).length, 1, '错误回合结束也会按投影占用告警（无成功采样时旧实现永不告警）')
  // 闩锁语义不变：同一会话只响一次，直到检查点/重置释放。
  emit({ type: 'turn/end', seq: 3, time: 3, data: { turn: 2, reason: { kind: 'aborted' } } })
  assert.equal(channel.notifications.filter(isLowContext).length, 1, '闩锁仍然只响一次')

  // 压缩检查点：占用跟着官方投影走（保留尾巴后的重算值），TUI 不再改写任何本地量。
  const summary = 'summary '.repeat(60)
  emit({ type: 'user/message', seq: 4, time: 4, data: { source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: summary }] } })
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, {
    pressureTokens: 96_000, projectedTokens: 20_000, contextWindow: 100_000,
  })
  assert.equal(channel.contextOccupancy?.usedTokens, 20_000, '压缩后占用 = 官方重算值（含 retainRatio 保留尾巴）')
  assert.notEqual(channel.contextOccupancy?.usedTokens, estimateTokens(summary), '不是摘要的分段估算（estimateTokens 只描述分段构成，不参与占用）')
  assert.equal(channel.lastUsage, undefined, '检查点不再伪造 lastUsage')
  assert.equal(channel.tokens.input, 647_808, '检查点不再改写累计 tokens 计数器')
  assert.equal(channel.contextSegments.assistant, 0, '分段条的分段清零保留')
  channel.releaseContributions()
}

// ── channel 层：构成（contextBreakdown）与占用同源、同一接缝 ─────────────
// 条的两个输入都要从 channel 拿：占用（权威总量）与构成（按什么切开它）。
// 这一段走的是生产接线——投影 → store → channel 访问器 → 份额，而不是把
// 一个字面量塞进 partial channel（那是 verify-context-bar-alignment 的活）。
{
  const { registry, store } = makeWiredStore()
  registry.publish({ id: 's1' }, CONTEXT_PRESSURE_PROJECTION_KEY, {
    pressureTokens: 306_000, projectedTokens: 306_827, contextWindow: 1_000_000,
  })
  const { ctx, agent, listeners } = makeFixture()
  const channel = createChannel(ctx as never, agent as never, {
    model: 'model', provider: 'provider', cwd: '/tmp', activity: false,
    contextPressure: store,
    seedContextOccupancy: session => store.seed(session),
  })
  assert.equal(channel.contextBreakdown, undefined, '老 meter 不发布构成 → channel 读出 undefined（回退本地估算）')

  const emit = (event: unknown): void => {
    const handler = listeners.get('session/event')
    assert.ok(handler !== undefined, 'channel 订阅了 session/event')
    ;(handler as unknown as (session: unknown, event: unknown) => void)(agent.session, event)
  }
  // 分段由真实投影器产出（本地估算那一层仍然是它在管）。
  emit({ type: 'system/message', seq: 1, time: 1, data: { message: { role: 'system', content: [{ type: 'text', text: 'S'.repeat(4_000) }] } } })
  emit({ type: 'user/message', seq: 2, time: 2, data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'U'.repeat(400) }] } })
  assert.equal(channel.contextSegments.system, 1_000, 'system 段来自投影器')
  assert.equal(channel.contextSegments.prompt, 100, 'prompt 段来自投影器')

  const before = channel.version
  registry.publish({ id: 's1' }, CONTEXT_BREAKDOWN_PROJECTION_KEY, {
    systemTokens: 1_341, toolsTokens: 18_976, messageTokens: 180_000,
  })
  assert.ok(channel.version > before, '构成变更同样 bump channel version（条跟着重绘）')
  assert.deepEqual(channel.contextBreakdown, {
    systemTokens: 1_341, toolsTokens: 18_976, messageTokens: 180_000,
  }, 'channel 访问器把主机值归一成端口形状')

  // 半填值不得整条丢弃：缺失字段归一成 0。
  registry.publish({ id: 's1' }, CONTEXT_BREAKDOWN_PROJECTION_KEY, { toolsTokens: 500 })
  assert.deepEqual(channel.contextBreakdown, { systemTokens: 0, toolsTokens: 500, messageTokens: 0 })

  registry.publish({ id: 's1' }, CONTEXT_BREAKDOWN_PROJECTION_KEY, {
    systemTokens: 1_341, toolsTokens: 18_976, messageTokens: 180_000,
  })
  const occupancy = channelContextOccupancy(channel)
  const used = occupancy?.usedTokens ?? 0
  const window = occupancy?.contextWindow ?? 0
  assert.equal(used, 306_827, '占用仍来自 contextPressure（构成从不参与总量）')
  const segments = barSegments(channel.contextSegments, channel.contextBreakdown)
  assert.equal(segments.tools, 18_976, '工具 schema 落在 tools 段（本地估算看不到的那块）')
  assert.equal(segments.system, 1_341, 'system 段取 meter 值')
  // 构成只分「已用段」内部的宽度：条长仍是占用的份额，构成从不参与总长。
  const width = 100
  const columns = contextBarColumns(segments, used, window, width)
  assert.equal(
    columns.used.reduce((total, value) => total + value, 0),
    Math.round(width * (used / window)),
    '条长 == 占用份额（构成不改变总长度）',
  )
  // 归因（issue #1350 期望②）：悬停明细里五段的整数和必须恰等于占用，否则用户
  // 把图例数字相加会得到第二套总量（原报告：906k ≠ 307k）。
  const attributed = attributeBarTokens(segments, used)
  assert.equal(
    USED_SEGMENTS.reduce((total, segment) => total + attributed[segment.key], 0),
    used,
    '归因：五段整数和恰等于占用（明细可加总）',
  )
  // 全零构成（压缩检查点 / 回放前那种只知总量的帧）不编造均分：条上是一整块
  // `unclassified`，图例就该报实测 `used` 一项。
  assert.deepEqual(
    attributeBarTokens({ system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, used),
    { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    '归因：构成未知时归因结果全零（图例回落到实测 used 一项）',
  )
  channel.releaseContributions()
}

// ── channel 层：投影缺席（回退路径）────────────────────────────────────
{
  const { ctx, agent, listeners } = makeFixture()
  const channel = createChannel(ctx as never, agent as never, {
    model: 'model', provider: 'provider', cwd: '/tmp', activity: false,
  })
  assert.equal(channel.contextOccupancy, undefined, '既无投影也无采样时不渲染占用')
  channel.lastUsage = { input: 70_000, output: 100, cacheRead: 6_000, cacheWrite: 6_000 }
  channel.contextWindow = 100_000
  assert.equal(channel.contextOccupancy?.source, 'sample', '无 token-meter 的合成回退到采样')
  assert.equal(channel.contextOccupancy?.usedTokens, 82_000)
  assert.equal(contextPressurePct(channelContextOccupancy(channel)), 82)

  const emit = (event: unknown): void => {
    const handler = listeners.get('session/event')
    assert.ok(handler !== undefined)
    ;(handler as unknown as (session: unknown, event: unknown) => void)(agent.session, event)
  }
  emit({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  emit({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'error', error: { name: 'Error', message: 'boom' } } } })
  assert.equal(channel.notifications.filter(isLowContext).length, 1, '回退路径的告警仍然工作（非 completed 回合）')

  // 兼容解析：旧 partial channel 字面量（没有 contextOccupancy 成员）走同一公式。
  assert.deepEqual(
    channelContextOccupancy({ lastUsage: { input: 1, cacheRead: 2, cacheWrite: 3 }, contextWindow: 10 }),
    { usedTokens: 6, contextWindow: 10, source: 'sample' },
  )
  channel.releaseContributions()
}

console.log('verify-context-occupancy OK (projection precedence, cached feed, fallback, error-turn warning, checkpoint)')
