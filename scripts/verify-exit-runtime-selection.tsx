/**
 * Runtime-selection regression for finishExit (PR #701 integration review):
 * the explicitly passed render handle is the runtime THIS exit call
 * corresponds to and must WIN over the instances-map lookup. The previous
 * map-first order (`instances.get(process.stdout) ?? handle`) could latch the
 * WRONG runtime when two runtimes exist (multi-instance embedder) or when
 * process.stdout identity drifted after render: finishExit(..., instanceA)
 * would begin/conclude runtime B and write B's terminal cleanup while A —
 * the runtime actually exiting — kept its stdin pump, TTY handlers and mouse
 * state, and A's own stream never received the cleanup bytes.
 *
 * Scenario (from the integration review):
 *   - runtime A renders to stdout A, runtime B renders to stdout B
 *   - process.stdout (and therefore the instances lookup) points at B
 *   - finishExit(..., instanceA, ...) runs
 *   - ONLY A may be begun/concluded; cleanup bytes land ONLY on stdout A;
 *     B must not be latched and must receive no terminal cleanup.
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

interface FakeRuntimeEvents {
  stream: CapturingStream
  events: string[]
  handle: Record<string, unknown>
}

const makeRuntime = (name: string): FakeRuntimeEvents => {
  const stream = new CapturingStream()
  const events: string[] = []
  const stdout = stream as unknown as NodeJS.WriteStream
  const runtime = {
    stdout,
    beginShutdown() { events.push(`${name}:begin`) },
    concludeShutdown() { events.push(`${name}:conclude`) },
    detachStdinForHandoff() { events.push(`${name}:handoff`) },
    drainStdin() { events.push(`${name}:drain`) },
  }
  instances.set(stdout, runtime as never)
  return {
    stream,
    events,
    // The render() handle callers pass: exposes the shutdown hooks, exactly
    // like the Instance returned by root.renderSync.
    handle: runtime as unknown as Record<string, unknown>,
  }
}

const runtimeA = makeRuntime('A')
const runtimeB = makeRuntime('B')

// The instances lookup (keyed by process.stdout) resolves to B — the drift
// scenario: the host swapped process.stdout, or a second runtime mounted on
// the process stream after A rendered to its own custom stdout.
swapStdout(runtimeB.stream as unknown as NodeJS.WriteStream)

let doneCalls = 0
await finishExit(
  ctx,
  runtimeA.handle as never,
  false,
  'exit-notice',
  undefined,
  () => { doneCalls += 1 },
)
swapStdout(originalStdout)
instances.delete(runtimeA.stream as unknown as NodeJS.WriteStream)
instances.delete(runtimeB.stream as unknown as NodeJS.WriteStream)

const cleanupOnA = runtimeA.stream.chunks.join('')
const cleanupOnB = runtimeB.stream.chunks.join('')

check('handle-first: runtime A is the one begun/concluded/handed off',
  runtimeA.events.join(',') === 'A:begin,A:drain,A:conclude,A:handoff')
check('handle-first: runtime B is never latched', runtimeB.events.length === 0)
check('handle-first: terminal cleanup bytes land on stdout A only',
  cleanupOnA.includes('\x1b[?1000l') && cleanupOnA.includes('exit-notice'))
check('handle-first: stdout B receives no terminal cleanup', cleanupOnB === '')
check('handle-first: done() fires exactly once for the winning exit', doneCalls === 1)

// Map fallback still works when NO handle is passed (or the handle carries no
// Ink hooks): the instances lookup must serve the runtime.
const runtimeC = makeRuntime('C')
swapStdout(runtimeC.stream as unknown as NodeJS.WriteStream)
let doneC = false
await finishExit(ctx, undefined, false, 'map-fallback', undefined, () => { doneC = true })
swapStdout(originalStdout)
instances.delete(runtimeC.stream as unknown as NodeJS.WriteStream)
check('map fallback: runtime resolved from instances when no handle given',
  runtimeC.events.join(',') === 'C:begin,C:drain,C:conclude,C:handoff' && doneC)

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
