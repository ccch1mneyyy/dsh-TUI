/**
 * The shared permission store and its channel bridge (docs/agent-backend-design.md
 * §4.7, §8.4), without a backend:
 *
 *  - FIFO: parallel prompts park, one is on the panel, the next surfaces when
 *    it settles; a duplicate request id is refused;
 *  - options: the snapshot carries the backend's options; `defaultToNo`
 *    sorts the rejection first; `suppressAlwaysAllow` / a forcing ask rule
 *    hide allow-always (defence in depth on top of the backend);
 *  - outcomes: allow-once / allow-always (with the option id) / rejected
 *    (with the typed reason) reach the settle callback with a decision; a
 *    choice the prompt never offered is refused as a rejection;
 *  - withdrawal: `withdraw` (the backend took it back), `withdrawSession`
 *    (the session left) and `settleAll` (teardown) settle `cancelled` with
 *    no decision — the backend is never answered twice;
 *  - a settle callback that throws does not wedge the queue;
 *  - the interaction bridge: `permission.request` parks, the panel decision
 *    reaches `capabilities.permissions.respond`, `permission.settled` closes
 *    the panel without answering; `question.request` asks the QuestionStore
 *    (answers by question order → `questions.respond`, the user's dismissal →
 *    `questions.cancel`, a backend withdrawal → neither); `release` withdraws
 *    everything the session parked.
 *
 * Run: node --import tsx/esm scripts/verify-permission-store.ts
 */
import assert from 'node:assert/strict'
import type { PermissionDecision, QuestionAnswers } from '../src/agent/capabilities.js'
import type { PermissionOutcome, PermissionRequestView } from '../src/agent/events.js'
import { attachInteraction } from '../src/channel/interaction.js'
import { PermissionStore, visiblePermissionOptions } from '../src/channel/permissions.js'
import { QuestionInterruptedError, QuestionStore } from '../src/channel/questions.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const view = (requestId: string, extra: Partial<PermissionRequestView> = {}): PermissionRequestView => ({
  requestId,
  toolName: 'Write',
  callId: `toolu_${requestId}`,
  command: `file-${requestId}.txt`,
  options: [
    { id: 'allow-once', kind: 'allow-once' },
    { id: 'allow-always', kind: 'allow-always', label: 'auto-accept edits' },
    { id: 'reject', kind: 'reject' },
  ],
  ...extra,
})

type Settled = { requestId: string; outcome: PermissionOutcome; decision?: PermissionDecision }

// ── FIFO, options, outcomes ───────────────────────────────────────────
{
  const store = new PermissionStore()
  const settled: Settled[] = []
  let notified = 0
  store.subscribe(() => { notified += 1 })
  const park = (requestId: string, extra: Partial<PermissionRequestView> = {}, sessionId = 's1'): void => {
    store.park({ sessionId, request: view(requestId, extra), settle: (outcome, decision) => settled.push({ requestId, outcome, ...(decision === undefined ? {} : { decision }) }) })
  }
  check('idle store has no panel', store.getSnapshot() === null)
  park('r1')
  park('r2')
  park('r3')
  const first = store.getSnapshot()
  check('the first prompt is on the panel', first?.toolName === 'Write' && first.command === 'file-r1.txt' && first.agentId === 's1' && notified > 0)
  check('the snapshot reference is stable between mutations', store.getSnapshot() === first)
  check('pending lists every parked prompt in park order', store.pending().map(request => request.requestId).join() === 'r1,r2,r3')
  check('options pass through', JSON.stringify(first?.options?.map(option => option.kind)) === JSON.stringify(['allow-once', 'allow-always', 'reject']))
  store.decide('allowed-once', { optionId: 'allow-once', kind: 'allow-once' })
  check('allow-once settles with its decision', settled[0]?.requestId === 'r1' && settled[0].outcome === 'allow-once' && settled[0].decision?.kind === 'allow-once')
  check('FIFO: the second prompt surfaces next', store.getSnapshot()?.command === 'file-r2.txt' && store.getSnapshot()?.key !== first?.key)
  store.decide('allowed-always', { optionId: 'allow-always', kind: 'allow-always' })
  check('allow-always settles with the picked option', settled[1]?.outcome === 'allow-always' && settled[1].decision?.kind === 'allow-always' && 'optionId' in settled[1].decision && settled[1].decision.optionId === 'allow-always')
  store.decide('rejected', { optionId: 'reject', kind: 'reject', feedback: '  use the tmp dir instead  ' })
  check('a rejection carries the trimmed reason', settled[2]?.outcome === 'rejected' && settled[2].decision?.kind === 'reject' && settled[2].decision.message === 'use the tmp dir instead')
  check('the queue drained', store.getSnapshot() === null && store.pending().length === 0)

  park('r4', { options: [{ id: 'allow-once', kind: 'allow-once' }, { id: 'reject', kind: 'reject' }] })
  store.decide('allowed-always', { optionId: 'allow-always', kind: 'allow-always' })
  check('an option the prompt never offered is refused as a rejection', settled[3]?.outcome === 'rejected' && settled[3].decision?.kind === 'reject')
  park('r5')
  store.decide('rejected')
  check('a bare rejection (Esc) carries no reason', settled[4]?.outcome === 'rejected' && settled[4].decision?.kind === 'reject' && settled[4].decision.message === undefined)

  park('dup')
  park('dup')
  check('a duplicate request id is refused as cancelled', settled[5]?.requestId === 'dup' && settled[5].outcome === 'cancelled' && settled[5].decision === undefined && store.pending().length === 1)
  store.decide('allowed-once')
  check('a bare outcome picks its kind', settled[6]?.outcome === 'allow-once')
}

// ── option presentation rules ─────────────────────────────────────────
{
  const options = view('x').options
  check('defaultToNo puts the rejection first', visiblePermissionOptions({ options, defaultToNo: true })[0]?.kind === 'reject')
  check('suppressAlwaysAllow hides allow-always', !visiblePermissionOptions({ options, suppressAlwaysAllow: true }).some(option => option.kind === 'allow-always'))
  check('a forcing ask rule hides allow-always', !visiblePermissionOptions({ options, matchedAskRule: true }).some(option => option.kind === 'allow-always'))
  check('no options = the two DSH rows', JSON.stringify(visiblePermissionOptions({}).map(option => option.kind)) === JSON.stringify(['allow-once', 'reject']))
  const store = new PermissionStore()
  store.park({ sessionId: 's', request: view('y', { defaultToNo: true, suppressAlwaysAllow: true, agentId: 'agent-7', blockedPath: '../outside', feedback: true }), settle: () => undefined })
  const snapshot = store.getSnapshot()
  check('the snapshot carries the presentation flags', snapshot?.defaultToNo === true && snapshot.suppressAlwaysAllow === true && snapshot.subagentId === 'agent-7' && snapshot.blockedPath === '../outside' && snapshot.feedback === true)
}

// ── withdrawal, session release, teardown, throwing callbacks ─────────
{
  const store = new PermissionStore()
  const settled: Settled[] = []
  const park = (requestId: string, sessionId: string): void => {
    store.park({ sessionId, request: view(requestId), settle: (outcome, decision) => settled.push({ requestId, outcome, ...(decision === undefined ? {} : { decision }) }) })
  }
  park('a1', 'A')
  park('b1', 'B')
  park('a2', 'A')
  check('withdraw of a queued prompt keeps the active one', store.withdraw('A', 'a2') && store.getSnapshot()?.command === 'file-a1.txt' && settled[0]?.outcome === 'cancelled' && settled[0].decision === undefined)
  check('withdraw of the active prompt surfaces the next', store.withdraw('A', 'a1') && store.getSnapshot()?.command === 'file-b1.txt')
  check('withdraw of an unknown prompt is a no-op', !store.withdraw('A', 'nope'))
  check('request ids are scoped by session', !store.withdraw('A', 'b1') && store.getSnapshot() !== null)
  park('a3', 'A')
  check('pendingAgentIds lists asking sessions', JSON.stringify(store.pendingAgentIds()) === JSON.stringify(['B', 'A']))
  check('pendingAgentDetail summarizes the first ask', store.pendingAgentDetail('A')?.command === 'file-a3.txt')
  store.withdrawSession('B')
  check('withdrawSession settles that session\'s prompts only', store.getSnapshot()?.command === 'file-a3.txt' && settled.some(entry => entry.requestId === 'b1' && entry.outcome === 'cancelled'))
  store.park({ sessionId: 'A', request: view('boom'), settle: () => { throw new Error('owner failed') } })
  store.settleAll()
  check('settleAll cancels everything, a throwing callback included', store.getSnapshot() === null && store.pending().length === 0 && settled.some(entry => entry.requestId === 'a3' && entry.outcome === 'cancelled'))
  park('after', 'A')
  check('the store keeps working after a throwing callback', store.getSnapshot()?.command === 'file-after.txt')
}

// ── the channel bridge ────────────────────────────────────────────────
{
  const permissions = new PermissionStore()
  const questions = new QuestionStore()
  const responses: { requestId: string; decision: PermissionDecision }[] = []
  const answers: { requestId: string; answers: QuestionAnswers }[] = []
  const cancels: string[] = []
  const session = {
    sessionId: 'claude-1',
    capabilities: {
      permissions: { respond: (requestId: string, decision: PermissionDecision) => { responses.push({ requestId, decision }) }, pending: () => [] },
      questions: {
        respond: (requestId: string, value: QuestionAnswers) => { answers.push({ requestId, answers: value }) },
        cancel: (requestId: string) => { cancels.push(requestId) },
      },
    },
  }
  const link = attachInteraction({ permissions, questions, debug: () => undefined }, session)
  link.apply([{ type: 'permission.request', request: view('p1') }])
  check('permission.request parks on the panel', permissions.getSnapshot()?.command === 'file-p1.txt' && permissions.getSnapshot()?.agentId === 'claude-1')
  permissions.decide('allowed-always', { optionId: 'allow-always', kind: 'allow-always' })
  check('the panel decision reaches permissions.respond', responses.length === 1 && responses[0]!.requestId === 'p1' && responses[0]!.decision.kind === 'allow-always')
  link.apply([{ type: 'permission.settled', requestId: 'p1', outcome: 'allow-always' }])
  check('the backend settlement after a decision is a no-op', responses.length === 1)
  link.apply([{ type: 'permission.request', request: view('p2') }])
  link.apply([{ type: 'permission.settled', requestId: 'p2', outcome: 'cancelled' }])
  check('a backend withdrawal closes the panel without answering', permissions.getSnapshot() === null && responses.length === 1)

  link.apply([{ type: 'question.request', request: { requestId: 'q1', callId: 'toolu_q', questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'red' }, { label: 'blue' }] },
    { question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }], multiSelect: true },
  ] } }])
  const shown = questions.getSnapshot()
  check('question.request shows the questionnaire', shown?.question.question === 'Which color?' && shown.question.id === '0' && shown.total === 2)
  questions.answerCurrent({ selected: ['blue'] })
  questions.answerCurrent({ selected: ['S', 'M'], custom: 'and XL' })
  await tick()
  check('answers by question order reach questions.respond', answers.length === 1 && answers[0]!.requestId === 'q1'
    && JSON.stringify(answers[0]!.answers.answers) === JSON.stringify([{ selected: ['blue'] }, { selected: ['S', 'M'], custom: 'and XL' }]), answers)

  link.apply([{ type: 'question.request', request: { requestId: 'q2', questions: [{ question: 'Proceed?', options: [{ label: 'yes' }] }] } }])
  questions.cancelCurrent()
  await tick()
  check('the user dismissal reaches questions.cancel', cancels.length === 1 && cancels[0] === 'q2')
  link.apply([{ type: 'question.request', request: { requestId: 'q3', questions: [{ question: 'Later?', options: [{ label: 'ok' }] }] } }])
  link.apply([{ type: 'question.settled', requestId: 'q3' }])
  await tick()
  check('a backend withdrawal closes the questionnaire without answering', questions.getSnapshot() === null && cancels.length === 1 && answers.length === 1)

  link.apply([{ type: 'question.request', request: { requestId: 'plan', questions: [{ question: 'Approve?', detail: '# Plan', options: [{ label: 'Go' }, { label: 'Go manual' }, { label: 'Keep' }], intent: { kind: 'plan-review', approve: 'Go', approveAlso: ['Go manual'], decline: 'Keep' } }] } }])
  check('a plan review keeps its intent and detail', questions.getSnapshot()?.question.intent?.kind === 'plan-review' && questions.getSnapshot()?.question.detail === '# Plan')
  link.apply([{ type: 'permission.request', request: view('p3') }])
  link.release()
  await tick()
  check('release withdraws every prompt and ask of the session', permissions.getSnapshot() === null && questions.getSnapshot() === null && responses.length === 1 && cancels.length === 1)
  link.apply([{ type: 'permission.request', request: view('p4') }])
  check('a released link ignores later events', permissions.getSnapshot() === null)
}

// ── the shared QuestionStore keeps its contract ───────────────────────
{
  const store = new QuestionStore()
  const asked = store.ask({ questions: [{ id: 'a', question: 'One?' }] })
  store.cancelCurrent()
  const error = await asked.then(() => undefined, (reason: unknown) => reason)
  check('a user cancel rejects with ASK_CANCELLED', error instanceof QuestionInterruptedError && error.code === 'ASK_CANCELLED')
  const controller = new AbortController()
  const aborted = store.ask({ questions: [{ id: 'b', question: 'Two?' }], signal: controller.signal })
  controller.abort()
  const abortError = await aborted.then(() => undefined, (reason: unknown) => reason)
  check('an asker abort rejects with ASK_ABORTED', abortError instanceof QuestionInterruptedError && abortError.code === 'ASK_ABORTED')
  const custom = new QuestionStore({ interruption: (message, code) => Object.assign(new Error(message), { code, custom: true }) })
  const injected = custom.ask({ questions: [{ id: 'c', question: 'Three?' }] })
  custom.rejectAll()
  const injectedError = await injected.then(() => undefined, (reason: unknown) => reason) as { custom?: boolean; code?: string }
  check('the interruption error is injectable (the DSH protocol error)', injectedError.custom === true && injectedError.code === 'ASK_ABORTED')
}

console.log(`\nverify-permission-store OK (${passed} checks)`)
