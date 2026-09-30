/**
 * verify-migrate-parse — 迁移源解析层回归（纯函数，合成 fixture，不读本机数据）。
 *
 * 覆盖 src/dsh-adapter/migrate/parse/ 与各源 *.parse.ts：注入识别与包装剥离、
 * 标题归一、工具调用配对，以及 docs/foreign-session-tabs-design.md §4.3 的
 * 逐源规则。fixture 全部是手写的合成数据，不提交任何真实会话内容。
 * 事件落盘与续聊链路见 scripts/verify-migrate.mjs。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate-parse.mjs
 */
const { parseJsonl, isRecord } = await import('../src/dsh-adapter/migrate/parse/jsonl.js')

let checks = 0
function check(name, ok, extra = '') {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

// ── 1. jsonl ────────────────────────────────────────────────────────────
{
  const raw = [
    JSON.stringify({ type: 'a' }),
    'null',
    '42',
    '"text"',
    '[1,2]',
    '{"type":"broken"',
    '',
    '   ',
    `${JSON.stringify({ type: 'b' })}\r`,
    'not json at all',
  ].join('\n')
  const { records, badLines } = parseJsonl(raw)
  check('1a. 只保留对象行且保持顺序', records.map(r => r.type).join(',') === 'a,b', JSON.stringify(records))
  check('1b. 合法的 null / 标量 / 数组行静默跳过，坏行计数', badLines === 2, `badLines=${badLines}`)
  check('1c. CRLF 行尾可解析', records[1]?.type === 'b')
  check('1d. isRecord 拒绝 null 与数组', !isRecord(null) && !isRecord([]) && isRecord({}))
  check('1e. 空文档 → 零行零坏行', parseJsonl('').records.length === 0 && parseJsonl('').badLines === 0)
}

// ── 2. 注入识别与包装剥离 ───────────────────────────────────────────────
{
  const { isInjectedText, unwrapUserText, stripSystemReminders, isInterruptNotice } =
    await import('../src/dsh-adapter/migrate/parse/injection.js')
  const injected = [
    '<environment_context>\n  <cwd>/tmp/x</cwd>\n</environment_context>',
    '  <system-reminder>提醒</system-reminder>',
    '<USER_INSTRUCTIONS>大写也算</USER_INSTRUCTIONS>',
    '<local-command-caveat>Caveat</local-command-caveat>',
    '<local-command-stdout>ok</local-command-stdout>',
    '<command-name>/model</command-name>',
    '<permissions>…</permissions>',
    '<user_info>OS: linux</user_info>',
    '# AGENTS.md instructions for /tmp/x\n\n<INSTRUCTIONS>…',
    '# Context from my IDE setup:\n\n## Open tabs',
  ]
  const missed = injected.filter(text => !isInjectedText(text))
  check('2a. 注入前缀表逐条命中（大小写不敏感、允许前导空白）', missed.length === 0, missed.join(' | '))
  check('2b. 真实提问不误判（正文中间出现标签不算注入）',
    !isInjectedText('请看 <system-reminder> 这个标签') && !isInjectedText('# 标题\n正文'))
  check('2c. <user_query> 只留正文', unwrapUserText('<user_query>\n修一下构建\n</user_query>') === '修一下构建')
  check('2d. 中断包装只留 <user_query> 正文',
    unwrapUserText('The user interrupted the previous turn: stop.\n<user_query>换个思路</user_query>') === '换个思路')
  check('2e. 插话包装只留 <user_query> 正文',
    unwrapUserText('The user sent a message while you were working:\n<user_query>顺便加测试</user_query>') === '顺便加测试')
  check('2f. 无 <user_query> 的包装去掉通知行首',
    unwrapUserText('The user sent a message while you were working: 顺便加测试') === '顺便加测试')
  check('2g. 未闭合的 <user_query> 取到末尾', unwrapUserText('<user_query>半截') === '半截')
  check('2h. 粘贴信封去标签留正文（含无闭标签形态）',
    unwrapUserText('看这段 <pasted_content id="p1">A\nB</pasted_content id="p1"> 怎么改') === '看这段 A\nB 怎么改'
    && unwrapUserText('<pasted_content id="p2">只有开标签') === '只有开标签')
  check('2i. 纯文本快速路径原样（仅去首尾空白）', unwrapUserText('  普通提问  ') === '普通提问')
  check('2j. system-reminder 行内剥离（多段、未闭合吞到末尾）',
    stripSystemReminders('前<system-reminder>a</system-reminder>中<system-reminder>b</system-reminder>后') === '前中后'
    && stripSystemReminders('正文<system-reminder>未闭合') === '正文')
  check('2k. 中断通知识别', isInterruptNotice('The user interrupted the previous turn: x') && !isInterruptNotice('interrupted'))
  // 线性扫描守卫：大量未闭合开标签不应退化为二次方
  const hostile = '<system-reminder>'.repeat(20000)
  const started = performance.now()
  stripSystemReminders(hostile)
  unwrapUserText('<user_query>'.repeat(20000))
  const elapsed = performance.now() - started
  check('2l. 敌意输入（2 万个未闭合开标签）线性完成', elapsed < 500, `${elapsed.toFixed(1)}ms`)
}

// ── 3. 标题归一 ─────────────────────────────────────────────────────────
{
  const { normalizeTitle, TITLE_MAX_CHARS } = await import('../src/dsh-adapter/migrate/parse/title.js')
  check('3a. 折叠空白为单行', normalizeTitle('  修复\n\n构建\t脚本  ') === '修复 构建 脚本')
  check('3b. 空白与 undefined → 空串', normalizeTitle(' \n ') === '' && normalizeTitle(undefined) === '')
  const long = '题'.repeat(TITLE_MAX_CHARS + 5)
  const cut = normalizeTitle(long)
  check('3c. 超长截断到上限并以 … 结尾', Array.from(cut).length === TITLE_MAX_CHARS && cut.endsWith('…'), cut)
  check('3d. 恰好上限不截断', normalizeTitle('字'.repeat(TITLE_MAX_CHARS)) === '字'.repeat(TITLE_MAX_CHARS))
  const emoji = normalizeTitle('🎏'.repeat(TITLE_MAX_CHARS + 1))
  check('3e. 按码点截断，不拆代理对', emoji.isWellFormed() && Array.from(emoji).length === TITLE_MAX_CHARS)
}

// ── 4. 工具调用配对 ─────────────────────────────────────────────────────
{
  const { CallIndex, closeToolPairs, clampToolText, newStep, TOOL_RESULT_MAX_BYTES } =
    await import('../src/dsh-adapter/migrate/parse/tools.js')
  const call = (id, name = 'read') => ({ type: 'tool-call', id, name, arguments: '{}' })
  // Claude 形态：两条连续 assistant 各带一个调用，结果在两步之后才到，且乱序
  const s1 = newStep('m1')
  s1.blocks.push({ type: 'text', text: '先读两个文件' }, call('a'), call('b'))
  const s2 = newStep()
  s2.blocks.push(call('c'))
  const index = new CallIndex()
  index.register(s1)
  index.register(s2)
  index.attach('c', 'C 的结果', false)
  index.attach('b', 'B 的结果', true)
  index.attach('a', 'A 的结果', false)
  const orphan = index.attach('zz', '孤儿', false)
  check('4a. 迟到结果挂回发起调用的那一步（不是最近一步）',
    s1.results.map(r => r.callId).sort().join(',') === 'a,b' && s2.results.map(r => r.callId).join(',') === 'c')
  check('4b. 找不到调用的结果丢弃并计数', orphan === false && index.orphans === 1)
  const turns = [{ prompt: 'q', steps: [s1, s2] }]
  closeToolPairs(turns)
  check('4c. 同一步内结果按调用顺序排列', s1.results.map(r => r.callId).join(',') === 'a,b')
  check('4d. isError 原样保留', s1.results[1].isError === true && s1.results[0].isError === false)

  // 无结果的调用补空结果；重复结果只留第一条；不属于本步的结果丢弃
  const s3 = newStep()
  s3.blocks.push(call('x'), call('y'))
  s3.results.push({ callId: 'y', text: 'Y1', isError: false }, { callId: 'y', text: 'Y2', isError: false },
    { callId: 'stray', text: '?', isError: false })
  const dropped = closeToolPairs([{ prompt: 'q', steps: [s3] }])
  check('4e. 无结果的调用补空结果，每个调用恰好一条结果',
    s3.results.length === 2 && s3.results[0].callId === 'x' && s3.results[0].text === '' && s3.results[1].text === 'Y1')
  check('4f. 重复结果与游离结果计入丢弃', dropped === 2, `dropped=${dropped}`)

  // 跨步复用同一 call id：后者改名，结果随之改名
  const r1 = newStep()
  r1.blocks.push(call('dup'))
  r1.results.push({ callId: 'dup', text: '第一次', isError: false })
  const r2 = newStep()
  r2.blocks.push(call('dup'))
  r2.results.push({ callId: 'dup', text: '第二次', isError: false })
  closeToolPairs([{ prompt: 'q', steps: [r1] }, { prompt: 'q2', steps: [r2] }])
  check('4g. 跨步重复的 call id 改名且结果跟随',
    r1.blocks[0].id === 'dup' && r2.blocks[0].id === 'dup#2' && r2.results[0].callId === 'dup#2' && r2.results[0].text === '第二次')

  // 64KB 截断：按字符边界，注明截掉的字节数
  const big = '汉'.repeat(TOOL_RESULT_MAX_BYTES)
  const clamped = clampToolText(big)
  const kept = clamped.slice(0, clamped.indexOf('…[truncated'))
  check('4h. 超长结果按 UTF-8 字节截断且不拆字符',
    Buffer.byteLength(kept) <= TOOL_RESULT_MAX_BYTES && kept.isWellFormed() && !kept.includes('\uFFFD')
    && /…\[truncated \d+ bytes\]$/u.test(clamped), clamped.slice(-30))
  check('4i. 未超限原样', clampToolText('短结果') === '短结果')
}

// ── 5. 角色列表折叠（旧形态机械适配）──────────────────────────────────────
{
  const { fromRoleTurns, messageCount } = await import('../src/dsh-adapter/migrate/parse/role-turns.js')
  const list = [
    { role: 'assistant', text: '孤立开场白', time: 0 },
    { role: 'user', text: '问一', time: 0 },
    { role: 'assistant', text: '答一', reasoning: '想一', model: 'm', time: 0 },
    { role: 'assistant', text: '', reasoning: '只有思考', time: 0 },
    { role: 'user', text: '尾问', time: 0 },
  ]
  const turns = fromRoleTurns(list)
  check('5a. 开头的 assistant 开无提问轮，user 开新轮，尾问成无步轮',
    turns.length === 3 && turns[0].prompt === '' && turns[0].steps.length === 1
    && turns[1].prompt === '问一' && turns[1].steps.length === 2 && turns[2].steps.length === 0)
  check('5b. 步内 reasoning 先于正文，model 落到步上',
    JSON.stringify(turns[1].steps[0].blocks) === JSON.stringify([{ type: 'reasoning', text: '想一' }, { type: 'text', text: '答一' }])
    && turns[1].steps[0].model === 'm' && turns[1].steps[1].blocks.length === 1)
  check('5c. messageCount 与角色列表长度一致', messageCount({ turns }) === list.length, String(messageCount({ turns })))
}

// ── 6. claude-code ──────────────────────────────────────────────────────
const { parseClaudeTranscript } = await import('../src/dsh-adapter/migrate/adapters/claude-code.parse.js')
const SID = '77777777-7777-4777-8777-777777777777'
/** Claude Code 行：公共字段 + 覆盖项。 */
const ccLine = (type, message, extra = {}) =>
  JSON.stringify({ type, sessionId: SID, cwd: '/w/cc', timestamp: '2026-09-01T00:00:00Z', message, ...extra })
const ccUser = (content, extra) => ccLine('user', { role: 'user', content }, extra)
const ccAsst = (id, content, extra) => ccLine('assistant', { id, role: 'assistant', model: 'claude-x', content }, extra)
const ccParse = lines => parseClaudeTranscript({ raw: lines.join('\n'), fileStem: SID, fallbackCwd: '/fallback' })
{
  const session = ccParse([
    ccUser('第一问<system-reminder>机器提醒</system-reminder>'),
    // 同一次响应拆成三行（thinking / text / 仅 tool_use），合并为一步
    ccAsst('msg_1', [{ type: 'thinking', thinking: '想一想' }]),
    ccAsst('msg_1', [{ type: 'text', text: '回答' }]),
    ccAsst('msg_2', [{ type: 'text', text: '第二次调用' }]),
    ccUser([{ type: 'text', text: '第二问' }]),
    ccAsst('msg_3', 'plain string content'),
    ccLine('assistant', null),
    '{broken',
  ])
  const [t1, t2] = session.turns
  check('6a. 同一 message.id 的多行合并为一步，不同 id 各为一步',
    t1.steps.length === 2 && JSON.stringify(t1.steps[0].blocks) === JSON.stringify([{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '回答' }]))
  check('6b. 提问剥掉行内 system-reminder；数组形态的提问同样开轮',
    t1.prompt === '第一问' && t2.prompt === '第二问' && t2.steps[0].blocks[0].text === 'plain string content')
  check('6c. 每步记录 message.model；cwd 取行上字段；坏行计数',
    t1.steps[0].model === 'claude-x' && session.cwd === '/w/cc' && session.stats.badLines === 1 && session.sourceId === SID)
  check('6d. 没有任何人类提问的 transcript 不成会话', ccParse([ccAsst('m', [{ type: 'text', text: '独白' }])]) === undefined)
}

{
  // Claude 形态：一次响应里两个 tool_use 各占一行，结果在两行之后才到、乱序，
  // 且一个是字符串内容、一个是含图片的块数组；另有一条找不到调用的孤儿结果
  const session = ccParse([
    ccUser('改两个文件'),
    ccAsst('msg_1', [{ type: 'text', text: '先读' }]),
    ccAsst('msg_1', [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: 'a.ts' } }]),
    ccAsst('msg_1', [{ type: 'tool_use', id: 'tu_b', name: 'Read', input: { file_path: 'b.ts' } }]),
    ccUser([{ type: 'tool_result', tool_use_id: 'tu_b', content: [{ type: 'text', text: 'B 正文' }, { type: 'image', source: { data: 'AAAA' } }] }]),
    ccUser([{ type: 'tool_result', tool_use_id: 'tu_a', content: 'A 正文', is_error: true }]),
    ccUser([{ type: 'tool_result', tool_use_id: 'tu_ghost', content: '孤儿' }]),
    ccAsst('msg_2', [{ type: 'tool_use', id: 'tu_c', name: 'Bash', input: { command: 'ls' } }]),
    ccAsst('msg_3', [{ type: 'text', text: '改完了' }]),
  ])
  const [step1, step2, step3] = session.turns[0].steps
  check('6e. tool_use 成为 tool-call 块，参数为 input 的 JSON',
    step1.blocks.filter(b => b.type === 'tool-call').map(b => `${b.id}:${b.name}:${b.arguments}`).join('|')
      === 'tu_a:Read:{"file_path":"a.ts"}|tu_b:Read:{"file_path":"b.ts"}')
  check('6f. 结果按 id 挂回发起调用的步、按调用顺序；字符串与块数组两种形态都取文本',
    step1.results.map(r => `${r.callId}:${r.text}:${r.isError}`).join('|') === 'tu_a:A 正文:true|tu_b:B 正文\n[image]:false',
    JSON.stringify(step1.results))
  check('6g. 没有结果的调用补空结果；孤儿结果计入 droppedToolResults',
    step2.results.length === 1 && step2.results[0].text === '' && session.stats.droppedToolResults === 1 && step3.results.length === 0)
}

{
  // isMeta 与命令回显：真实转录里的几种机器文本
  const session = ccParse([
    // 本地命令：caveat(isMeta) + 命令回显 + stdout，模型没有回复 → 整体不导入
    ccUser('<local-command-caveat>Caveat: generated while running local commands</local-command-caveat>', { isMeta: true }),
    ccUser('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    ccUser('<local-command-stdout>Set model to opus</local-command-stdout>'),
    ccUser('真实提问'),
    ccAsst('msg_1', [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'review' } }]),
    ccUser([{ type: 'tool_result', tool_use_id: 'tu_skill', content: 'Launching skill: review' }]),
    // skill 正文与图片说明以 isMeta 出现在一轮中间 → 下一步的输入，不开新轮
    ccUser([{ type: 'text', text: 'Base directory for this skill: /skills/review' }], { isMeta: true }),
    ccUser([{ type: 'text', text: '[Image: source: /tmp/shot.png]' }, { type: 'image', source: { data: 'AAAA' } }], { isMeta: true }),
    ccAsst('msg_2', [{ type: 'text', text: '按 skill 审查' }]),
    // 会调用模型的命令（skill 命令）：回显还原成 /name args 并正常成轮
    ccUser('<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>src/</command-args>'),
    ccUser('Base directory for this skill: /skills/review', { isMeta: true }),
    ccAsst('msg_3', [{ type: 'text', text: '开始审查 src/' }]),
    // 纯图片提问保留占位
    ccUser([{ type: 'image', source: { data: 'BBBB' } }]),
    ccAsst('msg_4', [{ type: 'text', text: '这是一张截图' }]),
  ])
  const prompts = session.turns.map(turn => turn.prompt)
  check('6h. 本地命令（caveat/回显/stdout，无模型回复）不成轮',
    prompts.join('|') === '真实提问|/review src/|[image]', prompts.join('|'))
  const [, step2] = session.turns[0].steps
  check('6i. 轮中途的 isMeta 成为下一步的输入，不开新轮；图片换占位',
    session.turns[0].steps.length === 2
    && JSON.stringify(step2.inputs) === JSON.stringify(['Base directory for this skill: /skills/review', '[Image: source: /tmp/shot.png]\n\n[image]']),
    JSON.stringify(step2.inputs))
  check('6j. 命令轮后的 isMeta 进入该轮首步输入', session.turns[1].steps[0].inputs.length === 1)
  check('6k. 过滤与折叠计数：caveat + stdout + 无回复命令轮 → filtered 3，isMeta 折叠 3',
    session.stats.filtered === 3 && session.stats.meta === 3, JSON.stringify(session.stats))
}

{
  // ghost retry：一次响应的调用没等到结果，下一次响应原样重发同一 call id
  const call = { type: 'tool_use', id: 'tu_same', name: 'Bash', input: { command: 'make' } }
  const session = ccParse([
    ccUser('构建一下'),
    ccAsst('msg_ghost', [call]),
    ccAsst('msg_retry', [{ type: 'text', text: '重试' }]),
    ccAsst('msg_retry', [call]),
    ccUser([{ type: 'tool_result', tool_use_id: 'tu_same', content: 'ok' }]),
    // 参数不同的重复 id 不是 ghost：保留两步，由 closeToolPairs 改名去重
    ccAsst('msg_x', [{ type: 'tool_use', id: 'tu_diff', name: 'Bash', input: { command: 'a' } }]),
    ccAsst('msg_y', [{ type: 'tool_use', id: 'tu_diff', name: 'Bash', input: { command: 'b' } }]),
  ])
  const steps = session.turns[0].steps
  check('6l. 原样重发的前一步被删除，结果留在重发步',
    steps[0].blocks.map(b => b.type).join(',') === 'text,tool-call' && steps[0].results[0]?.text === 'ok')
  check('6m. 参数不同的同 id 调用不当作 ghost，改名后两步都保留',
    steps.length === 3 && steps[1].blocks[0].id === 'tu_diff' && steps[2].blocks[0].id === 'tu_diff#2')
}

{
  // 压缩边界：isCompactSummary 的 user 行是摘要，不是提问
  const session = ccParse([
    ccUser('压缩前的提问'),
    ccAsst('msg_1', [{ type: 'text', text: '压缩前的回答' }]),
    ccUser('This session is being continued from a previous conversation. Summary: 做了 A 和 B', { isCompactSummary: true }),
    // 压缩后源 agent 自动续跑：没有人类提问，只有 isMeta 与回复
    ccUser('Continue from where you left off.', { isMeta: true }),
    ccAsst('msg_2', [{ type: 'text', text: '继续做 C' }]),
    ccUser('压缩后的提问'),
    ccAsst('msg_3', [{ type: 'text', text: '好的' }]),
    ccUser('第二次摘要', { isCompactSummary: true }),
  ])
  const shape = session.turns.map(turn => `${turn.prompt || '∅'}${turn.compaction ? `[${turn.compaction.summary.slice(0, 5)}@${turn.compaction.model}]` : ''}:${turn.steps.length}`)
  check('6n. 摘要挂到边界后的下一轮（无提问时开空提问轮），模型取边界前最后一步',
    shape.join(' | ') === '压缩前的提问:1 | ∅[This @claude-x]:1 | 压缩后的提问:1 | ∅[第二次摘要@claude-x]:0', shape.join(' | '))
  check('6o. 压缩后续跑的 isMeta 进入空提问轮首步的输入',
    session.turns[1].steps[0].inputs[0] === 'Continue from where you left off.')
}

{
  const body = [ccUser('<command-name>/review</command-name>'), ccAsst('m0', [{ type: 'text', text: 'x' }]),
    ccUser('  第一个真实\n提问  '), ccAsst('m1', [{ type: 'text', text: 'y' }])]
  const titleOf = extra => {
    const session = ccParse([...extra, ...body])
    return `${session.title}|${session.titleExplicit}`
  }
  const ai = n => JSON.stringify({ type: 'ai-title', aiTitle: `AI 标题 ${n}`, sessionId: SID })
  const custom = n => JSON.stringify({ type: 'custom-title', customTitle: `改名 ${n}`, sessionId: SID })
  const legacy = JSON.stringify({ type: 'summary', summary: '旧格式标题', leafUuid: 'l1' })
  check('6p. custom-title 后到者胜，压过 summary 与 ai-title', titleOf([ai(1), custom(1), legacy, custom(2)]) === '改名 2|true')
  check('6q. 旧格式 summary 压过 ai-title', titleOf([ai(1), legacy]) === '旧格式标题|true')
  check('6r. ai-title 取首个（后续逐轮改写会漂移）', titleOf([ai(1), ai(2)]) === 'AI 标题 1|true')
  check('6s. 无显式标题时兜底首个真实提问（跳过命令回显，归一空白），不算显式',
    titleOf([]) === '第一个真实 提问|false', titleOf([]))
}

check('6t. 记录 sessionId 与文件名不符的辅助 transcript 不成会话',
  parseClaudeTranscript({ raw: [ccUser('子任务'), ccAsst('m', 'x')].join('\n'), fileStem: 'agent-a1', fallbackCwd: '/f' }) === undefined)

// ── 7. codex ────────────────────────────────────────────────────────────
const { parseCodexRollout } = await import('../src/dsh-adapter/migrate/adapters/codex.parse.js')
const cxRow = (type, payload) => JSON.stringify({ timestamp: '2026-09-01T00:00:00Z', type, payload })
const cxItem = payload => cxRow('response_item', payload)
const cxUser = (...texts) => cxItem({ type: 'message', role: 'user', content: texts.map(text => ({ type: 'input_text', text })) })
const cxAsst = text => cxItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const cxMeta = (extra = {}) => cxRow('session_meta', { id: 'rollout-id', cwd: '/w/codex', timestamp: '2026-09-01T00:00:00Z', source: 'cli', thread_source: 'user', ...extra })
const cxParse = rows => parseCodexRollout({ raw: rows.join('\n'), sourceId: 'rollout-id' })
{
  const session = cxParse([
    cxMeta(),
    cxRow('turn_context', { model: 'gpt-a' }),
    cxUser('第一问'),
    cxAsst('第一答'),
    cxRow('event_msg', { type: 'agent_message', message: '重复的 UI 事件' }),
    cxRow('turn_context', { model: 'gpt-b' }),
    cxUser('第二问'),
    cxAsst('第二答'),
  ])
  check('7a. user 开轮、assistant 成步；event_msg 不重复计入',
    session.turns.map(t => `${t.prompt}:${t.steps.map(s => s.blocks[0].text).join('+')}`).join('|') === '第一问:第一答|第二问:第二答')
  check('7b. turn_context 的 model 写到其后的步上（中途换模型）',
    session.turns[0].steps[0].model === 'gpt-a' && session.turns[1].steps[0].model === 'gpt-b')
  check('7c. cwd 取 session_meta；没有 cwd 的 rollout 不成会话',
    session.cwd === '/w/codex' && cxParse([cxUser('q'), cxAsst('a')]) === undefined)
}

{
  // 注入块：AGENTS.md 说明与 <environment_context> 同在首条 user 消息里（真实 rollout 的开头形态）
  const session = cxParse([
    cxMeta(),
    cxUser('# AGENTS.md instructions for /w/codex\n\n<INSTRUCTIONS>规则</INSTRUCTIONS>', '<environment_context>\n  <cwd>/w/codex</cwd>\n</environment_context>'),
    cxUser('<user_instructions>自定义说明</user_instructions>', '  真正的\n第一问  '),
    cxItem({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: '看图' }] }),
    cxAsst('答'),
  ])
  check('7d. 纯注入的 user 消息不开轮；混合消息只留人类文本',
    session.turns.map(t => t.prompt).join('|') === '真正的\n第一问|[image]\n\n看图', JSON.stringify(session.turns.map(t => t.prompt)))
  check('7e. 丢弃的注入块计入 filtered', session.stats.filtered === 3, String(session.stats.filtered))
  check('7f. 标题兜底首个真实提问（归一空白），不算显式', session.title === '真正的 第一问' && session.titleExplicit === false)
}

{
  // 以 < 开头的人类提问（HTML/XML 问题）不是注入：只有前缀表命中才丢。
  // 反例曾整场丢失：唯一的 user 消息被当注入，rollout 解析为 undefined。
  const html = cxParse([cxMeta(), cxUser('<div>这段 HTML 怎么居中？</div>'), cxAsst('用 flex')])
  check('7f2. 唯一提问以 < 开头的会话照常导入', html !== undefined && html.turns[0]?.prompt === '<div>这段 HTML 怎么居中？</div>',
    JSON.stringify(html?.turns.map(turn => turn.prompt)))
  const mixed = cxParse([
    cxMeta(),
    cxUser('<Files>标签为什么没有注册</Files>'),
    cxAsst('答一'),
    cxItem({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<image name=[Image #1] path=/tmp/a.png>' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: '这张图呢' },
    ] }),
    cxAsst('答二'),
    cxUser('<task-notification>\n<task-id>b1</task-id>\n</task-notification>'),
    cxUser('<turn_aborted>\nThe user interrupted.\n</turn_aborted>'),
  ])
  check('7f3. 真实数据形态：<Files> 提问保留；图片外框、task-notification、turn_aborted 丢弃',
    mixed.turns.map(turn => turn.prompt).join('|') === '<Files>标签为什么没有注册</Files>|[image]\n\n这张图呢',
    JSON.stringify(mixed.turns.map(turn => turn.prompt)))
}

{
  const session = cxParse([
    cxMeta(),
    cxUser('跑一下测试'),
    // 第一次模型调用：说明 + 两个调用（function_call 与 custom_tool_call）
    cxAsst('我先看看'),
    cxItem({ type: 'function_call', call_id: 'fc_1', name: 'shell', arguments: '{"cmd":["ls"]}' }),
    cxItem({ type: 'custom_tool_call', call_id: 'ct_1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"npm test"})' }),
    // 三种输出形态：JSON 字符串、块数组（含图片）
    cxItem({ type: 'function_call_output', call_id: 'fc_1', output: '{"output":"a.ts\\nb.ts","metadata":{"exit_code":0}}' }),
    cxItem({ type: 'custom_tool_call_output', call_id: 'ct_1', output: [{ type: 'input_text', text: '12 passed' }, { type: 'input_image', image_url: 'x' }] }),
    // 输出之后的模型产物开启第二次调用
    cxItem({ type: 'custom_tool_call', call_id: 'ct_2', name: 'apply_patch', input: '*** Begin Patch' }),
    cxItem({ type: 'custom_tool_call_output', call_id: 'ct_2', output: '纯文本输出' }),
    cxItem({ type: 'function_call_output', call_id: 'ghost', output: '孤儿' }),
    cxAsst('测试都过了'),
  ])
  const steps = session.turns[0].steps
  check('7g. 步边界：同一次调用的消息与多个调用同一步，输出之后的产物开新步',
    steps.map(s => s.blocks.map(b => b.type === 'tool-call' ? b.id : 'text').join('+')).join(' | ') === 'text+fc_1+ct_1 | ct_2 | text',
    steps.map(s => s.blocks.map(b => b.type === 'tool-call' ? b.id : 'text').join('+')).join(' | '))
  check('7h. function_call 参数原样；custom_tool_call 的自由格式 input 包成 {"input":…}',
    steps[0].blocks[1].arguments === '{"cmd":["ls"]}' && JSON.parse(steps[0].blocks[2].arguments).input.startsWith('const r = await'))
  check('7i. 输出三形态取模型所见文本：JSON 内层 output、块数组（图片占位）、纯字符串',
    steps[0].results.map(r => r.text).join(' / ') === 'a.ts\nb.ts / 12 passed\n[image]' && steps[1].results[0].text === '纯文本输出',
    steps[0].results.map(r => r.text).join(' / '))
  check('7j. 找不到调用的输出计入 droppedToolResults', session.stats.droppedToolResults === 1)
}

{
  const reasoning = (...texts) => cxItem({ type: 'reasoning', summary: texts.map(text => ({ type: 'summary_text', text })), encrypted_content: 'gAAAA-opaque' })
  const session = cxParse([
    cxMeta(),
    cxUser('q'),
    reasoning('**计划** 先读文件', '再改'),
    cxItem({ type: 'function_call', call_id: 'f1', name: 'shell', arguments: '{}' }),
    cxItem({ type: 'function_call_output', call_id: 'f1', output: 'ok' }),
    reasoning('读完了，开始回答'),
    cxAsst('答复'),
    reasoning(),
  ])
  const steps = session.turns[0].steps
  check('7k. reasoning 摘要作为所属模型调用的 reasoning 块，位于该步最前',
    steps.length === 2 && steps[0].blocks[0].type === 'reasoning' && steps[0].blocks[0].text === '**计划** 先读文件\n\n再改'
    && steps[1].blocks.map(b => b.type).join(',') === 'reasoning,text')
  check('7l. encrypted_content 不进入导入内容；空摘要不产生块',
    !JSON.stringify(session).includes('gAAAA') && steps.length === 2)
}

{
  // compacted 常落在一轮工具执行的中间：边界后的产物以空提问轮继续
  const session = cxParse([
    cxMeta(),
    cxRow('turn_context', { model: 'gpt-c' }),
    cxUser('大任务'),
    cxItem({ type: 'function_call', call_id: 'f1', name: 'shell', arguments: '{}' }),
    cxItem({ type: 'function_call_output', call_id: 'f1', output: 'ok' }),
    cxRow('compacted', { message: '交接摘要：已完成第一阶段', replacement_history: [] }),
    cxItem({ type: 'function_call', call_id: 'f2', name: 'shell', arguments: '{}' }),
    cxItem({ type: 'function_call_output', call_id: 'f2', output: 'ok2' }),
    cxAsst('阶段二完成'),
    cxUser('下一个问题'),
    cxAsst('答'),
    cxRow('compacted', { message: '尾部摘要' }),
  ])
  const shape = session.turns.map(t => `${t.prompt || '∅'}${t.compaction ? `[${t.compaction.summary.slice(0, 4)}@${t.compaction.model}]` : ''}:${t.steps.length}`)
  check('7m. compacted 转检查点挂到边界后的轮；轮中途的边界后半段成空提问轮；停在边界保留检查点轮',
    shape.join(' | ') === '大任务:1 | ∅[交接摘要@gpt-c]:2 | 下一个问题:1 | ∅[尾部摘要@gpt-c]:0', shape.join(' | '))
}

{
  const session = cxParse([
    cxMeta(),
    cxUser('做一半被打断'),
    cxAsst('开始……'),
    cxRow('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    cxUser('换个方向'),
    cxAsst('好'),
  ])
  check('7n. turn_aborted 标记当前轮为中断，后续轮不受影响',
    session.turns[0].aborted === true && session.turns[1].aborted === undefined)
}

{
  const body = [cxUser('任务'), cxAsst('结果')]
  const parent = cxMeta({ id: 'parent', cwd: '/w/parent' })
  check('7o. 首个 session_meta 标记子代理（thread_source 或 source.subagent）的 rollout 不成会话',
    cxParse([cxMeta({ thread_source: 'subagent' }), parent, ...body]) === undefined
    && cxParse([cxMeta({ source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }), parent, ...body]) === undefined)
  const fork = cxParse([cxMeta({ cwd: '/w/fork', forked_from_id: 'parent' }), cxMeta({ id: 'parent', cwd: '/w/parent', thread_source: 'subagent' }), ...body])
  check('7p. 只看首个 meta：fork 会话保留，继承来的父 meta 不改 cwd、不触发排除',
    fork !== undefined && fork.cwd === '/w/fork')
}

{
  const report = text => cxItem({ type: 'agent_message', author: '/root/audit', recipient: '/root', content: [{ type: 'input_text', text }] })
  const session = cxParse([
    cxMeta(),
    cxUser('派两个子代理审查'),
    cxItem({ type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: '{}' }),
    cxItem({ type: 'function_call_output', call_id: 'spawn', output: 'spawned' }),
    cxAsst('等待子代理'),
    report('子代理 A：发现 2 个问题'),
    report('子代理 B：没有问题'),
    cxAsst('汇总：共 2 个问题'),
    report('迟到的报告'),
    cxUser('下一个问题'),
  ])
  const steps = session.turns[0].steps
  check('7q. agent_message 成为下一次模型调用的输入，并开启新步',
    steps.length === 3 && JSON.stringify(steps[2].inputs) === JSON.stringify(['子代理 A：发现 2 个问题', '子代理 B：没有问题'])
    && steps[2].blocks[0].text === '汇总：共 2 个问题')
  check('7r. 没被任何调用消费就遇到新提问的报告计入 filtered',
    session.stats.meta === 3 && session.stats.filtered === 1, JSON.stringify(session.stats))
}

// ── 8. grok-build ───────────────────────────────────────────────────────
const { parseGrokSession } = await import('../src/dsh-adapter/migrate/adapters/grok-build.parse.js')
const gkSummary = (extra = {}) => JSON.stringify({
  info: { id: 'grok-session-1', cwd: '/w/grok' }, session_summary: 'Grok 摘要标题', created_at: '2026-09-01T00:00:00Z', ...extra,
})
const gkUser = (text, extra = {}) => JSON.stringify({ type: 'user', content: [{ type: 'text', text }], ...extra })
const gkAsst = (content, extra = {}) => JSON.stringify({ type: 'assistant', content, model_id: 'grok-x', ...extra })
const gkReason = text => JSON.stringify({ type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text }], encrypted_content: 'opaque' })
const gkParse = (rows, summary = gkSummary()) => parseGrokSession({ summaryJson: summary, chatHistory: rows.join('\n') })
{
  const session = gkParse([
    JSON.stringify({ type: 'system', content: 'system prompt' }),
    gkUser('第一问'),
    gkReason('先想'),
    gkAsst('第一答'),
    JSON.stringify({ role: 'user', content: 'v0 形态提问' }),
    JSON.stringify({ role: 'assistant', content: 'v0 形态回答' }),
  ])
  check('8a. reasoning 行前置到下一个 assistant 步；model 取 model_id',
    JSON.stringify(session.turns[0].steps[0].blocks) === JSON.stringify([{ type: 'reasoning', text: '先想' }, { type: 'text', text: '第一答' }])
    && session.turns[0].steps[0].model === 'grok-x')
  check('8b. 兼容 v0 的 {role, content} 形态', session.turns[1]?.prompt === 'v0 形态提问' && session.turns[1].steps[0].blocks[0].text === 'v0 形态回答')
  check('8c. sourceId 与 cwd 取 summary.json 的 info；缺 info 的会话不成立',
    session.sourceId === 'grok-session-1' && session.cwd === '/w/grok' && gkParse([gkUser('q')], JSON.stringify({ info: null })) === undefined)
}

{
  const tr = (id, content, extra = {}) => JSON.stringify({ type: 'tool_result', tool_call_id: id, content, ...extra })
  const session = gkParse([
    gkUser('看两张图'),
    // 真实形态：content 字符串 + 顶层 tool_calls；可以没有正文
    gkAsst('先读图', { tool_calls: [{ id: 'call-0', name: 'read_file', arguments: '{"target_file":"a.png"}' }, { id: 'call-1', name: 'grep', arguments: '{}' }] }),
    tr('call-1', '3 matches'),
    tr('call-0', 'Read image file: a.png', { images: [{ type: 'image', url: 'data:image/png;base64,AAAA' }] }),
    tr('call-x', '孤儿'),
    gkAsst('', { tool_calls: [{ id: 'call-2', name: 'edit', arguments: '{}' }] }),
    JSON.stringify({ type: 'backend_tool_call', kind: { tool_type: 'web_search' } }),
    gkAsst('改好了'),
  ])
  const [s1, s2] = session.turns[0].steps
  check('8d. 顶层 tool_calls 成为该步的 tool-call 块；只有调用没有正文的行也成步',
    s1.blocks.map(b => b.type === 'tool-call' ? b.id : b.type).join(',') === 'text,call-0,call-1'
    && s2.blocks.map(b => b.type).join(',') === 'tool-call' && session.turns[0].steps.length === 3)
  check('8e. tool_result 按 tool_call_id 配对、按调用顺序；图片换占位，不写 base64',
    s1.results.map(r => r.text).join(' / ') === 'Read image file: a.png\n[image] / 3 matches' && !JSON.stringify(session).includes('base64'))
  check('8f. 孤儿结果计入 droppedToolResults；backend_tool_call 计入 filtered',
    session.stats.droppedToolResults === 1 && session.stats.filtered === 1 && s2.results[0].text === '')
}

{
  const session = gkParse([
    gkUser('<system-reminder>\nThe following skills are available</system-reminder>', { synthetic_reason: 'system_reminder' }),
    gkUser('<user_info>\nOS Version: windows\nWorkspace Path: D:\\w</user_info>'),
    gkUser('<user_query>\n请看一下动画\n</user_query>', { prompt_index: 0 }),
    gkAsst('在看'),
    gkUser('The user interrupted the previous turn:\n<user_query>\ncontinue\n</user_query>\nMake sure to…', { prior_turn_interrupt: 'mid_turn_abort', prompt_index: 1 }),
    gkAsst('继续'),
    gkUser('The user sent a message while you were working:\n<user_query>\n顺便加测试\n</user_query>', { prompt_index: 2 }),
    gkAsst('好'),
  ])
  check('8g. <user_query> 与中断/插话包装只留正文开轮',
    session.turns.map(t => t.prompt).join('|') === '请看一下动画|continue|顺便加测试', session.turns.map(t => t.prompt).join('|'))
  check('8h. 带 prior_turn_interrupt 的行把上一轮标为中断；插话不标',
    session.turns[0].aborted === true && session.turns[1].aborted === undefined)
  check('8i. 合成提醒与 <user_info> 不开轮，计入 filtered', session.stats.filtered === 2 && session.turns.length === 3)
}

{
  const session = gkParse([
    gkUser('<user_query>长任务</user_query>'),
    gkAsst('做了一半'),
    // 真实压缩形态：两条 compaction_meta（环境块 + 摘要），之后源 agent 直接续跑
    gkUser('<user_info>\nOS Version: windows</user_info>', { synthetic_reason: 'compaction_meta' }),
    gkUser('This session is being continued from a previous conversation that ran out of context. Summary: …', { synthetic_reason: 'compaction_meta' }),
    gkAsst('接着做'),
    gkUser('<user_query>下一个</user_query>'),
    gkAsst('好'),
  ])
  const shape = session.turns.map(t => `${t.prompt || '∅'}${t.compaction ? `[${t.compaction.summary.slice(0, 12)}@${t.compaction.model}]` : ''}:${t.steps.length}`)
  check('8j. compaction_meta 的摘要行转检查点挂到边界后的轮；环境块计入 filtered',
    shape.join(' | ') === '长任务:1 | ∅[This session@grok-x]:1 | 下一个:1' && session.stats.filtered === 1, shape.join(' | '))
}

{
  const rows = [gkUser('<user_query>\n  兜底\n提问 </user_query>'), gkAsst('a')]
  const titleOf = extra => {
    const session = gkParse(rows, gkSummary(extra))
    return `${session.title}|${session.titleExplicit}`
  }
  check('8k. generated_title 压过 session_summary，均为显式标题',
    titleOf({ generated_title: '生成标题' }) === '生成标题|true' && titleOf({}) === 'Grok 摘要标题|true')
  check('8l. 两者皆无时兜底首个真实提问（已剥包装、归一空白），不算显式',
    titleOf({ session_summary: '  ' }) === '兜底 提问|false', titleOf({ session_summary: '  ' }))
}

// ── 9. zcode ────────────────────────────────────────────────────────────
const { parseZcodeSession } = await import('../src/dsh-adapter/migrate/adapters/zcode.parse.js')
const zcDoc = (messages, meta = {}) => JSON.stringify({
  meta: { taskId: 'task-1', workspacePath: '/w/zc', createdAt: 1790000000000, title: 'zcode 标题', ...meta }, messages,
})
{
  const session = parseZcodeSession(zcDoc([
    null,
    { role: 'user', content: '问' },
    { role: 'assistant', content: '答一' },
    { role: 'assistant', content: '答二' },
    { role: 'tool', content: '未知角色不映射' },
    { role: 'user', content: '' },
  ]))
  check('9a. user 开轮、其后每条 assistant 一步；未知角色与空内容跳过',
    session.turns.length === 1 && session.turns[0].steps.map(s => s.blocks[0].text).join('+') === '答一+答二')
  check('9b. sourceId/cwd/startedAt 取 meta；缺 taskId 或非 {meta,messages} 文档不成会话',
    session.sourceId === 'task-1' && session.cwd === '/w/zc' && session.startedAt === 1790000000000
    && parseZcodeSession(zcDoc([{ role: 'user', content: 'q' }], { taskId: '' })) === undefined
    && parseZcodeSession('null') === undefined && parseZcodeSession('{broken') === undefined)
}

{
  const session = parseZcodeSession(zcDoc([
    { role: 'user', content: '<environment_context>\n<cwd>/w/zc</cwd>\n</environment_context>' },
    { role: 'user', content: '<user_query>真正的问题</user_query>' },
    { role: 'assistant', content: '答' },
  ], { title: '  zcode\n自带标题 ' }))
  check('9c. 共享注入规则：注入块不开轮并计数，包装只留正文',
    session.turns.map(t => t.prompt).join('|') === '真正的问题' && session.stats.filtered === 1)
  check('9d. meta.title 归一后为显式标题；缺失时兜底首个真实提问（不算显式）',
    session.title === 'zcode 自带标题' && session.titleExplicit === true
    && parseZcodeSession(zcDoc([{ role: 'user', content: '兜底问' }], { title: '' })).title === '兜底问'
    && parseZcodeSession(zcDoc([{ role: 'user', content: '兜底问' }], { title: '' })).titleExplicit === false)
}

console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate parse regression passed (${checks} checks)`)
