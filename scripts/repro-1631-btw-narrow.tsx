/**
 * issue #1631 的窄屏/配置矩阵：分栏渲不出来时 `/btw <问题>` 必须仍有可见
 * 反馈（面板或浮层），绝不能静默。
 *
 * 判定用的是「侧问的唯一词元有没有出现在某块屏幕上」——面板形态与浮层
 * 形态都会把题目渲染出来，所以词元不可见 = 用户什么都看不到。修复前
 * （v0.14.0–v0.16.1）R1/R2/S1/I1/E1 全为 FAIL；修复后应 0 FAIL。
 *
 * 运行：node --import tsx/esm scripts/repro-1631-btw-narrow.tsx
 * 加 DUMP=1 打印每个用例的画面。有 FAIL 时退出码为 1。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const fixtureHome = mkdtempSync(join(tmpdir(), 'repro-1631-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [
  React, { Terminal: XTerm }, ui, prefs, { setLang, t }, { QuestionStore },
  { LOCAL_COMMANDS }, { Chat }, { btwThreads },
] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/screens/Chat.js'),
  import('../src/components/sidePanel/btw/threads.js'),
])
const { render } = ui
const { applySidePanelOpen, applySidePanelPanels, applySidePanelSplitEnabled, getSidePanelOpen } = prefs
setLang('zh')

const ROWS = 26
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** Ctrl+Shift+E（展开草稿编辑器）/ Ctrl+Enter（编辑器里提交）。 */
const CTRL_SHIFT_E = '\x1b[69;6u'
const CTRL_ENTER = '\x1b[13;5u'

function scriptedAsk() {
  const calls: { question: string }[] = []
  let settle: ((outcome: { answer: string | null; error?: string }) => void) | null = null
  let stream: ((delta: string) => void) | null = null
  const ask = (question: string, options?: { onText?: (delta: string) => void }) => {
    calls.push({ question })
    stream = options?.onText ?? null
    return new Promise(resolve => { settle = resolve })
  }
  return {
    calls,
    ask,
    finish(answer: string) { settle?.({ answer }); settle = null; stream = null },
  }
}

class FakeStdout extends Writable {
  columns: number
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  frames: string[] = []
  constructor(term: import('@xterm/headless').Terminal, cols: number) { super(); this.term = term; this.columns = cols }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    this.frames.push(String(chunk))
    this.term.write(String(chunk), () => cb())
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

function makeChatChannel(ask: ReturnType<typeof scriptedAsk>) {
  const notices: string[] = []
  return {
    version: 0,
    rows: [] as string[][],
    status: 'idle' as const,
    working: false,
    agentId: 'probe-session',
    sessionId: 'probe-session',
    goal: undefined,
    todos: [] as unknown[],
    backgroundJobs: [] as unknown[],
    subagents: [] as unknown[],
    notifications: [] as unknown[],
    notices,
    attachedContexts: [] as unknown[],
    ask,
    sideQuestion: ask.ask,
    attachContext() {},
    detachContext() {},
    notify(text: string) { notices.push(text) },
    subscribe() { return () => {} },
    whaleIdle: false,
    sessionTitle: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/demo',
    displayCwd: 'C:/code/demo',
    gitBranch: 'main',
    spinnerMode: 'requesting' as const,
    mode: { plan: false },
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [] as unknown[],
    commandList: LOCAL_COMMANDS,
    commandCompletions: () => [],
    localRows: [] as string[][],
    submitCalls: [] as string[],
    submit(text: string) { this.submitCalls.push(text) },
    steer() {},
    cancel() {},
    clear() {},
    pushLocal(_command: string, lines: readonly string[]) { this.localRows.push([...lines]) },
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

async function mountChat(cols: number, fullscreen: boolean) {
  const ask = scriptedAsk()
  const channel = makeChatChannel(ask)
  const term = new XTerm({ cols, rows: ROWS, scrollback: 200, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols)
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen={fullscreen} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await delay(700)
  const screen = (): string => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < ROWS; y += 1) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return out.join('\n')
  }
  return {
    ask,
    channel,
    screen,
    keys: async (sequence: string) => {
      stdin.write(sequence)
      await delay(500)
    },
    run: async (line: string, submit = '\r') => {
      stdin.write(line)
      await delay(200)
      stdin.write(submit)
      await delay(700)
    },
    unmount: async () => { await instance.unmount() },
  }
}

interface Case {
  readonly name: string
  readonly cols: number
  readonly fullscreen?: boolean
  readonly panels?: string
  readonly splitEnabled?: boolean
  readonly line: string
  readonly token: string
  /** 期望词元出现在画面上。 */
  readonly expectVisible: boolean
  /** 先展开整屏草稿编辑器（命令从编辑器里提交）。 */
  readonly editor?: boolean
  /** 期望形态：屏幕可见（默认）或至少一句提示。 */
  readonly expect?: 'visible' | 'notice'
  /** 提示形态必须命中的 i18n 文案（已解析；只看到任意通知不算通过）。 */
  readonly expectNotice?: string
  /** 从「侧栏收起」起步，验证 openPanel 的开关写入是否可见。 */
  readonly startClosed?: boolean
}

/** 面板形态与浮层形态都渲染这个标题（i18n panel-title-btw）。 */
const BTW_FACE = t('panel-title-btw')

const DEFAULT_PANELS = 'todo,jobs,agents,info,trajectory,workspace,btw,companion'
const NO_BTW_PANELS = 'todo,jobs,agents,info,trajectory,workspace,companion'

const cases: Case[] = [
  // issue 的主路径：默认配置 + 窄终端
  { name: 'R1   80 列 /btw（默认面板）', cols: 80, line: '/btw Q80D', token: 'Q80D', expectVisible: true, startClosed: true },
  { name: 'R2   92 列 /btw（差 1 列）', cols: 92, line: '/btw Q92D', token: 'Q92D', expectVisible: true },
  // 分栏阈值边界
  { name: 'B1   93 列 /btw（刚好够分栏）', cols: 93, line: '/btw Q93D', token: 'Q93D', expectVisible: true },
  { name: 'B2  100 列 /btw', cols: 100, line: '/btw Q100D', token: 'Q100D', expectVisible: true, startClosed: true },
  // 对照组：btw 面板未启用 → 浮层（既有回退，窄宽度下可用）
  { name: 'O1   80 列 /btw（btw 面板未启用）', cols: 80, panels: NO_BTW_PANELS, line: '/btw Q80O', token: 'Q80O', expectVisible: true },
  // 渲染门守卫：宽屏 + btw 未启用 + 侧栏开着（split=true）时浮层必须照旧出现
  { name: 'O2  100 列 /btw（btw 未启用，侧栏开着）', cols: 100, panels: NO_BTW_PANELS, line: '/btw Q100O', token: 'Q100O', expectVisible: true },
  // 分栏开关关掉
  { name: 'S1  100 列 /btw（splitEnabled=false）', cols: 100, splitEnabled: false, line: '/btw Q100S', token: 'Q100S', expectVisible: true },
  // inline 模式（非 fullscreen）
  { name: 'I1  120 列 inline /btw', cols: 120, fullscreen: false, line: '/btw Q120I', token: 'Q120I', expectVisible: true },
  // 整屏草稿编辑器展开中（splitAvailable 因 editorOpen 为 false）
  { name: 'E1  100 列 编辑器展开 /btw（应给提示）', cols: 100, line: '/btw Q100E', token: 'Q100E', expectVisible: false, editor: true, expect: 'notice', expectNotice: t('btw-surface-busy') },
  // issue 声称的对照：/panel btw 在窄宽度下能开整屏 btw 场景——实测只能给提示，
  // 整屏形态只有面板 ⤢ 一个入口（需要面板先上屏）。这条期望因此是「不出现」。
  { name: 'C1   80 列 /panel btw（issue 的对照断言不成立）', cols: 80, line: '/panel btw', token: BTW_FACE, expectVisible: false, expect: 'notice', expectNotice: t('panel-unavailable-hint') },
]

const rows: string[] = []
for (const item of cases) {
  applySidePanelPanels(item.panels ?? DEFAULT_PANELS)
  applySidePanelSplitEnabled(item.splitEnabled ?? true)
  applySidePanelOpen(item.startClosed !== true)
  btwThreads.resetForTest()
  const chat = await mountChat(item.cols, item.fullscreen ?? true)
  if (item.editor === true) await chat.keys(CTRL_SHIFT_E)
  await chat.run(item.line, item.editor === true ? CTRL_ENTER : '\r')
  const screen = chat.screen()
  if (process.env.DUMP) console.log(`\n=== ${item.name} ===\n${screen}\n=== end ===`)
  const visible = screen.includes(item.token)
  // 侧问必须真的发出去：光靠草稿里残留的题目文本满足 `visible` 会是假绿。
  const asked = item.line.startsWith('/btw') ? chat.ask.calls.length === 1 : true
  // 提示形态必须命中预期文案，任意通知（复制、其它命令）不算。
  const expectedNotice = item.expectNotice
  const noticeOk = item.expect !== 'notice'
    || (expectedNotice !== undefined && chat.channel.notices.some(text => text.includes(expectedNotice)))
  const ok = visible === item.expectVisible && asked && noticeOk
  const status = ok ? 'PASS' : 'FAIL'
  const notice = chat.channel.notices.length > 0 ? JSON.stringify(chat.channel.notices[0]!.slice(0, 24)) : '无'
  const openAfter = getSidePanelOpen()
  rows.push(`${status}  ${item.name}  侧问发起=${chat.ask.calls.length}  词元可见=${visible}  设置open=${openAfter}  提示=${notice}`)
  await chat.unmount()
}

console.log('\n' + rows.join('\n'))
const failed = rows.filter(row => row.startsWith('FAIL')).length
console.log(`\n${rows.length - failed} pass, ${failed} fail`)
process.exit(failed > 0 ? 1 : 0)
