/** Real two-pane wheel regression. Run with node --import tsx/esm. */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [{ PassThrough, Writable }, React, { Terminal }, ui, instancesModule, selection, helpers] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/ink/instances.js'), import('../src/ink/selection.js'), import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, ThemeProvider, Box, Text, ScrollBox, useInput } = ui
const { settled } = helpers
const left = React.createRef<import('../src/ink/components/ScrollBox.js').ScrollBoxHandle>()
const right = React.createRef<import('../src/ink/components/ScrollBox.js').ScrollBoxHandle>()
const COLS = 100
const ROWS = 12
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class Stdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: Buffer.Encoding, cb: () => void) { term.write(String(chunk), cb) }
}
class Stdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Stderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: Buffer.Encoding, cb: () => void) { cb() }
}
const stdout = new Stdout()
const stdin = new Stdin()
function Harness(): React.ReactNode {
  useInput(() => {})
  return (
  <AlternateScreen mouseTracking>
    <ThemeProvider theme="dark">
      <Box width={COLS} height={ROWS} flexDirection="row">
        <Box width={60} height={ROWS} selectionPane="chat">
          <ScrollBox ref={left} width={60} height={ROWS} flexDirection="column">
            {Array.from({ length: 40 }, (_, i) => <Text key={i}>{'CHAT_' + String(i).padStart(2, '0')}</Text>)}
          </ScrollBox>
        </Box>
        <Box width={1} height={ROWS} noSelect><Text>{'│\n'.repeat(ROWS - 1) + '│'}</Text></Box>
        <Box width={39} height={ROWS} selectionPane="panel">
          <ScrollBox ref={right} width={39} height={ROWS} flexDirection="column">
            {Array.from({ length: 40 }, (_, i) => <Text key={i}>{'PANEL_' + String(i).padStart(2, '0')}</Text>)}
          </ScrollBox>
        </Box>
      </Box>
    </ThemeProvider>
  </AlternateScreen>
  )
}
const app = await render(<Harness />,
  { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new Stderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
)
const instances = instancesModule.default ?? instancesModule
const ink = instances.get(stdout) as {
  selection: import('../src/ink/selection.js').SelectionState
  frontFrame: { screen: import('../src/ink/screen.js').Screen }
}
const copy = (): string => selection.getSelectedText(ink.selection, ink.frontFrame.screen)
const sgr = (button: number, col: number, row: number, final = 'M'): string =>
  '\x1b[<' + button + ';' + (col + 1) + ';' + (row + 1) + final
const step = async (bytes: string): Promise<void> => {
  stdin.write(bytes)
  await new Promise(resolve => setImmediate(resolve))
}
let failed = 0
function check(name: string, ok: boolean): void {
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name)
  if (!ok) failed += 1
}
try {
  check('both scroll viewports render', await settled(() => term.buffer.active.getLine(0)?.translateToString().includes('PANEL_00') === true))
  await step(sgr(0, 0, 5))
  await step(sgr(32, 6, 7))
  await step(sgr(0, 6, 7, 'm'))
  const leftText = copy()
  check('real mouse drag selects left text', leftText.includes('CHAT_05'))
  const leftAnchor = ink.selection.anchor?.row
  await step(sgr(65, 70, 6))
  check('right wheel scrolls the right viewport', await settled(() => (right.current?.getScrollTop() ?? 0) > 0 && right.current?.getPendingDelta() === 0))
  check('right wheel leaves left selection coordinates and text intact', ink.selection.anchor?.row === leftAnchor && copy() === leftText)
  check('left viewport remains stationary', left.current?.getScrollTop() === 0)

  await step(sgr(0, 61, 5))
  await step(sgr(32, 68, 7))
  await step(sgr(0, 68, 7, 'm'))
  const rightText = copy()
  check('real mouse drag selects right text', rightText.includes('PANEL_'))
  const rightAnchor = ink.selection.anchor?.row
  await step(sgr(65, 10, 6))
  check('left wheel scrolls the left viewport', await settled(() => (left.current?.getScrollTop() ?? 0) > 0 && left.current?.getPendingDelta() === 0))
  check('left wheel leaves right selection coordinates and text intact', ink.selection.anchor?.row === rightAnchor && copy() === rightText)

  // Both boxes drain in the same render; only the selected pane moves its endpoints.
  await step(sgr(0, 61, 6))
  await step(sgr(32, 68, 8))
  await step(sgr(0, 68, 8, 'm'))
  const before = copy()
  const top = ink.selection.anchor?.row ?? -1
  const leftTop = left.current?.getScrollTop() ?? 0
  const rightTop = right.current?.getScrollTop() ?? 0
  left.current?.scrollBy(2)
  right.current?.scrollBy(1)
  check('both panes drain independent scrolls', await settled(() => left.current?.getScrollTop() === leftTop + 2 && right.current?.getScrollTop() === rightTop + 1 && left.current?.getPendingDelta() === 0 && right.current?.getPendingDelta() === 0))
  check('simultaneous scroll follows only the right owner', ink.selection.anchor?.row === top - 1 && copy() === before)
  if (ink.selection.anchor?.row !== top - 1 || copy() !== before) console.error(JSON.stringify({top, anchor: ink.selection.anchor, before, after: copy(), pane: ink.selection.pane}))
  check('right selection never captures left labels', !copy().includes('CHAT_'))
} finally {
  await app.unmount()
  term.dispose()
}
if (failed) process.exit(1)
console.log('OK: real two-pane selection scroll ownership')
process.exit(0)
