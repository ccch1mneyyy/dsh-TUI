/**
 * Side-panel layout regression (Phase 1, render level): mounts
 * SidePanelLayout + SidePanelColumn (real useSidePanel controller + a
 * minimal channel stub — the column's tabs now come from the panel store
 * via the controller) with fake chat content in a headless XTerm
 * (AlternateScreen — fixed-height boxes are only trustworthy there, see
 * verify-divider-width's lesson) and locks the visual contract:
 *  - divider column sits exactly at the chat width; rows 1 and rows-2
 *    draw '├' (teeing into the panel rules), every other row '│';
 *  - PanelBar on row 0 with the active capsule '‹ 待办 ›' and builtin
 *    icons; hint on the last row swapping text with focus (zh + en);
 *  - the chat-side bordered input never crosses the divider;
 *  - zoom (chat=64) and the 93-column minimum split keep those invariants
 *    with bar/hint each on exactly one row;
 *  - geometry=null renders children byte-identically to no layout;
 *  - overflow folds into a well-formed '+N' marker (digits included, at
 *    '+1'-scale and larger), capsule always visible;
 *  - resize oracle: 120 -> 100 -> 120 settles to the same frame as a
 *    fresh 120 render (terminal-state equivalence); the frame must also
 *    re-split live (geometry resolved from useTerminalSize, mirroring
 *    Chat's call site — a fixed prop would not re-split).
 * Run: node --import tsx/esm scripts/verify-side-panel-layout.tsx
 */
process.env.FORCE_COLOR = '3'
// Pin zh before module imports resolve the startup lang; the en pass
// switches at runtime via setLang (i18n hot-swaps).
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, dims, prefs, { setLang }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/components/sidePanel/dimensions.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, Box, Text, AlternateScreen, useTerminalSize } = ui
const { resolveSplit, resolveZoom, resolveSidePanelGeometry } = dims
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels } = prefs
const { settled, sleep } = termTest
setLang('zh')

const ROWS = 18

// Minimal channel stub: the todo builtin reads goal/todos/working (all
// empty -> renders nothing); nothing else in the column touches it.
const channelStub: unknown = {
  version: 0,
  rows: [],
  status: 'idle',
  working: false,
  goal: undefined,
  todos: [],
  // jobs/agents 面板默认启用（摘要 length / 名册 filter）
  backgroundJobs: [],
  subagents: [],
  subscribe() { return () => {} },
}

function ChatFake({ width }: { width: number }): React.ReactNode {
  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Box flexGrow={1} flexDirection="column" justifyContent="center">
        <Text>chat-body</Text>
      </Box>
      <Box borderStyle="single" flexShrink={0}>
        <Text>input › _</Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text>status:ready</Text>
      </Box>
    </Box>
  )
}

// Controller-driven split: mirrors Chat's call site (useSidePanel reads
// useTerminalSize via its columns prop and resolves geometry per render).
function SplitFixture({ focusPanel, zoom }: { focusPanel: boolean; zoom?: boolean }): React.ReactNode {
  const size = useTerminalSize()
  const sp = useSidePanel({ columns: size.columns, fullscreen: true, editorOpen: false })
  React.useEffect(() => {
    if (focusPanel) sp.focusPanel()
    if (zoom) sp.toggleZoom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const geo = sp.geometry
  return (
    <SidePanelLayout
      geometry={geo}
      focus={sp.focus}
      side={geo === null ? null : (
        <SidePanelColumn width={geo.panel} controller={sp} channel={channelStub as never} />
      )}
    >
      <ChatFake width={geo === null ? size.columns : geo.chat} />
    </SidePanelLayout>
  )
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

class FakeStdout extends Writable {
  columns: number
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, cols: number) {
    super()
    this.term = term
    this.columns = cols
  }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Frame {
  term: import('@xterm/headless').Terminal
  stdout: FakeStdout
  app: { unmount: () => Promise<void> }
  lines(): string[]
}

async function mountTree(cols: number, tree: React.ReactNode): Promise<Frame> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols)
  const app = await render(
    <AlternateScreen><ThemeProvider theme="dark">{tree}</ThemeProvider></AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const frame: Frame = {
    term, stdout, app,
    lines() {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(cols, ' '))
      return out
    },
  }
  await settled(() => frame.lines().some(l => l.includes('status:ready')))
  await sleep(50) // 固定窗:pacing 首帧无单一可轮询锚点（多面板 display:none 切换），等一帧渲染 flush 再交还夹具
  return frame
}

/** Reset the module-level live stores, then mount a controller-driven split. */
async function mountSplit(cols: number, focusPanel: boolean, zoom = false): Promise<Frame> {
  applySidePanelOpen(true)
  applySidePanelRatio(0.68)
  applySidePanelPanels('todo,jobs,agents')
  return mountTree(cols, <SplitFixture focusPanel={focusPanel} zoom={zoom} />)
}

function cells(line: string): string[] { return [...line] }

function assertSplitFrame(name: string, frame: Frame, geo: { chat: number; panel: number }, hintNeedle: string, hintAnti: string) {
  const lines = frame.lines()
  const chatCol = geo.chat
  // Divider column: tee at rule rows, seam elsewhere.
  for (let y = 0; y < ROWS; y += 1) {
    const expected = (y === 1 || y === ROWS - 2) ? '├' : '│'
    const got = cells(lines[y])[chatCol]
    check(name + ': divider row ' + y + ' is ' + expected, got === expected, 'got ' + JSON.stringify(got) + ' line=' + JSON.stringify(lines[y]))
  }
  // PanelBar on row 0: active capsule + builtin icons.
  check(name + ': row 0 carries the active capsule ‹ 待办 ›', lines[0].includes('‹ 待办 ›'), JSON.stringify(lines[0]))
  check(name + ': row 0 carries builtin icons ▸ and ◆', lines[0].includes('▸') && lines[0].includes('◆'), JSON.stringify(lines[0]))
  // Rules frame the host: row 1 and rows-2 are horizontal rules on the panel side.
  const ruleAfter = cells(lines[1]).slice(chatCol + 1).join('').trim()
  check(name + ': row 1 rule right of the divider', ruleAfter.length > 0 && ruleAfter.startsWith('─'), ruleAfter.slice(0, 8))
  const ruleBefore = cells(lines[ROWS - 2]).slice(chatCol + 1).join('').trim()
  check(name + ': rows-2 rule right of the divider', ruleBefore.length > 0 && ruleBefore.startsWith('─'), ruleBefore.slice(0, 8))
  // Hint on the last row, swapping with focus.
  check(name + ': hint row carries ' + JSON.stringify(hintNeedle), lines[ROWS - 1].includes(hintNeedle), JSON.stringify(lines[ROWS - 1]))
  check(name + ': hint row does not carry the other focus copy', !lines[ROWS - 1].includes(hintAnti), JSON.stringify(lines[ROWS - 1]))
  // Chat-side bordered input never crosses the divider.
  const topBorder = lines.find(l => l.includes('┌'))
  const bottomBorder = lines.find(l => l.includes('└'))
  const inputRow = lines.find(l => l.includes('input ›'))
  check(name + ': bordered input rendered', topBorder !== undefined && inputRow !== undefined && bottomBorder !== undefined)
  if (topBorder !== undefined && inputRow !== undefined) {
    const rightCorner = cells(topBorder).indexOf('┐')
    check(name + ': input box right edge (' + rightCorner + ') < divider (' + chatCol + ')', rightCorner >= 0 && rightCorner < chatCol)
    const side = cells(inputRow).indexOf('│')
    check(name + ': input box side border < divider', side >= 0 && side < chatCol)
    // Nothing chat-side bleeds into the divider column.
    check(name + ': chat body stops before the divider', cells(lines.find(l => l.includes('chat-body')) ?? '')[chatCol - 1] === ' ')
  }
}

// --- 1. 120 columns, focus=chat -----------------------------------------
{
  const frame = await mountSplit(120, false)
  assertSplitFrame('120/focus=chat', frame, resolveSplit(120, 0.68), '点击操作 · Ctrl+B 关闭', 'Esc 聊天')
  await frame.app.unmount()
}

// --- 2. 120 columns, focus=panel (hint swaps) ----------------------------
{
  const frame = await mountSplit(120, true)
  assertSplitFrame('120/focus=panel', frame, resolveSplit(120, 0.68), 'Esc 聊天', '点击操作 · Ctrl+B 关闭')
  await frame.app.unmount()
}

// --- 3. zoom at 120: chat=64 keeps every invariant -----------------------
{
  const frame = await mountSplit(120, true, true)
  assertSplitFrame('zoom(120)/chat=64', frame, resolveZoom(120), 'Esc 聊天', '点击操作 · Ctrl+B 关闭')
  check('zoom(120)/chat=64: divider sits at column 64', cells(frame.lines()[5])[64] === '│', JSON.stringify(frame.lines()[5]))
  await frame.app.unmount()
}

// --- 4. 93-column minimum split: bar/hint stay single rows ----------------
{
  const geo = resolveSidePanelGeometry({ columns: 93, open: true, zoom: false, ratio: 0.68 })
  if (geo === null) throw new Error('93 columns must split')
  const frame = await mountSplit(93, true)
  const lines = frame.lines()
  assertSplitFrame('93/focus=panel', frame, geo, 'Esc 聊天', '点击操作 · Ctrl+B 关闭')
  // No wrap: the bar occupies exactly row 0 (row 1 is the rule, not bar text).
  check('93: PanelBar is exactly one row (row 1 is the rule, no › spillover)', !lines[1].includes('›') && !lines[1].includes('‹'), JSON.stringify(lines[1]))
  // Hint is exactly one row: rows-2 is the rule, and no hint text above it.
  check('93: hint is exactly one row (rows-2 is the rule)', !lines[ROWS - 2].includes('Esc') && lines[ROWS - 1].includes('Esc'), JSON.stringify(lines[ROWS - 2]))
  await frame.app.unmount()
  // Unfocused hint at the minimum width: full copy fits.
  const frame2 = await mountSplit(93, false)
  check('93: unfocused hint copy fits one row', frame2.lines()[ROWS - 1].includes('点击操作 · Ctrl+B 关闭'), JSON.stringify(frame2.lines()[ROWS - 1]))
  await frame2.app.unmount()
}

// --- 5. Bar overflow folds into a well-formed +N --------------------------
{
  // Unregistered ids render as fallback-title tabs, so a long enabled list
  // drives the fold without registering real panels.
  const ids = (n: number) => Array.from({ length: n }, (_, i) => 'p' + i).join(',')
  applySidePanelOpen(true)
  applySidePanelRatio(0.68)
  applySidePanelPanels(ids(16))
  const geo93 = resolveSidePanelGeometry({ columns: 93, open: true, zoom: false, ratio: 0.68 })
  const frame = await mountTree(93, <SplitFixture focusPanel />)
  // The windowing budget counts the inter-segment marginRight(1), so the
  // '+N' fold marker keeps its digits even at an exactly-full bar.
  check('overflow: +N fold marker with digits on row 0', /\+\d+/.test(frame.lines()[0]), JSON.stringify(frame.lines()[0]))
  check('overflow: active capsule still visible', frame.lines()[0].includes('‹ P0 ›'), JSON.stringify(frame.lines()[0]))
  check('overflow: bar stays one row (row 1 is the rule)', !frame.lines()[1].includes('‹') && !frame.lines()[1].includes('+'), JSON.stringify(frame.lines()[1]))
  await frame.app.unmount()
  // Same long list on the wider default panel (120 cols, panel=38).
  applySidePanelOpen(true)
  applySidePanelPanels(ids(16))
  const frame2 = await mountTree(120, <SplitFixture focusPanel />)
  check('overflow(120): +N fold marker with digits', /\+\d+/.test(frame2.lines()[0]), JSON.stringify(frame2.lines()[0]))
  check('overflow(120): active capsule still visible', frame2.lines()[0].includes('‹ P0 ›'), JSON.stringify(frame2.lines()[0]))
  await frame2.app.unmount()
  // Small-scale folds ('+1' / '+2'): tab counts just past the fit so only
  // one or two tabs hide — the marker's digits must survive there too.
  for (const n of [12, 13]) {
    applySidePanelOpen(true)
    applySidePanelPanels(ids(n))
    const f3 = await mountTree(120, <SplitFixture focusPanel />)
    const expect = n === 12 ? '+1' : '+2'
    check('overflow(' + n + ' tabs): exact ' + expect + ' marker on row 0', f3.lines()[0].includes(expect) && !/\+\d\d/.test(f3.lines()[0]), JSON.stringify(f3.lines()[0]))
    check('overflow(' + n + ' tabs): active capsule still visible', f3.lines()[0].includes('‹ P0 ›'), JSON.stringify(f3.lines()[0]))
    await f3.app.unmount()
  }
  applySidePanelPanels('todo,jobs,agents')
}

// --- 6. 90 columns (!canSplit): geometry=null is a byte-identical passthrough
{
  const bare = await mountTree(90, <ChatFake width={90} />)
  const bareLines = bare.lines()
  await bare.app.unmount()
  const wrapped = await mountSplit(90, false)
  const wrappedLines = wrapped.lines()
  check('90 cols: geometry=null renders identical to no SidePanelLayout', JSON.stringify(bareLines) === JSON.stringify(wrappedLines),
    JSON.stringify(bareLines) + ' vs ' + JSON.stringify(wrappedLines))
  await wrapped.app.unmount()
}

// --- 7. resize oracle: 120 -> 100 -> 120 equals a fresh 120 frame ---------
{
  const frame = await mountSplit(120, true)
  // Shrink to 100, let it settle, then back to 120.
  frame.stdout.columns = 100
  frame.term.resize(100, ROWS)
  frame.stdout.emit('resize')
  await sleep(120) // 固定窗:墙钟 resize 触发的是节流重排，渲染节流窗口本身就是被等语义
  const shrunkGeo = resolveSidePanelGeometry({ columns: 100, open: true, zoom: false, ratio: 0.68 })
  if (shrunkGeo === null) throw new Error('100 columns must split')
  const shrunkLine = (frame.lines()[5] ?? '').slice(0, 100)
  check('resize: 100-col frame re-splits to chat=68/panel=31', [...shrunkLine][shrunkGeo.chat] === '│', JSON.stringify(shrunkLine))
  frame.stdout.columns = 120
  frame.term.resize(120, ROWS)
  frame.stdout.emit('resize')
  await sleep(120) // 固定窗:墙钟 同上：等渲染节流窗口过去再读终态帧
  const backLines = frame.lines().map(l => l.slice(0, 120))
  await frame.app.unmount()
  const fresh = await mountSplit(120, true)
  const freshLines = fresh.lines()
  await fresh.app.unmount()
  check('resize: 120->100->120 equals a fresh 120 render', JSON.stringify(backLines) === JSON.stringify(freshLines),
    'back=' + JSON.stringify(backLines.slice(0, 3)) + ' fresh=' + JSON.stringify(freshLines.slice(0, 3)))
}

// --- 8. en hint pass -------------------------------------------------------
{
  setLang('en')
  const frame = await mountSplit(120, true)
  check('en: focused hint says Esc chat', frame.lines()[ROWS - 1].includes('Esc chat'), JSON.stringify(frame.lines()[ROWS - 1]))
  await frame.app.unmount()
  const frame2 = await mountSplit(120, false)
  check('en: unfocused hint says Click panel · Ctrl+B close', frame2.lines()[ROWS - 1].includes('Click panel · Ctrl+B close'), JSON.stringify(frame2.lines()[ROWS - 1]))
  await frame2.app.unmount()
  setLang('zh')
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: side-panel layout all checks passed.')
process.exit(0)
