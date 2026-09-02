/**
 * Shutdown fallback regression: finishExit() normally finds the live Ink
 * runtime keyed by process.stdout and detaches it without running the full
 * unmount (a second EXIT_ALT_SCREEN would clobber the resume hint). When the
 * runtime lookup misses (custom stdout embedders), it must fall back to a
 * full instance.unmount() so raw mode / alt screen are restored before the
 * notice is written and control returns to the shell.
 */
import { Writable } from 'node:stream'
import { finishExit } from '../src/dsh-adapter/plugin.js'
import instances from '../src/ink/instances.js'

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

class CapturingStream extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(String(chunk))
    cb()
  }
}

const captured = new CapturingStream() as unknown as NodeJS.WriteStream
const originalStdout = process.stdout
const swapStdout = (stream: NodeJS.WriteStream): void => {
  Object.defineProperty(process, 'stdout', {
    value: stream,
    configurable: true,
    writable: true,
    enumerable: true,
  })
}

const ctx = { logger: { debug() {} } } as never
const fakeInstance = (unmount: () => void) => ({ unmount }) as never

// Case A: runtime lookup miss → full unmount must run before the notice write.
let unmountsA = 0
let doneA = false
swapStdout(captured)
instances.delete(captured)
await finishExit(
  ctx,
  fakeInstance(() => { unmountsA += 1 }),
  false,
  'hint-one',
  undefined,
  () => { doneA = true },
)
swapStdout(originalStdout)
check('runtime-miss shutdown falls back to instance.unmount', unmountsA === 1 && doneA)
check('runtime-miss shutdown still prints the notice', captured.chunks.join('').includes('hint-one'))

// Case B: runtime present → detach path runs, unmount stays untouched.
captured.chunks.length = 0
let detaches = 0
let handoffs = 0
instances.set(captured, {
  detachForShutdown() { detaches += 1 },
  detachStdinForHandoff() { handoffs += 1 },
} as never)
let unmountsB = 0
let doneB = false
swapStdout(captured)
await finishExit(
  ctx,
  fakeInstance(() => { unmountsB += 1 }),
  false,
  'hint-two',
  undefined,
  () => { doneB = true },
)
swapStdout(originalStdout)
instances.delete(captured)
check('runtime-present shutdown detaches without unmount', detaches === 1 && handoffs === 1 && unmountsB === 0 && doneB)
check('runtime-present shutdown prints the notice', captured.chunks.join('').includes('hint-two'))

// Case C: concurrent finishExit calls share ONE cleanup — the second awaits
// the in-flight first and deliberately never invokes its own done(): the
// process-level exit action belongs to the exit that actually ran the
// terminal cleanup (double-run would repeat the exit sequence and could
// spawn the /update or /restart handoff twice).
const streamC = new CapturingStream() as unknown as NodeJS.WriteStream
const eventsC: string[] = []
instances.set(streamC, {
  stdout: streamC,
  beginShutdown() { eventsC.push('begin') },
  concludeShutdown() { eventsC.push('conclude') },
  detachStdinForHandoff() { eventsC.push('handoff') },
  drainStdin() {},
} as never)
swapStdout(streamC)
let doneC1 = 0
let doneC2 = 0
await Promise.all([
  finishExit(ctx, fakeInstance(() => {}), false, 'hint-concurrent', undefined, () => { doneC1 += 1 }),
  finishExit(ctx, fakeInstance(() => {}), false, 'hint-concurrent', undefined, () => { doneC2 += 1 }),
])
swapStdout(originalStdout)
instances.delete(streamC)
const noticeCount = streamC.chunks.join('').split('hint-concurrent').length - 1
check('concurrent finishExit runs latch/conclude/handoff exactly once', eventsC.join(',') === 'begin,conclude,handoff')
check('concurrent finishExit writes the exit sequence once', noticeCount === 1)
check('concurrent finishExit invokes done() once (first caller wins)', doneC1 === 1 && doneC2 === 0)

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
