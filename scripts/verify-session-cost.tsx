/**
 * 本会话花费估算回归：子代理 durable usage + 主会话按模型分桶 + 多模型计价
 * （AC-A1..A6，#1089 / #857）。
 *
 * 覆盖：
 *  - AC-A5：价目表按 #857 更新（v4-flash / -vision-exp 用 Flash 价，v4-pro 行移除），
 *    priceForModel 前缀匹配结果；
 *  - AC-A1：SubagentActivityStore 消费 durable assistant/message.usage，按
 *    (provider, model) 累计并进入 estimateCostFromBucketsCny；
 *  - AC-A2：峰谷分桶 + cacheRead 命中价（与主会话同口径）；
 *  - AC-A3：live assistant/chunk.usage 不计费（只认 durable）；不污染 channel.tokens；
 *  - AC-A4：主会话按 event-time 模型分桶（request/header 驱动；无 header 或
 *    header 缺/空 model 回退 channel 模型），换模型不把历史 token 重估到新模型；
 *  - AC-A6：非官方 provider / 未收录模型只计 token、不计金额（unpriced）；
 *  - AC-A7：零金额 + 未计价 token 时状态栏与 hover 都露出"未计价"（渲染探针）；
 *  - 兼容：session-reset 清零、subagent-projection.syncNow 镜像、旧快照
 *    mainCost 缺失时 collectSessionCostEntries 回退 channel.tokens；
 *  - T07：/cost 末尾文案与"估算非账单"口径一致（旧"不提供费用计量"防回归）。
 *
 * Run: node --import tsx/esm scripts/verify-session-cost.tsx
 */

// 渲染探针要断言 zh 词条（"未计价"）；在动态 import i18n 前钉死语言，
// 避免机器上的 ~/.dsh-tui/lang.json 把探针输出切成英文。
process.env.DSH_TUI_LANG = 'zh'

const [
  { strict: assert },
  {
    DEEPSEEK_MODEL_PRICES,
    addUsageToCostBuckets,
    cloneCostBuckets,
    collectSessionCostEntries,
    emptyCostBuckets,
    estimateCostFromBucketsCny,
    isPeakHour,
    priceForModel,
  },
  { createInitialChannelView },
  { createChannelProjection },
  { createSubagentProjection },
  { SubagentActivityStore },
  { i18nDict },
  { readFileSync },
  { resetSessionProjection },
] = await Promise.all([
  import('node:assert'),
  import('../src/deepseekPricing.js'),
  import('../src/dsh-adapter/channel/state.js'),
  import('../src/dsh-adapter/channel/projection.js'),
  import('../src/dsh-adapter/channel/subagent-projection.js'),
  import('../src/dsh-adapter/subagents.js'),
  import('../src/i18n.js'),
  import('node:fs'),
  import('../src/dsh-adapter/channel/session-reset.js'),
])

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

const close = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9
const noop = (): void => {}

// 北京 = UTC+8。峰：周一 10:00（UTC 02:00）；谷：周一 13:00（UTC 05:00）。
const PEAK = Date.parse('2026-08-17T02:00:00Z')
const IDLE = Date.parse('2026-08-17T05:00:00Z')
const FLASH_PRICE = { inputMiss: [1.0, 2.0], inputHit: [0.02, 0.04], output: [4.0, 8.0] }

/** 一条固定 time 的 durable assistant/message 事件。 */
function durableMessage(seq: number, time: number, usage: Record<string, number>): unknown {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn: 1, step: 1, stream: [], message: { content: [] }, usage },
  }
}

/** 一条固定 time 的 request/header 事件（模型归属真源，replay 时按请求还原）。 */
function requestHeader(seq: number, time: number, model: string): unknown {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config: { provider: 'deepseek', model } }, reason: 'change' },
  }
}

/** request/header 的形状探针：config 可缺 model，也可带空串（AC-A4）。 */
function requestHeaderConfig(seq: number, time: number, config: Record<string, unknown>): unknown {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config }, reason: 'change' },
  }
}

/** 与既有 AC-A4 用例相同的 projector 依赖桩。 */
function makeProjector(state: Record<string, unknown>): { renderEvent: (event: unknown) => void } {
  return createChannelProjection(state as never, {
    agent: () => ({}) as never,
    rowIds: { value: 0 },
    resetContextWarning: noop,
    pendingTaskDescriptions: [],
    jobs: { onOutputSeen: noop, onStarted: noop },
    inputConvergence: { cancelInFlight: false },
    checkContextWarning: noop,
    notify: noop,
    attachments: noop,
  }) as { renderEvent: (event: unknown) => void }
}

// ═════════════════════ AC-A5：价目表按 #857 更新 ═════════════════════

{
  const flash = priceForModel('deepseek-v4-flash')
  check('AC-A5 priceForModel(v4-flash) = Flash 价', flash !== undefined
    && JSON.stringify(flash) === JSON.stringify(FLASH_PRICE), JSON.stringify(flash))
  const vision = priceForModel('deepseek-v4-flash-vision-exp')
  check('AC-A5 priceForModel(v4-flash-vision-exp) = Flash 价（最长前缀）', vision !== undefined
    && JSON.stringify(vision) === JSON.stringify(FLASH_PRICE), JSON.stringify(vision))
  check('AC-A5 v4-pro 行已移除', priceForModel('deepseek-v4-pro') === undefined
    && !Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_PRICES, 'deepseek-v4-pro'))
  check('AC-A5 既有 deepseek-flash 仍为 Flash 价', priceForModel('deepseek-flash') !== undefined
    && JSON.stringify(priceForModel('deepseek-flash')) === JSON.stringify(FLASH_PRICE))
  check('AC-A5 未收录模型不估价', priceForModel('gpt-4o') === undefined)
}

// ═════════════════════ 纯函数：按桶计价 + 分侧 + unpriced ═════════════════════

{
  const buckets = emptyCostBuckets()
  addUsageToCostBuckets(buckets, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, true)
  const estimate = estimateCostFromBucketsCny([
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', buckets, scope: 'main' },
  ])
  check('estimate 主会话高峰 1M 输入 = ¥2.00', estimate !== undefined
    && close(estimate.total, 2.0) && close(estimate.main, 2.0) && close(estimate.subagent, 0), JSON.stringify(estimate))

  const subBuckets = emptyCostBuckets()
  addUsageToCostBuckets(subBuckets, { input: 500_000, output: 250_000, cacheRead: 100_000, cacheWrite: 50_000 }, false)
  const split = estimateCostFromBucketsCny([
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', buckets, scope: 'main' },
    { provider: 'deepseek-official', model: 'deepseek-flash', buckets: subBuckets, scope: 'subagent' },
  ])
  // 子代理：空闲 (0.5M-0.1M)×1.0 + 0.1M×0.02 + 0.25M×4.0 = 0.4+0.002+1.0 = 1.402
  check('estimate 分侧 main/subagent + 峰谷合计', split !== undefined
    && close(split.main, 2.0) && close(split.subagent, 1.402) && close(split.total, 3.402)
    && close(split.peak, 2.0) && close(split.idle, 1.402), JSON.stringify(split))

  const unpriced = estimateCostFromBucketsCny([
    { provider: 'kimi-coding', model: 'kimi-k2', buckets: emptyCostBuckets0(), scope: 'subagent' },
  ])
  function emptyCostBuckets0() {
    const b = emptyCostBuckets()
    addUsageToCostBuckets(b, { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 }, true)
    return b
  }
  check('AC-A6 仅未计价用量：金额为 0、token 仍上报', unpriced !== undefined
    && close(unpriced.total, 0) && unpriced.unpricedTokens === 150, JSON.stringify(unpriced))
  check('estimate 零 token → undefined', estimateCostFromBucketsCny([]) === undefined)
  check('cloneCostBuckets 深拷贝', (() => {
    const source = emptyCostBuckets()
    addUsageToCostBuckets(source, { input: 7 }, true)
    const copy = cloneCostBuckets(source)
    copy.peak.input = 99
    return source.peak.input === 7 && copy.peak.input === 99
  })())
}

// ═════════════════════ AC-A1/A2：子代理 durable usage 累计与计价 ═════════════════════

{
  const store = new SubagentActivityStore()
  store.onSpawned('child-a', 'deepseek-official', 'deepseek-v4-flash')
  store.onSessionEvent('child-a', durableMessage(1, PEAK, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  const snapshot = store.costSnapshot()
  check('AC-A1 子代理 durable usage 进入按模型桶', snapshot.entries.length === 1
    && snapshot.entries[0]?.provider === 'deepseek-official'
    && snapshot.entries[0]?.model === 'deepseek-v4-flash'
    && snapshot.entries[0]?.buckets.peak.input === 1_000_000, JSON.stringify(snapshot.entries))
  const estimate = estimateCostFromBucketsCny(snapshot.entries.map(entry => ({ ...entry, scope: 'subagent' as const })))
  check('AC-A1 子代理按其自身模型计价 = ¥2.00', estimate !== undefined
    && close(estimate.total, 2.0) && close(estimate.subagent, 2.0), JSON.stringify(estimate))
}

{
  const store = new SubagentActivityStore()
  store.onSpawned('child-b', 'deepseek-official', 'deepseek-v4-flash')
  store.onSessionEvent('child-b', durableMessage(1, IDLE, { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 800_000, cacheWriteTokens: 100_000 }))
  store.onSessionEvent('child-b', durableMessage(2, PEAK, { inputTokens: 0, outputTokens: 250_000, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  const entry = store.costSnapshot().entries[0]
  check('AC-A2 跨时段分桶：peak.idle 各归其位', entry?.buckets.peak.output === 250_000
    && entry?.buckets.idle.input === 1_000_000 && entry?.buckets.idle.cacheRead === 800_000
    && entry?.buckets.idle.output === 500_000, JSON.stringify(entry?.buckets))
  const estimate = estimateCostFromBucketsCny(entry === undefined ? [] : [{ ...entry, scope: 'subagent' as const }])
  // 谷：(1M−0.8M)×1.0 + 0.8M×0.02 + 0.5M×4.0 = 2.216；峰：0.25M×8.0 = 2.0
  check('AC-A2 cacheRead 按命中价、跨时段分价 = ¥4.216', estimate !== undefined
    && close(estimate.total, 4.216) && close(estimate.peak, 2.0) && close(estimate.idle, 2.216), JSON.stringify(estimate))
  check('AC-A2 isPeakHour 判定与分桶一致', isPeakHour(new Date(PEAK)) && !isPeakHour(new Date(IDLE)))
}

// ═════════════════════ AC-A3：durable 去重、token 语义不被污染 ═════════════════════

{
  const store = new SubagentActivityStore()
  store.onSpawned('child-live', 'deepseek-official', 'deepseek-v4-flash')
  store.onSessionEvent('child-live', durableMessage(1, PEAK, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  const before = store.costSnapshot()
  // live chunk usage 只更新展示 token，不计费（否则同回合双计）。
  store.onSessionEvent('child-live', {
    type: 'assistant/chunk',
    seq: 2,
    time: PEAK,
    data: { chunk: { type: 'usage', usage: { inputTokens: 999_999, outputTokens: 999_999 } } },
  })
  const after = store.costSnapshot()
  check('AC-A3 live assistant/chunk.usage 不计费', after.entries[0]?.buckets.peak.input === before.entries[0]?.buckets.peak.input
    && after.entries[0]?.buckets.peak.output === before.entries[0]?.buckets.peak.output, JSON.stringify(after.entries))
  check('AC-A3 durable usage 只计一次', after.entries[0]?.buckets.peak.input === 100
    && after.entries[0]?.buckets.peak.output === 50, JSON.stringify(after.entries))
  check('AC-A3 reset 清空费用累计', (() => {
    store.reset()
    const cleared = store.costSnapshot()
    return cleared.entries.length === 0 && cleared.unpriced.peak.input === 0
  })())
}

// ═════════════════════ AC-A3b：同一条 durable 事件重投不重复计费 ═════════════════════
// 重放/回放会把同一批 durable 事件再投一次；若按事件逐笔累加，金额会随重投
// 线性膨胀（#1089 的目标是"算对"，双计比漏计更糟）。这里钉住按 seq 去重。

{
  const store = new SubagentActivityStore()
  store.onSpawned('child-replay', 'deepseek-official', 'deepseek-v4-flash')
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const first = durableMessage(7, PEAK, usage)
  store.onSessionEvent('child-replay', first)
  const once = store.costSnapshot()
  // 同一个对象再投一次，以及同 seq 的等价事件再投一次：都不得再计。
  store.onSessionEvent('child-replay', first)
  store.onSessionEvent('child-replay', durableMessage(7, PEAK, usage))
  const replayed = store.costSnapshot()
  check('AC-A3b 同 seq 重投只计一次', replayed.entries[0]?.buckets.peak.input === once.entries[0]?.buckets.peak.input
    && replayed.entries[0]?.buckets.peak.input === 1_000_000, JSON.stringify(replayed.entries))
  check('AC-A3b 重投后金额仍是 ¥2.00', close(
    estimateCostFromBucketsCny(replayed.entries.map(entry => ({ ...entry, scope: 'subagent' as const })))?.total ?? -1, 2.0))
  // 新 seq 是真的又发生了一笔用量，必须照常累计。
  store.onSessionEvent('child-replay', durableMessage(8, PEAK, usage))
  check('AC-A3b 新 seq 照常累计', store.costSnapshot().entries[0]?.buckets.peak.input === 2_000_000,
    JSON.stringify(store.costSnapshot().entries))
  check('AC-A3b reset 清掉去重水位（更小的 seq 不被旧水位挡住）', (() => {
    store.reset()
    store.onSpawned('child-replay', 'deepseek-official', 'deepseek-v4-flash')
    store.onSessionEvent('child-replay', durableMessage(3, PEAK, { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
    return store.costSnapshot().entries[0]?.buckets.peak.input === 5
  })())
}

// ═════════════════════ AC-A4：主会话按模型分桶（换模型不重估） ═════════════════════

{
  const state = {
    ...createInitialChannelView({ model: 'deepseek-v4-flash', provider: 'deepseek', cwd: '/tmp' }, {
      agentId: 'agent', sessionId: 'session', mode: { id: 'default', name: 'Default' } as never, cwdDescription: '/tmp',
    }),
    emit: noop,
  }
  const projector = createChannelProjection(state, {
    agent: () => ({}) as never,
    rowIds: { value: 0 },
    resetContextWarning: noop,
    pendingTaskDescriptions: [],
    jobs: { onOutputSeen: noop, onStarted: noop },
    inputConvergence: { cancelInFlight: false },
    checkContextWarning: noop,
    notify: noop,
    attachments: noop,
  })
  projector.renderEvent(requestHeader(1, PEAK, 'deepseek-flash') as never)
  projector.renderEvent(durableMessage(2, PEAK, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) as never)
  projector.renderEvent(requestHeader(3, IDLE, 'deepseek-v4-flash') as never)
  projector.renderEvent(durableMessage(4, IDLE, { inputTokens: 0, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 }) as never)
  const models = Object.keys(state.mainCost).sort()
  check('AC-A4 主会话按 event-time 模型分桶（两个模型桶）', models.length === 2
    && models[0] === 'deepseek-flash' && models[1] === 'deepseek-v4-flash', JSON.stringify(models))
  check('AC-A4 历史 token 留在原模型桶', state.mainCost['deepseek-flash']?.peak.input === 1_000_000
    && state.mainCost['deepseek-v4-flash']?.idle.output === 500_000, JSON.stringify(state.mainCost))
  const estimate = estimateCostFromBucketsCny(collectSessionCostEntries({
    provider: state.provider,
    main: state.mainCost,
    subagents: state.subagentCost,
  }))
  check('AC-A4 各模型按各自单价求和 = ¥4.00', estimate !== undefined
    && close(estimate.total, 4.0) && close(estimate.main, 4.0), JSON.stringify(estimate))
  check('AC-A3/A4 channel.tokens 既有累计语义不变', state.tokens.input === 1_000_000 && state.tokens.output === 500_000
    && state.tokens.peak.input === 1_000_000 && state.tokens.idle.output === 500_000, JSON.stringify(state.tokens))
}

{
  // 无 request/header 的旧日志/测试桩：回退事件发生时 channel 模型。
  const state = {
    ...createInitialChannelView({ model: 'deepseek-v4-flash', provider: 'deepseek', cwd: '/tmp' }, {
      agentId: 'agent', sessionId: 'session', mode: { id: 'default', name: 'Default' } as never, cwdDescription: '/tmp',
    }),
    emit: noop,
  }
  const projector = createChannelProjection(state, {
    agent: () => ({}) as never, rowIds: { value: 0 }, resetContextWarning: noop, pendingTaskDescriptions: [],
    jobs: { onOutputSeen: noop, onStarted: noop }, inputConvergence: { cancelInFlight: false },
    checkContextWarning: noop, notify: noop, attachments: noop,
  })
  projector.renderEvent(durableMessage(1, PEAK, { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }) as never)
  check('AC-A4 无 header 回退 channel 模型', state.mainCost['deepseek-v4-flash']?.peak.input === 200
    && state.mainCost['deepseek-v4-flash']?.peak.output === 100, JSON.stringify(state.mainCost))
  projector.renderEvent(durableMessage(2, IDLE, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) as never)
  check('AC-A4 零 usage 不建桶', Object.keys(state.mainCost).length === 1)
}

{
  // header 缺 model / model 为空串：不得沿用上一条 header 的旧值，必须清成
  // undefined 并在 usage 归属时回退 state.model，否则后续用量继续进旧模型桶。
  const state = {
    ...createInitialChannelView({ model: 'deepseek-v4-flash', provider: 'deepseek', cwd: '/tmp' }, {
      agentId: 'agent', sessionId: 'session', mode: { id: 'default', name: 'Default' } as never, cwdDescription: '/tmp',
    }),
    emit: noop,
  }
  const projector = makeProjector(state)
  projector.renderEvent(requestHeader(1, PEAK, 'deepseek-flash'))
  projector.renderEvent(durableMessage(2, PEAK, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  // config 整体缺 model
  projector.renderEvent(requestHeaderConfig(3, PEAK, { provider: 'deepseek' }))
  projector.renderEvent(durableMessage(4, PEAK, { inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  // config.model 为空串
  projector.renderEvent(requestHeaderConfig(5, PEAK, { provider: 'deepseek', model: '' }))
  projector.renderEvent(durableMessage(6, PEAK, { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  check('AC-A4 header 缺/空 model 清旧值并回退 state.model',
    state.mainCost['deepseek-flash']?.peak.input === 100
    && state.mainCost['deepseek-v4-flash']?.peak.input === 500
    && Object.keys(state.mainCost).length === 2,
    JSON.stringify(state.mainCost))
}

// ═════════════════════ AC-A6：非官方 / 未收录 = unpriced ═════════════════════

{
  const store = new SubagentActivityStore()
  store.onSpawned('child-official', 'deepseek-official', 'deepseek-v4-flash')
  store.onSessionEvent('child-official', durableMessage(1, PEAK, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  store.onSpawned('child-third-party', 'kimi-coding', 'kimi-k2')
  store.onSessionEvent('child-third-party', durableMessage(1, PEAK, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  store.onSpawned('child-unlisted', 'deepseek-official', 'deepseek-v4-pro')
  store.onSessionEvent('child-unlisted', durableMessage(1, PEAK, { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  const snapshot = store.costSnapshot()
  check('AC-A6 非官方与未收录各自成桶', snapshot.entries.length === 3, JSON.stringify(snapshot.entries))
  check('AC-A6 未计价桶累计第三方/未收录用量', snapshot.unpriced.peak.input === 800)
  const estimate = estimateCostFromBucketsCny(snapshot.entries.map(entry => ({ ...entry, scope: 'subagent' as const })))
  check('AC-A6 金额排除未计价、token 仍上报', estimate !== undefined
    && close(estimate.total, 2.0) && close(estimate.subagent, 2.0) && estimate.unpricedTokens === 900,
  JSON.stringify(estimate))
}

// ═════════════════════ 兼容：collect 回退 + session-reset + 投影镜像 ═════════════════════

{
  const fallback = emptyCostBuckets()
  addUsageToCostBuckets(fallback, { input: 1_000_000 }, true)
  const entries = collectSessionCostEntries({
    provider: 'deepseek',
    main: {},
    subagents: [],
    fallbackTokens: fallback,
    fallbackModel: 'deepseek-flash',
  })
  check('collect 旧快照回退 channel.tokens + 当前模型', entries.length === 1
    && entries[0]?.scope === 'main' && entries[0]?.model === 'deepseek-flash'
    && close(estimateCostFromBucketsCny(entries)?.total ?? -1, 2.0), JSON.stringify(entries))

  const mainBuckets = emptyCostBuckets()
  addUsageToCostBuckets(mainBuckets, { input: 100_000 }, false)
  const withMain = collectSessionCostEntries({
    provider: 'deepseek',
    main: { 'deepseek-v4-flash': mainBuckets },
    subagents: [{ provider: 'deepseek-official', model: 'deepseek-flash', buckets: emptyCostBuckets() }],
    fallbackTokens: fallback,
    fallbackModel: 'deepseek-flash',
  })
  check('collect mainCost 非空时不叠加 fallback（免双计）', withMain.length === 2
    && withMain[0]?.scope === 'main' && withMain[1]?.scope === 'subagent', JSON.stringify(withMain))
}

{
  const state = {
    ...createInitialChannelView({ model: 'deepseek-v4-flash', provider: 'deepseek', cwd: '/tmp' }, {
      agentId: 'agent', sessionId: 'session', mode: { id: 'default', name: 'Default' } as never, cwdDescription: '/tmp',
    }),
  }
  const seed = emptyCostBuckets()
  addUsageToCostBuckets(seed, { input: 10 }, true)
  state.mainCost = { 'deepseek-v4-flash': seed }
  state.subagentCost = [{ provider: 'deepseek-official', model: 'deepseek-flash', buckets: emptyCostBuckets() }]
  resetSessionProjection(state, { value: 3 }, noop, noop, noop)
  check('session-reset 清零 mainCost/subagentCost', Object.keys(state.mainCost).length === 0
    && state.subagentCost.length === 0 && state.tokens.input === 0, JSON.stringify({ main: state.mainCost, sub: state.subagentCost }))
}

{
  const state = { rows: [] as unknown[], subagents: [] as unknown[], subagentCost: [] as unknown[], emit: noop, emitStream: noop }
  const projection = createSubagentProjection(() => state as never, {
    rowIds: { value: 0 },
    agent: () => ({}) as never,
    subagents: () => undefined,
    lookupChild: () => undefined,
  })
  projection.onStart({ id: 'child-mirror', provider: 'deepseek-official' })
  projection.store.patch('child-mirror', { model: 'deepseek-v4-flash' })
  projection.store.onSessionEvent('child-mirror', durableMessage(1, PEAK, { inputTokens: 42, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }))
  projection.syncNow()
  const mirror = state.subagentCost as Array<{ provider: string; model: string; buckets: { peak: { input: number; output: number } } }>
  check('subagent-projection.syncNow 镜像 store 费用快照', mirror.length === 1
    && mirror[0]?.provider === 'deepseek-official' && mirror[0]?.model === 'deepseek-v4-flash'
    && mirror[0]?.buckets.peak.input === 42 && mirror[0]?.buckets.peak.output === 7, JSON.stringify(mirror))
  projection.reset()
  check('subagent-projection.reset 清空镜像', (state.subagentCost as unknown[]).length === 0)
}

// ═════════════════════ AC-A7：零金额 + 未计价 token 的状态栏/hover 可见性 ═════════════════════
// 仅未计价用量（total=0、unpricedTokens>0）不得被"有金额才显示"的旧门禁吃掉，
// 否则用户看到 token 在涨却没有任何"未计价"说明。渲染探针走真实 Ink 树 +
// xterm 鼠标悬停（与 verify-hover-details 同款 SGR 1003 注入）。

{
  const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, termTest, { StatusLine }] = await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('./lib/term-test.mjs'),
    import('../src/screens/StatusLine.js'),
  ])
  const { settled, screenHas, findText, viewportLines } = termTest
  const { render, AlternateScreen, Box, useInput } = ui

  const COLS = 100
  const ROWS = 8
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: unknown, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const screenText = (): string => viewportLines(term).join('\n')

  function KeySink(): unknown {
    useInput(() => {})
    return null
  }

  // 官方 provider + 未收录模型：token 有，金额恒为 0，unpricedTokens=150。
  const UNPRICED_MODEL = 'gpt-4o-unpriced-probe'
  const channel = {
    minimal: false,
    statusBar: { cost: true },
    provider: 'deepseek',
    model: 'unpriced-probe-model',
    mainCost: {
      [UNPRICED_MODEL]: {
        peak: { input: 150, output: 0, cacheRead: 0, cacheWrite: 0 },
        idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    subagentCost: [],
    tokens: { input: 150, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastUsage: undefined,
    contextWindow: undefined,
    contextBarEnabled: false,
    contextSegments: {},
    mode: { plan: false },
    modeIndex: 0,
    cwd: 'C:/work/unpriced-probe',
    displayCwd: 'C:/work/unpriced-probe',
    tpsSamples: [],
    reasoningEffort: undefined,
    working: false,
    activityFrames: [],
    goal: undefined,
    sessionTitle: undefined,
    agentId: 'unpriced-probe',
    gitBranch: undefined,
    tps: undefined,
  }
  const instance = await render(
    <AlternateScreen>
      <Box flexDirection="column">
        <KeySink />
        <StatusLine channel={channel as never} />
      </Box>
    </AlternateScreen>,
    { stdout, stderr: stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  check('AC-A7 仅未计价：状态栏显示未计价标注',
    await settled(() => screenHas(term, '未计价')), screenText())

  // 悬停费用字段：明细行应同时给金额拆解与未计价 token（`peak ` 是 hover 独有）。
  const at = findText(term, '未计价')
  if (at !== null) stdin.write(`\x1b[<35;${at.col + 1};${at.row + 1}M`)
  check('AC-A7 仅未计价：hover 明细同口径显示未计价',
    await settled(() => screenHas(term, 'peak ') && screenHas(term, '未计价')), screenText())

  await instance.unmount()
  term.dispose()
}

// ═════════════════════ T07：/cost 末尾文案与"估算非账单"口径一致 ═════════════════════
// 旧 `cost-note` 声称"DSH 不提供 API 费用计量"，与同屏金额/拆解及 T03 同步的
// 文档口径矛盾（issue #1089）。这里锁死词条语义与 /cost 的分支选择，防止回退。

{
  const legacyClaim = /不提供 API 费用计量|provides no API cost metering/i
  const asText = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object') {
      const forms = value as { one?: unknown; other?: unknown }
      return [forms.one, forms.other].filter(part => typeof part === 'string').join(' · ')
    }
    return ''
  }
  const priceNoteZh = asText(i18nDict['cost-note']?.zh)
  const priceNoteEn = asText(i18nDict['cost-note']?.en)
  check('T07 cost-note 不再声称 DSH 不提供费用计量',
    !legacyClaim.test(priceNoteZh) && !legacyClaim.test(priceNoteEn), `${priceNoteZh} | ${priceNoteEn}`)
  check('T07 cost-note = 本地估算（官方单价 × 用量）、非平台账单',
    /本地估算/.test(priceNoteZh) && /非平台账单/.test(priceNoteZh)
    && /local estimate/.test(priceNoteEn) && /not a platform bill/.test(priceNoteEn),
    `${priceNoteZh} | ${priceNoteEn}`)
  const noAmountZh = asText(i18nDict['cost-note-no-amount']?.zh)
  const noAmountEn = asText(i18nDict['cost-note-no-amount']?.en)
  check('T07 无金额分支词条 zh/en 均存在', noAmountZh !== '' && noAmountEn !== '',
    JSON.stringify(i18nDict['cost-note-no-amount']))
  check('T07 无金额分支只解释 token、不套用金额口径也不说"不提供计量"',
    /token/.test(noAmountZh) && !legacyClaim.test(noAmountZh) && !legacyClaim.test(noAmountEn),
    `${noAmountZh} | ${noAmountEn}`)
  const chatSource = readFileSync(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
  check('T07 /cost 按有无金额选择末尾词条（不再无条件 cost-note）',
    /\?\s*'cost-note'\s*:\s*'cost-note-no-amount'/.test(chatSource))
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll session-cost checks passed')
