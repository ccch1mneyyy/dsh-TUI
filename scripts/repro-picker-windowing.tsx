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
 *  - RewindPicker：30 条用户消息，首/中/末焦点在屏（首项带 'last message' 描述）。
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
  { settle, settled, sleep, viewportLines },
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
  import('./lib/term-test.mjs'),
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
  // 落定：等全部标记行（M0..M4）上屏（原固定 300ms）——断言在 settle 捕获
  // 的同一快照 lines2 上求值，无重读分叉。
  let lines2: string[] = []
  await settle(() => {
    lines2 = viewportLines(term2, ROWS)
    return ['M0', 'M1', 'M2', 'M3', 'M4'].every(m => lines2.some(l => l.includes(m)))
  })
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
// 30 轮用户消息垫底（rewind 数据源；rewind 列表 = 用户消息新→旧）。
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
// boot 落定：转录尾行上屏即可开始逐键交互（原固定 1200ms）。
await settle(() => screenLines().some(l => l.includes('rewind 消息 29')))

// 逐键 stepMs 与各步 100–400ms 固定窗口为按键序列的 ordering pacing：
// 浮层 key-ready / 关闭过渡无法用纯文本屏幕内容观测（同 repro-settings）。
const typeKeys = async (s: string, stepMs = 40) => {
  for (const ch of s) { stdin.write(ch); await sleep(stepMs) }
}

// ------------------------------------------------------------- ModelPicker
{
  const bufBefore = term.buffer.active.length
  await typeKeys('/model')
  await sleep(200)
  stdin.write('\r')
  // 焦点初始落在当前模型 model-00（索引 0）：每项 2 行也必须留在屏内。
  check('/model 焦点 0 在屏（带描述，每项 2 行）', await settled(() => focusLineVisible('Model 00')))
  check('/model 打开缓冲区零增长', term.buffer.active.length === bufBefore,
    `${bufBefore} → ${term.buffer.active.length}`)
  dump('model focus 0')
  for (let i = 0; i < 20; i++) { stdin.write('\x1b[B'); await sleep(25) }
  check('/model ↓×20 焦点 20 在屏', await settled(() => focusLineVisible('Model 20')))
  dump('model focus 20')
  stdin.write('\x1b')
  await sleep(400)
}

// ----------------------------------------------------- HistorySearchDialog
{
  const bufBefore = term.buffer.active.length
  stdin.write('\x12') // ctrl+r
  // 历史新→旧：最新一条是上一阶段真实键入的 '/model'（appendHistory 落盘），
  // 之后才是预置的 histcmd-29…00。焦点 0 = '/model'。
  check('ctrl+r 焦点 0 在屏（2 行项 + gap）', await settled(() => focusLineVisible('/model')))
  check('ctrl+r 打开缓冲区零增长', term.buffer.active.length === bufBefore,
    `${bufBefore} → ${term.buffer.active.length}`)
  dump('history focus 0')
  stdin.write('\x1b[A') // ↑ 从 0 回绕到末项
  check('ctrl+r ↑ 回绕末项焦点在屏', await settled(() => focusLineVisible('histcmd-00')))
  stdin.write('\x1b[B') // ↓ 回绕回 0
  await sleep(200)
  for (let i = 0; i < 15; i++) { stdin.write('\x1b[B'); await sleep(25) }
  // 索引 15 = histcmd-15（索引 0 是 '/model'，索引 1 才是 histcmd-29）。
  check('ctrl+r ↓×15 焦点 15 在屏', await settled(() => focusLineVisible('histcmd-15')))
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
  // 断言在 settle 捕获的同一快照 lines 上求值，无重读分叉。
  let lines: string[] = []
  await settle(() => {
    lines = screenLines()
    const row = lines.findIndex(l => l.includes('Foo Bar NL'))
    return row !== -1 && (lines[row] ?? '').includes('██')
  })
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

// ------------------------------------------------------------ RewindPicker
{
  const bufBefore = term.buffer.active.length
  stdin.write('\x1b') // 双击 Esc（空输入）打开 rewind——双击判定窗口是墙钟语义
  await sleep(100)
  stdin.write('\x1b')
  // 焦点 0 = 最新用户消息；首项带 'last message' 描述（2 行）。
  check('rewind 焦点 0 在屏（首项 2 行）', await settled(() => focusLineVisible('rewind 消息 29')))
  check('rewind 首项描述行在屏', await settled(() => screenLines().some(l => l.includes('最近一条消息'))))
  check('rewind 打开缓冲区零增长', term.buffer.active.length === bufBefore,
    `${bufBefore} → ${term.buffer.active.length}`)
  dump('rewind focus 0')
  stdin.write('\x1b[A') // ↑ 回绕到末项 = 最老一条
  check('rewind ↑ 回绕末项焦点在屏', await settled(() => focusLineVisible('rewind 消息 00')))
  stdin.write('\x1b[B') // ↓ 回绕回 0
  await sleep(200)
  for (let i = 0; i < 15; i++) { stdin.write('\x1b[B'); await sleep(25) }
  // 索引 15 = rewind 消息 14（索引 0 是最新的 29）。
  check('rewind ↓×15 焦点 15 在屏', await settled(() => focusLineVisible('rewind 消息 14')))
  dump('rewind focus 15')
  stdin.write('\x1b')
  await sleep(400)
}

instance.unmount()
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
