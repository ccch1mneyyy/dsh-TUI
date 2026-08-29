/**
 * /resume・/tree 搜索框显示塌缩回归：
 *
 * SearchBox 的单行窗口化预算取自 measureElement 实测的自身内容宽度，前提是
 * 「框宽与查询内容无关」（定宽）。SearchBox 被放在默认 row 方向、无 width
 * prop 的 Box 里时，框宽=上一帧内容宽 → 预算随内容收缩 → 反馈回路收敛到
 * 「前缀 + 1 字符 + 反色 caret」——只看得见最新输入的字符，前面的字符全部
 * 被 windowQuery 丢弃。查询状态本身完整（列表过滤一直正常），坏的只是显示。
 *
 * 基线说明：/resume 搜索卡片已在 #589 定宽（borderless + width="100%"），
 * 场景 1–4 锁定该正确行为防再腐坏；同一前提仍被违反的是 /resume 的 rename
 * 编辑器与 /tree 搜索卡片（场景 5、6），修复前必红。
 *
 * 断言：
 *   1. 逐键英文输入 a·b·c：三键后查询 'abc' 完整可见
 *   2. 续输 d：'abcd' 完整可见
 *   3. IME 整段上屏（单 chunk 多字符）：第二次上屏后 '深度思考' 完整可见
 *   4. 退格：剩余查询 '深度思' 仍完整可见
 *   5. rename 编辑器（ctrl+r 预填标题 + 追加 XX）：标题+XX 完整可见
 *      （塌缩时预填标题头部被窗口化丢弃）
 *   6. /tree 搜索：逐键输入 'ab' 完整可见（塌缩时只见 'b'）
 *   7. /tree 定宽下超长查询单行窗口化：尾部 'END' 可见、头部 'START' 滚出、
 *      行不折行（守住窗口化语义，防修复把横向滚动改成折行/撑破布局）
 *
 * 运行：node --import tsx/esm scripts/verify-session-browser-searchbox.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

// 语言与主题在 import 前钉死：文案断言与布局测量都依赖确定的界面语言，
// CI 的 LANG 环境不应影响默认语言解析（verify-session-tree 同款做法）。
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider, AlternateScreen },
  { SessionBrowser },
  { SessionTree },
  sessionTree,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/SessionBrowser.js'),
  import('../src/screens/SessionTree.js'),
  import('../src/dsh-adapter/sessionTree.js'),
])

/** 帧间 pacing：让一次 stdin 写入完整走完「解析→渲染→xterm 呈现」再发下一键。 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failed = 0

/** 断言计数器：FAIL 累计，脚本末尾以非零退出码交给 CI。 */
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

type Summary = {
  id: string
  kind: { kind: string; parent?: string; depth?: number }
  title: { text: string; source: string }
  cwd: string
  createdAt: number
  updatedAt: number
  bytes: number
  hasPrompt: boolean
  agentPreset: string
  model: string
  label?: string
  branch?: string
  childCount: number
}

/** SessionSummary 最小工厂：只覆盖浏览器渲染读取的字段，其余给安全默认值。 */
const summary = (over: Partial<Summary>): Summary => ({
  id: 'id',
  kind: { kind: 'root' },
  title: { text: 'title', source: 'auto' },
  cwd: '/tmp/project',
  createdAt: 1,
  updatedAt: 1,
  bytes: 2048,
  hasPrompt: true,
  agentPreset: 'standard',
  model: 'deepseek-v4-pro',
  label: undefined,
  branch: 'feat/trajectory',
  childCount: 0,
  ...over,
})

const S1_TITLE = '深度思考，全面分析当前实现的每一处细节并给出结论'

const SESSIONS: Summary[] = [
  summary({ id: 's1', title: { text: S1_TITLE, source: 'auto' }, updatedAt: 9 }),
  summary({ id: 's2', title: { text: 'a fairly long english session title that keeps going', source: 'renamed' }, updatedAt: 8 }),
  summary({ id: 's3', title: { text: '恢复会话', source: 'prompt' }, updatedAt: 7 }),
]

/** channel stub：listSessions 出三个会话，其余动作为成功 no-op。 */
function makeChannel() {
  return {
    cwd: '/tmp/project',
    gitBranch: 'feat/trajectory',
    agentId: 'live',
    listSessions: async () => SESSIONS.map(s => ({ ...s })),
    previewSession: async () => [],
    notify() {},
    resumeTo: async () => ({ ok: true }),
    deleteSession: async () => true,
    renameSessionTo: async () => true,
  }
}

/** sameProject stub：路径相等即同项目（浏览器按 cwd 分组用）。 */
const sameProject = (a: string, b: string) => a === b

/**
 * 无头 xterm 挂具：FakeStdout 把渲染输出喂给仿真终端，FakeStdin 接收键序
 * （模拟真实打字的独立 chunk）；searchRow/renameRow 按前缀字符定位输入行，
 * wrappedContinuations 收集折行续行供严格单行断言。
 */
function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdout = new FakeStdout() as FakeStdout & NodeJS.WriteStream
  const stderr = new Writable({ write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }) as Writable & NodeJS.WriteStream
  stderr.isTTY = true
  const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
  const lines = (): string[] => {
    const buf = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
  }
  /** 折行续行（上一行溢出）：修复若破坏单行窗口化，查询行会在这里现形。 */
  const wrappedContinuations = (): string[] => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.baseY + y)
      if (line?.isWrapped) out.push(line.translateToString(true))
    }
    return out
  }
  const searchRow = (): string => lines().find(l => l.includes('⌕')) ?? ''
  const renameRow = (): string => lines().find(l => l.includes('✎')) ?? ''
  /** 逐键写入并分帧：模拟真实打字（每键独立 stdin chunk、独立渲染帧）。 */
  const type = async (text: string, paceMs = 140): Promise<void> => {
    for (const ch of text) {
      stdin.write(ch)
      await sleep(paceMs)
    }
  }
  return { term, stdout, stderr, stdin, lines, wrappedContinuations, searchRow, renameRow, type }
}

/** 挂载 /resume 会话浏览器，并等会话列表异步加载完成后再交出发键权。 */
async function mountBrowser(cols = 120, rows = 30) {
  const h = makeHarness(cols, rows)
  const instance = await render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(SessionBrowser, {
        channel: makeChannel(),
        home: '/home/tester',
        sameProject,
        onClose: () => {},
      }),
    ),
    { stdout: h.stdout, stderr: h.stderr, stdin: h.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  // 等会话列表异步加载完成（s1 标题上屏）再发键。哨兵是 channel stub 的
  // 数据文案，不随界面语言变化。
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && !h.lines().some(l => l.includes('全面分析'))) await sleep(30)
  return { h, instance }
}

// /tree 所需的最小家族：单根 R（一轮完整对话 + 标题）。
/** 合成最小会话事件（scripts 不进 tsc，宽塑形即可）。 */
const ev = (type: string, seq: number, data: unknown): { type: string; seq: number; time: number; data: unknown } =>
  ({ type, seq, time: 1000 + seq, data })
const ROOT_LOG = [
  ev('turn/start', 0, { turn: 0 }),
  ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'u0-问根' }] }),
  ev('assistant/message', 2, { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'a0-答根' }] } }),
  ev('turn/end', 3, { turn: 0, reason: { kind: 'completed' } }),
  ev('session/title', 4, { title: '根会话标题' }),
]

/** 挂载 /tree 会话树（AlternateScreen + 最小单根家族），等搜索框就绪。 */
async function mountTree(cols = 120, rows = 30) {
  const h = makeHarness(cols, rows)
  const data = sessionTree.buildSessionTree(
    [{ id: 'R', createdAt: 1, events: ROOT_LOG, live: true, tailComplete: true }],
    'R',
  )
  const channel = {
    agentId: 'R',
    buildSessionTree: async () => data,
    rewindToNode: async () => '',
    notify() {},
  }
  const instance = await render(
    React.createElement(
      AlternateScreen,
      null,
      React.createElement(SessionTree, {
        channel,
        currentSessionId: 'R',
        onClose: () => {},
        onRestoreText: () => {},
      }),
    ),
    { stdout: h.stdout, stderr: h.stderr, stdin: h.stdin, exitOnCtrlC: false, patchConsole: false },
  )
  // 语言无关哨兵：SearchBox 的 ⌕ 前缀恒渲染（不依赖本地化文案），出现即
  // 搜索框已挂载，可直接发键。
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && !h.lines().some(l => l.includes('⌕'))) await sleep(30)
  return { h, instance }
}

// ── 1+2：逐键英文输入，查询必须完整可见 ─────────────────────────────────
{
  const { h, instance } = await mountBrowser()
  await h.type('abc')
  check(
    "逐键输入 abc：'abc' 完整可见",
    h.searchRow().includes('abc'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 40))}`,
  )
  await h.type('d')
  check(
    "续输 d：'abcd' 完整可见",
    h.searchRow().includes('abcd'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 40))}`,
  )
  instance.unmount()
  h.term.dispose()
  await sleep(20)
}

// ── 3+4：IME 整段上屏 + 退格 ────────────────────────────────────────────
{
  const { h, instance } = await mountBrowser()
  h.stdin.write('深度')
  await sleep(200)
  check(
    "首次上屏 '深度'：完整可见",
    h.searchRow().includes('深度'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 40))}`,
  )
  h.stdin.write('思考')
  await sleep(200)
  check(
    "二次上屏后 '深度思考' 完整可见",
    h.searchRow().includes('深度思考'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 40))}`,
  )
  h.stdin.write('\x7f') // backspace
  await sleep(200)
  check(
    "退格后剩余查询 '深度思' 完整可见",
    h.searchRow().includes('深度思'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 40))}`,
  )
  instance.unmount()
  h.term.dispose()
  await sleep(20)
}

// ── 5：rename 编辑器（预填标题 + 追加） ─────────────────────────────────
{
  const { h, instance } = await mountBrowser()
  h.stdin.write('\x12') // ctrl+r → rename，预填 focused 标题
  await sleep(200)
  check(
    'rename 预填标题完整可见',
    h.renameRow().includes(S1_TITLE),
    `renameRow=${JSON.stringify(h.renameRow().slice(0, 60))}`,
  )
  await h.type('XX')
  check(
    "rename 追加 XX 后 '标题XX' 完整可见",
    h.renameRow().includes(`${S1_TITLE}XX`),
    `renameRow=${JSON.stringify(h.renameRow().slice(0, 60))}`,
  )
  instance.unmount()
  h.term.dispose()
  await sleep(20)
}

// ── 6+7：/tree 搜索（同一前提违反，修复前必红） ─────────────────────────
{
  const { h, instance } = await mountTree()
  await h.type('ab')
  check(
    "/tree 逐键输入 'ab' 完整可见",
    h.searchRow().includes('ab'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 40))}`,
  )
  // 单 chunk 整段到达（等价粘贴）：查询一次到位，围绕 caret 只显示尾部窗口。
  h.stdin.write(`START${'x'.repeat(150)}END`)
  await sleep(300)
  check(
    "/tree 超长查询：尾部 'END' 可见",
    h.searchRow().includes('END'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 60))}`,
  )
  check(
    "/tree 超长查询：头部 'START' 已滚出窗口",
    !h.searchRow().includes('START'),
    `searchRow=${JSON.stringify(h.searchRow().slice(0, 60))}`,
  )
  check(
    '/tree 超长查询：不产生折行续行（严格单行）',
    h.wrappedContinuations().length === 0,
    `wrapped=${JSON.stringify(h.wrappedContinuations().slice(0, 2))}`,
  )
  instance.unmount()
  h.term.dispose()
  await sleep(20)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall session-browser searchbox checks passed')
