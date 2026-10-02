/**
 * Side-panel registry smoke: the builtin registrations and the ⤢ capability
 * bit, driven through the REAL PanelHost (not the panel components in
 * isolation) — the panel family's own probes mount one component each, so
 * nothing else catches a missing registration, a wrong icon (the bar's width
 * budget assumes one cell per icon) or a capability bit that never reaches
 * the bar.
 *
 * Locked behavior:
 *  r. every builtin panel is registered with a single-cell icon, and the
 *     fullscreen capability is set exactly where a fullscreen form exists;
 *  c. mounting the column with 'todo,info,trajectory' renders those three
 *     tabs, clicking the ⓘ tab swaps the column to the info readout,
 *     clicking ∿ swaps it to the trajectory panel (empty state without a
 *     build), and ⤢ shows up only while a fullscreen-capable panel is active.
 *
 * Run: node --import tsx/esm scripts/verify-side-panel-registry.tsx
 */
export {}

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, { panelStore }, prefs, { t }, { stringWidth }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('../src/ink/stringWidth.js'),
  import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelPanels, applySidePanelRatio } = prefs
const { settled, viewportLines } = termTest

const COLS = 120
// Tall enough that the whole info readout fits without scrolling: this probe
// asserts on rows in the LAST section, and a shorter column would push them
// out of the viewport (the panel's own scroll behavior is covered by
// verify-info-panel with its own scroll assertions).
const ROWS = 34

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// ── r. registry contract ────────────────────────────────────────────────────
const EXPECTED: readonly { id: string; icon: string; fullscreen: boolean }[] = [
  { id: 'todo', icon: '≡', fullscreen: false },
  { id: 'info', icon: 'ⓘ', fullscreen: false },
  { id: 'trajectory', icon: '∿', fullscreen: true },
  { id: 'jobs', icon: '▸', fullscreen: true },
  { id: 'agents', icon: '◆', fullscreen: true },
  { id: 'workspace', icon: '⌗', fullscreen: true },
  { id: 'companion', icon: '♥', fullscreen: false },
]
// Importing the column module runs registerBuiltinPanels(); give it a tick.
await new Promise(resolve => setTimeout(resolve, 0))
const registry = panelStore.list()
for (const expected of EXPECTED) {
  const entry = registry.find(candidate => candidate.definition.id === expected.id)
  check('r registry: ' + expected.id + ' is registered', entry !== undefined)
  if (entry === undefined) continue
  const icon = entry.definition.icon ?? ''
  check('r registry: ' + expected.id + ' has a single-cell icon', stringWidth(icon) === 1 && icon === expected.icon, icon)
  const fullscreen = entry.definition.capabilities?.fullscreen === true
  check('r registry: ' + expected.id + ' fullscreen=' + expected.fullscreen, fullscreen === expected.fullscreen)
}

// ── c. mount through the real host ──────────────────────────────────────────
// Field set mirrors verify-info-panel's stub: the info readout derives every
// value through the status-line helpers, so a thin stub would make it render
// its error card instead of its rows (and the assertions below vacuous).
const channelStub: unknown = {
  version: 0, rows: [], status: 'idle', working: false, todos: [], subagents: [], goal: undefined,
  displayCwd: '/tmp/demo', gitBranch: 'main', sessionTitle: 'registry',
  sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab', agentId: 'registry-agent',
  model: 'deepseek-chat-v4', reasoningEffort: 'high', mode: { plan: false },
  tokens: { input: 12_345, output: 678, cacheRead: 4_000, cacheWrite: 200 },
  contextSegments: { system: 900, prompt: 1_200, assistant: 3_000, thinking: 400, tools: 800 },
  contextWindow: 128_000,
  lastUsage: { input: 12_000, output: 500, cacheRead: 60_000, cacheWrite: 1_000 },
  tps: 37.4,
  tpsSamples: [{ tps: 30, at: Date.now() }, { tps: 44, at: Date.now() }],
  subscribe() { return () => {} },
  notify() {},
  listWorkspaceRegistry: () => Promise.resolve([]),
}

function Harness(): React.ReactNode {
  const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
  useInput(() => {}, { isActive: true })
  return (
    <SidePanelLayout
      geometry={sp.geometry}
      focus={sp.focus}
      side={<SidePanelColumn width={sp.panelColumns} controller={sp} channel={channelStub as never} onExpand={() => {}} />}
    >
      <Box flexDirection="column"><Text>{'chat-body'}</Text></Box>
    </SidePanelLayout>
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
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean) { this.isRaw = next; return this }
  setEncoding() { return this }
  ref() { return this }
  unref() { return this }
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdin = new FakeStdin()
const has = (s: string): boolean => viewportLines(term, ROWS).some(line => line.includes(s))
const findText = (s: string): { col: number; row: number } | null => {
  const view = viewportLines(term, ROWS)
  for (let row = 0; row < view.length; row++) {
    const col = view[row]!.indexOf(s)
    if (col >= 0) return { col, row }
  }
  return null
}
const click = (c: number, r: number) => {
  stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'M')
  stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'm')
}

applySidePanelRatio(0.68)
applySidePanelPanels('todo,info,trajectory')
applySidePanelOpen(true)

const app = await render(
  <AlternateScreen>
    <Harness />
  </AlternateScreen>,
  {
    stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

try {
  check('c mount: todo is the active capsule', await settled(() => has('‹ Todo ›'), { timeoutMs: 4000 }))
  check('c mount: the three enabled tabs are drawn', has('ⓘ') && has('∿'))
  check('c mount: no ⤢ while a fullscreen-less panel is active', !has('⤢'))

  const infoTab = findText('ⓘ')
  if (infoTab !== null) click(infoTab.col, infoTab.row)
  check('c info: capsule switched', await settled(() => has('‹ Info ›'), { timeoutMs: 4000 }))
  // Labels come from i18n so a copy change cannot make this silently vacuous.
  check('c info: session section rendered', await settled(() => has(t('info-section-session')), { timeoutMs: 4000 }))
  check('c info: cache row rendered', has(t('info-row-cache')))
  check('c info: working dir row rendered', has(t('info-row-cwd')))
  check('c info: still no ⤢ (no fullscreen form)', !has('⤢'))

  const trajTab = findText('∿')
  if (trajTab !== null) click(trajTab.col, trajTab.row)
  check('c trajectory: capsule switched', await settled(() => has('‹ Trajectory ›'), { timeoutMs: 4000 }))
  check('c trajectory: empty state without a build', await settled(() => has(t('panel-trajectory-empty').slice(0, 24)), { timeoutMs: 4000 }))
  check('c trajectory: ⤢ appears (declares capabilities.fullscreen)', has('⤢'))
} finally {
  await app.unmount()
}

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
