/**
 * Per-turn usage ledger regression (info-display design §C):
 *
 * The shared projector accumulates each turn's assistant-message usages
 * (messages report their OWN request — the sum is the turn total and never
 * blends into the session counters), counts failed/superseded attempts as
 * retries without double-counting one failure seen from two lifecycle
 * events, and closes the turn with a `turn-summary` row plus the
 * `state.turnUsage` snapshot the footer reads.
 *
 * Honesty rules under test: cache fields absent on the wire stay absent
 * (`cacheKnown` false) and explicit zeros are known-but-zero — neither ever
 * renders a fabricated number; a turn with no usage-bearing message emits
 * nothing; an interrupted turn keeps its partial ledger marked as such;
 * notification turns are real model calls and get their ledger too.
 *
 * Drives the ONE production reducer through scripts/lib/projector-harness.
 * Exits non-zero on any failure (CI convention).
 */
import assert from 'node:assert/strict'
import { createProjectorHarness } from './lib/projector-harness.ts'
import type { AgentEvent } from '../src/agent/events.js'
import type { ChatRow } from '../src/adapter/ports/channel-view.js'

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const summaryRows = (rows: readonly ChatRow[]): ChatRow[] => rows.filter(row => row.kind === 'turn-summary')

// ── 1. Completed turn: ledger, row, footer snapshot, sampled time ─────────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'user.message', id: 'u1', anchor: 'u1', seq: 1, time: 900, source: 'user', text: 'hi', blocks: [] },
    { type: 'turn.start', turn: 1, origin: 'user', time: 1000 },
    { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1, model: 'model-x' },
    { type: 'assistant.message', seq: 2, anchor: 'a1', turn: 1, step: 1, attemptId: 'a1', time: 6000, model: 'model-x', blocks: [{ type: 'text', text: 'answer' }], usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 }, canonical: true },
    { type: 'assistant.attempt.end', attemptId: 'a1', outcome: 'committed' },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 61000 },
  ] as readonly AgentEvent[])
  const rows = summaryRows(rig.state.rows)
  check('1a. 完成回合产生 turn-summary 行', rows.length === 1)
  const ledger = rows[0]?.turnUsage
  check('1b. 分项聚合正确', ledger !== undefined && ledger.input === 100 && ledger.output === 50 && ledger.cacheRead === 1000 && ledger.cacheWrite === 200)
  check('1c. cacheKnown 为真（wire 带缓存字段）', ledger?.cacheKnown === true)
  check('1d. 时长 = turn.end - turn.start', ledger?.durationMs === 60000)
  check('1e. 模型取自消息事件', ledger?.model === 'model-x')
  check('1f. outcome completed', ledger?.outcome === 'completed')
  check('1g. state.turnUsage 与行负载一致', rig.state.turnUsage === ledger)
  check('1h. 会话累计=单消息增量（不双计）', rig.state.tokens.input === 100 && rig.state.tokens.output === 50)
  check('1i. lastUsage 带采样时点', rig.state.lastUsage?.at === 6000)
}

// ── 2. Multi-step turn: per-message increments sum; no turn.end double add ─
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: '1' }], usage: { input: 10, output: 5 }, canonical: true },
    { type: 'tool.call', seq: 2, turn: 1, step: 1, callId: 'c1', name: 'read', argsJson: '{}', time: 1500 },
    { type: 'tool.result', seq: 3, turn: 1, step: 1, callId: 'c1', isError: false, time: 2000, content: [], text: 'ok' },
    { type: 'assistant.message', seq: 4, anchor: 'b', turn: 1, step: 2, attemptId: 'b', time: 3000, blocks: [{ type: 'text', text: '2' }], usage: { input: 10, output: 5 }, canonical: true },
    // turn.end carries a turn-level usage on the wire — it must NOT be added
    // on top of the per-message increments.
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 4000, usage: { input: 20, output: 10 } },
  ] as readonly AgentEvent[])
  const ledger = summaryRows(rig.state.rows)[0]?.turnUsage
  check('2a. 多步回合求和', ledger?.input === 20 && ledger?.output === 10)
  check('2b. 会话累计仍是增量之和（result/turn 口径不叠加）', rig.state.tokens.input === 20 && rig.state.tokens.output === 10)
}

// ── 3. Cache absent vs explicit zero ─────────────────────────────────────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'x' }], usage: { input: 5, output: 1 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2000 },
  ] as readonly AgentEvent[])
  const ledger = summaryRows(rig.state.rows)[0]?.turnUsage
  check('3a. 缓存字段缺席 → cacheKnown=false（不虚构 0）', ledger?.cacheKnown === false)
  check('3b. 缓存数值仍为 0 基线', ledger?.cacheRead === 0 && ledger?.cacheWrite === 0)
}
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'x' }], usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2000 },
  ] as readonly AgentEvent[])
  const ledger = summaryRows(rig.state.rows)[0]?.turnUsage
  check('3c. 显式零缓存 → cacheKnown=true（与缺席可区分）', ledger?.cacheKnown === true)
}

// ── 4. Interrupted turn: partial ledger marked; row order after interrupt ─
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'partial' }], usage: { input: 7, output: 2 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'aborted' }, time: 2500 },
  ] as readonly AgentEvent[])
  const rows = rig.state.rows
  const interruptAt = rows.findIndex(row => row.kind === 'interrupt')
  const summaryAt = rows.findIndex(row => row.kind === 'turn-summary')
  check('4a. 中断行存在', interruptAt >= 0)
  check('4b. 中断回合仍有账本行', summaryAt >= 0)
  check('4c. 账本行在中断行之后（回合先收口再结算）', interruptAt >= 0 && summaryAt === interruptAt + 1)
  check('4d. outcome=interrupted', rows[summaryAt]?.turnUsage?.outcome === 'interrupted')
}

// ── 5. Retries: failed attempts counted once each ────────────────────────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 },
    // Positioned durable end: the failed attempt's own record…
    { type: 'assistant.attempt.end', attemptId: 'a1', outcome: 'abandoned', turn: 1, step: 1 },
    { type: 'assistant.attempt.start', attemptId: 'a2', turn: 1, step: 2 },
    { type: 'assistant.message', seq: 1, anchor: 'a2', turn: 1, step: 2, attemptId: 'a2', time: 3000, blocks: [{ type: 'text', text: 'ok' }], usage: { input: 3, output: 4 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 4000 },
  ] as readonly AgentEvent[])
  check('5a. 一次失败尝试 = 重试 1', summaryRows(rig.state.rows)[0]?.turnUsage?.retries === 1)
}
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 },
    // Live supersede with NO end event — the same failure seen from the
    // replacement start only.
    { type: 'assistant.attempt.start', attemptId: 'a2', turn: 1, step: 2 },
    { type: 'assistant.message', seq: 1, anchor: 'a2', turn: 1, step: 2, attemptId: 'a2', time: 3000, blocks: [{ type: 'text', text: 'ok' }], usage: { input: 3, output: 4 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 4000 },
  ] as readonly AgentEvent[])
  check('5b. 无 end 的被顶替尝试也只计一次', summaryRows(rig.state.rows)[0]?.turnUsage?.retries === 1)
}

// ── 6. No-usage turn: no row, footer keeps the previous turn's ledger ────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'x' }], usage: { input: 9, output: 9 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2000 },
    { type: 'turn.start', turn: 2, origin: 'user', time: 3000 },
    { type: 'assistant.message', seq: 2, anchor: 'b', turn: 2, step: 1, attemptId: 'b', time: 3500, blocks: [{ type: 'text', text: 'y' }], canonical: true },
    { type: 'turn.end', turn: 2, reason: { kind: 'completed' }, time: 4000 },
  ] as readonly AgentEvent[])
  check('6a. 无用量回合不产生账本行', summaryRows(rig.state.rows).length === 1)
  check('6b. 底栏快照保留上一轮账本', rig.state.turnUsage?.input === 9)
}

// ── 7. Notification turn: a real model call gets its ledger ──────────────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'notification', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'report' }], usage: { input: 11, output: 1 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2000 },
  ] as readonly AgentEvent[])
  check('7. 通知回合照常结算账本', summaryRows(rig.state.rows)[0]?.turnUsage?.input === 11)
}

// ── 8. Compaction between turns: the next ledger starts clean ────────────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'x' }], usage: { input: 50, output: 5 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2000 },
    { type: 'user.message', id: 'c1', anchor: 'c1', seq: 2, time: 2500, source: 'compaction', text: 'summary of before', blocks: [] },
    { type: 'turn.start', turn: 2, origin: 'user', time: 3000 },
    { type: 'assistant.message', seq: 3, anchor: 'b', turn: 2, step: 1, attemptId: 'b', time: 4000, blocks: [{ type: 'text', text: 'z' }], usage: { input: 6, output: 2 }, canonical: true },
    { type: 'turn.end', turn: 2, reason: { kind: 'completed' }, time: 5000 },
  ] as readonly AgentEvent[])
  const rows = summaryRows(rig.state.rows)
  check('8a. 压缩后新回合账本只含本回合用量', rows.length === 2 && rows[1]?.turnUsage?.input === 6)
  check('8b. 会话累计跨压缩连续（累计口径不清零）', rig.state.tokens.input === 56)
}

// ── 9. Model absent on the message: ledger.model stays undefined ─────────
{
  const rig = createProjectorHarness()
  rig.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'x' }], usage: { input: 1, output: 1 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2000 },
  ] as readonly AgentEvent[])
  check('9. 消息不带模型 → 账本不猜模型', summaryRows(rig.state.rows)[0]?.turnUsage?.model === undefined)
}

// ── 10. Replay idempotence: the same events re-folded derive the same rows ─
{
  const rig = createProjectorHarness()
  const batch = [
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'assistant.message', seq: 1, anchor: 'a', turn: 1, step: 1, attemptId: 'a', time: 1000, blocks: [{ type: 'text', text: 'x' }], usage: { input: 4, output: 2, cacheRead: 8 }, canonical: true },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 3000 },
  ] as readonly AgentEvent[]
  rig.apply(batch, true)
  const replayRows = summaryRows(rig.state.rows)
  check('10. 重放同样导出账本行（resume 可重建）', replayRows.length === 1 && replayRows[0]?.turnUsage?.cacheRead === 8)
}

// ── 11. One formatter for the transcript row, /tokens and /status ────────
{
  const { setLang, t } = await import('../src/i18n.js')
  const { turnUsageParts } = await import('../src/components/TurnUsageRow.js')
  setLang('en')
  const base = { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, cacheKnown: true, durationMs: 60000, retries: 0, outcome: 'completed' as const, model: 'model-x', noteModel: true }
  const parts = turnUsageParts(base as never)
  check('11a. 分段：↑ ↓ 带读/写标注的缓存 时长', parts[0] === '↑100' && parts[1] === '↓50'
    && parts[2] === t('usage-cache-segment', { parts: `${t('usage-cache-read', { n: '1k' })}/${t('usage-cache-write', { n: '200' })}` })
    && parts.length === 4)
  check('11b. 只有转录行带模型名', turnUsageParts(base as never, { model: true }).includes('model-x') && !parts.includes('model-x'))
  const partial = turnUsageParts({ ...base, cacheKnown: false, retries: 2, outcome: 'interrupted' } as never)
  check('11c. 未上报缓存不显示缓存段；重试与中断标注都在', !partial.some(part => part.startsWith(t('usage-cache-segment', { parts: '' }).trim()))
    && partial.includes(t('usage-retry-segment', { n: 2 })) && partial.at(-1) === t('usage-turn-outcome-interrupted'))
}

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
