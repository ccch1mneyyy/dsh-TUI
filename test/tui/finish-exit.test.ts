/**
 * finishExit boundary tests (plan §1.2, WP-04):
 *
 * - An external editor child owns the tty while it runs (quiesced stdio
 *   inherit): finishExit must wait for the in-flight editor round-trip
 *   BEFORE finalStop starts the teardown, so a signal/update cannot exit the
 *   parent from under the editor.
 * - A failed final stdout flush (dead/blocked tty) must not run the
 *   child/exit handoff: finishExit takes the lifecycle emergency restore +
 *   exit path instead.
 *
 * Bare Node test runner; the TUI is faked down to the lifecycle's
 * consumption surface (same harness style as terminal-lifecycle.test.ts).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { finishExit } from '../../src/dsh-adapter/plugin.js'
import { TuiLifecycle } from '../../src/tui/lifecycle.js'
import type { Component, Terminal, TUI, TuiInputListener, TuiStopOptions } from '../../src/tui/public.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

class FakeTerminal implements Terminal {
  columns = 80
  rows = 24
  stopCount = 0

  start(_onInput: (data: string) => void, _onResize: () => void): void {}

  stop(): void {
    this.stopCount += 1
  }

  drainInput(): Promise<void> {
    return Promise.resolve()
  }

  write(_data: string): void {}

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

class FakeTui implements Component {
  readonly terminal = new FakeTerminal()
  readonly mode: 'regular' | 'fullscreen'
  readonly stopCalls: Array<TuiStopOptions | undefined> = []

  constructor(mode: 'regular' | 'fullscreen') {
    this.mode = mode
  }

  render(_width: number): string[] {
    return []
  }

  invalidate(): void {}
  addChild(_component: Component): void {}
  removeChild(_component: Component): void {}
  clear(): void {}

  start(): void {}

  stop(options?: TuiStopOptions): void {
    this.stopCalls.push(options)
  }

  renderNow(_force?: boolean): void {}
  requestRender(_force?: boolean): void {}

  addInputListener(_listener: TuiInputListener): () => void {
    return () => {}
  }

  removeInputListener(_listener: TuiInputListener): void {}

  onTerminalColorSchemeChange(_listener: (scheme: unknown) => void): () => void {
    return () => {}
  }
}

function asTui(ui: FakeTui): TUI {
  return ui as unknown as TUI
}

const fakeCtx = {
  logger: {
    debug() {},
    error() {},
    warn() {},
  },
} as unknown as Context

test('finishExit waits for an in-flight external editor before the handoff', async () => {
  const lifecycle = new TuiLifecycle({ ui: asTui(new FakeTui('regular')) })
  const editor = deferred<void>()
  let done = false

  const exit = finishExit(
    fakeCtx,
    lifecycle,
    'shutdown',
    undefined,
    undefined,
    () => {
      done = true
    },
    () => editor.promise,
  )

  // The editor child still owns the tty: no teardown may start.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false)
  assert.equal(lifecycle.finalStopEstablished, false)

  editor.resolve()
  await exit
  assert.equal(done, true)
  assert.equal(lifecycle.state, 'stopped')
})

test('finishExit without an editor flight stops and hands off immediately', async () => {
  const lifecycle = new TuiLifecycle({ ui: asTui(new FakeTui('regular')) })
  let done = false

  await finishExit(fakeCtx, lifecycle, 'signal', undefined, undefined, () => {
    done = true
  })

  assert.equal(done, true)
  assert.equal(lifecycle.state, 'stopped')
})

test('a failed final stdout flush takes the emergency exit, never the handoff', async () => {
  const exits: number[] = []
  const fake = new FakeTui('regular')
  const lifecycle = new TuiLifecycle({
    ui: asTui(fake),
    stdoutDrainTimeoutMs: 25,
    emergencyExit: ((code: number) => {
      exits.push(code)
    }) as (code: number) => never,
  })
  // Simulate a blocked tty: bytes pending that never drain.
  Object.defineProperty(process.stdout, 'writableLength', {
    configurable: true,
    writable: true,
    value: 512,
  })
  let done = false
  try {
    await assert.rejects(
      finishExit(fakeCtx, lifecycle, 'shutdown', undefined, undefined, () => {
        done = true
      }),
      /emergency exit did not terminate/,
    )
  } finally {
    delete (process.stdout as { writableLength?: number }).writableLength
  }

  assert.deepEqual(exits, [129])
  // emergencyTerminalExit's best-effort restore stopped the shared terminal.
  assert.equal(fake.terminal.stopCount, 1)
  assert.equal(done, false)
})
