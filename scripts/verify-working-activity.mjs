#!/usr/bin/env node
/** Channel-level regression for the in-process working-activity projection. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settled, sleep } from './lib/term-test.mjs'

const testHome = mkdtempSync(join(tmpdir(), 'dsh-tui-activity-home-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')
const { apply: applyWorkingActivity } = await import('dsh-working-activity')

// Both shipped compositions explicitly keep persistence disabled.
for (const configFile of ['cordis.patch.yml', 'cordis.yml']) {
  const config = readFileSync(configFile, 'utf8')
  const row = config.match(/- id: working-activity[\s\S]{0,240}/)?.[0] ?? ''
  assert.match(row, /publish:\s*false/, `${configFile} disables activity publishing`)
  assert.doesNotMatch(row, /publish:\s*true/)
}

// Exercise the mounted plugin sink itself: a representative turn may update
// narration/prompt state, but publish:false must never call session.append.
const pluginHandlers = new Map()
const pluginEffects = []
let appendCalls = 0
const pluginCtx = {
  get() { return undefined },
  inject() {},
  on(event, handler) {
    pluginHandlers.set(event, handler)
    return () => pluginHandlers.delete(event)
  },
  effect(setup) { pluginEffects.push(setup()) },
}
applyWorkingActivity(pluginCtx, { publish: false, narrate: false, tickMs: 500 })
const pluginSession = { append() { appendCalls += 1 } }
pluginHandlers.get('agent/status')({ agent: { session: pluginSession }, status: 'running' })
pluginHandlers.get('session/event')(pluginSession, {
  type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 'plugin-turn' },
})
await new Promise((resolve) => queueMicrotask(resolve))
assert.equal(appendCalls, 0, 'publish:false produces no activity/status log event')
for (const dispose of pluginEffects.reverse()) dispose()

// The TUI mount point (./working-activity re-export) must force publish off
// even when a stale global-launcher patch row passes publish:true — the
// dsh CLI resolves the patch anchor-first, so a ≤0.6.x launcher copy still
// carried publish:true on this row over an up-to-date profile (issue #153
// recurrence). The wrapper swallows the flag; only the bare package mount
// can publish.
const tuiMount = await import('../lib/types/working-activity.js')
const mountHandlers = new Map()
const mountEffects = []
let mountAppendCalls = 0
const mountCtx = {
  get() { return undefined },
  inject() {},
  on(event, handler) {
    mountHandlers.set(event, handler)
    return () => mountHandlers.delete(event)
  },
  effect(setup) { mountEffects.push(setup()) },
}
tuiMount.apply(mountCtx, { publish: true, narrate: false, tickMs: 500 })
const mountSession = { append() { mountAppendCalls += 1 } }
mountHandlers.get('agent/status')({ agent: { session: mountSession }, status: 'running' })
mountHandlers.get('session/event')(mountSession, {
  type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 'mount-turn' },
})
await new Promise((resolve) => queueMicrotask(resolve))
assert.equal(mountAppendCalls, 0, 'mount point forces publish:false even when the row config says true')
for (const dispose of mountEffects.reverse()) dispose()

const handlers = new Map()
const effects = []
let replacementAgent
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => {
      if (handlers.get(event) === handler) handlers.delete(event)
    }
  },
  effect(setup) {
    effects.push(setup())
  },
  get(name) {
    if (name === 'agents') {
      return {
        async create() {
          replacementAgent = makeAgent('agent-2', 'session-2')
          return { agent: replacementAgent, async dispose() {} }
        },
      }
    }
    return undefined
  },
  logger: { warn() {} },
}

function makeAgent(id, sessionId) {
  return {
    id,
    status: 'idle',
    session: { id: sessionId, seq: 0, events: [] },
    ctx: { on: () => () => {} },
  }
}

const agent = makeAgent('agent-1', 'session-1')
const channel = createChannel(ctx, agent, {
  model: 'test-model',
  provider: 'test-provider',
  cwd: testHome,
  activity: true,
})
const status = () => handlers.get('agent/status')
const sessionEvent = () => handlers.get('session/event')
assert.ok(status())
assert.ok(sessionEvent())

status()({ agent, status: 'running' })
assert.equal(channel.workingActivity?.phase, 'waiting')

const startedAt = Date.now()
sessionEvent()(agent.session, {
  type: 'turn/start', seq: 0, time: startedAt,
  data: { turn: 'turn-1' },
})
assert.equal(channel.workingActivity?.phase, 'waiting')

sessionEvent()(agent.session, {
  type: 'assistant/chunk', seq: 1, time: startedAt + 1,
  data: { turn: 'turn-1', step: 'step-1', chunk: { type: 'text-delta', text: 'hello' } },
})
assert.equal(channel.workingActivity?.phase, 'thinking')

sessionEvent()(agent.session, {
  type: 'tool/call', seq: 2, time: startedAt + 2,
  data: { turn: 'turn-1', step: 'step-1', callId: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' },
})
assert.equal(channel.workingActivity?.phase, 'tool')

const elapsedBeforeTick = channel.workingActivity.turnElapsedMs
assert.ok(await settled(() => channel.workingActivity.turnElapsedMs >= elapsedBeforeTick + 450), '500 ms timer refreshes elapsed state')

sessionEvent()(agent.session, {
  type: 'tool/result', seq: 3, time: Date.now(),
  data: {
    turn: 'turn-1', step: 'step-1',
    message: {
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
    },
  },
})
assert.equal(channel.workingActivity?.phase, 'thinking')

sessionEvent()(agent.session, {
  type: 'turn/end', seq: 4, time: Date.now(),
  data: { turn: 'turn-1', reason: { kind: 'completed' } },
})
status()({ agent, status: 'idle' })
assert.equal(channel.workingActivity?.phase, 'done')

// A legacy persisted snapshot is ignored; it cannot overwrite derived state.
const doneLine = channel.workingActivity.line
sessionEvent()(agent.session, {
  type: 'activity/status', seq: 5, time: Date.now(),
  data: { phase: 'tool', line: 'PERSISTED STATUS MUST NOT WIN' },
})
assert.equal(channel.workingActivity?.phase, 'done')
assert.notEqual(channel.workingActivity?.line, 'PERSISTED STATUS MUST NOT WIN')
assert.equal(channel.workingActivity?.line, doneLine)

assert.equal(await channel.newSession(), true)
assert.equal(channel.agentId, 'agent-2')
assert.equal(channel.workingActivity?.phase, 'idle')
assert.equal(channel.workingActivity?.line, '')

// The pi-style config file drives the tracker: `mode: minimal` renders plain
// functional labels instead of the playful pool (issue parity with pi).
mkdirSync(join(testHome, '.dsh-tui'), { recursive: true })
writeFileSync(join(testHome, '.dsh-tui', 'working-activity.json'), JSON.stringify({ frames: 'claude', mode: 'minimal' }))
const minimalChannel = createChannel(ctx, agent, {
  model: 'test-model', provider: 'test-provider', cwd: testHome, activity: true,
})
sessionEvent()(agent.session, {
  type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 'minimal-turn' },
})
sessionEvent()(agent.session, {
  type: 'assistant/chunk', seq: 1, time: Date.now(),
  data: { turn: 'minimal-turn', step: 'step-1', chunk: { type: 'text-delta', text: 'hi' } },
})
assert.match(minimalChannel.workingActivity.line, /思考中|Thinking/)

// ── the 500ms tick retires once the turn is done and the line is stable ───
{
  const opts = {
    model: 'test-model', provider: 'test-provider', cwd: testHome, activity: true,
  }
  const fresh = makeAgent('agent-3', 'session-3')
  const tickChannel = createChannel(ctx, fresh, opts)
  let emits = 0
  const unsubscribe = tickChannel.subscribe(() => { emits += 1 })
  // LIVE phase first: start a turn and keep it live (thinking). The 500ms
  // timer must ACTUALLY fire while the turn is open — recording the emit
  // baseline only after turn/end would prove nothing (a predicate already
  // satisfied by the done phase cannot evidence a live tick).
  handlers.get('agent/status')({ agent: fresh, status: 'running' })
  handlers.get('session/event')(fresh.session, {
    type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 'tick-turn' },
  })
  handlers.get('session/event')(fresh.session, {
    type: 'assistant/chunk', seq: 1, time: Date.now(),
    data: { turn: 'tick-turn', step: 'step-1', chunk: { type: 'text-delta', text: 'hi' } },
  })
  assert.equal(tickChannel.workingActivity?.phase, 'thinking')
  const emitsAtLive = emits
  const liveElapsedBefore = tickChannel.workingActivity.turnElapsedMs
  assert.ok(
    await settled(() => emits > emitsAtLive && tickChannel.workingActivity.turnElapsedMs >= liveElapsedBefore + 450),
    'live phase holds a real timer-driven 500ms emit (elapsed advances while the turn is open)',
  )
  // Only NOW end the turn.
  handlers.get('session/event')(fresh.session, {
    type: 'turn/end', seq: 2, time: Date.now(),
    data: { turn: 'tick-turn', reason: { kind: 'completed' } },
  })
  handlers.get('agent/status')({ agent: fresh, status: 'idle' })
  assert.equal(tickChannel.workingActivity?.phase, 'done')
  // The done summary carries a short-lived fragment; after it stabilizes
  // (~3s window + 4s grace) the tick must stop: no further emits.
  await sleep(5500)
  const emitsAfterIdle = emits
  await sleep(2000)
  assert.equal(emits, emitsAfterIdle, 'no activity emits while the done line is stable')

  // ── failure injection: projection unavailable retires the tick ──────────
  // The tick's `rendered === undefined` funnel is the SAME one a throwing
  // tracker.render() lands in (updateWorkingActivity catches and returns
  // undefined); the options.activity flip reaches it deterministically.
  // A live turn arms the tick; flipping the sidecar off must retire it on
  // the NEXT tick (≤ ~600ms) instead of spinning forever, and a later REAL
  // activity event must be able to re-arm it.
  handlers.get('agent/status')({ agent: fresh, status: 'running' })
  handlers.get('session/event')(fresh.session, {
    type: 'turn/start', seq: 3, time: Date.now(), data: { turn: 'tick-turn-2' },
  })
  handlers.get('session/event')(fresh.session, {
    type: 'assistant/chunk', seq: 4, time: Date.now(),
    data: { turn: 'tick-turn-2', step: 'step-1', chunk: { type: 'text-delta', text: 'hi' } },
  })
  assert.equal(tickChannel.workingActivity?.phase, 'thinking')
  const emitsLive2 = emits
  const live2Elapsed = tickChannel.workingActivity.turnElapsedMs
  assert.ok(
    await settled(() => emits > emitsLive2 && tickChannel.workingActivity.turnElapsedMs >= live2Elapsed + 450),
    'tick re-armed for the new live turn (timer-driven elapsed advance)',
  )
  // Poison the projection: every updateWorkingActivity now yields undefined.
  opts.activity = false
  const emitsAtPoison = emits
  await sleep(1600)
  const emitsAfterPoison = emits
  await sleep(1200)
  assert.equal(emits, emitsAfterPoison, 'tick retired after projection became unavailable (no 500ms wake loop)')
  assert.ok(
    emitsAfterPoison - emitsAtPoison <= 2,
    `at most the in-flight tick fired once more (delta=${emitsAfterPoison - emitsAtPoison})`,
  )
  // Recovery: a REAL activity event re-arms the tick once the projection is
  // available again.
  opts.activity = true
  handlers.get('session/event')(fresh.session, {
    type: 'assistant/chunk', seq: 5, time: Date.now(),
    data: { turn: 'tick-turn-2', step: 'step-2', chunk: { type: 'text-delta', text: 'again' } },
  })
  const recoveredElapsed = tickChannel.workingActivity?.turnElapsedMs ?? 0
  assert.ok(
    await settled(() => (tickChannel.workingActivity?.turnElapsedMs ?? 0) >= recoveredElapsed + 450),
    'a later real activity event re-arms the tick',
  )
  unsubscribe()
}

// ── streaming revive bumps rowsStreamingVersion (P2-7) ────────────────────
// A reconnect replay that revives a previously sealed assistant row flips
// `streaming` IN PLACE — invisible to rows identity/length, so the
// transcript filter cache must hear about it via the version counter.
{
  const fresh = makeAgent('agent-4', 'session-4')
  const reviveChannel = createChannel(ctx, fresh, {
    model: 'test-model', provider: 'test-provider', cwd: testHome, activity: false,
  })
  const before = reviveChannel.rowsStreamingVersion
  // Stream a step, then seal it with an assistant/message.
  handlers.get('session/event')(fresh.session, {
    type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1, step: 1 },
  })
  handlers.get('session/event')(fresh.session, {
    type: 'assistant/chunk', seq: 1, time: Date.now(),
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hello' } },
  })
  handlers.get('session/event')(fresh.session, {
    type: 'assistant/message', seq: 2, time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hello' }] } },
  })
  assert.ok(reviveChannel.rowsStreamingVersion > before, 'settle bumps rowsStreamingVersion')
  const settledVersion = reviveChannel.rowsStreamingVersion
  // A reconnect replay of the same step's chunk revives the sealed row.
  handlers.get('session/event')(fresh.session, {
    type: 'assistant/chunk', seq: 3, time: Date.now(),
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hello' } },
  })
  assert.ok(
    reviveChannel.rowsStreamingVersion > settledVersion,
    'revive of a sealed row bumps rowsStreamingVersion',
  )
}

for (const dispose of effects.reverse()) dispose()
rmSync(testHome, { recursive: true, force: true })
console.log('verify-working-activity: OK')
