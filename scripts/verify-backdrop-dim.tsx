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
 *   6. overlapping source/shaded colours stay independent across cached
 *      frames and target changes, for both foreground and background.
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
const [{ render, Box, Text, ThemeProvider }, { StylePool, transitionAnsiCodes }] = await Promise.all([
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

// A derived colour can equal a separately painted source colour. They
// still need independent shading, regardless of interning/visitation order.
for (const order of [[200, 100], [100, 200]]) {
  const styles = new StylePool()
  styles.setShadeTarget({ r: 0, g: 0, b: 0 })
  const source = (n: number) => styles.intern([
    { type: 'ansi', code: `\x1b[38;2;${n};${n};${n}m`, endCode: '\x1b[39m' },
  ])
  const shaded = order.map(n => styles.withDim(source(n)))
  check(`pool: overlapping colours shade independently (${order})`,
    shaded.every((id, i) => styles.get(id)[0]?.code === `\x1b[38;2;${order[i]! / 2};${order[i]! / 2};${order[i]! / 2}m`))
  check('pool: a cached shade is idempotent', shaded.every(id => styles.withDim(id) === id))
  styles.setShadeTarget({ r: 255, g: 255, b: 255 })
  check('pool: cached cells shade from their source after a target change',
    shaded.every((id, i) => {
      const n = Math.round((order[i]! + 255) / 2)
      return styles.get(styles.withDim(id))[0]?.code === `\x1b[38;2;${n};${n};${n}m`
    }))
  styles.setShadeTarget({ r: 0, g: 0, b: 0 })
  check('pool: revisiting a target reuses its styles',
    shaded.every((id, i) => styles.withDim(source(order[i]!)) === id))
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
        {Array.from({ length: 3 }, (_, i) => <Text key={i}>filler {i}</Text>)}
        {/* Half-block pixel pair: upper pixel in the fg, lower in the bg —
            the whale's technique. Plus a solid pixel: a space with a bg. */}
        <Text>
          <Text color="rgb(200,100,50)" backgroundColor="rgb(20,40,60)">▀▀</Text>
          <Text backgroundColor="rgb(20,40,60)">  </Text>
          <Text>pixels</Text>
        </Text>
        <Text>
          <Text color="rgb(200,200,200)" backgroundColor="rgb(200,200,200)">H</Text>
          <Text color="rgb(100,100,100)" backgroundColor="rgb(100,100,100)">L</Text>
        </Text>
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
const app = await render(<ThemeProvider theme="dark"><Harness /></ThemeProvider>, {
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
/** RGB of a cell's fg/bg as xterm packs them (0xRRGGBB), or -1 for default. */
const fgOf = (x: number, y: number): number => cell(x, y)?.getFgColor() ?? -1
const bgOf = (x: number, y: number): number => cell(x, y)?.getBgColor() ?? -1
const packed = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b
const PIXEL_ROW = 8

await settled(() => text().includes('filler 2'))
// Row 4 is excluded from the "plain" checks: `dimColor` is the theme's own
// business (it may be a colour rather than SGR 2); the shade must still
// leave it faint while open and touch nothing else when closed.
const PLAIN_ROWS = [0, 1, 2, 3, 5, 6, 7, 8, 9]
check('closed: no faint cell anywhere',
  PLAIN_ROWS.every(rowPlain), text())
const closedDimRowFg = fgOf(glyphCols(4)[0] ?? 0, 4)
check('closed: the pixel pair carries its own fg and bg, the solid pixel its bg',
  fgOf(0, PIXEL_ROW) === packed(200, 100, 50) && bgOf(0, PIXEL_ROW) === packed(20, 40, 60)
    && bgOf(2, PIXEL_ROW) === packed(20, 40, 60),
  JSON.stringify({ fg: fgOf(0, PIXEL_ROW).toString(16), bg: bgOf(0, PIXEL_ROW).toString(16), solid: bgOf(2, PIXEL_ROW).toString(16) }))

setState({ open: true, stream: 'first', backdropRows: '100%' })
await settled(() => text().includes('CARD'))
check('open: text under the backdrop is faint',
  rowDim(0) && rowDim(2) && rowDim(3) && rowDim(5), text())
check('open: bold text under the backdrop is faint AND still bold',
  rowDim(1) && glyphCols(1).every(x => isBold(x, 1)), text())
// `dimColor` is the theme's business: SGR faint stays faint, a dim colour
// blends like any explicit colour — either way the row reads as shaded.
check('open: an already-dim row is shaded once (faint kept, or its colour blended)',
  rowDim(4) || fgOf(glyphCols(4)[0] ?? 0, 4) !== closedDimRowFg, text())
// Explicit colours blend toward the target instead of taking faint: the
// pixel pair keeps its structure (both halves fade), the solid pixel's bg
// fades too, and the plain text after them is faint.
check('open: a half-block pixel pair fades fg AND bg halfway toward the target, without faint',
  fgOf(0, PIXEL_ROW) === packed(100, 50, 25) && bgOf(0, PIXEL_ROW) === packed(10, 20, 30)
    && !isDim(0, PIXEL_ROW) && fgOf(1, PIXEL_ROW) === packed(100, 50, 25),
  JSON.stringify({ fg: fgOf(0, PIXEL_ROW).toString(16), bg: bgOf(0, PIXEL_ROW).toString(16), dim: isDim(0, PIXEL_ROW) }))
check('open: a solid pixel (space with a bg) fades its bg',
  bgOf(2, PIXEL_ROW) === packed(10, 20, 30) && bgOf(3, PIXEL_ROW) === packed(10, 20, 30),
  JSON.stringify({ solid: bgOf(2, PIXEL_ROW).toString(16) }))
check('open: default-coloured text next to the pixels takes faint',
  isDim(4, PIXEL_ROW) && isDim(9, PIXEL_ROW), line(PIXEL_ROW))
const collisionRowShaded = (): boolean =>
  fgOf(0, 9) === packed(100, 100, 100) && bgOf(0, 9) === packed(100, 100, 100)
    && fgOf(1, 9) === packed(50, 50, 50) && bgOf(1, 9) === packed(50, 50, 50)
check('open: colliding source/shaded colours fade both fg and bg', collisionRowShaded(), line(9))
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
check('stream: colliding colours keep one shade across cached frames', collisionRowShaded(), line(9))

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
check('closed again: the pixel colours are restored exactly',
  fgOf(0, PIXEL_ROW) === packed(200, 100, 50) && bgOf(0, PIXEL_ROW) === packed(20, 40, 60)
    && bgOf(2, PIXEL_ROW) === packed(20, 40, 60),
  JSON.stringify({ fg: fgOf(0, PIXEL_ROW).toString(16), bg: bgOf(0, PIXEL_ROW).toString(16) }))
check('closed again: colliding colours return to their independent sources',
  fgOf(0, 9) === packed(200, 200, 200) && bgOf(0, 9) === packed(200, 200, 200)
    && fgOf(1, 9) === packed(100, 100, 100) && bgOf(1, 9) === packed(100, 100, 100), line(9))

app.rerender(<ThemeProvider key="light" theme="light"><Harness /></ThemeProvider>)
await settled(() => text().includes('stream: first'))
setState({ open: true, stream: 'light', backdropRows: '100%' })
check('theme: a custom output stream receives the light backdrop target',
  await settled(() =>
    fgOf(0, PIXEL_ROW) === packed(228, 178, 153)
    && bgOf(0, PIXEL_ROW) === packed(138, 148, 158)),
  text())

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
