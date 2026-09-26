/**
 * verify-migrate — 跨代理会话迁移回归（fixture 驱动，不依赖本机数据）。
 *
 * 第一版 PR 的教训：只验「头行合法」是假绿。本回归全程跑真实读取链——
 * 覆盖 src/migrate/：
 *   1. sessionize：官方 Session.append 生成的事件骨架（turn 配对 = 下一个
 *      user 关闭上一轮 + 收尾关闭最后一轮）、reasoning 块保留、header
 *      cwd/version、CJK 与 emoji 原样进入事件；
 *   2. 端到端往返（维护者要求的验收链）：fixture 会话 → importSessions
 *      （官方 JsonlSessionPersistence 落盘）→ open(id,'read') 读回 →
 *      Session.fromRestore + deriveMessages：角色/顺序/文本逐一断言；
 *   3. 续聊：restore 后的会话作为 seed 继续追加新一轮 → 写回 → 再读回，
 *      新旧消息同在（导入的会话是活的，不是只能看）；
 *   4. 幂等：同批 fixture 二次导入全部 existing，列表数不变；
 *   5. migrationUuid：确定性（同输入同 id）与区分性（不同 agent 不同 id）；
 *   6. adapter 解析冒烟：五家的最小 fixture 行（含 model 提取、null 防御）。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
const { importSessions, migrationSessionId } = await import('../src/dsh-adapter/migrate/index.js')
const { sessionize } = await import('../src/dsh-adapter/migrate/sessionize.js')
const { migrationUuid } = await import('../src/dsh-adapter/migrate/uuid.js')
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

/** Fixture：CJK + emoji + reasoning 的多形状会话。 */
function fixtureSessions() {
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
  check('1c. 一 user 一 assistant 的常规轮',
    types.join(' ') === 'turn/start user/message step/start assistant/message step/end turn/end turn/start user/message step/start assistant/message step/end turn/end',
    types.join(','))
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
    const expected = 'turn/start user/message step/start assistant/message step/end step/start assistant/message step/end step/start assistant/message step/end turn/end turn/start user/message turn/end'
    check('4c1. 一 user 三 assistant + 尾 user 的事件全序', types === expected, types)
  }
  // 夹具 3：孤立 assistant 开头（无 user 的首轮，一个 step 无 user/message）
  {
    const id = SessionId(migrationUuid(`fixture:${sessions[2].sourceId}`))
    const { events } = sessionize(id, 'fixture', sessions[2])
    const types = events.map(e => e.type).join(' ')
    check('4c2. 孤立 assistant 开头的事件全序',
      types === 'turn/start step/start assistant/message step/end turn/end', types)
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
  const prevDsh = process.env.DSH_HOME
  const prevStdoutWrite = process.stdout.write.bind(process.stdout)
  const sink = []
  process.stdout.write = (chunk) => { sink.push(String(chunk)); return true }
  process.env.HOME = home
  process.env.DSH_HOME = dshHome
  try {
    const usage = await cliMigrate(['a', 'b'])
    check('4e1. 多参数 → 退出码 2', usage === 2)
    const bogus = await cliMigrate(['not-an-agent'])
    check('4e2. 未知 agent → 退出码 2', bogus === 2)
    const bare = await cliMigrate([])
    check('4e3. 裸列表 → 退出码 0（HOME 指空目录，各源 0 会话）', bare === 0)
    // dry-run 契约：绝不写盘（目标根不存在）
    const dry = await cliMigrate(['fixture-agent' in {} ? 'x' : 'claude-code', '--dry-run'])
    const dryTargetExists = existsSync(dshHome)
    check('4e4. dry-run → 退出码 0 且未写目标根', dry === 0 && !dryTargetExists,
      `exit=${dry} targetExists=${dryTargetExists}`)
    check('4e5. 输出经过 stdout 且非空', sink.length > 0)
  } finally {
    process.stdout.write = prevStdoutWrite
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    rmSync(home, { recursive: true, force: true })
  }
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

  process.env.HOME = home
  const cc = claudeCodeAdapter.discover()
  const ccTurns = cc.sessions[0]?.turns ?? []
  check('6a. claude-code 解析（字符串 user + thinking + model）',
    cc.sessions.length === 1 && ccTurns.length === 2
    && ccTurns[1].reasoning === '思考内容' && ccTurns[1].model === 'claude-sonnet-5'
    && cc.sessions[0].cwd === '/tmp/cc')
  const codexFound = codexAdapter.discover()
  const codexTurns = codexFound.sessions[0]?.turns ?? []
  check('6b. codex 解析（turn_context model 前向）',
    codexFound.sessions.length === 1 && codexTurns.length === 2
    && codexTurns[1].model === 'gpt-5.1' && codexFound.sessions[0].cwd === '/tmp/codex')
  const ompFound = ompAdapter.discover()
  const ompTurns = ompFound.sessions[0]?.turns ?? []
  check('6c. omp 解析（thinking 块）',
    ompFound.sessions.length === 1 && ompTurns.length === 2 && ompTurns[1].reasoning === 'omp 思考')
  const zcFound = zcodeAdapter.discover()
  const zcTurns = zcFound.sessions[0]?.turns ?? []
  check('6d. zcode 解析（单对象 + 元素级 null 跳过）',
    zcFound.sessions.length === 1 && zcTurns.length === 2
    && zcFound.sessions[0].cwd === '/tmp/zc' && zcFound.sessions[0].title === 'zcode 会话标题')
  const gbFound = grokBuildAdapter.discover()
  const gbTurns = gbFound.sessions[0]?.turns ?? []
  check('6e. grok-build 解析（reasoning 兄弟行 + synthetic 过滤）',
    gbFound.sessions.length === 1 && gbTurns.length === 2
    && gbTurns[1].reasoning === 'grok 思考' && gbTurns[1].model === 'grok-4-fast'
    && gbFound.sessions[0].cwd === '/tmp/grok')
  rmSync(home, { recursive: true, force: true })
}

function firstUuid() {
  return '44444444-4444-4444-8444-444444444444'
}

rmSync(root, { recursive: true, force: true })
console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate regression passed (${checks} checks)`)
