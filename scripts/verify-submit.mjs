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

// ---- released dsh-agent: POSITIONAL inbox events (agent, item) ----
// The released package emits `enqueue/update/dequeue/discard` as
// `(agent, item | item[])` where `item.message.id` is the tracked id and
// `item.id` is an occurrence id; pull-back goes through `updateInbox`.
const releasedUpdateCalls = []
const makeReleasedAgent = (options = {}) => {
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events: [] },
    followup() {},
    // Released agent emits `enqueue` synchronously inside steer().
    steer(message) {
      const enqueue = handlers.get('agent/inbox/enqueue')
      enqueue?.(agent, { id: 'occ-1', message, placement: 'steering' })
      return { outcome: Promise.resolve({ status: 'admitted', turn: 1, step: 1 }) }
    },
    updateInbox(id, action) {
      releasedUpdateCalls.push({ id, action })
      return 'applied'
    },
    ...options,
  }
  return agent
}
const releasedAgent = makeReleasedAgent()
const releasedChannel = createChannel(ctx, releasedAgent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
releasedChannel.steer('发布版消息')
check('released steer tracked', releasedChannel.pending.length === 1, JSON.stringify(releasedChannel.pending))
check('released enqueue captured occurrence id', releasedChannel.pending[0]?.inboxItemId === 'occ-1', JSON.stringify(releasedChannel.pending))

// positional dequeue: (agent, item) — retires by item.message.id
const dequeueHandler = handlers.get('agent/inbox/dequeue')
if (dequeueHandler) {
  dequeueHandler(releasedAgent, { id: 'occ-1', message: { id: releasedChannel.pending[0]?.id }, placement: 'steering' })
  check('released positional dequeue retires the item', releasedChannel.pending.length === 0, JSON.stringify(releasedChannel.pending))
}

// positional discard: (agent, items[]) — retires every item's message id
releasedChannel.steer('a')
releasedChannel.steer('b')
const discardHandler = handlers.get('agent/inbox/discard')
if (discardHandler) {
  discardHandler(releasedAgent, releasedChannel.pending.map(p => ({ id: 'occ', message: { id: p.id }, placement: 'queued' })))
  check('released positional discard retires all', releasedChannel.pending.length === 0, JSON.stringify(releasedChannel.pending))
}

// pull-back via updateInbox (applied)
releasedChannel.steer('撤回我')
const releasePullId = releasedChannel.pending[0]?.id ?? ''
check('released pull-back via updateInbox', releasedChannel.removePending(releasePullId) === true && releasedUpdateCalls.at(-1)?.action?.kind === 'remove', JSON.stringify(releasedUpdateCalls.at(-1)))
check('released pending cleared after pull-back', releasedChannel.pending.length === 0)

// updateInbox refuses ('not-found' = already claimed) → pending kept
const refusedChannel = createChannel(ctx, makeReleasedAgent({ updateInbox() { return 'not-found' } }), {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
refusedChannel.steer('已被认领')
check('refused pull-back keeps pending', refusedChannel.removePending(refusedChannel.pending[0]?.id ?? '') === false && refusedChannel.pending.length === 1, JSON.stringify(refusedChannel.pending))

// steer admission rejected → preview rolls back once the outcome settles
const rejectedChannel = createChannel(ctx, makeReleasedAgent({ steer() { return { outcome: Promise.resolve({ status: 'rejected' }) } } }), {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
rejectedChannel.steer('被拒绝的插话')
await sleep(10)
check('rejected steer untracked after outcome', rejectedChannel.pending.length === 0, JSON.stringify(rejectedChannel.pending))

// ---- interruptAndDeliver: cancel + re-queue once the abort settles ----
// The harness parks kept inbox work until an unrelated wake (official
// cancel.spec: "keepInbox parks queued work after an active turn aborts"),
// and a wake issued while the driver still runs is ignored — so delivery
// is deferred to `whenIdle`, whose re-queue IS the wake that starts the
// new turn.
const interruptCalls = []
const interruptFollowups = []
let resolveIdle
const interruptAgent = {
  id: 'a1',
  status: 'running',
  session: { id: 's1', seq: 0, events: [] },
  cancel(cause, options) {
    interruptCalls.push({ cause, options })
  },
  whenIdle() {
    return new Promise(resolve => { resolveIdle = resolve })
  },
  followup(message) {
    interruptFollowups.push(message)
  },
}
const interruptChannel = createChannel(ctx, interruptAgent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
check('interruptAndDeliver trims and counts', interruptChannel.interruptAndDeliver(['插话一', '   ', '插话二']) === 2)
check('interruptAndDeliver cancels without keepInbox', interruptCalls.length === 1 && interruptCalls[0].options === undefined, JSON.stringify(interruptCalls))
check('delivery waits for the abort to settle', interruptFollowups.length === 0 && interruptChannel.pending.length === 0, JSON.stringify(interruptFollowups))
resolveIdle()
await sleep(10)
check('re-queued after idle (all texts)', interruptFollowups.length === 2 && interruptChannel.pending.length === 2, JSON.stringify(interruptFollowups.map(m => m.content?.[0]?.text)))
check('re-queued as followup', interruptChannel.pending.every(p => p.placement === 'followup'))

// A second interrupt while the first abort is still settling must not
// double-deliver: only the latest request's re-queue runs (both share the
// same abort's whenIdle).
let resolveIdle2
const idlePromise2 = new Promise(resolve => { resolveIdle2 = resolve })
const interruptAgent2 = {
  id: 'a1',
  status: 'running',
  session: { id: 's1', seq: 0, events: [] },
  cancel() {},
  whenIdle() {
    return idlePromise2
  },
  followup(message) {
    interruptFollowups.push(message)
  },
}
const interruptChannel2 = createChannel(ctx, interruptAgent2, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
interruptChannel2.interruptAndDeliver(['x'])
interruptChannel2.interruptAndDeliver(['y'])
resolveIdle2()
await sleep(10)
check('double interrupt does not double-deliver', interruptFollowups.filter(m => m.content?.[0]?.text === 'x').length === 0 && interruptFollowups.filter(m => m.content?.[0]?.text === 'y').length === 1, JSON.stringify(interruptFollowups.map(m => m.content?.[0]?.text)))

// No whenIdle (defensive): the re-queue waits a beat for the abort.
const fallbackCalls = []
const fallbackAgent = {
  id: 'a1',
  status: 'running',
  session: { id: 's1', seq: 0, events: [] },
  cancel() {},
  followup(message) {
    fallbackCalls.push(message)
  },
}
const fallbackChannel = createChannel(ctx, fallbackAgent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
fallbackChannel.interruptAndDeliver(['兜底投递'])
await sleep(300)
check('no-whenIdle fallback delivers after a beat', fallbackCalls.length === 1 && fallbackChannel.pending.length === 1, JSON.stringify(fallbackCalls))

process.exit(failed)
