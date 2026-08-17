/**
 * 长列表 picker 焦点窗口化回归（P1 一/二次审查实证）：限高浮层
 *（OverlayAbove maxHeight + overflow hidden）下全量渲染的列表会把焦点行
 * 裁出屏外；且窗口化若只按**项数**切片，带 description 的列表项（恒 2 行：
 * 正文 + 描述）依然会把焦点裁出去——30 行终端 30 个带描述的模型，焦点在
 * 索引 0 完全不可见，用户可能盲按 Enter（rewind 场景尤其危险）。
 *
 * 覆盖（二/三次审查 P2 要求）：
 *  - listWindow 纯函数边界表 + 性质扫描（焦点恒在窗内、窗口不超行预算）；
 *  - ListItem 单行契约直接断言：顶层字符串 / JSX 插值数组 / 嵌套 Fragment
 *    内嵌换行均被压平，description 同样单行化，实际屏幕行数与声明行高一致；
 *  - ModelPicker：30 个**带 description** 的模型，首/中焦点在屏；
 *  - HistorySearchDialog：30 条历史（每项恒 2 行 + 容器 gap=1），首/中/末焦点在屏；
 *  - ThemePicker：displayName 含内部换行的自定义主题单行渲染（生产路径）；
 *  - SessionTree（RewindPicker 的继任者，双击 Esc）：30 个用户条目，
 *    首/中/末焦点在屏（打开即聚焦 live tip = 最新一条）。
 *
 * "在屏"判定：焦点行的 ❯/正文是 suggestion 主题色（#ABC2EC），逐单元格
 * 比对前景色——转录里同文本的用户消息回显行（灰底）不会误判为在屏。
 *
 * 运行：node --import tsx/esm scripts/repro-picker-windowing.tsx
 * DUMP=1 可在每个断言点转储屏幕。
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

// 隔离家目录：modelPrefs/history 在模块加载时解析 homedir()，必须先切到
// 临时目录再 import src；picker 交互不落任何真实偏好文件。
// HOME 与 USERPROFILE 必须成对设置：os.homedir() 在 POSIX 读 HOME、在 Windows
// 读 USERPROFILE，只设一个等于在另一个平台上根本没有隔离。
const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const reproHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-repro-home-'))
process.env.HOME = reproHome
process.env.USERPROFILE = reproHome

// ctrl+r 数据源：30 条历史命令（每项渲染 2 行：命令 + age 描述）。
const NOW = Date.now()
mkdirSync(joinPath(process.env.HOME, '.dsh-tui'), { recursive: true })
writeFileSync(
  joinPath(process.env.HOME, '.dsh-tui', 'history.jsonl'),
  Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({ text: `histcmd-${String(i).padStart(2, '0')}`, ts: NOW }),
  ).join('\n') + '\n',
  'utf8',
)
// /theme 数据源：displayName 带内部换行的自定义主题（customTheme 允许保
// 留内部换行；ThemePicker 的 label 是包着 displayName 的 Fragment——三轮
// 审查实证的生产路径）。
mkdirSync(joinPath(process.env.HOME, '.dsh-tui', 'themes'), { recursive: true })
writeFileSync(
  joinPath(process.env.HOME, '.dsh-tui', 'themes', 'nltheme.json'),
  JSON.stringify({ name: 'nltheme', displayName: 'Foo\nBar NL', base: 'dark' }) + '\n',
  'utf8',
)

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, Text },
  { Chat },
  { QuestionStore },
  { createChannel },
  { listWindow },
  { ListItem },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/listWindow.js'),
  import('../src/components/design-system/ListItem.js'),
])

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    term.write(String(chunk), () => cb())
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// console.error 收集（四/五次审查）：生产默认 patchConsole，React key
// warning 会被写进错误日志而非终端；这里拦截 console.error 并在结尾做
// **严格零断言**——只筛 React 警告会静默吞掉其他错误让 CI 误绿（五次审查
// 实证：注入 console.error('synthetic failure') 后脚本仍报通过）。
const consoleErrors: string[] = []
const origConsoleError = console.error
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(' '))
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
function screenLines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = buf.baseY; y < buf.baseY + ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}
function dump(tag: string) {
  if (process.env.DUMP !== '1') return
  console.log(`--- dump: ${tag}`)
  screenLines().forEach((l, i) => console.log(String(i).padStart(2), l.replace(/\s+$/u, '').slice(0, 90)))
}

/** dark 主题 suggestion 色（焦点行 ❯/正文的 fg）。 */
const SUGGESTION_RGB = 0xABC2EC
/**
 * 焦点行是否在屏：含 `text` 且至少一个单元格前景为 suggestion 色。转录里
 * 同文本的用户消息回显行不是这个颜色，不会被误判（rewind 断言依赖这点）。
 */
function focusLineVisible(text: string): boolean {
  const buf = term.buffer.active
  for (let y = buf.baseY; y < buf.baseY + ROWS; y++) {
    const line = buf.getLine(y)
    if (!line || !line.translateToString(true).includes(text)) continue
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)
      if (cell && cell.getChars() && (cell.getFgColor() & 0xffffff) === SUGGESTION_RGB) return true
    }
  }
  return false
}

// ---------------------------------------------------------------- listWindow
// 纯函数边界表（二次审查建议）：每个用例的期望值都按"焦点居中、两侧交替扩
// 张、预算内尽量多放"手工推过。
const winCases: Array<{
  name: string
  heights: number[]
  focus: number
  maxRows: number
  gap?: number
  want: readonly [number, number]
}> = [
  { name: '空列表', heights: [], focus: 0, maxRows: 10, want: [0, 0] },
  { name: '单项', heights: [2], focus: 0, maxRows: 10, want: [0, 1] },
  { name: '焦点上越界 clamp', heights: [1, 1, 1], focus: 99, maxRows: 3, want: [0, 3] },
  { name: '焦点下越界 clamp', heights: [1, 1, 1], focus: -1, maxRows: 3, want: [0, 3] },
  { name: '单行居中', heights: Array(30).fill(1), focus: 10, maxRows: 5, want: [8, 13] },
  { name: '首边界', heights: Array(30).fill(1), focus: 0, maxRows: 5, want: [0, 5] },
  { name: '末边界', heights: Array(30).fill(1), focus: 29, maxRows: 5, want: [25, 30] },
  { name: '偶数预算偏上', heights: Array(30).fill(1), focus: 10, maxRows: 4, want: [8, 12] },
  { name: '预算 1 仅焦点', heights: Array(30).fill(1), focus: 10, maxRows: 1, want: [10, 11] },
  { name: '预算 0 仍含焦点', heights: Array(30).fill(1), focus: 10, maxRows: 0, want: [10, 11] },
  { name: '双行项按行切', heights: Array(30).fill(2), focus: 0, maxRows: 17, want: [0, 8] },
  { name: '双行+gap', heights: Array(30).fill(2), focus: 0, maxRows: 12, gap: 1, want: [0, 4] },
  { name: '混合行高（首项 2 行）', heights: [2, ...Array(29).fill(1)], focus: 0, maxRows: 4, want: [0, 3] },
  { name: '焦点项自身超预算', heights: [5, 5, 5], focus: 1, maxRows: 3, want: [1, 2] },
  { name: 'gap 居中', heights: Array(30).fill(1), focus: 10, maxRows: 5, gap: 1, want: [9, 12] },
]
for (const c of winCases) {
  const got = listWindow(c.heights, c.focus, c.maxRows, c.gap ?? 0)
  check(
    `listWindow ${c.name}`,
    got.start === c.want[0] && got.end === c.want[1],
    `want [${c.want[0]},${c.want[1]}) got [${got.start},${got.end})`,
  )
}
// 性质扫描：任意输入下焦点恒在窗内；窗口超过预算只允许发生在"仅焦点项"时。
{
  let sweepOk = true
  let badCase = ''
  const patterns = [Array(30).fill(1), Array(30).fill(2), [2, ...Array(29).fill(1)]]
  for (const heights of patterns) {
    for (const gap of [0, 1]) {
      for (let maxRows = 0; maxRows <= 20; maxRows++) {
        for (let focus = 0; focus < 30; focus++) {
          const { start, end } = listWindow(heights, focus, maxRows, gap)
          let used = 0
          for (let i = start; i < end; i++) used += heights[i] + (i > start ? gap : 0)
          if (!(start <= focus && focus < end) || (end - start > 1 && used > maxRows)) {
            sweepOk = false
            badCase = `len=${heights.length} h0=${heights[0]} gap=${gap} maxRows=${maxRows} focus=${focus} → [${start},${end}) used=${used}`
            break
          }
        }
      }
    }
  }
  check('listWindow 性质扫描（焦点在窗内且不超预算）', sweepOk, badCase)
}

// ------------------------------------------- ListItem 单行契约（三轮审查 P2）
// 直接渲染带标记行的组件树，断言实际屏幕行数与声明行高一致：换行压平必须
// 穿透顶层字符串、JSX 插值数组、嵌套 Fragment；description 同样单行化。
{
  const term2 = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout2 extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      term2.write(String(chunk), () => cb())
    }
  }
  const ui2 = await render(
    <Box flexDirection="column">
      <Text>M0</Text>
      <ListItem isFocused>{'Foo\nBar'}</ListItem>
      <Text>M1</Text>
      <ListItem isFocused>{'aa\nbb'} / {'cc'}</ListItem>
      <Text>M2</Text>
      <ListItem isFocused>
        <>
          {'Frag\nMent'}
          {'  '}
          <Text>XX</Text>
        </>
      </ListItem>
      <Text>M3</Text>
      <ListItem isFocused description={'D1\nD2'}>
        Plain
      </ListItem>
      <Text>M4</Text>
    </Box>,
    { stdout: new FakeStdout2(), stdin: new FakeStdin(), stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)
  const lines2: string[] = []
  for (let y = term2.buffer.active.baseY; y < term2.buffer.active.baseY + ROWS; y++) {
    lines2.push(term2.buffer.active.getLine(y)?.translateToString(true) ?? '')
  }
  const rowOf2 = (needle: string) => lines2.findIndex(l => l.includes(needle))
  check('契约：顶层字符串换行压平（恰 1 行）',
    rowOf2('M1') === rowOf2('M0') + 2 && (lines2[rowOf2('M0') + 1] ?? '').includes('Foo Bar'),
    lines2.slice(rowOf2('M0'), rowOf2('M1') + 1).map(l => l.trim()).join(' ⏎ '))
  check('契约：插值数组字符串片段换行压平（恰 1 行）',
    rowOf2('M2') === rowOf2('M1') + 2 && (lines2[rowOf2('M1') + 1] ?? '').includes('aa bb / cc'),
    lines2.slice(rowOf2('M1'), rowOf2('M2') + 1).map(l => l.trim()).join(' ⏎ '))
  check('契约：Fragment 内字符串换行压平（恰 1 行，色块同行）',
    rowOf2('M3') === rowOf2('M2') + 2 &&
      (lines2[rowOf2('M2') + 1] ?? '').includes('Frag Ment') &&
      (lines2[rowOf2('M2') + 1] ?? '').includes('XX'),
    lines2.slice(rowOf2('M2'), rowOf2('M3') + 1).map(l => l.trim()).join(' ⏎ '))
  check('契约：description 换行压平（正文+描述恰 2 行）',
    rowOf2('M4') === rowOf2('M3') + 3 && (lines2[rowOf2('M3') + 2] ?? '').includes('D1 D2'),
    lines2.slice(rowOf2('M3'), rowOf2('M4') + 1).map(l => l.trim()).join(' ⏎ '))
  ui2.unmount()
}

// ----------------------------------------------------------------- app 场景
// 30 轮用户消息垫底（会话树数据源；树行旧→新自上而下，live tip = 最新一条）。
const events: Array<Record<string, unknown>> = []
for (let i = 0; i < 30; i++) {
  events.push(
    { seq: i * 3, time: NOW + i * 30, type: 'turn/start', data: { turn: i } },
    {
      seq: i * 3 + 1,
      time: NOW + i * 30 + 5,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `rewind 消息 ${String(i).padStart(2, '0')}` }] },
    },
    { seq: i * 3 + 2, time: NOW + i * 30 + 10, type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } },
  )
}
const stubAgentCtx = { on: () => () => {} }
function makeAgent(id: string, sessionEvents: readonly unknown[]) {
  return {
    id, status: 'idle',
    session: { id: `s-${id}`, seq: sessionEvents.length, events: sessionEvents, header: {} },
    ctx: stubAgentCtx, followup() {}, steer() {}, inbox: { remove: () => true },
  }
}
// 30 个**带 description** 的模型：每项 2 行——一次审查后的无描述场景
// 已不能覆盖这条生产路径（二次审查实证：索引 0 焦点仍被裁出屏外）。
const MODELS = Array.from({ length: 30 }, (_, i) => ({
  provider: 'fake-provider',
  id: `model-${String(i).padStart(2, '0')}`,
  name: `Model ${String(i).padStart(2, '0')}`,
  description: `fake model desc ${String(i).padStart(2, '0')}`,
}))
const services: Record<string, unknown> = {
  sessions: { fork(session: { events: readonly unknown[] }) { return { events: session.events } } },
  agents: {
    async create(options: { sessionId: string; seed: readonly unknown[] }) {
      return { agent: makeAgent('fork-1', options.seed), dispose: async () => {} }
    },
  },
  llm: {
    listProviders: () => [{ id: 'fake-provider' }],
    listModels: async () => MODELS,
  },
  // 会话树的数据源（RewindPicker 时代不需要）：空后端——隔离 HOME 下没有
  // 持久化会话文件，家族 = live 会话自己。
  sessionPersistence: {
    list: async () => [],
  },
}
const ctx = {
  on: () => () => {},
  get: (name: string) => services[name],
  logger: { warn() {} },
}
const channel = createChannel(ctx as never, makeAgent('a1', events) as never, {
  model: 'model-00', cwd: '/tmp/demo', provider: 'fake-provider', activity: false,
})

const stdin = new FakeStdin()
const instance = await render(
  <Chat channel={channel as never} questionStore={new QuestionStore()} onExit={() => {}} />,
  { stdout: new FakeStdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200)

const typeKeys = async (s: string, stepMs = 40) => {
  for (const ch of s) { stdin.write(ch); await sleep(stepMs) }
}

// ------------------------------------------------------------- ModelPicker
{
  const bufBefore = term.buffer.active.length
  await typeKeys('/model')
  await sleep(200)
  stdin.write('\r')
  await sleep(600)
  // 焦点初始落在当前模型 model-00（索引 0）：每项 2 行也必须留在屏内。
  check('/model 焦点 0 在屏（带描述，每项 2 行）', focusLineVisible('Model 00'))
  check('/model 打开缓冲区零增长', term.buffer.active.length === bufBefore,
    `${bufBefore} → ${term.buffer.active.length}`)
  dump('model focus 0')
  for (let i = 0; i < 20; i++) { stdin.write('\x1b[B'); await sleep(25) }
  await sleep(400)
  check('/model ↓×20 焦点 20 在屏', focusLineVisible('Model 20'))
  dump('model focus 20')
  stdin.write('\x1b')
  await sleep(400)
}

// ----------------------------------------------------- HistorySearchDialog
{
  const bufBefore = term.buffer.active.length
  stdin.write('\x12') // ctrl+r
  await sleep(500)
  // 历史新→旧：最新一条是上一阶段真实键入的 '/model'（appendHistory 落盘），
  // 之后才是预置的 histcmd-29…00。焦点 0 = '/model'。
  check('ctrl+r 焦点 0 在屏（2 行项 + gap）', focusLineVisible('/model'))
  check('ctrl+r 打开缓冲区零增长', term.buffer.active.length === bufBefore,
    `${bufBefore} → ${term.buffer.active.length}`)
  dump('history focus 0')
  stdin.write('\x1b[A') // ↑ 从 0 回绕到末项
  await sleep(300)
  check('ctrl+r ↑ 回绕末项焦点在屏', focusLineVisible('histcmd-00'))
  stdin.write('\x1b[B') // ↓ 回绕回 0
  await sleep(200)
  for (let i = 0; i < 15; i++) { stdin.write('\x1b[B'); await sleep(25) }
  await sleep(300)
  // 索引 15 = histcmd-15（索引 0 是 '/model'，索引 1 才是 histcmd-29）。
  check('ctrl+r ↓×15 焦点 15 在屏', focusLineVisible('histcmd-15'))
  dump('history focus 15')
  stdin.write('\x1b')
  await sleep(400)
}

// ------------------------------------------------------------ ThemePicker
// 生产路径（三轮审查 P2）：displayName 含内部换行的自定义主题，label 是包
// 着 displayName + 色块的 Fragment。压平后该行只占一行且名字与色块同行。
// 放在 history 阶段之后：键入 '/theme' 会落一条历史，不影响前面的断言。
{
  await typeKeys('/theme')
  await sleep(200)
  stdin.write('\r')
  await sleep(600)
  const lines = screenLines()
  const nameRow = lines.findIndex(l => l.includes('Foo Bar NL'))
  check('/theme 换行 displayName 单行渲染且色块同行',
    nameRow !== -1 && (lines[nameRow] ?? '').includes('██'),
    nameRow === -1 ? '未找到 Foo Bar NL 行' : lines[nameRow]!.trim().slice(0, 60))
  check('/theme 无换行泄漏行（Bar NL 不得单独成行）',
    !lines.some(l => /^\s*Bar NL/u.test(l)))
  dump('theme newline displayName')
  stdin.write('\x1b')
  await sleep(400)
}

// ------------------------------------------------------------ SessionTree
// RewindPicker 的继任者（双击 Esc 会话树）：同一份窗口化回归——30 个用户
// 条目（30 轮各一条），焦点必须始终随窗口在屏。树行旧→新，光标初始落在
// live tip（最新一条）；无 description 行，改断言面板标题。
{
  const bufBefore = term.buffer.active.length
  stdin.write('\x1b') // 双击 Esc（空输入）打开会话树
  await sleep(100)
  stdin.write('\x1b')
  await sleep(600)
  check('tree 打开即聚焦 live tip（最新用户消息）', focusLineVisible('rewind 消息 29'))
  check('tree 面板标题在屏', screenLines().some(l => l.includes('会话树')))
  check('tree 打开缓冲区零增长', term.buffer.active.length === bufBefore,
    `${bufBefore} → ${term.buffer.active.length}`)
  dump('tree focus tip')
  stdin.write('\x1b[B') // ↓ 从末项回绕到首项 = 最老一条
  await sleep(300)
  check('tree ↓ 回绕首项焦点在屏', focusLineVisible('rewind 消息 00'))
  stdin.write('\x1b[A') // ↑ 回绕回末项
  await sleep(200)
  for (let i = 0; i < 15; i++) { stdin.write('\x1b[A'); await sleep(25) }
  await sleep(300)
  // 末项（索引 29）回退 15 行 = 索引 14。
  check('tree ↑×15 焦点 14 在屏', focusLineVisible('rewind 消息 14'))
  dump('tree focus 14')
  stdin.write('\x1b')
  await sleep(400)
}

instance.unmount()

// ------------------------------------------------------ 回退白屏（swap 重置）
// 生产事故回归：回退把一个短得多的转录换上（adoptAgent 从 id 0 重建 rows），
// 但 ScrollBox 的 scrollTop 还停在旧长日志底部，渲染器的 shrink 保护冻结该
// 帧——视口落在替换内容末尾之外（白屏直到下次输入），逐行重测又顶着回收 id
// 的旧高度把 total 推来推去（滚动抖动）。修复 = MessageList 测量缓存随
// transcriptKey 失效 + Chat 在 agentId 变化时 scrollToBottom 重钉。此处用
// 真实 rewindToNode 走完整 adoptAgent 路径：40 轮长转录 → 回退到 turn 1 的
// user 消息 → 替换为只剩 turn 0 的短转录。
{
  const term3 = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout3 extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      term3.write(String(chunk), () => cb())
    }
  }
  const screen3 = (): string[] => {
    const buf = term3.buffer.active
    const out: string[] = []
    for (let y = buf.baseY; y < buf.baseY + ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
    return out
  }
  // 每轮 5 行回答 × 40 轮：转录远超视口，回退前底部 scrollTop 远大于 0。
  const bigEvents: Array<Record<string, unknown>> = []
  for (let i = 0; i < 40; i++) {
    bigEvents.push(
      { seq: i * 4, time: NOW + i * 40, type: 'turn/start', data: { turn: i } },
      {
        seq: i * 4 + 1, time: NOW + i * 40 + 5, type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `长屏 问题 ${String(i).padStart(2, '0')}` }] },
      },
      {
        seq: i * 4 + 2, time: NOW + i * 40 + 10, type: 'assistant/message',
        data: {
          turn: i, step: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${String(i).padStart(2, '0')}\n第二行\n第三行\n第四行\n第五行` }] },
        },
      },
      { seq: i * 4 + 3, time: NOW + i * 40 + 15, type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } },
    )
  }
  const channel3 = createChannel(ctx as never, makeAgent('big', bigEvents) as never, {
    model: 'model-00', cwd: '/tmp/demo', provider: 'fake-provider', activity: false,
  })
  const stdout3 = new FakeStdout3()
  const instance3 = await render(
    <Chat channel={channel3 as never} questionStore={new QuestionStore()} onExit={() => {}} />,
    { stdout: stdout3 as never, stdin: new FakeStdin(), stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(1500)
  const pre = screen3()
  check('白屏回归预检：长转录尾部在屏', pre.some(l => l.includes('回答 39')))
  check('白屏回归预检：开头不在屏（转录确长）', !pre.some(l => l.includes('长屏 问题 00')))
  // 真实回退：选中 turn 1 的 ASSISTANT 消息（seq 6）→ 保留 turn 0+1，其余
  // 丢弃。两个生产病理条件缺一不可：① fork 前缀与旧转录逐行相同（重测高度
  // 无变化，不触发重绘）② 非 user 条目（restoredText 为空，输入框回填也不
  // 触发重绘）——没有修复时 shrink 帧冻结的 scrollTop 没有任何后续帧纠正。
  await channel3.rewindToNode('s-big', 6)
  await sleep(1200)
  const post = screen3()
  check('回退后短转录头部在屏（无白屏）', post.some(l => l.includes('长屏 问题 00')),
    post.map(l => l.trim()).filter(Boolean).slice(0, 6).join(' | '))
  check('回退后短转录尾部在屏', post.some(l => l.includes('回答 01')))
  check('回退后旧尾部已替换', !post.some(l => l.includes('回答 39')) && !post.some(l => l.includes('回答 02')))
  instance3.unmount()
}

// 先恢复再断言：恢复后产生的错误走原生 console.error 直接可见，不会被吞；
// 若上面任一阶段抛异常，顶层未捕获即以非零退出，CI 照样红。
console.error = origConsoleError
check('全程无 console.error（React key warning 等）', consoleErrors.length === 0,
  consoleErrors[0]?.split('\n')[0]?.slice(0, 120) ?? '')
if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
