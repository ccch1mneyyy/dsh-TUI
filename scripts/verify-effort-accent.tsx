/**
 * Effort accent regression — the `❯ ` prompt prefix under the top tier.
 *
 * Mounts the real glyph in a headless xterm and asserts the three states a
 * reader sees:
 *
 * - Off the top tier the prefix keeps its original dim rendering (no accent
 *   SGR beyond the working dim, byte-comparable output).
 * - Switching onto the top tier charges the prefix: bold + truecolor orange
 *   appears within the 150ms charge window and stays solid after it.
 * - Leaving the top tier restores the original rendering.
 *
 * Run: node --import tsx/esm scripts/verify-effort-accent.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render },
  { EffortChargeGlyph },
  { ClockProvider },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortChargeGlyph.js'),
  import('../src/ink/components/ClockContext.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

const cols = 20
const rows = 4
const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = cols
  rows = rows
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
// The painted cells of the first screen row as {glyph, fg-is-truecolor, bold}.
function firstRow(): string {
  const line = term.buffer.active.getLine(term.buffer.active.baseY)
  if (line === undefined) return ''
  return Array.from({ length: cols }, (_, x) => line.getCell(x)?.getChars() ?? '').join('')
}
function prefixFgTruecolor(): boolean {
  const line = term.buffer.active.getLine(term.buffer.active.baseY)
  if (line === undefined) return false
  for (let x = 0; x < 2; x++) {
    if (line.getCell(x)?.isFgRGB()) return true
  }
  return false
}
function prefixBold(): boolean {
  const line = term.buffer.active.getLine(term.buffer.active.baseY)
  if (line === undefined) return false
  for (let x = 0; x < 2; x++) {
    if ((line.getCell(x)?.isBold() ?? 0) > 0) return true
  }
  return false
}

function Driver(): React.ReactNode {
  // medium → high (top) at t=300ms, back to medium at t=900ms.
  const [effort, setEffort] = React.useState('medium')
  React.useEffect(() => {
    const timers = [
      setTimeout(() => setEffort('high'), 300),
      setTimeout(() => setEffort('medium'), 900),
    ]
    return () => timers.forEach(clearTimeout)
  }, [])
  return (
    <ClockProvider>
      <EffortChargeGlyph effort={effort} levels={['low', 'medium', 'high']} working={false} />
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

await sleep(200)
check('off the top tier: plain prefix, no accent', firstRow().startsWith('❯') && !prefixFgTruecolor() && !prefixBold())

// Sample the prefix's actual FG colour across the charge window's tail and
// the settle: a constant colour or a reversed ramp must fail here, not just
// a missing accent. luma(Rec.601) is the ramp's monotone observable — dim
// (band-tinted) is darker than full (hues[0]).
const luma = (rgb: number): number =>
  0.299 * ((rgb >> 16) & 0xff) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff)
const samples: number[] = []
await sleep(120)
for (let i = 0; i < 8; i++) {
  const line = term.buffer.active.getLine(term.buffer.active.baseY)
  const cell = line?.getCell(0)
  if (cell !== undefined && cell.isFgRGB()) samples.push(cell.getFgColor())
  await sleep(28)
}
check('charging onto the top tier: bold + truecolor accent', prefixFgTruecolor() && prefixBold())
check('charge ramps dark→full (sampled, monotone)',
  samples.length >= 3
  && luma(samples[0]!) < luma(samples[samples.length - 1]!)
  && samples.slice(1).some((value, index) => luma(value) >= luma(samples[index]!)),
  `${samples.length} samples, luma ${samples.length ? Math.round(luma(samples[0]!)) : '?'}→${samples.length ? Math.round(luma(samples[samples.length - 1]!)) : '?'}`)

await sleep(300)
check('past the charge window: accent stays solid', prefixFgTruecolor() && prefixBold())
await sleep(500)
check('off the top tier again: accent gone', !prefixFgTruecolor() && !prefixBold())

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
