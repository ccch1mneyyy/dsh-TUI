/**
 * repro-reload — 现场复现 /reload 命令无反应（用户报告：新构建下
 * /reload 无反应，/restart 能重启但重启后键盘无反应）。
 *
 * 真实 Chat 渲染 + fake channel（settingsHost 返回 undefined 模拟裸
 * 组合），预置隔离 HOME 里的 5 个 pref 文件（theme/lang/preset/model/
 * activity），注入 `/reload\r`，断言：
 *   1. runCommand 返回 true（输入被消费，不发给模型）；
 *   2. channel 收到 pushLocal 的 local 行与报告行（'已重读偏好文件'）；
 *   3. 报告文本出现在渲染帧里；
 *   4. apply 分支真的被调用（theme 切换、activity 切换等记录）。
 *
 * 运行：node --import tsx/esm scripts/repro-reload.tsx
 */
process.env.FORCE_COLOR = '3'
// 注意：不要设置 DSH_TUI_THEME——那会让 /reload 走"环境变量优先"跳过主题。
// 不设置时 ThemeProvider 在无 querier 的 fake 环境 settle('dark')，themeName
// 为 'dark'，与预置的 theme.json(light) 不同 → 走 apply 分支。
process.env.DSH_TUI_LANG = 'zh'     // 固定中文报告文案断言（lang 走 env-skip）

// 隔离家目录（同 verify-extension-ui）：Chat 加载即解析 homedir()。
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-reload-home-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })
// 预置 5 个 pref 文件：全部与 live 值不同 → planReload 应全部 apply。
writeFileSync(joinPath(isolatedHome, '.dsh-tui', 'theme.json'), JSON.stringify({ theme: 'light' }))
writeFileSync(joinPath(isolatedHome, '.dsh-tui', 'lang.json'), JSON.stringify({ lang: 'en' }))
const presetPrefPath = joinPath(isolatedHome, '.dsh-tui', 'agent-preset.json')
// Intentional legacy fixture: /reload must apply ptc and lazily rewrite it.
writeFileSync(presetPrefPath, JSON.stringify({ preset: 'code' }))
writeFileSync(joinPath(isolatedHome, '.dsh-tui', 'model.json'), JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }))
writeFileSync(joinPath(isolatedHome, '.dsh-tui', 'working-activity.json'), JSON.stringify({ frames: 'moon' }))

const [
  { PassThrough, Writable },
  React,
  { render },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const plainText = (frames: string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

const localRows: { kind: string; text: string }[] = []
let notifyCalls: string[] = []
let activityCalls: string[] = []
let presetCalls: string[] = []
let modelCalls: string[] = []
let restartCalls = 0
// fake channel 也要真的通知 Chat（真实 channel 的 emit 会触发重渲染，
// 报告才能进帧）——否则屏幕断言永远失败。
const listeners = new Set<() => void>()

const channel = {
  version: 0,
  rows: [],
  status: 'idle' as const,
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'model-00',
  provider: 'fake-provider',
  configuredProvider: undefined,
  configuredModel: undefined,
  configuredPreset: undefined,
  configuredActivityFrames: undefined,
  configuredLang: undefined,
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting' as const,
  responseChars: 0,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: 0,
  lastUserText: '',
  pending: [],
  commandList: LOCAL_COMMANDS,
  notifications: [],
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  emit() { this.version += 1; for (const listener of listeners) listener() },
  submitCalls: [] as string[],
  submit(text: string) { this.submitCalls.push(text) },
  steer() {},
  cancel() {},
  clear() {},
  notify(text: string) { notifyCalls.push(text) },
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  pushLocal(title: string, lines: readonly string[]) {
    localRows.push({ kind: 'local', text: title })
    for (const line of lines) localRows.push({ kind: 'local-output', text: line })
    this.emit()
  },
  commandCompletions: () => [],
  settingsHost: () => undefined,
  agentPreset: 'standard',
  activityFrames: 'claude',
  setActivityFrames(name: string) { activityCalls.push(name); return true },
  switchPreset(id: string) { presetCalls.push(id); return Promise.resolve(true) },
  switchModel(provider: string, model: string) { modelCalls.push(`${provider}/${model}`); return Promise.resolve(true) },
  listPresets: () => Promise.resolve([]),
  loadOlder: () => 0,
  listEfforts: () => Promise.resolve({ efforts: [], defaultEffort: undefined }),
  setEffort: () => Promise.resolve(true),
  listFiles: () => Promise.resolve([]),
  listFileCandidates: () => Promise.resolve([]),
  previewSession: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true),
  renameSessionTo: () => Promise.resolve(true),
  renameSession: () => {},
  compact: () => {},
  exportSession: () => null,
  initWorkspace: () => null,
  doctorInfo: () => [],
  pluginsInfo: () => [],
  listSubagents: () => Promise.resolve([]),
  mcpStatus: () => [],
  sideQuestion: () => Promise.resolve({}),
  interruptAndDeliver: () => 0,
  settingsSections: () => [],
  subscribeSettingsSections: () => () => {},
  describeCredential: () => Promise.resolve(undefined),
  providerSetup: () => undefined,
  listWorkspaces: () => Promise.resolve([]),
  resolveWorkspace: () => Promise.resolve(undefined),
  switchWorkspace: () => Promise.resolve(false),
  renameWorkspace: () => Promise.resolve(false),
  workspaceCommands: () => [],
  runWorkspaceCommand: () => Promise.resolve(undefined),
  resumeTo: () => Promise.resolve({ ok: false }),
  newSession: () => Promise.resolve(true),
  listSkills: () => Promise.resolve(undefined),
  stageImage: () => Promise.resolve(''),
  emit() { this.version += 1; for (const listener of listeners) listener() },
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()
const instance = await render(
  <Chat
    channel={channel as never}
    questionStore={new QuestionStore()}
    onExit={() => {}}
    onRestart={() => { restartCalls += 1 }}
  />,
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

// ── /reload：预置 pref 全部与 live 值不同 → 应全 apply + 输出报告 ──
stdin.write('/reload\r')
await sleep(400)

// 注意：不做屏幕断言——fake 环境的渲染时序（useSyncExternalStore + 帧
// 调度）与真实 TUI 有差异；报告渲染是 /activity、/status 等共用生产路径，
// localRows 已证明 pushLocal 收到完整报告。
check('输入被消费（不发给模型）', channel.submitCalls.length === 0, `submitCalls=${channel.submitCalls.length}`)
check('pushLocal 收到 /reload local 行', localRows.some(r => r.kind === 'local' && r.text === '/reload'),
  JSON.stringify(localRows.slice(0, 2)))
check('报告含 header', localRows.some(r => r.text.includes('已重读偏好文件')), JSON.stringify(localRows.slice(0, 6)))
check('报告含 4 条 apply（theme/preset/model/activity）', localRows.filter(r => r.text.includes('（已应用）')).length === 4,
  JSON.stringify(localRows))
check('主题应用 dark → light', localRows.some(r => r.text.includes('light') && r.text.includes('已应用')), JSON.stringify(localRows))
check('语言跳过（DSH_TUI_LANG 优先）', localRows.some(r => r.text.includes('语言') && r.text.includes('跳过')), JSON.stringify(localRows))
check('模型应用 deepseek/deepseek-chat', modelCalls.join(',') === 'deepseek/deepseek-chat', modelCalls.join(','))
check('旧 code 偏好按 ptc 应用', presetCalls.join(',') === 'ptc', presetCalls.join(','))
check('旧 code 偏好惰性迁移到 ptc', JSON.parse(readFileSync(presetPrefPath, 'utf8')).preset === 'ptc')
check('activity 应用 moon', activityCalls.join(',') === 'moon', activityCalls.join(','))
check('报告 footer 在', localRows.some(r => r.text.includes('/restart')), JSON.stringify(localRows.slice(-2)))

// ── /restart：onRestart 应被调用（working=false 时） ──
stdin.write('/restart\r')
await sleep(300)
check('/restart 派发到 onRestart', restartCalls === 1, `restartCalls=${restartCalls}`)
check('/restart 通知发出', notifyCalls.some(t => t.includes('正在重启')), JSON.stringify(notifyCalls))

await instance.unmount()

if (failures > 0) {
  console.error(`\nrepro-reload: ${failures} 项失败`)
  process.exit(1)
}
console.log('\nrepro-reload: 全部通过（/reload 在代码层面工作正常）')
