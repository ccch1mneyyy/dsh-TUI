import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalSnapshot } from '../../src/dsh-adapter/approvals.js'
import type { QuestionSelection, QuestionSnapshot } from '../../src/dsh-adapter/questions.js'
import { ApprovalPanelView } from '../../src/tui/components/overlays/approval-panel.js'
import { QuestionPanelView } from '../../src/tui/components/overlays/question-panel.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import {
  Key,
  TuiMainScreen,
  matchesKey,
  type Component,
  type Focusable,
  type Terminal,
  type TUI,
} from '../../src/tui/public.js'

interface OverlayCalls {
  readonly approvals: string[]
  readonly answers: QuestionSelection[]
  cancellations: number
}

function makeCommands(calls: OverlayCalls): TuiCommands {
  return {
    overlays: {
      answerQuestion(selection: QuestionSelection): void {
        calls.answers.push(selection)
      },
      cancelQuestion(): void {
        calls.cancellations += 1
      },
      decideApproval(outcome: 'allowed-once' | 'rejected'): void {
        calls.approvals.push(outcome)
      },
      decideDialog(): void {},
      cancelDialog(): void {},
    },
  } as unknown as TuiCommands
}

class PanelUi {
  readonly terminal = { columns: 80, rows: 24 } as Terminal
  renderRequests = 0

  requestRender(): void {
    this.renderRequests += 1
  }
}

function asPanelUi(ui: PanelUi): TUI {
  return ui as unknown as TUI
}

function approvalSnapshot(key = 'approval-1'): ApprovalSnapshot {
  return {
    key,
    toolName: 'bash',
    command: 'printf test',
    reason: 'The command needs permission.',
  }
}

function questionSnapshot(key = 'question-1'): QuestionSnapshot {
  return {
    key,
    question: {
      id: 'choice',
      question: 'Choose one',
      options: [
        { label: 'First', description: 'The first choice.' },
        { label: 'Second', description: 'The second choice.' },
      ],
      multiSelect: false,
    } as QuestionSnapshot['question'],
    position: 1,
    total: 1,
    answered: 0,
  }
}

test('ApprovalPanelView confirms only modifier-free Enter', () => {
  const calls: OverlayCalls = { approvals: [], answers: [], cancellations: 0 }
  const panel = new ApprovalPanelView(makeCommands(calls), asPanelUi(new PanelUi()))
  panel.update(approvalSnapshot())

  assert.equal(matchesKey('\r', Key.enter), true)
  assert.equal(matchesKey('\x1b\r', Key.enter), false)
  assert.equal(matchesKey('\x1b[13;5u', Key.enter), false)

  panel.handleInput('\x1b\r')
  panel.handleInput('\x1b[13;5u')
  assert.deepEqual(calls.approvals, [])

  panel.handleInput('\r')
  assert.deepEqual(calls.approvals, ['allowed-once'])
})

test('ApprovalPanelView maps Escape and Ctrl+C to rejection', () => {
  const calls: OverlayCalls = { approvals: [], answers: [], cancellations: 0 }
  const panel = new ApprovalPanelView(makeCommands(calls), asPanelUi(new PanelUi()))

  panel.update(approvalSnapshot('approval-esc'))
  panel.handleInput('\x1b')
  panel.update(approvalSnapshot('approval-ctrl-c'))
  panel.handleInput('\x03')

  assert.deepEqual(calls.approvals, ['rejected', 'rejected'])
})

test('QuestionPanelView submits the focused option and cancels with Escape or Ctrl+C', () => {
  const calls: OverlayCalls = { approvals: [], answers: [], cancellations: 0 }
  const panel = new QuestionPanelView(makeCommands(calls), asPanelUi(new PanelUi()))
  panel.update(questionSnapshot())

  panel.handleInput('\x1b\r')
  panel.handleInput('\x1b[13;5u')
  assert.deepEqual(calls.answers, [])

  panel.handleInput('\r')
  assert.deepEqual(calls.answers, [{ selected: ['First'] }])

  panel.update(questionSnapshot('question-esc'))
  panel.handleInput('\x1b')
  panel.update(questionSnapshot('question-ctrl-c'))
  panel.handleInput('\x03')
  assert.equal(calls.cancellations, 2)
})

class FakeTerminal implements Terminal {
  columns = 80
  rows = 24
  stopCount = 0
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined

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

  sendInput(data: string): void {
    this.inputHandler?.(data)
  }
}

class FocusComponent implements Component, Focusable {
  focused = false
  readonly inputs: string[] = []

  constructor(private readonly label: string) {}

  render(_width: number): string[] {
    return [this.label]
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.inputs.push(data)
  }
}

test('TuiMainScreen overlay toggles visibility and returns focus to the base component', () => {
  const terminal = new FakeTerminal()
  const ui = new TuiMainScreen(terminal)
  const base = new FocusComponent('base')
  const overlay = new FocusComponent('overlay')
  ui.addChild(base)
  ui.setFocus(base)
  ui.start()

  try {
    const handle = ui.showOverlay(overlay)
    assert.equal(ui.hasOverlay(), true)
    assert.equal(overlay.focused, true)
    assert.equal(base.focused, false)

    terminal.sendInput('overlay-input')
    assert.deepEqual(overlay.inputs, ['overlay-input'])
    assert.deepEqual(base.inputs, [])

    handle.setHidden(true)
    assert.equal(ui.hasOverlay(), false)
    assert.equal(handle.isHidden(), true)
    assert.equal(base.focused, true)
    assert.equal(overlay.focused, false)

    terminal.sendInput('base-while-hidden')
    assert.deepEqual(base.inputs, ['base-while-hidden'])

    handle.setHidden(false)
    assert.equal(ui.hasOverlay(), true)
    assert.equal(overlay.focused, true)
    assert.equal(base.focused, false)

    handle.hide()
    assert.equal(ui.hasOverlay(), false)
    assert.equal(overlay.focused, false)
    assert.equal(base.focused, true)

    terminal.sendInput('base-after-close')
    assert.deepEqual(base.inputs, ['base-while-hidden', 'base-after-close'])
  } finally {
    ui.stop()
  }

  assert.equal(terminal.stopCount, 1)
})
