/**
 * Channel-level TPS regression coverage (real createChannel + session events):
 *
 * - a two-step turn excludes a 51s tool gap and folds TPS as Σtokens / ΣdecodeMs
 * - reasoning and tool-call deltas both establish the first-token boundary
 * - live chars/4 estimates use every token delta, then provider usage settles it
 * - a retry-like delay stays inside the same step's decode span
 * - missing provider usage falls back to the streamed character estimate
 * - durable replay derives the same values from event.time
 *
 * Run after build: `node scripts/verify-tps.mjs`
 */
import { createChannel } from '../lib/types/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function near(actual, expected, epsilon = 1e-9) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= epsilon
}

function makeContext() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      get() {
        return undefined
      },
      logger: { warn() {} },
    },
  }
}

function makeAgent(events = []) {
  return {
    id: 'tps-agent',
    ctx: {
      on() {
        return () => {}
      },
    },
    status: 'idle',
    session: {
      id: 'tps-session',
      seq: events.at(-1)?.seq ?? 0,
      events,
    },
    followup() {},
    steer() {},
  }
}

const options = {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
}
const { ctx, handlers } = makeContext()
const agent = makeAgent()
const channel = createChannel(ctx, agent, options)
let seq = 0
function emit(type, time, data) {
  const event = { type, seq: ++seq, time, data }
  agent.session.seq = seq
  agent.session.events.push(event)
  handlers.get('session/event')?.(agent.session, event)
  return event
}

const usage = outputTokens => ({
  inputTokens: 1_000,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})
const message = (turn, step, outputTokens) => ({
  turn,
  step,
  message: { content: [] },
  ...(outputTokens === undefined ? {} : { usage: usage(outputTokens) }),
})
const completed = turn => ({ turn, reason: { kind: 'completed' } })
const B = 1_700_000_000_000

// Turn 1: 100 tokens / 1s, then a 51s non-decode gap, then 300 / 3s.
emit('turn/start', B, { turn: 1 })
emit('step/start', B + 100, { turn: 1, step: 1 })
emit('assistant/chunk', B + 1_000, {
  turn: 1,
  step: 1,
  chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
})
emit('assistant/message', B + 2_000, message(1, 1, 100))
check('first step settles at 100 TPS', near(channel.tps, 100), String(channel.tps))
check('in-progress turn has no historical sample', channel.tpsSamples.length === 0, String(channel.tpsSamples.length))
emit('step/end', B + 2_100, { turn: 1, step: 1 })

// The timestamp jump represents tool execution and the next request's TTFT.
emit('step/start', B + 52_000, { turn: 1, step: 2 })
emit('assistant/chunk', B + 53_000, {
  turn: 1,
  step: 2,
  chunk: {
    type: 'tool-call-delta',
    index: 0,
    id: 'call-1',
    name: 'bash',
    argumentsDelta: '{"command":"true"}',
  },
})
emit('assistant/message', B + 56_000, message(1, 2, 300))
emit('step/end', B + 56_100, { turn: 1, step: 2 })
check('turn fold excludes tool gap', near(channel.tps, 100), String(channel.tps))
const firstTurnEnd = emit('turn/end', B + 56_200, completed(1))
check('multi-step turn records one weighted sample', channel.tpsSamples.length === 1 && near(channel.tpsSamples[0]?.tps, 100), JSON.stringify(channel.tpsSamples))
check('sample timestamp comes from event.time', channel.tpsSamples[0]?.at === firstTurnEnd.time, JSON.stringify(channel.tpsSamples[0]))

// Turn 2: no text delta. Reasoning + tool args total 800 chars over 1s live,
// then exact provider usage settles 300 tokens over a 2s decode span.
emit('turn/start', B + 100_000, { turn: 2 })
emit('step/start', B + 100_100, { turn: 2, step: 1 })
emit('assistant/chunk', B + 101_000, {
  turn: 2,
  step: 1,
  chunk: { type: 'reasoning-delta', index: 0, text: 'r'.repeat(400) },
})
emit('assistant/chunk', B + 102_000, {
  turn: 2,
  step: 1,
  chunk: { type: 'tool-call-delta', index: 1, id: 'call-2', argumentsDelta: 'a'.repeat(400) },
})
check('live estimate includes reasoning and tool-call deltas', near(channel.tps, 200), String(channel.tps))
emit('assistant/message', B + 103_000, message(2, 1, 300))
check('provider usage replaces live estimate', near(channel.tps, 150), String(channel.tps))
emit('turn/end', B + 103_100, completed(2))
check('second turn adds exactly one sample', channel.tpsSamples.length === 2 && near(channel.tpsSamples[1]?.tps, 150), JSON.stringify(channel.tpsSamples))

// Turn 3: a retry-like pause does not move the first-token boundary.
emit('turn/start', B + 200_000, { turn: 3 })
emit('step/start', B + 200_100, { turn: 3, step: 1 })
emit('assistant/chunk', B + 201_000, {
  turn: 3,
  step: 1,
  chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
})
emit('assistant/chunk', B + 204_000, {
  turn: 3,
  step: 1,
  chunk: { type: 'text-delta', index: 0, text: 'successful attempt' },
})
emit('assistant/message', B + 205_000, message(3, 1, 100))
emit('turn/end', B + 205_100, completed(3))
check('retry-like delay remains in the step decode span', near(channel.tps, 25), String(channel.tps))

// Turn 4: providers without usage retain the existing chars/4 fallback.
emit('turn/start', B + 300_000, { turn: 4 })
emit('step/start', B + 300_100, { turn: 4, step: 1 })
emit('assistant/chunk', B + 301_000, {
  turn: 4,
  step: 1,
  chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(200) },
})
emit('assistant/chunk', B + 302_000, {
  turn: 4,
  step: 1,
  chunk: { type: 'text-delta', index: 0, text: 'y'.repeat(200) },
})
emit('assistant/message', B + 303_000, message(4, 1))
emit('turn/end', B + 303_100, completed(4))
check('missing usage falls back to chars/4', near(channel.tps, 50), String(channel.tps))
check('one sample is retained per completed turn', channel.tpsSamples.length === 4, String(channel.tpsSamples.length))

// Rebuild from durable history. Coalescing may merge adjacent text chunks, but
// the first event's persisted time remains the decode boundary.
const replayContext = makeContext()
const replayAgent = makeAgent([...agent.session.events])
const replay = createChannel(replayContext.ctx, replayAgent, options)
check('replay rebuilds all turn samples', replay.tpsSamples.length === 4, JSON.stringify(replay.tpsSamples))
check('replay derives the same latest TPS from event.time', near(replay.tps, channel.tps), `${replay.tps} vs ${channel.tps}`)
check('replay preserves the weighted multi-step sample', near(replay.tpsSamples[0]?.tps, 100), JSON.stringify(replay.tpsSamples[0]))

if (failed > 0) {
  console.error(`\n${failed} TPS verification(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll TPS verifications passed')
}
