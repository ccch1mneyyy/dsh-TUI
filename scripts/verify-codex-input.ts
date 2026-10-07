/**
 * Codex session input (docs/codex-backend-design.md §5.7, D8, D9, C0 V6) on
 * the fake app-server: the four placements, the client follow-up queue
 * (FIFO, one turn at a time), steer and its fallback, `now`, the claim of a
 * user row by its client id (nothing optimistic), a failed turn start,
 * retraction, cancel receipts for `user` / `interrupt` (unclaimed steers
 * re-queued or dropped), the forced settle of an unanswered interrupt,
 * images refused, dispose, connection loss and restore, and a resumed
 * thread's replay seed continuing into live numbering.
 *
 * Run: node --import tsx/esm scripts/verify-codex-input.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/agent/events.js'
import type { AgentInput } from '../src/agent/session.js'
import { setLang, t } from '../src/i18n.js'
import { FakeRpcError } from './lib/codex-fake-app-server.js'
import { CWD, openHarness, THREAD, threadAnswer, tick } from './lib/codex-session-harness.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const input = (id: string, text: string, extra: Partial<AgentInput> = {}): AgentInput => ({ text, clientMessageId: id, ...extra })
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// ── idle start, claim, queue, steer, now ────────────────────────────────
{
  const h = await openHarness()
  check('subscribe delivers session.ready and the start mode (backlog)', of(h.events(), 'session.ready')[0]?.sessionId === THREAD && of(h.events(), 'mode.changed')[0]?.modeId === 'auto')
  const thread = h.sent('thread/start')[0]!
  check('create: thread/start in the cwd with the default mode (auto = on-request + workspace-write)', thread.cwd === CWD && thread.approvalPolicy === 'on-request' && thread.sandbox === 'workspace-write' && thread.model === undefined)
  const result = await h.session.submit(input('c1', 'hello', { blocks: [{ type: 'text', text: 'hello' }, { type: 'text', text: '<attached file>' }] }), 'followup')
  const start = h.sent('turn/start')[0]!
  check('idle followup → turn/start with the client id', result.accepted && start.clientUserMessageId === 'c1' && start.threadId === THREAD)
  check('every text block is its own text input, typed text first', JSON.stringify(start.input) === JSON.stringify([{ type: 'text', text: 'hello', text_elements: [] }, { type: 'text', text: '<attached file>', text_elements: [] }]))
  check('D8: no user row before the server echoes the client id', of(h.events(), 'user.message').length === 0)
  await h.startTurn('turn-1', 'c1', 'hello')
  const claimBatch = h.batches.find(batch => batch.events.some(event => event.type === 'pending.changed'))
  check('the echoed client id claims the input, ahead of the user row in one batch', claimBatch !== undefined && claimBatch.events[0]!.type === 'pending.changed'
    && (claimBatch.events[0] as Extract<AgentEvent, { type: 'pending.changed' }>).claimed?.[0] === 'c1' && claimBatch.events.some(event => event.type === 'user.message' && event.id === 'c1'))
  // While the turn runs: two follow-ups queue; a steer joins.
  await h.session.submit(input('q1', 'first queued'), 'followup')
  await h.session.submit(input('q2', 'second queued'), 'turn')
  check('running: followup / turn wait in the client queue', h.sent('turn/start').length === 1)
  await h.session.submit(input('s1', 'steer me'), 'steer')
  const steer = h.sent('turn/steer')[0]!
  check('running: steer → turn/steer with the expected turn id and client id', steer.expectedTurnId === 'turn-1' && steer.clientUserMessageId === 's1')
  await h.notify('item/started', { turnId: 'turn-1', item: { type: 'userMessage', id: 'item-s1', clientId: 's1', content: [{ type: 'text', text: 'steer me', text_elements: [] }] } })
  check('a steer is claimed when its user message arrives (F10)', of(h.events(), 'pending.changed').some(event => event.claimed?.[0] === 's1') && of(h.events(), 'user.message').some(event => event.id === 's1'))
  await h.completeTurn('turn-1')
  await tick()
  const starts = h.sent('turn/start')
  check('FIFO: the first queued input starts after the turn completes, one at a time', starts.length === 2 && starts[1]!.clientUserMessageId === 'q1')
  await h.startTurn('turn-2', 'q1', 'first queued')
  await h.completeTurn('turn-2')
  await tick()
  check('FIFO: the next one follows the next completion', h.sent('turn/start').length === 3 && h.sent('turn/start')[2]!.clientUserMessageId === 'q2')
  await h.startTurn('turn-3', 'q2', 'second queued')
  // A refused steer falls back to the queue, said once.
  h.fake.on('turn/steer', () => { throw new FakeRpcError(-32600, 'cannot steer a compact turn') })
  await h.session.submit(input('s2', 'late steer'), 'steer')
  await h.session.submit(input('s3', 'another'), 'steer')
  check('a refused steer queues as a follow-up, with one notice', of(h.events(), 'notice').filter(event => event.text === t('codex-steer-fallback')).length === 1)
  // `now`: front of the queue + interrupt.
  await h.session.submit(input('n1', 'right now'), 'now')
  await tick()
  check('now → interrupt of the running turn', h.sent('turn/interrupt').at(-1)?.turnId === 'turn-3')
  await h.completeTurn('turn-3', 'interrupted')
  await tick()
  check('now → its input runs first after the interrupt', h.sent('turn/start').at(-1)?.clientUserMessageId === 'n1')
  check('retraction: a queued input can be pulled back, a sent one cannot', h.session.capabilities.pendingRetraction?.remove('s3') === true && h.session.capabilities.pendingRetraction?.remove('n1') === false)
  await h.session.dispose()
}

// ── cancel receipts ─────────────────────────────────────────────────────
{
  const h = await openHarness()
  await h.session.submit(input('c1', 'go'), 'followup')
  await h.startTurn('turn-1', 'c1', 'go')
  await h.session.submit(input('s1', 'unclaimed steer'), 'steer')
  await h.session.submit(input('q1', 'queued'), 'followup')
  const receipt = await h.session.cancel('user')
  check('cancel(user): interrupts the turn', h.sent('turn/interrupt')[0]?.turnId === 'turn-1')
  check('cancel(user): confirmed, the unclaimed steer and the queue still run', receipt.outcome === 'confirmed' && JSON.stringify(receipt.stillQueued) === '["s1","q1"]', receipt)
  await h.completeTurn('turn-1', 'interrupted')
  await tick()
  check('V6: after the interrupt the dropped steer runs first, then the queue', h.sent('turn/start').at(-1)?.clientUserMessageId === 's1')
  await h.startTurn('turn-2', 's1', 'unclaimed steer')
  await h.session.submit(input('s2', 'steer two'), 'steer')
  await h.session.submit(input('q2', 'queued two'), 'followup')
  const drop = await h.session.cancel('interrupt')
  check('cancel(interrupt): confirmed with nothing still queued', drop.outcome === 'confirmed' && drop.stillQueued.length === 0)
  check('cancel(interrupt): the queue is discarded (q1, q2)', of(h.events(), 'pending.changed').some(event => JSON.stringify(event.discarded) === '["q1","q2"]'))
  await h.completeTurn('turn-2', 'interrupted')
  await tick()
  check('cancel(interrupt): the unclaimed steer is discarded at the turn end', of(h.events(), 'pending.changed').some(event => event.discarded?.includes('s2') === true))
  check('cancel(interrupt): nothing starts afterwards', h.sent('turn/start').length === 2)
  // A completed turn records a steer it never echoed: claimed, not lost.
  await h.session.submit(input('c3', 'third'), 'followup')
  await h.startTurn('turn-3', 'c3', 'third')
  await h.session.submit(input('s3', 'quiet steer'), 'steer')
  await h.completeTurn('turn-3')
  check('a steer still unclaimed at a completed turn end is claimed', of(h.events(), 'pending.changed').some(event => event.claimed?.includes('s3') === true))
  // An interrupt nobody answers is settled here after the force window.
  await h.session.submit(input('c4', 'stuck'), 'followup')
  await h.startTurn('turn-4', 'c4', 'stuck')
  await h.session.submit(input('q4', 'after stuck'), 'followup')
  await h.session.cancel('user')
  h.clock.advance(15_000)
  await tick()
  check('forced settle: the turn closes interrupted with a notice, the queue moves on', of(h.events(), 'turn.end').at(-1)?.reason.kind === 'interrupted' && of(h.events(), 'notice').some(event => event.text === t('codex-cancel-forced')) && h.sent('turn/start').at(-1)?.clientUserMessageId === 'q4')
  // The server's late traffic for the force-settled turn opens no phantom turn.
  const startsBefore = of(h.events(), 'turn.start').length
  const endsBefore = of(h.events(), 'turn.end').length
  await h.notify('item/started', { turnId: 'turn-4', item: { type: 'agentMessage', id: 'late-1', text: '' } })
  await h.notify('item/agentMessage/delta', { turnId: 'turn-4', itemId: 'late-1', delta: 'late words' })
  await h.notify('item/completed', { turnId: 'turn-4', item: { type: 'agentMessage', id: 'late-1', text: 'late words' } })
  await h.notify('turn/completed', { turn: { id: 'turn-4', items: [], status: 'interrupted', error: null } })
  await tick()
  check('forced settle: a late item / delta / completion of the settled turn is dropped (no phantom turn)', of(h.events(), 'turn.start').length === startsBefore && of(h.events(), 'turn.end').length === endsBefore
    && !h.events().some(event => event.type === 'assistant.delta' || (event.type === 'assistant.message' && JSON.stringify(event).includes('late words'))), h.events().slice(-6))
  await h.session.dispose()
}

// ── `now` beats a pending steer (review fix) ────────────────────────────
{
  const h = await openHarness()
  await h.session.submit(input('c1', 'go'), 'followup')
  await h.startTurn('turn-1', 'c1', 'go')
  await h.session.submit(input('s1', 'unclaimed steer'), 'steer')
  await h.session.submit(input('n1', 'right now'), 'now')
  await tick()
  check('now + pending steer: the running turn is interrupted', h.sent('turn/interrupt').at(-1)?.turnId === 'turn-1')
  await h.completeTurn('turn-1', 'interrupted')
  await tick()
  check('now + pending steer: `now` starts first, the dropped steer after it', h.sent('turn/start').at(-1)?.clientUserMessageId === 'n1', h.sent('turn/start').map(start => start.clientUserMessageId))
  await h.startTurn('turn-2', 'n1', 'right now')
  await h.completeTurn('turn-2')
  await tick()
  check('now + pending steer: the steer runs next', h.sent('turn/start').at(-1)?.clientUserMessageId === 's1', h.sent('turn/start').map(start => start.clientUserMessageId))
  await h.session.dispose()
}

// ── failures, images, dispose ───────────────────────────────────────────
{
  const h = await openHarness()
  h.fake.on('turn/start', () => { throw new FakeRpcError(-32602, 'bad input') })
  const refused = await h.session.submit(input('x1', 'nope'), 'followup')
  check('a failed turn/start: not accepted, with a reason, and discarded', !refused.accepted && refused.reason?.includes('bad input') === true && of(h.events(), 'pending.changed').some(event => event.discarded?.[0] === 'x1'))
  const images = await h.session.submit(input('i1', 'pic', { blocks: [{ type: 'text', text: 'pic' }, { type: 'image' }] }), 'followup').catch((error: unknown) => (error as Error).message)
  check('image blocks without readable facades are refused explicitly', images === t('codex-image-unreadable', { name: 'i1' }))
  await h.session.dispose()
  check('dispose: unsubscribes and reports disposed', h.sent('thread/unsubscribe')[0]?.threadId === THREAD && h.session.status === 'disposed')
  const after = await h.session.submit(input('z', 'late'), 'followup').catch((error: unknown) => (error as Error).message)
  check('submit after dispose rejects', after === t('codex-session-closed'))
  check('dispose twice is a no-op', (await h.session.dispose(), true))
}

{
  const h = await openHarness()
  await h.session.submit(input('c1', 'go'), 'followup')
  await h.startTurn('turn-1', 'c1', 'go')
  const disposing = h.session.dispose()
  await disposing
  check('dispose during a turn interrupts it first', h.sent('turn/interrupt')[0]?.turnId === 'turn-1')
}

// ── connection loss and restore ─────────────────────────────────────────
{
  const h = await openHarness()
  await h.session.submit(input('c1', 'go'), 'followup')
  await h.startTurn('turn-1', 'c1', 'go')
  await h.session.submit(input('q1', 'waits'), 'followup')
  h.fake.on('thread/resume', () => threadAnswer({ initialTurnsPage: { data: [{ id: 'turn-1', status: 'completed', itemsView: 'full', items: [{ type: 'userMessage', id: 'item-c1', clientId: 'c1', content: [{ type: 'text', text: 'go', text_elements: [] }] }] }], nextCursor: null } }))
  h.fake.crash({ code: 9 })
  await tick()
  check('connection lost: the open native turn survives until recovery without a fabricated failure', of(h.events(), 'turn.end').length === 0 && of(h.events(), 'notice').some(event => event.text === t('codex-connection-lost')) && h.session.status === 'running')
  await h.session.submit(input('q2', 'while down'), 'followup')
  h.clock.advance(500)
  await tick()
  await h.hub.ready
  await tick()
  await tick()
  check('restore: the thread is resumed on the new child', h.fake.requests.filter(request => request.method === 'thread/resume' && request.generation === 2).length === 1)
  check('restore: a reconnected notice and the queue drains', of(h.events(), 'notice').some(event => event.text === t('codex-reconnected')) && h.sent('turn/start').at(-1)?.clientUserMessageId === 'q1')
  await h.session.dispose()
}

// ── resume: the replay seed and continued numbering ────────────────────
{
  const turns = [
    { id: 'old-2', status: 'completed', itemsView: 'full', startedAt: 1, completedAt: 2, error: null, items: [{ type: 'userMessage', id: 'u2', clientId: 'k2', content: [{ type: 'text', text: 'second', text_elements: [] }] }, { type: 'agentMessage', id: 'm2', text: 'two', phase: 'final_answer' }] },
    { id: 'old-1', status: 'completed', itemsView: 'full', startedAt: 0, completedAt: 1, error: null, items: [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'first', text_elements: [] }] }, { type: 'agentMessage', id: 'm1', text: 'one', phase: 'final_answer' }] },
  ]
  const h = await openHarness({ resume: threadAnswer({ initialTurnsPage: { data: turns, nextCursor: 'older', backwardsCursor: null }, turnsBackwardsCursor: 'older' }) })
  const resume = h.sent('thread/resume')[0]!
  check('resume: the newest page in full, without turns in the thread', resume.excludeTurns === true && JSON.stringify(resume.initialTurnsPage) === '{"limit":20,"sortDirection":"desc","itemsView":"full"}')
  const history = await h.session.history()
  const users = of(history, 'user.message')
  check('resume: history replays oldest first (ids: client id, else item id)', users.map(event => event.text).join(',') === 'first,second' && users[0]!.id === 'u1' && users[1]!.id === 'k2')
  check('resume: history() hands the seed over once', (await h.session.history()).length === 0)
  await h.session.submit(input('c9', 'next'), 'followup')
  await h.startTurn('turn-9', 'c9', 'next')
  check('resume: live numbering continues after the replay', of(h.events(), 'turn.start').at(-1)?.turn === 3)
  await h.session.dispose()
}

console.log(`\nverify-codex-input OK (${passed} checks)`)
