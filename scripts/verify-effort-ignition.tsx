/**
 * Effort ignition regression — the top-tier reasoning-effort wave band.
 *
 * Part A asserts the math layer (waveform sampling, easings, envelope, the
 * per-column colour contract). Part B mounts the real component in a
 * headless xterm and asserts the property that makes the band safe on a
 * live session, in the same terms as verify-trace-scene's motion gate:
 *
 * - **Animation patches, never repaints.** While the band is playing, the
 *   write stream contains no line erase, screen clear, or scroll — the band
 *   changes background colours only, glyphs are always spaces.
 * - **The band actually plays**: truecolor background SGR appears right
 *   after the effort switch, on exactly one screen row.
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
check('crest: beyond the half-width is silent', math.crest(1.5) === 0)
check('easings: endpoints are exact',
  math.easeInCubic(0) === 0 && math.easeInCubic(1) === 1
  && math.easeOutCubic(0) === 0 && math.easeOutCubic(1) === 1
  && math.easeInOutCubic(0) === 0 && math.easeInOutCubic(1) === 1)
check('easings: clamped outside [0,1]',
  math.easeInCubic(-1) === 0 && math.easeOutCubic(2) === 1 && math.easeInOutCubic(-3) === 0)
check('envelope: zero outside the window',
  math.envelope(0, 1, 0.25, 0.4) === 0 && math.envelope(1, 1, 0.25, 0.4) === 0)
check('envelope: fully open in the middle', math.envelope(0.5, 1, 0.25, 0.4) === 1)
check('line colors: exactly one entry per column',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 40, onLight: false }).length === 40)
check('line colors: empty before start and after the end',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 0, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: math.IGNITION_TOTAL_MS.wave + 1, width: 40, onLight: false }).length === 0)
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

// --- Part B: the band plays, patches, never repaints ----------------------------
const cols = 60
const rows = 8
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
const rgbBgRows = (): number =>
  Array.from({ length: rows }, (_, y) => {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
    if (line === undefined) return false
    for (let x = 0; x < cols; x++) {
      if (line.getCell(x)?.isBgRGB()) return true
    }
    return false
  }).filter(Boolean).length

function Driver(): React.ReactNode {
  const [effort, setEffort] = React.useState('medium')
  React.useEffect(() => {
    const timer = setTimeout(() => setEffort('high'), 300)
    return () => clearTimeout(timer)
  }, [])
  return (
    <ClockProvider>
      <EffortIgnitionLine
        effort={effort}
        levels={['low', 'medium', 'high']}
        columns={cols}
        onLight={false}
      />
    </ClockProvider>
  )
}

render(<Driver />, {
  stdout: new FakeStdout() as never,
  stdin: new FakeStdin() as never,
  stderr: new FakeStdout() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
await sleep(250)
check('no band before the effort switch', rgbBgRows() === 0, `${rgbBgRows()} painted rows`)
writes.length = 0
// The switch fires at t=300ms; capture [400ms, 1000ms] — inside every
// style's playing window (totals are 900–1300ms), away from the mount and
// unmount frames, which are one-shot layout changes, not animation frames.
await sleep(150)
writes.length = 0
await sleep(600)
const stream = writes.join('')
const repaints = [
  ['erase line', /\x1b\[[0-2]?K/],
  ['erase screen', /\x1b\[[0-3]?J/],
  ['scroll up', /\x1b\[\d*S/],
  ['scroll down', /\x1b\[\d*T/],
] as const
const offenders = repaints.filter(([, pattern]) => pattern.test(stream)).map(([name]) => name)
check('ignition band emits no repaint escapes', offenders.length === 0,
  offenders.length === 0 ? `${stream.length} bytes over the band` : offenders.join(', '))
check('ignition band paints truecolor backgrounds', /\x1b\[48;2;/.test(stream), `${stream.length} bytes`)
check('ignition band stays on one screen row', rgbBgRows() === 1, `${rgbBgRows()} painted rows`)

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
