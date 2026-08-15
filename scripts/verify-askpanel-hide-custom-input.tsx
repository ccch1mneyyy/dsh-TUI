/**
 * AskUserQuestionPanel `hideCustomInput` 行为回归（/provider 向导引入）。
 * 覆盖复核确认的无测试分支：
 *   1. 纯选择题 + hide：不渲染「自定义回答」输入行，hint 无输入提示；
 *      Tab 与可打印字符被忽略，Enter 只提交 selected（无 custom）。
 *   2. 无选项纯文本题 + hide：hide 被忽略，输入行仍在，文本照常提交
 *      （否则题变死局）。
 *   3. 多选题不带 hide（向导的模型选择题形态）：输入行保留，
 *      勾选 + 自定义补充同时生效（issue #9 默认行为不回退）。
 * 运行：node --import tsx/esm scripts/verify-askpanel-hide-custom-input.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AskUserQuestionPanel }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
])

const COLS = 90
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function screen(): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < ROWS; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

let answer: unknown
let cancelled = false
const app = await render(
  React.createElement(AskUserQuestionPanel, {
    position: 1, total: 1, answered: 0,
    onAnswer: (selection: unknown) => { answer = selection },
    onCancel: () => { cancelled = true },
    question: { question: '占位', options: [{ label: 'x' }] },
  }),
  { stdout, stdin, stderr: new FakeStdout(), debug: true, exitOnCtrlC: false },
)
await sleep(200)

let failures = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Remount the panel with a fresh question (key forces clean state). */
let mountSeq = 0
async function mount(question: Record<string, unknown>): Promise<void> {
  answer = undefined
  cancelled = false
  app.rerender(React.createElement(AskUserQuestionPanel, {
    key: `q${++mountSeq}`,
    position: 1, total: 1, answered: 0,
    onAnswer: (selection: unknown) => { answer = selection },
    onCancel: () => { cancelled = true },
    question,
  }))
  await sleep(200)
}

// ── 1. 纯选择题 + hideCustomInput ─────────────────────────────────────
await mount({
  question: '要添加哪种模型提供方？',
  options: [{ label: '内置 provider' }, { label: '自定义 API 端点' }],
  hideCustomInput: true,
})
check('1 hide: 无「自定义回答」输入行', !screen().includes('自定义回答'))
check('1 hide: hint 无输入提示', !screen().includes('输入回答') && !screen().includes('输入文字附带回答'))
check('1 hide: 选项照常渲染', screen().includes('内置 provider') && screen().includes('自定义 API 端点'))

stdin.write('\x1b[B') // ↓ → 第二项
await sleep(100)
stdin.write('\t')    // Tab 应被忽略（无输入行可跳）
await sleep(100)
stdin.write('x')     // 可打印字符应被忽略
await sleep(100)
stdin.write('\r')    // Enter 提交焦点项
await sleep(200)
check('1 hide: Enter 只提交 selected，无 custom',
  eq(answer, { selected: ['自定义 API 端点'] }), JSON.stringify(answer))

// ── 2. 无选项纯文本题 + hideCustomInput（hide 必须被忽略）─────────────
await mount({
  question: '输入 API key',
  hideCustomInput: true,
})
check('2 text-only: hide 被忽略，输入行仍在', screen().includes('自定义回答'))
stdin.write('sk-secret')
await sleep(100)
stdin.write('\r')
await sleep(200)
check('2 text-only: 文本照常提交',
  eq(answer, { selected: [], custom: 'sk-secret' }), JSON.stringify(answer))

// ── 3. 多选题不带 hide（模型选择题形态）：默认行为不回退 ──────────────
await mount({
  question: '选择要启用的模型',
  options: [{ label: 'deepseek-chat' }, { label: 'deepseek-reasoner' }],
  multiSelect: true,
})
check('3 multi: 输入行保留', screen().includes('自定义回答'))
stdin.write(' ')      // 勾选第一项
await sleep(100)
stdin.write('extra-model') // 输入行补充
await sleep(100)
stdin.write('\r')
await sleep(200)
check('3 multi: 勾选 + 自定义补充同时生效',
  eq(answer, { selected: ['deepseek-chat'], custom: 'extra-model' }), JSON.stringify(answer))

app.unmount()
console.log(failures === 0 ? '\nAll hide-custom-input checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
