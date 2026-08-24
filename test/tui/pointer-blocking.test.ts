/**
 * M3 stage 3 pointer tests: blocking-overlay click parity (approval /
 * question / extension dialog — research §4.3), the ChatScreen modal pointer
 * gate (§1.3 ownership mirrored to pointer), and the host wiring of
 * TuiAltScreen options including DSH_TUI_DISABLE_MOUSE granularity (§4.4).
 *
 * The screen-level integration tests reuse pi-tui's VirtualTerminal harness
 * (workspace test-only import — the package ships no public test entry) with
 * a REAL TuiAltScreen so events travel the genuine dispatch path: SGR decode
 * → layout hit chain → dock component / ChatScreen root gate.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualTerminal } from '../../packages/pi-tui/test/virtual-terminal.ts'
import { buildAltScreenOptions } from '../../src/tui/bootstrap.js'
import {
  getLayoutNode,
  LAYOUT_NODE,
  ScrollView,
  TuiAltScreen,
  type PointerEvent,
  type PointerEventType,
  type StackLayoutNode,
  type TUI,
} from '../../src/tui/public.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import { ApprovalPanelView } from '../../src/tui/components/overlays/approval-panel.js'
import { ExtensionDialogView } from '../../src/tui/components/overlays/extension-dialog.js'
import { QuestionPanelView } from '../../src/tui/components/overlays/question-panel.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { ApprovalSnapshot } from '../../src/dsh-adapter/approvals.js'

// ── shared fakes ────────────────────────────────────────────────────────

function fakeUi(): TUI {
  return { terminal: { columns: 80, rows: 24 }, requestRender() {} } as unknown as TUI
}

interface OverlaySpies {
  decisions: unknown[]
  answers: unknown[]
  dialogDecisions: unknown[]
}

function fakeCommands(): { commands: TuiCommands; spies: OverlaySpies } {
  const spies: OverlaySpies = { decisions: [], answers: [], dialogDecisions: [] }
  const commands = {
    overlays: {
      decideApproval: (outcome: unknown) => spies.decisions.push(outcome),
      answerQuestion: (selection: unknown) => spies.answers.push(selection),
      decideDialog: (key: unknown, value: unknown) => spies.dialogDecisions.push([key, value]),
      cancelQuestion() {},
      cancelDialog() {},
    },
  } as unknown as TuiCommands
  return { commands, spies }
}

function pointerEvent(
  type: PointerEventType,
  localY: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    type,
    x: 4,
    y: localY,
    localX: 4,
    localY,
    button: type === 'click' || type === 'press' ? 0 : -1,
    shift: false,
    alt: false,
    ctrl: false,
    deltaX: 0,
    deltaY: 0,
    cellIsBlank: false,
    ...overrides,
  }
}

/** Row index of the first rendered line containing `needle`. */
function rowOf(lines: readonly string[], needle: string): number {
  const row = lines.findIndex(line => line.includes(needle))
  assert.notEqual(row, -1, `rendered lines must contain ${JSON.stringify(needle)}: ${JSON.stringify(lines)}`)
  return row
}

// ── host wiring (research §4.4) ─────────────────────────────────────────

test('buildAltScreenOptions wires mouse granularity and the right-click paste hook', () => {
  const saved = process.env.DSH_TUI_DISABLE_MOUSE
  try {
    delete process.env.DSH_TUI_DISABLE_MOUSE
    let pasted = 0
    const options = buildAltScreenOptions({ onRightClickPaste: () => { pasted += 1 } })
    assert.equal(options.mouse, true)
    options.onRightClickPaste?.()
    assert.equal(pasted, 1, 'the onRightClickPaste hook must be threaded through')
    // Recorded gaps: no dsh-side clipboard writer (pi's built-in OSC 52 is
    // the copy path) and no browser-open wiring (dead option on source main).
    assert.equal(options.copySelection, undefined)
    assert.equal(options.openUrl, undefined)

    process.env.DSH_TUI_DISABLE_MOUSE = '1'
    const disabled = buildAltScreenOptions()
    assert.deepEqual(
      disabled.mouse,
      { buttons: false },
      'DISABLE_MOUSE must gate buttons only — wheel scroll survives (source parity)',
    )
    assert.equal(disabled.onRightClickPaste, undefined, 'no hook registered when none is given')
  } finally {
    if (saved === undefined) delete process.env.DSH_TUI_DISABLE_MOUSE
    else process.env.DSH_TUI_DISABLE_MOUSE = saved
  }
})

// ── approval panel ──────────────────────────────────────────────────────

test('approval panel: clicking an option row commits it like Enter', () => {
  const { commands, spies } = fakeCommands()
  const panel = new ApprovalPanelView(commands, fakeUi())
  const snapshot: ApprovalSnapshot = { key: 'a1', toolName: 'Bash', reason: 'need it' }
  panel.update(snapshot)
  const lines = panel.render(80)

  // Blank cells and non-option rows consume without acting.
  panel.handlePointer(pointerEvent('click', rowOf(lines, '1.'), { cellIsBlank: true }))
  panel.handlePointer(pointerEvent('click', 0))
  panel.handlePointer(pointerEvent('wheel', rowOf(lines, '1.'), { deltaY: -1 }))
  assert.deepEqual(spies.decisions, [])

  panel.handlePointer(pointerEvent('click', rowOf(lines, '1.')))
  assert.deepEqual(spies.decisions, ['allowed-once'])

  // A new snapshot remounts; the second row rejects.
  panel.update({ key: 'a2', toolName: 'Bash' })
  const lines2 = panel.render(80)
  panel.handlePointer(pointerEvent('click', rowOf(lines2, '2.')))
  assert.deepEqual(spies.decisions, ['allowed-once', 'rejected'])

  // A right-button press never activates a row.
  panel.update({ key: 'a3', toolName: 'Bash' })
  const lines3 = panel.render(80)
  panel.handlePointer(pointerEvent('click', rowOf(lines3, '1.'), { button: 2 }))
  assert.deepEqual(spies.decisions, ['allowed-once', 'rejected'])

  // Everything inside the rect is consumed while active; hidden panel passes through.
  assert.equal(panel.handlePointer(pointerEvent('press', 0)), true)
  assert.equal(panel.handlePointer(pointerEvent('release', 0)), true)
  panel.update(null)
  assert.equal(panel.handlePointer(pointerEvent('click', 0)), undefined)
})

// ── question panel ──────────────────────────────────────────────────────

function questionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    key: 'q1',
    position: 1,
    total: 1,
    answered: 0,
    question: {
      question: 'Pick one',
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
      ...overrides,
    },
  } as never
}

test('question panel single-select: click answers immediately (focus + Enter)', () => {
  const { commands, spies } = fakeCommands()
  const panel = new QuestionPanelView(commands, fakeUi())
  panel.update(questionSnapshot())
  const lines = panel.render(80)

  // Blank cells do not act.
  panel.handlePointer(pointerEvent('click', rowOf(lines, 'Beta'), { cellIsBlank: true }))
  assert.deepEqual(spies.answers, [])

  panel.handlePointer(pointerEvent('click', rowOf(lines, 'Beta')))
  assert.deepEqual(spies.answers, [{ selected: ['Beta'] }])
})

test('question panel multi-select: click toggles the checkmark (Space)', () => {
  const { commands, spies } = fakeCommands()
  const panel = new QuestionPanelView(commands, fakeUi())
  panel.update(questionSnapshot({ multiSelect: true, key: 'q2' }))
  const lines = panel.render(80)

  panel.handlePointer(pointerEvent('click', rowOf(lines, 'Alpha')))
  assert.deepEqual(spies.answers, [], 'a multi-select click must not submit')

  const checked = panel.render(80)
  assert.ok(checked[rowOf(checked, 'Alpha')]!.includes('◉'), 'the clicked row renders checked')

  // Enter on the option row then submits the checked labels.
  panel.handleInput('\r')
  assert.deepEqual(spies.answers, [{ selected: ['Alpha'] }])
})

test('question panel: clicking the input row focuses it (Tab), never submits', () => {
  const { commands, spies } = fakeCommands()
  const panel = new QuestionPanelView(commands, fakeUi())
  panel.update(questionSnapshot({ key: 'q3' }))
  const lines = panel.render(80)

  panel.handlePointer(pointerEvent('click', rowOf(lines, '✎')))
  assert.deepEqual(spies.answers, [])
  const focused = panel.render(80)
  assert.ok(
    focused.some(line => line.includes('❯✎')),
    'the input row owns the focus pointer after the click',
  )
})

test('question panel plan-review: click focuses + submits the option (Enter)', () => {
  const { commands, spies } = fakeCommands()
  const panel = new QuestionPanelView(commands, fakeUi())
  panel.update(
    questionSnapshot({
      key: 'q4',
      intent: { kind: 'plan-review', approve: 'Approve plan' },
      options: [{ label: 'Approve plan' }, { label: 'Keep planning' }],
    }),
  )
  const lines = panel.render(80)
  panel.handlePointer(pointerEvent('click', rowOf(lines, 'Keep planning')))
  assert.deepEqual(spies.answers, [{ selected: ['Keep planning'] }])
})

// ── extension dialog ────────────────────────────────────────────────────

test('extension dialog select/confirm: clicking a row settles it like Enter', () => {
  const { commands, spies } = fakeCommands()
  const dialog = new ExtensionDialogView(commands, fakeUi())

  dialog.update({
    key: 'd1',
    kind: 'select',
    title: 'Pick',
    options: [
      { id: 'a', label: 'Choice A' },
      { id: 'b', label: 'Choice B' },
    ],
  } as never)
  const selectLines = dialog.render(80)
  dialog.handlePointer(pointerEvent('click', rowOf(selectLines, 'Choice B'), { cellIsBlank: true }))
  dialog.handlePointer(pointerEvent('click', rowOf(selectLines, 'Choice B')))
  assert.deepEqual(spies.dialogDecisions, [['d1', 'b']])

  dialog.update({
    key: 'd2',
    kind: 'confirm',
    title: 'Sure?',
    confirmLabel: 'Go ahead',
    cancelLabel: 'Back out',
  } as never)
  const confirmLines = dialog.render(80)
  dialog.handlePointer(pointerEvent('click', rowOf(confirmLines, 'Back out')))
  assert.deepEqual(spies.dialogDecisions, [['d1', 'b'], ['d2', false]])

  // The input kind has no click action but still consumes (blocking modal).
  dialog.update({ key: 'd3', kind: 'input', title: 'Name', initial: '' } as never)
  dialog.render(80)
  assert.equal(dialog.handlePointer(pointerEvent('click', 3)), true)
  assert.equal(spies.dialogDecisions.length, 2)
})

// ── ChatScreen modal gate (research §1.3) ───────────────────────────────

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function makeViewModel(approval: ApprovalSnapshot | null, rowCount = 0): ChatViewModel {
  const mode = { id: 'default', plan: false } as never
  return {
    meta,
    transcript: {
      meta,
      rows: Array.from({ length: rowCount }, (_, index) => ({
        id: index + 1,
        kind: 'user' as const,
        text: `rowmsg-${index}`,
      })),
    },
    statusLine: {
      meta,
      minimal: false,
      statusBar: {} as never,
      lastUsage: undefined,
      reasoningEffort: undefined,
      mode,
      modeIndex: 0,
      contextWindow: undefined,
      tps: undefined,
      tpsSamples: [],
      model: 'test-model',
      tokens: { input: 0, output: 0 },
      gitBranch: 'main',
      displayCwd: '/repo',
      sessionTitle: '',
      agentId: '',
      working: false,
      workingActivity: undefined,
      activityFrames: undefined,
      contextBarEnabled: false,
      contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    },
    spinner: {
      meta,
      working: false,
      spinnerMode: 'requesting',
      responseChars: 0,
      turnStart: 0,
      activeToolCount: 0,
      workingActivity: undefined,
      activityFrames: undefined,
      activityEnabled: false,
      minimal: false,
      lastUsage: undefined,
    },
    header: { meta, whale: false, model: 'test-model', reasoningEffort: undefined, displayCwd: '/repo', loadedContext: undefined },
    prompt: { meta, pending: [], notifications: [], commandList: [], reasoningEffort: undefined, effortLevels: undefined, working: false, mode },
    overlays: { meta, question: null, approval, dialog: null, statusEntries: [] },
    pluginScene: { meta, active: undefined },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test-provider',
  } as unknown as ChatViewModel
}

class FakeController {
  private listener: (() => void) | undefined
  constructor(private vm: ChatViewModel) {}

  subscribe(_slice: 'chat', listener: () => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  getChat(): ChatViewModel {
    return this.vm
  }

  getSubagents(): never {
    return { meta, items: [] } as never
  }

  setViewModel(vm: ChatViewModel): void {
    this.vm = vm
    this.listener?.()
  }
}

const APPROVAL: ApprovalSnapshot = { key: 'gate-a', toolName: 'Bash', reason: 'gate check' }

function makeChat(ui: TUI, commands: TuiCommands, vm: ChatViewModel): { chat: ChatScreen; controller: FakeController } {
  const controller = new FakeController(vm)
  const chat = new ChatScreen({
    ui,
    commands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen: true,
  })
  return { chat, controller }
}

test('ChatScreen consumes pointer events only while a blocking overlay is active', () => {
  const { commands } = fakeCommands()
  const { chat, controller } = makeChat(fakeUi(), commands, makeViewModel(null))
  try {
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), undefined)
    assert.equal(chat.handlePointer(pointerEvent('wheel', 3, { deltaY: -1 })), undefined)

    controller.setViewModel(makeViewModel(APPROVAL))
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), true, 'click must be gated while approval is open')
    assert.equal(chat.handlePointer(pointerEvent('press', 3)), true, 'press must be gated (no selection start)')
    assert.equal(chat.handlePointer(pointerEvent('wheel', 3, { deltaY: -1 })), true, 'wheel must not fall to the transcript')

    controller.setViewModel(makeViewModel(null))
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), undefined)
  } finally {
    chat.dispose()
  }
})

// ── screen-level integration over the real dispatch path ────────────────

/** SGR mouse sequence for a 0-based cell. */
function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`
}

function conversationScrollOf(chat: ChatScreen): ScrollView {
  const node = chat[LAYOUT_NODE]()
  assert.ok(node !== undefined && node.type === 'vstack')
  // M4b: root = VStack(stickyHeader, conversationRow, dock); the ScrollView
  // is the conversation row HStack's first child.
  const row = (node as StackLayoutNode).entries[1]?.component
  const rowNode = row === undefined ? undefined : getLayoutNode(row)
  assert.ok(rowNode !== undefined && rowNode.type === 'hstack')
  const scroll = (rowNode as StackLayoutNode).entries[0]?.component
  assert.ok(scroll instanceof ScrollView)
  return scroll
}

test('fullscreen dispatch: approval click commits, modal blocks transcript pointer input', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const copied: string[] = []
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
  })
  const { commands, spies } = fakeCommands()
  const { chat, controller } = makeChat(tui, commands, makeViewModel(null, 40))
  try {
    tui.setLayoutRoot(chat)
    tui.start()
    await terminal.waitForRender()
    const scroll = conversationScrollOf(chat)
    const maxTop = scroll.scrollTop
    assert.ok(maxTop > 0, 'the 40-row conversation must overflow the viewport')

    // Baseline, no modal: wheel scrolls and drag-select copies.
    terminal.sendInput(sgr(64, 5, 2)) // wheel up over the transcript
    await terminal.waitForRender()
    assert.ok(scroll.scrollTop < maxTop, 'wheel reaches the transcript ScrollView with no modal')
    terminal.sendInput(sgr(65, 5, 2)) // wheel back down
    await terminal.waitForRender()

    terminal.sendInput(sgr(0, 5, 2))
    terminal.sendInput(sgr(32, 9, 3)) // drag motion
    terminal.sendInput(sgr(0, 9, 3, true))
    await terminal.waitForRender()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(copied.length, 1, 'drag-select copies with no modal')

    // Open the approval panel over the same screen.
    controller.setViewModel(makeViewModel(APPROVAL, 40))
    await terminal.waitForRender()

    // Click the first option row — equivalent to focusing it + Enter.
    const viewport = terminal.getViewport()
    const yesRow = viewport.findIndex(line => /1\.\s/.test(line))
    assert.notEqual(yesRow, -1, `approval option row must be visible: ${JSON.stringify(viewport)}`)
    terminal.sendInput(sgr(0, 6, yesRow))
    terminal.sendInput(sgr(0, 6, yesRow, true))
    await terminal.waitForRender()
    assert.deepEqual(spies.decisions, ['allowed-once'])

    // The fake store keeps the approval open: the modal gate is still up.
    const topBefore = scroll.scrollTop
    terminal.sendInput(sgr(64, 5, 2)) // wheel up over the transcript
    await terminal.waitForRender()
    assert.equal(scroll.scrollTop, topBefore, 'wheel must not reach the transcript while the modal is open')

    terminal.sendInput(sgr(0, 5, 2))
    terminal.sendInput(sgr(32, 9, 3))
    terminal.sendInput(sgr(0, 9, 3, true))
    await terminal.waitForRender()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(copied.length, 1, 'drag-select on the transcript is suppressed while the modal is open')
    assert.equal(spies.decisions.length, 1, 'transcript clicks never reach a business action')

    // Modal closed: pointer behavior returns.
    controller.setViewModel(makeViewModel(null, 40))
    await terminal.waitForRender()
    terminal.sendInput(sgr(64, 5, 2))
    await terminal.waitForRender()
    assert.ok(scroll.scrollTop < topBefore, 'wheel scrolls again once the modal closes')
  } finally {
    chat.dispose()
    tui.stop()
  }
})
