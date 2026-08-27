/**
 * Tooltip hover system regression (src/components/Tooltip.tsx).
 *
 * Focused headless harness (the repro-paste-fold rig): a probe tree inside
 * <AlternateScreen> (hover events only exist with mouse tracking on) with
 * TooltipLayer mounted last, driven through real SGR mode-1003 motion
 * sequences. Asserts:
 *   1. the tooltip does NOT appear before the dwell elapses
 *   2. after the dwell the full content is on screen
 *   3. leaving the target hides it immediately
 *   4. leaving before the dwell cancels the pending tooltip
 *   5. a custom delayMs shortens the dwell
 *   6. multi-line content renders every line, anchored ABOVE the target
 *   7. an anchor at the top of the screen drops the tooltip BELOW instead
 *   8. terminal resize hides the shown tooltip (stale geometry)
 *   9. a narrow terminal clamps the card inside the screen width
 *
 * Run: `node --import tsx/esm scripts/verify-tooltip.tsx`
 * Exits 1 on any failed assertion.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
// Redirect ~/.dsh-tui away from the real home before any module import
// resolves utils/paths.js.
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])
const dataDir = mkdtempSync(join(tmpdir(), 'verify-tooltip-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, tooltip, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
])

const { sleep, settle, settled, screenHas, findText, viewportLines } = termTest
const { render, AlternateScreen, Box, Text } = ui

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

/** One hoverable row: the tooltip props spread onto a plain Box. */
function Target({ label, content, delayMs }: {
  label: string
  content: string
  delayMs?: number
}): React.ReactNode {
  const hover = tooltip.useTooltip(content, delayMs !== undefined ? { delayMs } : undefined)
  return (
    <Box {...hover}>
      <Text>{label}</Text>
    </Box>
  )
}

/** The real Chat always mounts useInput consumers (PromptInput etc.); the
 * app wires its stdin parser only when at least one subscriber exists, so
 * the probe mirrors that condition instead of silently dropping input. */
function KeySink(): React.ReactNode {
  ui.useInput(() => {})
  return null
}

function Probe({ longContent }: { longContent?: boolean }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Target label="ROW-TOP" content="TIP-TOP-MARKER" />
      {Array.from({ length: 8 }, (_, i) => <Box key={i} height={1}><Text>{' '}</Text></Box>)}
      <Target label="ROW-ONE" content={longContent === true ? 'C'.repeat(40) : 'TIP-ONE-FULL-MARKER'} />
      <Target label="ROW-TWO" content={'multi-first-line\nmulti-second-line'} />
      <Target label="ROW-FAST" content="TIP-FAST-MARKER" delayMs={150} />
      <Text>TAIL-ANCHOR</Text>
      <KeySink />
      <tooltip.TooltipLayer />
    </Box>
  )
}

function TinyProbe(): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Target label="T" content={'\x1b[31mWIDE\x1b[0m'} delayMs={0} />
      <KeySink />
      <tooltip.TooltipLayer />
    </Box>
  )
}

function makeRig(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  return { term, stdout, stdin }
}

/** SGR mode-1003 motion with no buttons → dispatchHover. Coords 1-indexed. */
const hover = (stdin: PassThrough, col: number, row: number) =>
  stdin.write(`\x1b[<35;${col};${row}M`)

try {
  const COLS = 100
  const ROWS = 30
  const rig = makeRig(COLS, ROWS)
  const instance = await render(
    <AlternateScreen>
      <Probe />
    </AlternateScreen>,
    { stdout: rig.stdout, stdin: rig.stdin, stderr: new (class extends Writable {
      isTTY = true
      _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
    })(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)

  const { term, stdout, stdin } = { term: rig.term, stdout: rig.stdout, stdin: rig.stdin }
  const topRow = findText(term, 'ROW-TOP')?.row ?? -1
  const oneRow = findText(term, 'ROW-ONE')?.row ?? -1
  const twoRow = findText(term, 'ROW-TWO')?.row ?? -1
  const fastRow = findText(term, 'ROW-FAST')?.row ?? -1
  check('probe rows are laid out', topRow >= 0 && oneRow > topRow && twoRow > oneRow && fastRow > twoRow,
    `top=${topRow} one=${oneRow} two=${twoRow} fast=${fastRow}`)

  // 1+7. Anchor at the very top: no room above → the card must appear
  // BELOW the anchor, and only after the dwell.
  hover(stdin, 3, topRow + 1)
  await sleep(300)
  check('no tooltip before the dwell elapses', !screenHas(term, 'TIP-TOP-MARKER'))
  check('tooltip appears after the dwell', await settled(() => screenHas(term, 'TIP-TOP-MARKER')))
  const tipTopRow = findText(term, 'TIP-TOP-MARKER')?.row ?? -1
  check('top-of-screen anchor drops the tooltip below', tipTopRow > topRow,
    `anchor=${topRow} tip=${tipTopRow}`)

  // 3. Leaving hides it.
  hover(stdin, COLS - 1, ROWS - 1)
  check('leaving the target hides the tooltip', await settled(() => !screenHas(term, 'TIP-TOP-MARKER')))

  // 4. Leaving before the dwell cancels the pending tooltip.
  hover(stdin, 3, oneRow + 1)
  await sleep(300)
  hover(stdin, COLS - 1, ROWS - 1)
  await sleep(800)
  check('leaving before the dwell cancels the tooltip', !screenHas(term, 'TIP-ONE-FULL-MARKER'))

  // Global geometry invalidation (scroll/modal/focus-out) must cancel a
  // PENDING dwell too, not only an already shown tooltip.
  hover(stdin, 3, oneRow + 1)
  await sleep(300)
  tooltip.clearTooltip()
  await sleep(500)
  check('geometry invalidation cancels a pending tooltip', !screenHas(term, 'TIP-ONE-FULL-MARKER'))
  hover(stdin, COLS - 1, ROWS - 1)

  // 5. Custom delayMs shortens the dwell.
  hover(stdin, 3, fastRow + 1)
  await sleep(350)
  check('a custom delayMs shows the tooltip sooner', await settled(() => screenHas(term, 'TIP-FAST-MARKER')))
  hover(stdin, COLS - 1, ROWS - 1)
  await settle(() => !screenHas(term, 'TIP-FAST-MARKER'))

  // 6. Multi-line content, anchored above the hovered row.
  hover(stdin, 3, twoRow + 1)
  check('multi-line tooltip shows every line',
    await settled(() => screenHas(term, 'multi-first-line') && screenHas(term, 'multi-second-line')))
  const firstLineRow = findText(term, 'multi-first-line')?.row ?? -1
  check('tooltip is anchored above the target row', firstLineRow >= 0 && firstLineRow < twoRow,
    `anchor=${twoRow} tip=${firstLineRow}`)

  // 8. Resize invalidates the anchor: the shown tooltip disappears.
  term.resize(60, ROWS)
  stdout.columns = 60
  stdout.emit('resize')
  check('resize hides the shown tooltip',
    await settled(() => !screenHas(term, 'multi-first-line') && !screenHas(term, 'multi-second-line')))

  await instance.unmount()

  // 9. Narrow terminal: the card (border included) never exceeds the
  // screen width, regardless of the pointer column.
  const NARROW = 24
  const rig2 = makeRig(NARROW, 16)
  const instance2 = await render(
    <AlternateScreen>
      <Probe longContent />
    </AlternateScreen>,
    { stdout: rig2.stdout, stdin: rig2.stdin, stderr: new (class extends Writable {
      isTTY = true
      _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
    })(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  const oneRow2 = findText(rig2.term, 'ROW-ONE')?.row ?? -1
  hover(rig2.stdin, NARROW - 1, oneRow2 + 1) // pointer at the right edge
  const narrowShown = await settled(() => viewportLines(rig2.term).some(line => line.includes('CCCC')))
  const narrowLines = narrowShown
    ? viewportLines(rig2.term).filter(line => line.includes('C') || line.includes('╭') || line.includes('╰'))
    : []
  const maxLen = narrowLines.reduce((m, l) => Math.max(m, l.length), 0)
  const border = narrowLines.find(l => l.includes('╭')) ?? ''
  check('narrow terminal: tooltip appears', narrowShown)
  check('narrow terminal: every tooltip line fits the screen', narrowLines.length > 0 && maxLen <= NARROW,
    `max=${maxLen}`)
  check('narrow terminal: card width is clamped (border ≤ columns)', border.length > 0 && border.length <= NARROW,
    `border=${JSON.stringify(border)}`)
  await instance2.unmount()

  // 10. Ultra-narrow resize states used to keep a hard minimum width of 10,
  // producing a card wider than the terminal. A 6-column terminal must still
  // render a bounded card (1 content cell minimum + borders).
  const TINY = 6
  const rig3 = makeRig(TINY, 8)
  const instance3 = await render(
    <AlternateScreen><TinyProbe /></AlternateScreen>,
    { stdout: rig3.stdout, stdin: rig3.stdin, stderr: new (class extends Writable {
      isTTY = true
      _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
    })(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)
  const tinyTarget = findText(rig3.term, 'T')
  if (tinyTarget !== null) hover(rig3.stdin, tinyTarget.col + 1, tinyTarget.row + 1)
  const tinyShown = await settled(() => viewportLines(rig3.term).some(line => line.includes('W')))
  const tinyLines = viewportLines(rig3.term).filter(line => /[W╭╰]/u.test(line))
  check('ultra-narrow terminal: tooltip remains on-screen and strips ANSI geometry',
    tinyShown && tinyLines.every(line => line.length <= TINY) &&
      !viewportLines(rig3.term).some(line => /\[(?:31|0)m/u.test(line)),
    JSON.stringify(tinyLines))
  await instance3.unmount()
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(failed)
