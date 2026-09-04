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
import { render, AlternateScreen, Text } from '../src/ui.js'
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

  setRawMode(value: boolean): this {
    this.isRaw = value
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
// 4. serializeDiff keeps the empty-diff contract after the extraction.
// ---------------------------------------------------------------------------
{
  const sink = new PassThrough() as unknown as NodeJS.WriteStream
  const empty = serializeDiff({ stdout: sink, stderr: sink }, [])
  check('serializeDiff of an empty diff is empty', empty === '')
}

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
