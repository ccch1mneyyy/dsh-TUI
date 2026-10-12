/**
 * 子代理卡片描述绑定回归。
 *
 * 缺陷：卡片标题（description）来自一条**无身份**的 FIFO 队列（父会话
 * `tool/call` 事件的 `description` 顺序入队，`subagent/start` 边缘按到达
 * 顺序出队），而身份来自另一条通道。childId-keyed 的权威 `label`
 * （`subagent/catalog`、子会话 `subagent/descriptor`）到达时必须把标题
 * 纠正回自己的行，且**写入侧不得反过来被队列 term 覆盖**。
 *
 * 宿主的两种顺序（已核实，非竞态）：
 *   - one-shot（`run_in_background:false` 或非 continuable 行）：catalog 先到、
 *     边缘后到（`provider.start` → `establishCatalogChild` → `observeRun`）；
 *   - continuable 创建：边缘先、catalog 后（同一次 materialize 内）。
 *
 * 队列项只配当**无歧义时**的首帧猜测：并发派发时队列里堆着不止一条 term，而
 * 无身份的队列说不出哪条属于谁，此时作废描述、保留未匹配启动的槽位 —— 卡片可以
 * 暂时没有标题（占位），但绝不显示另一个 child 的标题。keyed label 比行先到时
 * 寄存（`holdKeyedLabel`），建行时直接采用。
 *
 * 断言清单（除 B0 是 harness 自检外，每条都能被实现侧的改动打红）：
 *   A1 A1b A1c    one-shot 顺序：keyed label 不被队列覆盖；歧义批次整体作废；
 *                 无歧义时仍用队列项
 *   A2a A2b A2c   resume 折叠行 + live 边缘：老行保持真名，新行不得借别人的名字
 *   A3            continuable 二次 epoch 保持冻结的 keyed label
 *   B0 B2a B2b B2c 两种宿主顺序各自归位；continuable 并发首帧不借标题
 *   B3            每个 keyed 事实（label 与 mode）落到自己的 childId
 *   K1–K7b        重复边缘不吃队列 / 新 epoch 取新 term / 占位可被补 / 历史折叠不污染
 *                 队列 / descriptor 是第二纠正路径 / 显式 patch 权威 / 早到的
 *                 descriptor 被寄存并在建行时采用
 *   P1–P11        队列上限；外层 reset；迟到 label；未 link 不认领；空 label 仍有标题；
 *                 空 description 不入队；无 runId 边缘的"刷新"与"首建"之别；歧义
 *                 作废后保留未匹配槽位；远程任务交错启动；溢出不忘记待启动的任务
 *
 * Run: node --import tsx/esm scripts/verify-subagent-description-binding.ts
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

// Home isolation: the projection touches the user directory.
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtui-subagent-desc-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(join(isolatedHome, '.dsh-tui'), { recursive: true })

const { createSubagentProjection } = await import('../src/dsh-adapter/channel/subagent-projection.js')

const parentSession = { id: 'sess-parent-1', seq: 0, events: [], header: {} }
const childSession = { id: 'sess-child-1' }
const agent = { id: 'ag-1', status: 'idle', session: parentSession }

interface Row {
  agentId: string
  description: string
  status: string
  mode?: string
  runId?: string
}

interface Harness {
  state: { rows: unknown[]; subagents: Row[]; subagentCost: unknown[]; emit(): void; emitStream(): void }
  projection: ReturnType<typeof createSubagentProjection>
  descriptionOf(agentId: string): string | undefined
  rowOf(agentId: string): Row | undefined
}

function harness(): Harness {
  const state = {
    rows: [] as unknown[],
    subagents: [] as Row[],
    subagentCost: [] as unknown[],
    emit(): void {},
    emitStream(): void {},
  }
  const projection = createSubagentProjection(() => state as never, {
    rowIds: { value: 0 },
    agent: () => agent as never,
    subagents: () => undefined,
    lookupChild: () => undefined,
  })
  return {
    state,
    projection,
    descriptionOf: (agentId) => state.subagents.find(sub => sub.agentId === agentId)?.description,
    rowOf: (agentId) => state.subagents.find(sub => sub.agentId === agentId),
  }
}

/** 一次 subagent 工具调用（父会话 durable 事件，描述入队的唯一入口）。 */
function delegate(h: Harness, seq: number, description: string): void {
  h.projection.onSessionEvent(parentSession, {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 5, step: 2, callId: `call_${seq}`, name: 'subagent', arguments: JSON.stringify({ description }) },
  })
}

/** 一次 spawn 边缘（`subagent/start`）。 */
function spawn(h: Harness, agentId: string, runId?: string, info: { provider?: string; local?: boolean } = {}): void {
  h.projection.onStart({
    id: agentId,
    ...(runId === undefined ? {} : { runId }),
    provider: info.provider ?? 'subagent',
    ...(info.local === undefined ? {} : { local: info.local }),
  }, agent)
}

/** `subagent/catalog`：childId-keyed 的权威事实（label 与 mode）。 */
function catalog(h: Harness, seq: number, childId: string, label?: string, mode: 'one-shot' | 'continuable' = 'continuable'): void {
  h.projection.onParentEvent({
    type: 'subagent/catalog',
    seq,
    time: seq,
    data: { version: 0, childId, childCreatedAt: seq, mode, ...(label === undefined ? {} : { label }) },
  })
}

let failed = 0
let checks = 0
function check(name: string, ok: boolean, extra = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

// ═══ P0 ═══════════════════════════════════════════════════════════════════

// ── A1. one-shot 顺序（catalog 先建行）下，队列里**别人的** term 不得覆盖
//    keyed label；且同一批还有第二条待派发项时整批作废（无身份的队列说不出
//    哪条属于谁）。
{
  const h = harness()
  delegate(h, 1, 'T1（属于本行）')
  delegate(h, 2, 'T2（属于下一行）')
  catalog(h, 3, 'agent-x', 'X 的真名')
  // 行的标题由 keyed label 定案，随后到达的边缘不得用队列 term 覆盖它
  spawn(h, 'agent-x', 'r-x')
  check('A1 catalog-first spawn does not overwrite the keyed label', h.descriptionOf('agent-x') === 'X 的真名', String(h.descriptionOf('agent-x')))
  spawn(h, 'agent-y', 'r-y')
  check('A1b an ambiguous batch is dropped, never handed to the next row',
    h.descriptionOf('agent-y') !== 'T2（属于下一行）' && h.descriptionOf('agent-y') !== 'T1（属于本行）',
    String(h.descriptionOf('agent-y')))
}

// ── A1c. 无歧义（队列恰好一条）时队列项仍是可用的首帧猜测：这是队列存在的唯一
//    理由，别把 A1b 的作废规则误读成"队列永不使用"。
{
  const h = harness()
  delegate(h, 1, '唯一的派发')
  spawn(h, 'agent-solo', 'r-solo')
  check('A1c a lone term is still used as the first frame', h.descriptionOf('agent-solo') === '唯一的派发', String(h.descriptionOf('agent-solo')))
}

// ── A2. resume：折叠出来的行已由 keyed label 定案，之后 live 边缘不得把新派发
//    的 term 抢进老行。
//    这条路径上新行按设计从占位起步：老行的边缘先到且新鲜，队头那条 term 归它
//    消费（不落地）——留下不消费会让后面每一行都跟着错开一格。新行的真名由它自己
//    的 catalog 给出（权威事实，必然到达），所以这里钉的是**不得错配**：老行保持
//    真名、新行不得顶着老行的真名，而不是"新行立刻拿到自己的 term"。
{
  const h = harness()
  h.projection.bootstrapFromLog([
    { type: 'subagent/catalog', seq: 1, time: 1, data: { version: 0, childId: 'child-old', childCreatedAt: 1, mode: 'continuable', label: 'child-old 的真名' } },
  ], String(parentSession.id))
  check('A2a a folded catalog row is described by its keyed label', h.descriptionOf('child-old') === 'child-old 的真名', String(h.descriptionOf('child-old')))
  delegate(h, 2, '新派发的任务名')
  spawn(h, 'child-old', 'r-epoch-2')
  check('A2b a live edge does not hand the new term to the folded row', h.descriptionOf('child-old') === 'child-old 的真名', String(h.descriptionOf('child-old')))
  spawn(h, 'child-new', 'r-new')
  check('A2c no row is left carrying another child\'s label',
    h.descriptionOf('child-new') !== 'child-old 的真名' && h.descriptionOf('child-old') !== '新派发的任务名',
    `${h.descriptionOf('child-old')} / ${h.descriptionOf('child-new')}`)
}

// ── A3. continuable 二次 epoch：已 bound 的行换 runId 时，队头若有并发/残留
//    term，标题仍保持冻结的 keyed label。
{
  const h = harness()
  delegate(h, 1, 'epoch1 的任务（队列 term）')
  spawn(h, 'agent-cont', 'r-1')
  catalog(h, 2, 'agent-cont', '冻结的任务名')
  delegate(h, 3, '并发同伴的 term')
  spawn(h, 'agent-cont', 'r-2')
  check('A3 a new epoch keeps the frozen keyed label', h.descriptionOf('agent-cont') === '冻结的任务名', String(h.descriptionOf('agent-cont')))
}

// ── B0. 前置条件（harness 自检，不是缺陷检出项）：两条边缘产出两行且都有描述。
//    它在任何变异下都不该红——作用只是防 harness 空转。
{
  const h = harness()
  delegate(h, 268, '实测入口加 Codex 组合')
  delegate(h, 269, '标废设计文档过时记录')
  spawn(h, 'agent-28d', 'r-28d')
  spawn(h, 'agent-9ec', 'r-9ec')
  check('B0 two edges produce two rows', h.state.subagents.length === 2 && h.descriptionOf('agent-28d') !== undefined && h.descriptionOf('agent-9ec') !== undefined)
}

// ── B2a. one-shot 顺序（catalog → 边缘）下的并发派发：两行各自正确。
{
  const h = harness()
  delegate(h, 268, '实测入口加 Codex 组合')
  delegate(h, 269, '标废设计文档过时记录')
  catalog(h, 270, 'agent-28d', '标废设计文档过时记录')
  catalog(h, 271, 'agent-9ec', '实测入口加 Codex 组合')
  spawn(h, 'agent-28d', 'r-28d')
  spawn(h, 'agent-9ec', 'r-9ec')
  check('B2a one-shot order (catalog first) keeps each row on its own label',
    h.descriptionOf('agent-28d') === '标废设计文档过时记录' && h.descriptionOf('agent-9ec') === '实测入口加 Codex 组合',
    `${h.descriptionOf('agent-28d')} / ${h.descriptionOf('agent-9ec')}`)
}

// ── B2b. continuable 顺序（边缘 → catalog）：首帧可以猜，catalog 必须纠正。
{
  const h = harness()
  delegate(h, 268, '实测入口加 Codex 组合')
  delegate(h, 269, '标废设计文档过时记录')
  spawn(h, 'agent-28d', 'r-28d')
  spawn(h, 'agent-9ec', 'r-9ec')
  catalog(h, 270, 'agent-28d', '标废设计文档过时记录')
  catalog(h, 271, 'agent-9ec', '实测入口加 Codex 组合')
  check('B2b continuable order (edge first) is healed by the catalog',
    h.descriptionOf('agent-28d') === '标废设计文档过时记录' && h.descriptionOf('agent-9ec') === '实测入口加 Codex 组合',
    `${h.descriptionOf('agent-28d')} / ${h.descriptionOf('agent-9ec')}`)
}

// ── B2c. continuable 并发的**首帧**（现场事故的形态）：队列里压着两条无身份的
//    term，两行谁都不许顶着另一条的标题出场——宁可占位，等 keyed label 定案。
//    这是"卡片标题跟错实体"的直接回归钉子（对抗复核用它复现过 7/9 帧）。
{
  const h = harness()
  const titles = ['实测入口加 Codex 组合', '标废设计文档过时记录']
  delegate(h, 268, titles[0]!)
  delegate(h, 269, titles[1]!)
  spawn(h, 'agent-28d', 'r-28d')
  spawn(h, 'agent-9ec', 'r-9ec')
  const shown = [h.descriptionOf('agent-28d'), h.descriptionOf('agent-9ec')]
  check('B2c an ambiguous first frame borrows no concurrent title',
    shown.every(title => !titles.includes(String(title))),
    shown.map(String).join(' / '))
}

// ── B3. 每个 keyed 事实（label + mode）落到自己的 childId。
{
  const h = harness()
  delegate(h, 1, '队列项')
  catalog(h, 2, 'agent-k', 'K 的 label', 'one-shot')
  spawn(h, 'agent-k', 'r-k')
  check('B3 every keyed fact lands on its own childId',
    h.descriptionOf('agent-k') === 'K 的 label' && h.rowOf('agent-k')?.mode === 'one-shot',
    `${h.descriptionOf('agent-k')} / ${String(h.rowOf('agent-k')?.mode)}`)
}

// ═══ P1 ═══════════════════════════════════════════════════════════════════

// ── K1. 同 run 的重复边缘不消费队列。构造上让每条 term 到达时队列只有它一条，
//    否则会先撞上 A1b 的整批作废、测不到重复边缘这一条规则。
{
  const h = harness()
  delegate(h, 1, 'A 的描述')
  spawn(h, 'agent-a', 'r-a')
  delegate(h, 2, 'B 的描述')
  spawn(h, 'agent-a', 'r-a')
  spawn(h, 'agent-b', 'r-b')
  check('K1 a re-announced edge does not shift the queue', h.descriptionOf('agent-b') === 'B 的描述', String(h.descriptionOf('agent-b')))
}

// ── K2. 没有 keyed 事实的新 run 仍消费队列（continuable 二次派发）。
{
  const h = harness()
  delegate(h, 1, '第一轮')
  spawn(h, 'agent-free', 'r-1')
  delegate(h, 2, '第二轮')
  spawn(h, 'agent-free', 'r-2')
  check('K2 a new epoch of an unbound row takes the new term', h.descriptionOf('agent-free') === '第二轮', String(h.descriptionOf('agent-free')))
}

// ── K3. 队列为空 → 占位描述被 keyed label 覆盖。
{
  const h = harness()
  spawn(h, 'agent-ph', 'r-ph')
  const placeholder = h.descriptionOf('agent-ph')
  catalog(h, 10, 'agent-ph', '占位行的真描述')
  check('K3 an empty queue leaves a placeholder that the label replaces',
    placeholder !== '占位行的真描述' && h.descriptionOf('agent-ph') === '占位行的真描述', String(placeholder))
}

// ── K4. 历史折叠只认 catalog，不污染队列。
{
  const h = harness()
  h.projection.bootstrapFromLog([
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'call_1', name: 'subagent', arguments: JSON.stringify({ description: '历史派发（不该入队）' }) } },
    { type: 'subagent/catalog', seq: 2, time: 2, data: { version: 0, childId: 'agent-hist', childCreatedAt: 2, mode: 'continuable', label: '历史子代理' } },
  ], String(parentSession.id))
  check('K4 a folded catalog row is described by its own label', h.descriptionOf('agent-hist') === '历史子代理', String(h.descriptionOf('agent-hist')))
  delegate(h, 3, '复活后的新派发')
  spawn(h, 'agent-live', 'r-live')
  check('K4b the replayed tool/call did not queue a stale term', h.descriptionOf('agent-live') === '复活后的新派发', String(h.descriptionOf('agent-live')))
}

// ── K5. 子会话自述（subagent/descriptor）也是纠正路径。
{
  const h = harness()
  delegate(h, 1, '队列里的错项')
  spawn(h, 'agent-desc', 'r-desc')
  h.projection.store.linkSession('agent-desc', childSession)
  h.projection.onSessionEvent(childSession, { type: 'subagent/descriptor', seq: 0, time: 0, data: { version: 3, mode: 'continuable', provider: 'spawn', label: '子会话自述' } })
  check('K5 the child session descriptor corrects the row', h.descriptionOf('agent-desc') === '子会话自述', String(h.descriptionOf('agent-desc')))
}

// ── K6. 显式 patch 的描述是权威（`patch({description})` 当前无生产调用者，属语义钉子）。
{
  const h = harness()
  delegate(h, 1, '队列项')
  spawn(h, 'agent-p', 'r-p')
  h.projection.store.patch('agent-p', { description: '显式写入' })
  catalog(h, 9, 'agent-p', 'catalog 的 label')
  check('K6 an explicit description outranks the catalog label', h.descriptionOf('agent-p') === '显式写入', String(h.descriptionOf('agent-p')))
}

// ── K7. 子会话自述比它那一行先到（宿主在建立 session link 之前就投递）：keyed 事实
//    被寄存，行建出来时直接带自己的名字，而不是被队列的猜测占住 —— 那种情况下
//    再也没有第二条 keyed 事实来救（外部子代理上游不写 catalog）。
{
  const h = harness()
  const earlySession = { id: 'sess-early-1' }
  const handled = h.projection.onSessionEvent(earlySession, { type: 'subagent/descriptor', seq: 0, time: 0, data: { version: 3, mode: 'continuable', provider: 'spawn', label: '自述的真名' } })
  delegate(h, 1, '队列里的别人的 term')
  spawn(h, String(earlySession.id), 'r-early')
  check('K7 a descriptor that beats its row is adopted, not dropped',
    handled === false && h.descriptionOf(String(earlySession.id)) === '自述的真名',
    `handled=${String(handled)} desc=${String(h.descriptionOf(String(earlySession.id)))}`)
  spawn(h, 'agent-after-early', 'r-after-early')
  check('K7b the term it displaced was consumed, not handed on',
    h.descriptionOf('agent-after-early') !== '队列里的别人的 term', String(h.descriptionOf('agent-after-early')))
}

// ── P1. 队列上限：溢出丢最旧（保留最后 32 条），防未来改成丢最新。直接看队列本身
//    ——经过 spawn 看会先撞上"歧义作废"，测不出上限。
{
  const h = harness()
  for (let i = 1; i <= 40; i += 1) delegate(h, i, `描述-${i}`)
  const queued = h.projection.pendingTaskDescriptions
  check('P1 the queue keeps the newest 32 terms',
    queued.length === 32 && queued[0] === '描述-9' && queued[31] === '描述-40',
    `${queued.length} / ${String(queued[0])} / ${String(queued[31])}`)
}

// ── P2. 外层 reset 重建投影，旧队列和被驱逐描述的待启动计数都不能进入新会话。
{
  const h = harness()
  delegate(h, 1, 'reset 前的残留')
  h.projection.reset()
  spawn(h, 'agent-after-reset', 'r-reset')
  check('P2 an outer reset rebuilds the projection (no stale term reaches the next spawn)', h.descriptionOf('agent-after-reset') !== 'reset 前的残留', String(h.descriptionOf('agent-after-reset')))
}
{
  const h = harness()
  for (let i = 1; i <= 40; i += 1) delegate(h, i, `旧描述-${i}`)
  h.projection.reset()
  delegate(h, 41, '新会话的唯一任务')
  spawn(h, 'agent-reset-overflow', 'r-reset-overflow')
  check('P2b an outer reset forgets evicted pending descriptions', h.descriptionOf('agent-reset-overflow') === '新会话的唯一任务', String(h.descriptionOf('agent-reset-overflow')))
}

// ── P3. catalog 先建占位行（无 label），之后带 label 的 catalog 能补上。
{
  const h = harness()
  catalog(h, 1, 'agent-late')
  const placeholder = h.descriptionOf('agent-late')
  catalog(h, 2, 'agent-late', '迟到的 label')
  check('P3 a label-less row is healed by a later label',
    placeholder !== '迟到的 label' && h.descriptionOf('agent-late') === '迟到的 label', String(placeholder))
}

// ── P4. 未建立 session link 时，descriptor 不认领（也不改描述）。
{
  const h = harness()
  delegate(h, 1, '队列里的 term')
  spawn(h, 'agent-nolink', 'r-nolink')
  const before = h.descriptionOf('agent-nolink')
  const handled = h.projection.onSessionEvent(childSession, { type: 'subagent/descriptor', seq: 0, time: 0, data: { version: 3, mode: 'continuable', provider: 'spawn', label: '无法归属的自述' } })
  check('P4 an unlinked descriptor is not claimed',
    handled === false && h.descriptionOf('agent-nolink') === before,
    `handled=${String(handled)} desc=${String(h.descriptionOf('agent-nolink'))}`)
}

// ── P5. 空 label 建行也要有非空标题（`??` 不处理空串）。
{
  const h = harness()
  catalog(h, 1, 'agent-empty', '')
  const description = h.descriptionOf('agent-empty')
  check('P5 an empty label still yields a non-empty title',
    typeof description === 'string' && description.trim() !== '', JSON.stringify(description))
}

// ── P6. 空 description 不入队（直接看队列，别拿占位文案当断言）。
{
  const h = harness()
  delegate(h, 1, '')
  spawn(h, 'agent-void', 'r-void')
  check('P6 an empty description never enters the queue',
    h.projection.pendingTaskDescriptions.length === 0,
    `${h.projection.pendingTaskDescriptions.length} / ${String(h.descriptionOf('agent-void'))}`)
}

// ── P7. 已经建过行的 child 收到不带 runId 的边缘：那是一次刷新，不消费队列、也不
//    清空 epoch。
{
  const h = harness()
  delegate(h, 1, 'A 的描述')
  spawn(h, 'agent-norun', 'r-1')
  h.projection.store.patch('agent-norun', { status: 'running' })
  spawn(h, 'agent-norun')
  check('P7 a runId-less edge of a known row is a refresh, not a new epoch', h.descriptionOf('agent-norun') === 'A 的描述' && h.rowOf('agent-norun')?.runId === 'r-1', `${String(h.descriptionOf('agent-norun'))} / ${String(h.rowOf('agent-norun')?.runId)}`)
  delegate(h, 2, 'B 的描述')
  spawn(h, 'agent-next', 'r-2')
  check('P7b the queue was not shifted by that refresh', h.descriptionOf('agent-next') === 'B 的描述', String(h.descriptionOf('agent-next')))
}

// ── P9. 反过来：行还不存在的无 runId 边缘是**新 run**，不是刷新。判成刷新会让它既
//    不消费自己的 term、又把那条 term 顺延给下一个 child —— 正是本 PR 要消灭的形态。
//    （上游的 edge 恒带 runId，这条属防护性断言。）
{
  const h = harness()
  delegate(h, 1, 'Z 的任务')
  spawn(h, 'agent-norun-first')
  check('P9 a runId-less first edge of an untracked child consumes its term',
    h.descriptionOf('agent-norun-first') === 'Z 的任务', String(h.descriptionOf('agent-norun-first')))
  spawn(h, 'agent-after-norun', 'r-after')
  check('P9b that term was not left behind for the next spawn',
    h.descriptionOf('agent-after-norun') !== 'Z 的任务', String(h.descriptionOf('agent-after-norun')))
}

// ── P8. 文本作废不代表旧派发已经启动：Y 迟到时不能取走后来才入队的 Z。
{
  const h = harness()
  delegate(h, 1, 'X 的 term')
  delegate(h, 2, 'Y 的 term')
  spawn(h, 'agent-p8a', 'r-p8a')
  delegate(h, 3, 'Z 的 term')
  spawn(h, 'agent-p8b', 'r-p8b')
  check('P8 a delayed start cannot take a later delegation title',
    h.descriptionOf('agent-p8a') !== 'X 的 term' && h.descriptionOf('agent-p8a') !== 'Y 的 term' && h.descriptionOf('agent-p8b') !== 'Z 的 term',
    `${String(h.descriptionOf('agent-p8a'))} / ${String(h.descriptionOf('agent-p8b'))}`)
}

// ── P10. 远程 provider 没有本地 session，也没有 catalog/descriptor 来补救错名。
//    B 的启动迟于 C 的派发；分别覆盖 B 先启动和 C 先启动，再确认歧义批次用完后
//    独立的新派发仍能取得自己的首帧描述。
for (const order of [['remote-b', 'remote-c'], ['remote-c', 'remote-b']]) {
  const h = harness()
  const remote = { provider: 'codex', local: false }
  delegate(h, 1, '远程 A 的标题')
  delegate(h, 2, '远程 B 的标题')
  spawn(h, 'remote-a', 'r-remote-a', remote)
  delegate(h, 3, '远程 C 的标题')
  for (const id of order) spawn(h, id, `r-${id}`, remote)
  h.projection.onEnd({ id: 'remote-b', runId: 'r-remote-b', stopReason: 'completed' }, agent)
  check(`P10 ${order.join(' → ')} does not leave a remote row with a peer title`,
    h.rowOf('remote-b')?.status === 'completed'
      && h.rowOf('remote-c')?.status === 'running'
      && h.descriptionOf('remote-b') !== '远程 C 的标题'
      && h.descriptionOf('remote-c') !== '远程 B 的标题',
    `${String(h.descriptionOf('remote-b'))} / ${String(h.descriptionOf('remote-c'))}`)
  delegate(h, 4, '批次结束后的独立任务')
  spawn(h, 'remote-d', 'r-remote-d', remote)
  check(`P10b ${order.join(' → ')} drains the pending slots`,
    h.descriptionOf('remote-d') === '批次结束后的独立任务', String(h.descriptionOf('remote-d')))
}

// ── P11. 上限只驱逐文本，不能忘记那一次派发仍在等待启动；超过 32 条的旧批次
//    与后来的新派发交错时，同样不能把新标题交给旧任务。
{
  const h = harness()
  const remote = { provider: 'codex', local: false }
  for (let i = 1; i <= 40; i += 1) delegate(h, i, `远程任务-${i}`)
  spawn(h, 'overflow-1', 'r-overflow-1', remote)
  delegate(h, 41, '溢出批次之后的新标题')
  for (let i = 2; i <= 40; i += 1) spawn(h, `overflow-${i}`, `r-overflow-${i}`, remote)
  check('P11 evicted terms still account for delayed starts',
    h.state.subagents.length === 40 && h.state.subagents.every(row => row.description !== '溢出批次之后的新标题'))
  spawn(h, 'overflow-new', 'r-overflow-new', remote)
  delegate(h, 42, '溢出批次结束后的独立任务')
  spawn(h, 'overflow-solo', 'r-overflow-solo', remote)
  check('P11b the overflow backlog eventually drains',
    h.descriptionOf('overflow-solo') === '溢出批次结束后的独立任务', String(h.descriptionOf('overflow-solo')))
}

// The total is printed so the count in the docs can be checked against the run
// (`grep -c '^PASS\|^FAIL'` stays the machine-checkable number).
console.log(failed === 0 ? `\nALL PASS (${checks} checks)` : `\n${failed} FAIL (of ${checks} checks)`)
process.exit(failed === 0 ? 0 : 1)
