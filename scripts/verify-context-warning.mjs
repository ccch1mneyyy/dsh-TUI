/**
 * Regression for #770: /resume must not raise live warnings from replayed
 * totals, historical windows, or failed turns. Run against the compiled channel.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-context-warning-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const [{ Context }, { createChannel }, { settled }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../lib/types/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeAgent(id, sessionId, events = []) {
  return {
    id,
    status: 'idle',
    options: {},
    ctx: { on: () => () => {} },
    session: {
      id: sessionId,
      seq: events.at(-1)?.seq ?? 0,
      events,
      header: { cwd: '/tmp/context-warning' },
    },
    followup() {},
    steer() {},
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

const usage = {
  inputTokens: 70_000,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}
const historicalEvents = [
  { type: 'request/context', seq: 1, time: 1, data: { contextWindow: 128_000 } },
  { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 3,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage },
  },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
  {
    type: 'assistant/message',
    seq: 6,
    time: 6,
    data: { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage },
  },
  { type: 'turn/end', seq: 7, time: 7, data: { turn: 2, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 8, time: 8, data: { turn: 3 } },
  {
    type: 'turn/end',
    seq: 9,
    time: 9,
    data: {
      turn: 3,
      reason: {
        kind: 'error',
        error: { name: 'Error', message: 'historical provider failure' },
      },
    },
  },
]

const liveModelInfo = {
  context: { contextWindow: 150_000 },
  reasoning: { efforts: [] },
}
const target = makeAgent('resumed-agent', 'resumed-session', historicalEvents)
const ctx = new Context()
let delayMetadata = false
let resolveResumeInfo
ctx.provide('llm', {
  resolveModelInfo: () => delayMetadata
    ? new Promise(resolve => { resolveResumeInfo = resolve })
    : Promise.resolve(liveModelInfo),
})
ctx.provide('agents', {
  resume: () => Promise.resolve({ agent: target, dispose: () => Promise.resolve() }),
})

const channel = createChannel(ctx, makeAgent('current-agent', 'current-session'), {
  model: 'test-model',
  provider: 'test-provider',
  cwd: '/tmp/context-warning',
  activity: false,
})
const hasLowWarning = () => channel.notifications.some(item =>
  /Context low|上下文即将耗尽/u.test(item.text),
)
const hasTurnError = detail => channel.notifications.some(item =>
  item.color === 'error' &&
  /Turn error|回合出错/u.test(item.text) &&
  item.text.includes(detail),
)
const hasErrorRow = detail => channel.rows.some(row =>
  row.kind === 'notice' && row.text.includes(detail),
)

delayMetadata = true
const result = await channel.resumeTo(target.session.id)
check('/resume succeeds', result.ok === true, JSON.stringify(result))
check('replay restores cumulative billing totals', channel.tokens.input === 140_000, String(channel.tokens.input))
check('replay keeps the latest request usage', channel.lastUsage?.input === 70_000, JSON.stringify(channel.lastUsage))
check('replay does not emit a stale warning', !hasLowWarning(), JSON.stringify(channel.notifications))
check('replay keeps historical turn failure in the transcript', hasErrorRow('historical provider failure'))
check(
  'replay does not re-notify a historical turn failure',
  !hasTurnError('historical provider failure'),
  JSON.stringify(channel.notifications),
)
check('resume requested current route metadata', typeof resolveResumeInfo === 'function')

resolveResumeInfo?.(liveModelInfo)
check(
  'current route replaces the historical context window',
  await settled(() => channel.contextWindow === liveModelInfo.context.contextWindow),
  String(channel.contextWindow),
)
check('current request usage avoids a cumulative-total warning', !hasLowWarning(), JSON.stringify(channel.notifications))

const emit = (type, data) => {
  const event = { type, seq: ++target.session.seq, time: target.session.seq, data }
  target.session.events.push(event)
  ctx.emit('session/event', target.session, event)
}
emit('request/context', { contextWindow: 80_000 })
emit('turn/start', { turn: 4 })
emit('assistant/message', {
  turn: 4,
  step: 1,
  message: { role: 'assistant', content: [] },
  usage,
})
emit('turn/end', { turn: 4, reason: { kind: 'completed' } })
check('a genuinely low live context still warns', hasLowWarning(), JSON.stringify(channel.notifications))

emit('turn/start', { turn: 5 })
emit('turn/end', {
  turn: 5,
  reason: {
    kind: 'error',
    error: { name: 'Error', message: 'live provider failure' },
  },
})
check(
  'a live turn failure still notifies',
  hasTurnError('live provider failure'),
  JSON.stringify(channel.notifications),
)

process.exit(failed)
