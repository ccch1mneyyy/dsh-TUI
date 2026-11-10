/**
 * Inline shrink-to-fit keeps the frame top-anchored (no detached tail row).
 *
 * While a turn runs, the frame height moves on every fold/live-output/spinner
 * step. When a frame that was taller than the viewport shrinks to fit it,
 * log-update takes the anchored shrink repaint: it erases the viewport and
 * repaints only the tail slice — bottom-aligned at `viewportHeight - 1` with a
 * blank band above. That band is only valid when the frame still covers the
 * viewport; for a frame that now fits, the fresh-render layout is top-anchored.
 * Bottom-aligning it detaches the last row (the status hint) from the chrome
 * above, and the next incremental frame — which maps frame row y to screen row
 * y — repaints the content above the band, leaving the hint stranded at the
 * viewport bottom with a large blank run between. A resize (full reset) heals
 * it, which is why the symptom looked intermittent and resize-dependent.
 *
 * Scenario: grow past the viewport, shrink to fit with only the tail row
 * changing (the spinner/hint case), then tick the tail again.
 *
 * Run: node --import tsx/esm scripts/verify-inline-shrink-to-fit.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, Box, Text }, { sleep }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('./lib/term-test.mjs'),
  ])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const COLS = 40
const ROWS = 43
const FITS = ROWS - 10
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    term.write(String(chunk), cb)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const viewportLines = (): string[] => {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, row) =>
    (buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').replace(/\s+$/, ''),
  )
}

let lines: string[] = []
const listeners = new Set<() => void>()
const setLines = (next: string[]): void => {
  lines = next
  for (const listener of listeners) listener()
}
function LinesView(): React.ReactNode {
  const snapshot = React.useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => lines,
  )
  return (
    <Box flexDirection="column">
      {snapshot.map((text, index) => (
        <Text key={index}>{text}</Text>
      ))}
    </Box>
  )
}

const frame = (count: number, tail: string): string[] => [
  ...Array.from({ length: count - 1 }, (_, index) => `row-${String(index).padStart(2, '0')}`),
  tail,
]

const instance = await render(<LinesView />, {
  stdout: new FakeStdout() as never,
  stdin: new FakeStdin() as never,
  stderr: new FakeStdout() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})

const settle = async (what: string, pred: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pred()) return
    await sleep(30)
  }
  check(`settle: ${what}`, false, 'never appeared within 3s')
}

// 1. Grow past the viewport so the shrink crosses back below it.
setLines(frame(ROWS + 12, 'TAIL-0'))
await settle('tall frame painted', () => viewportLines().includes('TAIL-0'))

// 2. Shrink to fit; only the tail row differs, so the seam sits in the tail and
// the anchored branch paints just the last rows.
setLines(frame(FITS, 'TAIL-1'))
await settle('shrink-to-fit repainted', () => {
  const rows = viewportLines()
  return rows[FITS - 1] === 'TAIL-1' && rows[FITS - 2] === `row-${String(FITS - 2).padStart(2, '0')}`
})

// 3. Tick the tail; the incremental frame must keep the same mapping.
setLines(frame(FITS, 'TAIL-2'))
await settle('tail tick repainted', () => viewportLines()[FITS - 1] === 'TAIL-2')

{
  const rows = viewportLines()
  const tailRows = rows.map((line, row) => (line.startsWith('TAIL-') ? row : -1)).filter(row => row >= 0)
  const firstRow = rows[0]
  const lastFrameRow = rows[FITS - 1]
  const neighbor = rows[FITS - 2]
  // Unfixed: the frame is bottom-aligned (row 0 blank, tail near ROWS-2) with a
  // blank band between the last chrome row and the detached hint.
  check('frame starts at the viewport top', firstRow === 'row-00', `row0=${JSON.stringify(firstRow)}`)
  check('tail sits at the frame bottom', lastFrameRow === 'TAIL-2', `row${FITS - 1}=${JSON.stringify(lastFrameRow)}`)
  check(
    'tail stays adjacent to the row above',
    neighbor === `row-${String(FITS - 2).padStart(2, '0')}`,
    `row${FITS - 2}=${JSON.stringify(neighbor)}`,
  )
  check('exactly one tail row on screen', tailRows.length === 1, `rows=${tailRows.join(',')}`)
  check('rows below the frame are blank', rows.slice(FITS).every(line => line === ''), `first=${JSON.stringify(rows[FITS] ?? '')}`)
}

instance.unmount()
term.dispose()
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
