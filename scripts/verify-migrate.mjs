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
 *   6. adapter 解析冒烟：三家的最小 fixture 行（含 model 提取）。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Session, SessionId, SessionLogOffset } = await import('@deepseek-ai/dsh-session')
const { importSessions, migrationSessionId } = await import('../src/dsh-adapter/migrate/index.js')
const { sessionize } = await import('../src/dsh-adapter/migrate/sessionize.js')
const { migrationUuid } = await import('../src/dsh-adapter/migrate/uuid.js')
const { claudeCodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/claude-code.js')
const { codexAdapter } = await import('../src/dsh-adapter/migrate/adapters/codex.js')
const { ompAdapter } = await import('../src/dsh-adapter/migrate/adapters/omp.js')

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
  check('1a. header 携带 cwd 与当前格式版本', header.cwd === first.cwd && header.version === 3, `v${header.version}`)
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
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/cc', message: { role: 'user', content: '纯文本提问' } }),
    // 真实格式：thinking 块的文本在 `thinking` 字段（不是 text）
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', cwd: '/tmp/cc', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '带思考的答复' }, { type: 'thinking', thinking: '思考内容' }] } }),
    '',
  ].join('\n'))
  // codex：turn_context 带 model + assistant 输出
  const codexDay = join(home, '.codex', 'sessions', '2026', '01', '01')
  mkdirSync(codexDay, { recursive: true })
  writeFileSync(join(codexDay, `rollout-2026-01-01T00-00-00-${firstUuid()}.jsonl`), [
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
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'omp 提问' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'omp 答复' }, { type: 'thinking', text: 'omp 思考' }] } }),
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
  rmSync(home, { recursive: true, force: true })
}

function firstUuid() {
  return '44444444-4444-4444-8444-444444444444'
}

rmSync(root, { recursive: true, force: true })
console.log(process.exitCode ? `${checks - 0} check(s), FAILED` : 'migrate regression passed')
