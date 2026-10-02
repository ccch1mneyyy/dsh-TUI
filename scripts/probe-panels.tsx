
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

const now = Date.now()
const fakeChannel = {
  version: 1,
  working: true,
  spinnerMode: 'tool-use',
  goal: { id: 'g1', phase: 'active', roundsStarted: 3, maxGoalRounds: 20, objective: '落地侧栏分栏布局与 Panel 系统' },
  todos: [
    { content: 'SidePanelLayout + dimensions + SurfaceEdges', status: 'completed' },
    { content: 'PanelStore / PanelHost / 键盘分发器', status: 'completed' },
    { content: 'todo / jobs / agents 三个 Panel 迁移', status: 'in_progress' },
    { content: 'Companion 皮肤系统与心情解析器', status: 'pending' },
  ],
  backgroundJobs: [
    { id: 'job-1', label: 'pwsh: run-ci-group channel-ui', status: 'running', command: 'node scripts/run-ci-group.mjs channel-ui', startedAt: now - 42000, outputLines: [{ text: 'render-scroll: 63/63 ✓', channel: 'log' }], progress: 'channel-ui 42/90' },
    { id: 'job-2', label: 'pwsh: verify:build', status: 'failed', command: 'node scripts/run-verify-build.mjs', startedAt: now - 300000, endedAt: now - 120000, outputLines: [{ text: 'verify:i18n ✗ 1 处失败', channel: 'stderr' }] },
    { id: 'job-3', label: 'pwsh: tsc --watch', status: 'completed', command: 'tsc --watch', startedAt: now - 3600000, endedAt: now - 3500000, outputLines: [] },
  ],
  subagents: [
    { agentId: 'agent-1', description: '勘察 Chat.tsx 集成点与键盘链', status: 'running', startedAt: now - 180000, output: [], outputEvents: [], toolCalls: [{ name: 'read' }, { name: 'grep' }, { name: 'read' }] },
    { agentId: 'agent-2', description: '实现 jobs 面板的侧栏变体与回归', status: 'completed', startedAt: now - 900000, completedAt: now - 600000, output: [], outputEvents: [], toolCalls: [{ name: 'edit' }] },
    { agentId: 'agent-3', description: 'Companion 皮肤渲染性能分析', status: 'failed', startedAt: now - 1500000, completedAt: now - 1200000, error: '渲染超时', output: [], outputEvents: [], toolCalls: [] },
  ],
  notify: () => {},
}
const fakeActivity = {
  phase: 'tool', line: '正在读取 package.json', live: true, label: '读取', detail: 'package.json',
  phrase: '⏵ 正在读取 package.json', toolCount: 3, phaseStartedAt: now - 8200, turnStartedAt: now - 30000, updatedAt: now, lang: 'zh',
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

async function scene(label, cols, rows, panelIndex, zoom) {
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
  const key = (k = {}) => ({ escape: false, leftArrow: false, rightArrow: false, ctrl: false, meta: false, shift: false, ...k })
  controller.handleKey('b', key({ ctrl: true }))
  await new Promise(r => setTimeout(r, 150))
  controller.handleKey(String(panelIndex), key())
  if (zoom) { await new Promise(r => setTimeout(r, 150)); controller.handleKey('z', key()) }
  await new Promise(r => setTimeout(r, 400))
  const { viewportLines } = await import('./lib/term-test.mjs')
  const lines = viewportLines(term, rows)
  await app.unmount()
  console.log('=== ' + label + ' ===')
  for (const line of lines) console.log('|' + line + '|')
  console.log('')
}
await scene('120x24 agents @ 38', 120, 24, 3, false)
await scene('120x24 jobs @ 38', 120, 24, 2, false)
await scene('120x24 agents @ zoom', 120, 24, 3, true)
