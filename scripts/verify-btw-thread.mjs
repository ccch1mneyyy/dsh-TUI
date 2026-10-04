#!/usr/bin/env node
/**
 * btw 线程回归（纯逻辑层）：
 *  - sideThreadQuestion / selectContextTurns：最近 N 轮窗口边界、单答案
 *    8k / 总 24k 字符预算按整轮裁剪、omitted 计数、无上下文时单问合同
 *    逐字节不变（sideQuestionPrompt 原文钉死——不改变单问原合同）。
 *  - btwThreads 生命周期：流式→落定、双发 busy、abort 后迟到 onText/
 *    result 被代际守卫丢弃、新话题清 turns/draft/unread 且旧内容不进
 *    新 prompt、两个 session 不串、unread 记账（cancelled 不计、失败
 *    error 位）、DSH 空答字面映射、跨线程并发上限 2。
 *  - 合同保全审计：ask 门面（= channel.sideQuestion）每轮恰好一次、
 *    prompt 是单个 question 字符串；毒化 channel 代理断言线程层除 ask
 *    外碰不到任何主会话写入口（不 submit/steer/pushLocal——sideQuery
 *    单轮无工具、问答不写主 session record，capabilities.ts:342 语义）。
 *  - 设置层（dsh-tui.btw.*）：normalize/apply 往返与越界钳制、
 *    recentTurnsLimit 三档（1/4/8）实测 prompt 携带配对数、
 *    contextBudget 透传与收紧预算挤掉旧轮、单答上限随总量派生
 *    （min(8k, budget/2)——收紧的总量不被 8k 架空）。
 * 运行：node --import tsx/esm scripts/verify-btw-thread.mjs
 */
process.env.DSH_TUI_LANG = 'zh'

const [
  { sideQuestionPrompt, sideThreadQuestion },
  { btwThreads, selectContextTurns, normalizeRecentTurnsLimit, BTW_RECENT_TURNS_DEFAULT, BTW_ANSWER_CHAR_BUDGET, BTW_CONTEXT_CHAR_BUDGET, BTW_MAX_CONCURRENT_ASKS },
  { btwComposerKey },
  prefs,
] = await Promise.all([
  import('../src/channel/side-prompts.js'),
  import('../src/components/sidePanel/btw/threads.js'),
  import('../src/components/sidePanel/btw/BtwComposer.js'),
  import('../src/tuiDisplayPrefs.js'),
])

let failures = 0
function check(name, ok, extra = '') {
  if (ok) console.log('PASS: ' + name)
  else { failures += 1; console.error('FAIL: ' + name + (extra ? '  (' + extra + ')' : '')) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true
    await tick()
  }
  return false
}
function completed(question, answer, seq) {
  return { turnId: 't' + seq, seq, question, answer, phase: 'completed', includedContextTurnIds: [], omittedOlderCount: 0 }
}

// ── A. prompt assembly：单问合同不动 + 线程上下文 ─────────────────────────
{
  const SINGLE = `<side-question-context>
Give one concise answer to the question below using the conversation already provided.
This auxiliary call runs alongside the main session. The main task continues independently;
do not describe it as interrupted, resumed, or as work performed by this call.
No tools are available here: do not claim to inspect files, execute commands, browse,
or carry out future actions. There will be no follow-up turn for this call.
When the available context is insufficient, state what is unknown without promising research.
</side-question-context>

what is 1+1?`
  check('A1. sideQuestionPrompt 单问合同逐字节不变（线程改造零触碰）', sideQuestionPrompt('what is 1+1?') === SINGLE)
  check('A2. 无上下文时 sideThreadQuestion 原样返回（首问=单问）', sideThreadQuestion('q0') === 'q0')
  const two = sideThreadQuestion('q2', [{ question: 'q1', answer: 'a1' }], 3)
  check('A3. 线程上下文含 side-thread-context 块', two.includes('<side-thread-context>'))
  check('A4. 配对以 Q:/A: 引用', two.includes('Q: q1') && two.includes('A: a1'))
  check('A5. omitted 计数进 prompt（模型知情）', two.includes('3 earlier pair(s)'))
  check('A6. 新问题在文末', two.trimEnd().endsWith('q2'))
  check('A7. omitted=0 时不出现省略句', !sideThreadQuestion('q', [{ question: 'a', answer: 'b' }], 0).includes('omitted here'))
}

// ── B. N 窗口与预算钳制 ──────────────────────────────────────────────────
{
  check('B1. limit 钳制 1–8（默认 4）', normalizeRecentTurnsLimit(undefined) === BTW_RECENT_TURNS_DEFAULT
    && normalizeRecentTurnsLimit(-3) === 1 && normalizeRecentTurnsLimit(0) === 1
    && normalizeRecentTurnsLimit(3) === 3 && normalizeRecentTurnsLimit(9) === 8
    && normalizeRecentTurnsLimit(Number.NaN) === 4)
  const six = [1, 2, 3, 4, 5, 6].map(n => completed('q' + n, 'a' + n, n))
  const windowed = selectContextTurns(six, 4)
  check('B2. 最近 N=4：更旧两轮整轮省略', windowed.included.length === 4 && windowed.omittedOlderCount === 2
    && windowed.included[0].question === 'q3' && windowed.included[3].question === 'q6')
  const clipped = selectContextTurns([completed('q', 'x'.repeat(BTW_ANSWER_CHAR_BUDGET + 500), 1)], 4)
  check('B3. 单答案 8k 裁剪（代理对安全，省略号计入 +1）', clipped.included[0].answer.length <= BTW_ANSWER_CHAR_BUDGET + 1
    && clipped.included[0].answer.endsWith('…'), 'len=' + clipped.included[0].answer.length)
  const fat = [1, 2, 3].map(n => completed('q' + n, 'y'.repeat(10_000), n))
  const budgeted = selectContextTurns(fat, 8)
  check('B4. 总 24k 预算按整轮从最旧裁剪', budgeted.included.length === 2 && budgeted.omittedOlderCount === 1
    && budgeted.included[0].question === 'q2', 'included=' + budgeted.included.length)
  const mixed = [
    completed('done', 'ok', 1),
    { ...completed('failed', '', 2), phase: 'failed' },
    { ...completed('run', '', 3), phase: 'running' },
  ]
  const onlyDone = selectContextTurns(mixed, 4)
  check('B5. 只有完成轮进上下文', onlyDone.included.length === 1 && onlyDone.included[0].question === 'done')
}

// ── C. 受控 ask 门面 ─────────────────────────────────────────────────────
function scriptedAsk() {
  const calls = []
  let pending = []
  const ask = (question, options) => {
    calls.push({ question, options })
    return new Promise(resolve => { pending.push({ resolve, options }) })
  }
  return {
    calls,
    ask,
    count: () => calls.length,
    /** 流几段文本给最新一次调用。 */
    stream(text) { const p = pending.at(-1); p?.options?.onText?.(text) },
    settle(index, outcome) { const p = pending[index]; p?.resolve(outcome) },
    settleLast(outcome) { this.settle(pending.length - 1, outcome) },
  }
}
/** 毒化 channel：任何非 sideQuestion 的属性访问都记录（合同审计）。 */
function poisonedChannel(touched) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'sideQuestion') return (question, options) => { touched.push('sideQuestion'); return Promise.resolve({ answer: 'ok:' + question }) }
      touched.push(String(prop))
      return () => {}
    },
  })
}

// ── D. store 生命周期 ────────────────────────────────────────────────────
{
  btwThreads.resetForTest()
  const s = scriptedAsk()
  const r1 = btwThreads.submit('sess-A', 'first question', s.ask)
  check('D1. 首问 submit ok + running', r1.ok === true && btwThreads.get('sess-A')?.activeTurnId === r1.turnId)
  s.stream('partial ')
  s.settleLast({ answer: 'full answer' })
  check('D2. 落定 completed + 全答替换流答', await waitFor(() => btwThreads.get('sess-A')?.turns[0]?.phase === 'completed')
    && btwThreads.get('sess-A')?.turns[0]?.answer === 'full answer')
  check('D3. ask 门面每轮恰好一次（单轮合同）', s.count() === 1)
  check('D4. 首问 prompt 不带线程块', !s.calls[0].question.includes('<side-thread-context>'))

  // 追问携带最近问答
  const r2 = btwThreads.submit('sess-A', 'follow up', s.ask)
  await waitFor(() => s.count() === 2)
  check('D5. 追问 prompt 显式携带上一组 Q/A', s.calls[1].question.includes('Q: first question') && s.calls[1].question.includes('A: full answer'))
  check('D6. 追问轮记录 includedContextTurnIds', btwThreads.get('sess-A')?.turns[1]?.includedContextTurnIds.includes(r1.turnId) === true)
  // 双发 busy
  const busy = btwThreads.submit('sess-A', 'too early', s.ask)
  check('D7. 在途时再问 busy（不隐式取消）', busy.ok === false && busy.reason === 'busy' && s.count() === 2)
  // abort 后迟到写回被丢弃
  btwThreads.abortActive('sess-A')
  check('D8. abort 立即 cancelled', btwThreads.get('sess-A')?.turns[1]?.phase === 'cancelled')
  s.stream('late delta')
  s.settleLast({ answer: 'late answer' })
  await tick(); await tick()
  const afterLate = btwThreads.get('sess-A')?.turns[1]
  check('D9. 迟到 onText/result 全被代际守卫丢弃', afterLate?.answer === '' && afterLate?.phase === 'cancelled')
  check('D10. 错误不删历史（完成轮仍在）', btwThreads.get('sess-A')?.turns[0]?.phase === 'completed')

  // unread 记账
  check('D11. 未看过的落定轮计未读', btwThreads.get('sess-A')?.unread.count === 1)
  btwThreads.markSeen('sess-A')
  check('D12. markSeen 清未读', btwThreads.get('sess-A')?.unread.count === 0)

  // 新话题
  btwThreads.setDraft('sess-A', 'draft kept?')
  const oldThreadId = btwThreads.get('sess-A')?.threadId
  const r3 = btwThreads.submit('sess-A', 'q3', s.ask)
  await waitFor(() => s.count() === 3)
  btwThreads.newTopic('sess-A')
  const cleared = btwThreads.get('sess-A')
  check('D13. 新话题清 turns/draft/unread + 换 thread id', cleared !== undefined && cleared.turns.length === 0
    && cleared.draft === '' && cleared.unread.count === 0 && cleared.threadId !== oldThreadId)
  const r4 = btwThreads.submit('sess-A', 'fresh topic', s.ask)
  await waitFor(() => s.count() === 4)
  check('D14. 新话题后旧内容不进 prompt', !s.calls[3].question.includes('first question')
    && !s.calls[3].question.includes('<side-thread-context>'))
  s.settleLast({ answer: null, error: 'No response received' })
  await waitFor(() => btwThreads.get('sess-A')?.turns[0]?.phase === 'failed')
  check('D15. DSH 空答字面映射为本地化文案', btwThreads.get('sess-A')?.turns[0]?.error === '没有收到回答')
  check('D16. 失败轮未读带 error 位', btwThreads.get('sess-A')?.unread.error === true)
  void r2; void r3; void r4
}

// ── E. session 隔离 + 并发上限 ───────────────────────────────────────────
{
  btwThreads.resetForTest()
  const s = scriptedAsk()
  btwThreads.submit('sess-A', 'A question', s.ask)
  await waitFor(() => s.count() === 1)
  btwThreads.submit('sess-B', 'B question', s.ask)
  await waitFor(() => s.count() === 2)
  check('E1. 两 session 线程互不串（B 的 prompt 无 A 的问句）', !s.calls[1].question.includes('A question'))
  const third = btwThreads.submit('sess-C', 'C question', s.ask)
  check('E2. 跨线程并发上限 2 → congested（不隐式取消）', third.ok === false && third.reason === 'congested' && s.count() === 2,
    'cap=' + BTW_MAX_CONCURRENT_ASKS)
  s.settle(0, { answer: 'A done' })
  await waitFor(() => btwThreads.get('sess-A')?.turns[0]?.phase === 'completed')
  const retry = btwThreads.submit('sess-C', 'C question', s.ask)
  check('E3. 有线程落定后并发槽释放', retry.ok === true)
  // 会话切换后旧线程继续流完、不写进新 session
  s.stream('B delta')
  s.settle(1, { answer: 'B done' })
  await waitFor(() => btwThreads.get('sess-B')?.turns[0]?.phase === 'completed')
  check('E4. 旧 session 线程在切换后继续落定到自己的档', btwThreads.get('sess-B')?.turns[0]?.answer === 'B done'
    && btwThreads.get('sess-A')?.turns.length === 1)
}

// ── F. 合同保全审计 ──────────────────────────────────────────────────────
{
  btwThreads.resetForTest()
  const touched = []
  const poisoned = poisonedChannel(touched)
  btwThreads.submit('sess-audit', 'audit q', (question, options) => poisoned.sideQuestion(question, options))
  await waitFor(() => btwThreads.get('sess-audit')?.turns[0]?.phase === 'completed')
  check('F1. 线程层只经 sideQuestion 门面说话（无 submit/steer/pushLocal 触碰）',
    touched.every(name => name === 'sideQuestion'), 'touched=' + JSON.stringify([...new Set(touched)]))
  check('F2. 一次 ask、prompt 为单字符串（无工具参数面）', touched.filter(n => n === 'sideQuestion').length === 1)
}

// ── G. composer 键语义（Esc 分层/失败保留的基础） ────────────────────────
{
  const esc = btwComposerKey({ text: 'draft', caret: 5 }, '', { escape: true })
  check('G1. Esc = 退出编辑焦点（非清空）', esc !== null && esc.exitFocus === true)
  const enter = btwComposerKey({ text: 'hello', caret: 5 }, '', { return_: true })
  check('G2. 裸 Enter = submit', enter !== null && enter.submit === true)
  const mod = btwComposerKey({ text: 'x', caret: 1 }, '', { return_: true, ctrl: true })
  check('G3. Ctrl+Enter 不提交', mod === null)
  const typed = btwComposerKey({ text: 'ab', caret: 1 }, 'X', {})
  check('G4. 插入落在 caret 处', typed?.state?.text === 'aXb' && typed?.state?.caret === 2)
  const back = btwComposerKey({ text: 'ab', caret: 2 }, '', { backspace: true })
  check('G5. Backspace 删 caret 前', back?.state?.text === 'a' && back?.state?.caret === 1)
  const left = btwComposerKey({ text: 'ab', caret: 2 }, '', { leftArrow: true })
  check('G6. ← 移动 caret 不滚列表', left?.state?.caret === 1 && left?.submit === undefined)
  const tab = btwComposerKey({ text: 'ab', caret: 0 }, '\t', { tab: true })
  check('G7. Tab 退出编辑焦点切列表', tab !== null && tab.exitFocus === true)
  const unconsumed = btwComposerKey({ text: 'ab', caret: 0 }, 'c', { ctrl: true })
  check('G8. Ctrl 组合未消费（交宿主：interrupt/exit 保持可用）', unconsumed === null)
}

// ── H. 设置层（dsh-tui.btw.*）：往返、钳制、三档实测、预算派生 ─────────
{
  const pairsOf = prompt => (prompt.match(/<side-thread-pair n=/g) ?? []).length

  // H1/H2. normalize 越界钳制（设置入口与 store 兜底同规则）
  check('H1. contextTurns 钳制 1–8（junk/越界回默认或边界）',
    prefs.normalizeBtwContextTurns(0) === 1 && prefs.normalizeBtwContextTurns(-3) === 1
    && prefs.normalizeBtwContextTurns(9) === 8 && prefs.normalizeBtwContextTurns(3.6) === 4
    && prefs.normalizeBtwContextTurns(Number.NaN) === 4 && prefs.normalizeBtwContextTurns('x') === 4)
  check('H2. contextBudget 钳制 1k–200k',
    prefs.normalizeBtwContextBudget(999) === 1000 && prefs.normalizeBtwContextBudget(300000) === 200000
    && prefs.normalizeBtwContextBudget(Number.NaN) === 24000 && prefs.normalizeBtwContextBudget('y') === 24000)

  // H3. 设置往返：apply → get 生效 + subscribe 通知（/settings 与 cordis.yml 的镜像路径）
  let notified = 0
  const unsubscribe = prefs.subscribeBtwContextTurns(() => { notified += 1 })
  const applied = prefs.applyBtwContextTurns(8)
  check('H3. apply→get 往返 + 订阅通知', applied === 8 && prefs.getBtwContextTurns() === 8 && notified === 1)
  prefs.applyBtwContextBudget(4000)
  check('H3b. budget 往返', prefs.getBtwContextBudget() === 4000)
  unsubscribe

  // H4. 三档实测（1/4/8）：submit 透传 recentTurnsLimit → prompt 配对数
  btwThreads.resetForTest()
  const s = scriptedAsk()
  for (let index = 1; index <= 6; index += 1) {
    btwThreads.submit('sess-set', 'q' + index, s.ask)
    s.settleLast({ answer: 'a' + index })
    await waitFor(() => btwThreads.get('sess-set')?.turns.at(-1)?.phase === 'completed')
  }
  for (const turns of [1, 4, 8]) {
    // 前两档的 followup 落定后也成了完成轮——期望取 min(档位, 当时完成轮数)。
    const priorCompleted = btwThreads.get('sess-set')?.turns.filter(turn => turn.phase === 'completed').length ?? 0
    const expected = Math.min(turns, priorCompleted)
    const before = s.count()
    const r = btwThreads.submit('sess-set', 'follow@' + turns, s.ask, { recentTurnsLimit: turns, contextBudget: prefs.getBtwContextBudget() })
    await waitFor(() => s.count() === before + 1)
    const prompt = s.calls.at(-1).question
    const pairs = pairsOf(prompt)
    s.settleLast({ answer: 'ok' })
    await waitFor(() => btwThreads.get('sess-set')?.turns.at(-1)?.phase === 'completed')
    check(`H4. recentTurnsLimit=${turns} → prompt 携带 min(${turns}, 完成${priorCompleted})=${expected} 组`, r.ok === true && pairs === expected,
      'pairs=' + pairs)
  }

  // H5. 收紧预算挤掉旧轮（budget 透传 selectContextTurns.total）
  btwThreads.resetForTest()
  const s2 = scriptedAsk()
  for (let index = 1; index <= 3; index += 1) {
    btwThreads.submit('sess-bud', 'q' + index, s2.ask)
    s2.settleLast({ answer: 'x'.repeat(3000) })
    await waitFor(() => btwThreads.get('sess-bud')?.turns.at(-1)?.phase === 'completed')
  }
  const tight = btwThreads.submit('sess-bud', 'tight question', s2.ask, { recentTurnsLimit: 8, contextBudget: 6500 })
  await waitFor(() => s2.count() === 4)
  const tightPairs = pairsOf(s2.calls.at(-1).question)
  check('H5. contextBudget=6500：~2 组 3k 答案后旧轮整组挤出', tight.ok === true && tightPairs === 2, 'pairs=' + tightPairs)
  const tightTurn = btwThreads.get('sess-bud')?.turns.at(-1)
  check('H5b. omitted 计数随预算裁剪上报', tightTurn?.omittedOlderCount === 1, 'omitted=' + (tightTurn?.omittedOlderCount ?? 'x'))
  s2.settleLast({ answer: 'done' })

  // H6. 单答上限随总量派生：budget=4000 → perAnswer=min(8000,2000)=2000
  const derived = selectContextTurns([completed('q', 'y'.repeat(9000), 1)], 4, { total: 4000 })
  check('H6. perAnswer 内部派生 min(8k, budget/2)——收紧总量不被 8k 架空',
    derived.included[0].answer.length <= 2001 && derived.included[0].answer.endsWith('…'),
    'len=' + derived.included[0].answer.length)
  const wide = selectContextTurns([completed('q', 'y'.repeat(9000), 1)], 4, { total: 24000 })
  check('H6b. 默认预算下 perAnswer 仍是 8k', wide.included[0].answer.length <= 8001, 'len=' + wide.included[0].answer.length)

  // 还原设置默认，避免污染同进程的其他夹具
  prefs.applyBtwContextTurns(4)
  prefs.applyBtwContextBudget(24000)
}

console.log(failures === 0 ? '\nbtw-thread: ALL PASS' : `\nbtw-thread: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
