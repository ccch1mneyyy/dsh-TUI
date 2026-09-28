/**
 * DeepSeek 官方定价与"本会话花费"估算（人民币口径）。
 *
 * 数据来源：DeepSeek 官方文档「模型 & 价格」页（2026-09 快照，含
 * V4.1-Flash 发布调价），单位为人民
 * 币/百万 tokens。DeepSeek 官方 API 只返回 token 用量、不返回金额，本模块按
 * 官方公开单价把会话累计 token 换算成金额 —— 这是**估算**，不是账单：
 * 定价可能变动，且余额扣费发生在 DeepSeek 侧（以平台账单为准）。
 *
 * 计价规则（来自官方页面）：
 *  - 扣减费用 = token 消耗量 × 模型单价；
 *  - 缓存命中的输入按命中价计费，其余输入（含写入缓存）按未命中价计费；
 *  - 高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，其余为空闲时段
 *    （空闲价为高峰价的一半）。
 */

/** 单价对：`[空闲价, 高峰价]`，单位 元/百万 tokens。 */
export type CnyPerMillion = readonly [number, number]

/** 一个官方模型的完整价目（人民币/百万 tokens）。 */
export interface DeepSeekModelPrice {
  /** 输入（缓存未命中，含写入缓存部分）。 */
  inputMiss: CnyPerMillion
  /** 输入（缓存命中）。 */
  inputHit: CnyPerMillion
  /** 输出。 */
  output: CnyPerMillion
}

/**
 * 在售模型价目表，按 API model id 前缀匹配（最长前缀优先）。
 * 新模型上线而本表未收录时，估算返回 undefined，界面不显示金额（只显示
 * token 用量），不会给出错误数字。
 */
export const DEEPSEEK_MODEL_PRICES: Readonly<Record<string, DeepSeekModelPrice>> = {
  // DeepSeek-V41-Flash（2026-09-10 发布并取代 V4-Pro 后的下调价目）。
  'deepseek-flash': {
    inputMiss: [1.0, 2.0],
    inputHit: [0.02, 0.04],
    output: [4.0, 8.0],
  },
  // issue #857：官方已按 Flash 价计费 V4.1-Flash 的正式 id 与 vision 实验 id；
  // V4-Pro 已下线，不再保留价目行（未收录 → priceForModel 返回 undefined，
  // 界面只展示 token、不给金额）。
  'deepseek-v4-flash': {
    inputMiss: [1.0, 2.0],
    inputHit: [0.02, 0.04],
    output: [4.0, 8.0],
  },
  'deepseek-v4-flash-vision-exp': {
    inputMiss: [1.0, 2.0],
    inputHit: [0.02, 0.04],
    output: [4.0, 8.0],
  },
}

/**
 * DeepSeek 官方 API key 路由（余额/花费估算只对它们有意义）。参考社区
 * dsh-balance 的 provider 判定：DSH 自带官方路由 `deepseek-official`
 * （modelRoute.ts 默认路由），另兼容裸 `deepseek` 与 dsh-vision-router
 * 的 `deepseek-vision` 包装路由。
 */
export const DEEPSEEK_OFFICIAL_PROVIDERS: readonly string[] = [
  'deepseek',
  'deepseek-official',
  'deepseek-vision',
]

/** 是否 DeepSeek 官方 provider（余额与定价只适用于官方计费口径）。 */
export function isDeepSeekOfficialProvider(provider: string): boolean {
  return DEEPSEEK_OFFICIAL_PROVIDERS.includes(provider)
}

/**
 * 是否处于高峰计费时段：北京时间周一至周五 9:00-12:00、14:00-18:00。
 * 北京时间为 UTC+8 固定偏移（无夏令时），用 UTC 时刻加偏移换算。
 */
export function isPeakHour(date: Date = new Date()): boolean {
  const shifted = new Date(date.getTime() + 8 * 3_600_000)
  const weekday = shifted.getUTCDay() // 0 = Sunday
  const hour = shifted.getUTCHours()
  if (weekday === 0 || weekday === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 按前缀匹配模型价目，最长前缀优先；未收录返回 undefined。 */
export function priceForModel(model: string): DeepSeekModelPrice | undefined {
  let best: DeepSeekModelPrice | undefined
  let bestLength = 0
  for (const [prefix, price] of Object.entries(DEEPSEEK_MODEL_PRICES)) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = price
      bestLength = prefix.length
    }
  }
  return best
}

/** 会话累计 token（与 Channel.tokens 同构，含缓存分项）。 */
export interface CostTokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 按计价时段分桶的会话 token：每笔 usage 按其发生时刻（event.time）落入
 * 高峰或空闲桶，估算时各按对应单价——跨时段会话不会整段按当前时段计价。
 */
export interface CostTokenBuckets {
  peak: CostTokenTotals
  idle: CostTokenTotals
}

/** 空桶（防御 tokens.peak/idle 缺失的旧数据/测试桩）。 */
const EMPTY_TOTALS: Readonly<CostTokenTotals> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

/** 按高峰/空闲单价分别计价，返回 [高峰元, 空闲元]（未除 1e6）。 */
function costSplit(
  tokens: CostTokenBuckets,
  price: DeepSeekModelPrice,
): { peak: number; idle: number } {
  // 分桶字段在真实 Channel 上恒有（emptyTokenUsage 初始化），但旧快照与
  // 测试桩可能缺桶——缺失时按空桶计，绝不抛错。
  const peak = tokens.peak ?? EMPTY_TOTALS
  const idle = tokens.idle ?? EMPTY_TOTALS
  const costOf = (bucket: CostTokenTotals, rateIndex: 0 | 1): number => {
    const input = Math.max(0, bucket.input)
    const output = Math.max(0, bucket.output)
    const cacheRead = Math.max(0, Math.min(input, bucket.cacheRead))
    return (input - cacheRead) * price.inputMiss[rateIndex]
      + cacheRead * price.inputHit[rateIndex]
      + output * price.output[rateIndex]
  }
  return {
    peak: costOf(peak, 1),
    idle: costOf(idle, 0),
  }
}

/**
 * 估算本会话花费拆分（人民币，元）：高峰桶按高峰价、空闲桶按空闲价。
 * 公式（每桶）：(input − cacheRead) × 输入未命中价 + cacheRead × 输入命中价
 * + output × 输出价；cacheWrite 不单独计价（写入缓存的 token 已计入 input
 * 的未命中部分）。模型未收录或所有 token 均为零时返回 undefined（调用方
 * 不显示金额）。这是**估算**，不是账单——定价可能变动，以 DeepSeek 平台
 * 账单为准。
 * @param tokens - 按计价时段分桶的会话累计 token。
 * @param model - 当前模型 id（前缀匹配价目）。
 */
export function estimateSessionCostSplitCny(
  tokens: CostTokenBuckets,
  model: string,
): { total: number; peak: number; idle: number } | undefined {
  const price = priceForModel(model)
  if (price === undefined) return undefined
  const split = costSplit(tokens, price)
  const peak = tokens.peak ?? EMPTY_TOTALS
  const idle = tokens.idle ?? EMPTY_TOTALS
  const totalTokens =
    peak.input + peak.output + idle.input + idle.output
  if (totalTokens <= 0) return undefined
  return {
    total: split.peak / 1_000_000 + split.idle / 1_000_000,
    peak: split.peak / 1_000_000,
    idle: split.idle / 1_000_000,
  }
}

/**
 * 估算本会话花费（人民币，元）——estimateSessionCostSplitCny 的总价捷径。
 */
export function estimateSessionCostCny(
  tokens: CostTokenBuckets,
  model: string,
): number | undefined {
  return estimateSessionCostSplitCny(tokens, model)?.total
}

/** 一笔增量 usage（durable assistant/message.usage 的计价字段）。 */
export type CostUsageDelta = Partial<CostTokenTotals>

/** 空的峰谷分桶（新模型 / 新会话累计起点）。 */
export function emptyCostBuckets(): CostTokenBuckets {
  return {
    peak: { ...EMPTY_TOTALS },
    idle: { ...EMPTY_TOTALS },
  }
}

/** 深拷贝分桶，供快照镜像（调用方拿到后修改不得影响累计源）。 */
export function cloneCostBuckets(buckets: CostTokenBuckets): CostTokenBuckets {
  return {
    peak: { ...(buckets.peak ?? EMPTY_TOTALS) },
    idle: { ...(buckets.idle ?? EMPTY_TOTALS) },
  }
}

/**
 * 把一笔 usage 按计价时段累加进分桶（in-place）。durable 事件按发生时刻
 * 落桶，峰/谷单价不同；cacheRead/cacheWrite 作为分项保留（cacheRead 计价
 * 时按命中价，见 costSplit）。
 */
export function addUsageToCostBuckets(
  buckets: CostTokenBuckets,
  usage: CostUsageDelta,
  peak: boolean,
): void {
  const bucket = peak ? buckets.peak : buckets.idle
  bucket.input += usage.input ?? 0
  bucket.output += usage.output ?? 0
  bucket.cacheRead += usage.cacheRead ?? 0
  bucket.cacheWrite += usage.cacheWrite ?? 0
}

/** 一笔待计价用量：provider 决定官方与否，model 查价目，buckets 为峰谷分桶。 */
export interface CostBucketEntry {
  readonly provider: string
  readonly model: string
  readonly buckets: CostTokenBuckets
  /** 展示分侧（主会话 / 子代理）；缺省按主会话处理（兼容旧调用）。 */
  readonly scope?: 'main' | 'subagent'
}

/** 多模型桶计价选项。 */
export interface EstimateCostOptions {
  /** 默认 true：非官方 provider 一律不估价（只计入 unpriced）。false 时
   *  非官方 provider 也按 model 价目估算（调用方自担口径）。 */
  readonly officialOnly?: boolean
}

/** 多模型桶计价结果：金额按展示分侧拆解，未计价 token 单独上报。 */
export interface SessionCostEstimate {
  /** 已计价总额（元）＝ main + subagent。 */
  readonly total: number
  /** 主会话部分（元）。 */
  readonly main: number
  /** 子代理部分（元）。 */
  readonly subagent: number
  /** 高峰时段部分（元）。 */
  readonly peak: number
  /** 空闲时段部分（元）。 */
  readonly idle: number
  /** 未能计价的用量 token（非官方 provider / 价目未收录）：只展示，不计金额。 */
  readonly unpricedTokens: number
}

/** 分桶里的计价 token 总数（input 含 cacheRead，与既有显示口径一致）。 */
function bucketTokenTotal(buckets: CostTokenBuckets): number {
  const peak = buckets.peak ?? EMPTY_TOTALS
  const idle = buckets.idle ?? EMPTY_TOTALS
  return peak.input + peak.output + idle.input + idle.output
}

/**
 * 多模型桶计价纯函数：逐条目查价求和，金额按 scope 拆成主会话/子代理，
 * 非官方 provider 或未收录模型计入 unpriced（只上报 token，不给金额）。
 * 所有条目都是零 token 时返回 undefined（调用方不显示金额）。
 * 空 provider 表示旧快照/测试桩（生产契约里 provider 恒有）——不武断视为
 * 非官方，按 model 价目估算，避免既有展示静默少算。
 */
export function estimateCostFromBucketsCny(
  entries: readonly CostBucketEntry[],
  options: EstimateCostOptions = {},
): SessionCostEstimate | undefined {
  const officialOnly = options.officialOnly !== false
  let total = 0
  let main = 0
  let subagent = 0
  let peak = 0
  let idle = 0
  let unpricedTokens = 0
  let tokenCount = 0
  for (const entry of entries) {
    const tokens = bucketTokenTotal(entry.buckets)
    tokenCount += tokens
    const priceable = !officialOnly
      || entry.provider === ''
      || isDeepSeekOfficialProvider(entry.provider)
    const price = priceable ? priceForModel(entry.model) : undefined
    if (price === undefined) {
      unpricedTokens += tokens
      continue
    }
    const split = costSplit(entry.buckets, price)
    const amount = (split.peak + split.idle) / 1_000_000
    total += amount
    peak += split.peak / 1_000_000
    idle += split.idle / 1_000_000
    if (entry.scope === 'subagent') subagent += amount
    else main += amount
  }
  if (tokenCount <= 0) return undefined
  return { total, main, subagent, peak, idle, unpricedTokens }
}

/** 费用估算输入：主会话按模型桶 + 子代理按 (provider, model) 桶。 */
export interface SessionCostInput {
  /** 主会话当前 provider（主会话条目的官方判定；空串 = 旧快照）。 */
  readonly provider: string
  /** 主会话按模型分桶（ChannelState.mainCost）。 */
  readonly main?: Readonly<Record<string, CostTokenBuckets>> | undefined
  /** 子代理按 (provider, model) 分桶（ChannelState.subagentCost）。 */
  readonly subagents?: readonly {
    readonly provider: string
    readonly model: string
    readonly buckets: CostTokenBuckets
  }[] | undefined
  /** main 缺失/为空时的回退 token（旧快照/测试桩没有 mainCost 时用
   *  channel.tokens + 当前模型，保持既有展示不消失）。 */
  readonly fallbackTokens?: CostTokenBuckets | undefined
  readonly fallbackModel?: string | undefined
}

/**
 * 汇总一次费用估算的输入条目：主会话按模型分桶优先；没有分桶的旧快照
 * 回退到 `channel.tokens` + 当前模型（不叠加，避免双计）；子代理条目
 * 追加在后。纯函数，不修改入参。
 */
export function collectSessionCostEntries(input: SessionCostInput): CostBucketEntry[] {
  const entries: CostBucketEntry[] = []
  const main = input.main ?? {}
  const mainModels = Object.keys(main)
  if (mainModels.length > 0) {
    for (const model of mainModels) {
      const buckets = main[model]
      if (buckets !== undefined) entries.push({ provider: input.provider, model, buckets, scope: 'main' })
    }
  } else if (input.fallbackTokens !== undefined && input.fallbackModel !== undefined && input.fallbackModel !== '') {
    entries.push({ provider: input.provider, model: input.fallbackModel, buckets: input.fallbackTokens, scope: 'main' })
  }
  for (const subagent of input.subagents ?? []) {
    entries.push({ provider: subagent.provider, model: subagent.model, buckets: subagent.buckets, scope: 'subagent' })
  }
  return entries
}

/** collectSessionCostEntries + estimateCostFromBucketsCny 的展示侧捷径。 */
export function estimateSessionCostSnapshotCny(
  input: SessionCostInput,
  options: EstimateCostOptions = {},
): SessionCostEstimate | undefined {
  return estimateCostFromBucketsCny(collectSessionCostEntries(input), options)
}
