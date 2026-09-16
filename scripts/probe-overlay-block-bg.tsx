/**
 * probe-overlay-block-bg — fullscreen 下逐单元格扫描非默认背景，报告每行
 * 的背景色块（颜色、范围、面积），用于排查浮层把整块区域涂亮的回归。
 * 依次测量：基线 → / 补全菜单 → /model picker → 关闭。
 *
 * 运行：node --import tsx/esm scripts/probe-overlay-block-bg.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { completeCommands, LOCAL_COMMANDS }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

const COLS = 100
const ROWS = 30
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
  return { stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: new FakeStdin() }
}

const listeners = new Set<() => void>()
const channel: any = {
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
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([{ id: 'm1', label: 'model one' }, { id: 'm2', label: 'model two' }, { id: 'm3', label: 'model three' }]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0')
}

/** 逐单元格扫非默认背景，输出每行的背景块摘要。 */
function scanBg(label: string, term: InstanceType<typeof XTerm>) {
  const buf = term.buffer.active
  const rowsWithBg: string[] = []
  let totalCells = 0
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    let runStart = -1
    let runColor = -1
    const runs: string[] = []
    const flush = (end: number) => {
      if (runStart >= 0 && runColor >= 0) {
        const width = end - runStart
        if (width >= 3) runs.push('cols ' + runStart + '-' + (end - 1) + ' ' + hex(runColor) + ' (w=' + width + ')')
        totalCells += width
      }
      // runColor must reset too: a same-color block split by default cells
      // would otherwise never start a new run (c === runColor keeps
      // runStart at -1) and drop out of both the run list and totalCells.
      runStart = -1
      runColor = -1
    }
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)
      if (!cell) continue
      if (cell.isBgDefault() || cell.isBgPalette()) {
        flush(x)
      } else {
        const c = cell.getBgColor()
        if (c !== runColor) { flush(x); runStart = x; runColor = c }
      }
    }
    flush(COLS)
    if (runs.length > 0) {
      const text = (line.translateToString(true) ?? '').trim().slice(0, 42)
      rowsWithBg.push('  行' + String(y).padStart(2) + ' | ' + runs.join(' + ') + '  「' + text + '」')
    }
  }
  console.log('=== ' + label + '：非默认背景单元格 ' + totalCells + ' 个（' + rowsWithBg.length + ' 行）===')
  for (const r of rowsWithBg) console.log(r)
  console.log('')
}

const term = makeTerm()
const s = makeStreams(term)
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: s.stdout as any, stdin: s.stdin as any, stderr: s.stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

scanBg('基线（无面板）', term)

// 1) / 补全菜单
s.stdin.write('/')
await sleep(400)
scanBg('输入 / 后（命令补全菜单）', term)

// 关闭
s.stdin.write('\x1b')
await sleep(300)
scanBg('Esc 关闭后', term)

// 2) /model picker
s.stdin.write('/model')
await sleep(300)
s.stdin.write('\r')
await sleep(500)
scanBg('/model picker', term)

s.stdin.write('\x1b')
await sleep(300)
scanBg('Esc 关闭后 2', term)

await inst.unmount()
