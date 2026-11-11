/**
 * 外部执行体（external provider）回归。
 *
 * external 子代理（`subagent_oar`、`subagent_claude_code`）没有本地子会话：
 * `subagent/descriptor` 永不发，`lookupChild` 永远 miss，`subagent/start` 与
 * `subagent/end` 不落盘。能穿过重放的只有 catalog v2 的 `mode:'external'`；
 * 实时态则从第一帧的 `local:false` 就能认出来。
 *
 * 断言清单：
 *   E1 实时态：`local:false` 首帧即判 external（catalog 尚未到达）
 *   E2 重放态：只有 catalog v2 时保住 `mode:'external'`，状态 unknown
 *   E3 门禁：external（live 无 catalog / 重放）与 one-shot 都拒绝续接
 *   E4 不误伤：v0 无 mode、v1 unknown 与 continuable 行照旧交给服务层
 *   E5 D4：`subagent_oar` 登记为子代理工具名（主屏 presentation 的唯一入口）
 *   E6 判据本身：mode/local 两半、continuable 与 local:true 不误伤
 *   E7 external 仍可中断：上游 interrupt() 对非 local activation 走 abort+dispose
 *   E8 /agents 名册：external 有独立 mode 词，unknown 不占用 activity 槽
 *   U1 详情页：external 徽标、3 页、重放「结果未留存」、输出页「本地无会话记录」，
 *      即使传了 loadTranscript 与 compose 也不出现转录页签/续接框
 *   U2 卡片：external 徽标
 *   U4 实时帧：只有 local:false、catalog 未到时同样成立
 *   U5 侧栏 panel：external 无 composer，continuable 保留（对照）
 *   U6 Agent View：external 行不出现 composer
 *   U8 external 行按 i 不锁键盘：翻页与 Esc 仍然工作
 *   U9 Agent View 即使收到 loadTranscript 也不读、不报 unavailable
 *   U3 对照：continuable 行保留转录页签
 *
 * Run: node --import tsx/esm scripts/verify-external-subagent.ts
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

// Home isolation: the projection and the detail memory touch the user directory.
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtui-external-subagent-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(join(isolatedHome, '.dsh-tui'), { recursive: true })

const [
  { createSubagentProjection },
  { isSubagentToolName },
  { isExternalExecution },
  { t, setLang },
] = await Promise.all([
  import('../src/dsh-adapter/channel/subagent-projection.js'),
  import('../src/dsh-adapter/channel/projection-helpers.js'),
  import('../src/channel/subagentMode.js'),
  import('../src/i18n.js'),
])
setLang('en')

let failed = 0
let checks = 0
function check(name: string, ok: boolean, extra = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

// ═══ 投影与门禁 ═══════════════════════════════════════════════════════════

const parentSession = { id: 'sess-parent-ext', seq: 0, events: [], header: {} }
const agent = { id: 'ag-parent-ext', status: 'idle', session: parentSession }

interface Row {
  agentId: string
  description: string
  status: string
  mode?: string
  local?: boolean
  runId?: string
}

interface Harness {
  state: { rows: unknown[]; subagents: Row[]; subagentCost: unknown[]; emit(): void; emitStream(): void }
  projection: ReturnType<typeof createSubagentProjection>
  promptCalls: unknown[]
  interruptCalls: string[]
  rowOf(agentId: string): Row | undefined
}

function harness(options: { interrupt?: boolean } = {}): Harness {
  const state = {
    rows: [] as unknown[],
    subagents: [] as Row[],
    subagentCost: [] as unknown[],
    emit(): void {},
    emitStream(): void {},
  }
  const promptCalls: unknown[] = []
  const interruptCalls: string[] = []
  const service = {
    prompt: async (request: unknown) => {
      promptCalls.push(request)
      return { messageId: 'msg-ext-1' }
    },
    listChildren: async () => [],
    ...(options.interrupt === true ? { interrupt: (target: string) => { interruptCalls.push(target) } } : {}),
  }
  const projection = createSubagentProjection(() => state as never, {
    rowIds: { value: 0 },
    agent: () => agent as never,
    subagents: () => service as never,
    lookupChild: () => undefined,
  })
  return { state, projection, promptCalls, interruptCalls, rowOf: agentId => state.subagents.find(sub => sub.agentId === agentId) }
}

/** 一次 spawn 边缘（`subagent/start`）。 */
function spawn(h: Harness, id: string, info: { provider?: string; local?: boolean; runId?: string } = {}): void {
  h.projection.onStart({
    id,
    ...(info.runId === undefined ? {} : { runId: info.runId }),
    provider: info.provider ?? 'oar',
    ...(info.local === undefined ? {} : { local: info.local }),
  })
}

/** `subagent/catalog`：childId-keyed 的持久事实。 */
function catalog(h: Harness, seq: number, childId: string, mode?: string, label?: string): void {
  h.projection.onParentEvent({
    type: 'subagent/catalog',
    seq,
    time: seq,
    data: {
      version: mode === undefined ? 0 : 2,
      childId,
      childCreatedAt: seq,
      ...(mode === undefined ? {} : { mode }),
      ...(label === undefined ? {} : { label }),
    },
  })
}

const submit = (h: Harness, targetId: string) =>
  h.projection.control.message.submit({ targetId, text: 'continue please', delivery: 'queue' })

// ── E1. 实时态：catalog 未到，local:false 已经足够 ─────────────────────────
{
  const h = harness()
  spawn(h, 'ext-live', { provider: 'oar', local: false, runId: 'run-live' })
  const row = h.rowOf('ext-live')
  check('E1 a live external row is recognized before its catalog',
    row !== undefined && isExternalExecution(row) && row.mode === undefined && row.status === 'running',
    `${String(row?.mode)} / ${String(row?.local)} / ${String(row?.status)}`)
}

// ── E2. 重放态：只剩 catalog 一条事实 ────────────────────────────────────
{
  const h = harness()
  h.projection.bootstrapFromLog([
    { type: 'subagent/catalog', seq: 1, time: 1, data: { version: 2, childId: 'ext-old', childCreatedAt: 1, mode: 'external', label: 'oar: fix the build' } },
  ], String(parentSession.id))
  const row = h.rowOf('ext-old')
  check('E2 replay keeps the external mode and stays unknown',
    row?.mode === 'external' && row.status === 'unknown' && isExternalExecution(row),
    `${String(row?.mode)} / ${String(row?.status)}`)
  check('E2b replay keeps the catalog label', row?.description === 'oar: fix the build', String(row?.description))
}

// ── E3. 门禁：没有本地会话的行一律拒绝续接 ───────────────────────────────
{
  const h = harness()
  spawn(h, 'ext-live', { provider: 'oar', local: false })
  const live = await submit(h, 'ext-live')
  check('E3 a live external row rejects continuation before its catalog',
    live.ok === false && live.reason === 'not-resumable', JSON.stringify(live))

  // 重放态只有 catalog、没有 `local` 边沿：这一行单独建，不能复用上面的
  // live 行，否则断言只覆盖 `local === false`，durable 分支消失也不会红。
  const replayHarness = harness()
  catalog(replayHarness, 4, 'ext-replayed', 'external')
  const replayed = await submit(replayHarness, 'ext-replayed')
  check('E3b an external catalog row with no bus fact rejects continuation',
    replayed.ok === false && replayed.reason === 'not-resumable' && replayHarness.promptCalls.length === 0,
    JSON.stringify(replayed))

  spawn(h, 'one-shot-kid', { provider: 'subagent' })
  catalog(h, 3, 'one-shot-kid', 'one-shot')
  const oneShot = await submit(h, 'one-shot-kid')
  check('E3c a one-shot row still rejects continuation',
    oneShot.ok === false && oneShot.reason === 'not-resumable', JSON.stringify(oneShot))

  check('E3d rejected prompts never reach the service', h.promptCalls.length === 0, `${h.promptCalls.length} calls`)
}

// ── E4. 不误伤：v0 无 mode 与 continuable 行照旧放行 ─────────────────────
{
  const h = harness()
  h.projection.bootstrapFromLog([
    { type: 'subagent/catalog', seq: 1, time: 1, data: { version: 0, childId: 'legacy-v0', childCreatedAt: 1, label: 'legacy child' } },
  ], String(parentSession.id))
  const legacy = await submit(h, 'legacy-v0')
  check('E4 a v0 row without mode still reaches the service',
    legacy.ok === true && h.promptCalls.length === 1, JSON.stringify(legacy))

  catalog(h, 2, 'cont-kid', 'continuable', 'continuable child')
  const cont = await submit(h, 'cont-kid')
  check('E4b a continuable row still reaches the service',
    cont.ok === true && h.promptCalls.length === 2, JSON.stringify(cont))

  // v1 的 `unknown` 是历史 epoch 的可续行：判据一旦放宽到吞掉它，这一条必须红。
  const v1Harness = harness()
  v1Harness.projection.bootstrapFromLog([
    { type: 'subagent/catalog', seq: 3, time: 3, data: { version: 1, childId: 'legacy-v1', childCreatedAt: 3, mode: 'unknown' } },
  ], String(parentSession.id))
  const v1 = await submit(v1Harness, 'legacy-v1')
  check('E4c a v1 unknown row still reaches the service',
    v1.ok === true && v1Harness.promptCalls.length === 1, JSON.stringify(v1))
}

// ── E5. D4：工具名是主屏子代理卡的唯一入口 ───────────────────────────────
{
  check('E5 subagent_oar is a subagent tool', isSubagentToolName('subagent_oar'))
  check('E5b tool-name matching stays case-insensitive', isSubagentToolName('SUBAGENT_OAR'))
  check('E5c unrelated tool names stay plain', !isSubagentToolName('run_in_background'))
}

// ── E6. 判据本身 ─────────────────────────────────────────────────────────
{
  check('E6 mode external without a bus fact', isExternalExecution({ mode: 'external' }))
  check('E6b local:false without a catalog', isExternalExecution({ local: false }))
  check('E6c a continuable local child is not external', !isExternalExecution({ mode: 'continuable', local: true }))
  check('E6d an empty v0 row is not external', !isExternalExecution({}))
  check('E6d2 a v1 unknown row is not external', !isExternalExecution({ mode: 'unknown' }))
  check('E6e local:true never hides a local child', !isExternalExecution({ local: true }))

  // E7: external 仍可中断——上游 interrupt() 对非 local activation 走
  // controller.abort + dispose，TUI 不替后端拒绝。
  {
    const h = harness({ interrupt: true })
    spawn(h, 'ext-live', { provider: 'oar', local: false, runId: 'run-live' })
    const interrupted = h.projection.control.interrupt('ext-live')
    check('E7 a live external row keeps the upstream interrupt path',
      interrupted && h.interruptCalls.length === 1 && h.interruptCalls[0] === 'ext-live',
      `${String(interrupted)} / ${JSON.stringify(h.interruptCalls)}`)
  }
}

// ═══ UI ══════════════════════════════════════════════════════════════════

const [
  { PassThrough, Writable },
  { default: React },
  { Terminal: XTerm },
  uiMod,
  detailMod,
  cardMod,
  sceneMod,
  termTest,
  { createLocalActions },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/SubagentDetailScene.js'),
  import('../src/components/SubagentCard.js'),
  import('../src/screens/AgentTranscriptScene.js'),
  import('./lib/term-test.mjs'),
  import('../src/dsh-adapter/channel/local-actions.js'),
])
const { render, AlternateScreen, useInput } = uiMod as unknown as {
  render: typeof import('../src/ui.js').render
  AlternateScreen: React.ComponentType<{ children?: React.ReactNode }>
  useInput: (handler: (input: string, key: unknown) => void, options?: { isActive?: boolean }) => void
}
const { SubagentDetailScene } = detailMod as unknown as { SubagentDetailScene: React.ComponentType<Record<string, unknown>> }
const { SubagentCard } = cardMod as unknown as { SubagentCard: React.ComponentType<Record<string, unknown>> }
const { AgentTranscriptScene } = sceneMod as unknown as { AgentTranscriptScene: React.ComponentType<Record<string, unknown>> }
const { settle, settled, viewportLines } = termTest as unknown as {
  settle: (pred: () => boolean, opts?: { timeoutMs?: number }) => Promise<void>
  settled: (pred: () => boolean, opts?: { timeoutMs?: number }) => Promise<boolean>
  viewportLines: (term: InstanceType<typeof XTerm>, rows?: number) => string[]
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
/** 键盘链路保持器：没有组件开 raw mode，注入的键进不了管线。 */
function RawMode(): null {
  useInput((): void => {}, { isActive: true })
  return null
}

interface Frame {
  screen(): string
  rerender(node: React.ReactNode): void
  stdin: Input
}

async function withTerminal(make: () => React.ReactNode, run: (frame: Frame) => Promise<void>): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  const stdin = new Input()
  const instance = await render(React.createElement(AlternateScreen, null, React.createElement(RawMode, null), make()), {
    stdout, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false,
  })
  const frame: Frame = {
    screen: () => viewportLines(term, ROWS).join('\n'),
    rerender: node => { instance.rerender(React.createElement(AlternateScreen, null, React.createElement(RawMode, null), node)) },
    stdin,
  }
  try {
    await settle(() => viewportLines(term, ROWS).join('\n').includes('Subagent:'), { timeoutMs: 2_000 })
    await run(frame)
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

function makeSubagent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'agent-ext-0001',
    description: 'external task',
    status: 'unknown',
    startedAt: NOW - 60_000,
    mode: 'external',
    output: [],
    outputEvents: [],
    toolCalls: [],
    ...over,
  }
}

/** 最小 composer fixture：只有 Detail/Agent View 传了 compose 才会渲染。 */
function makeCompose(): Record<string, unknown> {
  return {
    control: {
      via: 'direct-continuable',
      steer: true,
      listTargets: async () => [],
      messages: () => [],
      submit: async () => ({ ok: true, intentId: 'intent-fx', state: 'issued' }),
    },
    target: { agentId: 'agent-ext-0001', name: 'external task' },
  }
}

// ── U1. 详情页：徽标、重放标注、无转录页签 ────────────────────────────────
await withTerminal(
  () => React.createElement(SubagentDetailScene, {
    subagent: makeSubagent(),
    onBack: () => {},
    // Chat 对 external 不传 loadTranscript/compose；这里故意都传，钉住组件兜底。
    loadTranscript: async () => ({ events: [], uuids: [], hasOlder: false, skippedFromStart: 0 }),
    compose: makeCompose(),
  }),
  async frame => {
    const summary = frame.screen()
    check('U1 detail shows the external badge', summary.includes('⇅ external'))
    check('U1g external detail exposes exactly three pages', summary.includes('1/3'), JSON.stringify(summary.slice(0, 120)))
    check('U1f detail never renders a composer for external rows',
      !summary.includes('Send to') && !summary.includes('i compose'), JSON.stringify(summary.slice(0, 200)))
    check('U1b replayed external row says the result was not retained',
      summary.includes('External run · result not retained'), JSON.stringify(summary.slice(0, 200)))
    check('U1c detail hides the transcript tab for external rows', !summary.includes('Transcript'))

    // Right arrow: summary → output (pages: summary, output, tools).
    frame.stdin.write('\x1b[C')
    const reached = await settled(() => frame.screen().includes('Runs in an external executor; no local session record'), { timeoutMs: 2_000 })
    check('U1d output page explains the missing local session', reached, JSON.stringify(frame.screen().slice(0, 200)))
    check('U1e output page never says "No output yet" for external rows', !frame.screen().includes('No output yet'))
  },
)

// ── U2. 卡片：external 徽标 ───────────────────────────────────────────────
await withTerminal(
  () => React.createElement(SubagentCard, { subagent: makeSubagent({ status: 'running' }) }),
  async frame => {
    const screen = frame.screen()
    check('U2 card shows the external badge', screen.includes('⇅ external'), JSON.stringify(screen.slice(0, 200)))
  },
)

// ── U4. 实时帧：只有 local:false，catalog 未到 ────────────────────────────
await withTerminal(
  () => React.createElement(SubagentDetailScene, {
    subagent: makeSubagent({ status: 'running', mode: undefined, local: false }),
    onBack: () => {},
  }),
  async frame => {
    const screen = frame.screen()
    check('U4 a live external frame (local:false, no catalog) shows the badge', screen.includes('⇅ external'))
    check('U4b live external frame explains the missing local session',
      screen.includes('Runs in an external executor'), JSON.stringify(screen.slice(0, 200)))
  },
)

// ── U5. 侧栏 panel 形态：external 无 composer，continuable 保留 ────────────
await withTerminal(
  () => React.createElement(SubagentDetailScene, {
    subagent: makeSubagent(),
    onBack: () => {},
    variant: 'panel',
    compose: makeCompose(),
  }),
  async frame => {
    const screen = frame.screen()
    check('U5 a panel detail hides the composer for external rows',
      !screen.includes('Send to') && !screen.includes('i compose'), JSON.stringify(screen.slice(0, 200)))
  },
)
await withTerminal(
  () => React.createElement(SubagentDetailScene, {
    subagent: makeSubagent({ status: 'completed', mode: 'continuable', completedAt: NOW - 1_000 }),
    onBack: () => {},
    variant: 'panel',
    compose: makeCompose(),
  }),
  async frame => {
    check('U5b a panel detail keeps the composer for continuable rows', frame.screen().includes('Send to'))
  },
)

// ── U6. Agent View：external 行不出现 composer ────────────────────────────
await withTerminal(
  () => React.createElement(AgentTranscriptScene, {
    subagent: makeSubagent(),
    source: { kind: 'chat' },
    onExit: () => {},
    compose: makeCompose(),
  }),
  async frame => {
    check('U6 Agent View hides the composer for external rows',
      !frame.screen().includes('Send to'), JSON.stringify(frame.screen().slice(0, 200)))
  },
)

// ── U8. external 行上按 i 不能锁死键盘：翻页与 Esc 仍然工作 ────────────────
{
  let backCalls = 0
  await withTerminal(
    () => React.createElement(SubagentDetailScene, {
      subagent: makeSubagent(),
      onBack: () => { backCalls += 1 },
      compose: makeCompose(),
    }),
    async frame => {
      frame.stdin.write('i')
      frame.stdin.write('\x1b[C')
      const paged = await settled(() => frame.screen().includes('2/3'), { timeoutMs: 2_000 })
      check('U8 a trapped i cannot steal paging', paged, JSON.stringify(frame.screen().slice(0, 120)))
      frame.stdin.write('\x1b')
      await settled(() => backCalls === 1, { timeoutMs: 2_000 })
      check('U8b Esc still leaves the detail', backCalls === 1, String(backCalls))
    },
  )
}

// ── U9. Agent View：external 行即使收到 loadTranscript 也不读、不报错 ─────
{
  let loads = 0
  await withTerminal(
    () => React.createElement(AgentTranscriptScene, {
      subagent: makeSubagent(),
      source: { kind: 'chat' },
      onExit: () => {},
      loadTranscript: async () => { loads += 1; return null },
    }),
    async frame => {
      await settle(() => frame.screen().includes('Runs in an external executor'), { timeoutMs: 2_000 })
      check('U9 Agent View never reads a transcript for external rows',
        loads === 0 && !frame.screen().includes('Subagent transcript unavailable'),
        `${loads} / ${JSON.stringify(frame.screen().slice(0, 160))}`)
    },
  )
}

// ── U3. 对照：continuable 行仍保留转录页签与 composer 文案 ─────────────────
await withTerminal(
  () => React.createElement(SubagentDetailScene, {
    subagent: makeSubagent({ status: 'completed', mode: 'continuable', completedAt: NOW - 1_000 }),
    onBack: () => {},
    loadTranscript: async () => ({ events: [], uuids: [], hasOlder: false, skippedFromStart: 0 }),
  }),
  async frame => {
    check('U3 a continuable row keeps the transcript tab', frame.screen().includes('Transcript'))
  },
)

// ── E8. /agents 名册：external 有独立 mode 词，unknown 不占用 activity 槽 ──
{
  const actions = createLocalActions({
    ctx: {
      get: () => ({
        listChildren: async () => [
          { createdAt: 1, mode: 'continuable', label: 'c', id: 'c0000001' },
          { createdAt: 2, mode: 'external', label: 'e', id: 'e0000002' },
          { createdAt: 3, mode: 'unknown', id: 'u0000003' },
          { createdAt: 4, mode: 'one-shot', id: 'o0000004' },
        ],
      }),
    },
    owner: { current: () => true },
    binding: { capture: () => 'cap', isCurrent: () => true, agent: { session: { id: 'parent-1' } } },
    state: { subagents: [{ agentId: 'e0000002', status: 'running' }] } as never,
    presenters: {} as never,
    foldBack: (() => 0) as never,
  })
  const lines = await actions.listSubagents()
  check('E8 /agents names an external child instead of calling it one-shot',
    lines.some(line => line.startsWith('external ') && line.includes('e0000002')), JSON.stringify(lines))
  check('E8b /agents keeps a mode-unknown row out of the activity wording',
    lines.some(line => line.startsWith('unknown ') && line.includes('u0000003'))
    && !lines.some(line => line.startsWith(' status')), JSON.stringify(lines))
}

console.log(failed === 0 ? `\nALL PASS (${checks} checks)` : `\n${failed} FAIL (of ${checks} checks)`)
process.exit(failed === 0 ? 0 : 1)
