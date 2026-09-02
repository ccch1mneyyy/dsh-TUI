/**
 * Windows Terminal fullscreen regression: a long User bubble is selected
 * while wheel scrolling. Selection overlays mutate the previous screen; that
 * contaminated frame must never feed the DECSTBM hardware-scroll fast path.
 *
 * Two paths start from the same real Chat tree and scroll trajectory:
 *   A. hold a text selection over the long User bubble while wheeling;
 *   B. wheel without a selection (golden control).
 *
 * Plain-text terminal output must remain coherent/equivalent, and path A must
 * emit no DECSTBM while the selection is alive. Windows Terminal enables DEC
 * 2026 through WT_SESSION, matching the reported environment.
 *
 * Run: node --import tsx/esm scripts/repro-user-drag-wheel-render.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.WT_SESSION = 'headless-windows-terminal-probe'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])
const { default: instances } = await import('../src/ink/instances.js')
const { stringWidth } = await import('../src/ink/stringWidth.js')
const { sleep, settled, viewportLines } = termTest

const COLS = 96
const ROWS = 34
const TARGET_MARKERS = Array.from({ length: 10 }, (_, i) =>
  `USR_DRAG_${String(i).padStart(2, '0')}`,
)

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

function makeRows(): any[] {
  const rows: any[] = []
  let id = 1
  for (let turn = 0; turn < 24; turn++) {
    const userText = turn === 12
      ? TARGET_MARKERS.map((marker, line) =>
          `${marker} 长用户消息第 ${line + 1} 行：这里包含足够多的文字来形成带背景色的多行 User 气泡，并用于检查滚轮拖选后的顺序与重复。`,
        ).join('\n')
      : `历史用户消息 ${turn}：请检查模块 ${turn} 的行为和边界条件。`
    rows.push({ id: id++, kind: 'user', text: userText, time: 1_700_000_000_000 + turn * 2000 })
    rows.push({
      id: id++,
      kind: 'assistant',
      text: `助手回复 ${turn}：${'分析结果与建议。'.repeat(9)}`,
      time: 1_700_000_000_800 + turn * 2000,
    })
  }
  return rows
}

function makeChannel(rows: any[]) {
  const listeners = new Set<() => void>()
  return {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'selection-wheel-probe',
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
    subagents: [],
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
  } as any
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

function screenLines(term: InstanceType<typeof XTerm>): string[] {
  return viewportLines(term, ROWS).map((line: string) => line.replace(/\s+$/, ''))
}

function wheel(stdin: FakeStdin, direction: 'up' | 'down', ticks: number): void {
  const button = direction === 'up' ? 64 : 65
  for (let i = 0; i < ticks; i++) stdin.write(`\x1b[<${button};48;16M`)
}

function markerLocations(lines: string[]): Array<{ marker: string; row: number }> {
  const found: Array<{ marker: string; row: number }> = []
  for (const marker of TARGET_MARKERS) {
    for (let row = 0; row < lines.length; row++) {
      if (lines[row]!.includes(marker)) found.push({ marker, row })
    }
  }
  return found
}

function checkCoherent(tag: string, lines: string[]): void {
  for (const marker of TARGET_MARKERS) {
    const rows = lines.flatMap((line, row) => line.includes(marker) ? [row] : [])
    check(`${tag}: ${marker} 至多出现一次`, rows.length <= 1, `rows=${rows.join(',')}`)
  }
  const found = markerLocations(lines)
  const byRow = [...found].sort((a, b) => a.row - b.row)
  const sourceIndices = byRow.map(({ marker }) => TARGET_MARKERS.indexOf(marker))
  const ordered = sourceIndices.every((value, index) => index === 0 || value > sourceIndices[index - 1]!)
  check(`${tag}: User marker 顺序单调`, ordered, byRow.map(v => `${v.marker}@${v.row}`).join(' '))
}

async function runScenario(withSelection: boolean, seekTicks?: number): Promise<{
  lines: string[]
  seekTicks: number
  activeDecstbm: number
  selectionBeforeWheel: { anchor: { col: number; row: number } | null; focus: { col: number; row: number } | null }
  selectionAfterWheel: { anchor: { col: number; row: number } | null; focus: { col: number; row: number } | null }
}> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      const text = String(chunk)
      writes.push(text)
      term.write(text, callback)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    override _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const tree = (
    <AlternateScreen>
      <Chat channel={makeChannel(makeRows())} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>
  )
  const instance = await render(tree, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new FakeStderr() as any,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(process.stdout, instances.get(stdout)!)
  instance.rerender(tree)
  await sleep(800)

  let usedSeekTicks = 0
  if (seekTicks === undefined) {
    while (usedSeekTicks < 100 && !screenLines(term).some(line => line.includes(TARGET_MARKERS[4]!))) {
      wheel(stdin, 'up', 1)
      usedSeekTicks++
      await sleep(18)
    }
  } else {
    usedSeekTicks = seekTicks
    for (let i = 0; i < seekTicks; i++) {
      wheel(stdin, 'up', 1)
      await sleep(18)
    }
  }
  await settled(() => screenLines(term).some(line => line.includes(TARGET_MARKERS[4]!)))
  await sleep(250)

  const before = screenLines(term)
  const markerRow = before.findIndex(line => line.includes(TARGET_MARKERS[4]!))
  if (markerRow < 0) throw new Error('target marker did not enter the viewport')
  const markerLine = before[markerRow]!
  const markerChar = markerLine.indexOf(TARGET_MARKERS[4]!)
  const markerCol = stringWidth(markerLine.slice(0, markerChar))

  writes.length = 0
  if (withSelection) {
    stdin.write(`\x1b[<0;${markerCol + 2};${markerRow + 1}M`)
    await sleep(40)
    const focusRow = Math.min(ROWS - 6, markerRow + 2)
    stdin.write(`\x1b[<32;${Math.min(COLS - 2, markerCol + 28)};${focusRow + 1}M`)
    await sleep(70)
  }

  const beforeWheelState = instances.get(process.stdout)?.selection
  const selectionBeforeWheel = {
    anchor: beforeWheelState?.anchor ? { ...beforeWheelState.anchor } : null,
    focus: beforeWheelState?.focus ? { ...beforeWheelState.focus } : null,
  }

  wheel(stdin, 'up', 7)
  await sleep(180)
  const afterWheelState = instances.get(process.stdout)?.selection
  const selectionAfterWheel = {
    anchor: afterWheelState?.anchor ? { ...afterWheelState.anchor } : null,
    focus: afterWheelState?.focus ? { ...afterWheelState.focus } : null,
  }
  if (withSelection) {
    stdin.write(`\x1b[<32;${Math.min(COLS - 2, markerCol + 34)};${Math.min(ROWS - 6, markerRow + 3) + 1}M`)
  }
  wheel(stdin, 'down', 4)
  await sleep(220)

  const activeRaw = writes.join('')
  const activeDecstbm = (activeRaw.match(/\x1b\[\d+;\d+r/g) ?? []).length
  if (withSelection) {
    stdin.write(`\x1b[<0;${Math.min(COLS - 2, markerCol + 34)};${Math.min(ROWS - 6, markerRow + 3) + 1}m`)
  }
  await sleep(700)

  const lines = screenLines(term)
  await instance.unmount()
  instances.delete(process.stdout)
  term.dispose()
  return { lines, seekTicks: usedSeekTicks, activeDecstbm, selectionBeforeWheel, selectionAfterWheel }
}

const selected = await runScenario(true)
const control = await runScenario(false, selected.seekTicks)
check(
  '拖动选区时滚轮同时移动 anchor/focus',
  selected.selectionBeforeWheel.anchor !== null && selected.selectionAfterWheel.anchor !== null &&
    selected.selectionBeforeWheel.focus !== null && selected.selectionAfterWheel.focus !== null &&
    selected.selectionBeforeWheel.anchor.row !== selected.selectionAfterWheel.anchor.row &&
    selected.selectionBeforeWheel.focus.row !== selected.selectionAfterWheel.focus.row,
  `before=${JSON.stringify(selected.selectionBeforeWheel)} after=${JSON.stringify(selected.selectionAfterWheel)}`,
)

checkCoherent('拖选+滚轮', selected.lines)
checkCoherent('无选区对照', control.lines)

const normalize = (line: string): string => line.replace(/\d+(?:\.\d+)?/g, '#')
const visualDiffs: string[] = []
for (let row = 0; row < ROWS; row++) {
  if (normalize(selected.lines[row] ?? '') !== normalize(control.lines[row] ?? '')) {
    visualDiffs.push(`row ${row}: A|${selected.lines[row] ?? ''}\n        B|${control.lines[row] ?? ''}`)
  }
}
check('拖选路径与无选区路径最终纯文本画面一致', visualDiffs.length === 0, `${visualDiffs.length} rows differ`)
if (visualDiffs.length > 0) console.log(visualDiffs.slice(0, 12).join('\n'))

check(
  '无选区滚轮仍保留 DECSTBM 快路径',
  control.activeDecstbm > 0,
  `DECSTBM=${control.activeDecstbm}`,
)
check(
  '选区存活期间禁止 DECSTBM 硬件滚动',
  selected.activeDecstbm === 0,
  `DECSTBM=${selected.activeDecstbm}`,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
