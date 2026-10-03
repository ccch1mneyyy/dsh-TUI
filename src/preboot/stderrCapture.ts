/**
 * Keep what dsh writes to stderr while the boot screen owns the terminal.
 *
 * The boot phase's Ink instance swallows stray stderr writes and console
 * errors (they would corrupt the frame; see Ink's patchStderr/patchConsole),
 * which is right while the screen is up — but when the boot screen is torn
 * down because dsh never mounted dsh-tui, or exited on its own, those lines
 * are the only account of WHY (a profile without the row, a config that
 * failed validation). This records them, forwarding every call to the layer
 * underneath unchanged, so the boot funnel can replay them on the restored
 * terminal.
 *
 * Installed on TOP of Ink's patches and released before the slot is disposed:
 * Ink restores process.stderr.write only while its own intercept is still the
 * installed one, so a wrapper left above it would keep stderr swallowed for
 * the rest of the process.
 */
import { format } from 'node:util'

/** Bound on what is kept: the tail is where the reason is. */
const MAX_CAPTURED = 32 * 1024

export interface BootStderrCapture {
  /** Everything recorded so far (the last MAX_CAPTURED characters). */
  text(): string
  /** Stop recording and unhook (idempotent). */
  release(): void
}

type ConsoleMethod = 'error' | 'warn'

export function captureBootStderr(stderr: NodeJS.WriteStream = process.stderr, con: Console = console): BootStderrCapture {
  let captured = ''
  let active = true
  const record = (text: string): void => {
    if (!active || text === '') return
    captured = (captured + text).slice(-MAX_CAPTURED)
  }
  const underlyingWrite = stderr.write
  const write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    record(typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : '')
    return (underlyingWrite as (...args: unknown[]) => boolean).call(stderr, chunk, ...rest)
  } as NodeJS.WriteStream['write']
  stderr.write = write
  const consoleOriginals = new Map<ConsoleMethod, Console[ConsoleMethod]>()
  const consoleWrappers = new Map<ConsoleMethod, Console[ConsoleMethod]>()
  for (const method of ['error', 'warn'] as const) {
    const underlying = con[method]
    const wrapper = (...args: unknown[]): void => {
      record(`${format(...args)}\n`)
      underlying.apply(con, args)
    }
    consoleOriginals.set(method, underlying)
    consoleWrappers.set(method, wrapper)
    con[method] = wrapper
  }
  return {
    text: () => captured,
    release() {
      if (!active) return
      active = false
      // Unhook only where we are still on top; a layer installed above us
      // keeps calling through, and `active` makes us a plain pass-through.
      if (stderr.write === write) stderr.write = underlyingWrite
      for (const [method, wrapper] of consoleWrappers) {
        if (con[method] === wrapper) con[method] = consoleOriginals.get(method)!
      }
    },
  }
}
