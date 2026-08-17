#!/usr/bin/env node
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ Writable, PassThrough }, React, { Terminal }, { render }, { Chat }, { setLang }, commands, instancesModule] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/i18n.js'),
  import('../src/commands.js'),
  import('../src/ink/instances.js'),
])
const instances = instancesModule.default
setLang('zh')

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const cols = 90
const rows = 24
const term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true })
const stdout = new Writable({
  write(chunk, _encoding, callback) {
    term.write(String(chunk), callback)
  },
}) as Writable & { columns: number; rows: number; isTTY: boolean }
stdout.columns = cols
stdout.rows = rows
stdout.isTTY = true
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as Writable & { isTTY: boolean }
stderr.isTTY = true
const stdin = new PassThrough() as PassThrough & {
  isTTY: boolean
  setRawMode: () => typeof stdin
  ref: () => typeof stdin
  unref: () => typeof stdin
}
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.ref = () => stdin
stdin.unref = () => stdin

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: { kind: 'root' },
  title: { text: id, source: 'auto' },
  cwd: '/repo',
  createdAt: 1,
  updatedAt: 1,
  bytes: 1024,
  hasPrompt: true,
  agentPreset: 'standard',
  model: 'deepseek-chat',
  label: undefined,
  branch: 'main',
  childCount: 0,
  ...over,
})
const sessions = [
  summary('root', { title: { text: '根会话', source: 'auto' }, createdAt: 1 }),
  summary('current', { title: { text: '当前分支', source: 'auto' }, kind: { kind: 'fork', parent: 'root' }, createdAt: 2 }),
  summary('child', { title: { text: '后续分支', source: 'auto' }, kind: { kind: 'fork', parent: 'current' }, createdAt: 3 }),
  summary('sibling', { title: { text: '兄弟分支', source: 'auto' }, kind: { kind: 'fork', parent: 'root' }, createdAt: 4 }),
  summary('agent-run', { title: { text: '不应出现的子代理', source: 'auto' }, kind: { kind: 'subagent', parent: 'current', depth: 1 } }),
  summary('unrelated', { title: { text: '不应出现的无关会话', source: 'auto' } }),
]
const calls = { resume: [] as string[], fork: 0 }
const listeners = new Set<() => void>()
const channel = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: '当前分支',
  agentId: 'current',
  model: 'deepseek-chat',
  provider: 'deepseek',
  tokens: { input: 0, output: 0 },
  cwd: '/repo',
  displayCwd: '/repo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: '',
  pending: [],
  notifications: [],
  contextWindow: undefined,
  reasoningEffort: 'high',
  workingActivity: undefined,
  activityEnabled: false,
  contextBarEnabled: true,
  agentPreset: 'standard',
  goal: undefined,
  todos: [],
  commandList: commands.LOCAL_COMMANDS,
  commandCompletions(input: string) { return commands.completeCommands(input, this.commandList) },
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
  modeIndex: 0,
  async listSessions() { return sessions },
  async resumeTo(id: string) { calls.resume.push(id); this.agentId = id; return true },
  async forkSession() { calls.fork += 1; return true },
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  emit() { this.version += 1; for (const listener of listeners) listener() },
  notify() {}, pushLocal() {}, submit() {}, steer() {}, cancel() {}, clear() {}, compact() {},
  removePending: () => true, interruptAndDeliver: () => 0, loadOlder: () => 0,
  listModels: async () => [], listFiles: async () => [], listWorkspaces: async () => [],
  resolveWorkspace: async () => undefined, switchWorkspace: async () => false,
  renameWorkspace: async () => false, workspaceCommands: () => [], runWorkspaceCommand: async () => undefined,
  setResumeTarget() {}, renameSession() {}, renameSessionTo: async () => false, deleteSession: async () => false,
  previewSession: async () => [], setActivityFrames: () => true, activityFrames: 'claude',
  runExternalCommand: async () => undefined, mcpStatus: () => [], exportSession: () => null,
  initWorkspace: () => null, doctorInfo: () => [], listSubagents: async () => [],
  listPresets: async () => [], switchPreset: async () => false, switchModel: async () => false,
  rewindTo: async () => null, newSession: async () => false, listEfforts: async () => ({ efforts: [], defaultEffort: undefined }),
  setEffort: async () => false, cycleMode: async () => {}, listSkills: async () => [],
  describeCredential: async () => undefined, settingsHost: () => undefined, settingsSections: () => [],
  subscribeSettingsSections: () => () => {}, providerSetup: () => undefined,
  commandChildren: () => [], traceEvents: () => [], sideQuestion: async () => ({ answer: null }),
  stageImage: async () => '', closePluginScene() {}, openPluginScene: () => false,
}

const instance = await render(
  <Chat channel={channel as never} questionStore={{ subscribe: () => () => {}, getSnapshot: () => null, answerCurrent() {} } as never} onExit={() => {}} />,
  { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)

const screen = () => Array.from({ length: term.rows }, (_, y) =>
  (term.buffer.active.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/u, ''),
).join('\n')
const type = async (text: string) => {
  for (const char of text) {
    stdin.write(char)
    await sleep(35)
  }
}

await sleep(500)
await type('/tree')
stdin.write('\r')
await sleep(600)
let frame = screen()
check('/tree 打开全屏分支树', frame.includes('会话分支'), frame.slice(0, 140))
check('树包含当前 lineage', frame.includes('根会话') && frame.includes('当前分支') && frame.includes('后续分支') && frame.includes('兄弟分支'))
check('树排除子代理和无关会话', !frame.includes('不应出现的子代理') && !frame.includes('不应出现的无关会话'))
check('默认聚焦当前节点', /❯.*当前分支/u.test(frame), frame.split('\n').find(line => line.includes('❯')) ?? '')

if (process.env.DSH_TUI_CAPTURE_SESSION_TREE === '1') {
  const [{ mkdirSync, writeFileSync }, { resolve }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
  ])
  const directory = resolve('artifacts/issue-81')
  const escaped = frame
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'after.txt'), frame)
  writeFileSync(
    resolve(directory, 'after.html'),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111318;color:#e5e7eb}body{padding:28px}pre{font:16px/1.35 "Cascadia Mono","Consolas",monospace;white-space:pre;margin:0}</style><pre>${escaped}</pre>`,
  )
}

stdout.columns = 40
stdout.rows = 8
term.resize(40, 8)
stdout.emit('resize')
await sleep(350)
frame = screen()
check(
  '40x8 短终端没有换行溢出',
  Array.from({ length: term.rows }, (_, y) => term.buffer.active.getLine(y)?.isWrapped === true).every(wrapped => !wrapped),
)
check('40x8 操作提示仍在最后一行', term.buffer.active.getLine(7)?.translateToString(true).includes('Enter') === true)

stdout.columns = cols
stdout.rows = rows
term.resize(cols, rows)
stdout.emit('resize')
await sleep(350)

stdin.write('\x1b[B')
await sleep(120)
stdin.write('\r')
await sleep(500)
check('Enter 恢复选中的分支', calls.resume.join(',') === 'child', calls.resume.join(','))

await type('/fork')
stdin.write('\r')
await sleep(300)
check('/fork 调用 channel 分叉', calls.fork === 1, String(calls.fork))

instance.unmount()
if (failed > 0) process.exitCode = 1
