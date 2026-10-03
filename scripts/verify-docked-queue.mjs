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
import { Writable, PassThrough } from 'node:stream'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { setLang, t } from '../lib/types/i18n.js'
import { settle, settled, sleep, findText } from './lib/term-test.mjs'

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

// ─────── Section D (R4-R1): a dock-row click never destroys the draft ────
// The blocker: clicking a docked row used to silently overwrite a non-empty
// draft (text, staged images AND the undo history). The fix is a lossless
// SWAP — the draft parks at the dock's tail while the clicked row comes
// into the input; nothing sends, Ctrl+Z swaps back. Channel level first
// (the primitive's own contract), then the real PromptInput round-trip.
{
  // D1 — the primitive trades one docked row for the draft, atomically.
  const { session, state } = makeClaudeSession()
  const channel = createChannel(ctx, session, launchOptions)
  channel.submit('dock me')
  await settle(() => channel.pending.length === 1)
  channel.interruptAndDock()
  await flush()
  const dockedId = channel.pending.find(item => item.docked === true)?.id
  const draftImages = [{ token: '[Image #1]', stageId: 'stage-1' }]
  check('D1 swap succeeds on a docked row', channel.swapDockedForDraft(dockedId, { text: 'valuable draft', images: draftImages }) === true)
  check('D1 the clicked row is gone, the draft parked as a NEW docked tail row',
    channel.pending.length === 1 && channel.pending[0]?.docked === true
      && channel.pending[0]?.text === 'valuable draft'
      && channel.pending[0]?.placement === 'followup'
      && JSON.stringify(channel.pending[0]?.images) === JSON.stringify(draftImages),
    JSON.stringify(channel.pending))
  check('D1 the parked row carries a local-only prefixed id',
    typeof channel.pending[0]?.id === 'string' && channel.pending[0].id.startsWith('dock-swap-'),
    channel.pending[0]?.id)
  check('D1 the swap sends nothing', state.submits.length === 1, JSON.stringify(state.submits.map(input => input.text)))

  // D2 — only a CONFIRMED-cancelled (docked) copy is swappable: an
  // un-docked row's backend copy still lives, so editing it away would
  // duplicate the intent (F2's fence, preserved by the swap).
  {
    const { session: s2, state: st2 } = makeClaudeSession({ stillQueuedOnInterrupt: true })
    const ch2 = createChannel(ctx, s2, launchOptions)
    ch2.submit('kept by cli')
    await settle(() => ch2.pending.length === 1)
    ch2.interruptAndDock()
    check('D2 an unconfirmed row is not swappable',
      await settled(() => ch2.pending.length === 1 && ch2.pending[0]?.docked !== true)
        && ch2.swapDockedForDraft(ch2.pending[0]?.id, { text: 'draft' }) === false
        && ch2.pending.length === 1 && ch2.pending[0]?.text === 'kept by cli',
      JSON.stringify(ch2.pending))
    check('D2 the refused swap sent nothing', st2.submits.length === 1, JSON.stringify(st2.submits.map(input => input.text)))
  }

  // D3 — the parked draft has NO backend copy: a receipt settling around
  // the swap must not un-dock it (the F2 fence governs rows the backend
  // may still hold; the swap row was never dispatched).
  {
    let release
    const { session: s3, state: st3 } = makeClaudeSession({ cancelReceipt: () => new Promise(resolve => { release = resolve }) })
    const ch3 = createChannel(ctx, s3, launchOptions)
    ch3.submit('covered row')
    await settle(() => ch3.pending.length === 1)
    ch3.interruptAndDock()
    const coveredId = ch3.pending.find(item => item.docked === true)?.id
    check('D3 swap while the receipt is in flight', ch3.swapDockedForDraft(coveredId, { text: 'parked draft' }) === true)
    release({ stillQueued: [], outcome: 'confirmed' })
    check('D3 the settled receipt keeps the parked draft docked',
      await settled(() => ch3.pending.length === 1 && ch3.pending[0]?.docked === true && ch3.pending[0]?.text === 'parked draft'),
      JSON.stringify(ch3.pending))
    check('D3 deliverDocked counts the parked draft', ch3.deliverDocked() === 1)
    const texts3 = () => st3.submits.map(input => input.text)
    await settle(() => texts3().length === 2)
    check('D3 each intent delivered exactly once (original + parked)',
      texts3().filter(text => text === 'parked draft').length === 1
        && texts3().filter(text => text === 'covered row').length === 1,
      JSON.stringify(texts3()))
  }

  // D4 — retirement events name the row they retire: a discard/claim for
  // the swapped-OUT id is a no-op, and the parked draft stays editable.
  {
    const { session: s4, state: st4, push } = makeClaudeSession()
    const ch4 = createChannel(ctx, s4, launchOptions)
    ch4.submit('to swap')
    await settle(() => ch4.pending.length === 1)
    ch4.interruptAndDock()
    await flush()
    const swappedOutId = ch4.pending.find(item => item.docked === true)?.id
    ch4.swapDockedForDraft(swappedOutId, { text: 'parked b' })
    push({ type: 'pending.changed', items: [], claimed: [], discarded: [swappedOutId] })
    check('D4 a discard naming the swapped-out id retires nothing (the row is gone)',
      ch4.pending.length === 1 && ch4.pending[0]?.docked === true && ch4.pending[0]?.text === 'parked b',
      JSON.stringify(ch4.pending))
    const parkedId = ch4.pending[0]?.id
    check('D4 the parked draft retracts locally',
      ch4.removePending(parkedId) === true && ch4.pending.length === 0,
      JSON.stringify(ch4.pending))
    check('D4 the discard caused no extra delivery', st4.submits.length === 1, JSON.stringify(st4.submits.map(input => input.text)))
  }
}

// ─── UI level (R4-R1): the real PromptInput swap round-trip (SGR click) ───
// FakeStdout paints a real xterm; the composer sits at the bottom of the
// frame so the OverlayAbove dock paints above the input row and an SGR
// click lands on the painted row.
const [ReactUI, { render: renderUI, AlternateScreen, Box }, xtermModule] = await Promise.all([
  import('react'),
  import('../lib/types/ui.js'),
  import('@xterm/headless'),
])
const XTermUI = xtermModule.Terminal ?? xtermModule.default?.Terminal
const { PromptInput: PromptInputUI } = await import('../lib/types/components/PromptInput.js')
const COLS_UI = 100
const ROWS_UI = 30
const termUI = new XTermUI({ cols: COLS_UI, rows: ROWS_UI, scrollback: 50, allowProposedApi: true })
class FakeStdoutUI extends Writable {
  columns = COLS_UI
  rows = ROWS_UI
  isTTY = true
  _write(chunk, _enc, cb) { termUI.write(String(chunk), cb) }
}
class FakeStderrUI extends Writable {
  isTTY = true
  _write(_c, _e, cb) { cb() }
}
class FakeStdinUI extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const uiStdout = new FakeStdoutUI()
const uiStderr = new FakeStderrUI()
const uiStdin = new FakeStdinUI()
const clickUI = (col, row) => {
  uiStdin.write('\x1b[<0;' + col + ';' + row + 'M')
  uiStdin.write('\x1b[<0;' + col + ';' + row + 'm')
}
const findUI = text => findText(termUI, text)

function makeUiChannel(initialPending, options = {}) {
  const notified = []
  const removed = []
  const swaps = []
  const discardedImages = []
  const staged = new Map([['stage-1', { id: 'stage-1', name: 'shot.png' }]])
  let pending = [...initialPending]
  let swapSeq = 0
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: () => [],
    notifications: [],
    contextWindow: undefined,
    cwd: '/tmp',
    get pending() { return pending },
    notify(text, notifyOptions) { notified.push({ text, options: notifyOptions }) },
    submit() {},
    steer() {},
    removePending(id) { removed.push(id); pending = pending.filter(item => item.id !== id); return true },
    swapDockedForDraft(id, draft) {
      if (options.refuseSwap === true) return false
      swaps.push({ id, text: draft.text })
      pending = pending.filter(item => item.id !== id)
      pending = [...pending, { id: 'ui-swap-' + ++swapSeq, text: draft.text, images: draft.images ?? [], placement: 'followup', docked: true }]
      return true
    },
    cancel() {},
    interruptAndDock() { return 0 },
    deliverDocked() { return 0 },
    interruptAndDeliver() { return 0 },
    listFiles: async () => [],
    stagedImageGeneration: () => 0,
    hasStagedImage: id => staged.has(id),
    stagedImage: id => staged.get(id),
    discardStagedImage(id) { discardedImages.push(id); staged.delete(id) },
    stageImage() {},
    notified,
    removed,
    swaps,
    discardedImages,
  }
}

const uiController = { current: null }
async function mountUI(channel) {
  const tree = ReactUI.createElement(AlternateScreen, null,
    ReactUI.createElement(Box, { height: ROWS_UI, flexDirection: 'column', justifyContent: 'flex-end' },
      ReactUI.createElement(PromptInputUI, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
        controllerRef: uiController,
      })))
  return renderUI(tree, { stdout: uiStdout, stderr: uiStderr, stdin: uiStdin, exitOnCtrlC: false, patchConsole: false })
}
const typeUI = async str => {
  for (const char of str) {
    uiStdin.write(char)
    // 固定窗:pacing 逐字符等待上一字符落入草稿（假 stdout 的帧由 xterm 消费，无文本锚点）
    await sleep(20)
  }
  await sleep(80) // 固定窗:pacing 让整段输入的末帧渲染落定
}

{
  // D5 — a valuable draft SWAPS with the clicked row (SGR click).
  const channel = makeUiChannel([
    { id: 'd1', text: 'dock-alpha', placement: 'followup', docked: true },
    { id: 'd2', text: 'dock-beta', placement: 'followup', docked: true },
  ])
  const instance = await mountUI(channel)
  check('D5 the dock paints above the input', await settled(() => findUI('dock-alpha') !== null))
  await typeUI('valuable draft')
  const pos = findUI('dock-alpha')
  if (pos) clickUI(pos.col + 3, pos.row + 1)
  check('D5 the clicked row lands in the input', await settled(() => uiController.current?.text() === 'dock-alpha'), JSON.stringify(uiController.current?.text()))
  check('D5 the draft parked at the dock tail as a docked row',
    channel.pending.length === 2 && channel.pending[1]?.docked === true && channel.pending[1]?.text === 'valuable draft'
      && channel.pending[0]?.id === 'd2',
    JSON.stringify(channel.pending.map(item => ({ id: item.id, text: item.text, docked: item.docked }))))
  check('D5 nothing was sent; the swap notice shows',
    channel.removed.length === 0 && channel.notified.some(n => n.text === t('input-dock-swapped')),
    JSON.stringify(channel.notified.map(n => n.text)))
  // D6 — Ctrl+Z swaps back byte-identically; the parked copy stays queued.
  uiStdin.write('\x1a')
  check('D6 Ctrl+Z restores the draft byte-identically', await settled(() => uiController.current?.text() === 'valuable draft'), JSON.stringify(uiController.current?.text()))
  check('D6 the parked copy stays in the dock', channel.pending.some(item => item.text === 'valuable draft' && item.docked === true), JSON.stringify(channel.pending.map(item => item.text)))
  instance.unmount()
}
{
  // D7 — a multi-line draft survives the round-trip unchanged.
  const channel = makeUiChannel([
    { id: 'd1', text: 'dock-multi', placement: 'followup', docked: true },
  ])
  const instance = await mountUI(channel)
  check('D7 dock painted', await settled(() => findUI('dock-multi') !== null))
  await typeUI('line1')
  uiStdin.write('\n') // bare LF = Ctrl+J newline insert (not Enter)
  await sleep(120) // 固定窗:pacing 等换行落定再续打第二行
  await typeUI('line2')
  check('D7 multi-line draft composed', uiController.current?.text() === 'line1\nline2', JSON.stringify(uiController.current?.text()))
  const pos = findUI('dock-multi')
  if (pos) clickUI(pos.col + 3, pos.row + 1)
  check('D7 swap took the row into the input', await settled(() => uiController.current?.text() === 'dock-multi'), JSON.stringify(uiController.current?.text()))
  check('D7 the parked copy keeps the newlines', channel.pending.some(item => item.text === 'line1\nline2'), JSON.stringify(channel.pending.map(item => item.text)))
  uiStdin.write('\x1a')
  check('D7 Ctrl+Z restores the multi-line draft losslessly', await settled(() => uiController.current?.text() === 'line1\nline2'), JSON.stringify(uiController.current?.text()))
  instance.unmount()
}
{
  // D8 — staged images ride the swap both ways; the capability survives.
  const channel = makeUiChannel([
    { id: 'd1', text: 'dock-img', placement: 'followup', docked: true },
    { id: 'img-src', text: '[Image #1]', images: [{ token: '[Image #1]', stageId: 'stage-1' }], placement: 'followup', docked: true },
  ])
  const instance = await mountUI(channel)
  check('D8 dock painted', await settled(() => findUI('dock-img') !== null))
  // Pull the image-bearing row with Alt+Up (newest docked row first).
  uiStdin.write('\x1b[1;3A')
  check('D8 the image draft pulled into the input', await settled(() => uiController.current?.text() === '[Image #1]'), JSON.stringify(uiController.current?.text()))
  check('D8 the binding is live before the swap', (uiController.current?.previewImages?.() ?? []).length === 1)
  await typeUI(' tail')
  const pos = findUI('dock-img')
  if (pos) clickUI(pos.col + 3, pos.row + 1)
  check('D8 swap landed', await settled(() => uiController.current?.text() === 'dock-img'), JSON.stringify(uiController.current?.text()))
  check('D8 the parked row carries the image refs',
    channel.pending.some(item => item.text === '[Image #1] tail'
      && JSON.stringify(item.images) === JSON.stringify([{ token: '[Image #1]', stageId: 'stage-1' }])),
    JSON.stringify(channel.pending.map(item => ({ text: item.text, images: item.images }))))
  check('D8 the capability was not discarded', !channel.discardedImages.includes('stage-1'), JSON.stringify(channel.discardedImages))
  uiStdin.write('\x1a')
  check('D8 Ctrl+Z restores the image draft', await settled(() => uiController.current?.text() === '[Image #1] tail'), JSON.stringify(uiController.current?.text()))
  check('D8 the restored binding is live', (uiController.current?.previewImages?.() ?? []).length === 1)
  instance.unmount()
}
{
  // D9 — an EMPTY draft keeps the plain retraction (no parked copy).
  const channel = makeUiChannel([
    { id: 'd1', text: 'dock-empty', placement: 'followup', docked: true },
  ])
  const instance = await mountUI(channel)
  check('D9 dock painted', await settled(() => findUI('dock-empty') !== null))
  const pos = findUI('dock-empty')
  if (pos) clickUI(pos.col + 3, pos.row + 1)
  check('D9 empty draft edits as before (plain retract)',
    await settled(() => uiController.current?.text() === 'dock-empty' && channel.removed.includes('d1')),
    JSON.stringify({ text: uiController.current?.text(), removed: channel.removed }))
  check('D9 no swap row was parked', !channel.pending.some(item => item.docked === true) && channel.swaps.length === 0, JSON.stringify(channel.pending))
  instance.unmount()
}
{
  // D10 — a refused swap (the row was claimed meanwhile) keeps the draft.
  const channel = makeUiChannel([
    { id: 'd1', text: 'dock-gone', placement: 'followup', docked: true },
  ], { refuseSwap: true })
  const instance = await mountUI(channel)
  check('D10 dock painted', await settled(() => findUI('dock-gone') !== null))
  await typeUI('keep me')
  const pos = findUI('dock-gone')
  if (pos) clickUI(pos.col + 3, pos.row + 1)
  check('D10 a refused swap keeps the draft untouched',
    await settled(() => uiController.current?.text() === 'keep me' && channel.notified.some(n => n.text === t('input-cannot-retract'))),
    JSON.stringify({ text: uiController.current?.text(), notified: channel.notified.map(n => n.text) }))
  instance.unmount()
}
process.exit(failed)
