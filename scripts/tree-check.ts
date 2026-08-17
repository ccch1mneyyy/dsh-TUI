/**
 * Model checks for src/sessionTree.ts: synthetic session family → structure/
 * flatten/filter/rewind-boundary assertions. Run: npm run tree-check
 */
import {
  buildSessionTree,
  droppedTurnInfo,
  extractEntries,
  filterTree,
  flattenTree,
  liveTailWindow,
  nearestVisibleIndex,
  rewindTarget,
  turnBoundary,
  turnUserText,
  type FamilySession,
} from '../src/dsh-adapter/sessionTree.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

let time = 0
const ev = (type: string, seq: number, data: unknown): SessionEvent =>
  ({ type, seq, time: ++time, data }) as unknown as SessionEvent
const turnStart = (seq: number, turn: number) => ev('turn/start', seq, { turn })
const user = (seq: number, text: string) =>
  ev('user/message', seq, { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/message', seq, { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const chunk = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/chunk', seq, { turn, step, chunk: { type: 'text-delta', text } })
const toolCall = (seq: number, turn: number, step: number, callId: string, name: string, args: string) =>
  ev('tool/call', seq, { turn, step, callId, name, arguments: args })
const toolOk = (seq: number, turn: number, step: number, callId: string) =>
  ev('tool/result', seq, { turn, step, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: 'ok' }] } })
const turnEnd = (seq: number, turn: number, reason: object) => ev('turn/end', seq, { turn, reason })
const stepStart = (seq: number, turn: number, step: number) => ev('step/start', seq, { turn, step })
const stepEnd = (seq: number, turn: number, step: number) => ev('step/end', seq, { turn, step })
const compact = (seq: number, text: string) =>
  ev('user/message', seq, { source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text }] })

// ── Session A: three turns (tool turn, then an aborted streamed turn) ────
const A: SessionEvent[] = [
  turnStart(0, 0),
  user(1, 'first question'),
  assistant(2, 0, 0, 'answer one'),
  turnEnd(3, 0, { kind: 'completed' }),
  turnStart(4, 1),
  user(5, 'second question'),
  toolCall(6, 1, 0, 'c1', 'Bash', '{"command":"ls"}'),
  toolOk(7, 1, 0, 'c1'),
  assistant(8, 1, 1, 'answer two'),
  turnEnd(9, 1, { kind: 'completed' }),
  turnStart(10, 2),
  user(11, 'third question'),
  chunk(12, 2, 0, 'partial ans'),
  chunk(13, 2, 0, 'wer three'),
  turnEnd(14, 2, { kind: 'aborted' }),
]
// ── Session B: fork of A at seedLength 10 (rewound to turn 2's start) ────
const B: SessionEvent[] = [
  ...A.slice(0, 10),
  turnStart(10, 2),
  user(11, 'retry third question'),
  assistant(12, 2, 0, 'answer three retry'),
  turnEnd(13, 2, { kind: 'completed' }),
]
// ── Session C: sibling fork of A at the same seedLength 10 ───────────────
const C: SessionEvent[] = [
  ...A.slice(0, 10),
  turnStart(10, 2),
  user(11, 'sibling attempt'),
  compact(12, 'summary of the conversation so far'),
  turnEnd(13, 2, { kind: 'completed' }),
]
// ── Session D: empty fork at A's tip (no own events) ─────────────────────
const D: SessionEvent[] = [...A]
// ── Session E: orphan (parent deleted) — keeps its full prefix ───────────
const E: SessionEvent[] = [
  turnStart(0, 0),
  user(1, 'inherited question'),
  assistant(2, 0, 0, 'inherited answer'),
  turnEnd(3, 0, { kind: 'completed' }),
  turnStart(4, 1),
  user(5, 'orphan own question'),
  turnEnd(6, 1, { kind: 'completed' }),
]

const family: FamilySession[] = [
  { id: 'sess-a', createdAt: 1, events: A, live: false },
  { id: 'sess-b', createdAt: 2, parentSession: 'sess-a', seedLength: 10, events: B, live: true },
  { id: 'sess-c', createdAt: 3, parentSession: 'sess-a', seedLength: 10, events: C, live: false },
  { id: 'sess-d', createdAt: 4, parentSession: 'sess-a', seedLength: 15, events: D, live: false },
  { id: 'sess-e', createdAt: 5, parentSession: 'sess-missing', seedLength: 4, events: E, live: false },
]

let failures = 0
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) {
    failures++
    console.log(`FAIL ${name}`, detail ?? '')
  } else {
    console.log(`ok   ${name}`)
  }
}

// ── extractEntries ───────────────────────────────────────────────────────
const entriesA = extractEntries('sess-a', A)
check('A kinds', entriesA.map(e => e.kind).join(',') === 'user,assistant,user,tool,assistant,user,assistant,interrupt',
  entriesA.map(e => `${e.kind}@${e.seq}${e.label ? `(${e.label})` : ''}`))
check('A tool ok', entriesA[3]?.toolStatus === 'ok')
check('A aborted text merged', entriesA[6]?.text === 'partial answer three' && entriesA[6]?.label === 'aborted', entriesA[6])
check('A interrupt', entriesA[7]?.kind === 'interrupt')
const entriesC = extractEntries('sess-c', C)
check('C compact entry', entriesC.some(e => e.kind === 'compact' && e.text.startsWith('summary of')))

// ── firstTurn marking (complete log only) ─────────────────────────────────
// Turn 0 of a complete log can never rewind (boundary -1): its entries are
// marked so the panel refuses them before the confirm seat. A truncated tail
// opens mid-log — its first visible turn rewinds fine against the full log,
// so nothing there may be marked.
check('firstTurn marks turn-0 entries',
  entriesA[0]?.firstTurn === true && entriesA[1]?.firstTurn === true,
  entriesA.slice(0, 2).map(e => `${e.kind}@${e.seq}:${e.firstTurn}`))
check('firstTurn stops after turn 0',
  entriesA.slice(2).every(e => e.firstTurn === undefined))
check('firstTurn covers chunk-synthesized + interrupt entries of turn 0', (() => {
  const aborted0: SessionEvent[] = [
    turnStart(0, 0),
    user(1, 'cut off'),
    chunk(2, 0, 0, 'partial'),
    chunk(3, 0, 0, ' text'),
    turnEnd(4, 0, { kind: 'aborted' }),
  ]
  const marked = extractEntries('sess-x', aborted0)
  return marked.length === 3 && marked.every(e => e.firstTurn === true)
})())
const tailEntries = extractEntries('sess-tail', A.slice(4))
check('truncated tail never marks firstTurn',
  tailEntries.length > 0 && tailEntries.every(e => e.firstTurn === undefined))

// ── liveTailWindow (over-budget live session tail) ───────────────────────
// A fits the budget → unchanged. A tail slice opening mid-turn aligns to the
// first whole turn inside the window. A window filled entirely by ONE giant
// first turn (its turn/start@0 cut away) drops to empty: every entry in it
// rewinds to boundary -1, and firstTurn marking cannot see a sliced log.
check('liveTailWindow keeps a fitting log', liveTailWindow(A, A.length) === A)
check('liveTailWindow aligns to the first whole turn', (() => {
  // Budget 8 slices to seq 7..14 — opening mid-turn (turn 2's start is @10).
  const windowed = liveTailWindow(A, 8)
  return windowed.length === 5 && windowed[0]?.type === 'turn/start' && windowed[0]?.seq === 10
})())
check('liveTailWindow keeps a turn-aligned slice as-is', (() => {
  // Budget 5 slices exactly to turn 2's start — nothing to trim.
  const windowed = liveTailWindow(A, 5)
  return windowed.length === 5 && windowed[0]?.seq === 10
})())
check('liveTailWindow empties a single-giant-turn window', (() => {
  // One huge turn 0 (chunk storm), longer than any budget: turn/start@0 then
  // thousands of chunks, no second turn/start inside the window.
  const giant: SessionEvent[] = [
    turnStart(0, 0),
    user(1, 'the only question'),
    ...Array.from({ length: 100 }, (_, i) => chunk(2 + i, 0, 0, `t${i}`)),
    turnEnd(102, 0, { kind: 'aborted' }),
  ]
  const windowed = liveTailWindow(giant, 50)
  return windowed.length === 0
})())
check('liveTailWindow keeps earlier complete turns behind a giant LAST turn', (() => {
  // The reviewer repro (total=200012, budget 200000 → 0 visible): the last
  // turn alone overflows the window, but the complete turns BEFORE it are
  // perfectly good rewind targets and must not be wiped with it.
  const huge: SessionEvent[] = [
    turnStart(0, 0), user(1, 'early question'), assistant(2, 0, 0, 'early answer'), turnEnd(3, 0, { kind: 'completed' }),
    turnStart(4, 1), user(5, 'giant prompt'),
    ...Array.from({ length: 100 }, (_, i) => chunk(6 + i, 1, 0, `t${i}`)),
    turnEnd(106, 1, { kind: 'completed' }),
  ]
  const windowed = liveTailWindow(huge, 50)
  return windowed.length === 4 && windowed[0]?.seq === 0
})())
check('liveTailWindow walks back past consecutive oversized turns', (() => {
  const two: SessionEvent[] = [
    turnStart(0, 0), user(1, 'q0'), turnEnd(2, 0, { kind: 'completed' }),
    turnStart(3, 1), ...Array.from({ length: 60 }, (_, i) => chunk(4 + i, 1, 0, 'x')), turnEnd(64, 1, { kind: 'completed' }),
    turnStart(65, 2), ...Array.from({ length: 60 }, (_, i) => chunk(66 + i, 2, 0, 'y')), turnEnd(126, 2, { kind: 'completed' }),
  ]
  // Window over the full log holds only turn-2 chunks → cut; over [0..64]
  // (65 events > 50) only turn-1 chunks → cut; [0..2] fits whole.
  const windowed = liveTailWindow(two, 50)
  return windowed.length === 3 && windowed[0]?.seq === 0
})())
check('liveTailWindow with zero budget keeps nothing', liveTailWindow(A, 0).length === 0)

// ── turnBoundary / rewindTarget / turnUserText ───────────────────────────
// turnBoundary is the DROP-THE-TURN boundary (fallback for user messages and
// open turns); rewindTarget is the actual rewind mapping — pi semantics on
// DSH's fork constraint: user drops its turn; anything else keeps through its
// enclosing step's step/end (a mid-turn cut — closeTurn asks the channel to
// append a synthetic turn/end), or the closing turn/end when no step/end
// stands between the entry and the turn's end.
check('boundary user in turn', turnBoundary(A, 11) === 9)
check('boundary turn/end entry', turnBoundary(A, 14) === 9)
check('boundary first turn', turnBoundary(A, 1) === -1)
check('boundary tool', turnBoundary(A, 6) === 3)
// rewindTarget: user messages drop their turn …
check('rewind user in turn', rewindTarget(A, 11).boundary === 9)
check('rewind first-turn user', rewindTarget(A, 1).boundary === -1)
// … everything else in a closed turn KEEPS the turn through its turn/end —
// picking an AI answer must leave that answer in history (the old mapping
// dropped the whole turn, eating the prompt above it and sometimes more).
// Session A has no step markers, so these all land on the turn/end itself.
check('rewind assistant keeps the turn', rewindTarget(A, 8).boundary === 9)
check('rewind tool keeps the turn', rewindTarget(A, 6).boundary === 9)
check('rewind turn-0 assistant keeps turn 0', rewindTarget(A, 2).boundary === 3)
check('rewind kept turn needs no synthetic close', rewindTarget(A, 8).closeTurn === undefined)
// A turn/end-derived entry (interrupt/notice) keeps through itself.
check('rewind turn/end entry', rewindTarget(A, 14).boundary === 14)
// An entry of the still-OPEN last turn cannot keep the turn (no turn/end for
// the fork to close at), so it falls back to dropping the turn.
const openTail: SessionEvent[] = [
  turnStart(0, 0), user(1, 'q0'), assistant(2, 0, 0, 'a0'), turnEnd(3, 0, { kind: 'completed' }),
  turnStart(4, 1), user(5, 'q1'), chunk(6, 1, 0, 'streaming'),
]
check('rewind open-turn entry drops the turn', rewindTarget(openTail, 6).boundary === 3)
check('rewind open-turn user drops the turn', rewindTarget(openTail, 5).boundary === 3)
// ── step granularity: a mid-turn entry cuts at its step's step/end ───────
// DSH agentic turns are marathons — one prompt, N steps, thousands of events.
// Keeping the WHOLE turn maps any mid-turn pick to the turn's end, which
// barely changes the visible conversation (the "rewind stays in place" bug).
// The step is the finest SAFE cut: a step closes with every tool call
// answered, so the seed never dangles an open tool_call; the synthetic
// turn/end then closes the turn exactly like a real user interrupt does.
const S: SessionEvent[] = [
  turnStart(0, 0),
  user(1, 'explore this project'),
  stepStart(2, 0, 0),
  toolCall(3, 0, 0, 'c1', 'Bash', '{"command":"ls"}'),
  toolOk(4, 0, 0, 'c1'),
  stepEnd(5, 0, 0),
  stepStart(6, 0, 1),
  assistant(7, 0, 1, 'first findings'),
  stepEnd(8, 0, 1),
  stepStart(9, 0, 2),
  toolCall(10, 0, 2, 'c2', 'Read', '{"path":"a.ts"}'),
  toolOk(11, 0, 2, 'c2'),
  stepEnd(12, 0, 2),
  turnEnd(13, 0, { kind: 'completed' }),
]
check('stepped rewind tool in step 0 cuts at its step/end', (() => {
  const target = rewindTarget(S, 3)
  return target.boundary === 5 && target.closeTurn === 0
})())
check('stepped rewind assistant in step 1 cuts at its step/end', (() => {
  const target = rewindTarget(S, 7)
  return target.boundary === 8 && target.closeTurn === 0
})())
// The LAST step of the turn also cuts at its step/end + synthetic close —
// content-wise equal to keeping the turn, but the fork records the interrupt.
check('stepped rewind last step closes synthetically', (() => {
  const target = rewindTarget(S, 10)
  return target.boundary === 12 && target.closeTurn === 0
})())
// A turn/end pick in a stepped turn still keeps through itself.
check('stepped rewind turn/end entry', (() => {
  const target = rewindTarget(S, 13)
  return target.boundary === 13 && target.closeTurn === undefined
})())
// An OPEN turn with a completed step behind the pick still cuts at that
// step's step/end — the synthetic turn/end closes the orphaned turn exactly
// like a real user interrupt.
const openStepped: SessionEvent[] = [
  turnStart(0, 0),
  user(1, 'q'),
  stepStart(2, 0, 0),
  assistant(3, 0, 0, 'partial'),
  stepEnd(4, 0, 0),
  stepStart(5, 0, 1),
  chunk(6, 0, 1, 'streaming'),
]
check('stepped rewind open turn after a closed step', (() => {
  const target = rewindTarget(openStepped, 3)
  return target.boundary === 4 && target.closeTurn === 0
})())
// … but a pick inside the still-OPEN step (no step/end ahead) falls back to
// dropping the whole turn — a cut inside an open step could leave an
// unanswered tool_call in the seed.
check('stepped rewind open streaming step drops the turn', (() => {
  const target = rewindTarget(openStepped, 6)
  return target.boundary === -1 && target.closeTurn === undefined
})())
// Prompt restore only when the entry's own turn was DROPPED.
check('userText dropped turn', turnUserText(A, 11) === 'third question')
check('userText turn/end entry restores nothing', turnUserText(A, 14) === '')
check('userText kept turn restores nothing', turnUserText(A, 8) === '')
check('userText mid-turn cut restores nothing', turnUserText(S, 3) === '')
check('userText open turn restores the prompt', turnUserText(openTail, 6) === 'q1')
check('userText B', turnUserText(B, 11) === 'retry third question')
// A BETWEEN-turns entry (a compact checkpoint logged outside any turn) has no
// enclosing turn, so there is no prompt to restore: turnBoundary falls back to
// the entry's own seq, and scanning on would cross the NEXT turn/start and
// steal that turn's prompt — prefilling text the fork already contains.
const betweenTurns: SessionEvent[] = [
  turnStart(0, 0),
  user(1, 'q'),
  turnEnd(2, 0, { kind: 'completed' }),
  compact(3, 'checkpoint summary'),
  turnStart(4, 1),
  user(5, 'next prompt'),
  turnEnd(6, 1, { kind: 'completed' }),
]
check('between-turns boundary keeps the checkpoint', turnBoundary(betweenTurns, 3) === 3)
check('between-turns rewind keeps the checkpoint', rewindTarget(betweenTurns, 3).boundary === 3)
check('between-turns entry restores nothing', turnUserText(betweenTurns, 3) === '')
// firstTurn must not leak past turn 0's turn/end: the between-turns compact
// checkpoint has a valid rewind boundary (itself), so marking it firstTurn
// would make the panel refuse a legal rewind as "cannot rewind to the very
// first message".
const betweenEntries = extractEntries('sess-bt', betweenTurns)
check('turn-0 entry keeps firstTurn', betweenEntries.find(e => e.seq === 1)?.firstTurn === true)
check('between-turns compact not firstTurn-marked', (() => {
  const checkpoint = betweenEntries.find(e => e.kind === 'compact' && e.seq === 3)
  return checkpoint !== undefined && checkpoint.firstTurn === undefined
})())
check('later turns stay unmarked', betweenEntries
  .filter(e => e.seq >= 4)
  .every(e => e.firstTurn === undefined))

// ── buildSessionTree ─────────────────────────────────────────────────────
const data = buildSessionTree(family, 'sess-b')
check('roots = A + orphan E', data.roots.length === 2)
check('sessionCount', data.sessionCount === 5)

// A's chain keeps only its own entries; B/C trim the inherited prefix.
const flat = flattenTree(data.roots, data.activeLeafId)
const byId = new Map(flat.map(f => [f.node.id, f]))
const aTailUser = byId.get('sess-a:11')
check('A tail kept (dead branch)', aTailUser?.node.entry?.text === 'third question')
// B's head hangs under A's seq-8 entry (last entry ≤ seedLength-1 = 9).
const bHead = byId.get('sess-b:11')
check('B head trimmed prefix', bHead?.node.entry?.text === 'retry third question')
check('B head parent = A:8', bHead?.parentId === 'sess-a:8', bHead?.parentId)
const cHead = byId.get('sess-c:11')
check('C head parent = A:8', cHead?.parentId === 'sess-a:8', cHead?.parentId)
// Empty fork placeholder at A's tip (last entry ≤ 14 = interrupt @14).
const dHead = byId.get('sess-d:head')
check('D placeholder', dHead?.node.entry === null && dHead.parentId === 'sess-a:14', dHead?.parentId)
// Orphan E is a root and keeps its inherited prefix (untrimmed).
check('E root keeps prefix', byId.get('sess-e:1')?.node.entry?.text === 'inherited question')

// Active path: B's whole chain + A's prefix entries (seq ≤ 9), nothing else.
const pathKinds = [...data.activePath].sort()
check('activePath ids', JSON.stringify(pathKinds) === JSON.stringify([
  'sess-a:1', 'sess-a:2', 'sess-a:5', 'sess-a:6', 'sess-a:8',
  'sess-b:11', 'sess-b:12',
].sort()), pathKinds)
check('activeLeaf = B tip', data.activeLeafId === 'sess-b:12')

// ── walk-up anchor: fork boundary predating the parent's displayed entries ─
// F forks off B at seedLength 4 — inside the prefix B trims away, so B's own
// chain has no entry ≤ 3. The anchor must be found by walking UP to A's
// chain (seq 2), with F attached there as a reachable branch; synthesizing
// a disconnected head on B instead used to orphan F's whole subtree.
const F: SessionEvent[] = [
  ...A.slice(0, 4),
  turnStart(4, 1),
  user(5, 'grandchild question'),
  assistant(6, 1, 0, 'grandchild answer'),
  turnEnd(7, 1, { kind: 'completed' }),
]
const walkData = buildSessionTree([
  { id: 'sess-a', createdAt: 1, events: A, live: false },
  { id: 'sess-b', createdAt: 2, parentSession: 'sess-a', seedLength: 10, events: B, live: true },
  { id: 'sess-f', createdAt: 3, parentSession: 'sess-b', seedLength: 4, events: F, live: false },
], 'sess-b')
const walkFlat = flattenTree(walkData.roots, walkData.activeLeafId)
const walkById = new Map(walkFlat.map(f => [f.node.id, f]))
check('walk-up: F head parent = A:2', walkById.get('sess-f:5')?.parentId === 'sess-a:2', walkById.get('sess-f:5')?.parentId)
check('walk-up: F subtree reachable', walkById.get('sess-f:6')?.node.entry?.text === 'grandchild answer')
check('walk-up: no synthesized head on B', walkById.get('sess-b:head') === undefined)
check('walk-up: B attachment unchanged', walkById.get('sess-b:11')?.parentId === 'sess-a:8')
// Active path with the GRANDCHILD live: F forked inside B's inherited prefix
// (seedLength 4), so the path through A stops at A's entries ≤ 3. Using each
// hop's own seedLength alone would re-widen the boundary to 9 at B→A and
// wrongly mark A:5/A:6/A:8 (B's dead branch) with •.
const walkLiveF = buildSessionTree([
  { id: 'sess-a', createdAt: 1, events: A, live: false },
  { id: 'sess-b', createdAt: 2, parentSession: 'sess-a', seedLength: 10, events: B, live: false },
  { id: 'sess-f', createdAt: 3, parentSession: 'sess-b', seedLength: 4, events: F, live: true },
], 'sess-f')
check('activePath narrows walking up', JSON.stringify([...walkLiveF.activePath].sort()) === JSON.stringify([
  'sess-a:1', 'sess-a:2', 'sess-f:5', 'sess-f:6',
].sort()), [...walkLiveF.activePath])

// ── parent cycles: corrupt headers must not black out the panel ─────────
// A self-referencing header (or A↔B mutual parenting) closes a loop with no
// topmost member: attached under each other, every loop session is skipped
// by root selection and the whole loop — live chain included — vanishes from
// the tree. The builder cuts the edge that closes the loop (input order
// keeps the surviving root deterministic) and the loop renders like any
// other family.
const cycleData = buildSessionTree([
  { id: 'cyc-a', createdAt: 1, parentSession: 'cyc-b', events: A, live: false },
  { id: 'cyc-b', createdAt: 2, parentSession: 'cyc-a', events: B, live: true },
], 'cyc-b')
check('cycle: the loop still produces a root', cycleData.roots.length === 1)
const cycleFlat = flattenTree(cycleData.roots, cycleData.activeLeafId)
check(
  'cycle: both loop sessions stay on the tree',
  cycleFlat.some(f => f.node.sessionId === 'cyc-a') && cycleFlat.some(f => f.node.sessionId === 'cyc-b'),
)
check(
  'cycle: the live chain is still marked',
  cycleData.activeLeafId !== null && cycleData.activePath.has(cycleData.activeLeafId),
)
const selfData = buildSessionTree([
  { id: 'self', createdAt: 1, parentSession: 'self', events: A, live: true },
], 'self')
check('self-parent: the session is its own root', selfData.roots.length === 1)
check('self-parent: its entries render', flattenTree(selfData.roots, selfData.activeLeafId).length > 0)

// ── coverage trim: a dead/truncated parent cannot hide the child's prefix ──
// The inherited seed prefix trims by what the ancestor chain ACTUALLY
// displays, not by the bare seedLength: an unreadable parent shows nothing,
// so the child (self-contained log) keeps its whole prefix; a budget-
// truncated parent covers only up to its last event, so the child keeps the
// uncovered remainder of the prefix instead of it vanishing with the cut.
const P: SessionEvent[] = [
  turnStart(0, 0), user(1, 'p q0'), assistant(2, 0, 0, 'p a0'), turnEnd(3, 0, { kind: 'completed' }),
  turnStart(4, 1), user(5, 'p q1'), assistant(6, 1, 0, 'p a1'), turnEnd(7, 1, { kind: 'completed' }),
  turnStart(8, 2), user(9, 'p q2'), assistant(10, 2, 0, 'p a2'), turnEnd(11, 2, { kind: 'completed' }),
]
// Child forked at seedLength 8 (rewound to turn 2's start): own turn at 8…
const childOfP: SessionEvent[] = [
  ...P.slice(0, 8),
  turnStart(8, 2), user(9, 'c q2'), assistant(10, 2, 0, 'c a2'), turnEnd(11, 2, { kind: 'completed' }),
]
{
  const deadParent = buildSessionTree([
    { id: 'p', createdAt: 1, events: [], live: false, unreadable: true },
    { id: 'c', createdAt: 2, parentSession: 'p', seedLength: 8, events: childOfP, live: true },
  ], 'c')
  const deadById = new Map(flattenTree(deadParent.roots, deadParent.activeLeafId).map(f => [f.node.id, f]))
  check('unreadable parent: child keeps its inherited prefix',
    deadById.get('c:1')?.node.entry?.text === 'p q0' && deadById.get('c:5')?.node.entry?.text === 'p q1')
  check('unreadable parent: child own entries kept', deadById.get('c:9')?.node.entry?.text === 'c q2')
  check('unreadable parent: child turn-0 entries still firstTurn-marked',
    deadById.get('c:1')?.node.entry?.firstTurn === true)
  check('unreadable parent: child hangs off the parent placeholder',
    deadById.get('c:1')?.parentId === 'p:head', deadById.get('c:1')?.parentId)
}
{
  // Parent truncated mid turn-1 (events 0..5 → covers [0..5]): the child
  // keeps the uncovered prefix remainder (assistant@6) plus its own entries.
  const partialParent = buildSessionTree([
    { id: 'p', createdAt: 1, events: P.slice(0, 6), live: false },
    { id: 'c', createdAt: 2, parentSession: 'p', seedLength: 8, events: childOfP, live: true },
  ], 'c')
  const partById = new Map(flattenTree(partialParent.roots, partialParent.activeLeafId).map(f => [f.node.id, f]))
  check('truncated parent: child keeps the uncovered prefix remainder',
    partById.get('c:6')?.node.entry?.text === 'p a1')
  check('truncated parent: covered prefix stays trimmed', partById.get('c:5') === undefined)
  check('truncated parent: child anchors at the parent tip',
    partById.get('c:6')?.parentId === 'p:5', partById.get('c:6')?.parentId)
}
{
  // Coverage-skipped read (what the channel hands over after dedup): the
  // child's events START at the cutoff (seq 8) — nothing to trim, no
  // firstTurn marking mid-log, anchor still lands on the parent's chain.
  const skipped = buildSessionTree([
    { id: 'p', createdAt: 1, events: P, live: false },
    { id: 'c', createdAt: 2, parentSession: 'p', seedLength: 8, events: childOfP.slice(8), live: true },
  ], 'c')
  const skipById = new Map(flattenTree(skipped.roots, skipped.activeLeafId).map(f => [f.node.id, f]))
  check('skipped read: own entries shown', skipById.get('c:9')?.node.entry?.text === 'c q2')
  check('skipped read: no firstTurn marking mid-log',
    skipById.get('c:9')?.node.entry?.firstTurn === undefined)
  check('skipped read: anchors at the fork point',
    skipById.get('c:9')?.parentId === 'p:6', skipById.get('c:9')?.parentId)
}

// ── flattenTree geometry ─────────────────────────────────────────────────
// Active-first: A's chain 1..8, then B subtree, then A's dead tail (with D
// under its tip), then C; orphan E root last. pi's rules: a branch point's
// children get +1 indent and a connector; the FIRST hop after a branch gets
// one more +1 with a continuing │ gutter; single-child chains stay flat.
const order = flat.map(f => f.node.id)
const idx = (id: string) => order.indexOf(id)
check('order: B before A tail before C', idx('sess-b:11') < idx('sess-a:11') && idx('sess-a:11') < idx('sess-c:11'))
check('order: D under A tail tip, before C', idx('sess-d:head') === idx('sess-a:14') + 1 && idx('sess-d:head') < idx('sess-c:11'))
check('order: orphan E root last', idx('sess-e:1') > idx('sess-d:head'))
// A:8 has 3 children: B (active first), A's own tail, C. D forks at A:14.
const a8 = byId.get('sess-a:8')!
// Tree children stay in insertion order: the main branch (A's own tail)
// first, forks appended by createdAt. flattenTree re-prioritizes active-first.
check('A:8 children main-branch-first', a8.node.children.map(c => c.id).join(',') === 'sess-a:11,sess-b:11,sess-c:11',
  a8.node.children.map(c => c.id))
check('B connector ├─', bHead!.showConnector && !bHead!.isLast)
check('A-tail connector ├─', aTailUser!.showConnector && !aTailUser!.isLast)
check('C connector └─', byId.get('sess-c:11')!.showConnector && byId.get('sess-c:11')!.isLast)
check('D hangs under A:14', dHead!.parentId === 'sess-a:14')
// First hop after a branch: +1 indent with the parent's │ gutter continuing.
check('B tip +1 indent (first hop after branch)', byId.get('sess-b:12')!.indent === bHead!.indent + 1)
check('B tip gutter continues', byId.get('sess-b:12')!.gutters.some(g => g.show === true))
check('C tip gutter closed (last sibling)', byId.get('sess-c:12')!.gutters.every(g => g.show === false),
  byId.get('sess-c:12')!.gutters)
// A's linear prefix: no connectors (the root's connector is suppressed as a
// virtual-root child); every row carries the multipleRoots flag.
check('A linear prefix no connectors', ['sess-a:2', 'sess-a:5', 'sess-a:6', 'sess-a:8'].every(id => !byId.get(id)!.showConnector))
check('multipleRoots stamped', flat.every(f => f.multipleRoots === true))

// ── filterTree ───────────────────────────────────────────────────────────
const userOnly = filterTree(flat, data.activeLeafId, 'user-only', '')
check('user-only keeps users + active leaf',
  userOnly.every(f => f.node.entry === null || f.node.entry.kind === 'user' || f.node.id === data.activeLeafId))
// Rehang: B's user lands under A:5 (nearest visible ancestor), one level in
// with a connector (A:5 also has A:11 and C:11 as visible children).
const uoB = userOnly.find(f => f.node.id === 'sess-b:11')!
const uoA5 = userOnly.find(f => f.node.id === 'sess-a:5')!
check('user-only rehangs B under A:5', uoB.indent === uoA5.indent + 1 && uoB.showConnector,
  { indent: uoB.indent, a5: uoA5.indent, connector: uoB.showConnector })
check('user-only still multi-root (E survives)', userOnly.every(f => f.multipleRoots === true))
const noTools = filterTree(flat, data.activeLeafId, 'no-tools', '')
check('no-tools drops tool+notice, keeps interrupt',
  !noTools.some(f => f.node.entry?.kind === 'tool' || f.node.entry?.kind === 'notice') &&
  noTools.some(f => f.node.entry?.kind === 'interrupt'))
const search = filterTree(flat, data.activeLeafId, 'all', 'retry third')
check('search AND tokens', search.some(f => f.node.id === 'sess-b:11') && !search.some(f => f.node.id === 'sess-a:1'))
check('search keeps active leaf', search.some(f => f.node.id === data.activeLeafId))
check('search stamps single root', search.every(f => f.multipleRoots === false))
const all = filterTree(flat, data.activeLeafId, 'all', '')
check('all keeps placeholder', all.some(f => f.node.entry === null))
const def = filterTree(flat, data.activeLeafId, 'default', '')
check('default drops placeholder', !def.some(f => f.node.entry === null))
check('default drops notice', !def.some(f => f.node.entry?.kind === 'notice'))

// ── nearestVisibleIndex ──────────────────────────────────────────────────
const target = nearestVisibleIndex(userOnly, flat, 'sess-a:8') // hidden in user-only
check('nearest visible walks to A:5', userOnly[target]?.node.id === 'sess-a:5', userOnly[target]?.node.id)
check('nearest visible exact', userOnly[nearestVisibleIndex(userOnly, flat, 'sess-b:11')]?.node.id === 'sess-b:11')

// ── rewindFacts / droppedTurnInfo / tipBoundary ──────────────────────────
// The confirm-seat UX facts: how much a user-message drop removes from its
// branch, and where a whole-branch adopt lands. tailComplete gates both —
// a budget-sliced tail must never produce a "keep everything" target.
const G: SessionEvent[] = [
  turnStart(0, 0),
  user(1, 'root question'),
  assistant(2, 0, 0, 'root answer'),
  turnEnd(3, 0, { kind: 'completed' }),
  turnStart(4, 1),
  user(5, 'root again'),
  assistant(6, 1, 0, 'root answer two'),
  turnEnd(7, 1, { kind: 'completed' }),
]
// H: fork whose ENTIRE own content is one turn — the user's trap shape.
const H: SessionEvent[] = [
  ...G.slice(0, 4),
  turnStart(4, 1),
  user(5, 'branch only question'),
  assistant(6, 1, 0, 'branch answer'),
  turnEnd(7, 1, { kind: 'completed' }),
]
// I: fork with TWO own turns (dropping one keeps the other).
const I: SessionEvent[] = [
  ...G.slice(0, 4),
  turnStart(4, 1),
  user(5, 'branch q1'),
  assistant(6, 1, 0, 'branch a1'),
  turnEnd(7, 1, { kind: 'completed' }),
  turnStart(8, 2),
  user(9, 'branch q2'),
  assistant(10, 2, 0, 'branch a2'),
  turnEnd(11, 2, { kind: 'completed' }),
]
// J: open tip (crashed/in-flight shape) — tipBoundary is the last CLOSED
// turn/end, never the open tail.
const J: SessionEvent[] = [
  ...G.slice(0, 4),
  turnStart(4, 1),
  user(5, 'branch closed'),
  turnEnd(6, 1, { kind: 'completed' }),
  turnStart(7, 2),
  user(8, 'branch open question'),
  assistant(9, 2, 0, 'partial'),
]
const factsFamily: FamilySession[] = [
  { id: 'sess-g', createdAt: 1, events: G, live: true, tailComplete: true },
  { id: 'sess-h', createdAt: 2, parentSession: 'sess-g', seedLength: 4, events: H, live: false, tailComplete: true },
  { id: 'sess-i', createdAt: 3, parentSession: 'sess-g', seedLength: 4, events: I, live: false, tailComplete: true },
  { id: 'sess-j', createdAt: 4, parentSession: 'sess-g', seedLength: 4, events: J, live: false, tailComplete: true },
  { id: 'sess-k', createdAt: 5, parentSession: 'sess-g', seedLength: 4, events: H.map(e => ({ ...e })), live: false },
]
const factsData = buildSessionTree(factsFamily, 'sess-g')
const entryOf = (sid: string, seq: number) =>
  extractEntries(sid, factsFamily.find(s => s.id === sid)!.events).find(e => e.seq === seq)!
// G: two own turns, four own entries — dropping turn 0's user keeps turn 1.
const dropG = droppedTurnInfo(factsData, entryOf('sess-g', 1))
check('drop-turn info counts the turn entries', dropG?.droppedEntries === 2 && dropG.coversBranch === false, dropG)
// H: the single own turn holds both own entries → the drop erases the branch.
const dropH = droppedTurnInfo(factsData, entryOf('sess-h', 5))
check('drop-turn covers single-turn branch', dropH?.droppedEntries === 2 && dropH.coversBranch === true, dropH)
// I: dropping turn 1's user keeps turn 2 → not branch-covering.
const dropI = droppedTurnInfo(factsData, entryOf('sess-i', 5))
check('drop-turn partial branch stays quiet', dropI?.droppedEntries === 2 && dropI.coversBranch === false, dropI)
const dropI2 = droppedTurnInfo(factsData, entryOf('sess-i', 9))
check('drop-turn last of two turns also partial', dropI2?.droppedEntries === 2 && dropI2.coversBranch === false, dropI2)
// K: same shape as H but tail NOT complete — never claim the branch is covered.
const dropK = droppedTurnInfo(factsData, entryOf('sess-k', 5))
check('tail-cut branch never claims coverage', dropK?.droppedEntries === 2 && dropK.coversBranch === false, dropK)
// Non-user entries never drop a turn.
check('assistant entry has no drop info', droppedTurnInfo(factsData, entryOf('sess-g', 2)) === undefined)
// tipBoundary: last closed turn/end when the tail is complete.
check('tipBoundary is last turn/end', factsData.rewindFacts.get('sess-g')?.tipBoundary === 7,
  factsData.rewindFacts.get('sess-g'))
check('tipBoundary on open-tip session is last CLOSED end', factsData.rewindFacts.get('sess-j')?.tipBoundary === 6,
  factsData.rewindFacts.get('sess-j'))
check('tipBoundary withheld when tail cut', factsData.rewindFacts.get('sess-k')?.tipBoundary === undefined)
check('rewindFacts recorded ownEntries', factsData.rewindFacts.get('sess-i')?.ownEntries === 4)
// rewindTarget honors a turn/end pick as keep-through (the adopt boundary).
check('turn/end pick keeps through itself', rewindTarget(G, 7).boundary === 7 && rewindTarget(G, 7).closeTurn === undefined,
  rewindTarget(G, 7))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
