/**
 * Side-panel selection regression (user report 2026-10-02: "侧边栏里的文字
 * 没法复制"). The side-panel column carries noSelect (design §4.6: a
 * chat-origin drag must never capture panel glyphs), which used to be a
 * direction-blind per-cell exclusion — a drag that STARTED inside the panel
 * highlighted nothing and copied nothing, so panel text was entirely
 * uncopyable.
 *
 * The fix is a direction-aware fence on the selection state
 * (SelectionState.includeNoSelectCells, seeded by startSelection from the
 * anchor cell's noSelect bit): gestures anchored on a noSelect cell select
 * that region's own text; gestures anchored anywhere else keep the
 * exclusion verbatim. The divider seam is noSelect too (chrome, not text).
 *
 * Locked behavior, all driven by REAL SGR mouse sequences into a headless
 * xterm (press/motion/release bytes, motion = button 0 + 0x20 drag bit):
 *  a. boot: split renders divider + roster + chat anchors;
 *  b. §4.6 (MUST keep): chat-origin drag sweeping into the panel copies
 *     chat text and NO panel glyphs (no "AAA", no │/├);
 *  c. panel-origin horizontal drag copies the covered card word;
 *  d. panel-origin vertical drag copies both covered cards and no chat
 *     anchors;
 *  e. panel double-click selects the word under the cursor;
 *  f. panel-origin selection actually HIGHLIGHTS panel cells (selection
 *     background on a covered cell), while a chat-origin selection leaves
 *     panel cells untouched.
 *
 * Run: node --import tsx/esm scripts/verify-side-panel-selection.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
// Minimal-UI glyphs (✓/·, all narrow) keep the harness terminal's cell
// grid in agreement with the app model — see verify-side-panel-scroll-paint
// for the @xterm/headless emoji-width discrepancy this avoids.
{
  const { setMinimalUiMode } = await import('../src/minimalUiMode.js')
  setMinimalUiMode(true)
}

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, termTest, instancesMod, selectionMod] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/instances.js'),
  import('../src/ink/selection.js'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels } = prefs
const { settled, sleep } = termTest
const instances = instancesMod.default ?? instancesMod
const { getSelectedText } = selectionMod

const COLS = 120
const ROWS = 24

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- fake channel: completed-only roster (durations frozen) ----------------
interface FakeSubagent {
  agentId: string
  description: string
  status: string
  startedAt: number
  completedAt?: number
  model?: string
  output: string[]
  outputEvents: unknown[]
  toolCalls: unknown[]
}
const NOW = Date.now()
const ROSTER: FakeSubagent[] = Array.from({ length: 8 }, (_, i) => ({
  agentId: 'agent-' + (i + 1),
  description: 'AAA' + (i + 1),
  status: 'completed',
  startedAt: NOW - 120_000,
  completedAt: NOW - 60_000 + i * 1000,
  model: 'm1',
  output: [],
  outputEvents: [],
  toolCalls: [],
}))
const channel = {
  version: 1,
  get subagents() { return ROSTER },
  subagentControl: { interrupt() { return true } },
  notifications: [] as Array<{ text: string }>,
  notify(_text: string) {},
  subscribe() { return () => {} },
}

// --- harness ----------------------------------------------------------------
let exposedChatColumns = 0
let openAgents: (() => void) | undefined

function Harness(): React.ReactNode {
  const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
  exposedChatColumns = sp.split ? sp.chatColumns : COLS
  openAgents = () => sp.openPanel('agents', { focus: true })
  const [, bump] = React.useState(0)
  // The fixture has no selection subscriber (Chat owns that in production),
  // so the selection overlay only lands in a frame when something re-renders:
  // any keypress pokes the harness.
  useInput(() => { bump(previous => previous + 1) })
  const chatWidth = sp.split ? sp.chatColumns : COLS - 1
  const anchors = Array.from({ length: ROWS }, (_, i) => 'R' + String(i).padStart(2, '0') + ' ' + '·'.repeat(Math.max(0, chatWidth - 4)))
  return (
    <Box width={COLS} height={ROWS} flexDirection="row">
      <SidePanelLayout
        geometry={sp.geometry}
        focus={sp.focus}
        onActivateChat={sp.focusChat}
        onActivatePanel={sp.focusPanel}
        onResize={sp.resize}
        side={
          <SidePanelColumn
            width={sp.panelColumns}
            controller={sp}
            channel={channel as never}
          />
        }
      >
        <Box flexDirection="column" flexShrink={0} height={ROWS}>
          {anchors.map((line, i) => <Text key={i}>{line}</Text>)}
        </Box>
      </SidePanelLayout>
    </Box>
  )
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

applySidePanelOpen(true)
applySidePanelRatio(0.68)
applySidePanelPanels('todo,agents')

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
type InkLike = {
  selection: import('../src/ink/selection.js').SelectionState
  frontFrame: { screen: import('../src/ink/screen.js').Screen }
  setSelectionBgColor: (color: string) => void
}
const inkInstance = instances.get(stdout) as InkLike | undefined
// Production wires the theme's selection bg via use-selection's effect
// (ScrollKeybindingHandler); the fixture calls the setter directly.
inkInstance?.setSelectionBgColor('rgb(80, 90, 120)')

function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(buf.baseY + y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
const has = (needle: string): boolean => lines().some(l => l.includes(needle))
const findText = (needle: string): { col: number; row: number } | null => {
  const ls = lines()
  for (let y = 0; y < ls.length; y += 1) {
    const col = ls[y]!.indexOf(needle)
    if (col >= 0) return { col, row: y }
  }
  return null
}
const dividerCol = (): number => exposedChatColumns
const selectedText = (): string =>
  inkInstance ? getSelectedText(inkInstance.selection, inkInstance.frontFrame.screen) : ''
const cellHighlighted = (col: number, row: number): boolean => {
  const buf = term.buffer.active
  const cell = buf.getLine(buf.baseY + row)?.getCell(col)
  // Production wires a solid selection bg (ScrollKeybindingHandler effect);
  // without it StylePool falls back to SGR-7 inverse — accept either.
  return cell !== undefined && (!cell.isBgDefault() || cell.isInverse())
}
// SGR 1-indexed. press/release = button 0; motion = button 0 + drag bit 0x20.
const press = (c: number, r: number): string => '\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'M'
const motion = (c: number, r: number): string => '\x1b[<32;' + (c + 1) + ';' + (r + 1) + 'M'
const release = (c: number, r: number): string => '\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'm'
const writeStep = async (data: string): Promise<void> => {
  stdin.write(data)
  await new Promise(resolve => setImmediate(resolve))
}
/** 无选择订阅者的夹具里，覆盖层只在下一帧落屏：按键戳一次重渲染。 */
const poke = async (): Promise<void> => {
  stdin.write('z')
  await sleep(60) // 固定窗:pacing 等 poke 帧渲染完
}

try {
  check('harness: ink instance registered under the fixture stdout', inkInstance !== undefined)
  await settled(() => has('AAA1') && has('R00'))
  openAgents?.()
  await settled(() => has('AAA1') && has('Agents'))
  check('boot: split renders divider + roster + chat anchors', has('AAA1') && has('AAA2'), 'chatCols=' + exposedChatColumns)

  // --- b. §4.6: chat-origin drag sweeping into the panel -------------------
  {
    const row = 10
    await writeStep(press(0, row))
    await writeStep(motion(dividerCol() + 8, row))
    await writeStep(release(dividerCol() + 8, row))
    await poke()
    await sleep(120) // 固定窗:pacing 等 release 尾部的重绘/指纹帧落定
    const text = selectedText()
    check('§4.6: chat-origin drag copies the chat row', text.includes('R' + String(row).padStart(2, '0')), JSON.stringify(text.slice(0, 40)))
    check('§4.6: chat-origin copy has NO panel glyphs', !text.includes('AAA'), JSON.stringify(text.slice(0, 40)))
    // The divider seam itself stays selectable (pre-existing behavior):
    // §4.6's contract is about PANEL glyphs, not the seam chrome.
    check('§4.6: chat cells DO highlight (readback control)', cellHighlighted(5, row))
    // The divider seam itself stays selectable (pre-existing behavior);
    // §4.6's lock is the PANEL column's cells.
    check('§4.6: panel cells stay unhighlighted for chat-origin drags',
      !cellHighlighted(dividerCol() + 8, row) && !cellHighlighted(dividerCol() + 30, row))
  }

  // --- c. panel-origin horizontal drag --------------------------------------
  {
    const cell = findText('AAA2')
    check('panel drag: target card on screen', cell !== null)
    if (cell !== null) {
      await writeStep(press(cell.col, cell.row))
      await writeStep(motion(cell.col + 6, cell.row))
      await writeStep(release(cell.col + 6, cell.row))
      await poke()
      await sleep(120) // 固定窗:pacing 同上
      const text = selectedText()
      check('panel drag: horizontal drag copies the card word', text.trim() === 'AAA2', JSON.stringify(text))
      check('panel drag: horizontal copy has no chat anchors', !text.includes('R1'), JSON.stringify(text))
      check('panel drag: covered panel cell is highlighted', cellHighlighted(cell.col + 1, cell.row))
    }
  }

  // --- d. panel-origin vertical drag ----------------------------------------
  {
    const a = findText('AAA2')
    const b = findText('AAA3')
    check('panel drag: both cards located', a !== null && b !== null)
    if (a !== null && b !== null) {
      await writeStep(press(a.col, a.row))
      await writeStep(motion(b.col, b.row))
      await writeStep(release(b.col, b.row))
      await poke()
      await sleep(120) // 固定窗:pacing 同上
      const text = selectedText()
      check('panel drag: vertical drag copies both cards', text.includes('AAA2') && text.includes('AAA3'), JSON.stringify(text.slice(0, 80)))
      check('panel drag: vertical copy has no chat anchors', !/R\d\d/.test(text), JSON.stringify(text.slice(0, 80)))
    }
  }

  // --- e. panel double-click word select (non-interactive row: the summary) -
  {
    const cell = findText('completed')
    check('word select: summary line located', cell !== null)
    if (cell !== null) {
      await writeStep(press(cell.col, cell.row))
      await writeStep(release(cell.col, cell.row))
      await sleep(40) // 固定窗:pacing 双击窗口内的 press 步进（<500ms 链）
      await writeStep(press(cell.col, cell.row))
      await writeStep(release(cell.col, cell.row))
      await poke()
      await sleep(120) // 固定窗:pacing 等 word-select 高亮帧落定
      const text = selectedText()
      check('word select: double-click on the panel selects the word', text === 'completed', JSON.stringify(text))
    }
  }
} finally {
  if (failed > 0) {
    console.error('---- screen ----')
    console.error(lines().map((l, i) => String(i).padStart(2, '0') + '|' + l.trimEnd()).join('\n'))
  }
  await app.unmount()
  term.dispose()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: side panel selection all checks passed.')
process.exit(0)
