/**
 * Effort ignition regression — the top-tier reasoning-effort wave band.
 *
 * Part A asserts the math layer (waveform sampling, easings, envelope, the
 * per-column colour contract, boundary guards). Part B mounts the real
 * component in a headless xterm, one harness per scenario, and asserts the
 * properties that make the band safe on a live session, in the same terms
 * as verify-trace-scene's motion gate:
 *
 * - **Every style plays, deterministically.** The component accepts a fixed
 *   `style` prop here, so wave/aurora/pulse each get their own full run —
 *   not whichever one `Math.random` picked this time.
 * - **Animation patches, never repaints.** While the band plays, the write
 *   stream contains no line erase, screen clear, or scroll — frames change
 *   foreground colours only, glyphs are always spaces.
 * - **Mount and unmount never scroll.** The band's one-shot insert/remove
 *   frames are the exact family that once sank the UI into scrollback
 *   (#38/#39/#19/#10); the whole stream, mounting included, must contain
 *   no scroll sequences.
 * - **It cleans up after itself**: painted rows return to zero after each
 *   style's total and the write stream goes quiet.
 * - **Negative paths stay dark**: cold mount on the top tier, a single-tier
 *   table, a missing table, and leaving the top tier must all play nothing.
 *
 * Run: node --import tsx/esm scripts/verify-effort-ignition.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render },
  { EffortIgnitionLine },
  { ClockProvider },
  math,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortIgnitionLine.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/trajectory/effortIgnition.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

// --- Part A: math layer --------------------------------------------------------
check('crest: 1 at the crest, 0 at one half-width out', math.crest(0) === 1 && math.crest(1) === 0)
check('crest: beyond the half-width is silent, both directions',
  math.crest(1.5) === 0 && math.crest(-1) === 0 && math.crest(-2) === 0)
check('easings: endpoints are exact',
  math.easeInCubic(0) === 0 && math.easeInCubic(1) === 1
  && math.easeOutCubic(0) === 0 && math.easeOutCubic(1) === 1
  && math.easeInOutCubic(0) === 0 && math.easeInOutCubic(1) === 1)
check('easings: clamped outside [0,1]',
  math.easeInCubic(-1) === 0 && math.easeOutCubic(2) === 1 && math.easeInOutCubic(-3) === 0)
check('envelope: zero outside the window',
  math.envelope(0, 1, 0.25, 0.4) === 0 && math.envelope(1, 1, 0.25, 0.4) === 0)
check('envelope: fully open in the middle', math.envelope(0.5, 1, 0.25, 0.4) === 1)
check('envelope: ramp sides bind, not max',
  math.envelope(0.1, 1, 0.25, 0.4) < 0.45 && Math.abs(math.envelope(0.1, 1, 0.25, 0.4) - 0.4) < 0.01)
check('line colors: exactly one entry per column',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 40, onLight: false }).length === 40)
check('line colors: empty before start and after the end',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 0, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: math.IGNITION_TOTAL_MS.wave + 1, width: 40, onLight: false }).length === 0)
check('line colors: boundary guards (width 0, negative/NaN/at-total elapsed)',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 0, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: -5, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: Number.NaN, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: math.IGNITION_TOTAL_MS.wave, width: 40, onLight: false }).length === 0)
check('line colors: single-column terminal yields one entry',
  math.ignitionLineColors({ style: 'aurora', elapsedMs: 300, width: 1, onLight: false }).length === 1)
check('line colors: every painted entry is a truecolor rgb() string',
  math
    .ignitionLineColors({ style: 'pulse', elapsedMs: 200, width: 60, onLight: false })
    .every(color => color === undefined || /^rgb\(\d+,\d+,\d+\)$/.test(String(color))))
check('line colors: some columns are painted mid-wave',
  math
    .ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 80, onLight: false })
    .some(color => color !== undefined))
check('random style: never repeats the previous one',
  Array.from({ length: 20 }, () => math.randomIgnitionStyle('wave')).every(style => style !== 'wave'))

// --- Part B: the band plays, patches, never repaints, and cleans up -------------
const LEVELS = ['low', 'medium', 'high'] as const

async function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 200, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
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
  const rgbFgRows = (): number =>
    Array.from({ length: rows }, (_, y) => {
      const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
      if (line === undefined) return false
      for (let x = 0; x < cols; x++) {
        if (line.getCell(x)?.isFgRGB()) return true
      }
      return false
    }).filter(Boolean).length
  const instance = await render(React.createElement(ClockProvider, null, React.createElement(DriverSlot)), {
    stdout: new FakeStdout() as never,
    stdin: new FakeStdin() as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return { term, writes, rgbFgRows, instance }
}

/** Driver slot: the harness mounts one driver; scenarios swap what it renders. */
let driverElement: React.ReactNode = null
function DriverSlot(): React.ReactNode {
  return driverElement
}

/**
 * One scenario: mount, flip effort at t=300ms, sample the playing window
 * [400,1000]ms, then wait past the style's total for self-unmount checks.
 */
async function runBandScenario(style: 'wave' | 'aurora' | 'pulse') {
  const cols = 60
  function Driver(): React.ReactNode {
    const [effort, setEffort] = React.useState<string>('medium')
    React.useEffect(() => {
      const timer = setTimeout(() => setEffort('high'), 300)
      return () => clearTimeout(timer)
    }, [])
    return React.createElement(
      EffortIgnitionLine,
      { effort, levels: LEVELS, columns: cols, onLight: false, style },
    )
  }
  driverElement = React.createElement(Driver)
  const harness = await makeHarness(cols, 8)
  try {
    await sleep(200)
    const darkBefore = harness.rgbFgRows()
    // One-row check sits in the styles' COMMON on-screen window at t=550ms:
    // pulse's ring leaves a 60-col screen around t=665ms (radius ≥ width/2
    // + half-width), wave's crest has entered from the left, aurora always
    // paints. The capture window below still holds frames for every style
    // (pulse paints until ~665ms, wave/aurora to their totals).
    await sleep(350)
    const paintedMidBand = harness.rgbFgRows()
    harness.writes.length = 0
    await sleep(420)
    const stream = harness.writes.join('')
    const repaints = [
      ['erase line', /\x1b\[[0-2]?K/],
      ['erase screen', /\x1b\[[0-3]?J/],
      ['scroll up', /\x1b\[\d*S/],
      ['scroll down', /\x1b\[\d*T/],
    ] as const
    const offenders = repaints.filter(([, pattern]) => pattern.test(stream)).map(([name]) => name)
    check(`${style}: no repaint escapes while playing`, offenders.length === 0,
      offenders.length === 0 ? `${stream.length} bytes over the band` : offenders.join(', '))
    check(`${style}: paints truecolor foregrounds`, /\x1b\[38;2;/.test(stream), `${stream.length} bytes`)
    check(`${style}: exactly one painted row`, paintedMidBand === 1, `${paintedMidBand} rows`)
    check(`${style}: dark before the switch`, darkBefore === 0)
    // Self-unmount: past every style's total (≤1300ms from the 300ms switch,
    // so t=1650ms is past all of them), plus a quiet tail.
    await sleep(700)
    check(`${style}: self-unmounts after its total`, harness.rgbFgRows() === 0, `${harness.rgbFgRows()} rows`)
    harness.writes.length = 0
    await sleep(300)
    check(`${style}: write stream goes quiet`, !/\x1b\[38;2;/.test(harness.writes.join('')))
  } finally {
    harness.instance.unmount()
    driverElement = null
  }
}

for (const style of ['wave', 'aurora', 'pulse'] as const) {
  await runBandScenario(style)
}

// --- Negative paths: these must stay completely dark ---------------------------
async function runDarkScenario(name: string, makeDriver: () => React.ReactNode) {
  driverElement = makeDriver()
  const harness = await makeHarness(60, 8)
  try {
    await sleep(300)
    harness.writes.length = 0
    await sleep(1300)
    const stream = harness.writes.join('')
    check(`${name}: no ignition at all`,
      harness.rgbFgRows() === 0 && !/\x1b\[38;2;/.test(stream))
  } finally {
    harness.instance.unmount()
    driverElement = null
  }
}

await runDarkScenario('cold mount on the top tier', () =>
  React.createElement(EffortIgnitionLine, { effort: 'high', levels: LEVELS, columns: 60, onLight: false }))
await runDarkScenario('single-tier table', () =>
  React.createElement(EffortIgnitionLine, { effort: 'high', levels: ['high'], columns: 60, onLight: false }))
await runDarkScenario('missing level table', () =>
  React.createElement(EffortIgnitionLine, { effort: 'high', levels: undefined, columns: 60, onLight: false }))
await runDarkScenario('leaving the top tier', () => {
  function Driver(): React.ReactNode {
    const [effort, setEffort] = React.useState<string>('high')
    React.useEffect(() => {
      const timer = setTimeout(() => setEffort('medium'), 300)
      return () => clearTimeout(timer)
    }, [])
    return React.createElement(EffortIgnitionLine, { effort, levels: LEVELS, columns: 60, onLight: false })
  }
  return React.createElement(Driver)
})

// --- Mount/unmount frames never scroll the buffer -------------------------------
// The band inserts and removes a whole row; those one-shot frames are the
// shrink-frame family from #38/#39/#19/#10. Capture a full lifecycle in one
// stream (mount → play → unmount) and assert no scroll sequences at all.
{
  const cols = 60
  function Driver(): React.ReactNode {
    const [effort, setEffort] = React.useState<string>('medium')
    React.useEffect(() => {
      const timer = setTimeout(() => setEffort('high'), 200)
      return () => clearTimeout(timer)
    }, [])
    return React.createElement(
      EffortIgnitionLine, { effort, levels: LEVELS, columns: cols, onLight: false, style: 'pulse' })
  }
  driverElement = React.createElement(Driver)
  const harness = await makeHarness(cols, 8)
  await sleep(1800)
  const stream = harness.writes.join('')
  check('lifecycle (mount+play+unmount): no scroll sequences',
    !/\x1b\[\d*S/.test(stream) && !/\x1b\[\d*T/.test(stream))
  harness.instance.unmount()
  driverElement = null
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
