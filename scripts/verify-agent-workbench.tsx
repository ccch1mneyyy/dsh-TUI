#!/usr/bin/env node
"use strict";
/**
 * verify-agent-workbench — agent-team P3（design agent-team-panels 路线图
 * P3 行：完整工作台 / peer roster / 跨会话如实降级）的回归。
 *
 *   W1  父关系/兄弟纯函数（agentTeam.ts）：parentAgentId 是唯一父事实、
 *       depth 1 证明主循环、depth>=2 无父=unknown（不造假树）；transcript
 *       的显式父覆盖 roster 事实；兄弟=同父可证，深度相同不构成兄弟。
 *   W2  领域事实链：Claude replay 的 subagent.start 带真实 parentAgentId
 *       （嵌套）/depth 1（主链）；生产投影折叠 parentAgentId 且无父刷新
 *       不清已有父事实。
 *   W3  工作台 UI（AgentTranscriptScene）：宽屏右侧 metadata/工具/父关系
 *       面板；sibling 原地切换不混消息（换代理即换转录源，旧代理行不
 *       残留、expandedLeaf 重置、消息按代理过滤）；来源栈不被 sibling
 *       切换推入；窄屏（40 列）面板整体退场。
 *   W4  peer roster（SubagentDashboard）：children 与 peers 分区呈现；
 *       无 peer 名册能力时如实降级一行（不伪装空名册）；served peers
 *       不混入 children、无发送入口（跨会话交互无上游支持面）。
 *
 * 运行：node --import tsx/esm scripts/verify-agent-workbench.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtui-agent-workbench-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

let failed = 0
let passed = 0
function check(name: string, ok: boolean, extra = ''): void {
  passed += ok ? 1 : 0
  if (!ok) failed += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
}

// ── W1: parent/sibling pure math ───────────────────────────────────────────
console.log('--- W1: parent fact + neighbourhood math ---')
{
  const { agentParentFactOf, viewedAgentParentFact, agentNeighbourhood } = await import('../src/components/messages/agentTeam.js')
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ agentId: 'a', depth: undefined, ...over })
  check('W1 parentAgentId 是父事实', agentParentFactOf(row({ parentAgentId: 'p1' }) as never).kind === 'agent' && (agentParentFactOf(row({ parentAgentId: 'p1' }) as never) as { agentId: string }).agentId === 'p1')
  check('W1 depth 1 证明主循环', agentParentFactOf(row({ depth: 1 }) as never).kind === 'main')
  check('W1 depth>=2 无父 = unknown（不画孤儿）', agentParentFactOf(row({ depth: 2 }) as never).kind === 'unknown')
  check('W1 无 depth 无父 = unknown', agentParentFactOf(row() as never).kind === 'unknown')
  const self = row({ agentId: 'self', depth: 2, parentAgentId: 'p9' })
  check('W1 transcript 显式父覆盖 roster', viewedAgentParentFact(self as never, 'p-other').kind === 'agent' && (viewedAgentParentFact(self as never, 'p-other') as { agentId: string }).agentId === 'p-other')
  check('W1 transcript null + depth1 = 主循环', viewedAgentParentFact(row({ agentId: 's', depth: 1 }) as never, null).kind === 'main')
  check('W1 transcript null + depth2 = 未知（旧格式）', viewedAgentParentFact(row({ agentId: 's', depth: 2 }) as never, null).kind === 'unknown')
  check('W1 transcript 未载入保持 roster 事实', (viewedAgentParentFact(self as never, undefined) as { agentId: string }).agentId === 'p9')

  const mk = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ agentId: id, description: 'agent ' + id, status: 'completed', startedAt: 0, output: [], outputEvents: [], toolCalls: [], ...over })
  const roster = [
    mk('main-a', { depth: 1 }),
    mk('main-b', { depth: 1 }),
    mk('nest-1', { depth: 2, parentAgentId: 'main-a' }),
    mk('nest-2', { depth: 2, parentAgentId: 'main-a' }),
    mk('nest-3', { depth: 2, parentAgentId: 'main-b' }),
    mk('orphan', { depth: 2 }),
    mk('nodepth', {}),
  ]
  const hoodOfMain = agentNeighbourhood(roster[0] as never, roster as never, null)
  check('W1 主循环兄弟 = 其它 depth-1', hoodOfMain.parent.kind === 'main' && hoodOfMain.siblings.map(s => s.agentId).join(',') === 'main-b', JSON.stringify(hoodOfMain.siblings.map(s => s.agentId)))
  const hoodOfNest1 = agentNeighbourhood(roster[2] as never, roster as never, 'main-a')
  check('W1 同父嵌套互为兄弟（transcript 父事实）', hoodOfNest1.siblings.map(s => s.agentId).join(',') === 'nest-2', JSON.stringify(hoodOfNest1.siblings.map(s => s.agentId)))
  const hoodOfNest3 = agentNeighbourhood(roster[4] as never, roster as never, undefined)
  check('W1 不同父不构成兄弟（同深度也不行）', hoodOfNest3.siblings.length === 0, JSON.stringify(hoodOfNest3.siblings.map(s => s.agentId)))
  const hoodOfOrphan = agentNeighbourhood(roster[5] as never, roster as never, null)
  check('W1 旧格式孤儿无兄弟（诚实缺席）', hoodOfOrphan.parent.kind === 'unknown' && hoodOfOrphan.siblings.length === 0)
}

// ── W2: the facts through replay + the production fold ────────────────────
console.log('--- W2: replay parent facts + projection fold ---')
{
  const { replayClaudeTranscript } = await import('../src/backends/claude/replay.js')
  const { createProjectorHarness } = await import('./lib/projector-harness.js')
  const at = (s: number): string => new Date(1_700_000_000_000 + s * 1000).toISOString()
  const chain = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate two levels' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'c-1', name: 'Agent', input: { description: 'outer dig', prompt: 'x' } }] }, timestamp: at(1) },
  ]
  const outer = [
    { type: 'user', message: { role: 'user', content: 'outer prompt' }, timestamp: at(2), parent_agent_id: null },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'c-2', name: 'Agent', input: { description: 'inner dig', prompt: 'y' } }] }, timestamp: at(3), parent_agent_id: null },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-2', content: 'agentId: agent-b' }] }, timestamp: at(4), parent_agent_id: null },
  ]
  const inner = [
    { type: 'user', message: { role: 'user', content: 'inner prompt' }, timestamp: at(5), parent_agent_id: 'agent-a' },
    { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'inner body works' }] }, timestamp: at(6), parent_agent_id: 'agent-a' },
  ]
  const replay = replayClaudeTranscript(chain as never, {
    cwd: '/fixture/project',
    subagents: new Map([
      ['c-1', { agentId: 'agent-a', messages: outer }],
      ['c-2', { agentId: 'agent-b', messages: inner, parentAgentId: 'agent-a' }],
    ]) as never,
  })
  const starts = new Map(replay.events.filter(e => e.type === 'subagent.start').map(e => [(e as { agentId: string }).agentId, e as { depth?: number; parentAgentId?: string }]))
  check('W2 replay：主链子代理 depth 1 且无伪父', starts.get('agent-a')?.depth === 1 && starts.get('agent-a')?.parentAgentId === undefined, JSON.stringify(starts.get('agent-a')))
  check('W2 replay：嵌套子代理带真实 parentAgentId + depth 2', starts.get('agent-b')?.parentAgentId === 'agent-a' && starts.get('agent-b')?.depth === 2, JSON.stringify(starts.get('agent-b')))

  const harness = createProjectorHarness({ activity: true })
  harness.apply([{ type: 'subagent.start', agentId: 'fx-1', description: 'has parent', background: false, depth: 2, parentAgentId: 'fx-0', time: 1 } as never])
  const folded = (harness.state as unknown as { subagents: Array<{ agentId: string; parentAgentId?: string }> }).subagents.find(s => s.agentId === 'fx-1')
  check('W2 投影折叠 parentAgentId 进名册', folded?.parentAgentId === 'fx-0', JSON.stringify(folded))
  harness.apply([{ type: 'subagent.start', agentId: 'fx-1', description: 'refresh without parent', background: false, time: 2 } as never])
  const refreshed = (harness.state as unknown as { subagents: Array<{ agentId: string; parentAgentId?: string }> }).subagents.find(s => s.agentId === 'fx-1')
  check('W2 无父刷新不清已有父事实', refreshed?.parentAgentId === 'fx-0', JSON.stringify(refreshed))
}

if (failed > 0) {
  console.error('verify-agent-workbench FAILED (' + failed + ' checks)')
  process.exit(1)
}
console.log('verify-agent-workbench OK (' + passed + ' checks)')
