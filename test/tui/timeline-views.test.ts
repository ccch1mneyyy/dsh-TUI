/**
 * M4b timeline chrome tests (docs/pi-tui-ui-rewrite-research.md §3.3–§3.5):
 * the three fullscreen views and their ChatScreen wiring.
 *
 * - TimelineRailView: eligibility (narrow terminal / <2 turns / unscrollable /
 *   short viewport → []), tick/chevron glyphs, click → onJumpToTurn, blank
 *   rows consume without acting, press fences selection, wheel NEVER
 *   consumed, §1.3 blocked gate consumes everything, hover dwell pops the
 *   preview card (120ms), sweeps never pop, state change clears hover.
 * - ScrollbarGutterView: proportional ██ thumb, click-to-position on the
 *   track, same eligibility/fences, no wheel consumption.
 * - StickyPromptHeaderView: pinned active-turn preview while scrolled up,
 *   gone at the bottom, click → onJumpToTurn, blank-cell veto.
 * - BackToBottomPillView: shown whenever off-bottom, unseen-count label vs
 *   back-to-bottom label, click bounds limited to the painted pill, hover
 *   restyle.
 * - Screen wiring: the fullscreen root is VStack(sticky, HStack(scroll,
 *   gutter), dock(pill, …)); the gutter slot is width-stable across
 *   timeline↔scrollbar and gone in hidden mode; jumpToTurn scrolls measured
 *   turns by content coordinate; folded turns reveal via loadOlder /
 *   showAll and then seek; the hover card is a non-capturing overlay owned
 *   by the screen; the exit replay carries none of the chrome; inline mode
 *   mounts nothing (§3.4.8).
 *
 * Component-level tests drive handlePointer with synthesized events (localY
 * = the row in the last render output). Screen-level tests reuse the M4a
 * harness style: scroll metrics through ScrollView.updateLayout/scrollTo,
 * ticks by pushing a view model through the fake controller. One
 * integration test drives a REAL TuiAltScreen (SGR decode → layout hit
 * chain → gutter slot → rail). Bare Node test runner
 * (`node --import tsx/esm --test`).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import chalk from 'chalk'
import { VirtualTerminal } from '../../packages/pi-tui/test/virtual-terminal.ts'

// The hover-restyle assertions compare painted output; the bare test runner
// is not a TTY, so chalk would otherwise downgrade every style to identity.
chalk.level = 3
import {
  getLayoutNode,
  LAYOUT_NODE,
  ScrollView,
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type OverlayOptions,
  type PointerEvent,
  type PointerEventType,
  type StackLayoutNode,
  type TUI,
} from '../../src/tui/public.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { ChatRow } from '../../src/dsh-adapter/channel.js'
import {
  HOVER_DWELL_MS,
  ScrollbarGutterView,
  TimelineRailView,
  type TimelineHoverCard,
  type TimelineViewInputs,
} from '../../src/tui/components/timeline-rail.js'
import { StickyPromptHeaderView } from '../../src/tui/components/sticky-prompt-header.js'
import { BackToBottomPillView } from '../../src/tui/components/back-to-bottom-pill.js'
import { computeRailGeometry, RAIL_WIDTH, type TimelineTurn } from '../../src/tui/timeline-model.js'
import type { TimelineState } from '../../src/tui/timeline.js'
import { setLang } from '../../src/i18n.js'

setLang('en')

const WIDTH = 80

function pointerEvent(
  type: PointerEventType,
  localY: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    type,
    x: 1,
    y: localY,
    localX: 1,
    localY,
    button: type === 'click' || type === 'press' ? 0 : -1,
    shift: false,
    alt: false,
    ctrl: false,
    deltaX: 0,
    deltaY: type === 'wheel' ? 3 : 0,
    cellIsBlank: false,
    ...overrides,
  }
}

function strip(lines: readonly string[]): string[] {
  return lines.map(line => stripTerminalSequences(line))
}

// ── Component-level fixtures ──────────────────────────────────────────────

const DEFAULT_TURNS: readonly TimelineTurn[] = [
  { id: 1, top: 0, preview: 'first question' },
  { id: 3, top: 4, preview: 'second question' },
  { id: 5, top: 8, preview: 'third question' },
]

function makeState(overrides: Partial<{
  turns: readonly TimelineTurn[]
  activeId: number | null
  upId: number | null
  downId: number | null
  unseenCount: number
  scrollable: boolean
  atBottom: boolean
}> = {}): TimelineState {
  return {
    snapshot: {
      turns: overrides.turns ?? DEFAULT_TURNS,
      activeId: overrides.activeId === undefined ? 3 : overrides.activeId,
      upId: overrides.upId === undefined ? 1 : overrides.upId,
      downId: overrides.downId === undefined ? 5 : overrides.downId,
    },
    unseenAnchor: null,
    unseenCount: overrides.unseenCount ?? 0,
    scrollable: overrides.scrollable ?? true,
    atBottom: overrides.atBottom ?? false,
  }
}

function makeInputs(overrides: Partial<{
  state: TimelineState
  terminalWidth: number
  viewportRows: number
  scrollTop: number
  maxScrollTop: number
}> = {}): TimelineViewInputs {
  return {
    state: overrides.state ?? makeState(),
    terminalWidth: overrides.terminalWidth ?? WIDTH,
    viewportRows: overrides.viewportRows ?? 10,
    scrollTop: overrides.scrollTop ?? 5,
    maxScrollTop: overrides.maxScrollTop ?? 7,
  }
}

// ── TimelineRailView ───────────────────────────────────────────────────────

test('rail: renders ticks and chevrons for the eligible window', () => {
  const view = new TimelineRailView()
  const inputs = makeInputs()
  view.source = () => inputs
  const lines = strip(view.render(RAIL_WIDTH))
  // 3 turns in a 10-row rail: blockTop 2 → ▲@2, ticks@3..5, ▼@6.
  assert.equal(lines.length, 10)
  assert.equal(lines[2], ' ▴')
  assert.equal(lines[3], ' ─')
  assert.equal(lines[4], '━━', 'the active turn owns the heavy tick')
  assert.equal(lines[5], ' ─')
  assert.equal(lines[6], ' ▾')
  assert.equal(lines[0], '')
})

test('rail: eligibility — narrow terminal, few turns, unscrollable, short viewport', () => {
  const view = new TimelineRailView()
  const inputs = makeInputs()
  view.source = () => inputs
  assert.ok(view.render(RAIL_WIDTH).length > 0, 'baseline eligible')

  view.source = () => makeInputs({ terminalWidth: 59 })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'below the 60-column minimum')

  view.source = () => makeInputs({ state: makeState({ turns: DEFAULT_TURNS.slice(0, 1) }) })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'fewer than 2 turns')

  view.source = () => makeInputs({ state: makeState({ scrollable: false }) })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'content fits the viewport')

  view.source = () => makeInputs({ viewportRows: 2 })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'no room for ▲ + tick + ▼')

  view.source = () => undefined
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'no frame yet')
})

test('rail: memo — unchanged inputs replay the identical array', () => {
  const view = new TimelineRailView()
  const inputs = makeInputs()
  view.source = () => inputs
  const first = view.render(RAIL_WIDTH)
  assert.equal(view.render(RAIL_WIDTH), first, 'same inputs → same lines object')
  // A scroll-only change keeps the state identity: still a memo hit.
  view.source = () => ({ ...inputs, scrollTop: 6 })
  assert.equal(view.render(RAIL_WIDTH), first, 'scrollTop is not a rail memo key')
  // A NEW state identity repaints (new object, not a mutation).
  view.source = () => makeInputs({ state: makeState({ activeId: 5 }) })
  const repainted = view.render(RAIL_WIDTH)
  assert.notEqual(repainted, first)
  assert.equal(strip(repainted)[5], '━━')
})

test('rail: tick and chevron clicks report the resolved turn', () => {
  const view = new TimelineRailView()
  const inputs = makeInputs()
  view.source = () => inputs
  const jumped: number[] = []
  view.onJumpToTurn = turn => jumped.push(turn.id)
  view.render(RAIL_WIDTH)

  // Ticks at rows 3/4/5 (turns 1/3/5), ▲@2 targets upId 1, ▼@6 targets downId 5.
  assert.equal(view.handlePointer(pointerEvent('click', 4)), true)
  assert.deepEqual(jumped, [3])
  assert.equal(view.handlePointer(pointerEvent('click', 2)), true)
  assert.equal(view.handlePointer(pointerEvent('click', 6)), true)
  assert.deepEqual(jumped, [3, 1, 5])

  // A blank spacer row is consumed without acting; the wheel falls through.
  assert.equal(view.handlePointer(pointerEvent('click', 0)), true)
  assert.equal(view.handlePointer(pointerEvent('wheel', 4)), undefined)
  assert.equal(view.handlePointer(pointerEvent('press', 4)), true, 'press fences selection')
  assert.equal(jumped.length, 3)
})

test('rail: a disabled chevron (no target) consumes without jumping', () => {
  const view = new TimelineRailView()
  view.source = () => makeInputs({ state: makeState({ activeId: 1, upId: null, downId: 3 }) })
  const jumped: number[] = []
  view.onJumpToTurn = turn => jumped.push(turn.id)
  view.render(RAIL_WIDTH)
  assert.equal(view.handlePointer(pointerEvent('click', 2)), true)
  assert.deepEqual(jumped, [], 'null upId → no navigation')
  assert.equal(view.handlePointer(pointerEvent('click', 6)), true)
  assert.deepEqual(jumped, [3])
})

test('rail: the §1.3 blocked gate consumes every event without acting', () => {
  const view = new TimelineRailView()
  const inputs = makeInputs()
  view.source = () => inputs
  const jumped: number[] = []
  view.onJumpToTurn = turn => jumped.push(turn.id)
  view.isPointerBlocked = () => true
  view.render(RAIL_WIDTH)
  assert.equal(view.handlePointer(pointerEvent('click', 4)), true)
  assert.equal(view.handlePointer(pointerEvent('wheel', 4)), true)
  assert.equal(view.handlePointer(pointerEvent('press', 4)), true)
  assert.deepEqual(jumped, [])
})

test('rail: hover dwell pops the preview card; sweeps and state changes never leave one', async () => {
  const view = new TimelineRailView()
  let inputs = makeInputs()
  view.source = () => inputs
  const cards: (TimelineHoverCard | null)[] = []
  view.onHoverCard = card => cards.push(card)
  view.render(RAIL_WIDTH)

  // A sweep (in and out well under the dwell) never pops.
  view.handlePointer(pointerEvent('move', 3))
  view.handlePointer(pointerEvent('move', 4))
  view.handlePointer(pointerEvent('leave', 0))
  await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
  assert.deepEqual(cards, [], 'a sweep arms nothing')

  // Rest on the turn-3 tick (row 4): the card pops after the dwell with the
  // rail-local row for the screen's overlay placement.
  view.handlePointer(pointerEvent('move', 4))
  await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
  assert.deepEqual(cards.map(card => card === null ? null : [card.turn.id, card.row]), [[3, 4]])

  // Moving to another tick clears the card first…
  view.handlePointer(pointerEvent('move', 5))
  assert.deepEqual(cards.at(-1), null)
  await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
  assert.deepEqual(cards.at(-1)?.turn.id, 5, '…then dwells the new tick')

  // A state change under a stationary pointer clears hover and the card.
  inputs = makeInputs({ state: makeState({ activeId: 1 }) })
  view.render(RAIL_WIDTH)
  assert.deepEqual(cards.at(-1), null)

  // Leaving the rail clears any dwell in flight.
  view.handlePointer(pointerEvent('move', 3))
  view.handlePointer(pointerEvent('leave', 0))
  await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
  assert.equal(cards.at(-1), null, 'no card pops after leave')
  view.dispose()
})

// ── ScrollbarGutterView ────────────────────────────────────────────────────

test('scrollbar gutter: proportional thumb tracks the scroll position', () => {
  const view = new ScrollbarGutterView()
  const inputs = makeInputs() // viewportRows 10, scrollTop 5, maxScrollTop 7 → content 17
  view.source = () => inputs
  const lines = strip(view.render(RAIL_WIDTH))
  assert.equal(lines.length, 10)
  // contentHeight = viewport 10 + maxScroll 7 = 17;
  // thumbHeight = max(min(2,10), min(10, round(10*10/17))) = 6;
  // trackHeight = 4; thumbTop = round(5/7 * 4) = 3 → thumb rows 3..8.
  const thumbRows = lines.flatMap((line, row) => line.includes('██') ? [row] : [])
  assert.deepEqual(thumbRows, [3, 4, 5, 6, 7, 8])

  view.source = () => makeInputs({ scrollTop: 0 })
  let thumb = strip(view.render(RAIL_WIDTH))
  assert.ok(thumb[0]!.includes('██'), 'top of track at scrollTop 0')
  view.source = () => makeInputs({ scrollTop: 7 })
  thumb = strip(view.render(RAIL_WIDTH))
  assert.ok(thumb[9]!.includes('██'), 'bottom of track at maxScrollTop')
})

test('scrollbar gutter: click maps the track row to a scrollTop', () => {
  const view = new ScrollbarGutterView()
  const inputs = makeInputs()
  view.source = () => inputs
  const targets: number[] = []
  view.onScrollTo = top => targets.push(top)
  view.render(RAIL_WIDTH)

  // trackHeight = 10 − 6 = 4.
  assert.equal(view.handlePointer(pointerEvent('click', 0)), true)
  assert.equal(view.handlePointer(pointerEvent('click', 99)), true)
  assert.equal(view.handlePointer(pointerEvent('click', 2)), true)
  assert.deepEqual(targets, [0, 7, Math.round((2 / 4) * 7)])
  assert.equal(view.handlePointer(pointerEvent('wheel', 2)), undefined, 'wheel falls through')
  assert.equal(view.handlePointer(pointerEvent('press', 2)), true, 'press fences selection')
})

test('scrollbar gutter: eligibility and the blocked gate', () => {
  const view = new ScrollbarGutterView()
  view.source = () => makeInputs({ viewportRows: 1 })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'no track room')
  view.source = () => makeInputs({ state: makeState({ scrollable: false }) })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'content fits')
  view.source = () => makeInputs({ terminalWidth: 59 })
  assert.deepEqual(view.render(RAIL_WIDTH), [], 'narrow terminal')

  const inputs = makeInputs()
  view.source = () => inputs
  view.isPointerBlocked = () => true
  view.render(RAIL_WIDTH)
  assert.equal(view.handlePointer(pointerEvent('click', 2)), true, 'blocked: consume, no act')
})

// ── StickyPromptHeaderView ─────────────────────────────────────────────────

test('sticky header: pinned while scrolled up, gone at the bottom', () => {
  const view = new StickyPromptHeaderView()
  const state = makeState({ activeId: 3 })
  view.source = () => ({ state })
  const lines = strip(view.render(WIDTH))
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('❯ second question'), lines[0])

  view.source = () => ({ state: makeState({ atBottom: true }) })
  assert.deepEqual(view.render(WIDTH), [], 'at the bottom the header lifts')

  view.source = () => ({ state: makeState({ activeId: null }) })
  assert.deepEqual(view.render(WIDTH), [], 'no active turn')

  view.source = () => ({ state: makeState({ turns: [{ id: 9, top: 0, preview: '' }], activeId: 9 }) })
  assert.deepEqual(view.render(WIDTH), [], 'empty preview renders nothing')

  view.source = () => undefined
  assert.deepEqual(view.render(WIDTH), [], 'no frame yet')
})

test('sticky header: click jumps to the pinned turn; blank cells never do', () => {
  const view = new StickyPromptHeaderView()
  const state = makeState({ activeId: 3 })
  view.source = () => ({ state })
  const jumped: number[] = []
  view.onJumpToTurn = turn => jumped.push(turn.id)
  view.render(WIDTH)

  assert.equal(view.handlePointer(pointerEvent('click', 0)), true)
  assert.deepEqual(jumped, [3])
  assert.equal(view.handlePointer(pointerEvent('click', 0, { cellIsBlank: true })), undefined)
  assert.equal(view.handlePointer(pointerEvent('press', 0)), undefined, 'press stays selection-only')
  assert.equal(jumped.length, 1)

  // Memo: an unchanged pull replays the identical lines.
  const first = view.render(WIDTH)
  assert.equal(view.render(WIDTH), first)
})

// ── BackToBottomPillView ───────────────────────────────────────────────────

test('pill: off-bottom shows the back-to-bottom label; at the bottom nothing', () => {
  const view = new BackToBottomPillView()
  view.source = () => ({ state: makeState({ atBottom: true }) })
  assert.deepEqual(view.render(WIDTH), [])

  view.source = () => ({ state: makeState() })
  const lines = strip(view.render(WIDTH))
  assert.equal(lines.length, 2)
  assert.equal(lines[0], '', 'the blank row mirrors the source paddingTop=1')
  // paddingX=2 around the painted pill, which itself pads the label by 1.
  assert.equal(lines[1], `  ${' ↓ back to bottom (Enter/End) '}`)
})

test('pill: unseen rows switch the label to the count', () => {
  const view = new BackToBottomPillView()
  view.source = () => ({ state: makeState({ unseenCount: 1 }) })
  assert.ok(strip(view.render(WIDTH))[1]!.includes('↓ 1 new message'))
  view.source = () => ({ state: makeState({ unseenCount: 3 }) })
  assert.ok(strip(view.render(WIDTH))[1]!.includes('↓ 3 new messages'))
})

test('pill: only the painted pill is clickable; hover restyles it', () => {
  const view = new BackToBottomPillView()
  const state = makeState() // one state identity: the memo keys on it
  view.source = () => ({ state })
  let jumps = 0
  view.onJumpToBottom = () => { jumps++ }
  const lines = view.render(WIDTH)
  const pillRight = 2 + visibleWidth(' ↓ back to bottom (Enter/End) ')

  // The blank padding row and the unpainted tail never navigate.
  assert.equal(view.handlePointer(pointerEvent('click', 0, { localX: 4 })), undefined)
  assert.equal(view.handlePointer(pointerEvent('click', 1, { localX: pillRight })), undefined)
  assert.equal(jumps, 0)
  assert.equal(view.handlePointer(pointerEvent('click', 1, { localX: 2 })), true)
  assert.equal(jumps, 1)
  assert.equal(view.handlePointer(pointerEvent('press', 1, { localX: 4 })), undefined, 'press stays selection-only')
  assert.equal(view.handlePointer(pointerEvent('wheel', 1)), undefined, 'wheel falls through')

  // Hover brightens the pill (DECSET 1003 terminals); leave restores it.
  view.handlePointer(pointerEvent('move', 1, { localX: 4 }))
  const hovered = view.render(WIDTH)
  assert.notEqual(hovered[1], lines[1], 'hover repaints the pill')
  view.handlePointer(pointerEvent('leave', 1))
  assert.equal(view.render(WIDTH)[1], lines[1], 'leave restores the default paint')

  // Memo: an unchanged pull replays the identical lines.
  assert.equal(view.render(WIDTH), view.render(WIDTH))
})

// ── Screen-level harness (M4a style) ───────────────────────────────────────

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function userRow(id: number, text: string, folded = false): ChatRow {
  return { id, kind: 'user', text, ...(folded ? { folded: true } : {}) } as ChatRow
}

function assistantRow(id: number, text: string): ChatRow {
  return { id, kind: 'assistant', text } as ChatRow
}

function makeViewModel(
  rows: readonly ChatRow[],
  opts: {
    minimal?: boolean
    epoch?: number
    revision?: number
    scrollGutter?: 'timeline' | 'scrollbar' | 'hidden'
    approval?: unknown
  } = {},
): ChatViewModel {
  const { minimal = false, epoch = 0, revision = 1, scrollGutter = 'timeline', approval = null } = opts
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
      approval: approval as never,
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
    scrollGutter,
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
  opts: Parameters<typeof makeViewModel>[1] & { commands?: TuiCommands; ui?: TUI } = {},
): { chat: ChatScreen; controller: FakeController } {
  const { commands, ui, ...vmOpts } = opts
  const controller = new FakeController(makeViewModel(rows, vmOpts))
  const chat = new ChatScreen({
    ui: ui ?? ({
      terminal: { columns: 80, rows: 24 },
      requestRender() {},
    } as unknown as TUI),
    commands: commands ?? ({} as TuiCommands),
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen,
  })
  return { chat, controller }
}

/** Prime the transcript geometry, then lay the scroll metrics out exactly as
 *  the alt-screen layout pass would. */
function prime(chat: ChatScreen, contentHeight: number, viewportHeight: number): void {
  chat.render(WIDTH)
  const scroll = chat.conversationScrollView
  assert.ok(scroll !== undefined)
  scroll.updateLayout(contentHeight, viewportHeight, () => {})
}

/** The six-row fixture's measured height (minimal mode, width 80): 11. */
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

function rootNode(chat: ChatScreen): StackLayoutNode {
  const node = chat[LAYOUT_NODE]()
  assert.ok(node !== undefined && node.type === 'vstack')
  return node as StackLayoutNode
}

function conversationRowOf(chat: ChatScreen): StackLayoutNode {
  const row = rootNode(chat).entries[1]?.component
  const node = row === undefined ? undefined : getLayoutNode(row)
  assert.ok(node !== undefined && node.type === 'hstack')
  return node as StackLayoutNode
}

function gutterEntryOf(chat: ChatScreen) {
  const entry = conversationRowOf(chat).entries[1]
  assert.ok(entry !== undefined)
  return entry
}

function dockOf(chat: ChatScreen): StackLayoutNode {
  const dock = rootNode(chat).entries[2]?.component
  const node = dock === undefined ? undefined : getLayoutNode(dock)
  assert.ok(node !== undefined && node.type === 'vstack')
  return node as StackLayoutNode
}

const VIEWPORT = { width: 80, height: 24 }

// ── Screen wiring ──────────────────────────────────────────────────────────

test('fullscreen gutter: three modes, width-stable slot, scrollbar policy', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))

    // timeline mode: eligible at 80 columns, gone below 60.
    const entry = gutterEntryOf(chat)
    assert.equal(entry.basis, RAIL_WIDTH)
    assert.equal(entry.visible?.(VIEWPORT), true, 'timeline rail mounts')
    assert.equal(entry.visible?.({ width: 59, height: 24 }), false, 'narrow terminal hides the rail')
    assert.equal(chat.conversationScrollView!.scrollbar, 'hidden', 'the rail replaces the built-in scrollbar')

    // scrollbar mode: same slot, same width, proportional thumb inside.
    controller.setViewModel(makeViewModel(rows, { minimal: true, scrollGutter: 'scrollbar' }))
    const sameEntry = gutterEntryOf(chat)
    assert.equal(sameEntry, entry, 'the slot is a stable delegate across modes')
    assert.equal(sameEntry.visible?.(VIEWPORT), true)
    const thumb = strip(sameEntry.component.render(RAIL_WIDTH))
    assert.ok(thumb.some(line => line.includes('██')), 'the scrollbar thumb renders')
    assert.equal(chat.conversationScrollView!.scrollbar, 'hidden')

    // hidden mode: no slot at all; pi's transient auto-scrollbar returns.
    controller.setViewModel(makeViewModel(rows, { minimal: true, scrollGutter: 'hidden' }))
    assert.equal(gutterEntryOf(chat).visible?.(VIEWPORT), false)
    assert.equal(chat.conversationScrollView!.scrollbar, 'auto')
  } finally {
    chat.dispose()
  }
})

test('fullscreen gutter: eligibility follows scrollability and turn count', () => {
  // Content fits the viewport → not scrollable → no rail.
  const { chat, controller } = makeChat(true, fixtureRows(), { minimal: true })
  try {
    prime(chat, 11, 20)
    controller.setViewModel(makeViewModel(fixtureRows(), { minimal: true }))
    assert.equal(chat.timelineState!.scrollable, false)
    assert.equal(gutterEntryOf(chat).visible?.(VIEWPORT), false)
  } finally {
    chat.dispose()
  }

  // A single turn never mounts the rail even when scrollable.
  const oneTurn: ChatRow[] = [userRow(1, 'only question')]
  for (let id = 2; id <= 30; id++) oneTurn.push(assistantRow(id, `line ${id}`))
  const { chat: chat2, controller: controller2 } = makeChat(true, oneTurn, { minimal: true })
  try {
    chat2.render(WIDTH)
    chat2.conversationScrollView!.updateLayout(60, 4, () => {})
    controller2.setViewModel(makeViewModel(oneTurn, { minimal: true }))
    assert.equal(chat2.timelineState!.scrollable, true)
    assert.equal(chat2.timelineState!.snapshot.turns.length, 1)
    assert.equal(gutterEntryOf(chat2).visible?.(VIEWPORT), false, 'one turn → no rail')
  } finally {
    chat2.dispose()
  }
})

test('sticky header and pill predicates track the scroll position', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    const stickyEntry = rootNode(chat).entries[0]!
    const pillEntry = dockOf(chat).entries[0]!

    // At the bottom both are gone (the ScrollView never shifts under the reader).
    assert.equal(chat.timelineState!.atBottom, true)
    assert.equal(stickyEntry.visible?.(VIEWPORT), false)
    assert.equal(pillEntry.visible?.(VIEWPORT), false)

    // Scrolled up: the header pins the ACTIVE turn's prompt, the pill shows.
    const scroll = chat.conversationScrollView!
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    assert.equal(stickyEntry.visible?.(VIEWPORT), true)
    assert.equal(pillEntry.visible?.(VIEWPORT), true)
    const headerLine = strip(stickyEntry.component.render(WIDTH))
    assert.ok(headerLine[0]!.includes('❯ first question'), headerLine[0])
    assert.ok(strip(pillEntry.component.render(WIDTH))[1]!.includes('back to bottom'))

    // New rows while away: the pill switches to the unseen count.
    const grown = [...rows, userRow(7, 'fourth question'), assistantRow(8, 'answer four')]
    scroll.updateLayout(15, 4, () => {})
    controller.setViewModel(makeViewModel(grown, { minimal: true, revision: 2 }))
    assert.ok(strip(pillEntry.component.render(WIDTH))[1]!.includes('2 new messages'))

    // Predicate pulls never republish an unchanged timeline state.
    const before = chat.timelineState
    stickyEntry.visible?.(VIEWPORT)
    pillEntry.visible?.(VIEWPORT)
    gutterEntryOf(chat).visible?.(VIEWPORT)
    assert.equal(chat.timelineState, before, 'per-frame pulls are signature-gated')
  } finally {
    chat.dispose()
  }
})

test('rail tick click scrolls a measured turn to the viewport top', () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    const scroll = chat.conversationScrollView!
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    const state = chat.timelineState!
    assert.deepEqual(state.snapshot.turns.map(t => [t.id, t.top]), [[1, 0], [3, 4], [5, 8]])

    // Find turn 3's tick row from the same geometry the rail renders with.
    const geo = computeRailGeometry(3, 4, 0, false)!
    const slot = gutterEntryOf(chat).component
    slot.render(RAIL_WIDTH) // build the rail memo
    assert.equal(slot.handlePointer?.(pointerEvent('click', geo.tickTop + 1)), true)
    assert.equal(scroll.scrollTop, 4, 'turn 3 pins its prompt text to the viewport top')

    // The sticky header click routes through the same jump (back to turn 3).
    scroll.scrollTo(6)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    const sticky = rootNode(chat).entries[0]!.component
    sticky.render(WIDTH)
    assert.equal(sticky.handlePointer?.(pointerEvent('click', 0)), true)
    assert.equal(scroll.scrollTop, 4)

    // The pill click returns to the bottom.
    const pill = dockOf(chat).entries[0]!.component
    pill.render(WIDTH)
    assert.equal(pill.handlePointer?.(pointerEvent('click', 1, { localX: 3 })), true)
    assert.equal(scroll.isFollowingEnd, true)
  } finally {
    chat.dispose()
  }
})

test('folded turn tick: channel-folded rows reveal via loadOlder, then seek', async () => {
  const rows = fixtureRows()
  rows[0] = userRow(1, 'folded away prompt', true)
  let loadOlderCalls = 0
  const controller = new FakeController(makeViewModel(rows, { minimal: true }))
  const commands = {
    transcript: {
      loadOlder: async () => {
        loadOlderCalls++
        // The real foldBack restores every folded row and emits synchronously.
        controller.setViewModel(makeViewModel(fixtureRows(), { minimal: true, revision: 2 }))
        return 1
      },
    },
  } as unknown as TuiCommands
  const chat = new ChatScreen({
    ui: { terminal: { columns: 80, rows: 24 }, requestRender() {} } as unknown as TUI,
    commands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen: true,
  })
  try {
    // Folded fixture: divider (2) + 11 lines = 13.
    prime(chat, 13, 4)
    const scroll = chat.conversationScrollView!
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    let state = chat.timelineState!
    assert.deepEqual(state.snapshot.turns.map(t => [t.id, t.top]), [[1, -1], [3, 6], [5, 10]])

    // Turn 1's tick: reveal path — loadOlder, then the seek pins the
    // restored prompt (top 0 after the divider vanishes).
    const geo = computeRailGeometry(3, 4, 0, false)!
    const slot = gutterEntryOf(chat).component
    slot.render(RAIL_WIDTH)
    assert.equal(slot.handlePointer?.(pointerEvent('click', geo.tickTop)), true)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(loadOlderCalls, 1, 'the reveal goes through the fenced sink once')
    assert.equal(scroll.scrollTop, 0, 'the restored turn seeks to its fresh top')

    controller.setViewModel(makeViewModel(fixtureRows(), { minimal: true, revision: 2 }))
    state = chat.timelineState!
    assert.equal(state.snapshot.turns[0]!.top, 0, 'the turn is measured after the reveal')
    assert.equal(state.snapshot.turns[0]!.folded, undefined)
  } finally {
    chat.dispose()
  }
})

test('folded turn tick: window-excluded rows reveal via showAll (no loadOlder)', async () => {
  const rows: ChatRow[] = []
  for (let id = 0; id < 302; id++) rows.push(userRow(id, `prompt ${id}`))
  let loadOlderCalls = 0
  const commands = {
    transcript: {
      loadOlder: async () => {
        loadOlderCalls++
        return 0
      },
    },
  } as unknown as TuiCommands
  const { chat, controller } = makeChat(true, rows, { minimal: true, commands })
  try {
    // Capped render: 2-line divider + 1 + 299*2 = 601 lines.
    prime(chat, 601, 20)
    const scroll = chat.conversationScrollView!
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    let state = chat.timelineState!
    assert.equal(state.snapshot.turns.length, 302)
    assert.equal(state.snapshot.turns[1]!.folded, true, 'row 1 is window-excluded')

    // Turn 1's tick is in the window (active stands at index 0): reveal via
    // showAll — the channel holds nothing folded, so loadOlder never fires.
    const activeIndex = state.snapshot.turns.findIndex(t => t.id === state.snapshot.activeId)
    const geo = computeRailGeometry(302, 20, activeIndex === -1 ? null : activeIndex, false)!
    assert.ok(1 >= geo.windowStart && 1 < geo.windowEnd)
    const slot = gutterEntryOf(chat).component
    slot.render(RAIL_WIDTH)
    assert.equal(slot.handlePointer?.(pointerEvent('click', geo.tickTop + 1)), true)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(loadOlderCalls, 0, 'window exclusion is not a channel fold')
    assert.equal(scroll.scrollTop, 2, 'row 1 seeks to its uncapped top (2×1)')

    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    state = chat.timelineState!
    assert.equal(state.snapshot.turns[1]!.top, 2, 'the turn is measured after showAll')
    assert.equal(state.snapshot.turns[1]!.folded, undefined)
  } finally {
    chat.dispose()
  }
})

test('hover card: the screen mounts a non-capturing overlay and owns its lifecycle', async () => {
  const rows = fixtureRows()
  const overlays: { component: Component; options?: OverlayOptions }[] = []
  const ui = {
    terminal: { columns: 80, rows: 24 },
    requestRender() {},
    showOverlay(component: Component, options?: OverlayOptions) {
      const entry = { component, options }
      overlays.push(entry)
      return {
        hide: () => { const i = overlays.indexOf(entry); if (i >= 0) overlays.splice(i, 1) },
        setHidden() {},
        isHidden: () => false,
        focus() {},
        unfocus() {},
      }
    },
    hasOverlay: () => overlays.length > 0,
  } as unknown as TUI
  const { chat, controller } = makeChat(true, rows, { minimal: true, ui })
  try {
    prime(chat, 11, 4)
    const scroll = chat.conversationScrollView!
    scroll.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))

    const slot = gutterEntryOf(chat).component
    gutterEntryOf(chat).visible?.(VIEWPORT) // seeds the terminal width
    slot.render(RAIL_WIDTH)

    // Dwell on turn 3's tick (row 2 in the 4-row rail window) → the card
    // pops as a NON-capturing overlay carrying that turn's preview.
    slot.handlePointer?.(pointerEvent('move', 2))
    await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
    assert.equal(overlays.length, 1, 'the dwell pops the preview card')
    assert.equal(overlays[0]!.options?.nonCapturing, true)
    assert.equal(typeof overlays[0]!.options?.row, 'number')
    assert.equal(typeof overlays[0]!.options?.col, 'number')
    const cardLines = strip(overlays[0]!.component.render(40))
    assert.ok(cardLines.some(line => line.includes('second question')), cardLines.join('|'))

    // A state change under the card (a scroll tick) clears it.
    scroll.scrollTo(4)
    slot.render(RAIL_WIDTH)
    assert.equal(overlays.length, 0, 'a state change hides the card')

    // Pop again, then a modal opening drops the card immediately (the
    // update() backstop — no pointer event needed).
    slot.handlePointer?.(pointerEvent('move', 2))
    await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
    assert.equal(overlays.length, 1)
    controller.setViewModel(makeViewModel(rows, {
      minimal: true,
      approval: { key: 'gate-1', toolName: 'Bash', reason: 'gate' },
    }))
    assert.equal(overlays.length, 0, 'a modal open drops the card')

    // While the modal owns the keyboard the rail consumes without acting.
    const topBefore = scroll.scrollTop
    assert.equal(slot.handlePointer?.(pointerEvent('click', 2)), true)
    assert.equal(scroll.scrollTop, topBefore, 'blocked: no navigation')
  } finally {
    chat.dispose()
  }
})

test('hover card: a fake ui without an overlay stack is a silent no-op', async () => {
  const rows = fixtureRows()
  const { chat, controller } = makeChat(true, rows, { minimal: true })
  try {
    prime(chat, 11, 4)
    chat.conversationScrollView!.scrollTo(0)
    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    const slot = gutterEntryOf(chat).component
    gutterEntryOf(chat).visible?.(VIEWPORT)
    slot.render(RAIL_WIDTH)
    slot.handlePointer?.(pointerEvent('move', 2))
    // The default fake ui has no showOverlay: nothing pops, nothing throws.
    await new Promise(resolve => setTimeout(resolve, HOVER_DWELL_MS + 40))
  } finally {
    chat.dispose()
  }
})

test('exit replay and inline mode carry none of the M4b chrome', () => {
  const { chat } = makeChat(true, fixtureRows(), { minimal: true })
  try {
    const replay = chat.getTranscriptComponentsForExit()
    assert.ok(!replay.some(component =>
      component instanceof TimelineRailView ||
      component instanceof ScrollbarGutterView ||
      component instanceof StickyPromptHeaderView ||
      component instanceof BackToBottomPillView
    ), 'the exit replay is the transcript chrome only')
  } finally {
    chat.dispose()
  }

  // Inline (§3.4.8 three-no): flat root, no HStack, no chrome components.
  const { chat: inline } = makeChat(false, fixtureRows())
  try {
    const node = rootNode(inline)
    assert.ok(node.entries.every(entry => getLayoutNode(entry.component)?.type !== 'hstack'))
    assert.ok(node.entries.every(entry =>
      !(entry.component instanceof TimelineRailView) &&
      !(entry.component instanceof ScrollbarGutterView) &&
      !(entry.component instanceof StickyPromptHeaderView) &&
      !(entry.component instanceof BackToBottomPillView)
    ))
    assert.equal(inline.conversationScrollView, undefined)
    assert.equal(inline.timelineState, undefined)
  } finally {
    inline.dispose()
  }
})

// ── Real alt-screen dispatch ───────────────────────────────────────────────

/** SGR mouse sequence for a 0-based cell. */
function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`
}

test('fullscreen dispatch: rail click jumps, wheel over the rail scrolls, press fences selection', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const copied: string[] = []
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: async (text) => {
      copied.push(text)
      return true
    },
  })
  const rows: ChatRow[] = []
  for (let id = 1; id <= 40; id++) {
    rows.push(id % 2 === 1 ? userRow(id, `question ${id}`) : assistantRow(id, `answer ${id}`))
  }
  // The screen must share the alt-screen TUI: its requestRender is what the
  // timeline tick's convergence frames schedule onto.
  const { chat, controller } = makeChat(true, rows, { minimal: true, ui: tui as unknown as TUI })
  try {
    tui.setLayoutRoot(chat)
    tui.start()

    const scroll = chat.conversationScrollView!
    assert.ok(scroll !== undefined)

    // The gutter mounts on the converging follow-up frames (the first frame
    // ticks with no transcript geometry yet — see tickTimeline), so wait
    // until the active tick glyph lands on the right edge.
    let painted: string[] = []
    for (let attempt = 0; attempt < 30; attempt++) {
      await terminal.waitForRender()
      painted = terminal.getViewport().map(line => stripTerminalSequences(line))
      if (painted.some(line => line.includes('━━'))) break
    }
    assert.ok(scroll.maxScrollTop > 0, 'the 40-row conversation overflows the viewport')
    assert.ok(painted.some(line => line.includes('━━')), `rail painted: ${JSON.stringify(painted)}`)

    // Click a turn tick near the tail: reachable (top ≤ maxScroll) and
    // always inside the bottom-biased tick window.
    const state = chat.timelineState!
    assert.equal(state.snapshot.turns.length, 20)
    const reachable = state.snapshot.turns.filter(t => t.folded !== true && t.top <= scroll.maxScrollTop)
    const target = reachable[reachable.length - 2]!
    const targetIndex = state.snapshot.turns.indexOf(target)
    const activeIndex = state.snapshot.turns.findIndex(t => t.id === state.snapshot.activeId)
    const geo = computeRailGeometry(
      state.snapshot.turns.length,
      scroll.viewportHeight,
      activeIndex === -1 ? null : activeIndex,
      state.atBottom,
    )!
    assert.ok(targetIndex >= geo.windowStart && targetIndex < geo.windowEnd, 'the target tick is in the window')
    const tickY = geo.tickTop + (targetIndex - geo.windowStart) // conversation row at screen y 0 (sticky hidden at the bottom)
    terminal.sendInput(sgr(0, 78, tickY))
    terminal.sendInput(sgr(0, 78, tickY, true))
    await terminal.waitForRender()
    assert.equal(scroll.scrollTop, target.top, 'the tick click pins the turn to the viewport top')

    // The wheel over the rail falls through to the conversation ScrollView.
    const beforeWheel = scroll.scrollTop
    terminal.sendInput(sgr(64, 78, 10))
    await terminal.waitForRender()
    assert.ok(scroll.scrollTop < beforeWheel, 'the rail never consumes the wheel')

    // A drag STARTING on the rail selects nothing (consumed press = pi's
    // NoSelect equivalent).
    terminal.sendInput(sgr(0, 78, 5))
    terminal.sendInput(sgr(32, 30, 8))
    terminal.sendInput(sgr(0, 30, 8, true))
    await terminal.waitForRender()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(copied.length, 0, 'no selection candidate starts on the rail')

    controller.setViewModel(makeViewModel(rows, { minimal: true }))
    await terminal.waitForRender()
  } finally {
    chat.dispose()
    tui.stop()
  }
})
