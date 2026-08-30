/**
 * inline 模式 scrollback 输入框残影复现（用户报告："往上翻页经常看到
 * 输入框在上面"）：
 *
 * 终端原生 scrollback 是不可变的。任何一帧把 composer（输入框边框
 * ╭─╰─/❯）画到了错误的高度、随后又被滚动推出视口，那行残影就永久
 * 冻在 scrollback 里——用户上翻就会看到"多余的输入框"。
 *
 * 场景：多轮完整对话（用户 → reasoning 流式 → 折叠 → tool 卡片 →
 * assistant 流式 → 收尾收缩 → 下一轮），帧高反复涨落，正是残影最
 * 容易沉积的路径。跑完后逐行扫描整个 buffer（scrollback + 视口），
 * 统计 composer 边框行（╭…╮ / ╰…╯）出现的位置：
 *  - 视口内最后一份 = 正常（真正的 composer）；
 *  - 视口上方任何一份 = 残影（FAIL，报出所在行号和内容）。
 * 运行：node --import tsx/esm scripts/repro-composer-ghost.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
])

const COLS = 100
const ROWS = 24
const SCROLLBACK = 3000
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
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

function fullBufferLines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows: [] as any[], status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash',
  mode: { plan: false }, reasoningEffort: 'max', tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main', working: false, spinnerMode: 'requesting',
  responseChars: 0, activeToolCount: 0, turnStart: Date.now(), lastUserText: '',
  pending: [], commandList: [], notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

let id = 0
const stdoutObj = new FakeStdout()
const stdin = new FakeStdin()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  { stdout: stdoutObj, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(3500) // 鲸鱼启动动画定格

// ---- 多轮完整对话：每轮都经历 grow → stream → fold 收缩 → settle ----
const TURNS = 4
for (let turn = 0; turn < TURNS; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `第 ${turn} 轮：分析这个模块的设计 ${'细节' .repeat(turn + 1)}` })
  channel.working = true
  channel.lastUserText = `第 ${turn} 轮`
  bump(); await sleep(150)

  const reasoning = { id: id++, kind: 'reasoning', text: '', streaming: true }
  channel.rows.push(reasoning); bump()
  for (let i = 0; i < 8; i++) {
    reasoning.text += `思考片段 ${turn}-${i}：先看结构再下手，考虑边界与错误路径。`
    bump(); await sleep(60)
  }
  reasoning.streaming = false
  reasoning.durationMs = 900
  bump(); await sleep(120)

  const tool = {
    id: id++, kind: 'tool', text: '',
    tool: {
      callId: `t${turn}`, name: 'Read', argsText: '{"file_path":"/home/demo/mod.dart"}', argsFull: '{}',
      status: 'running', startedAt: Date.now(), durationMs: undefined as number | undefined,
      resultText: undefined as string | undefined,
    },
  }
  channel.rows.push(tool); bump(); await sleep(200)
  tool.tool.status = 'ok'
  tool.tool.durationMs = 40
  tool.tool.resultText = Array.from({ length: 10 }, (_, i) => `结果行 ${turn}-${i}`).join('\n')
  bump(); await sleep(150)

  const answer = { id: id++, kind: 'assistant', text: '', streaming: true }
  channel.rows.push(answer); bump()
  for (let i = 0; i < 14; i++) {
    answer.text += `- 回答要点 ${turn}-${i}：模块划分、依赖方向、错误处理、性能与可测性。\n`
    bump(); await sleep(70)
  }
  answer.streaming = false
  channel.working = false
  channel.activeToolCount = 0
  bump()
  await sleep(400) // 收尾收缩帧（thinking 折叠 / spinner 卸载）
}

await sleep(600)

// ---- 扫描整个 buffer：composer 边框行只允许出现在视口内 ----
const lines = fullBufferLines()
const total = lines.length
const viewportStart = total - ROWS
const isTopBorder = (l: string) => /^ *╭─+╮/.test(l)
const isBottomBorder = (l: string) => /^ *╰─+╯/.test(l)
const ghosts: Array<{ y: number; kind: string; text: string }> = []
for (let y = 0; y < viewportStart; y++) {
  const l = lines[y]!
  if (isTopBorder(l)) ghosts.push({ y, kind: 'top', text: l.trim().slice(0, 50) })
  else if (isBottomBorder(l)) ghosts.push({ y, kind: 'bottom', text: l.trim().slice(0, 50) })
}
const inViewport = lines.slice(viewportStart).filter(l => isTopBorder(l) || isBottomBorder(l)).length

console.log(`buffer=${total} 行，viewportStart=${viewportStart}，视口内边框行=${inViewport}，scrollback 残影=${ghosts.length}`)
for (const g of ghosts.slice(0, 12)) console.log(`  残影 行${g.y} [${g.kind}] ${g.text}`)
check('scrollback 无输入框残影', ghosts.length === 0, `残影 ${ghosts} 处 / buffer ${total} 行`)
check('视口内恰有一份 composer', inViewport >= 2, `边框行 ${inViewport}`)

// ---- 转录行完整性：每个要点在 buffer 中恰一份 ----
let missing = 0
for (let t = 0; t < TURNS; t++) {
  for (let i = 0; i < 14; i++) {
    const marker = `回答要点 ${t}-${i}：` // 带冒号终止符，避免 0-1 匹配 0-10
    const count = lines.filter(l => l.includes(marker)).length
    if (count !== 1) { missing++; console.log(`  要点异常 ${marker} ×${count}`) }
  }
}
check('每个流式要点在 buffer 中恰出现一次', missing === 0, `${missing} 处异常`)

// ---- 场景 B：用户上翻阅读（终端原生 scrollback）+ 后台继续流式 ----
// inline 模式没有鼠标跟踪，上翻 = 终端自己滚 scrollback；此时流式继续、
// 帧继续渲染。任何一帧把 composer 画错高度，残影永久冻进 scrollback。
const SCROLL_TURNS = 2
for (let turn = 0; turn < SCROLL_TURNS; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `上翻轮 ${turn}：继续流式输出` })
  channel.working = true
  bump(); await sleep(150)
  const answer = { id: id++, kind: 'assistant', text: '', streaming: true }
  channel.rows.push(answer); bump()
  for (let i = 0; i < 16; i++) {
    answer.text += `- 上翻要点 ${turn}-${i}：边滚边流的行。\n`
    bump(); await sleep(70)
    if (i === 4 || i === 9 || i === 13) {
      term.scrollLines(-80) // 用户往上翻页
      await sleep(40)
    }
  }
  answer.streaming = false
  channel.working = false
  bump(); await sleep(300)
}
await sleep(400)

// ---- 场景 C：输入草稿多行（composer 变高）期间流式 + 收缩 ----
const draft = { id: -1, kind: 'assistant', text: '', streaming: true }
channel.rows.push({ id: id++, kind: 'user', text: '输入期间流式' })
channel.working = true
bump(); await sleep(120)
channel.rows.push(draft); bump()
// 边打字（composer 高度 1→5 行）边流式
const typing = ['多行草稿第一行', '第二行内容追加', '第三行继续写', '第四行', '第五行收尾']
for (let i = 0; i < typing.length; i++) {
  stdin.write(typing[i]!)
  await sleep(60)
  stdin.write('\u001b[13;2u') // Shift+Enter (kitty CSI-u)
  await sleep(60)
  draft.text += `- 输入期要点 ${i}：composer 变高时的流式行。\n`
  bump(); await sleep(90)
}
for (let i = typing.length; i < 10; i++) {
  draft.text += `- 输入期要点 ${i}：composer 变高时的流式行。\n`
  bump(); await sleep(90)
}
// 清空草稿（一次 Backspace 链 / Ctrl+U）—— composer 5 行收缩回 1 行
const beforeClear = fullBufferLines().slice(-ROWS)
const draftVisible = beforeClear.filter(l => l.includes('多行草稿') || l.includes('第二行') || l.includes('第五行')).length
console.log(`[诊断] Ctrl+U 前视口内草稿行数 = ${draftVisible}（0 = 键盘注入未生效）`)
stdin.write('\u0015') // Ctrl+U 清行
await sleep(200)
draft.streaming = false
channel.working = false
bump(); await sleep(500)

// 再次扫描
const lines2 = fullBufferLines()
const total2 = lines2.length
const viewportStart2 = total2 - ROWS
const ghosts2: Array<{ y: number; text: string }> = []
for (let y = 0; y < viewportStart2; y++) {
  const l = lines2[y]!
  if (/^ *╭─+╮/.test(l) || /^ *╰─+╯/.test(l)) ghosts2.push({ y, text: l.trim().slice(0, 50) })
}
console.log(`[上翻场景] buffer=${total2} 行，scrollback 残影=${ghosts2.length}`)
for (const g of ghosts2.slice(0, 12)) console.log(`  残影 行${g.y} ${g.text}`)
check('上翻+流式：scrollback 无输入框残影', ghosts2.length === 0, `残影 ${ghosts2.length} 处`)

let missing2 = 0
for (let t = 0; t < SCROLL_TURNS; t++) {
  for (let i = 0; i < 16; i++) {
    const marker = `上翻要点 ${t}-${i}：`
    const count = lines2.filter(l => l.includes(marker)).length
    if (count !== 1) { missing2++; console.log(`  要点异常 ${marker} ×${count}`) }
  }
}
check('上翻+流式：每个要点恰出现一次', missing2 === 0, `${missing2} 处异常`)

// 场景 C 后再扫一次（输入收缩是残影最危险的时刻）
const lines3 = fullBufferLines()
const viewportStart3 = lines3.length - ROWS
const ghosts3: Array<{ y: number; text: string }> = []
for (let y = 0; y < viewportStart3; y++) {
  const l = lines3[y]!
  if (/^ *╭─+╮/.test(l) || /^ *╰─+╯/.test(l)) ghosts3.push({ y, text: l.trim().slice(0, 50) })
}
console.log(`[输入收缩场景] buffer=${lines3.length} 行，scrollback 残影=${ghosts3.length}`)
for (const g of ghosts3.slice(0, 12)) console.log(`  残影 行${g.y} ${g.text}`)
check('多行输入收缩：scrollback 无输入框残影', ghosts3.length === 0, `残影 ${ghosts3.length} 处`)
{
  let missing3 = 0
  for (let i = 0; i < 10; i++) {
    const marker = `输入期要点 ${i}：`
    const count = lines3.filter(l => l.includes(marker)).length
    if (count !== 1) { missing3++; console.log(`  要点异常 ${marker} ×${count}`) }
  }
  check('多行输入+流式：每个要点恰出现一次', missing3 === 0, `${missing3} 处异常`)
}

console.log(failed === 0 ? '\nALL PASS（scrollback 干净，无输入框残影）' : `\n${failed} 项失败`)
await instance.unmount()
process.exit(failed === 0 ? 0 : 1)
