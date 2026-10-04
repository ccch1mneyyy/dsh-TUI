/**
 * btw 面板/快路径/回退/badge 回归（渲染层，设计 btw-panel.md §回归形状 4–7）：
 *  - 面板级（XTerm + AlternateScreen + 真侧栏控制器）：空态、线程问答上屏
 *    （Markdown）、badge（不可见期间落定 → ●；进入面板即清）、composer 键
 *    语义（打字/Enter 提交/Esc 分层保草稿/Tab 切焦点）、n 新话题、s 发送到
 *    聊天（attach 合同 + 截断提示）、28/40 列窄幅不崩；连按键（两键之间
 *    没有重渲染）不丢字、退格整删 emoji。
 *  - 全屏场景（BtwThreadScene）：Esc 退出编辑后 Tab 回到 composer 继续打字。
 *  - 浮层回退（BtwPanelFallback）：粘贴的换行、带修饰的 Enter 不关浮层，
 *    只有无修饰的 Enter 才关（关闭即中止在途侧问）。
 *  - Chat 级（真 Chat + fake channel）：/btw 快路由——面板启用时路由进侧栏
 *    且浮层反针不出现（单一 surface）；未启用时浮层回退，Esc 关闭即 abort。
 * 运行：node --import tsx/esm scripts/verify-btw-panel.tsx
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-btw-panel-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome

const [React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, { setLang }, { QuestionStore }, { LOCAL_COMMANDS }, { Chat }, { btwThreads }, { BtwThreadScene }, { BtwPanelFallback }] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/screens/Chat.js'),
  import('../src/components/sidePanel/btw/threads.js'),
  import('../src/components/sidePanel/btw/BtwThreadScene.js'),
  import('../src/components/BtwPanel.js'),
])
const { render, ThemeProvider, Box, Text, AlternateScreen, useInput, useTerminalSize } = ui
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels } = prefs
setLang('zh')

const ROWS = 22
let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log('PASS: ' + name)
  else { failures += 1; console.error('FAIL: ' + name + (extra ? '  (' + extra + ')' : '')) }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ESC = String.fromCharCode(27)

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
    emit(delta: string) { stream?.(delta) },
    finish(answer: string) { settle?.({ answer }); settle = null; stream = null },
    fail(error: string) { settle?.({ answer: null, error }); settle = null; stream = null },
  }
}

/** 侧栏列需要的最小通道面（btw/todo 两个适配器读的字段）。 */
function makePanelChannel(ask: ReturnType<typeof scriptedAsk>) {
  const notices: string[] = []
  const attached: { id: string; source: 'panel'; sourceId: string; title: string; content: string; chars: number; truncated: boolean }[] = []
  let seq = 0
  return {
    version: 0,
    rows: [],
    status: 'idle' as const,
    working: false,
    agentId: 'probe-session',
    goal: undefined,
    todos: [],
    backgroundJobs: [],
    subagents: [],
    notifications: [],
    notices,
    attachedContexts: attached,
    ask,
    sideQuestion: ask.ask,
    attachContext(entry: { source: 'panel'; sourceId: string; title: string; content: string }) {
      const truncated = entry.content.length > 50_000
      const content = truncated ? entry.content.slice(0, 50_000) : entry.content
      attached.push({ id: 'ctx-' + (++seq), ...entry, content, chars: content.length, truncated })
    },
    detachContext() {},
    notify(text: string) { notices.push(text) },
    subscribe() { return () => {} },
  }
}

class FakeStdout extends Writable {
  columns: number
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  frames: string[] = []
  constructor(term: import('@xterm/headless').Terminal, cols: number) { super(); this.term = term; this.columns = cols }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.frames.push(String(chunk)); this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Frame {
  term: import('@xterm/headless').Terminal
  stdout: FakeStdout
  stdin: FakeStdin
  app: { unmount: () => Promise<void> }
  lines(): string[]
}

async function mountTree(cols: number, tree: React.ReactNode): Promise<Frame> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen><ThemeProvider theme="dark">{tree}</ThemeProvider></AlternateScreen>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  )
  const frame: Frame = {
    term, stdout, stdin, app,
    lines() {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(cols, ' '))
      return out
    },
  }
  await delay(600)
  return frame
}

function ChatFake({ width }: { width: number }): React.ReactNode {
  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Box flexGrow={1} flexDirection="column" justifyContent="center"><Text>chat-body</Text></Box>
      <Box height={1} flexShrink={0}><Text>status:ready</Text></Box>
    </Box>
  )
}

/** 面板级夹具：真 useSidePanel 控制器 + 键盘转发（镜像 Chat 的让位线）。 */
function PanelFixture({ channel, focusPanel }: { channel: ReturnType<typeof makePanelChannel>; focusPanel: boolean }): React.ReactNode {
  const size = useTerminalSize()
  const sp = useSidePanel({ columns: size.columns, fullscreen: true, editorOpen: false })
  React.useEffect(() => {
    if (focusPanel) sp.focusPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useInput((input, key, event) => {
    if (key.wheelUp || key.wheelDown) return
    sp.handleKey(input, key as never, event)
  })
  const geo = sp.geometry
  return (
    <SidePanelLayout
      geometry={geo}
      focus={sp.focus}
      side={geo === null ? null : <SidePanelColumn width={geo.panel} controller={sp} channel={channel as never} />}
    >
      <ChatFake width={geo === null ? size.columns : geo.chat} />
    </SidePanelLayout>
  )
}

async function mountPanel(cols: number, panels: string, focusPanel: boolean, channel: ReturnType<typeof makePanelChannel>): Promise<Frame> {
  applySidePanelOpen(true)
  applySidePanelRatio(0.62)
  applySidePanelPanels(panels)
  btwThreads.resetForTest()
  return mountTree(cols, <PanelFixture channel={channel} focusPanel={focusPanel} />)
}

async function keys(frame: Frame, sequence: readonly string[]): Promise<void> {
  for (const key of sequence) { frame.stdin.write(key); await delay(180) }
}

// ── P1/P2: 空态 + 线程问答上屏（面板 ≈40 列：105 列终端）────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(105, 'btw', true, channel)
  const empty = frame.lines().join('\n')
  check('P1. 空态提示可见（面板 ≈40 列）', empty.includes('还没有侧问'))
  const r = btwThreads.submit('probe-session', '这是第一个很长很长的问题关于编译器与运行时的边界', channel.ask.ask)
  check('P2a. 直发线程成功', r.ok === true)
  await delay(300)
  ask.emit('流式**加粗**回答')
  await delay(300)
  ask.finish('流式**加粗**回答完成版')
  await delay(400)
  const shown = frame.lines().join('\n')
  check('P2b. 问题文本上屏', shown.includes('第一个很长很长的问题'))
  check('P2c. 答案文本上屏（Markdown 渲染无崩溃）', shown.includes('回答完成版'))
  check('P2d. composer 在面板底部可见（› 提示）', shown.includes('›'))
  await frame.app.unmount()
}

// ── P3: badge（不可见期间落定 → ●；进入面板清）─────────────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(100, 'todo,btw', false, channel)
  check('P3a. todo 为活动面板时无徽章', !frame.lines().join('\n').includes('●'))
  btwThreads.submit('probe-session', 'badge question', ask.ask)
  await delay(250)
  ask.finish('badge answer')
  await delay(500)
  const badged = frame.lines().join('\n')
  check('P3b. 不可见期间落定 → 未读徽章 ●', badged.includes('●'))
  // 聚焦右栏 + ']' 切到 btw → visible → markSeen 清徽章
  await keys(frame, [String.fromCharCode(2), ']'])
  await delay(500)
  const opened = frame.lines().join('\n')
  check('P3c. 进入面板看到最新线程后清徽章', !opened.includes('●') && opened.includes('badge answer'),
    opened.split('\n').filter(l => l.includes('●') || l.includes('badge')).join(' | '))
  await frame.app.unmount()
}

// ── P4/P5/P6/P7: composer 键语义与面板动作（100 列）────────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(100, 'btw', true, channel)
  // composer 默认拿编辑焦点：打字 → 草稿
  await keys(frame, ['追', '问'])
  await delay(150)
  check('P4a. 面板聚焦即 composer 编辑（打字进草稿）', frame.lines().some(l => l.includes('追问')), frame.lines().filter(l => l.includes('›')).join(' | '))
  await keys(frame, ['\r'])
  await delay(400)
  check('P4b. Enter 提交走 channel.sideQuestion（一次）', ask.calls.length === 1 && ask.calls[0].question === '追问')
  check('P4c. 提交后草稿清空（store 侧）', btwThreads.get('probe-session')?.draft === '')
  ask.finish('追问的答案')
  await delay(400)
  // Esc 分层：第一层收起草稿（保草稿），第二层回 chat
  await keys(frame, ['草稿保留', ESC])
  await delay(200)
  const afterFirstEsc = frame.lines().join('\n')
  check('P5a. 第一层 Esc 退出编辑但保留草稿', afterFirstEsc.includes('草稿保留'))
  await keys(frame, [ESC])
  await delay(300)
  const afterSecondEsc = frame.lines().join('\n')
  check('P5b. 第二层 Esc 交宿主回聊天（提示行换焦点文案）', afterSecondEsc.includes('Ctrl+B 聚焦侧栏'))
  check('P5c. 草稿仍在（store 持久）', btwThreads.get('probe-session')?.draft === '草稿保留')
  // 列表模式动作：先回右栏（Ctrl+B），再 n 新话题 / s 发送到聊天
  await keys(frame, [String.fromCharCode(2)])
  const r2 = btwThreads.submit('probe-session', 'attach me', ask.ask)
  await delay(200)
  ask.finish('attach answer body')
  await delay(400)
  await keys(frame, ['s'])
  await delay(300)
  const attached = channel.attachedContexts[0]
  check('P7a. s = 发送到聊天（AttachedContext 合同）', channel.attachedContexts.length === 1
    && attached?.source === 'panel' && r2.ok === true && attached?.sourceId === r2.turnId,
    JSON.stringify(channel.attachedContexts.map(a => ({ s: a.sourceId, t: a.title }))))
  check('P7b. attach 标题带 /btw 前缀', attached?.title.startsWith('/btw: '))
  check('P7c. 附加成功提示', channel.notices.some(text => text.includes('已附加')))
  await keys(frame, ['n'])
  await delay(300)
  check('P6. n = 新话题（清线程 + 通知）', btwThreads.get('probe-session')?.turns.length === 0
    && channel.notices.some(text => text.includes('新话题')), channel.notices.join(' | '))
  await frame.app.unmount()
}

// ── P9: 连按键不丢字（两键之间不等重渲染）+ 退格整删 emoji ─────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(100, 'btw', true, channel)
  for (const ch of ['x', 'y', 'z']) {
    frame.stdin.write(ch)
    await new Promise(resolve => setImmediate(resolve))
  }
  await delay(200)
  check('P9a. 连按三键草稿顺序完整', btwThreads.get('probe-session')?.draft === 'xyz', JSON.stringify(btwThreads.get('probe-session')?.draft))
  await keys(frame, ['\u{1F44D}', '\x7f'])
  await delay(150)
  check('P9b. 退格整删一个 emoji（不留半个代理对）', btwThreads.get('probe-session')?.draft === 'xyz', JSON.stringify(btwThreads.get('probe-session')?.draft))
  await frame.app.unmount()
}

// ── F1: 全屏场景 Esc 退出编辑、Tab 回到 composer ─────────────────────────
{
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountTree(100, <BtwThreadScene channel={channel as never} onClose={() => {}} />)
  await keys(frame, ['a', 'b', ESC, '\t', 'c'])
  await delay(150)
  check('F1. Esc 后 Tab 回到 composer 继续编辑', btwThreads.get('probe-session')?.draft === 'abc', JSON.stringify(btwThreads.get('probe-session')?.draft))
  await frame.app.unmount()
}

// ── F2: 浮层回退只认真正的 Enter ─────────────────────────────────────────
{
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  btwThreads.submit('probe-session', 'fallback question', ask.ask)
  let closes = 0
  const frame = await mountTree(100, <BtwPanelFallback thread={btwThreads.get('probe-session')} onClose={() => { closes += 1 }} onCopy={() => {}} />)
  frame.stdin.write(ESC + '[200~\r' + ESC + '[201~')
  await delay(200)
  check('F2a. 粘贴的换行不关闭浮层', closes === 0, 'closes=' + closes)
  frame.stdin.write(ESC + '[13;2u')
  await delay(200)
  check('F2c. Shift+Enter 不关闭浮层（只认无修饰的 Enter）', closes === 0, 'closes=' + closes)
  await keys(frame, ['\r'])
  check('F2b. Enter 关闭浮层', closes === 1, 'closes=' + closes)
  await frame.app.unmount()
  btwThreads.resetForTest()
}

// ── P8: 面板 28 列最窄档不崩（CJK 长问题 + code fence；93 列终端）────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(93, 'btw', true, channel)
  btwThreads.submit('probe-session', '极长的中日韩混排问题需要在这个很窄的面板里安全折行不崩坏画面布局', ask.ask)
  await delay(300)
  ask.finish('代码块回答：\n\u0060\u0060\u0060js\nconst x = 1\n\u0060\u0060\u0060\n完')
  await delay(500)
  const narrow = frame.lines().join('\n')
  check('P8. 28 列窄幅渲染不崩（问题与答案都在屏）', narrow.includes('极长的') && narrow.includes('代码块'), narrow.split('\n').slice(0, 4).join(' | '))
  await frame.app.unmount()
}

// ── Chat 级：/btw 快路由（面板启用）与浮层回退（未启用）────────────────
function makeChatChannel(ask: ReturnType<typeof scriptedAsk>) {
  const base = makePanelChannel(ask)
  return {
    ...base,
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
    pending: [],
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
const plainText = (frames: readonly string[]) => frames.join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

async function mountChat(ask: ReturnType<typeof scriptedAsk>) {
  const channel = makeChatChannel(ask)
  const term = new XTerm({ cols: 100, rows: ROWS, scrollback: 200, allowProposedApi: true })
  const stdout = new FakeStdout(term, 100)
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  )
  await delay(500)
  const lines = () => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(100, ' '))
    return out
  }
  return {
    channel, stdout, stdin, lines,
    since: (mark: number) => plainText(stdout.frames.slice(mark)),
    run: async (line: string) => {
      const from = stdout.frames.length
      stdin.write(line)
      await delay(150)
      stdin.write('\r')
      await delay(600)
      return plainText(stdout.frames.slice(from))
    },
    unmount: async () => { await instance.unmount() },
  }
}

{
  // C1: 面板启用 → 快路由进侧栏；浮层反针不出现（单一 surface）
  applySidePanelOpen(true)
  applySidePanelRatio(0.62)
  applySidePanelPanels('btw')
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask)
  const after = await chat.run('/btw 快路由的问题一')
  check('C1a. 面板启用时 /btw 立即发起侧问（一次）', ask.calls.length === 1)
  const screen = chat.lines().join('\n')
  check('C1b. 侧栏打开且 btw 为活动面板（胶囊标题）', screen.includes('侧问'), screen.split('\n').slice(0, 3).join(' | '))
  check('C1c. 问题路由进面板', after.includes('快路由的问题一'))
  check('C1d. 浮层回退不出现（单一 surface）', !after.includes('未启用 btw 面板'))
  ask.finish('快路由的答案')
  await delay(500)
  const answered = chat.lines().join('\n')
  check('C1e. 答案落进面板线程', answered.includes('快路由的答案'), answered.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | '))
  await chat.unmount()
}

{
  // C2: 面板未启用 → 浮层回退；Esc 关闭即 abort（cancelled）
  applySidePanelOpen(true)
  applySidePanelPanels('todo,jobs,agents')
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask)
  const after = await chat.run('/btw 回退模式的问题')
  check('C2a. 未启用面板时浮层回退出现', after.includes('未启用 btw 面板') && after.includes('回退模式的问题'))
  check('C2b. 侧问仍然发起（一次）', ask.calls.length === 1)
  chat.stdin.write(ESC)
  await delay(500)
  const turn = btwThreads.get('probe-session')?.turns[0]
  check('C2c. Esc 关闭浮层即中止在途轮', turn?.phase === 'cancelled', 'phase=' + (turn?.phase ?? 'none'))
  const closed = plainText(chat.stdout.frames.slice(chat.stdout.frames.length - 20))
  check('C2d. 浮层关闭后回到普通聊天', !closed.includes('未启用 btw 面板'))
  await chat.unmount()
}

btwThreads.resetForTest()
console.log(failures === 0 ? '\nbtw-panel: ALL PASS' : '\nbtw-panel: ' + failures + ' FAIL')
process.exit(failures === 0 ? 0 : 1)
