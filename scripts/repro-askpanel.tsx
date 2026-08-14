/**
 * AskUserQuestionPanel inline-input scenario (issue #9): the option list's
 * last row IS the input — typing on a focused option writes there without
 * any mode switch (the list stays put), attaches the label, and Enter
 * carries both selected + custom. Focusing the input row directly gives a
 * pure custom answer. Drives the real useInput path with fake stdin;
 * output is captured raw and ANSI-stripped (no xterm dependency).
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
/** The real terminal screen, line by line. */
function screen(): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < ROWS; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

let answer: unknown
const panelProps = {
  position: 1,
  total: 1,
  answered: 0,
  onAnswer: (selection: unknown) => { answer = selection },
  onCancel: () => {},
}
const app = await render(
  React.createElement(AskUserQuestionPanel, {
    ...panelProps,
    key: 'q1',
    question: {
      question: '你有 API Key 吗？',
      options: [{ label: '我有' }, { label: '我没有' }],
    },
  }),
  { stdout, stdin, stderr: new FakeStdout(), debug: true, exitOnCtrlC: false },
)
await sleep(300)

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

// 1. Initial render: the input row is visible INSIDE the option list.
const s1 = screen()
check('选项列表里直接可见「自定义回答」输入行', s1.includes('自定义回答'))
check('提示行说明可直接输入', s1.includes('输入文字附带回答'))

// 2. Type on the focused "我有" option: text lands in the input row, the
//    option list stays (no jump), and the label is attached.
stdin.write('sk-test123')
await sleep(300)
const s2 = screen()
check('输入内容出现在输入行', s2.includes('sk-test123'))
check('视图不跳转（选项列表仍在）', s2.includes('我没有'))
check('输入行标注附加标签「我有」', s2.includes('（附加：我有）'))

// 3. Enter right there → the answer carries BOTH the label and the text.
stdin.write('\r')
await sleep(300)
const a1 = answer as { selected?: string[]; custom?: string } | undefined
check('提交同时携带 selected + custom', a1?.selected?.join() === '我有' && a1?.custom === 'sk-test123')

// 4. Pure custom: focus the input row itself (↓↓) and type → no label.
answer = undefined
app.rerender(
  React.createElement(AskUserQuestionPanel, {
    ...panelProps,
    key: 'q2',
    question: { question: '还有别的要说吗？', options: [{ label: '有' }, { label: '没有' }] },
  }),
)
await sleep(300)
stdin.write('[B') // ↓
stdin.write('[B') // ↓ → input row
await sleep(200)
stdin.write('随便说说')
await sleep(200)
const s4 = screen()
check('输入行内联编辑（视图仍不跳转）', s4.includes('随便说说') && s4.includes('没有'))
stdin.write('\r')
await sleep(300)
const a2 = answer as { selected?: string[]; custom?: string } | undefined
check('输入行直接提交为纯自定义（无标签）', a2?.selected?.length === 0 && a2?.custom === '随便说说')

// 5. Multi-select: Space checks an option, typing appends, Enter on the
//    option row carries checked labels + text.
answer = undefined
app.rerender(
  React.createElement(AskUserQuestionPanel, {
    ...panelProps,
    key: 'q3',
    question: {
      question: '要哪些口味？',
      multiSelect: true,
      options: [{ label: '甜' }, { label: '辣' }],
    },
  }),
)
await sleep(300)
stdin.write(' ') // check 甜
await sleep(150)
stdin.write('少放糖')
await sleep(200)
stdin.write('\r')
await sleep(300)
const a3 = answer as { selected?: string[]; custom?: string } | undefined
check('多选：勾选 + 文本一起提交', a3?.selected?.join() === '甜' && a3?.custom === '少放糖')

app.unmount()
await sleep(100)
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
