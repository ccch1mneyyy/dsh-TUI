/**
 * DeepSeek 官方账户余额查询（host 层）。
 *
 * 只服务官方 base URL（api.deepseek.com）：非官方网关没有官方余额语义，
 * 查询返回 undefined，状态栏整行隐藏（与 ds-balance 插件同款降级语义）。
 * key 只在本模块内经 credentials 服务解析，明文不进 React 层。
 */

import type { Balance } from './channel.js'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const OFFICIAL_HOST = 'api.deepseek.com'
const QUERY_TIMEOUT_MS = 8000
/** 成功结果缓存时长（防频繁点击/重渲染触发的重复查询）。 */
const CACHE_MS = 60_000

let cachedAt = 0
let cachedResult: Balance | undefined
let inFlight: Promise<Balance | undefined> | null = null

/** base URL 主机不是官方 api.deepseek.com 即视为非官方。 */
export function isOfficialHost(base: string): boolean {
  const match = /^https?:\/\/([^/?#]+)/.exec(base)
  if (match === null) return false
  const host = match[1]
  return host === OFFICIAL_HOST || host.startsWith(OFFICIAL_HOST + ':')
}

/** 余额展示：CNY → `¥68.64`，USD → `$68.64`，其他货币 → `EUR 68.64`。 */
export function formatBalance(balance: { total: number; currency: string }): string {
  const amount = balance.total.toFixed(2)
  switch (balance.currency.toUpperCase()) {
    case 'CNY':
      return `¥${amount}`
    case 'USD':
      return `$${amount}`
    default:
      return `${balance.currency} ${amount}`
  }
}

/** 解析 /user/balance 响应（{is_available, balance_infos:[{total_balance,currency,...}]}）。 */
export function parseBalanceResponse(json: unknown): Balance | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const body = json as Record<string, unknown>
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : []
  const info = infos[0]
  if (typeof info !== 'object' || info === null) return undefined
  const total = Number((info as Record<string, unknown>).total_balance)
  if (!Number.isFinite(total)) return undefined
  const currency = (info as Record<string, unknown>).currency
  return {
    total,
    currency:
      typeof currency === 'string' && currency !== '' ? currency : 'CNY',
    // 缺省视为可用（旧字段兼容）；明确 false 才是预警信号。
    isAvailable: body.is_available !== false,
  }
}

interface CredentialsService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** 查询一次余额；非官方/无 key/网络失败一律返回 undefined（静默）。 */
export async function queryBalance(ctx: {
  get(name: 'credentials'): CredentialsService | undefined
}): Promise<Balance | undefined> {
  if (cachedResult !== undefined && Date.now() - cachedAt < CACHE_MS) {
    return cachedResult
  }
  if (inFlight !== null) return inFlight
  const run = fetchBalance(ctx).catch(() => undefined)
  inFlight = run.then((result) => {
    if (result !== undefined) {
      cachedResult = result
      cachedAt = Date.now()
    }
    return result
  })
  return inFlight.finally(() => {
    inFlight = null
  })
}

async function fetchBalance(ctx: {
  get(name: 'credentials'): CredentialsService | undefined
}): Promise<Balance | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const key = await credentials.resolve('DEEPSEEK_API_KEY')
  if (key === undefined) return undefined
  const baseRef = await credentials.resolve('DEEPSEEK_BASE_URL')
  const base = (baseRef === undefined ? DEFAULT_BASE_URL : baseRef.value)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
  if (!isOfficialHost(base)) return undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS)
  try {
    const response = await fetch(base + '/user/balance', {
      headers: { accept: 'application/json', authorization: 'Bearer ' + key.value },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return parseBalanceResponse(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动余额监控：立即查一次，之后每 intervalMs 查一次。
 * 失败静默（下个周期重试）。返回停止函数（teardown 时调用）。
 */
export function startBalanceMonitor(
  ctx: { get(name: 'credentials'): CredentialsService | undefined },
  onBalance: (balance: Balance | undefined) => void,
  intervalMs = 5 * 60_000,
): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  const tick = async (): Promise<void> => {
    if (stopped) return
    onBalance(await queryBalance(ctx))
    if (stopped) return
    timer = setTimeout(tick, intervalMs)
    timer.unref()
  }
  void tick()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}
