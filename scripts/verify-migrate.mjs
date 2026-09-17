/**
 * verify-migrate — 跨代理会话迁移回归（fixture 驱动，不依赖本机数据）。
 *
 * 覆盖 src/migrate/：
 *   1. synthesizeSessionEvents：session 头（origin/v4 语义字段）、策略三连、
 *      turn/start→user/message→assistant/message→turn/end 骨架、reasoning 块
 *      保留、无用户轮的会话拒绝、session/title 锚定首个用户轮；
 *   2. mungeCwd：DSH sessions 的 `--dash-munged--` 段；
 *   3. migrationUuid：确定性（同输入同 id）与区分性（不同 agent 前缀不同 id）；
 *   4. 三个 adapter 对最小 fixture 行的解析（CC 的字符串 content/tool_result
 *      跳过/sidechain 跳过、codex 的 input_text/output_text/加密 reasoning
 *      跳过、omp 的同构 content）；
 *   5. importSession：zstd 落盘后可解压回读、seq 严格递增、幂等覆盖同文件。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

const dec = promisify(zstdDecompress)

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// 直接从各模块取（tsx 允许 .ts 导入）
const synth = (await import('../src/migrate/synthesize.ts')).synthesizeSessionEvents
const munge = (await import('../src/migrate/index.ts')).mungeCwd
const uuidOf = (await import('../src/migrate/uuid.ts')).migrationUuid
const { importSession, MIGRATION_ADAPTERS } = await import('../src/migrate/index.ts')

// 上游真实读取链（审查 C1 的教训：只断言自身形状会漏掉格式契约违约）
const { createRequire } = await import('node:module')
const require = createRequire(new URL('..', import.meta.url))
let catalog
try {
  catalog = require('@deepseek-ai/dsh-session-format-catalog')
} catch {
  const { readdirSync } = await import('node:fs')
  const pnpm = readdirSync(new URL('../node_modules/.pnpm', import.meta.url).pathname).find(name => name.startsWith('@deepseek-ai+dsh-session-format-catalog@'))
  catalog = require(`${new URL('../node_modules/.pnpm', import.meta.url).pathname}/${pnpm}/node_modules/@deepseek-ai/dsh-session-format-catalog`)
}
const readHeader = catalog.sessionFormatCatalog ? catalog.sessionFormatCatalog.readHeader.bind(catalog.sessionFormatCatalog) : catalog.readHeader.bind(catalog)

// ── 1. 合成器 ────────────────────────────────────────────────────────────
{
  const session = {
    sourceId: 'src-1', cwd: '/w/one', startedAt: 1000,
    turns: [
      { role: 'user', text: '你好', time: 1100 },
      { role: 'assistant', text: '在', reasoning: '想', time: 1200 },
      { role: 'user', text: '再来', time: 1300 },
      { role: 'assistant', text: '好', reasoning: undefined, time: 1400 },
    ],
  }
  const events = synth(session, 'cc', 'id-1')
  const head = events[0]
  check('合成: session 头契约字段（无 origin——header 只允许 subagent）', head.type === 'session' && head.origin === undefined && head.cwd === '/w/one' && head.version === 0 && head.delegationDepth === 0)
  const verdict = readHeader(JSON.parse(JSON.stringify(head)))
  check('上游 catalog: 合成头可读（非 malformed）', verdict.status !== 'malformed', verdict.reason ?? verdict.status)
  const types = events.map(event => event.type)
  check('合成: 策略三连在头部之后', types.slice(1, 4).join(',') === 'permission/preset,sandbox/mode,approval/policy')
  check('合成: 两轮 turn/start↔turn/end 骨架', types.filter(t => t === 'turn/start').length === 2 && types.filter(t => t === 'turn/end').length === 2)
  const firstUser = events.find(event => event.type === 'user/message')
  check('合成: user/message surfaceOp 在信封层且 data 仅四键', firstUser.surfaceOp === 'append'
    && Object.keys(firstUser.data).sort().join(',') === 'content,id,role,source')
  const firstAssistant = events.find(event => event.type === 'assistant/message')
  check('合成: assistant 带双 turn/step 与 reasoning 块（信封无 surfaceOp）', firstAssistant.data.turn === 1 && firstAssistant.data.step === 1
    && firstAssistant.data.message.content[0].type === 'reasoning' && firstAssistant.data.message.content[1].type === 'text'
    && firstAssistant.surfaceOp === undefined)
  const secondAssistant = events.filter(event => event.type === 'assistant/message')[1]
  check('合成: 空 reasoning 不产生空块', secondAssistant.data.message.content.length === 1 && secondAssistant.data.message.content[0].type === 'text')
  const turnEnd = events.find(event => event.type === 'turn/end')
  check('合成: turn/end 用合法 variant completed', turnEnd.data.reason.kind === 'completed')
  const title = events.find(event => event.type === 'session/title')
  check('合成: title 锚定首个用户轮的精确 seq', title.data.title === '你好' && title.data.messageSeqs.length === 1 && title.data.messageSeqs[0] === firstUser.seq)
  const seqs = events.filter(event => event.seq !== undefined).map(event => event.seq)
  check('合成: seq 从 0 严格递增', seqs[0] === 0 && seqs.every((seq, i) => i === 0 || seq === seqs[i - 1] + 1))
  const times = events.filter(event => event.time !== undefined).map(event => event.time)
  check('合成: time 单调不减', times.every((time, i) => i === 0 || time >= times[i - 1]))
  check('合成: 无用户轮拒绝', synth({ sourceId: 'x', cwd: '/w', startedAt: 1, turns: [{ role: 'assistant', text: 'hi', time: 2 }] }, 'cc', 'id').length === 0)
}

// ── 2. mungeCwd ──────────────────────────────────────────────────────────
check('munge: DSH 段格式', munge('/mnt/shared/_Projects') === '--mnt-shared-_Projects--' && munge('/') === '----')

// ── 3. uuid ─────────────────────────────────────────────────────────────
{
  const a1 = uuidOf('cc:same')
  check('uuid: 确定性', a1 === uuidOf('cc:same'))
  check('uuid: agent 前缀区分', a1 !== uuidOf('codex:same'))
  check('uuid: v5 形状', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(a1))
}

// ── 4. adapter fixture 解析 ──────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'verify-migrate-'))
  const fakeHome = join(root, 'home')
  // claude-code fixture
  const ccDir = join(fakeHome, '.claude', 'projects', '-mnt-w')
  mkdirSync(ccDir, { recursive: true })
  writeFileSync(join(ccDir, 'a1.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: '<system-reminder>\nPrimary working directory: /mnt/w\n</system-reminder>\n\n做点事' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'thinking', text: '思考' }, { type: 'text', text: '好的' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:03Z', isSidechain: true, message: { role: 'user', content: 'sidechain' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
  ].join('\n') + '\n')
  // codex fixture
  const cxDir = join(fakeHome, '.codex', 'sessions', '2026', '01', '01')
  mkdirSync(cxDir, { recursive: true })
  writeFileSync(join(cxDir, 'rollout-2026-01-01T00-00-00-019f2c03-7916-7300-ac3b-5df79aa78cb9.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: '019f2c03-7916-7300-ac3b-5df79aa78cb9', cwd: '/mnt/w2', timestamp: '2026-01-01T00:00:00Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'zzz' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '结论' }] } }),
  ].join('\n') + '\n')
  // omp fixture
  const ompDir = join(fakeHome, '.omp', 'agent', 'sessions', '--mnt-w3--')
  mkdirSync(ompDir, { recursive: true })
  writeFileSync(join(ompDir, '2026-01-01T00-00-00Z_019ff7c0-2816-7000-a281-5a2d66d11977.jsonl'), [
    JSON.stringify({ type: 'session', id: '019ff7c0', cwd: '/mnt/w3', title: '清理' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '开始' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }),
  ].join('\n') + '\n')

  const prevHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    const cc = MIGRATION_ADAPTERS.find(adapter => adapter.id === 'claude-code')
    const ccFound = cc.discover()
    check('CC fixture: 发现 1 会话', ccFound.sessions.length === 1)
    const ccSession = ccFound.sessions[0]
    check('CC fixture: cwd 取自 system-reminder', ccSession.cwd === '/mnt/w')
    check('CC fixture: 2 轮（sidechain/tool_result 剔除）', ccSession.turns.length === 2 && ccSession.turns[0].role === 'user' && ccSession.turns[1].text === '好的')
    check('CC fixture: reasoning 归位', ccSession.turns[1].reasoning === '思考')

    const cx = MIGRATION_ADAPTERS.find(adapter => adapter.id === 'codex')
    const cxF = cx.discover()
    check('codex fixture: 发现并解析', cxF.sessions.length === 1 && cxF.sessions[0].cwd === '/mnt/w2' && cxF.sessions[0].turns.length === 2)
    check('codex fixture: sourceId 取 rollout uuid', cxF.sessions[0].sourceId === '019f2c03-7916-7300-ac3b-5df79aa78cb9')

    const omp = MIGRATION_ADAPTERS.find(adapter => adapter.id === 'omp')
    const ompF = omp.discover()
    check('omp fixture: 发现并解析（title 提取）', ompF.sessions.length === 1 && ompF.sessions[0].title === '清理' && ompF.sessions[0].turns.length === 2)

    // ── 5. importSession 端到端（fixture → zstd → 回读）────────────────
    const dshHome = join(root, 'dsh-home')
    const out = await importSession(omp, ompF.sessions[0], dshHome)
    check('导入: 落盘于 munged 段下的 uuid 目录', out.target.includes(join('sessions', '--mnt-w3--')) && out.target.endsWith('session.jsonl.zstd'))
    const lines = (await dec(readFileSync(out.target))).toString().split('\n').filter(Boolean)
    check('导入: zstd 可解压、头行合法（无 origin）', JSON.parse(lines[0]).type === 'session' && JSON.parse(lines[0]).origin === undefined)
    const storeVerdict = readHeader(JSON.parse(lines[0]))
    check('导入: 上游 catalog 认可落盘头', storeVerdict.status !== 'malformed', storeVerdict.reason ?? storeVerdict.status)
    const again = await importSession(omp, ompF.sessions[0], dshHome)
    check('导入: 幂等（同 target，已存在不重写）', again.target === out.target && again.wrote === false)
  } finally {
    process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
}

if (failed > 0) {
  console.error(`verify-migrate: ${failed} failure(s)`)
  process.exit(1)
}
console.log('verify-migrate: all ok')
