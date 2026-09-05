/**
 * repro-suggestion-click — / 补全菜单鼠标点击链路复现（用户报告：点击无效）。
 *
 * 场景：fullscreen 下输入 "/" 打开命令补全菜单，向某个命令行注入 SGR
 * press+release。断言：
 *   1. 菜单在点击后关闭（输入被清空 → overlay 卸载）；
 *   2. 命令真的执行（channel.clear 被调，/clear 的副作用）。
 *
 * 诊断：置 DSH_TUI_DEBUG_MOUSE=1，mouse-debug.log 会记录
 * "mouse arrive" / "dispatchClick {handled}" —— 点击若失效，日志能区分
 * 「解析层没收到」「派发被门禁拦下」「hit-test 没找到 handler」三种情况。
 *
 * 运行：node --import tsx/esm scripts/repro-suggestion-click.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DEBUG_MOUSE = '1'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { completeCommands, LOCAL_COMMANDS }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COLS = 100
const ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const mouseLogPath = join(homedir(), '.dsh-cc', 'mouse-debug.log')
const mouseLogSizeBefore = (() => { try { return statSync(mouseLogPath).size } catch { return 0 } })()

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
  for (let y = 0; y < ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}
/** SGR 点击注入：press+release 同一单元格（1-indexed）。 */
function clickCell(stdin: any, col1: number, row1: number) {
  stdin.write(`\x1b[<0;${col1};${row1}M`)
  stdin.write(`\x1b[<0;${col1};${row1}m`)
}

const term = makeTerm()
const s = makeStreams(term)
let clearCalls = 0
const listeners = new Set<() => void>()
const channel: any = {
  // 探针确定性：鲸鱼欢迎期闲置动画（默认开）不进本探针的测量窗口。
  whaleIdle: false,
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  pending: [],
  commandList: LOCAL_COMMANDS,
  notifications: [],
  mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude',
  agentPreset: undefined,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => { clearCalls++ },
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: s.stdout as any, stdin: s.stdin as any, stderr: s.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

// 打开 / 菜单
s.stdin.write('/')
await sleep(400)

let lines = screenLines(term)
const menuRowIdx = lines.findIndex(l => l.includes('clear'))
check('菜单出现且含 clear 行', menuRowIdx >= 0,
  menuRowIdx >= 0 ? `行${menuRowIdx}: ${lines[menuRowIdx]!.trim().slice(0, 40)}` : '未找到')
if (menuRowIdx < 0) {
  console.log('=== 屏幕快照 ===')
  for (const [i, l] of lines.entries()) if (l.trim()) console.log(`${String(i).padStart(2)} |${l}`)
  process.exit(1)
}

// 点击 clear 行中部（SGR 1-indexed）
const col1 = lines[menuRowIdx]!.indexOf('clear') + 3
clickCell(s.stdin, col1, menuRowIdx + 1)
await sleep(500)

lines = screenLines(term)
// 菜单行文案是本地化的（清空当前会话）——菜单关闭即该行消失
const menuGone = !lines.some(l => l.includes('清空当前会话') || l.includes('Clear the conversation'))
check('点击后菜单关闭（命令被执行、输入清空）', menuGone)
check('channel.clear 被调用（/clear 真的跑了）', clearCalls > 0, `clearCalls=${clearCalls}`)

await inst.unmount()

// ═══════════════ 第二幕：输入框点击定位光标 ═══════════════
const term2 = makeTerm()
const s2 = makeStreams(term2)
const ch2 = { ...channel, subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) } }
const inst2 = await render(
  <AlternateScreen>
    <Chat channel={ch2} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: s2.stdout as any, stdin: s2.stdin as any, stderr: s2.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(500)

s2.stdin.write('hello world')
await sleep(400)
lines = screenLines(term2)
const inputRowIdx = lines.findIndex(l => l.includes('hello world'))
check('输入行出现', inputRowIdx >= 0, inputRowIdx >= 0 ? `行${inputRowIdx}` : '未找到')
if (inputRowIdx >= 0) {
  // 点击 hello 内第 4 列（hell|o）→ 光标应落在 offset 4
  const helloCol = lines[inputRowIdx]!.indexOf('hello')
  clickCell(s2.stdin, helloCol + 4 + 1, inputRowIdx + 1)
  await sleep(250)
  // 点击后插入 X → 期望 hellXo world
  s2.stdin.write('X')
  await sleep(350)
  lines = screenLines(term2)
  const got = lines.find(l => l.includes('hellXo world'))
  check('点击定位光标后插入落在点击处', got !== undefined,
    got ? got.trim().slice(0, 30) : '未出现 hellXo world')

  // 再点行尾右侧空白 → 光标到行尾；插入 Y 应在末尾
  const rowText = lines.find(l => l.includes('hellXo world'))!
  const endCol = rowText.indexOf('hellXo world') + 'hellXo world'.length
  clickCell(s2.stdin, endCol + 3 + 1, lines.findIndex(l => l === rowText) + 1)
  await sleep(250)
  s2.stdin.write('Y')
  await sleep(350)
  lines = screenLines(term2)
  check('点击行尾空白 → 光标到末尾', lines.some(l => l.includes('hellXo worldY')),
    (lines.find(l => l.includes('hellXo world')) ?? '').trim().slice(0, 30))
}
await inst2.unmount()

// ═══════════════ 第三幕：命令菜单滚轮选择 ═══════════════
const term3 = makeTerm()
const s3 = makeStreams(term3)
const ch3 = { ...channel, subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) } }
const inst3 = await render(
  <AlternateScreen>
    <Chat channel={ch3} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: s3.stdout as any, stdin: s3.stdin as any, stderr: s3.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(500)

s3.stdin.write('/')
await sleep(400)
lines = screenLines(term3)
const menuIdx = lines.findIndex(l => l.includes('❯ /') || /\s❯\s*\w/.test(l))
check('菜单出现且指针行可见', menuIdx >= 0, menuIdx >= 0 ? `行${menuIdx}` : '未找到')
if (menuIdx >= 0) {
  const pointerBefore = lines[menuIdx]!
  // 菜单中部滚轮下滚 2 格
  s3.stdin.write(`\x1b[<65;30;${menuIdx + 2}M`)
  s3.stdin.write(`\x1b[<65;30;${menuIdx + 2}M`)
  await sleep(400)
  lines = screenLines(term3)
  const pointerAfter = lines.find(l => l.includes('❯')) ?? ''
  check('滚轮下滚移动选中行（❯ 下移）',
    pointerAfter.trim() !== pointerBefore.trim() && pointerAfter !== '',
    `before="${pointerBefore.trim().slice(0, 24)}" after="${pointerAfter.trim().slice(0, 24)}"`)
}
await inst3.unmount()

// ═══════════════ 第四幕：rewind 点击选中→确认页点击执行 + workspace 菜单点击 ═══════════════
const term4 = makeTerm()
const s4 = makeStreams(term4)
let rewindCalls = 0
const notifyTexts: string[] = []
const ch4 = {
  ...channel,
  rows: [
    { id: 1, kind: 'user', text: 'first user message' },
    { id: 2, kind: 'user', text: 'second user message' },
  ],
  promptRewind: () => Promise.resolve(undefined),
  rewindTo: () => { rewindCalls += 1; return Promise.resolve('first user message') },
  workspaceCommands: () => [],
  notify: (text: string) => { notifyTexts.push(text) },
  subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) },
}
const inst4 = await render(
  <AlternateScreen>
    <Chat channel={ch4} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: s4.stdout as any, stdin: s4.stdin as any, stderr: s4.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(500)

// 双击 Esc（空输入）打开 rewind 选择器
s4.stdin.write('\x1b')
await sleep(150)
s4.stdin.write('\x1b')
await sleep(400)
lines = screenLines(term4)
check('rewind 选择器打开', lines.some(l => l.includes('回退')))
// 候选行在浮层里（OverlayAbove 钉在输入框上方）：从后往前找——
// 转录区同样渲染这条消息，但它不是浮层行
let firstMsgRow = -1
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i]!.includes('first user message')) { firstMsgRow = i; break }
}
check('rewind 候选行可见', firstMsgRow >= 0, firstMsgRow >= 0 ? `行${firstMsgRow}` : '未找到')

if (firstMsgRow >= 0) {
  // 列表页：点击只选中（❯ 移到被点行，不进确认）
  clickCell(s4.stdin, lines[firstMsgRow]!.indexOf('first') + 2, firstMsgRow + 1)
  await sleep(300)
  lines = screenLines(term4)
  let pickedRow = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('first user message')) { pickedRow = i; break }
  }
  check('列表页点击 → 只选中（❯ 落在被点行）',
    pickedRow >= 0 && lines[pickedRow]!.trimStart().startsWith('❯'),
    pickedRow >= 0 ? lines[pickedRow]!.trim().slice(0, 32) : '未找到')

  // Enter 进确认页，确认页点击 = 直接执行（用户决策：确认层点击即确认）
  s4.stdin.write('\r')
  await sleep(400)
  lines = screenLines(term4)
  const confirmRow = lines.findIndex(l => l.includes('将对话回退到这条消息？'))
  check('Enter 进入确认页', confirmRow >= 0, confirmRow >= 0 ? `行${confirmRow}` : '未出现确认标题')
  if (confirmRow >= 0) {
    const confirmTarget = lines.findIndex((l, i) => i > confirmRow && l.includes('first user message'))
    check('确认页展示消息预览行', confirmTarget >= 0, confirmTarget >= 0 ? `行${confirmTarget}` : '未找到')
    if (confirmTarget >= 0) {
      clickCell(s4.stdin, lines[confirmTarget]!.indexOf('first') + 2, confirmTarget + 1)
      await sleep(500)
      lines = screenLines(term4)
      check('确认页点击 → rewind 执行一次', rewindCalls === 1, `rewindCalls=${rewindCalls}`)
      check('确认页点击后选择器关闭、消息回到输入框',
        !lines.some(l => l.includes('将对话回退到这条消息？')) && lines.some(l => l.includes('first user message')),
        (lines.find(l => l.includes('first user message')) ?? '').trim().slice(0, 30))
    }
  }
}

// workspace 裸菜单：点击 rename 行 = 执行该菜单项（notify 用法提示）
s4.stdin.write('\x1b') // 清空输入（回填的消息）
await sleep(250)
s4.stdin.write('/workspace')
await sleep(300)
s4.stdin.write('\r')
await sleep(400)
lines = screenLines(term4)
const renameRow = lines.findIndex(l => /^\s*❯?\s*rename/.test(l) || l.includes('rename'))
check('workspace 菜单打开（含 rename 行）', lines.some(l => l.includes('resume')) && renameRow >= 0,
  renameRow >= 0 ? `行${renameRow}: ${lines[renameRow]!.trim().slice(0, 30)}` : '未找到')
if (renameRow >= 0) {
  clickCell(s4.stdin, lines[renameRow]!.indexOf('rename') + 2, renameRow + 1)
  await sleep(400)
  check('点击 rename 行 → 菜单项执行（用法提示已发）',
    notifyTexts.some(text => text.includes('用法') || text.includes('Usage')),
    `notify 数=${notifyTexts.length}`)
}
await inst4.unmount()

// 诊断：打印本次运行追加的 mouse-debug 日志
try {
  const fd = readFileSync(mouseLogPath)
  const appended = fd.subarray(mouseLogSizeBefore).toString()
  const tail = appended.split('\n').filter(Boolean).slice(-12)
  console.log('--- mouse-debug（本次追加，末 12 行）---')
  for (const l of tail) console.log(l)
} catch {
  console.log('(mouse-debug.log 不存在)')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
