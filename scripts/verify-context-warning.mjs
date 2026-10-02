/**
 * Regression for #770: /resume must not raise live warnings from replayed
 * totals, historical windows, or failed turns. Run against the compiled channel.
 *
 * The warning's numerator is the channel's SINGLE occupancy reading (the
 * official `contextPressure` projection when a token meter is mounted, else the
 * last request's billed sample — see dsh-adapter/context-occupancy.ts). The
 * sections below that build a channel WITHOUT `contextPressure` therefore cover
 * the fallback path on purpose; the closing section mounts one and pins the
 * projected numerator.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-context-warning-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const [{ Context }, { createChannel }, { settled, sleep }] = await Promise.all([
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

// Cache reads/writes occupy the window too, so keep them non-zero: the live
// scenario below is sized so a cache-BLIND numerator (lastUsage.input alone:
// 30k left of 100k) stays above the 20k warning buffer while the billed
// numerator (70k + 6k + 6k = 82k used, 18k left) crosses it. A
// cumulative-tokens implementation and a cache-ignoring one both fail here.
// (This is the no-meter fallback path: the channel has no `contextPressure`.)
const usage = {
  inputTokens: 70_000,
  outputTokens: 1_000,
  cacheReadTokens: 6_000,
  cacheWriteTokens: 6_000,
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
const countLowWarnings = () => channel.notifications.filter(item =>
  /Context low|上下文即将耗尽/u.test(item.text),
).length
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
// 100k with the billed 82k leaves 18k — under the 20k buffer, but a numerator
// that ignored the cache split (70k) would leave 30k and stay silent.
emit('request/context', { contextWindow: 100_000 })
emit('turn/start', { turn: 4 })
emit('assistant/message', {
  turn: 4,
  step: 1,
  message: { role: 'assistant', content: [] },
  usage,
})
emit('turn/end', { turn: 4, reason: { kind: 'completed' } })
check('a genuinely low live context still warns', hasLowWarning(), JSON.stringify(channel.notifications))
check('the live warning fires exactly once', countLowWarnings() === 1, String(countLowWarnings()))

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

// A route-metadata answer that lands after the Channel was released must not
// reach the dead state surface. applyRouteMetadata intentionally runs before
// the effort freshness gate (capacity follows the provider/model across a
// resume's binding rebuild), so owner liveness is the only fence it keeps; the
// answer below is deliberately tiny (8k < the 70k lastUsage) so a missing fence
// would both replace the window and re-arm the context-low warning.
{
  const lateHistory = [
    { type: 'request/context', seq: 1, time: 1, data: { contextWindow: 128_000 } },
    { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage },
    },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const lateTarget = makeAgent('late-agent', 'late-session', lateHistory)
  const lateCtx = new Context()
  let answerLateMetadata
  lateCtx.provide('llm', {
    resolveModelInfo: () => new Promise(resolve => { answerLateMetadata = resolve }),
  })
  lateCtx.provide('agents', {
    resume: () => Promise.resolve({ agent: lateTarget, dispose: () => Promise.resolve() }),
  })
  const lateChannel = createChannel(lateCtx, makeAgent('late-current-agent', 'late-current-session'), {
    model: 'test-model',
    provider: 'test-provider',
    cwd: '/tmp/context-warning',
    activity: false,
  })
  const lateResult = await lateChannel.resumeTo(lateTarget.session.id)
  check('late metadata: /resume succeeds', lateResult.ok === true, JSON.stringify(lateResult))
  check(
    'late metadata: replay restored the historical window',
    lateChannel.contextWindow === 128_000,
    String(lateChannel.contextWindow),
  )
  check('late metadata: the route lookup is still in flight', typeof answerLateMetadata === 'function')
  const notificationsBeforeRelease = lateChannel.notifications.length
  lateChannel.releaseContributions()
  answerLateMetadata({ context: { contextWindow: 8_000 }, reasoning: { efforts: [] } })
  await sleep(50) // 固定窗:探针 迟到答案的观察窗：等它落地后再断言窗口与通知都不变
  check(
    'a released channel keeps its replayed context window',
    lateChannel.contextWindow === 128_000,
    String(lateChannel.contextWindow),
  )
  check(
    'a released channel raises no notification for the late answer',
    lateChannel.notifications.length === notificationsBeforeRelease,
    JSON.stringify(lateChannel.notifications),
  )
}

// ── 投影在场：官方 contextPressure 才是告警（与页脚占用）的分子 ────────────
// 这一组刻意让 channel 里**没有**任何成功 usage 采样（lastUsage undefined）——
// 正是「请求被拒/溢出」留下的状态：旧实现（只认 lastUsage 求和）永不告警。
{
  const source = { value: { pressureTokens: 700_000, projectedTokens: 990_000, contextWindow: 1_000_000 } }
  const feed = new Set()
  const contextPressure = {
    read: () => source.value,
    subscribe(listener) { feed.add(listener); return () => feed.delete(listener) },
  }
  const projCtx = new Context()
  projCtx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 1_000_000 }, reasoning: { efforts: [] } }),
  })
  const projAgent = makeAgent('projection-agent', 'projection-session')
  const projChannel = createChannel(projCtx, projAgent, {
    model: 'test-model',
    provider: 'test-provider',
    cwd: '/tmp/context-warning',
    activity: false,
    contextPressure,
    seedContextOccupancy: () => {},
  })
  const countProjectedWarnings = () => projChannel.notifications.filter(item =>
    /Context low|上下文即将耗尽/u.test(item.text),
  ).length
  check(
    'projection: occupancy is the official projected value',
    projChannel.contextOccupancy?.source === 'projection' &&
      projChannel.contextOccupancy?.usedTokens === 990_000 &&
      projChannel.contextOccupancy?.contextWindow === 1_000_000,
    JSON.stringify(projChannel.contextOccupancy),
  )
  // 解耦：把「会话累计未缓存输入」堆到荒谬的大值也不改变占用读数。
  projChannel.tokens.input = 12_345_678
  check(
    'projection: occupancy is decoupled from the cumulative counter',
    projChannel.contextOccupancy?.usedTokens === 990_000,
    String(projChannel.tokens.input),
  )
  check('projection: no settled usage sample exists yet', projChannel.lastUsage === undefined)
  const projEmit = (type, data) => {
    const event = { type, seq: ++projAgent.session.seq, time: projAgent.session.seq, data }
    projAgent.session.events.push(event)
    projCtx.emit('session/event', projAgent.session, event)
  }
  const warningsBefore = countProjectedWarnings()
  projEmit('turn/start', { turn: 1 })
  projEmit('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { name: 'Error', message: 'context length exceeded' } },
  })
  check(
    'projection: a failed turn end still evaluates the warning',
    countProjectedWarnings() === warningsBefore + 1,
    `${warningsBefore} → ${countProjectedWarnings()}`,
  )
  // 投影变更 → channel 重发（页脚/告警立刻看到新值，不等下一次请求）。
  const versionBefore = projChannel.version
  source.value = { pressureTokens: 700_000, projectedTokens: 100_000, contextWindow: 1_000_000 }
  for (const listener of [...feed]) listener()
  check('projection: a change republishes through the channel', projChannel.version > versionBefore)
  check(
    'projection: the UI reads the republished value',
    projChannel.contextOccupancy?.usedTokens === 100_000,
    JSON.stringify(projChannel.contextOccupancy),
  )
  projChannel.releaseContributions()
}

process.exit(failed)
