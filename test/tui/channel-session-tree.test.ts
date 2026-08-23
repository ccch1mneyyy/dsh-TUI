/**
 * Channel session-tree tests: rewindToNode (rewind/fork boundary semantics,
 * cross-session forks, refusal paths) and buildSessionTree (family assembly,
 * cwd scoping, live overlay) against the REAL channel with the same fake
 * ctx/agent harness as channel-session-mutation.test.ts.
 *
 * Bare Node test runner (`node --import tsx/esm --test`). Synthetic logs
 * follow the session-tree-model.test.ts convention: seq === array index.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelState } from '../../src/dsh-adapter/channel.js'
import { flattenTree } from '../../src/dsh-adapter/sessionTree.js'

// sessionHistory/*Prefs resolve the data dir at module load — redirect HOME
// (USERPROFILE on Windows) into a throwaway dir BEFORE the channel import so
// no preference/last-used file in the real profile is touched.
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-tui-tree-home-'))
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome
process.env.DSH_TUI_SESSION_ROOT = mkdtempSync(join(tmpdir(), 'dsh-tui-tree-sessions-'))

const { createChannel } = await import('../../src/dsh-adapter/channel.js')

/** Deadlock tripwire: node:test has no per-test timeout, so a queued
 *  mutation that never settles must FAIL instead of hanging the runner. */
function withTimeout<T>(pending: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle — session-mutation queue deadlock?`)), 5000)
    }),
  ]).finally(() => clearTimeout(timer))
}

type Handler = (...args: never[]) => void

function makeCtx(services: Record<string, unknown>): {
  ctx: {
    on(event: string, handler: Handler): () => void
    get(name: string): unknown
    logger: { warn(): void }
  }
  /** Fire a bus event into every subscribed handler (the channel binds
   *  `session/event` here — this is how a test drives working/idle). */
  emit(event: string, ...args: unknown[]): void
} {
  const handlers = new Map<string, Handler[]>()
  return {
    ctx: {
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {
          const index = list.indexOf(handler)
          if (index >= 0) list.splice(index, 1)
        }
      },
      get(name) {
        return services[name]
      },
      logger: { warn() {} },
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
    },
  }
}

interface FakeAgent {
  id: string
  status: string
  options: Record<string, unknown>
  session: {
    id: string
    seq: number
    events: SessionEvent[]
    header: Record<string, unknown>
    append(type: string, data: unknown): void
  }
  ctx: { on(): () => void }
  followup(message: unknown): void
  steer(message: unknown): void
  inbox: { remove(): boolean }
  cancel(): void
  whenIdle(): Promise<void>
}

function makeAgent(id: string, sessionId: string, events: SessionEvent[] = []): FakeAgent {
  const session: FakeAgent['session'] = {
    id: sessionId,
    seq: 0,
    events,
    header: {},
    append(type, data) {
      session.events.push({ type, seq: session.events.length, time: Date.now(), data } as SessionEvent)
    },
  }
  return {
    id,
    status: 'idle',
    options: {},
    session,
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

interface CreateCall {
  sessionId: string
  seed: SessionEvent[]
  meta: Record<string, unknown>
}

/** agents fake: records every create and answers with a fresh agent whose
 *  session id is the requested child id; `disposed` tracks handle disposal. */
function makeAgents(suffix: string): {
  agents: { create(options: CreateCall): Promise<unknown> }
  calls: CreateCall[]
  disposed: string[]
} {
  const calls: CreateCall[] = []
  const disposed: string[] = []
  return {
    calls,
    disposed,
    agents: {
      create: (options: CreateCall) => {
        calls.push(options)
        return Promise.resolve({
          agent: makeAgent(`agent-fork-${suffix}-${calls.length}`, options.sessionId),
          dispose: () => {
            disposed.push(options.sessionId)
            return Promise.resolve()
          },
        })
      },
    },
  }
}

function makeChannel(services: Record<string, unknown>, initial: FakeAgent): ChannelState {
  return makeChannelWithBus(services, initial).channel
}

function makeChannelWithBus(
  services: Record<string, unknown>,
  initial: FakeAgent,
): { channel: ChannelState; emit: (event: string, ...args: unknown[]) => void } {
  const { ctx, emit } = makeCtx(services)
  const channel = createChannel(ctx as never, initial as never, {
    model: 'test-model',
    cwd: '/tmp',
    provider: 'test',
    activity: false,
  })
  // Toast expiry timers (4–8s) would hold the test process open after the
  // assertions finish; shrink them — orthogonal to the mechanism under test.
  const notify = channel.notify.bind(channel)
  channel.notify = (text, options) => notify(text, { ...options, timeoutMs: 1 })
  return { channel, emit }
}

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

function turnStart(turn: number): SessionEvent {
  return ev('turn/start', { turn })
}

function turnEnd(turn: number, reason: unknown = { kind: 'completed' }): SessionEvent {
  return ev('turn/end', { turn, reason })
}

function stepEnd(turn: number, step: number): SessionEvent {
  return ev('step/end', { turn, step })
}

/** A two-turn log: turn 0 one step, turn 1 two steps (14 events). */
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
    turnEnd(1), // 11 — 12 events total; keep the log tight
  ])
}

const userRowTexts = (channel: ChannelState): string[] =>
  channel.rows.filter(row => row.kind === 'user').map(row => row.text)

test('rewindToNode rewind: a user pick drops its turn, forks a child, and restores the prompt', async () => {
  const { agents, calls } = makeAgents('rewind')
  const channel = makeChannel({ agents }, makeAgent('agent-initial', 's-live', twoTurnLog()))
  const epochBefore = channel.sessionEpoch

  const restored = await withTimeout(channel.rewindToNode('s-live', 6), 'rewindToNode')
  assert.equal(restored, 'second prompt', 'the dropped turn’s prompt comes back for re-editing')
  assert.equal(calls.length, 1, 'exactly one fork created')
  const call = calls[0]!
  assert.notEqual(call.sessionId, 's-live')
  assert.equal(call.meta.parentSession, 's-live')
  assert.deepEqual(call.seed.map(event => event.seq), [0, 1, 2, 3, 4], 'seed stops before the dropped turn')
  assert.equal(call.meta.seedLength, 5)
  assert.equal(channel.agentId, 'agent-fork-rewind-1')
  assert.equal(channel.sessionEpoch, epochBefore + 1, 'one epoch bump per committed fork')
  assert.deepEqual(userRowTexts(channel), ['first prompt'], 'the replayed transcript ends before the dropped turn')
})

test('rewindToNode fork: a user pick is KEPT and the open turn closes synthetically', async () => {
  const { agents, calls } = makeAgents('fork')
  const channel = makeChannel({ agents }, makeAgent('agent-initial', 's-live', twoTurnLog()))

  const restored = await withTimeout(channel.rewindToNode('s-live', 6, 'fork'), 'rewindToNode fork')
  assert.equal(restored, '', 'fork mode never restores prompt text')
  assert.equal(calls.length, 1)
  const seed = calls[0]!.seed
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7], 'seed keeps through the picked entry plus a closer')
  const closer = seed[seed.length - 1]!
  assert.equal(closer.type, 'turn/end', 'the mid-turn cut is closed synthetically')
  assert.equal(closer.data.turn, 1)
  assert.deepEqual(closer.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
  assert.deepEqual(userRowTexts(channel), ['first prompt', 'second prompt'], 'the kept entry replays')
})

test('rewindToNode rewind: a non-user pick keeps through its enclosing step', async () => {
  const { agents, calls } = makeAgents('step')
  const channel = makeChannel({ agents }, makeAgent('agent-initial', 's-live', twoTurnLog()))

  const restored = await withTimeout(channel.rewindToNode('s-live', 7), 'rewindToNode step')
  assert.equal(restored, '', 'a kept turn restores no prompt text')
  const seed = calls[0]!.seed
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'seed ends at the step/end')
  const closer = seed[seed.length - 1]!
  assert.equal(closer.type, 'turn/end')
  assert.equal(closer.data.turn, 1, 'the cut turn closes synthetically')
  assert.deepEqual(userRowTexts(channel), ['first prompt', 'second prompt'])
})

test('rewindToNode refuses the first message, the no-op tip, and a missing agents service', async () => {
  const { agents, calls } = makeAgents('refuse')
  const channel = makeChannel({ agents }, makeAgent('agent-initial', 's-live', twoTurnLog()))
  const epochBefore = channel.sessionEpoch

  // Turn 0's user message: boundary -1.
  assert.equal(await withTimeout(channel.rewindToNode('s-live', 1), 'first-message'), null)
  // The last entry: nothing message-bearing follows the boundary.
  assert.equal(await withTimeout(channel.rewindToNode('s-live', 9), 'noop'), null)
  assert.equal(calls.length, 0, 'a refused rewind never reaches agents.create')
  assert.equal(channel.sessionEpoch, epochBefore, 'a refused rewind bumps nothing')
  assert.equal(channel.agentId, 'agent-initial')

  const bare = makeChannel({}, makeAgent('agent-bare', 's-bare', twoTurnLog()))
  assert.equal(await withTimeout(bare.rewindToNode('s-bare', 6), 'no-agents'), null)
})

test('rewindToNode cross-session: the source log loads from persistence and forks under it', async () => {
  const { agents, calls } = makeAgents('cross')
  const deadLog = twoTurnLog()
  const sessionPersistence = {
    load: (id: string) => {
      assert.equal(id, 's-dead')
      return Promise.resolve({ meta: { id: 's-dead', cwd: '/tmp' }, events: deadLog })
    },
  }
  const channel = makeChannel(
    { agents, sessionPersistence },
    makeAgent('agent-initial', 's-live', twoTurnLog()),
  )

  const restored = await withTimeout(channel.rewindToNode('s-dead', 6), 'cross-session rewind')
  assert.equal(restored, 'second prompt')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.meta.parentSession, 's-dead', 'the fork hangs under the SOURCE session')
  assert.deepEqual(calls[0]!.seed.map(event => event.seq), [0, 1, 2, 3, 4])
  assert.equal(channel.agentId, 'agent-fork-cross-1', 'the live session switched to the fork')
})

test('rewindToNode cross-session: fork mode on a dead branch adopts even its tip', async () => {
  const { agents, calls } = makeAgents('adopt')
  const deadLog = twoTurnLog()
  const sessionPersistence = {
    load: () => Promise.resolve({ meta: { id: 's-dead', cwd: '/tmp' }, events: deadLog }),
  }
  const channel = makeChannel({ agents, sessionPersistence }, makeAgent('agent-initial', 's-live', twoTurnLog()))

  // The tip entry of a DEAD session: the live-only no-op guard must not fire.
  const restored = await withTimeout(channel.rewindToNode('s-dead', 9, 'fork'), 'branch adopt')
  assert.equal(restored, '')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.meta.parentSession, 's-dead')
  assert.deepEqual(userRowTexts(channel), ['first prompt', 'second prompt'])
})

test('rewindToNode cross-session: load failure and missing persistence refuse cleanly', async () => {
  const { agents, calls } = makeAgents('loadfail')
  const failing = { load: () => Promise.reject(new Error('corrupt log')) }
  const channel = makeChannel({ agents, sessionPersistence: failing }, makeAgent('agent-initial', 's-live', twoTurnLog()))
  assert.equal(await withTimeout(channel.rewindToNode('s-dead', 6), 'load failure'), null)

  const noPersistence = makeChannel({ agents }, makeAgent('agent-initial', 's-live', twoTurnLog()))
  assert.equal(await withTimeout(noPersistence.rewindToNode('s-dead', 6), 'no persistence'), null)
  assert.equal(calls.length, 0, 'a refused cross-session rewind never reaches agents.create')
})

test('buildSessionTree assembles the family around the live session and scopes to cwd', async () => {
  const liveLog = twoTurnLog()
  const parentLog = reseq([
    turnStart(0),
    userText('parent prompt'),
    assistantText(0, 0, 'parent reply'),
    stepEnd(0, 0),
    turnEnd(0),
  ])
  // The child forked off the live tip: its log repeats the 12-event seed
  // prefix, then adds its own turn.
  const childLog = reseq([
    ...twoTurnLog(),
    turnStart(2), // 12
    userText('child prompt'), // 13
    assistantText(2, 0, 'child reply'), // 14
    stepEnd(2, 0), // 15
    turnEnd(2), // 16
  ])
  const eventsById: Record<string, SessionEvent[]> = { 's-parent': parentLog, 's-child': childLog }
  const sessionPersistence = {
    list: () =>
      Promise.resolve([
        { id: 's-parent', cwd: '/tmp', createdAt: 1 },
        // The live session is listed too (the jsonl backend materializes its
        // header on first append); the in-memory overlay only covers a fresh
        // fork that has not appended yet.
        { id: 's-live', cwd: '/tmp', createdAt: 2, parentSession: 's-parent' },
        { id: 's-child', cwd: '/tmp', createdAt: 3, parentSession: 's-live', seedLength: 12 },
        // Another project's session must never join the family.
        { id: 's-other', cwd: '/elsewhere', createdAt: 4 },
        // Delegation artifacts are not rewind branches.
        { id: 's-sub', cwd: '/tmp', createdAt: 5, origin: 'subagent', delegationDepth: 1 },
      ]),
    inspect: (id: string) => Promise.resolve({ events: eventsById[id] ?? [] }),
  }
  const live = makeAgent('agent-initial', 's-live', liveLog)
  live.session.header = { id: 's-live', cwd: '/tmp', createdAt: 2, parentSession: 's-parent' }
  const channel = makeChannel({ sessionPersistence }, live)

  const tree = await withTimeout(channel.buildSessionTree(), 'buildSessionTree')
  assert.ok(tree !== null)
  assert.equal(tree.sessionCount, 3, 'parent + live + child, cwd/subagent-filtered')
  assert.equal(tree.truncated, false)
  assert.equal(tree.sessions.get('s-live')?.live, true)
  assert.equal(tree.sessions.get('s-parent')?.live, false)

  const texts = flattenTree(tree.roots, tree.activeLeafId).map(flat => flat.node.entry?.text ?? '')
  for (const expected of ['parent prompt', 'first prompt', 'second prompt', 'child prompt']) {
    assert.ok(texts.some(text => text.includes(expected)), `tree shows "${expected}"`)
  }
  // The child's inherited prefix is coverage-skipped: its own chain shows
  // only its own turn.
  const childTexts = flattenTree(tree.roots, tree.activeLeafId)
    .filter(flat => flat.node.sessionId === 's-child')
    .map(flat => flat.node.entry?.text ?? '')
  assert.ok(childTexts.some(text => text.includes('child prompt')))
  assert.ok(!childTexts.some(text => text.includes('first prompt')), 'no duplicated seed prefix')
  // The initial cursor lands on the live session's last entry.
  assert.equal(tree.activeLeafId?.startsWith('s-live:'), true)
})

test('buildSessionTree without a persistence service reports unavailable', async () => {
  const channel = makeChannel({}, makeAgent('agent-initial', 's-live', twoTurnLog()))
  assert.equal(await withTimeout(channel.buildSessionTree(), 'buildSessionTree bare'), null)
})

// ---------------------------------------------------------------------------
// forkSession (kimi-code /fork): fork at the tip, STAY in the source session.
// ---------------------------------------------------------------------------

/** sessions fake: fork slices the source log through the boundary (no
 *  boundary = the whole log), mirroring the real service's seed contract. */
function makeSessions(): { fork(source: { events: SessionEvent[] }, boundary?: number): { events: SessionEvent[] } } {
  return {
    fork: (source, boundary) => ({
      events: boundary === undefined ? [...source.events] : source.events.filter(event => event.seq <= boundary),
    }),
  }
}

test('forkSession forks at the tip, stays in the source session, and toasts the resume command', async () => {
  const { agents, calls, disposed } = makeAgents('tip')
  const initial = makeAgent('agent-initial', 's-live', twoTurnLog())
  const channel = makeChannel({ agents, sessions: makeSessions() }, initial)
  const notices: string[] = []
  const base = channel.notify.bind(channel)
  channel.notify = (text, options) => {
    notices.push(text)
    return base(text, options)
  }
  const epochBefore = channel.sessionEpoch

  assert.equal(await withTimeout(channel.forkSession(), 'forkSession'), true)
  assert.equal(calls.length, 1, 'exactly one fork created')
  const call = calls[0]!
  assert.notEqual(call.sessionId, 's-live')
  assert.equal(call.meta.parentSession, 's-live', 'the fork hangs under the source session')
  assert.equal(call.seed.length, 12, 'no boundary: the seed is the whole log')
  assert.equal(call.meta.seedLength, 12)
  assert.equal(channel.agentId, 'agent-initial', 'the live session is NEVER swapped')
  assert.equal(channel.sessionEpoch, epochBefore, 'no swap → no epoch bump')
  assert.deepEqual(disposed, [call.sessionId], 'the fork runtime is released immediately')
  assert.deepEqual(userRowTexts(channel), ['first prompt', 'second prompt'], 'the transcript is untouched')
  assert.ok(
    notices.some(text => text.includes(String(call.sessionId)) && text.includes('DSH_TUI_RESUME_SESSION')),
    'the toast carries the fork id and its resume command',
  )
})

test('forkSession refuses while a turn is running and never reaches agents.create', async () => {
  const { agents, calls } = makeAgents('working')
  const initial = makeAgent('agent-initial', 's-live', twoTurnLog())
  const { channel, emit } = makeChannelWithBus({ agents, sessions: makeSessions() }, initial)
  // Drive the working flag through the same bus event the real agent emits.
  emit('session/event', initial.session, { type: 'turn/start', seq: 12, time: 1, data: { turn: 2 } })
  assert.equal(channel.working, true)

  assert.equal(await withTimeout(channel.forkSession(), 'forkSession working'), false)
  assert.equal(calls.length, 0, 'a refused fork creates nothing')
  assert.equal(channel.agentId, 'agent-initial')
  emit('session/event', initial.session, {
    type: 'turn/end',
    seq: 13,
    time: 2,
    data: { turn: 2, reason: { kind: 'completed' } },
  })
})

test('forkSession without session services reports unavailable', async () => {
  const bare = makeChannel({}, makeAgent('agent-bare', 's-bare', twoTurnLog()))
  assert.equal(await withTimeout(bare.forkSession(), 'forkSession bare'), false)
})
