#!/usr/bin/env node
"use strict";
/**
 * verify-agent-workbench — Agent View 工作台、peer roster、侧栏 Detail
 * composer 与转录分页的回归。
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
 *       切换推入；窄屏（40 列）面板整体退场、顶栏保留代理名，28 列下
 *       长行在屏内折行（不按 44 列排版后被屏幕右缘裁掉）。
 *   W4  peer roster（SubagentDashboard）：children 与 peers 分区呈现；
 *       无 peer 名册能力时不画 peers 分区；served peers 不混入 children、
 *       无发送入口（跨会话交互无上游支持面）。
 *   W5  侧栏 Detail 的 composer：按键经面板分发器进草稿（宿主吞掉普通键，
 *       直接 useInput 收不到）；Esc 先让出编辑焦点、焦点仍在侧栏；焦点被
 *       宿主切回聊天后，聊天里的打字和 Enter 不进 composer、不发给子代理。
 *   W6  转录分页：代理消息只落在它所属的那一页（载入更早不重复、newest
 *       页不收更早页的消息）；调用在旧页、结果在新页时载入旧页后卡片落定；
 *       载入更早在途时切换代理，旧代理的更早页不会拼进新代理的转录；live
 *       合并不改写历史叶子。
 *   W7  运行中跟尾：新输出把视图钉到底部；用户上滚后新输出不再把视图
 *       拽回底部，滚回底部后恢复跟随。
 *   W8  Detail 转录页：o 键载入更早一页（页脚提示）；运行中上滚到历史
 *       后，新输出不把视图拽回底部。
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

// ── terminal harness (the same shape verify-agent-view-ui uses) ───────────
const NOW = Date.now()
const [{ PassThrough, Writable }, { default: React }, { Terminal: XTerm }, uiMod, sceneMod] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/AgentTranscriptScene.js'),
])
const { render, AlternateScreen, useInput, Box, Text } = uiMod as unknown as {
  Box: React.ComponentType<Record<string, unknown>>
  Text: React.ComponentType<Record<string, unknown>>
  render: typeof import('../src/ui.js').render
  AlternateScreen: React.ComponentType<{ children?: React.ReactNode }>
  useInput: (handler: (input: string, key: unknown) => void, options?: { isActive?: boolean }) => void
}
const { AgentTranscriptScene } = sceneMod as unknown as { AgentTranscriptScene: React.ComponentType<Record<string, unknown>> }
const termTest = await import('./lib/term-test.mjs')
const { settled, sleep, viewportLines, findText } = termTest as unknown as {
  settled(pred: () => boolean, opts?: { timeoutMs?: number }): Promise<boolean>
  sleep: (ms: number) => Promise<void>
  viewportLines(term: InstanceType<typeof XTerm>, rows?: number): string[]
  findText(term: InstanceType<typeof XTerm>, needle: string): { col: number; row: number } | null
}
const { setLang, t } = await import('../src/i18n.js')
setLang('en')

const COLS = 100
const ROWS = 30

class FakeStdout extends Writable {
  columns: number
  rows = ROWS
  isTTY = true
  constructor(private term: InstanceType<typeof XTerm>, cols = COLS) { super(); this.columns = cols }
  _write(chunk: unknown, _e: unknown, cb: () => void): void { this.term.write(String(chunk), cb) }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/** 输入链路保持器（同 verify-jobs-transcript-group 的教训）：没有组件开
 *  raw mode，注入的键鼠根本进不了管线。 */
function RawMode(): null {
  useInput((): void => {}, { isActive: true })
  return null
}

interface Frame {
  screen(): string
  lines(): string[]
  rerender(node: React.ReactNode): void
  stdin: Input
  term: InstanceType<typeof XTerm>
}
async function withTerminal(make: () => React.ReactNode, run: (frame: Frame) => Promise<void>, cols = COLS): Promise<void> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols) as unknown as NodeJS.WriteStream
  const stdin = new Input()
  const instance = await render(React.createElement(AlternateScreen, null, React.createElement(RawMode, null), make()), {
    stdout, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false,
  })
  const lines = (): string[] => viewportLines(term, ROWS)
  try {
    await run({ screen: () => lines().join('\n'), lines, rerender: node => { instance.rerender(React.createElement(AlternateScreen, null, React.createElement(RawMode, null), node)) }, stdin, term })
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

async function click(frame: Frame, needle: string): Promise<boolean> {
  const hit = findText(frame.term, needle)
  if (hit === null) return false
  frame.stdin.write('\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + 'M')
  await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
  frame.stdin.write('\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + 'm')
  return true
}

const ev = (type: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ type, ...over })
const historyPage = (events: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> => ({ events, parentAgentId: null, uuids: [], hasOlder: false, skippedFromStart: 0, ...over })

function makeRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: id,
    description: 'agent ' + id,
    status: 'completed',
    startedAt: NOW - 60_000,
    completedAt: NOW - 10_000,
    output: [],
    outputEvents: [],
    toolCalls: [],
    ...over,
  }
}

// ── W3: the workbench scene ───────────────────────────────────────────────
console.log('--- W3: workbench panel + sibling switching ---')
{
  // Two depth-1 siblings (same main-loop parent) with distinct histories.
  const pages = new Map<string, Record<string, unknown>>([
    ['agent-a', historyPage([
      ev('assistant.message', { anchor: 'aa1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'alpha unique marker one' }] }),
      ev('tool.call', { callId: 'ac1', name: 'Grep', argsJson: '{}', time: NOW - 30_000, seq: 1, turn: 1, step: 1 }),
      ev('tool.result', { callId: 'ac1', isError: false, text: 'alpha tool body', time: NOW - 20_000, seq: 2, turn: 1, step: 1, content: [] }),
    ])],
    ['agent-b', historyPage([
      ev('assistant.message', { anchor: 'bb1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'beta unique marker two' }] }),
    ])],
  ])
  const load = async (agentId: string): Promise<Record<string, unknown> | null> => pages.get(agentId) ?? null
  const roster = [
    makeRow('agent-a', { mode: 'continuable', model: 'fixture-model', tokens: { input: 10, output: 5, total: 15 }, toolCalls: [{ id: 't1', name: 'Grep', status: 'completed', startedAt: NOW - 30_000, endedAt: NOW - 20_000 }] }),
    makeRow('agent-b', { depth: 1 }),
    makeRow('agent-c', { depth: 1 }),
    makeRow('agent-nested', { depth: 2, parentAgentId: 'agent-a' }),
  ]
  // roster rows carry depth 1 for a/b/c (the main-loop proof)
  roster[0] = makeRow('agent-a', { depth: 1, mode: 'continuable', model: 'fx-model', tokens: { input: 10, output: 5, total: 15 }, toolCalls: [{ id: 't1', name: 'Grep', status: 'completed', startedAt: NOW - 30_000, endedAt: NOW - 20_000 }] })
  const switched: string[] = []
  let exited = 0
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: roster[0],
      source: { kind: 'transcript-card', rowId: 3 },
      onExit: () => { exited += 1 },
      loadTranscript: load as never,
      roster: roster as never,
      onSwitchAgent: (id: string) => { switched.push(id) },
    }),
    async frame => {
      check('W3 宽屏渲染右侧工作台面板', await settled(() => frame.screen().includes('workbench') && frame.screen().includes('metadata') && frame.screen().includes('parent & siblings')), frame.lines().slice(0, 2).join('|'))
      check('W3 面板元数据：状态/模式/模型', frame.screen().includes('completed') && frame.screen().includes('continuable') && frame.screen().includes('fx-model'))
      check('W3 面板工具段保留记录', frame.screen().includes('Grep'))
      check('W3 父关系=主循环（depth 1 事实）', frame.screen().includes('main loop'))
      check('W3 同主循环兄弟列出（b/c）', frame.screen().includes('agent agent-b') && frame.screen().includes('agent agent-c'))
      check('W3 嵌套不同父不混入兄弟列表', !frame.screen().includes('agent agent-nested'))
      // keyboard: Tab focuses the panel, arrows walk, Enter switches
      frame.stdin.write('\t')
      await settled(() => frame.screen().includes('select'))
      frame.stdin.write('\x1b[B') // ↓ past the first sibling (agent-b)
      await sleep(30) // 固定窗:pacing 焦点移动重渲染
      frame.stdin.write('\r')
      check('W3 键盘 Enter 原地切换兄弟（调 onSwitchAgent）', await settled(() => switched.length === 1 && switched[0] === 'agent-c'), JSON.stringify(switched))
      // rerender as the wiring would: subagent=b, same source (the panel
      // keeps focus across the switch — Esc first leaves the panel, the
      // second Esc exits the scene to the ORIGINAL source)
      frame.rerender(React.createElement(AgentTranscriptScene, {
        subagent: roster[1],
        source: { kind: 'transcript-card', rowId: 3 },
        onExit: () => { exited += 1 },
        loadTranscript: load as never,
        roster: roster as never,
        onSwitchAgent: (id: string) => { switched.push(id) },
      }))
      check('W3 切换后新代理转录载入', await settled(() => frame.screen().includes('beta unique marker two')), frame.lines().slice(0, 4).join('|'))
      check('W3 旧代理行不残留（不混消息）', await settled(() => !frame.screen().includes('alpha unique marker one') && !frame.screen().includes('alpha tool body')))
      check('W3 切换后顶栏换成新代理描述', frame.screen().includes('agent agent-b'))
      // Esc still exits to the ORIGINAL source (not the previous agent):
      // the first Esc only leaves the focused panel.
      frame.stdin.write('\x1b')
      await sleep(30) // 固定窗:pacing 焦点层切换
      frame.stdin.write('\x1b')
      check('W3 Esc 退出场景一次（来源栈未被切换推入）', await settled(() => exited === 1), String(exited))
    },
  )

  // Mouse switching + the composer draft never travels across targets.
  const dispatchLog: Array<Record<string, unknown>> = []
  const control = {
    via: 'parent-mediated',
    steer: false,
    listTargets: async () => [],
    messages: () => [],
    submit: async (input: Record<string, unknown>) => {
      dispatchLog.push(input)
      return { ok: true, intentId: 'intent-' + (dispatchLog.length), state: 'issued' }
    },
  }
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: roster[0],
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
      loadTranscript: load as never,
      roster: roster as never,
      onSwitchAgent: (id: string) => { switched.push(id) },
      compose: { control, target: { agentId: 'agent-a', name: 'agent agent-a' } } as never,
    }),
    async frame => {
      check('W3 composer 挂载', await settled(() => frame.screen().includes('Send to agent agent-a')))
      frame.stdin.write('secret draft for a')
      check('W3 草稿接收输入', await settled(() => frame.screen().includes('secret draft for a')))
      check('W3 鼠标点击兄弟行切换', await click(frame, 'agent agent-c'), 'row not found')
      check('W3 点击发出 onSwitchAgent(agent-c)', await settled(() => switched.includes('agent-c')), JSON.stringify(switched))
      // wiring rerenders with target B: the composer remounts (keyed)
      frame.rerender(React.createElement(AgentTranscriptScene, {
        subagent: roster[2],
        source: { kind: 'chat', returnFocus: 'prompt' },
        onExit: () => {},
        loadTranscript: load as never,
        roster: roster as never,
        onSwitchAgent: (id: string) => { switched.push(id) },
        compose: { control, target: { agentId: 'agent-c', name: 'agent agent-c' } } as never,
      }))
      check('W3 草稿不随目标漂移（重挂清空）', await settled(() => !frame.screen().includes('secret draft for a') && frame.screen().includes('Send to agent agent-c')))
      check('W3 未提交的草稿没有发往任何目标', dispatchLog.length === 0, JSON.stringify(dispatchLog))
    },
  )

  // 40 columns: the single-column layout, no workbench rail.
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: roster[0],
      source: { kind: 'agents-dashboard' },
      onExit: () => {},
      loadTranscript: load as never,
      roster: roster as never,
    }),
    async frame => {
      check('W3 窄屏（40 列）面板退场', await settled(() => frame.screen().includes('alpha unique marker one')) && !frame.screen().includes('workbench'))
      check('W3 窄屏顶栏仍显示代理名', frame.lines().slice(0, 3).some(line => line.includes(t('subagent-card-prefix') + 'agent')), frame.lines().slice(0, 3).join('|'))
    },
    40,
  )

  // A long line wraps inside the 28-column screen instead of being laid out
  // wider than the terminal and clipped at the edge.
  const longPage = historyPage([
    ev('assistant.message', { anchor: 'w1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'first second third fourth fifth sixth seventh eighth ninth LASTWORD' }] }),
  ])
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: roster[0],
      source: { kind: 'agents-dashboard' },
      onExit: () => {},
      loadTranscript: (async () => longPage) as never,
    }),
    async frame => {
      check('W3 28 列长行完整折行（末词可见）', await settled(() => frame.screen().includes('LASTWORD')), frame.lines().slice(0, 10).join('|'))
    },
    28,
  )
}

// ── W4: peer roster partition (Dashboard) ─────────────────────────────────
console.log('--- W4: dashboard children/peers partition ---')
{
  const { SubagentDashboard } = (await import('../src/components/SubagentDashboard.js')) as unknown as { SubagentDashboard: React.ComponentType<Record<string, unknown>> }
  const mainA = makeRow('agent-a', { depth: 1 })
  const mainB = makeRow('agent-b', { depth: 1 })
  const nestedKnown = makeRow('agent-n1', { depth: 2, parentAgentId: 'agent-a' })
  const nestedOld = makeRow('agent-n2', { depth: 2 })

  // (1) children-only roster, no peers prop: no peers section at all (no
  // roster capability, nothing to draw), and no nested marks.
  const selected: string[] = []
  await withTerminal(
    () => React.createElement(SubagentDashboard, {
      subagents: [mainA, mainB] as never,
      onSelect: (id: string) => { selected.push(id) },
      onClose: () => {},
    }),
    async frame => {
      await settled(() => frame.screen().includes('agent agent-b'))
      check('W4 无 peer 名册能力：不画 peers 分区', !frame.screen().includes(t('agents-peers-title')))
      check('W4 纯直属名册保持 P1 平铺（无嵌套标记）', !frame.screen().includes('nested'))
      // keyboard walks the displayed order: ↓ then Enter selects agent-b
      frame.stdin.write('\x1b[B')
      await sleep(30) // 固定窗:pacing 焦点移动重渲染
      frame.stdin.write('\r')
      check('W4 键盘走显示顺序选择 agent-b', await settled(() => selected.length === 1 && selected[0] === 'agent-b'), JSON.stringify(selected))
    },
  )

  // (1b) An empty peer roster is not useful panel content.
  await withTerminal(
    () => React.createElement(SubagentDashboard, {
      subagents: [mainA] as never,
      peers: [] as never,
      variant: 'panel',
      onSelect: () => {},
    }),
    async frame => {
      await settled(() => frame.screen().includes('agent agent-a'))
      check('W4 panel variant hides empty peers and its duplicate heading/footer', !frame.screen().includes(t('agents-peers-title')) && !frame.screen().includes(t('subagent-dashboard-title')) && !frame.screen().includes('Enter view detail'))
    },
  )

  // (2) partition: main-loop children first, nested spawns after with the
  // ↳ mark (known parent AND old-format unknown parent both nest).
  await withTerminal(
    () => React.createElement(SubagentDashboard, {
      subagents: [mainA, nestedKnown, mainB, nestedOld] as never,
      onSelect: () => {},
      onClose: () => {},
    }),
    async frame => {
      const screen = () => frame.screen()
      await settled(() => screen().includes('agent agent-b'))
      const a = screen().indexOf('agent agent-a')
      const b = screen().indexOf('agent agent-b')
      const n1 = screen().indexOf('agent agent-n1')
      const n2 = screen().indexOf('agent agent-n2')
      check('W4 直属在前嵌套在后（分区排序）', a >= 0 && b > a && n1 > b && n2 > n1, JSON.stringify({ a, b, n1, n2 }))
      check('W4 嵌套行带 ↳ 标记', screen().includes('↳'))
      check('W4 计数行含嵌套数', screen().includes('nested'))
    },
  )

  // (3) served peers: own section, never mixed into children, and NO
  // interactive affordance (cross-session targets are not addressable
  // through the parent relay or the direct child prompt).
  const selected2: string[] = []
  await withTerminal(
    () => React.createElement(SubagentDashboard, {
      subagents: [mainA] as never,
      peers: [{ agentId: 'peer-session-0001', name: 'codex' }, { agentId: 'peer-session-0002', label: 'teammate row' }] as never,
      onSelect: (id: string) => { selected2.push(id) },
      onClose: () => {},
    }),
    async frame => {
      check('W4 served peers 渲染在独立分区', await settled(() => frame.screen().includes('codex') && frame.screen().includes('teammate row') && frame.screen().includes('peer-ses')))
      const childrenAt = frame.screen().indexOf('agent agent-a')
      const peersAt = frame.screen().indexOf(t('agents-peers-title'))
      check('W4 children 在 peers 分区之前（不混淆分区）', childrenAt >= 0 && peersAt > childrenAt, JSON.stringify({ childrenAt, peersAt }))
      check('W4 peer 行注明无发送入口（跨会话降级）', frame.screen().includes(t('agents-peers-note')))
      await click(frame, 'codex')
      check('W4 点击 peer 行不触发任何 child 导航', selected2.length === 0, JSON.stringify(selected2))
      const childrenCount = (frame.screen().match(/agent agent-a/g) ?? []).length
      check('W4 children 不重复出现在 peers 分区', childrenCount === 1, String(childrenCount))
    },
  )
}

// ── W6: transcript paging with the agent message feed ─────────────────────
console.log('--- W6: transcript paging ---')
{
  const fold = await import('../src/components/messages/subagentTranscript.js')
  const message = (id: string, observedAt: number): Record<string, unknown> => ({ messageId: id, from: 'parent', to: 'agent-a', via: 'agent-relay', text: 'note ' + id, state: 'queued', observedAt })
  const messages = [message('m-old', NOW - 90_000), message('m-mid', NOW - 35_000), message('m-new', NOW - 5_000)]
  const newest = [
    ev('assistant.message', { anchor: 'n1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'newest page text' }] }),
    ev('assistant.message', { anchor: 'n2', time: NOW - 30_000, blocks: [{ type: 'text', text: 'newest page tail' }] }),
  ]
  const older = [ev('assistant.message', { anchor: 'o1', time: NOW - 100_000, blocks: [{ type: 'text', text: 'older page text' }] })]
  const leaves: Array<Record<string, unknown>> = []
  const from = fold.foldTranscriptLeaves(newest as never, leaves as never, messages as never, { olderPagesRemain: true })
  const ids = (rows: Array<Record<string, unknown>>): string[] => rows.filter(row => row.kind === 'agent-message').map(row => (row.message as { messageId: string }).messageId)
  check('W6 newest 页不收更早页的消息', ids(leaves).join(',') === 'm-mid,m-new', JSON.stringify(ids(leaves)))
  const olderLeaves: Array<Record<string, unknown>> = []
  fold.foldTranscriptLeaves(older as never, olderLeaves as never, messages as never, { olderPagesRemain: false, before: from })
  const merged = fold.prependOlderLeaves(olderLeaves as never, leaves as never) as unknown as Array<Record<string, unknown>>
  check('W6 载入更早后每条消息恰好一次且按序', ids(merged).join(',') === 'm-old,m-mid,m-new', JSON.stringify(ids(merged)))

  // A call on the older page whose result landed on the newer one: the
  // card settles once the older page is folded in (it does not stay
  // running forever).
  const splitNewest = historyPage([
    ev('tool.result', { callId: 'split-1', isError: false, text: 'split result body', time: NOW - 20_000, seq: 9, turn: 1, step: 1, content: [] }),
    ev('assistant.message', { anchor: 'sn1', time: NOW - 10_000, blocks: [{ type: 'text', text: 'after the split call' }] }),
  ], { hasOlder: true, skippedFromStart: 10 })
  const splitOlder = historyPage([
    ev('tool.call', { callId: 'split-1', name: 'Grep', argsJson: '{}', time: NOW - 30_000, seq: 8, turn: 1, step: 1 }),
  ], { hasOlder: false, skippedFromStart: 0 })
  const newestState = fold.foldNewestPage('agent-a', splitNewest as never, [])
  check('W6 新页记下找不到调用的结果', newestState.orphanResults.has('split-1'), JSON.stringify([...newestState.orphanResults.keys()]))
  const joined = fold.foldOlderPage(newestState, splitOlder as never, [])
  const splitCard = joined.leaves.find(leaf => leaf.kind === 'tool') as { tool: { status: string; resultText?: string } } | undefined
  check('W6 跨页的调用拿到新页里的结果（不停在 running）', splitCard?.tool.status === 'ok' && splitCard.tool.resultText === 'split result body', JSON.stringify(splitCard?.tool))
  check('W6 配上的结果不再挂在待配表里', joined.orphanResults.size === 0)

  const live = makeRow('agent-a', { status: 'running', completedAt: undefined, toolCalls: [{ id: 'tc1', name: 'Read', status: 'completed', startedAt: NOW - 20_000, endedAt: NOW - 10_000, resultPreview: 'live result' }] })
  const history = [{ kind: 'tool', key: 'tc1', tool: { callId: 'tc1', name: 'Read', argsText: '{}', status: 'running', startedAt: NOW - 20_000 } }]
  const overlaid = fold.mergeLiveWindow(history as never, live as never, true) as unknown as Array<{ tool?: { status: string } }>
  check('W6 live 状态叠加到合并结果', overlaid[0]?.tool?.status === 'ok', JSON.stringify(overlaid[0]))
  check('W6 live 合并不改写历史叶子', history[0]!.tool.status === 'running', JSON.stringify(history[0]))

  // Scene: the feed placed once across a load-older, then an older request
  // left in flight while the view switches to another agent.
  let releaseOlder: ((page: Record<string, unknown>) => void) | undefined
  const scenePages = (agentId: string, window?: { count: number; skipFromStart: number }): Promise<Record<string, unknown>> => {
    if (agentId === 'agent-b') return Promise.resolve(historyPage([ev('assistant.message', { anchor: 'b1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'beta newest body' }] })]))
    if (window === undefined) return Promise.resolve(historyPage(newest, { hasOlder: true, skippedFromStart: 800 }))
    if (window.skipFromStart === 800) return Promise.resolve(historyPage(older, { hasOlder: true, skippedFromStart: 400 }))
    return new Promise(resolve => { releaseOlder = resolve })
  }
  const sceneProps = (row: Record<string, unknown>): Record<string, unknown> => ({
    subagent: row,
    source: { kind: 'agents-dashboard' },
    onExit: () => {},
    loadTranscript: scenePages as never,
    messages: row.agentId === 'agent-a' ? messages : [],
  })
  const rowA = makeRow('agent-a')
  const rowB = makeRow('agent-b')
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, sceneProps(rowA)),
    async frame => {
      await settled(() => frame.screen().includes('newest page tail'))
      // useInput swaps in the new handler in a passive effect: a key sent in
      // the same tick as the frame can still reach the previous render's.
      await sleep(30) // 固定窗:pacing 等被动 effect 换上新的按键处理器
      frame.stdin.write('o')
      check('W6 场景载入更早页', await settled(() => frame.screen().includes('older page text')), frame.lines().slice(0, 12).join('|'))
      const count = (needle: string): number => frame.screen().split(needle).length - 1
      check('W6 场景里每条消息只画一次', count('note m-mid') === 1 && count('note m-new') === 1 && count('note m-old') === 1, JSON.stringify({ mid: count('note m-mid'), recent: count('note m-new'), old: count('note m-old') }))
      frame.stdin.write('o')
      await settled(() => releaseOlder !== undefined)
      frame.rerender(React.createElement(AgentTranscriptScene, sceneProps(rowB)))
      await settled(() => frame.screen().includes('beta newest body'))
      releaseOlder?.(historyPage([ev('assistant.message', { anchor: 'z1', time: NOW - 200_000, blocks: [{ type: 'text', text: 'alpha oldest leak' }] })], { hasOlder: false, skippedFromStart: 0 }))
      await sleep(100) // 固定窗:探针 负向断言：给迟到的更早页留出拼接的时间
      check('W6 切换代理后旧代理的更早页不拼进来', !frame.screen().includes('alpha oldest leak') && frame.screen().includes('beta newest body'), frame.lines().slice(0, 10).join('|'))
    },
  )
}

// ── W7: tail follow yields to the user's scroll ──────────────────────────
console.log('--- W7: tail follow ---')
{
  const lines = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_, index) => ({ kind: 'text', text: 'tail line ' + String(index).padStart(3, '0'), at: NOW, settled: true }))
  const running = (count: number): Record<string, unknown> => makeRow('agent-tail', { status: 'running', completedAt: undefined, outputEvents: lines(count) })
  const props = (count: number): Record<string, unknown> => ({ subagent: running(count), source: { kind: 'agents-dashboard' }, onExit: () => {} })
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, props(60)),
    async frame => {
      check('W7 运行中钉在尾部', await settled(() => frame.screen().includes('tail line 059')), frame.lines().slice(-6).join('|'))
      for (let index = 0; index < 4; index += 1) {
        frame.stdin.write('\x1b[A')
        await sleep(20) // 固定窗:pacing 逐键滚动
      }
      await settled(() => !frame.screen().includes('tail line 059'))
      frame.rerender(React.createElement(AgentTranscriptScene, props(64)))
      await sleep(150) // 固定窗:探针 负向断言：给错误的跟尾留出发生的时间
      check('W7 上滚后新输出不把视图拽回底部', !frame.screen().includes('tail line 063'), frame.lines().slice(-6).join('|'))
      frame.stdin.write('\x1b[6~')
      await sleep(20) // 固定窗:pacing 滚回底部
      frame.stdin.write('\x1b[6~')
      await settled(() => frame.screen().includes('tail line 063'))
      frame.rerender(React.createElement(AgentTranscriptScene, props(68)))
      check('W7 滚回底部后恢复跟随', await settled(() => frame.screen().includes('tail line 067')), frame.lines().slice(-6).join('|'))
    },
  )
}

// ── W8: Detail transcript page ────────────────────────────────────────────
console.log('--- W8: detail transcript page ---')
{
  const { SubagentDetailScene } = (await import('../src/components/SubagentDetailScene.js')) as unknown as { SubagentDetailScene: React.ComponentType<Record<string, unknown>> }
  const history = Array.from({ length: 40 }, (_, index) =>
    ev('assistant.message', { anchor: 'h' + index, time: NOW - 50_000 + index, blocks: [{ type: 'text', text: 'history row ' + String(index).padStart(2, '0') }] }))
  const olderRows = [ev('assistant.message', { anchor: 'old1', time: NOW - 90_000, blocks: [{ type: 'text', text: 'detail older row' }] })]
  const loader = async (_agentId: string, window?: { skipFromStart: number }): Promise<Record<string, unknown>> =>
    window === undefined ? historyPage(history, { hasOlder: true, skippedFromStart: 500 }) : historyPage(olderRows, { hasOlder: false, skippedFromStart: 0 })
  const row = (outputs: number): Record<string, unknown> => makeRow('agent-detail', {
    status: 'running',
    completedAt: undefined,
    outputEvents: Array.from({ length: outputs }, (_, index) => ({ kind: 'text', text: 'live out ' + index, at: NOW, settled: true })),
  })
  const props = (outputs: number): Record<string, unknown> => ({ subagent: row(outputs), onBack: () => {}, loadTranscript: loader as never })
  await withTerminal(
    () => React.createElement(SubagentDetailScene, props(1)),
    async frame => {
      await settled(() => frame.screen().includes(t('subagent-tab-summary')))
      frame.stdin.write('\x1b[C')
      await sleep(30) // 固定窗:pacing 逐页
      frame.stdin.write('\x1b[C')
      check('W8 进入转录页（历史已载入）', await settled(() => frame.screen().includes('history row')), frame.lines().slice(0, 12).join('|'))
      const loadOlderHint = 'o ' + t('subagent-transcript-load-older', { count: 400 })
      check('W8 页脚提示 o 载入更早', frame.screen().includes(loadOlderHint), frame.lines().slice(-3).join('|'))
      await sleep(30) // 固定窗:pacing 等被动 effect 换上新的按键处理器
      frame.stdin.write('o')
      // The older page has no older one: the footer hint goes away.
      check('W8 o 键载入更早一页（页脚提示随之消失）', await settled(() => !frame.screen().includes(loadOlderHint)), frame.lines().slice(-3).join('|'))
      // Scroll up to the top of the history: the older row is there.
      for (let press = 0; press < 40; press += 1) {
        frame.stdin.write('\x1b[A')
        await sleep(5) // 固定窗:pacing 逐键滚动
      }
      check('W8 更早一页拼在转录顶部', await settled(() => frame.screen().includes('detail older row')), frame.lines().slice(4, 12).join('|'))
      // At the top of the history while the child keeps streaming: the view
      // stays put.
      for (const outputs of [2, 3, 4]) {
        frame.rerender(React.createElement(SubagentDetailScene, props(outputs)))
        await sleep(40) // 固定窗:pacing 让每条新输出各自渲染一帧
      }
      await sleep(100) // 固定窗:探针 负向断言：给错误的跟尾留出发生的时间
      check('W8 运行中新输出不把转录页拽到底部', frame.screen().includes('detail older row') && !frame.screen().includes('live out 3'), frame.lines().slice(4, 14).join('|'))
    },
  )
}

// ── W5: side-panel Detail composer key routing ────────────────────────────
console.log('--- W5: side-panel detail composer ---')
{
  const [{ SidePanelColumn }, { useSidePanel }, prefs, { ThemeProvider }] = await Promise.all([
    import('../src/components/sidePanel/SidePanelColumn.js'),
    import('../src/components/sidePanel/useSidePanel.js'),
    import('../src/tuiDisplayPrefs.js'),
    import('../src/ui.js'),
  ])
  prefs.applySidePanelOpen(true)
  prefs.applySidePanelRatio(0.5)
  const WIDE = 140
  const submitted: Array<Record<string, unknown>> = []
  const child = makeRow('agent-p1', { description: 'panel child', status: 'running', completedAt: undefined, mode: 'continuable' })
  const channel = {
    version: 1,
    subagents: [child],
    backgroundJobs: [],
    subagentControl: {
      interrupt: () => true,
      message: {
        via: 'agent-relay',
        steer: false,
        listTargets: async () => [],
        messages: () => [],
        submit: async (input: Record<string, unknown>) => {
          submitted.push(input)
          return { ok: true, intentId: 'intent-p' + submitted.length, state: 'queued' }
        },
      },
    },
    notifications: [],
    notify: () => {},
    subscribe: () => () => {},
  }
  let controller: ReturnType<typeof useSidePanel> | undefined
  let chatTyped = ''
  // Chat's shape: one listener mounted before any panel content, handing the
  // real event to the host so its stopImmediatePropagation takes effect.
  function Host(): React.ReactNode {
    const sp = useSidePanel({ columns: WIDE, fullscreen: true, editorOpen: false })
    controller = sp
    const [, bump] = React.useState(0)
    useInput(((input: string, key: Record<string, boolean | undefined>, event: unknown) => {
      if (!sp.handleKey(input, key as never, event as never) && input !== '' && key.ctrl !== true && key.return !== true) chatTyped += input
      bump(n => n + 1)
    }) as never)
    return React.createElement(ThemeProvider, { theme: 'dark' },
      React.createElement(Box, { flexDirection: 'row', width: WIDE, height: ROWS },
        React.createElement(Box, { width: sp.split ? sp.chatColumns : WIDE }, React.createElement(Text, null, 'chat-anchor focus=' + sp.focus)),
        sp.split ? React.createElement(SidePanelColumn, { width: sp.panelColumns, controller: sp, channel: channel as never }) : null,
      ))
  }
  const key = async (frame: Frame, data: string): Promise<void> => {
    frame.stdin.write(data)
    await new Promise(resolve => setImmediate(resolve))
  }
  await withTerminal(
    () => React.createElement(Host),
    async frame => {
      await settled(() => controller?.split === true)
      controller?.openPanel('agents', { focus: true })
      await settled(() => frame.screen().includes('panel child'))
      await key(frame, '\r')
      const composeTitle = t('agent-message-compose-title', { name: 'panel child' })
      check('W5 侧栏 Detail 挂出 composer', await settled(() => frame.screen().includes(composeTitle)), frame.lines().slice(0, 6).join('|'))
      await key(frame, 'i')
      await sleep(30) // 固定窗:pacing 聚焦是 state 翻转，没有可读的屏幕变化
      for (const ch of 'hi there') await key(frame, ch)
      check('W5 i 聚焦后打字进 composer 草稿', await settled(() => frame.screen().includes('hi there')), frame.lines().filter(l => l.includes(composeTitle) || l.includes('there')).join('|'))
      // The first Esc only leaves the editor (no visible change), the second
      // one is the Detail's own Esc back to the dashboard — neither may hand
      // the focus to chat.
      await key(frame, '\x1b')
      await sleep(80) // 固定窗:pacing 单独 Esc 要等 50ms 解析窗才成键
      await key(frame, '\x1b')
      check('W5 Esc 先让出编辑焦点、再回 Dashboard，焦点留在侧栏', await settled(() => !frame.screen().includes(composeTitle) && frame.screen().includes('1 ' + t('subagent-count-running'))) && controller?.focus === 'panel', String(controller?.focus))
      // Back into the editor, then the host moves focus to chat (a click on
      // the chat column does the same) while the composer still holds it.
      await key(frame, '\r')
      await settled(() => frame.screen().includes(composeTitle))
      await key(frame, 'i')
      await sleep(30) // 固定窗:pacing 同上
      for (const ch of 'abc') await key(frame, ch)
      check('W5 重新聚焦后草稿可编辑', await settled(() => frame.screen().includes('abc')))
      controller?.focusChat()
      await settled(() => frame.screen().includes('chat-anchor focus=chat'))
      for (const ch of 'zq') await key(frame, ch)
      await key(frame, '\r')
      await sleep(60) // 固定窗:探针 负向断言：给错误投递留出发生的时间
      check('W5 聊天里的键到了聊天', chatTyped.includes('zq'), JSON.stringify(chatTyped))
      check('W5 聊天打字不进侧栏 composer', !frame.screen().includes('abczq'), frame.lines().filter(l => l.includes('abc')).join('|'))
      check('W5 聊天 Enter 不把草稿发给子代理', submitted.length === 0, JSON.stringify(submitted))
    },
    WIDE,
  )
}

if (failed > 0) {
  console.error('verify-agent-workbench FAILED (' + failed + ' checks)')
  process.exit(1)
}
console.log('verify-agent-workbench OK (' + passed + ' checks)')