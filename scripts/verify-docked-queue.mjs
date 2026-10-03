/**
 * Channel-level regression for the docked queue (Claude Code 2.1.284 parity):
 * Esc with queued input while a turn runs parks the previews as a DOCK —
 * the abort drops the backend's queued copies and nothing re-delivers them
 * until the user sends the dock (⏎ / deliverDocked) or retracts items.
 *
 * Both backends are pinned through the SAME channel core:
 * - DSH fixture: a real createDshSession over a fake agent (keepInbox
 *   belongs to user-cancel only; the interrupt cancel drops the inbox and
 *   the dock survives the kernel's discard events).
 * - Claude fixture: a raw AgentSession whose CLI keeps no withdrawal API
 *   (retractPending false) — docked rows still retract locally — and whose
 *   interrupt receipt can answer still_queued (the no-cancelQueued CLI
 *   fallback: those rows un-dock and retire on their own).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-docked-queue.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { setLang, t } from '../lib/types/i18n.js'
import { settle, settled } from './lib/term-test.mjs'

setLang('en')
const flush = () => new Promise(resolve => setImmediate(resolve))

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

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
const handlers = new Map()
const stubAgentCtx = { on: () => () => {} }

const launchOptions = { model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false }

// ───────────────────────── Section A: DSH fixture ─────────────────────────
{
  const followupCalls = []
  const cancelCalls = []
  const inboxRemovals = []
  const agent = {
    id: 'a1',
    status: 'running',
    session: { id: 's1', seq: 0, events: [] },
    ctx: stubAgentCtx,
    followup(message) {
      followupCalls.push(message)
    },
    steer() {},
    cancel(cause, options) {
      cancelCalls.push({ cause, options })
    },
    inbox: {
      remove(id) {
        inboxRemovals.push(id)
        return true
      },
    },
  }
  const channel = createChannel(ctx, agent, launchOptions)

  // Two queued messages while a turn runs.
  channel.submit('停靠一')
  channel.submit('停靠二')
  check('A1 two queued previews tracked', await settled(() => channel.pending.length === 2), JSON.stringify(channel.pending.map(p => p.text)))

  // Esc: dock, not deliver.
  check('A2 interruptAndDock counts', channel.interruptAndDock() === 2)
  check('A2 interrupt cancel drops the inbox (no keepInbox)', cancelCalls.length === 1 && cancelCalls[0]?.options === undefined, JSON.stringify(cancelCalls))
  check('A2 previews parked as docked', channel.pending.length === 2 && channel.pending.every(item => item.docked === true), JSON.stringify(channel.pending))

  // The kernel's discard events (the cancel dropped the inbox) must not
  // delete the docked previews.
  const discarded = handlers.get('agent/inbox/discarded')
  check('A3 discard handler registered', typeof discarded === 'function')
  if (discarded) {
    for (const message of [...followupCalls]) discarded({ agent, message })
    check('A3 docked previews survive the discard events', channel.pending.length === 2 && channel.pending.every(item => item.docked === true), JSON.stringify(channel.pending))
  }
  check('A4 nothing re-delivered after the dock', await settled(() => followupCalls.length === 2), JSON.stringify(followupCalls.map(m => m.content?.[0]?.text)))

  // Retract one docked row: purely local — the agent inbox is never asked.
  const retractedId = channel.pending[0]?.id
  check('A5 docked retract is local (no inbox.remove)', channel.removePending(retractedId) === true && inboxRemovals.length === 0 && channel.pending.length === 1)

  // Send the dock: exactly once, FIFO.
  check('A6 deliverDocked counts', channel.deliverDocked() === 1)
  const texts = () => followupCalls.map(m => m.content?.[0]?.text)
  check('A6 docked text delivered exactly once', await settled(() => texts().filter(text => text === '停靠二').length === 1), JSON.stringify(texts()))
  check('A6 fresh preview is not docked', await settled(() => channel.pending.length === 1 && channel.pending[0]?.docked !== true && channel.pending[0]?.placement === 'followup'), JSON.stringify(channel.pending))

  // Claim still retires a docked row (the fallback backend ran it).
  channel.submit('停靠三')
  await settle(() => channel.pending.length === 2)
  channel.interruptAndDock()
  const claimedId = channel.pending.find(item => item.docked === true)?.id
  const claimed = handlers.get('agent/inbox/claimed')
  check('A8 claim handler registered', typeof claimed === 'function')
  if (claimed) {
    claimed({ agent, message: { id: claimedId } })
    check('A8 claim retires a docked row', channel.pending.every(item => item.id !== claimedId), JSON.stringify(channel.pending))
  }

  // Ctrl+Enter over a dock: immediate delivery takes the dock along (the
  // docked text re-delivered exactly once, ahead of the new input), and no
  // docked row is left behind. Assert on the DELTA since the interrupt
  // began: the original submission already reached the agent once before
  // the dock parked its preview.
  const beforeInterrupt = followupCalls.length
  channel.interruptAndDeliver(['urgent'])
  const interruptDelta = () => texts().slice(beforeInterrupt)
  check('A9 interruptAndDeliver takes the dock first, exactly once each', await settled(() =>
    JSON.stringify(interruptDelta()) === JSON.stringify(['停靠三', 'urgent'])
    && channel.pending.every(item => item.docked !== true),
  ), JSON.stringify(interruptDelta()))

  // User-cancel semantics untouched: keepInbox stays exclusive to 'user'.
  const userCancelCalls = []
  const userCancelAgent = {
    id: 'a2',
    status: 'running',
    session: { id: 's2', seq: 0, events: [] },
    ctx: stubAgentCtx,
    followup() {},
    steer() {},
    cancel(cause, options) {
      userCancelCalls.push({ cause, options })
    },
    inbox: { remove: () => true },
  }
  const userChannel = createChannel(ctx, userCancelAgent, launchOptions)
  userChannel.submit('保留我')
  await settle(() => userChannel.pending.length === 1)
  userChannel.cancel()
  check('A7 user cancel keeps the inbox (keepInbox:true)', userCancelCalls.length === 1 && JSON.stringify(userCancelCalls[0]?.options) === '{"keepInbox":true}', JSON.stringify(userCancelCalls))
  check('A7 user cancel keeps the preview undocked', userChannel.pending.length === 1 && userChannel.pending[0]?.docked !== true)
}

// ─────────────────────── Section B: Claude fixture ────────────────────────
// A raw AgentSession shaped like the Claude backend: no live-inbox
// withdrawal (removePending false, retractPending therefore false) and an
// interrupt receipt that answers still_queued.
function makeClaudeSession({ stillQueuedOnInterrupt, cancelReceipt } = {}) {
  const state = {
    submits: [],
    cancels: [],
    removePendingCalls: [],
    listeners: new Set(),
    keptIds: [],
  }
  const session = {
    ref: { backendId: 'claude', sessionId: 'cs1' },
    cwd: '/tmp',
    status: 'running',
    capabilities: { native: {} },
    history: async () => [],
    subscribe(listener) {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    submit(input) {
      state.submits.push(input)
      if (stillQueuedOnInterrupt === true) state.keptIds.push(input.clientMessageId)
      return Promise.resolve({ accepted: true })
    },
    removePending(id) {
      state.removePendingCalls.push(id)
      return false
    },
    cancel(cause) {
      state.cancels.push(cause)
      if (cancelReceipt !== undefined) return cancelReceipt(state)
      return Promise.resolve({ stillQueued: cause === 'interrupt' ? [...state.keptIds] : [], outcome: 'confirmed' })
    },
    dispose: async () => {},
  }
  const push = event => {
    for (const listener of [...state.listeners]) listener([event], { replay: false, wake: 'sync' })
  }
  return { session, state, push }
}

{
  const { session, state, push } = makeClaudeSession()
  const channel = createChannel(ctx, session, launchOptions)
  check('B0 claude fixture has no retractPending', channel.backendCapabilities.retractPending === false)

  channel.submit('claude 一')
  channel.submit('claude 二')
  check('B1 two queued previews tracked', await settled(() => channel.pending.length === 2), JSON.stringify(channel.pending.map(p => p.text)))

  check('B2 interruptAndDock counts', channel.interruptAndDock() === 2)
  check('B2 cancel cause is interrupt', state.cancels.length === 1 && state.cancels[0] === 'interrupt', JSON.stringify(state.cancels))
  check('B2 previews parked (empty still_queued receipt)', await settled(() => channel.pending.length === 2 && channel.pending.every(item => item.docked === true)), JSON.stringify(channel.pending))

  // The CLI dropped its queue: pending.changed discards must not delete the
  // docked previews.
  push({ type: 'pending.changed', items: [], claimed: [], discarded: channel.pending.map(item => item.id) })
  check('B3 docked previews survive the CLI discard events', channel.pending.length === 2 && channel.pending.every(item => item.docked === true), JSON.stringify(channel.pending))

  // THE retract fix: a docked row retracts locally even though the session
  // reports no withdrawal capability at all.
  const dockedId = channel.pending[0]?.id
  check('B4 docked retract works without retractPending', channel.removePending(dockedId) === true && state.removePendingCalls.length === 0 && channel.pending.length === 1)

  check('B5 deliverDocked counts', channel.deliverDocked() === 1)
  check('B5 docked text delivered exactly once', await settled(() => {
    const texts = state.submits.map(input => input.text)
    return texts.filter(text => text === 'claude 二').length === 1
  }), JSON.stringify(state.submits.map(input => input.text)))
  check('B5 fresh preview is not docked', await settled(() => channel.pending.length === 1 && channel.pending[0]?.docked !== true), JSON.stringify(channel.pending))
}

// Fallback leg: a CLI without interrupt_cancel_queued_v1 answers the
// interrupt receipt with the ids it KEPT — those rows un-dock and retire on
// their own (a discard retires them like any live preview).
{
  const { session, state, push } = makeClaudeSession({ stillQueuedOnInterrupt: true })
  const channel = createChannel(ctx, session, launchOptions)
  channel.submit('fallback 消息')
  await settle(() => channel.pending.length === 1)
  check('B6 dock counted', channel.interruptAndDock() === 1)
  check('B6 kept-queue receipt un-docks the row', await settled(() => channel.pending.length === 1 && channel.pending[0]?.docked !== true), JSON.stringify(channel.pending))
  push({ type: 'pending.changed', items: [], claimed: [], discarded: [channel.pending[0]?.id] })
  check('B6 undocked row retires on discard (no ghost preview)', channel.pending.length === 0, JSON.stringify(channel.pending))
  check('B6 no delivery was made by the channel', state.submits.length === 1, JSON.stringify(state.submits.map(input => input.text)))
}

// ─────────── Section C: an unconfirmed interrupt never keeps a dock ────
// R2-1: a failed or answerless cancel receipt must not read as an empty
// queue. The dock is a CLAIM that the backend dropped its queued copies;
// without a confirmed receipt the channel revokes it (with a notice), so
// the still-live single backend copy keeps running and the SDK never
// accepts a second copy of the same intent.
{
  // C1 — the interrupt request itself rejects.
  const { session, state } = makeClaudeSession({ cancelReceipt: () => Promise.reject(new Error('interrupt refused')) })
  const channel = createChannel(ctx, session, launchOptions)
  channel.submit('queued')
  await settle(() => channel.pending.length === 1)
  check('C1 dock counted', channel.interruptAndDock() === 1)
  check('C1 a rejected interrupt un-docks the row', await settled(() => channel.pending.length === 1 && channel.pending[0]?.docked !== true), JSON.stringify(channel.pending))
  check('C1 the failure is notified', channel.notifications.some(item => item.text === t('claude-interrupt-failed')), JSON.stringify(channel.notifications))
  check('C1 nothing re-delivers over the live copy', channel.deliverDocked() === 0)
  check('C1 the SDK accepted exactly one copy of the intent', state.submits.filter(input => input.text === 'queued').length === 1, JSON.stringify(state.submits.map(input => input.text)))
  // Only a CONFIRMED-cancelled (docked) copy may be retracted locally
  // (B4): the un-docked row's backend copy still lives, so withdrawal
  // belongs to the backend — which this fixture (Claude shape) cannot do,
  // and the row stays queued rather than silently vanishing.
  check('C1 an un-docked row is not locally retractable', channel.removePending(channel.pending[0]?.id) === false && state.removePendingCalls.length === 0 && channel.pending.length === 1, JSON.stringify(channel.pending))
}
{
  // C2 — an older CLI answers no receipt (undefined → unknown) and keeps
  // its queue: same revocation, unconfirmed notice.
  const { session, state } = makeClaudeSession({ cancelReceipt: s => Promise.resolve({ stillQueued: s.submits.map(input => input.clientMessageId), outcome: 'unknown' }) })
  const channel = createChannel(ctx, session, launchOptions)
  channel.submit('old cli msg')
  await settle(() => channel.pending.length === 1)
  check('C2 dock counted', channel.interruptAndDock() === 1)
  check('C2 an answerless interrupt un-docks the row', await settled(() => channel.pending.length === 1 && channel.pending[0]?.docked !== true), JSON.stringify(channel.pending))
  check('C2 the unconfirmed dock is notified', channel.notifications.some(item => item.text === t('claude-interrupt-unconfirmed')), JSON.stringify(channel.notifications))
  check('C2 deliverDocked sends nothing', channel.deliverDocked() === 0)
  check('C2 exactly one copy accepted', state.submits.filter(input => input.text === 'old cli msg').length === 1, JSON.stringify(state.submits.map(input => input.text)))
}
{
  // C3 — generation boundary: rows docked while the receipt was in flight
  // sit outside its queue snapshot; even a confirmed-empty receipt cannot
  // vouch for them (they un-dock; the row the receipt DID cover stays).
  let release
  const { session, state } = makeClaudeSession({ cancelReceipt: () => new Promise(resolve => { release = resolve }) })
  const channel = createChannel(ctx, session, launchOptions)
  channel.submit('first batch')
  await settle(() => channel.pending.length === 1)
  check('C3 first dock counted', channel.interruptAndDock() === 1)
  channel.submit('during request')
  await settle(() => channel.pending.length === 2)
  check('C3 second dock parks without a second request', channel.interruptAndDock() === 1 && state.cancels.length === 1, JSON.stringify(state.cancels))
  release({ stillQueued: [], outcome: 'confirmed' })
  check('C3 covered row stays docked, uncovered row un-docks', await settled(() => {
    const covered = channel.pending.find(item => item.text === 'first batch')
    const uncovered = channel.pending.find(item => item.text === 'during request')
    return covered?.docked === true && uncovered?.docked !== true
  }), JSON.stringify(channel.pending))
  check('C3 the uncovered row is notified as unconfirmed', channel.notifications.some(item => item.text === t('claude-interrupt-unconfirmed')), JSON.stringify(channel.notifications))
  check('C3 only the confirmed-cancelled copy re-sends', channel.deliverDocked() === 1)
  const texts = () => state.submits.map(input => input.text)
  await settle(() => texts().length === 3)
  check('C3 the SDK saw the uncovered intent exactly once', texts().filter(text => text === 'during request').length === 1 && texts().filter(text => text === 'first batch').length === 2, JSON.stringify(texts()))
}
{
  // C4 — a later Esc whose predecessor's receipt already settled (the
  // abort still converging) fires its own request: every dock batch gets a
  // receipt that actually saw it.
  const receipts = [{ stillQueued: [], outcome: 'confirmed' }, { stillQueued: [], outcome: 'confirmed' }]
  const { session, state } = makeClaudeSession({ cancelReceipt: () => Promise.resolve(receipts.shift()) })
  const channel = createChannel(ctx, session, launchOptions)
  channel.submit('gen one')
  await settle(() => channel.pending.length === 1)
  channel.interruptAndDock()
  await flush()
  channel.submit('gen two')
  await settle(() => channel.pending.length === 2)
  check('C4 a new dock after the settled receipt fires its own request', channel.interruptAndDock() === 1 && state.cancels.length === 2, JSON.stringify(state.cancels))
  await flush()
  check('C4 both rows stay docked on their own confirmed receipts', channel.pending.length === 2 && channel.pending.every(item => item.docked === true), JSON.stringify(channel.pending))
  check('C4 both re-send exactly once', channel.deliverDocked() === 2)
  const texts = () => state.submits.map(input => input.text)
  await settle(() => texts().length === 4)
  check('C4 each intent ran once plus exactly one confirmed resend', texts().filter(text => text === 'gen one').length === 2 && texts().filter(text => text === 'gen two').length === 2, JSON.stringify(texts()))
}

process.exit(failed)
