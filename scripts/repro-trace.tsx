/**
 * `/trace` 轨迹视图回归（issue #80）：
 * 1. 纯函数装配（src/dsh-adapter/trace.ts）：事件 → 条目、tool/step/turn 配对耗时、
 *    thinking 条目、todo 摘要、过滤器、extendTrace 增量追加、时长/时钟/
 *    CJK 宽度截断。
 * 2. 组件渲染（xterm headless 驱动真实 TraceView）：条目行渲染、耗时
 *    后缀、选中行 ❯ 指针、窗口滚动不炸、单行截断、过滤标签、空态。
 */
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, { render }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
])
const {
  buildTraceEntries,
  extendTrace,
  filterTraceEntries,
  formatClock,
  formatDuration,
  truncateWidth,
} = await import('../src/dsh-adapter/trace.js')
const { TraceView, TRACE_WINDOW } = await import('../src/components/TraceView.js')
const { setLang } = await import('../src/i18n.js')

setLang('zh')

const COLS = 90
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
const stdout = new FakeStdout()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** The real terminal screen, line by line (colors stripped). */
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}
function screen(): string {
  return lines().join('\n')
}
function rowOf(needle: string): number {
  const rows = lines()
  for (let y = 0; y < rows.length; y++) {
    if (rows[y]!.includes(needle)) return y
  }
  return -1
}

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

// ── 事件工厂 ──────────────────────────────────────────────────────────
type AnyEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
const T0 = Date.UTC(2026, 0, 15, 8, 0, 0) // 固定时刻，时钟断言用 formatClock 对齐
let seq = 0
const ev = (type: string, time: number, data: Record<string, unknown>): AnyEvent =>
  ({ type, seq: seq++, time, data })

/** 一轮完整回合：turn/start → user → step → thinking+text → tool 配对 → step/end → turn/end。 */
function sampleEvents(): AnyEvent[] {
  seq = 0
  return [
    ev('turn/start', T0, { turn: 1 }),
    ev('user/message', T0 + 100, {
      role: 'user',
      content: [{ type: 'text', text: '帮我修一下登录 bug' }],
      source: { kind: 'user' },
    }),
    ev('step/start', T0 + 200, { turn: 1, step: 1 }),
    ev('assistant/message', T0 + 1200, {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先看一下登录模块的代码结构' },
          { type: 'text', text: '我先查一下登录相关代码' },
        ],
      },
    }),
    ev('tool/call', T0 + 1300, {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'bash',
      arguments: '{"command":"ls -la src/"}',
    }),
    ev('tool/result', T0 + 2800, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { callId: 'c1' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }],
      },
    }),
    ev('todo/write', T0 + 2900, {
      todos: [
        { content: '定位登录 bug', status: 'completed' },
        { content: '修复并重测', status: 'in_progress' },
      ],
    }),
    ev('step/end', T0 + 3000, { turn: 1, step: 1 }),
    ev('turn/end', T0 + 3100, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

// ── 1. 纯函数装配 ──────────────────────────────────────────────────────
const events = sampleEvents()
// oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具：结构化形状与 SessionEvent 对齐
const entries = buildTraceEntries(events as any)

const kinds = entries.map(entry => entry.kind)
check('条目顺序：turn → user → step → thinking → assistant → tool → todo',
  kinds.join(',') === 'turn,user,step,thinking,assistant,tool,todo')

const turnEntry = entries.find(entry => entry.kind === 'turn')!
const stepEntry = entries.find(entry => entry.kind === 'step')!
const toolEntry = entries.find(entry => entry.kind === 'tool')!
check('turn 配对耗时 3100ms 且状态 ok', turnEntry.durationMs === 3100 && turnEntry.status === 'ok')
check('step 配对耗时 2800ms 且状态 ok', stepEntry.durationMs === 2800 && stepEntry.status === 'ok')
check('tool/call↔tool/result 按 callId 配对耗时 1500ms',
  toolEntry.durationMs === 1500 && toolEntry.status === 'ok')
check('工具摘要 = 名称 + 压平参数', toolEntry.summary === 'bash {"command":"ls -la src/"}')
check('user 摘要取首个 text block', entries[1]!.summary === '帮我修一下登录 bug')
check('reasoning block → thinking 条目', entries[3]!.summary === '先看一下登录模块的代码结构')
check('todo 摘要 = 完成数/总数 + 进行中项', entries[6]!.summary === '1/2 · 修复并重测')

// 失败工具：error 字段 → error 状态。
{
  const failEvents = [
    ev('tool/call', T0, { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{"file_path":"/x"}' }),
    ev('tool/result', T0 + 40, {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { callId: 'c9' }, content: [] },
      error: { name: 'FsError', code: 'ENOENT' },
    }),
  ]
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  const failed = buildTraceEntries(failEvents as any)
  check('失败工具：error 状态 + 40ms 耗时',
    failed[0]!.status === 'error' && failed[0]!.durationMs === 40)
}

// 未配对括号保持 running，没有耗时。
{
  const open = buildTraceEntries([
    ev('turn/start', T0, { turn: 2 }),
    ev('tool/call', T0 + 10, { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }),
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  ] as any)
  check('未配对 turn/tool 保持 running 无耗时',
    open.every(entry => entry.status === 'running' && entry.durationMs === undefined))
}

// 注入上下文（plugin source）不进轨迹。
{
  const injected = buildTraceEntries([
    ev('user/message', T0, {
      role: 'user',
      content: [{ type: 'text', text: '[system] injected context' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }),
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  ] as any)
  check('plugin 注入的 user/message 不进轨迹', injected.length === 0)
}

// ── 2. 过滤器 ─────────────────────────────────────────────────────────
check('filter=tool 只留工具', filterTraceEntries(entries, 'tool').every(e => e.kind === 'tool'))
check('filter=thinking 只留思考', filterTraceEntries(entries, 'thinking').length === 1)
check('filter=message 留 user+assistant',
  filterTraceEntries(entries, 'message').map(e => e.kind).join(',') === 'user,assistant')
check('filter=progress 留 turn+step',
  filterTraceEntries(entries, 'progress').map(e => e.kind).join(',') === 'turn,step')
check('filter=all 原样返回', filterTraceEntries(entries, 'all').length === entries.length)

// ── 3. 增量追加（extendTrace）─────────────────────────────────────────
{
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  const base = extendTrace(null, events.slice(0, 6) as any) // 到 tool/result 为止
  check('增量基线：tool 已配对', base.entries.find(e => e.kind === 'tool')!.durationMs === 1500)
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  const grown = extendTrace(base, events as any)
  check('增量追加：条目数与全量一致', grown.entries.length === entries.length)
  check('增量追加：复用前缀不重算（同一 entries 数组）', grown.entries === base.entries)
  // 换一条完全不同的事件流 → 全量重建。
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  const rebuilt = extendTrace(grown, [ev('todo/write', T0, { todos: [] })] as any)
  check('事件流更换（agent 切换）→ 全量重建', rebuilt.entries.length === 1 && rebuilt.entries[0]!.summary === '0/0')
}

// ── 4. 格式化工具 ──────────────────────────────────────────────────────
check('formatDuration: 350ms', formatDuration(350) === '350ms')
check('formatDuration: 1.5s', formatDuration(1500) === '1.5s')
check('formatDuration: 2m05s', formatDuration(125_000) === '2m05s')
check('formatClock: HH:MM:SS 零填充', /^\d{2}:\d{2}:\d{2}$/.test(formatClock(T0)))
check('truncateWidth: 短串原样', truncateWidth('abc', 10) === 'abc')
check('truncateWidth: CJK 按显示宽度截断', truncateWidth('一二三四五六', 7) === '一二三…')
check('truncateWidth: 英文截断加省略号', truncateWidth('abcdefghij', 5) === 'abcd…')

// ── 5. 组件渲染 ────────────────────────────────────────────────────────
function view(
  list: readonly (typeof entries)[number][],
  cursor: number,
  filter: 'all' | 'tool' | 'thinking' | 'message' | 'progress' = 'all',
): React.ReactElement {
  return React.createElement(TraceView, { entries: list, cursor, filter })
}

const app = await render(view(entries, entries.length - 1), { stdout, debug: true, exitOnCtrlC: false })
await sleep(250)

{
  const s = screen()
  check('标题与过滤标签（zh）', s.includes('轨迹') && s.includes('过滤：全部') && s.includes('7 条'))
  check('条目行：时钟 + 工具摘要', s.includes(formatClock(T0 + 1300)) && s.includes('bash {"command":"ls -la src/"}'))
  check('配对耗时后缀 (1.5s)', s.includes('(1.5s)'))
  check('thinking 条目渲染', s.includes('先看一下登录模块的代码结构'))
  check('todo 条目渲染', s.includes('1/2 · 修复并重测'))
  check('底部键位提示（zh）', s.includes('f 过滤') && s.includes('Esc/q 关闭'))
}

// en 语言下提示行整体切回英文（picker i18n 分支：hint-trace 词条双语）。
{
  setLang('en')
  app.rerender(view(entries, entries.length - 1))
  await sleep(250)
  const s = screen()
  check('底部键位提示（en）', s.includes('to scroll') && s.includes('to close'))
  setLang('zh')
}

// 选中行带 ❯ 指针（光标在最后一行 = todo 条目）。
{
  const y = rowOf('1/2 · 修复并重测')
  check('选中行 ❯ 指针', y >= 0 && lines()[y]!.includes('❯'))
  // 用 thinking 行做对照（user 行的类型图标本身就是 ❯）。
  const yOther = rowOf('先看一下登录模块的代码结构')
  check('非选中行无 ❯ 指针', yOther >= 0 && !lines()[yOther]!.includes('❯'))
}

// 运行中工具显示 (…)。
{
  const running = buildTraceEntries([
    ev('tool/call', T0, { turn: 1, step: 1, callId: 'c3', name: 'bash', arguments: '{"command":"sleep 5"}' }),
  // oxlint-disable-next-line typescript/no-explicit-any -- 测试夹具
  ] as any)
  app.rerender(view(running, 0))
  await sleep(250)
  check('running 工具显示 (…)', screen().includes('(…)'))
}

// 长 CJK 摘要截断到单行（宽度预算内加省略号）。
{
  const longSummary = '修复'.repeat(60)
  const longEntries = [{
    seq: 0,
    time: T0,
    kind: 'assistant' as const,
    summary: longSummary,
  }]
  app.rerender(view(longEntries, 0))
  await sleep(250)
  const y = rowOf('修复修复')
  check('长 CJK 摘要截断（… 结尾，单行）', y >= 0 && lines()[y]!.includes('…') && !screen().includes(longSummary))
}

// 窗口滚动：30 条，光标在末尾 → 只有最后 TRACE_WINDOW 条在屏上。
{
  const many = Array.from({ length: 30 }, (_, i) => ({
    seq: i,
    time: T0 + i * 1000,
    kind: 'user' as const,
    summary: `msg ${String(i).padStart(2, '0')}`,
  }))
  app.rerender(view(many, 29))
  await sleep(250)
  const s = screen()
  check('滚动窗口：末尾条目可见', s.includes('msg 29'))
  check('滚动窗口：窗口外条目不可见', !s.includes('msg 05') && !s.includes('msg 17'))
  check('滚动窗口：窗口下缘可见', s.includes(`msg ${30 - TRACE_WINDOW}`))
}

// 光标移到顶部 → 顶部条目可见，底部滚动提示。
{
  const many = Array.from({ length: 30 }, (_, i) => ({
    seq: i,
    time: T0 + i * 1000,
    kind: 'user' as const,
    summary: `top ${String(i).padStart(2, '0')}`,
  }))
  app.rerender(view(many, 0))
  await sleep(250)
  const s = screen()
  check('光标回顶：首条可见', s.includes('top 00'))
  check('光标回顶：末尾不可见', !s.includes('top 29'))
}

// 空态。
{
  app.rerender(view([], 0))
  await sleep(250)
  check('空态提示', screen().includes('暂无轨迹事件'))
}

app.unmount()
await sleep(100)
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
