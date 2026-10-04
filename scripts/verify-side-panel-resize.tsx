/**
 * Divider resize regression using real terminal mouse reports, the actual
 * side-panel controller, page margins and the renderer's captured drag.
 * Covers both bounds, returning from a bound, zoom, keyboard resize,
 * interrupted gestures, collapse/reopen, and chat state preservation.
 * Run with node --import tsx/esm and this script's absolute path.
 */
export {}
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [assertMod, streams, React, xterm, ui, layout, controller, page, prefs, termTest, instancesMod] = await Promise.all([
  import('node:assert/strict'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/components/PageMargin.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/instances.js'),
])
const assert = assertMod.default
const { PassThrough, Writable } = streams
const { Box, Text, ScrollBox, render, AlternateScreen, ThemeProvider, useInput, useTerminalSize } = ui
const { SidePanelLayout } = layout
const { useSidePanel } = controller
const { PageMargin } = page
const { settled, sleep, viewportLines } = termTest

const ROWS = 20
const INSET = 3
let sp: ReturnType<typeof useSidePanel>
let mounts = 0
let unmounts = 0
let chatKeys = 0
let editorOpen = false
let fullscreen = true
let scroll: import('../src/ui.js').ScrollBoxHandle | null = null
const captureScroll = (handle: import('../src/ui.js').ScrollBoxHandle | null): void => { scroll = handle }

function ChatFixture(): React.ReactNode {
  const [draft, setDraft] = React.useState('draft')
  const size = useTerminalSize()
  React.useEffect(() => {
    mounts++
    return () => { unmounts++ }
  }, [])
  useInput((input, key) => {
    if (sp.handleKey(input, key)) return
    if (input === 'x') {
      chatKeys++
      setDraft(previous => previous + input)
    }
  })
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text>{'chat-selectable'}</Text>
      <ScrollBox ref={captureScroll} flexDirection="column" flexGrow={1} flexShrink={1}>
        {Array.from({ length: 50 }, (_, index) => <Text key={index}>{`history-row-${index}`}</Text>)}
      </ScrollBox>
      <Box borderStyle="single" flexShrink={0}><Text>{draft}</Text></Box>
      <Text>{`width=${size.columns}`}</Text>
    </Box>
  )
}

function Harness(): React.ReactNode {
  const size = useTerminalSize()
  sp = useSidePanel({ columns: size.columns, fullscreen, editorOpen })
  return (
    <SidePanelLayout
      geometry={sp.geometry}
      focus={sp.focus}
      onResize={sp.resize}
      onActivateChat={sp.focusChat}
      onActivatePanel={sp.focusPanel}
      side={<Box flexDirection="column"><Text>{'panel-selectable'}</Text></Box>}
    >
      <ChatFixture />
    </SidePanelLayout>
  )
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class FakeStdout extends Writable {
  isTTY = true
  columns = 144
  rows = ROWS
  constructor(readonly term: import('@xterm/headless').Terminal) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    this.term.write(String(chunk), done)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}

const term = new xterm.Terminal({ cols: 144, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()
prefs.applyPageMargin('3x1')
prefs.applySidePanelSplitEnabled(true)
prefs.applySidePanelOpen(true)
prefs.applySidePanelRatio(0.68)
const tree = () => (
  <AlternateScreen><ThemeProvider theme="dark"><PageMargin><Harness /></PageMargin></ThemeProvider></AlternateScreen>
)
const app = await render(tree(), {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
const ink = instancesMod.default.get(stdout as unknown as NodeJS.WriteStream)!
const lines = () => viewportLines(term, stdout.rows)
const cell = (col: number, row = 5) => term.buffer.active.getLine(row)?.getCell(col)
const seam = () => INSET + sp.chatColumns
const mouse = (button: number, col: number, end = 'M', row = 5) => {
  stdin.write(`\x1b[<${button};${col + 1};${row + 1}${end}`)
}
const press = (col: number) => mouse(0, col)
const move = (col: number) => mouse(32, col)
const release = (col: number) => mouse(0, col, 'm')
let checks = 0
async function check(name: string, predicate: () => boolean): Promise<void> {
  assert.ok(await settled(predicate), name + ': ' + JSON.stringify({ geometry: sp.geometry, lines: lines() }))
  console.log('PASS: ' + name)
  checks++
}
async function width(chat: number): Promise<void> {
  await check(`chat width ${chat}, divider at column ${INSET + chat}`, () =>
    sp.chatColumns === chat && cell(INSET + chat)?.getChars() === '│' && lines().some(line => line.includes(`width=${chat}`)),
  )
}
async function resizeTerminal(cols: number): Promise<void> {
  term.resize(cols, stdout.rows)
  stdout.columns = cols
  stdout.emit('resize')
}

try {
  await width(93)
  stdin.write('x')
  await check('draft is editable before dragging', () => lines().some(line => line.includes('draftx')))
  scroll?.scrollTo(8)
  await check('chat history is scrolled before dragging', () => scroll?.getScrollTop() === 8 && lines().some(line => line.includes('history-row-8')))
  mouse(35, seam())
  await check('divider highlights on hover', () => Boolean(cell(seam())?.isBold()))
  const beforeClick = prefs.getSidePanelRatio()
  press(seam())
  release(seam())
  await sleep(100) // 固定窗:探针 原地点击不得改变比例或焦点
  assert.equal(prefs.getSidePanelRatio(), beforeClick)
  assert.equal(sp.focus, 'chat')

  const origin = seam()
  press(origin)
  move(origin - 8)
  await width(85)
  move(origin - 15)
  await width(78)
  assert.equal(ink.selection.isDragging, false, 'divider drag must not start text selection')
  move(0)
  await width(64)
  assert.equal(sp.panelColumns, 73)
  move(143)
  await width(109)
  assert.equal(sp.panelColumns, 28)
  move(origin + 6)
  await width(99)
  move(origin)
  await width(93)
  move(origin + 6)
  await width(99)
  release(origin + 6)
  await check('release clears drag highlighting and retains chat focus', () => !cell(seam())?.isBold() && sp.focus === 'chat')
  assert.equal(mounts, 1)
  assert.equal(unmounts, 0)
  assert.equal(chatKeys, 1, 'mouse reports must not become chat text')
  assert.ok(lines().some(line => line.includes('draftx')))
  assert.equal(scroll?.getScrollTop(), 8, 'divider drag must preserve history position')

  // A modified gesture stays in the renderer's text-selection path.
  const beforeModified = prefs.getSidePanelRatio()
  mouse(4, seam())
  mouse(36, seam() - 8)
  mouse(4, seam() - 8, 'm')
  await sleep(100) // 固定窗:探针 Shift 拖动不得触发分隔线调宽
  assert.equal(prefs.getSidePanelRatio(), beforeModified)

  sp.focusPanel()
  await check('panel focus is active', () => sp.focus === 'panel')
  sp.toggleZoom()
  await width(64)
  const zoomOrigin = seam()
  press(zoomOrigin)
  move(zoomOrigin + 9)
  await width(73)
  release(zoomOrigin + 9)
  assert.equal(sp.zoom, false, 'drag must resize from visible zoom geometry')
  assert.equal(sp.focus, 'panel', 'drag must preserve panel focus')
  stdin.write('+')
  await width(69)
  stdin.write('-')
  await width(73)

  // Focus loss and terminal resize end the captured gesture; later motion
  // without a new press must never keep resizing.
  let start = seam()
  press(start)
  move(start + 4)
  await width(77)
  stdin.write('\x1b[O')
  await check('focus loss clears divider highlighting', () => !cell(seam())?.isBold())
  const beforeFocusMotion = prefs.getSidePanelRatio()
  stdin.write('\x1b[I')
  move(start + 10)
  release(start + 10)
  await sleep(100) // 固定窗:探针 焦点丢失后的孤立移动不得继续调宽
  assert.equal(prefs.getSidePanelRatio(), beforeFocusMotion)

  start = seam()
  press(start)
  move(start + 3)
  await width(80)
  const resizedRatio = prefs.getSidePanelRatio()
  await resizeTerminal(106)
  await width(64)
  assert.equal(prefs.getSidePanelRatio(), resizedRatio, 'resize cleanup must not rewrite ratio')
  move(start + 20)
  release(start + 20)
  await sleep(100) // 固定窗:探针 窗口缩放后的孤立移动不得继续调宽
  assert.equal(prefs.getSidePanelRatio(), resizedRatio)

  await resizeTerminal(98)
  await check('narrow terminal collapses the side panel', () => !sp.split && lines().some(line => line.includes('width=92')))
  await resizeTerminal(144)
  await width(80)
  prefs.applySidePanelOpen(false)
  await check('closing restores full chat width', () => !sp.split && lines().some(line => line.includes('width=138')))
  prefs.applySidePanelOpen(true)
  await width(80)
  assert.equal(mounts, 1, 'resize/collapse/reopen must not remount chat')
  assert.equal(unmounts, 0)
  assert.ok(lines().some(line => line.includes('draftx')))
  assert.equal(scroll?.getScrollTop(), 8, 'collapse/reopen must preserve history position')

  editorOpen = true
  app.rerender(tree())
  await check('fullscreen draft editor suppresses the split', () => !sp.split)
  const beforeHiddenResize = prefs.getSidePanelRatio()
  sp.resize(90)
  assert.equal(prefs.getSidePanelRatio(), beforeHiddenResize)
  editorOpen = false
  fullscreen = false
  app.rerender(tree())
  await check('inline controller suppresses the split', () => !sp.split && !sp.splitAvailable)
  sp.resize(90)
  assert.equal(prefs.getSidePanelRatio(), beforeHiddenResize)
  console.log(`OK: ${checks} divider resize checks passed`)
} finally {
  await app.unmount()
  term.dispose()
}
