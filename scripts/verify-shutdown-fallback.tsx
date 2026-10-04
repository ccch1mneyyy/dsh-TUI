/**
 * Shutdown fallback regression: finishExit() normally finds the live Ink
 * runtime keyed by process.stdout and detaches it without running the full
 * unmount (a second EXIT_ALT_SCREEN would clobber the resume hint). When the
 * runtime lookup misses (custom stdout embedders), it must fall back to a
 * full instance.unmount() so raw mode / alt screen are restored before the
 * notice is written and control returns to the shell.
 */
import { readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { createExitFunnel, finishExit, runCrashExit } from '../src/dsh-adapter/plugin.js'
import { UNSERIALIZABLE } from '../src/utils/crashDetail.js'
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

// ── Cases C/D (r1-stability S03): the crash tail's diagnostics are fully ──
// degradable while the terminal cleanup runs exactly once, no matter what
// the sinks or the throwable do. Drives the REAL createExitFunnel around
// the REAL runCrashExit with fault-injected sinks — the pre-fix shape (a
// serializer escape skipping finishExit → "exited but not cleaned up") goes
// red here.
{
  // Case C: EVERYTHING throws — serializer, every log sink, the marker write.
  const finishCalls: string[] = []
  let resumeAttempts = 0
  const boom = (): never => { throw new Error('sink boom') }
  const funnelC = createExitFunnel({
    onUserExit: err => {
      runCrashExit({
        error: err,
        serialize: boom,
        logError: boom,
        appendLog: boom,
        logRestart: boom,
        logDebug: boom,
        writeResumeMarkers: () => { resumeAttempts += 1; boom() },
        finish: line => { finishCalls.push(line) },
      })
    },
  })
  let escaped = false
  let acceptedC = false
  try {
    acceptedC = funnelC.handleExit(new Error('the crash'))
  } catch {
    escaped = true
  }
  check('funnel: total sink failure does not escape handleExit', !escaped && acceptedC)
  check('funnel: cleanup (finish) ran exactly once with the fallback crash line',
    finishCalls.length === 1 && finishCalls[0] === ('dsh-tui crashed: ' + UNSERIALIZABLE), finishCalls.join(' | '))
  check('funnel: resume markers attempted despite total diagnostics failure', resumeAttempts === 1)
  check('funnel: latch intact — a second handleExit is refused after cleanup ran', funnelC.handleExit(new Error('second')) === false)
}
{
  // Case D: a hostile throwable through the REAL serializer + a MID-CHAIN
  // sink failure (appendLog throws after logError succeeded): the fallback
  // relabels the detail and the cleanup still runs exactly once.
  const hostile = new Error('real message')
  for (const key of ['stack', 'componentStack', 'digest'] as const) {
    Object.defineProperty(hostile, key, { get: (): never => { throw new Error('getter boom') }, configurable: true })
  }
  const loggedSummaries: string[] = []
  const finishCalls: string[] = []
  const funnelD = createExitFunnel({
    onUserExit: err => {
      runCrashExit({
        error: err,
        logError: message => { loggedSummaries.push(message) },
        appendLog: () => { throw new Error('appendLog boom') },
        logRestart: () => undefined,
        logDebug: () => undefined,
        writeResumeMarkers: () => undefined,
        finish: line => { finishCalls.push(line) },
      })
    },
  })
  const acceptedD = funnelD.handleExit(hostile)
  check('funnel: hostile throwable + mid-chain sink failure still accepted', acceptedD)
  check('funnel: cleanup ran exactly once with the fallback line after the mid-chain failure',
    finishCalls.length === 1 && finishCalls[0] === ('dsh-tui crashed: ' + UNSERIALIZABLE), finishCalls.join(' | '))
  check('funnel: first attempt logged the real (degraded) summary, fallback relabeled',
    loggedSummaries.length === 2 && loggedSummaries[1] === ('dsh-tui: exit after error: Error: ' + UNSERIALIZABLE), loggedSummaries.join(' | '))
  // The wiring itself: the funnel's finish handoff exits non-zero.
  const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  check('funnel wiring: crash finish hands off to disposeRootAndExit(ctx, 1)',
    pluginSource.includes('finish: crashLine =>') && pluginSource.includes('disposeRootAndExit(ctx, 1)'))
}

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
