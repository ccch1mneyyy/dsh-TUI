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
 * Multi-round growth/shrink keeps the original scrollback depth (#1934).
 * An offscreen reset must discard that depth before subsequent sparse edits.
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

async function runCase(sequence: number[], editAfterReset = false): Promise<void> {
  const target = sequence.at(-1)!
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
    // 用共享默认超时：CI 共享 runner 会把上限放宽，条件成立即返回。
    const ok = await settled(pred)
    if (!ok) check(`settle: ${what}`, false, 'never appeared before the settle timeout')
  }

  const label = `sequence=${sequence.join(',')}`

  for (const [step, height] of sequence.entries()) {
    const tail = `TAIL-${step}`
    setLines(frame(height, tail))
    await settle(`${label}: step ${step} painted`, () => viewportLines(term, ROWS).includes(tail))
  }

  if (editAfterReset) {
    // The 100 -> 50 shrink clears the terminal. Its fresh viewport begins
    // at frame row 8; the earlier anchored pad (13) must no longer hide 8..12.
    const edited = frame(target, 'TAIL-EDIT')
    for (let row = 8; row <= 12; row++) edited[row] = `MUT-${String(row).padStart(2, '0')}`
    setLines(edited)
    const expected = edited.slice(target - ROWS + 1).concat('')
    let viewport: string[] = []
    const painted = await settled(() => {
      viewport = viewportLines(term, ROWS)
      return viewport.join('\n') === expected.join('\n')
    })
    check(`${label}: reset clears stale scrollback reachability`,
      painted, JSON.stringify(viewport.slice(0, 6)))
    instance.unmount()
    term.dispose()
    return
  }

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

for (const target of [ROWS - 10, ROWS - 1, ROWS]) await runCase([TALL, target])
for (const sequence of [[55, 33, 50, 30], [55, 42, 50, 41], [55, 43, 30]]) {
  await runCase(sequence)
}
await runCase([55, 33, 100, 50], true)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
