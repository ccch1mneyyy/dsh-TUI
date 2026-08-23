/**
 * Session family tree pure-model tests (src/dsh-adapter/sessionTree.ts):
 * rewindTarget/forkTarget boundary semantics, extractEntries extraction
 * choices, buildSessionTree fork stitching, flatten/filter geometry, and the
 * live tail window. Bare node:test runner over synthetic SessionEvent logs —
 * no channel, no persistence.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildSessionTree,
  droppedTurnInfo,
  extractEntries,
  filterTree,
  flattenTree,
  forkTarget,
  liveTailWindow,
  nearestVisibleIndex,
  rewindTarget,
  turnUserText,
  type FamilySession,
} from '../../src/dsh-adapter/sessionTree.js'

// ---------------------------------------------------------------------------
// Synthetic log builders — seq === array index, like the real contiguous log.
// ---------------------------------------------------------------------------

let clock = 0
function ev(type: string, data: unknown): SessionEvent {
  const event = { type, seq: -1, time: ++clock, data } as unknown as SessionEvent
  return event
}

function reseq(events: SessionEvent[]): SessionEvent[] {
  events.forEach((event, index) => {
    ;(event as { seq: number }).seq = index
  })
  return events
}

function userText(text: string): SessionEvent {
  return ev('user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

function assistantText(turn: number, step: number, text: string): SessionEvent {
  return ev('assistant/message', {
    turn,
    step,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

function toolCall(turn: number, step: number, callId: string, name = 'bash'): SessionEvent {
  return ev('tool/call', { turn, step, callId, name, arguments: '{"cmd":"ls"}' })
}

function toolResult(turn: number, step: number, callId: string, error?: { name: string; code: string }): SessionEvent {
  return ev('tool/result', {
    turn,
    step,
    message: { role: 'user', source: { kind: 'tool', callId }, content: [] },
    ...(error === undefined ? {} : { error }),
  })
}

function turnStart(turn: number): SessionEvent {
  return ev('turn/start', { turn })
}

function turnEnd(turn: number, reason: unknown = { kind: 'completed' }): SessionEvent {
  return ev('turn/end', { turn, reason })
}

function stepEnd(turn: number, step: number): SessionEvent {
  return ev('step/end', { turn, step })
}

/** A two-turn log: turn 0 one step, turn 1 two steps. */
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
    toolCall(1, 0, 'c1'), // 8
    toolResult(1, 0, 'c1'), // 9
    stepEnd(1, 0), // 10
    assistantText(1, 1, 'step1 text'), // 11
    stepEnd(1, 1), // 12
    turnEnd(1), // 13
  ])
}

test('rewindTarget: user message drops its whole turn (boundary before turn/start)', () => {
  const log = twoTurnLog()
  // Second prompt (seq 6) → boundary just before turn/start@5.
  assert.deepEqual(rewindTarget(log, 6), { boundary: 4 })
  // The dropped turn's prompt comes back for re-editing.
  assert.equal(turnUserText(log, 6), 'second prompt')
})

test('rewindTarget: turn-0 user message is unrewindable (boundary -1)', () => {
  const log = twoTurnLog()
  assert.deepEqual(rewindTarget(log, 1), { boundary: -1 })
})

test('rewindTarget: assistant entry keeps through its enclosing step (closeTurn set)', () => {
  const log = twoTurnLog()
  // step-0 text of turn 1 (seq 7) → boundary at step/end@10, closing turn 1.
  assert.deepEqual(rewindTarget(log, 7), { boundary: 10, closeTurn: 1 })
  // A kept turn restores no prompt text.
  assert.equal(turnUserText(log, 7), '')
})

test('rewindTarget: tool call mid-turn keeps through its step end', () => {
  const log = twoTurnLog()
  assert.deepEqual(rewindTarget(log, 8), { boundary: 10, closeTurn: 1 })
})

test('rewindTarget: entry past the last step keeps through the turn end (no closeTurn)', () => {
  const log = twoTurnLog()
  // step1 text (seq 11) → step/end@12 follows, so the step cut wins…
  assert.deepEqual(rewindTarget(log, 11), { boundary: 12, closeTurn: 1 })
  // …and the closing turn/end entry itself keeps through itself.
  assert.deepEqual(rewindTarget(log, 13), { boundary: 13 })
})

test('rewindTarget: entry of a still-open turn falls back to dropping the turn without a step ahead', () => {
  const log = reseq([
    turnStart(0),
    userText('only prompt'),
    turnEnd(0),
    turnStart(1),
    userText('open prompt'),
    assistantText(1, 0, 'partial'),
    // no step/end, no turn/end — the turn is open.
  ])
  // The assistant entry has no step/end or turn/end ahead → drop the turn.
  assert.deepEqual(rewindTarget(log, 5), { boundary: 2 })
  assert.equal(turnUserText(log, 5), 'open prompt')
})

test('rewindTarget: between-turns compact checkpoint keeps through its own seq', () => {
  const log = reseq([
    turnStart(0),
    userText('prompt'),
    turnEnd(0),
    ev('user/message', {
      source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'summary' }],
    }),
    turnStart(1),
    userText('next'),
    turnEnd(1),
  ])
  assert.deepEqual(rewindTarget(log, 3), { boundary: 3 })
})

test('forkTarget: user message keeps through itself, closing the turn synthetically', () => {
  const log = twoTurnLog()
  assert.deepEqual(forkTarget(log, 6), { boundary: 6, closeTurn: 1 })
  // Turn-0 user message forks fine (boundary can never go negative).
  assert.deepEqual(forkTarget(log, 1), { boundary: 1, closeTurn: 0 })
})

test('forkTarget: non-user entries match rewindTarget', () => {
  const log = twoTurnLog()
  assert.deepEqual(forkTarget(log, 7), rewindTarget(log, 7))
  assert.deepEqual(forkTarget(log, 8), rewindTarget(log, 8))
  assert.deepEqual(forkTarget(log, 13), rewindTarget(log, 13))
})

test('forkTarget: between-turns compact checkpoint needs no synthetic closer', () => {
  const log = reseq([
    turnStart(0),
    userText('prompt'),
    turnEnd(0),
    ev('user/message', {
      source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'summary' }],
    }),
  ])
  assert.deepEqual(forkTarget(log, 3), { boundary: 3 })
})

test('extractEntries: kinds, tool settle, aborted chunk-only text, firstTurn marking', () => {
  const log = reseq([
    turnStart(0), // 0
    userText('hello there'), // 1
    assistantText(0, 0, 'hi'), // 2
    toolCall(0, 0, 'c1', 'bash'), // 3
    toolResult(0, 0, 'c1', { name: 'Error', code: 'X' }), // 4
    turnEnd(0), // 5
    turnStart(1), // 6
    userText('second'), // 7
    ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'partial answer' } }), // 8
    turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } }), // 9
  ])
  const entries = extractEntries('s1', log)
  assert.deepEqual(
    entries.map(entry => [entry.kind, entry.seq]),
    [
      ['user', 1],
      ['assistant', 2],
      ['tool', 3],
      ['user', 7],
      ['assistant', 8],
      ['interrupt', 9],
    ],
  )
  // Tool result settles the card's status.
  assert.equal(entries[2]!.toolStatus, 'error')
  // Chunk-only assistant text of an aborted turn survives with the marker.
  assert.equal(entries[4]!.label, 'aborted')
  // Only turn-0 entries carry firstTurn (the interrupt of turn 1 does not).
  assert.deepEqual(entries.filter(entry => entry.firstTurn === true).map(entry => entry.seq), [1, 2, 3])
})

test('extractEntries: settled assistant/message supersedes its chunk run', () => {
  const log = reseq([
    turnStart(0),
    userText('q'),
    ev('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'full text' } }),
    assistantText(0, 0, 'full text'),
    stepEnd(0, 0),
    turnEnd(0),
  ])
  const entries = extractEntries('s1', log)
  assert.deepEqual(entries.map(entry => entry.kind), ['user', 'assistant'])
  assert.equal(entries[1]!.seq, 3)
})

test('extractEntries: no firstTurn marking on a head-truncated tail', () => {
  const full = twoTurnLog()
  // A coverage/budget cut that opens mid-log: its first visible turn rewinds
  // fine against the full log, so nothing may carry the refusal marker.
  const tail = full.slice(5)
  const entries = extractEntries('s1', tail)
  assert.ok(entries.length > 0)
  assert.ok(entries.every(entry => entry.firstTurn !== true))
})

/** One family member for buildSessionTree, with defaults. */
function family(partial: Partial<FamilySession> & { id: string }): FamilySession {
  return {
    createdAt: 0,
    events: [],
    live: false,
    tailComplete: true,
    ...partial,
  }
}

test('buildSessionTree: a fork attaches at the inherited boundary; parent tail stays the main branch', () => {
  const parentLog = twoTurnLog()
  // The fork inherits through turn 0 (seedLength 5) and appends its own turn.
  const forkLog = reseq([
    ...parentLog.slice(0, 5),
    turnStart(1),
    userText('forked prompt'),
    assistantText(1, 0, 'forked reply'),
    stepEnd(1, 0),
    turnEnd(1),
  ])
  const data = buildSessionTree(
    [
      family({ id: 'parent', events: parentLog, createdAt: 1 }),
      family({
        id: 'fork',
        events: forkLog,
        createdAt: 2,
        parentSession: 'parent',
        seedLength: 5,
        live: true,
      }),
    ],
    'fork',
  )

  // One root (the parent chain); the fork's own entries hang off the anchor.
  assert.equal(data.roots.length, 1)
  const flat = flattenTree(data.roots, data.activeLeafId)
  const forkEntries = flat.filter(row => row.node.sessionId === 'fork' && row.node.entry !== null)
  // The fork displays only its OWN entries (the inherited prefix dedups; a
  // completed turn/end is never an entry).
  assert.deepEqual(
    forkEntries.map(row => row.node.entry!.seq),
    [6, 7],
  )
  // The fork head's tree-parent is the parent's last displayed ENTRY at
  // seq <= 4 — seq 2 (turn/end@4 is bookkeeping, never an entry).
  const forkHead = forkEntries[0]!
  const parentRow = flat.find(row => row.node.id === forkHead.parentId)
  assert.equal(parentRow?.node.sessionId, 'parent')
  assert.equal(parentRow?.node.entry?.seq, 2)
  // The parent's own turn-1 entries remain as the main branch.
  const parentOwn = flat.filter(row => row.node.sessionId === 'parent' && row.node.entry !== null)
  assert.ok(parentOwn.some(row => row.node.entry!.seq === 6))
  // Active path: the fork's chain plus the parent's inherited prefix (node
  // ids live on entry seqs, so the boundary marker is parent:2).
  assert.equal(data.activeLeafId, forkEntries.at(-1)!.node.id)
  assert.ok(data.activePath.has('parent:2'))
  assert.ok(!data.activePath.has('parent:6'))
})

test('buildSessionTree: a parent loop is cut instead of vanishing the family', () => {
  const log = twoTurnLog()
  const data = buildSessionTree(
    [
      family({ id: 'a', events: log, createdAt: 1, parentSession: 'b', seedLength: 0, live: true }),
      family({ id: 'b', events: log, createdAt: 2, parentSession: 'a', seedLength: 0 }),
    ],
    'a',
  )
  // Both sessions still surface (one edge cut), and the live chain is intact.
  assert.equal(data.sessionCount, 2)
  assert.ok(data.roots.length >= 1)
  assert.ok(data.activeLeafId !== null)
})

test('buildSessionTree + droppedTurnInfo: a single-turn branch warns it loses everything', () => {
  const parentLog = twoTurnLog()
  const branchLog = reseq([
    ...parentLog.slice(0, 5),
    turnStart(1),
    userText('branch prompt'),
    assistantText(1, 0, 'branch reply'),
    stepEnd(1, 0),
    turnEnd(1),
  ])
  const data = buildSessionTree(
    [
      family({ id: 'parent', events: parentLog, createdAt: 1, live: true }),
      family({ id: 'branch', events: branchLog, createdAt: 2, parentSession: 'parent', seedLength: 5 }),
    ],
    'parent',
  )
  const branchUser = { sessionId: 'branch', seq: 6, kind: 'user' as const, text: '', searchText: '', time: 0 }
  const info = droppedTurnInfo(data, branchUser)
  // The dropped turn holds the branch's two own entries (a completed turn/end
  // is not an entry), which IS the whole visible branch.
  assert.equal(info?.droppedEntries, 2)
  assert.equal(info?.coversBranch, true)
  // Non-user picks never warn.
  assert.equal(droppedTurnInfo(data, { ...branchUser, kind: 'assistant' }), undefined)
  // The branch-adopt target is the branch log's last turn/end.
  assert.equal(data.rewindFacts.get('branch')?.tipBoundary, 9)
})

test('filterTree: user-only keeps the active leaf visible and re-hangs children', () => {
  const parentLog = twoTurnLog()
  const data = buildSessionTree([family({ id: 'p', events: parentLog, live: true })], 'p')
  const full = flattenTree(data.roots, data.activeLeafId)
  const visible = filterTree(full, data.activeLeafId, 'user-only', '')
  // Only user entries… plus the active leaf (pi keeps the position visible).
  assert.ok(visible.every(row => row.node.entry?.kind === 'user' || row.node.id === data.activeLeafId))
  assert.ok(visible.length >= 2)
})

test('filterTree: search matches uncapped searchText across kinds', () => {
  const parentLog = twoTurnLog()
  const data = buildSessionTree([family({ id: 'p', events: parentLog, live: true })], 'p')
  const full = flattenTree(data.roots, data.activeLeafId)
  const visible = filterTree(full, data.activeLeafId, 'all', 'bash')
  // The match is the tool card; the active leaf (the last assistant text)
  // always survives filtering so the current position stays visible.
  assert.deepEqual(visible.map(row => row.node.entry?.kind), ['tool', 'assistant'])
})

test('nearestVisibleIndex: walks the parent chain when the target filtered out', () => {
  const parentLog = twoTurnLog()
  const data = buildSessionTree([family({ id: 'p', events: parentLog, live: true })], 'p')
  const full = flattenTree(data.roots, data.activeLeafId)
  const visible = filterTree(full, data.activeLeafId, 'user-only', '')
  // The tool row is hidden; its nearest visible ancestor is the user row.
  const toolRow = full.find(row => row.node.entry?.kind === 'tool')!
  const index = nearestVisibleIndex(visible, full, toolRow.node.id)
  assert.equal(visible[index]!.node.entry?.kind, 'user')
})

test('liveTailWindow: aligns to whole turns and keeps the tail', () => {
  const log = twoTurnLog()
  // Budget smaller than the log: the window opens at turn 1's turn/start.
  const windowed = liveTailWindow(log, 9)
  assert.equal(windowed[0]!.type, 'turn/start')
  assert.equal(windowed[0]!.seq, 5)
  // A budget covering everything returns the log untouched.
  assert.equal(liveTailWindow(log, log.length), log)
  assert.equal(liveTailWindow(log, 0).length, 0)
})

test('liveTailWindow: one oversized last turn retries over the earlier complete turns', () => {
  const giant = Array.from({ length: 50 }, (_, i) =>
    ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', text: `t${i}` } }))
  const log = reseq([
    turnStart(0),
    userText('prompt'),
    assistantText(0, 0, 'reply'),
    stepEnd(0, 0),
    turnEnd(0),
    turnStart(1),
    userText('huge turn'),
    ...giant,
  ])
  const windowed = liveTailWindow(log, 10)
  // The oversized turn spans the whole budget: the window falls back to the
  // earlier complete turn rather than showing a partial unrewindable one.
  assert.ok(windowed.length > 0)
  assert.equal(windowed[0]!.type, 'turn/start')
  assert.equal(windowed[0]!.data.turn, 0)
  // When the oversized turn IS the log's own first turn, the window is empty.
  const onlyGiant = reseq([turnStart(0), userText('huge'), ...giant])
  assert.equal(liveTailWindow(onlyGiant, 10).length, 0)
})
