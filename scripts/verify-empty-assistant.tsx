/**
 * verify-empty-assistant — PR #383 的重复圆点 bug 回归：
 * 模型直接调工具（不产文本）时 assistant/message 产生空文本行，渲染为
 * 工具卡上方的孤立 `●`。过滤发生在 visibleRows 管线（虚拟化之前）。
 *
 * 断言：
 *  1. 空 settled assistant 行被过滤——不出现孤立 ● 行（● 后无内容）；
 *  2. 前后的工具卡与真实正文不受影响；
 *  3. 空文本但 streaming 的 assistant 行保留（live dot 是“正在回答”信号）；
 *  4. 落定翻转（streaming true→false 原地写、rows 身份不变）后过滤生效；
 *  5. 用户/通知等其他空文本行不受影响（kind 限定 assistant）。
 *
 * 运行：node --import tsx/esm scripts/verify-empty-assistant.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

const COLS = 100, ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
/** 孤立 ● 行：以 ● 开头、后面只有空白。 */
function loneDotLines(lines: string[]): string[] {
  return lines.filter(l => /^●\s*$/.test(l))
}

const rows: any[] = [
  { id: 0, kind: 'user', text: '帮我跑一下测试' },
  // 空文本 settled assistant（PR #383 的 bug 形状：模型直接调工具）
  { id: 1, kind: 'assistant', text: '', streaming: false },
  { id: 2, kind: 'tool', text: '', tool: { callId: 't1', name: 'Bash', argsText: '{"command": "npm test"}', argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 42, resultText: 'all 12 tests passed' } },
  { id: 3, kind: 'assistant', text: '测试全部通过，共 12 项。REALBODY-END', streaming: false },
  // 空文本但 streaming：必须保留（live dot）
  { id: 4, kind: 'assistant', text: '', streaming: true },
]

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: true, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 1, turnStart: Date.now(),
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude', agentPreset: undefined, subagents: [], lastUserText: '帮我跑一下测试',
  scrollGutter: 'timeline', whale: true,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  emit() { channel.version++; for (const cb of listeners) cb() },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const inst = await render(
  <AlternateScreen><Chat channel={channel} questionStore={new QuestionStore()} fullscreen /></AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(700)

{
  const lines = screenLines()
  const screen = lines.join('\n')
  // bug 形状：工具卡【上方】的孤立 ●（空 settled assistant）。streaming
  // 空行的 live dot 在工具卡下方，是设计行为，不算。
  const toolRow = lines.findIndex(l => l.includes('Bash'))
  const dotAboveTool = toolRow >= 0 && lines.slice(0, toolRow).some(l => /^●\s*$/.test(l))
  check('空 settled assistant 行被过滤（工具卡上方无孤立 ●）', !dotAboveTool,
    `toolRow=${toolRow}`)
  check('空文本 streaming 行保留（live dot）', lines.slice(toolRow).some(l => l.includes('●')),
    '')
  check('工具卡正常渲染', screen.includes('Bash'), '')
  check('真实正文正常渲染', screen.includes('REALBODY-END'), '')
}

// 落定翻转：streaming true → false 原地写（rows 身份/长度不变）
rows[4]!.streaming = false
channel.emit()
await sleep(500)
{
  const lines = screenLines()
  check('落定翻转后空 assistant 行被过滤（缓存流位指纹生效）', loneDotLines(lines).length === 0,
    `lone dots=${loneDotLines(lines).length}`)
  check('翻转后真实正文仍在', lines.join('\n').includes('REALBODY-END'), '')
}
// 用户空文本行不受影响（kind 限定）：一个空 user 行仍渲染其气泡形状
rows.push({ id: 5, kind: 'user', text: '' })
channel.emit()
await sleep(400)
check('空 user 行不受 assistant 过滤影响（无崩溃、界面存活）', screenLines().some(l => l.includes('❯')))

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
