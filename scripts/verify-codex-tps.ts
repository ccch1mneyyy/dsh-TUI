/**
 * Codex throughput regression: real translator + shared projector with a
 * controlled notification clock. Hidden reasoning starts before its summary
 * or reply streams; output usage must include that generation time. Tool
 * execution, delayed metering and historical replay must not skew the rate.
 * No process, network or model call.
 *
 * Run: node --import tsx/esm scripts/verify-codex-tps.ts
 */
import type { AgentEvent } from '../src/agent/events.js'
import { createItemContext } from '../src/backends/codex/translate/items.js'
import { createLiveTranslator } from '../src/backends/codex/translate/live.js'
import { replayTurns } from '../src/backends/codex/translate/replay.js'
import { setLang } from '../src/i18n.js'
import { assertAgentEventInvariants } from './lib/agent-event-invariants.js'
import { createProjectorHarness } from './lib/projector-harness.js'

setLang('en')
const B = 1_700_000_000_000
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`)
  if (!ok) failed += 1
}
const near = (actual: number | undefined, expected: number): boolean =>
  actual !== undefined && Math.abs(actual - expected) < 1e-6

function rig() {
  let now = B
  const ctx = createItemContext({ cwd: '/fixture', now: () => now })
  const live = createLiveTranslator(ctx, { model: 'fixture-model', effort: 'high', modeId: 'auto' })
  const harness = createProjectorHarness()
  const events: AgentEvent[] = []
  const notify = (at: number, method: string, params: Record<string, unknown>): void => {
    now = B + at
    const batch = live.notification(method, { threadId: 'thread-tps', turnId: ctx.turnId, ...params })
    events.push(...batch)
    harness.apply(batch)
  }
  return {
    ctx, harness, events, notify,
    start(at: number, item: Record<string, unknown>) { notify(at, 'item/started', { item }) },
    complete(at: number, item: Record<string, unknown>) { notify(at, 'item/completed', { item }) },
    turn(at = 0, id = 'turn-tps') {
      notify(at, 'turn/started', { turn: { id, status: 'inProgress' } })
      notify(at, 'item/started', { item: { type: 'userMessage', id: `user-${id}`, content: [{ type: 'text', text: 'measure' }] } })
    },
    end(at: number) { notify(at, 'turn/completed', { turn: { id: ctx.turnId, status: 'completed' } }) },
    usage(at: number, output: number, reasoningOutputTokens = 0) {
      notify(at, 'thread/tokenUsage/updated', {
        tokenUsage: {
          last: { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: output, reasoningOutputTokens, totalTokens: 1_000_000 + output },
          modelContextWindow: 2_000_000,
        },
      })
    },
  }
}

const reasoning = (id = 'reasoning'): Record<string, unknown> => ({ type: 'reasoning', id, summary: [], content: [] })
const message = (id = 'reply', text = ''): Record<string, unknown> => ({ type: 'agentMessage', id, text, phase: 'final_answer' })

{
  // The summary and short reply arrive only at the end of 60s of hidden
  // reasoning. Previously 3,000 tokens / 40ms displayed 75,000 TPS.
  const run = rig()
  run.turn()
  run.start(1_000, reasoning())
  run.notify(60_960, 'item/reasoning/summaryTextDelta', { itemId: 'reasoning', delta: 'Brief summary', summaryIndex: 0 })
  run.complete(60_975, { ...reasoning(), summary: ['Brief summary'] })
  run.start(60_980, message())
  run.notify(60_990, 'item/agentMessage/delta', { itemId: 'reply', delta: 'ok' })
  run.complete(61_000, message('reply', 'ok'))
  run.usage(61_010, 3_000, 2_999)
  check('hidden reasoning uses its full generation span: 3,000 tokens / 60s = 50 TPS', near(run.harness.state.tps, 50), run.harness.state.tps)
  run.end(61_020)
  check('turn sample keeps the corrected rate', run.harness.state.tpsSamples.length === 1 && near(run.harness.state.tpsSamples[0]?.tps, 50), run.harness.state.tpsSamples)
  check('billing keeps the full output count and input/cache split', run.harness.state.tokens.output === 3_000 && run.harness.state.tokens.input === 100_000 && run.harness.state.tokens.cacheRead === 900_000)
  assertAgentEventInvariants(run.events)
}

{
  // No reasoning summary or text delta at all; the final usage arrives
  // after turn completion. A known start/end still permits a real sample.
  const run = rig()
  run.turn()
  run.start(1_000, reasoning())
  run.complete(60_990, reasoning())
  run.start(60_990, message())
  run.complete(61_000, message('reply', 'ok'))
  run.end(61_020)
  check('no deltas do not manufacture a zero-speed sample', run.harness.state.tps === undefined && run.harness.state.tpsSamples.length === 0, run.harness.state.tpsSamples)
  run.usage(90_000, 3_000, 2_999)
  check('post-turn usage meters hidden generation even without deltas', near(run.harness.state.tps, 50), run.harness.state.tps)
  check('post-turn usage creates one sample at the turn end, excluding its delivery delay', run.harness.state.tpsSamples.length === 1 && near(run.harness.state.tpsSamples[0]?.tps, 50) && run.harness.state.tpsSamples[0]?.at === B + 61_020, run.harness.state.tpsSamples)
  assertAgentEventInvariants(run.events)
}

{
  // Two model calls separated by a 51s tool execution. The first reply is
  // reasoning-only with no visible text; its usage arrives after the tool.
  const run = rig()
  const tool = { type: 'commandExecution', id: 'tool', command: 'echo ok', cwd: '/fixture', source: 'agent', status: 'inProgress' }
  run.turn()
  run.start(1_000, reasoning('first'))
  run.complete(60_990, reasoning('first'))
  run.start(61_000, tool)
  run.complete(112_000, { ...tool, status: 'completed', aggregatedOutput: 'ok', exitCode: 0, durationMs: 51_000 })
  run.usage(112_100, 3_000, 2_950)
  check('reasoning-only tool step excludes tool execution', near(run.harness.state.tps, 50), run.harness.state.tps)
  run.start(113_000, reasoning('second'))
  run.complete(114_980, reasoning('second'))
  run.start(114_980, message())
  run.notify(114_990, 'item/agentMessage/delta', { itemId: 'reply', delta: 'ok' })
  run.complete(115_000, message('reply', 'ok'))
  run.usage(115_010, 100, 99)
  run.end(115_020)
  check('multi-step turn folds 3,100 tokens / 62s, excluding tool and request gaps', near(run.harness.state.tps, 50), run.harness.state.tps)
  check('multi-step turn records one sample', run.harness.state.tpsSamples.length === 1, run.harness.state.tpsSamples)
  assertAgentEventInvariants(run.events)
}

{
  // Ordinary text generation still excludes the request's first-token wait.
  const run = rig()
  run.turn()
  run.start(10_000, message())
  run.notify(10_000, 'item/agentMessage/delta', { itemId: 'reply', delta: 'a'.repeat(100) })
  run.notify(11_000, 'item/agentMessage/delta', { itemId: 'reply', delta: 'b'.repeat(100) })
  check('live text estimate excludes the 10s first-token wait', near(run.harness.state.tps, 50), run.harness.state.tps)
  run.complete(12_000, message('reply', 'a'.repeat(100) + 'b'.repeat(100)))
  run.usage(12_010, 100)
  run.end(12_020)
  check('ordinary text settles on actual output usage', near(run.harness.state.tps, 50), run.harness.state.tps)
  assertAgentEventInvariants(run.events)
}

{
  const run = rig()
  run.turn()
  run.start(1_000, reasoning())
  run.start(1_000, message())
  run.notify(1_000, 'item/agentMessage/delta', { itemId: 'reply', delta: 'ok' })
  run.complete(1_000, message('reply', 'ok'))
  run.usage(1_010, 10_000, 9_999)
  check('zero-duration delivery leaves throughput unknown', run.harness.state.tps === undefined && run.harness.state.tpsSamples.length === 0, run.harness.state.tps)
  run.start(2_000, message('next'))
  run.notify(2_000, 'item/agentMessage/delta', { itemId: 'next', delta: 'next' })
  run.complete(4_000, message('next', 'next'))
  run.usage(4_010, 100)
  run.end(4_020)
  check('a zero-duration buffered reply cannot inflate another measured call', near(run.harness.state.tps, 50) && run.harness.state.tpsSamples.length === 1, run.harness.state.tps)
  assertAgentEventInvariants(run.events)
}

{
  const run = rig()
  const replay = replayTurns([{
    id: 'history', status: 'completed', startedAt: B / 1000, completedAt: B / 1000 + 60,
    items: [{ type: 'userMessage', id: 'old-user', content: [{ type: 'text', text: 'previous' }] }, reasoning(), message('old-reply', 'old')],
  }], run.ctx)
  run.harness.apply(replay, true)
  check('replay never synthesizes historical TPS from item timestamps', run.harness.state.tps === undefined && run.harness.state.tpsSamples.length === 0)
  run.turn(100_000, 'live-after-replay')
  run.start(101_000, reasoning())
  run.start(102_990, message())
  run.notify(102_995, 'item/agentMessage/delta', { itemId: 'reply', delta: 'ok' })
  run.complete(103_000, message('reply', 'ok'))
  run.usage(103_010, 100, 99)
  run.end(103_020)
  check('live generation after replay starts a fresh timing span', near(run.harness.state.tps, 50) && run.harness.state.tpsSamples.length === 1, run.harness.state.tps)
  assertAgentEventInvariants([...replay, ...run.events])
}

if (failed > 0) {
  console.error(`verify-codex-tps: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-codex-tps OK')
