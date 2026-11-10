/**
 * Inline shrink keeps the repainted tail flush under the scrollback (#1923).
 *
 * While a turn runs the frame height moves on every fold / live-output /
 * spinner step. When a frame that reached the viewport shrinks back to fit it,
 * log-update takes the anchored shrink repaint: it erases the viewport and
 * repaints only the tail slice — the rows without a scrollback original. That
 * slice used to be bottom-aligned at `viewportHeight - 1` with a manufactured
 * blank band above it, which is only harmless while the frame still covers the
 * viewport. A fitting frame has no rows stranded in scrollback, so the band
 * becomes a pure hole between the transcript above and the tail row (the status
 * hint) pinned near the viewport bottom; a resize reset repaints the frame and
 * hides it again, which is why the symptom looked intermittent.
 *
 * Oracle (per shrink target `viewport-10`, `viewport-1`, `viewport`):
 * - the viewport's first row continues the scrollback's deepest row — no band;
 * - no blank row inside the frame;
 * - no line appears twice across scrollback + viewport: the anchored branch
 *   keeps the scrollback originals authoritative instead of reprinting them;
 * - the tail is the frame's last row, adjacent to the row above.
 *
 * Run: node --import tsx/esm scripts/verify-inline-shrink-to-fit.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, Box, Text }, { settled, viewportLines }] =
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
const TALL = ROWS + 12

const frame = (count: number, tail: string): string[] => [
  ...Array.from({ length: count - 1 }, (_, index) => `row-${String(index).padStart(2, '0')}`),
  tail,
]

const nonBlank = (lines: string[]): string[] => lines.filter(line => line !== '')

async function runCase(target: number): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
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

  const instance = await render(<LinesView />, {
    stdout: new FakeStdout() as never,
    stdin: new FakeStdin() as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  // 等待与断言共用同一个谓词：settled 轮询到条件成立，超时才落一条失败。
  const settle = async (what: string, pred: () => boolean): Promise<void> => {
    const ok = await settled(pred, { timeoutMs: 3000, stepMs: 30 })
    if (!ok) check(`settle: ${what}`, false, 'never appeared within 3s')
  }

  const label = `rows=${target}`

  // 1. Grow past the viewport so the shrink crosses back below it.
  setLines(frame(TALL, 'TAIL-0'))
  await settle(`${label}: tall frame painted`, () => viewportLines(term, ROWS).includes('TAIL-0'))

  // 2. Shrink to fit; only the tail row differs, so the seam sits in the tail.
  setLines(frame(target, 'TAIL-1'))
  await settle(`${label}: shrink repainted`, () => viewportLines(term, ROWS).includes('TAIL-1'))

  const buffer = term.buffer.active
  const viewport = viewportLines(term, ROWS)
  const scrollback = Array.from(
    { length: buffer.baseY },
    (_, row) => (buffer.getLine(row)?.translateToString(true) ?? '').replace(/\s+$/, ''),
  )
  const above = nonBlank(scrollback)
  const tailRow = viewport.findIndex(line => line.startsWith('TAIL-'))
  const lastFrameRow = viewport.reduce((last, line, row) => (line === '' ? last : row), -1)

  check(
    `${label}: viewport continues the scrollback`,
    above.length > 0 &&
      viewport[0] === `row-${String(Number(above.at(-1)?.slice(4)) + 1).padStart(2, '0')}`,
    `above=${JSON.stringify(above.at(-1))} row0=${JSON.stringify(viewport[0])}`,
  )
  check(
    `${label}: no blank row inside the frame`,
    tailRow > 0 && viewport.slice(0, tailRow).every(line => line !== ''),
    `blank=${viewport.findIndex(line => line === '')}`,
  )
  check(`${label}: tail is the frame's last row`, tailRow === lastFrameRow, `tail=${tailRow} last=${lastFrameRow}`)
  check(
    `${label}: tail stays adjacent to the row above`,
    viewport[tailRow - 1] === `row-${String(target - 2).padStart(2, '0')}`,
    `above=${JSON.stringify(viewport[tailRow - 1])}`,
  )
  const counts = new Map<string, number>()
  for (const line of [...scrollback, ...viewport]) {
    if (line !== '') counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  const duplicates = [...counts].filter(([, count]) => count > 1)
  check(
    `${label}: no line repeats across scrollback and viewport`,
    duplicates.length === 0,
    duplicates.slice(0, 4).map(([text, count]) => `${text}x${count}`).join(' '),
  )

  instance.unmount()
  term.dispose()
}

for (const target of [ROWS - 10, ROWS - 1, ROWS]) await runCase(target)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
