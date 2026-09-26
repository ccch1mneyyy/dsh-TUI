/**
 * 问卷作答记录的真源投影回归（issue #1009）。
 *
 * `ask_user_question` 的卡片按设计不渲染（面板自己承载交互），于是它的
 * `tool/result` 在投影里没有卡片可落定——整条 answers 载荷曾经没有任何
 * 渲染者。作答摘要只由 `Chat.tsx` 在「面板由开转关」的那一跳里
 * `pushLocal` 推进 `state.rows`（`pushLocal` 不追加会话事件）：既不在持久化
 * 日志里，面板没被观察到「打开→关闭」时也一次都不推。后果就是 issue 的
 * 两条现象——`/resume`、rewind、重放后记录消失；被整屏页占用或 ask 被
 * abort 时从不出现。
 *
 * 本脚本钉住修复后的契约：记录是**日志投影**的产物。
 *   1. 实时：`tool/call` + 配对 `tool/result` → 转录出现一条记录，含问题与所选；
 *   2. 重放：同一批事件构造 channel（`/resume`、rewind/fork 收养、模型切换
 *      走的 `replaying` 分支）→ 同一条记录仍在（**修复前此条必红**）；
 *   3. 不重复：实时路径同一次 ask 只产生一条记录；
 *   4. 错误结果：`data.error`（ASK_CANCELLED / ASK_ABORTED）时渲染日志里的
 *      错误文本，不得出现伪造答案；
 *   5. `redact`：打码路径只在本地向导使用（不经工具、不在日志）——校验
 *      纯构造函数对 redact 选项打码、默认路径不泄漏。
 *
 * Run: node --import tsx/esm scripts/verify-question-transcript-record.tsx
 */

import './lib/fake-home.mjs'

process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '0'

import assert from 'node:assert/strict'
import type { ChatRow } from '../src/dsh-adapter/channel.js'

const [
  { createChannel },
  { buildQuestionRecord },
  { setLang },
] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel/question-record.js'),
  import('../src/i18n.js'),
])

setLang('en')

/** The tool-visible argument shape the model sends (dsh-tool-ask-user). */
const askArguments = {
  questions: [
    { id: 'q1', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { id: 'q2', question: 'Anything else?', options: [{ label: 'No' }] },
  ],
}
// dsh-tool-ask-user renders its output as one JSON text block: the SAME bytes
// the model reads back, which is what makes the log a sufficient source.
const answersPayload = {
  answers: [
    { id: 'q1', selected: ['SQLite'] },
    { id: 'q2', selected: [], custom: 'keep it local' },
  ],
}

// The fold's own compile-time contract with the persisted shapes lives where
// it is enforced: `projection.ts` passes the parsed payload straight into
// `buildQuestionRecord`, so `pnpm compile` (tsconfig includes only `src`)
// fails if the durable shapes and the record types drift apart.

const askCall = {
  type: 'tool/call',
  seq: 3,
  time: 3,
  data: { turn: 1, step: 1, callId: 'ask-1', name: 'ask_user_question', arguments: JSON.stringify(askArguments) },
}
const askResult = {
  type: 'tool/result',
  seq: 4,
  time: 4,
  data: {
    turn: 1,
    step: 1,
    message: {
      source: { callId: 'ask-1' },
      content: [{ type: 'tool-result', toolCallId: 'ask-1', content: [{ type: 'text', text: JSON.stringify(answersPayload) }] }],
    },
  },
}

function channelFixture(events: object[] = []): {
  readonly channel: ReturnType<typeof createChannel>
  readonly emit: (event: object) => void
} {
  const handlers = new Map<string, (...args: never[]) => void>()
  const session = {
    id: 'question-transcript-session',
    seq: events.at(-1) === undefined ? 0 : (events.at(-1) as { seq: number }).seq,
    events: [...events],
  }
  const ctx = {
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
    get() { return undefined },
    logger: { warn() {} },
  }
  const agent = {
    id: 'question-transcript-agent',
    status: 'idle',
    session,
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  const channel = createChannel(ctx as never, agent as never, {
    model: 'fixture-model',
    cwd: '/tmp',
    provider: 'fixture-provider',
    activity: false,
  })
  return {
    channel,
    emit(event) {
      session.events.push(event)
      session.seq = (event as { seq: number }).seq
      handlers.get('session/event')?.(session as never, event as never)
    },
  }
}

/** The answered-questionnaire record rows, in transcript order. */
const records = (rows: readonly ChatRow[]): ChatRow[] => rows.filter(row => row.kind === 'local')
const recordText = (rows: readonly ChatRow[]): string =>
  rows.map(row => `${row.kind}:${row.text}`).join('\n')

// ── 1. live: call + paired result project one record ────────────────────
const live = channelFixture()
live.emit(askCall)
assert.equal(records(live.channel.rows).length, 0, 'the ask tool card stays hidden while the panel owns the interaction')
live.emit(askResult)
const liveRecords = records(live.channel.rows)
assert.equal(liveRecords.length, 1, 'the paired tool/result projects exactly one answered-questionnaire record')
assert.equal(liveRecords[0]!.seq, askResult.seq, 'the record is anchored at its tool/result sequence number')
assert.match(recordText(live.channel.rows), /Questionnaire answered/u)
assert.match(recordText(live.channel.rows), /Which database\? → SQLite/u, 'the selected option reaches the transcript')
assert.match(recordText(live.channel.rows), /Anything else\? → keep it local/u, 'the free-text answer reaches the transcript')

// ── 2. replay: the same batch of events rebuilds the same record ────────
// This is the /resume, rewind-fork-adoption and model-switch path: a fresh
// channel constructed over the persisted log. It MUST NOT depend on the
// panel ever having been observed open.
const replay = channelFixture([askCall, askResult])
assert.deepEqual(
  recordText(replay.channel.rows),
  recordText(live.channel.rows),
  'a replayed session log projects the same answered-questionnaire record as the live stream',
)
assert.equal(records(replay.channel.rows).length, 1, 'replay does not duplicate the record')

// ── 3. no duplication: a repeated result for the same callId ────────────
live.emit(askResult)
assert.equal(records(live.channel.rows).length, 1, 'a repeated tool/result for the same callId stays a single record')

// ── 4. error results render the log's error text, never fake answers ────
const cancelledCall = { ...askCall, seq: 5, time: 5, data: { ...askCall.data, callId: 'ask-2' } }
const cancelledResult = {
  type: 'tool/result',
  seq: 6,
  time: 6,
  data: {
    turn: 1,
    step: 1,
    message: {
      source: { callId: 'ask-2' },
      content: [{ type: 'tool-result', toolCallId: 'ask-2', isError: true, content: [{ type: 'text', text: 'the user cancelled ask_user_question' }] }],
    },
    error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' },
  },
}
const errored = channelFixture([cancelledCall, cancelledResult])
const errorText = recordText(errored.channel.rows)
assert.doesNotMatch(errorText, /→/u, 'a cancelled ask fabricates no answer line')
assert.doesNotMatch(errorText, /SQLite|Postgres/u, 'a cancelled ask leaks no option label')
assert.match(errorText, /ASK_CANCELLED/u, "the record renders the log's own error code")
assert.match(errorText, /the user cancelled ask_user_question/u, "the record renders the log's own error detail")

const aborted = channelFixture([
  { ...askCall, seq: 7, time: 7, data: { ...askCall.data, callId: 'ask-3' } },
  {
    type: 'tool/result',
    seq: 8,
    time: 8,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { callId: 'ask-3' },
        content: [{ type: 'tool-result', toolCallId: 'ask-3', isError: true, content: [{ type: 'text', text: 'ask_user_question was interrupted before the user answered' }] }],
      },
      error: { name: 'UserQuestionError', code: 'ASK_ABORTED' },
    },
  },
])
assert.match(recordText(aborted.channel.rows), /ASK_ABORTED/u, 'an aborted ask reports ASK_ABORTED from the log')

// An ask whose result names a different callId (or that never had a call)
// must stay inert: no card, no record, no throw.
const orphanResult = {
  type: 'tool/result',
  seq: 9,
  time: 9,
  data: { turn: 1, step: 1, message: { source: { callId: 'ask-unknown' }, content: [] } },
}
const orphan = channelFixture([orphanResult])
assert.equal(records(orphan.channel.rows).length, 0, 'a result with no matching ask call projects nothing')

// ── 5. redact stays a local-wizard concern ──────────────────────────────
// The model-side ask carries no redact flag, so nothing in the log is
// redacted; the pure builder still honours it for local wizards.
const plain = buildQuestionRecord(askArguments.questions, answersPayload.answers)
assert.match(plain.title, /Questionnaire answered/u)
assert.equal(plain.lines.length, 2)
assert.ok(plain.lines[0]!.includes('Which database?') && plain.lines[0]!.includes('SQLite'),
  'the selected option reaches the record line')
assert.ok(plain.lines[1]!.includes('Anything else?') && plain.lines[1]!.includes('keep it local'),
  'the free-text answer reaches the record line')
assert.ok(!plain.lines[1]!.includes('No'), 'an unanswered option label never appears')
const redacted = buildQuestionRecord(askArguments.questions, answersPayload.answers, { redact: true })
assert.ok(redacted.lines.every(line => !line.includes('SQLite') && !line.includes('keep it local')),
  'redact never writes local-wizard secret text into the transcript')
assert.ok(redacted.lines.every(line => line.includes('••••••')), 'redacted lines keep the masked placeholder')

// ── 6. malformed durable payloads degrade instead of throwing ───────────
// Projection must stay total: a throw here would take down the whole
// transcript fold, so unparseable args/answers fall back to a title-only
// record rather than an exception.
const malformed = channelFixture([
  { ...askCall, seq: 11, time: 11, data: { ...askCall.data, callId: 'ask-4', arguments: '{not json' } },
  {
    type: 'tool/result',
    seq: 12,
    time: 12,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { callId: 'ask-4' },
        content: [{ type: 'tool-result', toolCallId: 'ask-4', content: [{ type: 'text', text: 'not json either' }] }],
      },
    },
  },
])
assert.equal(records(malformed.channel.rows).length, 1, 'unparseable durable payloads still project a record')
assert.match(recordText(malformed.channel.rows), /Questionnaire answered/u)
assert.doesNotMatch(recordText(malformed.channel.rows), /not json/u, 'unparseable payload text never becomes a fake answer')

// ── 7. an unanswered / non-ask tool result is untouched ─────────────────
const otherTool = channelFixture([
  { type: 'tool/call', seq: 13, time: 13, data: { turn: 1, step: 1, callId: 'tool-1', name: 'job_output', arguments: '{}' } },
  {
    type: 'tool/result',
    seq: 14,
    time: 14,
    data: {
      turn: 1,
      step: 1,
      message: { source: { callId: 'tool-1' }, content: [{ type: 'tool-result', toolCallId: 'tool-1', content: [{ type: 'text', text: 'plain output' }] }] },
    },
  },
])
assert.equal(records(otherTool.channel.rows).length, 0, 'non-ask tools keep their card and project no questionnaire record')
assert.equal(otherTool.channel.rows.filter(row => row.kind === 'tool').length, 1)

console.log('Question transcript record regression passed')
