/**
 * verify-attached-context — 侧栏「Send to Chat」channel 层回归（设计 §6.7）。
 *
 * 三面覆盖：
 *   A 纯函数（无渲染）：attach/detach/consume 的投影语义（id 自增 ctx-N、
 *     重复 sourceId+title 替换而非叠加、超限截断 + truncated 标记）与
 *     <attached-context …> 块形状（与 <attached-file … selection> 同形、
 *     属性转义、截断标记）；
 *   B 真 channel（真 cordis Context + 假 agent/agents 服务）：投影可见且推进
 *     version → 提交 payload 经 composer 路径带块且 chip 清空 → 第二次提交
 *     不再带（consume-once）→ 真实 /new 会话切换清空；
 *   C 真 PromptInput（headless xterm）：chip 上屏、在输入行上方、多枚同行横排、
 *     超宽单行截断（不撑高、不换行）；
 *   D Esc 分层：有 chip 时第一次 Esc 只清 chip（草稿原样），第二次才清草稿。
 *
 * 运行：node --import tsx/esm scripts/verify-attached-context.tsx
 */
process.env.FORCE_COLOR = '3'
// Chip 文案断言走 zh（'⧉ {{title}}' 两侧同形，语言只影响其它行文）。
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

// 家目录隔离：channel 构造路径会 touch ~/.dsh-tui，先切临时目录再 import。
const nodeFs = await import('node:fs')
const nodeOs = await import('node:os')
const nodePath = await import('node:path')
const isolatedHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dshtui-attached-context-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
nodeFs.mkdirSync(nodePath.join(isolatedHome, '.dsh-tui'), { recursive: true })

const { Context } = await import('@deepseek-ai/cordis')
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const {
  createAttachedContextRegistry, buildAttachedContextBlock, appendAttachedContextBlocks,
} = await import('../src/dsh-adapter/channel/attached-context.js')
const { MENTION_MAX_FILE_CHARS } = await import('../src/dsh-adapter/channel/mentions.js')
const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')
const { settled, sleep, viewportLines, screenHas, findText } = await import('./lib/term-test.mjs')
const React = (await import('react')).default
const { Writable, PassThrough } = await import('node:stream')
const xterm = await import('@xterm/headless')
const { render, AlternateScreen } = await import('../src/ui.js')
const { PromptInput } = await import('../src/components/PromptInput.js')
const { LOCAL_COMMANDS } = await import('../src/commands.js')
const { Terminal: XTerm } = xterm

let failed = 0
function check(name, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

const BLOCK = 'boom\nstack'
const EXPECTED_BLOCK = '<attached-context source="panel" sourceId="job-142" title="Job #142">\nboom\nstack\n</attached-context>'

// ---------------------------------------------------------------------------
// A — registry 语义 + 块构造（纯函数）
// ---------------------------------------------------------------------------
console.log('--- A: registry + block builder ---')
{
  const holder = { attachedContexts: [] }
  let emits = 0
  const registry = createAttachedContextRegistry(() => holder, () => { emits += 1 })
  const first = { source: 'panel', sourceId: 'job-142', title: 'Job #142', content: BLOCK }

  registry.attach(first)
  const entry = holder.attachedContexts[0]
  check('A1 attach 落投影：id=ctx-1 / source=panel / chars=content.length / 未截断',
    holder.attachedContexts.length === 1 && entry.id === 'ctx-1' && entry.source === 'panel'
    && entry.sourceId === 'job-142' && entry.title === 'Job #142' && entry.content === BLOCK
    && entry.chars === BLOCK.length && entry.truncated === false,
    JSON.stringify(entry))
  check('A1 attach 推进一次 emit（读投影按 version 取快照）', emits === 1)

  // 重复 sourceId+title = REPLACE：同 id、同位置、内容更新，不叠第二枚 chip。
  const updated = 'line 1\nline 2\nline 3'
  registry.attach({ source: 'panel', sourceId: 'job-142', title: 'Job #142', content: updated })
  check('A2 重复键替换（同 id、数量不变、内容与 chars 更新）',
    holder.attachedContexts.length === 1 && holder.attachedContexts[0].id === 'ctx-1'
    && holder.attachedContexts[0].content === updated
    && holder.attachedContexts[0].chars === updated.length,
    JSON.stringify(holder.attachedContexts))

  // 同 sourceId、不同 title = 另一枚 chip；id 自增。
  registry.attach({ source: 'panel', sourceId: 'job-142', title: 'Job #143', content: 'other' })
  check('A3 同 sourceId 不同 title 并列两枚，id 自增 ctx-2',
    holder.attachedContexts.length === 2 && holder.attachedContexts[1].id === 'ctx-2')

  const emitsBeforeNoop = emits
  registry.detach('nope')
  check('A4 detach 未知 id 是 no-op（不 emit）',
    holder.attachedContexts.length === 2 && emits === emitsBeforeNoop)
  registry.detach('ctx-2')
  check('A4 detach 只摘目标那一枚',
    holder.attachedContexts.length === 1 && holder.attachedContexts[0].id === 'ctx-1')

  // consume = 取快照 + 清空（一次提交只带一次）。
  const taken = registry.consume()
  check('A5 consume 返回快照并清空投影',
    taken.length === 1 && taken[0].id === 'ctx-1' && holder.attachedContexts.length === 0)
  const emitsAfterConsume = emits
  check('A5 空投影 consume 不 emit（不空推 version）',
    registry.consume().length === 0 && emits === emitsAfterConsume)

  // 上限：内容超 MENTION_MAX_FILE_CHARS 在 attach 时截断并记 truncated。
  registry.attach({ source: 'panel', sourceId: 'huge', title: 'Huge', content: 'y'.repeat(MENTION_MAX_FILE_CHARS + 500) })
  const capped = holder.attachedContexts[0]
  check('A6 超限内容 attach 时截断（content/chars = 上限、truncated 记位）',
    capped !== undefined && capped.content.length === MENTION_MAX_FILE_CHARS
    && capped.chars === MENTION_MAX_FILE_CHARS && capped.truncated === true)
  check('A6 截断块带可见省略标记',
    buildAttachedContextBlock(capped).indexOf('\n[… truncated]\n</attached-context>') >= 0)

  registry.detach(capped.id)
  registry.attach({ source: 'panel', sourceId: 'exact', title: 'Exact', content: 'z'.repeat(MENTION_MAX_FILE_CHARS) })
  const exact = holder.attachedContexts[0]
  check('A6 恰好等于上限不误标截断',
    exact !== undefined && exact.truncated === false && exact.chars === MENTION_MAX_FILE_CHARS
    && buildAttachedContextBlock(exact).indexOf('truncated') < 0)

  // 块形状：与 <attached-file … selection> 同形（属性 + 正文行 + 闭标签）。
  check('A7 块形状固定', buildAttachedContextBlock({
    id: 'ctx-9', source: 'panel', sourceId: 'job-142', title: 'Job #142',
    content: BLOCK, chars: BLOCK.length, truncated: false,
  }) === EXPECTED_BLOCK)

  const escaped = buildAttachedContextBlock({
    id: 'ctx-10', source: 'panel', sourceId: 'a"b', title: 'x&y<z>', content: 'c', chars: 1, truncated: false,
  })
  check('A7 属性转义（& " < > 不得逃出属性）',
    escaped.indexOf('<attached-context source="panel" sourceId="a&quot;b" title="x&amp;y&lt;z&gt;">') === 0, escaped)

  // 追加器：按 stage 顺序、返回条数；空列表不动 blocks。
  const blocks = [{ type: 'text', text: 'typed' }]
  const appended = appendAttachedContextBlocks(blocks, [
    { id: 'ctx-11', source: 'panel', sourceId: 's', title: 'One', content: '1', chars: 1, truncated: false },
    { id: 'ctx-12', source: 'panel', sourceId: 's', title: 'Two', content: '2', chars: 1, truncated: false },
  ])
  check('A8 追加器保序、返回条数、正文块仍在前',
    appended === 2 && blocks.length === 3 && blocks[0].text === 'typed'
    && blocks[1].text.indexOf('title="One"') >= 0 && blocks[2].text.indexOf('title="Two"') >= 0)
  check('A8 空列表不产块', appendAttachedContextBlocks(blocks, []) === 0 && blocks.length === 3)
}

// ---------------------------------------------------------------------------
// B — 真 channel：投影 / 提交 payload / consume-once / 会话切换清空
// ---------------------------------------------------------------------------
console.log('--- B: real channel ---')
const delivered = []
function makeAgent(id, sessionId) {
  return {
    id,
    status: 'idle',
    options: {},
    ctx: { on: () => () => {} },
    session: { id: sessionId, seq: 0, events: [], header: {} },
    followup(message) { delivered.push(message) },
    steer(message) { delivered.push(message) },
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}
const makeHandle = agent => ({ agent, dispose: () => Promise.resolve() })
{
  const ctx = new Context()
  const provide = ctx.provide.bind(ctx)
  const initial = makeAgent('agent-a', 'sess-a')
  provide('agents', {
    get: () => undefined,
    create: () => Promise.resolve(makeHandle(makeAgent('agent-b', 'sess-b'))),
  })
  const channel = createChannel(ctx, initial, { model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false })

  check('B1 初始投影为空数组', Array.isArray(channel.attachedContexts) && channel.attachedContexts.length === 0)
  const versionBefore = channel.version
  let wakes = 0
  const stop = channel.subscribe(() => { wakes += 1 })

  channel.attachContext({ source: 'panel', sourceId: 'job-142', title: 'Job #142', content: BLOCK })
  check('B1 attach 后投影可见（真 channel 直读）',
    channel.attachedContexts.length === 1 && channel.attachedContexts[0].id === 'ctx-1'
    && channel.attachedContexts[0].chars === BLOCK.length,
    JSON.stringify(channel.attachedContexts))
  check('B1 attach 推进 version 并通知订阅者', channel.version > versionBefore && wakes >= 1)

  channel.submit('看看这段输出')
  check('B2 提交 payload 经 composer 路径附块（正文块仍第一）',
    await settled(() => delivered.length === 1
      && delivered[0].content[0].text === '看看这段输出'
      && delivered[0].content[1].text === EXPECTED_BLOCK),
    delivered.length === 1 ? JSON.stringify(delivered[0].content) : 'no delivery')
  check('B2 提交后 chip 清空', channel.attachedContexts.length === 0)

  channel.submit('第二条')
  check('B3 第二次提交不带上下文（consume-once）',
    await settled(() => delivered.length === 2 && delivered[1].content.length === 1))

  channel.attachContext({ source: 'panel', sourceId: 'job-1', title: 'One', content: '1' })
  channel.attachContext({ source: 'panel', sourceId: 'job-2', title: 'Two', content: '2' })
  channel.submit('两条一起')
  check('B3b 多枚按 stage 顺序各附一块，提交后同步清空',
    await settled(() => delivered.length === 3 && channel.attachedContexts.length === 0
      && delivered[2].content.length === 3
      && delivered[2].content[1].text.indexOf('title="One"') >= 0
      && delivered[2].content[2].text.indexOf('title="Two"') >= 0),
    JSON.stringify(delivered[2] === undefined ? null : delivered[2].content))

  // 生产读投影（mountChannelUi 内部用的同一个 createChannelUi）：新属性/动作
  // 必须穿过冻结视图——真实 Chat 与面板消费的是它，不是裸 ChannelState。
  {
    const lease = createChannelUiLease(() => true)
    const view = createChannelUi(channel, 'new', lease)
    view.attachContext({ source: 'panel', sourceId: 'job-7', title: 'Job #7', content: 'panel body' })
    const seen = view.attachedContexts
    check('B6 生产视图可见新投影（脱离的冻结快照）',
      seen.length === 1 && /^ctx-\d+$/.test(seen[0].id) && seen[0].sourceId === 'job-7'
      && seen[0].chars === 'panel body'.length
      && Object.isFrozen(seen) && Object.isFrozen(seen[0]), JSON.stringify(seen))
    view.detachContext(seen[0].id)
    check('B6 生产视图 detach 生效', view.attachedContexts.length === 0)
    lease.dispose()
  }

  // 真实会话切换（/new）：attachedContexts 与其它会话级投影同一漏斗。
  channel.attachContext({ source: 'panel', sourceId: 'job-9', title: 'Stale', content: 'stale' })
  check('B4 切换前确实有 chip（前置条件成立）', channel.attachedContexts.length === 1)
  check('B4 /new 成功', (await channel.newSession()) === true)
  check('B4 会话切换清空 attachedContexts', channel.attachedContexts.length === 0)
  stop()
  channel.releaseContributions()
}
// resume / rewind / model-switch / 后台化都必须走同一个重置漏斗（否则新会话会
// 带着上一段对话的 chip，甚至把面板上下文喂给别的会话）。
{
  const callers = ['session-adoption.ts', 'session-live-adoption.ts', 'session-resume.ts', 'model-switch.ts', 'background-action.ts']
  const missing = callers.filter(file =>
    nodeFs.readFileSync(nodePath.join(import.meta.dirname, '..', 'src', 'dsh-adapter', 'channel', file), 'utf8')
      .indexOf('resetSessionProjection') < 0)
  check('B5 rewind/resume/model-switch/background 共用 resetSessionProjection 漏斗', missing.length === 0, missing.join(','))
  const resetSource = nodeFs.readFileSync(
    nodePath.join(import.meta.dirname, '..', 'src', 'dsh-adapter', 'channel', 'session-reset.ts'), 'utf8')
  check('B5 漏斗确实清 attachedContexts', resetSource.indexOf('state.attachedContexts = []') >= 0)
}

// ---------------------------------------------------------------------------
// C/D — 真 PromptInput：chip 上屏 + Esc 分层
// ---------------------------------------------------------------------------
console.log('--- C/D: composer render ---')
{
  const COLS = 80
  const ROWS = 20
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = COLS; this.rows = ROWS; this.isTTY = true }
    _write(chunk, _e, cb) { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable {
    constructor() { super(); this.isTTY = true }
    _write(_c, _e, cb) { cb() }
  }
  class FakeStdin extends PassThrough {
    constructor() { super(); this.isTTY = true }
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }

  // 假 channel 只补 PromptInput 读取的面；attachedContexts / attachContext /
  // detachContext 走真 registry，语义（id/替换/截断）与真 channel 一致。
  const holder = { attachedContexts: [] }
  const listeners = new Set()
  let version = 0
  const bump = () => { version += 1; for (const listener of Array.from(listeners)) listener() }
  const registry = createAttachedContextRegistry(() => holder, bump)
  const channel = {
    staged: new Map(),
    rows: [],
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    agentBindingGeneration: 0,
    model: 'model-00',
    provider: 'fake-provider',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    commandCompletions: () => [],
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit() {}, steer() {}, cancel() {}, clear() {}, notify() {},
    stagedImageGeneration: () => 0,
    stageImage: async () => '[Image #1]',
    async stageComposerImage() { return { stageId: 'stage-1' } },
    discardStagedImage() {},
    hasStagedImage: () => false,
    stagedImage: () => undefined,
    stagedImageLimits: () => undefined,
    attachContext(input) { registry.attach(input) },
    detachContext(id) { registry.detach(id) },
  }
  Object.defineProperty(channel, 'version', { get: () => version })
  Object.defineProperty(channel, 'attachedContexts', { get: () => holder.attachedContexts })

  function Host() {
    // Chat 的接线等价物：version 变化重渲染（真 Chat 用 useExternalVersion）。
    React.useSyncExternalStore(
      listener => channel.subscribe(listener),
      () => channel.version,
    )
    return React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp: () => {},
      onRunCommand: () => false,
      selectionActive: false,
    })
  }

  const stdin = new FakeStdin()
  const app = await render(React.createElement(AlternateScreen, null, React.createElement(Host)), {
    stdin,
    stdout: new FakeStdout(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // 固定窗:pacing 等首帧挂载与 useInput 监听注册，无单一可观测锚点。
  await sleep(400)

  check('C1 无上下文时不渲染 chip（前置条件）', !screenHas(term, '⧉'))

  stdin.write('草稿')
  check('C2 草稿上屏（Esc 分层的对照物）', await settled(() => screenHas(term, '草稿')))

  channel.attachContext({ source: 'panel', sourceId: 'job-142', title: 'Job #142', content: BLOCK })
  check('C2 attach 后 chip 上屏', await settled(() => screenHas(term, '⧉ Job #142')))
  const chipPos = findText(term, '⧉ Job #142')
  const draftPos = findText(term, '草稿')
  check('C2 chip 在输入行上方', chipPos !== null && draftPos !== null && chipPos.row < draftPos.row,
    JSON.stringify({ chip: chipPos, draft: draftPos }))

  channel.attachContext({ source: 'panel', sourceId: 'job-143', title: 'Job #143', content: 'x' })
  channel.attachContext({ source: 'panel', sourceId: 'job-144', title: 'Job #144', content: 'y' })
  check('C3 多枚 chip 同一行横排（按 stage 顺序）', await settled(() => {
    const a = findText(term, '⧉ Job #142')
    const b = findText(term, '⧉ Job #143')
    const c = findText(term, '⧉ Job #144')
    return a !== null && b !== null && c !== null && a.row === b.row && b.row === c.row
      && a.col < b.col && b.col < c.col
  }))

  // 超宽：只留一枚超长标题的 chip —— 行高恒 1、以省略号收尾、完整标题不上屏。
  const detachAll = () => { for (const item of Array.from(holder.attachedContexts)) registry.detach(item.id) }
  detachAll()
  check('C4 前置：清空后 chip 行消失', await settled(() => !screenHas(term, '⧉')))
  const longTitle = 'Job #' + '9'.repeat(120)
  channel.attachContext({ source: 'panel', sourceId: 'long', title: longTitle, content: 'z' })
  check('C4 超宽 chip 单行截断（恒一行、省略号收尾、完整标题不上屏）', await settled(() => {
    const rows = viewportLines(term).filter(line => line.indexOf('⧉') >= 0)
    return rows.length === 1 && rows[0].trimEnd().endsWith('…') && !screenHas(term, longTitle)
  }), JSON.stringify(viewportLines(term).filter(line => line.indexOf('⧉') >= 0)))

  // D — Esc 分层。
  detachAll()
  channel.attachContext({ source: 'panel', sourceId: 'job-142', title: 'Job #142', content: BLOCK })
  check('D1 分层前置：chip 在屏、草稿在屏',
    await settled(() => screenHas(term, '⧉ Job #142') && screenHas(term, '草稿')))

  stdin.write('\x1b')
  check('D1 第一次 Esc 只清 chip', await settled(() => !screenHas(term, '⧉ Job #142')
    && holder.attachedContexts.length === 0))
  check('D1 ……且草稿原样保留（Esc 不动文本）', screenHas(term, '草稿'))

  stdin.write('\x1b')
  check('D2 第二次 Esc 才清草稿', await settled(() => !screenHas(term, '草稿')))

  await app.unmount()
}

console.log('')
console.log(failed === 0 ? 'verify-attached-context: all checks passed' : 'verify-attached-context: ' + failed + ' check(s) FAILED')
process.exit(failed === 0 ? 0 : 1)
