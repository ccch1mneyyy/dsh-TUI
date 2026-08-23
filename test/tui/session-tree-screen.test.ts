/**
 * SessionTreeScreen interaction tests (src/tui/screens/session-tree.ts): the
 * loading/rewinding seats, cursor + search + filter keyboard state machine,
 * the rewind/fork confirm seats, branch adopt (ctrl+b), and the close
 * semantics of null/undefined tree loads. Bare node:test runner with a fake
 * command sink; the tree fixture is built by the REAL sessionTree model.
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionTreeScreen } from '../../src/tui/screens/session-tree.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import { stripTerminalSequences } from '../../src/tui/public.js'
import { t } from '../../src/i18n.js'
import {
  buildSessionTree,
  type FamilySession,
  type SessionTreeData,
} from '../../src/dsh-adapter/sessionTree.js'

// ---------------------------------------------------------------------------
// Synthetic log builders — seq === array index, like the real contiguous log.
// ---------------------------------------------------------------------------

let clock = 0
function ev(type: string, data: unknown): SessionEvent {
  return { type, seq: -1, time: ++clock, data } as unknown as SessionEvent
}

function reseq(events: SessionEvent[]): SessionEvent[] {
  events.forEach((event, index) => {
    ;(event as { seq: number }).seq = index
  })
  return events
}

function userText(text: string): SessionEvent {
  return ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function assistantText(turn: number, step: number, text: string): SessionEvent {
  return ev('assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

function turnStart(turn: number): SessionEvent {
  return ev('turn/start', { turn })
}

function turnEnd(turn: number): SessionEvent {
  return ev('turn/end', { turn, reason: { kind: 'completed' } })
}

function stepEnd(turn: number, step: number): SessionEvent {
  return ev('step/end', { turn, step })
}

/** A two-turn log (14 events): turn 0 'first prompt', turn 1 'second prompt'. */
function twoTurnLog(): SessionEvent[] {
  return reseq([
    turnStart(0), // 0
    userText('first prompt'), // 1
    assistantText(0, 0, 'first reply'), // 2
    stepEnd(0, 0), // 3
    turnEnd(0), // 4
    turnStart(1), // 5
    userText('second prompt'), // 6
    assistantText(1, 0, 'step0 text'), // 7
    stepEnd(1, 0), // 8
    assistantText(1, 1, 'step1 text'), // 9
    stepEnd(1, 1), // 10
    turnEnd(1), // 11 — 12 events
  ])
}

function family(partial: Partial<FamilySession> & { id: string }): FamilySession {
  return { createdAt: 0, events: [], live: false, tailComplete: true, ...partial }
}

/**
 * Live session 'live' (two turns) with a dead 'branch' forked off turn 0
 * (seedLength 5) adding its own turn. The branch's tipBoundary is its last
 * turn/end (seq 9 of its log).
 */
function treeFixture(): SessionTreeData {
  const liveLog = twoTurnLog()
  const branchLog = reseq([
    ...liveLog.slice(0, 5),
    turnStart(1), // 5
    userText('branch prompt'), // 6
    assistantText(1, 0, 'branch reply'), // 7
    stepEnd(1, 0), // 8
    turnEnd(1), // 9
  ])
  return buildSessionTree(
    [
      family({ id: 'live', events: liveLog, createdAt: 1, live: true }),
      family({ id: 'branch', events: branchLog, createdAt: 2, parentSession: 'live', seedLength: 5 }),
    ],
    'live',
  )
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RewindCall {
  sessionId: string
  seq: number
  mode: 'rewind' | 'fork' | undefined
}

interface Harness {
  screen: SessionTreeScreen
  calls: {
    rewind: RewindCall[]
    notifications: Array<{ text: string; color?: string }>
    restored: string[]
  }
  closed: () => boolean
  rendered: () => string
  focusedLine: () => string
}

function makeHarness(options: {
  mode?: 'rewind' | 'fork'
  tree?: SessionTreeData | null | undefined
  rewindResult?: string | null
} = {}): Harness {
  const calls: Harness['calls'] = { rewind: [], notifications: [], restored: [] }
  let closed = false
  const commands = {
    query: {
      getSessionTree: async () => options.tree === undefined ? null : options.tree,
    },
    session: {
      rewindToNode: async (sessionId: string, seq: number, mode?: 'rewind' | 'fork') => {
        calls.rewind.push({ sessionId, seq, mode })
        return options.rewindResult === undefined ? '' : options.rewindResult
      },
    },
    info: {
      notify: (text: string, notifyOptions?: { color?: string }) => {
        calls.notifications.push({ text, ...(notifyOptions?.color === undefined ? {} : { color: notifyOptions.color }) })
        return () => {}
      },
    },
  } as unknown as TuiCommands
  const screen = new SessionTreeScreen({
    commands,
    mode: options.mode ?? 'rewind',
    currentSessionId: 'live',
    onClose: () => {
      closed = true
    },
    onRestoreText: (text) => {
      calls.restored.push(text)
    },
  })
  return {
    screen,
    calls,
    closed: () => closed,
    rendered: () => stripTerminalSequences(screen.render(100).join('\n')),
    focusedLine: () =>
      stripTerminalSequences(screen.render(100).join('\n'))
        .split('\n')
        .find(line => line.startsWith('❯')) ?? '',
  }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_O = '\x0f'
const CTRL_B = '\x02'

/** Move the cursor until the focused row shows `text` (wraps at most once). */
function focusRow(harness: Harness, text: string, steps = 20): void {
  for (let i = 0; i < steps; i++) {
    if (harness.focusedLine().includes(text)) return
    harness.screen.handleInput(DOWN)
  }
  assert.fail(`no row with "${text}" ever took the cursor`)
}

test('the loading seat swallows keys except Esc, which closes', async () => {
  const harness = makeHarness({ tree: null })
  // Never resolve: keep the load pending by NOT calling load's continuation —
  // simply check the seat before the microtask flush.
  harness.screen.load()
  assert.ok(harness.rendered().includes(t('tree-loading')))
  harness.screen.handleInput('a')
  harness.screen.handleInput(ENTER)
  assert.ok(harness.rendered().includes(t('tree-loading')), 'letters and Enter do nothing while loading')
  harness.screen.handleInput(ESC)
  assert.equal(harness.closed(), true)
  await tick()
})

test('a null tree (unavailable) closes the panel; real data lands the cursor on the live tip', async () => {
  const unavailable = makeHarness({ tree: null })
  unavailable.screen.load()
  await tick()
  assert.equal(unavailable.closed(), true, 'buildSessionTree already notified the reason')

  const harness = makeHarness({ tree: treeFixture() })
  harness.screen.load()
  await tick()
  assert.equal(harness.closed(), false)
  const out = harness.rendered()
  assert.ok(out.includes(t('tree-title')))
  assert.ok(out.includes(t('tree-filter-default')))
  assert.ok(harness.focusedLine().includes('step1 text'), 'the initial cursor is the live leaf')
  harness.screen.handleInput(ESC)
  assert.equal(harness.closed(), true)
})

test('search narrows the list; Esc clears the query before closing', async () => {
  const harness = makeHarness({ tree: treeFixture() })
  harness.screen.load()
  await tick()

  harness.screen.handleInput('b')
  harness.screen.handleInput('r')
  harness.screen.handleInput('a')
  // 'bra' matches only the branch rows.
  const out = harness.rendered()
  assert.ok(out.includes(t('tree-search', { query: 'bra' })))
  assert.ok(out.includes('branch prompt'))
  assert.ok(!out.includes('first reply'), 'non-matching rows are filtered out')

  harness.screen.handleInput(ESC)
  assert.equal(harness.closed(), false, 'the first Esc clears the query')
  assert.ok(!harness.rendered().includes('branch prompt') || harness.rendered().includes('first reply'))
  harness.screen.handleInput(ESC)
  assert.equal(harness.closed(), true, 'the second Esc closes')
})

test('ctrl+o cycles the kind filter', async () => {
  const harness = makeHarness({ tree: treeFixture() })
  harness.screen.load()
  await tick()
  assert.ok(harness.rendered().includes(t('tree-filter-default')))
  harness.screen.handleInput(CTRL_O)
  assert.ok(harness.rendered().includes(t('tree-filter-no-tools')))
  harness.screen.handleInput(CTRL_O)
  assert.ok(harness.rendered().includes(t('tree-filter-user-only')))
  harness.screen.handleInput(CTRL_O)
  assert.ok(harness.rendered().includes(t('tree-filter-all')))
  harness.screen.handleInput(CTRL_O)
  assert.ok(harness.rendered().includes(t('tree-filter-default')))
})

test('Enter on a turn-0 user entry refuses on screen instead of confirming', async () => {
  const harness = makeHarness({ tree: treeFixture() })
  harness.screen.load()
  await tick()
  focusRow(harness, 'first prompt')
  harness.screen.handleInput(ENTER)
  assert.ok(harness.rendered().includes(t('tree-first-message')))
  assert.ok(!harness.rendered().includes(t('tree-confirm-title')), 'no confirm seat for an unrewindable entry')
  assert.equal(harness.calls.rewind.length, 0)
})

test('Enter confirms, Esc backs out, Enter executes the rewind and restores the prompt', async () => {
  const harness = makeHarness({ tree: treeFixture(), rewindResult: 'second prompt' })
  harness.screen.load()
  await tick()
  focusRow(harness, 'second prompt')

  harness.screen.handleInput(ENTER)
  const confirm = harness.rendered()
  assert.ok(confirm.includes(t('tree-confirm-title')))
  assert.ok(confirm.includes(t('tree-confirm-drop-turn')), 'a user pick spells out the drop-turn boundary')
  assert.ok(confirm.includes('second prompt'))

  // Esc backs out to the list without executing.
  harness.screen.handleInput(ESC)
  assert.ok(!harness.rendered().includes(t('tree-confirm-title')))
  assert.equal(harness.calls.rewind.length, 0)

  harness.screen.handleInput(ENTER)
  harness.screen.handleInput(ENTER)
  await tick()
  await tick()
  assert.deepEqual(harness.calls.rewind, [{ sessionId: 'live', seq: 6, mode: 'rewind' }])
  assert.deepEqual(harness.calls.restored, ['second prompt'])
  assert.ok(harness.calls.notifications.some(n => n.text === t('tree-rewound')))
  assert.equal(harness.closed(), true, 'the panel closes once the swap settles')
})

test('fork mode keeps the picked entry (confirm copy + fork call + forked toast)', async () => {
  const harness = makeHarness({ mode: 'fork', tree: treeFixture(), rewindResult: '' })
  harness.screen.load()
  await tick()

  // The turn-0 refusal is rewind-only: fork keeps the message.
  focusRow(harness, 'first prompt')
  harness.screen.handleInput(ENTER)
  assert.ok(harness.rendered().includes(t('tree-fork-title')), 'turn-0 user entries confirm in fork mode')
  harness.screen.handleInput(ESC)

  focusRow(harness, 'second prompt')
  harness.screen.handleInput(ENTER)
  const confirm = harness.rendered()
  assert.ok(confirm.includes(t('tree-fork-title')))
  assert.ok(confirm.includes(t('tree-fork-keep-message')))
  harness.screen.handleInput(ENTER)
  await tick()
  await tick()
  assert.deepEqual(harness.calls.rewind, [{ sessionId: 'live', seq: 6, mode: 'fork' }])
  assert.deepEqual(harness.calls.restored, [], 'fork never restores prompt text')
  assert.ok(harness.calls.notifications.some(n => n.text === t('tree-forked')))
  assert.equal(harness.closed(), true)
})

test('ctrl+b adopts a dead branch at its tip; the live branch refuses', async () => {
  const harness = makeHarness({ tree: treeFixture() })
  harness.screen.load()
  await tick()

  // Live row: already on this branch.
  harness.screen.handleInput(CTRL_B)
  assert.ok(harness.rendered().includes(t('tree-adopt-live')))
  assert.equal(harness.calls.rewind.length, 0)

  focusRow(harness, 'branch prompt')
  harness.screen.handleInput(CTRL_B)
  const confirm = harness.rendered()
  assert.ok(confirm.includes(t('tree-adopt-title')))
  assert.ok(confirm.includes(t('tree-adopt-body')))
  harness.screen.handleInput(ENTER)
  await tick()
  await tick()
  // The adopt target is the branch tip's turn/end (seq 9), run as a rewind.
  assert.deepEqual(harness.calls.rewind, [{ sessionId: 'branch', seq: 9, mode: 'rewind' }])
  assert.ok(harness.calls.notifications.some(n => n.text === t('tree-adopted')))
  assert.equal(harness.closed(), true)
})

test('a refused rewind (null) closes without restoring text or a success toast', async () => {
  const harness = makeHarness({ tree: treeFixture(), rewindResult: null })
  harness.screen.load()
  await tick()
  focusRow(harness, 'second prompt')
  harness.screen.handleInput(ENTER)
  harness.screen.handleInput(ENTER)
  await tick()
  await tick()
  assert.equal(harness.calls.rewind.length, 1)
  assert.deepEqual(harness.calls.restored, [])
  assert.ok(!harness.calls.notifications.some(n => n.text === t('tree-rewound')))
  assert.equal(harness.closed(), true)
})

test('ctrl+f toggles the rewind/fork intent in-panel (title + Enter action follow)', async () => {
  const harness = makeHarness({ tree: treeFixture(), rewindResult: '' })
  harness.screen.load()
  await tick()
  assert.ok(!harness.rendered().includes(t('tree-mode-fork')), 'opens in rewind intent')

  harness.screen.handleInput('\x06') // ctrl+f
  assert.ok(harness.rendered().includes(t('tree-mode-fork')), 'the title line marks fork mode')

  // The rewind-only turn-0 refusal no longer applies: fork keeps the entry.
  focusRow(harness, 'first prompt')
  harness.screen.handleInput(ENTER)
  const confirm = harness.rendered()
  assert.ok(confirm.includes(t('tree-fork-title')))
  assert.ok(confirm.includes(t('tree-fork-keep-message')))
  harness.screen.handleInput(ENTER)
  await tick()
  await tick()
  assert.deepEqual(harness.calls.rewind, [{ sessionId: 'live', seq: 1, mode: 'fork' }])
  assert.ok(harness.calls.notifications.some(n => n.text === t('tree-forked')))
  assert.equal(harness.closed(), true)
})
