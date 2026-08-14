/**
 * Faithful fullscreen streaming repro v2:
 * - pre-seeded "resumed" history (~2.5 viewports) with cold height cache
 * - working spinner ticking during the whole stream (independent dirty frames)
 * - status metrics ticking (~10/s channel bumps without content change)
 * - reasoning rows streaming expanded then folding (height shrink mid-stream)
 * - tool cards running->ok with long multi-line results
 * - final assistant message with markdown table streamed chunk-wise
 * Dumps the emulated screen after each phase; look for two fragments sharing
 * one row (stale-Y collisions) or dropped/duplicated lines.
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'  // force DEC-2026 path (SYNC_OUTPUT_SUPPORTED=true) so the DECSTBM scroll-hint optimization fires

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 200
const ROWS = 50
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })

const rawChunks: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { rawChunks.push(String(chunk)); term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function screenText(): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out.map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n')
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [] as any[],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 1,
  turnStart: Date.now(),
  lastUserText: '看看这个项目',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

let id = 0
// --- pre-seed resumed history: 2 full turns (~2.5 viewports) ---------------
for (let turn = 0; turn < 2; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `历史问题 ${turn}：检查一下构建配置` })
  channel.rows.push({ id: id++, kind: 'reasoning', text: '用户想看构建配置，先找配置文件。'.repeat(3), streaming: false, durationMs: 1200 })
  for (let t = 0; t < 4; t++) {
    channel.rows.push({
      id: id++, kind: 'tool', text: '',
      tool: {
        callId: `h${turn}-${t}`, name: t % 2 ? 'Read' : 'Bash',
        argsText: t % 2 ? `{"file_path": "/home/sisct/Code/projects/FlutterProjects/jotsy/lib/history${turn}_${t}.dart"}` : `{"command": "git log --oneline -15 && echo \\"---STATUS---\\" && git status --short && git branch --show-current", "description": "Show recent commits and working tree status"}`,
        argsFull: '{}',
        status: 'ok', startedAt: Date.now() - 60000, durationMs: 30,
        resultText: Array.from({ length: 8 + t * 5 }, (_, i) => `eb33e0${i} ci: separate runtime properties 历史结果行 ${turn}-${t}-${i} (cikeseven, 2026-07-12)`).join('\n'),
      },
    })
  }
  channel.rows.push({ id: id++, kind: 'assistant', text: `历史回答 ${turn}：\n\n- 构建配置在 \`pubspec.yaml\`\n- CI 在 \`.github/workflows/\`\n\n| 项 | 值 |\n| --- | --- |\n| SDK | ^3.7.0 |\n| riverpod | ^3.2.1 |`, streaming: false })
}

const stdin = new FakeStdin()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: new FakeStdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)

// metrics ticking ~10/s for the whole run (status line tps etc.)
const ticker = setInterval(() => {
  channel.responseChars += 7
  bump()
}, 100)

await sleep(800)

// --- live turn ---------------------------------------------------------------
const add = (row: any) => { channel.rows.push({ id: id++, ...row }); bump() }
add({ kind: 'user', text: '看看这个项目，给个概览' })
await sleep(120)

const think1 = { id: id++, kind: 'reasoning', text: '', streaming: true, durationMs: undefined }
channel.rows.push(think1); bump()
for (const chunk of ['先看目录结构', '，读 README 和 pubspec', '，然后汇总。']) {
  think1.text += chunk; bump(); await sleep(140)
}
think1.streaming = false; think1.durationMs = 1000; bump()
await sleep(150)

const tool1 = {
  id: id++, kind: 'tool', text: '',
  tool: {
    callId: 'c1', name: 'Bash',
    argsText: '{"command": "git log --oneline -15 && echo \\"---STATUS---\\" && git status --short && git branch --show-current", "description": "Show recent commits and working tree status"}',
    argsFull: '{}',
    status: 'running', resultText: undefined, startedAt: Date.now(), durationMs: undefined,
  },
}
channel.rows.push(tool1); bump(); await sleep(500)
tool1.tool.status = 'ok'
tool1.tool.durationMs = 42
tool1.tool.resultText = 'eb33e02 ci: separate runtime properties\neb33e03 ci: improve release secret diagnostics\n' + Array.from({ length: 24 }, (_, i) => `M  lib/file${i}.dart (cikeseven, 2026-07-12)`).join('\n')
channel.activeToolCount = 0
bump(); await sleep(200)

for (let t = 2; t <= 4; t++) {
  add({
    kind: 'tool', text: '',
    tool: {
      callId: `c${t}`, name: 'Read',
      argsText: `{"file_path": "/home/sisct/Code/projects/FlutterProjects/jotsy/lib/file${t}.dart"}`,
      argsFull: '{}',
      status: 'ok', startedAt: Date.now(), durationMs: 12,
      resultText: `<path>/home/sisct/Code/projects/FlutterProjects/jotsy/lib/file${t}.dart</path>\n<type>file</type>\n<content>\n` + Array.from({ length: 10 + t * 4 }, (_, i) => `// line ${i} of file ${t}`).join('\n'),
    },
  })
  await sleep(140)
}

const think2 = { id: id++, kind: 'reasoning', text: '结构清楚了，整理概览，含表格。', streaming: true, durationMs: undefined }
channel.rows.push(think2); bump(); await sleep(500)
think2.streaming = false; think2.durationMs = 7000; bump(); await sleep(150)

const finalMsg = { id: id++, kind: 'assistant', text: '', streaming: true }
channel.rows.push(finalMsg); bump()
const doc = [
  '项目看完了，给你一份概览：\n',
  '\n## 项目概况\n\n',
  'Jotsy（Jot）—— 一款完全本地化、注重隐私的 Android 日记应用（开源，早期版本）。\n\n',
  '| 方面 | 选型 |\n| --- | --- |\n',
  '| 框架 | Flutter / Dart SDK ^3.7.0 |\n',
  '| 状态管理 | flutter_riverpod ^3.2.1 |\n',
  '| 数据库 | Drift (SQLite), schema v7, 按 query/write/migration/tag ops 拆分 |\n',
  '| 目录结构 | （与 AGENTS.md 分层规范一致） |\n',
  '| 编辑器 | flutter_quill + extensions（图文混排） |\n\n',
  '- `lib/app/` — App 装配、主题系统、WebDAV 同步、archive\n',
  '- `lib/core/` — database/ 与 services/（设置、定位、天气、备份、封面/媒体存储等）\n',
  '- `lib/ui/` — 按 feature 划分：diaries、home、calendar、explore、settings、widgets\n',
  '\n## 近期动态\n\n',
  '- 最新提交集中在：日记卡片标签显示配置（tag limit 功能）、CI 发布流程改进\n',
]
for (const chunk of doc) {
  finalMsg.text += chunk
  bump()
  await sleep(160)
}
finalMsg.streaming = false
channel.working = false
bump()
await sleep(1000)
clearInterval(ticker)
await sleep(300)

const allRaw = rawChunks.join('')
const scrollRegions = allRaw.match(/\x1b\[\d+;\d+r/g) ?? []
const scrollOps = allRaw.match(/\x1b\[\d+[ST]/g) ?? []
const resets = allRaw.match(/\x1b\[r/g) ?? []
console.log('DECSTBM regions:', scrollRegions.length, 'SU/SD ops:', scrollOps.length, 'region resets:', resets.length)
console.log('sample regions:', scrollRegions.slice(0, 8).map(x => JSON.stringify(x)).join(' '))
await import('node:fs').then(fs => fs.writeFileSync('/tmp/tui-stream.bin', Buffer.from(allRaw, 'utf8')))
console.log('=== screen after streaming settles ===')
console.log(screenText())
await instance.unmount()
process.exit(0)
