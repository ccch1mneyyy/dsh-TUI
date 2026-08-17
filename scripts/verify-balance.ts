/**
 * Balance-module checks: official-host gating and /user/balance response
 * parsing stay correct — non-official gateways must never render, malformed
 * payloads must never crash the status footer.
 *
 * Run via `node --import tsx/esm scripts/verify-balance.ts`.
 */
import { formatBalance, isOfficialHost, parseBalanceResponse } from '../src/dsh-adapter/balance.js'

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return
  failures += 1
  console.error(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---- isOfficialHost: 官方主机判定（决定整行显示/隐藏） ----
check('official https', isOfficialHost('https://api.deepseek.com'), true)
check('official /v1 suffix', isOfficialHost('https://api.deepseek.com/v1'), true)
check('official port', isOfficialHost('https://api.deepseek.com:443'), true)
check('official http', isOfficialHost('http://api.deepseek.com'), true)
check('gateway rejected', isOfficialHost('https://ark.cn-beijing.volces.com'), false)
check('proxy rejected', isOfficialHost('https://api.deepseek.com.example.com'), false)
check('garbage rejected', isOfficialHost('not a url'), false)
check('empty rejected', isOfficialHost(''), false)

// ---- parseBalanceResponse: 余额响应解析 ----
check('undefined payload', parseBalanceResponse(undefined), undefined)
check('null payload', parseBalanceResponse(null), undefined)
check('empty body', parseBalanceResponse({}), undefined)
check('empty infos', parseBalanceResponse({ balance_infos: [] }), undefined)
check('info without balance', parseBalanceResponse({ balance_infos: [{}] }), undefined)
check('non-numeric balance', parseBalanceResponse({ balance_infos: [{ total_balance: 'abc' }] }), undefined)
const stringTotal = parseBalanceResponse({ balance_infos: [{ total_balance: '68.64' }] })
check('string total parsed', stringTotal?.total, 68.64)
check('default currency CNY', stringTotal?.currency, 'CNY')
check('default is available', stringTotal?.isAvailable, true)
const usd = parseBalanceResponse({ balance_infos: [{ total_balance: 12.5, currency: 'USD' }] })
check('numeric total parsed', usd?.total, 12.5)
check('currency kept', usd?.currency, 'USD')
const zero = parseBalanceResponse({ balance_infos: [{ total_balance: 0 }] })
check('zero is a valid balance', zero?.total, 0)
check('zero keeps currency', zero?.currency, 'CNY')
const unavailable = parseBalanceResponse({ is_available: false, balance_infos: [{ total_balance: '0.5' }] })
check('is_available false parsed', unavailable?.isAvailable, false)
const explicitAvailable = parseBalanceResponse({ is_available: true, balance_infos: [{ total_balance: '1' }] })
check('is_available true parsed', explicitAvailable?.isAvailable, true)

// ---- formatBalance: 余额展示格式 ----
check('CNY format', formatBalance({ total: 68.64, currency: 'CNY' }), '¥68.64')
check('USD format', formatBalance({ total: 12.5, currency: 'USD' }), '$12.50')
check('other currency', formatBalance({ total: 7, currency: 'EUR' }), 'EUR 7.00')

if (failures > 0) {
  console.error(`balance checks failed (${failures})`)
  process.exit(1)
}
console.log('balance checks OK (parse + official-host gating)')
