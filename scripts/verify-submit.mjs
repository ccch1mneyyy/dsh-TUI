/**
 * Channel-level verification of the send chain: a real Channel (createChannel)
 * wired to a minimal fake agent with a working inbox event emitter.
 *
 * - `channel.submit(text)` → `agent.followup` (queued for AFTER the turn)
 * - `channel.steer(text)` → `agent.steer` (into the RUNNING turn)
 * - both land in `channel.pending` with the right placement
 * - a simulated `agent/inbox/claimed` event retires them (delivery)
 * - `channel.removePending(id)` pulls one back and calls `agent.inbox.remove`
 *
 * Run with plain node against the compiled lib: `node scripts/verify-submit.mjs`
 */
import { createChannel } from '../lib/types/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

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
const inboxRemovals = []
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  followup(message) {
    followupCalls.push(message)
  },
  steer(message) {
    steerCalls.push(message)
  },
  inbox: {
    remove(id) {
      inboxRemovals.push(id)
    },
  },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

// ---- followup (Tab queue) path
channel.submit('  第一条消息  ')
check('submit → agent.followup', followupCalls.length === 1 && followupCalls[0]?.content?.[0]?.text === '第一条消息')
check('submit tracked as pending followup', channel.pending.length === 1 && channel.pending[0]?.placement === 'followup', JSON.stringify(channel.pending))

// ---- steer (Enter while working) path
channel.steer('第二条消息')
check('steer → agent.steer', steerCalls.length === 1 && steerCalls[0]?.content?.[0]?.text === '第二条消息')
check('steer tracked as pending steer', channel.pending.length === 2 && channel.pending[1]?.placement === 'steer', JSON.stringify(channel.pending))
check('blank steer ignored', channel.steer('   ') === undefined && steerCalls.length === 1)

// ---- claimed event retires the pending item (delivery)
const claimedHandler = handlers.get('agent/inbox/claimed')
const discardedHandler = handlers.get('agent/inbox/discarded')
check('claimed handler registered', typeof claimedHandler === 'function')
if (claimedHandler) {
  claimedHandler({ agent, message: steerCalls[0] })
  check('claimed retires the steer item', channel.pending.length === 1 && channel.pending[0]?.placement === 'followup', JSON.stringify(channel.pending))
}
if (discardedHandler) {
  discardedHandler({ agent, message: followupCalls[0] })
  check('discarded retires the followup item', channel.pending.length === 0, JSON.stringify(channel.pending))
}

// ---- removePending pulls a message back out of the inbox
channel.steer('撤回我')
check('steer for removal tracked', channel.pending.length === 1, JSON.stringify(channel.pending))
const removed = channel.removePending(channel.pending[0]?.id ?? '')
check('removePending → agent.inbox.remove', removed === true && inboxRemovals.length === 1)
check('removePending clears the item', channel.pending.length === 0)
check('removePending unknown id is false', channel.removePending('nope') === false)

// ---- released dsh-agent without the inbox API: pull-back is refused
const legacyAgent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  followup(message) {
    followupCalls.push(message)
  },
  steer(message) {
    steerCalls.push(message)
  },
  // no `inbox` — released dsh-agent shape
}
const legacyChannel = createChannel(ctx, legacyAgent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
legacyChannel.steer('旧版agent的消息')
check('legacy agent steers fine', steerCalls.some(m => m.content?.[0]?.text === '旧版agent的消息'))
check('legacy agent tracks pending', legacyChannel.pending.length === 1, JSON.stringify(legacyChannel.pending))
check('legacy pull-back refused (no ghost send)', legacyChannel.removePending(legacyChannel.pending[0]?.id ?? '') === false)
check('legacy pending kept after refusal', legacyChannel.pending.length === 1)

process.exit(failed)
