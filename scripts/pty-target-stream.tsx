/**
 * conpty 增量压力探测的目标进程（issue #16/#10）：真实 stdout（inline 模式，
 * 与 npm 安装默认一致）上先流式渲染长回复（多帧 diff），中途弹 ask 问卷、
 * spinner/指标持续 tick——多帧增量序列经 conpty 重编码后，宿主重建屏幕
 * 断言问卷完整。静态一帧的探测（pty-target.tsx）已验证通过，本脚本针对
 * 增量 diff 的保真度。
 */
process.env.FORCE_COLOR = '3'
const [{ default: React }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('react'), import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/questions.js'),
])

const listeners = new Set<() => void>()
const rows: any[] = []
let id = 0
for (let i = 0; i < 8; i++) {
  rows.push({ id: id++, kind: 'user', text: `第 ${i + 1} 轮：帮我处理一下这个问题` })
  rows.push({ id: id++, kind: 'assistant', text: `好的，第 ${i + 1} 轮处理完毕。回答涉及配置检查、依赖对齐与构建验证三部分。`, streaming: false })
}
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', reasoningEffort: 'max', tokens: { input: 120, output: 45 },
  cwd: 'C:/code/demo-project', gitBranch: 'main', working: true,
  spinnerMode: 'requesting', responseChars: 20, activeToolCount: 0, turnStart: Date.now(),
  lastUserText: '再来问一个问题', pending: [], commandList: [], notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const store = new QuestionStore()
const app = render(React.createElement(Chat, { channel, questionStore: store as never }), { exitOnCtrlC: false, patchConsole: false })
const ticker = setInterval(() => { channel.responseChars += 7; bump() }, 100)
await sleep(1000)

// 流式长回复：问卷会在 2/3 处弹出，之后正文继续流（真实并发场景）。
const finalMsg = { id: id++, kind: 'assistant', text: '', streaming: true }
rows.push(finalMsg); bump()
const chunks: string[] = []
for (let s = 1; s <= 6; s++) {
  chunks.push(`第 ${s} 节要点\n`)
  for (let i = 0; i < 8; i++) chunks.push(`- 第 ${s} 节第 ${i + 1} 条：装配、主题、同步与加密打包的说明文字\n`)
}
let asked = false
let i = 0
for (const c of chunks) {
  finalMsg.text += c
  bump()
  i++
  if (!asked && i >= Math.floor(chunks.length * 2 / 3)) {
    asked = true
    void store.ask({
      questions: [{
        header: '随便问问 2', id: 'weekend_plan',
        question: '再测一次：如果明天是周末，你大概率会怎么过？',
        options: [
          { label: '宅家打游戏/看剧', description: '把想做的事列成清单，一样一样划掉，很有成就感。' },
          { label: '出去浪一圈', description: '出门走走，吃点好的，换换脑子。' },
          { label: '学习或写代码', description: '继续写代码/学新东西，卷王本王。' },
          { label: '纯躺平休息', description: '什么都不安排，睡到自然醒。' },
        ],
      }],
    } as never)
  }
  await sleep(80)
}
finalMsg.streaming = false
bump()
await sleep(1500)
clearInterval(ticker)
await sleep(500)
try { (app as { unmount?: () => void }).unmount?.() } catch { /* 探测脚本收尾不影响断言 */ }
process.exit(0)
