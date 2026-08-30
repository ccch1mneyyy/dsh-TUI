/**
 * Resize temporal-stability regression（审计 P1-C，借鉴 Codex 的 resize
 * 时间漂移测试维度）。
 *
 * 现有 verify-resize-reflow 只验证「最终画面对不对」；本脚本补测：
 *   1. 时间不变量：resize 落定后 250ms 与 1000ms 的画面必须完全一致
 *      （不许继续慢慢漂）；
 *   2. 往返不变量：90↔150 宽度循环 20 次后回到基线宽度，composer/
 *      sentinel 行必须精确回到基线位置（无累计漂移）；
 *   3. 流中 resize：streaming 期间反复 resize，消息 finalize 后的画面
 *      必须与同内容冷渲染完全一致（resize + live mutation 竞争不留下
 *      任何与冷路径不同的几何）。
 *
 * 运行：node --import tsx/esm scripts/verify-resize-temporal.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { default: instances }, { settle, settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])

const BASE_COLS = 108
const ROWS = 34
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

function makeTerminal() {
  const term = new XTerm({ cols: BASE_COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  let lastFlushed: Promise<void> = Promise.resolve()
  class FakeStdout extends Writable {
    columns = BASE_COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      lastFlushed = new Promise<void>(res => term.write(String(chunk), () => { cb(); res() }))
    }
  }
  const stdout = new FakeStdout() as any
  const stderr = (new (class extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } })()) as any
  const stdin = (new (class extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } })()) as any
  return { term, stdout, stderr, stdin, flush: () => lastFlushed }
}

function screenLines(term: typeof XTerm.prototype): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return out
}

// ---- 稳定历史（无时间敏感组件：无 subagent 卡片、无 running tool）----
function makeRows(): any[] {
  const rows: any[] = []
  let id = 0
  for (let t = 0; t < 40; t++) {
    rows.push({ id: id++, kind: 'user', text: '问题 ' + t + '：分析模块 ' + t + ' 的边界条件与失败模式' })
    rows.push({ id: id++, kind: 'assistant', text: '回答 ' + t + '：\n\n- 条件成立\n- 边界已覆盖\n- 结论稳定', streaming: false })
  }
  rows.push({ id: id++, kind: 'assistant', text: 'SENTINEL-TAIL 最终结论：全部检查通过。', streaming: false })
  return rows
}

async function mountChat(rows: any[]) {
  const listeners = new Set<() => void>()
  const channel: any = {
    version: 0, rows, status: 'idle', sessionTitle: 'resize-temporal', agentId: 'x',
    model: 'deepseek-v4-flash', reasoningEffort: 'max',
    tokens: { input: 100, output: 40 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
    gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: rows[0].text,
    pending: [], commandList: [], notifications: [],
    mode: { plan: false }, effortLevels: undefined,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]), listSessions: () => [],
    setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
  }
  const t = makeTerminal()
  await render(
    <AlternateScreen>
      <Chat channel={channel} questionStore={new QuestionStore()} />
    </AlternateScreen>,
    { stdout: t.stdout, stdin: t.stdin, stderr: t.stderr, exitOnCtrlC: false, patchConsole: false },
  )
  const ink: any = instances.get(t.stdout)
  if (!ink) throw new Error('Ink instance not found')
  ink.setAltScreenActive(true, true)
  return {
    ...t,
    bump: () => { channel.version++; for (const cb of listeners) (cb as () => void)() },
    unmount: () => ink.unmount(),
  }
}

function doResize(app: { stdout: any; term: typeof XTerm.prototype }, w: number, h: number) {
  app.stdout.columns = w
  app.stdout.rows = h
  app.term.resize(w, h)
  app.stdout.emit('resize')
}

// ================= 1+2. 时间稳定性 & 往返循环 =================
const app = await mountChat(makeRows())
const composerY = (lines: string[]) => lines.findIndex(l => l.includes('╭'))
const sentinelY = (lines: string[]) => lines.findIndex(l => l.includes('SENTINEL-TAIL'))
// 基线就绪 = composer 与 transcript 最后一行（sentinel）都已上屏，且右缘
// 滚动条（▴）已画上——滚动条在首个内容帧之后的一帧才出现，只等内容会把
// 无滚动条的早帧当基线，导致回基线比对必挂。
const baselineReady = await settled(() => {
  const lines = screenLines(app.term)
  return composerY(lines) >= 0 && sentinelY(lines) >= 0 && lines.some(l => l.endsWith('▴'))
})
await app.flush()
const baseline = screenLines(app.term)
check('基线含 composer 与 sentinel', baselineReady, `composer=${composerY(baseline)} sentinel=${sentinelY(baseline)}`)

// ---- 1. resize 落定后不得继续漂 ----
doResize(app, 90, ROWS)
// 固定墙钟采样点保留：250ms 与 1000ms 的对比本身是被测语义（「状态不得
// 再改变」探针），轮询会在首个成立帧立即返回，等于没测。
await sleep(250); await app.flush()
const at250 = screenLines(app.term)
await sleep(750); await app.flush()
const at1000 = screenLines(app.term)
check('resize 落定后 250ms 与 1000ms 画面一致（时间不变量）', at250.join('\n') === at1000.join('\n'))

// ---- 2. 90↔150 循环 20 次后回基线 ----
for (let i = 0; i < 20; i++) {
  doResize(app, i % 2 === 0 ? 150 : 90, ROWS)
  await sleep(12) // 固定 pacing 保留：制造快速连环 resize 竞争，本身无可轮询条件
  await app.flush()
}
doResize(app, BASE_COLS, ROWS)
const roundTripSettled = await settled(() => screenLines(app.term).join('\n') === baseline.join('\n'))
// 收敛后保留固定稳定窗：迟到的 resize repaint 可能在首个相等帧之后才漂移，
// 轮询在首帧相等即返回，盖不住「之后不得再漂」的时间语义——终态再比对一次。
await sleep(250); await app.flush()
const roundTrip = screenLines(app.term)
check('20 次宽度循环后画面回到基线（无累计漂移）', roundTripSettled && roundTrip.join('\n') === baseline.join('\n'), `composer ${composerY(baseline)}→${composerY(roundTrip)}, sentinel ${sentinelY(baseline)}→${sentinelY(roundTrip)}`)
app.unmount()
await sleep(150) // 固定小窗保留：unmount 收尾写出无完成回调可等

// ================= 3. 流中 resize：终态 == 冷渲染 =================
const liveRows = makeRows()
const streamRow: any = { id: 9999, kind: 'assistant', text: '', streaming: true }
liveRows.push(streamRow)
const app2 = await mountChat(liveRows)
// 等首帧就绪（sentinel 上屏）再开始流式：等待后只操作不断言 → settle
await settle(() => sentinelY(screenLines(app2.term)) >= 0)
await app2.flush()

const STREAM_TEXT = '流式内容：第一段论述比较长，用来触发宽度变化下的重排。'.repeat(8) + '\n\n- 要点甲\n- 要点乙\n- 结论 TAILMARK-终'
// 逐段流入，期间反复 resize（resize + live mutation 竞争）
for (let i = 0; i < 10; i++) {
  streamRow.text = STREAM_TEXT.slice(0, Math.floor((STREAM_TEXT.length * (i + 1)) / 10))
  app2.bump()
  await sleep(40) // 固定 pacing 保留：模拟流式节奏，与 resize 的竞争时序本身是被测对象
  if (i % 3 === 0) { doResize(app2, i % 2 === 0 ? 88 : 132, ROWS) }
  await app2.flush()
}
streamRow.text = STREAM_TEXT
streamRow.streaming = false
doResize(app2, BASE_COLS, ROWS)
app2.bump()
// 固定窗口保留：尾标记在 finalize 前的流式帧里已上屏（末次切片即全文），
// 轮询 tail 计数会对已成立条件立即返回、抓到旧宽度的中间帧；这里等的是
// 回到 BASE_COLS 的终帧落定，无独立可轮询条件（终帧对错由冷渲染比对把关）。
await sleep(600); await app2.flush()
const warm = screenLines(app2.term)
// 计数用全文唯一的尾标记（正文字符串内部有 repeat，不能当标记）
const streamedOnce = warm.join('\n').split('TAILMARK-终').length - 1
check('finalize 后流式文本恰好出现一次（无重复）', streamedOnce === 1, 'occurrences=' + streamedOnce)
app2.unmount()
await sleep(150) // 固定小窗保留：unmount 收尾写出无完成回调可等

// 冷渲染：同最终内容、同尺寸、从零渲染
const coldRows = makeRows()
coldRows.push({ id: 9999, kind: 'assistant', text: STREAM_TEXT, streaming: false })
const app3 = await mountChat(coldRows)
const coldConverged = await settled(() => screenLines(app3.term).join('\n') === warm.join('\n'))
// 同上：首个相等帧之后仍可能有迟到 repaint，固定稳定窗后取终态再比对。
await sleep(250); await app3.flush()
check('流中 resize 终态 == 冷渲染（live mutation 竞争无残留几何）', coldConverged && screenLines(app3.term).join('\n') === warm.join('\n'))
app3.unmount()

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
