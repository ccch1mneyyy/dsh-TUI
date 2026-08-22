import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiLifecycle, TuiLifecycleError } from '../../src/tui/lifecycle.js'
import type { Component, Terminal, TUI, TuiInputListener, TuiStopOptions } from '../../src/tui/public.js'
import type { Channel } from '../../src/dsh-adapter/channel.js'
import { createTuiCommands } from '../../src/tui/commands.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

class FakeTerminal implements Terminal {
  readonly events: string[]
  /** Raw payloads of terminal.write, for replay-content assertions. */
  readonly writes: string[] = []
  /** Test hook fired inside drainInput (e.g. a mid-drain EIO). */
  drainHook: (() => void) | undefined
  columns = 80
  rows = 24
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined
  stopCount = 0

  constructor(events: string[] = []) {
    this.events = events
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
    this.events.push('terminal.start')
  }

  stop(): void {
    this.stopCount += 1
    this.inputHandler = undefined
    this.resizeHandler = undefined
    this.events.push('terminal.stop')
  }

  drainInput(): Promise<void> {
    this.events.push('terminal.drainInput')
    this.drainHook?.()
    return Promise.resolve()
  }

  write(data: string): void {
    this.events.push('terminal.write')
    this.writes.push(data)
  }

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

  sendInput(data: string): void {
    this.inputHandler?.(data)
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resizeHandler?.()
  }
}

class FakeTui implements Component {
  readonly children: Component[] = []
  readonly stopCalls: Array<TuiStopOptions | undefined> = []
  readonly inputListeners = new Set<TuiInputListener>()
  readonly events: string[]
  readonly terminal: FakeTerminal
  readonly mode: 'regular' | 'fullscreen'
  private clearOnShrink = false
  private showHardwareCursor = false

  constructor(mode: 'regular' | 'fullscreen', events: string[] = []) {
    this.mode = mode
    this.events = events
    this.terminal = new FakeTerminal(events)
  }

  render(_width: number): string[] {
    return []
  }

  invalidate(): void {}

  addChild(component: Component): void {
    this.children.push(component)
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component)
    if (index >= 0) this.children.splice(index, 1)
  }

  clear(): void {
    this.children.length = 0
  }

  getShowHardwareCursor(): boolean {
    return this.showHardwareCursor
  }

  setShowHardwareCursor(enabled: boolean): void {
    this.showHardwareCursor = enabled
  }

  getClearOnShrink(): boolean {
    return this.clearOnShrink
  }

  setClearOnShrink(enabled: boolean): void {
    this.clearOnShrink = enabled
  }

  setFocus(_component: Component | null): void {}

  showOverlay(_component: Component): never {
    throw new Error('overlay is not part of this fake')
  }

  hideOverlay(): void {}

  hasOverlay(): boolean {
    return false
  }

  start(): void {
    this.events.push('ui.start')
  }

  stop(options?: TuiStopOptions): void {
    this.stopCalls.push(options)
    this.events.push('ui.stop')
  }

  renderNow(_force?: boolean): void {
    this.events.push('ui.renderNow')
  }

  requestRender(force?: boolean): void {
    this.events.push(`ui.requestRender:${force === true}`)
  }

  addInputListener(listener: TuiInputListener): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  removeInputListener(listener: TuiInputListener): void {
    this.inputListeners.delete(listener)
  }

  onTerminalColorSchemeChange(_listener: (scheme: unknown) => void): () => void {
    return () => {}
  }

  setTerminalColorSchemeNotifications(_enabled: boolean): void {}

  queryTerminalBackgroundColor(_options: { timeoutMs: number }): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  queryTerminalColorScheme(_options: { timeoutMs: number }): Promise<undefined> {
    return Promise.resolve(undefined)
  }
}

function asTui(ui: FakeTui): TUI {
  return ui as unknown as TUI
}

async function cleanupLifecycle(lifecycle: TuiLifecycle): Promise<void> {
  await lifecycle.finalStop('shutdown')
}

test('quiesce preserves fullscreen but not inline screen', async () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    const events: string[] = []
    const fake = new FakeTui(mode, events)
    const lifecycle = new TuiLifecycle({ ui: asTui(fake) })

    try {
      await lifecycle.quiesce('external-editor')
      assert.equal(lifecycle.state, 'quiesced')
      assert.equal(fake.stopCalls.length, 1)
      if (mode === 'fullscreen') {
        assert.equal(fake.stopCalls[0]?.preserveScreen, true)
      } else {
        assert.equal(fake.stopCalls[0]?.preserveScreen, undefined)
      }
    } finally {
      await cleanupLifecycle(lifecycle)
    }
  }
})

test('resume pauses stdin, starts, renders, then runs the resync hook', async () => {
  const events: string[] = []
  const fake = new FakeTui('regular', events)
  let afterResumeCalls = 0
  const lifecycle = new TuiLifecycle({
    ui: asTui(fake),
    onAfterResume: () => {
      afterResumeCalls += 1
      events.push('onAfterResume')
    },
  })
  const stdin = process.stdin as NodeJS.ReadStream & { pause: () => NodeJS.ReadStream }
  const originalPause = stdin.pause
  stdin.pause = (() => {
    events.push('stdin.pause')
    return stdin
  }) as typeof stdin.pause

  try {
    await lifecycle.quiesce('external-editor')
    events.length = 0

    await lifecycle.resume()

    assert.deepEqual(events, ['stdin.pause', 'ui.start', 'ui.requestRender:true', 'onAfterResume'])
    assert.equal(lifecycle.state, 'running')
    assert.equal(lifecycle.generation, 1)
    assert.equal(afterResumeCalls, 1)
  } finally {
    stdin.pause = originalPause
    await cleanupLifecycle(lifecycle)
  }
})

test('awaitStop rejects before finalStop is established', async () => {
  const fake = new FakeTui('regular')
  const lifecycle = new TuiLifecycle({ ui: asTui(fake) })

  try {
    await assert.rejects(lifecycle.awaitStop(), (error: unknown) => {
      return error instanceof TuiLifecycleError && error.code === 'TUI_NOT_FINAL_STOPPED'
    })
  } finally {
    await cleanupLifecycle(lifecycle)
  }
})

test('finalStop drains input before stopping once, is idempotent, and cleans stream listeners', async () => {
  const events: string[] = []
  const fake = new FakeTui('regular', events)
  const stdoutErrorListenersBefore = process.stdout.listeners('error')
  const stderrErrorListenersBefore = process.stderr.listeners('error')
  const lifecycle = new TuiLifecycle({ ui: asTui(fake) })

  assert.equal(process.stdout.listenerCount('error'), stdoutErrorListenersBefore.length + 1)
  assert.equal(process.stderr.listenerCount('error'), stderrErrorListenersBefore.length + 1)

  const first = lifecycle.finalStop('shutdown')
  const repeated = lifecycle.finalStop('signal')
  assert.strictEqual(repeated, first)

  const result = await first
  assert.equal(result.reason, 'shutdown')
  assert.equal(result.stdoutDrainError, undefined)
  assert.deepEqual(events, ['terminal.drainInput', 'ui.stop'])
  assert.equal(fake.stopCalls.length, 1)
  assert.strictEqual(await lifecycle.awaitStop(), result)
  assert.equal(process.stdout.listenerCount('error'), stdoutErrorListenersBefore.length)
  assert.equal(process.stderr.listenerCount('error'), stderrErrorListenersBefore.length)

  await assert.rejects(lifecycle.resume(), (error: unknown) => {
    return error instanceof TuiLifecycleError && error.code === 'TUI_FINAL_STOPPED'
  })
})

test('fullscreen finalStop replays the transcript, then main.stop() lands the cursor below it', async () => {
  const events: string[] = []
  const fake = new FakeTui('fullscreen', events)
  const transcript: Component = {
    render: () => ['replay-alpha', 'replay-beta'],
    invalidate() {},
  }
  const lifecycle = new TuiLifecycle({
    ui: asTui(fake),
    getTranscript: () => {
      events.push('getTranscript')
      return [transcript]
    },
  })

  const result = await lifecycle.finalStop('shutdown')

  assert.equal(result.stdoutDrainError, undefined)
  assert.equal(fake.stopCalls.length, 1)
  assert.equal(fake.stopCalls[0]?.preserveScreen, true)
  // The fork's real TuiMainScreen backs the replay on the same terminal:
  // renderNow() writes the whole transcript, then main.stop()'s
  // beforeTerminalStop moves the cursor below the content (trailing \r\n)
  // and re-stops the already-stopped terminal exactly once (idempotent).
  assert.deepEqual(events, [
    'terminal.drainInput',
    'ui.stop',
    'getTranscript',
    'terminal.write', // first paint: the whole transcript
    'terminal.write', // beforeTerminalStop: " "
    'terminal.write', // beforeTerminalStop: cursor move below the content
    'terminal.write', // beforeTerminalStop: trailing \r\n
    'terminal.stop',
  ])
  assert.equal(fake.terminal.writes.length, 4)
  assert.ok(fake.terminal.writes[0]!.includes('replay-alpha'))
  assert.ok(fake.terminal.writes[0]!.includes('replay-beta'))
  assert.equal(fake.terminal.writes.at(-1), '\r\n')
  assert.equal(fake.terminal.stopCount, 1)
})

test('finalStop after quiesce does not stop the TUI a second time', async () => {
  // Inline: quiesce already ran TUI.stop(); finalStop only drains and waits.
  {
    const events: string[] = []
    const fake = new FakeTui('regular', events)
    const lifecycle = new TuiLifecycle({ ui: asTui(fake) })
    await lifecycle.quiesce('external-editor')
    const result = await lifecycle.finalStop('shutdown')
    assert.equal(result.reason, 'shutdown')
    assert.deepEqual(events, ['ui.stop', 'terminal.drainInput'])
    assert.equal(fake.stopCalls.length, 1)
  }
  // Fullscreen: the transcript replay still runs on the stopped terminal,
  // and the temporary main screen's stop is the only terminal re-stop.
  {
    const events: string[] = []
    const fake = new FakeTui('fullscreen', events)
    const lifecycle = new TuiLifecycle({
      ui: asTui(fake),
      getTranscript: () => [{ render: () => ['replay-row'], invalidate() {} }],
    })
    await lifecycle.quiesce('external-editor')
    await lifecycle.finalStop('shutdown')
    assert.equal(fake.stopCalls.length, 1)
    assert.equal(fake.stopCalls[0]?.preserveScreen, true)
    assert.deepEqual(events, [
      'ui.stop',
      'terminal.drainInput',
      'terminal.write',
      'terminal.write',
      'terminal.write',
      'terminal.write',
      'terminal.stop',
    ])
    assert.ok(fake.terminal.writes[0]?.includes('replay-row'))
    assert.equal(fake.terminal.stopCount, 1)
  }
})

test('finalStop moves the generation: a late command completion is fenced out', async () => {
  const events: string[] = []
  const fake = new FakeTui('regular', events)
  const lifecycle = new TuiLifecycle({ ui: asTui(fake) })
  // Only the read under test exists; the sink is typed against the full
  // Channel by design (same cast as command-write-fence.test.ts).
  const channel = {
    sessionEpoch: 0,
    listFilesResult: Promise.resolve<readonly string[]>([]),
    listFiles(): Promise<readonly string[]> {
      return this.listFilesResult
    },
  }
  const commands = createTuiCommands({
    channel: channel as unknown as Channel,
    fences: {
      sessionEpoch: () => channel.sessionEpoch,
      generation: () => lifecycle.generation,
    },
  })

  // Control: an undisturbed completion passes the fence.
  const live = deferred<readonly string[]>()
  channel.listFilesResult = live.promise
  const livePending = commands.query.listFiles()
  live.resolve(['live.txt'])
  assert.deepEqual(await livePending, ['live.txt'])

  const generationBefore = lifecycle.generation
  const slow = deferred<readonly string[]>()
  channel.listFilesResult = slow.promise
  const stalePending = commands.query.listFiles()
  const stop = lifecycle.finalStop('shutdown')
  // The generation moves the moment finalStop is established, not when the
  // queued stop runs.
  assert.ok(lifecycle.generation > generationBefore)
  slow.resolve(['late.txt'])
  // The in-flight read captured the pre-stop generation: its late result is
  // dropped as undefined, never delivered into a projection or the tty.
  assert.equal(await stalePending, undefined)
  await stop
})

test('an EIO during the finalStop drain still reaches the emergency exit', async () => {
  const preexisting = new Set(process.stdout.listeners('error'))
  const events: string[] = []
  const fake = new FakeTui('regular', events)
  const exits: number[] = []
  const lifecycle = new TuiLifecycle({
    ui: asTui(fake),
    emergencyExit: ((code: number) => {
      exits.push(code)
    }) as (code: number) => never,
  })
  // The fork's drainInput() writes to stdout itself; a dead tty must reach
  // the emergency path from inside that window. (The listener is invoked
  // directly: broadcasting a synthetic 'error' on the real process.stdout
  // would also hit the test runner's own stdout error listeners.)
  const listener = process.stdout
    .listeners('error')
    .find((candidate) => !preexisting.has(candidate)) as ((error: Error) => void) | undefined
  assert.ok(listener !== undefined)
  fake.terminal.drainHook = () => {
    // Still installed inside the drain window (pre-fix they stood down
    // before drainInput ran).
    assert.ok(process.stdout.listeners('error').includes(listener))
    listener(Object.assign(new Error('read EIO'), { code: 'EIO' }))
  }

  const result = await lifecycle.finalStop('shutdown')

  assert.equal(result.reason, 'shutdown')
  assert.deepEqual(exits, [129])
  // emergencyTerminalExit's best-effort restore stopped the terminal; the
  // regular stop path then ran without touching it again.
  assert.deepEqual(events, ['terminal.drainInput', 'terminal.stop', 'ui.stop'])
  assert.equal(fake.terminal.stopCount, 1)
  // Stood down once every tty write of the stop completed.
  assert.ok(!process.stdout.listeners('error').includes(listener))
})
