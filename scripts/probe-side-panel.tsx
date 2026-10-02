/**
 * Visual probe for the side panel + Panel system (not a CI gate).
 * Run: node --import tsx/esm scripts/probe-side-panel.tsx
 */
process.env.DSH_TUI_LANG = 'zh'
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, { applySidePanelOpen }] =
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

const fakeChannel = {
  goal: { id: 'g1', phase: 'active', roundsStarted: 3, maxGoalRounds: 20, objective: '落地侧栏分栏布局与 Panel 系统（含 v2.1 键盘契约修订）' },
  todos: [
    { content: 'SidePanelLayout + dimensions + SurfaceEdges', status: 'completed' },
    { content: 'PanelStore / PanelHost / 键盘分发器', status: 'completed' },
    { content: 'todo / jobs / agents 三个 Panel 迁移', status: 'in_progress' },
    { content: 'Companion 皮肤系统与心情解析器', status: 'pending' },
    { content: '插件 API ctx.tuiPanels 与授权矩阵', status: 'pending' },
    { content: '回归与文档收口', status: 'pending' },
  ],
  working: true,
}

function Harness({ cols, rows, focusWanted, zoomWanted, onReady }) {
  const sidePanel = useSidePanel({ columns: cols, fullscreen: true, editorOpen: false })
  React.useEffect(() => { onReady?.(sidePanel) })
  const chat = (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        <Text>chat line 1 — 消息内容消息内容消息内容消息内容消息内容消息内容消息内容</Text>
        <Text dimColor>chat line 2 (transcript …)</Text>
      </Box>
      <Box flexShrink={0} borderStyle="round" borderColor="accent" paddingX={1}><Text>❯ 输入框在这里</Text></Box>
      <Box flexShrink={0}><Text dimColor>status line ─ model · cwd</Text></Box>
    </Box>
  )
  return (
    <SidePanelLayout
      geometry={sidePanel.geometry}
      focus={sidePanel.focus}
      onActivateChat={sidePanel.focusChat}
      onActivatePanel={sidePanel.focusPanel}
      side={<SidePanelColumn width={sidePanel.panelColumns} controller={sidePanel} channel={fakeChannel} />}
    >
      {chat}
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
    <ThemeProvider theme="dark">
      <AlternateScreen>
        <Box flexDirection="column" height={rows}>
          <Harness cols={cols} rows={rows} onReady={(c) => { controller = c }} />
        </Box>
      </AlternateScreen>
    </ThemeProvider>,
    { stdout: new FakeStdout(), exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 250))
  if (drive) { await drive(() => controller, () => new Promise(r => setTimeout(r, 150))); await new Promise(r => setTimeout(r, 250)) }
  const { viewportLines } = await import('./lib/term-test.mjs')
  const lines = viewportLines(term, rows)
  await app.unmount()
  console.log('=== ' + label + ' ===')
  for (const line of lines) console.log('|' + line + '|')
  console.log('')
}

applySidePanelOpen(true)
const key = (k = {}) => ({ escape: false, leftArrow: false, rightArrow: false, ctrl: false, meta: false, shift: false, ...k })
await scene('120x18 focus=panel (Ctrl+B)', 120, 18, async (get) => { get().handleKey('b', key({ ctrl: true })) })
await scene('120x18 panel jobs tab (->)', 120, 18, async (get, tick) => { get().handleKey('b', key({ ctrl: true })); await tick(); get().handleKey('', key({ rightArrow: true })) })
await scene('120x18 zoom', 120, 18, async (get, tick) => { get().handleKey('b', key({ ctrl: true })); await tick(); get().handleKey('z', key()) })
