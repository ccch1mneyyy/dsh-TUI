/**
 * /tree 搜索框显示塌缩回归：
 *
 * SearchBox 的单行窗口化预算取自 measureElement 实测的自身内容宽度，前提是
 * 「框宽与查询内容无关」（定宽）。SearchBox 被放在默认 row 方向、无 width
 * prop 的 Box 里时，框宽=上一帧内容宽 → 预算随内容收缩 → 反馈回路收敛到
 * 「前缀 + 1 字符 + 反色 caret」——只看得见最新输入的字符，前面的字符全部
 * 被 windowQuery 丢弃。查询状态本身完整（列表过滤一直正常），坏的只是显示。
 *
 * /tree 的搜索卡片违反该前提，修复前必红；场景 1–3 锁定修复后的行为。
 *
 * 断言：
 *   1. 逐键输入 'ab' 完整可见（塌缩时只见 'b'）
 *   2. 单 chunk 整段到达（等价粘贴）后，尾部 'END' 可见、头部 'START' 滚出
 *   3. 超长查询仍严格单行：不产生折行续行（守住窗口化语义，防修复把横向
 *      滚动改成折行/撑破布局）
 *
 * 运行：node --import tsx/esm scripts/verify-searchbox-windowing.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

// 语言与主题在 import 前钉死：文案断言与布局测量都依赖确定的界面语言，
// CI 的 LANG 环境不应影响默认语言解析（verify-session-tree 同款做法）。
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

// 静态 import 会提升到上面的 env 钉死之前，但 term-test 只读 process.env.CI，
// 与语言/主题无关，顺序安全。
import { settle } from './lib/term-test.mjs'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider, AlternateScreen },
  { SessionTree },
  sessionTree,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
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

/**
 * 无头 xterm 挂具：FakeStdout 把渲染输出喂给仿真终端，FakeStdin 接收键序
 * （模拟真实打字的独立 chunk）；searchRow 按前缀字符定位输入行，
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
  /** 逐键写入并分帧：模拟真实打字（每键独立 stdin chunk、独立渲染帧）。 */
  const type = async (text: string, paceMs = 140): Promise<void> => {
    for (const ch of text) {
      stdin.write(ch)
      await sleep(paceMs) // 固定窗:pacing 逐键步间，保证每键各自成 chunk 与渲染帧
    }
  }
  return { term, stdout, stderr, stdin, lines, wrappedContinuations, searchRow, type }
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
  await settle(() => h.lines().some(l => l.includes('⌕')), { timeoutMs: 4000 })
  return { h, instance }
}

// ── 1+2+3：/tree 搜索窗口化 ────────────────────────────────────────────
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
  // 固定窗:待迁移 同一个 sleep 服务下面三条断言（尾部可见 / 头部滚出 / 不折行），
  // 不是「一个 sleep 一条断言」的平凡改写形态。
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
  await sleep(20) // 固定窗:pacing 卸载/dispose 收尾
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall searchbox windowing checks passed')
