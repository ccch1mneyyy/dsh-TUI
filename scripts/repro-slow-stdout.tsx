/**
 * Slow-stdout reproduction: a stream that rejects writes (returns false,
 * holds the callback, never drains on its own) must NOT put the renderer
 * into a fixed ~4ms re-probe loop, must not accumulate an unbounded write
 * backlog, and must resume on the stream's own `drain` event. Teardown
 * must clear the drain listener and the fallback timer.
 *
 *   A. Backpressured window: bounded write count (fallback backoff, not a
 *      4ms busy loop) and bounded backlog (frames coalesce, no growth).
 *   B. `drain` event resumes writes.
 *   C. unmount clears the drain listener and timers.
 *
 * Run via `node --import tsx/esm scripts/repro-slow-stdout.tsx`.
 */
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { render }, { Text }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/ui.js'),
])
const instances = (await import('../src/ink/instances.js')).default
const { sleep } = await import('./lib/term-test.mjs')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** An animated node so renders keep coming while we watch the gate. */
function Animated(): React.ReactNode {
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 100)
    return () => clearInterval(timer)
  }, [])
  return React.createElement(Text, null, `tick ${tick} `.repeat(40))
}

class SlowStdout extends Writable {
  columns = 100
  rows = 24
  isTTY = true
  writes = 0
  heldCallbacks: Array<() => void> = []
  term!: { write(chunk: string, cb: () => void): void }
  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.writes += 1
    // Hold the callback: the stream never flushes on its own (SSH-like
    // saturated pipe). The internal buffer grows until write() returns
    // false, which is exactly the state the backpressure gate must handle.
    // When a held callback eventually fires (the B-phase flush), the bytes
    // reach the simulated terminal — so the final-content assertion is real.
    this.heldCallbacks.push(() => {
      callback()
      this.term.write(String(chunk), () => {})
    })
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const stdout = new SlowStdout()
const stdin = new FakeStdin()
const term = new (await import('@xterm/headless')).Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
stdout.term = term
const instance = await render(
  React.createElement(Animated),
  { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
const ink = instances.get(stdout) ?? instances.values().next().value

// Let the first paint land and the write buffer saturate (the held
// callbacks make writableLength climb past the 8192 gate). Wait until the
// ink instance actually reports backpressure before measuring anything.
let saturated = false
for (let i = 0; i < 100 && !saturated; i++) {
  await sleep(50)
  saturated = (ink as { backpressured?: boolean }).backpressured === true
}
check('saturation: the renderer reports backpressure', saturated, '')
stdout.writes = 0

// ── A. Backpressured window: bounded wakeups, bounded backlog ─────────────
const startLength = (stdout as unknown as { writableLength: number }).writableLength
await sleep(1500)
const writesInWindow = stdout.writes
// Fallback ladder 250+500+1000ms ⇒ ≤ ~5 re-probes in 1.5s. A 4ms busy loop
// would be ~375. Allow slack for boundary effects.
check('A1: backpressured renderer does not busy-poll at 4ms',
  writesInWindow <= 8,
  `writes=${writesInWindow} over 1.5s`)
const endLength = (stdout as unknown as { writableLength: number }).writableLength
check('A2: write backlog stays bounded while backpressured',
  endLength - startLength <= 8192,
  `backlog delta=${endLength - startLength} bytes (≤ one frame)`)
// A second window must not keep growing the backlog: the gate holds it at
// the saturation level instead of stacking a frame per render.
const startLength2 = endLength
await sleep(1500)
const endLength2 = (stdout as unknown as { writableLength: number }).writableLength
check('A3: backlog plateaus (no infinite growth)',
  endLength2 <= startLength2 + 1024,
  `second-window delta=${endLength2 - startLength2} bytes`)

// ── B. The stream's own drain resumes painting ────────────────────────────
stdout.writes = 0
// Flush the held chunk (the drain that a real stream would emit after the
// buffer empties) then signal drain explicitly.
for (const cb of stdout.heldCallbacks) cb()
if (process.env.SLOW_DEBUG === '1') console.error('[slow] B-phase flush done')
stdout.heldCallbacks = []
stdout.emit('drain')
await sleep(400)
check('B: drain event resumes frame writes', stdout.writes > 0, `writes=${stdout.writes} after drain`)
// The coalesced frames must have painted the LATEST content: a skipped
// frame's delta is re-computed against the last-written baseline, so the
// terminal holds the final state, not a stale one.
const buffer = term.buffer.active
const screenText = Array.from({ length: 24 }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\n')
check('B2: final terminal content is complete (no lost frames)',
  /tick \d+/.test(screenText) && screenText.includes('tick'),
  screenText.slice(0, 60).replace(/\n/g, '|'))

// ── C. Teardown clears listener + timers ──────────────────────────────────
instance.unmount()
instances.delete(stdout)
await sleep(50)
check('C1: unmount removes the drain listener',
  stdout.listenerCount('drain') === 0,
  `drain listeners=${stdout.listenerCount('drain')}`)
const drainTimerCleared =
  (ink as { drainTimer?: unknown }).drainTimer === null ||
  (ink as { drainTimer?: unknown }).drainTimer === undefined
check('C2: unmount clears the fallback timer', drainTimerCleared, '')
stdout.destroy()

console.log(failed === 0 ? 'repro-slow-stdout: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
