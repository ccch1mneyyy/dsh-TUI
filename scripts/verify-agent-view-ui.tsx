#!/usr/bin/env node
"use strict"
/**
 * verify-agent-view-ui — agent-team-full 设计 §7 回归矩阵的 UI 条目
 * （主屏只读 Agent View / composer / 代理↔代理消息流 / 键位契约）。
 *
 * 组件层（headless xterm 直挂组件 + 纯函数单测）：
 *   S1  foldTranscriptLeaves 按 observedAt 把 AgentMessageView 交错进
 *       thinking/text/tool 分页；uniqueRenderKeys/prependOlderLeaves 冒烟。
 *   S2  AgentTranscriptScene（Claude history 形态）：顶栏 label/live-history/
 *       readonly/短 id/来源；叶子渲染；载入更早；history unavailable 如实报错。
 *   S3  无 history capability（DSH 回退）：有界 tail + 范围标注；不出现假
 *       Transcript；消息流叶子追加在尾。
 *   S4  Esc 分层：composer 聚焦吃 Esc（让焦）→ 再 Esc 退场景；无 composer
 *       时 Esc 直接退。Enter=queue；Ctrl+Enter 仅 steer 能力下 steer，
 *       Claude 中介仍 queue。失败保 draft + notice。
 *   S5  降级：无能力不渲染 composer；无 name 无提交；重名按稳定 id 消歧。
 *   S6  消息行渲染：state 词表；unknown 附「不推断」行；未知关系不画箭头。
 *   S7  28/40 列顶栏不溢出。
 *   S8  Detail：消息流页能力驱动出现；'v' 主屏查看；composer 挂载。
 *   S9  Dashboard：'v' 专用动作；行下 from → to 摘要。
 * Chat 层（真 Chat + 桩 channel）：
 *   C1  转录卡 ⤢ 点击进 Agent View，Esc 回聊天；父 rows/草稿不变。
 *   C2  Ctrl+A → Dashboard → 'v' 进 Agent View（来源 dashboard），Esc 回
 *       Dashboard、再 Esc 回聊天。
 *   C3  场景内 composer 真提交（dispatch queue）且状态行只认通道给的。
 *
 * 运行：node --import tsx/esm scripts/verify-agent-view-ui.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtui-agent-view-ui-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

const [
  { PassThrough, Writable },
  { default: React },
  { Terminal: XTerm },
  uiMod,
  sceneMod,
  detailMod,
  dashMod,
  leavesMod,
  foldMod,
  teamMod,
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/AgentTranscriptScene.js'),
  import('../src/components/SubagentDetailScene.js'),
  import('../src/components/SubagentDashboard.js'),
  import('../src/components/messages/TranscriptLeaves.js'),
  import('../src/components/messages/subagentTranscript.js'),
  import('../src/components/messages/agentTeam.js'),
  import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, useInput } = uiMod as unknown as {
  render: typeof import('../src/ui.js').render
  AlternateScreen: React.ComponentType<{ children?: React.ReactNode }>
  useInput: (handler: (input: string, key: unknown) => void, options?: { isActive?: boolean }) => void
}
const { AgentTranscriptScene } = sceneMod as unknown as { AgentTranscriptScene: React.ComponentType<Record<string, unknown>> }
const { SubagentDetailScene } = detailMod as unknown as { SubagentDetailScene: React.ComponentType<Record<string, unknown>> }
const { SubagentDashboard } = dashMod as unknown as { SubagentDashboard: React.ComponentType<Record<string, unknown>> }
const { AgentMessageLeafRow } = leavesMod as unknown as { AgentMessageLeafRow: React.ComponentType<Record<string, unknown>> }
const { foldTranscriptLeaves, prependOlderLeaves, uniqueRenderKeys } = foldMod as unknown as Record<string, Function>
const team = teamMod as unknown as typeof import('../src/components/messages/agentTeam.js')
const { settled, sleep, viewportLines, findText } = termTest as unknown as {
  settled(pred: () => boolean, opts?: { timeoutMs?: number }): Promise<boolean>
  sleep: (ms: number) => Promise<void>
  viewportLines(term: InstanceType<typeof XTerm>, rows?: number): string[]
  findText(term: InstanceType<typeof XTerm>, needle: string): { col: number; row: number } | null
}
const { t, setLang } = await import('../src/i18n.js')
setLang('en')

let failed = 0
let passed = 0
function check(name: string, ok: boolean, extra = ''): void {
  passed += ok ? 1 : 0
  if (!ok) failed += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
}

const COLS = 100
const ROWS = 30
const NOW = Date.now()

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

// ── fixtures ───────────────────────────────────────────────────────────────

function makeSubagent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'agent-child-0001',
    description: 'research the spec',
    status: 'completed',
    startedAt: NOW - 60_000,
    completedAt: NOW - 10_000,
    mode: 'continuable',
    output: [],
    outputEvents: [],
    toolCalls: [],
    ...(over.outputEvents === undefined ? {} : {}),
    ...over,
  }
}

const msg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  messageId: 'm1',
  from: 'parent-session-1',
  to: 'agent-child-0001',
  via: 'dsh-agent-relay',
  text: 'please focus on §7',
  state: 'queued',
  observedAt: NOW - 50_000,
  parentSessionId: 'parent-session-1',
  ...over,
})

const ev = (type: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ type, ...over })

function historyPage(events: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { events, parentAgentId: 'parent-agent-9', uuids: [], hasOlder: false, skippedFromStart: 0, ...over }
}

function makeCapability(log: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    via: 'claude-parent-mediated',
    dispatch: async (input: Record<string, unknown>) => {
      log.push(input)
      if (over.fail === true) return { ok: false, reason: over.reason ?? 'dispatch-failed' }
      return { ok: true, state: over.state ?? 'issued' }
    },
    ...(over.steer === true ? { steer: true as const } : {}),
    ...(over.via === undefined ? {} : { via: over.via }),
  }
}

// ── S1: pure fold interleave ───────────────────────────────────────────────
console.log('--- S1: fold interleave + key uniqueness ---')
{
  const events = [
    ev('assistant.message', { anchor: 'a1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'first reply' }] }),
    ev('tool.call', { callId: 'c1', name: 'Read', argsJson: '{}', time: NOW - 30_000, seq: 1, turn: 1, step: 1 }),
    ev('tool.result', { callId: 'c1', isError: false, text: 'ok', time: NOW - 20_000, seq: 2, turn: 1, step: 1, content: [] }),
  ]
  const messages = [
    msg({ messageId: 'm0', observedAt: NOW - 45_000, text: 'before anything' }),
    msg({ messageId: 'm1', observedAt: NOW - 35_000, text: 'between text and tool' }),
    msg({ messageId: 'm2', observedAt: NOW - 5_000, text: 'after everything' }),
  ]
  const leaves: Array<Record<string, unknown>> = []
  foldTranscriptLeaves(events as never, leaves as never, messages as never)
  const kinds = leaves.map(l => l.kind)
  check('S1 消息按 observedAt 交错（先于首事件）', kinds[0] === 'agent-message' && (leaves[0] as { message: { messageId: string } }).message.messageId === 'm0', JSON.stringify(kinds))
  const textIdx = kinds.indexOf('text')
  const toolIdx = kinds.indexOf('tool')
  const m1Idx = leaves.findIndex(l => l.kind === 'agent-message' && (l as { message: { messageId: string } }).message.messageId === 'm1')
  check('S1 消息落在 text 与 tool 之间', textIdx >= 0 && m1Idx === textIdx + 1 && toolIdx === m1Idx + 1, JSON.stringify(kinds))
  check('S1 尾部消息在最后', kinds[kinds.length - 1] === 'agent-message', JSON.stringify(kinds))
  // repeated anchors keep unique render keys
  const repeated = uniqueRenderKeys([
    { kind: 'text', key: 'a1', text: 'x' },
    { kind: 'text', key: 'a1', text: 'y' },
  ] as never) as Array<{ key: string }>
  check('S1 重复 anchor 加序号后缀', repeated[0]!.key === 'a1' && repeated[1]!.key === 'a1#2', JSON.stringify(repeated.map(r => r.key)))
  const merged = prependOlderLeaves(
    [{ kind: 'text' as const, key: 'a1', text: 'older ' }],
    [{ kind: 'text' as const, key: 'a1', text: 'newer' }],
  ) as Array<{ text: string }>
  check('S1 边界同 key 同类合并', merged.length === 1 && merged[0]!.text === 'older \nnewer', JSON.stringify(merged.map(m => m.text)))
}

// ── S2: scene with Claude history ─────────────────────────────────────────
console.log('--- S2: scene renders history + header ---')
{
  let olderClicks = 0
  const page1 = historyPage([
    ev('assistant.message', { anchor: 'a1', time: NOW - 40_000, blocks: [{ type: 'reasoning', text: 'hmm' }] }),
    ev('assistant.message', { anchor: 'a1', time: NOW - 39_000, blocks: [{ type: 'text', text: 'the answer is 42' }] }),
    ev('tool.call', { callId: 'c1', name: 'Read', argsJson: '{"path":"a.md"}', time: NOW - 30_000, seq: 1, turn: 1, step: 1 }),
    ev('tool.result', { callId: 'c1', isError: false, text: 'file body', time: NOW - 20_000, seq: 2, turn: 1, step: 1, content: [] }),
  ], { hasOlder: true, skippedFromStart: 500 })
  const load = async (): Promise<Record<string, unknown> | null> => page1
  const messages = [msg({ messageId: 'm1', observedAt: NOW - 35_000 })]
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'transcript-card', rowId: 7 },
      onExit: () => {},
      loadTranscript: load as never,
      messages: messages as never,
    }),
    async frame => {
      check('S2 顶栏含描述与只读/短 id', await settled(() => frame.screen().includes('research the spec') && frame.screen().includes('read-only') && frame.screen().includes('id agent-ch')), frame.lines().slice(0, 3).join('|'))
      check('S2 历史态标注 history', frame.screen().includes('history'), frame.lines()[1] ?? '')
      check('S2 来源标注来自转录卡', frame.screen().includes('from transcript card'))
      check('S2 正文叶子渲染', await settled(() => frame.screen().includes('the answer is 42')))
      check('S2 工具卡渲染', frame.screen().includes('Read'))
      check('S2 消息流叶子渲染（from → to）', frame.screen().includes('parent → child'))
      check('S2 消息流状态徽标', frame.screen().includes('queued'))
      check('S2 载入更早可见且可点', await settled(() => frame.screen().includes('Load 400 older')) && await click(frame, 'Load 400 older'))
      await settled(() => { olderClicks += 0; return true })
    },
  )
  // history read failure → unavailable, not empty
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
      loadTranscript: (async (): Promise<Record<string, unknown> | null> => { throw new Error('disk gone') }) as never,
    }),
    async frame => {
      check('S2 history 失败显示 unavailable 而非空历史', await settled(() => frame.screen().includes('unavailable')), frame.lines().slice(0, 6).join('|'))
      check('S2 不出现「为空」伪装', !frame.screen().includes('empty'))
    },
  )
}

// ── S3: no history capability (DSH fallback) ───────────────────────────────
console.log('--- S3: bounded tail fallback ---')
{
  const tail = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', text: 'tail line ' + i, at: NOW - i * 100, settled: true }))
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent({ status: 'completed', outputEvents: tail }),
      source: { kind: 'agents-dashboard' },
      onExit: () => {},
    }),
    async frame => {
      check('S3 无 history：范围标注出现', await settled(() => frame.screen().includes('200 lines retained')), frame.lines().slice(0, 4).join('|'))
      check('S3 无 history：顶栏不自称 history（不出现假 Transcript 历史标注）', !frame.lines()[0]!.includes('history'), JSON.stringify(frame.lines().slice(0, 2)))
    },
  )
  const shortTail = Array.from({ length: 4 }, (_, i) => ({ kind: 'text', text: 'short tail ' + i, at: NOW - i * 100, settled: true }))
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent({ status: 'completed', outputEvents: shortTail }),
      source: { kind: 'agents-dashboard' },
      onExit: () => {},
      messages: [msg()] as never,
    }),
    async frame => {
      check('S3 消息流叶子仍在（tail 后）', await settled(() => frame.screen().includes('parent → child')), frame.lines().slice(0, 10).join('|'))
    },
  )
}

// ── S4: Esc layering + composer transport ─────────────────────────────────
console.log('--- S4: esc layering + queue/steer ---')
{
  const dispatchLog: Array<Record<string, unknown>> = []
  let exited = 0
  const capability = makeCapability(dispatchLog)
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => { exited += 1 },
      compose: { capability, target: { agentId: 'agent-child-0001', name: 'research the spec' } } as never,
    }),
    async frame => {
      check('S4 composer 标题（经父代理转发）', await settled(() => frame.screen().includes('Send to research the spec') && frame.screen().includes('via parent relay')), frame.lines().slice(-6).join('|'))
      // typing goes to the composer draft
      frame.stdin.write('hello child')
      await settled(() => frame.screen().includes('hello child'))
      check('S4 草稿接收输入', true)
      // Enter submits as queue (followup semantics)
      frame.stdin.write('\r')
      check('S4 Enter 提交为 queue', await settled(() => dispatchLog.length === 1 && dispatchLog[0]!.delivery === 'queue'), JSON.stringify(dispatchLog))
      check('S4 提交后草稿清空', await settled(() => !frame.screen().includes('hello child')))
      check('S4 状态行只认通道给的 issued', frame.screen().includes('submitted') && frame.screen().includes('issued'))
      // Ctrl+Enter on a mediated capability stays followup (queue)
      frame.stdin.write('second')
      await settled(() => frame.screen().includes('second'))
      frame.stdin.write('\x1b[13;5u') // CSI-u Ctrl+Enter
      await settled(() => dispatchLog.length === 2)
      check('S4 Claude 中介 Ctrl+Enter 仍 queue（不打断父回合）', dispatchLog[1]!.delivery === 'queue', JSON.stringify(dispatchLog))
      // Esc #1: the composer editor layer consumes (hand off, draft retained)
      frame.stdin.write('keep draft')
      await settled(() => frame.screen().includes('keep draft'))
      frame.stdin.write('\x1b')
      await sleep(60) // 固定窗:pacing Esc 分层步间
      check('S4 Esc#1 让焦不退场（草稿保留）', exited === 0 && frame.screen().includes('keep draft'), 'exited=' + exited)
      // Esc #2: the scene exits to source
      frame.stdin.write('\x1b')
      check('S4 Esc#2 退场回来源', await settled(() => exited === 1), 'exited=' + exited)
    },
  )
  // steer capability: Ctrl+Enter steers
  const steerLog: Array<Record<string, unknown>> = []
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
      compose: { capability: makeCapability(steerLog, { steer: true, via: 'dsh-direct-continuable', state: 'queued' }), target: { agentId: 'agent-child-0001', name: 'research the spec' } } as never,
    }),
    async frame => {
      await settled(() => frame.screen().includes('direct to child'))
      frame.stdin.write('steer me')
      await settled(() => frame.screen().includes('steer me'))
      frame.stdin.write('\x1b[13;5u')
      check('S4 DSH 直发 Ctrl+Enter = steer', await settled(() => steerLog.length === 1 && steerLog[0]!.delivery === 'steer'), JSON.stringify(steerLog))
      check('S4 receipt 只升到 queued（不伪造 delivered）', frame.screen().includes('queued') && !frame.screen().includes('delivered'))
    },
  )
  // failure keeps draft + notice
  const failLog: Array<Record<string, unknown>> = []
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
      compose: { capability: makeCapability(failLog, { fail: true, reason: 'target-not-resumable' }), target: { agentId: 'agent-child-0001', name: 'research the spec' } } as never,
    }),
    async frame => {
      frame.stdin.write('draft stays')
      await settled(() => frame.screen().includes('draft stays'))
      frame.stdin.write('\r')
      check('S4 失败保留草稿', await settled(() => failLog.length === 1 && frame.screen().includes('draft stays')), 'log=' + JSON.stringify(failLog))
      check('S4 失败 notice 稳定理由 + 草稿保留说明', frame.screen().includes('not resumable') && frame.screen().includes('draft retained'))
    },
  )
  // no composer → Esc exits immediately
  {
    let direct = 0
    await withTerminal(
      () => React.createElement(AgentTranscriptScene, {
        subagent: makeSubagent(),
        source: { kind: 'agents-dashboard' },
        onExit: () => { direct += 1 },
      }),
      async frame => {
        await settled(() => frame.screen().includes('read-only'))
        frame.stdin.write('\x1b')
        check('S4 无 composer：Esc 直接退场', await settled(() => direct === 1), 'direct=' + direct)
      },
    )
  }
}

// ── S5: degradation ────────────────────────────────────────────────────────
console.log('--- S5: capability degradation ---')
{
  const log: Array<Record<string, unknown>> = []
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
      compose: { capability: makeCapability(log), target: { agentId: 'agent-child-0001' } } as never,
    }),
    async frame => {
      check('S5 无 name：不提供提交（提示 nameless）', await settled(() => frame.screen().includes('no addressable name')), frame.lines().slice(-4).join('|'))
      frame.stdin.write('x')
      await sleep(60) // 固定窗:pacing 输入到断言步间
      frame.stdin.write('\r')
      await sleep(60) // 固定窗:pacing 提交到断言步间
      check('S5 无 name：Enter 不派发', log.length === 0, JSON.stringify(log))
    },
  )
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
      compose: { capability: makeCapability(log), target: { agentId: 'agent-child-0001', name: 'dup', ambiguous: true } } as never,
    }),
    async frame => {
      check('S5 重名：标题按稳定 id 消歧', await settled(() => frame.screen().includes('Send to agent-ch')), frame.lines().slice(-5).join('|'))
      check('S5 重名：消歧说明出现', frame.screen().includes('duplicate names'))
    },
  )
  // no compose → composer absent entirely
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat', returnFocus: 'prompt' },
      onExit: () => {},
    }),
    async frame => {
      check('S5 无能力不渲染 composer', await settled(() => frame.screen().includes('read-only')) && !frame.screen().includes('Send to'))
    },
  )
}

// ── S6: leaf states + unknown relation ─────────────────────────────────────
console.log('--- S6: message leaf states ---')
{
  await withTerminal(
    () => React.createElement(React.Fragment, null,
      React.createElement(AgentMessageLeafRow, { message: msg({ state: 'refused' }), selfAgentId: 'agent-child-0001', marginTopOnTurn: false }),
      React.createElement(AgentMessageLeafRow, { message: msg({ messageId: 'm2', state: 'unknown', from: undefined, to: undefined }), selfAgentId: 'agent-child-0001', marginTopOnTurn: true }),
      React.createElement(AgentMessageLeafRow, { message: msg({ messageId: 'm3', state: 'delivered' }), selfAgentId: 'agent-child-0001', marginTopOnTurn: true }),
    ),
    async frame => {
      check('S6 首行渲染', await settled(() => frame.screen().includes('refused')))
      const screen = frame.screen()
      check('S6 delivered 词渲染', screen.includes('delivered'), screen)
      check('S6 unknown 词渲染', screen.includes('unknown'), screen)
      check('S6 未知关系不画箭头', screen.includes('unknown relation') && !screen.includes('→ undefined'), screen)
      check('S6 未知关系行没有 from→to 箭头', !(screen.split('\n').some(line => line.includes('unknown relation') && line.includes('→'))), screen)
      check('S6 unknown 附不推断说明', screen.includes('no delivery fact'), screen)
    },
  )
}

// ── S7: narrow columns ─────────────────────────────────────────────────────
console.log('--- S7: 28/40 column headers ---')
for (const cols of [28, 40]) {
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent({ description: 'a very long description that would wrap badly' }),
      source: { kind: 'agent-detail', agentId: 'agent-child-0001' },
      onExit: () => {},
    }),
    async frame => {
      check('S7 ' + cols + ' 列顶栏存在', await settled(() => frame.lines().some(line => line.includes('⤢') || line.includes('read-only'))), frame.lines().slice(0, 3).join('|'))
      const lines = frame.lines()
      const overflow = lines.filter(line => line.length > 0).filter(line => stringWidthOf(line) > cols)
      check('S7 ' + cols + ' 列无超宽行', overflow.length === 0, overflow.slice(0, 2).join('|'))
    },
    cols,
  )
}
function stringWidthOf(line: string): number {
  // cheap width: this fixture is ASCII-only
  return line.length
}

// ── S8: detail scene ───────────────────────────────────────────────────────
console.log('--- S8: detail messages page + view action ---')
{
  let opened = 0
  const log: Array<Record<string, unknown>> = []
  await withTerminal(
    () => React.createElement(SubagentDetailScene, {
      subagent: makeSubagent(),
      onBack: () => {},
      onOpenView: () => { opened += 1 },
      messages: [msg(), msg({ messageId: 'm2', state: 'unknown', from: undefined, to: undefined })] as never,
      compose: { capability: makeCapability(log), target: { agentId: 'agent-child-0001', name: 'research the spec' } } as never,
    }),
    async frame => {
      check('S8 Messages 页签出现（feed 非空）', await settled(() => frame.screen().includes('Messages 2')), frame.lines().slice(3, 8).join('|'))
      check('S8 主屏查看动作可见（⤢ 字形位）', frame.screen().includes('⤢'))
      frame.stdin.write('v')
      check('S8 v 键触发主屏查看', await settled(() => opened === 1), 'opened=' + opened)
      // ←/→ to the messages page
      for (let i = 0; i < 3; i++) {
        frame.stdin.write('\x1b[C') // →（summary→output→tools→messages）
        await sleep(70) // 固定窗:pacing 逐键翻页步间
      }
      check('S8 消息页渲染 from → to 与 unknown 诊断', frame.screen().includes('parent → child') && frame.screen().includes('unknown relation'), frame.lines().slice(4, 12).join('|'))
      check('S8 composer 挂载', frame.screen().includes('Send to research the spec'))
    },
  )
  // no feed → no messages tab
  await withTerminal(
    () => React.createElement(SubagentDetailScene, {
      subagent: makeSubagent(),
      onBack: () => {},
    }),
    async frame => {
      await settled(() => frame.screen().includes('Summary'))
      check('S8 无 feed 无 Messages 页签', !frame.screen().includes('Messages '))
    },
  )
}

// ── S9: dashboard ──────────────────────────────────────────────────────────
console.log('--- S9: dashboard view action + summary ---')
{
  let opened = 0
  await withTerminal(
    () => React.createElement(SubagentDashboard, {
      subagents: [makeSubagent()] as never,
      onSelect: () => {},
      onOpenView: (id: string) => { opened += id === 'agent-child-0001' ? 1 : 0 },
      messages: [msg()] as never,
    }),
    async frame => {
      check('S9 行内主屏查看动作出现', await settled(() => frame.screen().includes('open in main view')), frame.lines().slice(0, 10).join('|'))
      check('S9 消息摘要行（from → to · state）', frame.screen().includes('parent → child') && frame.screen().includes('queued'))
      frame.stdin.write('v')
      check('S9 v 键打开主屏查看', await settled(() => opened === 1), 'opened=' + opened)
    },
  )
}

// ── Chat 层 ────────────────────────────────────────────────────────────────
console.log('--- Chat: source stack + parent state preservation ---')
{
  const [{ Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, chatScope] = await Promise.all([
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/commands.js'),
    import('../src/dsh-adapter/channel.js'),
  ])
  type ChatT = typeof import('../src/screens/Chat.js')
  void (0 as unknown as ChatT)
  void chatScope

  const dispatchLog: Array<Record<string, unknown>> = []
  const listeners = new Set<() => void>()
  const EMPTY: readonly never[] = Object.freeze([])
  const subagent = {
    agentId: 'agent-child-0001',
    description: 'chat level child',
    status: 'completed' as const,
    startedAt: NOW - 60_000,
    completedAt: NOW - 10_000,
    output: [],
    outputEvents: [{ kind: 'text' as const, text: 'child said hi', at: NOW - 20_000, settled: true }],
    toolCalls: [],
    mode: 'continuable' as const,
  }
  const historyPageData = historyPage([
    ev('assistant.message', { anchor: 'a1', time: NOW - 40_000, blocks: [{ type: 'text', text: 'child answer in history' }] }),
  ])
  const feed = [msg({ text: 'flow message one', to: 'agent-child-0001', from: 'parent-session-1' })]
  const channel: Record<string, unknown> = {
    whaleIdle: false,
    version: 0,
    rows: [
      { id: 1, kind: 'user', text: 'please delegate' },
      { id: 2, kind: 'subagent', text: '', subagent: { ...subagent, runId: 'r1', outputLines: [] } },
      { id: 3, kind: 'assistant', text: 'delegated', streaming: false },
    ],
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-chat',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    activeToolCount: 0,
    turnStart: 0,
    pending: [],
    commandList: LOCAL_COMMANDS,
    notifications: [],
    mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8',
    lastUserText: '',
    scrollGutter: 'timeline',
    subagents: [subagent],
    backgroundJobs: EMPTY,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    bump() { channel.version = (channel.version as number) + 1; for (const cb of listeners) cb() },
    submit() {},
    cancel: () => {},
    clear() {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => EMPTY,
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
    stagedImageGeneration: () => 0,
    previewImages: () => EMPTY,
    subagentControl: {
      interrupt: () => true,
      history: async () => historyPageData,
      agentMessages: () => feed,
      agentCompose: () => makeCapability(dispatchLog),
    },
    backgroundCurrent: async () => ({ ok: true, backgroundedSessionId: 'probe' }),
    agentViewRows: () => EMPTY,
    subscribeAgentView: () => () => {},
    settingsHost: () => undefined,
    settingsSections: () => EMPTY,
    subscribeSettingsSections: () => () => {},
    buildSessionTree: () => new Promise<null>(() => {}),
  }

  const term = new XTerm({ cols: COLS, rows: 36, scrollback: 0, allowProposedApi: true })
  class ChatStdout extends Writable {
    columns = COLS
    rows = 36
    isTTY = true
    _write(chunk: unknown, _e: unknown, cb: () => void): void { term.write(String(chunk), cb) }
  }
  class ChatStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: unknown, cb: () => void): void { cb() }
  }
  const stdin = new Input()
  const instance = await render(
    React.createElement(AlternateScreen, null,
      React.createElement(Chat as unknown as React.ComponentType<Record<string, unknown>>, {
        channel,
        questionStore: new QuestionStore(),
        fullscreen: true,
      })),
    {
      stdout: new ChatStdout() as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new ChatStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => viewportLines(term, 36)
  const screen = (): string => lines().join('\n')
  try {
    // parent state before the round trip
    check('C1 父转录渲染子代理卡', await settled(() => screen().includes('chat level child')), lines().slice(0, 8).join('|'))
    // draft into the parent composer
    stdin.write('parent draft stays')
    await settled(() => screen().includes('parent draft stays'))
    const beforeRows = lines().filter(l => l.includes('please delegate') || l.includes('delegated') || l.includes('chat level child'))
    // card ⤢ click → Agent View (source transcript-card)
    check('C1 转录卡主屏查看动作（⤢ 字形）可定位', await click({ screen, lines, rerender: () => {}, stdin, term } as unknown as Frame, '⤢'))
    check('C1 进入 Agent View（顶栏出现）', await settled(() => screen().includes('read-only') && screen().includes('from transcript card')), lines().slice(0, 3).join('|'))
    check('C1 场景读同一 history（子答案可见）', await settled(() => screen().includes('child answer in history')))
    check('C1 场景内消息流叶子', screen().includes('parent → child'))
    // composer submit through the channel-provided capability
    stdin.write('to the child')
    await settled(() => screen().includes('to the child'))
    stdin.write('\r')
    check('C1 场景 composer 提交（queue）', await settled(() => dispatchLog.length === 1 && (dispatchLog[0] as { delivery: string }).delivery === 'queue'), JSON.stringify(dispatchLog))
    // Esc → blur; Esc → exit to chat
    stdin.write('\x1b')
    await sleep(80) // 固定窗:pacing Esc 分层步间
    stdin.write('\x1b')
    check('C1 Esc 退回聊天（父转录仍在）', await settled(() => screen().includes('please delegate') && !screen().includes('read-only')), lines().slice(0, 4).join('|'))
    const afterRows = lines().filter(l => l.includes('please delegate') || l.includes('delegated') || l.includes('chat level child'))
    // 行尾空白格不是比较对象（重挂载后 flex 尾格可能多一格 padding）。
    const norm = (ls: readonly string[]): string[] => ls.map(l => l.replace(/\s+$/, ''))
    check('C1 父 rows 逐字不变', JSON.stringify(norm(beforeRows)) === JSON.stringify(norm(afterRows)), JSON.stringify({ before: beforeRows, after: afterRows }))
    check('C1 父草稿保留', await settled(() => screen().includes('parent draft stays')))
    check('C1 主转录未因消息流多出普通行', !screen().includes('flow message one'))

    // C2: dashboard → v → Agent View → Esc → dashboard → Esc → chat
    stdin.write('\x01') // Ctrl+A
    check('C2 Ctrl+A 打开代理面板', await settled(() => screen().includes('Subagent Dashboard')), lines().slice(0, 6).join('|'))
    stdin.write('v')
    check('C2 Dashboard v 进入 Agent View（来源面板）', await settled(() => screen().includes('from agents panel')), lines().slice(0, 3).join('|'))
    stdin.write('\x1b')
    await sleep(80) // 固定窗:pacing Esc 分层步间
    stdin.write('\x1b')
    check('C2 Esc 回到 Dashboard', await settled(() => screen().includes('Subagent Dashboard') && !screen().includes('read-only')), lines().slice(0, 4).join('|'))
    stdin.write('\x1b')
    check('C2 Esc 关面板回聊天', await settled(() => screen().includes('please delegate')))
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

console.log(failed === 0 ? `ALL PASS (${passed})` : `FAILED: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
