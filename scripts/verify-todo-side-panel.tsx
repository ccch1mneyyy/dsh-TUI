/**
 * Todo side-panel toggle regression (user report: 侧边栏 todo 面板展开不了).
 *
 * Mounts SidePanelColumn + PanelHost headless (xterm headless + AlternateScreen
 * + a useInput raw-mode keeper) with a fake channel carrying goal + todos, and
 * locks:
 *  - a real SGR mouse click on the fold header toggles expand/collapse in the
 *    panel variant (the header row's onClick must be wired — before the fix
 *    TodoPanelAdapter never passed onToggle and the header was a dead control);
 *  - Enter and Space toggle through the v2.1 dispatcher (usePanelInput) while
 *    the panel is active;
 *  - control: the chat-page default variant still renders its list + fold
 *    hint line untouched (panel-variant-only change).
 *  - wrapped objectives and blocked reasons copy their source through the
 *    pane fence, including a real SGR drag over the mounted side panel.
 * Run: node --import tsx/esm scripts/verify-todo-side-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelColumn }, { useSidePanel }, prefs, GoalTodoPanelModule, termTest, { stringWidth }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/GoalTodoPanel.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio } = prefs
const { settled, sleep } = termTest
const {
  GoalTodoPanel, buildGoalPanelRows, goalPanelContentWidth, goalObjectiveWidth,
  goalBlockedWidth, goalPanelViewportRows, wrapTodoLines,
} = GoalTodoPanelModule as typeof import('../src/components/GoalTodoPanel.js')
const [{ renderToScreen }, { cellAt }, { TerminalSizeContext }, { SidePanelLayout }, selection, { default: instances }] = await Promise.all([
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/ink/selection.js'),
  import('../src/ink/instances.js'),
])

const COLS = 110
const ROWS = 22

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- pure row-model assertions (no xterm) -----------------------------------
// 组件与回归共用 buildGoalPanelRows：这里直接断言预算与折行，避免「渲染一
// 套、预算另一套」，也避免在测试里再写一份 height-4 之类的公式。
const rowsOf = (
  objective: string,
  options: {
    todos?: Array<{ id: string; content: string; status: string }>
    contentWidth?: number
    todoWidth?: number
    collapsed?: boolean
    showTodoSection?: boolean
    extra?: Record<string, unknown>
  } = {},
) => buildGoalPanelRows({
  goal: { id: 'g', objective, phase: 'active', roundsStarted: 0, maxGoalRounds: 4, ...options.extra } as never,
  todos: (options.todos ?? []) as never,
  showTodoSection: options.showTodoSection ?? (options.todos ?? []).length > 0,
  collapsed: options.collapsed ?? false,
  contentWidth: options.contentWidth ?? goalPanelContentWidth(28),
  todoWidth: options.todoWidth ?? 20,
})
{
  const content28 = goalPanelContentWidth(28)
  const content62 = goalPanelContentWidth(62)
  check('rows: panel content width is width - padding on both sides',
    content28 === 26 && content62 === 60, content28 + '/' + content62)
  check('rows: the objective width leaves room for the glyph plus one spare cell',
    goalObjectiveWidth(content28) === 22,
    String(goalObjectiveWidth(content28)))

  // 28/62 列：每行都不超过目标折行宽，宽字符/emoji 不丢不重。
  const wideObjective = '目标🎯abc'.repeat(20)
  for (const contentWidth of [content28, content62]) {
    const built = rowsOf(wideObjective, { contentWidth })
    const objectiveRows = built.filter(row => row.kind === 'objective')
    check(`rows: ${contentWidth + 2}-col objective rows stay within the wrap width`,
      objectiveRows.length > 1 && objectiveRows.every(row => stringWidth(row.text) <= goalObjectiveWidth(contentWidth)),
      String(objectiveRows.length))
    check(`rows: ${contentWidth + 2}-col wide chars survive wrapping`,
      objectiveRows.map(row => row.text).join('') === wideObjective)
  }

  // 显式换行 / 空行 / 组合字符。
  const multiline = rowsOf('first\n\nthird line ' + 'x'.repeat(40)).filter(row => row.kind === 'objective')
  check('rows: explicit newlines stay independent rows (blank line preserved)',
    multiline[0]?.text === 'first' && multiline[1]?.text === '' && multiline[2]?.text.startsWith('third'),
    JSON.stringify(multiline.slice(0, 3).map(row => row.kind === 'objective' ? row.text : '')))
  // 折行实现把 'e' + combining mark 规范化成预组合字符（既有行为），
  // 因此按 NFC 等价比较，而不是逐码点比较。
  const combining = 'e\u0301'.repeat(30)
  const combiningRows = rowsOf(combining).filter(row => row.kind === 'objective')
  check('rows: combining characters are not split or lost',
    combiningRows.map(row => row.kind === 'objective' ? row.text : '').join('').normalize('NFC') ===
      combining.normalize('NFC'))

  // 滚动形态：所有 todo 都进入行模型，不再有预算隐藏/`…N more`。
  const shorts = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, content: 'task ' + i, status: 'pending' }))
  const allFit = rowsOf('goal', { todos: shorts })
  check('rows: every todo becomes a row (no budget lane)',
    allFit.length === 15 && !allFit.some(row => row.kind === 'overflow'), String(allFit.length))
  const mixed = rowsOf('goal', {
    todos: [
      { id: 'a', content: 'A'.repeat(30), status: 'pending' },
      { id: 'b', content: 'B'.repeat(30), status: 'pending' },
      ...shorts,
    ],
  })
  check('rows: a long list renders all items, wrapped rows included, and stays scrollable',
    mixed.length === 19 && mixed.filter(row => row.kind === 'todo').length === 16 &&
      !mixed.some(row => row.kind === 'overflow'), String(mixed.length))
  const folded = rowsOf('goal', { todos: shorts, collapsed: true })
  check('rows: collapsed emits no todo rows',
    !folded.some(row => row.kind === 'todo') && folded.some(row => row.kind === 'header'))

  // 无 goal / 无 todo / blocked。
  const todoOnly = buildGoalPanelRows({
    goal: undefined, todos: shorts as never, showTodoSection: true, collapsed: false,
    contentWidth: content28, todoWidth: 20,
  })
  check('rows: without a goal the list starts at the header (no objective/status rows)',
    todoOnly[0]?.kind === 'header' &&
      !todoOnly.some(row => row.kind === 'objective' || row.kind === 'status'))
  const goalOnly = rowsOf('goal')
  check('rows: without todos there is no header row',
    !goalOnly.some(row => row.kind === 'header'))
  const blocked = rowsOf('goal', { extra: { phase: 'blocked', blockedReason: { message: 'why '.repeat(40) } } })
  const blockedKinds = blocked.map(row => row.kind)
  check('rows: blocked adds a gap plus wrapped reason rows within the blocked width',
    blockedKinds[blockedKinds.indexOf('status') + 1] === 'gap' &&
      blockedKinds.filter(kind => kind === 'blocked').length > 1 &&
      blocked.filter(row => row.kind === 'blocked').every(row => stringWidth(row.text) <= goalBlockedWidth(content28)))

  // 视口公式与 todo 折行 cap。
  check('rows: viewport rows account for the top padding row',
    goalPanelViewportRows(1) === 1 && goalPanelViewportRows(2) === 1 &&
      goalPanelViewportRows(18) === 17 && goalPanelViewportRows(undefined) === Number.POSITIVE_INFINITY)
  const overlong = wrapTodoLines('X'.repeat(100), 20)
  check('rows: an overlong todo caps at 2 rows and ends with an ellipsis',
    overlong.length === 2 && overlong[1]!.endsWith('\u2026'))
}

// Copy the actual painted panel through the same pane fence as Chat. Expected
// text is the source, independent of the row model and its wrap calculations.
for (const width of [28, 62]) {
  for (const blocked of [false, true]) {
    const wrapWidth = width - (blocked ? 5 : 6)
    for (const [name, text] of [
      ['hard wrap', 'a'.repeat(130)],
      ['word wrap', 'read the entire goal and preserve the source words. '.repeat(3).trim()],
      ['exact fill', 'x'.repeat(wrapWidth) + ' next word'],
      ['double space', 'x'.repeat(wrapWidth) + '  next word'],
      ['hard newlines', 'first\n\n  indented ' + 'word '.repeat(20).trim() + '\nlast'],
      ['Unicode', '目标🧑‍💻e\u0301'.repeat(20)],
    ]) {
      const chatColumns = 64
      const columns = chatColumns + 1 + width
      const goal = {
        id: 'copy-goal', revision: 1, phase: blocked ? 'blocked' : 'complete',
        objective: blocked ? 'short objective' : text, roundsStarted: 0, maxGoalRounds: 4,
        ...(blocked ? { blockedReason: { code: 'test', message: text } } : {}),
      }
      const { screen, height } = renderToScreen(
        <TerminalSizeContext.Provider value={{ columns, rows: 80 }}>
          <SidePanelLayout geometry={{ chat: chatColumns, panel: width }} focus="panel"
            side={<GoalTodoPanel channel={{ goal, todos: [] } as never} variant="panel" width={width} />}>
            <Box flexDirection="column">
              {Array.from({ length: 80 }, (_, i) => <Text key={i}>CHAT COPY ANCHOR</Text>)}
            </Box>
          </SidePanelLayout>
        </TerminalSizeContext.Provider>, columns,
      )
      // Objective starts on row 0; blocked reason follows objective, status,
      // and the explicit gap. The final objective row precedes status.
      const panelLines = Array.from({ length: height }, (_, row) =>
        Array.from({ length: width }, (_, col) => cellAt(screen, chatColumns + 1 + col, row)?.char ?? '').join(''))
      const statusRow = panelLines.findIndex(line => line.includes(' · 0/4'))
      const firstRow = blocked ? statusRow + 2 : 0
      const lastRow = blocked ? panelLines.findLastIndex(line => line.trim() !== '') : statusRow - 1
      const picked = selection.createSelectionState()
      selection.startSelection(picked, chatColumns + 2 + (blocked ? 2 : 3), firstRow, screen)
      selection.updateSelection(picked, columns - 1, lastRow)
      const copied = selection.getSelectedText(picked, screen)
      check(`copy: ${width}-col ${blocked ? 'blocked reason' : 'objective'} preserves ${name}`,
        copied === text.normalize('NFC'), JSON.stringify(copied))
      // Prefix exclusions in the sidebar must not erase the sibling pane.
      const chatPick = selection.createSelectionState()
      selection.startSelection(chatPick, 0, firstRow, screen)
      selection.updateSelection(chatPick, 15, firstRow)
      check(`copy: ${width}-col sidebar prefix leaves chat selectable (${blocked}/${name})`,
        selection.getSelectedText(chatPick, screen) === 'CHAT COPY ANCHOR')
    }
  }
}

// --- fake channel -----------------------------------------------------------
const NOW = Date.now()
let todos: Array<{ id: string; content: string; status: string }> = [
  { id: 't1', content: 'finish the probe', status: 'completed' },
  { id: 't2', content: 'write the fix', status: 'in_progress' },
  { id: 't3', content: 'run the gates', status: 'pending' },
]
let channelVersion = 0
const channelListeners = new Set<() => void>()
let working = true
let currentSessionId = 'session-1'
function bumpVersion(): void {
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
function setSessionId(next: string): void {
  currentSessionId = next
  bumpVersion()
}
function setWorking(next: boolean): void {
  working = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
function setTodos(next: typeof todos): void {
  todos = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
// 长行夹具：折行后第二行全为 B（首行全 a），好断言悬挂缩进；overlong 折出
// >2 行，用来锁「cap 到 2 行 + 省略号」。
const LONG_WRAP = 'a'.repeat(30) + 'B'.repeat(20)
const OVERLONG = 'X'.repeat(100)
const BASE_GOAL = { id: 'g1', objective: 'fix the todo panel', phase: 'active', roundsStarted: 1, maxGoalRounds: 8 } as const
let currentGoal: {
  id: string
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: { message: string }
  budget?: { tokensUsed: number; tokenBudget: number | null; timeUsedSeconds: number }
} = { ...BASE_GOAL }
function setGoal(next: typeof currentGoal): void {
  currentGoal = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
const channel = {
  get version() { return channelVersion },
  get sessionId() { return currentSessionId },
  get goal() { return currentGoal },
  get todos() { return todos },
  get working() { return working },
  notifications: [] as Array<{ text: string }>,
  // 运行时契约：侧栏启用面板含 jobs/agents，适配器会读这两个字段
  // （backgroundJobs 摘要行、subagents.filter 名册）——缺了就炸进边界。
  backgroundJobs: [] as unknown[],
  subagents: [] as unknown[],
  notify(text: string) { channel.notifications.push({ text }) },
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}

// --- harness (mirrors verify-jobs-side-panel.tsx) ----------------------------
let exposedFocus = ''
let exposedActive = ''
let exposedChatColumns = 0
let openTodo: (() => void) | undefined

function Harness({ columns = COLS, rows = ROWS }: { columns?: number; rows?: number } = {}): React.ReactNode {
  const sp = useSidePanel({ columns, fullscreen: true, editorOpen: false })
  const [, bump] = React.useState(0)
  exposedFocus = sp.focus
  exposedActive = sp.activePanelId ?? 'none'
  exposedChatColumns = sp.chatColumns
  openTodo = () => sp.openPanel('todo', { focus: true })
  React.useEffect(() => channel.subscribe(() => bump(previous => previous + 1)), [])
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    sp.handleKey(input, key as never)
    bump(previous => previous + 1)
  })
  return (
    <Box flexDirection="row" width={columns} height={rows}>
      <SidePanelLayout geometry={sp.geometry} focus={sp.focus}
        onActivateChat={sp.focusChat} onActivatePanel={sp.focusPanel}
        side={<SidePanelColumn width={sp.panelColumns} controller={sp} channel={channel as never} />}>
        <Text>{'chat-anchor SP split=' + (sp.split ? 1 : 0) + ' focus=' + sp.focus + ' active=' + (sp.activePanelId ?? 'none')}</Text>
      </SidePanelLayout>
    </Box>
  )
}

class FakeStdout extends Writable {
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, readonly columns: number = COLS, readonly rows: number = ROWS) { super(); this.term = term }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

applySidePanelOpen(true)
applySidePanelRatio(0.68)
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()
const app = await render(
  <AlternateScreen mouseTracking={true}>
    <ThemeProvider theme="dark">
      <Harness />
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
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
const findCell = (needle: string): { col: number; row: number } | null => {
  const ls = lines()
  for (let y = 0; y < ls.length; y += 1) {
    const col = ls[y].indexOf(needle)
    if (col >= 0) return { col, row: y }
  }
  return null
}
/** 逐键滚动直到 marker 进入视口（不同面板宽度需要的步数不同）。 */
async function scrollUntil(
  write: (bytes: string) => void,
  read: () => string[],
  needle: string,
  max = 140,
): Promise<boolean> {
  for (let i = 0; i < max; i += 1) {
    if (read().some(line => line.includes(needle))) return true
    write('\x1b[B')
    await sleep(8) // 固定窗:pacing 每键等一帧再读屏
  }
  return read().some(line => line.includes(needle))
}

function clickAt(cell: { col: number; row: number }): void {
  // SGR press/release; motion is button 35, a plain click is button 0.
  const seq = '\x1b[<0;' + (cell.col + 1) + ';' + (cell.row + 1)
  stdin.write(seq + 'M')
  stdin.write(seq + 'm')
}

interface PanelSession {
  lines(): string[]
  stdin: FakeStdin
  app: Awaited<ReturnType<typeof render>>
  term: InstanceType<typeof XTerm>
  close(): Promise<void>
}

/** 独立 mount：28/62 列的真终端几何验证（ratio 走与产品同一份 resolver）。 */
async function mountSession(columns: number, rows: number, ratio: number): Promise<PanelSession> {
  applySidePanelOpen(true)
  applySidePanelRatio(ratio)
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, columns, rows)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Harness columns={columns} rows={rows} />
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
  const read = (): string[] => {
    const buf = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < rows; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(columns, ' '))
    return out
  }
  await settled(() => read().some(l => l.includes('split=1')))
  return {
    lines: read,
    stdin,
    app,
    term,
    async close() { await app.unmount(); term.dispose() },
  }
}

try {
  await settled(() => lines().some(l => l.includes('split=1')))
  check('mount: sidebar split with todo panel active', exposedActive === 'todo', 'active=' + exposedActive)

  // The todo panel default state is EXPANDED: list rows visible.
  const expandedInitially = lines().some(l => l.includes('write the fix'))
  check('initial: todo list rows visible (expanded)', expandedInitially)
  const headerCell = findCell('1/3')
  check('initial: fold header (done/total) on screen', headerCell !== null)

  // --- 1. mouse click on the header collapses; second click expands --------
  check('preclick: focus is chat (click must not need focus)', exposedFocus === 'chat', exposedFocus)
  if (headerCell === null || !expandedInitially) {
    check('click: header toggle works', false, 'header/list not found')
  } else {
    clickAt(headerCell)
    check('click 1: header click collapses the list (pending rows fold away)', await settled(() => !lines().some(l => l.includes('run the gates')) && lines().some(l => l.includes('\u25b8'))))
    const collapsedCell = findCell('1/3')
    check('click 1: collapsed preview header still on screen', collapsedCell !== null)
    // ink 的双击窗口是 500ms（App.tsx MULTI_CLICK_TIMEOUT_MS）：冷却期内
    // 同点位再按会被吃成双击选词而不是 onClick——真实用户单击间隔远大于
    // 此，探针必须等过窗口再发第二次点击。
    await sleep(600) // 固定窗:墙钟 ink 500ms 双击判定窗口本身是被测语义（等冷却到期再单击）
    if (collapsedCell !== null) clickAt(collapsedCell)
    check('click 2: second header click expands again', await settled(() => lines().some(l => l.includes('run the gates'))))
  }

  // --- 2. keyboard: Enter toggles through usePanelInput --------------------
  openTodo?.()
  await settled(() => exposedFocus === 'panel', { timeout: 4000 })
  check('keys: panel focused after openPanel(todo, focus)', exposedFocus === 'panel', exposedFocus)
  await settled(() => lines().some(l => l.includes('write the fix')))
  stdin.write('\r') // ink Enter: input='' + key.return
  check('keys: Enter collapses the expanded list', await settled(() => !lines().some(l => l.includes('run the gates'))))
  stdin.write(' ')
  check('keys: Space expands again', await settled(() => lines().some(l => l.includes('run the gates'))))
  stdin.write('x') // unrelated key must NOT toggle and must be consumed-safe
  await sleep(60) // 固定窗:探针 断言无关键不改变折叠状态——只能等一个观察窗
  check('keys: unrelated key leaves the fold state alone', lines().some(l => l.includes('run the gates')))

  // --- 3. panel wrap: long todo folds onto 2 rows, height unchanged --------
  const ruleRows = (): number[] => {
    const rows: number[] = []
    for (let y = 0; y < ROWS; y += 1) if (lines()[y].includes('\u2500\u2500\u2500\u2500')) rows.push(y)
    return rows
  }
  const rulesBefore = ruleRows()
  check('wrap: panel rules located (baseline geometry)', rulesBefore.length >= 2, JSON.stringify(rulesBefore))
  // hostHeight = ROWS-4 = 18 → 视口 17 行。两条 2 行项 + 12 条单行 = 16 行
  // todo，加上目标/状态/折叠头 3 行超出视口：滚动形态下全部进入行模型，
  // 末条要滚一屏才看得到（旧的 height-4 预算会用 …N more 吞掉）。
  const shorts = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, content: 'short task ' + i, status: 'pending' }))
  setTodos([
    { id: 'L', content: LONG_WRAP, status: 'pending' },
    { id: 'O', content: OVERLONG, status: 'pending' },
    ...shorts,
  ])
  await settled(() => lines().some(l => l.includes('BBBBB')), { timeout: 4000 })
  check('wrap: long todo first line renders (a-run)', lines().some(l => l.includes('aaaaa')))
  // 悬挂缩进：续行在首行树形前缀列上是 5 格空格（前缀 3 + glyph 2），正文与首行对齐。
  const wrapFirstRow = lines().findIndex(l => l.includes('aaaaa'))
  const contLine = lines()[wrapFirstRow + 1]
  const prefixCol = wrapFirstRow >= 0 ? lines()[wrapFirstRow]!.indexOf('\u251c') : -1
  // 整组不变量：续行在树形前缀列上必须以 '│' 开头（竖线与首行连续），
  // 且正文列与首行对齐（'│'+4 格 = 5 格）。
  const contAtPrefix = contLine !== undefined && prefixCol >= 0 ? contLine.slice(prefixCol, prefixCol + 5) : ''
  check('wrap: continuation line hangs with 5-space indent (aligns with first-line text)',
    contAtPrefix === '\u2502    ',
    JSON.stringify(contLine ?? null))
  // 滚动形态：全部 todo 进入行模型，不再有 `…N more` 预算隐藏；视口外的
  // 条目滚一下就能看到（19 行 > 17 行视口）。
  const scrollWheel = (button: number) => '\x1b[<' + button + ';' + (exposedChatColumns + 4) + ';5M'
  check('wrap: the panel renders every todo (no …N more lane)',
    !lines().some(l => l.includes(' more')) && lines().some(l => l.includes('short task 0')),
    lines().find(l => l.includes('more')) ?? 'no-more-line')
  for (let i = 0; i < 6; i += 1) { stdin.write(scrollWheel(65)); await sleep(4) } // 固定窗:pacing 逐格滚轮
  check('wrap: scrolling reaches the last todo in the list',
    await settled(() => lines().some(l => l.includes('short task 11')), { timeout: 4000 }))
  for (let i = 0; i < 6; i += 1) { stdin.write(scrollWheel(64)); await sleep(4) } // 固定窗:pacing 逐格滚轮
  await settled(() => lines().some(l => l.includes('short task 0')))
  // 高度契约（§16.6）：折行只改变可见条数，面板盒子高度（分隔线位置）不变。
  check('wrap: panel height unchanged (rule rows identical)', JSON.stringify(ruleRows()) === JSON.stringify(rulesBefore),
    'before=' + JSON.stringify(rulesBefore) + ' after=' + JSON.stringify(ruleRows()))

  // --- 4. panel wrap cap: >2 lines truncate with an ellipsis on row 2 ------
  setTodos([
    { id: 'O', content: OVERLONG, status: 'pending' },
    { id: 't2', content: 'write the fix', status: 'in_progress' },
  ])
  // 上一段屏幕上本来就有 X 行——必须等到旧列表（shorts）真正退场，否则读到旧帧。
  await settled(() => !lines().some(l => l.includes('short task 0')) && lines().some(l => l.includes('XXXXX')), { timeout: 4000 })
  const xRows = lines().filter(l => l.includes('XXXXX'))
  check('cap: overlong todo occupies exactly 2 rows', xRows.length === 2, String(xRows.length))
  check('cap: second row ends with the ellipsis', xRows[1] !== undefined && xRows[1].trimEnd().endsWith('\u2026'), JSON.stringify(xRows[1] ?? null))
  const xIdx = xRows[1] !== undefined ? xRows[1].indexOf('XXXXX') : -1
  check('cap: second row also carries the tree stem (\u2502 + aligned text)',
    xIdx >= 5 && xRows[1]!.slice(xIdx - 5, xIdx) === '\u2502    ')
  check('cap: short neighbor still visible after it (budget left for 1-line rows)', lines().some(l => l.includes('write the fix')))
  check('wrap-cap: panel height still unchanged', JSON.stringify(ruleRows()) === JSON.stringify(rulesBefore))

  // --- 4b. LAST item wrapped: its continuation must NOT carry the stem -----
  // └─ 表示树到此为止——末条折行续行下面没有兄弟，'│' 是突兀的（用户实
  // 测）；非末条（cap 用例已锁）续行必须仍是 '│'+4 格。
  setTodos([
    { id: 't2', content: 'write the fix', status: 'in_progress' },
    { id: 'TL', content: 'LASTMARK-' + 'z'.repeat(60), status: 'pending' },
  ])
  await settled(() => lines().some(l => l.includes('LASTMARK-')), { timeout: 4000 })
  const lastRow = lines().findIndex(l => l.includes('LASTMARK-'))
  const lastPrefixCol = lastRow >= 0 ? lines()[lastRow]!.indexOf('\u2514') : -1
  const lastCont = lastRow >= 0 ? lines()[lastRow + 1] : undefined
  const lastAtPrefix = lastCont !== undefined && lastPrefixCol >= 0 ? lastCont.slice(lastPrefixCol, lastPrefixCol + 5) : ''
  check('last-wrap: last item first line closes with \u2514', lastPrefixCol >= 0)
  check('last-wrap: continuation column is blank (no stray stem)', lastAtPrefix === '     ', JSON.stringify(lastAtPrefix))
  check('last-wrap: continuation text still aligned with first-line text',
    lastCont !== undefined && lastCont.slice(lastPrefixCol + 5, lastPrefixCol + 7) === 'zz')

  // --- 5. idle + all completed: the expanded list must NOT be empty --------
  // 用户实测：折叠头 ✓ 9/9，点开后一条都没有。根因是 default 形态的
  // 「idle 自动隐藏完成行」语义泄漏进侧栏（过滤光 + showTodoSection 双层）。
  setWorking(false)
  const nine = Array.from({ length: 9 }, (_, i) =>
    i % 3 === 0
      ? { id: 'n' + i, content: 'long finished task ' + i + ' with plenty of wrapping text to fold onto a second row', status: 'completed' }
      : { id: 'n' + i, content: 'finished task ' + i, status: 'completed' })
  setTodos(nine)
  await settled(() => lines().some(l => l.includes('9/9')) && lines().some(l => l.includes('finished task 1')), { timeout: 4000 })
  check('idle-9: header still counts 9/9', lines().some(l => l.includes('9/9')))
  const idleRows = lines().filter(l => l.includes('finished task')).length
  check('idle-9: expanded list shows the completed rows (not empty)', idleRows >= 9, String(idleRows))
  check('idle-9: first and last items both on screen', lines().some(l => l.includes('finished task 0')) && lines().some(l => l.includes('finished task 8')))
  check('idle-9: completed rows render dimmed but present (glyph ✓)', lines().some(l => l.includes('\u2713 finished task 1')))
  // 点开/收起往返仍然工作（折叠头 → 预览行；再展开 → 9 行回来）。
  const idleHeader = findCell('9/9')
  await sleep(600) // 固定窗:墙钟 ink 500ms 双击判定窗口（距上次点击已远，此处仅对齐用例节奏）
  if (idleHeader !== null) clickAt(idleHeader)
  check('idle-9: collapse still folds the list', await settled(() => !lines().some(l => l.includes('finished task 1')) && lines().some(l => l.includes('\u25b8'))))
  await sleep(600) // 固定窗:墙钟 双击冷却到期后再单击展开
  const idleCollapsed = findCell('9/9')
  if (idleCollapsed !== null) clickAt(idleCollapsed)
  check('idle-9: re-expand brings the 9 rows back (list never empty)', await settled(() => lines().filter(l => l.includes('finished task')).length >= 9))
  setWorking(true)

  // --- 6. long goal: panel wraps the objective; status owns its own row -----
  // 面板宽 = 110 − 74 − 1 = 35（内容 33，目标折行宽约 29）。
  const GOAL_HEAD = 'GOAL_HEAD-'
  const GOAL_TAIL = '-GOAL_TAIL'
  const mediumObjective = GOAL_HEAD + 'medium objective line that still needs ' + 'm'.repeat(70)
  setGoal({ ...currentGoal, objective: mediumObjective })
  await settled(() => lines().some(l => l.includes(GOAL_HEAD)), { timeout: 4000 })
  const headRow = lines().find(l => l.includes(GOAL_HEAD)) ?? ''
  check('goal-wrap: status badge is NOT on the objective row',
    !headRow.includes('active \u00b7'), JSON.stringify(headRow))
  const statusRows = lines().filter(l => l.includes('\u25cf active'))
  check('goal-wrap: status badge owns a separate row',
    statusRows.length > 0 && statusRows.every(l => !l.includes(GOAL_HEAD)), JSON.stringify(statusRows))
  check('goal-wrap: objective stays inside the panel column',
    lines().every(l => !l.includes(GOAL_HEAD) || l.indexOf(GOAL_HEAD) >= exposedChatColumns))

  // 视口由真实折行数决定：medium 目标（~5 行）+ 状态 + 折叠头之后只剩
  // ~10 行给 todo，20 条单行 todo 的末条必须滚动才看得到（旧实现按
  // height-4 预算用 …N more 吞掉多余条目）。
  const budgetTodos = Array.from({ length: 20 }, (_, i) => ({
    id: 'b' + i, content: 'budget task ' + i, status: 'pending',
  }))
  setTodos(budgetTodos)
  await settled(() => lines().some(l => l.includes('budget task 0')), { timeout: 4000 })
  check('goal-budget: all todos are rendered (no …N more) and the list scrolls',
    lines().some(l => l.includes('budget task 0')) && !lines().some(l => l.includes(' more')))
  for (let i = 0; i < 25; i += 1) { stdin.write(scrollWheel(65)); await sleep(4) } // 固定窗:pacing 逐格滚轮
  check('goal-budget: the last todo is reachable by scrolling',
    await settled(() => lines().some(l => l.includes('budget task 19')), { timeout: 4000 }))
  for (let i = 0; i < 25; i += 1) { stdin.write(scrollWheel(64)); await sleep(4) } // 固定窗:pacing 逐格滚轮
  await settled(() => lines().some(l => l.includes('budget task 0')), { timeout: 4000 })

  // --- 7. long goal: scroll by keys / wheel; reset on goal switch ----------
  const longObjective = GOAL_HEAD + 'wrap this objective across the panel width. '.repeat(40) + GOAL_TAIL
  setGoal({ ...currentGoal, objective: longObjective })
  await settled(() => lines().some(l => l.includes(GOAL_HEAD)), { timeout: 4000 })
  check('goal-scroll: the tail starts off-screen', !lines().some(l => l.includes(GOAL_TAIL)))
  openTodo?.()
  await settled(() => exposedFocus === 'panel', { timeout: 4000 })
  // 固定窗:pacing 逐键写入：一次 chunk 里的多个 ESC 序列会被解析层合并。
  check('goal-scroll: Down reveals the goal tail',
    await scrollUntil(bytes => stdin.write(bytes), lines, GOAL_TAIL))
  check('goal-scroll: continuing past the tail reaches the todo section',
    await scrollUntil(bytes => stdin.write(bytes), lines, 'budget task 0'))
  // 固定窗:pacing 同上：逐键写入。
  for (let i = 0; i < 80; i += 1) { stdin.write('\x1b[A'); await sleep(4) }
  check('goal-scroll: Up returns to the objective head',
    await settled(() => lines().some(l => l.includes(GOAL_HEAD)), { timeout: 4000 }))

  // 滚轮：鼠标位于面板内容上，一格滚轮 = 一行。第一行滚出即证明位移。
  const wheelCol = exposedChatColumns + 3
  const wheelSeq = (button: number) => '\x1b[<' + button + ';' + (wheelCol + 1) + ';5M'
  stdin.write(wheelSeq(65))
  check('goal-wheel: wheel down scrolls one row (head leaves the viewport)',
    await settled(() => !lines().some(l => l.includes(GOAL_HEAD)), { timeout: 4000 }))
  stdin.write(wheelSeq(64))
  check('goal-wheel: wheel up scrolls back to the head',
    await settled(() => lines().some(l => l.includes(GOAL_HEAD)), { timeout: 4000 }))

  // 切换 goal id 复位到顶部；同 id 的 revision 更新保留滚动位置。
  // 固定窗:pacing 逐键写入。
  for (let i = 0; i < 60; i += 1) { stdin.write('\x1b[B'); await sleep(4) }
  await settled(() => lines().some(l => l.includes(GOAL_TAIL)), { timeout: 4000 })
  setGoal({ ...currentGoal, objective: longObjective + ' REV' })
  await sleep(120) // 固定窗:探针 同 id 更新不触发复位——等两帧确认位置未跳
  check('goal-scroll: same-id revision keeps the scroll position',
    !lines().some(l => l.includes(GOAL_HEAD)))
  setGoal({ ...currentGoal, id: 'g2' })
  check('goal-scroll: a new goal id resets to the head',
    await settled(() => lines().some(l => l.includes(GOAL_HEAD)) && !lines().some(l => l.includes(GOAL_TAIL)), { timeout: 4000 }))
  // 切换会话同样复位（sessionId 变化 + version bump 触发重渲染）。
  for (let i = 0; i < 60; i += 1) { stdin.write('\x1b[B'); await sleep(4) } // 固定窗:pacing 逐键写入
  await settled(() => lines().some(l => l.includes(GOAL_TAIL)), { timeout: 4000 })
  setSessionId('session-2')
  check('goal-scroll: switching the session resets to the head',
    await settled(() => lines().some(l => l.includes(GOAL_HEAD)) && !lines().some(l => l.includes(GOAL_TAIL)), { timeout: 4000 }))

  // 折叠/展开在滚动路径上仍然工作：换回中等目标，头部与 todo 同屏。
  // 折叠预览会复述第一条 todo，所以用第 5 条判断列表是否收起了。
  const foldObjective = GOAL_HEAD + 'fold objective ' + 'f'.repeat(90)
  setGoal({ ...currentGoal, id: 'g3', objective: foldObjective })
  await settled(() => lines().some(l => l.includes(GOAL_HEAD)) && lines().some(l => l.includes('budget task 5')), { timeout: 4000 })
  // 滚动/换 goal 之后鼠标仍命中原行（不用 ScrollBox 的理由）。
  await sleep(600) // 固定窗:墙钟 ink 500ms 双击判定窗口
  const scrolledHeader = findCell('0/20')
  if (scrolledHeader !== null) clickAt(scrolledHeader)
  else stdin.write('\r')
  check('goal-collapse: the fold header still folds the todo list after scrolling',
    await settled(() => !lines().some(l => l.includes('budget task 5')) && lines().some(l => l.includes('\u25b8')), { timeout: 4000 }))
  stdin.write(' ')
  check('goal-collapse: Space expands again',
    await settled(() => lines().some(l => l.includes('budget task 5')), { timeout: 4000 }))

  // 宿主键未被抢占：←/→ 仍切面板，Esc 仍回聊天。
  stdin.write('\x1b[C')
  check('goal-keys: Right still cycles the panel', await settled(() => exposedActive !== 'todo', { timeout: 4000 }), exposedActive)
  stdin.write('\x1b[D')
  check('goal-keys: Left cycles back to todo', await settled(() => exposedActive === 'todo', { timeout: 4000 }), exposedActive)
  stdin.write('\x1b')
  check('goal-keys: Esc still returns focus to chat', await settled(() => exposedFocus === 'chat', { timeout: 4000 }), exposedFocus)
  const headVisibleBeforeChatScroll = lines().some(l => l.includes(GOAL_HEAD))
  for (let i = 0; i < 5; i += 1) stdin.write('\x1b[B')
  await sleep(120) // 固定窗:探针 焦点在聊天时下键不进面板——等两帧确认无位移
  check('goal-keys: chat focus keeps Down out of the panel',
    lines().some(l => l.includes(GOAL_HEAD)) === headVisibleBeforeChatScroll)

  // Real SGR drag: selection ownership, decoration exclusions and wrap joins
  // must work together in the mounted split, not only renderToScreen.
  const copyObjective = 'x'.repeat(29) + ' next word\n目标🧑‍💻e\u0301保留原文'
  setGoal({ ...currentGoal, id: 'copy-drag', objective: copyObjective })
  setTodos([])
  await settled(() => lines().some(l => l.includes('xxxxxxxx')) && lines().some(l => l.includes('保留原文')))
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as {
    selection: import('../src/ink/selection.js').SelectionState
    frontFrame: { screen: import('../src/ink/screen.js').Screen }
  }
  const firstCopyRow = lines().findIndex(l => l.includes('xxxxxxxx'))
  const lastCopyRow = lines().findIndex(l => l.includes('保留原文'))
  const firstCopyCol = exposedChatColumns + 1 + 1 + 3 // divider, padding, glyph
  stdin.write(`\x1b[<0;${firstCopyCol + 1};${firstCopyRow + 1}M`)
  stdin.write(`\x1b[<32;${COLS};${lastCopyRow + 1}M`)
  stdin.write(`\x1b[<0;${COLS};${lastCopyRow + 1}m`)
  check('copy: a real panel drag preserves the goal source without chat or decoration',
    await settled(() => selection.getSelectedText(ink.selection, ink.frontFrame.screen) === copyObjective.normalize('NFC')),
    JSON.stringify(selection.getSelectedText(ink.selection, ink.frontFrame.screen)))
  selection.clearSelection(ink.selection)

  setGoal({ ...currentGoal, objective: GOAL_HEAD + 'long default objective ' + 'd'.repeat(240) + GOAL_TAIL })
  // control 段的夹具：短列表 + 超长行（default 形态不折行的对照物）。
  setTodos([
    { id: 't2', content: 'write the fix', status: 'in_progress' },
    { id: 't3', content: 'run the gates', status: 'pending' },
    { id: 'O', content: OVERLONG, status: 'pending' },
  ])

  await app.unmount()
  term.dispose()

  // --- 5. control: default (chat-page) variant untouched -------------------
  const term2 = new XTerm({ cols: 60, rows: 12, scrollback: 0, allowProposedApi: true })
  const stdout2 = new FakeStdout(term2, 60, 12)
  const stdin2 = new FakeStdin()
  const app2 = await render(
    <AlternateScreen>
      <ThemeProvider theme="dark">
        <GoalTodoPanel channel={channel as never} variant="default" />
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: stdout2 as unknown as NodeJS.WriteStream,
      stdin: stdin2 as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  try {
    await settled(() => {
      for (let y = 0; y < 12; y += 1) if ((term2.buffer.active.getLine(y)?.translateToString(false) ?? '').includes('write the fix')) return true
      return false
    })
    const ls2: string[] = []
    for (let y = 0; y < 12; y += 1) ls2.push(term2.buffer.active.getLine(y)?.translateToString(false) ?? '')
    check('control: default variant renders expanded list', ls2.some(l => l.includes('write the fix')))
    check('control: default variant keeps its fold hint line', ls2.some(l => l.includes('to fold')), ls2.find(l => l.includes('fold')) ?? '')
    check('control: default variant header is expanded glyph', ls2.some(l => l.includes('\u25be')))
    // 整屏形态不折行：长 todo 仍是单行 truncate——没有任何续行。
    const xRows2 = ls2.filter(l => l.includes('XXXXX'))
    check('control: default variant does NOT wrap the long todo (single truncated row)',
      xRows2.length === 1 && !ls2.some(l => l.includes('BBBBB')), String(xRows2.length))
    // default 形态的长目标仍是单行 truncate + 状态同排（panel 的改动不外溢）。
    const defaultGoalRows = ls2.filter(l => l.includes(GOAL_HEAD))
    check('control: default keeps the long goal on one truncated row',
      defaultGoalRows.length === 1 && !ls2.some(l => l.includes(GOAL_TAIL)), String(defaultGoalRows.length))
    check('control: default keeps the status badge on the goal row',
      defaultGoalRows[0]?.includes('active \u00b7') === true, defaultGoalRows[0] ?? '')
  } finally {
    await app2.unmount()
    term2.dispose()
  }

  // --- 8. 28 / 62 columns: real geometry, wrap, status row, no bleed --------
  const wideObjective = GOAL_HEAD + 'wrap across the panel width. '.repeat(40) + GOAL_TAIL
  setGoal({ ...BASE_GOAL, objective: wideObjective })
  setTodos(Array.from({ length: 20 }, (_, i) => ({ id: 'w' + i, content: 'wide task ' + i, status: 'pending' })))
  for (const [columns, ratio, expectedPanel] of [[93, 0.69, 28], [127, 0.5, 62]] as const) {
    const session = await mountSession(columns, 22, ratio)
    try {
      const ls = session.lines()
      const panelWidth = columns - exposedChatColumns - 1
      check(`cols ${columns}: split yields a ${expectedPanel}-column panel`,
        panelWidth === expectedPanel, String(panelWidth))
      check(`cols ${columns}: long goal head is on screen, tail needs scrolling`,
        ls.some(l => l.includes(GOAL_HEAD)) && !ls.some(l => l.includes(GOAL_TAIL)))
      const head = ls.find(l => l.includes(GOAL_HEAD)) ?? ''
      check(`cols ${columns}: status badge does not share the objective row`,
        !head.includes('active \u00b7'), JSON.stringify(head.trimEnd()))
      check(`cols ${columns}: objective never bleeds into the chat column`,
        ls.every(l => !l.includes(GOAL_HEAD) || l.indexOf(GOAL_HEAD) >= exposedChatColumns))
      check(`cols ${columns}: the chat anchor is intact`, ls.some(l => l.includes('chat-anchor')))
      // 高度不足时 ↓ 仍能滚到尾部（键路由与面板宽度无关）。
      openTodo?.()
      await settled(() => exposedFocus === 'panel', { timeout: 4000 })
      check(`cols ${columns}: Down reaches the goal tail`,
        await scrollUntil(bytes => session.stdin.write(bytes), session.lines, GOAL_TAIL),
        JSON.stringify(session.lines().slice(0, 5).map(l => l.trimEnd())))
    } finally {
      await session.close()
    }
  }

  // --- 9. status row truncation: stop at the 28-col content edge ------------
  // token budget 让状态行长于 28 列面板的内容宽（26）；截断必须停在内容边缘，
  // 面板最后一格（右 padding）保持空白。`width="100%"` 会按父盒 padding-box
  // 解析、正好多占这一格并把省略号裁掉，所以这格是独立判据。
  const STATUS_PANEL = 28
  const STATUS_CHAT = 93 - STATUS_PANEL - 1
  setGoal({
    ...BASE_GOAL,
    objective: 'short objective',
    budget: { tokensUsed: 12345, tokenBudget: 50000, timeUsedSeconds: 125 },
  })
  setTodos([])
  {
    const session = await mountSession(93, 22, 0.69)
    try {
      const ls = session.lines()
      const panelCols = 93 - exposedChatColumns - 1
      const panelStart = exposedChatColumns + 1
      const statusLine = ls.find(l => l.includes('\u25cf active \u00b7')) ?? ''
      check('status: 28-col panel geometry holds', panelCols === STATUS_PANEL && exposedChatColumns === STATUS_CHAT,
        exposedChatColumns + '/' + panelCols)
      check('status: long badge truncates with an ellipsis at the content edge',
        statusLine[panelStart + panelCols - 2] === '\u2026',
        JSON.stringify(statusLine.slice(panelStart, panelStart + panelCols)))
      check('status: the right padding column stays blank',
        statusLine[panelStart + panelCols - 1] === ' ',
        JSON.stringify(statusLine.slice(panelStart + panelCols - 3, panelStart + panelCols)))
    } finally {
      await session.close()
    }
  }
} finally {
  try { await app.unmount() } catch { /* already unmounted */ }
  try { term.dispose() } catch { /* already disposed */ }
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: todo side panel all checks passed.')
process.exit(0)
