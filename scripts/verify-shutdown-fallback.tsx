/**
 * Shutdown fallback regression: finishExit() normally finds the live Ink
 * runtime keyed by process.stdout and detaches it without running the full
 * unmount (a second EXIT_ALT_SCREEN would clobber the resume hint). When the
 * runtime lookup misses (custom stdout embedders), it must fall back to a
 * full instance.unmount() so raw mode / alt screen are restored before the
 * notice is written and control returns to the shell.
 */
import { readFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { settled } from './lib/term-test.mjs'
import React from 'react'
import { createRoot, render, AlternateScreen, Text, useInput } from '../src/ui.js'
import { claimShutdownInput, getShutdownInput } from '../src/ink/shutdown-input.js'
import { cursorMove } from '../src/ink/termio/csi.js'
import { Context } from '@deepseek-ai/cordis'
import { createExitFunnel, finishExit, runCrashExit, writeCrashResumeMarkers } from '../src/dsh-adapter/plugin.js'
import { UNSERIALIZABLE } from '../src/utils/crashDetail.js'
import instances from '../src/ink/instances.js'
import { ESU, EXIT_ALT_SCREEN, DISABLE_MOUSE_TRACKING } from '../src/ink/termio/dec.js'

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
  onWrite?: (data: string) => void
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(String(chunk))
    this.onWrite?.(String(chunk))
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
  true,
  'hint-one',
  undefined,
  () => { doneA = true },
)
swapStdout(originalStdout)
check('runtime-miss shutdown falls back to instance.unmount', unmountsA === 1 && doneA)
check('unknown legacy unmount retains generic alt-screen cleanup', captured.chunks.join('').includes(EXIT_ALT_SCREEN))
check('runtime-miss shutdown still prints the notice', captured.chunks.join('').includes('hint-one'))
check('runtime-miss cleanup ends synchronized output without a frame', captured.chunks.join('').includes(ESU))

// Case B: runtime present → detach path runs, unmount stays untouched.
captured.chunks.length = 0
let detaches = 0
let handoffs = 0
instances.set(captured, {
  detachForShutdown() { detaches += 1 },
  detachStdinForHandoff() { handoffs += 1 },
  frontFrame: { cursor: { x: 12, y: 8 } },
  displayCursor: { x: 3, y: 2 },
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
check('normal inline cleanup preserves the cursor offset', captured.chunks.join('').includes(cursorMove(9, 6)))
check('runtime-present shutdown prints the notice', captured.chunks.join('').includes('hint-two'))
check('runtime-present cleanup explicitly ends synchronized output', captured.chunks.join('').includes(ESU))

// Actual renderer lease survives a legacy handle with no runtime hooks.
class OwnedInput extends PassThrough {
  isTTY = true
  isRaw = false
  rawCalls = 0
  setRawMode(value: boolean): this { this.rawCalls++; this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
}
for (const mode of ['owned', 'revoked', 'replacement', 'revoked-before', 'replacement-before', 'replacement-root-before', 'non-tty'] as const) {
  const input = new OwnedInput()
  input.isTTY = mode !== 'non-tty'
  const output = new CapturingStream()
  // Non-TTY output keeps the fallback's synchronous final write in the capture.
  output.isTTY = false
  let deviceDrains = 0
  const handle = await createRoot({
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    patchConsole: false,
    drainStdin: () => { deviceDrains++ },
  })
  const originalTree = React.createElement(Text, null, 'owned input')
  handle.render(mode === 'replacement-root-before' ? React.createElement(AlternateScreen, null, originalTree) : originalTree)
  const renderer = instances.get(output as unknown as NodeJS.WriteStream)!
  const lease = getShutdownInput(handle)!
  check(`${mode}: unmount-only legacy handle retains the actual renderer lease`, getShutdownInput({ unmount: handle.unmount }) === lease)
  instances.delete(output as unknown as NodeJS.WriteStream)
  if (mode === 'revoked-before') lease.release()
  if (mode === 'replacement-before') claimShutdownInput(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, () => {})
  let replacement: Awaited<ReturnType<typeof createRoot>> | undefined
  let received = ''
  if (mode === 'replacement-root-before') {
    output.isTTY = true
    function Reader() {
      useInput(text => { received += text })
      return React.createElement(Text, null, 'replacement')
    }
    replacement = await createRoot({ stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, patchConsole: false })
    replacement.render(React.createElement(AlternateScreen, null, React.createElement(Reader)))
  }
  const outputBeforeExit = output.chunks.length
  if (mode.endsWith('-before')) input.push('before-transfer-key')
  const rawBeforeExit = input.rawCalls
  const newReader = () => {}
  if (mode === 'replacement-before') input.on('readable', newReader)
  let unmounts = 0
  if (mode === 'owned') {
    const unmount = renderer.unmount.bind(renderer)
    renderer.unmount = () => { unmounts++; unmount() }
  }
  let rawAfterCleanup = input.rawCalls
  let drainsAfterCleanup = deviceDrains
  output.onWrite = data => {
    if (!data.includes('owned-notice')) return
    rawAfterCleanup = input.rawCalls
    drainsAfterCleanup = deviceDrains
    // Fixed shutdown settle window: replies genuinely arrive after cleanup.
    setTimeout(() => {
      if (mode === 'revoked') lease.release()
      if (mode === 'replacement') claimShutdownInput(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, () => {})
      input.push('\x1b[<0;5;7M\x1b[?8;12;1R')
    }, 20)
  }
  const legacy = mode === 'owned' ? handle : { unmount() { unmounts++; handle.unmount() } }
  await finishExit(ctx, legacy as never,
    false, 'owned-notice', undefined, () => {}, mode === 'owned' ? {} : { shutdownInput: lease })
  check(`${mode}: legacy lookup miss fully unmounts exactly once`, unmounts === 1)
  check(`${mode}: notice written exactly once to actual custom output`, output.chunks.join('').split('owned-notice').length === (mode.endsWith('-before') ? 1 : 2))
  check(`${mode}: late mouse and CPR consumed only by current terminal owner`,
    (input.readableLength === 0) === (mode === 'owned' || mode === 'replacement-root-before'))
  check(`${mode}: late drain never changes custom raw mode`, input.rawCalls === rawAfterCleanup)
  check(`${mode}: device drain is owner-guarded`, deviceDrains - drainsAfterCleanup === (mode === 'owned' ? 1 : 0))
  check(`${mode}: finish revokes its lease`, !lease.ownsInput())
  if (mode.endsWith('-before')) check(`${mode}: already-transferred raw mode remains unchanged`, input.rawCalls === rawBeforeExit)
  if (mode === 'replacement-before') check('replacement listener remains attached', input.listeners('readable').includes(newReader))
  if (replacement !== undefined) {
    check('actual replacement retains its registry entry and input lease', instances.get(output as unknown as NodeJS.WriteStream)?.shutdownInput === replacement.shutdownInput && replacement.shutdownInput.ownsInput())
    input.write('replacement-key')
    await new Promise<void>(resolve => setImmediate(resolve))
    check('actual replacement receives subsequent input', received.includes('replacement-key'))
    const tail = output.chunks.slice(outputBeforeExit).join('')
    check('old root does not exit replacement alternate screen or disable its mouse', !tail.includes(EXIT_ALT_SCREEN) && !tail.includes(DISABLE_MOUSE_TRACKING))
    await instances.get(output as unknown as NodeJS.WriteStream)!.detachForShutdown()
    replacement.unmount()
  }
  input.destroy()
}

// Review regressions: exercise real roots, leases and shutdown, not copied policy.
for (const mode of ['destroyed', 'detached-legacy', 'throwing-drain', 'revoked', 'revoked-error', 'replacement'] as const) {
  const input = new OwnedInput()
  const output = new CapturingStream()
  output.isTTY = mode === 'replacement'
  let effectDisposed = false
  let throwDrain = mode === 'throwing-drain'
  function Owner() {
    useInput(() => {})
    React.useEffect(() => () => { effectDisposed = true }, [])
    return React.createElement(Text, null, 'original root')
  }
  const handle = await createRoot({
    stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream,
    patchConsole: false, terminalImages: false,
    drainStdin: () => { if (throwDrain) throw new Error('revoked device') },
  })
  handle.render(React.createElement(AlternateScreen, null, React.createElement(Owner)))
  await new Promise<void>(resolve => setImmediate(resolve))
  const ink = instances.get(output as unknown as NodeJS.WriteStream)!
  if (mode === 'destroyed' || mode === 'detached-legacy') {
    if (mode === 'destroyed') input.destroy()
    else await ink.detachForShutdown()
    output.chunks.length = 0
    await finishExit(ctx, { unmount: handle.unmount } as never, true, 'still-restored', undefined, () => {})
    check(`${mode}: actual output exits alt screen and retains notice`,
      output.chunks.join('').includes(EXIT_ALT_SCREEN) && output.chunks.join('').includes('still-restored'))
  } else if (mode === 'throwing-drain') {
    let threw = false
    try { await ink.detachForShutdown() } catch { threw = true }
    check('throwing device drain does not abort tree cleanup', !threw && effectDisposed && !input.isRaw)
    throwDrain = false
  } else {
    let outcome = 'pending'
    void handle.waitUntilExit().then(() => { outcome = 'resolved' }, error => { outcome = error.message })
    let replacement: Awaited<ReturnType<typeof createRoot>> | undefined
    if (mode === 'replacement') {
      replacement = await createRoot({ stdin: input as unknown as NodeJS.ReadStream,
        stdout: output as unknown as NodeJS.WriteStream, patchConsole: false, terminalImages: false })
      replacement.render(React.createElement(AlternateScreen, null, React.createElement(Text, null, 'new root')))
      output.chunks.length = 0
      // A queued recovery/render from the old instance must be inert immediately.
      ;(ink as unknown as { handleResume(): void }).handleResume()
      ink.onRender()
      check('replacement synchronously stops old recovery and frame output', output.chunks.length === 0)
    } else {
      handle.shutdownInput.release()
      ink.unmount(mode === 'revoked-error' ? new Error('original exit error') : undefined)
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    check(`${mode}: exit promise settles after effect cleanup`, effectDisposed &&
      outcome === (mode === 'revoked-error' ? 'original exit error' : 'resolved'))
    if (replacement) await instances.get(output as unknown as NodeJS.WriteStream)!.detachForShutdown()
  }
  await ink.detachForShutdown()
  input.destroy()
}
{
  const input = new OwnedInput(), output = new CapturingStream()
  output.isTTY = false
  const options = { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, patchConsole: false }
  const first = await render(React.createElement(Text, null, 'first'), options)
  const next = await render(React.createElement(Text, null, 'next'), options)
  check('same-instance render retains its original live lease', first.shutdownInput === next.shutdownInput && next.shutdownInput.ownsInput())
  await next.detachForShutdown()
  input.destroy()
}

// Independent non-interactive roots may share the default/piped input, while
// an interactive input still transfers ownership even across different outputs.
for (const tty of [false, true]) {
  const input = new OwnedInput()
  input.isTTY = tty
  const firstOutput = new CapturingStream(), nextOutput = new CapturingStream()
  firstOutput.isTTY = nextOutput.isTTY = tty
  const options = { stdin: input as unknown as NodeJS.ReadStream, patchConsole: false, terminalImages: false }
  let received = '', disposed = false, outcome = 'pending'
  function First() {
    useInput(() => {}, { isActive: tty })
    React.useEffect(() => () => { disposed = true }, [])
    return React.createElement(Text, null, 'first-root')
  }
  function Next() {
    useInput(text => { received += text }, { isActive: tty })
    return React.createElement(Text, null, 'next-root')
  }
  const first = await createRoot({ ...options, stdout: firstOutput as unknown as NodeJS.WriteStream })
  first.render(React.createElement(First))
  await new Promise<void>(resolve => setImmediate(resolve))
  const firstReaders = input.listeners('readable')
  void first.waitUntilExit().then(() => { outcome = 'resolved' })
  const next = await createRoot({ ...options, stdout: nextOutput as unknown as NodeJS.WriteStream })
  next.render(React.createElement(Next))
  await new Promise<void>(resolve => setImmediate(resolve))
  if (tty) {
    check('shared TTY across outputs revokes the old root and settles its exit', !first.shutdownInput.ownsInput() && disposed && outcome === 'resolved')
    check('shared TTY removes every old readable listener', firstReaders.length > 0 && firstReaders.every(reader => !input.listeners('readable').includes(reader)))
  } else {
    check('non-TTY shared input retains both independent roots', first.shutdownInput.ownsInput() && next.shutdownInput.ownsInput() && !disposed && outcome === 'pending')
    firstOutput.chunks.length = 0
    nextOutput.chunks.length = 0
    first.render(React.createElement(Text, null, 'first-rerender'))
    next.render(React.createElement(Text, null, 'next-rerender'))
    check('independent headless roots both rerender', await settled(() => firstOutput.chunks.join('').includes('first-rerender') && nextOutput.chunks.join('').includes('next-rerender')))
  }
  const rawCalls = input.rawCalls, nextWrites = nextOutput.chunks.length
  first.unmount()
  await first.waitUntilExit()
  check(`${tty ? 'TTY' : 'headless'}: old unmount preserves the other root and device`, next.shutdownInput.ownsInput() && input.rawCalls === rawCalls && nextOutput.chunks.length === nextWrites)
  if (tty) {
    input.write('new-owner-key')
    await new Promise<void>(resolve => setImmediate(resolve))
    check('shared TTY replacement receives input after old unmount', received.includes('new-owner-key'))
  } else {
    nextOutput.chunks.length = 0
    next.render(React.createElement(Text, null, 'surviving-root'))
    check('independent headless root rerenders after peer unmount', await settled(() => nextOutput.chunks.join('').includes('surviving-root')))
  }
  const nextExited = next.waitUntilExit()
  next.unmount()
  await nextExited
  input.destroy()
}

// Terminal and diagnostic failures must still reach the original exit action.
const broken = new CapturingStream() as unknown as NodeJS.WriteStream
broken.write = () => { throw new Error('terminal unavailable') }
let exitCode: number | undefined
swapStdout(broken)
try {
  await finishExit(ctx, undefined, false, undefined, undefined, () => { exitCode = 1 })
  check('terminal write failure preserves nonzero exit continuation', exitCode === 1)
  exitCode = undefined
  await finishExit(
    { logger: { debug() { throw new Error('diagnostics unavailable') } } } as never,
    undefined, false, undefined, undefined, () => { exitCode = 1 },
  )
} finally {
  swapStdout(originalStdout)
}
check('cleanup and diagnostic failures preserve nonzero exit continuation', exitCode === 1)


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

// ── Cases E/F: the crash tail's resume markers per kernel ─────────────────
// The standalone entry runs the Claude kernel on a bare `new Context()` (no
// `agents` service); the marker write must not fail there.
type CrashMarkerDeps = Parameters<typeof writeCrashResumeMarkers>[0]
const crashWithMarkers = (deps: Omit<CrashMarkerDeps, 'writeResumeTarget' | 'refreshLastRunRecord'>) => {
  const record = { dshTargets: [] as string[], lastRunRefreshes: 0, finish: [] as string[], logged: [] as string[] }
  runCrashExit({
    error: new Error('render boom'),
    logError: message => { record.logged.push(message) },
    appendLog: () => undefined,
    logRestart: () => undefined,
    logDebug: () => undefined,
    writeResumeMarkers: () => {
      writeCrashResumeMarkers({
        ...deps,
        writeResumeTarget: id => { record.dshTargets.push(id) },
        refreshLastRunRecord: () => { record.lastRunRefreshes += 1 },
      })
    },
    finish: line => { record.finish.push(line) },
  })
  return record
}
{
  // Case E: the entry shape — a real bare cordis root, the Claude kernel.
  const bare = new Context()
  check('entry: a bare root has no agents service (the condition under test)', (bare as unknown as { agents?: unknown }).agents === undefined)
  const claudeId = '11111111-1111-4111-8111-111111111111'
  const lastSessions: string[] = []
  const claudeStart = {
    persisted: (_id: string, rows: readonly { readonly kind: string }[]) => rows.some(row => row.kind === 'user'),
    sessionPrefs: { setLastSession: (id: string) => { lastSessions.push(id) } },
  }
  const sent = crashWithMarkers({
    ctx: bare,
    backendStart: claudeStart,
    channel: { agentId: claudeId, pending: [], rows: [{ kind: 'user' }] },
    startupAgent: undefined,
  })
  check('entry crash: the crash line reaches finish once', sent.finish.length === 1 && sent.finish[0] === 'dsh-tui crashed: render boom', sent.finish.join(' | '))
  check('entry crash: the error is logged', sent.logged.some(line => line.includes('render boom')))
  check('entry crash: a persisted Claude session is the backend\'s last session', lastSessions.length === 1 && lastSessions[0] === claudeId, JSON.stringify(lastSessions))
  check('entry crash: the last-run record is refreshed', sent.lastRunRefreshes === 1)
  check('entry crash: a Claude id is never a DSH resume target', sent.dshTargets.length === 0)
  lastSessions.length = 0
  const blank = crashWithMarkers({
    ctx: bare,
    backendStart: claudeStart,
    channel: { agentId: claudeId, pending: [], rows: [{ kind: 'notice' }] },
    startupAgent: undefined,
  })
  check('entry crash before the first message: no backend marker, the record still refreshed',
    lastSessions.length === 0 && blank.lastRunRefreshes === 1 && blank.finish.length === 1)
}
{
  // Case F: the DSH kernel keeps its behavior — the live session decides,
  // and a crash never clears a marker.
  const dshId = 'dsh-session-1'
  const agentWith = (events: unknown[]) => ({ session: { events } }) as never
  const userMessage = { type: 'user/message', seq: 1, time: 0, data: { source: { kind: 'user' } } }
  const looked: unknown[] = []
  // A real Cordis root, not a bare object with `agents`: the crash tail goes
  // through `ctx.get('agents')`.
  const dshCtx = (live: unknown): Context => {
    const root = new Context()
    root.provide('agents' as never, { get: (id: unknown) => { looked.push(id); return live } } as never)
    return root
  }
  const resumable = crashWithMarkers({
    ctx: dshCtx(agentWith([userMessage])),
    backendStart: undefined,
    channel: { agentId: dshId, pending: [], rows: [] },
    startupAgent: agentWith([]),
  })
  check('dsh crash: the live session is looked up by the channel id', looked.length === 1 && String(looked[0]) === dshId)
  check('dsh crash: a resumable session writes the resume target', resumable.dshTargets.length === 1 && resumable.dshTargets[0] === dshId)
  check('dsh crash: the last-run record is refreshed', resumable.lastRunRefreshes === 1 && resumable.finish.length === 1)
  const empty = crashWithMarkers({
    ctx: dshCtx(agentWith([])),
    backendStart: undefined,
    channel: { agentId: dshId, pending: [], rows: [] },
    startupAgent: agentWith([]),
  })
  check('dsh crash: an empty session writes no target (and clears nothing)', empty.dshTargets.length === 0 && empty.lastRunRefreshes === 1)
  // The DSH branch on a bare root (no `agents`) must not throw; runCrashExit
  // swallows a marker throw, so the refresh after the lookup tells.
  const bareDsh = crashWithMarkers({ ctx: new Context(), backendStart: undefined, channel: { agentId: dshId, pending: [], rows: [] }, startupAgent: undefined })
  check('bare-root dsh crash: no throw (the record refreshed), no target, the crash line once',
    bareDsh.lastRunRefreshes === 1 && bareDsh.dshTargets.length === 0 && bareDsh.finish.length === 1, JSON.stringify(bareDsh))
}

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
