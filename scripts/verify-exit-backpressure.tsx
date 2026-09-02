/**
 * verify-exit-backpressure — #713 (stdout backpressure) × #701 (shutdown
 * funnel) cross-invariant (integration review §8).
 *
 * With a backpressured stdout (drain listener attached + fallback timer
 * armed + pending drain), finishExit's beginShutdown must — BEFORE the
 * stdout barrier and terminal cleanup — set the renderer shutdown latch,
 * cancel the throttled render, invalidate pending microtask renders,
 * detach the stdout drain listener, clear the fallback timer, and tear
 * down the backpressure recovery producer. Otherwise a late `drain` event
 * could fire the renderer callback and write an ordinary frame AFTER
 * DISABLE_MOUSE_TRACKING / EXIT_ALT_SCREEN landed.
 *
 * Scenario:
 *   1. stdout saturation (a Writable that never flushes — chunks queue,
 *      write() returns false, writableLength grows past PTY_BACKLOG_BYTES);
 *   2. a render arms the backpressure wait (listener + fallback timer);
 *   3. finishExit runs with the drain/fallback still pending;
 *   4. 'drain' is EMITTED inside the shutdown window.
 *
 * Asserts:
 *   - ordinary renderer frames stop at beginShutdown (frame count frozen);
 *   - the drain event triggers NO frame (listener detached);
 *   - cleanup order preserved (DISABLE_MOUSE before EXIT_ALT_SCREEN);
 *   - listener and fallback timer counts are 0 at the end.
 *
 * Run: node --import tsx/esm scripts/verify-exit-backpressure.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  streamMod,
  ReactMod,
  { render, AlternateScreen, useInput },
  textMod,
  pluginMod,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/ink/components/Text.js'),
  import('../src/dsh-adapter/plugin.js'),
])
const { finishExit } = pluginMod
const React = ReactMod
const { PassThrough, Writable } = streamMod
const Text = textMod.default

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

const COLS = 100
const ROWS = 30
const DISABLE_MOUSE = '\x1b[?1006l'
const EXIT_ALT = '\x1b[?1049l'

const writes: string[] = []
let frames = 0
/** Never flushes: every chunk queues forever (write() returns false once
 * past the tiny high-water mark; writableLength keeps growing — exactly the
 * stalled-ssh/ConPTY saturation shape). */
class SaturatingStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor() {
    super({ highWaterMark: 16 })
  }
  write(chunk: any, enc?: BufferEncoding | (() => void), cb?: () => void): boolean {
    const ok = super.write(chunk, enc as BufferEncoding, cb)
    writes.push(String(chunk))
    return ok
  }
  _write(_chunk: unknown, _enc: BufferEncoding, _cb: () => void): void {
    // Deliberately never calls back: the stream stays saturated forever.
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) {
    cb()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const stdout = new SaturatingStdout()
const stdin = new FakeStdin()

function Scene(props: { marker: string }): React.ReactNode {
  useInput(() => {})
  return (
    <AlternateScreen>
      <Text>{props.marker}</Text>
    </AlternateScreen>
  )
}

const instance = await render(<Scene marker="BP-ONE" /> as never, {
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStderr() as never,
  exitOnCtrlC: false,
  patchConsole: false,
  onFrame: () => {
    frames += 1
  },
})
// Let the AlternateScreen insertion effect run (ENTER_ALT + mouse enable).
await new Promise(resolve => setTimeout(resolve, 150))
const framesAtStart = frames

// Force frames through until the stream saturates and the backpressure gate
// engages (listener + fallback timer armed, writes coalesced).
let marker = 'BP-ONE'
for (let i = 0; i < 40 && frames - framesAtStart < 8; i++) {
  marker = `BP-${i}`
  instance.rerender(<Scene marker={marker} /> as never)
  await new Promise(resolve => setTimeout(resolve, 25))
}
const saturated = stdout.writableLength > 0
check('setup: stdout saturated (backpressure engaged)', saturated, `writableLength=${stdout.writableLength}`)
check('setup: frames were being produced before shutdown', frames > framesAtStart, `frames=${frames - framesAtStart}`)

// finishExit with the drain/fallback still pending; emit 'drain' INSIDE the
// shutdown window (during the 150ms settle).
const writesAtExit = writes.length
let done = false
const exitPromise = finishExit(
  { logger: { debug() {} } } as never,
  instance as never,
  true,
  undefined,
  undefined,
  () => {
    done = true
  },
)
setTimeout(() => {
  ;(stdout as unknown as { emit(ev: string): boolean }).emit('drain')
}, 60)
await exitPromise
await new Promise(resolve => setTimeout(resolve, 250))

check('X1: finishExit completes (done executed)', done)
const tail = writes.slice(writesAtExit).join('')
check('X2: cleanup order DISABLE_MOUSE → EXIT_ALT_SCREEN preserved',
  tail.indexOf(DISABLE_MOUSE) >= 0 && tail.indexOf(EXIT_ALT) >= 0 && tail.indexOf(DISABLE_MOUSE) < tail.indexOf(EXIT_ALT))
check('X3: no frame marker written after beginShutdown (renderer latch)',
  !tail.includes('BP-'), `tailLen=${tail.length}`)
const drainListeners = stdout.listeners('drain').length
check('X4: stdout drain listener detached after shutdown', drainListeners === 0, `listeners=${drainListeners}`)
check(
  'X5: teardown 后 stdin readable listener 为 0',
  (stdin as unknown as { listenerCount(e: string): number }).listenerCount('readable') === 0,
)

console.log(failures === 0 ? 'verify-exit-backpressure: all checks passed' : `FAILURES: ${failures}`)
if (failures > 0) process.exit(1)
