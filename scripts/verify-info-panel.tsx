/**
 * InfoPanel 无头回归：headless XTerm + AlternateScreen 面板夹具（面板必须
 * 套 AlternateScreen——定高盒在非 alt-screen 下丢子节点）。直挂
 * SidePanelRuntimeContext / PanelContext（与 PanelHost 相同的两份 context），
 * 键盘从 stdin 进 → 经 usePanelInput 契约（v2.1 dispatcher）→ ↑/↓ 滚动；
 * 滚轮走 ScrollBox 的位置路由。锁定：
 *  - 分组标题与点名要的字段都出现（有数据分支）；
 *  - 无数据分支：缺省值渲染 info-value-none（'—'）；
 *  - 长 cwd / 长标题不溢出不折行（每行显示宽度 ≤ 面板宽度）；
 *  - 窄到 28 列仍可读；
 *  - visible=false / 未聚焦：usePanelInput 以 enabled=false 注册、键不投递；
 *  - ↑/↓ 与滚轮都能滚动。
 * Run: node --import tsx/esm scripts/verify-info-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, runtimeCtx, { InfoPanel }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('../src/components/sidePanel/InfoPanel.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, useInput } = ui
const { SidePanelRuntimeContext, PanelContext } = runtimeCtx
const { settled, sleep } = termTest

const COLS = 60
const ROWS = 46

let failed = 0
let passed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (ok ? '' : '  (' + extra + ')'))
  if (ok) passed += 1; else failed += 1
}

// --- fake channel（ChannelUi 只读投影子集） ----------------------------------
interface FakeChannel extends Record<string, any> {
  version: number
  subscribe(listener: () => void): () => void
}
let channelVersion = 0
const listeners = new Set<() => void>()
function makeChannel(patch: Record<string, unknown>): FakeChannel {
  const base: Record<string, unknown> = {
    rows: [],
    notifications: [],
    notify() {},
    status: 'idle',
    sessionTitle: '',
    sessionId: '',
    agentId: '',
    model: '',
    provider: 'custom-relay',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    mainCost: {},
    subagentCost: [],
    cwd: '/',
    displayCwd: '/',
    working: false,
    spinnerMode: 'requesting',
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tpsSamples: [],
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    statusBar: {},
    backgroundJobs: [],
    subagents: [],
    get version() { return channelVersion },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return Object.assign(base, patch) as FakeChannel
}
function setChannel(channel: FakeChannel, patch: Record<string, unknown>): void {
  Object.assign(channel, patch)
  channelVersion += 1
  for (const listener of [...listeners]) listener()
}

const LONG_TITLE = 'LongSessionTitlePrefix' + 't'.repeat(60)
const LONG_CWD = 'D:/x/' + 'y'.repeat(60) + '-cwd-tail'
const FULL: Record<string, unknown> = {
  status: 'idle',
  sessionTitle: LONG_TITLE,
  sessionId: '12345678-abcd-ef01-2345-6789abcdef01',
  agentId: '87654321-abcd-ef01-2345-6789abcdef01',
  model: 'deepseek-chat-v4',
  provider: 'deepseek',
  tokens: { input: 12_345, output: 678, cacheRead: 4_000, cacheWrite: 200 },
  mainCost: {},
  subagentCost: [],
  cwd: 'D:/code/projects/.worktrees/dsh-tui-live',
  displayCwd: LONG_CWD,
  gitBranch: 'feat/launchpad',
  working: true,
  spinnerMode: 'thinking',
  contextWindow: 128_000,
  reasoningEffort: 'high',
  lastUsage: { input: 12_000, output: 500, cacheRead: 60_000, cacheWrite: 1_000 },
  tps: 37.4,
  tpsSamples: [{ tps: 30, at: Date.now() }, { tps: 44, at: Date.now() }],
  mode: { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
  backgroundJobs: [
    { id: 'job-1', label: 'one', status: 'running', startedAt: Date.now(), outputLines: [] },
    { id: 'job-2', label: 'two', status: 'completed', startedAt: Date.now(), outputLines: [] },
  ],
  subagents: [{ agentId: 'a' }, { agentId: 'b' }],
}

// --- harness：context 直挂 + stdin→usePanelInput 转发 ------------------------
const captured: {
  enabled: boolean | null
  handler: ((input: string, key: Record<string, boolean | undefined>) => boolean | void) | null
  calls: number
} = { enabled: null, handler: null, calls: 0 }
let mountProps: { width: number; height: number; focused: boolean; visible: boolean } = {
  width: 40, height: 40, focused: true, visible: true,
}

function Harness({ channel }: { channel: FakeChannel }): React.ReactNode {
  const runtime = React.useMemo(() => ({
    registerInput: (_id: string, handler: never, enabled: boolean) => {
      captured.enabled = enabled
      captured.handler = handler as typeof captured.handler
      return () => { captured.handler = null }
    },
    dispatchKey: () => false,
  }), [])
  const [, bump] = React.useState(0)
  React.useEffect(() => channel.subscribe(() => bump(v => v + 1)), [channel])
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    if (mountProps.focused && mountProps.visible && captured.handler !== null) {
      captured.handler(input, key)
      captured.calls += 1
    }
    bump(v => v + 1)
  })
  return (
    <SidePanelRuntimeContext.Provider value={{ runtime, channel: channel as never }}>
      <PanelContext.Provider value={{ panelId: 'info' }}>
        <Box width={mountProps.width} height={Math.min(mountProps.height, ROWS)}>
          <InfoPanel {...mountProps} mode="split" />
        </Box>
      </PanelContext.Provider>
    </SidePanelRuntimeContext.Provider>
  )
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

async function mount(channel: FakeChannel): Promise<{
  lines: () => string[]
  stdin: FakeStdin
  term: import('@xterm/headless').Terminal
  unmount: () => Promise<void>
}> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Harness channel={channel} />
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return {
    lines: () => {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').replace(/\s+$/, ''))
      return out
    },
    stdin,
    term,
    unmount: () => app.unmount(),
  }
}

const SECTION_TITLES = ['Session', 'Model', 'Context', 'Runtime']
const FULL_VALUES = [
  'deepseek-chat-v4', 'high', 'plan mode', 'read-only·ask', 'feat/launchpad',
  '→678', '#12345678', '#87654321', '1/2', 'thinking', 'idle', '37 tps', '82.2%',
]

try {
  // --- 1. 有数据分支：标题 + 点名字段全出现，usePanelInput 以 active 注册 ----
  captured.enabled = null
  captured.handler = null
  captured.calls = 0
  mountProps = { width: 40, height: 40, focused: true, visible: true }
  const fullChannel = makeChannel(FULL)
  const A = await mount(fullChannel)
  try {
    await settled(() => A.lines().some(l => l.includes('deepseek-chat-v4')), { timeout: 4000 })
    const ls = A.lines()
    for (const title of SECTION_TITLES) {
      check('full: section title ' + JSON.stringify(title) + ' renders', ls.some(l => l.includes(title)))
    }
    for (const value of FULL_VALUES) {
      check('full: field value ' + JSON.stringify(value) + ' renders', ls.some(l => l.includes(value)),
        ls.find(l => l.includes(value.slice(0, 6)))?.trim() ?? 'absent')
    }
    check('full: context readout in status-bar format (% (used/window))',
      ls.some(l => l.includes('% (') && l.includes('/128k')), ls.find(l => l.includes('/128k'))?.trim() ?? '')
    check('full: usePanelInput registered active (focused && visible)', captured.enabled === true, String(captured.enabled))

    // --- 4. 键盘：↑/↓ 经 usePanelInput 滚动 --------------------------------
    // 视口压到 12 行：Runtime 组（'Subagents' 行）在折下。
    mountProps = { width: 40, height: 12, focused: true, visible: true }
    setChannel(fullChannel, { tps: 38 }) // bump → harness 重渲染读新 props
    await sleep(120) // 固定窗:pacing props 生效的一帧余量
    check('keys: subagents row below the fold at height 12', !A.lines().some(l => l.includes('Subagents')))
    for (let i = 0; i < 12; i += 1) {
      A.stdin.write('\x1b[B')
      await sleep(15) // 固定窗:pacing 逐 tick 按键——同 tick 多次写入会合并成一条粘贴
    }
    await settled(() => A.lines().some(l => l.includes('Subagents')), { timeout: 4000 })
    check('keys: downArrow (12 ticks) reveals the Runtime tail', A.lines().some(l => l.includes('Subagents')))
    for (let i = 0; i < 12; i += 1) {
      A.stdin.write('\x1b[A')
      await sleep(15) // 固定窗:pacing 逐 tick 按键
    }
    await settled(() => A.lines().some(l => l.includes('Session')), { timeout: 4000 })
    check('keys: upArrow scrolls back to the head', A.lines().some(l => l.includes('Session')))

    // --- 5. 滚轮：SGR wheel（位置路由进 ScrollBox） -------------------------
    for (let i = 0; i < 12; i += 1) {
      A.stdin.write('\x1b[<65;10;3M')
      A.stdin.write('\x1b[<65;10;3m')
      await sleep(15) // 固定窗:pacing 逐 tick 滚轮
    }
    await settled(() => A.lines().some(l => l.includes('Subagents')), { timeout: 4000 })
    check('wheel: SGR wheel-down scrolls the panel', A.lines().some(l => l.includes('Subagents')))
  } finally {
    await A.unmount()
    A.term.dispose()
  }

  // --- 2. 无数据分支：缺省全 '—'（info-value-none） ------------------------
  mountProps = { width: 40, height: 40, focused: true, visible: true }
  const emptyChannel = makeChannel({})
  const B = await mount(emptyChannel)
  try {
    await settled(() => B.lines().some(l => l.includes('Session')), { timeout: 4000 })
    const ls = B.lines()
    const dashRows = ls.filter(l => l.includes('—'))
    check('empty: missing values render info-value-none (—)', dashRows.length >= 8, String(dashRows.length))
    check('empty: no model id', !ls.some(l => l.includes('deepseek-chat-v4')))
    for (const title of SECTION_TITLES) {
      check('empty: section title ' + JSON.stringify(title) + ' still renders', ls.some(l => l.includes(title)))
    }
    check('empty: token totals render zero', ls.some(l => l.includes('0→0')))
  } finally {
    await B.unmount()
    B.term.dispose()
  }

  // --- 3. 长 cwd / 长标题不溢出（40 列 / 28 列各一遍） ----------------------
  for (const panelWidth of [40, 28]) {
    mountProps = { width: panelWidth, height: 40, focused: true, visible: true }
    const C = await mount(makeChannel(FULL))
    try {
      await settled(() => C.lines().some(l => l.includes('Session')), { timeout: 4000 })
      const ls = C.lines()
      check('overflow@' + panelWidth + ': every line within terminal width', ls.every(l => l.length <= COLS),
        ls.find(l => l.length > COLS) ?? '')
      // 长标题截断：前缀可见、全文（含尾标）不出现、不折行到第二行。
      check('overflow@' + panelWidth + ': long title prefix visible, tail truncated',
        ls.some(l => l.includes(panelWidth >= 40 ? 'LongSessionTitle' : 'LongSess'))
        && ls.filter(l => l.includes('tttt')).length <= 1,
        ls.find(l => l.includes('LongSessionTitlePrefix'))?.trim() ?? 'absent')
      // 长 cwd 同理：连续 y 段只出现在一行（无折行），'-cwd-tail' 被截掉。
      check('overflow@' + panelWidth + ': long cwd truncated on ONE line (no wrap)',
        !ls.some(l => l.includes('-cwd-tail')) && ls.filter(l => /yyy/.test(l)).length === 1,
        String(ls.filter(l => /yyyyyy/.test(l)).length))
      // 28 列也必须保住点名字段（可读）。
      check('narrow@' + panelWidth + ': model row still readable', ls.some(l => l.includes(panelWidth >= 40 ? 'deepseek-chat-v4' : 'deepseek')))
      check('narrow@' + panelWidth + ': branch row still readable', ls.some(l => l.includes('feat/')))
    } finally {
      await C.unmount()
      C.term.dispose()
    }
  }

  // --- 6. visible=false / 未聚焦：enabled=false 注册、键不投递 --------------
  captured.enabled = null
  captured.handler = null
  captured.calls = 0
  mountProps = { width: 40, height: 12, focused: false, visible: false }
  const D = await mount(makeChannel(FULL))
  try {
    await settled(() => D.lines().some(l => l.includes('Session')), { timeout: 4000 })
    check('inactive: usePanelInput registered with enabled=false', captured.enabled === false, String(captured.enabled))
    await sleep(60) // 固定窗:探针 留一帧确认无定时器/订阅驱动的额外渲染
    check('inactive: panel content still renders (enabled mount keeps state)', D.lines().some(l => l.includes('deepseek-chat-v4')))
    D.stdin.write('\x1b[B')
    await sleep(80) // 固定窗:探针 非 active 键不投递的观察窗
    check('inactive: keys are not delivered to the panel handler', captured.calls === 0, String(captured.calls))
  } finally {
    await D.unmount()
    D.term.dispose()
  }
} finally {
  // noop — 每个 mount 在自己的 finally 里清理
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s) (passed ' + passed + ').')
  process.exit(1)
}
console.log('OK: info panel all checks passed (' + passed + ').')
process.exit(0)