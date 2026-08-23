/**
 * repro-trajectory-mouse — 轨迹场景鼠标链路复现（docs/mouse-adaptation-plan-abcd.md B 组）。
 *
 * 场景：AlternateScreen 包裹的 TrajectoryScene（产品内联形态），注入 SGR
 * press+release / 滚轮，断言六件事：
 *   1. Ledger 行点击 = 光标跳到该行（▸ 落在被点行上）；
 *   2. 滚轮下滚 = 光标下移（与 ↓ 同路径，一格 3 行）；
 *   3. WaveBand 波形列点击 = 光标跳到该列最近事件；
 *   4. 页签行空白 gap 点击 = 打开 / 搜索编辑器；
 *   5. 页签点击切换热点视图 + 排序标签点击循环排序；
 *   6. 热点排行行点击 = 跳回时序视图并定位该组首成员（与 Enter 同路径）。
 *
 * 诊断：置 DSH_TUI_DEBUG_MOUSE=1 看 mouse-debug.log 的
 * "dispatchClick {handled}" / "wheel routed by position"。
 *
 * 运行：node --import tsx/esm scripts/repro-trajectory-mouse.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { TrajectoryScene }, { stringWidth }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/TrajectoryScene.js'),
    import('../src/ink/stringWidth.js'),
  ])
const traj = await import('../src/dsh-adapter/trajectory/index.js')

const COLS = 120
const ROWS = 30
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeTerm() {
  return new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
}
function makeStreams(term: InstanceType<typeof XTerm>) {
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  return { stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: new FakeStdin() }
}
function screenLines(term: InstanceType<typeof XTerm>): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
  return out
}
/** SGR 点击：press+release 同一单元格（1-indexed）。 */
function clickCell(stdin: any, col1: number, row1: number) {
  stdin.write(`\x1b[<0;${col1};${row1}M`)
  stdin.write(`\x1b[<0;${col1};${row1}m`)
}
/** 行内目标（CJK 前）所在单元格列（0 基）：按显示宽度换算。 */
function cellCol(line: string, charIndex: number): number {
  return stringWidth(line.slice(0, charIndex))
}

// ── 事件样本：3 轮，含工具、burst、失败、重试（与 verify-trace-scene 同族） ──
const T0 = 1_700_000_000_000
let seq = 0
const ev = (type: string, data: unknown): Record<string, unknown> =>
  ({ type, seq: ++seq, time: T0 + ++seq * 250, data })
function sampleEvents(): Record<string, unknown>[] {
  seq = 0
  const out: Record<string, unknown>[] = []
  for (let turn = 1; turn <= 3; turn++) {
    out.push(ev('turn/start', { turn }))
    out.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] }))
    out.push(ev('step/start', { turn, step: 1 }))
    out.push(ev('assistant/chunk', { turn, step: 1, chunk: {} }))
    out.push(ev('assistant/message', {
      turn, step: 1,
      message: { content: [{ type: 'text', text: `reply about turn ${turn}` }] },
      usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0 },
    }))
    for (const name of ['read_file', 'grep_repo']) {
      const callId = `c${turn}-${name}`
      out.push(ev('tool/call', { turn, step: 1, callId, name, arguments: `{"path":"src/${name}.ts"}` }))
      out.push(ev('tool/result', {
        turn, step: 1,
        message: { source: { callId }, content: [{ type: 'text', text: `${name} produced output` }] },
        ...(turn === 2 && name === 'grep_repo' ? { error: { name: 'E', code: 'ENOENT' } } : {}),
      }))
    }
    if (turn === 3) {
      for (let i = 0; i < 4; i++) {
        const callId = `burst${i}`
        out.push(ev('tool/call', { turn, step: 1, callId, name: 'web_search', arguments: `{"q":${i}}` }))
        out.push(ev('tool/result', { turn, step: 1, message: { source: { callId }, content: [] } }))
      }
      out.push(ev('llm/retry', { retryId: 'r', turn, step: 1, provider: 'deepseek-official', retry: 1, maxRetries: 2, delayMs: 900, failure: { message: 'rate limited', code: 'RATE_LIMIT' } }))
      out.push(ev('llm/retry-started', { retryId: 'r', turn, step: 1, retry: 1 }))
    }
    out.push(ev('step/end', { turn, step: 1 }))
    out.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return out
}
const EVENTS = sampleEvents()

const channel: any = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'mouse probe',
  cwd: 'C:/code/demo',
  traceEvents: () => EVENTS,
  subscribe: () => () => {},
}

const term = makeTerm()
const s = makeStreams(term)
const inst = await render(
  <AlternateScreen>
    <TrajectoryScene channel={channel} build={traj.buildTrajectory(EVENTS as never)} onClose={() => {}} />
  </AlternateScreen>,
  { stdout: s.stdout as any, stdin: s.stdin as any, stderr: s.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const pointerRow = (lines: string[]): number => lines.findIndex(l => l.includes('▸'))

// ── 1. Ledger 行点击 = 光标跳转 ────────────────────────────────────────────
let lines = screenLines(term)
const before = pointerRow(lines)
const targetIdx = lines.findIndex(l => l.includes('read_file'))
check('时序视图渲染且光标指针可见', before >= 0 && targetIdx >= 0, `pointer=${before} read_file=${targetIdx}`)
if (targetIdx >= 0) {
  const col = cellCol(lines[targetIdx]!, lines[targetIdx]!.indexOf('read_file')) + 2
  clickCell(s.stdin, col + 1, targetIdx + 1)
  await sleep(400)
  lines = screenLines(term)
  const after = pointerRow(lines)
  // 窗口随光标重定位：被点行可能移动，断言指针行内容是被点的工具行
  check('点击 read_file 行 → ▸ 落到被点工具行', after >= 0 && lines[after]!.includes('read_file'),
    `pointer ${before} → ${after}: ${(lines[after] ?? '').trim().slice(0, 36)}`)
}

// ── 2. 滚轮下滚 = 光标下移（一格 3 行；SGR 65 = wheel down） ──────────────
{
  const p1 = pointerRow(lines)
  s.stdin.write(`\x1b[<65;${Math.floor(COLS / 2)};${p1 + 2}M`)
  await sleep(400)
  lines = screenLines(term)
  const p2 = pointerRow(lines)
  check('滚轮下滚 → 光标下移 3 行', p2 - p1 === 3, `pointer ${p1} → ${p2}`)
}

// ── 3. WaveBand 波形列点击 = 跳到最近事件 ─────────────────────────────────
{
  const waveIdx = lines.findIndex(l => /[▁▂▃▄▅▆▇█]{6,}|·{6,}/.test(l))
  const p1 = pointerRow(lines)
  check('波形带渲染', waveIdx >= 0, `row=${waveIdx}`)
  if (waveIdx >= 0) {
    clickCell(s.stdin, 6, waveIdx + 1) // 靠左列 = 会话早期事件
    await sleep(400)
    lines = screenLines(term)
    const p2 = pointerRow(lines)
    check('点击波形早列 → 光标跳到早期行', p2 !== p1 && p2 >= 0, `pointer ${p1} → ${p2}`)
  }
}

// ── 4. 页签行空白 gap 点击 = 打开 / 搜索编辑器 ────────────────────────────
{
  const tabsIdx = lines.findIndex(l => l.includes('时序') && l.includes('热点'))
  check('页签行渲染', tabsIdx >= 0, `row=${tabsIdx}`)
  if (tabsIdx >= 0) {
    const line = lines[tabsIdx]!
    // gap 中段：热点标签结束与右端标签之间取中点
    const afterHotspot = line.indexOf('热点') + '热点'.length
    const gapEnd = Math.max(afterHotspot + 8, line.trimEnd().length - 12)
    const midGap = Math.floor(afterHotspot + 3 + (gapEnd - afterHotspot - 3) / 2)
    clickCell(s.stdin, midGap + 1, tabsIdx + 1)
    await sleep(400)
    lines = screenLines(term)
    const tabs = lines[tabsIdx] ?? ''
    check('gap 点击 → 搜索编辑器打开（/ 与匹配计数出现）',
      tabs.includes('匹配') && tabs.includes('/'),
      tabs.trim().slice(0, 44))
    s.stdin.write('\x1b') // Esc 关闭搜索
    await sleep(300)
  }
}

// ── 5. 页签点击切热点 + 排序标签点击循环 ──────────────────────────────────
{
  lines = screenLines(term)
  const tabsIdx = lines.findIndex(l => l.includes('时序') && l.includes('热点'))
  const line = lines[tabsIdx]!
  const hotspotCol = cellCol(line, line.indexOf('热点'))
  clickCell(s.stdin, hotspotCol + 1, tabsIdx + 1)
  await sleep(400)
  lines = screenLines(term)
  check('点击热点页签 → 热点视图（工具分节 + 计数行出现）',
    lines.some(l => l.includes('工具')) && lines.some(l => /×/.test(l)),
    (lines.find(l => l.includes('工具')) ?? '').trim().slice(0, 30))

  const tabsLine2 = lines[tabsIdx] ?? ''
  const sortCol = tabsLine2.indexOf('按耗时')
  check('排序标签可见', sortCol >= 0, tabsLine2.trim().slice(-20))
  if (sortCol >= 0) {
    clickCell(s.stdin, cellCol(tabsLine2, sortCol) + 1, tabsIdx + 1)
    await sleep(400)
    lines = screenLines(term)
    check('点击排序标签 → 循环到下一排序（按次数）', (lines[tabsIdx] ?? '').includes('按次数'),
      (lines[tabsIdx] ?? '').trim().slice(-20))
  }
}

// ── 6. 热点行点击 = 跳回时序定位组首成员（与 Enter 同路径） ────────────────
{
  const hotRowIdx = lines.findIndex(l => l.includes('read_file'))
  check('热点排行含 read_file 行', hotRowIdx >= 0, `row=${hotRowIdx}`)
  if (hotRowIdx >= 0) {
    const line = lines[hotRowIdx]!
    clickCell(s.stdin, cellCol(line, line.indexOf('read_file')) + 2, hotRowIdx + 1)
    await sleep(400)
    lines = screenLines(term)
    const backToTimeline = lines.some(l => l.includes('时序') && l.includes('热点'))
    // timeline 里第一条 read_file 行应带 ▸（组首成员 = 它的 firstIndex）
    const firstRead = lines.findIndex(l => l.includes('read_file'))
    check('点击热点行 → 跳回时序且光标落在该组首成员',
      backToTimeline && firstRead >= 0 && lines[firstRead]!.includes('▸'),
      firstRead >= 0 ? `行${firstRead}: ${lines[firstRead]!.trim().slice(0, 36)}` : '未找到 read_file 行')
  }
}

// ── 7. 头行 ✕ 退出按钮点击 = onClose ─────────────────────────────────────
await inst.unmount()
{
  let closed = 0
  const onClose = (): void => { closed++ }
  const termX = makeTerm()
  const sX = makeStreams(termX)
  const instX = await render(
    <AlternateScreen>
      <TrajectoryScene channel={channel} build={traj.buildTrajectory(EVENTS as never)} onClose={onClose} />
    </AlternateScreen>,
    { stdout: sX.stdout as any, stdin: sX.stdin as any, stderr: sX.stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  let lx = screenLines(termX)
  for (let wait = 0; wait < 5 && !lx.some(l => l.includes('时序')); wait++) {
    await sleep(200)
    lx = screenLines(termX)
  }
  const closeRowIdx = lx.findIndex(l => l.includes('时序') && l.includes('热点'))
  // ✕ 钉在头行（页签行上一行）末列
  const headerIdx2 = closeRowIdx - 1
  check('✕ 退出按钮可见', headerIdx2 >= 0 && (lx[headerIdx2] ?? '').trimEnd().endsWith('✕'),
    headerIdx2 >= 0 ? `行${headerIdx2} 末字符=${(lx[headerIdx2] ?? '').trimEnd().slice(-1)} 行尾=[${(lx[headerIdx2] ?? '').slice(-30)}]` : '未找到页签行')
  clickCell(sX.stdin, COLS - 3, headerIdx2 + 1) // ✕ 在 bandWidth（COLS-4）末端：paddingX 1 + 116 宽内容，✕ 于 1-indexed COLS-3
  await sleep(300)
  check('点击 ✕ → onClose 被调用', closed === 1, `closed=${closed}`)
  await instX.unmount()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
