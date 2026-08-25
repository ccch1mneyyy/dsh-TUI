/**
 * Long-option AskUserQuestionPanel regression. A `/provider` catalog can
 * contain dozens of two-line options; the focused row must remain inside a
 * short terminal viewport instead of being laid out off-screen.
 *
 * Run: node --import tsx/esm scripts/verify-askpanel-long-list.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal }, { render }, { AskUserQuestionPanel }, { settle }] = await Promise.all([
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

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
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

// 每个快照 settle 到「焦点标签在屏且恰一个 ●」——断言的同一条件；只盯焦点
// 标签会在旧焦点行尚未擦除的半解析帧上提前返回。
const settled = (label: string): boolean =>
  viewport().includes(label) && viewport().split('\n').filter(line => line.includes('●')).length === 1
await settle(() => settled('● provider-00'))
const initial = viewport()
for (let index = 0; index < 25; index += 1) {
  stdin.write('\x1b[B')
  await delay(20)
}
await settle(() => settled('● provider-25'))
const moved = viewport()

terminal.resize(90, 18)
stdout.rows = 18
stdout.emit('resize')
await settle(() => settled('● provider-25'))
const resized = viewport()

let failures = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures += 1
}
const selectedRows = (screen: string): number => screen.split('\n').filter(line => line.includes('●')).length

check('initial focus label is visible', initial.includes('● provider-00'))
check('initial viewport has exactly one selected/focused row', selectedRows(initial) === 1)
check('focus 25 label is visible after navigation', moved.includes('● provider-25'))
check('moved viewport has exactly one selected/focused row', selectedRows(moved) === 1)
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
