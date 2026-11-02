#!/usr/bin/env node --import tsx/esm
/**
 * 子代理通道失败统计门禁（issue #1791）。
 *
 * 一串里某个 delegation provider 反复失败时，面板只给一行行 `🔴`，看不出
 * 「这条通道整体在坏」。`summarizeChannelFailures` 按 provider 统计已应答的
 * 运行，`isDegradedChannel` 决定值不值得弹横幅。本脚本钉住这两条纯函数：
 *
 *   - 统计只收 provider 应答过的行（`failed` + `completed`），用户取消的
 *     `cancelled` 不稀释失败率，`running`/`unknown` 不计；
 *   - 只有可切换的产品通道（`claude-code`/`codex`）才可能弹横幅；
 *     内建 `subagent`、workflow 成员、Claude 的 `subagent_type` 桶都不弹；
 *   - 阈值：至少 2 次失败且失败数不低于已应答的一半，50% 边界取等号。
 *
 * 只读源码里的纯函数，不启宿主、不碰网络。
 */
import { isDegradedChannel, summarizeChannelFailures } from '../src/channel/subagent-failure.js'

let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
    return
  }
  failed += 1
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const summaries = summarizeChannelFailures([
  { provider: 'claude-code', status: 'failed' },
  { provider: 'claude-code', status: 'failed' },
  { provider: 'claude-code', status: 'completed' },
  { provider: 'spawn', status: 'completed' },
  { status: 'failed' },
  { provider: '', status: 'failed' },
] as const)
check('groups by provider only', summaries.length === 1 && summaries[0]?.provider === 'claude-code', JSON.stringify(summaries))
check('counts settled and failed', summaries[0]?.failed === 2 && summaries[0]?.settled === 3, JSON.stringify(summaries[0]))

const notAnswered = summarizeChannelFailures([
  { provider: 'x', status: 'failed' },
  { provider: 'x', status: 'failed' },
  { provider: 'x', status: 'cancelled' },
  { provider: 'x', status: 'cancelled' },
  { provider: 'x', status: 'cancelled' },
  { provider: 'x', status: 'running' },
  { provider: 'x', status: 'unknown' },
] as const)
check('cancelled and unsettled rows do not dilute the rate', notAnswered[0]?.failed === 2 && notAnswered[0]?.settled === 2, JSON.stringify(notAnswered))

const ordered = summarizeChannelFailures([
  { provider: 'b', status: 'failed' },
  { provider: 'a', status: 'failed' },
  { provider: 'a', status: 'failed' },
] as const)
check('orders by failure count', ordered[0]?.provider === 'a' && ordered[1]?.provider === 'b', JSON.stringify(ordered))

// A continuable child reuses one `agentId`; opening its next run resets the
// live row to `running`, so only the kept history can show that the same child
// failed twice. Counting the live row alone would keep the banner quiet here.
const rerunChild = summarizeChannelFailures([
  {
    provider: 'claude-code',
    status: 'running',
    settledRuns: [
      { runId: 'run-1', provider: 'claude-code', status: 'failed' },
      { runId: 'run-2', provider: 'claude-code', status: 'failed' },
    ],
  },
] as const)
check('repeated runs of one child accumulate', rerunChild[0]?.failed === 2 && rerunChild[0]?.settled === 2, JSON.stringify(rerunChild))
check('two runs of one child reach the banner floor', rerunChild.some(isDegradedChannel), JSON.stringify(rerunChild))
const liveAfterHistory = summarizeChannelFailures([
  {
    provider: 'claude-code',
    status: 'failed',
    settledRuns: [{ runId: 'run-1', provider: 'claude-code', status: 'failed' }],
  },
] as const)
check('the settled run is not counted twice when the live row repeats it', liveAfterHistory[0]?.failed === 1 && liveAfterHistory[0]?.settled === 1, JSON.stringify(liveAfterHistory))

check('one failure is not a degraded channel', !isDegradedChannel({ provider: 'claude-code', failed: 1, settled: 1 }))
check('a switchable product route is surfaced', isDegradedChannel({ provider: 'claude-code', failed: 9, settled: 9 })
  && isDegradedChannel({ provider: 'codex', failed: 2, settled: 2 }))
// Positive list, not an exclusion list: an unknown backend must opt in before
// it can banner, and the three buckets that are not switchable routes must not.
check('non-switchable buckets are never bannered', !isDegradedChannel({ provider: 'subagent', failed: 9, settled: 9 })
  && !isDegradedChannel({ provider: 'workflow', failed: 3, settled: 4 })
  && !isDegradedChannel({ provider: 'Explore', failed: 2, settled: 2 })
  && !isDegradedChannel({ provider: 'general-purpose', failed: 2, settled: 2 }))
check('the 50% boundary is inclusive', isDegradedChannel({ provider: 'claude-code', failed: 2, settled: 4 })
  && !isDegradedChannel({ provider: 'claude-code', failed: 2, settled: 5 })
  && isDegradedChannel({ provider: 'claude-code', failed: 3, settled: 6 }))

if (failed > 0) {
  console.error(`\n子代理失败诊断门禁：${failed} 项失败`)
  process.exit(1)
}
console.log('\n子代理失败诊断门禁：全部通过')
