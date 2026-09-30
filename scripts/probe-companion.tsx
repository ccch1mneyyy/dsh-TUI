
process.env.DSH_TUI_LANG = 'zh'
process.env.FORCE_COLOR = '3'
const [{ Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/sidePanel/SidePanelLayout.js'),
    import('../src/components/sidePanel/SidePanelColumn.js'),
    import('../src/components/sidePanel/useSidePanel.js'),
    import('../src/tuiDisplayPrefs.js'),
  ])
const { render, ThemeProvider, Box, Text, AlternateScreen } = ui
prefs.applySidePanelPanels('todo,jobs,agents,companion')
prefs.applySidePanelOpen(true)

const fakeChannel = {
  version: 1,
  working: true,
  spinnerMode: 'tool-use',
  goal: undefined,
  todos: [],
  backgroundJobs: [],
  subagents: [],
}
const fakeActivity = {
  phase: 'tool', line: '正在读取 package.json', live: true, label: '读取', detail: 'package.json',
  phrase: '⏵ 正在读取 package.json', toolCount: 3, phaseStartedAt: Date.now() - 8200, turnStartedAt: Date.now() - 30000, updatedAt: Date.now(), lang: 'zh',
}

function Harness({ cols, onReady }) {
  const sidePanel = useSidePanel({ columns: cols, fullscreen: true, editorOpen: false })
  React.useEffect(() => { onReady?.(sidePanel) })
  return (
    <SidePanelLayout
      geometry={sidePanel.geometry}
      focus={sidePanel.focus}
      side={<SidePanelColumn width={sidePanel.panelColumns} controller={sidePanel} channel={fakeChannel} activity={fakeActivity} attention={{ approvals: 0, questions: 0 }} />}
    >
      <Box flexDirection="column" flexGrow={1}><Text>chat</Text></Box>
    </SidePanelLayout>
  )
}

async function scene(label, cols, rows, drive) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = cols; this.rows = rows; this.isTTY = true }
    _write(chunk, _encoding, callback) { term.write(String(chunk), callback) }
  }
  let controller
  const app = await render(
    <ThemeProvider theme="dark"><AlternateScreen><Box flexDirection="column" height={rows}><Harness cols={cols} onReady={(c) => { controller = c }} /></Box></AlternateScreen></ThemeProvider>,
    { stdout: new FakeStdout(), exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 400))
  if (drive) { await drive(() => controller, () => new Promise(r => setTimeout(r, 150))) ; await new Promise(r => setTimeout(r, 300)) }
  const { viewportLines } = await import('./lib/term-test.mjs')
  const lines = viewportLines(term, rows)
  await app.unmount()
  console.log('=== ' + label + ' ===')
  for (const line of lines) console.log('|' + line + '|')
  console.log('')
}
const key = (k = {}) => ({ escape: false, leftArrow: false, rightArrow: false, ctrl: false, meta: false, shift: false, ...k })
// 全幅 deepy：ratio 0.55 → 140 列 panel ~62
prefs.applySidePanelRatio(0.55)
await scene('140x26 companion deepy working (focus panel, tab 4)', 140, 26, async (get, tick) => {
  get().handleKey('b', key({ ctrl: true })); await tick()
  get().handleKey('4', key()); await tick()
})
// compact：120 列默认 0.68 → panel 38 < 44
prefs.applySidePanelRatio(0.68)
await scene('120x26 companion compact', 120, 26, async (get, tick) => {
  get().handleKey('b', key({ ctrl: true })); await tick()
  get().handleKey('4', key()); await tick()
})
