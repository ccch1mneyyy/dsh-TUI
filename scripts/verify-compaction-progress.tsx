/**
 * 压缩进行中的状态行回归（真实 channel.compact / 可控 fake compaction 服务 +
 * 真实 llm/stream 观测器 + 真实组件渲染）：
 *
 *  1. 手动 /compact 打开一行可取消的「压缩中」状态（prefill 起算），不再只发
 *     一条 4 秒 toast —— 实测压缩中位 ~25s / p90 ~70s，旧提示只盖住开头 4 秒。
 *  2. llm/stream 观测器按 `purpose: 'compaction'` + 本会话 sessionId 过滤：
 *     计数本次摘要的输出字符并把阶段切到 summary；其他 purpose / 其他会话
 *     必须原样透传同一个 iterable（不消费、不包装）。
 *  3. cancelCompact（Esc / Ctrl+C）中止在飞事务：服务看到 abort、行被清掉、
 *     提示是「已取消」而不是「失败」；无在飞事务时是 no-op。
 *  4. 自动压力压缩由 session 事件驱动：`compaction/start` 建一行不可取消的
 *     行，`compaction/end` 清掉；宿主自己的 start 事件不得把手动行降级。
 *  5. 组件渲染：标签 + 阶段 + 计时 + Esc 提示；窄终端先丢阶段、再丢提示；
 *     前导指示器随 spinner 槽位——开了活动行就用用户的 `/activity` 预设
 *     （宽帧要计入行宽预算），否则才是经典圆点。
 *  6. 挂真实 Chat：状态行出现在 prompt 上方，Esc 真的打到 cancelCompact；
 *     不可取消的那一行（自动压缩）Esc 不触发取消；回合进行中改为 spinner
 *     后缀徽标而不是第二行。
 *
 * 运行：node --import tsx/esm scripts/verify-compaction-progress.tsx
 */
const [{ createChannel }, { settled, viewportLines }, { Writable, PassThrough }, React, { Terminal: XTerm }, ui, { CompactionStatusRow }, { t }, { Chat }, { QuestionStore }, { default: instances }, { FRAME_PRESETS }, { ActivityStore }] =
  await Promise.all([
    import('../src/dsh-adapter/channel.js'),
    import('./lib/term-test.mjs'),
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/CompactionStatusRow.js'),
    import('../src/i18n.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/ink/instances.js'),
    import('../src/components/activityFrames.js'),
    import('../src/dsh-adapter/activity-store.js'),
  ])

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = (cond, ms = 3000) => settled(cond, { timeoutMs: ms })
const toasts = channel => channel.notifications.map(item => item.text).join('\n')
/** `/activity aesthetic` — the progress-bar preset the row has to borrow. */
const BAR_FRAMES = FRAME_PRESETS.aesthetic.frames

// ---- 事件与 agent 桩 --------------------------------------------------------
let seq = 0
let now = Date.now()
function ev(type, data) {
  return { seq: seq++, time: (now += 5), type, data }
}
function makeEvents(turns = 2) {
  const events = []
  for (let turn = 0; turn < turns; turn++) {
    events.push(ev('turn/start', { turn }))
    events.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${turn}` }] }))
    events.push(ev('assistant/message', {
      turn, step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${turn}` }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    }))
    events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events
}
const stubAgentCtx = { on: () => () => {} }
function makeAgent(id, sessionEvents) {
  return {
    id,
    status: 'idle',
    session: { id: `s-${id}`, seq: sessionEvents.length, events: sessionEvents, header: {} },
    ctx: stubAgentCtx,
    followup() {},
    steer() {},
    inbox: { remove: () => true },
  }
}

// ---- 可控 compaction 服务：hang 到 abort / 直接成功 -------------------------
function makeCompaction(kind) {
  const calls = []
  return {
    calls,
    async compactNow(agent, signal) {
      const call = { agentId: agent.id, abortedAt: undefined }
      calls.push(call)
      if (kind === 'resolve') {
        await sleep(20) // 固定窗:pacing 桩内模拟压缩耗时，不是在等可观测状态
        return { shadowedSeqs: [1, 2] }
      }
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          call.abortedAt = Date.now()
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      return undefined
    },
  }
}

function assemble(kind = 'hang-until-abort', extra = []) {
  seq = 0
  const compaction = makeCompaction(kind)
  const services = { compaction, llm: { listProviders: () => [], listModels: async () => [] } }
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => { if (handlers.get(event) === handler) handlers.delete(event) }
    },
    get: name => services[name],
    logger: { warn() {} },
  }
  const events = makeEvents()
  // Extra durable events land in the log BEFORE the channel binds, so they are
  // folded by the replay path rather than by the live `session/event` path.
  for (const event of extra) events.push(ev(event.type, event.data))
  const agent = makeAgent('a1', events)
  const channel = createChannel(ctx, agent, { model: 'model-a', cwd: '/tmp/demo', provider: 'fake-provider', activity: false })
  return { compaction, channel, agent, handlers }
}

// ==== 场景 1：手动压缩打开可取消的状态行，且不再只发 4 秒 toast ==============
{
  const { channel, compaction } = assemble()
  check('scene1: idle channel carries no compaction row', channel.compaction === undefined)
  // The row must also WAKE the renderer: a manual compaction runs while the
  // session is idle, so without a bump that carries the open row nothing
  // repaints until it ends. Wait out the constructor's own background
  // refresh first so this window contains exactly the row-open bump.
  await sleep(50) // 固定窗:pacing 桩内等构造期后台刷新落定，不是在等可观测状态
  const bumps = []
  const unsubscribe = channel.subscribe(() => bumps.push({ version: channel.version, row: channel.compaction !== undefined }))
  channel.compact()
  const opened = await settle(() => channel.compaction !== undefined)
  check('scene1: /compact opens the status row', opened)
  check(
    'scene1: opening the row wakes the renderer with it',
    // 首个 bump 必须带行（行开即重绘）；窗口内后续 bump（负载下迟到的后台
    // 刷新）合法，但没有哪个 bump 应当丢行。
    bumps.length >= 1 && bumps[0].row === true && bumps.every(bump => bump.row === true),
    JSON.stringify(bumps),
  )
  unsubscribe()
  const row = channel.compaction
  check(
    'scene1: row is cancellable, prefill, zero output',
    row?.cancellable === true && row?.phase === 'prefill' && row?.outputChars === 0 && typeof row?.startedAt === 'number',
    JSON.stringify(row),
  )
  check('scene1: compactNow reached the service', compaction.calls.length === 1, String(compaction.calls.length))
  check('scene1: no transient "working" toast (the row replaces it)', !toasts(channel).includes(t('compact-working')), toasts(channel))
  channel.releaseContributions()
}

// ==== 场景 2：llm/stream 观测器只认本会话的压缩调用，其余原样透传 ============
{
  const { channel, handlers } = assemble()
  channel.compact()
  await settle(() => channel.compaction !== undefined)
  const listener = handlers.get('llm/stream')
  check('scene2: llm/stream listener is registered', typeof listener === 'function')

  const untouched = (async function* () { yield { type: 'text-delta', text: 'x' } })()
  const titleCall = listener({ purpose: 'session-title', sessionId: 's-a1' }, () => untouched)
  check('scene2: a non-compaction purpose passes the stream through by identity', titleCall === untouched)
  const otherSession = listener({ purpose: 'compaction', sessionId: 's-other' }, () => untouched)
  check('scene2: another session passes the stream through by identity', otherSession === untouched)
  check('scene2: untouched calls leave the row in prefill', channel.compaction?.phase === 'prefill' && channel.compaction?.outputChars === 0)

  const source = [{ type: 'text-delta', text: 'abc' }, { type: 'reasoning-delta', text: 'de' }, { type: 'usage', usage: {} }]
  const stream = listener({ purpose: 'compaction', sessionId: 's-a1' }, () => (async function* () { for (const chunk of source) yield chunk })())
  const seen = []
  for await (const chunk of stream) seen.push(chunk)
  check('scene2: the compaction stream is not consumed (all chunks forwarded)', seen.length === source.length, String(seen.length))
  check(
    'scene2: streamed output flips the phase and counts chars',
    channel.compaction?.phase === 'summary' && channel.compaction?.outputChars === 5,
    JSON.stringify(channel.compaction),
  )
  channel.releaseContributions()
}

// ==== 场景 3：cancelCompact 中止在飞事务，报「已取消」而不是「失败」=========
{
  const { channel, compaction } = assemble()
  channel.compact()
  await settle(() => channel.compaction !== undefined)
  channel.cancelCompact()
  const aborted = await settle(() => compaction.calls[0]?.abortedAt !== undefined)
  check('scene3: cancel reaches the in-flight service call', aborted)
  const cleared = await settle(() => channel.compaction === undefined)
  check('scene3: the row is cleared once the abort settles', cleared)
  const text = toasts(channel)
  check('scene3: the only notice is the cancellation', channel.notifications.length === 1 && text === t('compact-cancelled'), text)
  channel.releaseContributions()
}

// ==== 场景 4：没有在飞事务时取消是 no-op ====================================
{
  const { channel } = assemble('resolve')
  channel.cancelCompact()
  check('scene4: cancel without an in-flight compaction is a no-op', channel.compaction === undefined)
  channel.releaseContributions()
}

// ==== 场景 5：自动压缩由 session 事件驱动，且不降级手动行 ====================
{
  const { channel, agent, handlers } = assemble()
  const onEvent = handlers.get('session/event')
  check('scene5: session/event listener is registered', typeof onEvent === 'function')
  onEvent(agent.session, { seq: 900, time: Date.now(), type: 'compaction/start', data: {} })
  check(
    'scene5: an automatic compaction opens a non-cancellable row',
    channel.compaction !== undefined && channel.compaction.cancellable === false,
    JSON.stringify(channel.compaction),
  )
  onEvent(agent.session, { seq: 901, time: Date.now(), type: 'compaction/end', data: {} })
  check('scene5: compaction/end clears the row', channel.compaction === undefined)
  channel.releaseContributions()

  const second = assemble()
  second.channel.compact()
  await settle(() => second.channel.compaction !== undefined)
  second.handlers.get('session/event')(second.agent.session, { seq: 902, time: Date.now(), type: 'compaction/start', data: {} })
  check(
    'scene5: the host start event does not downgrade a manual row',
    second.channel.compaction?.cancellable === true && second.channel.compaction?.phase === 'prefill',
    JSON.stringify(second.channel.compaction),
  )
  second.channel.cancelCompact()
  await settle(() => second.channel.compaction === undefined)
  second.channel.releaseContributions()

  // Replay is settled history: a process killed between start and end leaves an
  // unmatched start in the log, and a row painted for it would never clear —
  // the resume would look like a compaction that runs forever.
  const killed = assemble('resolve', [{ type: 'compaction/start', data: {} }])
  check(
    'scene5: an unmatched compaction/start in the log opens no row on replay',
    killed.channel.compaction === undefined,
    JSON.stringify(killed.channel.compaction),
  )
  killed.channel.releaseContributions()

  // The matched pair must not paint one either (it opens and clears inside the
  // same replay fold — nothing about it is live).
  const settledPair = assemble('resolve', [
    { type: 'compaction/start', data: {} },
    { type: 'compaction/end', data: {} },
  ])
  check(
    'scene5: a completed compaction pair in the log opens no row on replay',
    settledPair.channel.compaction === undefined,
    JSON.stringify(settledPair.channel.compaction),
  )
  settledPair.channel.releaseContributions()
}

// ==== 场景 6：状态行渲染（标签 / 阶段 / 计时 / Esc 提示 / 窄屏降级）==========
async function mountRow(compaction, cols, activityPreset) {
  const rows = 6
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = cols; this.rows = rows; this.isTTY = true }
    _write(chunk, _encoding, callback) { term.write(String(chunk), callback) }
  }
  const { render, ThemeProvider } = ui
  const app = await render(
    React.createElement(
      ThemeProvider,
      { theme: 'dark' },
      React.createElement(CompactionStatusRow, { compaction, activityPreset }),
    ),
    { stdout: new FakeStdout(), exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => term.buffer.active.getLine(1)?.translateToString(true).includes(t('compact-working')), { timeoutMs: 3000 })
  return { term, app, row: () => term.buffer.active.getLine(1)?.translateToString(true) ?? '' }
}

async function renderRow(compaction, cols, activityPreset) {
  const { term, app } = await mountRow(compaction, cols, activityPreset)
  const lines = []
  for (let y = 0; y < 6; y++) lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  await app.unmount()
  return lines
}

{
  const wide = await renderRow({ startedAt: Date.now() - 26_000, phase: 'prefill', outputChars: 0, cancellable: true }, 100)
  const prefillRow = wide.find(line => line.includes(t('compact-working'))) ?? ''
  check('scene6: the row shows its label', prefillRow.includes(t('compact-working')), prefillRow)
  check('scene6: prefill names the silent phase', prefillRow.includes(t('compact-phase-prefill')), prefillRow)
  check('scene6: prefill shows the elapsed seconds', prefillRow.includes('26s'), prefillRow)
  check('scene6: a cancellable row advertises Esc', prefillRow.includes(t('compact-esc-cancel')), prefillRow)

  const summary = await renderRow({ startedAt: Date.now() - 3_000, phase: 'summary', outputChars: 4_800, cancellable: true }, 100)
  const summaryRow = summary.find(line => line.includes(t('compact-working'))) ?? ''
  check('scene6: summary streams the token count instead of the phase', summaryRow.includes('1.2k tokens'), summaryRow)
  check('scene6: summary drops the prefill wording', !summaryRow.includes(t('compact-phase-prefill')), summaryRow)

  const auto = await renderRow({ startedAt: Date.now() - 3_000, phase: 'summary', outputChars: 800, cancellable: false }, 100)
  const autoRow = auto.find(line => line.includes(t('compact-working'))) ?? ''
  check('scene6: a compaction this process cannot abort hides the Esc hint', !autoRow.includes(t('compact-esc-cancel')), autoRow)

  const narrow = await renderRow({ startedAt: Date.now() - 12_000, phase: 'prefill', outputChars: 0, cancellable: true }, 34)
  const narrowRow = narrow.find(line => line.includes(t('compact-working'))) ?? ''
  check('scene6: a narrow terminal drops the phase before the Esc hint', !narrowRow.includes(t('compact-phase-prefill')) && narrowRow.includes(t('compact-esc-cancel')), narrowRow)
  check('scene6: the narrow row stays on one line', narrow.filter(line => line.trim() !== '').length === 1, JSON.stringify(narrow))

  // The spinner slot's indicator: with the working-activity line on, the row
  // must draw the user's `/activity` preset instead of the classic dot.
  const plainRow = { startedAt: Date.now() - 26_000, phase: 'prefill', outputChars: 0, cancellable: true }
  const preset = await renderRow(plainRow, 100, 'aesthetic')
  const presetRow = preset.find(line => line.includes(t('compact-working'))) ?? ''
  check('scene6: a /activity preset draws the indicator', BAR_FRAMES.some(frame => presetRow.includes(frame)), presetRow)
  // The leading slot, not "somewhere on the line": the dot family's `·` frame
  // is the same character as the field separator, so only the first cell tells
  // the two families apart.
  check('scene6: the preset owns the leading slot', BAR_FRAMES.some(frame => presetRow.startsWith(frame)), presetRow)
  check('scene6: a classic row still leads with the dot glyph', ['·', '•', '●'].includes(prefillRow[0]), prefillRow)

  // The 7-cell bar is charged to the row's budget: the dot needs 34 columns to
  // keep the Esc hint, the bar needs 40 — at 36 they must disagree.
  const tightDot = await renderRow(plainRow, 36)
  const tightDotRow = tightDot.find(line => line.includes(t('compact-working'))) ?? ''
  const tightBar = await renderRow(plainRow, 36, 'aesthetic')
  const tightBarRow = tightBar.find(line => line.includes(t('compact-working'))) ?? ''
  check('scene6: at 36 columns the dot keeps the Esc hint', tightDotRow.includes(t('compact-esc-cancel')), tightDotRow)
  check('scene6: the preset indicator is charged to the row budget', !tightBarRow.includes(t('compact-esc-cancel')), tightBarRow)
  check('scene6: the preset row stays on one line', tightBar.filter(line => line.trim() !== '').length === 1, JSON.stringify(tightBar))

  // Cadence comes from the preset (aesthetic: 140ms/frame), not from a frozen
  // first frame.
  const live = await mountRow(plainRow, 100, 'aesthetic')
  const seen = new Set()
  for (let i = 0; i < 14; i++) {
    const frame = BAR_FRAMES.find(candidate => live.row().includes(candidate))
    if (frame !== undefined) seen.add(frame)
    await sleep(40) // 固定窗:pacing 等下一次重绘以采样动画帧
  }
  await live.app.unmount()
  check('scene6: the indicator advances through the preset frames', seen.size >= 2, [...seen].join(','))
}

// ==== 场景 7：挂真实 Chat —— 行在屏上，Esc 真的打到 cancelCompact ============
function makeChatChannel(overrides = {}) {
  const calls = { compact: 0, cancelCompact: 0 }
  const channel = {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'compaction probe',
    sessionColor: '',
    agentId: 'probe',
    sessionId: 'probe',
    agentBindingGeneration: 0,
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/x',
    displayCwd: 'C:/code/x',
    gitBranch: 'main',
    working: false,
    compaction: undefined,
    cancelPending: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: Date.now(),
    lastUserText: '',
    pending: [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: false,
    activityFrames: [],
    goal: undefined,
    todos: [],
    contextWindow: 1_000_000,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tps: undefined,
    tpsSamples: [],
    reasoningEffort: 'high',
    agentPreset: 'standard',
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode: () => {},
    commandList: [],
    commandCompletions: () => [],
    loadedContext: undefined,
    lastUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    traceEvents: () => [],
    subscribe: () => () => {},
    submit: () => {},
    cancel: () => {},
    cancelCompact: () => { calls.cancelCompact += 1 },
    compact: () => { calls.compact += 1 },
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    stageImage: () => Promise.resolve(''),
    workspaceLabel: undefined,
    ...overrides,
  }
  return { channel, calls }
}

async function mountChat(channel, cols = 100, rows = 30, activityStore) {
  const term = new XTerm({ cols, rows, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = cols; this.rows = rows; this.isTTY = true }
    _write(chunk, _encoding, callback) { term.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    constructor() { super(); this.isTTY = true }
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const screen = () => viewportLines(term, rows).join('\n')
  const instance = await ui.render(
    React.createElement(Chat, {
      channel,
      questionStore: new QuestionStore(),
      onExit: () => {},
      fullscreen: false,
      trajectorySeen: true,
      activityStore,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  // AlternateScreen resolves its instance through `process.stdout`; alias the
  // fake one so the screen behaves as it does on a real terminal.
  for (const value of instances.values()) instances.set(process.stdout, value)
  return { term, stdin, screen, instance }
}

{
  const { channel, calls } = makeChatChannel({
    compaction: { startedAt: Date.now() - 26_000, phase: 'prefill', outputChars: 0, cancellable: true },
  })
  const chat = await mountChat(channel)
  const shown = await settled(() => chat.screen().includes(t('compact-working')), { timeoutMs: 4000 })
  check('scene7: Chat renders the compaction row above the prompt', shown, chat.screen().trim().split('\n').slice(-3).join(' | '))
  check('scene7: the row offers Esc while it can be aborted', chat.screen().includes(t('compact-esc-cancel')), chat.screen().trim())
  // 固定窗:pacing Chat 的按键处理器在首帧之后才挂上——立刻写键会落空。
  await sleep(120)
  chat.stdin.write('\x1b')
  const cancelled = await settled(() => calls.cancelCompact === 1, { timeoutMs: 2000 })
  check('scene7: Esc reaches cancelCompact exactly once', cancelled, String(calls.cancelCompact))
  await chat.instance.unmount()

  // The row borrows the spinner slot's indicator: the working-activity line
  // owns that slot with `activityEnabled`, so the row must draw the preset the
  // turn would draw — the wiring lives in Chat, not in the component.
  const preset = makeChatChannel({
    activityEnabled: true,
    activityFrames: 'aesthetic',
    compaction: { startedAt: Date.now() - 26_000, phase: 'prefill', outputChars: 0, cancellable: true },
  })
  const presetChat = await mountChat(preset.channel)
  const presetLine = () => presetChat.screen().split('\n').find(line => line.includes(t('compact-working'))) ?? ''
  const presetShown = await settled(
    () => BAR_FRAMES.some(frame => presetLine().includes(frame)),
    { timeoutMs: 4000 },
  )
  check('scene7: Chat draws the /activity preset in the compaction row', presetShown, presetLine())
  check('scene7: the preset owns the leading slot', BAR_FRAMES.some(frame => presetLine().startsWith(frame)), presetLine())
  check('scene7: the preset row keeps the Esc hint', presetChat.screen().includes(t('compact-esc-cancel')), presetChat.screen().trim())
  await presetChat.instance.unmount()

  const automatic = makeChatChannel({
    compaction: { startedAt: Date.now() - 3_000, phase: 'summary', outputChars: 800, cancellable: false },
  })
  const autoChat = await mountChat(automatic.channel)
  await settled(() => autoChat.screen().includes(t('compact-working')), { timeoutMs: 4000 })
  await sleep(120) // 固定窗:pacing 同上——等按键处理器挂载
  autoChat.stdin.write('\x1b')
  // 固定窗:探针 负向断言观察窗：Esc 若迟到打进取消，落定瞬间检查会漏掉。
  await sleep(150)
  check('scene7: Esc leaves a compaction this process cannot abort alone', automatic.calls.cancelCompact === 0, String(automatic.calls.cancelCompact))
  await autoChat.instance.unmount()

  // A running turn keeps the working spinner and rides the compaction as a
  // badge instead of a second row.
  const duringTurn = makeChatChannel({
    working: true,
    compaction: { startedAt: Date.now() - 3_000, phase: 'summary', outputChars: 800, cancellable: true },
  })
  const turnChat = await mountChat(duringTurn.channel)
  const badged = await settled(() => turnChat.screen().includes(t('compact-badge')), { timeoutMs: 4000 })
  check('scene7: an automatic compaction badges the working spinner', badged, turnChat.screen().trim().split('\n').slice(-3).join(' | '))
  // 行级判定：随机提示行可能含「Esc 取消」字样（如「拖选即复制；Esc 取消
  // 选区」），裸子串会与之假撞——独立的压缩行是**同一行**同时带进行标签与
  // Esc 提示；提示行没有进行标签。徽章行只有徽章没有 Esc。
  check('scene7: no separate row while a turn runs', !turnChat.screen().split('\n').some(line => line.includes(t('compact-working')) && line.includes(t('compact-esc-cancel'))), turnChat.screen().trim())
  await turnChat.instance.unmount()
  check('scene7: Esc during a turn interrupts the turn, not the compaction', duringTurn.calls.cancelCompact === 0, String(duringTurn.calls.cancelCompact))

  // ...and the badge has to ride the working-ACTIVITY line too: with real
  // activity data that line IS the spinner slot, so a badge passed only to the
  // classic spinner would leave an automatic compaction invisible.
  const activityStore = new ActivityStore()
  activityStore.update('probe', {
    phase: 'thinking',
    line: '正在思考…',
    live: true,
    toolCount: 0,
    phaseStartedAt: Date.now() - 5_000,
    turnStartedAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    lang: 'zh',
  })
  const lineTurn = makeChatChannel({
    working: true,
    activityEnabled: true,
    activityFrames: 'aesthetic',
    compaction: { startedAt: Date.now() - 3_000, phase: 'summary', outputChars: 800, cancellable: true },
  })
  const lineChat = await mountChat(lineTurn.channel, 100, 30, activityStore)
  const activityLineRow = () => lineChat.screen().split('\n').find(line => line.includes('正在思考…')) ?? ''
  const lineBadged = await settled(() => activityLineRow().includes(t('compact-badge')), { timeoutMs: 4000 })
  check('scene7: an automatic compaction badges the working-activity line', lineBadged, activityLineRow())
  check(
    'scene7: the badge rides that line as a suffix, not as a second row',
    activityLineRow().includes(t('compact-badge')) && !lineChat.screen().includes(t('compact-esc-cancel')),
    activityLineRow(),
  )
  await lineChat.instance.unmount()
}

console.log(failed === 0 ? '\nOK: compaction progress row' : `\n${failed} FAILED`)
process.exit(failed)
