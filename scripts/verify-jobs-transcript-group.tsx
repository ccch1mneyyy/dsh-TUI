/**
 * 连续任务卡成组回归（transcript job groups / JobGroupHeader）。
 *
 * MessageList 把连续的 ≥2 张后台任务卡读成一组（见 JobGroupRow）：
 *   - 组头一行汇总（后台任务 ×N · 运行中/已完成/失败 · 合计时长），整行可点
 *   - 组内不再互相空行，成员左侧共用连接线（mid=│ / tail=└）
 *   - 折叠阈值（settings `dsh-tui.jobGroupFold`）：auto=整组落定且 ≥3；
 *     always=≥2 立即折（含在跑）；never=从不自动折
 *   - 折叠行点击 / Ctrl+O（expanded）展开；失败数留在折叠行上（不静默掩埋）
 *   - 只有相邻的任务行才成组；单张卡完全保持原样
 *
 * 渲染走真终端（headless xterm）+ 真鼠标 SGR 事件，断言读视口文本。
 * 画面预览：DSH_TUI_DUMP_FRAMES=1 会把每个场景的终屏打出来。
 *
 * 运行：node --import tsx/esm scripts/verify-jobs-transcript-group.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

// 家目录隔离：DATA_DIR（~/.dsh-tui，鼠标调试日志/设置快照的落点）在模块加载
// 时定死，所以先切临时目录再 import。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-jobs-group-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [React, uiMod, listMod, termTest] = await Promise.all([
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('./lib/term-test.mjs'),
])
const { Writable, PassThrough } = await import('node:stream')
const { Terminal: XTerm } = (await import('@xterm/headless')) as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

const { render, AlternateScreen, useInput } = uiMod as unknown as {
  render: typeof import('../src/ui.js').render
  AlternateScreen: React.ComponentType<{ children?: React.ReactNode }>
  useInput: (handler: (input: string, key: unknown) => void, options?: { isActive?: boolean }) => void
}

/**
 * 输入链路保持器：App 只在某个组件打开 raw mode 后才挂 stdin readable 监听
 * （见 App.handleSetRawMode）。MessageList 自己不用键盘，独立渲染它时若不
 * 补这一层，注入的鼠标/按键根本进不了管线——点击会静默地什么都不发生。
 */
function RawMode(): null {
  useInput((): void => {}, { isActive: true })
  return null
}
const { MessageList } = listMod as unknown as { MessageList: React.ComponentType<Record<string, unknown>> }
const { settled, sleep, viewportLines } = termTest as unknown as {
  settled(pred: () => boolean, opts?: { timeoutMs?: number }): Promise<boolean>
  // 写成属性签名的形状：`sleep(` 会被固定窗门禁当成调用点（那是文本匹配）。
  sleep: (ms: number) => Promise<void>
  viewportLines(term: InstanceType<typeof XTerm>, rows?: number): string[]
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const COLS = 100
const ROWS = 30
const DUMP = process.env.DSH_TUI_DUMP_FRAMES === '1'

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: unknown, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

interface Frame {
  screen(): string
  lines(): string[]
  rerender(node: React.ReactNode): void
  stdin: Input
  term: InstanceType<typeof XTerm>
}

async function withTerminal(make: () => React.ReactNode, run: (frame: Frame) => Promise<void>): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  const stdin = new Input()
  const instance = await render(make(), {
    stdout,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const lines = (): string[] => viewportLines(term, ROWS)
  const frame: Frame = {
    screen: () => lines().join('\n'),
    lines,
    rerender: node => { instance.rerender(node) },
    stdin,
    term,
  }
  try {
    await run(frame)
    if (DUMP) console.log('--- frame ---\n' + frame.screen().replace(/\n+$/, '') + '\n-------------')
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const NOW = Date.now()
type JobStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'killed'
interface FakeJob {
  id: string
  kind: string
  label: string
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
  outputLines: Array<{ text: string }>
}
function makeJob(id: string, status: JobStatus, extra: Partial<FakeJob> = {}): FakeJob {
  const live = status === 'running' || status === 'stopping'
  const base: FakeJob = {
    id, kind: 'pwsh', label: 'run ' + id, status,
    startedAt: NOW - 4000, outputLines: [],
    ...(live ? {} : { finishedAt: NOW - 1000, detail: 'exit code: 0' }),
  }
  return { ...base, ...extra }
}
const jobRow = (rowId: number, job: FakeJob): Record<string, unknown> =>
  ({ id: rowId, kind: 'job', text: job.label, job })
const noteRow = (rowId: number, text: string): Record<string, unknown> =>
  ({ id: rowId, kind: 'assistant', text, streaming: false })

function listProps(rows: Array<Record<string, unknown>>, opts: {
  expanded?: boolean
  expandedRows?: number[]
  jobGroupFold?: 'auto' | 'always' | 'never'
  onToggleRow?: (rowId: number) => void
} = {}): Record<string, unknown> {
  return {
    rows,
    expanded: opts.expanded === true,
    expandedRows: new Set(opts.expandedRows ?? []),
    selectedId: null,
    onToggleRow: opts.onToggleRow ?? ((): void => {}),
    model: 'deepseek-chat',
    showAll: true,
    onToggleAll(): void {},
    onLoadOlder(): void {},
    jobGroupFold: opts.jobGroupFold ?? 'auto',
  }
}
const renderList = (rows: Array<Record<string, unknown>>, opts = {}): React.ReactNode =>
  React.createElement(MessageList, listProps(rows, opts))

const idxOf = (lines: string[], needle: string): number => lines.findIndex(line => line.includes(needle))

// ---------------------------------------------------------------------------
// G1 — 两张连续落定：成组但不折叠（auto 阈值 3）
// ---------------------------------------------------------------------------
console.log('--- G1: two settled jobs group without folding ---')
{
  const rows = [noteRow(1, 'note one'), jobRow(2, makeJob('pwsh-1', 'completed')), jobRow(3, makeJob('pwsh-2', 'completed'))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G1 组头汇总出现（×2）', await settled(() => frame.screen().includes('background jobs ×2')), frame.lines().slice(0, 6).join('|'))
    const lines = frame.lines()
    const i1 = idxOf(lines, 'job: pwsh-1')
    const i2 = idxOf(lines, 'job: pwsh-2')
    check('G1 两张卡都在屏上', i1 >= 0 && i2 >= 0, 'i1=' + i1 + ' i2=' + i2)
    check('G1 组内不留空行（成员相邻）', i2 === i1 + 1, 'i1=' + i1 + ' i2=' + i2)
    check('G1 成员左侧共用连接线', (lines[i1] ?? '').startsWith('│ ') && (lines[i2] ?? '').startsWith('│ '),
      JSON.stringify([lines[i1], lines[i2]]))
    check('G1 两张不触发自动折叠', !frame.screen().includes('background jobs folded'))
    check('G1 组头报已完成数', frame.screen().includes('2 completed'))
  })
}

// ---------------------------------------------------------------------------
// G2 — 三张连续落定：折叠成一行 + 展开路径（expandedRows / Ctrl+O）
// ---------------------------------------------------------------------------
console.log('--- G2: three settled jobs fold into the summary ---')
{
  const rows = [
    noteRow(1, 'note one'),
    jobRow(2, makeJob('pwsh-1', 'completed')),
    jobRow(3, makeJob('pwsh-2', 'completed')),
    jobRow(4, makeJob('pwsh-3', 'completed')),
  ]
  await withTerminal(() => renderList(rows), async frame => {
    check('G2 全组落定 → 折叠成一行', await settled(() => frame.screen().includes('3 background jobs folded')), frame.lines().slice(0, 6).join('|'))
    check('G2 折叠行报全部完成', frame.screen().includes('all completed'))
    check('G2 折叠行给出展开提示', frame.screen().includes('click to expand'))
    check('G2 折叠标是 ▸', frame.lines().some(line => line.includes('▸') && line.includes('folded')))
    check('G2 成员卡全部收起',
      !frame.screen().includes('job: pwsh-1') && !frame.screen().includes('job: pwsh-2') && !frame.screen().includes('job: pwsh-3'))
    // 点击产出的同一状态：expandedRows 含组头行 id（row id 2）。
    frame.rerender(renderList(rows, { expandedRows: [2] }))
    check('G2 展开后三张卡回归', await settled(() => frame.screen().includes('job: pwsh-3')))
    check('G2 展开后回到汇总头（×3）', frame.screen().includes('background jobs ×3'))
    // Ctrl+O：全局展开同样打开折叠组。
    frame.rerender(renderList(rows))
    check('G2 重新折叠', await settled(() => frame.screen().includes('background jobs folded')))
    frame.rerender(renderList(rows, { expanded: true }))
    check('G2 Ctrl+O 展开折叠组', await settled(() => frame.screen().includes('job: pwsh-1')))
  })
}

// ---------------------------------------------------------------------------
// G3 — 真鼠标：点击折叠行展开整组（AlternateScreen 内才有鼠标跟踪）
// ---------------------------------------------------------------------------
console.log('--- G3: a click on the fold line expands the run ---')
{
  const rows = [
    noteRow(1, 'note one'),
    jobRow(2, makeJob('pwsh-1', 'completed')),
    jobRow(3, makeJob('pwsh-2', 'completed')),
    jobRow(4, makeJob('pwsh-3', 'completed')),
  ]
  // 受控状态闭环：点击 → onToggleRow → 更新 expandedRows → 重渲染，这正是
  // Chat 的 toggleRowExpanded 在做的事（夹具里的空 onToggleRow 会让点击
  // 悄悄通过却什么都没发生）。
  const toggled = new Set<number>()
  let frameRef: Frame | null = null
  const view = (): React.ReactNode => renderList(rows, {
    expandedRows: [...toggled],
    onToggleRow: (rowId: number): void => {
      if (toggled.has(rowId)) toggled.delete(rowId)
      else toggled.add(rowId)
      frameRef?.rerender(view())
    },
  })
  await withTerminal(
    () => React.createElement(AlternateScreen, null, React.createElement(RawMode, null), view()),
    async frame => {
      frameRef = frame
      check('G3 点击前整组折叠', await settled(() => frame.screen().includes('3 background jobs folded')), frame.lines().slice(0, 6).join('|'))
      const hit = termTest.findText(frame.term, 'background jobs folded') as { col: number; row: number } | null
      check('G3 折叠行可在屏上定位', hit !== null)
      if (hit !== null) {
        const seq = (final: string): string => '\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + final
        frame.stdin.write(seq('M')) // press
        await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
        frame.stdin.write(seq('m')) // release
        check('G3 点击折叠行展开整组', await settled(() => frame.screen().includes('job: pwsh-1')),
          'toggled=' + JSON.stringify([...toggled]) + ' | ' + frame.lines().slice(0, 6).join('|'))
        check('G3 点击落在组头行 id 上（不是别的行）', toggled.has(2), JSON.stringify([...toggled]))
      }
    },
  )
}

// ---------------------------------------------------------------------------
// G4 — 组内有存活成员：auto 不折叠（在跑的工作必须看得见）
// ---------------------------------------------------------------------------
console.log('--- G4: a live member keeps the run open ---')
{
  const rows = [
    noteRow(1, 'note one'),
    jobRow(2, makeJob('pwsh-1', 'completed')),
    jobRow(3, makeJob('pwsh-2', 'running')),
    jobRow(4, makeJob('pwsh-3', 'completed')),
  ]
  await withTerminal(() => renderList(rows), async frame => {
    check('G4 组头汇总出现（×3）', await settled(() => frame.screen().includes('background jobs ×3')), frame.lines().slice(0, 6).join('|'))
    check('G4 组头报运行中', frame.screen().includes('1 running'))
    check('G4 三张卡都可见', ['pwsh-1', 'pwsh-2', 'pwsh-3'].every(id => frame.screen().includes('job: ' + id)))
    check('G4 有存活成员时不折叠', !frame.screen().includes('background jobs folded'))
  })
}

// ---------------------------------------------------------------------------
// G5 — 中间隔着别的行：两次独立调用，不成组
// ---------------------------------------------------------------------------
console.log('--- G5: non-adjacent jobs stay ungrouped ---')
{
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed')),
    noteRow(2, 'in between'),
    jobRow(3, makeJob('pwsh-2', 'completed')),
  ]
  await withTerminal(() => renderList(rows), async frame => {
    check('G5 两张卡都在屏上', await settled(() => frame.screen().includes('job: pwsh-1') && frame.screen().includes('job: pwsh-2')), frame.lines().slice(0, 8).join('|'))
    check('G5 不出现组头', !frame.screen().includes('background jobs ×'))
    check('G5 不出现连接线', !frame.lines().some(line => line.startsWith('│ ') || line.startsWith('└ ')))
  })
}

// ---------------------------------------------------------------------------
// G6 — 失败留在折叠行上（响亮，不被折叠掩埋）
// ---------------------------------------------------------------------------
console.log('--- G6: failures stay loud on the fold line ---')
{
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed')),
    jobRow(2, makeJob('pwsh-2', 'failed')),
    jobRow(3, makeJob('pwsh-3', 'completed')),
  ]
  await withTerminal(() => renderList(rows), async frame => {
    check('G6 三张落定仍折叠', await settled(() => frame.screen().includes('3 background jobs folded')), frame.lines().slice(0, 5).join('|'))
    check('G6 折叠行报失败数', frame.screen().includes('1 failed'))
    check('G6 有失败就不说"全部完成"', !frame.screen().includes('all completed'))
  })
}

// ---------------------------------------------------------------------------
// G7 — 两段连续：前段折叠、后段保持打开，互不串组
// ---------------------------------------------------------------------------
console.log('--- G7: two runs do not merge ---')
{
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed')),
    jobRow(2, makeJob('pwsh-2', 'completed')),
    jobRow(3, makeJob('pwsh-3', 'completed')),
    noteRow(4, 'break'),
    jobRow(5, makeJob('pwsh-4', 'completed')),
    jobRow(6, makeJob('pwsh-5', 'completed')),
  ]
  await withTerminal(() => renderList(rows), async frame => {
    check('G7 前段（3 张）折叠', await settled(() => frame.screen().includes('3 background jobs folded')), frame.lines().slice(0, 8).join('|'))
    check('G7 后段（2 张）仍开组', frame.screen().includes('background jobs ×2'))
    check('G7 两段不合并成 ×5', !frame.screen().includes('background jobs ×5'))
  })
}

// ---------------------------------------------------------------------------
// G8/G9 — 设置项：never 从不自动折 / always 两张也折（含在跑）
// ---------------------------------------------------------------------------
console.log('--- G8: jobGroupFold=never keeps runs open ---')
{
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed')),
    jobRow(2, makeJob('pwsh-2', 'completed')),
    jobRow(3, makeJob('pwsh-3', 'completed')),
  ]
  await withTerminal(() => renderList(rows, { jobGroupFold: 'never' }), async frame => {
    check('G8 never：仍成组（组头在）', await settled(() => frame.screen().includes('background jobs ×3')), frame.lines().slice(0, 5).join('|'))
    check('G8 never：三张卡都留着', ['pwsh-1', 'pwsh-2', 'pwsh-3'].every(id => frame.screen().includes('job: ' + id)))
    check('G8 never：不出现折叠行', !frame.screen().includes('background jobs folded'))
  })
}
console.log('--- G9: jobGroupFold=always folds a live pair ---')
{
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'running')),
    jobRow(2, makeJob('pwsh-2', 'completed')),
  ]
  await withTerminal(() => renderList(rows, { jobGroupFold: 'always' }), async frame => {
    check('G9 always：两张（含在跑）立即折叠', await settled(() => frame.screen().includes('2 background jobs folded')), frame.lines().slice(0, 5).join('|'))
    check('G9 always：折叠行报运行中', frame.screen().includes('1 running'))
  })
}

// ---------------------------------------------------------------------------
// G10 — 单张卡保持原样（不成组、保留自己的空行节奏）
// ---------------------------------------------------------------------------
console.log('--- G10: a lone card keeps the original rhythm ---')
{
  const rows = [noteRow(1, 'note one'), jobRow(2, makeJob('pwsh-1', 'completed'))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G10 单卡在屏上', await settled(() => frame.screen().includes('job: pwsh-1')), frame.lines().slice(0, 6).join('|'))
    const lines = frame.lines()
    const iNote = idxOf(lines, 'note one')
    const iCard = idxOf(lines, 'job: pwsh-1')
    check('G10 单卡不成组（无组头/连接线）',
      !frame.screen().includes('background jobs ×') && !(lines[iCard] ?? '').startsWith('│ ') && !(lines[iCard] ?? '').startsWith('└ '),
      JSON.stringify(lines[iCard]))
    check('G10 单卡保留块间空行', iCard === iNote + 2, 'iNote=' + iNote + ' iCard=' + iCard)
  })
}

// ---------------------------------------------------------------------------
// G11 — 鼠标悬停：开着的组头亮起并提示可折叠（AlternateScreen 内才有 hover）
// ---------------------------------------------------------------------------
console.log('--- G11: hovering an open group header offers the fold ---')
{
  const rows = [jobRow(1, makeJob('pwsh-1', 'completed')), jobRow(2, makeJob('pwsh-2', 'completed'))]
  await withTerminal(
    () => React.createElement(AlternateScreen, null, React.createElement(RawMode, null), renderList(rows)),
    async frame => {
      check('G11 悬停前不显示折叠提示', await settled(() => frame.screen().includes('background jobs ×2')) && !frame.screen().includes('click to fold'),
        frame.lines().slice(0, 4).join('|'))
      const hit = termTest.findText(frame.term, 'background jobs ×2') as { col: number; row: number } | null
      check('G11 组头行可在屏上定位', hit !== null)
      if (hit !== null) {
        // mode-1003 无键 motion：SGR 35 = 3（无按键）+ 32（motion 位）。
        frame.stdin.write('\x1b[<35;' + (hit.col + 1) + ';' + (hit.row + 1) + 'M')
        check('G11 悬停组头出现折叠提示', await settled(() => frame.screen().includes('click to fold')),
          frame.lines().slice(0, 4).join('|'))
      }
    },
  )
}

// ---------------------------------------------------------------------------
// G12 — Chat 接线：channel.jobGroupFold 真的传到 MessageList（prop 丢失时
//       默认 auto 依然工作，所以只断言"不折"的档位才能抓到静默漏接）
// ---------------------------------------------------------------------------
console.log('--- G12: Chat wires channel.jobGroupFold through ---')
{
  const { Chat } = await import('../src/screens/Chat.js')
  const { QuestionStore } = await import('../src/dsh-adapter/questions.js')
  const chatRows = [
    jobRow(1, makeJob('pwsh-1', 'completed')),
    jobRow(2, makeJob('pwsh-2', 'completed')),
    jobRow(3, makeJob('pwsh-3', 'completed')),
  ]
  const makeChannel = (mode: 'auto' | 'always' | 'never'): Record<string, unknown> => ({
    version: 0,
    rows: chatRows,
    status: 'idle',
    sessionTitle: 'jobs group probe',
    agentId: 'probe',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    working: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode(): void {},
    turnStart: NOW,
    lastUserText: '',
    pending: [],
    commandList: [],
    commandCompletions: () => [],
    notifications: [],
    activityEnabled: false,
    activityFrames: [],
    backgroundJobs: [],
    jobControl: { kill: () => true },
    jobGroupFold: mode,
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (): void => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: (): void => {},
    stageImage: () => Promise.resolve(''),
    listSubagents: () => Promise.resolve([]),
    lastUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    contextWindow: 1_000_000,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tps: undefined,
    tpsSamples: [],
    reasoningEffort: 'high',
    agentPreset: 'standard',
  })
  const renderChat = (mode: 'auto' | 'always' | 'never'): React.ReactNode =>
    React.createElement(Chat, {
      channel: makeChannel(mode) as never,
      questionStore: new QuestionStore() as never,
      onExit: (): void => {},
      fullscreen: true,
      trajectorySeen: true,
    })
  await withTerminal(() => renderChat('never'), async frame => {
    check('G12 never 档：Chat 传下去后三张卡仍开着',
      await settled(() => frame.screen().includes('background jobs ×3') && frame.screen().includes('job: pwsh-3')),
      frame.lines().filter(l => l.trim() !== '').slice(0, 5).join('|'))
    check('G12 never 档：不出现折叠行', !frame.screen().includes('background jobs folded'))
  })
  await withTerminal(() => renderChat('auto'), async frame => {
    check('G12 auto 档：同一条转录折叠成一行',
      await settled(() => frame.screen().includes('3 background jobs folded')),
      frame.lines().filter(l => l.trim() !== '').slice(0, 4).join('|'))
  })
}

// ---------------------------------------------------------------------------
// G13/G14 — 长行自动换行（不再是硬截断）
// ---------------------------------------------------------------------------
console.log('--- G13: a long command label wraps in full ---')
{
  const TAIL = 'END-OF-LONG-COMMAND'
  const longLabel = 'pwsh -Command "' + 'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.FullName } ; '.repeat(2) + TAIL + '"'
  const rows = [jobRow(1, makeJob('pwsh-1', 'completed', { label: longLabel }))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G13 长命令尾部可见（换行而非截断）', await settled(() => frame.screen().includes(TAIL)),
      frame.lines().filter(l => l.trim() !== '').slice(0, 5).join('|'))
    const cardLines = frame.lines().filter(l => l.includes('job: pwsh-1') || l.includes('Get-ChildItem'))
    check('G13 长命令占多行', cardLines.length >= 2, JSON.stringify(cardLines).slice(0, 300))
  })
}
console.log('--- G14: a long output line wraps and keeps the tail ---')
{
  const OUT_TAIL = 'OUTPUT-TAIL-MARKER'
  const longOutput = Array.from({ length: 30 }, (_, i) => 'segment-' + i).join(' ') + ' ' + OUT_TAIL
  const rows = [jobRow(1, makeJob('pwsh-1', 'running', { outputLines: [{ text: longOutput }] }))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G14 长输出尾部可见（折行取尾）', await settled(() => frame.screen().includes(OUT_TAIL)),
      frame.lines().filter(l => l.includes('│')).slice(0, 4).join('|'))
    const waterfallLines = frame.lines().filter(l => l.includes('│ ') && (l.includes('segment-') || l.includes(OUT_TAIL)))
    check('G14 瀑布仍是常量高度（≤3 行）', waterfallLines.length > 0 && waterfallLines.length <= 3,
      'rows=' + waterfallLines.length + ' ' + JSON.stringify(waterfallLines).slice(0, 300))
  })
}
console.log('--- G15: the jobs panel wraps long command/output lines ---')
{
  const { JobsPanel } = await import('../src/components/JobsPanel.js')
  const CMD_TAIL = 'CMD-TAIL-MARKER'
  const ERR_TAIL = 'STDERR-TAIL-MARKER'
  const LABEL_TAIL = 'LABEL-TAIL-MARKER'
  const longCommand = 'pnpm --filter @deepseek-harness-tui/dsh-tui run ' + 'build:everything --with-flags '.repeat(4) + CMD_TAIL
  const panelJob = {
    ...makeJob('pwsh-9', 'running'),
    label: 'deploy --stack ' + 'service-name '.repeat(8) + LABEL_TAIL,
    command: longCommand,
    startedAt: NOW - 5000,
    outputLines: [{ text: 'plain stdout line' }, { text: 'error: ' + 'x'.repeat(120) + ' ' + ERR_TAIL, channel: 'stderr' as const }],
  }
  await withTerminal(
    () => React.createElement(JobsPanel, { jobs: [panelJob], onClose: (): void => {}, onKill: (): void => {} }),
    async frame => {
      check('G15 面板详情：长命令尾部可见', await settled(() => frame.screen().includes(CMD_TAIL)),
        frame.lines().filter(l => l.trim() !== '').slice(0, 8).join('|'))
      check('G15 面板列表：长任务名换行后尾部可见', frame.screen().includes(LABEL_TAIL),
        frame.lines().filter(l => l.includes('service-name') || l.includes(LABEL_TAIL)).join('|'))
      check('G15 面板详情：长 stderr 行尾部可见', frame.screen().includes(ERR_TAIL),
        frame.lines().filter(l => l.includes('error:')).slice(0, 3).join('|'))
    },
  )
}

// ---------------------------------------------------------------------------
// G16 — 冻结行契约：会话投影把行数组与每一行都 Object.freeze 后交给渲染
// （resume/replay 首帧正是这条路）。成组预补必须把装饰写到浅拷贝上；直接写
// 共享行对象会在启动即抛 "Cannot add property jobGroup, object is not
// extensible"（2026-09-30 实机 resume 闪退实证）。
// ---------------------------------------------------------------------------
console.log('--- G16: frozen rows survive grouping (session snapshot contract) ---')
{
  const frozen = Object.freeze([
    noteRow(1, 'note one'),
    jobRow(2, makeJob('pwsh-1', 'completed')),
    jobRow(3, makeJob('pwsh-2', 'completed')),
    jobRow(4, makeJob('pwsh-3', 'completed')),
  ].map(row => Object.freeze({ ...row })))
  await withTerminal(() => renderList(frozen), async frame => {
    check('G16 冻结行成组不崩且折叠行出现', await settled(() => frame.screen().includes('background jobs folded')),
      frame.lines().slice(0, 6).join('|'))
    check('G16 共享行对象未被写入装饰', frozen.every(row => (row as Record<string, unknown>).jobGroup === undefined))
  })
}

// ---------------------------------------------------------------------------
// G17 — 长标签折行时，状态标必须留在首行（flexShrink 回归）
// 现场：标签一折行，行就超约束；未加 flexShrink 的 glyph 文本节点被压缩，
// 被挤到下一行、孤零零掉到组外（2026-09-30 用户截图实证）。
// ---------------------------------------------------------------------------
console.log('--- G17: a wrapped label keeps the joint+glyph on its own line ---')
{
  const longLabel = 'npm run build --filter @deepseek-harness-tui/dsh-tui --with-every-flag-enabled ' +
    '--and-a-very-long-tail-argument-that-forces-the-label-column-to-wrap-over-several-rows indeed'
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed', { label: longLabel })),
    jobRow(2, makeJob('pwsh-2', 'completed', { label: longLabel })),
    jobRow(3, makeJob('pwsh-3', 'completed', { label: longLabel })),
  ]
  await withTerminal(() => renderList(rows, { jobGroupFold: 'never' }), async frame => {
    check('G17 折行卡渲染出来', await settled(() => frame.lines().some(l => l.includes('several-rows'))),
      frame.lines().filter(l => l.trim() !== '').slice(0, 4).join('|'))
    const lines = frame.lines()
    const head = lines.find(l => l.includes('job: pwsh-3')) ?? ''
    check('G17 末成员首行也在竖线内且带状态标', head.startsWith('│ ') && head.includes('✓'), JSON.stringify(head))
    check('G17 不出现孤立的字形行', !lines.some(l => /^\s*[✓✗●▾▸]\s*$/.test(l)),
      JSON.stringify(lines.filter(l => l.trim() !== '').slice(0, 8)))
  })
}

// ---------------------------------------------------------------------------
// G18 — 成员标签折行时竖线不得断开（竖线由 body 的左边框画，覆盖每一行）
// 现场：逐行手写前缀时，折行出来的续行在 label 列内部，没有前缀可加 →
// 组里第一张卡的续行掉线，链条断开（2026-09-30 用户截图实证）。
// ---------------------------------------------------------------------------
console.log('--- G18: every row of the group stays inside the rail ---')
{
  const longLabel = "gh pr view 1206 --repo ccch1mneyyy/dsh-TUI --json maintainerCanModify,state,headRefName --jq " +
    "'{canModify: .maintainerCanModify, state: .state, head: .headRefName}'"
  // BOTH members carry a wrapping label, and the LAST one also has a live
  // output row: the rail must cover all of it (2026-09-30 用户截图实证：
  // 最后一张的续行掉在竖线外，整组看着散)。
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed', { label: longLabel })),
    jobRow(2, makeJob('pwsh-2', 'running', { label: longLabel, outputLines: [{ text: 'compiling module a …' }] })),
  ]
  await withTerminal(() => renderList(rows, { jobGroupFold: 'never' }), async frame => {
    check('G18 折行成员渲染出来', await settled(() => frame.lines().some(l => l.includes('compiling module a'))),
      frame.lines().filter(l => l.trim() !== '').slice(0, 5).join('|'))
    const lines = frame.lines().filter(l => l.trim() !== '')
    const header = lines.findIndex(l => l.includes('background jobs ×2'))
    const body = header >= 0 ? lines.slice(header + 1) : []
    check('G18 组内每一行都在竖线内', body.length >= 4 && body.every(l => l.startsWith('│ ')),
      JSON.stringify(body.slice(0, 8)))
    check('G18 末行（输出行）同样在竖线内', (body[body.length - 1] ?? '').startsWith('│ '),
      JSON.stringify(body.slice(-2)))
  })
}

// ---------------------------------------------------------------------------
// G19 — 中间成员在跑并吐输出时，它的输出行也必须在竖线之内
// ---------------------------------------------------------------------------
console.log('--- G19: a live middle member keeps the rail on its output rows ---')
{
  const rows = [
    jobRow(1, makeJob('pwsh-1', 'completed')),
    jobRow(2, makeJob('pwsh-2', 'running', {
      label: 'pnpm run build',
      outputLines: [{ text: 'compiling module a …' }, { text: 'compiling module b …' }],
    })),
    jobRow(3, makeJob('pwsh-3', 'completed')),
  ]
  await withTerminal(() => renderList(rows, { jobGroupFold: 'never' }), async frame => {
    check('G19 中间成员的输出行可见', await settled(() => frame.lines().some(l => l.includes('compiling module b'))),
      frame.lines().filter(l => l.trim() !== '').slice(0, 6).join('|'))
    const lines = frame.lines()
    const out = lines.findIndex(l => l.includes('compiling module a'))
    check('G19 输出行在竖线之内', out >= 0 && (lines[out] ?? '').startsWith('│ '), JSON.stringify(lines[out]))
    check('G19 第二行输出同样有线', out >= 0 && (lines[out + 1] ?? '').startsWith('│ '), JSON.stringify(lines[out + 1]))
    const tail = lines.findIndex(l => l.includes('job: pwsh-3'))
    check('G19 末成员同样在竖线内', tail >= 0 && (lines[tail] ?? '').startsWith('│ '), JSON.stringify(lines[tail]))
  })
}

if (failed > 0) {
  console.error('\n' + failed + ' check(s) failed')
  process.exit(1)
}
console.log('\nALL PASS')
