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
await sleep(230)
check('charging onto the top tier: bold + truecolor accent', prefixFgTruecolor() && prefixBold())
await sleep(400)
check('past the charge window: accent stays solid', prefixFgTruecolor() && prefixBold())
await sleep(500)
check('off the top tier again: accent gone', !prefixFgTruecolor() && !prefixBold())

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
