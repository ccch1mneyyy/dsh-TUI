/** Minimal: which event appends the extra blank row below the statusline? */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
])
const COLS = 100, ROWS = 24
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
const rawChunks: string[] = []
let recording = false
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(c: unknown, _e: BufferEncoding, cb: () => void) {
    const s = String(c)
    if (recording) rawChunksSaved.push(s)
    const before = recording ? term.buffer.active.length : -1
    term.write(s, () => {
      if (recording) {
        const grow = term.buffer.active.length - before
        const lfs = (s.match(/\n/g) ?? []).length
        frameStats.push({ bytes: s.length, grow, lfs })
      }
      cb()
    })
  }
}
const rawChunksSaved: string[] = []
const frameStats: Array<{ bytes: number; grow: number; lfs: number }> = []
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows: [] as any[], status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', mode: { plan: false }, reasoningEffort: 'max', tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main', working: false, spinnerMode: 'requesting',
  responseChars: 0, activeToolCount: 0, turnStart: Date.now(), lastUserText: '',
  pending: [], commandList: [], notifications: [],
  _ls: listeners,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  { stdout: new FakeStdout() as any, stdin: new FakeStdin() as any, stderr: new FakeStderr() as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(3500)

/** buffer 末尾：statusline 位置 + 下方空行数。 */
function tailInfo(): { bufLen: number; statusY: number; blanksBelow: number } {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  let statusY = -1
  for (let y = lines.length - 1; y >= 0; y--) {
    if (lines[y]!.includes('deepseek-v4-flash')) { statusY = y; break }
  }
  let blanks = 0
  for (let y = lines.length - 1; y > statusY; y--) blanks++
  return { bufLen: buf.length, statusY, blanksBelow: blanks }
}
const report = (label: string) => {
  const t = tailInfo()
  console.log(`${label}: buffer=${t.bufLen} statusline@${t.statusY} 下方空行=${t.blanksBelow}`)
  return t
}

let id = 0
// 阶段 1：只长 assistant 流式（working=false，无 spinner 行）
report('基线（空会话）')
{
  channel.rows.push({ id: id++, kind: 'user', text: 'Q1' })
  const a = { id: id++, kind: 'assistant', text: '', streaming: true }
  channel.rows.push(a); bump()
  for (let i = 0; i < 30; i++) { a.text += `- L1 行 ${i}\n`; bump(); await sleep(60) }
  a.streaming = false; bump(); await sleep(500)
  report('阶段1 纯 assistant 流式（无 working 切换）')
}
// 阶段 2：working true→false（spinner 行挂载→卸载 = 收缩）
{
  channel.rows.push({ id: id++, kind: 'user', text: 'Q2' })
  channel.working = true
  rawChunks.length = 0; recording = true
  bump(); await sleep(200)
  const a = { id: id++, kind: 'assistant', text: '', streaming: true }
  channel.rows.push(a); bump()
  for (let i = 0; i < 30; i++) { a.text += `- L2 行 ${i}\n`; bump(); await sleep(60) }
  a.streaming = false
  channel.working = false
  bump(); await sleep(500)
  recording = false
  // 解码收缩帧尾部的转义序列
  const decode = (s: string) => s
    .replace(/\x1b\[\?2026h/g, '[BSU]').replace(/\x1b\[\?2026l/g, '[ESU]')
    .replace(/\x1b\[(\d*)A/g, (_, n) => `[CUU${n || 1}]`)
    .replace(/\x1b\[(\d*)B/g, (_, n) => `[CUD${n || 1}]`)
    .replace(/\x1b\[(\d*)K/g, (_, n) => `[EL${n || 0}]`)
    .replace(/\x1b\[2J/g, '[ED2]').replace(/\x1b\[J/g, '[ED0]')
    .replace(/\x1b\[H/g, '[HOME]').replace(/\r/g, '[CR]').replace(/\n/g, '[LF]')
    .replace(/\x1b\[\?25l/g, '[HIDE]').replace(/\x1b\[m/g, '[SGR0]')
  let growFrames = 0
  frameStats.forEach((st, i) => {
    if (st.grow > 0) {
      growFrames++
      const d = decode(rawChunksSaved[i] ?? '')
      console.log(`  涨行帧#${i}(${st.bytes}B, LF×${st.lfs}) buffer+${st.grow} 尾: …${d.slice(-70)}`)
    }
  })
  const totalGrow = frameStats.reduce((s, f) => s + f.grow, 0)
  console.log(`  [阶段2录制] 共 ${frameStats.length} 帧，涨行帧 ${growFrames} 个，buffer 总涨 ${totalGrow}`)
  report('阶段2 含 working 切换（spinner 收缩）')
}
// 阶段 3：reasoning 流式→折叠（thinking fold 收缩）
{
  channel.rows.push({ id: id++, kind: 'user', text: 'Q3' })
  channel.working = true; bump(); await sleep(200)
  const r = { id: id++, kind: 'reasoning', text: '', streaming: true }
  channel.rows.push(r); bump()
  for (let i = 0; i < 12; i++) { r.text += `推理 ${i} `.repeat(8); bump(); await sleep(60) }
  r.streaming = false; r.durationMs = 500; bump(); await sleep(200)
  const a = { id: id++, kind: 'assistant', text: '', streaming: true }
  channel.rows.push(a); bump()
  for (let i = 0; i < 20; i++) { a.text += `- L3 行 ${i}\n`; bump(); await sleep(60) }
  a.streaming = false; channel.working = false; bump(); await sleep(500)
  report('阶段3 含 reasoning 折叠')
}
await instance.unmount()
process.exit(0)
