/**
 * Divider resize regression: real SGR press/motion/release through Ink and
 * headless xterm, with PageMargin. Locks captured motion across both columns,
 * cell-exact widths and both minimums, zoom/focus, release/focus-loss/resize
 * cleanup, collapsed/inline fallback, selection compatibility, and Chat wiring
 * with an unsent draft. No backend requests.
 *
 * Run: node --import tsx/esm scripts/verify-side-panel-resize.tsx
 */
export {}
import './lib/fake-home.mjs'
import type { SidePanelController } from '../src/components/sidePanel/useSidePanel.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

const [
  assert, { PassThrough, Writable }, React, { Terminal: XTerm }, ui,
  { PageMargin }, { SidePanelLayout }, { useSidePanel }, prefs,
  { default: instances }, { hasSelection }, { Chat }, { QuestionStore }, termTest,
] = await Promise.all([
  import('node:assert/strict'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PageMargin.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/selection.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, ThemeProvider, Box, Text, useTerminalSize, useInput } = ui
const { applyPageMargin, applySidePanelOpen, applySidePanelRatio, applySidePanelPanels, getSidePanelRatio } = prefs
const { settled, sleep, viewportLines } = termTest
const ROWS = 24
const INSET = 2
const POINTER_ROW = 6

function check(name: string, ok: boolean, detail = ''): void {
  assert.default.ok(ok, name + (detail ? '\n' + detail : ''))
  console.log('PASS: ' + name)
}

function Harness({ report, editorOpen = false, covered = false }: {
  readonly report: (controller: SidePanelController) => void
  readonly editorOpen?: boolean
  readonly covered?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const sp = useSidePanel({ columns, fullscreen: true, editorOpen })
  report(sp)
  useInput((input, key, event) => { sp.handleKey(input, key, event) })
  if (covered) return <Text>fullscreen scene</Text>
  return (
    <SidePanelLayout
      geometry={sp.geometry}
      focus={sp.focus}
      onActivateChat={sp.focusChat}
      onActivatePanel={sp.focusPanel}
      onResize={sp.resize}
      side={<Box flexDirection="column" flexGrow={1}><Text>{'panel ' + sp.panelColumns}</Text></Box>}
    >
      <Box flexDirection="column" flexGrow={1}>
        <Text>{'chat ' + sp.chatColumns}</Text>
        <Box flexGrow={1} />
        <Box borderStyle="single" flexShrink={0}><Text>input draft</Text></Box>
        <Text>status ready</Text>
      </Box>
    </SidePanelLayout>
  )
}

class FakeStdout extends Writable {
  isTTY = true
  rows = ROWS
  constructor(readonly term: import('@xterm/headless').Terminal, public columns: number) { super() }
  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  override setEncoding(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
class FakeStderr extends Writable {
  isTTY = true
  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
}

const channelStub = {
  version: 0, rows: [], status: 'idle', working: false, whaleIdle: false,
  sessionTitle: 'divider-resize', sessionId: 'resize-session', agentId: 'resize-agent',
  model: 'deepseek-chat-v4', reasoningEffort: 'high', mode: { plan: false },
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000,
  cwd: '/tmp', displayCwd: '/tmp', gitBranch: 'main',
  pending: [], commandList: [], notifications: [], todos: [], subagents: [], backgroundJobs: [],
  spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: Date.now(), lastUserText: '',
  subscribe: () => () => {}, submit: () => {}, cancel: () => {}, clear: () => {}, steer: () => {},
  interruptAndDeliver: () => 0, removePending: () => true, cycleMode: async () => {},
  listFiles: async () => [], listModels: async () => [], listSessions: () => [],
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], notify: () => {},
  listWorkspaceRegistry: async () => [],
}

async function mount({ columns = 124, chat = false, fullscreen = true } = {}) {
  applyPageMargin('normal')
  applySidePanelRatio(0.68)
  applySidePanelPanels('todo')
  applySidePanelOpen(true)
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 100, allowProposedApi: true })
  const stdout = new FakeStdout(term, columns)
  const stdin = new FakeStdin()
  let controller: SidePanelController | undefined
  const tree = (editorOpen = false, covered = false): React.ReactNode => {
    const body = (
      <ThemeProvider theme="dark">
        <PageMargin>
          {chat
            ? <Chat fullscreen={fullscreen} channel={channelStub as unknown as React.ComponentProps<typeof Chat>['channel']} questionStore={new QuestionStore()} onExit={() => {}} />
            : <Harness editorOpen={editorOpen} covered={covered} report={next => { controller = next }} />}
        </PageMargin>
      </ThemeProvider>
    )
    return fullscreen ? <AlternateScreen>{body}</AlternateScreen> : body
  }
  const app = await render(tree(), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  const cell = (col: number, row: number) => term.buffer.active.getLine(term.buffer.active.baseY + row)?.getCell(col)
  const frameAt = (chatWidth: number): boolean => {
    for (let row = 0; row < ROWS - 2; row += 1) {
      const glyph = row === 1 || row === ROWS - 4 ? '├' : '│'
      if (cell(INSET + chatWidth, 1 + row)?.getChars() !== glyph) return false
    }
    // The fixture body is blank: an old divider left behind by the diff
    // would produce a second glyph on this row.
    return chat || viewportLines(term)[POINTER_ROW]?.trimEnd() === ' '.repeat(INSET + chatWidth) + '│'
  }
  const mouse = (button: number, col: number, row = POINTER_ROW, suffix = 'M') =>
    stdin.write('\x1b[<' + button + ';' + (col + 1) + ';' + (row + 1) + suffix)
  return {
    app, stdin, stdout, term, tree, cell, frameAt,
    controller: () => controller!,
    press: (col: number, row = POINTER_ROW) => mouse(0, col, row),
    motion: (col: number, row = POINTER_ROW) => mouse(32, col, row),
    release: (col: number, row = POINTER_ROW) => mouse(0, col, row, 'm'),
    hover: (col: number, row = POINTER_ROW) => mouse(35, col, row),
    lines: () => viewportLines(term),
    resize: (width: number) => { term.resize(width, ROWS); stdout.columns = width; stdout.emit('resize') },
    async close() { await app.unmount(); term.dispose() },
  }
}

const s = await mount()
try {
  check('boot: 120 content columns split 81/38 inside page margins', await settled(() => s.frameAt(81)))
  const inactive = s.cell(83, POINTER_ROW)?.getFgColor()
  s.hover(83)
  check('hover brightens the draggable divider', await settled(() => s.cell(83, POINTER_ROW)?.getFgColor() !== inactive))
  s.hover(20)
  check('leaving restores the divider color', await settled(() => s.cell(83, POINTER_ROW)?.getFgColor() === inactive))
  const beforeClick = getSidePanelRatio()
  s.press(83); s.release(83)
  await sleep(80) // 固定窗:探针 单击不能调整宽度或抢走聊天焦点
  check('plain divider click keeps width and chat focus', getSidePanelRatio() === beforeClick && s.controller().focus === 'chat')

  s.press(83)
  s.motion(75)
  check('drag left widens the panel immediately, without a page-inset jump', await settled(() => s.frameAt(73) && s.controller().panelColumns === 46), JSON.stringify(s.lines().slice(0, 8)))
  s.motion(70, POINTER_ROW + 3)
  check('captured motion outside the divider uses the press width', await settled(() => s.frameAt(68)))
  s.motion(83)
  check('returning to the press cell restores the width before release', await settled(() => s.frameAt(81)))
  const ink = instances.get(s.stdout as unknown as NodeJS.WriteStream)!
  check('resize does not start a text selection', !hasSelection(ink.selection) && !ink.selection.isDragging)
  s.motion(4)
  check('left edge clamps chat at 64 columns', await settled(() => s.frameAt(64) && s.controller().panelColumns === 55))
  s.motion(76)
  check('reversing after clamping resumes at the pointer', await settled(() => s.frameAt(74)))
  s.motion(123)
  check('right edge clamps the panel at 28 columns', await settled(() => s.frameAt(91) && s.controller().panelColumns === 28))
  s.motion(78); s.motion(79); s.motion(80)
  check('batched motions do not accumulate a resize offset', await settled(() => s.frameAt(78)))
  s.release(82)
  check('release applies its final column and keeps chat focus', await settled(() => s.frameAt(80) && s.controller().focus === 'chat'))
  s.motion(72)
  await sleep(80) // 固定窗:探针 松手后的孤立 motion 不能继续调宽
  check('motion after release leaves the width fixed', s.frameAt(80))

  s.press(90, 2); s.release(90, 2)
  check('panel can still take focus by click', await settled(() => s.controller().focus === 'panel'))
  s.press(82); s.motion(76)
  check('resize also preserves panel focus', await settled(() => s.frameAt(74) && s.controller().focus === 'panel'))
  s.stdin.write('\x1b[O')
  s.motion(70)
  await sleep(80) // 固定窗:探针 focus-out 必须终止捕获，不让后续 motion 改宽度
  check('focus loss ends resizing', s.frameAt(74))
  s.stdin.write('\x1b[I')
  s.release(70)
  s.stdin.write('z')
  check('zoom starts at the visible minimum chat width', await settled(() => s.frameAt(64) && s.controller().zoom))
  s.press(66); s.motion(70); s.release(70)
  check('drag exits zoom from its displayed width, without jumping to the saved ratio', await settled(() => s.frameAt(68) && !s.controller().zoom))

  s.press(70); s.motion(75)
  check('drag before terminal resize is active', await settled(() => s.frameAt(73)))
  const beforeResize = getSidePanelRatio()
  s.resize(100)
  check('terminal resize recomputes the legal split', await settled(() => s.frameAt(64) && s.controller().panelColumns === 31))
  s.motion(90); s.release(90)
  await sleep(80) // 固定窗:探针 终端 resize 已结束旧手势，不能用旧按下坐标再次调宽
  check('terminal resize cancels the captured gesture', getSidePanelRatio() === beforeResize)
  s.resize(124)
  check('expanding restores the resized ratio', await settled(() => s.frameAt(73)))

  s.press(75); s.motion(73)
  check('drag before collapse is active', await settled(() => s.frameAt(71)))
  applySidePanelOpen(false)
  check('closed sidebar gives the full width back to chat', await settled(() => !s.controller().split && s.controller().chatColumns === 120))
  const beforeClose = getSidePanelRatio()
  s.motion(60); s.release(60)
  await sleep(80) // 固定窗:探针 已卸载分隔线的捕获事件不能改隐藏侧栏的比例
  check('captured events after closing are ignored', getSidePanelRatio() === beforeClose)
  applySidePanelOpen(true)
  check('reopening keeps the last width', await settled(() => s.frameAt(71)))
  s.press(73); s.motion(71)
  check('drag before editor is active', await settled(() => s.frameAt(69)))
  await s.app.rerender(s.tree(true))
  check('editor collapses the sidebar', await settled(() => !s.controller().split))
  const beforeEditor = getSidePanelRatio()
  s.motion(60); s.release(60)
  await sleep(80) // 固定窗:探针 编辑器覆盖侧栏后，旧捕获事件不能再改比例
  check('captured events while editing are ignored', getSidePanelRatio() === beforeEditor)
  await s.app.rerender(s.tree())
  check('leaving editor restores the resized split', await settled(() => s.frameAt(69)))

  s.press(71); s.motion(69)
  check('drag before a fullscreen scene is active', await settled(() => s.frameAt(67)))
  await s.app.rerender(s.tree(false, true))
  check('fullscreen scene removes the layout while keeping the controller', await settled(() => s.lines().some(line => line.includes('fullscreen scene')) && s.controller().split))
  const beforeScene = getSidePanelRatio()
  s.motion(60); s.release(60)
  await sleep(80) // 固定窗:探针 换屏卸载布局时控制器仍可分栏，旧捕获事件不能再改宽度
  check('removed divider stops resizing behind a fullscreen scene', getSidePanelRatio() === beforeScene)
  await s.app.rerender(s.tree())
  check('returning from a fullscreen scene keeps the last width', await settled(() => s.frameAt(67)))
  s.press(69)
  await s.app.rerender(s.tree(false, true))
  check('scene can also interrupt a press before its first motion', await settled(() => s.lines().some(line => line.includes('fullscreen scene'))))
  s.motion(79); s.release(79)
  await sleep(80) // 固定窗:探针 未起拖的已卸载目标也不能在后续 motion 上重新开始调宽
  check('removed divider cannot start a delayed drag', getSidePanelRatio() === beforeScene)
  await s.app.rerender(s.tree())
  check('scene return restores the untouched split', await settled(() => s.frameAt(67)))

  s.resize(135)
  check('ratio follows the wider terminal', await settled(() => s.frameAt(73)))
  s.press(75); s.motion(85); s.release(85)
  check('83 cells at 131 columns do not round down to 82', await settled(() => s.frameAt(83)))
  s.resize(97)
  check('minimum split width is 64/28', await settled(() => s.frameAt(64) && s.controller().panelColumns === 28))
  s.press(66); s.motion(10); s.motion(96); s.release(96)
  await sleep(80) // 固定窗:探针 93 列边界没有可调空间，两侧都必须保持最小宽度
  check('drag at the minimum cannot squeeze either surface', s.frameAt(64) && s.controller().panelColumns === 28)
  s.resize(96)
  check('below the split threshold the divider disappears', await settled(() => !s.controller().split && s.controller().chatColumns === 92))
} finally {
  await s.close()
}

const chat = await mount({ chat: true })
try {
  check('real Chat renders the draggable seam', await settled(() => chat.frameAt(81)))
  chat.stdin.write('keep-this-draft')
  check('real Chat accepts an unsent draft', await settled(() => chat.lines().some(line => line.includes('keep-this-draft'))))
  chat.press(83); chat.motion(78); chat.release(78)
  check('real Chat wires dragging and preserves its unsent draft', await settled(() => chat.frameAt(76) && chat.lines().some(line => line.includes('keep-this-draft'))))
} finally {
  await chat.close()
}

const inline = await mount({ chat: true, fullscreen: false })
try {
  inline.stdin.write('inline-draft')
  check('inline Chat still accepts input', await settled(() => inline.lines().some(line => line.includes('inline-draft'))))
  check('inline Chat has no side-panel seam', !inline.frameAt(81))
} finally {
  await inline.close()
}

console.log('OK: side-panel drag resize checks passed.')
process.exit(0)
