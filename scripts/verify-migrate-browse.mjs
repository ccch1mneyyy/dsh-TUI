/**
 * verify-migrate-browse — 外部来源浏览层回归（合成 fixture，临时目录，不读本机数据）。
 *
 * 覆盖 docs/foreign-session-tabs-design.md §3、§5、§7：扫描 IO 基础设施
 * （有界头尾窗口、异步遍历、并发扫描池、指纹复用）、四个源的 scan()/load()
 * （摘要与全量解析一致、sessionKey 等于 discover() 的 sourceId）、browse
 * （存在性探测只走到第一个候选、同一进程内复用未变的摘要、不落盘、行上不
 * 暴露来源格式）、单会话导入。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate-browse.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let checks = 0
function check(name, ok, extra = '') {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

const scratch = mkdtempSync(join(tmpdir(), 'verify-migrate-browse-'))

// ── 1. 扫描 IO 基础设施 ─────────────────────────────────────────────────
{
  const { readHead, readTail, walkFiles, runScan, withHead, loadText, MAX_ARTIFACT_BYTES } =
    await import('../src/dsh-adapter/migrate/adapters/scan-fs.js')
  const file = join(scratch, 'lines.jsonl')
  // 每行 10 字节（含换行），末行无换行
  writeFileSync(file, ['汉字ab1', '汉字ab2', '汉字ab3'].join('\n'))
  check('1a. 头窗口只保留完整行（窗口在行中间时丢掉残行）', (await readHead(file, 14)) === '汉字ab1\n')
  check('1b. 尾窗口丢掉开头的残行', (await readTail(file, 14, 29)) === '汉字ab3')
  check('1c. 文件短于窗口时整读', (await readHead(file, 1024)).endsWith('汉字ab3'))
  const seen = []
  const accepted = await withHead(file, 29, (head, whole) => { seen.push(whole); return head.includes('ab3') ? 'found' : undefined })
  check('1d. withHead 在小文件上一次整读即返回', accepted === 'found' && seen.join() === 'true')

  const tree = join(scratch, 'tree')
  mkdirSync(join(tree, 'a', 'subagents'), { recursive: true })
  mkdirSync(join(tree, 'a', 'b', 'c', 'd'), { recursive: true })
  writeFileSync(join(tree, 'a', 'x.jsonl'), '')
  writeFileSync(join(tree, 'a', 'subagents', 'agent.jsonl'), '')
  writeFileSync(join(tree, 'a', 'b', 'c', 'd', 'deep.jsonl'), '')
  writeFileSync(join(tree, 'a', 'note.txt'), '')
  const names = []
  for await (const walked of walkFiles([tree, join(scratch, 'missing-root')], { maxDepth: 3, match: n => n.endsWith('.jsonl'), skipDirs: ['subagents'] })) {
    names.push(walked.name)
  }
  check('1e. 遍历按名字匹配、跳过指定目录、限制深度、缺失根目录不报错', names.join(',') === 'x.jsonl', names.join(','))

  const controller = new AbortController()
  controller.abort()
  let aborted = false
  try {
    for await (const _ of walkFiles([tree], { maxDepth: 3, match: () => true, signal: controller.signal })) { /* empty */ }
  } catch (error) {
    aborted = error?.name === 'AbortError'
  }
  check('1f. 已中止的 signal 让遍历以 AbortError 结束', aborted)

  const walked = async function* (refs) {
    for (const ref of refs) yield { path: ref, dir: '', name: ref }
  }
  const fps = { r1: { mtimeMs: 1, size: 1 }, r2: { mtimeMs: 2, size: 2 }, r3: { mtimeMs: 3, size: 3 }, r4: { mtimeMs: 4, size: 4 } }
  const summarized = []
  const reported = []
  const summary = ref => ({ agentId: 'x', sessionKey: ref, ref, title: ref, cwd: '', lastMessageAt: 0, createdAt: 0 })
  // r1 重复出现（grok 一个目录多个文件的形态）只扫一次；r5 指纹时已消失
  const entries = await runScan(walked(['r1', 'r2', 'r3', 'r1', 'r4', 'r5']), file => file.path, async ref => fps[ref], {
    cached: ref => ref === 'r1' ? summary('r1') : ref === 'r2' ? null : undefined,
    onEntry: s => reported.push(s.ref),
  }, async ({ ref }) => {
    summarized.push(ref)
    if (ref === 'r4') throw new Error('vanished')
    return summary(ref)
  })
  const sorted = entries.map(e => `${e.ref}:${e.summary === null ? 'null' : 'ok'}`).sort()
  check('1g. 命中缓存的（含已知否定结果）不再读取，其余逐个摘要；重复 ref 只扫一次，消失的不入列',
    summarized.sort().join(',') === 'r3,r4' && sorted.join(',') === 'r1:ok,r2:null,r3:ok', `${summarized} / ${sorted}`)
  check('1h. 读取失败的条目本轮跳过、不缓存；onEntry 只报会话', reported.sort().join(',') === 'r1,r3')
  // 并发池：stat 与头读取是 IO，逐个串行等于把上千次往返相加
  let active = 0
  let peak = 0
  const many = Array.from({ length: 40 }, (_, i) => `m${i}`)
  const pooled = await runScan(walked(many), file => file.path, async () => ({ mtimeMs: 1, size: 1 }), undefined, async ({ ref }) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    return summary(ref)
  })
  check('1g2. 扫描以有界并发执行（并发 >1 且不超过 16），结果不丢', pooled.length === 40 && peak > 1 && peak <= 16, `peak=${peak}`)
  check('1i. 全量读取：缺失文件报 missing', JSON.stringify(await loadText(join(scratch, 'nope.jsonl'))) === '{"skip":"missing"}'
    && MAX_ARTIFACT_BYTES === 64 * 1024 * 1024)
}

// ── 公共：假 HOME（adapter 经 os.homedir() 定位源目录；Windows 读 USERPROFILE）──
const home = join(scratch, 'home')
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GROK_HOME: process.env.GROK_HOME }
process.env.HOME = home
process.env.USERPROFILE = home
process.env.GROK_HOME = join(home, '.grok')
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
/** scan() 的结果按 sessionKey 排序后的 [sessionKey, title] 摘要，便于断言。 */
const keyed = entries => entries.filter(e => e.summary !== null).map(e => e.summary).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey))

// ── 2. claude-code scan()/load() ────────────────────────────────────────
{
  const { claudeCodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/claude-code.js')
  const project = join(home, '.claude', 'projects', '-w-cc')
  mkdirSync(join(project, 'aaaa', 'subagents'), { recursive: true })
  const line = (sessionId, type, message, extra = {}) => ({ type, sessionId, cwd: '/w/cc', timestamp: '2026-09-01T00:00:00Z', message, ...extra })
  const conversation = (sessionId, prompt) => [
    line(sessionId, 'user', { role: 'user', content: prompt }),
    line(sessionId, 'assistant', { id: `m-${sessionId}`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: '好的' }] }),
  ]
  writeFileSync(join(project, 'aaaa.jsonl'), jsonl([{ type: 'ai-title', aiTitle: '小会话标题', sessionId: 'aaaa' }, ...conversation('aaaa', '小会话提问')]))
  // 大会话：提问在头部，/rename 标题在 256KB 之后的尾部（改名追加，后到者胜）
  const filler = Array.from({ length: 400 }, (_, i) =>
    line('bbbb', 'assistant', { id: `f${i}`, role: 'assistant', content: [{ type: 'text', text: '填充'.repeat(400) }] }))
  writeFileSync(join(project, 'bbbb.jsonl'), jsonl([
    { type: 'custom-title', customTitle: '早期的名字', sessionId: 'bbbb' },
    ...conversation('bbbb', '大会话提问'), ...filler,
    { type: 'custom-title', customTitle: '最后的名字', sessionId: 'bbbb' },
  ]))
  writeFileSync(join(project, 'agent-aux.jsonl'), jsonl(conversation('aaaa', '辅助 transcript')))
  writeFileSync(join(project, 'aaaa', 'subagents', 'agent-1.jsonl'), jsonl(conversation('aaaa', '子代理')))
  writeFileSync(join(project, 'cccc.jsonl'), jsonl([line('cccc', 'user', { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' })]))

  const reported = []
  const entries = await claudeCodeAdapter.scan({ onEntry: s => reported.push(s.sessionKey) })
  const summaries = keyed(entries)
  check('2a. 只列出独立会话：辅助 transcript 与纯注入会话为 null，subagents/ 不遍历',
    summaries.map(s => s.sessionKey).join(',') === 'aaaa,bbbb' && entries.length === 4 && reported.length === 2,
    entries.map(e => `${e.ref.split(/[\\/]/).pop()}:${e.summary?.sessionKey ?? null}`).join(' '))
  check('2b. 摘要标题：小文件取 ai-title；大文件读尾窗口取最后一次 /rename',
    summaries[0].title === '小会话标题' && summaries[1].title === '最后的名字', summaries.map(s => s.title).join(' | '))
  const discovered = claudeCodeAdapter.discover().sessions.map(s => s.sourceId).sort()
  check('2c. scan 的 sessionKey 与 discover 的 sourceId 完全一致', JSON.stringify(summaries.map(s => s.sessionKey)) === JSON.stringify(discovered), discovered.join(','))
  check('2d. 摘要的 cwd/时间：cwd 取行上字段，lastMessageAt 为文件 mtime',
    summaries.every(s => s.cwd === '/w/cc' && s.lastMessageAt === entries.find(e => e.ref === s.ref).fp.mtimeMs))
  const loaded = await claudeCodeAdapter.load(summaries[1].ref)
  const full = claudeCodeAdapter.discover().sessions.find(s => s.sourceId === 'bbbb')
  check('2e. load(ref) 与 discover 的全量解析逐字段一致', JSON.stringify(loaded) === JSON.stringify(full))
  check('2f. load 不是会话的 ref → not-a-session；不存在的 ref → missing',
    (await claudeCodeAdapter.load(join(project, 'agent-aux.jsonl'))).skip === 'not-a-session'
    && (await claudeCodeAdapter.load(join(project, 'gone.jsonl'))).skip === 'missing')
  const rescanned = []
  await claudeCodeAdapter.scan({ cached: (ref, fp) => entries.find(e => e.ref === ref && e.fp.mtimeMs === fp.mtimeMs)?.summary, onEntry: s => rescanned.push(s.sessionKey) })
  check('2g. 指纹未变时整轮命中缓存（含否定结果）仍按会话回报', rescanned.sort().join(',') === 'aaaa,bbbb')
}

// ── 3. codex / grok-build / zcode scan()/load() ─────────────────────────
{
  const { codexAdapter } = await import('../src/dsh-adapter/migrate/adapters/codex.js')
  const { grokBuildAdapter } = await import('../src/dsh-adapter/migrate/adapters/grok-build.js')
  const { zcodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/zcode.js')
  const discoveredKeys = adapter => adapter.discover().sessions.map(s => s.sourceId).sort()

  // codex：主 rollout（首问前有很大的 base_instructions，逼出第二级头窗口）+ 子代理 rollout
  const day = join(home, '.codex', 'sessions', '2026', '09', '01')
  mkdirSync(day, { recursive: true })
  const uuid = n => `0199aaaa-0000-7000-8000-00000000000${n}`
  const meta = (extra = {}) => ({ timestamp: '2026-09-01T00:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/w/codex', timestamp: '2026-09-01T00:00:00Z', base_instructions: '规则'.repeat(20000), ...extra } })
  const item = payload => ({ timestamp: '2026-09-01T00:00:01Z', type: 'response_item', payload })
  const ask = text => item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>env</environment_context>' }, { type: 'input_text', text }] })
  writeFileSync(join(day, `rollout-2026-09-01T00-00-00-${uuid(1)}.jsonl`), jsonl([meta(), ask('Codex 主会话提问'), item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答' }] })]))
  writeFileSync(join(day, `rollout-2026-09-01T00-00-01-${uuid(2)}.jsonl`), jsonl([meta({ thread_source: 'subagent' }), ask('子代理任务')]))
  const codexEntries = await codexAdapter.scan()
  const codexSummaries = keyed(codexEntries)
  check('3a. codex：子代理 rollout 为 null；首问在 32KB 之外也能取到；注入块不进标题',
    codexEntries.length === 2 && codexSummaries.length === 1 && codexSummaries[0].title === 'Codex 主会话提问' && codexSummaries[0].cwd === '/w/codex',
    codexSummaries.map(s => s.title).join('|'))
  check('3b. codex：sessionKey 等于 discover 的 sourceId（文件名中的 uuid）',
    JSON.stringify(codexSummaries.map(s => s.sessionKey)) === JSON.stringify(discoveredKeys(codexAdapter)) && codexSummaries[0].sessionKey === uuid(1))
  check('3c. codex：load(ref) 与 discover 逐字段一致',
    JSON.stringify(await codexAdapter.load(codexSummaries[0].ref)) === JSON.stringify(codexAdapter.discover().sessions[0]))

  // grok：一个有真实提问的会话目录 + 一个只有注入的会话目录
  const grokSession = (id, rows, summary = {}) => {
    const dir = join(home, '.grok', 'sessions', '%2Fw%2Fgrok', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd: '/w/grok' }, created_at: '2026-09-01T00:00:00Z', ...summary }))
    writeFileSync(join(dir, 'chat_history.jsonl'), jsonl(rows))
    return dir
  }
  const grokDir = grokSession('grok-1', [
    { type: 'user', content: [{ type: 'text', text: '<user_info>OS</user_info>' }] },
    { type: 'user', content: [{ type: 'text', text: '<user_query>Grok 提问</user_query>' }] },
    { type: 'assistant', content: '答', model_id: 'grok-x' },
  ], { session_summary: 'Grok 会话标题' })
  grokSession('grok-2', [{ type: 'user', content: [{ type: 'text', text: '<user_info>OS</user_info>' }] }])
  const grokEntries = await grokBuildAdapter.scan()
  const grokSummaries = keyed(grokEntries)
  check('3d. grok：一个目录一个条目，ref 是会话目录；只有注入的会话为 null；标题取 session_summary',
    grokEntries.length === 2 && grokSummaries.length === 1 && grokSummaries[0].ref === grokDir && grokSummaries[0].title === 'Grok 会话标题')
  check('3e. grok：sessionKey 等于 discover 的 sourceId（info.id），load 与 discover 一致',
    JSON.stringify(grokSummaries.map(s => s.sessionKey)) === JSON.stringify(discoveredKeys(grokBuildAdapter))
    && JSON.stringify(await grokBuildAdapter.load(grokDir)) === JSON.stringify(grokBuildAdapter.discover().sessions[0]))
  const before = grokEntries.find(e => e.ref === grokDir).fp
  writeFileSync(join(grokDir, 'summary.json'), JSON.stringify({ info: { id: 'grok-1', cwd: '/w/grok' }, session_summary: '改过的标题 更长一些' }))
  const after = (await grokBuildAdapter.scan()).find(e => e.ref === grokDir).fp
  check('3f. grok：指纹复合两个文件，只改 summary.json 也会失效', before.size !== after.size || before.mtimeMs !== after.mtimeMs)

  // zcode：{meta, messages} 文档 + 一个坏文档
  const zdir = join(home, '.zcode', 'v2', 'sessions', 'w')
  mkdirSync(zdir, { recursive: true })
  writeFileSync(join(zdir, 'task-9.json'), JSON.stringify({ meta: { taskId: 'task-9', workspacePath: '/w/zc', title: 'zcode 标题', createdAt: 1790000000000 }, messages: [{ role: 'user', content: 'zcode 提问' }, { role: 'assistant', content: '答' }] }))
  writeFileSync(join(zdir, 'broken.json'), '{')
  const zcEntries = await zcodeAdapter.scan()
  const zcSummaries = keyed(zcEntries)
  check('3g. zcode：整读解析，坏文档为 null；sessionKey 等于 meta.taskId，load 与 discover 一致',
    zcEntries.length === 2 && zcSummaries.length === 1 && zcSummaries[0].title === 'zcode 标题' && zcSummaries[0].createdAt === 1790000000000
    && JSON.stringify(zcSummaries.map(s => s.sessionKey)) === JSON.stringify(discoveredKeys(zcodeAdapter))
    && JSON.stringify(await zcodeAdapter.load(zcSummaries[0].ref)) === JSON.stringify(zcodeAdapter.discover().sessions[0]))
}

// ── 4. browse：存在性探测、进程内复用、generation 保护、不落盘 ─────────
{
  const { utimesSync } = await import('node:fs')
  const { createForeignBrowser } = await import('../src/dsh-adapter/migrate/browse.js')
  const { claudeCodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/claude-code.js')
  const { codexAdapter } = await import('../src/dsh-adapter/migrate/adapters/codex.js')
  const { grokBuildAdapter } = await import('../src/dsh-adapter/migrate/adapters/grok-build.js')
  const { zcodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/zcode.js')
  const { ompAdapter } = await import('../src/dsh-adapter/migrate/adapters/omp.js')

  // 记录 cached 命中次数：命中 = 这次没有重读该条目
  let hits = 0
  const spied = {
    ...claudeCodeAdapter,
    scan: options => claudeCodeAdapter.scan({
      ...options,
      cached: (ref, fp) => {
        const known = options?.cached?.(ref, fp)
        if (known !== undefined) hits += 1
        return known
      },
    }),
  }
  const adapters = [spied, codexAdapter, ompAdapter, zcodeAdapter, grokBuildAdapter]
  const browser = createForeignBrowser(() => undefined, undefined, adapters)

  const sources = await browser.listSources()
  check('4a. 探测只列可浏览且有候选的来源（omp 不在），按注册顺序，只带 id 与名称',
    sources.map(s => s.agentId).join(',') === 'claude-code,codex,zcode,grok-build'
    && sources.every(s => Object.keys(s).sort().join(',') === 'agentId,label'),
    JSON.stringify(sources))

  // 探测走到第一个候选即停：一个有 50 个候选的来源，match 只被问到第一个
  const crowded = join(scratch, 'crowded')
  mkdirSync(crowded, { recursive: true })
  for (let i = 0; i < 50; i++) writeFileSync(join(crowded, `s${i}.jsonl`), '')
  let asked = 0
  const probeOnly = {
    id: 'crowded', label: 'Crowded', roots: () => [crowded], discover: () => ({ roots: [], sessions: [] }),
    walk: { maxDepth: 1, match: () => { asked += 1; return true } },
    scan: async () => [], load: async () => ({ skip: 'missing' }),
  }
  const probed = await createForeignBrowser(() => undefined, undefined, [probeOnly]).listSources()
  check('4a2. 存在性探测在第一个候选处停止，不遍历、不 stat 整个来源', probed.length === 1 && asked === 1, `asked=${asked}`)

  const streamed = []
  const rows = await browser.listSessions('claude-code', row => streamed.push(row.key))
  check('4b. 会话按最近活动降序，否定结果不出现，逐条回报',
    rows.length === 2 && streamed.length === 2 && rows[0].updatedAt >= rows[1].updatedAt, JSON.stringify(rows.map(r => r.title)))
  check('4b2. 行只有 agentId/key/title/cwd/updatedAt，不暴露 sessionKey、指纹等来源格式',
    rows.every(row => Object.keys(row).sort().join(',') === 'agentId,cwd,key,title,updatedAt'), Object.keys(rows[0]).join(','))

  hits = 0
  await browser.listSessions('claude-code')
  check('4c. 同一进程内再次列出：指纹未变的条目（含否定结果）全部复用，不重读', hits === 4, `hits=${hits}`)
  const aaaa = join(home, '.claude', 'projects', '-w-cc', 'aaaa.jsonl')
  utimesSync(aaaa, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  hits = 0
  const changed = await browser.listSessions('claude-code')
  check('4d. 指纹变化的条目重新读取，排序随之更新', hits === 3 && changed[0].title === '小会话标题', `hits=${hits}`)

  // generation 保护：先发起的慢扫描晚于后发起的快扫描完成时，不覆盖新结果
  let release
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  const summary = key => ({ agentId: 'fake', sessionKey: key, ref: key, title: key, cwd: '', lastMessageAt: 0, createdAt: 0 })
  const fake = {
    id: 'fake', label: 'Fake', roots: () => [], discover: () => ({ roots: [], sessions: [] }),
    walk: { maxDepth: 0, match: () => false },
    load: async () => ({ skip: 'missing' }),
    scan: async () => {
      calls += 1
      if (calls === 1) {
        await gate
        return [{ ref: 'old', fp: { mtimeMs: 1, size: 1 }, summary: summary('old') }]
      }
      return [{ ref: 'new', fp: { mtimeMs: 2, size: 2 }, summary: summary('new') }]
    },
  }
  const raced = createForeignBrowser(() => undefined, undefined, [fake])
  const slow = raced.listSessions('fake')
  const fast = await raced.listSessions('fake')
  release()
  const late = await slow
  check('4e. 晚到的旧扫描不覆盖新结果', fast[0]?.key === 'new' && late[0]?.key === 'new')

  const controller = new AbortController()
  const aborting = createForeignBrowser(() => undefined, controller.signal, adapters)
  await aborting.listSessions('claude-code')
  controller.abort()
  const afterAbort = await aborting.listSessions('claude-code')
  check('4f. channel 释放后的列出返回已知结果而不抛出', afterAbort.length === 2)
  check('4g. 浏览不写任何长期状态（HOME 下没有 ~/.dsh-tui）', !existsSync(join(home, '.dsh-tui')))
}

// ── 5. 单会话导入（官方 JsonlSessionPersistence）────────────────────────
{
  const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { Context } = await import('@deepseek-ai/cordis')
  const { importForeignSession, createForeignImporter } = await import('../src/dsh-adapter/migrate/import-one.js')
  const { importSessions, migrationSessionId } = await import('../src/dsh-adapter/migrate/index.js')
  const { claudeCodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/claude-code.js')
  const root = join(scratch, 'dsh-sessions')
  const ctx = new Context()
  const fiber = ctx.plugin(JsonlSessionPersistence, { root })
  for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) await new Promise(resolve => setTimeout(resolve, 50))
  const persistence = ctx.get('sessionPersistence')

  const listed = (await claudeCodeAdapter.scan()).map(e => e.summary).filter(Boolean)
  const target = listed.find(s => s.sessionKey === 'aaaa')
  const request = { sessionKey: target.sessionKey, ref: target.ref, cwd: '' }
  const cwdExists = () => true
  const first = await importForeignSession(persistence, claudeCodeAdapter, request, { cwdExists })
  const full = claudeCodeAdapter.discover().sessions.find(s => s.sourceId === 'aaaa')
  check('5a. 首次导入写入会话，id 与 /migrate 的确定性 id 相同',
    first.kind === 'ready' && first.created === true && first.sessionId === migrationSessionId(claudeCodeAdapter, full), JSON.stringify(first))
  const second = await importForeignSession(persistence, claudeCodeAdapter, request, { cwdExists })
  const batch = await importSessions(claudeCodeAdapter, root, [full])
  check('5b. 再次选中直接打开不重写；/migrate 入口把它识别为已存在',
    second.kind === 'ready' && second.created === false && second.sessionId === first.sessionId && batch.existing === 1 && batch.imported === 0)
  const handle = await persistence.open(first.sessionId, 'read')
  const { events } = await handle.read()
  await handle.close()
  check('5c. 落盘内容可经官方读取链读回（标题事件在内）',
    events.some(e => e.type === 'user/message' && e.data.content?.[0]?.text === '小会话提问')
    && events.some(e => e.type === 'session/title' && e.data.title === '小会话标题'))

  const other = listed.find(s => s.sessionKey === 'bbbb')
  const missingCwd = await importForeignSession(persistence, claudeCodeAdapter, { sessionKey: 'bbbb', ref: other.ref, cwd: '/w/cc' }, { cwdExists: () => false })
  check('5d. 工作目录不存在时不导入', missingCwd.kind === 'cwd-missing' && missingCwd.cwd === '/w/cc'
    && await persistence.stat(migrationSessionId(claudeCodeAdapter, { sourceId: 'bbbb' })) === undefined)
  const skipped = await importForeignSession(persistence, claudeCodeAdapter, { sessionKey: 'gone', ref: join(home, 'gone.jsonl'), cwd: '' }, { cwdExists })
  check('5e. 源文件已消失 → failed(missing)', skipped.kind === 'failed' && skipped.reason === 'missing')

  // 写入失败：不留半截日志，结果如实报告
  const discarded = []
  const broken = {
    stat: async () => undefined,
    list: async () => [],
    create: async () => ({ append: async () => { throw new Error('disk full') }, flush: async () => {}, close: async () => {} }),
  }
  const failed = await importForeignSession(broken, claudeCodeAdapter, { sessionKey: 'bbbb', ref: other.ref, cwd: '' }, { cwdExists, discard: id => discarded.push(id) })
  check('5f. 写入失败时清理半截日志并报告原因',
    failed.kind === 'failed' && failed.reason === 'write-failed' && failed.detail === 'disk full' && discarded.length === 1)

  // create 竞态：exists 检查与 create 之间，别的写入者（/migrate 批量、另一个
  // TUI）已把同一个确定性 id 落盘——失败路径绝不能删掉对方的完整会话。
  const racedDiscard = []
  let raceLost = false
  const raced = {
    stat: async id => (raceLost ? { header: { id } } : undefined),
    list: async () => [],
    create: async () => { raceLost = true; throw new Error('session already exists') },
  }
  const racedResult = await importForeignSession(raced, claudeCodeAdapter, { sessionKey: 'bbbb', ref: other.ref, cwd: '' }, { cwdExists, discard: id => racedDiscard.push(id) })
  check('5f2. create 输掉并发竞态时打开已存在的会话，而不是删掉它',
    racedResult.kind === 'ready' && racedResult.created === false && racedDiscard.length === 0,
    JSON.stringify(racedResult) + ` discarded=[${racedDiscard.join(',')}]`)

  // 防重入：同一会话连续两次选中只写一次
  let creates = 0
  const counting = {
    stat: async () => undefined, list: async () => [],
    create: async header => { creates += 1; return persistence.create(header) },
  }
  const importer = createForeignImporter(() => counting, { cwdExists })
  const a = importer.import(claudeCodeAdapter, { sessionKey: 'bbbb', ref: other.ref, cwd: '' })
  const b = importer.import(claudeCodeAdapter, { sessionKey: 'bbbb', ref: other.ref, cwd: '' })
  const [ra, rb] = await Promise.all([a, b])
  check('5g. 同一会话正在导入时再次选中并入同一次导入，只写一次',
    a === b && creates === 1 && ra.kind === 'ready' && rb === ra)
  // 同一源里两个产物带同一个源 id（Claude 会话在另一个项目目录里续写）：
  // 按身份去重，第二个并入第一个；按 ref 去重会并发写同一个 id，失败方的
  // 清理会删掉胜者的日志。
  creates = 0
  const twin = join(home, '.claude', 'projects', '-w-cc-copy', 'bbbb.jsonl')
  mkdirSync(join(home, '.claude', 'projects', '-w-cc-copy'), { recursive: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(other.ref, twin)
  const fresh = createForeignImporter(() => counting, { cwdExists })
  const c = fresh.import(claudeCodeAdapter, { sessionKey: 'bbbb', ref: other.ref, cwd: '' })
  const d = fresh.import(claudeCodeAdapter, { sessionKey: 'bbbb', ref: twin, cwd: '' })
  await Promise.all([c, d])
  check('5g2. 不同 ref、同一会话身份的并发导入并入一次，不会并发写同一个 id', c === d && creates <= 1, `creates=${creates}`)
  rmSync(join(home, '.claude', 'projects', '-w-cc-copy'), { recursive: true, force: true })
  const unavailable = await createForeignImporter(() => undefined).import(claudeCodeAdapter, request)
  check('5h. 宿主没有持久化服务时报告失败而不是抛出', unavailable.kind === 'failed')
  await Promise.resolve(fiber.dispose()).catch(() => {})
}

// ── 6. channel 接线：三个方法经 browse 导入到宿主持久化 ─────────────────
{
  const { createForeignBrowser } = await import('../src/dsh-adapter/migrate/browse.js')
  const { CHANNEL_UI_EFFECTS } = await import('../src/adapter/channel/ui-policy.js')
  const writes = []
  const persistence = {
    stat: async () => undefined,
    list: async () => [],
    create: async header => {
      writes.push(header.id)
      return { append: async () => {}, flush: async () => {}, close: async () => {} }
    },
  }
  // 一个工作目录真实存在的会话（其余 fixture 的 cwd 是虚构路径）
  writeFileSync(join(home, '.claude', 'projects', '-w-cc', 'dddd.jsonl'), jsonl([
    { type: 'user', sessionId: 'dddd', cwd: home, timestamp: '2026-09-02T00:00:00Z', message: { role: 'user', content: '可导入的会话' } },
    { type: 'assistant', sessionId: 'dddd', cwd: home, timestamp: '2026-09-02T00:00:01Z', message: { id: 'md', role: 'assistant', content: [{ type: 'text', text: '好' }] } },
  ]))
  const browser = createForeignBrowser(() => persistence)
  const sources = await browser.listSources()
  check('6a. 默认注册表下探测列出四个可浏览来源（不含 omp）',
    sources.map(s => s.agentId).join(',') === 'claude-code,codex,zcode,grok-build', sources.map(s => s.agentId).join(','))
  const rows = await browser.listSessions('claude-code')
  const byTitle = title => rows.find(row => row.title === title)
  const missing = await browser.importSession('claude-code', byTitle('最后的名字').key)
  check('6b. 行上的 cwd 不存在时不导入', missing.kind === 'cwd-missing' && missing.cwd === '/w/cc' && writes.length === 0)
  const outcome = await browser.importSession('claude-code', byTitle('可导入的会话').key)
  check('6c. 导入经宿主 sessionPersistence 写入', outcome.kind === 'ready' && outcome.created === true && writes.length === 1)
  const unknown = await browser.importSession('omp', byTitle('可导入的会话').key)
  check('6d. 不可浏览的来源报告 unknown-source', unknown.kind === 'failed' && unknown.reason === 'unknown-source')
  const classes = ['listForeignSources', 'listForeignSessions', 'importForeignSession'].map(name => CHANNEL_UI_EFFECTS[name])
  check('6e. 三个方法都登记了副作用分类（导入为 mutate）', classes.join(',') === 'read-only,read-only,mutate', classes.join(','))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
rmSync(scratch, { recursive: true, force: true })
console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate browse regression passed (${checks} checks)`)
