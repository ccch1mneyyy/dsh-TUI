/**
 * M4a timeline wiring tests (docs/pi-tui-ui-rewrite-research.md §3.3/§3.4):
 * the transcript's per-row geometry recording and the ChatScreen snapshot /
 * unseen data path built on it. The rail/header/pill VIEWS are M4b — this
 * file pins the data layer only:
 *
 * - TranscriptView.renderRows records exact { rowId, kind, startRow, height,
 *   preview, folded } per ChatRow: user-turn startRow is the prompt TEXT top
 *   (margin counted), channel-folded and window-excluded user rows are
 *   folded turns;
 * - the chat screen's timeline tick puts the header height and the
 *   transcript geometry into ONE ScrollView content coordinate system and
 *   runs the renderer-neutral model over the real scroll metrics
 *   (scrollTop / viewportHeight / contentHeight − viewport);
 * - the unseen anchor is a stable channel row id, the count decrements as
 *   row tops enter the viewport, and returning to the bottom clears it;
 * - inline mode exposes no timeline state; a session-epoch change resets
 *   geometry and anchor.
 *
 * Scroll state is driven straight through ScrollView.updateLayout/scrollTo
 * (the same seam the layout pass uses); ticks are fired by pushing a view
 * model through the fake controller. Bare Node test runner
 * (`node --import tsx/esm --test`).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripTerminalSequences, type TUI } from '../../src/tui/public.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import { HeaderView } from '../../src/tui/components/header.js'
import {
  TranscriptView,
  type TranscriptRowGeometry,
} from '../../src/tui/components/transcript.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { ChatRow } from '../../src/dsh-adapter/channel.js'
import { setLang } from '../../src/i18n.js'

setLang('en')

const WIDTH = 80

function userRow(id: number, text: string, folded = false): ChatRow {
  return { id, kind: 'user', text, ...(folded ? { folded: true } : {}) } as ChatRow
}

function assistantRow(id: number, text: string): ChatRow {
  return { id, kind: 'assistant', text } as ChatRow
}

function projection(rows: readonly ChatRow[], revision = 1, sessionEpoch = 0) {
  return { meta: { revision, sessionEpoch, generation: 0 }, rows } as never
}

/** Render the rows in a standalone view and return its recorded geometry —
 *  the reference measurement the chat-screen wiring must match. */
function measure(
  rows: readonly ChatRow[],
  width = WIDTH,
): { height: number; geometry: readonly TranscriptRowGeometry[] } {
  const view = new TranscriptView()
  view.update(projection(rows))
  const height = view.render(width).length
  return { height, geometry: view.rowGeometry }
}

function stripped(view: TranscriptView, width = WIDTH): string[] {
  return view.render(width).map(line => stripTerminalSequences(line))
}

// ── TranscriptView geometry recording ────────────────────────────────────

test('geometry: user-turn startRow is the prompt TEXT top (margin counted)', () => {
  const view = new TranscriptView()
  const rows = [
    userRow(1, 'hello'),
    assistantRow(2, 'answer one'),
    userRow(3, 'second question'),
  ]
  view.update(projection(rows))
  const lines = stripped(view)
  const geometry = view.rowGeometry

  assert.equal(geometry.length, 3)
  // First row: no margin — wrapper top IS the text top.
  assert.deepEqual(
    geometry.map(g => [g.rowId, g.kind, g.startRow, g.height, g.folded]),
    [[1, 'user', 0, 1, false], [2, 'assistant', 1, 2, false], [3, 'user', 4, 2, false]],
  )
  // The recorded top is exactly the rendered prompt line, and the line above
  // a margined turn is its blank margin row.
  assert.ok(lines[0]!.includes('hello'))
  assert.equal(lines[3], '', 'the line above the second prompt is its margin')
  assert.ok(lines[4]!.includes('second question'))
  assert.equal(geometry[0]!.preview, 'hello')
  assert.equal(geometry[2]!.preview, 'second question')
})

test('geometry: preview is the first non-empty prompt line, clipped', () => {
  const view = new TranscriptView()
  view.update(projection([
    userRow(1, '\n\n  pick this line  \nsecond line\n'),
    userRow(2, `${'x'.repeat(200)}`),
  ]))
  stripped(view)
  const geometry = view.rowGeometry
  assert.equal(geometry[0]!.preview, 'pick this line')
  assert.equal([...geometry[1]!.preview].length, 120)
  assert.ok(geometry[1]!.preview.endsWith('…'))
})

test('geometry: a channel-folded user row keeps its span but is a folded turn', () => {
  const view = new TranscriptView()
  view.update(projection([
    userRow(1, 'folded prompt preview', true),
    assistantRow(2, 'answer'),
  ]))
  const lines = stripped(view)
  const geometry = view.rowGeometry
  // The load-earlier divider sits above the rows (2 lines), then the folded
  // prompt still renders its preview text — measured, but a folded TURN.
  assert.ok(lines.some(line => line.includes('Load earlier') || line.length > 0))
  assert.equal(geometry[0]!.folded, true)
  assert.equal(geometry[0]!.startRow, 2)
  assert.equal(geometry[0]!.height, 1)
  assert.ok(lines[2]!.includes('folded prompt preview'))
  assert.equal(geometry[1]!.folded, false, 'folded is a user-turn concept')
})

test('geometry: rows beyond MAX_RENDERED_ROWS are window-folded until showAll', () => {
  const view = new TranscriptView()
  const rows: ChatRow[] = []
  for (let id = 0; id < 302; id++) rows.push(userRow(id, `prompt ${id}`))
  view.update(projection(rows))
  stripped(view)
  let geometry = view.rowGeometry

  // hiddenCount = 2: rows 0 and 1 never rendered.
  assert.equal(geometry[0]!.startRow, -1)
  assert.equal(geometry[0]!.height, 0)
  assert.equal(geometry[0]!.folded, true)
  assert.equal(geometry[0]!.preview, 'prompt 0', 'folded turns keep a preview')
  assert.equal(geometry[1]!.folded, true)
  // Row 2 is the first rendered row: the 2-line show-all divider leads, and
  // the first rendered row takes no margin.
  assert.equal(geometry[2]!.startRow, 2)
  assert.equal(geometry[2]!.height, 1)
  assert.equal(geometry[2]!.folded, false)
  assert.equal(geometry[3]!.startRow, 4, 'margin line counted for later turns')

  // Ctrl+E lifts the window fold: the divider vanishes and every row is
  // measured from line 0.
  view.showAll()
  stripped(view)
  geometry = view.rowGeometry
  assert.equal(geometry[0]!.startRow, 0)
  assert.equal(geometry[0]!.folded, false)
  assert.equal(geometry[1]!.startRow, 2)
})

test('geometry: the thinking filter unrenders reasoning rows, never user turns', () => {
  const view = new TranscriptView()
  view.update(projection([
    userRow(1, 'first'),
    { id: 2, kind: 'reasoning', text: 'thinking…' } as ChatRow,
    userRow(3, 'second'),
  ]))
  view.setThinkingVisible(false)
  const lines = stripped(view)
  const geometry = view.rowGeometry

  assert.equal(geometry[1]!.startRow, -1)
  assert.equal(geometry[1]!.folded, false, 'non-user rows are never folded turns')
  // The reasoning row took no space: the second user row's wrapper is line 1,
  // its margin makes the prompt text top line 2.
  assert.equal(geometry[2]!.startRow, 2)
  assert.equal(lines[1], '')
  assert.ok(lines[2]!.includes('second'))
})

// ── ChatScreen wiring ────────────────────────────────────────────────────

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function makeViewModel(
  rows: readonly ChatRow[],
  opts: { minimal?: boolean; epoch?: number; revision?: number } = {},
): ChatViewModel {
  const { minimal = false, epoch = 0, revision = 1 } = opts
  const transcriptMeta = { revision, sessionEpoch: epoch, generation: 0 }
  const mode = { id: 'default', plan: false } as never
  return {
    meta,
    transcript: { meta: transcriptMeta, rows },
    statusLine: {
      meta,
      minimal,
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
      minimal,
      lastUsage: undefined,
    },
    header: {
      meta,
      whale: false,
      model: 'test-model',
      reasoningEffort: undefined,
      displayCwd: '/repo',
      loadedContext: undefined,
    },
    prompt: {
      meta,
      pending: [],
      notifications: [],
      commandList: [],
      reasoningEffort: undefined,
      effortLevels: undefined,
      working: false,
      mode,
    },
    overlays: {
      meta,
      question: null,
      approval: null,
      dialog: null,
      statusEntries: [],
    },
    pluginScene: {
      meta,
      active: undefined,
    },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test-provider',
    scrollGutter: 'timeline',
  }
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

function makeChat(
  fullscreen: boolean,
  rows: readonly ChatRow[] = [],
  opts: { minimal?: boolean; epoch?: number } = {},
): { chat: ChatScreen; controller: FakeController } {
  const controller = new FakeController(makeViewModel(rows, opts))
  const chat = new ChatScreen({
    ui: {
      terminal: { columns: 80, rows: 24 },
      requestRender() {},
    } as unknown as TUI,
    commands: {} as TuiCommands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen,
  })
  return { chat, controller }
}

/** Prime the transcript geometry (the first frame), then lay the scroll
 *  metrics out exactly as the alt-screen layout pass would. */
function prime(chat: ChatScreen, contentHeight: number, viewportHeight: number): void {
  chat.render(WIDTH)
  const scroll = chat.conversationScrollView
  assert.ok(scroll !== undefined)
  scroll.updateLayout(contentHeight, viewportHeight, () => {})
}

/** The six-row fixture's measured geometry (minimal mode, width 80):
 *  u1@0 h1, a1@1 h2, u2@4 h2, a2@5 h2, u3@8 h2, a3@9 h2 — height 11. */
function fixtureRows(): ChatRow[] {
  return [
    userRow(1, 'first question'),
    assistantRow(2, 'answer one'),
    userRow(3, 'second question'),
    assistantRow(4, 'answer two'),
    userRow(5, 'third question'),
    assistantRow(6, 'answer three'),
  ]
}

test('snapshot: turns carry content-space tops and follow the scroll position', () => {
  const rows = fixtureRows()
  const m = measure(rows)
  assert.equal(m.height, 11)
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    // Before the first frame the state is the empty default.
    assert.equal(chat.timelineState!.snapshot.turns.length, 0)
    assert.equal(chat.timelineState!.atBottom, true)

    // Viewport 3 keeps the last turn reachable (top 8 ≤ maxScroll 8).
    prime(chat, m.height, 3)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    const scroll = chat.conversationScrollView!
    // follow=end pinned the viewport at the end: scrollTop = 11 - 3 = 8.
    assert.equal(scroll.scrollTop, 8)

    let state = chat.timelineState!
    assert.equal(state.scrollable, true)
    assert.deepEqual(
      state.snapshot.turns.map(t => [t.id, t.top]),
      [[1, 0], [3, 4], [5, 8]],
      'minimal mode: header offset is 0, turn tops are the measured text tops',
    )
    // Tail boundary: the last turn's top IS maxScroll, so ▼ has no target.
    assert.equal(state.snapshot.activeId, 5)
    assert.equal(state.snapshot.upId, 3)
    assert.equal(state.snapshot.downId, null)

    // Mid turn 2: turn 2 owns the top row and ▲ first aligns its own prompt.
    scroll.scrollTo(5)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    state = chat.timelineState!
    assert.equal(state.atBottom, false)
    assert.equal(state.snapshot.activeId, 3)
    assert.equal(state.snapshot.upId, 3)
    assert.equal(state.snapshot.downId, 5)

    // Back at the very top: the first turn stands in, ▼ names turn 2.
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    state = chat.timelineState!
    assert.equal(state.snapshot.activeId, 1)
    assert.equal(state.snapshot.upId, null)
    assert.equal(state.snapshot.downId, 3)
  } finally {
    chat.dispose()
  }
})

test('snapshot: turn below maxScroll is never a down target', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    const scroll = chat.conversationScrollView!
    chat.render(WIDTH)
    // Viewport 4: maxScroll = 11 - 4 = 7 < the last turn's top (8) — the
    // renderer clamps scrollTop there, so turn 3 could never own the
    // viewport top row and ▼ must not name it (the stuck-▼ bug).
    scroll.updateLayout(11, 4, () => {})
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    let state = chat.timelineState!
    assert.equal(state.snapshot.downId, null)
    assert.equal(state.snapshot.activeId, 3)

    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    state = chat.timelineState!
    // Turn 2 (top 4 ≤ 7) is reachable, turn 3 (top 8) is not.
    assert.equal(state.snapshot.downId, 3)
  } finally {
    chat.dispose()
  }
})

test('snapshot: folded turns stay up targets, never active or down', () => {
  const rows = fixtureRows()
  rows[0] = userRow(1, 'folded away prompt', true)
  // The load-earlier divider (2 lines) now leads the transcript.
  const m = measure(rows)
  assert.equal(m.height, 13)
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, m.height, 3)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    const scroll = chat.conversationScrollView!
    let state = chat.timelineState!
    assert.deepEqual(
      state.snapshot.turns.map(t => [t.id, t.top, t.folded === true]),
      [[1, -1, true], [3, 6, false], [5, 10, false]],
    )

    // From the middle: the folded turn is strictly above the viewport — a
    // legal ▲ candidate — but never active nor ▼.
    scroll.scrollTo(7)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    state = chat.timelineState!
    assert.equal(state.snapshot.activeId, 3)
    assert.equal(state.snapshot.upId, 3)
    assert.equal(state.snapshot.downId, 5)
    assert.notEqual(state.snapshot.activeId, 1)
  } finally {
    chat.dispose()
  }
})

test('snapshot: header height shifts every turn top into content space', () => {
  const rows = fixtureRows()
  const m = measure(rows)
  const ui = { requestRender() {} } as unknown as TUI
  const header = new HeaderView(ui, makeViewModel(rows).header)
  const headerHeight = header.render(WIDTH).length
  header.dispose()
  assert.ok(headerHeight > 0)

  const { chat, controller } = makeChat(true, rows) // minimal=false: header visible
  try {
    // The scroll content is VStack(header, transcript): taller by the header.
    prime(chat, headerHeight + m.height, 4)
    controller.setViewModel(makeViewModel(rows))
    const state = chat.timelineState!
    assert.deepEqual(
      state.snapshot.turns.map(t => t.top),
      m.geometry.filter(g => g.kind === 'user').map(g => g.startRow + headerHeight),
      'every turn top is transcript-local top + header height',
    )
  } finally {
    chat.dispose()
  }
})

test('unseen: anchor on leaving the bottom, count, decrement, clear at bottom', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    const scroll = chat.conversationScrollView!
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    let state = chat.timelineState!
    assert.equal(state.atBottom, true)
    assert.equal(state.unseenAnchor, null)
    assert.equal(state.unseenCount, 0)

    // Leaving the bottom pins the last SEEN row id (the channel row id, not
    // a render index).
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    state = chat.timelineState!
    assert.equal(state.unseenAnchor, 6)
    assert.equal(state.unseenCount, 0)

    // Two new rows arrive: u4's text top is 12 (margin 11), a4's wrapper
    // top 13 — both below the viewport bottom (0 + 4).
    const grown = [...rows, userRow(7, 'fourth question'), assistantRow(8, 'answer four')]
    const gm = measure(grown)
    assert.equal(gm.height, 15)
    assert.equal(gm.geometry[6]!.startRow, 12)
    assert.equal(gm.geometry[7]!.startRow, 13)
    scroll.updateLayout(gm.height, 4, () => {})
    controller.setViewModel(makeViewModel(grown, { minimal: true, revision: 2 }))
    state = chat.timelineState!
    assert.equal(state.unseenAnchor, 6, 'the anchor does not move while away')
    assert.equal(state.unseenCount, 2)

    // Scrolling down reveals u4's top (12 < 9 + 4): the count decrements;
    // a4's top (13) is still below.
    scroll.scrollTo(9)
    controller.setViewModel(makeViewModel(grown, { minimal: true, revision: 2 }))
    state = chat.timelineState!
    assert.equal(state.unseenCount, 1)

    // Back to the bottom: anchor and count clear.
    scroll.scrollToEnd()
    controller.setViewModel(makeViewModel(grown, { minimal: true, revision: 2 }))
    state = chat.timelineState!
    assert.equal(state.atBottom, true)
    assert.equal(state.unseenAnchor, null)
    assert.equal(state.unseenCount, 0)
  } finally {
    chat.dispose()
  }
})

test('change detection: an unchanged tick republishes the same object', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    const vm = makeViewModel(rows, { minimal: true })
    controller.setViewModel(vm)
    const first = chat.timelineState!
    controller.setViewModel(vm)
    assert.equal(chat.timelineState, first, 'same inputs → same published state')

    const scroll = chat.conversationScrollView!
    scroll.scrollTo(5)
    controller.setViewModel(vm)
    const scrolled = chat.timelineState!
    assert.notEqual(scrolled, first, 'a scroll tick publishes a new snapshot')
    assert.equal(scrolled.snapshot.activeId, 3)
  } finally {
    chat.dispose()
  }
})

test('session epoch change resets the geometry and the unseen anchor', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    const scroll = chat.conversationScrollView!
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    assert.equal(chat.timelineState!.unseenAnchor, 6)

    // Session replacement: row ids restart. The new transcript is short, so
    // the follow-end viewport re-pins at the bottom and the anchor clears.
    const fresh: ChatRow[] = [userRow(1, 'new session prompt'), assistantRow(2, 'new answer')]
    const fm = measure(fresh)
    assert.equal(fm.height, 3)
    scroll.updateLayout(fm.height, 4, () => {})
    controller.setViewModel(makeViewModel(fresh, { minimal: true, epoch: 1 }))
    const state = chat.timelineState!
    assert.equal(state.snapshot.turns.length, 1)
    assert.deepEqual(state.snapshot.turns.map(t => [t.id, t.top]), [[1, 0]])
    assert.equal(state.unseenAnchor, null)
    assert.equal(state.unseenCount, 0)
    assert.equal(state.scrollable, false, 'content fits the viewport')
    assert.equal(state.atBottom, true)
  } finally {
    chat.dispose()
  }
})

test('inline mode exposes no timeline state', () => {
  const { chat, controller } = makeChat(false, fixtureRows())
  try {
    chat.render(WIDTH)
    controller.setViewModel(makeViewModel(fixtureRows()))
    assert.equal(chat.conversationScrollView, undefined)
    assert.equal(chat.timelineState, undefined)
  } finally {
    chat.dispose()
  }
})
