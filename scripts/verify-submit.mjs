/**
 * Channel-level verification of the send chain: a real Channel (createChannel)
 * wired to a minimal fake agent with a working inbox event emitter.
 *
 * - `channel.submit(text)` → `agent.followup` (queued for AFTER the turn)
 * - `channel.steer(text)` → `agent.steer` (into the RUNNING turn)
 * - both land in `channel.pending` with the right placement
 * - a simulated `agent/inbox/claimed` event retires them (delivery)
 * - `channel.removePending(id)` pulls one back through `agent.inbox.remove`,
 *   and respects a refusal (already claimed → no ghost pull-back)
 * - `channel.interruptAndDeliver` cancels, then re-queues on `whenIdle`
 *
 * 对齐说明：投递自 #34（@ 文件引用）起走 sendChain 异步链（expandMentions
 * 在 followup/steer 之前 await），断言前需等链落定；撤回自 rc.6 收敛为
 * 官方 `Inbox.remove(messageId)` 单一路径——旧版 positional inbox 事件与
 * `updateInbox` 兼容层已从 channel 移除，对应测试段一并退役。
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
/** 投递链（sendChain）落定：expandMentions + followup/steer 都是微任务级。 */
const settle = () => sleep(10)

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

// bindAgent 会把 dsh-agent 的 installModelSelection 挂到 agent.ctx 的
// assembly/request 瀑布上（0.3.6 Shift+Tab 推理等级）；stub 只需提供
// "可订阅、返回解除函数"的最小面。
const stubAgentCtx = { on: () => () => {} }

const followupCalls = []
const steerCalls = []
const inboxRemovals = []
// rc.6 语义：remove 返回是否成功撤回（false = 已被认领，UI 不得假装
// 拉回一次幽灵发送）。可切换，供拒绝场景复用同一 agent。
let inboxRemoveResult = true
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  ctx: stubAgentCtx,
  followup(message) {
    followupCalls.push(message)
  },
  steer(message) {
    steerCalls.push(message)
  },
  inbox: {
    remove(id) {
      inboxRemovals.push(id)
      return inboxRemoveResult
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
await settle()
check('submit → agent.followup', followupCalls.length === 1 && followupCalls[0]?.content?.[0]?.text === '第一条消息')
check('submit tracked as pending followup', channel.pending.length === 1 && channel.pending[0]?.placement === 'followup', JSON.stringify(channel.pending))

// ---- steer (Enter while working) path
channel.steer('第二条消息')
await settle()
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
await settle()
check('steer for removal tracked', channel.pending.length === 1, JSON.stringify(channel.pending))
const removed = channel.removePending(channel.pending[0]?.id ?? '')
check('removePending → agent.inbox.remove', removed === true && inboxRemovals.length === 1)
check('removePending clears the item', channel.pending.length === 0)
check('removePending unknown id is false', channel.removePending('nope') === false)

// ---- inbox.remove refuses (already claimed) → pending kept, no ghost send
channel.steer('已被认领')
await settle()
inboxRemoveResult = false
check('refused pull-back keeps pending', channel.removePending(channel.pending[0]?.id ?? '') === false && channel.pending.length === 1, JSON.stringify(channel.pending))
inboxRemoveResult = true
check('pull-back succeeds once unclaimed', channel.removePending(channel.pending[0]?.id ?? '') === true && channel.pending.length === 0)

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
  ctx: stubAgentCtx,
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
  ctx: stubAgentCtx,
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
  ctx: stubAgentCtx,
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
