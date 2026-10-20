/**
 * btw 面板/快路径/回退/badge 回归（渲染层）：
 *  - 面板级（XTerm + AlternateScreen + 真侧栏控制器）：空态、线程问答上屏
 *    （Markdown）、badge（不可见期间落定 → ?1；进入面板即清）、composer 键
 *    语义（打字/Enter 提交/Esc 分层保草稿/Tab 切焦点）、n 新话题、s 发送到
 *    聊天（attach 合同 + 截断提示）、28/40 列窄幅不崩；流式期间 badge 不变
 *    就不通知侧栏；失败的一轮保留已流出的部分答复；连按键（两键之间
 *    没有重渲染）不丢字、退格整删 emoji。
 *  - 全屏场景（BtwThreadScene）：Esc 退出编辑后 Tab 回到 composer 继续打字。
 *  - 浮层回退（BtwPanelFallback）：粘贴的换行、带修饰的 Enter 不关浮层，
 *    只有无修饰的 Enter 才关（关闭即中止在途侧问）。
 *  - Chat 级（真 Chat + fake channel）：/btw 快路由——面板启用时路由进侧栏
 *    且浮层反针不出现（单一 surface）；未启用时浮层回退，Esc 关闭即 abort。
 *  - Chat 级分栏掩码（issue #1631）：窄屏（<93 列）或 splitEnabled=false 时
 *    面板「已启用」但分栏渲不出来，/btw 必须退浮层、且不写无效的打开状态；
 *    整屏编辑器占屏时给一句提示，而不是把浮层开在它底下。
 *  - Chat 级 surface 切换（issue #1631）：浮层开着时把终端拉宽——分栏画的是
 *    别的面板，浮层必须留在原处；分栏正好画的是 btw，浮层让位、线程进侧栏，
 *    主输入框回来（`btwOverlayVisible` 不能停在「不可见却仍占键盘」）。
 *    移交后展开整屏编辑器，草稿可继续编辑、收起后保留；主任务问卷异步
 *    到达时先接管显示与 Enter，回答后恢复仍在途的侧问（inline/fullscreen）。
 * 运行：node --import tsx/esm scripts/verify-btw-panel.tsx
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settle, settled } from './lib/term-test.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-btw-panel-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome

const [React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, { setLang, t }, { QuestionStore }, { LOCAL_COMMANDS }, { Chat }, { btwThreads }, { BtwThreadScene }, { BtwPanelFallback }, { panelStore }, { btwComposerKey }] = await Promise.all([
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
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/components/sidePanel/btw/BtwComposer.js'),
])
const { render, ThemeProvider, Box, Text, AlternateScreen, useInput, useTerminalSize } = ui
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels, applySidePanelSplitEnabled, getSidePanelOpen } = prefs
setLang('zh')

const ROWS = 22
let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log('PASS: ' + name)
  else { failures += 1; console.error('FAIL: ' + name + (extra ? '  (' + extra + ')' : '')) }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ESC = String.fromCharCode(27)
/** 主输入框行首的会话入口（⌸），浮层/侧栏接管时它随 PromptInput 一起消失。 */
const HOME_BUTTON = '\u2338'
/** 展开草稿编辑器（Ctrl+Shift+E）/ 在编辑器里提交（Ctrl+Enter）。 */
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
    sessionId: 'probe-session',
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
    detachContext(id: string) {
      // 忠实于真 registry：按 id 摘掉那一条（s 再按一次 = 撤回这条路径要用）。
      const at = attached.findIndex(entry => entry.id === id)
      if (at >= 0) attached.splice(at, 1)
    },
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
  /** Called once xterm has applied each write: the viewport is current. */
  onFrame: (() => void) | undefined
  constructor(term: import('@xterm/headless').Terminal, cols: number) { super(); this.term = term; this.columns = cols }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    this.frames.push(String(chunk))
    this.term.write(String(chunk), () => { this.onFrame?.(); cb() })
  }
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
      // 与 Chat.tsx 的真实接线一致（:6667-6668）：点右栏任意处把列焦点交给面板。
      // 少了这两条，点击路径在夹具里没有下家，P12 那类回归会假过。
      onActivateChat={sp.focusChat}
      onActivatePanel={sp.focusPanel}
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

// 首次广告空串必须覆盖能力位兜底；宽面板保证发送提示不会被截断掩盖。
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(180, 'btw', true, channel)
  check('P0. 首次空线程不广告发送键', !frame.lines()[ROWS - 1].includes('s 送聊天'), frame.lines()[ROWS - 1])
  await frame.app.unmount()
}

// ── P1/P2: 空态 + 线程问答上屏（面板 ≈40 列：105 列终端）────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(105, 'btw', true, channel)
  const empty = frame.lines().join('\n')
  check('P1. 空态提示可见（面板 ≈40 列）', empty.includes('还没有侧问')
    && empty.includes('旁路问答') && empty.includes('参考最近'), empty.split('\n').filter(l => l.includes('还没有') || l.includes('旁路') || l.includes('参考')).join(' | '))
  check('P1b. 输入框只剩一句占位提示（键位提示在底栏）', empty.includes('Enter 提问'), empty.split('\n').filter(l => l.includes('›') || l.includes('提问')).join(' | '))
  // 空线程不画头部：标题没内容、`新话题` 也无事可做（面板标签栏已有标题）。
  check('P1c. 空态不画头部（无 [n] 新话题、无头部细线）',
    !empty.includes('新话题') && !/│─{8,}/u.test(empty),
    empty.split('\n').filter(l => l.includes('新话题') || /│─{8,}/u.test(l)).join(' | '))
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
  check('P2e. 有线程后头部出现（标题 + [n] 新话题 + 细线）',
    shown.includes('新话题') && shown.includes('─────') && shown.includes('第一个很长很长的问题'),
    shown.split('\n').filter(l => l.includes('新话题') || l.includes('──')).join(' | '))
  if (process.env.BTW_SCREENSHOT) console.log('SCREENSHOT-EMPTY\n' + frame.lines().map(l => l.slice(58)).join('\n'))
  await frame.app.unmount()
}

// ── P10: 流式期间 badge 不变就不通知侧栏 ─────────────────────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(105, 'btw', true, channel)
  btwThreads.submit('probe-session', 'stream question', channel.ask.ask)
  await delay(200)
  let badgeEvents = 0
  const stop = panelStore.subscribe(event => { if (event.type === 'badge') badgeEvents += 1 })
  for (let index = 0; index < 20; index += 1) {
    ask.emit('delta ' + index + ' ')
    await delay(15)
  }
  ask.finish('stream answer done')
  await delay(400)
  stop()
  // The panel is visible, so the badge stays 'info' while running and
  // clears at the end: a couple of changes at most, not one per delta.
  check('P10. 20 个流式 delta 的 badge 通知不超过 2 次', badgeEvents <= 2, 'badge events=' + badgeEvents)
  await frame.app.unmount()
}

// ── P11: 失败的一轮保留已流出的部分答复 ───────────────────────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(105, 'btw', true, channel)
  btwThreads.submit('probe-session', 'failing question', channel.ask.ask)
  await delay(200)
  ask.emit('partial words before')
  await delay(200)
  ask.fail('upstream broke')
  await delay(400)
  const screen = frame.lines().join('\n')
  check('P11. 失败后部分答复仍在、错误标在下面', screen.includes('partial words before') && screen.includes(t('btw-thread-error')) && screen.includes('upstream broke'),
    screen.split('\n').filter(l => l.trim() !== '').slice(-6).join(' | '))
  await frame.app.unmount()
}

// ── P3: badge（不可见期间落定 → ?1；进入面板清）────────────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(100, 'todo,btw', false, channel)
  check('P3a. todo 为活动面板时无徽章', !frame.lines()[0].includes('?1') && panelStore.get('btw')?.badge === null)
  btwThreads.submit('probe-session', 'badge question', ask.ask)
  await delay(250)
  ask.finish('badge answer')
  await delay(500)
  const badged = frame.lines()[0]
  check('P3b. 不可见期间落定 → 未读徽章 ?1', badged.includes('?1') && panelStore.get('btw')?.badge?.unread === 1, badged.trim())
  // 聚焦右栏 + ']' 切到 btw → visible → markSeen 清徽章
  await keys(frame, [String.fromCharCode(2), ']'])
  await delay(500)
  const opened = frame.lines().join('\n')
  check('P3c. 进入面板看到最新线程后清徽章', !opened.includes('?1') && panelStore.get('btw')?.badge === null && opened.includes('badge answer'),
    opened.split('\n').filter(l => l.includes('?1') || l.includes('badge')).join(' | '))
  await frame.app.unmount()
}

// ── P4/P5/P6/P7: composer 键语义与面板动作（100 列）────────────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(100, 'btw', true, channel)
  // 新聚焦模型：面板聚焦默认是阅读层（箭头归导航）——打字不落草稿，
  // Enter（或点击输入框）之后才是编辑。
  await keys(frame, ['追', '问'])
  await delay(150)
  check('P4a0. 默认阅读层：打字不进草稿', (btwThreads.get('probe-session')?.draft ?? '') === '', JSON.stringify(btwThreads.get('probe-session')?.draft))
  await keys(frame, ['\r', '追', '问'])
  await delay(150)
  check('P4a. Enter 聚焦后打字进草稿', frame.lines().some(l => l.includes('追问')), frame.lines().filter(l => l.includes('›')).join(' | '))
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
  // P5d：列表态 Enter 回编辑层（草稿续写），Esc 再收起——列表动作不受影响。
  await keys(frame, [String.fromCharCode(2), '\r', 'x'])
  await delay(150)
  check('P5d. 列表态 Enter 回编辑层，草稿续写', btwThreads.get('probe-session')?.draft === '草稿保留x', JSON.stringify(btwThreads.get('probe-session')?.draft))
  await keys(frame, [ESC])
  // 列表模式动作：底栏提示 / s 发送到聊天 / c 复制 / n 新话题
  const r2 = btwThreads.submit('probe-session', 'attach me', ask.ask)
  await delay(200)
  ask.finish('attach answer body')
  await delay(400)
  // 面板聚焦时底栏广告面板自己的键。这条夹具是 105 列（面板 40 → 底栏只有 38 格），
  // 整段放不下：按「导航 → 面板键 → 列控制」的截断规矩，能看见的是面板段的头
  // （↑/↓ 选择）；s/c 两段在 P15e（140 列、面板 ≈52）里断言。必须按在 s 之前：
  // 送完焦点就交回主输入框了，见 P7g。
  check('P7f. 底栏广告面板自己的键（列表层）', frame.lines().join('\n').includes('↑/↓ 选择'), frame.lines()[ROWS - 1])
  check('P7e. 两轮之间有分隔线', frame.lines().some(l => l.includes('┈┈┈┈')))
  await keys(frame, ['s'])
  await delay(300)
  const attached = channel.attachedContexts[0]
  check('P7a. s = 发送到聊天（AttachedContext 合同）', channel.attachedContexts.length === 1
    && attached?.source === 'panel' && r2.ok === true && attached?.sourceId === r2.turnId,
    JSON.stringify(channel.attachedContexts.map(a => ({ s: a.sourceId, t: a.title }))))
  check('P7b. attach 标题带 /btw 前缀', attached?.title.startsWith('/btw: '))
  check('P7c. 附加成功提示', channel.notices.some(text => text.includes('已附加')))
  // 送完焦点交回主输入框：chip 就在眼前、可直接接着打字，toast 里那句
  // 「Esc 可撤」也才成立（剥 chip 的 Esc 只有主输入框有焦点才收得到）。
  check('P7g. 送完焦点回主输入框（底栏换未聚焦文案）', frame.lines().join('\n').includes('Ctrl+B 聚焦侧栏'), frame.lines()[ROWS - 1])
  await keys(frame, [String.fromCharCode(2)])
  await delay(250)
  const noticesBeforeCopy = channel.notices.length
  await keys(frame, ['c'])
  await delay(200)
  check('P7d. c = 复制最新答案（通知字符数）', channel.notices.length === noticesBeforeCopy + 1 && (channel.notices[noticesBeforeCopy] ?? '').includes('已复制'), channel.notices.join(' | '))
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
  // 默认阅读层：先 Enter 进编辑层再连按（两键之间不等重渲染）。
  frame.stdin.write('\r')
  await new Promise(resolve => setImmediate(resolve))
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

// ── P9c: 编辑层的 ←/→ 让位宿主（光标移到头才切面板）────────────────────
{
  const shiftLeft = btwComposerKey({ text: 'ab', caret: 1 }, '', { leftArrow: true, shift: true } as never)
  const plainLeft = btwComposerKey({ text: 'ab', caret: 1 }, '', { leftArrow: true } as never)
  check('P9c. Shift+←/→ 未消费（落宿主切面板）、纯 ←/→ 仍移光标',
    shiftLeft === null && plainLeft?.state?.caret === 0,
    JSON.stringify({ shiftLeft, plainLeft }))
  // 光标先走、到头让位：贴行首的 ←、贴行尾的 →、空草稿的两边都返回未消费。
  const atHead = btwComposerKey({ text: 'ab', caret: 0 }, '', { leftArrow: true } as never)
  const atTail = btwComposerKey({ text: 'ab', caret: 2 }, '', { rightArrow: true } as never)
  const emptyHead = btwComposerKey({ text: '', caret: 0 }, '', { leftArrow: true } as never)
  const emptyTail = btwComposerKey({ text: '', caret: 0 }, '', { rightArrow: true } as never)
  check('P9d. 光标贴行首/行尾后 ←/→ 未消费（让位宿主切面板）',
    atHead === null && atTail === null && emptyHead === null && emptyTail === null,
    JSON.stringify({ atHead, atTail, emptyHead, emptyTail }))
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

async function mountChat(ask: ReturnType<typeof scriptedAsk>, cols = 100, fullscreen = true) {
  const channel = makeChatChannel(ask)
  const questionStore = new QuestionStore()
  const term = new XTerm({ cols, rows: ROWS, scrollback: 200, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols)
  const stdin = new FakeStdin()
  let width = cols
  const chat = <Chat channel={channel as never} questionStore={questionStore} fullscreen={fullscreen} />
  const instance = await render(
    fullscreen ? <AlternateScreen>{chat}</AlternateScreen> : chat,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
  )
  await delay(500)
  const lines = () => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(width, ' '))
    return out
  }
  // Negative checks read the rendered viewport after every write instead of
  // the raw frames: the renderer writes cell diffs, so a raw frame need not
  // contain a whole string even while it is on screen.
  const viewport = (): string => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < ROWS; y += 1) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return out.join('\n')
  }
  const watched = new Map<string, boolean>()
  stdout.onFrame = () => {
    if (watched.size === 0) return
    const screen = viewport()
    for (const needle of watched.keys()) if (screen.includes(needle)) watched.set(needle, true)
  }
  return {
    channel, questionStore, stdout, stdin, lines,
    /** Start recording whether `needle` is ever on screen. */
    viewport,
    watch: (needle: string) => { watched.set(needle, viewport().includes(needle)) },
    seen: (needle: string) => watched.get(needle) === true,
    since: (mark: number) => plainText(stdout.frames.slice(mark)),
    run: async (line: string, submit = '\r') => {
      const from = stdout.frames.length
      stdin.write(line)
      await delay(150)
      stdin.write(submit)
      await delay(600)
      return plainText(stdout.frames.slice(from))
    },
    unmount: async () => { await instance.unmount() },
    /** 改列宽并让 ink 重排：窄屏浮层 ↔ 宽屏分栏的 surface 切换回归用。 */
    resize: async (next: number) => {
      width = next
      term.resize(next, ROWS)
      stdout.columns = next
      stdout.emit('resize')
      await delay(700)
    },
    /** 硬件终端光标（IME 预编辑锚点）落点。 */
    cursor: () => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }),
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
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  chat.watch(fallbackNote)
  const after = await chat.run('/btw 快路由的问题一')
  check('C1a. 面板启用时 /btw 立即发起侧问（一次）', ask.calls.length === 1)
  const screen = chat.lines().join('\n')
  check('C1b. 侧栏打开且 btw 为活动面板（胶囊标题）', screen.includes('侧问'), screen.split('\n').slice(0, 3).join(' | '))
  check('C1c. 问题路由进面板', after.includes('快路由的问题一'))
  check('C1d. 浮层回退不出现（单一 surface，任何一帧都没有）', !chat.seen(fallbackNote))
  ask.finish('快路由的答案')
  await delay(500)
  const answered = chat.lines().join('\n')
  check('C1e. 答案落进面板线程', answered.includes('快路由的答案'), answered.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | '))
  // C1f/C1g：IME 光标让位（issue #1427）——面板聚焦 + 编辑层时，硬件光标
  //（IME 预编辑/读屏锚点）必须停在面板输入框，而不是主聊天框；焦点回
  // 聊天后由主输入框重新接管。100 列下分栏 ≈ 62/38，阈值取 55。
  await chat.stdin.write('\r')
  await delay(300)
  {
    const cur = chat.cursor()
    check('C1f. 面板聚焦编辑时硬件光标在面板输入框（IME 锚点让位）', cur.x > 55, `cursor=${JSON.stringify(cur)}`)
  }
  await chat.stdin.write(ESC)
  await chat.stdin.write(ESC)
  await delay(300)
  {
    const cur = chat.cursor()
    check('C1g. 焦点回聊天后光标回主输入框', cur.x < 55, `cursor=${JSON.stringify(cur)}`)
  }
  await chat.unmount()
}

{
  // C2: 面板未启用 → 浮层回退；Esc 关闭即 abort（cancelled）
  applySidePanelOpen(true)
  applySidePanelPanels('todo,jobs,agents')
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  chat.watch(fallbackNote)
  await chat.run('/btw 回退模式的问题')
  check('C2e. 逐帧检测器看得到浮层（C1d 的对照组）', chat.seen(fallbackNote))
  const open = chat.viewport()
  check('C2a. 未启用面板时浮层回退出现', open.includes(fallbackNote) && open.includes('回退模式的问题'), open.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | '))
  check('C2b. 侧问仍然发起（一次）', ask.calls.length === 1)
  chat.stdin.write(ESC)
  await delay(500)
  const turn = btwThreads.get('probe-session')?.turns[0]
  check('C2c. Esc 关闭浮层即中止在途轮', turn?.phase === 'cancelled', 'phase=' + (turn?.phase ?? 'none'))
  let closed = chat.viewport()
  for (let waited = 0; closed.includes(fallbackNote) && waited < 3000; waited += 100) {
    await delay(100)
    closed = chat.viewport()
  }
  check('C2d. 浮层关闭后回到普通聊天（视口里没有浮层）', !closed.includes(fallbackNote), closed.split('\n').filter(l => l.trim() !== '').slice(-4).join(' | '))
  await chat.unmount()
}

// ── C3: 分栏渲不出来时 /btw 退浮层（issue #1631：绝不静默）────────────
{
  // 80 列 < canSplit 阈值（CHAT_MIN 64 + PANEL_MIN 28 + DIVIDER 1 = 93）。
  // 修前：openPanel 只写了一个被 splitAvailable 掩掉的开关，屏幕不变、也
  // 没有一句提示，用户无从判断命令有没有生效。
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,btw,companion')
  applySidePanelOpen(false)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 80)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  chat.watch(fallbackNote)
  await chat.run('/btw 窄屏的问题一')
  const narrow = chat.viewport()
  check('C3a. 80 列 + btw 面板启用：浮层兜底出现并把题目上屏',
    narrow.includes(fallbackNote) && narrow.includes('窄屏的问题一'),
    narrow.split('\n').filter(l => l.trim() !== '').slice(-3).join(' | '))
  check('C3b. 侧问照常发起（一次）', ask.calls.length === 1)
  check('C3c. 分栏不可用时不写一个不生效的「侧栏打开」状态', getSidePanelOpen() === false)
  await chat.unmount()
}

// ── C4: splitEnabled=false 是同一根因的另一条掩码，同样要退浮层──────
{
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,btw,companion')
  applySidePanelSplitEnabled(false)
  applySidePanelOpen(true)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 120)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  await chat.run('/btw 关掉分栏的问题')
  const wide = chat.viewport()
  check('C4a. splitEnabled=false：浮层兜底出现并把题目上屏',
    wide.includes(fallbackNote) && wide.includes('关掉分栏的问题'),
    wide.split('\n').filter(l => l.trim() !== '').slice(-3).join(' | '))
  check('C4b. 侧问照常发起（一次）', ask.calls.length === 1)
  await chat.unmount()
  applySidePanelSplitEnabled(true)
}

// ── C5: 整屏编辑器占屏 → 发通知，别把浮层挂上去 ───────────────────────
// 编辑器是全屏不透明 cover（PromptEditorLayer 是 Chat 根 Box 的最后一个
// 孩子），toast 也在它下面，所以这一格能保证的是「不静默丢弃」+「不挂一
// 个既看不见又会先吃掉编辑器按键的浮层」（useInput 按挂载顺序分发）。
{
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,btw,companion')
  applySidePanelOpen(true)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 100)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  chat.watch(fallbackNote)
  chat.stdin.write(CTRL_SHIFT_E)
  await delay(400)
  await chat.run('/btw 编辑器里的侧问', CTRL_ENTER)
  check('C5a. 编辑器占屏：侧问被挡住这件事进了通知通道（不静默丢弃）',
    chat.channel.notices.some(text => text.includes(t('btw-surface-busy'))),
    JSON.stringify(chat.channel.notices))
  check('C5b. 不在编辑器底下开一个看不见的浮层', !chat.seen(fallbackNote))
  check('C5c. 侧问照常发起（一次）', ask.calls.length === 1)
  await chat.unmount()
}

// ── C6: 窄屏浮层开着时把终端拉宽——分栏回来了，但画的是别的面板：浮层与
// 题目必须留在原处。修前渲染门只问「分栏在不在」，浮层被悄悄卸掉，
// btwOverlayOpen 仍为真又让 PromptInput 一直 suspended、Chat 的按键处理器
// 一直让位（composer 消失、Esc/Ctrl+C 失效）────────────────────────────
{
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,btw,companion')
  applySidePanelSplitEnabled(true)
  applySidePanelOpen(true)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 92)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  await chat.run('/btw 拉宽之后还在的问题')
  check('C6a. 92 列：分栏渲不出来，浮层兜底把题目上屏', chat.viewport().includes('拉宽之后还在的问题'))
  await chat.resize(120)
  const wide = chat.viewport()
  check('C6b. 拉宽后侧栏出现（分栏在渲染）', wide.includes(t('panel-hint-unfocused')), wide.split('\n').slice(-2).join(' | '))
  check('C6c. 但活动面板不是 btw：浮层与题目必须留在原处',
    wide.includes(fallbackNote) && wide.includes('拉宽之后还在的问题'),
    wide.split('\n').filter(l => l.trim() !== '').slice(-3).join(' | '))
  check('C6d. 侧问仍然只发起一次', ask.calls.length === 1)
  check('C6e. 没有被挡住的提示噪声', !chat.channel.notices.some(text => text.includes(t('btw-surface-busy'))))
  await chat.unmount()
}

// ── C7: 对照组——侧栏就在 btw 面板上：拉宽后浮层让位、线程进侧栏，主输入框
// 必须回来（btwOverlayVisible=false 才让 PromptInput 与按键恢复）────────
{
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,btw,companion')
  applySidePanelSplitEnabled(true)
  applySidePanelOpen(true)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 120)
  await chat.run('/panel btw')
  chat.stdin.write(ESC)
  await delay(200)
  chat.stdin.write(ESC)
  await delay(300)
  await chat.resize(92)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  await chat.run('/btw 侧栏接管的问题')
  check('C7a. 缩窄到 92 列：浮层出现', chat.viewport().includes('侧栏接管的问题'))
  await chat.resize(120)
  const wide = chat.viewport()
  check('C7b. 拉宽后浮层让位（单一 surface）', !wide.includes(fallbackNote))
  check('C7c. 线程在侧栏可见', wide.includes('侧栏接管的问题'))
  check('C7d. 主输入框回来（浮层不再接管输入）', wide.includes(HOME_BUTTON), wide.split('\n').slice(-2).join(' | '))
  check('C7e. 侧问只发起一次', ask.calls.length === 1)
  // 编辑器会临时收起分栏；残留的 fallback 请求不能因此重新暂停输入框，
  // 否则编辑器发布/撤下相互触发，直到 React #185 重挂整树并丢掉草稿。
  const draft = 'DRAFT-AFTER-BTW'
  const editorTitle = t('input-expand-editor-title')
  chat.stdin.write(draft)
  await settle(() => chat.viewport().includes(draft))
  chat.stdin.write(CTRL_SHIFT_E)
  check('C7f. 移交侧栏后编辑器保持打开、草稿可见', await settled(() =>
    chat.viewport().includes(editorTitle) && chat.viewport().includes(draft)))
  if (process.env.BTW_SCREENSHOT) console.log('SCREENSHOT-C7-EDITOR\n' + chat.viewport())
  chat.stdin.write('-KEPT')
  check('C7g. 编辑器可继续编辑原草稿', await settled(() => chat.viewport().includes(draft + '-KEPT')))
  chat.stdin.write(ESC)
  check('C7h. 收起编辑器后主输入框保留完整草稿', await settled(() =>
    !chat.viewport().includes(editorTitle) && chat.viewport().includes(HOME_BUTTON)
    && chat.viewport().includes(draft + '-KEPT')))
  check('C7i. 编辑器往返没有取消或重发侧问', ask.calls.length === 1
    && btwThreads.get('probe-session')?.turns.at(-1)?.phase === 'running')
  await chat.unmount()
}

// ── C8: 面板未启用 + 整屏编辑器占屏：同样只发通知。修前 `!btwPanelEnabled`
// 会把浮层直接挂到编辑器底下——看不见却接管输入，编辑器一关才冒出来────
{
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,companion')
  applySidePanelOpen(true)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 100)
  const fallbackNote = t('btw-panel-unavailable').slice(0, 10)
  chat.stdin.write(CTRL_SHIFT_E)
  await delay(400)
  await chat.run('/btw 面板未启用时编辑器占屏', CTRL_ENTER)
  check('C8a. 面板未启用也一样走通知（不静默丢弃）',
    chat.channel.notices.some(text => text.includes(t('btw-surface-busy'))),
    JSON.stringify(chat.channel.notices))
  chat.stdin.write(ESC)
  await delay(500)
  const after = chat.viewport()
  check('C8b. 关掉编辑器后不冒出那个「看不见的浮层」', !after.includes(fallbackNote))
  check('C8c. 主输入框可用（浮层没有接管输入）', after.includes(HOME_BUTTON), after.split('\n').slice(-2).join(' | '))
  check('C8d. 侧问照常发起（一次）', ask.calls.length === 1)
  await chat.unmount()
}

// ── C9: 主任务问卷到达时先接管浮层；Enter 回答问卷，不误取消侧问 ───────
for (const fullscreen of [true, false]) {
  const mode = fullscreen ? 'fullscreen' : 'inline'
  applySidePanelPanels('todo,jobs,agents,info,trajectory,workspace,btw,companion')
  applySidePanelSplitEnabled(true)
  applySidePanelOpen(true)
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const chat = await mountChat(ask, 80, fullscreen)
  const sideQuestion = 'SIDE-THREAD-QUESTION'
  const mainQuestion = 'MAIN-QUESTION'
  await chat.run('/btw ' + sideQuestion)
  check('C9a. ' + mode + ' 起点为在途侧问浮层', await settled(() => chat.viewport().includes(sideQuestion)))
  chat.channel.working = true
  const answerPromise = chat.questionStore.ask({ questions: [{
    id: 'main-question',
    question: mainQuestion,
    options: [{ label: 'CONTINUE-MAIN' }],
  }] }).then(
    answer => ({ ok: true as const, answer }),
    (error: unknown) => ({ ok: false as const, error: String(error) }),
  )
  check('C9b. ' + mode + ' 问卷先上屏、浮层让位', await settled(() =>
    chat.viewport().includes(mainQuestion) && chat.viewport().includes('CONTINUE-MAIN')
    && !chat.viewport().includes(sideQuestion)))
  if (process.env.BTW_SCREENSHOT) console.log('SCREENSHOT-C9-' + mode + '\n' + chat.viewport())
  chat.stdin.write('\r')
  check('C9c. ' + mode + ' 第一次 Enter 即完成主问卷', await settled(() => chat.questionStore.getSnapshot() === null))
  // 失败路径也要结清 ask：不能让一个永不 settle 的 await 掩掉断言失败。
  if (chat.questionStore.getSnapshot() !== null) chat.questionStore.cancelCurrent()
  const outcome = await answerPromise
  check('C9d. ' + mode + ' 回答来自主问卷选项', outcome.ok
    && outcome.answer.answers[0]?.selected[0] === 'CONTINUE-MAIN', JSON.stringify(outcome))
  check('C9e. ' + mode + ' 回答后恢复仍在途的侧问浮层', await settled(() =>
    chat.viewport().includes(sideQuestion) && !chat.viewport().includes(mainQuestion))
    && ask.calls.length === 1 && btwThreads.get('probe-session')?.turns.at(-1)?.phase === 'running')
  await chat.unmount()
}

// ── P11: 编辑层光标到头 → 让位宿主切面板（105 列，todo+btw 两面板）────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(105, 'todo,btw', true, channel)
  // 活动面板是 todo（order 更小）：没有 sendToChat 能力，底栏不该广告 s。
  check('P11a. 无 sendToChat 能力的面板不广告 s', !frame.lines().join('\n').includes('s 送聊天'), frame.lines()[ROWS - 1])
  await keys(frame, ['\x1b[C'])
  await delay(250)
  check('P11b. 阅读层 → 切到 btw（composer 在场）', frame.lines().some(l => l.includes('╭')), frame.lines()[0])
  // 新契约：底栏广告由面板按层发——空线程没有可选的轮，连能力位那一段都不画，
  // 免得广告一个按下去没反应的 s（有轮时的正向用例在 P7f / P15e）。
  check('P11c. 空线程不广告 s（没有可送的那一条），框内只剩占位',
    !frame.lines().join('\n').includes('s 送聊天') && frame.lines().join('\n').includes('Enter 提问'),
    frame.lines()[ROWS - 1])
  await keys(frame, ['\r', 'a', 'b'])
  await delay(200)
  check('P11d. Enter 进编辑层并落草稿', (btwThreads.get('probe-session')?.draft ?? '') === 'ab'
    && frame.lines().some(l => l.includes('Enter 发送')), JSON.stringify(btwThreads.get('probe-session')?.draft))
  // 光标已贴行尾：同一个 → 不再消费，落宿主切面板（btw 的 composer 离场）。
  await keys(frame, ['\x1b[C'])
  await delay(300)
  check('P11e. 编辑层光标在行尾时 → 让位宿主切面板', !frame.lines().some(l => l.includes('╭')), frame.lines()[0])
  await frame.app.unmount()
}

// ── P12: 点输入框 = 聚焦面板 + 进编辑层（一次点击，不要求先点非输入区）──
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  // focusPanel=false：焦点留在聊天，正是「回到主输入框后想点侧栏输入框」的起点。
  const frame = await mountPanel(105, 'btw', false, channel)
  const before = frame.lines()
  check('P12a. 起点焦点在聊天（底栏提示 Ctrl+B）', before.join('\n').includes('Ctrl+B 聚焦侧栏'), before[ROWS - 1])
  const top = before.findIndex(l => l.includes('╭'))
  const col = (before[top] ?? '').indexOf('╭') + 6
  frame.stdin.write(`\x1b[<0;${col};${top + 2}M`)
  frame.stdin.write(`\x1b[<0;${col};${top + 2}m`)
  await delay(400)
  const after = frame.lines().join('\n')
  check('P12b. 点输入框后列焦点归面板（底栏换聚焦文案）', after.includes('Esc 聊天') && !after.includes('Ctrl+B 聚焦侧栏'), frame.lines()[ROWS - 1])
  check('P12c. 同一次点击即进编辑层（框内提示出现）', after.includes('Enter 发送'), frame.lines().filter(l => l.includes('›')).join(' | '))
  await frame.app.unmount()
}

// ── P13: 点消息区只聚焦（不注入）+ 选中轮决定 s/c 的作用对象 ──────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  // focusPanel=false：起点焦点在聊天，点消息区应当只把列焦点交给面板。
  const frame = await mountPanel(105, 'btw', false, channel)
  const r1 = btwThreads.submit('probe-session', '第一问标题', ask.ask)
  await delay(150)
  ask.finish('第一答正文标记AAA')
  await delay(300)
  const r2 = btwThreads.submit('probe-session', '第二问标题', ask.ask)
  await delay(150)
  ask.finish('第二答正文标记BBB')
  await delay(400)
  const before = frame.lines()
  const answerRow = before.findIndex(l => l.includes('第二答正文标记BBB'))
  const col = (before[answerRow] ?? '').indexOf('第二答') + 2
  frame.stdin.write(`\x1b[<0;${col};${answerRow + 1}M`)
  frame.stdin.write(`\x1b[<0;${col};${answerRow + 1}m`)
  await delay(400)
  check('P13a. 点消息区只聚焦面板、不再注入', channel.attachedContexts.length === 0
    && frame.lines().join('\n').includes('Esc 聊天'),
    JSON.stringify({ attached: channel.attachedContexts.length, bottom: frame.lines()[ROWS - 1] }))
  check('P13b. 列表默认选中最后一条', btwThreads.get('probe-session')?.selectedTurnId === r2.turnId,
    String(btwThreads.get('probe-session')?.selectedTurnId))
  await keys(frame, ['\x1b[A'])
  await delay(250)
  check('P13c. ↑ 把选中移到上一轮', btwThreads.get('probe-session')?.selectedTurnId === r1.turnId,
    String(btwThreads.get('probe-session')?.selectedTurnId))
  await keys(frame, ['s'])
  await delay(300)
  check('P13d. s 送的是选中轮（不是最新轮）+ 焦点回主输入框',
    channel.attachedContexts[0]?.sourceId === r1.turnId
    && frame.lines().join('\n').includes('Ctrl+B 聚焦侧栏'),
    JSON.stringify({ sourceId: channel.attachedContexts[0]?.sourceId, turn: r1.turnId }))
  await keys(frame, [String.fromCharCode(2)])
  await delay(250)
  const noticesBefore = channel.notices.length
  await keys(frame, ['s'])
  await delay(300)
  check('P13e. 同一个 s 再按一次 = 撤回（detach + 撤回提示）',
    channel.attachedContexts.length === 0
    && channel.notices.slice(noticesBefore).some(text => text.includes('撤回')),
    channel.notices.slice(noticesBefore).join(' | '))
  // ↓ 走到最后一条再按一次 = 回输入框（与 ↑ 上到标题互为往返）。
  await keys(frame, ['\x1b[B', '\x1b[B'])
  await delay(300)
  check('P13f. ↓ 到底回输入框（框内提示出现）', frame.lines().join('\n').includes('Enter 发送'),
    frame.lines().filter(l => l.includes('›')).join(' | '))
  await frame.app.unmount()
}

// ── P14: 折行答案的末行不被分割线吃掉（扫宽度，issue #1526）──────────────
// 回归的是引擎侧的不变量：折行文本叶子在「容器内容宽」下量出的高度不能当成
// 它在「自身宽（内容宽 − marginLeft）」下的高度——差 1 行时末行会被画到下一个
// 兄弟（btw 的 ┈ 分割线）那一行再被覆盖。判据取屏幕级，不依赖内部字段：
// 分割线（┈）上方最近一个非空行必须是答案的最后一段（末行标记）。
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(200, 'btw', true, channel)
  // 长段落制造折行，末段短到永远单行 → 「分割线上方那行」是否含它可作为判据。
  const answer = '折行回归段落，内容宽与节点宽相差两列时，末行会溢出到下一个兄弟。'.repeat(8)
    + '\n\n末行标记ZZZ'
  btwThreads.submit('probe-session', '扫宽度的第一问', ask.ask)
  await delay(200)
  ask.finish(answer)
  await delay(300)
  btwThreads.submit('probe-session', '第二问', ask.ask)
  await delay(150)
  ask.finish('第二答')
  await delay(400)
  const bad: string[] = []
  for (let step = 0; step <= 20; step += 1) {
    const ratio = 0.55 + step * 0.01
    applySidePanelRatio(ratio)
    await delay(220)
    const lines = frame.lines()
    const divider = lines.findIndex(l => l.includes('┈┈┈┈'))
    let above = divider - 1
    while (above >= 0 && (lines[above] ?? '').trim() === '') above -= 1
    if (divider < 0 || !(lines[above] ?? '').includes('末行标记ZZZ')) {
      bad.push(`ratio=${ratio.toFixed(2)} divider=${divider} above=${JSON.stringify((lines[above] ?? '').trim().slice(-24))}`)
    }
  }
  check('P14. 扫 21 档宽度：分割线上方那行始终是答案末段（末行不被吃）', bad.length === 0, bad.join(' | '))
  await frame.app.unmount()
}

// ── P15: 选中态的观感契约（只反色标题字形 / 输入框里不显示 / 点标题挪过去）──
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  // 140 列 → 面板 ≈52 列：底栏两段（s 送聊天 · c 复制）都能完整显示，断言才验的是
  // 契约本身而不是「被截断到第几个字」。窄面板仍按老规矩从尾部截断（先牺牲
  // z 缩放 / +/- 调宽，再是面板段尾部）。
  const frame = await mountPanel(140, 'btw', true, channel)
  const r1 = btwThreads.submit('probe-session', '第一问标题', ask.ask)
  await delay(150)
  ask.finish('第一答正文标记AAA')
  await delay(300)
  btwThreads.submit('probe-session', '第二问标题', ask.ask)
  await delay(150)
  ask.finish('第二答正文标记BBB')
  await delay(400)

  const { default: instances } = await import('../src/ink/instances.js')
  // 文本样式（含 inverse）落在 node.textStyles 上（布局样式在 node.style /
  // yogaNode 上）；面板头部也画首问标题，所以按「最后一个匹配」取线程里的标题行。
  type InkNode = { nodeName: string; nodeValue?: string; childNodes?: InkNode[]; textStyles?: Record<string, unknown> }
  function textOf(node: InkNode): string {
    if (node.nodeName === '#text') return node.nodeValue ?? ''
    return (node.childNodes ?? []).map(textOf).join('')
  }
  function findTitle(needle: string): InkNode | undefined {
    const root = (instances.get(frame.stdout as never) as unknown as { rootNode?: InkNode }).rootNode
    if (root === undefined) return undefined
    let hit: InkNode | undefined
    const walk = (node: InkNode): void => {
      if (node.nodeName === 'ink-text' && textOf(node) === needle) hit = node
      for (const child of node.childNodes ?? []) walk(child)
    }
    walk(root)
    return hit
  }
  const bottomBar = (): string => frame.lines()[ROWS - 1] ?? ''
  const composerRow = (): string => frame.lines().find(line => line.includes('›')) ?? ''
  // 键位提示挪到底栏，框内只剩一句占位；列表层底栏说选轮 + s/c。
  check('P15e. 列表层：底栏说 s 与 c，框内不再有键位提示',
    bottomBar().includes('s 送聊天') && bottomBar().includes('c 复制')
    && !composerRow().includes('送聊天'),
    JSON.stringify({ bottom: bottomBar().trim(), box: composerRow().trim() }))

  const second = findTitle('第二问标题')
  check('P15a. 选中标题只反色字形（inverse，且文本无行尾补空格）',
    second?.textStyles?.inverse === true && textOf(second) === '第二问标题',
    JSON.stringify({ inverse: second?.textStyles?.inverse, text: second === undefined ? '' : JSON.stringify(textOf(second)) }))
  check('P15b. 未选中的标题不反色', findTitle('第一问标题')?.textStyles?.inverse !== true,
    JSON.stringify(findTitle('第一问标题')?.textStyles?.inverse))

  // 光标进侧栏输入框（编辑层）：高亮收起——列表没拿键盘时不该有常驻标记。
  await keys(frame, ['\r'])
  await delay(300)
  check('P15c. 编辑层里不显示选中反色（光标在输入框）',
    findTitle('第二问标题')?.textStyles?.inverse !== true,
    JSON.stringify({ inverse: findTitle('第二问标题')?.textStyles?.inverse, bottom: bottomBar().trim() }))
  // 编辑层里 s/c 只是打字：底栏改说「↑ 回标题」，绝不广告 s to chat。
  check('P15f. 编辑层：底栏不广告 s/c，改说 ↑ 选择',
    bottomBar().includes('↑ 选择') && !bottomBar().includes('送聊天') && !bottomBar().includes('复制'),
    JSON.stringify({ bottom: bottomBar().trim() }))

  // 鼠标点另一条标题：高亮挪过去，并离开编辑层（高亮才看得见）。头部那行也写着
  // 首问标题，所以取最后一个匹配的屏幕行 = 线程里的标题行。
  const rows = frame.lines()
  const at = rows.map(line => line.includes('第一问标题')).lastIndexOf(true)
  const col = (rows[at] ?? '').indexOf('第一问标题') + 2
  frame.stdin.write(`\x1b[<0;${col};${at + 1}M`)
  frame.stdin.write(`\x1b[<0;${col};${at + 1}m`)
  await delay(400)
  check('P15d. 点标题行把高亮挪到那一轮（并离开编辑层）',
    btwThreads.get('probe-session')?.selectedTurnId === r1.turnId
    && findTitle('第一问标题')?.textStyles?.inverse === true,
    JSON.stringify({ selected: btwThreads.get('probe-session')?.selectedTurnId, want: r1.turnId }))
  await frame.app.unmount()
}

// ── P16: 选中轮的最小滚动揭示（视口里没有上一条标题时才滚）──────────────
{
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(105, 'btw', true, channel)
  // 9 轮 1 行问答 → 内容远高于面板视口，↑ 一定会把选中走出视口。
  for (let i = 1; i <= 9; i += 1) {
    btwThreads.submit('probe-session', `第${i}问标题`, ask.ask)
    await delay(120)
    ask.finish(`第${i}答正文`)
    await delay(120)
  }
  await delay(400)
  const last = btwThreads.get('probe-session')?.turns.at(-1)?.turnId
  check('P16a. 起点选中最后一条，且它在视口里（跟尾）',
    btwThreads.get('probe-session')?.selectedTurnId === last
    && frame.lines().join('\n').includes('第9问标题'),
    String(btwThreads.get('probe-session')?.selectedTurnId))
  const problems: string[] = []
  let reveals = 0
  for (let step = 0; step < 6; step += 1) {
    const beforeText = frame.lines().join('\n')
    await keys(frame, ['\x1b[A'])
    await delay(260)
    const afterText = frame.lines().join('\n')
    const question = btwThreads.selectedTurn('probe-session')?.question ?? ''
    const wasVisible = beforeText.includes(question)
    if (!afterText.includes(question)) problems.push(`step${step} 选中标题不可见:${question}`)
    // 目标标题本来就在视口里 → 一行都不该滚（文本帧应完全相同；高亮是样式，不入文本）。
    if (wasVisible && afterText !== beforeText) problems.push(`step${step} 已可见却滚了:${question}`)
    if (!wasVisible) reveals += 1
  }
  check('P16b. ↑ 走位后选中标题始终可见，且已可见时不动滚动', problems.length === 0, problems.join(' | '))
  check('P16c. 这条线程确实走到了「滚出视口 → 揭示」路径', reveals > 0, 'reveals=' + reveals)
  await frame.app.unmount()
}

// ── P17: 只允许把已完成答案送聊天；失败/中止时仍可在侧栏读部分答复 ─────
for (const phase of ['running', 'failed', 'cancelled'] as const) {
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const frame = await mountPanel(140, 'btw', true, channel)
  btwThreads.submit('probe-session', 'phase ' + phase, ask.ask)
  if (phase === 'running') {
    await keys(frame, ['s'])
    check('P17. 空的在途答案不附加', channel.attachedContexts.length === 0)
  }
  ask.emit('partial-' + phase)
  if (phase === 'failed') ask.fail('failed on purpose')
  if (phase === 'cancelled') {
    btwThreads.abortActive('probe-session')
    ask.finish('late answer')
  }
  await settle(() => frame.lines().join('\n').includes('partial-' + phase))
  await keys(frame, ['s'])
  check('P17. ' + phase + ' 不附加且不切走焦点', channel.attachedContexts.length === 0
    && !frame.lines()[ROWS - 1].includes('Ctrl+B'), JSON.stringify(channel.attachedContexts))
  await frame.app.unmount()
}

// ── P18: 单轮长答案从编辑层回列表时也要揭示标题（ID 没变）──────────────
{
  btwThreads.resetForTest()
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  const question = 'LONG-ANSWER-QUESTION'
  btwThreads.submit('probe-session', question, ask.ask)
  ask.finish(Array.from({ length: 30 }, (_, index) => 'paragraph-' + index).join('\n\n'))
  await settle(() => btwThreads.selectedTurn('probe-session')?.phase === 'completed')
  const frame = await mountTree(100, <BtwThreadScene channel={channel as never} onClose={() => {}} />)
  check('P18a. 长答案起点跟尾，标题在视口外', frame.lines().join('\n').includes('paragraph-29')
    && !frame.lines().join('\n').includes(question))
  await keys(frame, ['\x1b[A'])
  check('P18b. 输入框 ↑ 回列表即揭示选中标题', await settled(() => frame.lines().join('\n').includes(question)))
  await keys(frame, ['\x1b[6~', '\x1b[6~', '\x1b[6~', '\x1b[6~'])
  await settle(() => frame.lines().join('\n').includes('paragraph-29'))
  await keys(frame, ['\r', ESC])
  check('P18c. Esc 回列表也揭示同一标题', await settled(() => frame.lines().join('\n').includes(question)))
  await frame.app.unmount()
}

// ── P19: React 19 的 ref 清理必须同时撤销标题节点注册 ───────────────────
{
  // 只观察真实标题节点注册的 Map，不给产品增加测试接口或持有历史节点。
  const rowMaps = new Set<Map<unknown, unknown>>()
  const originalSet = Map.prototype.set
  Map.prototype.set = function<K, V>(this: Map<K, V>, key: K, value: V): Map<K, V> {
    if (typeof key === 'string' && /^btw-\d+$/u.test(key)
      && typeof value === 'object' && value !== null && 'nodeName' in value && value.nodeName === 'ink-box') {
      rowMaps.add(this)
    }
    originalSet.call(this, key, value)
    return this
  }
  const ask = scriptedAsk()
  const channel = makePanelChannel(ask)
  let frame: Frame | undefined
  try {
    frame = await mountPanel(140, 'btw', true, channel)
    for (let index = 0; index < 3; index += 1) {
      const answer = 'topic-answer-' + index
      btwThreads.submit('probe-session', 'topic ' + index, ask.ask)
      ask.finish(answer)
      await settle(() => frame!.lines().join('\n').includes(answer))
      check('P19. 标题注册表只有当前一轮', rowMaps.size === 1 && [...rowMaps].every(map => map.size === 1))
      btwThreads.newTopic('probe-session')
      await settle(() => frame!.lines().join('\n').includes('还没有侧问'))
      check('P19. 新话题释放旧标题节点 ' + index, [...rowMaps].every(map => map.size === 0),
        JSON.stringify([...rowMaps].map(map => map.size)))
    }
  } finally {
    Map.prototype.set = originalSet
    await frame?.app.unmount()
  }
}

btwThreads.resetForTest()
console.log(failures === 0 ? '\nbtw-panel: ALL PASS' : '\nbtw-panel: ' + failures + ' FAIL')
process.exit(failures === 0 ? 0 : 1)
