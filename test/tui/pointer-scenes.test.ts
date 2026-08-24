/**
 * M3 stage 6 pointer tests, part 2 — transient scenes (research §4.3 final
 * state):
 *
 * - TrajectoryScene: the header ✕ closes (q/Esc seat), tab segments switch
 *   views (←/→), the query segment AND the clipped gap reopen the search
 *   editor (/), the right axis label cycles the projection/sort (m/t), a
 *   wave-band column seeks the nearest event, a ledger row moves the cursor
 *   (jumpTo), a hotspot row takes the Enter path back to the timeline, and
 *   the wheel moves the SELECTION (±3 ledger / ±1 hotspot), not a viewport;
 * - SubagentDashboardScreen: the counts row's ✕ closes, card rows stay
 *   keyboard-Enter only (source main parity — clicks are consumed without
 *   acting), the wheel steps the focus row;
 * - SubagentDetailScreen: the identity row's ✕ takes the onBack seat, tab
 *   cells switch pages with the ←/→ turn semantics (scroll reset), the hint
 *   row's `X interrupt` segment runs the x key's exact command path
 *   (commands.query.subagentInterrupt), and the wheel scrolls the body.
 *
 * Every click/wheel inside a transient scene is consumed (nothing behind it
 * may see the event); press/release/move stay unconsumed so terminal
 * drag-selection copy keeps working.
 *
 * Component-level tests drive handlePointer directly with synthesized events
 * (localY = the line index in the last render output, localX = the padded
 * cell); runs with the bare Node test runner (`node --import tsx/esm --test`).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripTerminalSequences, type PointerEvent, type PointerEventType } from '../../src/tui/public.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import { TrajectoryScene } from '../../src/tui/screens/trajectory-scene.js'
import {
  SubagentDashboardScreen,
  SubagentDetailScreen,
} from '../../src/tui/screens/subagent-scenes.js'
import type { SubagentState } from '../../src/dsh-adapter/subagents.js'
import { setLang } from '../../src/i18n.js'

setLang('en')

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function pointerEvent(
  type: PointerEventType,
  localY: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    type,
    x: overrides.localX ?? 4,
    y: localY,
    localX: overrides.localX ?? 4,
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

// ── trajectory fixtures ─────────────────────────────────────────────────

let seq = 0
const T0 = 1_700_000_000_000
/** One event with a monotonic seq and a caller-controlled offset. */
const ev = (type: string, data: unknown, dtMs = 1): unknown =>
  ({ type, seq: ++seq, time: T0 + seq * 10 + dtMs, data })

/** Three turns, one step each: turn/user/step/assistant/tool → 15 nodes. */
function synthEvents(): readonly unknown[] {
  seq = 0
  const out: unknown[] = []
  for (let turn = 1; turn <= 3; turn++) {
    out.push(ev('turn/start', { turn }))
    out.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] }))
    out.push(ev('step/start', { turn, step: 1 }))
    out.push(ev('assistant/message', {
      turn,
      step: 1,
      message: { content: [{ type: 'text', text: `reply ${turn}` }] },
      usage: { input: 100, output: 20 },
    }))
    out.push(ev('tool/call', { turn, step: 1, callId: `c${turn}`, name: 'read', arguments: '{}' }))
    out.push(ev('tool/result', {
      turn,
      step: 1,
      message: { source: { callId: `c${turn}` }, content: [{ type: 'text', text: `result ${turn}` }] },
    }))
    out.push(ev('step/end', { turn, step: 1 }))
    out.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return out
}

function makeTrajectory(viewportHeight = 24) {
  let closes = 0
  const commands = {
    info: { traceEvents: () => [] },
    query: { subagentInterrupt: () => {} },
  } as unknown as TuiCommands
  const scene = new TrajectoryScene({
    commands,
    onClose: () => { closes += 1 },
    title: 'test session',
    viewportHeight,
  })
  scene.update({ meta, events: synthEvents() } as never)
  return { scene, closes: () => closes }
}

function trajLines(scene: TrajectoryScene, width = 80): string[] {
  return scene.render(width).map(line => stripTerminalSequences(line))
}

/** Offset (within the ledger window) of the cursor row's `▸` marker. */
function cursorOffset(lines: readonly string[]): number {
  const CONTENT_START = 5
  const offset = lines.slice(CONTENT_START).findIndex(line => line.includes('▸'))
  assert.notEqual(offset, -1, `a cursor row must be visible: ${JSON.stringify(lines)}`)
  return offset
}

// ── trajectory: chrome rows ─────────────────────────────────────────────

test('trajectory: the header ✕ closes; other header cells only consume', () => {
  const { scene, closes } = makeTrajectory()
  try {
    trajLines(scene)
    // Far-left header cell: consumed (modal), no action.
    assert.equal(scene.handlePointer(pointerEvent('click', 0, { localX: 10 })), true)
    assert.equal(closes(), 0)
    // The ✕ cell pins to the band's right end: bandWidth = 80-4 = 76 content
    // columns, the padded scene line shifts by one → localX ≥ 75.
    assert.equal(scene.handlePointer(pointerEvent('click', 0, { localX: 76 })), true)
    assert.equal(closes(), 1, 'the ✕ click takes the q/Esc seat')
  } finally {
    scene.dispose()
  }
})

test('trajectory: tab clicks switch views like ←/→', () => {
  const { scene } = makeTrajectory()
  try {
    let lines = trajLines(scene)
    assert.ok(lines[1]!.includes('● Timeline'), 'starts on the timeline tab')

    const hotspotColumn = lines[1]!.indexOf('Hotspot')
    assert.notEqual(hotspotColumn, -1)
    assert.equal(scene.handlePointer(pointerEvent('click', 1, { localX: hotspotColumn + 1 })), true)
    lines = trajLines(scene)
    assert.ok(lines[1]!.includes('● Hotspot'), 'the hotspot tab is active now')
    assert.ok(lines.some(line => line.includes('Tools')), 'the hotspot sections render')

    const timelineColumn = lines[1]!.indexOf('Timeline')
    assert.equal(scene.handlePointer(pointerEvent('click', 1, { localX: timelineColumn + 1 })), true)
    assert.ok(trajLines(scene)[1]!.includes('● Timeline'), 'back to the timeline')
  } finally {
    scene.dispose()
  }
})

test('trajectory: the axis label click cycles the projection like m', () => {
  const { scene } = makeTrajectory()
  try {
    let lines = trajLines(scene)
    assert.ok(lines[1]!.includes('compressed'), 'compressed wall-clock is the default')

    const axisX = (): number => lines[1]!.length - 1 // the right-most cell is inside the axis segment
    scene.handlePointer(pointerEvent('click', 1, { localX: axisX() + 1 }))
    lines = trajLines(scene)
    assert.ok(lines[1]!.includes('even'), 'compressed → even (sequence)')

    scene.handlePointer(pointerEvent('click', 1, { localX: axisX() + 1 }))
    lines = trajLines(scene)
    assert.ok(lines[1]!.includes('wall-clock'), 'even → wall-clock')

    scene.handlePointer(pointerEvent('click', 1, { localX: axisX() + 1 }))
    assert.ok(trajLines(scene)[1]!.includes('compressed'), 'wall-clock wraps to compressed')
  } finally {
    scene.dispose()
  }
})

test('trajectory: the tabs-row gap reopens the query editor like /', () => {
  const { scene } = makeTrajectory()
  try {
    const lines = trajLines(scene)
    assert.ok(!lines[1]!.includes('▌'), 'no query editor initially')
    // The clipped gap between the tabs and the axis label IS where the query
    // line sits — clicking it opens the editor.
    assert.equal(scene.handlePointer(pointerEvent('click', 1, { localX: 41 })), true)
    assert.ok(trajLines(scene)[1]!.includes('▌'), 'the query editor opened')
  } finally {
    scene.dispose()
  }
})

// ── trajectory: band + ledger + hotspot ─────────────────────────────────

test('trajectory: a wave-band column click seeks the nearest event', () => {
  const { scene } = makeTrajectory()
  try {
    let lines = trajLines(scene)
    // Tail-follow: the cursor starts on the last ledger row.
    assert.ok(cursorOffset(lines) > 0, 'the cursor starts pinned to the tail')

    // Column 0's bucket holds the session's first event (ruler row included).
    assert.equal(scene.handlePointer(pointerEvent('click', 2, { localX: 1 })), true)
    lines = trajLines(scene)
    assert.equal(cursorOffset(lines), 0, 'the cursor jumped to the first event')

    // The ruler row (one line below the wave) seeks too.
    assert.equal(scene.handlePointer(pointerEvent('click', 3, { localX: 40 })), true)
    assert.ok(cursorOffset(trajLines(scene)) >= 0, 'the ruler row is clickable')
  } finally {
    scene.dispose()
  }
})

test('trajectory: a ledger row click moves the cursor to that row', () => {
  const { scene } = makeTrajectory()
  try {
    trajLines(scene)
    // Pin the cursor to the top first so the window start is deterministic.
    scene.handlePointer(pointerEvent('click', 2, { localX: 1 }))
    assert.equal(cursorOffset(trajLines(scene)), 0)

    assert.equal(scene.handlePointer(pointerEvent('click', 5 + 3, { localX: 6 })), true)
    assert.equal(cursorOffset(trajLines(scene)), 3, 'the clicked ledger row is focused')

    // The divider/inspector rows below the ledger are inert (still consumed).
    assert.equal(scene.handlePointer(pointerEvent('click', 5 + 10 + 2, { localX: 6 })), true)
    assert.equal(cursorOffset(trajLines(scene)), 3, 'below-ledger clicks never move the cursor')
  } finally {
    scene.dispose()
  }
})

test('trajectory: a hotspot row click takes the Enter path back to the timeline', () => {
  const { scene } = makeTrajectory()
  try {
    let lines = trajLines(scene)
    scene.handlePointer(pointerEvent('click', 1, { localX: lines[1]!.indexOf('Hotspot') + 1 }))
    lines = trajLines(scene)
    assert.ok(lines[1]!.includes('● Hotspot'))

    // The section title row has no click target: the view stays put.
    assert.equal(scene.handlePointer(pointerEvent('click', 5, { localX: 6 })), true)
    assert.ok(trajLines(scene)[1]!.includes('● Hotspot'), 'title rows are inert')

    // The first data row (one below the title) jumps back to the timeline,
    // positioned on the group's first member — the hotspot Enter seat.
    assert.equal(scene.handlePointer(pointerEvent('click', 6, { localX: 6 })), true)
    lines = trajLines(scene)
    assert.ok(lines[1]!.includes('● Timeline'), 'the click returned to the timeline')
    assert.ok(cursorOffset(lines) >= 0, 'a cursor row is focused')
  } finally {
    scene.dispose()
  }
})

test('trajectory: the wheel moves the selection, not a viewport', () => {
  const { scene } = makeTrajectory()
  try {
    trajLines(scene)
    scene.handlePointer(pointerEvent('click', 2, { localX: 1 })) // cursor → 0
    assert.equal(cursorOffset(trajLines(scene)), 0)

    assert.equal(scene.handlePointer(pointerEvent('wheel', 8, { deltaY: 1 })), true)
    assert.equal(cursorOffset(trajLines(scene)), 3, 'timeline wheel steps ±3')

    assert.equal(scene.handlePointer(pointerEvent('wheel', 8, { deltaY: -1 })), true)
    assert.equal(cursorOffset(trajLines(scene)), 0, 'wheel up steps back')

    // Hotspot view: ±1 cursor step (the LINE delta is larger when a section
    // title sits between the two rows — the cursor walks rows, not lines).
    let lines = trajLines(scene)
    scene.handlePointer(pointerEvent('click', 1, { localX: lines[1]!.indexOf('Hotspot') + 1 }))
    lines = trajLines(scene)
    const hotCursorRow = lines.findIndex(line => line.includes('▸'))
    assert.ok(hotCursorRow > 0)
    scene.handlePointer(pointerEvent('wheel', 8, { deltaY: 1 }))
    const moved = trajLines(scene).findIndex(line => line.includes('▸'))
    assert.ok(moved > hotCursorRow, 'hotspot wheel steps the cursor one row down')
  } finally {
    scene.dispose()
  }
})

test('trajectory: press/release/move are never consumed', () => {
  const { scene } = makeTrajectory()
  try {
    trajLines(scene)
    assert.equal(scene.handlePointer(pointerEvent('press', 0, { localX: 76 })), undefined)
    assert.equal(scene.handlePointer(pointerEvent('release', 0, { localX: 76 })), undefined)
    assert.equal(scene.handlePointer(pointerEvent('move', 1)), undefined)
  } finally {
    scene.dispose()
  }
})

// ── subagent fixtures ───────────────────────────────────────────────────

function subagent(agentId: string, status: SubagentState['status'], extra: Partial<SubagentState> = {}): SubagentState {
  return {
    agentId,
    description: `scout ${agentId}`,
    status,
    startedAt: T0,
    output: [],
    outputEvents: [],
    toolCalls: [],
    ...extra,
  }
}

function makeCommands(interrupts: string[]): TuiCommands {
  return {
    info: { traceEvents: () => [] },
    query: { subagentInterrupt: (agentId: string) => interrupts.push(agentId) },
  } as unknown as TuiCommands
}

function stripped(view: { render(width: number): string[] }, width = 80): string[] {
  return view.render(width).map(line => stripTerminalSequences(line))
}

// ── subagent dashboard ──────────────────────────────────────────────────

test('dashboard: the counts row ✕ closes; card rows never open on click', () => {
  const interrupts: string[] = []
  let closes = 0
  const selected: string[] = []
  const screen = new SubagentDashboardScreen(makeCommands(interrupts), {
    onClose: () => { closes += 1 },
    onSelect: agentId => selected.push(agentId),
  })
  screen.update({ meta, items: [subagent('a-1', 'running'), subagent('a-2', 'completed')] })
  const lines = stripped(screen)
  assert.ok(lines[3]!.includes('running'), 'the counts row renders')

  // Card row click (the list starts at row 5): consumed, but NOT a select —
  // card rows are keyboard-Enter only on source main.
  assert.equal(screen.handlePointer(pointerEvent('click', 5, { localX: 10 })), true)
  assert.deepEqual(selected, [])
  assert.equal(closes, 0)

  // The ✕ cell at the counts row's right end: contentWidth = 80-4 = 76,
  // side padding 2 → localX ≥ 76.
  assert.equal(screen.handlePointer(pointerEvent('click', 3, { localX: 77 })), true)
  assert.equal(closes, 1, 'the ✕ click takes the Esc seat')
})

test('dashboard: the wheel steps the focus row like ↑/↓', () => {
  const interrupts: string[] = []
  const selected: string[] = []
  const screen = new SubagentDashboardScreen(makeCommands(interrupts), {
    onClose: () => {},
    onSelect: agentId => selected.push(agentId),
  })
  screen.update({ meta, items: [subagent('a-1', 'running'), subagent('a-2', 'completed')] })
  stripped(screen)

  assert.equal(screen.handlePointer(pointerEvent('wheel', 5, { deltaY: 1 })), true)
  screen.handleInput('\r') // an unmodified Enter confirms the focused row
  assert.deepEqual(selected, ['a-2'], 'the wheel moved the focus to the second card')

  assert.equal(screen.handlePointer(pointerEvent('press', 5)), undefined)
  assert.equal(screen.handlePointer(pointerEvent('move', 5)), undefined)
})

// ── subagent detail ─────────────────────────────────────────────────────

function detailFixture(): SubagentState {
  return subagent('a-9', 'running', {
    outputEvents: Array.from({ length: 40 }, (_, index) => ({
      kind: 'text' as const,
      text: `line-${index}`,
      at: T0 + index,
      settled: true,
    })),
    output: Array.from({ length: 40 }, (_, index) => `line-${index}`),
  })
}

test('detail: tab cells switch pages with the ←/→ turn semantics', () => {
  const interrupts: string[] = []
  let backs = 0
  const screen = new SubagentDetailScreen(makeCommands(interrupts), { onBack: () => { backs += 1 } }, detailFixture())
  let lines = stripped(screen)
  assert.ok(lines.some(line => line.includes('Status')), 'the summary page renders first')

  const tabsRow = lines.findIndex(line => line.includes('Summary') && line.includes('Output'))
  assert.notEqual(tabsRow, -1, `the tab bar must render: ${JSON.stringify(lines)}`)

  // Click the Output tab cell (its label's first cell is inside the range).
  const outputX = lines[tabsRow]!.indexOf('Output')
  assert.equal(screen.handlePointer(pointerEvent('click', tabsRow, { localX: outputX + 1 })), true)
  lines = stripped(screen)
  // The subagent is RUNNING: the output page tail-follows the newest line
  // (goToPage resumes the follow), so the window sits at the stream's tail.
  assert.ok(lines.some(line => line.includes('line-39')), 'the output page tail-follows the stream')
  assert.ok(!lines.some(line => line.includes('line-0')), 'the head scrolled out of the window')

  // Clicking the ACTIVE tab is a no-op (same page).
  assert.equal(screen.handlePointer(pointerEvent('click', tabsRow, { localX: outputX + 1 })), true)
  assert.ok(stripped(screen).some(line => line.includes('line-39')), 'still on the output page')

  // The ✕ on the identity row takes the onBack seat.
  assert.equal(screen.handlePointer(pointerEvent('click', 1, { localX: 77 })), true)
  assert.equal(backs, 1)
})

test('detail: the X interrupt hint segment runs the x key command path', () => {
  const interrupts: string[] = []
  const screen = new SubagentDetailScreen(makeCommands(interrupts), { onBack: () => {} }, detailFixture())
  const lines = stripped(screen)
  const hintRow = lines.findIndex(line => line.includes('X interrupt'))
  assert.notEqual(hintRow, -1, 'a running subagent shows the interrupt hint')

  // Outside the segment: consumed, no command.
  assert.equal(screen.handlePointer(pointerEvent('click', hintRow, { localX: 3 })), true)
  assert.deepEqual(interrupts, [])

  const segmentX = lines[hintRow]!.indexOf('X interrupt')
  assert.equal(screen.handlePointer(pointerEvent('click', hintRow, { localX: segmentX + 2 })), true)
  assert.deepEqual(interrupts, ['a-9'], 'the click runs commands.query.subagentInterrupt')
})

test('detail: a settled subagent has no interrupt target; the wheel scrolls the body', () => {
  const interrupts: string[] = []
  const settled = { ...detailFixture(), status: 'completed' as const, completedAt: T0 + 60_000 }
  const screen = new SubagentDetailScreen(makeCommands(interrupts), { onBack: () => {} }, settled)
  let lines = stripped(screen)
  assert.ok(!lines.some(line => line.includes('X interrupt')), 'no interrupt hint once settled')

  // Switch to the output page (tab click), then wheel-scroll the body.
  const tabsRow = lines.findIndex(line => line.includes('Summary') && line.includes('Output'))
  screen.handlePointer(pointerEvent('click', tabsRow, { localX: lines[tabsRow]!.indexOf('Output') + 1 }))
  lines = stripped(screen)
  const bodyRow = lines.findIndex(line => line.includes('line-0'))
  assert.notEqual(bodyRow, -1, 'the output starts at the top')

  assert.equal(screen.handlePointer(pointerEvent('wheel', bodyRow, { deltaY: 1 })), true)
  lines = stripped(screen)
  assert.ok(!lines.some(line => line.includes('line-0')), 'wheel down scrolled the first lines away')
  assert.ok(lines.some(line => line.includes('line-3')), 'the body advanced by the scroll step')

  assert.equal(screen.handlePointer(pointerEvent('wheel', bodyRow, { deltaY: -1 })), true)
  assert.ok(stripped(screen).some(line => line.includes('line-0')), 'wheel up scrolled back')

  assert.equal(screen.handlePointer(pointerEvent('press', bodyRow)), undefined)
  assert.equal(screen.handlePointer(pointerEvent('release', bodyRow)), undefined)
})
