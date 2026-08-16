/**
 * Collapsing a frame that is taller than the viewport must not leave a copy of
 * it on screen.
 *
 * This is the shrink-frame family (#38/#39/#19/#10) at its largest step. The
 * everyday cases — a thinking fold, the spinner row unmounting, markdown
 * reflow — shrink the frame by a row or two, and `repaintViewportInPlace`
 * handles them. The step this pins is the big one: an expanded panel that made
 * the frame much TALLER than the viewport collapses back in a single frame.
 *
 * Reported from the loaded-context panel (expand with Ctrl+T, collapse again)
 * and reproduced here without Chat, so the check describes the renderer rather
 * than one screen's layout.
 *
 * The oracle is final-state equivalence, the same one verify-resize-reflow
 * uses and for the same reason: it needs no theory of the bug. Drive the
 * shrink, then build the same short state fresh, and demand the two screens
 * match. Whatever the shrink path forgot to erase shows up as a diff.
 *
 * Run: node --import tsx/esm scripts/repro-collapse-shrink.tsx
 */
process.env.FORCE_COLOR = '3'

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

const COLS = 80
const ROWS = 24

function makeHarness() {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  /** Visible viewport rows, blanks dropped — placement is not what is at
   *  stake here, leftover content is. */
  const screen = (): string[] => {
    // getLine() indexes the WHOLE buffer, scrollback included. The viewport
    // starts at baseY — reading from 0 returns scrollback rows, which after a
    // frame taller than the terminal is the previous, larger frame.
    const buffer = term.buffer.active
    return Array.from({ length: ROWS }, (_, y) =>
      (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
      .filter(line => line !== '')
  }
  return { term, stdout: new FakeStdout(), stdin: new FakeStdin(), screen, writes }
}

/**
 * A header that never changes plus a body that can be much taller than the
 * viewport — the shape of any expandable panel.
 */
function Panel({ open, bodyRows }: { open: boolean; bodyRows: number }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{open ? '▼' : '▶'} panel header</Text>
      {open && (
        <Box flexDirection="column">
          {Array.from({ length: bodyRows }, (_, i) => (
            <Text key={i}>{`  body line ${i + 1}`}</Text>
          ))}
        </Box>
      )}
      <Text>tail marker</Text>
    </Box>
  )
}

/** Body rows chosen so the OPEN frame is comfortably taller than the viewport. */
const BODY_ROWS = ROWS + 12

async function run(): Promise<void> {
  // ── drive the shrink: render open, then collapse in place ────────────────
  const live = makeHarness()
  let setOpen: ((value: boolean) => void) | undefined
  function Host(): React.ReactNode {
    const [open, set] = React.useState(true)
    setOpen = set
    return <Panel open={open} bodyRows={BODY_ROWS} />
  }
  const liveInstance = await render(<Host />, {
    stdout: live.stdout as never,
    stdin: live.stdin as never,
    stderr: live.stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(400)
  check('the expanded frame is taller than the viewport', live.screen().length >= ROWS - 1,
    `${live.screen().length} rows visible of ${ROWS}`)

  const mark = live.writes.length
  setOpen?.(false)
  await sleep(600)
  if (process.env.DBG_SHRINK === '1') {
    live.writes.slice(mark).forEach((w, i) => {
      console.log(`[w${i}] ${JSON.stringify(w.slice(0, 160))}`)
    })
  }
  const collapsed = live.screen()
  liveInstance.unmount()
  live.term.dispose()
  await sleep(40)

  // ── the same short state, built fresh ────────────────────────────────────
  const cold = makeHarness()
  const coldInstance = await render(<Panel open={false} bodyRows={BODY_ROWS} />, {
    stdout: cold.stdout as never,
    stdin: cold.stdin as never,
    stderr: cold.stdout as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(400)
  const fresh = cold.screen()
  coldInstance.unmount()
  cold.term.dispose()

  check('the collapsed screen has no leftover body lines',
    !collapsed.some(line => line.includes('body line')),
    collapsed.filter(line => line.includes('body line')).length + ' leftover')
  check('the header appears exactly once',
    collapsed.filter(line => line.includes('panel header')).length === 1,
    `${collapsed.filter(line => line.includes('panel header')).length} copies`)
  check('the collapsed screen matches a fresh render',
    collapsed.join('\n') === fresh.join('\n'),
    collapsed.join('\n') === fresh.join('\n')
      ? ''
      : `after=${JSON.stringify(collapsed.slice(0, 4))} fresh=${JSON.stringify(fresh.slice(0, 4))}`)
}

await run()

console.log(failed === 0 ? '\nAll collapse-shrink checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
