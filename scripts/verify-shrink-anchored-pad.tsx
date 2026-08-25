/**
 * Shrink-while-above-viewport keeps the diff anchored (anchoredPad).
 *
 * Deterministic distillation of the verify-trace-scene settle-gap flake:
 * when inline content shrinks but stays >= the viewport height (log-update's
 * "case 1" ordinary-diff shrink), the terminal's scrollback keeps every row
 * that was already above the viewport — scrollback cannot shrink — while the
 * per-frame heights formula (height - viewport + cursorRestoreScroll)
 * recomputes scrollback from the smaller height and undercounts by the
 * shrink delta. The next frame that touches a top row then believes a
 * scrolled-away row is reachable, its cursor-up move clamps at the viewport
 * top, and the whole relative write chain of that frame lands one row low:
 * a stale duplicate of the clamped row plus every later sparse diff patching
 * the wrong physical rows (frozen spinners, torn leading characters).
 *
 * The scenario needs no timing races: grow past the viewport, shrink by one
 * (still >= viewport), then edit a row at the reachability boundary. On the
 * unfixed renderer the edit lands one row below where the old text sits and
 * the assertion fails every run.
 *
 * Run: node --import tsx/esm scripts/verify-shrink-anchored-pad.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, Box, Text }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
  ])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const COLS = 40
const ROWS = 10
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
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

const bufferLines = (): string[] => {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.length }, (_, row) =>
    (buffer.getLine(row)?.translateToString(true) ?? '').replace(/\s+$/, ''),
  )
}
const waitFor = async (what: string, pred: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pred()) return
    await sleep(30)
  }
  check(`settle: ${what}`, false, 'never appeared within 3s')
}

// External store so the test drives exact content-height transitions.
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

const label = (index: number): string => `row-${String(index).padStart(2, '0')}`

const instance = await render(<LinesView />, {
  stdout: new FakeStdout() as never,
  stdin: new FakeStdin() as never,
  stderr: new FakeStdout() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})

// 1. Grow to viewport + 2: rows 0-1 scroll away, restore LF strands one more.
setLines(Array.from({ length: ROWS + 2 }, (_, index) => label(index)))
await waitFor('tall frame painted', () => bufferLines().some(line => line === label(ROWS + 1)))

// 2. Case-1 shrink: viewport + 1 rows — still >= viewport, ordinary diff path.
setLines(Array.from({ length: ROWS + 1 }, (_, index) => label(index)))
await waitFor('shrink settled', () => !bufferLines().some(line => line === label(ROWS + 1)))

// 3. One frame edits BOTH a stranded row and a visible row. Physical
// scrollback after the shrink is 3 (2 from growth + 1 cursor-restore LF);
// the unfixed heights formula recomputes 2, so the diff believes frame row
// 2 is reachable, walks the cursor up to it, clamps at the viewport top
// (physical frame row 3), and every later write in the frame — including
// the visible row-05 edit — lands one row low. The fixed renderer keeps
// anchoredPad=3: row 2 is skipped (stale in scrollback by design) and the
// visible edit lands in place.
const edited = Array.from({ length: ROWS + 1 }, (_, index) => label(index))
edited[2] = 'MARKER-STRANDED-ROW'
edited[5] = 'MARKER-VISIBLE-ROW'
setLines(edited)
await waitFor('edit painted', () => bufferLines().some(line => line.includes('MARKER-VISIBLE-ROW')))

{
  const observed = bufferLines()
  const markerRows = observed
    .map((line, row) => (line.includes('MARKER-VISIBLE-ROW') ? row : -1))
    .filter(row => row >= 0)
  const oldTextRows = observed
    .map((line, row) => (line === label(5) ? row : -1))
    .filter(row => row >= 0)
  const neighborRow = observed.findIndex(line => line === label(6))
  // The visible edit replaces row-05 in place: exactly one marker, directly
  // above a surviving row-06, and the old row-05 text gone. On the unfixed
  // renderer the clamped chain writes the marker one row low, over row-06.
  check('visible edit painted exactly once', markerRows.length === 1, `rows=${markerRows.join(',')}`)
  check('stale pre-edit text is gone', oldTextRows.length === 0, `rows=${oldTextRows.join(',')}`)
  check(
    'visible edit sits directly above its neighbor',
    markerRows.length === 1 && neighborRow >= 0 && markerRows[0] === neighborRow - 1,
    `marker=${markerRows.join(',')}, row-06=${neighborRow}`,
  )
  // Positive pair for the absence assertions above: surrounding rows exist.
  check('neighbor row survives the edit frame', neighborRow >= 0, `row-06=${neighborRow}`)
}

instance.unmount()
term.dispose()
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
