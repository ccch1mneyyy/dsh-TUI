/**
 * Delivery-chain verification for the Enter paint-first yield: after the
 * input's Enter, the pending preview must be visible synchronously while the
 * agent call is deferred to a macrotask (so the UI paints the cleared input
 * + new row + spinner before the turn-start assembly runs), and rapid
 * submits must stay FIFO through the deferred chain.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-delivery-yield.mjs`
 */
import { createChannel } from '../lib/types/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get() {
    return undefined
  },
  logger: { warn() {} },
}

const followupCalls = []
const steerCalls = []
const agent = {
  id: 'a1',
  status: 'idle',
  // 0.4.0 bindAgent needs the agent-side ctx for installModelSelection.
  ctx: { on: () => () => {} },
  session: { id: 's1', seq: 0, events: [] },
  followup(message) {
    followupCalls.push(message)
  },
  steer(message) {
    steerCalls.push(message)
  },
  inbox: { remove() {} },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

// ---- Enter: the pending preview lands in the microtask drain (same frame
// as the cleared input), the agent call is deferred to a macrotask
channel.submit('第一条消息')
await sleep(0)
check('submit tracks the pending preview in the microtask drain', channel.pending.length === 1, JSON.stringify(channel.pending))
check('followup NOT called before the macrotask (paint-first yield)', followupCalls.length === 0, `calls=${followupCalls.length}`)

await sleep(30)
check('followup called once after the macrotask yield', followupCalls.length === 1 && followupCalls[0]?.content?.[0]?.text === '第一条消息', JSON.stringify(followupCalls.map(m => m.content?.[0]?.text)))

// ---- rapid submits stay FIFO through the deferred chain
channel.submit('第二条')
channel.submit('第三条')
await sleep(0)
check('both tracked in the microtask drain', channel.pending.length === 3, JSON.stringify(channel.pending))
await sleep(60)
check('FIFO order preserved', followupCalls.length === 3
  && followupCalls[1]?.content?.[0]?.text === '第二条'
  && followupCalls[2]?.content?.[0]?.text === '第三条',
JSON.stringify(followupCalls.map(m => m.content?.[0]?.text)))

// ---- steer path also defers
channel.steer('第四条')
check('steer defers the agent call too', steerCalls.length === 0)
await sleep(30)
check('steer delivered after the yield', steerCalls.length === 1 && steerCalls[0]?.content?.[0]?.text === '第四条')

if (failed > 0) process.exit(1)
console.log('\nAll delivery-yield checks passed.')
