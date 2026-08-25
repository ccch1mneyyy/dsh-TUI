/**
 * Long-option AskUserQuestionPanel regression. A `/provider` catalog can
 * contain dozens of two-line options; the focused row must remain inside a
 * short terminal viewport instead of being laid out off-screen.
 *
 * Run: node --import tsx/esm scripts/verify-askpanel-long-list.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal }, { render }, { AskUserQuestionPanel }, { settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('./lib/term-test.mjs'),
])

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const terminal = new Terminal({ cols: 90, rows: 24, scrollback: 1000, allowProposedApi: true })
const stdout = new Writable({
  write(chunk, _encoding, callback) { terminal.write(String(chunk), callback) },
}) as Writable & { columns: number; rows: number; isTTY: boolean }
stdout.columns = 90
stdout.rows = 24
stdout.isTTY = true
const stdin = new FakeStdin()
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as Writable & { isTTY: boolean }
stderr.isTTY = true

const options = Array.from({ length: 36 }, (_, index) => ({
  label: `provider-${String(index).padStart(2, '0')}`,
  description: `Provider ${String(index).padStart(2, '0')}`,
}))
const app = await render(React.createElement(AskUserQuestionPanel, {
  position: 1,
  total: 1,
  answered: 0,
  question: { question: '选择 provider', options, hideCustomInput: true },
  onAnswer() {},
  onCancel() {},
}), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false })

function viewport(): string {
  const buffer = terminal.buffer.active
  return Array.from({ length: terminal.rows }, (_, y) =>
    buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').join('\n')
}

let failures = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures += 1
}
const selectedRows = (screen: string): number => screen.split('\n').filter(line => line.includes('●')).length

// 每阶段的两个条件（焦点标签在屏 + 恰一个 ●）必须在**同一快照**上同时成立：
// 拆成两个独立 settled 会被半解析帧分别骗过（第一帧双 ● 但含目标标签、
// 下一帧单 ● 却是错误行）。settled 谓词内捕获快照，两条 check 读同一快照。
let initial = ''
await settled(() => { initial = viewport(); return initial.includes('● provider-00') && selectedRows(initial) === 1 })
check('initial focus label is visible', initial.includes('● provider-00'))
check('initial viewport has exactly one selected/focused row', selectedRows(initial) === 1)
for (let index = 0; index < 25; index += 1) {
  stdin.write('\x1b[B')
  // 键间固定 pacing：逐项下移无需逐帧断言，保留小窗口保证按键不粘连。
  await sleep(20)
}
let moved = ''
await settled(() => { moved = viewport(); return moved.includes('● provider-25') && selectedRows(moved) === 1 })
check('focus 25 label is visible after navigation', moved.includes('● provider-25'))
check('moved viewport has exactly one selected/focused row', selectedRows(moved) === 1)

terminal.resize(90, 18)
stdout.rows = 18
stdout.emit('resize')
let resized = ''
await settled(() => { resized = viewport(); return resized.includes('● provider-25') && selectedRows(resized) === 1 })
check('focus 25 stays visible after shrinking to 18 rows', resized.includes('● provider-25'))
check('resized viewport has exactly one selected/focused row', selectedRows(resized) === 1)

if (failures > 0) {
  console.error(`\n=== INITIAL VIEWPORT ===\n${initial}`)
  console.error(`\n=== AFTER 25 DOWN ===\n${moved}`)
  console.error(`\n=== AFTER RESIZE ===\n${resized}`)
}

await app.unmount()
terminal.dispose()
console.log(failures === 0 ? '\nAskPanel long-list windowing verified' : `\n${failures} long-list check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
