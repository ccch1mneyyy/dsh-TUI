/**
 * Side-panel mouse regression: the bar is the one place where a click
 * switches WHAT the whole right column shows, so it must be clickable, must
 * say so on hover, and the ⤢ fullscreen affordance must appear only for
 * panels that actually have a fullscreen form (capabilities.fullscreen).
 *
 * Locked behavior:
 *  a. the active title stays centered while inactive panels appear as dots;
 *  b. dot hover reveals the panel title, and clicking its hit area selects it;
 *  c. the edge arrows wrap through the panel order and ⤢ appears by capability;
 *  d. ⤢ calls the host with the active panel id;
 *  e. clicking the chat column returns focus to chat.
 *
 * Run: node --import tsx/esm scripts/verify-side-panel-mouse.tsx
 */
export {}

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, { TooltipLayer }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelPanels, applySidePanelRatio } = prefs
const { settled, viewportLines } = termTest

const COLS = 120
const ROWS = 20

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

/** Host-side record of ⤢ clicks (mirrors Chat's openPanelFullscreen). */
let expanded: string[] = []

const channelStub: unknown = {
  version: 0, rows: [], status: 'idle', working: false, goal: undefined, todos: [], subagents: [],
  // jobs 摘要（length）/info 读数（notifications）/workspace 路径（displayCwd）
  backgroundJobs: [],
  notifications: [],
  displayCwd: '/tmp/demo',
  cwd: '/tmp/demo',
  // info 行读数经 status 助手派生（modeDisplayName 读 mode.label 等）——
  // 字段集照 verify-side-panel-registry 的桩（那里踩过同样的坑）。
  mode: { plan: false },
  sessionTitle: 'mouse',
  sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab',
  agentId: 'mouse-agent',
  gitBranch: 'main',
  model: 'deepseek-chat-v4',
  reasoningEffort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  listWorkspaceRegistry: () => Promise.resolve([]),
  subscribe() { return () => {} },
  notify() {},
}

function Harness({ columns = COLS }: { readonly columns?: number } = {}): React.ReactNode {
  const sp = useSidePanel({ columns, fullscreen: true, editorOpen: false })
  // Mouse/keys only reach the tree while stdin has a readable listener the
  // ink App owns; MessageList-free fixtures must keep one alive.
  useInput(() => {}, { isActive: true })
  return (
    <SidePanelLayout
      geometry={sp.geometry}
      focus={sp.focus}
      onActivateChat={sp.focusChat}
      onActivatePanel={sp.focusPanel}
      side={
        <SidePanelColumn
          width={sp.panelColumns}
          controller={sp}
          channel={channelStub as never}
          onExpand={(id: string) => { expanded = [...expanded, id] }}
        />
      }
    >
      <Box flexDirection="column">
        <Text>{'chat-body'}</Text>
      </Box>
    </SidePanelLayout>
  )
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, cols?: number, rows?: number) {
    super()
    this.term = term
    if (cols !== undefined) this.columns = cols
    if (rows !== undefined) this.rows = rows
  }
  _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean) { this.isRaw = next; return this }
  setEncoding() { return this }
  ref() { return this }
  unref() { return this }
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()

const lines = (): string[] => viewportLines(term, ROWS)
const has = (s: string): boolean => lines().some(line => line.includes(s))
const findText = (s: string): { col: number; row: number } | null => {
  const view = lines()
  for (let row = 0; row < view.length; row++) {
    const col = view[row]!.indexOf(s)
    if (col >= 0) return { col, row }
  }
  return null
}
const boldAt = (col: number, row: number): boolean => {
  const buf = term.buffer.active
  return buf.getLine(buf.baseY + row)?.getCell(col)?.isBold() ?? false
}
// SGR 1-indexed。无按键移动 = 35（32 是「按住左键拖动」，别混）；
// press(0)/release(0) = 点击。
const motion = (c: number, r: number) => stdin.write('\x1b[<35;' + (c + 1) + ';' + (r + 1) + 'M')
const press = (c: number, r: number) => stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'M')
const release = (c: number, r: number) => stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'm')
const click = (c: number, r: number) => { press(c, r); release(c, r) }

applySidePanelRatio(0.68)
applySidePanelPanels('todo,jobs,agents')
applySidePanelOpen(true)

const app = await render(
  <AlternateScreen>
    <>
      <Harness />
      <TooltipLayer />
    </>
  </AlternateScreen>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

try {
  check('a boot: active title is centered on Todo', await settled(() => has('Todo'), { timeoutMs: 4000 }))
  check('a boot: inactive panels use carousel dots', (lines()[0]?.match(/[○●]/g) ?? []).length === 2, lines()[0]?.trim())
  check('a boot: no ⤢ for a panel without a fullscreen form', !has('⤢'))

  const agentsDot = findText('○')
  check('b hover: agents dot located', agentsDot !== null, JSON.stringify(agentsDot))
  if (agentsDot !== null) {
    check('b hover: dot starts dim', !boldAt(agentsDot.col, agentsDot.row))
    motion(agentsDot.col, agentsDot.row)
    check('b hover: dot brightens and reveals its title', await settled(() => boldAt(agentsDot.col, agentsDot.row) && has('Agents'), { timeoutMs: 4000 }))
    motion(agentsDot.col + 5, agentsDot.row + 3)
    check('b hover: tooltip disappears after leaving the dot', await settled(() => !has('Agents'), { timeoutMs: 4000 }))
  }

  if (agentsDot !== null) click(agentsDot.col + 1, agentsDot.row)
  check('c click: dot hit area selects Agents', await settled(() => has('Agents') && has('⤢'), { timeoutMs: 4000 }))
  const nextArrow = findText('▶')
  check('c arrows: right arrow located', nextArrow !== null)
  if (nextArrow !== null) click(nextArrow.col, nextArrow.row)
  check('c arrows: next wraps from Agents to Todo', await settled(() => has('Todo') && !has('⤢'), { timeoutMs: 4000 }))
  const previousArrow = findText('◀')
  check('c arrows: left arrow located', previousArrow !== null)
  if (previousArrow !== null) click(previousArrow.col, previousArrow.row)
  check('c arrows: previous wraps from Todo to Agents', await settled(() => has('Agents') && has('⤢'), { timeoutMs: 4000 }))

  // ── d. ⤢ hands the ACTIVE panel id to the host ─────────────────────────
  const expand = findText('⤢')
  check('d ⤢: button located', expand !== null, JSON.stringify(expand))
  if (expand !== null) {
    click(expand.col, expand.row)
    // 固定窗:onExpand 是宿主回调，屏幕本身没有可轮询的变化点
    await new Promise(resolve => setTimeout(resolve, 200))
    check('d ⤢: host received the active panel id', expanded.length === 1 && expanded[0] === 'agents', JSON.stringify(expanded))
  }

  // ── e. clicking the chat column returns the focus ──────────────────────
  check('e focus: panel focus first (clicking the column focuses it)', await settled(() => has('Esc chat'), { timeoutMs: 4000 }))
  const body = findText('chat-body')
  check('e focus: chat body located', body !== null, JSON.stringify(body))
  if (body !== null) click(body.col, body.row)
  check('e focus: hint swaps back to the unfocused copy', await settled(() => has('Click panel · Ctrl+B close'), { timeoutMs: 4000 }))
} finally {
  await app.unmount()
}

// ── f. seven dots and fullscreen control stay on one narrow bar ───────────
{
  const NARROW = 96
  const NROWS = 14
  const term2 = new XTerm({ cols: NARROW, rows: NROWS, scrollback: 0, allowProposedApi: true })
  const lines2 = (): string[] => viewportLines(term2, NROWS)
  // Jobs starts active so the fullscreen control is present beside seven dots.
  applySidePanelRatio(0.78)
  applySidePanelPanels('jobs,todo,info,trajectory,agents,workspace,companion')
  const app2 = await render(
    <AlternateScreen>
      <Harness columns={NARROW} />
    </AlternateScreen>,
    {
      stdout: new FakeStdout(term2, NARROW, NROWS) as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  try {
    await settled(() => lines2().some(line => line.includes('Jobs')), { timeoutMs: 4000 })
    const barRow = lines2()[0] ?? ''
    check('f narrow: seven-panel bar keeps every dot and both arrows', (barRow.match(/[○●]/g) ?? []).length === 6 && barRow.includes('◀') && barRow.includes('▶'), barRow.trim())
    check('f narrow: ⤢ stays on the same row', barRow.includes('⤢'), barRow.trim())
    check('f fold: the bar is exactly one row (row 1 is the rule)', (lines2()[1] ?? '').includes('─'), (lines2()[1] ?? '').trim())
  } finally {
    await app2.unmount()
  }
}

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
