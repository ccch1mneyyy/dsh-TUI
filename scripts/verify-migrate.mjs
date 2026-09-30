/**
 * verify-migrate — 跨代理会话迁移回归（fixture 驱动，不依赖本机数据）。
 *
 * 第一版 PR 的教训：只验「头行合法」是假绿。本回归全程跑真实读取链——
 * 覆盖 src/dsh-adapter/migrate/：
 *   1. sessionize：官方 Session.append 生成的事件骨架（turn 配对 = 下一个
 *      user 关闭上一轮 + 收尾关闭最后一轮，与 live loop 同序，首步空
 *      system head）、reasoning 块保留、header cwd/version、CJK 与 emoji
 *      原样进入事件；工具调用与步内输入（4c'，含落盘读回的 wire 合法性）、
 *      中断轮与显式标题（4c'5–8）、原生压缩检查点（4c''）；
 *   2. 端到端往返（维护者要求的验收链）：fixture 会话 → importSessions
 *      （官方 JsonlSessionPersistence 落盘）→ open(id,'read') 读回 →
 *      Session.fromRestore + deriveMessages：角色/顺序/文本逐一断言；
 *   3. 续聊：restore 后的会话作为 seed 继续追加新一轮 → 写回 → 再读回，
 *      新旧消息同在（导入的会话是活的，不是只能看）；按 live loop 的写法
 *      替换 head 后系统提示词位于第 0 位（3b）；
 *   4. 幂等：同批 fixture 二次导入全部 existing，列表数不变；
 *   5. migrationUuid：确定性（同输入同 id）与区分性（不同 agent 不同 id）；
 *   6. adapter 解析冒烟：五家的最小 fixture 行（含 model 提取、null 防御、
 *      sourceId 必须是裸文件名——幂等键不随源目录移动）；
 *   7. /migrate 命令分类矩阵（pure）：fresh 会话的直接入口、--dry-run 与
 *      多参数语义必须与 CLI 一致。
 * 逐源解析规则见 scripts/verify-migrate-parse.mjs；运行面的交互回归见
 * scripts/verify-migrate-command.tsx（挂真实 Chat）。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
const { importSessions, migrationSessionId } = await import('../src/dsh-adapter/migrate/index.js')
const { sessionize } = await import('../src/dsh-adapter/migrate/sessionize.js')
const { migrationUuid } = await import('../src/dsh-adapter/migrate/uuid.js')
const { fromRoleTurns, emptyStats } = await import('../src/dsh-adapter/migrate/parse/role-turns.js')
const { claudeCodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/claude-code.js')
const { codexAdapter } = await import('../src/dsh-adapter/migrate/adapters/codex.js')
const { ompAdapter } = await import('../src/dsh-adapter/migrate/adapters/omp.js')
const { zcodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/zcode.js')
const { grokBuildAdapter } = await import('../src/dsh-adapter/migrate/adapters/grok-build.js')

let checks = 0
function check(name, ok, extra = '') {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

/** Fixture：CJK + emoji + reasoning 的多形状会话（按角色列表书写，经 fromRoleTurns 折成轮）。 */
function fixtureSessions() {
  return roleFixtures().map(session => ({
    ...session,
    titleExplicit: false,
    turns: fromRoleTurns(session.turns),
    stats: emptyStats(),
  }))
}

function roleFixtures() {
  return [
    {
      sourceId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/广州/项目一',
      startedAt: 1790000000000,
      title: '常规两轮',
      turns: [
        { role: 'user', text: '你好，世界——第一轮 🎏', time: 1790000000000 },
        { role: 'assistant', text: '第一轮答复：没问题 ✓', reasoning: '推理：先分析需求', model: 'gpt-5', time: 1790000001000 },
        { role: 'user', text: '第二轮问题', time: 1790000010000 },
        { role: 'assistant', text: '第二轮答复', model: 'gpt-5', time: 1790000011000 },
      ],
    },
    {
      sourceId: '22222222-2222-4222-8222-222222222222',
      cwd: '/home/u/project-b',
      startedAt: 1790000100000,
      turns: [
        // 维护者评审 fixture B：一 user 三 assistant
        { role: 'user', text: '一条提问', time: 1790000100000 },
        { role: 'assistant', text: '答1', time: 1790000100100 },
        { role: 'assistant', text: '答2', time: 1790000100200 },
        { role: 'assistant', text: '答3', time: 1790000100300 },
        // 维护者评审 fixture D：结尾是 user（无回复）
        { role: 'user', text: '没被回答的尾问', time: 1790000200000 },
      ],
    },
    {
      sourceId: '33333333-3333-4333-8333-333333333333',
      cwd: '/home/u/project-b',
      startedAt: 1790000300000,
      turns: [
        // 孤立 assistant 开头（源丢了首 user）
        { role: 'assistant', text: '孤立开场白', time: 1790000300000 },
      ],
    },
  ]
}

const fakeAdapter = { id: 'fixture', label: 'Fixture', roots: () => [], discover: () => ({ roots: [], sessions: [] }) }

// ── 1. sessionize 事件骨架 ───────────────────────────────────────────────
{
  const [first] = fixtureSessions()
  const id = SessionId(migrationUuid(`fixture:${first.sourceId}`))
  const { header, events } = sessionize(id, 'fixture', first)
  const types = events.map(event => event.type)
  check('1a. header 携带 cwd 与当前格式版本', header.cwd === first.cwd && header.version === SESSION_FORMAT_VERSION, `v${header.version}`)
  check('1b. turn 配对：2 轮 = 2×start + 2×end',
    types.filter(t => t === 'turn/start').length === 2 && types.filter(t => t === 'turn/end').length === 2)
  // 与 live loop 同序：提问是首步的 user 消息；首步先写空 system head（surface 第 0 节点）
  check('1c. 一 user 一 assistant 的常规轮（首步带空 system head）',
    types.join(' ') === 'turn/start step/start system/message user/message assistant/message step/end turn/end turn/start step/start user/message assistant/message step/end turn/end',
    types.join(','))
  const head = events.find(event => event.type === 'system/message')
  check('1c2. head 为空内容的 system-prompt 消息且只写一次',
    head?.data?.message?.content?.length === 0 && head?.data?.message?.source?.kind === 'system-prompt'
    && types.filter(t => t === 'system/message').length === 1)
  const assistant = events.find(event => event.type === 'assistant/message')
  const blocks = assistant?.data?.message?.content ?? []
  check('1d. reasoning 块先于正文块',
    blocks[0]?.type === 'reasoning' && blocks[0]?.text === '推理：先分析需求' && blocks[1]?.text === '第一轮答复：没问题 ✓')
  check('1e. 溯源与模型进入 provenance',
    assistant?.data?.message?.source?.provider === 'migrated:fixture' && assistant?.data?.message?.source?.model === 'gpt-5')
  check('1f. CJK/emoji 原样进入事件', JSON.stringify(events).includes('你好，世界——第一轮 🎏'))
}

// ── 2. 端到端往返（官方持久化 + 官方读取链）────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'verify-migrate-'))
{
  const sessions = fixtureSessions()
  const run = await importSessions(fakeAdapter, root, sessions)
  check('2a. 三条会话全部导入', run.imported === 3 && run.failed === 0, JSON.stringify(run))

  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  const readFiber = ctx.plugin(JsonlSessionPersistence, { root })
  for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const persistence = ctx.get('sessionPersistence')
  assert.ok(persistence !== undefined, 'persistence service became ready')
  const listed = await persistence.list()
  check('2b. 官方 list 可见全部三条', listed.length === 3)

  const first = sessions[0]
  const id = migrationSessionId(fakeAdapter, first)
  const handle = await persistence.open(id, 'read')
  const { events, eventState } = await handle.read()
  const restored = Session.fromRestore(id, events, handle.header, SessionLogOffset(0), eventState)
  const messages = restored.deriveMessages()
  const flat = messages.map(message =>
    `[${message.role}] ${message.content.map(block => block.text ?? '').join(' / ')}`).join(' | ')
  check('2c. deriveMessages 角色与顺序', messages.map(m => m.role).join(',') === 'user,assistant,user,assistant')
  check('2d. CJK/emoji/思考全量无损',
    flat.includes('你好，世界——第一轮 🎏') && flat.includes('第一轮答复：没问题 ✓') && flat.includes('推理：先分析需求'),
    flat.slice(0, 80))
  await handle.close()

  // ── 3. 续聊：restore 作 seed 追加新一轮，写回再读 ──────────────────
  const turnCount = events.filter(event => event.type === 'turn/end').length
  const continued = Session.create(id, events, handle.header)
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  continued.append('turn/start', { turn: turnCount + 1 })
  continued.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '续聊：迁移之后继续提问' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  continued.append('turn/end', { turn: turnCount + 1, reason: { kind: 'completed' } })
  const grown = continued.snapshotEvents()
  const write = await persistence.open(id, 'write')
  await write.append(grown.slice(events.length))
  await write.flush()
  await write.close()
  const reHandle = await persistence.open(id, 'read')
  const reRead = await reHandle.read()
  const reRestored = Session.fromRestore(id, reRead.events, reHandle.header, SessionLogOffset(0), reRead.eventState)
  const reFlat = reRestored.deriveMessages().map(m => m.content.map(b => b.text ?? '').join('')).join('|')
  check('3a. 续聊后新旧消息同在', reFlat.includes('你好，世界——第一轮 🎏') && reFlat.includes('续聊：迁移之后继续提问'))
  await reHandle.close()

  // 3b. 续聊首步 live loop 会把渲染后的系统提示词「替换」进 head（surface 第 0 节点）。
  // 照它的写法替换一次：系统提示词必须落在第 0 位，而不是接在导入历史之后——
  // 否则 pi-ai 这类只提取「首条 system」的适配器会把它当成一条 user 消息发出。
  {
    const { createSystemMessage } = await import('@deepseek-ai/dsh-llm')
    const resumed = Session.create(id, reRead.events, reHandle.header)
    const headSeq = reRead.events.find(event => event.type === 'system/message')?.seq
    const nextTurn = reRead.events.filter(event => event.type === 'turn/end').length + 1
    resumed.append('turn/start', { turn: nextTurn })
    resumed.append('step/start', { turn: nextTurn, step: 1 })
    resumed.append('system/message', { turn: nextTurn, step: 1, message: createSystemMessage('SYSTEM PROMPT') },
      { surfaceOp: { op: 'replace', startSeq: headSeq, endSeq: headSeq }, sourceEventSeqs: [headSeq] })
    const roles = resumed.deriveMessages().map(m => m.role)
    check('3b. 续聊时系统提示词替换进 head、位于第 0 位',
      headSeq !== undefined && roles[0] === 'system' && roles.filter(r => r === 'system').length === 1 && roles[1] === 'user',
      roles.join(','))
  }
  await Promise.resolve(readFiber.dispose()).catch(() => {})
}

// ── 4. 幂等：同批再导入全部 existing，官方列表数不变 ────────────────────
{
  const run2 = await importSessions(fakeAdapter, root, fixtureSessions())
  check('4a. 二次导入零新增零失败', run2.imported === 0 && run2.existing === 3 && run2.failed === 0, JSON.stringify(run2))
  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  const fiber = ctx.plugin(JsonlSessionPersistence, { root })
  for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const relisted = await ctx.get('sessionPersistence').list()
  check('4b. 二次导入后官方列表仍为三条', relisted.length === 3)
  await Promise.resolve(fiber.dispose()).catch(() => {})
}

// ── 4c. 维护者点名的非常规形状：事件骨架全序断言（deep-review M4）──────
{
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const sessions = fixtureSessions()
  // 夹具 2：一 user 三 assistant + 尾部无回复 user —— turn 配对必须是
  // 「下一个 user 关闭上一轮 + 收尾关闭最后一轮」，三个 assistant 各占一步
  {
    const id = SessionId(migrationUuid(`fixture:${sessions[1].sourceId}`))
    const { events } = sessionize(id, 'fixture', sessions[1])
    const types = events.map(e => e.type).join(' ')
    const expected = 'turn/start step/start system/message user/message assistant/message step/end step/start assistant/message step/end step/start assistant/message step/end turn/end turn/start user/message turn/end'
    check('4c1. 一 user 三 assistant + 尾 user 的事件全序', types === expected, types)
  }
  // 夹具 3：孤立 assistant 开头（无 user 的首轮，一个 step 无 user/message）
  {
    const id = SessionId(migrationUuid(`fixture:${sessions[2].sourceId}`))
    const { events } = sessionize(id, 'fixture', sessions[2])
    const types = events.map(e => e.type).join(' ')
    check('4c2. 孤立 assistant 开头的事件全序',
      types === 'turn/start step/start system/message assistant/message step/end turn/end', types)
  }
  // 只有一条无回复提问的会话：head 需要打开的步，首轮补一个只装 head 与提问的步
  {
    const lone = { ...sessions[1], turns: fromRoleTurns([{ role: 'user', text: '只有提问', time: 0 }]) }
    const id = SessionId(migrationUuid('fixture:lone'))
    const types = sessionize(id, 'fixture', lone).events.map(e => e.type).join(' ')
    check('4c2b. 无步首轮：head 与提问装在同一步',
      types === 'turn/start step/start system/message user/message step/end turn/end', types)
  }
  // 夹具 2 端到端：restore 后 5 条消息且末位是 user（尾问保留）
  {
    const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
    const { Context } = await import('@deepseek-ai/cordis')
    const { SessionLogOffset: SLO, Session } = await import('@deepseek-ai/dsh-session')
    const root2 = mkdtempSync(join(tmpdir(), 'verify-migrate-shapes-'))
    const only = [{ ...sessions[1] }]
    await importSessions(fakeAdapter, root2, only)
    const ctx2 = new Context()
    const fiber2 = ctx2.plugin(JsonlSessionPersistence, { root: root2 })
    for (let i = 0; i < 100 && ctx2.get('sessionPersistence') === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(ctx2.get('sessionPersistence') !== undefined, 'persistence ready (shapes)')
    const id = migrationSessionId(fakeAdapter, sessions[1])
    const h = await ctx2.get('sessionPersistence').open(id, 'read')
    const r = await h.read()
    await h.close()
    const restored = Session.fromRestore(id, r.events, h.header, SLO(0), r.eventState)
    const msgs = restored.deriveMessages()
    check('4c3. 夹具 2 restore 得 5 条消息且末位 user',
      msgs.length === 5 && msgs[4].role === 'user', msgs.map(m => m.role).join(','))
    await Promise.resolve(fiber2.dispose()).catch(() => {})
    rmSync(root2, { recursive: true, force: true })
  }
}

// ── 4c'. 工具调用与步内输入：事件顺序 + 落盘读回后的 wire 合法性 ─────────
{
  const { newStep } = await import('../src/dsh-adapter/migrate/parse/tools.js')
  const step1 = newStep('model-a')
  step1.blocks.push({ type: 'reasoning', text: '先看两个文件' }, { type: 'text', text: '我读一下' },
    { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"path":"a.ts"}' },
    { type: 'tool-call', id: 'call_b', name: 'read', arguments: '{"path":"b.ts"}' })
  step1.results.push({ callId: 'call_a', text: 'A 内容', isError: false }, { callId: 'call_b', text: '', isError: true })
  const step2 = newStep('model-a')
  step2.inputs.push('[Image: 截图说明]')
  step2.blocks.push({ type: 'text', text: '看完了' })
  const toolSession = {
    sourceId: '55555555-5555-4555-8555-555555555555', cwd: '/tmp/tools', startedAt: 1790000400000,
    titleExplicit: false, stats: emptyStats(),
    turns: [{ prompt: '读 a 和 b', steps: [step1, step2] }],
  }
  const id = migrationSessionId(fakeAdapter, toolSession)
  const { events } = sessionize(id, 'fixture', toolSession)
  const types = events.map(e => e.type).join(' ')
  check("4c'1. 步内顺序：assistant → tool/call×n → tool/result×n；步内输入在 assistant 之前",
    types === 'turn/start step/start system/message user/message assistant/message tool/call tool/call tool/result tool/result step/end'
      + ' step/start user/message assistant/message step/end turn/end', types)
  const calls = events.filter(e => e.type === 'tool/call')
  const results = events.filter(e => e.type === 'tool/result')
  check("4c'2. tool/result 引用各自 tool/call 的 seq，错误标记保留",
    results.length === 2 && results[0].sourceEventSeqs?.[0] === calls[0].seq && results[1].sourceEventSeqs?.[0] === calls[1].seq
    && results[1].data.message.isError === true && results[1].data.message.content.length === 0)
  const assistant = events.find(e => e.type === 'assistant/message')
  check("4c'3. assistant 内容携带 tool-call 块（wire 的 tool_calls 由它派生）",
    assistant.data.message.content.filter(b => b.type === 'tool-call').map(b => b.id).join(',') === 'call_a,call_b')

  const abortedSession = { ...toolSession, turns: [{ prompt: '做到一半', steps: [], aborted: true }, { prompt: '接着', steps: [] }] }
  const ends = sessionize(id, 'fixture', abortedSession).events.filter(e => e.type === 'turn/end').map(e => e.data.reason)
  check("4c'5. 源标记中断的轮以 aborted(legacy) 收尾，其余 completed",
    ends[0]?.kind === 'aborted' && ends[0]?.reason?.kind === 'legacy' && ends[1]?.kind === 'completed', JSON.stringify(ends))

  const titled = { ...toolSession, sourceId: 'titled', title: '  源自带的\n标题  ', titleExplicit: true }
  const titledEvents = sessionize(SessionId(migrationUuid('fixture:titled')), 'fixture', titled).events
  const last = titledEvents.at(-1)
  check("4c'6. 显式标题归一后作为末尾 session/title 写入",
    last?.type === 'session/title' && last.data.title === '源自带的 标题' && last.data.source?.kind === 'user', JSON.stringify(last?.data))
  check("4c'7. 首问兜底的标题不写 session/title（留给 DSH 自己回退）",
    !sessionize(id, 'fixture', { ...toolSession, title: '兜底', titleExplicit: false }).events.some(e => e.type === 'session/title'))

  const rootTools = mkdtempSync(join(tmpdir(), 'verify-migrate-tools-'))
  const run = await importSessions(fakeAdapter, rootTools, [toolSession, titled])
  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { Context } = await import('@deepseek-ai/cordis')
  const ctxT = new Context()
  const fiberT = ctxT.plugin(JsonlSessionPersistence, { root: rootTools })
  for (let i = 0; i < 100 && ctxT.get('sessionPersistence') === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const h = await ctxT.get('sessionPersistence').open(id, 'read')
  const r = await h.read()
  await h.close()
  const msgs = Session.fromRestore(id, r.events, h.header, SessionLogOffset(0), r.eventState).deriveMessages()
  // wire 规则：带 tool_calls 的 assistant 之后，紧跟的消息恰好是覆盖全部 call id 的 tool 消息
  let legal = true
  for (let i = 0; i < msgs.length; i++) {
    const ids = msgs[i].role === 'assistant' ? msgs[i].content.filter(b => b.type === 'tool-call').map(b => b.id) : []
    if (ids.length === 0) continue
    const answered = msgs.slice(i + 1, i + 1 + ids.length)
    if (answered.length !== ids.length || answered.some((m, k) => m.role !== 'tool' || m.toolCallId !== ids[k])) legal = false
  }
  const th = await ctxT.get('sessionPersistence').open(migrationSessionId(fakeAdapter, titled), 'read')
  const titleRead = (await th.read()).events.filter(e => e.type === 'session/title').map(e => e.data.title)
  await th.close()
  check("4c'8. 带标题的会话经官方读取链可读回标题", titleRead.join('|') === '源自带的 标题', titleRead.join('|'))
  check("4c'4. 落盘读回后 wire 合法（每个 tool_call 紧跟其 tool 消息）",
    run.imported === 2 && legal && msgs.map(m => m.role).join(',') === 'user,assistant,tool,tool,user,assistant',
    msgs.map(m => m.role).join(','))
  await Promise.resolve(fiberT.dispose()).catch(() => {})
  rmSync(rootTools, { recursive: true, force: true })
}

// ── 4c''. 压缩检查点：原生压缩事务 + 读回后模型只见「检查点 + 之后」─────────
{
  const { newStep } = await import('../src/dsh-adapter/migrate/parse/tools.js')
  const answer = (text, calls = []) => {
    const step = newStep()
    step.blocks.push({ type: 'text', text }, ...calls.map(id => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })))
    for (const id of calls) step.results.push({ callId: id, text: `${id} 输出`, isError: false })
    return step
  }
  const compacted = {
    sourceId: '66666666-6666-4666-8666-666666666666', cwd: '/tmp/compact', startedAt: 1790000500000,
    titleExplicit: false, stats: emptyStats(),
    turns: [
      { prompt: '压缩前的提问', steps: [answer('压缩前的回答', ['c1'])] },
      { prompt: '压缩后的提问', compaction: { summary: '第一次压缩摘要', model: 'src-model' }, steps: [answer('压缩后的回答')] },
      { prompt: '', compaction: { summary: '第二次压缩摘要' }, steps: [answer('续跑的回答')] },
      // 会话正好停在压缩点：只有边界、没有提问与回复，不单独成轮
      { prompt: '', compaction: { summary: '尾部压缩摘要' }, steps: [] },
    ],
  }
  const id = migrationSessionId(fakeAdapter, compacted)
  const { events } = sessionize(id, 'fixture', compacted)
  const types = events.map(e => e.type)
  const starts = types.filter(t => t === 'compaction/start').length
  check("4c''1. 每个边界一次原生压缩事务（start→summary→检查点→end，位于 turn/start 之前）",
    starts === 3 && types.join(' ').includes('turn/end compaction/start compaction/summary user/message compaction/end turn/start'),
    types.join(' '))
  const ckpts = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'compact-checkpoint')
  const summaries = events.filter(e => e.type === 'compaction/summary')
  const head = events.find(e => e.type === 'system/message')
  const first = ckpts[0]
  check("4c''2. 检查点 replace 覆盖 head 之后的全部节点，sourceEventSeqs = shadowedSeqs",
    first !== undefined && typeof first.surfaceOp === 'object' && first.surfaceOp.startSeq > head.seq
    && JSON.stringify(first.sourceEventSeqs) === JSON.stringify(summaries[0].data.shadowedSeqs)
    && first.surfaceOp.startSeq === summaries[0].data.shadowedRange.start && first.surfaceOp.endSeq === summaries[0].data.shadowedRange.end
    && first.data.source.compactionId === summaries[0].data.compactionId && summaries[0].data.model === 'src-model')
  check("4c''3. 第二次压缩遮蔽上一个检查点及其后的节点",
    summaries[1]?.data.shadowedSeqs[0] === ckpts[0].seq)
  check("4c''4. 停在压缩点的尾部边界不产生空轮",
    types.filter(t => t === 'turn/start').length === 3)

  const rootC = mkdtempSync(join(tmpdir(), 'verify-migrate-compact-'))
  const run = await importSessions(fakeAdapter, rootC, [compacted])
  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { Context } = await import('@deepseek-ai/cordis')
  const ctxC = new Context()
  const fiberC = ctxC.plugin(JsonlSessionPersistence, { root: rootC })
  for (let i = 0; i < 100 && ctxC.get('sessionPersistence') === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const h = await ctxC.get('sessionPersistence').open(id, 'read')
  const r = await h.read()
  await h.close()
  const texts = Session.fromRestore(id, r.events, h.header, SessionLogOffset(0), r.eventState).deriveMessages()
    .map(m => `${m.role}:${m.content.map(b => b.text ?? '').join('')}`)
  const { CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG, SUMMARY_CLOSE_TAG } = await import('../src/dsh-adapter/migrate/sessionize.js')
  check("4c''5. 落盘读回：模型只见最后一个检查点 + 其后的对话，原始事件仍在日志里",
    run.imported === 1 && texts.join('|') === `user:${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}尾部压缩摘要${SUMMARY_CLOSE_TAG}`
    && r.events.some(e => e.type === 'user/message' && e.data.content?.[0]?.text === '压缩前的提问'),
    texts.join('|'))
  await Promise.resolve(fiberC.dispose()).catch(() => {})
  rmSync(rootC, { recursive: true, force: true })

  // 边界之前没有可折叠的节点：摘要作为首轮开头的一条 user 消息，不发事务
  const early = { ...compacted, turns: [{ prompt: '第一问', compaction: { summary: '无处可折的摘要' }, steps: [answer('答')] }] }
  const earlyEvents = sessionize(id, 'fixture', early).events
  const users = earlyEvents.filter(e => e.type === 'user/message').map(e => e.data.content[0].text)
  check("4c''6. 无可遮蔽节点时不发事务，摘要落为首条 user 消息",
    !earlyEvents.some(e => e.type === 'compaction/start') && users.join('|') === '无处可折的摘要|第一问', users.join('|'))

  // 与真实 /compact 的对照：检查点的包装（前言 + <compacted-summary> 标签）
  // 必须与已安装的压缩引擎逐字一致——后续自动压缩靠这对标签认出前代检查点，
  // 包装漂移会让它把摘要当普通内容再摘要。常量取自引擎自己的源码，引擎一变
  // 这里就失败，而不是让测试替分歧形状背书。
  const engineSource = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-compaction-basic')), 'utf8')
  const constant = name => new RegExp(`\\b${name}\\s*=\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(engineSource)?.[2]
  const checkpoint = ckpts[0].data.content
  check("4c''7. 检查点包装与已安装的压缩引擎一致（前言、开闭标签、三段结构，摘要事件仍存裸摘要）",
    constant('CHECKPOINT_PREAMBLE') === CHECKPOINT_PREAMBLE
    && constant('SUMMARY_OPEN_TAG') === SUMMARY_OPEN_TAG && constant('SUMMARY_CLOSE_TAG') === SUMMARY_CLOSE_TAG
    && engineSource.includes('${CHECKPOINT_PREAMBLE}\\n\\n${SUMMARY_OPEN_TAG}')
    && checkpoint.length === 3 && checkpoint[0].text === `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}`
    && checkpoint[1].text === '第一次压缩摘要' && checkpoint[2].text === SUMMARY_CLOSE_TAG
    && summaries[0].data.summary[0].text === '第一次压缩摘要',
    `preamble=${constant('CHECKPOINT_PREAMBLE') === CHECKPOINT_PREAMBLE} open=${constant('SUMMARY_OPEN_TAG')} close=${constant('SUMMARY_CLOSE_TAG')}`)
}

// ── 4d. 单会话失败不中断批次（deep-review M6：容错路径必须被触发）────────
{
  const good1 = fixtureSessions()[0]
  const good2 = fixtureSessions()[2]
  const poisoned = {
    ...fixtureSessions()[1],
    // createdAt: NaN 让 Session.create 拒绝（header 非 JSON 无损可序列化）
    startedAt: Number.NaN,
  }
  const run = await importSessions(fakeAdapter, mkdtempSync(join(tmpdir(), 'verify-migrate-batch-')), [good1, poisoned, good2])
  check('4d. 坏会话失败 1、前后好会话各导入 1（批次不中断）',
    run.imported === 2 && run.failed === 1
    && run.failures.length === 1 && run.failures[0].includes(poisoned.sourceId),
    JSON.stringify({ imported: run.imported, failed: run.failed }))
}

// ── 4e. cliMigrate 集成：七个分支的可执行面（deep-review M5）────────────
{
  const { cliMigrate } = await import('../src/dsh-adapter/migrate/cli.js')
  const home = mkdtempSync(join(tmpdir(), 'verify-migrate-cli-'))
  const dshHome = join(home, 'dsh')
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  const prevDsh = process.env.DSH_HOME
  const prevGrok = process.env.GROK_HOME
  const prevStdoutWrite = process.stdout.write.bind(process.stdout)
  const sink = []
  process.stdout.write = (chunk) => { sink.push(String(chunk)); return true }
  // HOME + USERPROFILE: the adapters read os.homedir(), which is HOME on POSIX
  // and USERPROFILE on Windows — setting only HOME made this section scan the
  // real home there instead of the fixture. GROK_HOME overrides the grok-build
  // roots on top of homedir(), so it is pinned to the fixture's own `.grok`
  // path: a dev machine that sets it must not leak its real store into the run.
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.GROK_HOME = join(home, '.grok')
  process.env.DSH_HOME = dshHome
  // This section swaps process.stdout.write to measure the CLI's own output,
  // and check() logs through console.log — straight into the sink. Report
  // through stderr instead: a failing 4e case must leave evidence in the log
  // (stderr is not captured here), otherwise the run ends with a bare
  // "FAILED" and no line saying which case broke.
  const checkCli = (name, ok, extra = '') => {
    checks += 1
    if (!ok) process.exitCode = 1
    process.stderr.write(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}\n`)
  }
  try {
    const usage = await cliMigrate(['a', 'b'])
    checkCli('4e1. 多参数 → 退出码 2', usage === 2)
    const bogus = await cliMigrate(['not-an-agent'])
    checkCli('4e2. 未知 agent → 退出码 2', bogus === 2)
    const bare = await cliMigrate([])
    checkCli('4e3. 裸列表 → 退出码 0（HOME 指空目录，各源 0 会话）', bare === 0)
    // dry-run 契约：绝不写盘（目标根不存在）
    const dry = await cliMigrate(['fixture-agent' in {} ? 'x' : 'claude-code', '--dry-run'])
    const dryTargetExists = existsSync(dshHome)
    checkCli('4e4. dry-run → 退出码 0 且未写目标根', dry === 0 && !dryTargetExists,
      `exit=${dry} targetExists=${dryTargetExists}`)
    // 4e5 只算本次调用产生的 stdout：check() 自己走 console.log 写同一个
    // 被替换的 write，之前用 sink.length > 0 断言等于恒真（假通过）。
    const beforeCli = sink.length
    await cliMigrate(['claude-code', '--dry-run'])
    checkCli('4e5. cliMigrate 自身写出 stdout', sink.length > beforeCli,
      `${beforeCli} → ${sink.length}`)
    // 裸 --dry-run 与 TUI 同语义：预览必须先指明源，不能静默退化成列表。
    const bareDry = await cliMigrate(['--dry-run'])
    checkCli('4e6. 裸 --dry-run → 退出码 2（与 TUI 的“请指明源”一致）', bareDry === 2)
  } finally {
    process.stdout.write = prevStdoutWrite
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    if (prevGrok === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prevGrok
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    rmSync(home, { recursive: true, force: true })
  }
}

// ── 4e'. 导入目标根与持久化后端同一解析顺序 ─────────────────────────────
// cordis.patch.yml 的后端根是 DSH_TUI_SESSION_ROOT ?? $DSH_HOME/sessions ??
// ~/.dsh/sessions；CLI 若不认第一项，设了它的机器上两个入口分库，同一条会话
// 落两份、互相看不见。
{
  const { defaultSessionRoot } = await import('../src/dsh-adapter/migrate/index.js')
  const saved = { root: process.env.DSH_TUI_SESSION_ROOT, dsh: process.env.DSH_HOME }
  try {
    process.env.DSH_TUI_SESSION_ROOT = join(tmpdir(), 'explicit-root')
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home')
    const explicit = defaultSessionRoot()
    process.env.DSH_TUI_SESSION_ROOT = '   '
    const blankFallsThrough = defaultSessionRoot()
    delete process.env.DSH_TUI_SESSION_ROOT
    const fromDshHome = defaultSessionRoot()
    check('4e7. DSH_TUI_SESSION_ROOT 优先于 DSH_HOME',
      explicit === join(tmpdir(), 'explicit-root'), explicit)
    check('4e8. 空白的 DSH_TUI_SESSION_ROOT 视为未设，回落 $DSH_HOME/sessions',
      blankFallsThrough === join(tmpdir(), 'dsh-home', 'sessions') && fromDshHome === blankFallsThrough, `${blankFallsThrough} / ${fromDshHome}`)
  } finally {
    if (saved.root === undefined) delete process.env.DSH_TUI_SESSION_ROOT
    else process.env.DSH_TUI_SESSION_ROOT = saved.root
    if (saved.dsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.dsh
  }
}

// ── 4f. /migrate 的 bin 探测：双布局都必须命中（真机 CONFIRMED 回归）───
{
  const { resolveOwnBin } = await import('../src/dsh-adapter/migrate/bin-path.js')
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { existsSync, statSync } = await import('node:fs')
  // dev 布局：本脚本从包内 src 层解析（src/screens 深度）
  const devBin = resolveOwnBin(dirname(fileURLToPath(import.meta.url)))
  check('4f1. dev 布局（scripts/ 深度）探测命中本包 bin',
    devBin !== undefined && existsSync(devBin), String(devBin))
  // 安装布局：lib/types/screens/ 深度（编译产物存在时才测——CI 的
  // verify job 在 build 后运行；本地无产物时是 SKIP，不是 PASS）
  const installedRoot = join(process.cwd(), 'lib', 'types', 'screens')
  try {
    statSync(installedRoot)
    const installedBin = resolveOwnBin(installedRoot)
    check('4f2. 安装布局（lib/types/screens/ 深度）探测命中本包 bin',
      installedBin !== undefined && existsSync(installedBin), String(installedBin))
  } catch {
    console.log('SKIP: 4f2. 安装布局产物未构建（CI build 后覆盖；不计入 check 数）')
  }
  // 反向：越界深度必须返回 undefined。resolveOwnBin 只返回 existsSync 通过
  // 的候选，所以旧的 `miss === undefined || existsSync(miss)` 恒真——空转断言。
  const miss = resolveOwnBin('/')
  check('4f3. 树外起点不误命中', miss === undefined, String(miss))
}

// ── 4g. 近期活动检测器矩阵（纯函数喂夹具：全冷/单热/多热/缺数据）────
{
  const { recentAgentsFrom, RECENT_ACTIVITY_WINDOW_MS } = await import('../src/dsh-adapter/migrate/recent-agents.js')
  const NOW = 1_790_000_000_000
  const sample = (agentId, minutesAgoOrNull) => ({
    agentId, label: agentId, newestMtimeMs: minutesAgoOrNull === null ? null : NOW - minutesAgoOrNull * 60_000,
  })
  check('4g1. 全冷（超窗）→ 空',
    recentAgentsFrom([sample('cc', 120), sample('codex', 5867)], NOW).length === 0)
  check('4g2. 单热 → 一项带 minutesAgo',
    JSON.stringify(recentAgentsFrom([sample('cc', 5), sample('codex', 300)], NOW))
      === JSON.stringify([{ agentId: 'cc', label: 'cc', minutesAgo: 5 }]))
  const multi = recentAgentsFrom([sample('cc', 18), sample('codex', 3), sample('zcode', 10)], NOW)
  check('4g3. 多热按最近优先排序',
    multi.map(m => m.agentId).join(',') === 'codex,zcode,cc', multi.map(m => `${m.agentId}:${m.minutesAgo}`).join(' '))
  check('4g4. 缺数据（null mtime）永不近期',
    recentAgentsFrom([sample('grok', null)], NOW).length === 0)
  check('4g5. 未来时间戳（时钟偏移）不算近期',
    recentAgentsFrom([sample('cc', -5)], NOW).length === 0)
  check('4g6. 窗口边界：恰 20 分钟算近期',
    recentAgentsFrom([sample('cc', 20)], NOW).length === 1
    && recentAgentsFrom([sample('cc', 21)], NOW, RECENT_ACTIVITY_WINDOW_MS).length === 0)
}

// ── 4h. 交互返工数据层：子进程汇报计数解析（PRD #3）────────────────────
{
  const { parseImportSummary } = await import('../src/dsh-adapter/migrate/picker.js')
  const out = [
    '[zcode] importing 60 conversation(s) into /x',
    '[zcode] imported 60',
    '[omp] importing 1366 conversation(s) into /x',
    '[omp] imported 0 · already present 1366',
  ].join('\n')
  const parsed = parseImportSummary(out)
  check('4h1. 解析逐源真实计数（导入/已存在）',
    parsed.length === 2
    && parsed[0].agentId === 'zcode' && parsed[0].imported === 60 && parsed[0].existing === 0
    && parsed[1].agentId === 'omp' && parsed[1].imported === 0 && parsed[1].existing === 1366)
  check('4h2. 无汇总输出 → 空数组（P2：不再误报完成）',
    parseImportSummary('[claude-code] 848 session file(s) to scan').length === 0)
}

// ── 4i. /migrate 命令分类矩阵（入口真源是注册表，不是选择器缓存）──────
{
  const { resolveMigrateCommand } = await import('../src/dsh-adapter/migrate/picker.js')
  const KNOWN = ['claude-code', 'codex', 'omp', 'zcode', 'grok-build']
  const kinds = raw => JSON.stringify(resolveMigrateCommand(raw, KNOWN))
  // fresh 会话（picker 从未打开、rows 为空）也必须直接可用——旧实现从选择器
  // 缓存里查 agent，导致这个入口首次调用永远报“未知迁移源”。
  check('4i1. fresh 会话 /migrate claude-code → 直接确认（不看选择器缓存）',
    kinds(' claude-code') === JSON.stringify({ kind: 'import', agentId: 'claude-code', dryRun: false }))
  check('4i2. 裸 /migrate → 打开选择器',
    kinds('') === JSON.stringify({ kind: 'picker' }))
  check('4i3. 未知源 → unknown（消费方报未知迁移源）',
    kinds(' nope') === JSON.stringify({ kind: 'unknown', agentId: 'nope' }))
  check('4i4. /migrate --dry-run → 明确要源，不再报“未知源 --dry-run”',
    kinds(' --dry-run') === JSON.stringify({ kind: 'dry-run-needs-source' }))
  check('4i5. /migrate zcode --dry-run → 只预览该源',
    kinds(' zcode --dry-run') === JSON.stringify({ kind: 'import', agentId: 'zcode', dryRun: true }))
  check('4i6. 两个源 → usage（与 CLI 的退出码 2 同语义，不再静默取第一个）',
    kinds(' claude-code codex') === JSON.stringify({ kind: 'usage' }))
}

// ── 5. uuid 确定性与区分性 ──────────────────────────────────────────────
{
  const [first] = fixtureSessions()
  check('5a. 同输入同 id', migrationUuid(`fixture:${first.sourceId}`) === migrationUuid(`fixture:${first.sourceId}`))
  check('5b. 不同 agent 前缀不同 id',
    migrationUuid(`fixture:${first.sourceId}`) !== migrationUuid(`codex:${first.sourceId}`))
}

// ── 6. adapter 解析冒烟（含 model 提取）────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'verify-migrate-adapters-'))
  // claude-code：一行 user（字符串 content）+ 一行 assistant（数组 content + thinking + model）
  const ccDir = join(home, '.claude', 'projects', '-tmp-cc')
  mkdirSync(ccDir, { recursive: true })
  writeFileSync(join(ccDir, `${firstUuid()}.jsonl`), [
    // 合法 JSON null 行（codex 对抗审核：不得终止扫描）
    'null',
    // 合法 JSON 的 null 子对象（dsh-tui-df 独立测试 CONFIRMED：不得让 discover 抛
    // 未捕获 TypeError——typeof null === 'object' 骗过旧守卫）
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/cc', message: null }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/cc', message: null }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/cc', message: { role: 'user', content: '纯文本提问' } }),
    // 真实格式：thinking 块的文本在 `thinking` 字段（不是 text）
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', cwd: '/tmp/cc', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '带思考的答复' }, { type: 'thinking', thinking: '思考内容' }] } }),
    '',
  ].join('\n'))
  // 同一会话的子代理 transcript（<session>/subagents/）与辅助 transcript：都不是独立会话
  const ccSub = join(ccDir, firstUuid(), 'subagents')
  mkdirSync(ccSub, { recursive: true })
  const auxLines = [
    JSON.stringify({ type: 'user', sessionId: firstUuid(), cwd: '/tmp/cc', message: { role: 'user', content: '子代理任务' } }),
    JSON.stringify({ type: 'assistant', sessionId: firstUuid(), cwd: '/tmp/cc', message: { id: 'ms', role: 'assistant', content: [{ type: 'text', text: '子代理回答' }] } }),
    '',
  ].join('\n')
  writeFileSync(join(ccSub, 'agent-a1.jsonl'), auxLines)
  writeFileSync(join(ccDir, 'agent-aux.jsonl'), auxLines)
  // codex：turn_context 带 model + assistant 输出
  const codexDay = join(home, '.codex', 'sessions', '2026', '01', '01')
  mkdirSync(codexDay, { recursive: true })
  writeFileSync(join(codexDay, `rollout-2026-01-01T00-00-00-${firstUuid()}.jsonl`), [
    // payload 为合法 JSON null（不得让 discover 抛未捕获 TypeError）
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: null }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { cwd: '/tmp/codex', timestamp: '2026-01-01T00:00:00Z' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'turn_context', payload: { model: 'gpt-5.1' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex 提问' }] } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex 答复' }] } }),
    '',
  ].join('\n'))
  // omp：`--<munged-cwd>--/<timestamp>_<id>.jsonl`，session 头行 + message 行
  const ompDir = join(home, '.omp', 'agent', 'sessions', '--tmp-omp--')
  mkdirSync(ompDir, { recursive: true })
  writeFileSync(join(ompDir, `1790000000000_${firstUuid()}.jsonl`), [
    JSON.stringify({ type: 'session', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/omp', title: 'omp 会话' }),
    // message 为合法 JSON null（不得让 discover 抛未捕获 TypeError）
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:00Z', message: null }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'omp 提问' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'omp 答复' }, { type: 'thinking', text: 'omp 思考' }] } }),
    '',
  ].join('\n'))

  // zcode：`~/.zcode/v2/sessions/<dir>/<taskId>.json` 单对象（meta+messages）
  const zcodeDir = join(home, '.zcode', 'v2', 'sessions', 't1')
  mkdirSync(zcodeDir, { recursive: true })
  // 整个文档为合法 JSON null（不得让 discover 抛未捕获 TypeError）
  writeFileSync(join(zcodeDir, 'doc-null.json'), 'null')
  // meta 为合法 JSON null（同上）
  writeFileSync(join(zcodeDir, 'meta-null.json'), JSON.stringify({ meta: null, messages: [] }))
  writeFileSync(join(zcodeDir, 'zcode-session.json'), JSON.stringify({
    meta: { taskId: 'zcode-task-1', workspacePath: '/tmp/zc', createdAt: 1787589672487, title: 'zcode 会话标题' },
    messages: [
      // messages 为合法 JSON null（同上）
      null,
      { role: 'user', content: null },
      { role: 'user', content: 'zcode 提问' },
      { role: 'assistant', content: 'zcode 答复', timestamp: 1787589674000 },
    ],
  }))
  // grok-build：`~/.grok/sessions/<encoded-cwd>/<uuid>/{summary.json,chat_history.jsonl}`
  const grokDir = join(home, '.grok', 'sessions', '%2Ftmp%2Fgrok', '0192a7f0-1234-7abc-8def-0123456789ab')
  mkdirSync(grokDir, { recursive: true })
  writeFileSync(join(grokDir, 'summary.json'), JSON.stringify({
    info: { id: '0192a7f0-1234-7abc-8def-0123456789ab', cwd: '/tmp/grok' },
    session_summary: 'grok 会话', created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:05:00Z',
    num_messages: 5, current_model_id: 'grok-4-fast', chat_format_version: 1,
  }))
  writeFileSync(join(grokDir, 'chat_history.jsonl'), [
    'null',
    JSON.stringify({ type: 'system', content: 'system prompt' }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'grok 提问' }] }),
    // reasoning 兄弟行：附到下一个 assistant turn
    JSON.stringify({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'grok 思考' }] }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '合成注入不迁移' }], synthetic_reason: 'system_reminder' }),
    JSON.stringify({ type: 'user', content: null }),
    JSON.stringify({ type: 'assistant', content: 'grok 答复', model_id: 'grok-4-fast' }),
    '',
  ].join('\n'))

  // Adapters resolve their roots through os.homedir(), which reads
  // USERPROFILE (not HOME) on Windows: setting only HOME silently pointed the
  // scan at the REAL home there and failed 6a–6c on every Windows checkout.
  // grok-build additionally honors GROK_HOME, so that override is pinned to
  // the fixture's own `.grok` directory (otherwise a host that sets it would
  // have 6e read the real store).
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.GROK_HOME = join(home, '.grok')
  // 断言读轮模型：一轮 = 一个提问 + 若干步；reasoning 是步内的 reasoning 块
  const stepOf = session => session?.turns[0]?.steps[0]
  const blockText = (step, type) => step?.blocks.find(block => block.type === type)?.text
  const cc = claudeCodeAdapter.discover()
  const ccStep = stepOf(cc.sessions[0])
  check('6a. claude-code 解析（字符串 user + thinking + model）',
    cc.sessions.length === 1 && cc.sessions[0].turns.length === 1 && cc.sessions[0].turns[0].prompt === '纯文本提问'
    && blockText(ccStep, 'reasoning') === '思考内容' && ccStep?.model === 'claude-sonnet-5'
    && cc.sessions[0].cwd === '/tmp/cc')
  check('6a2. claude-code 的 subagents/ 与辅助 transcript 不成会话，也不计入 count',
    cc.sessions.length === 1 && claudeCodeAdapter.count() === 2, `count=${claudeCodeAdapter.count()}`)
  const codexFound = codexAdapter.discover()
  const codexStep = stepOf(codexFound.sessions[0])
  check('6b. codex 解析（turn_context model 前向）',
    codexFound.sessions.length === 1 && codexFound.sessions[0].turns.length === 1
    && codexStep?.model === 'gpt-5.1' && blockText(codexStep, 'text') === 'codex 答复'
    && codexFound.sessions[0].cwd === '/tmp/codex')
  const ompFound = ompAdapter.discover()
  const ompStep = stepOf(ompFound.sessions[0])
  check('6c. omp 解析（thinking 块）',
    ompFound.sessions.length === 1 && ompFound.sessions[0].turns.length === 1 && blockText(ompStep, 'reasoning') === 'omp 思考')
  const zcFound = zcodeAdapter.discover()
  check('6d. zcode 解析（单对象 + 元素级 null 跳过）',
    zcFound.sessions.length === 1 && zcFound.sessions[0].turns.length === 1 && zcFound.sessions[0].turns[0].steps.length === 1
    && zcFound.sessions[0].cwd === '/tmp/zc' && zcFound.sessions[0].title === 'zcode 会话标题')
  const gbFound = grokBuildAdapter.discover()
  const gbStep = stepOf(gbFound.sessions[0])
  check('6e. grok-build 解析（reasoning 兄弟行 + synthetic 过滤）',
    gbFound.sessions.length === 1 && gbFound.sessions[0].turns.length === 1
    && blockText(gbStep, 'reasoning') === 'grok 思考' && gbStep?.model === 'grok-4-fast'
    && gbFound.sessions[0].cwd === '/tmp/grok')
  // sourceId 是幂等键的一部分（UUIDv5 输入）：它必须是裸文件名，不能把源目录
  // 带进来——join() 在 Windows 产出 `\`，旧实现的 split('/') 会退化成整条绝对
  // 路径，源目录一移动就重复导入。本断言在 Windows 抓得住这个回归。
  const ids = [cc.sessions[0], codexFound.sessions[0], ompFound.sessions[0], zcFound.sessions[0], gbFound.sessions[0]]
    .map(session => session.sourceId)
  check('6f. 五家 sourceId 都是裸文件名（不带路径分隔符，跨平台稳定）',
    ids.every(id => typeof id === 'string' && id !== '' && !/[\\/]/u.test(id)), ids.join(' | '))
  check('6g. claude-code/omp 的 sourceId 取到夹具 uuid 本身（而非路径原文）',
    cc.sessions[0].sourceId === firstUuid() && ompFound.sessions[0].sourceId === firstUuid(),
    `${cc.sessions[0].sourceId} | ${ompFound.sessions[0].sourceId}`)
  // 平台无关守卫：sourceId 不许用 split('/') 从路径里抠文件名——join() 在
  // Windows 产 `\`，那种写法只在 POSIX 正确，而 required CI 组全在 Linux 上
  // 跑（6f/6g 在 Linux 抓不到这个回归）。本断言在任何平台都有效；只看代码行，
  // 注释里解释这条规矩本身不算违规。
  const adapterDir = join(import.meta.dirname, '..', 'src/dsh-adapter/migrate/adapters')
  const offenders = ['claude-code.ts', 'codex.ts', 'omp.ts', 'zcode.ts', 'grok-build.ts']
    .filter(name => readFileSync(join(adapterDir, name), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
      .some(line => /\.split\(\s*'\/'\s*\)/u.test(line)))
  check('6h. adapter 不用 split(\'/\') 取文件名（跨平台 sourceId 守卫）',
    offenders.length === 0, offenders.join(','))
  rmSync(home, { recursive: true, force: true })
}

function firstUuid() {
  return '44444444-4444-4444-8444-444444444444'
}

rmSync(root, { recursive: true, force: true })
console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate regression passed (${checks} checks)`)
