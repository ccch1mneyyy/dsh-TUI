/**
 * Exit mouse-reporting cleanup regression (issue #522): after dsh-tui exits
 * the shell keeps echoing SGR mouse sequences (ESC[<btn;col;rowM) because
 * ENABLE_MOUSE_TRACKING was re-written AFTER the exit cleanup's
 * DISABLE_MOUSE_TRACKING — the self-heal probe (and the DECRPM re-entry
 * reply) fired inside the dispose window, and a throwing final render could
 * skip the whole synchronous cleanup block.
 *
 * Guards:
 * 1. The render() handle exposes detachForShutdown/detachStdinForHandoff,
 *    so finishExit's instances-map fallback can latch the runtime even when
 *    the map lookup misses (stdout identity drift).
 * 2. detachForShutdown latches the self-heal paths: probeAltScreenHealth,
 *    reassertTerminalModes and reenterAltScreen stop writing
 *    ENABLE_MOUSE_TRACKING / ENTER_ALT_SCREEN afterwards.
 * 3. unmount() survives a throwing final render and still writes the full
 *    synchronous cleanup (EXIT_ALT_SCREEN → DISABLE_MOUSE_TRACKING →
 *    SHOW_CURSOR) to the stdout stream's own fd, with the last frame (when
 *    present) preceding EXIT_ALT_SCREEN.
 */
import React from 'react'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { render, AlternateScreen, Text, useInput } from '../src/ui.js'
import instances from '../src/ink/instances.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from '../src/ink/termio/dec.js'
import { serializeDiff } from '../src/ink/terminal.js'

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  /** Physical raw-mode transitions with timestamps (performance.now()). */
  rawTransitions: Array<{ value: boolean; at: number }> = []

  setRawMode(value: boolean): this {
    this.isRaw = value
    this.rawTransitions.push({ value, at: performance.now() })
    return this
  }

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }
}

/** PassThrough masquerading as a TTY; optionally pinned to a real fd. */
function fakeTTY(options: { fd?: number } = {}): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & {
    fd?: number | null
  }
  Object.assign(stream, { isTTY: true, columns: 80, rows: 24 })
  if (options.fd !== undefined) {
    Object.defineProperty(stream, 'fd', { value: options.fd, configurable: true })
  }
  return stream
}

const drain = (stream: NodeJS.WriteStream): string => {
  let out = ''
  let chunk: unknown
  while ((chunk = (stream as PassThrough).read()) !== null) {
    out += String(chunk)
  }
  return out
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 1 + 2. Handle exposes the detach methods; detach latches the self-heal
// paths so nothing re-writes ENABLE_MOUSE_TRACKING after shutdown begins.
// ---------------------------------------------------------------------------
{
  const stdout = fakeTTY()
  const stdin = new FakeStdin()
  const instance = await render(
    React.createElement(AlternateScreen, null, React.createElement(Text, null, 'exit mouse cleanup')),
    {
      stdout,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: true,
    },
  )

  check(
    'render handle exposes detachForShutdown (finishExit fallback can latch)',
    typeof instance.detachForShutdown === 'function',
  )
  check(
    'render handle exposes beginShutdown/concludeShutdown (finishExit split phases)',
    typeof instance.beginShutdown === 'function' && typeof instance.concludeShutdown === 'function',
  )
  check(
    'render handle exposes detachStdinForHandoff',
    typeof instance.detachStdinForHandoff === 'function',
  )

  const ink = instances.get(stdout)
  check('live Ink instance found by stdout', ink !== undefined)

  const mounted = drain(stdout)
  check('AlternateScreen mount enables mouse tracking', mounted.includes(ENABLE_MOUSE_TRACKING))

  // While active, the probe re-asserts mouse tracking (first call passes the
  // 250ms throttle).
  ink?.probeAltScreenHealth()
  await new Promise(resolve => setImmediate(resolve))
  const afterProbe = drain(stdout)
  check('active probe re-asserts mouse tracking', afterProbe.includes(ENABLE_MOUSE_TRACKING))

  // Latch, then let the probe throttle window pass: every self-heal path must
  // stay silent afterwards.
  instance.detachForShutdown()
  await sleep(300)

  ink?.probeAltScreenHealth()
  await new Promise(resolve => setImmediate(resolve))
  const afterLatchProbe = drain(stdout)
  check('latched probe does not re-enable mouse tracking', !afterLatchProbe.includes(ENABLE_MOUSE_TRACKING))

  ink?.reassertTerminalModes()
  await new Promise(resolve => setImmediate(resolve))
  const afterReassert = drain(stdout)
  check('latched reassert does not re-enable mouse tracking', !afterReassert.includes(ENABLE_MOUSE_TRACKING))

  ;(ink as unknown as { reenterAltScreen(): void }).reenterAltScreen()
  await new Promise(resolve => setImmediate(resolve))
  const afterReenter = drain(stdout)
  check('latched reenter does not re-enter alt screen', !afterReenter.includes(ENTER_ALT_SCREEN))
  check('latched reenter does not re-enable mouse tracking', !afterReenter.includes(ENABLE_MOUSE_TRACKING))

  instance.detachStdinForHandoff()
  check('handle detachStdinForHandoff removes stdin readers', stdin.listenerCount('readable') === 0)
}

// ---------------------------------------------------------------------------
// 3. unmount() must survive a throwing final render and still write the full
// synchronous cleanup to the stdout stream's own fd.
// ---------------------------------------------------------------------------
{
  const tmpFile = join(tmpdir(), `dsh-tui-exit-mouse-cleanup-${process.pid}.out`)
  const tmpFd = openSync(tmpFile, 'w')
  const stdout = fakeTTY({ fd: tmpFd })
  const stdin = new FakeStdin()
  const instance = await render(
    React.createElement(AlternateScreen, null, React.createElement(Text, null, 'cleanup survives render crash')),
    {
      stdout,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: true,
    },
  )

  const ink = instances.get(stdout) as unknown as { renderNow(): void }
  ink.renderNow = () => {
    throw new Error('final render boom')
  }

  let unmountThrew = false
  try {
    instance.unmount()
  } catch {
    unmountThrew = true
  }
  closeSync(tmpFd)

  check('unmount survives a throwing final render', !unmountThrew)
  const cleanup = readFileSync(tmpFile, 'utf8')
  check('sync cleanup exits the alt screen', cleanup.includes(EXIT_ALT_SCREEN))
  check('sync cleanup disables mouse tracking', cleanup.includes(DISABLE_MOUSE_TRACKING))
  const disableAt = cleanup.indexOf(DISABLE_MOUSE_TRACKING)
  check('EXIT_ALT_SCREEN precedes DISABLE_MOUSE_TRACKING',
    cleanup.indexOf(EXIT_ALT_SCREEN) !== -1 &&
    cleanup.indexOf(EXIT_ALT_SCREEN) < disableAt)
  // The last frame itself carries a cursorShow patch, so search for the
  // cleanup's SHOW_CURSOR only AFTER the disables.
  check('sync cleanup shows the cursor after the disables',
    cleanup.indexOf(SHOW_CURSOR, disableAt) !== -1)
  check('sync cleanup contains no ENABLE_MOUSE_TRACKING', !cleanup.includes(ENABLE_MOUSE_TRACKING))

  // The last frame (serialized with a BSU head) must land BEFORE the alt
  // screen exits — an async frame write would arrive after ?1049l and paint
  // misplaced residue on the main screen.
  const frameAt = cleanup.indexOf('\x1b[?2026h')
  if (frameAt !== -1) {
    check('last frame lands before EXIT_ALT_SCREEN', frameAt < cleanup.indexOf(EXIT_ALT_SCREEN))
  }
}

// ---------------------------------------------------------------------------
// 4. React error-boundary path: a throwing mount drives componentDidCatch →
//    handleExit → Ink.unmount, which writes the synchronous cleanup itself
//    and latches exitCleanupWritten. The finishExit funnel must then SKIP
//    re-writing the mode resets (exactly one DISABLE_MOUSE_TRACKING and one
//    EXIT_ALT_SCREEN in the fd trace) while still running latch → settle →
//    conclude → handoff. finishExit never sees process.stdout swapped here,
//    so the notice landing in the file also proves the funnel targets the
//    runtime's own stream (stdout identity, #522).
// ---------------------------------------------------------------------------
{
  const { finishExit } = await import('../src/dsh-adapter/plugin.js')
  const tmpFile = join(tmpdir(), `dsh-tui-exit-boundary-${process.pid}.out`)
  const tmpFd = openSync(tmpFile, 'w')
  const stdout = fakeTTY({ fd: tmpFd })
  const stdin = new FakeStdin()
  const stderr = fakeTTY()

  // Throw on the FIRST UPDATE, not on mount: a mount-time throw aborts the
  // commit before AlternateScreen's insertion effect runs, so the app never
  // enters the alt screen and the cleanup legitimately omits EXIT_ALT_SCREEN.
  // The real error-boundary path (#522 crash reports) throws with the app
  // already running — alt screen active, frames rendered. RawHolder is the
  // realistic raw-mode borrower (PromptInput's useInput): its effect cleanup
  // runs DURING React's error unwinding — before componentDidCatch — so it
  // physically releases raw mode before the shutdown latch exists, and the
  // latch must re-acquire it for the settle window.
  const RawHolder = (): React.ReactElement => {
    useInput(() => {})
    return React.createElement(Text, null, 'raw holder')
  }
  const Bomb = (): React.ReactElement => {
    const [boom, setBoom] = React.useState(false)
    React.useEffect(() => { setBoom(true) }, [])
    if (boom) throw new Error('render boom')
    return React.createElement(Text, null, 'running before boom')
  }

  let renderThrew = false
  let instance: Awaited<ReturnType<typeof render>> | undefined
  try {
    instance = await render(
      React.createElement(AlternateScreen, null, React.createElement(RawHolder), React.createElement(Bomb)),
      {
        stdout,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr,
        exitOnCtrlC: false,
        patchConsole: true,
      },
    )
    // componentDidCatch → handleExit → Ink.unmount rejects the exit promise;
    // awaiting it (with catch) is also the sync point for "unmount done".
    await instance.waitUntilExit().catch(() => {})
  } catch {
    renderThrew = true
  }

  check('error boundary catches the throwing mount (render does not throw out)', !renderThrew && instance !== undefined)

  if (instance) {
    check('unmount already wrote the exit cleanup (hasWrittenExitCleanup latched)',
      instance.hasWrittenExitCleanup === true)

    // Mid-point, finishExit not yet called: the crash-unmount must have kept
    // (re-acquired) raw mode — the settle window is only meaningful raw —
    // and the cleanup bytes must have been written in that state (#522:
    // cooked+echo before the terminal processes DISABLE is the echo bug).
    const midTrace = readFileSync(tmpFile, 'utf8')
    check('raw mode survives the crash-unmount (settle-window precondition)', stdin.isRaw === true)
    check('crash-unmount wrote DISABLE while raw mode was held', midTrace.includes(DISABLE_MOUSE_TRACKING))

    const ctx = { logger: { debug() {} } } as never
    let done = false
    let finishThrew = false
    const finishStart = performance.now()
    try {
      await finishExit(ctx, instance, true, 'hint-boundary', undefined, () => { done = true })
    } catch {
      finishThrew = true
    }
    closeSync(tmpFd)

    const trace = readFileSync(tmpFile, 'utf8')
    // React's error unwinding runs <AlternateScreen>'s insertion-effect
    // cleanup (async writeRaw → stream buffer) before Ink.unmount's writeSync
    // block, and setAltScreenActive(false) then suppresses unmount's
    // redundant EXIT_ALT_SCREEN — so EXIT_ALT lands exactly once across BOTH
    // channels (buffer + fd trace), while the fd trace alone proves whether
    // finishExit double-wrote its cleanup block (a broken skip would add a
    // second writeSync DISABLE_MOUSE_TRACKING to the file).
    const combined = drain(stdout) + trace
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1
    check('finishExit survives the post-boundary funnel', !finishThrew && done)
    check('fd trace has exactly one writeSync DISABLE (finishExit skip worked)',
      count(trace, DISABLE_MOUSE_TRACKING) === 1)
    check('EXIT_ALT_SCREEN reaches the terminal exactly once (no double write)',
      count(combined, EXIT_ALT_SCREEN) === 1)
    check('skip-branch still parks the notice on the runtime stream', trace.includes('hint-boundary'))
    // The mount itself legitimately enables mouse tracking — the contract is
    // that nothing re-enables it AFTER the final EXIT_ALT_SCREEN.
    const postExitTail = combined.slice(combined.lastIndexOf(EXIT_ALT_SCREEN))
    check('no ENABLE_MOUSE_TRACKING after the final EXIT_ALT_SCREEN', !postExitTail.includes(ENABLE_MOUSE_TRACKING))
    check('concludeShutdown still ran in the finally (raw mode released)', stdin.isRaw === false)
    // The physical raw-off must happen INSIDE finishExit, after its 150ms
    // raw-mode settle window — never before the funnel (the pre-fix path
    // released it in App.handleExit, ahead of the cleanup write itself).
    const lastOff = stdin.rawTransitions.filter(t => !t.value).at(-1)
    check('raw-off happened only after the settle window (finishExit-owned)',
      lastOff !== undefined && lastOff.at - finishStart >= 140)
  } else {
    closeSync(tmpFd)
  }
}

// ---------------------------------------------------------------------------
// 5. unmount() on a TTY-like stream WITHOUT an fd must write the cleanup to
//    the stream's own ordered queue — never writeSync(1): fd 1 belongs to
//    the host process, so a wrapped/embedder stream would lose every reset
//    while its enable writes still reached the TTY (#522 review). The queued
//    fallback also preserves frame → EXIT_ALT_SCREEN ordering for free.
//    (Pre-fix, this stream captured NOTHING — the bytes went to real fd 1.)
// ---------------------------------------------------------------------------
{
  class NoFdTty extends PassThrough {
    isTTY = true
    columns = 40
    rows = 10
    // Explicitly no `fd` property.
  }
  const stdout = new NoFdTty() as unknown as NodeJS.WriteStream
  const stdin = new FakeStdin()
  // A real raw-mode borrower (useInput) so the unmount must actually detach
  // the readable pump — without it the listener-leak checks below are vacuous.
  const RawHolder = (): React.ReactElement => {
    useInput(() => {})
    return React.createElement(Text, null, 'holder')
  }
  const instance = await render(
    React.createElement(AlternateScreen, null, React.createElement(RawHolder), React.createElement(Text, null, 'no-fd cleanup target')),
    {
      stdout,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: true,
    },
  )
  drain(stdout)
  instance.unmount()
  const out = drain(stdout)
  check('no-fd unmount writes EXIT_ALT_SCREEN to the stream itself', out.includes(EXIT_ALT_SCREEN))
  check('no-fd unmount writes DISABLE_MOUSE_TRACKING to the stream itself', out.includes(DISABLE_MOUSE_TRACKING))
  check('no-fd unmount orders EXIT_ALT_SCREEN before DISABLE',
    out.indexOf(EXIT_ALT_SCREEN) !== -1 && out.indexOf(EXIT_ALT_SCREEN) < out.indexOf(DISABLE_MOUSE_TRACKING))
  // An external (funnel-less) unmount must restore cooked mode itself.
  check('external unmount restores cooked mode (no funnel follows)', stdin.isRaw === false)
  // ...and the App-level conclude must run even though React already nulled
  // the ref during teardown: a leaked latched pump keeps draining a shared
  // stdin in drain-only mode and starves the next mounted instance (#522 CI:
  // verify-session-tree / verify-help-scroll remount-on-shared-stdin).
  check('external unmount detaches the stdin readable pump', stdin.listenerCount('readable') === 0)
}

// ---------------------------------------------------------------------------
// 6. serializeDiff keeps the empty-diff contract after the extraction.
// ---------------------------------------------------------------------------
{
  const sink = new PassThrough() as unknown as NodeJS.WriteStream
  const empty = serializeDiff({ stdout: sink, stderr: sink }, [])
  check('serializeDiff of an empty diff is empty', empty === '')
}

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
