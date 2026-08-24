/**
 * M3 stage 6 pointer tests, part 1 — transcript card clicks (research §4.3
 * final state):
 *
 * - tool / compact / settled-reasoning rows toggle their PER-ROW expansion
 *   (RowContext.expandedRows); a streaming reasoning row toggles
 *   streamFoldedRows instead (its default is the live view);
 * - every fold action is gated by cellIsBlank — the unpainted right tail of
 *   a row is a selection attempt, not a toggle;
 * - plain user/assistant rows never consume a click (reading area; drag
 *   selection stays available) and press/wheel/move are never consumed;
 * - the subagent card click opens the detail scene through the wired
 *   callback (the dashboard Enter path's target), the fold dividers reuse
 *   the loadOlder sink path / the Ctrl+E fold lift;
 * - the §1.3 pointer gate is mirrored into the transcript via
 *   isPointerBlocked — under an open modal a card click is consumed without
 *   acting;
 * - the fullscreen integration drives a REAL TuiAltScreen: SGR decode →
 *   layout hit chain → TranscriptView, including the dispatch contract that
 *   a drag release never produces a click.
 *
 * Component-level tests drive handlePointer directly with synthesized events
 * (localY = the line index in the last render output); runs with the bare
 * Node test runner (`node --import tsx/esm --test`).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualTerminal } from '../../packages/pi-tui/test/virtual-terminal.ts'
import {
  TuiAltScreen,
  stripTerminalSequences,
  type PointerEvent,
  type PointerEventType,
  type TUI,
} from '../../src/tui/public.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import { TranscriptView } from '../../src/tui/components/transcript.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { ChatRow } from '../../src/dsh-adapter/channel.js'
import type { ApprovalSnapshot } from '../../src/dsh-adapter/approvals.js'
import { setLang, t } from '../../src/i18n.js'

setLang('en')

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

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

/** Rendered lines, ANSI-stripped, plus the index lookup helper. */
function linesOf(view: TranscriptView, width = 80): string[] {
  return view.render(width).map(line => stripTerminalSequences(line))
}

function rowOf(lines: readonly string[], needle: string): number {
  const row = lines.findIndex(line => line.includes(needle))
  assert.notEqual(row, -1, `rendered lines must contain ${JSON.stringify(needle)}: ${JSON.stringify(lines)}`)
  return row
}

function projection(rows: readonly ChatRow[], revision = 1) {
  return { meta: { ...meta, revision }, rows } as never
}

function toolRow(id: number): ChatRow {
  return {
    id,
    kind: 'tool',
    text: '',
    tool: {
      callId: `call-${id}`,
      name: 'bash',
      argsText: 'ls -la',
      status: 'ok',
      resultText: 'r1\nr2\nr3\nr4\nr5',
      startedAt: 1,
      durationMs: 1500,
    },
  } as ChatRow
}

const FOLD_HINT = '+2 lines (ctrl+o to expand)'

// ── tool card ───────────────────────────────────────────────────────────

test('tool card: click toggles the per-row expansion, blank tail never does', () => {
  const view = new TranscriptView()
  view.update(projection([{ id: 1, kind: 'assistant', text: 'answer' } as ChatRow, toolRow(2)]))

  let lines = linesOf(view)
  const headerY = rowOf(lines, 'Bash(ls -la)')
  assert.ok(lines.some(line => line.includes(FOLD_HINT)), 'the body starts capped')

  // The unpainted right tail of the row is a selection attempt (audit C-03).
  assert.equal(view.handlePointer(pointerEvent('click', headerY, { cellIsBlank: true })), undefined)
  lines = linesOf(view)
  assert.ok(lines.some(line => line.includes(FOLD_HINT)), 'blank-tail click must not expand')

  // A painted cell toggles the row open — and ONLY this row's state moved.
  assert.equal(view.handlePointer(pointerEvent('click', headerY)), true)
  lines = linesOf(view)
  assert.ok(!lines.some(line => line.includes(FOLD_HINT)), 'click expands the body')
  assert.ok(lines.some(line => line.includes('r5')), 'the full result is visible')

  // Clicking again folds it back.
  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'Bash(ls -la)'))), true)
  lines = linesOf(view)
  assert.ok(lines.some(line => line.includes(FOLD_HINT)), 'second click folds the body again')
})

test('tool card: press, wheel and right-button clicks stay unconsumed', () => {
  const view = new TranscriptView()
  view.update(projection([toolRow(1)]))
  const lines = linesOf(view)
  const headerY = rowOf(lines, 'Bash(ls -la)')
  assert.equal(view.handlePointer(pointerEvent('press', headerY)), undefined)
  assert.equal(view.handlePointer(pointerEvent('release', headerY)), undefined)
  assert.equal(view.handlePointer(pointerEvent('wheel', headerY, { deltaY: -1 })), undefined)
  assert.equal(view.handlePointer(pointerEvent('click', headerY, { button: 2 })), undefined)
  // Nothing acted: the body stays capped.
  assert.ok(linesOf(view).some(line => line.includes(FOLD_HINT)))
})

// ── thinking rows ───────────────────────────────────────────────────────

test('settled thinking row: click toggles the per-row expansion', () => {
  const view = new TranscriptView()
  view.update(projection([
    { id: 1, kind: 'reasoning', text: 'reasoning body line A\nreasoning body line B', durationMs: 2000 } as ChatRow,
  ]))

  let lines = linesOf(view)
  const headerY = rowOf(lines, 'Thinking')
  assert.ok(!lines.some(line => line.includes('reasoning body line A')), 'settled rows start folded')

  assert.equal(view.handlePointer(pointerEvent('click', headerY, { cellIsBlank: true })), undefined)
  assert.ok(!linesOf(view).some(line => line.includes('reasoning body line A')), 'blank click must not expand')

  assert.equal(view.handlePointer(pointerEvent('click', headerY)), true)
  lines = linesOf(view)
  assert.ok(lines.some(line => line.includes('reasoning body line A')), 'click expands the full text')

  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'Thinking'))), true)
  assert.ok(!linesOf(view).some(line => line.includes('reasoning body line A')), 'second click folds again')
})

test('streaming thinking row: click folds the live view to the header and back', () => {
  const view = new TranscriptView()
  const row = {
    id: 1,
    kind: 'reasoning',
    text: Array.from({ length: 12 }, (_, index) => `stream reasoning line ${index}`).join('\n'),
    streaming: true,
  } as ChatRow
  view.update(projection([row]))

  // Default thinkingFold is 'preview': the constant-height 3-row ticker.
  let lines = linesOf(view)
  const tickerRows = lines.filter(line => line.includes('│'))
  assert.equal(tickerRows.length, 3, 'the live ticker shows by default')

  // Click folds to the bare spinner header (streamFoldedRows, not
  // expandedRows — the streaming default is the opposite of settled).
  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'Thinking'))), true)
  lines = linesOf(view)
  assert.equal(lines.filter(line => line.includes('│')).length, 0, 'click folds the ticker away')
  assert.ok(lines.some(line => line.includes('Thinking')), 'the header stays')

  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'Thinking'))), true)
  assert.equal(linesOf(view).filter(line => line.includes('│')).length, 3, 'second click restores the live view')
})

test('streaming thinking fold never leaks into the settled default', () => {
  const view = new TranscriptView()
  const row = {
    id: 1,
    kind: 'reasoning',
    text: 'stream body',
    streaming: true,
  } as ChatRow
  view.update(projection([row]))
  let lines = linesOf(view)
  view.handlePointer(pointerEvent('click', rowOf(lines, 'Thinking')))
  assert.ok(!linesOf(view).some(line => line.includes('stream body')), 'folded while streaming')

  // The row settles (same id, streaming flag cleared): the settled default
  // fold takes over seamlessly — the two defaults never flip each other.
  view.update(projection([{ ...row, streaming: false, durationMs: 2000 }], 2))
  lines = linesOf(view)
  assert.ok(lines.some(line => line.includes('Thinking')), 'settled header shows')
  assert.ok(!lines.some(line => line.includes('stream body')), 'still folded after settling')
})

// ── compact row ─────────────────────────────────────────────────────────

test('compact row: click toggles the summary fold', () => {
  const view = new TranscriptView()
  view.update(projection([{ id: 1, kind: 'compact', text: 'the full summary body' } as ChatRow]))
  const foldedMarker = t('compact-summary-folded')

  let lines = linesOf(view)
  const headerY = rowOf(lines, foldedMarker)
  assert.equal(view.handlePointer(pointerEvent('click', headerY, { cellIsBlank: true })), undefined)
  assert.ok(linesOf(view).some(line => line.includes(foldedMarker)), 'blank click must not expand')

  assert.equal(view.handlePointer(pointerEvent('click', headerY)), true)
  lines = linesOf(view)
  assert.ok(!lines.some(line => line.includes(foldedMarker)), 'click reveals the full summary')
  assert.ok(lines.some(line => line.includes('the full summary body')))

  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'the full summary body'))), true)
  assert.ok(linesOf(view).some(line => line.includes(foldedMarker)), 'second click folds again')
})

// ── plain rows stay a reading area ──────────────────────────────────────

test('plain user/assistant rows never consume a click', () => {
  const view = new TranscriptView()
  view.update(projection([
    { id: 1, kind: 'user', text: 'the question' } as ChatRow,
    { id: 2, kind: 'assistant', text: 'the answer' } as ChatRow,
  ]))
  const lines = linesOf(view)
  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'the question'))), undefined)
  assert.equal(view.handlePointer(pointerEvent('click', rowOf(lines, 'the answer'))), undefined)
})

// ── subagent card ───────────────────────────────────────────────────────

function subagentRow(id: number, agentId: string): ChatRow {
  return {
    id,
    kind: 'subagent',
    text: '',
    subagent: {
      agentId,
      description: 'scout the repo',
      status: 'completed',
      startedAt: 0,
      completedAt: 1,
      durationMs: 1000,
      outputLines: [],
      toolCalls: [],
    },
  } as ChatRow
}

test('subagent card: click opens the detail through the wired callback', () => {
  const view = new TranscriptView()
  const opened: string[] = []
  view.onOpenSubagent = agentId => opened.push(agentId)
  view.update(projection([subagentRow(1, 'agent-42')]))

  const lines = linesOf(view)
  const cardY = rowOf(lines, 'Subagent:')

  // Without a painted cell there is no card click (selection attempt).
  assert.equal(view.handlePointer(pointerEvent('click', cardY, { cellIsBlank: true })), undefined)
  assert.deepEqual(opened, [])

  assert.equal(view.handlePointer(pointerEvent('click', cardY)), true)
  assert.deepEqual(opened, ['agent-42'])
})

test('subagent card: without the callback the click stays unconsumed', () => {
  const view = new TranscriptView()
  view.update(projection([subagentRow(1, 'agent-42')]))
  const cardY = rowOf(linesOf(view), 'Subagent:')
  assert.equal(view.handlePointer(pointerEvent('click', cardY)), undefined)
})

// ── fold dividers ───────────────────────────────────────────────────────

test('load-earlier divider: click routes to the wired sink callback', () => {
  const view = new TranscriptView()
  let loads = 0
  view.onLoadOlder = () => { loads += 1 }
  view.update(projection([
    { id: 1, kind: 'user', text: 'old prompt', folded: true } as ChatRow,
    { id: 2, kind: 'assistant', text: 'old answer' } as ChatRow,
  ]))
  const lines = linesOf(view)
  const dividerY = rowOf(lines, t('load-earlier').trim())

  // The blank line above the divider paints nothing — never a trigger.
  assert.equal(view.handlePointer(pointerEvent('click', dividerY - 1, { cellIsBlank: true })), undefined)
  assert.equal(loads, 0)

  assert.equal(view.handlePointer(pointerEvent('click', dividerY)), true)
  assert.equal(loads, 1)
})

test('show-previous divider: click lifts the render cap like Ctrl+E', () => {
  const rows = Array.from({ length: 305 }, (_, index) =>
    ({ id: index + 1, kind: 'user', text: `rowmsg-${index}` }) as ChatRow)
  const view = new TranscriptView()
  view.update(projection(rows))
  const lines = linesOf(view)
  const dividerY = rowOf(lines, 'ctrl+e to show')
  assert.equal(view.isShowingAll, false)

  assert.equal(view.handlePointer(pointerEvent('click', dividerY)), true)
  assert.equal(view.isShowingAll, true, 'the click lifts the MAX_RENDERED_ROWS fold')
  assert.ok(linesOf(view).some(line => line.includes('rowmsg-0')), 'the oldest row renders now')
})

// ── pointer gate mirror (§1.3) ──────────────────────────────────────────

test('isPointerBlocked: a blocked transcript consumes clicks without acting', () => {
  const view = new TranscriptView()
  view.isPointerBlocked = () => true
  view.update(projection([toolRow(1)]))
  const headerY = rowOf(linesOf(view), 'Bash(ls -la)')

  assert.equal(view.handlePointer(pointerEvent('click', headerY)), true, 'consumed, like the root backstop')
  assert.equal(view.handlePointer(pointerEvent('wheel', headerY, { deltaY: 1 })), true, 'wheel gated too')
  assert.ok(linesOf(view).some(line => line.includes(FOLD_HINT)), 'no business action while blocked')
})

// ── fullscreen integration over the real dispatch path ──────────────────

/** SGR mouse sequence for a 0-based cell. */
function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`
}

function makeViewModel(rows: readonly ChatRow[], approval: ApprovalSnapshot | null = null): ChatViewModel {
  const mode = { id: 'default', plan: false } as never
  return {
    meta,
    transcript: { meta, rows },
    statusLine: {
      meta,
      minimal: true, // no whale header: the transcript owns content row 0
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

  setViewModel(vm: ChatViewModel): void {
    this.vm = vm
    this.listener?.()
  }
}

function transcriptRows(): ChatRow[] {
  return [
    { id: 1, kind: 'user', text: 'the question' } as ChatRow,
    { id: 2, kind: 'assistant', text: 'a plain reading row' } as ChatRow,
    toolRow(3),
    { id: 4, kind: 'assistant', text: 'trailing answer' } as ChatRow,
  ]
}

test('fullscreen dispatch: card clicks toggle, drag release never does, the modal gate holds', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const copied: string[] = []
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
  })
  const commands = { overlays: {} } as unknown as TuiCommands
  const controller = new FakeController(makeViewModel(transcriptRows()))
  const chat = new ChatScreen({
    ui: tui as unknown as TUI,
    commands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen: true,
  })
  try {
    tui.setLayoutRoot(chat)
    tui.start()
    await terminal.waitForRender()

    const toolY = (): number => {
      const viewport = terminal.getViewport()
      const row = viewport.findIndex(line => line.includes('Bash(ls -la)'))
      assert.notEqual(row, -1, `tool header must be visible: ${JSON.stringify(viewport)}`)
      return row
    }
    const folded = (): boolean =>
      terminal.getViewport().some(line => line.includes(FOLD_HINT))

    assert.ok(folded(), 'the tool body starts capped')

    // 1. A click on the card header toggles the expansion (same cell,
    //    no drag → click dispatched; painted cell → not blank).
    const y0 = toolY()
    terminal.sendInput(sgr(0, 3, y0))
    terminal.sendInput(sgr(0, 3, y0, true))
    await terminal.waitForRender()
    assert.ok(!folded(), 'click expands the tool body')

    // 2. Clicking again folds it back.
    const y1 = toolY()
    terminal.sendInput(sgr(0, 3, y1))
    terminal.sendInput(sgr(0, 3, y1, true))
    await terminal.waitForRender()
    assert.ok(folded(), 'second click folds the body again')

    // 3. A drag starting on the card selects text and must NOT toggle —
    //    the dispatch contract never turns a drag release into a click.
    const y2 = toolY()
    terminal.sendInput(sgr(0, 3, y2))
    terminal.sendInput(sgr(32, 9, y2 + 1)) // button-motion drag
    terminal.sendInput(sgr(0, 9, y2 + 1, true))
    await terminal.waitForRender()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(folded(), 'drag release must not toggle the card')
    assert.equal(copied.length, 1, 'the drag still copies the selection')

    // 4. A click on a plain assistant row is a no-op: unconsumed, no copy.
    const viewport = terminal.getViewport()
    const plainY = viewport.findIndex(line => line.includes('a plain reading row'))
    assert.notEqual(plainY, -1)
    terminal.sendInput(sgr(0, 3, plainY))
    terminal.sendInput(sgr(0, 3, plainY, true))
    await terminal.waitForRender()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(copied.length, 1, 'a plain-row click copies nothing')
    assert.ok(folded(), 'a plain-row click changes nothing')

    // 5. With an approval panel open the transcript consumes the click
    //    through the isPointerBlocked mirror — no business action leaks.
    controller.setViewModel(makeViewModel(transcriptRows(), { key: 'gate-1', toolName: 'Bash', reason: 'gate' }))
    await terminal.waitForRender()
    const y3 = toolY()
    terminal.sendInput(sgr(0, 3, y3))
    terminal.sendInput(sgr(0, 3, y3, true))
    await terminal.waitForRender()
    assert.ok(folded(), 'a card click under an open modal must not act')

    // 6. Gate lifted: clicks act again.
    controller.setViewModel(makeViewModel(transcriptRows()))
    await terminal.waitForRender()
    const y4 = toolY()
    terminal.sendInput(sgr(0, 3, y4))
    terminal.sendInput(sgr(0, 3, y4, true))
    await terminal.waitForRender()
    assert.ok(!folded(), 'the click acts again once the modal closes')
  } finally {
    chat.dispose()
    tui.stop()
  }
})
