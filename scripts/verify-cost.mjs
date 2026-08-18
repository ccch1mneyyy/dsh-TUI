/**
 * Headless verification of the spend estimate (pricing.ts), the local usage
 * ledger (usageLedger.ts), and the channel wiring behind `/cost` and
 * `/usage`.
 *
 * The money path has no visible failure mode — a wrong rate, a missed
 * off-peak boundary, a silently dropped override file, or a replay counted
 * twice all render as a plausible number — so the arithmetic, the peak
 * schedule, the override merge, the ledger rollup, and the replay gate are
 * all pinned here.
 *
 * Run against the compiled lib: `node scripts/verify-cost.mjs`
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The data directory is resolved when the lib modules evaluate, so the home
// redirect has to happen before they are imported — a channel-level test
// must never append to the real ~/.dsh-tui/usage.jsonl.
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-tui-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const [pricing, ledger, channelModule, paths] = await Promise.all([
  import('../lib/types/pricing.js'),
  import('../lib/types/usageLedger.js'),
  import('../lib/types/dsh-adapter/channel.js'),
  import('../lib/types/utils/paths.js'),
])
const { BUILT_IN_PRICES, estimateCost, findModelPrice, formatAmount, isOffPeak, parsePriceTable } = pricing
const { appendUsageRecord, parseUsageRecord, readUsageRecords, summarizeUsage } = ledger
const { createChannel } = channelModule

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const near = (a, b) => Math.abs(a - b) < 1e-9

// ── 1. Peak schedule ──────────────────────────────────────────────────────
// DeepSeek peak windows are 01:00-04:00 and 06:00-10:00 UTC, half-open.

const at = (h, m = 0) => Date.UTC(2026, 7, 18, h, m)
check('00:30 UTC is off-peak', isOffPeak(BUILT_IN_PRICES, at(0, 30)))
check('01:00 UTC starts peak', !isOffPeak(BUILT_IN_PRICES, at(1)))
check('03:59 UTC is still peak', !isOffPeak(BUILT_IN_PRICES, at(3, 59)))
check('04:00 UTC ends peak', isOffPeak(BUILT_IN_PRICES, at(4)))
check('06:00 UTC starts the second window', !isOffPeak(BUILT_IN_PRICES, at(6)))
check('09:59 UTC is still peak', !isOffPeak(BUILT_IN_PRICES, at(9, 59)))
check('10:00 UTC ends peak', isOffPeak(BUILT_IN_PRICES, at(10)))
check('23:00 UTC is off-peak', isOffPeak(BUILT_IN_PRICES, at(23)))

const wrapping = parsePriceTable(JSON.stringify({ peakWindowsUtc: [['22:00', '02:00']] }))
check('a window wrapping midnight covers 23:00', !isOffPeak(wrapping, at(23)))
check('a window wrapping midnight covers 01:00', !isOffPeak(wrapping, at(1)))
check('a window wrapping midnight excludes 12:00', isOffPeak(wrapping, at(12)))

// ── 2. Model matching ─────────────────────────────────────────────────────

check('exact model id', findModelPrice(BUILT_IN_PRICES, 'deepseek-v4-pro')?.output === 3.96)
check(
  'dated release inherits its family',
  findModelPrice(BUILT_IN_PRICES, 'deepseek-v4-pro-0813')?.output === 3.96,
)
check('unknown model has no price', findModelPrice(BUILT_IN_PRICES, 'gpt-tuned-7b') === undefined)
{
  const table = parsePriceTable(JSON.stringify({
    models: { 'deepseek-v4': { cacheHitInput: 1, input: 1, output: 1 } },
  }))
  check(
    'longest prefix wins over a shorter one',
    findModelPrice(table, 'deepseek-v4-pro')?.output === 3.96,
  )
}

// ── 3. Cost arithmetic ────────────────────────────────────────────────────

const oneMillionEach = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }
check(
  'peak rate: 1M of each kind on v4-pro',
  near(estimateCost(BUILT_IN_PRICES, 'deepseek-v4-pro', oneMillionEach, at(2)), 1.32 + 3.96 + 0.044),
)
check(
  'off-peak halves the same turn',
  near(estimateCost(BUILT_IN_PRICES, 'deepseek-v4-pro', oneMillionEach, at(12)), (1.32 + 3.96 + 0.044) / 2),
)
check(
  'cache writes bill at the cache-miss rate by default',
  near(
    estimateCost(BUILT_IN_PRICES, 'deepseek-v4-pro', { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, at(2)),
    1.32,
  ),
)
check(
  'an unpriced model yields no estimate',
  estimateCost(BUILT_IN_PRICES, 'mystery-model', oneMillionEach, at(2)) === undefined,
)
check(
  'a zero-token turn costs nothing',
  near(estimateCost(BUILT_IN_PRICES, 'deepseek-v4-pro', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, at(2)), 0),
)

// ── 4. Override file ──────────────────────────────────────────────────────

check('unparseable JSON keeps the built-in list', parsePriceTable('{oh no') === BUILT_IN_PRICES)
check('a JSON array keeps the built-in list', parsePriceTable('[]') === BUILT_IN_PRICES)
{
  const table = parsePriceTable(JSON.stringify({
    currency: 'CNY',
    asOf: '2030-01-01',
    models: {
      'deepseek-v4-pro': { cacheHitInput: 0.5, input: 4, output: 12 },
      'broken-model': { cacheHitInput: 1, output: 2 },
    },
  }))
  check('currency overrides', table.currency === 'CNY')
  check('asOf overrides', table.asOf === '2030-01-01')
  check('source is marked as the user file', table.source === 'user')
  check('a named model is replaced', table.models['deepseek-v4-pro'].output === 12)
  check('unnamed models are kept', table.models['deepseek-v4-flash'].output === 1.32)
  check('an entry missing a rate is dropped', table.models['broken-model'] === undefined)
  check('an absent peak schedule keeps the built-in one', table.peakWindowsUtc.length === 2)
}
{
  const table = parsePriceTable(JSON.stringify({ peakWindowsUtc: [['01:00', '04:00'], ['nope', '04:00']] }))
  check('a malformed window is dropped, the valid one kept', table.peakWindowsUtc.length === 1)
}

check('small amounts keep four decimals', formatAmount(0.0123456, 'USD') === '$0.0123')
check('large amounts round to cents', formatAmount(12.3456, 'USD') === '$12.35')
check('CNY renders with its own symbol', formatAmount(1.5, 'CNY') === '¥1.50')
check('an unknown currency renders as a suffix', formatAmount(1.5, 'XYZ') === '1.50 XYZ')

// ── 5. Ledger ─────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-usage-'))
try {
  check('an empty ledger reads as no history', readUsageRecords(dir).length === 0)
  check('summary of nothing is empty', summarizeUsage([], Date.now()).all.turns === 0)

  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  const record = (ageDays, model, amount, extra = {}) => ({
    at: now - ageDays * day,
    session: 's1',
    provider: 'deepseek-official',
    model,
    input: 1000,
    output: 200,
    cacheRead: 5000,
    cacheWrite: 0,
    amount,
    currency: 'USD',
    ...extra,
  })

  appendUsageRecord(record(0, 'deepseek-v4-pro', 0.01), dir)
  appendUsageRecord(record(3, 'deepseek-v4-pro', 0.02), dir)
  appendUsageRecord(record(20, 'deepseek-v4-flash', 0.03), dir)
  appendUsageRecord(record(90, 'deepseek-v4-flash', 0.04), dir)
  check('records round-trip through the file', readUsageRecords(dir).length === 4)

  // A killed process mid-append leaves a partial line; it must cost one
  // record, not the whole history.
  const path = join(dir, 'usage.jsonl')
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"at":123,"model":"trunc`)
  check('a truncated tail line is skipped', readUsageRecords(dir).length === 4)
  check('a truncated line parses as undefined', parseUsageRecord('{"at":1,"mo') === undefined)
  check('a non-object line parses as undefined', parseUsageRecord('42') === undefined)

  const summary = summarizeUsage(readUsageRecords(dir), now)
  check('today counts only today', summary.today.turns === 1)
  check('the 7-day window counts two', summary.week.turns === 2)
  check('the 30-day window counts three', summary.month.turns === 3)
  check('all time counts four', summary.all.turns === 4)
  check('amounts sum per window', near(summary.week.amount, 0.03))
  check('all-time amount sums everything', near(summary.all.amount, 0.10))
  check('tokens sum per window', summary.today.cacheRead === 5000 && summary.today.input === 1000)
  check('since is the oldest record', summary.since === now - 90 * day)
  check('models roll up largest spend first', summary.models[0].model === 'deepseek-v4-flash')
  check('per-model turns are counted', summary.models[0].turns === 2)
  check(
    'per-model tokens sum every kind',
    summary.models[0].tokens === 2 * (1000 + 200 + 5000),
  )

  // A record priced in another currency must not be added to the total.
  const mixed = summarizeUsage(
    [record(0, 'deepseek-v4-pro', 1, { currency: 'CNY' }), record(0, 'deepseek-v4-pro', 2)],
    now,
  )
  check('mixed currencies report the newest priced one', mixed.currency === 'USD')
  check('a foreign-currency record is not summed', near(mixed.all.amount, 2))
  check('a foreign-currency record counts as unpriced', mixed.all.unpriced === 1)

  // A model with no price entry is recorded but excluded from the total.
  const partial = summarizeUsage(
    [record(0, 'deepseek-v4-pro', undefined), record(0, 'deepseek-v4-pro', 5)],
    now,
  )
  check('an unpriced record still counts its tokens', partial.all.turns === 2)
  check('an unpriced record adds nothing to the amount', near(partial.all.amount, 5))
  check('an unpriced record is flagged', partial.all.unpriced === 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. Channel wiring: replay rebuilds, only live turns are recorded ───────

const peak = at(2)
const usageEvent = (seq, turn, time) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    turn,
    step: 1,
    message: { content: [{ type: 'text', text: 'done' }] },
    usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
})
const turnEvents = (baseSeq, turn, time) => [
  { type: 'turn/start', seq: baseSeq, time, data: { turn } },
  usageEvent(baseSeq + 1, turn, time),
  { type: 'turn/end', seq: baseSeq + 2, time, data: { turn, reason: { kind: 'completed' } } },
]

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get() {
    return undefined
  },
  logger: { warn() {} },
}
const seed = turnEvents(1, 1, peak)
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 3, events: seed },
  ctx: { on: () => () => {} },
}
const channel = createChannel(ctx, agent, {
  model: 'deepseek-v4-pro',
  cwd: '/tmp',
  provider: 'deepseek-official',
  activity: false,
})

// 1M cache-miss input tokens on v4-pro at peak = $1.32.
check('replay folds the session estimate', near(channel.cost.amount, 1.32), String(channel.cost.amount))
check('replay counts the priced turn', channel.cost.pricedTurns === 1)
check('replay reports the table currency', channel.cost.currency === 'USD')
check('the channel exposes the price table', channel.priceTable.asOf === BUILT_IN_PRICES.asOf)

const ledgerPath = join(paths.DATA_DIR, 'usage.jsonl')
if (!paths.DATA_DIR.startsWith(fakeHome)) {
  // Never write to a real home just to assert a test: report instead.
  console.log(`SKIP: data dir was not redirected (${paths.DATA_DIR}); ledger-write assertions skipped`)
} else {
  check('replay writes nothing to the ledger', !existsSync(ledgerPath))

  const sessionHandler = handlers.get('session/event')
  if (sessionHandler === undefined) {
    check('session/event handler captured', false)
  } else {
    for (const event of turnEvents(4, 2, peak)) sessionHandler(agent.session, event)
    check('a live turn adds to the session estimate', near(channel.cost.amount, 2.64), String(channel.cost.amount))
    check('a live turn is recorded once', readUsageRecords(paths.DATA_DIR).length === 1)
    const [written] = readUsageRecords(paths.DATA_DIR)
    check('the record carries the model', written?.model === 'deepseek-v4-pro')
    check('the record carries the priced amount', near(written?.amount ?? 0, 1.32))
    check('the record carries the token counts', written?.input === 1_000_000)
  }
}

rmSync(fakeHome, { recursive: true, force: true })
console.log(failed === 0 ? '\nverify-cost: OK' : `\nverify-cost: ${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
