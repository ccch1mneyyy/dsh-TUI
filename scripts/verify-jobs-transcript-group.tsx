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
  constructor(private term: InstanceType<typeof XTerm>, cols = COLS) {
    super()
    this.columns = cols
  }
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

async function withTerminal(
  make: () => React.ReactNode,
  run: (frame: Frame) => Promise<void>,
  // 列宽可覆盖：成组的竖线是逐行自绘的，宽度一变就要重新核对行数
  cols = COLS,
): Promise<void> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols) as unknown as NodeJS.WriteStream
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
    check('G1 相邻卡片之间只有命令行、没有空行', i2 === i1 + 2, 'i1=' + i1 + ' i2=' + i2)
    const firstCommand = lines[i1 + 1] ?? ''
    const lastCommand = lines[i2 + 1] ?? ''
    check('G1 色边仅覆盖命令节，胶囊无组竖线', !(lines[i1] ?? '').startsWith('│ ') && firstCommand.startsWith('│ ') && !(lines[i2] ?? '').startsWith('│ ') && lastCommand.startsWith('│ '),
      JSON.stringify([lines[i1], firstCommand, lines[i2], lastCommand]))
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
    check('G5 单卡胶囊无组rail，命令节色边独立', frame.lines().filter(line => line.includes('job: pwsh-')).every(line => !line.startsWith('│ ')) && !/[╭╰└]/.test(frame.screen()) && frame.lines().filter(line => line.startsWith('│ ')).length === 2)
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
    check('G13 长命令默认折叠并显示续行数', await settled(() => frame.screen().includes('Get-ChildItem')) && !frame.screen().includes(TAIL) && !frame.screen().includes('pwsh -Command'), frame.lines().slice(0, 5).join('|'))
    frame.rerender(renderList(rows, { expanded: true }))
    check('G13 长命令尾部可见（换行而非截断）', await settled(() => frame.screen().includes(TAIL)),
      frame.lines().filter(l => l.trim() !== '').slice(0, 5).join('|'))
    const cardLines = frame.lines().filter(l => l.includes('job: pwsh-1') || l.includes('Get-ChildItem'))
    check('G13 长命令占多行', cardLines.length >= 2, JSON.stringify(cardLines).slice(0, 300))
    check('G13 每个命令正文行都有节色边且没有词标签或树标', frame.lines().filter(line => line.includes('Get-ChildItem')).every(line => line.startsWith('│ ')) && !frame.screen().includes('⎿') && !frame.screen().includes('▾ script'), frame.lines().slice(0, 6).join('|'))
    frame.rerender(renderList(rows))
    check('G13 可以再次折叠', await settled(() => !frame.screen().includes(TAIL) && frame.screen().includes('Get-ChildItem')))
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
    const waterfallLines = frame.lines().filter(l => l.includes('segment-') || l.includes(OUT_TAIL))
    check('G14 瀑布恒定两行', waterfallLines.length === 2,
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
      check('G15 面板详情默认折叠长命令', await settled(() => frame.screen().includes('pnpm --filter')) && !frame.screen().includes(CMD_TAIL), frame.lines().slice(0, 9).join('|'))
      frame.stdin.write('e')
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
// extensible" when a frozen resume snapshot is decorated in place.
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

const commandMark = process.platform === 'win32' ? '>' : '❯'

console.log('--- G17: command expansion does not move the status out of its capsule ---')
{
  const label = 'cd D:/project\n' + 'Write-Output long-command-part '.repeat(7)
  const rows = [1, 2, 3].map(id => jobRow(id, makeJob('pwsh-' + id, 'completed', { label })))
  await withTerminal(() => renderList(rows, { jobGroupFold: 'never' }), async frame => {
    check('G17 folded: all three capsules remain visible', await settled(() => frame.screen().includes('job: pwsh-3')))
    const capsules = frame.lines().filter(line => line.includes('job: pwsh-'))
    check('G17 capsules: status stays bright outside section edges', capsules.length === 3 && capsules.every(line => line.startsWith('✓ ') && !line.includes('│')), JSON.stringify(capsules))
    check('G17 folded: command sections each show one first statement', frame.lines().filter(line => line.startsWith('│ ')).length === 3)
    frame.rerender(renderList(rows, { jobGroupFold: 'never', expanded: true }))
    check('G17 expanded: full command remains available', await settled(() => frame.screen().includes('long-command-part')))
    check('G17 expanded: no orphan state glyph or tree controls', !frame.lines().some(line => /^\s*[✓✗●]\s*$/.test(line)) && !frame.screen().includes('⎿') && !/[╭╰]/.test(frame.screen()))
  })
}

console.log('--- G18: content rows use continuous section edges, not a group rail ---')
{
  const label = 'cd D:/project\nWrite-Output first section row\nWrite-Output final section row'
  const rows = [jobRow(1, makeJob('pwsh-1', 'completed', { label })), jobRow(2, makeJob('pwsh-2', 'running', { label, outputLines: [{ text: 'output first' }, { text: 'output last' }] }))]
  await withTerminal(() => renderList(rows, { jobGroupFold: 'never', expanded: true }), async frame => {
    check('G18 both sections render', await settled(() => frame.screen().includes('output last')))
    const lines = frame.lines().filter(line => line.trim() !== '')
    const content = lines.filter(line => !line.includes('background jobs ×') && !line.includes('job: '))
    check('G18 every command/output row has exactly one edge', content.length === 8 && content.every(line => line.startsWith('│ ') && !line.slice(2).includes('│')), JSON.stringify(content))
    check('G18 capsules replace group separators without extra rails', lines.filter(line => line.includes('job: ')).every(line => !line.startsWith('│ ')) && !/[╭╰└]/.test(frame.screen()))
    check('G18 section marks occur only on first rows', content.filter(line => line.startsWith('│ ' + commandMark + ' ')).length === 2 && content.filter(line => line.startsWith('│ ≡ ')).length === 1)
    const cmd = frame.lines().findIndex(line => line.startsWith('│ ' + commandMark))
    const out = frame.lines().findIndex(line => line.startsWith('│ ≡'))
    const cmdColor = frame.term.buffer.active.getLine(cmd)?.getCell(0)?.getFgColor()
    const outColor = frame.term.buffer.active.getLine(out)?.getCell(0)?.getFgColor()
    check('G18 command and output edges use different continuous colors', cmd >= 0 && out >= 0 && cmdColor !== outColor && frame.term.buffer.active.getLine(out + 1)?.getCell(0)?.getFgColor() === outColor, JSON.stringify({ cmdColor, outColor }))
  })
}

console.log('--- G19: output remains a two-row tail while command expansion changes ---')
{
  const rows = [jobRow(1, makeJob('pwsh-live', 'running', { label: 'first command\nlast command', outputLines: Array.from({ length: 5 }, (_, index) => ({ text: 'LIVE-OUT-' + index })) }))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G19 folded: newest output rows remain, earlier output does not', await settled(() => frame.screen().includes('LIVE-OUT-4')) && frame.screen().includes('LIVE-OUT-3') && !frame.screen().includes('LIVE-OUT-0'))
    frame.rerender(renderList(rows, { expanded: true }))
    check('G19 expanded: only the command grows', await settled(() => frame.screen().includes('last command')) && frame.lines().filter(line => line.includes('LIVE-OUT-')).length === 2 && !frame.screen().includes('LIVE-OUT-0'))
    const outputRows = frame.lines().filter(line => line.includes('LIVE-OUT-'))
    check('G19 output symbol and edge stay on two preview rows', outputRows[0]?.startsWith('│ ≡ ') && outputRows[1]?.startsWith('│ LIVE-OUT-4') && outputRows.every(line => !line.slice(2).includes('│')), JSON.stringify(outputRows))
  })
}

console.log('--- G20: summaries stay above zero-gap capsules and folded groups hide sections ---')
{
  const rows = [jobRow(1, makeJob('pwsh-1', 'completed')), jobRow(2, makeJob('pwsh-2', 'completed'))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G20 open: group summary remains', await settled(() => frame.screen().includes('background jobs ×2')))
    const lines = frame.lines()
    const first = idxOf(lines, 'job: pwsh-1')
    const second = idxOf(lines, 'job: pwsh-2')
    check('G20 open: capsule is the only card separator', first >= 0 && second === first + 2 && lines[first + 1]?.startsWith('│ '), lines.slice(0, 6).join('|'))
    check('G20 open: no group bracket remains', !/[╭╰└]/.test(frame.screen()))
  })
  await withTerminal(() => renderList([...rows, jobRow(3, makeJob('pwsh-3', 'completed'))]), async frame => {
    check('G20 folded: one summary and no command/output edges', await settled(() => frame.screen().includes('3 background jobs folded')) && !frame.screen().includes('│'))
  })
}

console.log('--- G21: every width keeps content inside the two-column section edge ---')
{
  const label = 'cd D:/project\n' + 'Write-Output expanded command piece; '.repeat(4) + 'COMMAND-END'
  for (const cols of [60, 80, 140]) {
    const rows = [jobRow(1, makeJob('pwsh-width', 'running', { label, outputLines: [{ text: 'first output' }, { text: 'last output' }] }))]
    await withTerminal(() => renderList(rows, { expanded: true }), async frame => {
      check('G21 ' + cols + ': command and tail both render', await settled(() => frame.screen().includes('COMMAND-END') && frame.screen().includes('last output')))
      const body = frame.lines().filter(line => line.trim() !== '' && !line.includes('job: '))
      check('G21 ' + cols + ': content rows keep edges without group brackets', body.length >= 4 && body.every(line => line.startsWith('│ ')) && !/[╭╰]/.test(frame.screen()), JSON.stringify(body))
    }, cols)
  }
}

console.log('--- G22: narrow sections keep at least twenty-four content columns and full expansion ---')
{
  const token = 'ABCDEFGHIJKLMNOPQRSTUVWX'
  for (const cols of [28, 34]) {
    const rows = [jobRow(1, makeJob('pwsh-narrow', 'running', { label: 'pwsh -Command "' + token + '\nNARROW-END"', outputLines: [{ text: 'last output row' }] }))]
    await withTerminal(() => renderList(rows), async frame => {
      check('G22 ' + cols + ': folded preview fits the interpreter-free first statement', await settled(() => frame.screen().includes(token)) && !frame.screen().includes('NARROW-END') && !frame.screen().includes('pwsh -Command'), frame.lines().slice(0, 5).join('|'))
      const command = frame.lines().find(line => line.includes(token)) ?? ''
      check('G22 ' + cols + ': two-column edge plus one-character section mark', command.startsWith('│ ' + commandMark + ' ' + token), JSON.stringify(command))
      frame.rerender(renderList(rows, { expanded: true }))
      check('G22 ' + cols + ': remaining command rows expand inside the edge', await settled(() => frame.screen().includes('│ NARROW-END')) && frame.lines().filter(line => line.includes(token) || line.includes('NARROW-END') || line.includes('last output row')).every(line => line.startsWith('│ ')))
    }, cols)
  }
}

console.log('--- G23: body clicks and Ctrl+O toggle only the command; capsule opens the job ---')
{
  const rows = [jobRow(1, makeJob('pwsh-click', 'running', { label: 'cd D:/project\nCOMMAND-LAST-LINE', outputLines: Array.from({ length: 5 }, (_, index) => ({ text: 'CLICK-OUT-' + index })) }))]
  const toggled = new Set<number>()
  const opened: string[] = []
  let allExpanded = false
  let frameRef: Frame | undefined
  function Keys(): null {
    useInput((input, key) => {
      if (input === 'o' && (key as { ctrl?: boolean }).ctrl === true) { allExpanded = !allExpanded; frameRef?.rerender(view()) }
    })
    return null
  }
  const view = (): React.ReactNode => React.createElement(AlternateScreen, null, React.createElement(Keys), React.createElement(MessageList, {
    ...listProps(rows, { expanded: allExpanded, expandedRows: [...toggled], onToggleRow: id => {
      if (toggled.has(id)) toggled.delete(id)
      else toggled.add(id)
      frameRef?.rerender(view())
    } }),
    onOpenJobs: (id: string) => { opened.push(id) },
  }))
  await withTerminal(view, async frame => {
    frameRef = frame
    check('G23 default: first statement and two output rows only', await settled(() => frame.screen().includes('CLICK-OUT-4')) && !frame.screen().includes('COMMAND-LAST-LINE') && frame.lines().filter(line => line.includes('CLICK-OUT-')).length === 2)
    const clickText = async (text: string): Promise<void> => {
      const hit = termTest.findText(frame.term, text)
      check('G23 hit target: ' + text, hit !== null)
      if (hit === null) return
      frame.stdin.write('\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + 'M')
      await sleep(30) // 固定窗:pacing 鼠标按下和松开分成两次事件
      frame.stdin.write('\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + 'm')
    }
    await clickText('cd D:/project')
    check('G23 body click: full command opens but output remains two rows', await settled(() => frame.screen().includes('COMMAND-LAST-LINE')) && frame.lines().filter(line => line.includes('CLICK-OUT-')).length === 2 && opened.length === 0)
    await clickText('CLICK-OUT-3')
    check('G23 output click: folds the command without expanding output', await settled(() => !frame.screen().includes('COMMAND-LAST-LINE')) && !frame.screen().includes('CLICK-OUT-0'))
    frame.stdin.write('\x0f')
    check('G23 Ctrl+O: opens full command', await settled(() => frame.screen().includes('COMMAND-LAST-LINE')) && !frame.screen().includes('CLICK-OUT-0'))
    frame.stdin.write('\x0f')
    check('G23 Ctrl+O: folds the command again', await settled(() => !frame.screen().includes('COMMAND-LAST-LINE')))
    await clickText('job: pwsh-click')
    check('G23 capsule: opens the correct task rather than expanding', await settled(() => opened[0] === 'pwsh-click') && !frame.screen().includes('COMMAND-LAST-LINE'), JSON.stringify(opened))
  })
}

console.log('--- G24: twenty-five script lines expand completely with no control rows ---')
{
  const script = Array.from({ length: 25 }, (_, index) => 'SCRIPT-ROW-' + String(index + 1).padStart(2, '0')).join('\n')
  const rows = [jobRow(1, makeJob('pwsh-all', 'completed', { label: 'pwsh -NoProfile -Command "' + script + '"', outputLines: [{ text: 'output row one' }, { text: 'output row two' }] }))]
  await withTerminal(() => renderList(rows), async frame => {
    check('G24 folded: interpreter-free first statement without labels', await settled(() => frame.screen().includes('SCRIPT-ROW-01')) && !frame.screen().includes('SCRIPT-ROW-02') && !frame.screen().includes('pwsh -NoProfile') && !frame.screen().includes('⎿'))
    frame.rerender(renderList(rows, { expanded: true }))
    check('G24 expanded: twenty-five command rows all paint', await settled(() => frame.screen().includes('SCRIPT-ROW-25')) && frame.lines().filter(line => /SCRIPT-ROW-\d{2}/.test(line)).length === 25 && !frame.screen().includes('script (') && !frame.screen().includes('⎿'), frame.lines().slice(0, 30).join('|'))
    const command = termTest.findText(frame.term, 'SCRIPT-ROW-01')
    const header = termTest.findText(frame.term, 'job: pwsh-all')
    const bodyColor = command === null ? undefined : frame.term.buffer.active.getLine(command.row)?.getCell(command.col)?.getFgColor()
    const rgb = bodyColor === undefined ? '' : `rgb(${(bodyColor >> 16) & 255},${(bodyColor >> 8) & 255},${bodyColor & 255})`
    check('G24 hierarchy: content stays gray and capsule stays bright', command !== null && header !== null && rgb === (await import('../src/theme.js')).getActiveTheme().inactive && frame.term.buffer.active.getLine(header.row)?.getCell(header.col)?.getFgColor() !== bodyColor)
    check('G24 output: settled and expanded cards still show exactly two rows', frame.lines().filter(line => line.includes('output row')).length === 2)
    const { jobCommandRows } = await import('../src/components/Chat/JobCard.js')
    const compact = jobCommandRows('pwsh -Command "first\n\n\nlast"', 80, true)
    check('G24 blanks: repeated empty lines compress to one without adding labels', compact.length === 3 && compact[1] === '' && compact[2] === 'last', JSON.stringify(compact))
    frame.rerender(renderList([jobRow(1, makeJob('pwsh-blank', 'completed', { label: 'first\n\n\nlast' }))], { expanded: true }))
    await settled(() => frame.screen().includes('│ last'))
    const first = frame.lines().findIndex(line => line.trimEnd().endsWith(commandMark + ' first'))
    const last = frame.lines().findIndex(line => line.trimEnd().endsWith('│ last'))
    check('G24 blanks: one actual visual blank row remains inside the edge', first >= 0 && last === first + 2 && frame.lines()[first + 1]?.trim() === '│', frame.lines().slice(0, 6).join('|'))
  })
}

if (failed > 0) {
  console.error('\n' + failed + ' check(s) failed')
  process.exit(1)
}
console.log('\nALL PASS')
