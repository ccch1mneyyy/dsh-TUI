/** conpty 探测的目标进程：真实 stdout 渲染 Chat + ask 问卷（精确 payload）。 */
process.env.FORCE_COLOR = '3'
const [{ default: React }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('react'), import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/questions.js'),
])
const rows: unknown[] = []
for (let i = 0; i < 60; i++) {
  rows.push({ id: i * 2, kind: 'user', text: `第 ${i + 1} 轮：帮我处理一下这个问题` })
  rows.push({ id: i * 2 + 1, kind: 'assistant', text: `好的，第 ${i + 1} 轮处理完毕。`, time: Date.now() })
}
const channel = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', tokens: { input: 120, output: 45 },
  cwd: 'C:/code/demo-project', gitBranch: 'main', working: true,
  spinnerMode: 'requesting', responseChars: 20, activeToolCount: 0, turnStart: Date.now(),
  lastUserText: '再来问一个问题', pending: [], commandList: [], notifications: [],
  activityEnabled: true, activityFrames: [], contextBarEnabled: true,
  workingActivity: { phase: 'asking', line: '提问中', toolCount: 0, turnElapsedMs: 80000, phaseStartedAt: Date.now() - 80000 },
  subscribe: () => () => {}, submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
} as never
const store = new QuestionStore()
const app = render(React.createElement(Chat, { channel, questionStore: store as never }), { exitOnCtrlC: false, patchConsole: false })
await new Promise(r => setTimeout(r, 1200))
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
await new Promise(r => setTimeout(r, 2500))
try { (app as { unmount?: () => void }).unmount?.() } catch { /* 探测脚本收尾不影响断言 */ }
process.exit(0)
