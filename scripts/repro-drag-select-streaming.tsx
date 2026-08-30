/**
 * repro-drag-select-streaming — 选区复制回归的重现脚本（issue：全屏模式
 * 拖选复制失效，"只能复制一个字符 / 只有输入框文字能复制"）。
 *
 * 根因：TimelineRail / ScrollbarGutter 是屏幕右侧的 2 列 gutter，却用了
 * NoSelect fromLeftEdge —— noSelect 区域被拉成 [第 0 列 → 盒子右缘]，
 * 整个转录区每行都被标记为不可选取，extractRowText 全部跳过 → 复制为空。
 * 输入框在 gutter 行布局之外，不受影响 —— 与用户"只有输入框文字能复制"
 * 的症状完全吻合。
 *
 * 场景（真实 Chat 树，fullscreen + AlternateScreen）：
 *   1. 对照组：静息状态（无流式）拖选尾部标记行 → OSC 52 应携带完整文本；
 *   2. 回归组：上滚阅读到中部历史 + 尾部行 streaming 并发时，同样拖选
 *      中部历史标记行 → OSC 52 应同样完整；
 *   3. 流式结束后再拖一次 → 应恢复。
 *
 * 运行：node --import tsx/esm scripts/repro-drag-select-streaming.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
// 纯 OSC 52 路径：跳过 wl-copy/xclip 探测链，断言只依赖 stdout 帧
process.env.SSH_CONNECTION = 'headless-repro'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])
const { default: instances } = await import('../src/ink/instances.js')
const { stringWidth } = await import('../src/ink/stringWidth.js')

const COLS = 100, ROWS = 40
// 等待/读屏走公共辅助（issue #532）：settled 轮询到谓词为真后返回终值，
// 等待与断言共用同一条件——固定 sleep 在慢 runner 上会断言到旧屏幕。
// alt-screen 下 baseY 恒 0，视口读取与直扫等价。
const { sleep, settled } = termTest
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    writes.push(String(chunk))
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

// ── fixture：40 轮对话；中部与尾部各埋一个可定位的 ASCII 标记行 ──
const T0 = Date.now() - 600_000
const HMARK = 'ZZMARKER_ABCDEFGHIJ'   // 中部历史标记（回归组拖这个）
const TMARK = 'TTMARKER_KLMNOPQRST'   // 尾部标记（对照组拖这个）
const chatRows: any[] = []
for (let i = 0; i < 40; i++) {
  chatRows.push({ id: i * 2, kind: 'user', text: `用户消息 ${i}：帮我看看这个问题`, time: T0 + i * 8000 })
  const text = i === 20
    ? `历史标记行：${HMARK} 其后是普通内容。`
    : i === 39
      ? `尾部标记行：${TMARK} 结束。`
      : `助手回复 ${i}：这个问题看起来出在 ${'分析内容。'.repeat(6)}，建议从这几个方向排查。`
  chatRows.push({ id: i * 2 + 1, kind: 'assistant', text, time: T0 + i * 8000 + 3000 })
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows: chatRows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const tree = (
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>
)
const inst = await render(tree, {
  stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
  exitOnCtrlC: false, patchConsole: false,
})
// useCopyOnSelect/useSelection 经 instances.get(process.stdout) 找实例；
// 本 harness 渲染到假 stdout，挂载时 key 未命中 → 拿到的是 no-op stub。
// 别名后重渲一次，让 hook 绑到真实实例（与 verify-copy-on-select 同法）。
instances.set(process.stdout, instances.get(stdout)!)
inst.rerender(tree)

// 首帧挂载 pacing：等 React 树完成首次渲染与鼠标/选取 hook 挂接，
// 无单一可观测条件。
await sleep(900)

function screenLines(): string[] {
  return termTest.viewportLines(term, ROWS)
}

function osc52Payloads(): string[] {
  return [...writes.join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)]
    .map(m => Buffer.from(m[1]!, 'base64').toString('utf8'))
}

/**
 * 在当前屏幕上定位 marker，从 marker 内偏移 a 拖到 b（0-indexed 单元格，
 * 闭区间：press..release 列都包含在选区里）。SGR 坐标是单元格列；
 * CJK 占 2 格而 indexOf 是字符索引，必须用 stringWidth 换算前缀宽度。
 */
async function dragOver(marker: string, a: number, b: number): Promise<void> {
  const lines = screenLines()
  const row = lines.findIndex(l => l.includes(marker))
  if (row < 0) throw new Error(`marker ${marker} not on screen`)
  const charIdx = lines[row]!.indexOf(marker)
  const col0 = stringWidth(lines[row]!.slice(0, charIdx))
  stdin.write(`\x1b[<0;${col0 + a + 1};${row + 1}M`)   // press
  await sleep(80)
  stdin.write(`\x1b[<32;${col0 + b + 1};${row + 1}M`)   // drag (motion)
  await sleep(80)
  stdin.write(`\x1b[<0;${col0 + b + 1};${row + 1}m`)    // release
}

// ── 对照组：静息（sticky 底部），拖选尾部标记 ──
writes.length = 0
await dragOver(TMARK, 2, 10)
{
  const expect = TMARK.slice(2, 10 + 1)
  check('静息拖选 → OSC 52 携带完整选中文本', await settled(() => osc52Payloads().includes(expect)),
    `payloads=${JSON.stringify(osc52Payloads())} expect="${expect}"`)
}

// ── 回归组：上滚阅读到中部历史 + 尾部流式并发 ──
for (let i = 0; i < 90 && !screenLines().some(l => l.includes(HMARK)); i++) {
  stdin.write('\x1b[<64;90;20M')  // wheel up，小步走到标记可见
  await sleep(12)
}
// 稳定性窗口（不得改变）：上面的轮询循环已见到 HMARK，settle 会立即返回
// 等于没测——固定窗口让滚轮连发后的错误重绘（标记被冲掉）有机会暴露。
await sleep(400)
{
  const lines = screenLines()
  check('上滚后中部历史标记可见', lines.some(l => l.includes(HMARK)))
}

writes.length = 0
const streamRow = chatRows[chatRows.length - 1]!
streamRow.streaming = true
const origText = streamRow.text
const chunk = '流式增量段落：继续分析模块边界与常量折叠的正确性，覆盖深层嵌套与循环引用的边界情况。\n\n'
let streamed = 0
const streamStart = Date.now()
const streamLoop = (async () => {
  while (Date.now() - streamStart < 2600) {
    streamRow.text = origText + chunk.repeat(++streamed)
    channel.version++
    listeners.forEach(l => l())
    await sleep(33)
  }
})()

// 真实墙钟语义：拖选必须落在 2.6s 流式窗口的中段——streamed>0 一到就返回
// 的轮询表达不了"流式进行中"这个并发时点，保留固定等待。
await sleep(400)  // 流式已在跑
try {
  await dragOver(HMARK, 3, 11)
} catch (e) {
  check('流式期间标记行仍在视口', false, String(e))
}
await streamLoop
streamRow.streaming = undefined
// 流式收尾后的重绘 pacing：无单一可观测条件（下面的 settled 只等 OSC 52）。
await sleep(400)

{
  const expect = HMARK.slice(3, 11 + 1)
  check('流式并发时拖选 → OSC 52 携带完整选中文本', await settled(() => osc52Payloads().includes(expect)),
    `payloads=${JSON.stringify(osc52Payloads())} expect="${expect}"`)
}

// ── 附加：流式结束后（静息）再拖一次，看是否恢复 ──
writes.length = 0
// 静息 pacing：给上一次选区/复制状态一个收尾窗口，无单一可观测条件。
await sleep(200)
try {
  await dragOver(HMARK, 3, 11)
  const expect = HMARK.slice(3, 11 + 1)
  check('流式结束后拖选 → 恢复完整', await settled(() => osc52Payloads().includes(expect)),
    `payloads=${JSON.stringify(osc52Payloads())} expect="${expect}"`)
} catch (e) {
  check('流式结束后标记行仍可见', false, String(e))
}

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
