/**
 * AskUserQuestionPanel 全应用布局回归（issue：ask 问卷在完整 Chat 布局下的
 * 渲染完整性）。与 repro-askpanel.tsx（面板隔离交互）互补：本脚本把面板
 * 挂进真实 Chat 屏幕，在四种布局压力下校验所有行都上屏——
 *   1. 短会话静态渲染（精确 payload：4 选项全带 description + header）
 *   2. 长高录（120 行对话，ScrollBox 窗口收缩）
 *   3. activity 行持续 tick 时的差分重绘
 *   4. 终端 resize 风暴（放大后连续抖动缩小）
 * 运行：node --import tsx/esm scripts/verify-askpanel-layout.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 用户真实会话日志里的 payload（issue 现场）：4 个选项全带描述。 */
const EXACT_QUESTION = {
  header: '随便问问 2',
  id: 'weekend_plan',
  question: '再测一次：如果明天是周末，你大概率会怎么过？',
  options: [
    { label: '宅家打游戏/看剧', description: '把想做的事列成清单，一样一样划掉，很有成就感。' },
    { label: '出去浪一圈', description: '出门走走，吃点好的，换换脑子。' },
    { label: '学习或写代码', description: '继续写代码/学新东西，卷王本王。' },
    { label: '纯躺平休息', description: '什么都不安排，睡到自然醒。' },
  ],
}

/** 面板完整渲染时必须全部上屏的关键行。 */
const REQUIRED = [
  '随便问问 2', // header 标签
  '再测一次', // 问题文本
  '宅家打游戏/看剧', '出去浪一圈', '学习或写代码', '纯躺平休息', // 4 个 label
  '很有成就感', '换换脑子', '卷王本王', '睡到自然醒', // 4 个 description
  '自定义回答', // 内联输入行
  '↑/↓ 选择', 'Esc 中断', // 底部提示行
]

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdout = new FakeStdout()
  const screen = (): string => {
    const buf = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  return { term, stdout, FakeStdin, screen }
}

function makeChannel(transcriptRows: unknown[], listeners?: Set<() => void>) {
  return {
    version: 0,
    rows: transcriptRows,
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    tokens: { input: 120, output: 45 },
    cwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: true,
    spinnerMode: 'requesting',
    responseChars: 20,
    activeToolCount: 0,
    turnStart: Date.now(),
    lastUserText: '再来问一个问题',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: true,
    contextBarEnabled: true,
    activityFrames: [],
    workingActivity: {
      phase: 'asking',
      line: '提问中',
      toolCount: 0,
      turnElapsedMs: 80_000,
      phaseStartedAt: Date.now() - 80_000,
    },
    subscribe: listeners
      ? (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
      : () => () => {},
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  } as never
}

const tallRows: unknown[] = []
for (let i = 0; i < 60; i++) {
  tallRows.push({ id: i * 2, kind: 'user', text: `第 ${i + 1} 轮：帮我处理一下这个问题` })
  tallRows.push({ id: i * 2 + 1, kind: 'assistant', text: `好的，第 ${i + 1} 轮处理完毕。`, time: Date.now() })
}
const shortRows: unknown[] = [
  { id: 0, kind: 'user', text: '再来问一个问题' },
  { id: 1, kind: 'assistant', text: '好嘞，再来一发～', time: Date.now() },
]

let failures = 0
const check = (name: string, screenText: string) => {
  const missing = REQUIRED.filter(t => !screenText.includes(t))
  if (missing.length === 0) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name} — 缺: ${missing.join(' / ')}`)
  }
}

/** 场景 1+2：静态渲染（短/长高录）。 */
for (const [name, rows] of [['短会话', shortRows], ['长高录', tallRows]] as const) {
  const { stdout, FakeStdin, screen } = makeHarness(160, 50)
  const store = new QuestionStore()
  const app = await render(
    React.createElement(Chat, { channel: makeChannel(rows as unknown[]), questionStore: store as never }),
    { stdout, stdin: new FakeStdin(), stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  void store.ask({ questions: [EXACT_QUESTION] } as never)
  await sleep(600)
  check(`静态渲染（${name}）`, screen())
  app.unmount()
  await sleep(100)
}

/** 场景 3：activity 持续 tick 下的差分重绘。 */
{
  const { stdout, FakeStdin, screen } = makeHarness(160, 45)
  const listeners = new Set<() => void>()
  const channel = makeChannel(tallRows, listeners)
  const store = new QuestionStore()
  const app = await render(
    React.createElement(Chat, { channel, questionStore: store as never }),
    { stdout, stdin: new FakeStdin(), stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  void store.ask({ questions: [EXACT_QUESTION] } as never)
  await sleep(400)
  let worst = ''
  let worstMissing = -1
  for (let tick = 0; tick < 20; tick++) {
    ;(channel.workingActivity as { turnElapsedMs: number }).turnElapsedMs += 1000
    channel.responseChars += 1
    channel.version += 1
    for (const l of [...listeners]) l()
    await sleep(120)
    const s = screen()
    const missing = REQUIRED.filter(t => !s.includes(t)).length
    if (missing > worstMissing) {
      worstMissing = missing
      worst = s
    }
  }
  check('activity tick 差分重绘（20 次取最坏帧）', worst)
  app.unmount()
  await sleep(100)
}

/** 场景 4：resize 风暴（160x50 → 200x60 → 快速抖到 130x42）。 */
{
  const { term, stdout, FakeStdin, screen } = makeHarness(160, 50)
  const store = new QuestionStore()
  const app = await render(
    React.createElement(Chat, { channel: makeChannel(tallRows), questionStore: store as never }),
    { stdout, stdin: new FakeStdin(), stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  void store.ask({ questions: [EXACT_QUESTION] } as never)
  await sleep(400)
  for (const [c, r] of [[200, 60], [190, 58], [160, 50], [135, 44], [130, 42]] as const) {
    stdout.columns = c
    stdout.rows = r
    term.resize(c, r)
    stdout.emit('resize')
    await sleep(90)
  }
  await sleep(800)
  check('resize 风暴后（130x42）', screen())
  app.unmount()
  await sleep(100)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
