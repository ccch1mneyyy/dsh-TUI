/**
 * 全屏模式残影复现（issue #39 DECSTBM 快速路径假设 + #38/#19 滚动场景）：
 * 两套预言机——
 * 1. 终态等价：同一份最终 UI 状态，增量流式渲染出的终端屏幕（xterm A）
 *    与全新挂载渲染出的屏幕（xterm B）必须一致；差异 = 差分管线 bug。
 * 2. 屏内自洽：滚动（SGR 滚轮注入 stdin）后的每一帧里，唯一标记行至多
 *    出现一次、且出现顺序符合文档序；重复/乱序 = 残影。
 *
 * 病理条件（照 #39 假设）：尾部流式增长的同时，中部 reasoning 行折叠
 * （高度收缩）——制造"高度增长量与 scrollTop delta 不一致"的帧。
 * 运行：node --import tsx/esm scripts/repro-fullscreen-ghost.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'  // DEC-2026 同步输出，使 DECSTBM 滚动优化生效
process.env.CC_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 100
const ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
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
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      term.write(String(chunk), cb)
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
  return { stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: new FakeStdin() }
}
function screenLines(term: InstanceType<typeof XTerm>): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return out
}

/** 唯一标记行：每个在完整文档里只出现一次。
 *  节标题用整行匹配（正文行是 `- 节标题 的第 N 条…`，含标题字符串但
 *  不会整行等于标题），logo/用户消息用包含匹配。 */
const MARKERS = ['一、项目定位', '三、核心功能', '五、代码结构', '七、构建与发布', '九、当前状态备注', '探索未至', '看看这个项目，给个概览']
const matchesMarker = (line: string, m: string) =>
  m === '探索未至' || m === '看看这个项目，给个概览' ? line.includes(m) : line.trim() === m
/** 屏内自洽断言：标记至多一次 + 相对顺序符合文档序。 */
function assertScreenCoherent(tag: string, lines: string[]) {
  const seen: Array<{ marker: string; row: number }> = []
  for (const m of MARKERS) {
    const rows = lines.map((l, i) => (matchesMarker(l, m) ? i : -1)).filter(i => i >= 0)
    check(`[${tag}]「${m}」至多出现一次`, rows.length <= 1, `行 ${rows.join(',')}`)
    if (rows.length === 1) seen.push({ marker: m, row: rows[0] })
  }
  const ordered = MARKERS.filter(m => seen.some(s => s.marker === m))
  const byRow = [...seen].sort((a, b) => a.row - b.row).map(s => s.marker)
  // 探索未至(logo)/用户消息在文档序里位于所有节标题之前。
  const docOrder = ['探索未至', '看看这个项目，给个概览', '一、项目定位', '三、核心功能', '五、代码结构', '七、构建与发布', '九、当前状态备注']
  const expect = docOrder.filter(m => ordered.includes(m))
  check(`[${tag}] 标记顺序符合文档序`, JSON.stringify(byRow) === JSON.stringify(expect), `实际 ${byRow.join('>')}`)
}

function makeChannel(rows: any[]) {
  const listeners = new Set<() => void>()
  const channel: any = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 500,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '看看这个项目',
    pending: [],
    commandList: [],
    notifications: [],
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
  }
  const bump = () => { channel.version++; for (const cb of listeners) (cb as () => void)() }
  return { channel, bump }
}

function seedHistory(rows: any[], idRef: { v: number }) {
  for (let turn = 0; turn < 2; turn++) {
    rows.push({ id: idRef.v++, kind: 'user', text: `历史问题 ${turn}：检查一下构建配置` })
    rows.push({ id: idRef.v++, kind: 'reasoning', text: '用户想看构建配置，先找配置文件。'.repeat(3), streaming: false, durationMs: 1200 })
    for (let t = 0; t < 4; t++) {
      rows.push({
        id: idRef.v++, kind: 'tool', text: '',
        tool: {
          callId: `h${turn}-${t}`, name: t % 2 ? 'Read' : 'Bash',
          argsText: t % 2 ? `{"file_path": "/home/demo/lib/history${turn}_${t}.dart"}` : '{"command": "git log --oneline -15"}',
          argsFull: '{}',
          status: 'ok', startedAt: 0, durationMs: 30,
          resultText: Array.from({ length: 8 + t * 5 }, (_, i) => `历史结果行 ${turn}-${t}-${i}`).join('\n'),
        },
      })
    }
    rows.push({ id: idRef.v++, kind: 'assistant', text: `历史回答 ${turn}：\n\n- 构建配置在 \`pubspec.yaml\``, streaming: false })
  }
}

const sections = ['一、项目定位', '二、技术栈', '三、核心功能', '四、数据设计要点', '五、代码结构', '六、工程规范', '七、构建与发布', '八、数据迁移', '九、当前状态备注']
function buildDocChunks(): string[] {
  const docLines: string[] = []
  for (const sec of sections) {
    docLines.push(sec + '\n')
    for (let i = 0; i < 11; i++) docLines.push(`- ${sec} 的第 ${i + 1} 条说明文字：应用装配、主题系统、同步与加密打包\n`)
    docLines.push('\n')
  }
  const doc: string[] = []
  let acc = ''
  for (const l of docLines) {
    acc += l
    if (acc.length > 60) { doc.push(acc); acc = '' }
  }
  if (acc) doc.push(acc)
  return doc
}

/** SGR 滚轮注入：64=上滚 65=下滚，坐标取屏幕中部（ScrollBox 区域内）。 */
function wheel(stdin: any, dir: 'up' | 'down', ticks: number) {
  const btn = dir === 'up' ? 64 : 65
  for (let i = 0; i < ticks; i++) stdin.write(`\x1b[<${btn};50;18M`)
}

// ═══════════════ 运行 A：增量流式（含中部折叠 + 中途滚动） ═══════════════
const termA = makeTerm()
const sA = makeStreams(termA)
const idRef = { v: 0 }
const rowsA: any[] = []
seedHistory(rowsA, idRef)
const { channel: chA, bump: bumpA } = makeChannel(rowsA)
chA.working = true
chA.activeToolCount = 1

const instA = await render(
  <AlternateScreen>
    <Chat channel={chA} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: sA.stdout as any, stdin: sA.stdin as any, stderr: sA.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
const ticker = setInterval(() => { chA.responseChars += 7; bumpA() }, 100)
await sleep(800)

rowsA.push({ id: idRef.v++, kind: 'user', text: '看看这个项目，给个概览' }); bumpA()
await sleep(120)

// 现场 reasoning：先展开流式，稍后（尾部长文流式期间）折叠 —— 制造中部高度收缩。
const think = { id: idRef.v++, kind: 'reasoning', text: '', streaming: true, durationMs: undefined as number | undefined }
rowsA.push(think); bumpA()
for (const chunk of ['先看目录结构', '，读 README 与构建配置', '，对比依赖版本', '，然后汇总要点。']) {
  think.text += chunk; bumpA(); await sleep(120)
}

const tool1 = {
  id: idRef.v++, kind: 'tool', text: '',
  tool: {
    callId: 'c1', name: 'Bash', argsText: '{"command": "git log --oneline -15"}', argsFull: '{}',
    status: 'running' as string, resultText: undefined as string | undefined, startedAt: 0, durationMs: undefined as number | undefined,
  },
}
rowsA.push(tool1); bumpA(); await sleep(300)

// 尾部长文流式；think 在第 6 块后折叠（中部收缩），tool1 在第 10 块后落定（中部增长）。
const finalMsg = { id: idRef.v++, kind: 'assistant', text: '', streaming: true }
rowsA.push(finalMsg); bumpA()
const doc = buildDocChunks()
let i = 0
for (const chunk of doc) {
  finalMsg.text += chunk
  i++
  if (i === 6) { think.streaming = false; think.durationMs = 2000 }
  if (i === 10) {
    tool1.tool.status = 'ok'
    tool1.tool.durationMs = 42
    tool1.tool.resultText = Array.from({ length: 20 }, (_, k) => `工具结果行 ${k}`).join('\n')
    chA.activeToolCount = 0
  }
  bumpA()
  await sleep(90)
  // 第 1/3 处：流式中上滚 5 格再滚回底部（issue #19 场景）。
  if (i === Math.floor(doc.length / 3)) {
    wheel(sA.stdin, 'up', 5); await sleep(200)
    assertScreenCoherent('A:流式中上滚', screenLines(termA))
    wheel(sA.stdin, 'down', 40); await sleep(200)
  }
}
finalMsg.streaming = false
chA.working = false
bumpA()
await sleep(800)
clearInterval(ticker)
await sleep(300)

const snapA_bottom = screenLines(termA)
assertScreenCoherent('A:终态底部', snapA_bottom)

// 回合结束后上滚（issue #38 场景）：逐段上滚到顶，每步屏内自洽。
wheel(sA.stdin, 'up', 10); await sleep(250)
assertScreenCoherent('A:上滚10', screenLines(termA))
wheel(sA.stdin, 'up', 60); await sleep(300)
assertScreenCoherent('A:滚到顶', screenLines(termA))
wheel(sA.stdin, 'down', 90); await sleep(300)
const snapA_rebottom = screenLines(termA)
assertScreenCoherent('A:滚回底部', snapA_rebottom)

// 终态快照（供 B 对比）：深拷贝行数据。
const finalRows = structuredClone(rowsA)
await instA.unmount()

// ═══════════════ 运行 B：同一终态全新挂载（黄金基准） ═══════════════
const termB = makeTerm()
const sB = makeStreams(termB)
const { channel: chB, bump: bumpB } = makeChannel(finalRows)
const instB = await render(
  <AlternateScreen>
    <Chat channel={chB} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: sB.stdout as any, stdin: sB.stdin as any, stderr: sB.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(1000)
const snapB_bottom = screenLines(termB)
await instB.unmount()

// ═══════════════ 终态等价对比 ═══════════════
// 状态栏行含 tps/ctx 等易变读数，对比时归一化掉数字。
const normalize = (l: string) => l.replace(/\d+(\.\d+)?/g, '#')
let diffCount = 0
const diffs: string[] = []
for (let y = 0; y < ROWS; y++) {
  const a = normalize(snapA_bottom[y] ?? '')
  const b = normalize(snapB_bottom[y] ?? '')
  if (a !== b) {
    diffCount++
    diffs.push(`  行${String(y).padStart(2)} A|${snapA_bottom[y]}`)
    diffs.push(`      B|${snapB_bottom[y]}`)
  }
}
check('终态等价：增量渲染 == 全新挂载', diffCount === 0, `${diffCount} 行不同`)
if (diffCount > 0) {
  console.log('=== 终态差异（A=增量 B=全新） ===')
  console.log(diffs.join('\n'))
}
assertScreenCoherent('B:黄金基准', snapB_bottom)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
