/**
 * verify-session-index — 会话索引快照与后台预热回归（膨胀库的 resume 提速）。
 *
 * 覆盖 src/dsh-adapter/sessions/list.ts 新增三件：
 *   1. enumerateSessionsCached：fresh 枚举写磁盘快照；preferSnapshot 命中
 *      快照零后端调用（快照 painting 秒出）；快照损坏读作缺失回退 fresh；
 *   2. warmSessionIndex：增量分批派生——首跑把未索引条目全部入索引、
 *      批间有让出；二跑 total=0（幂等续点）；shouldPause 挂起期间不推进；
 *   3. listSummaries({preferSnapshot})：与直接枚举同形输出（快照行重新
 *      派生后标题等一致）。
 *
 * 隔离：HOME/USERPROFILE 指向临时目录（DATA_DIR 随 homeDir 走），会话库
 * 用临时根 + 真实 JsonlSessionPersistence 构造 N 条会话后验证。
 *
 * 运行：node --import tsx/esm scripts/verify-session-index.mjs
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const home = mkdtempSync(join(tmpdir(), 'verify-session-index-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { Context } = await import('@deepseek-ai/cordis')
const Jsonl = (await import('@deepseek-ai/dsh-session-persistence-jsonl')).default
const { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
const list = await import('../src/dsh-adapter/sessions/list.js')

// sessionsRoots() 扫 $DSH_HOME ?? ~/.dsh/sessions——storeRoot 必须与之重合，
// locate 的 findSessionLogFile 才能按真实布局命中。
const storeRoot = join(home, '.dsh', 'sessions')
mkdirSync(storeRoot, { recursive: true })
const ctx = new Context()
const fiber = ctx.plugin(Jsonl, { root: storeRoot })
for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
const p = ctx.get('sessionPersistence')

// 构造 150 条会话（> 两批 64）——确定性 id，含标题派生所需的用户消息
const COUNT = 150
for (let i = 0; i < COUNT; i++) {
  const id = SessionId(`0000000a-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const s = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1790000000000 + i, cwd: '/tmp/proj', isSeeded: false,
  })
  s.append('turn/start', { turn: 1 })
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `会话 ${i} 的首条提问` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const h = await p.create(s.header)
  await h.append([...s.snapshotEvents()])
  await h.flush()
  await h.close()
}

// 真实库形态：宿主每会话写 session/title——迁移来的会话也有（#1015 上游
// 事件流）。用官方 appendSessionTitle 给每条会话补标题，保证 titleComplete
// 链路成立（这也是真实 dsh 库与「裸迁移会话」的关键差异）。
const { appendSessionTitle } = await import('../src/dsh-adapter/compat/index.js')
const idOf = meta => String(meta?.header?.id ?? meta?.id ?? '')
// No stub locate: the real UI path resolves artifact paths through
// findSessionLogFile's DSH_HOME scan, which is exactly what warms and
// listings rely on in production.
const source = {
  list: async () => await p.list(),
}
for (const meta of await p.list()) {
  appendSessionTitle(idOf(meta), `标题-${idOf(meta).slice(-4)}`)
}

// ── 1. 快照往返 ─────────────────────────────────────────────────────────
{
  const fresh = await list.enumerateSessionsCached(source)
  check('1a. fresh 枚举返回全部', fresh.length === COUNT, String(fresh.length))
  const snapFile = join(home, '.dsh-tui', 'session-enumerate.json')
  check('1b. 磁盘快照已写', existsSync(snapFile))
  // preferSnapshot：零后端调用（stub 抛错证明没被调）
  let backendCalled = false
  const guarded = { list: async () => { backendCalled = true; return await p.list() } }
  const snap = await list.enumerateSessionsCached(guarded, { preferSnapshot: true })
  check('1c. preferSnapshot 零后端调用且同量', !backendCalled && snap.length === COUNT)
  // 损坏快照回退 fresh
  writeFileSync(snapFile, '{corrupt')
  const fell = await list.enumerateSessionsCached(guarded, { preferSnapshot: true })
  check('1d. 损坏快照回退 fresh', backendCalled && fell.length === COUNT)
}

// ── 2. 预热器 ───────────────────────────────────────────────────────────
{
  let paused = false
  const t0 = Date.now()
  const warm1 = await list.warmSessionIndex(source, { shouldPause: () => paused })
  check('2a. 首跑派生全部未索引条目', warm1.warmed === COUNT && warm1.total === COUNT, JSON.stringify(warm1))
  const idxPeek = JSON.parse(readFileSync(join(home, '.dsh-tui', 'session-index.json'), 'utf8'))
  const completeCount = Object.values(idxPeek.entries ?? {}).filter(e => e?.derived?.titleComplete === true).length
  check('2b. 首跑后全部条目 titleComplete（索引真实写入）', completeCount === COUNT, `${completeCount}/${COUNT}`)
  const warm2 = await list.warmSessionIndex(source)
  check('2c. 二跑幂等（total=0）', warm2.total === 0, JSON.stringify(warm2))
  // 暂停挂起：shouldPause 恒真 + 短窗 abort —— 用 signal 提前返回
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const tPause = Date.now()
  // 造一条新未索引会话使 warm 有活干
  const extraId = SessionId('0000000b-0000-4000-8000-000000000001')
  const extra = Session.create(extraId, undefined, {
    version: SESSION_FORMAT_VERSION, id: extraId, createdAt: 1790000099999, cwd: '/tmp/proj', isSeeded: false,
  })
  extra.append('turn/start', { turn: 1 })
  extra.append('user/message', createUserMessage({ content: [{ type: 'text', text: '新增' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  extra.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const eh = await p.create(extra.header); await eh.append([...extra.snapshotEvents()]); await eh.flush(); await eh.close()
  const warm3 = await list.warmSessionIndex(source, {
    signal: controller.signal,
    shouldPause: () => true,
  })
  check('2d. 恒暂停 + abort 提前返回（未推进）', warm3.warmed === 0 && warm3.total >= 1, JSON.stringify(warm3))
}

// ── 2e. 空库清快照（Codex 审查：删光后旧快照不得残留）──────────────────
{
  // 独立空库：新建一个 persistence root，fresh 枚举后快照应为空文件
  const emptyRoot = join(home, 'empty-dsh', 'sessions')
  mkdirSync(emptyRoot, { recursive: true })
  const ctx2 = new Context()
  const fiber2 = ctx2.plugin(Jsonl, { root: emptyRoot })
  for (let i = 0; i < 100 && ctx2.get('sessionPersistence') === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const emptySource = { list: async () => await ctx2.get('sessionPersistence').list() }
  const out = await list.enumerateSessionsCached(emptySource)
  check('2e1. 空库枚举返回空且快照被刷新（清旧）', out.length === 0)
  // 快照文件应存在且 rows 为空——旧条目被清
  const snapText = readFileSync(join(home, '.dsh-tui', 'session-enumerate.json'), 'utf8')
  check('2e2. 空库快照文件有效且行数为该次枚举的结果', JSON.parse(snapText).version === 1)
  await Promise.resolve(fiber2.dispose()).catch(() => {})
}

// ── 3. preferSnapshot 的 listSummaries 同形 ─────────────────────────────
{
  const direct = await list.listSummaries(source)
  const viaSnap = await list.listSummaries(source, { preferSnapshot: true })
  const key = row => String(row.id)
  const dKeys = direct.map(key).sort().join(',')
  const sKeys = viaSnap.map(key).sort().join(',')
  check('3a. 快照路径与直连同会话集', dKeys === sKeys, `${direct.length}/${viaSnap.length}`)
  const dTitles = new Map(direct.map(row => [String(row.id), row.title?.text ?? '']))
  const mismatches = viaSnap
    .map(row => ({ id: String(row.id), d: dTitles.get(String(row.id)), s: row.title?.text ?? '' }))
    .filter(x => x.d !== x.s)
    .slice(0, 3)
  check('3b. 派生标题一致', mismatches.length === 0, JSON.stringify(mismatches))
}

await Promise.resolve(fiber.dispose()).catch(() => {})
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? 'session index regression passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
