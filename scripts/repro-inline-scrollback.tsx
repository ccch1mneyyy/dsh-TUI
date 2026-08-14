/**
 * inline 模式 scrollback 污染复现（issue #38/#19/#39 统一验证）：
 * npm 安装默认 fullscreen: false —— 不进 alt screen，终端 scrollback 由
 * 终端原生接管。若增量重绘的 erase 行数与上一帧实际占行不一致（或帧高
 * 超过视口无法全部擦除），旧帧内容会永久落入 scrollback：用户上滚看到
 * "UI 重复渲染 / 启动页随机插入 / 输出结束后上方内容乱掉"。
 *
 * 场景照 issue #39：预置 2 轮历史（冷高度缓存）+ 长流式回复 + spinner/
 * 指标独立 tick。xterm-headless 开 2000 行 scrollback 重建终端视角，
 * 断言 scrollback + 视口中每段唯一 UI 文本只出现一次。
 * 运行：node --import tsx/esm scripts/repro-inline-scrollback.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'  // DEC-2026 同步输出路径（与真机 Windows Terminal/WezTerm 一致）
process.env.CC_TUI_THEME = 'dark'     // 跳过 OSC 11 探测，保持确定性

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 100
const ROWS = 40
const SCROLLBACK = 2000
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true })

const rawChunks: string[] = []
/** 逐帧账本：buffer 总行数增量 vs 该帧特征（定位污染来源）。 */
const frameLedger: Array<{ n: number; bufGrow: number; lf: number; reset: boolean; up: number; bytes: number }> = []
let frameNo = 0
let lastBufLen = 0
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const str = String(chunk)
    rawChunks.push(str)
    term.write(str, () => {
      // 帧以 DEC2026 开头：一次 write = 一帧（terminal.ts 单次写出）。
      if (str.includes('\x1b[?2026h') || str.includes('\x1b[10000S')) {
        frameNo++
        const bufLen = term.buffer.active.length
        const lf = (str.match(/\n/g) ?? []).length
        const ups = [...str.matchAll(/\x1b\[(\d*)A/g)].reduce((s, m) => s + Number(m[1] || 1), 0)
        frameLedger.push({
          n: frameNo,
          bufGrow: bufLen - lastBufLen,
          lf,
          reset: str.includes('\x1b[10000S'),
          up: ups,
          bytes: str.length,
        })
        lastBufLen = bufLen
      }
      cb()
    })
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

/** 整个 buffer（scrollback + 视口）逐行取纯文本。 */
function fullBufferLines(): string[] {
  const buf = term.buffer.active
  const total = buf.length
  const out: string[] = []
  for (let y = 0; y < total; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- channel stub（与 repro-long-output 同款） ------------------------------
const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [] as any[],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 1,
  turnStart: Date.now(),
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
const bump = () => { channel.version++; for (const cb of listeners) cb() }

let id = 0
for (let turn = 0; turn < 2; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `历史问题 ${turn}：检查一下构建配置` })
  channel.rows.push({ id: id++, kind: 'reasoning', text: '用户想看构建配置，先找配置文件。'.repeat(3), streaming: false, durationMs: 1200 })
  for (let t = 0; t < 4; t++) {
    channel.rows.push({
      id: id++, kind: 'tool', text: '',
      tool: {
        callId: `h${turn}-${t}`, name: t % 2 ? 'Read' : 'Bash',
        argsText: t % 2 ? `{"file_path": "/home/demo/lib/history${turn}_${t}.dart"}` : '{"command": "git log --oneline -15"}',
        argsFull: '{}',
        status: 'ok', startedAt: Date.now() - 60000, durationMs: 30,
        resultText: Array.from({ length: 8 + t * 5 }, (_, i) => `历史结果行 ${turn}-${t}-${i}`).join('\n'),
      },
    })
  }
  channel.rows.push({ id: id++, kind: 'assistant', text: `历史回答 ${turn}：\n\n- 构建配置在 \`pubspec.yaml\``, streaming: false })
}

const stdoutObj = new FakeStdout()
const stdin = new FakeStdin()
// inline 模式：不包 AlternateScreen —— 与 npm 安装默认一致。
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  { stdout: stdoutObj, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)

const ticker = setInterval(() => { channel.responseChars += 7; bump() }, 100)
await sleep(800)

// ---- 现场回合：user → reasoning → tool → 长流式回复 -------------------------
const add = (row: any) => { channel.rows.push({ id: id++, ...row }); bump() }
add({ kind: 'user', text: '看看这个项目，给个概览' })
await sleep(120)

const think1 = { id: id++, kind: 'reasoning', text: '', streaming: true, durationMs: undefined as number | undefined }
channel.rows.push(think1); bump()
for (const chunk of ['先看目录结构', '，读 README', '，然后汇总。']) {
  think1.text += chunk; bump(); await sleep(140)
}
think1.streaming = false; think1.durationMs = 1000; bump()
await sleep(150)

const tool1 = {
  id: id++, kind: 'tool', text: '',
  tool: {
    callId: 'c1', name: 'Bash',
    argsText: '{"command": "git log --oneline -15"}',
    argsFull: '{}',
    status: 'running' as string, resultText: undefined as string | undefined, startedAt: Date.now(), durationMs: undefined as number | undefined,
  },
}
channel.rows.push(tool1); bump(); await sleep(400)
tool1.tool.status = 'ok'
tool1.tool.durationMs = 42
tool1.tool.resultText = Array.from({ length: 20 }, (_, i) => `工具结果行 ${i}`).join('\n')
channel.activeToolCount = 0
bump(); await sleep(200)

// 长流式回复：9 大节 × 每节 11 条，60 字符一个 chunk（照 issue #39 的量级）。
const finalMsg = { id: id++, kind: 'assistant', text: '', streaming: true }
channel.rows.push(finalMsg); bump()
const sections = ['一、项目定位', '二、技术栈', '三、核心功能', '四、数据设计要点', '五、代码结构', '六、工程规范', '七、构建与发布', '八、数据迁移', '九、当前状态备注']
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
for (const chunk of doc) {
  finalMsg.text += chunk
  bump()
  await sleep(90)
}
finalMsg.streaming = false
channel.working = false
bump()
await sleep(800)
clearInterval(ticker)
await sleep(300)

// ---- 字节取证：erase/清屏/滚动序列统计（定位残留的发生机制） ----------------
const allRaw = rawChunks.join('')
const stat = (name: string, re: RegExp) => {
  const n = (allRaw.match(re) ?? []).length
  console.log(`  ${name}: ${n}`)
  return n
}
console.log('== 输出序列统计 ==')
stat('ERASE_SCREEN (CSI 2J)', /\x1b\[2J/g)
stat('ERASE_DOWN (CSI 0?J)', /\x1b\[0?J/g)
stat('cursor-up (CSI nA)', /\x1b\[\d*A/g)
stat('ERASE_LINE (CSI 2K)', /\x1b\[2K/g)
stat('DECSTBM (CSI n;mr)', /\x1b\[\d+;\d+r/g)
stat('同步帧数 (CSI ?2026h)', /\x1b\[\?2026h/g)
// full-reset 取证：clearTerminal = scrollUp(10000)+CURSOR_HOME —— 每次触发
// 都把整个当前屏推入 scrollback 并从头重画整帧（含 logo）。
stat('full-reset (CSI 10000S)', /\x1b\[10000S/g)
stat('scroll-up 任意 (CSI nS)', /\x1b\[\d+S/g)
// cursor-up 的行数分布：full-reset 前上移量 = 引擎认为上一帧占的行数。
const ups = [...allRaw.matchAll(/\x1b\[(\d*)A/g)].map(m => Number(m[1] || 1))
if (ups.length) {
  const max = Math.max(...ups)
  console.log(`  cursor-up 行数: 次数=${ups.length} 最大=${max} 视口=${ROWS}（若最大 < 上一帧真实占行则擦除不足）`)
}

// ---- 逐帧账本：找出污染帧（buffer 增长超过合理增量的帧） --------------------
console.log('== 逐帧账本（bufGrow>0 的帧） ==')
console.log('  帧号  bufGrow  LF  up  reset  bytes')
for (const f of frameLedger) {
  if (f.bufGrow > 0) {
    console.log(`  ${String(f.n).padStart(4)}  ${String(f.bufGrow).padStart(7)}  ${String(f.lf).padStart(2)}  ${String(f.up).padStart(2)}  ${f.reset ? 'RESET' : '     '}  ${f.bytes}`)
  }
}
const totalGrow = frameLedger.reduce((s, f) => s + f.bufGrow, 0)
const resetGrow = frameLedger.filter(f => f.reset).reduce((s, f) => s + f.bufGrow, 0)
console.log(`  合计推入 scrollback+视口: ${totalGrow} 行；其中 RESET 帧贡献: ${resetGrow} 行`)

// ---- 断言：scrollback + 视口中唯一 UI 文本只应出现一次 ----------------------
const lines = fullBufferLines()
const text = lines.join('\n')
const buf = term.buffer.active
const scrollbackRows = buf.length - ROWS
console.log(`buffer 总行数=${buf.length} 视口=${ROWS} scrollback=${scrollbackRows}`)

// 成功标准是「恰好一份终态拷贝」：inline 模式内容超视口后，超出部分沉入
// scrollback 本是正常语义（转录式渲染器同样如此）——不允许的是【重复】
// 拷贝（收缩帧 full-reset 每轮把整份 UI 再打一遍）与 full-reset 本身。
const count = (needle: string) => lines.filter(l => l.includes(needle)).length
const countExact = (needle: string) => lines.filter(l => l.trim() === needle).length
// 每个标记在完整 UI 里恰好一份：logo/用户消息按包含匹配，节标题按整行
// 匹配（正文 bullet 行 `- 五、… 的第 N 条…` 含标题字符串，属于同一份拷贝
// 的合法内容，不能按包含计数）。
for (const t of ['探索未至', '历史问题 0：', '历史问题 1：', '看看这个项目，给个概览']) {
  const n = count(t)
  check(`「${t}」恰好一份`, n === 1, `实际 ${n} 次`)
}
for (const t of ['五、代码结构', '九、当前状态备注']) {
  const n = countExact(t)
  check(`「${t}」标题行恰好一份`, n === 1, `实际 ${n} 次`)
}
// full-reset 零触发：收缩帧（thinking 折叠、回合结束 spinner 卸载）必须走
// 视口就地重画，任何一次 clearTerminal 都会把整份 UI 复制进 scrollback。
const resets = (allRaw.match(/\x1b\[\d+S/g) ?? []).length
check('full-reset 零触发（无 CSI nS）', resets === 0, `实际 ${resets} 次`)

if (failed > 0) {
  console.log('\n=== scrollback 前 60 非空行（残留证据） ===')
  let shown = 0
  for (let y = 0; y < Math.max(0, scrollbackRows) && shown < 60; y++) {
    const l = lines[y]
    if (l.trim() !== '') { console.log(`${String(y).padStart(4)}|${l}`); shown++ }
  }
  console.log('\n=== 视口（最后一帧） ===')
  for (let y = Math.max(0, scrollbackRows); y < buf.length; y++) {
    console.log(`${String(y - scrollbackRows).padStart(3)}|${lines[y]}`)
  }
}
// 完整 buffer 落盘（DSH_CC_REPRO_DUMP 指定路径时），供离线分析残留分布。
if (process.env.DSH_CC_REPRO_DUMP) {
  const fs = await import('node:fs')
  fs.writeFileSync(process.env.DSH_CC_REPRO_DUMP, lines.map((l, i) => `${String(i).padStart(4)}|${l}`).join('\n'))
  console.log(`buffer 已落盘: ${process.env.DSH_CC_REPRO_DUMP}`)
  // 附带解剖三个稳态帧的原始序列（escape 可见化），核对光标记账。
  const vis = (s: string) => s
    .replace(/\x1b/g, '⎋')
    .replace(/\r/g, '␍')
    .replace(/\n/g, '␊\n      ')
  const frames = rawChunks.filter(c => c.includes('\x1b[?2026h'))
  // 稳态内容增长帧（~780B）才是泄漏嫌疑；spinner tick 帧只有 ~50B。
  const bigIdx = frames.map((f, i) => ({ i, n: f.length })).filter(x => x.n > 600 && x.n < 900).map(x => x.i)
  const picks = bigIdx.slice(Math.floor(bigIdx.length / 2), Math.floor(bigIdx.length / 2) + 2)
  const dump2 = picks.map(i => `━━━ 稳态帧 #${i}（${frames[i].length}B） ━━━\n      ${vis(frames[i])}`).join('\n')
  fs.writeFileSync(process.env.DSH_CC_REPRO_DUMP + '.frames', dump2)
  console.log(`稳态帧序列已落盘: ${process.env.DSH_CC_REPRO_DUMP}.frames`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
await instance.unmount()
process.exit(failed === 0 ? 0 : 1)
