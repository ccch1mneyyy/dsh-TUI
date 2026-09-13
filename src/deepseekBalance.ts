import type { BalanceResult, BalanceInfo } from './adapter/ports/channel-catalog.js'
export type { BalanceResult, BalanceInfo } from './adapter/ports/channel-catalog.js'


/** 查询选项；fetchImpl 供无头回归注入。 */
export interface BalanceQueryOptions {
  /** 覆盖全局 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 覆盖 API 根地址（测试或镜像）。 */
  baseUrl?: string
  /** 超时毫秒数，默认 8000。 */
  timeoutMs?: number
}

export const DEEPSEEK_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'

const DEFAULT_TIMEOUT_MS = 8000

/**
 * 查询 DeepSeek 官方账户余额。
 * @param apiKey - `DEEPSEEK_API_KEY` 值；空字符串返回 no-key。
 * @param options - 查询选项。
 */
export async function fetchBalance(
  apiKey: string,
  options: BalanceQueryOptions = {},
): Promise<BalanceResult> {
  if (apiKey === '') return { ok: false, reason: 'no-key' }
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.baseUrl === undefined
    ? DEEPSEEK_BALANCE_ENDPOINT
    : `${options.baseUrl.replace(/\/+$/, '')}/user/balance`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', status: response.status }
    }
    if (!response.ok) {
      return { ok: false, reason: 'http', status: response.status }
    }
    const payload: unknown = await response.json().catch(() => undefined)
    const parsed = parseBalancePayload(payload)
    return parsed ?? { ok: false, reason: 'invalid' }
  } catch {
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

function parseBalancePayload(payload: unknown): Extract<BalanceResult, { ok: true }> | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const infos = record.balance_infos
  if (!Array.isArray(infos)) return undefined
  const balances: BalanceInfo[] = []
  for (const raw of infos) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const info = raw as Record<string, unknown>
    const currency = info.currency
    const total = parseCny(info.total_balance)
    const granted = parseCny(info.granted_balance)
    const toppedUp = parseCny(info.topped_up_balance)
    if (typeof currency !== 'string' || currency === '' || total === undefined || granted === undefined || toppedUp === undefined) {
      return undefined
    }
    balances.push({ currency, total, granted, toppedUp })
  }
  return {
    ok: true,
    isAvailable: record.is_available === true,
    balances,
  }
}

function parseCny(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
