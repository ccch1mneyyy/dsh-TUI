import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiAltScreen, TuiMainScreen, type Component, type Terminal } from '../../src/tui/public.js'

class FakeTerminal implements Terminal {
  columns: number
  rows: number
  readonly writes: string[] = []
  stopCount = 0
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined

  constructor(columns = 40, rows = 12) {
    this.columns = columns
    this.rows = rows
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.stopCount += 1
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  drainInput(): Promise<void> {
    return Promise.resolve()
  }

  write(data: string): void {
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

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resizeHandler?.()
  }

  sendInput(data: string): void {
    this.inputHandler?.(data)
  }
}

class StatefulComponent implements Component {
  value = 'first'
  readonly renderedValues: string[] = []
  readonly renderedWidths: number[] = []

  render(width: number): string[] {
    this.renderedValues.push(this.value)
    this.renderedWidths.push(width)
    return [`${this.value} ${width}`]
  }

  invalidate(): void {}
}

function exerciseRoot(
  name: string,
  create: (terminal: FakeTerminal) => { addChild(component: Component): void; start(): void; renderNow(force?: boolean): void; stop(): void },
): void {
  test(`${name} renders first state, updates state, and renders after resize`, () => {
    const terminal = new FakeTerminal()
    const root = create(terminal)
    const component = new StatefulComponent()
    root.addChild(component)

    try {
      root.start()
      root.renderNow(true)
      component.value = 'updated'
      root.renderNow()
      terminal.resize(60, 10)
      root.renderNow()

      assert.deepEqual(component.renderedValues, ['first', 'updated', 'updated'])
      assert.deepEqual(component.renderedWidths, [40, 40, 60])
      assert.ok(terminal.writes.length > 0)
    } finally {
      root.stop()
    }

    assert.equal(terminal.stopCount, 1)
  })
}

exerciseRoot('TuiMainScreen', (terminal) => new TuiMainScreen(terminal))
exerciseRoot('TuiAltScreen', (terminal) => new TuiAltScreen(terminal))
