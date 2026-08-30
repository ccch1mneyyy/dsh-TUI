/**
 * DeepSeek 官方定价与"本会话花费"估算（人民币口径）。
 *
 * 数据来源：DeepSeek 官方文档「模型 & 价格」页（2026-08 快照），单位为人民
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
  'deepseek-v4-flash': {
    inputMiss: [1.5, 3.0],
    inputHit: [0.05, 0.10],
    output: [4.5, 9.0],
  },
  'deepseek-v4-pro': {
    inputMiss: [4.5, 9.0],
    inputHit: [0.15, 0.30],
    output: [13.5, 27.0],
  },
  'deepseek-v4-flash-vision-exp': {
    inputMiss: [1.5, 3.0],
    inputHit: [0.05, 0.10],
    output: [4.5, 9.0],
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
