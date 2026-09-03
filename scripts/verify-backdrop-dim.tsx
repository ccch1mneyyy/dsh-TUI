/**
 * verify-backdrop-dim — the `backdrop="dim"` Box style (renderer core).
 *
 * A transparent absolute click-catcher spanning a region shades every glyph
 * painted beneath it with SGR faint; an opaque card painted after it is not
 * shaded. Covers:
 *   1. closed → nothing faint; open → text under the backdrop faint, bold
 *      text stays bold, the card's border and text stay plain;
 *   2. text rewritten under an open backdrop (streaming) is shaded on the
 *      frame it appears, while untouched rows keep their shade (clean blit +
 *      idempotent re-shade, no stacking);
 *   3. a backdrop that shrinks releases the rows it vacated (poisoned frame
 *      re-derives them from the tree);
 *   4. closing releases every shaded cell (absolute removal poisons prevScreen);
 *   5. transitionAnsiCodes re-applies bold when SGR 22 drops a shade
 *      (bold+dim → bold used to lose the bold).
 *
 * Run: node --import tsx/esm scripts/verify-backdrop-dim.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { settled, sleep } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [{ render, Box, Text }, { transitionAnsiCodes }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/ink/screen.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 40
const ROWS = 12

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

type State = { open: boolean; stream: string; backdropRows: number | '100%' }
let setState: (next: State) => void = () => {}

function Harness(): React.ReactNode {
  const [state, set] = React.useState<State>({ open: false, stream: 'first', backdropRows: '100%' })
  setState = set
  return (
    // Two rows shorter than the terminal: an inline frame that fills every
    // row scrolls the top row away.
    <Box width={COLS} height={ROWS - 2} flexDirection="column">
      <Box flexDirection="column">
        <Text>plain row one</Text>
        <Text bold>BOLD row two</Text>
        <Text color="red">red row three</Text>
        <Text>stream: {state.stream}</Text>
        <Text dimColor>already faint row</Text>
        {Array.from({ length: 5 }, (_, i) => <Text key={i}>filler {i}</Text>)}
      </Box>
      {state.open && (
        <Box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height={state.backdropRows}
          flexShrink={0}
          overflow="hidden"
          backdrop="dim"
        />
      )}
      {state.open && (
        <Box
          position="absolute"
          top={6}
          left={20}
          width={14}
          height={3}
          flexShrink={0}
          overflow="hidden"
          borderStyle="round"
          opaque
        >
          <Text>CARD</Text>
        </Box>
      )}
    </Box>
  )
}

const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const app = await render(<Harness />, {
  stdin: new FakeStdin() as never,
  stdout: stdout as never,
  stderr: new FakeStderr() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})

const line = (y: number): string => terminal.buffer.active.getLine(y)?.translateToString(true) ?? ''
const text = (): string => Array.from({ length: ROWS }, (_, y) => line(y)).join('\n')
const cell = (x: number, y: number) => terminal.buffer.active.getLine(y)?.getCell(x)
const isDim = (x: number, y: number): boolean => (cell(x, y)?.isDim() ?? 0) !== 0
const isBold = (x: number, y: number): boolean => (cell(x, y)?.isBold() ?? 0) !== 0
/** Columns of the first glyph run on a row, so checks follow the text and
 *  not a hard-coded column. */
const glyphCols = (y: number): number[] => {
  const cols: number[] = []
  const row = line(y)
  for (let x = 0; x < row.length; x++) if (row[x] !== ' ') cols.push(x)
  return cols
}
const rowDim = (y: number): boolean => {
  const cols = glyphCols(y)
  return cols.length > 0 && cols.every(x => isDim(x, y))
}
const rowPlain = (y: number): boolean => {
  const cols = glyphCols(y)
  return cols.length > 0 && cols.every(x => !isDim(x, y))
}
const cardCol = (): number => line(6).indexOf('╭')

await settled(() => text().includes('filler 4'))
// Row 4 is excluded from the "plain" checks: `dimColor` is the theme's own
// business (it may be a colour rather than SGR 2); the shade must still
// leave it faint while open and touch nothing else when closed.
const PLAIN_ROWS = [0, 1, 2, 3, 5, 6, 7, 8, 9]
check('closed: no faint cell anywhere',
  PLAIN_ROWS.every(rowPlain), text())

setState({ open: true, stream: 'first', backdropRows: '100%' })
await settled(() => text().includes('CARD'))
check('open: text under the backdrop is faint',
  rowDim(0) && rowDim(2) && rowDim(3) && rowDim(5), text())
check('open: bold text under the backdrop is faint AND still bold',
  rowDim(1) && glyphCols(1).every(x => isBold(x, 1)), text())
check('open: an already-faint row is unchanged (idempotent)',
  rowDim(4), text())
{
  const left = cardCol()
  const cardText = line(7).indexOf('CARD')
  check('open: the card painted after the backdrop is not shaded (border + text)',
    left !== -1 && !isDim(left, 6) && !isDim(left + 1, 6)
      && cardText !== -1 && !isDim(cardText, 7) && !isDim(cardText + 3, 7),
    JSON.stringify({ left, cardText, row6: line(6), row7: line(7) }))
  // Filler text to the LEFT of the card on the card's rows is under the backdrop.
  check('open: text beside the card on the same row is faint',
    isDim(0, 7) && isDim(5, 7), line(7))
}

// Streaming under an open backdrop: the rewritten row is shaded on arrival,
// untouched rows keep theirs.
setState({ open: true, stream: 'second', backdropRows: '100%' })
await settled(() => text().includes('stream: second'))
await sleep(60)
check('stream: text rewritten under the backdrop is faint on the frame it appears',
  rowDim(3) && line(3).includes('stream: second'), text())
check('stream: untouched rows keep exactly their shade (blit + idempotent re-shade)',
  rowDim(0) && rowDim(1) && rowDim(2) && rowDim(5) && !isDim(cardCol(), 6), text())

// Shrink: rows the backdrop vacates come back plain on the next frame.
setState({ open: true, stream: 'second', backdropRows: 3 })
await settled(() => rowPlain(3) && rowPlain(5))
await sleep(60)
check('shrink: rows still under the backdrop stay faint',
  rowDim(0) && rowDim(1) && rowDim(2), text())
check('shrink: rows the backdrop vacated are plain again',
  rowPlain(3) && rowPlain(5) && rowPlain(8), text())

// Grow back, then close: everything under it is released.
setState({ open: true, stream: 'second', backdropRows: '100%' })
await settled(() => rowDim(3) && rowDim(8))
setState({ open: false, stream: 'second', backdropRows: '100%' })
await settled(() => !text().includes('CARD'))
await sleep(60)
check('closed again: no faint cell remains',
  PLAIN_ROWS.every(rowPlain), text())

await app.unmount()
terminal.dispose()

// transitionAnsiCodes: SGR 22 cancels both intensities; the kept one returns.
{
  const bold = { type: 'ansi' as const, code: '\x1b[1m', endCode: '\x1b[22m' }
  const dim = { type: 'ansi' as const, code: '\x1b[2m', endCode: '\x1b[22m' }
  const red = { type: 'ansi' as const, code: '\x1b[31m', endCode: '\x1b[39m' }
  const codes = (list: readonly { code: string }[]) => list.map(c => c.code)
  check('transition: bold+dim → bold re-applies bold after SGR 22',
    JSON.stringify(codes(transitionAnsiCodes([bold, dim], [bold]))) === JSON.stringify(['\x1b[22m', '\x1b[1m']),
    JSON.stringify(codes(transitionAnsiCodes([bold, dim], [bold]))))
  check('transition: red+dim → red emits only SGR 22',
    JSON.stringify(codes(transitionAnsiCodes([red, dim], [red]))) === JSON.stringify(['\x1b[22m']))
  check('transition: bold → bold+dim adds only SGR 2',
    JSON.stringify(codes(transitionAnsiCodes([bold], [bold, dim]))) === JSON.stringify(['\x1b[2m']))
  check('transition: unrelated styles are untouched',
    JSON.stringify(codes(transitionAnsiCodes([red], [bold]))) === JSON.stringify(['\x1b[39m', '\x1b[1m']))
}

if (failures > 0) {
  console.error(`verify-backdrop-dim: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-backdrop-dim: all checks passed')
