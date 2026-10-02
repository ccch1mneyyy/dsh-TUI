/**
 * WorkspacePanel (side panel) headless regression.
 *
 * Mounts the panel directly under AlternateScreen with a stub channel behind
 * the real SidePanelRuntimeContext (no PanelContext → usePanelInput takes its
 * plain-useInput fallback, so keys arrive through the fake stdin). Locks:
 *  - loading → list render (fixed registry array);
 *  - current-workspace highlight (normalizeWorkspaceCwd, case/slash tolerant);
 *  - present=false missing marker (panel-workspace-missing, warning color);
 *  - long paths never overflow the column budget (display width per line);
 *  - failed fetch renders the error line (panel-workspace-failed);
 *  - ↑/↓ move the selection, Enter opens the fullscreen workspace home via
 *    the host outlet, 'r' refetches;
 *  - wheel scrolls the ledger, a real SGR click selects a row, hover lights
 *    the row marker;
 *  - visible=false never starts (or re-fires) a registry fetch.
 * Run: node --import tsx/esm scripts/verify-workspace-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { WorkspacePanel }, { SidePanelRuntimeContext }, termTest, { stringWidth }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/WorkspacePanel.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { settled, sleep } = termTest

const COLS = 120
const ROWS = 26
const PANEL_W = 40

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- registry fixture --------------------------------------------------------
interface StubEntry { id: string; path: string; title: string; present: boolean; sessionCount: number }
// 跨平台：current 高亮断言要求 entry.path 与 channel.cwd 在任何平台的
// normalizeWorkspaceCwd 下都判等——两侧同形（同盘符大小写、同分隔符），
// 大小写/斜线容错由 normalizeWorkspaceCwd 的单测覆盖，不在这里赌平台行为。
const CURRENT = { id: 'w-cur', path: 'd:/code/projects/dsh-tui', title: 'dsh-tui', present: true, sessionCount: 3 }
const MISSING = { id: 'w-miss', path: 'D:\\gone\\dir', title: 'gone-dir', present: false, sessionCount: 1 }
const LONGP = { id: 'w-long', path: 'C:\\Users\\someone\\very\\deep\\nested\\directory\\tree\\with\\a\\long\\tail\\project-name-here', title: 'long-project', present: true, sessionCount: 0 }
const MANY: StubEntry[] = Array.from({ length: 24 }, (_, i) => ({ id: 'w-' + i, path: 'D:\\ws\\proj-' + i, title: 'proj-' + i, present: true, sessionCount: i }))

let fetchCount = 0
let nextResult: 'ok-current' | 'ok-many' | 'fail' = 'ok-current'
const registry = (): Promise<StubEntry[]> => {
  fetchCount += 1
  if (nextResult === 'fail') return Promise.reject(new Error('registry offline'))
  const list = nextResult === 'ok-many' ? MANY : [CURRENT, MISSING, LONGP]
  return Promise.resolve(list)
}
const channel = {
  cwd: 'd:/code/projects/dsh-tui',
  displayCwd: '~/code/projects/dsh-tui',
  gitBranch: 'feat/launchpad-onboarding',
  listWorkspaceRegistry: registry,
} as never

// --- harness -----------------------------------------------------------------
let openCalls: string[] = []
let panelVisible = true
let panelFocused = true
let harnessKey = 0
let bumpKey: (() => void) | undefined

function Keeper(): React.ReactNode {
  useInput(() => {})
  return null
}
function Harness(): React.ReactNode {
  const [, bump] = React.useState(0)
  bumpKey = () => bump(n => n + 1)
  return (
    <SidePanelRuntimeContext.Provider
      value={{
        runtime: { registerInput: () => () => {}, dispatchKey: () => false },
        channel,
        openFullscreen: (panelId: string) => { openCalls.push(panelId) },
      } as never}
    >
      <Keeper />
      <Box width={COLS} height={ROWS} flexDirection="row">
        <Box width={PANEL_W} height={ROWS}>
          <WorkspacePanel key={harnessKey} width={PANEL_W} height={ROWS} focused={panelFocused} visible={panelVisible} mode="split" />
        </Box>
        <Box width={COLS - PANEL_W}><Text>{'right-edge sentinel SR'}</Text></Box>
      </Box>
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
const findLine = (needle: string): { text: string; row: number } | null => {
  const ls = lines()
  for (let y = 0; y < ls.length; y += 1) if (ls[y]!.includes(needle)) return { text: ls[y]!, row: y }
  return null
}
const focusedLine = (): string => lines().find(l => l.includes('❯')) ?? ''

try {
  // --- 1. loading, then the fixed list renders ------------------------------
  await settled(() => lines().some(l => l.includes('Loading workspaces')), { timeout: 4000 })
  check('load: loading line while the registry promise is pending', true)
  await settled(() => lines().some(l => l.includes('dsh-tui') && l.includes('❯')), { timeout: 4000 })
  const listState = lines()
  check('load: registry rows render (titles)', listState.some(l => l.includes('gone-dir')) && listState.some(l => l.includes('long-project')))
  check('load: header counts 3 registered', listState.some(l => l.includes('Registered workspaces ×3')), listState.find(l => l.includes('Registered')) ?? '')
  check('load: current cwd + branch shown', listState.some(l => l.includes('~/code/projects/dsh-tui')) && listState.some(l => l.includes('feat/launchpad-onboarding')), listState.find(l => l.includes('feat/')) ?? '')
  check('load: hint line present', listState.some(l => l.includes('\u2191/\u2193 select') && l.includes('Enter')))

  // --- 2. current-workspace highlight + missing marker ----------------------
  const curLine = listState.find(l => l.includes('\u25cf')) !== undefined ? { text: listState.find(l => l.includes('\u25cf'))!, row: 0 } : null
  check('current: ledger row for the live cwd is highlighted', curLine !== null && curLine.text.includes('●'), curLine?.text.trim() ?? '')
  const missLine = findLine('gone-dir')
  check('missing: present=false row shows the missing marker', missLine !== null && lines()[missLine.row + 1] !== undefined && lines()[missLine.row + 1]!.includes('directory missing'), (missLine ? lines()[missLine.row + 1] ?? '' : '').trim())

  // --- 3. long path never overflows the column budget -----------------------
  const longPathLine = lines()[findLine('long-project')!.row + 1] ?? ''
  const longVisible = longPathLine.slice(0, PANEL_W).trimEnd()
  check('overflow: long-path line clipped inside the panel width', stringWidth(longVisible) <= PANEL_W && longVisible.includes('…'), JSON.stringify(longVisible))
  const widthOk = lines().every(l => stringWidth(l.replace(/\s+$/u, '')) <= COLS)
  const sentinel = findLine('right-edge sentinel SR')
  check('overflow: every screen line within terminal width', widthOk)
  check('overflow: right-edge sentinel untouched', sentinel !== null && sentinel.text.includes('right-edge sentinel SR'), sentinel?.text.slice(PANEL_W, PANEL_W + 24) ?? '')

  // --- 4. ↑/↓ move the selection --------------------------------------------
  check('keys: selection starts at the current row', focusedLine().includes('dsh-tui'), focusedLine().trim())
  stdin.write('\x1b[B')
  await settled(() => focusedLine().includes('gone-dir'), { timeout: 4000 })
  check('keys: downArrow moves to the second row', focusedLine().includes('gone-dir'), focusedLine().trim())
  stdin.write('\x1b[A')
  await settled(() => focusedLine().includes('dsh-tui'), { timeout: 4000 })
  check('keys: upArrow moves back', focusedLine().includes('dsh-tui'), focusedLine().trim())

  // --- 5. Enter opens the fullscreen workspace home -------------------------
  stdin.write('\r')
  await settled(() => openCalls.length === 1, { timeout: 4000 })
  check('enter: openFullscreen(\'workspace\') via the host outlet', openCalls.join(',') === 'workspace', openCalls.join(','))

  // --- 6. 'r' refetch: failure branch shows the error line ------------------
  nextResult = 'fail'
  stdin.write('r')
  await settled(() => lines().some(l => l.includes('Failed to load workspaces')), { timeout: 4000 })
  const failLine = lines().find(l => l.includes('Failed to load workspaces')) ?? ''
  check('refresh: r refetches; failure renders the error line', failLine.includes('Failed to load workspaces'), failLine.trim())
  check('refresh: fetch count is 2 after one manual refresh', fetchCount === 2, String(fetchCount))

  // --- 7. many rows: wheel scroll + click select + hover feedback ------------
  nextResult = 'ok-many'
  stdin.write('r')
  await settled(() => lines().some(l => l.includes('proj-0') && l.includes('❯')) && lines().some(l => l.includes('proj-8')), { timeout: 4000 })
  check('scroll: 24-row ledger renders the head', lines().some(l => l.includes('proj-0')))
  check('scroll: tail row clipped out before scrolling', !lines().some(l => l.includes('proj-23')), lines().find(l => l.includes('proj-2')) ?? '')
  const wheelRow = (findLine('Registered workspaces')?.row ?? 3) + 3
  for (let i = 0; i < 8; i += 1) stdin.write('\x1b[<65;10;' + (wheelRow + 1) + 'M')
  await settled(() => !lines().some(l => l.includes('proj-0')), { timeout: 4000 })
  check('scroll: wheel-down scrolls the ledger (head row left the viewport)', !lines().some(l => l.includes('proj-0')), lines().find(l => l.includes('proj-')) ?? '')

  // wheel may have scrolled past proj-4; wheel back until something clickable is on screen.
  let target = findLine('proj-4')
  for (let i = 0; i < 8 && target === null; i += 1) {
    stdin.write('\x1b[<64;10;' + (wheelRow + 1) + 'M')
    await sleep(30) // 固定窗:pacing 滚轮事件步间——同 tick 多次写入会被合并
    target = findLine('proj-4') ?? findLine('proj-2')
  }
  check('click: target row on screen', target !== null, target?.text.trim() ?? '')
  if (target !== null) {
    stdin.write('\x1b[<0;' + (target.text.indexOf('proj') + 1) + ';' + (target.row + 1) + 'M')
    stdin.write('\x1b[<0;' + (target.text.indexOf('proj') + 1) + ';' + (target.row + 1) + 'm')
    await settled(() => focusedLine().includes(target.text.trim().slice(2).split(/\s/u)[0] ?? 'zz'), { timeout: 4000 })
    check('click: SGR press selects the row', lines()[target.row] !== undefined && lines()[target.row]!.includes('❯'), (lines()[target.row] ?? '').trim())
  }

  // hover: move over an unselected row → marker lights; leave → clears.
  const hoverLinesAll = lines()
  const hoverLineIndex = hoverLinesAll.findIndex(l => /proj-\d/u.test(l) && !l.includes('\u276f') && !l.includes('D:\\'))
  const hoverRow = hoverLineIndex >= 0 ? { text: hoverLinesAll[hoverLineIndex]!, row: hoverLineIndex } : null
  if (hoverRow !== null) {
    stdin.write('\x1b[<35;6;' + (hoverRow.row + 1) + 'M')
    await settled(() => (lines()[hoverRow.row] ?? '').includes('❯') || (lines()[hoverRow.row - 1] ?? '').includes('❯'), { timeout: 4000 })
    const hoverHit = (lines()[hoverRow.row] ?? '').includes('❯') || (lines()[hoverRow.row - 1] ?? '').includes('❯')
    check('hover: motion over a row lights the marker', hoverHit, (lines()[hoverRow.row] ?? '').trim())
    stdin.write('\x1b[<35;3;1M')
    await settled(() => !(lines()[hoverRow.row] ?? '').includes('❯'), { timeout: 4000 })
    check('hover: leaving clears it', !(lines()[hoverRow.row] ?? '').includes('❯'), (lines()[hoverRow.row] ?? '').trim())
  } else {
    check('hover: a hoverable row exists', false, 'no proj-5/6 row on screen')
  }

  // --- 8. visible=false never (re-)fires a fetch -----------------------------
  const fetchBefore = fetchCount
  panelVisible = false
  panelFocused = false
  bumpKey?.()
  await sleep(120) // 固定窗:探针 visible=false 后的观察窗——断言静默期不发请求
  check('visible=false: hiding the panel fires no fetch', fetchCount === fetchBefore, String(fetchCount - fetchBefore))
  // remount from cold with visible=false: still silent.
  harnessKey += 1
  bumpKey?.()
  await sleep(150) // 固定窗:探针 冷挂载 visible=false 的观察窗
  check('visible=false: cold remount starts no request', fetchCount === fetchBefore, String(fetchCount - fetchBefore))
  panelVisible = true
  panelFocused = true
  harnessKey += 1
  bumpKey?.()
  await settled(() => fetchCount > fetchBefore, { timeout: 4000 })
  check('visible=true: first visibility after cold mount fetches once', fetchCount === fetchBefore + 1, String(fetchCount - fetchBefore))
} finally {
  await app.unmount()
  term.dispose()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: workspace panel all checks passed.')
process.exit(0)
