/**
 * Effort accent regression — the prompt prefix consumes the prompt-owned
 * ignition frame instead of owning another clock or transition detector.
 *
 * Run: node --import tsx/esm scripts/verify-effort-accent.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider },
  { EffortChargeGlyph },
  { EffortIgnitionContext },
  { CHARGE_MS },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortChargeGlyph.js'),
  import('../src/components/EffortIgnitionContext.js'),
  import('../src/trajectory/effortIgnition.js'),
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
function firstRow(): string {
  const line = term.buffer.active.getLine(term.buffer.active.baseY)
  if (line === undefined) return ''
  return Array.from({ length: cols }, (_, x) => line.getCell(x)?.getChars() ?? '').join('')
}
function prefixFg(): number | undefined {
  const cell = term.buffer.active.getLine(term.buffer.active.baseY)?.getCell(0)
  return cell?.isFgRGB() ? cell.getFgColor() : undefined
}
function prefixBold(): boolean {
  const cell = term.buffer.active.getLine(term.buffer.active.baseY)?.getCell(0)
  return (cell?.isBold() ?? 0) > 0
}

let setEffort: React.Dispatch<React.SetStateAction<string | undefined>> = () => {}
let setElapsed: React.Dispatch<React.SetStateAction<number | null>> = () => {}
function Driver(): React.ReactNode {
  const [effort, updateEffort] = React.useState<string | undefined>('medium')
  const [elapsed, updateElapsed] = React.useState<number | null>(null)
  setEffort = updateEffort
  setElapsed = updateElapsed
  const frame = elapsed === null
    ? null
    : { label: effort?.toUpperCase() ?? '', style: 'ltr' as const, elapsedMs: elapsed, durationMs: 900 }
  return (
    <ThemeProvider theme="dark">
      <EffortIgnitionContext.Provider value={frame}>
        <EffortChargeGlyph effort={effort} levels={['low', 'medium', 'high', 'max']} working={false} />
      </EffortIgnitionContext.Provider>
    </ThemeProvider>
  )
}

const stdout = new FakeStdout()
const instance = await render(<Driver />, {
  stdout: stdout as never,
  stdin: new FakeStdin() as never,
  stderr: stdout as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
const settle = async (): Promise<void> => { await sleep(45) }

try {
  await settle()
  check('unsupported tier: plain prefix, no accent', firstRow().startsWith('❯') && prefixFg() === undefined && !prefixBold())

  setEffort('high')
  setElapsed(0)
  await settle()
  const start = prefixFg()
  check('supported tier starts bold truecolor charge', start !== undefined && prefixBold())

  setElapsed(Math.floor(CHARGE_MS / 2))
  await settle()
  const middle = prefixFg()
  setElapsed(CHARGE_MS)
  await settle()
  const full = prefixFg()
  check('charge changes color across its bounded window', start !== undefined && middle !== undefined && full !== undefined && start !== middle && middle !== full)
  check('past the charge window: accent stays solid', prefixBold() && full !== undefined)

  setElapsed(null)
  await settle()
  check('supported tier keeps its steady accent after ignition', prefixBold() && prefixFg() === full)

  setEffort('medium')
  await settle()
  check('leaving supported tiers restores the plain prefix', prefixFg() === undefined && !prefixBold())
} finally {
  instance.unmount()
}

{
  const ansiTerm = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
  class AnsiStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      ansiTerm.write(String(chunk), callback)
    }
  }
  function AnsiDriver(): React.ReactNode {
    return (
      <ThemeProvider theme="dark-ansi">
        <EffortIgnitionContext.Provider
          value={{ label: 'ULTRA', style: 'outward', elapsedMs: CHARGE_MS, durationMs: 900 }}
        >
          <EffortChargeGlyph effort="ultra" levels={['ultra']} working={false} />
        </EffortIgnitionContext.Provider>
      </ThemeProvider>
    )
  }
  const ansi = await render(<AnsiDriver />, {
    stdout: new AnsiStdout() as never,
    stdin: new FakeStdin() as never,
    stderr: new AnsiStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  try {
    await settle()
    const cell = ansiTerm.buffer.active.getLine(ansiTerm.buffer.active.baseY)?.getCell(0)
    check('ANSI theme: steady prefix uses a palette color without invented truecolor',
      cell?.isFgPalette() === true && cell.isFgRGB() === false,
      `palette=${cell?.getFgColor()}`)
  } finally {
    ansi.unmount()
    ansiTerm.dispose()
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
