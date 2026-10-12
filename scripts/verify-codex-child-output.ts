/**
 * Child tool output through the real Codex session, RPC hub and scripted
 * app-server. The manual clock proves the 99/100ms boundary without sleeps.
 * No CLI process, credentials or network.
 * Run: node --import tsx/esm scripts/verify-codex-child-output.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent, AgentEventOf } from '../src/agent/events.js'
import { setLang } from '../src/i18n.js'
import { NOTIFY } from '../src/backends/codex/protocol/index.js'
import { CWD, openHarness, THREAD, tick, type SessionHarness } from './lib/codex-session-harness.js'

setLang('en')
const CHILD = '019a0000-0000-7000-8000-000000000002'
const LANE = 'child-spawn'
const CALL = 'shared-command'
let passed = 0
const check = (label: string, condition: unknown): void => { assert.ok(condition, label); passed += 1; console.log('PASS ' + label) }
const output = (events: readonly AgentEvent[]): AgentEventOf<'tool.output'>[] => events.filter((event): event is AgentEventOf<'tool.output'> => event.type === 'tool.output')
const command = (id: string, complete = false) => ({
  type: 'commandExecution', id, command: 'echo output', cwd: CWD, source: 'agent', processId: null,
  status: complete ? 'completed' : 'inProgress', commandActions: [],
  aggregatedOutput: complete ? 'finished' : null, exitCode: complete ? 0 : null, durationMs: complete ? 1 : null,
})
async function beginChild(h: SessionHarness): Promise<void> {
  await h.startTurn('parent-turn', 'prompt', 'run child')
  await h.notify(NOTIFY.itemStarted, { turnId: 'parent-turn', item: { type: 'subAgentActivity', id: LANE, kind: 'started', agentThreadId: CHILD, agentPath: '/root/child' } })
  await h.notify(NOTIFY.turnStarted, { threadId: CHILD, turn: { id: 'child-turn', status: 'inProgress', items: [] } })
  await h.notify(NOTIFY.itemStarted, { threadId: CHILD, turnId: 'child-turn', item: command(CALL) })
}

// 50 child deltas share one timer. Parent and child with the same native
// call id keep separate payloads and parentCallId attribution.
{
  const h = await openHarness()
  try {
    await beginChild(h)
    await h.notify(NOTIFY.itemStarted, { turnId: 'parent-turn', item: command(CALL) })
    for (let index = 0; index < 50; index += 1) h.fake.notify(NOTIFY.commandOutputDelta, { threadId: CHILD, turnId: 'child-turn', itemId: CALL, delta: 'c' })
    h.fake.notify(NOTIFY.commandOutputDelta, { threadId: THREAD, turnId: 'parent-turn', itemId: CALL, delta: 'parent' })
    await tick()
    check('real session buffers every child delta before the timer', output(h.events()).length === 0)
    h.clock.advance(99)
    check('50 child deltas produce no output at 99ms', output(h.events()).length === 0)
    h.clock.advance(1)
    const outputs = output(h.events())
    check('50 child deltas coalesce into one frame batch at 100ms', outputs.filter(event => event.parentCallId === LANE).length === 1 && outputs.find(event => event.parentCallId === LANE)?.text === 'c'.repeat(50))
    check('parent and child shared call id never merge their output chunks', outputs.length === 2 && outputs.find(event => event.parentCallId === undefined)?.text === 'parent' && outputs.every(event => event.callId === CALL))
    check('coalesced child output requests a frame wake', h.batches.filter(batch => batch.events.some(event => event.type === 'tool.output' && event.parentCallId === LANE)).every(batch => batch.meta.wake === 'frame'))
  } finally { await h.session.dispose(); await h.hub.close() }
}

// A child result does not wait for 100ms: the shared session deliver path
// drains the pending output first and its cancelled timer emits no duplicate.
{
  const h = await openHarness()
  try {
    await beginChild(h)
    for (let index = 0; index < 50; index += 1) h.fake.notify(NOTIFY.commandOutputDelta, { threadId: CHILD, turnId: 'child-turn', itemId: CALL, delta: String(index) + ',' })
    await tick()
    check('early child output remains pending until result or timer', output(h.events()).length === 0)
    await h.notify(NOTIFY.itemCompleted, { threadId: CHILD, turnId: 'child-turn', item: command(CALL, true) })
    const events = h.events()
    const firstOutput = events.findIndex(event => event.type === 'tool.output' && event.parentCallId === LANE)
    const result = events.findIndex(event => event.type === 'tool.result' && event.parentCallId === LANE && event.callId === CALL)
    check('child result flushes the entire output before its settlement event', firstOutput >= 0 && result > firstOutput && output(events)[0]?.text === Array.from({ length: 50 }, (_, index) => String(index) + ',').join(''))
    h.clock.advance(100)
    check('the flushed child timer emits no duplicate output', output(h.events()).length === 1)
    h.fake.notify(NOTIFY.itemStarted, { threadId: CHILD, turnId: 'child-turn', item: command('unfinished-child') })
    h.fake.notify(NOTIFY.commandOutputDelta, { threadId: CHILD, turnId: 'child-turn', itemId: 'unfinished-child', delta: 'cancel-on-dispose' })
    await tick()
    await h.session.dispose()
    const disposedCount = output(h.events()).length
    h.clock.advance(100)
    check('session disposal cancels pending child-output timers', output(h.events()).length === disposedCount)
  } finally { await h.session.dispose(); await h.hub.close() }
}
console.log('\nverify-codex-child-output OK (' + passed + ' checks)')
