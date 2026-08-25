/**
 * /balance 与状态栏花费估算回归。
 *
 * Part A —— 两个纯函数模块（不发真实网络请求）：
 *  - fetchBalance（src/deepseekBalance.ts）：余额接口响应解析（多币种、
 *    字符串数字、is_available）、失败分类（401 / HTTP / 网络 / 非法响应 /
 *    空 key）、baseUrl 拼接、超时；
 *  - deepseekPricing（src/deepseekPricing.ts）：官方单价表匹配（最长前缀）、
 *    高峰/空闲时段（北京时间边界）、缓存命中计价、未知模型与零 token 不估算、
 *    官方 provider 判定。
 *
 * Part B —— 真实 Chat 中的 /balance 交互（xterm headless）：
 *  - 输入 /balance 触发恰好一次 balanceInfo，摘要行出现；
 *  - hover 摘要行展开明细（币种拆分、token/花费估算、刷新与关闭 chip）；
 *  - 点击摘要行重新查询；点击 × 关闭报告；
 *  - 失败态（认证失败）摘要与 hover 原因展示。
 *
 * Run: node --import tsx/esm scripts/verify-balance.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { setLang },
  { settle, screenHas, findText, viewportLines, sleep },
  { stringWidth },
  { fetchBalance },
  { estimateSessionCostCny, estimateSessionCostSplitCny, isDeepSeekOfficialProvider, isPeakHour, priceForModel },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
  import('../src/deepseekBalance.js'),
  import('../src/deepseekPricing.js'),
])

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

// ═══════════════════════════ Part A：纯函数逻辑 ═══════════════════════════

// --- fetchBalance：响应解析 ---

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '5.5', granted_balance: '0', topped_up_balance: '5.5' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  check('fetchBalance 成功解析多币种', result.ok, JSON.stringify(result))
  if (result.ok) {
    check('fetchBalance is_available=true', result.isAvailable === true)
    check('fetchBalance 币种数量', result.balances.length === 2)
    const cny = result.balances[0]
    check('fetchBalance 字符串数字转数值', cny?.total === 110 && cny?.granted === 10 && cny?.toppedUp === 100, JSON.stringify(cny))
    check('fetchBalance 币种名', cny?.currency === 'CNY')
  }
}

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response(JSON.stringify({
      is_available: false,
      balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
    }), { status: 200 }),
  })
  check('fetchBalance is_available=false', result.ok && !result.isAvailable, JSON.stringify(result))
}

// --- fetchBalance：失败分类 ---

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response('unauthorized', { status: 401 }),
  })
  check('fetchBalance 401 → unauthorized', !result.ok && result.reason === 'unauthorized' && result.status === 401, JSON.stringify(result))
}

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response('boom', { status: 500 }),
  })
  check('fetchBalance 500 → http', !result.ok && result.reason === 'http' && result.status === 500, JSON.stringify(result))
}

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => { throw new TypeError('ECONNREFUSED') },
  })
  check('fetchBalance 网络异常 → network', !result.ok && result.reason === 'network', JSON.stringify(result))
}

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
  })
  check('fetchBalance 非 JSON → invalid', !result.ok && result.reason === 'invalid', JSON.stringify(result))
}

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response(JSON.stringify({ is_available: true }), { status: 200 }),
  })
  check('fetchBalance 缺 balance_infos → invalid', !result.ok && result.reason === 'invalid', JSON.stringify(result))
}

{
  const result = await fetchBalance('sk-test', {
    fetchImpl: async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: 'abc', granted_balance: '1', topped_up_balance: '2' }],
    }), { status: 200 }),
  })
  check('fetchBalance 非法数字 → invalid', !result.ok && result.reason === 'invalid', JSON.stringify(result))
}

{
  const result = await fetchBalance('', { fetchImpl: async () => new Response('{}', { status: 200 }) })
  check('fetchBalance 空 key → no-key（不发请求）', !result.ok && result.reason === 'no-key', JSON.stringify(result))
}

{
  let calledUrl = ''
  const result = await fetchBalance('sk-test', {
    baseUrl: 'https://mirror.example.com/',
    fetchImpl: async (url) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ is_available: true, balance_infos: [] }), { status: 200 })
    },
  })
  check('fetchBalance baseUrl 拼接去尾斜杠', result.ok && calledUrl === 'https://mirror.example.com/user/balance', calledUrl)
}

{
  // 永不 resolve 的 fetch + 50ms 超时 → network。fake fetch 与真实
  // fetch 一样尊重 AbortSignal：abort 时 reject（AbortError）。
  const result = await fetchBalance('sk-test', {
    timeoutMs: 50,
    fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }),
  })
  check('fetchBalance 超时 → network', !result.ok && result.reason === 'network', JSON.stringify(result))
}

// --- deepseekPricing：时段判断（北京时间） ---

// 北京 = UTC+8：北京 2026-08-17（周一）10:00 = UTC 02:00
const mondayPeak = new Date('2026-08-17T02:00:00Z')
check('isPeakHour 周一北京 10:00 → 高峰', isPeakHour(mondayPeak))
check('isPeakHour 周一北京 13:00 → 空闲', !isPeakHour(new Date('2026-08-17T05:00:00Z')))
check('isPeakHour 周一北京 08:00 → 空闲', !isPeakHour(new Date('2026-08-17T00:00:00Z')))
check('isPeakHour 周一北京 15:00 → 高峰', isPeakHour(new Date('2026-08-17T07:00:00Z')))
check('isPeakHour 周五北京 17:59 → 高峰', isPeakHour(new Date('2026-08-21T09:59:00Z')))
check('isPeakHour 周五北京 18:00 → 空闲', !isPeakHour(new Date('2026-08-21T10:00:00Z')))
check('isPeakHour 周日北京 10:00 → 空闲', !isPeakHour(new Date('2026-08-23T02:00:00Z')))

// --- deepseekPricing：单价匹配 ---

{
  const flash = priceForModel('deepseek-v4-flash')
  check('priceForModel 精确匹配 flash', flash !== undefined && flash.output[1] === 9.0)
  const vision = priceForModel('deepseek-v4-flash-vision-exp')
  check('priceForModel 最长前缀匹配 vision（flash 价）', vision !== undefined && vision.output[1] === 9.0)
  check('priceForModel 未知模型', priceForModel('gpt-4o') === undefined)
}

// --- deepseekPricing：估算（高峰/空闲分桶） ---

/** 构造分桶 token 的快捷方式。 */
const buckets = (peak: Partial<import('../src/deepseekPricing.js').CostTokenTotals>, idle: Partial<import('../src/deepseekPricing.js').CostTokenTotals> = {}) => ({
  peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...peak },
  idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...idle },
})

{
  // 高峰桶 1M 输入（未命中）→ 3.0 元（flash 高峰未命中价）
  const cost = estimateSessionCostCny(buckets({ input: 1_000_000 }), 'deepseek-v4-flash')
  check('估算 高峰桶 1M 输入未命中 = 3.0', cost !== undefined && Math.abs(cost - 3.0) < 1e-9, `cost=${cost}`)
}
{
  // 空闲桶 1M 输入（未命中）→ 1.5 元（flash 空闲未命中价）
  const cost = estimateSessionCostCny(buckets({}, { input: 1_000_000 }), 'deepseek-v4-flash')
  check('估算 空闲桶 1M 输入未命中 = 1.5', cost !== undefined && Math.abs(cost - 1.5) < 1e-9, `cost=${cost}`)
}
{
  // 跨时段会话：高峰 0.2M + 空闲 0.8M 输入 → 0.2×3.0 + 0.8×1.5 = 1.8
  const cost = estimateSessionCostCny(buckets({ input: 200_000 }, { input: 800_000 }), 'deepseek-v4-flash')
  check('估算 跨时段分桶各按对应单价 = 1.8', cost !== undefined && Math.abs(cost - 1.8) < 1e-9, `cost=${cost}`)
}
{
  // 缓存命中计价：高峰桶 1M 输入其中 0.8M 命中 → 0.2×3.0 + 0.8×0.10 = 0.68
  const cost = estimateSessionCostCny(buckets({ input: 1_000_000, cacheRead: 800_000 }), 'deepseek-v4-flash')
  check('估算 缓存命中按命中价 = 0.68', cost !== undefined && Math.abs(cost - 0.68) < 1e-9, `cost=${cost}`)
}
{
  // 输出计价：空闲桶 0.5M 输出 → 0.5×4.5 = 2.25（vision 同 flash 价）
  const cost = estimateSessionCostCny(buckets({}, { output: 500_000 }), 'deepseek-v4-flash-vision-exp')
  check('估算 输出按输出价（vision 前缀）= 2.25', cost !== undefined && Math.abs(cost - 2.25) < 1e-9, `cost=${cost}`)
}
{
  // 拆分函数：高峰/空闲各自金额
  const split = estimateSessionCostSplitCny(buckets({ input: 1_000_000 }, { input: 1_000_000 }), 'deepseek-v4-flash')
  check('估算拆分 peak=3.0 idle=1.5 total=4.5', split !== undefined && Math.abs(split.peak - 3.0) < 1e-9 && Math.abs(split.idle - 1.5) < 1e-9 && Math.abs(split.total - 4.5) < 1e-9, `split=${JSON.stringify(split)}`)
}
{
  // 缓存写超 input 的异常值钳制（防御）
  const cost = estimateSessionCostCny(buckets({ input: 100, cacheRead: 10_000 }), 'deepseek-v4-flash')
  check('估算 cacheRead 超 input 时钳制', cost !== undefined && cost >= 0, `cost=${cost}`)
}
{
  const cost = estimateSessionCostCny(buckets({}, {}), 'deepseek-v4-flash')
  check('估算 零 token → undefined', cost === undefined, `cost=${cost}`)
}
{
  const cost = estimateSessionCostCny(buckets({ input: 1_000 }), 'gpt-4o')
  check('估算 未知模型 → undefined', cost === undefined, `cost=${cost}`)
}

// --- deepseekPricing：官方 provider 判定 ---

check('isDeepSeekOfficialProvider deepseek-official', isDeepSeekOfficialProvider('deepseek-official'))
check('isDeepSeekOfficialProvider deepseek', isDeepSeekOfficialProvider('deepseek'))
check('isDeepSeekOfficialProvider deepseek-vision', isDeepSeekOfficialProvider('deepseek-vision'))
check('isDeepSeekOfficialProvider kimi-coding 为 false', !isDeepSeekOfficialProvider('kimi-coding'))
check('isDeepSeekOfficialProvider 空串为 false', !isDeepSeekOfficialProvider(''))

// ═══════════════════════════ Part B：/balance 交互 ═══════════════════════════

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

/** 视口纯文本（join 后做 includes 断言）。 */
function screenText(target: XTerm): string {
  return viewportLines(target, ROWS).join('\n')
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

/** SGR hover 注入（1-indexed）。 */
const hover = (col: number, row: number) => stdin.write(`\x1b[<35;${col};${row}M`)
/** SGR 点击注入：press+release 同一单元格（1-indexed）。 */
const clickCell = (col: number, row: number) => {
  stdin.write(`\x1b[<0;${col};${row}M`)
  stdin.write(`\x1b[<0;${col};${row}m`)
}

/**
 * findText 的 col 是 JS 字符索引；SGR 鼠标坐标按显示列（CJK 宽字符
 * 占 2 列）。把字符索引换算成显示列。
 */
function cellOf(target: XTerm, pos: { col: number; row: number }): { col: number; row: number } {
  const line = viewportLines(target)[pos.row] ?? ''
  return { col: stringWidth(line.slice(0, pos.col)), row: pos.row }
}

function makeChannel() {
  const listeners = new Set<() => void>()
  let balanceCalls = 0
  let nextRowId = 3
  const channel: any = {
    version: 0,
    rows: [
      { id: 1, kind: 'user', text: '检查这个问题' },
      { id: 2, kind: 'assistant', text: '已经检查。', streaming: false },
    ],
    status: 'idle',
    sessionTitle: '我的会话',
    sessionColor: '',
    autoRecapOnOpen: false,
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: {
      input: 1234,
      output: 5678,
      cacheRead: 900,
      cacheWrite: 100,
      peak: { input: 400, output: 2000, cacheRead: 300, cacheWrite: 40 },
      idle: { input: 834, output: 3678, cacheRead: 600, cacheWrite: 60 },
    },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'max',
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [
      { name: 'balance', description: 'Show DeepSeek account balance' },
      { name: 'cost', description: 'Show session token usage' },
      { name: 'status', description: 'Show session status' },
    ],
    commandCompletions() { return [] },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify() {},
    pushLocal() {},
    renameSession() {},
    balanceInfo: async () => {
      balanceCalls += 1
      return balanceResult
    },
    emit() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
    traceEvents: () => [],
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    get balanceCalls() { return balanceCalls },
  }
  return channel
}

setLang('zh')
const stdin = new FakeStdin()
/** 可变的查询结果：主实例先跑成功态，再切失败态复测（避免双渲染实例）。 */
let balanceResult: import('../src/deepseekBalance.js').BalanceResult = {
  ok: true,
  isAvailable: true,
  balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }],
}
const channel = makeChannel()
const questionStore = { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} }
const approvalStore = { subscribe: () => () => {}, getSnapshot: () => null }
await render(
  <AlternateScreen>
    <Chat
      fullscreen
      channel={channel}
      questionStore={questionStore as any}
      approvalStore={approvalStore as any}
    />
  </AlternateScreen>,
  {
    stdout: new FakeStdout(),
    stderr: new FakeStderr(),
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

// ── 1. /balance 触发查询：摘要行出现，balanceInfo 恰好一次 ──────────────
// 输入分两步（同 verify-session-color-recap）：先写文本并等上屏确认，
// 再写回车——整块 `/balance\r` 在 prompt 就绪前写入会丢回车。
stdin.write('/balance')
await settle(() => screenText(term).includes('/balance'))
stdin.write('\r')
await settle(() => screenHas(term, 'DeepSeek 余额 ¥110.00'))
check('摘要行显示余额', screenHas(term, 'DeepSeek 余额 ¥110.00'))
check('触发恰好一次 balanceInfo', channel.balanceCalls === 1, String(channel.balanceCalls))
check('摘要行不可用标记未出现', !screenHas(term, '查询失败'))

// ── 2. hover 摘要行：明细与操作 chip 出现 ────────────────────────────────
const summaryPos = findText(term, 'DeepSeek 余额 ¥110.00')
check('摘要行在视口内', summaryPos !== null)
if (summaryPos !== null) {
  const cell = cellOf(term, summaryPos)
  hover(cell.col + 1, cell.row + 1)
}
await settle(() => screenHas(term, '总额 ¥110.00'))
check('hover 显示币种拆分', screenHas(term, '总额 ¥110.00') && screenHas(term, '赠送 ¥10.00') && screenHas(term, '充值 ¥100.00'))
check('hover 显示 token 与花费估算', screenHas(term, '本会话 tokens 1.2k in → 5.7k out · ≈¥'))
check('hover 显示刷新 chip', screenHas(term, '点击刷新'))
check('hover 显示关闭 chip', screenHas(term, '×'))
check('hover 显示口径说明', screenHas(term, '余额查询免费'))

// ── 3. 点击 × 关闭报告（在 hover 状态新鲜时进行） ───────────────────────
{
  const closePos = findText(term, '×')
  check('关闭 chip 在视口内', closePos !== null)
  if (closePos !== null) {
    const cell = cellOf(term, closePos)
    clickCell(cell.col + 1, cell.row + 1)
  }
  await settle(() => !screenHas(term, 'DeepSeek 余额'))
  check('点击 × 关闭报告', !screenHas(term, 'DeepSeek 余额'))
}

// ── 4. 重新触发后点击摘要行：重新查询 ───────────────────────────────────
stdin.write('/balance')
await settle(() => screenText(term).includes('/balance'))
stdin.write('\r')
await settle(() => screenHas(term, 'DeepSeek 余额 ¥110.00'))
check('重新触发后摘要恢复', screenHas(term, 'DeepSeek 余额 ¥110.00'))
check('累计两次 balanceInfo', channel.balanceCalls === 2, String(channel.balanceCalls))
{
  const refreshPos = findText(term, 'DeepSeek 余额 ¥110.00')
  if (refreshPos !== null) {
    const cell = cellOf(term, refreshPos)
    hover(cell.col + 1, cell.row + 1)
    await settle(() => screenHas(term, '点击刷新'))
    clickCell(cell.col + 1, cell.row + 1)
  }
}
await settle(() => channel.balanceCalls >= 3)
check('点击摘要行重新查询', channel.balanceCalls === 3, String(channel.balanceCalls))
await settle(() => screenHas(term, 'DeepSeek 余额 ¥110.00'))
check('刷新后摘要仍在', screenHas(term, 'DeepSeek 余额 ¥110.00'))

// ── 5. 失败态：认证失败摘要与 hover 原因（复用主实例） ──────────────────
{
  balanceResult = { ok: false, reason: 'unauthorized', status: 401 }
  stdin.write('/balance')
  await settle(() => screenText(term).includes('/balance'))
  stdin.write('\r')
  await settle(() => screenHas(term, '查询失败'))
  check('失败态摘要', screenHas(term, 'DeepSeek 余额 · 查询失败'))
  const failPos = findText(term, 'DeepSeek 余额 · 查询失败')
  if (failPos !== null) {
    const cell = cellOf(term, failPos)
    // stale-hover 抑制：鼠标停在同一位置时新状态不触发 onMouseEnter，
    // 先移开再移回（verify-auto-recap 同款解药）。
    hover(1, 1)
    await sleep(100)
    hover(cell.col + 1, cell.row + 1)
    await settle(() => screenHas(term, '认证失败'))
    check('失败态 hover 显示原因', screenHas(term, '认证失败'))
    check('失败态 hover 显示重试', screenHas(term, '点击重试'))
  } else {
    check('失败态 hover 显示原因', false, '摘要行不在视口')
  }
  // 收尾：鼠标移开，避免残留 hover。
  hover(1, 1)
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll balance/cost checks passed')
