#!/usr/bin/env node
/** Channel-level regression for the in-process working-activity projection. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(tmpdir(), 'dsh-tui-activity-home-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
const { createChannel } = await import('../lib/types/channel.js')
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
await new Promise((resolve) => setTimeout(resolve, 550))
assert.ok(channel.workingActivity.turnElapsedMs >= elapsedBeforeTick + 450, '500 ms timer refreshes elapsed state')

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

for (const dispose of effects.reverse()) dispose()
rmSync(testHome, { recursive: true, force: true })
console.log('verify-working-activity: OK')
