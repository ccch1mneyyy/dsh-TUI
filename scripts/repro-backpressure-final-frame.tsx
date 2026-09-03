/**
 * #713 backpressure × Smooth Streaming final-frame regression.
 *
 * A skipped terminal write must not consume the DOM renderer's dirty state.
 * React commits and renderNodeToOutput can finish while stdout is gated; if the
 * producer then becomes idle (a one-shot update, or a reveal cursor catching
 * up and stopping its timer), the drain render is the ONLY remaining frame.
 * It must rebuild from the current DOM rather than blitting the last-written
 * frontFrame back over the skipped candidate.
 *
 * Run: node --import tsx/esm scripts/repro-backpressure-final-frame.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Text, useInput },
  { default: instances },
  { getRevealVersion, isRevealTimerRunning, resetRevealForTest, revealTextOf },
  { useRevealVersion },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/instances.js'),
  import('../src/components/smoothReveal.js'),
  import('../src/hooks/useRevealVersion.js'),
])

const COLS = 100
const ROWS = 24
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(ok: () => boolean, budgetMs = 5_000, stepMs = 25): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    if (ok()) return true
    await sleep(stepMs)
  }
  return ok()
}

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures += 1
}

function KeepAlive(): React.ReactElement | null {
  useInput(() => {})
  return null
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

class ControlledStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  reportedBacklog = 0
  readonly writes: string[] = []
  constructor(readonly term: InstanceType<typeof XTerm>) {
    super()
    // Ink reads writableLength as an additional gate. Keep Node's real
    // Writable mechanics untouched while exposing a deterministic synthetic
    // backlog to the renderer.
    Object.defineProperty(this, 'writableLength', {
      configurable: true,
      get: () => this.reportedBacklog,
    })
  }
  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    const text = String(chunk)
    this.writes.push(text)
    this.term.write(text, callback)
  }
}

function screenText(term: InstanceType<typeof XTerm>): string {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, y) =>
    buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
  ).join('\n')
}

function gateRenderer(stdout: ControlledStdout, ink: any): void {
  stdout.reportedBacklog = 9_001
  ink.backpressured = true
}

function releaseRenderer(stdout: ControlledStdout): void {
  stdout.reportedBacklog = 0
  stdout.emit('drain')
}

// ---------------------------------------------------------------------------
// A. One-shot React update: no producer exists after the skipped commit.
// ---------------------------------------------------------------------------
{
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new ControlledStdout(term)
  const stdin = new FakeStdin()
  let updateText: React.Dispatch<React.SetStateAction<string>> = () => {}
  function OneShot(): React.ReactElement {
    const [value, setValue] = React.useState('BEFORE-ONE-SHOT')
    updateText = setValue
    return <Text>{value}</Text>
  }
  const instance = await render(
    <AlternateScreen>
      <OneShot />
      <KeepAlive />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, exitOnCtrlC: false, patchConsole: false },
  )
  check('A0 initial frame reached terminal', await until(() => screenText(term).includes('BEFORE-ONE-SHOT')))
  const ink = instances.get(stdout) as any
  check('A0 Ink instance found', ink !== undefined)

  gateRenderer(stdout, ink)
  updateText('AFTER-ONE-SHOT-FINAL')
  await sleep(150)
  check('A1 final commit was gated',
    ink.backpressured === true && !screenText(term).includes('AFTER-ONE-SHOT-FINAL'))
  check('A1 drain listener armed', stdout.listenerCount('drain') === 1,
    `listeners=${stdout.listenerCount('drain')}`)

  releaseRenderer(stdout)
  check('A2 drain paints the one-shot final DOM',
    await until(() => screenText(term).includes('AFTER-ONE-SHOT-FINAL'), 2_000),
    JSON.stringify(screenText(term).slice(0, 80)))

  await instance.unmount()
  term.dispose()
}

// ---------------------------------------------------------------------------
// B. Smooth reveal catches up while gated, then retires its only timer.
// ---------------------------------------------------------------------------
{
  resetRevealForTest()
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new ControlledStdout(term)
  const stdin = new FakeStdin()
  const target = 'x'.repeat(2_000)
  function SmoothFinal(): React.ReactElement {
    useRevealVersion()
    const shown = revealTextOf('backpressure-final', target, { enabled: true, active: true })
    return (
      <>
        <Text>STATIC-CHROME-TOP</Text>
        <Text>{`REVEAL-LEN=${shown.length}/${target.length}`}</Text>
        <Text>STATIC-CHROME-BOTTOM</Text>
      </>
    )
  }
  const instance = await render(
    <AlternateScreen>
      <SmoothFinal />
      <KeepAlive />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, exitOnCtrlC: false, patchConsole: false },
  )
  check('B0 initial smooth frame reached terminal',
    await until(() => screenText(term).includes('REVEAL-LEN=')))
  const ink = instances.get(stdout) as any
  gateRenderer(stdout, ink)

  check('B1 reveal advances while stdout is gated',
    await until(() => getRevealVersion() > 3, 2_000),
    `version=${getRevealVersion()}`)
  check('B1 reveal timer retires after catching up',
    await until(() => !isRevealTimerRunning(), 5_000),
    `version=${getRevealVersion()}`)
  await sleep(100)
  check('B1 terminal still lacks the skipped final reveal',
    !screenText(term).includes(`REVEAL-LEN=${target.length}/${target.length}`))

  releaseRenderer(stdout)
  check('B2 drain paints final reveal after its timer retired',
    await until(() => screenText(term).includes(`REVEAL-LEN=${target.length}/${target.length}`), 2_000),
    JSON.stringify(screenText(term).split('\n').slice(0, 4)))
  check('B3 static chrome remains correctly placed',
    screenText(term).includes('STATIC-CHROME-TOP') && screenText(term).includes('STATIC-CHROME-BOTTOM'))

  await instance.unmount()
  term.dispose()
  resetRevealForTest()
}

// ---------------------------------------------------------------------------
// C. A long blocked terminal is itself a restore/surface-uncertainty signal.
// ---------------------------------------------------------------------------
{
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new ControlledStdout(term)
  const stdin = new FakeStdin()
  let updateText: React.Dispatch<React.SetStateAction<string>> = () => {}
  function StaticChrome(): React.ReactElement {
    const [value, setValue] = React.useState('DYNAMIC-BEFORE')
    updateText = setValue
    return (
      <>
        <Text>STATIC-SURFACE-TOP</Text>
        <Text>{value}</Text>
        <Text>STATIC-SURFACE-BOTTOM</Text>
      </>
    )
  }
  const instance = await render(
    <AlternateScreen>
      <StaticChrome />
      <KeepAlive />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, exitOnCtrlC: false, patchConsole: false },
  )
  check('C0 initial static surface reached terminal',
    await until(() => screenText(term).includes('STATIC-SURFACE-BOTTOM')))
  const ink = instances.get(stdout) as any
  gateRenderer(stdout, ink)
  updateText('DYNAMIC-AFTER')
  check('C0 long-stall clock armed by the skipped frame',
    await until(() => ink.backpressureStartedAt !== null, 1_000))
  await sleep(1_200)
  await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HPHYSICAL-SURFACE-STALE', resolve))
  stdout.writes.length = 0

  releaseRenderer(stdout)
  check('C1 long drain triggers alt-surface health recovery',
    await until(() => stdout.writes.some(write => write.includes('\x1b[?1049$p')), 1_000),
    `writes=${stdout.writes.length}`)
  // Headless xterm does not answer DECRQM/DA1. The extra DA1 covers the
  // startup XTVERSION sentinel when it is still ahead in the querier FIFO.
  stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c')
  check('C2 long drain rebuilds unchanged static cells too',
    await until(() => {
      const text = screenText(term)
      return text.includes('STATIC-SURFACE-TOP') &&
        text.includes('DYNAMIC-AFTER') &&
        text.includes('STATIC-SURFACE-BOTTOM') &&
        !text.includes('PHYSICAL-SURFACE-STALE')
    }, 3_000),
    JSON.stringify(screenText(term).split('\n').slice(0, 5)))

  await instance.unmount()
  term.dispose()
}

// ---------------------------------------------------------------------------
// D. Same-size restore must supersede a stale backpressure latch immediately.
// ---------------------------------------------------------------------------
{
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new ControlledStdout(term)
  const stdin = new FakeStdin()
  const instance = await render(
    <AlternateScreen>
      <Text>SAME-SIZE-BACKPRESSURE-SURFACE</Text>
      <KeepAlive />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, exitOnCtrlC: false, patchConsole: false },
  )
  check('D0 initial same-size surface reached terminal',
    await until(() => screenText(term).includes('SAME-SIZE-BACKPRESSURE-SURFACE')))
  const ink = instances.get(stdout) as any
  gateRenderer(stdout, ink)
  await sleep(80)
  await new Promise<void>(resolve => term.write('\x1b[2J\x1b[HSAME-SIZE-STALE', resolve))
  stdout.reportedBacklog = 0
  stdout.writes.length = 0
  stdout.emit('resize')
  await sleep(80)
  check('D1 same-size restore clears stale backpressure latch before repaint',
    ink.backpressured === false,
    `backpressured=${String(ink.backpressured)}`)
  check('D1 same-size restore starts surface query',
    stdout.writes.some(write => write.includes('\x1b[?1049$p')))
  stdin.write('\x1b[?1049;1$y\x1b[?c\x1b[?c')
  check('D2 same-size restore repaints without waiting for drain backoff',
    await until(() => {
      const text = screenText(term)
      return text.includes('SAME-SIZE-BACKPRESSURE-SURFACE') && !text.includes('SAME-SIZE-STALE')
    }, 1_000))

  await instance.unmount()
  term.dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
