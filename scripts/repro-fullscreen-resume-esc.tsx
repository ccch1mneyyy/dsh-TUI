/**
 * repro-fullscreen-resume-esc — 用户稳定复现的全量条件重现。
 *
 * 用户报告：全屏模式进入 /resume 之类的整屏页面后，Esc 退回，稳定掉回
 * 主屏（失去鼠标交互）；且 resume 行 hover 高亮划过不消失。
 *
 * 与 repro-fullscreen-page-exit 的差异（都是真实使用条件）：
 *   1. 转录有真实历史（Esc 后帧从小页面切回大转录，重绘量大）；
 *   2. 在 /resume 里停留 >5s（STDIN_RESUME_GAP_MS）再 Esc——Esc 成为
 *      "gap 后第一个输入"，触发 reassertTerminalModes → 模式探测；
 *   3. Esc 前用 SGR motion 事件扫过若干 resume 行（hover enter/leave），
 *      断言移开后 leave 已派发（高亮不滞留）。
 *
 * 运行：node --import tsx/esm scripts/repro-fullscreen-resume-esc.tsx
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
const { SessionSummary } = await import('../src/dsh-adapter/sessions/index.js')

const COLS = 100, ROWS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    writes.push(String(chunk))
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

// 真实规模转录：60 轮对话（Esc 后切回的是大帧）
const T0 = Date.now() - 600_000
const chatRows: any[] = []
for (let i = 0; i < 30; i++) {
  chatRows.push({ id: i * 2, kind: 'user', text: `用户消息 ${i}：帮我看看这个问题`, time: T0 + i * 8000 })
  chatRows.push({ id: i * 2 + 1, kind: 'assistant', text: `助手回复 ${i}：这个问题看起来出在 ${'分析内容。'.repeat(8)}，建议从这几个方向排查。`, time: T0 + i * 8000 + 3000 })
}

// 会话列表：12 条（SessionSummary 形状：kind.kind、hasPrompt 缺一不可——
// 缺 hasPrompt 会被当成"无对话内容"计数而从不列出）
const sessions: any[] = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i}`,
  kind: { kind: 'root' },
  title: { text: `历史会话 ${i}`, source: 'auto' },
  cwd: '/tmp/demo',
  createdAt: T0 - i * 60_000,
  updatedAt: T0 + i * 60_000,
  bytes: 12_000 + i * 1000,
  branch: 'main',
  model: 'deepseek-v4-flash',
  childCount: 0,
  hasPrompt: true,
  label: undefined,
  agentPreset: undefined,
}))

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: chatRows,
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  pending: [],
  commandList: LOCAL_COMMANDS,
  notifications: [],
  mode: { plan: false, sandbox: undefined },
  activityFrames: 'claude',
  agentPreset: undefined,
  subagents: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => Promise.resolve(sessions),
  deleteSession: () => Promise.resolve(true),
  renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
  listResumeSessions: () => Promise.resolve(sessions),
  resumeSession: () => Promise.resolve(true),
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(700)
check('boot 后进入 alternate buffer', term.buffer.active.type === 'alternate', term.buffer.active.type)

// 打开 /resume（走命令）
stdin.write('/resume')
await sleep(350)
stdin.write('\r')
await sleep(600)
const lines0 = screenLines()
check('/resume 整屏浏览器打开', lines0.some(l => l.includes('历史会话') || l.includes('恢复')),
  (lines0.find(l => l.includes('历史会话')) ?? '').trim().slice(0, 30))

writes.length = 0 // 只看页面交互期的模式写

// ── hover 扫过三行再移走（mode-1003 无键 motion: SGR 35 = 3+32） ──
// 注意：聚焦行（❯ 历史会话 11）hover 不亮（focused 优先，by design），
// 测试行必须是非聚焦行
{
  const rowA = lines0.findIndex(l => l.includes('历史会话 0'))
  const rowB = lines0.findIndex(l => l.includes('历史会话 5'))
  const rowC = lines0.findIndex(l => l.includes('历史会话 4'))
  check('resume 行可见（0/5/4）', rowA >= 0 && rowB >= 0 && rowC >= 0, `rows=${rowA},${rowB},${rowC}`)
  if (rowA >= 0 && rowB >= 0 && rowC >= 0) {
    // 真实断言：xterm 单元背景色随 hover 出现、移开后消失
    const cellBg = (y: number, x = 20): number | undefined => {
      const cell = term.buffer.active.getLine(y)?.getCell(x)
      const color = cell?.getBgColor()
      // xterm headless reports default bg as -1 or 0; treat both as "none"
      return color === undefined || color === -1 || color === 0 ? undefined : color
    }
    const bgA0 = cellBg(rowA)
    const wBefore = writes.length
    stdin.write(`\x1b[<35;20;${rowA + 1}M`)
    await sleep(150)
    const bgA1 = cellBg(rowA)
    const wAfter = writes.slice(wBefore)
    if (process.env.HOVER_DEBUG) {
      console.log(`[dbg] motion1 writes=${wAfter.length} chunks, bg=${bgA1}`)
      for (const w of wAfter) console.log('   chunk:', JSON.stringify(w.slice(0, 400)))
    }
    check('hover 行 A → 背景高亮出现', bgA0 === undefined && bgA1 !== undefined, `bg ${bgA0} → ${bgA1}`)

    const writesAfterHoverA = writes.length
    stdin.write(`\x1b[<35;20;${rowB + 1}M`)
    await sleep(150)
    if (process.env.HOVER_DEBUG) {
      console.log(`[dbg] writes A→B: ${writes.length - writesAfterHoverA} chunks, A bg=${cellBg(rowA)} B bg=${cellBg(rowB)}`)
    }
    const bgA2 = cellBg(rowA)
    const bgB = cellBg(rowB)
    check('移到行 B → A 的高亮消失、B 出现（leave 派发）', bgA2 === undefined && bgB !== undefined, `A=${bgA2} B=${bgB}`)

    stdin.write(`\x1b[<35;20;${ROWS - 2}M`) // 移出列表
    await sleep(150)
    const bgB2 = cellBg(rowB)
    check('移出列表 → B 高亮消失', bgB2 === undefined, `B=${bgB2}`)
    check('hover 扫过列表后页面仍在 alternate buffer', term.buffer.active.type === 'alternate')
  }
}

// ── 滚轮下滚 = 焦点下移（❯ 随行移动；位置路由无 onWheel → 回落
// wheelDown 键 → 浏览器 step(1)，与 ↓ 同路径） ──
{
  const pointerRow = (): number => screenLines().findIndex(l => l.trimStart().startsWith('❯'))
  const p0 = pointerRow()
  check('聚焦行 ❯ 可见', p0 >= 0, `行${p0}`)
  if (p0 >= 0) {
    stdin.write(`\x1b[<65;40;${p0 + 3}M`) // SGR 65 = wheel down，列表中部
    await sleep(250)
    const p1 = pointerRow()
    check('滚轮下滚 → ❯ 下移到下一会话行', p1 > p0, `❯ ${p0} → ${p1}`)
    stdin.write(`\x1b[<64;40;${p1 + 3}M`) // wheel up 滚回
    await sleep(250)
    check('滚轮上滚 → ❯ 回到原位', pointerRow() === p0, `❯ → ${pointerRow()}`)
  }
}

// ── 停留 >5s 后 Esc（触发 stdin-gap 重断言路径） ──
await sleep(5300)
stdin.write('\x1b')
await sleep(600)

const afterType = term.buffer.active.type
check('Esc 退回后 buffer 仍是 alternate', afterType === 'alternate', `type=${afterType}`)

const exitAlt = writes.filter(w => w.includes('\x1b[?1049l'))
const mouseOff = writes.filter(w => /\x1b\[\?(1000|1002|1003|1006)l/.test(w))
check('页面交互期无 EXIT_ALT_SCREEN 写', exitAlt.length === 0, exitAlt.length ? JSON.stringify(exitAlt[0]!.slice(0, 50)) : '')
check('页面交互期无鼠标跟踪关闭写', mouseOff.length === 0, mouseOff.length ? JSON.stringify(mouseOff[0]!.slice(0, 50)) : '')

// stdin-gap 路径是否真的触发了模式探测（Esc 是 gap 后第一键）
const probed = writes.some(w => w.includes('\x1b[?1049$p'))
check('Esc（gap 后）触发了 1049 健康探测', probed,
  writes.filter(w => w.includes('$p')).length + ' 次 $p 写')

// 退回后主对话活着
stdin.write('qq')
await sleep(400)
const ls2 = screenLines()
check('退回后输入框可交互', ls2.some(l => l.includes('qq')),
  (ls2.find(l => l.includes('❯')) ?? '').trimEnd().slice(0, 30))

if (failed > 0) {
  console.log('--- 模式相关写（全量过滤 1049/100x/9001）---')
  for (const w of writes) {
    if (/1049|1000|1002|1003|1006|9001/.test(w)) console.log('   ', JSON.stringify(w.slice(0, 80)))
  }
}

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}

await inst.unmount()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
