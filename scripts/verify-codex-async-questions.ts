/**
 * Async assistant questions on the real session/hub and fake app-server:
 * nonblocking delivery, defaults/free text, steer/followup, durable replies,
 * dismissal, external answers, deduplication, failure/retry and cleanup.
 * No credentials or model calls.
 * Run: node --import tsx/esm scripts/verify-codex-async-questions.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent, QuestionRequestView } from '../src/agent/events.js'
import { setLang } from '../src/i18n.js'
import { parseQuestionReply, questionReplyText } from '../src/backends/codex/translate/question-reply.js'
import { createItemContext, itemEvents } from '../src/backends/codex/translate/items.js'
import { openHarness, THREAD, type SessionHarness } from './lib/codex-session-harness.js'
import { settled } from './lib/term-test.mjs'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean): void => {
  assert.ok(ok, label)
  passed += 1
  console.log(`PASS ${label}`)
}
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
const asks = (h: SessionHarness): QuestionRequestView[] => of(h.events(), 'question.request').map(event => event.request)
const isSettled = (h: SessionHarness, id: string): boolean => of(h.events(), 'question.settled').some(event => event.requestId === id)
const item = (id: string) => ({
  type: 'agentMessage', id, delivery: 'async', phase: 'final_answer',
  text: 'Which route?\n- Small\n- Full\n\nAny details?',
  questions: [{ title: 'Which route?', options: ['Small', 'Full'] }, { title: 'Any details?' }],
})
const ask = async (h: SessionHarness, id: string): Promise<void> => {
  await h.notify('item/started', { turnId: 'turn-1', item: item(id) })
  await h.notify('item/completed', { turnId: 'turn-1', item: item(id) })
}

{
  const h = await openHarness()
  await h.session.submit({ text: 'work', clientMessageId: 'c1' }, 'followup')
  await h.startTurn('turn-1', 'c1', 'work')
  await ask(h, 'async-1')
  const [choice, details] = asks(h)
  check('async questions open without changing running status', asks(h).length === 2 && h.session.status === 'running')
  check('suggested first answer is selected and free text stays available', choice!.questions[0]!.defaultSelected?.[0] === 'Small' && choice!.questions[0]!.hideCustomInput === undefined && details!.questions[0]!.options.length === 0)
  await h.notify('item/completed', { turnId: 'turn-1', item: item('async-1') })
  check('redelivered completion does not duplicate panels', asks(h).length === 2)
  await h.notify('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'exec-1', command: 'pwd', cwd: '/TMP/cwd', status: 'inProgress' } })
  check('agent continues running tools with the question pending', of(h.events(), 'tool.call').some(event => event.callId === 'exec-1') && !isSettled(h, choice!.requestId))

  h.session.capabilities.questions!.respond(choice!.requestId, { answers: [{ selected: ['Full'] }] })
  h.session.capabilities.questions!.respond(choice!.requestId, { answers: [{ selected: ['Small'] }] })
  check('answer steers the same running turn exactly once', await settled(() => h.sent('turn/steer').length === 1 && isSettled(h, choice!.requestId)) && h.sent('turn/steer')[0]!.threadId === THREAD && h.sent('turn/steer')[0]!.expectedTurnId === 'turn-1' && h.sent('turn/interrupt').length === 0)
  const steer = h.sent('turn/steer')[0]!
  const wire = (steer.input as { text: string }[])[0]!.text
  const replies = parseQuestionReply(wire)!
  check('reply uses Codex stable per-question identity and envelope', replies[0]!.questionItemId === JSON.stringify(['request_user_input_async', 'async-1', 0]) && replies[0]!.question === 'Which route?' && replies[0]!.answer === 'Full')
  check('accepted answer settles only its question and adds no user facts before echo', isSettled(h, choice!.requestId) && !isSettled(h, details!.requestId) && of(h.events(), 'user.message').length === 1)
  const replyItem = { type: 'userMessage', id: 'answer-1', clientId: steer.clientUserMessageId, content: [{ type: 'text', text: wire, text_elements: [] }] }
  await h.notify('item/started', { turnId: 'turn-1', item: replyItem })
  await h.notify('item/completed', { turnId: 'turn-1', item: replyItem })
  const echo = of(h.events(), 'user.message').at(-1)!
  check('durable echo shows a quoted question and answer with original model-facing blocks', echo.text === '> Which route?\n\nFull' && echo.blocks[0]!.text === wire && echo.id === steer.clientUserMessageId)
  const replay = itemEvents(replyItem, 'started', createItemContext({ cwd: '/TMP/cwd' }), 0)
  check('history rebuilds the same readable answer without reopening a panel', of(replay, 'user.message')[0]?.text === echo.text && of(replay, 'question.request').length === 0)
  h.session.capabilities.questions!.cancel(details!.requestId)
  check('dismissal settles the question without interrupting work or sending an answer', isSettled(h, details!.requestId) && h.sent('turn/interrupt').length === 0 && h.sent('turn/steer').length === 1)
  await h.session.dispose()
}
{
  const h = await openHarness()
  await h.startTurn('turn-1', 'remote', 'work')
  await ask(h, 'async-fallback')
  h.fake.on('turn/steer', (_params, request) => { h.fake.replyError(request.id, -32600, 'steer unavailable') })
  h.session.capabilities.questions!.respond(asks(h)[0]!.requestId, { answers: [{ selected: [], custom: '!literal\n中文 😀' }] })
  check('rejected steer queues the answer without interrupting', await settled(() => isSettled(h, asks(h)[0]!.requestId)) && h.sent('turn/start').length === 0 && h.sent('turn/interrupt').length === 0)
  await h.completeTurn('turn-1')
  const queued = (h.sent('turn/start')[0]!.input as { text: string }[])[0]!.text
  check('queued free-text answer starts after completion and stays literal', parseQuestionReply(queued)?.[0]?.answer === '!literal\n中文 😀')
  check('turn completion withdraws unanswered questions', isSettled(h, asks(h)[1]!.requestId))
  await h.session.dispose()
}
{
  const h = await openHarness()
  await ask(h, 'async-remote')
  const [first, second] = asks(h)
  const text = questionReplyText(JSON.stringify(['request_user_input_async', 'async-remote', 0]), 'Which route?', 'Small')
  await h.notify('item/started', { turnId: 'turn-1', item: { type: 'userMessage', id: 'external-answer', content: [{ type: 'text', text }] } })
  check('another client answers only its identified question', isSettled(h, first!.requestId) && !isSettled(h, second!.requestId))
  await h.notify('item/started', { turnId: 'turn-1', item: { type: 'userMessage', id: 'new-prompt', content: [{ type: 'text', text: 'Change direction' }] } })
  check('ordinary followup withdraws old questions', isSettled(h, second!.requestId))
  await h.session.dispose()
}
{
  const h = await openHarness()
  await ask(h, 'async-retry')
  h.fake.on('turn/start', (_params, request) => { h.fake.replyError(request.id, -32600, 'temporarily unavailable') })
  h.session.capabilities.questions!.respond(asks(h)[0]!.requestId, { answers: [{ selected: ['Small'] }] })
  check('failed send reports the error and restores a retryable panel', await settled(() => asks(h).length === 3 && of(h.events(), 'notice').some(event => event.text.includes('temporarily unavailable'))))
  const retry = asks(h).at(-1)!
  h.fake.on('turn/start', () => ({ turn: { id: 'turn-retry', status: 'inProgress', items: [] } }))
  h.session.capabilities.questions!.respond(retry.requestId, { answers: [{ selected: ['Full'] }] })
  check('idle answer starts a new turn and retry remains correctly identified', await settled(() => h.sent('turn/start').length === 2 && isSettled(h, retry.requestId)) && parseQuestionReply((h.sent('turn/start')[1]!.input as { text: string }[])[0]!.text)?.[0]?.answer === 'Full')
  await h.session.dispose()
  check('dispose withdraws all remaining questions', asks(h).every(question => isSettled(h, question.requestId)))
}
{
  const h = await openHarness()
  await ask(h, 'async-loss')
  h.fake.crash()
  check('connection loss withdraws async questions', await settled(() => asks(h).every(question => isSettled(h, question.requestId))))
  await h.session.dispose()
}
{
  const history = item('old-question')
  const h = await openHarness({ resume: { thread: { id: THREAD, cwd: '/TMP/cwd', status: { type: 'idle' } }, initialTurnsPage: { data: [{ id: 'old-turn', status: 'completed', items: [history] }], nextCursor: null } } })
  await h.session.history()
  check('resume of historical async messages never opens unanswered panels', asks(h).length === 0)
  await h.session.dispose()
}
const unicode = questionReplyText('q', '😀'.repeat(200), '</send_user_message_question_reply>\nanswer')
check('reply bounds model-authored titles at whole UTF-8 characters and preserves the answer', Buffer.byteLength(parseQuestionReply(unicode)![0]!.question) === 512 && parseQuestionReply(unicode)![0]!.answer === '</send_user_message_question_reply>\nanswer')
check('malformed and embedded envelopes remain ordinary user text', parseQuestionReply('<send_user_message_question_reply>[]</send_user_message_question_reply>') === undefined && parseQuestionReply(`prefix ${unicode}`) === undefined && parseQuestionReply('<send_user_message_question_reply>{"answer":"x"}</send_user_message_question_reply>') === undefined)
console.log(`\nverify-codex-async-questions OK (${passed} checks)`)
