/**
 * Side-panel scroll paint regression (user report 2026-10-02: scrolling the
 * agents panel "breaks the boundary redraw — the divider and the Chat page").
 *
 * Root cause locked here: the ink renderer's ScrollBox fast path pairs an
 * x-scoped blit with a FULL-WIDTH row shift (DECSTBM + SU/SD semantics — ANSI
 * has no column-scoped scroll). Any scroll container narrower than the screen
 * (the side-panel column; the chat column while split) therefore displaced
 * every sibling column's cells while the edge-row repaint only covered the
 * box's own x-range — the divider seam and the chat column stayed corrupted
 * in both the model and the terminal.
 *
 * Fixture = the REAL split surface: SidePanelLayout (divider column included)
 * + SidePanelColumn with the agents panel active and a roster tall enough to
 * scroll. The chat column is filled edge-to-edge with unique per-row anchors
 * (a blank cell shifting under the seam is invisible; anchors make any
 * vertical displacement detectable) and lives inside its own ScrollBox so the
 * reverse direction (chat scroll damaging the divider/panel) is covered too.
 *
 * Invariants after EVERY scroll input (arrow keys and SGR wheel):
 *  1. divider column: rows 0..ROWS-1 each still exactly one of │/├,
 *     junctions only at rows 1 and ROWS-2, column index fixed = chat width;
 *  2. the column that did NOT scroll is byte-identical to its snapshot
 *     (chat region frozen while the panel scrolls; panel region frozen while
 *     chat scrolls — both regions are time-invariant in this fixture);
 *  3. no orphan glyphs: the chat column keeps strictly ordered unique
 *     anchors (a full-width row shift would displace/duplicate/blank them);
 *  4. the scroll actually happened (top card changed / chat scrollTop moved).
 *
 * Run: node --import tsx/esm scripts/verify-side-panel-scroll-paint.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
// The harness terminal (@xterm/headless 6.0.0) classifies the emoji status
// glyphs (U+1F7E2 etc.) as width 1 while the app model (and every modern
// real terminal, per EAW=W) uses width 2 — a sparse diff write would then
// land one column off the harness's own boot paint INSIDE the panel, failing
// region assertions for a reason that cannot occur in production.
// The minimal-UI glyphs (·/×/✓, all narrow) keep the fixture's terminal and
// model in agreement, so the assertions below test the scroll-paint contract
// (divider/seam/stable columns) and nothing else.
{
  const { setMinimalUiMode } = await import('../src/minimalUiMode.js')
  setMinimalUiMode(true)
}

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput, ScrollBox } = ui
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels } = prefs
const { settled, sleep } = termTest

const COLS = 120
const ROWS = 24

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- fake channel: completed-only roster (durations frozen -> the panel
// region is time-invariant and byte-comparable across scroll steps) ---------
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
const ROSTER: FakeSubagent[] = Array.from({ length: 24 }, (_, i) => ({
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
let channelVersion = 1
const channelListeners = new Set<() => void>()
const channel = {
  get version() { return channelVersion },
  get subagents() { return ROSTER },
  subagentControl: { interrupt() { return true } },
  notifications: [] as Array<{ text: string }>,
  notify(_text: string) {},
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}

// --- harness ----------------------------------------------------------------
let exposedChatColumns = 0
let exposedPanelColumns = 0
let openAgents: (() => void) | undefined
const chatScrollRef = React.createRef<import('../src/ink/components/ScrollBox.js').ScrollBoxHandle>()

const CHAT_ROWS = 40

function Harness(): React.ReactNode {
  const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
  exposedChatColumns = sp.split ? sp.chatColumns : COLS
  exposedPanelColumns = sp.panelColumns
  openAgents = () => sp.openPanel('agents', { focus: true })
  const [, bump] = React.useState(0)
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    sp.handleKey(input, key as never)
    bump(previous => previous + 1)
  })
  const chatWidth = sp.split ? sp.chatColumns : COLS - 1
  const anchors = Array.from({ length: CHAT_ROWS }, (_, i) => 'R' + String(i).padStart(2, '0') + ' ' + '·'.repeat(Math.max(0, chatWidth - 4)))
  return (
    <Box width={COLS} height={ROWS} flexDirection="row">
      <SidePanelLayout
        geometry={sp.geometry}
        focus={sp.focus}
        onActivateChat={sp.focusChat}
        onActivatePanel={sp.focusPanel}
        side={
          <SidePanelColumn
            width={sp.panelColumns}
            controller={sp}
            channel={channel as never}
          />
        }
      >
        <ScrollBox ref={chatScrollRef} flexDirection="column" flexShrink={0} height={ROWS}>
          {anchors.map((line, i) => <Text key={i}>{line}</Text>)}
        </ScrollBox>
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
const stdin = new FakeStdin()
const app = await render(
  <AlternateScreen mouseTracking={true}>
    <ThemeProvider theme="dark">
      <Harness />
    </ThemeProvider>
  </AlternateScreen>,
  {
    stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

function rawLines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(buf.baseY + y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
const has = (needle: string): boolean => rawLines().some(l => l.includes(needle))
const hasAgent = (id: string): boolean => rawLines().some(line => new RegExp('\\b' + id + '\\b').test(line))
const dividerCol = (): number => exposedChatColumns
/** '' when every divider cell is the expected glyph; else a row:got!=want list. */
function dividerReport(): string {
  const col = dividerCol()
  const bad: string[] = []
  const lines = rawLines()
  for (let y = 0; y < ROWS; y += 1) {
    const want = y === 1 || y === ROWS - 2 ? '├' : '│'
    const got = lines[y]![col] ?? ' '
    if (got !== want) bad.push(y + ':' + JSON.stringify(got) + '!=' + want)
  }
  return bad.join(' ')
}
const chatRegion = (): string[] => rawLines().map(l => l.slice(0, dividerCol()))
const panelRegion = (): string[] => rawLines().map(l => l.slice(dividerCol() + 1))
/** The scrolling chat column keeps strictly ordered unique anchors (a
 * full-width row shift would displace/duplicate/blank them). */
function anchorsOrdered(): { ok: boolean; detail: string } {
  const seen: number[] = []
  for (const line of chatRegion()) {
    const m = /^R(\d\d)/.exec(line)
    if (m) seen.push(Number(m[1]))
  }
  for (let i = 1; i < seen.length; i += 1) {
    if (seen[i]! <= seen[i - 1]!) return { ok: false, detail: 'order ' + seen.join(',') }
  }
  if (new Set(seen).size !== seen.length) return { ok: false, detail: 'dup ' + seen.join(',') }
  return { ok: true, detail: seen.join(',') }
}
const writeKey = async (data: string): Promise<void> => {
  stdin.write(data)
  await new Promise(resolve => setImmediate(resolve))
}
// SGR 1-indexed: 64 = wheel up, 65 = wheel down.
const wheelUp = (c: number, r: number) => stdin.write('\x1b[<64;' + (c + 1) + ';' + (r + 1) + 'M')
const wheelDown = (c: number, r: number) => stdin.write('\x1b[<65;' + (c + 1) + ';' + (r + 1) + 'M')

function dumpScreen(tag: string): void {
  console.error('---- screen dump: ' + tag + ' (divider col=' + dividerCol() + ') ----')
  console.error(rawLines().map((l, i) => String(i).padStart(2, '0') + '|' + l.replace(/ +$/, '')).join('\n'))
  console.error('---- divider: ' + (dividerReport() || 'ok') + ' ----')
}

try {
  await settled(() => hasAgent('AAA1') && has('R00'))
  openAgents?.()
  await settled(() => hasAgent('AAA1') && has('Agents'))
  check('boot: agents panel active with the roster', hasAgent('AAA1') && hasAgent('AAA2'), 'panel=' + exposedPanelColumns + ' chat=' + exposedChatColumns)
  check('boot: divider intact before any scroll', dividerReport() === '', dividerReport())

  let chatBase = chatRegion()
  let panelBase = panelRegion()

  const assertChatUntouched = (tag: string): void => {
    const now = chatRegion()
    const diffs: string[] = []
    for (let y = 0; y < ROWS; y += 1) if (now[y] !== chatBase[y]) diffs.push(y + ': ' + JSON.stringify(chatBase[y]!.slice(0, 12)) + ' -> ' + JSON.stringify(now[y]!.slice(0, 12)))
    check(tag + ': chat column untouched', diffs.length === 0, diffs.slice(0, 4).join(' | '))
    check(tag + ': divider column intact', dividerReport() === '', dividerReport())
  }
  const assertPanelUntouched = (tag: string): void => {
    const now = panelRegion()
    const diffs: string[] = []
    for (let y = 0; y < ROWS; y += 1) if (now[y].trimEnd() !== panelBase[y].trimEnd()) diffs.push(y + ': ' + JSON.stringify(panelBase[y]!.trimEnd().slice(-24)) + ' -> ' + JSON.stringify(now[y]!.trimEnd().slice(-24)))
    check(tag + ': panel column untouched', diffs.length === 0, diffs.slice(0, 4).join(' | '))
    check(tag + ': divider column intact', dividerReport() === '', dividerReport())
  }

  // --- 1. arrow keys scroll the panel --------------------------------------
  for (let step = 1; step <= 4; step += 1) {
    await writeKey('\x1b[B')
    await sleep(90) // 固定窗:pacing 每步滚动后的排水/渲染窗口，连续按键不能同 tick 合并
    assertChatUntouched('down #' + step)
  }
  check('keys: the panel list actually scrolled down', !hasAgent('AAA1'), (rawLines().find(l => l.includes('AAA')) ?? '').trim())
  const orderDown = anchorsOrdered()
  check('keys: chat anchors ordered/unique after downs', orderDown.ok, orderDown.detail)

  for (let step = 1; step <= 2; step += 1) {
    await writeKey('\x1b[A')
    await sleep(90) // 固定窗:pacing 同上
    assertChatUntouched('up #' + step)
  }

  // --- 2. wheel scroll over the panel list ----------------------------------
  chatBase = chatRegion()
  const panelCell = (() => {
    const lines = rawLines()
    for (let y = 0; y < ROWS; y += 1) {
      const col = lines[y]!.indexOf('AAA3')
      if (col >= 0) return { col, row: y }
    }
    return { col: dividerCol() + 4, row: 10 }
  })()
  for (let step = 1; step <= 3; step += 1) {
    wheelDown(panelCell.col, panelCell.row)
    await sleep(90) // 固定窗:pacing 滑轮步间等待，避免同一 stdin 批次合并
    assertChatUntouched('wheel-down #' + step)
  }
  const firstCardAfterDowns = (rawLines().find(l => l.includes('AAA')) ?? '').trim()
  check('wheel: the panel list scrolled (AAA1 gone)', !hasAgent('AAA1'), firstCardAfterDowns)
  const orderWheel = anchorsOrdered()
  check('wheel: chat anchors ordered/unique', orderWheel.ok, orderWheel.detail)

  for (let step = 1; step <= 3; step += 1) {
    wheelUp(panelCell.col, panelCell.row)
    await sleep(90) // 固定窗:pacing 同上
    check('wheel-up #' + step + ': divider column intact', dividerReport() === '', dividerReport())
  }
  // Scroll rebound is clamped by maxScroll (overscrolled downs mean the ups
  // do not return to the exact base): assert the list moved back up at all.
  const firstCardAfterUps = (rawLines().find(l => l.includes('AAA')) ?? '').trim()
  check('wheel: the panel scrolled back up', firstCardAfterUps !== '' && firstCardAfterUps !== firstCardAfterDowns,
    firstCardAfterDowns + ' -> ' + firstCardAfterUps)

  // --- 3. wheel over the CHAT column: the seam must survive the reverse ----
  // The panel scrolled during section 2, so its baseline is re-snapshotted
  // here: this section asserts "scrolling chat must not move the panel",
  // not "the panel never changes".
  panelBase = panelRegion()
  const chatCell = { col: 4, row: 12 }
  for (let step = 1; step <= 3; step += 1) {
    wheelDown(chatCell.col, chatCell.row)
    await sleep(90) // 固定窗:pacing 同上
    assertPanelUntouched('chat wheel-down #' + step)
    const ord = anchorsOrdered()
    check('chat wheel-down #' + step + ': chat anchors ordered/unique', ord.ok, ord.detail)
  }
  check('chat wheel: the chat list actually scrolled',
    (chatScrollRef.current?.getScrollTop() ?? 0) > 0 && !chatRegion().some(l => l.startsWith('R00')),
    'scrollTop=' + String(chatScrollRef.current?.getScrollTop() ?? -1))
} finally {
  if (failed > 0) dumpScreen('final')
  await app.unmount()
  term.dispose()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: side panel scroll paint all checks passed.')
process.exit(0)
