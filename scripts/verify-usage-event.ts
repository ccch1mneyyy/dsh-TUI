/**
 * N8: separate usage books tokens/cost/turn totals without touching rows;
 * backend context occupancy wins over the billing sample, never DSH's meter.
 * Exercises the production projector, trajectory source, channel and export.
 * No backend process, credentials or network.
 * Run: node --import tsx/esm scripts/verify-usage-event.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentEventMeta, AgentEventOf } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { resolveContextOccupancy } from '../src/dsh-adapter/context-occupancy.js'
import { createAgentTrajectorySource } from '../src/dsh-adapter/trajectory/agent-source.js'
import { setLang } from '../src/i18n.js'
import { createProjectorHarness } from './lib/projector-harness.js'

setLang('en')
let passed = 0
const check = (label: string, run: () => void): void => {
  run()
  passed += 1
  console.log('PASS ' + label)
}
const start: AgentEvent = { type: 'turn.start', turn: 1, origin: 'user', time: 1 }
const message: AgentEventOf<'assistant.message'> = {
  type: 'assistant.message', seq: 1, anchor: 'reply', turn: 1, step: 1,
  attemptId: 'reply', time: 5, canonical: true, blocks: [{ type: 'text', text: 'Settled reply' }],
}
const usage: AgentEventOf<'usage'> = {
  type: 'usage', seq: 2, turn: 1, step: 1, time: 10, model: 'reported-model',
  usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 4 },
}

// A frozen row/array is a stronger guard than comparing only visible text:
// a count must not rewrite its timestamp, anchor, images or dirty markers.
const h = createProjectorHarness()
h.apply([start, message])
const rows = h.state.rows
const row = rows[0]!
const before = structuredClone(row)
Object.freeze(row)
Object.freeze(rows)
h.apply([usage, usage])
check('usage creates no row and changes no settled row', () => {
  assert.equal(h.state.rows, rows)
  assert.equal(rows.length, 1)
  assert.equal(rows[0], row)
  assert.deepEqual(row, before)
})
check('seq deduplicates independent usage', () => {
  assert.deepEqual(h.state.tokens.idle, usage.usage)
  assert.equal(h.state.tokens.input, 20)
  assert.equal(h.state.tokens.output, 5)
})
check('usage uses the same cost buckets and last-request sample', () => {
  assert.deepEqual(h.state.mainCost['reported-model']?.idle, usage.usage)
  assert.deepEqual(h.state.lastUsage, { ...usage.usage, at: usage.time })
})

const ledger = createProjectorHarness()
ledger.apply([start, message, usage, { ...usage, seq: 3, usage: { input: 2, output: 1 } },
  { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 20 }])
check('turn ledger adds usage increments, not turn.end totals', () => {
  assert.equal(ledger.state.turnUsage?.input, 22)
  assert.equal(ledger.state.turnUsage?.output, 6)
  assert.equal(ledger.state.turnUsage?.cacheRead, 3)
  assert.equal(ledger.state.turnUsage?.cacheWrite, 4)
  assert.equal(ledger.state.turnUsage?.cacheKnown, true)
  assert.equal(ledger.state.turnUsage?.model, 'reported-model')
})
const settled = structuredClone(ledger.state.rows)
ledger.apply([{ ...usage, seq: 4, time: 21 }])
check('even a late report does not rewrite the completed transcript', () => assert.deepEqual(ledger.state.rows, settled))
ledger.projector.reset()
ledger.apply([usage])
check('reset clears the usage seq fence', () => assert.equal(ledger.state.tokens.input, 62))

const legacy = createProjectorHarness()
legacy.apply([start, message, { ...message, seq: 2, canonical: false, blocks: [], time: 42 }])
check('legacy empty assistant messages retain their original settlement path', () => assert.equal(legacy.state.rows[0]?.time, 42))

for (const replay of [false, true]) {
  const trace = createAgentTrajectorySource()
  for (const event of [start, message]) trace.observe(event, replay)
  const prior = [...trace.events()]
  trace.observe(usage, replay)
  check('usage is naturally ignored by trace (' + (replay ? 'replay' : 'live') + ')', () => assert.deepEqual(trace.events(), prior))
}

const sample = { input: 1, cacheRead: 2, cacheWrite: 3 }
const backend = { type: 'context.usage', used: 50, max: 100 } as const
check('DSH projection wins over backend measurement and billing sample', () => assert.deepEqual(
  resolveContextOccupancy({ projectedTokens: 80, contextWindow: 200 }, sample, 300, backend),
  { usedTokens: 80, contextWindow: 200, source: 'projection' },
))
check('backend measurement wins over billing, including explicit zero', () => {
  assert.deepEqual(resolveContextOccupancy(undefined, sample, 300, backend), { usedTokens: 50, contextWindow: 100, source: 'backend' })
  assert.equal(resolveContextOccupancy(undefined, sample, 300, { used: 0 })?.usedTokens, 0)
  assert.equal(resolveContextOccupancy(undefined, undefined, 300, { used: 0 })?.contextWindow, 300)
})
check('without a backend measurement, the DSH/Claude sample path is unchanged', () => assert.deepEqual(
  resolveContextOccupancy(undefined, sample, 300), { usedTokens: 6, contextWindow: 300, source: 'sample' },
))
const occupancy = createProjectorHarness()
occupancy.apply([backend])
check('projector remembers context.usage without modifying the billing sample', () => {
  assert.equal(occupancy.projector.contextUsage(), backend)
  assert.equal(occupancy.state.lastUsage, undefined)
  assert.equal(occupancy.state.rows.length, 0)
})
occupancy.apply([], true)
check('replay clears the previous context measurement', () => assert.equal(occupancy.projector.contextUsage(), undefined))
occupancy.apply([backend])
occupancy.projector.reset()
check('projection reset clears context measurement', () => assert.equal(occupancy.projector.contextUsage(), undefined))

// Real channel wiring and /export: the event reaches the projector but only
// transcript facts cross the Markdown boundary.
const cwd = mkdtempSync(join(tmpdir(), 'dsh-tui-usage-'))
const listeners = new Set<(events: readonly AgentEvent[], meta: AgentEventMeta) => void>()
const session: AgentSession = {
  ref: { backendId: 'fixture', sessionId: 'usage' }, cwd, status: 'idle', capabilities: { native: {} },
  history: async () => [],
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  submit: async () => ({ accepted: true }),
  cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }),
  dispose: async () => undefined,
}
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
try {
  const channel = createChannel(ctx, session, { model: 'fixture', provider: '', cwd, activity: false, initialHistory: [] })
  const emit = (events: readonly AgentEvent[]): void => { for (const listener of listeners) listener(events, { replay: false }) }
  try {
    emit([start, message, usage, backend])
    check('channel occupancy accessor consumes the projector measurement', () => assert.deepEqual(channel.contextOccupancy, { usedTokens: 50, contextWindow: 100, source: 'backend' }))
    const file = channel.exportSession()
    assert.notEqual(file, null)
    const text = readFileSync(file!, 'utf8')
    check('export contains the reply once, with no usage event section', () => {
      assert.equal(text.split('Settled reply').length, 2)
      assert.equal(text.includes('reported-model'), false)
      assert.equal(text.includes('context.usage'), false)
    })
    emit([{ type: 'session.reset', trigger: 'fixture' }])
    check('conversation reset releases the measured occupancy', () => assert.equal(channel.contextOccupancy, undefined))
  } finally {
    channel.releaseContributions()
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
console.log('\nverify-usage-event OK (' + passed + ' checks)')
