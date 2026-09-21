/**
 * AskUserQuestionPanel inline-input scenario (issue #9): the option list's
 * last row IS the input — typing on a focused option writes there without
 * any mode switch (the list stays put), attaches the label, and Enter
 * carries both selected + custom. Focusing the input row directly gives a
 * pure custom answer. Drives the real useInput path with fake stdin;
 * output is captured raw and ANSI-stripped (no xterm dependency).
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AskUserQuestionPanel }, { settle, settled, sleep, viewportLines, findText }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('./lib/term-test.mjs'),
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
/** The real terminal screen, line by line. */
function screen(): string {
  return viewportLines(term, ROWS).join('\n')
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

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** 视口坐标 → 单元格（相对 baseY）；越界返回 undefined。 */
function bufferCell(row: number, col: number) {
  const buf = term.buffer.active
  return col < 0 ? undefined : buf.getLine(buf.baseY + row)?.getCell(col)
}
type CellRef = ReturnType<typeof bufferCell>
/**
 * 在视口里按**整格字形**定位。不用 findText：那返回的是 translateToString
 * 的字符串下标，而中日韩宽字符占两格——在含中文的行上取格会整体左移
 * （本脚本第一版就因此读到隔壁标签的颜色，把红的断言读成绿的）。
 */
function findGlyph(glyph: string): { row: number; col: number } | null {
  const buf = term.buffer.active
  for (let row = 0; row < ROWS; row++) {
    const line = buf.getLine(buf.baseY + row)
    if (!line) continue
    for (let x = 0; x < COLS; x++) {
      if (line.getCell(x)?.getChars() === glyph) return { row, col: x }
    }
  }
  return null
}
/** 前景样式：是否走终端默认色 + 具体色值。 */
function styleOf(cell: CellRef): string {
  if (cell === undefined) return 'n/a'
  return `${cell.isFgDefault() ? 'default' : 'set#' + (cell.getFgColor() & 0xffffff).toString(16)}`
}
function fgAt(row: number, col: number): string {
  return styleOf(bufferCell(row, col))
}

// 1. Initial render: the input row is visible INSIDE the option list.
check('选项列表里直接可见「自定义回答」输入行', await settled(() => screen().includes('自定义回答')))
check('提示行说明可直接输入', await settled(() => screen().includes('输入文字附带回答')))

// 1b. IME 锚点格必须是「正文色空格」：终端在物理光标那一格上绘制输入法
//     拼音并继承该格的前景色——锚点若压在 dim 占位符上，拼音会跟着变暗
//     （与 2b 同源；2026-09-22 主人真机截图：按空格后打字，拼音是选项蓝）。
// 1b. IME 锚点格必须是「与正文同款样式」的一格空白：终端在物理光标那一格
//     上绘制输入法拼音并继承该格样式——锚点压在 dim 占位符上，拼音会跟着
//     变暗；压在蓝色光标条上，拼音会跟着变蓝（2026-09-22 主人真机截图）。
//     插入点 = 输入行 `：` 之后的第一格（同一行内定位，不靠提示行里的同名字）。
{
  const question = findGlyph('你')        // 题干：不带 color 的正文样式基准
  const labelRow = findGlyph('自')        // 输入行的「自定义回答」
  const textStyle = question === null ? 'n/a' : fgAt(question.row, question.col)
  let anchor: CellRef
  if (labelRow !== null) {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + labelRow.row)
    const colonX = Array.from({ length: COLS }, (_, x) => x)
      .find(x => line?.getCell(x)?.getChars() === '：') ?? -1
    anchor = colonX < 0 ? undefined : bufferCell(labelRow.row, colonX + (line?.getCell(colonX)?.getWidth() ?? 1))
  }
  check('空输入时插入点那格是正文样式的空白（占位符不再压在锚点上）',
    question !== null && anchor !== undefined && (anchor.getChars() === '' || anchor.getChars() === ' ')
      && styleOf(anchor) === textStyle,
    `chars=${JSON.stringify(anchor?.getChars())} anchor=${styleOf(anchor)} text=${textStyle}`)
}

// 2. Type on the focused "我有" option: text lands in the input row, the
//    option list stays (no jump), and the label is attached.
stdin.write('sk-test123')
check('输入内容出现在输入行', await settled(() => screen().includes('sk-test123')))
check('视图不跳转（选项列表仍在）', await settled(() => screen().includes('我没有')))
check('输入行标注附加标签「我有」', await settled(() => screen().includes('（附加：我有）')))

// 2b. 内联 caret 的那一格同样必须是正文色——它就是 IME 锚点（见 1b）。
{
  const caret = findGlyph('▏')            // 输入行内联 caret 格 = IME 锚点
  const typed = findGlyph('k')            // 已键入正文（sk-test123 里的 k）
  const textFg = typed === null ? 'n/a' : fgAt(typed.row, typed.col)
  check('内联 caret 格与正文同色（拼音继承白色，不再染成选项色）',
    caret !== null && typed !== null && fgAt(caret.row, caret.col) === textFg,
    `caret=(${caret?.row},${caret?.col}) caretFg=${fgAt(caret?.row ?? -1, caret?.col ?? -1)} textFg=${textFg}`)
}

// 3. Enter right there → the answer carries BOTH the label and the text.
stdin.write('\r')
check('提交同时携带 selected + custom', await settled(() => {
  const a1 = answer as { selected?: string[]; custom?: string } | undefined
  return a1?.selected?.join() === '我有' && a1?.custom === 'sk-test123'
}))

// 4. Pure custom: focus the input row itself (↓↓) and type → no label.
answer = undefined
app.rerender(
  React.createElement(AskUserQuestionPanel, {
    ...panelProps,
    key: 'q2',
    question: { question: '还有别的要说吗？', options: [{ label: '有' }, { label: '没有' }] },
  }),
)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('[B') // ↓
stdin.write('[B') // ↓ → input row
// 固定窗:pacing 焦点移动无可观测的纯文本条件（高亮为颜色，已被裁剪）
await sleep(200)
stdin.write('随便说说')
check('输入行内联编辑（视图仍不跳转）', await settled(() => screen().includes('随便说说') && screen().includes('没有')))
stdin.write('\r')
check('输入行直接提交为纯自定义（无标签）', await settled(() => {
  const a2 = answer as { selected?: string[]; custom?: string } | undefined
  return a2?.selected?.length === 0 && a2?.custom === '随便说说'
}))

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
await settle(() => screen().includes('要哪些口味？'))
stdin.write(' ') // check 甜
// 固定窗:pacing 勾选状态无可观测的纯文本条件（勾选标记依赖样式渲染）
await sleep(150)
stdin.write('少放糖')
await settle(() => screen().includes('少放糖'))
stdin.write('\r')
check('多选：勾选 + 文本一起提交', await settled(() => {
  const a3 = answer as { selected?: string[]; custom?: string } | undefined
  return a3?.selected?.join() === '甜' && a3?.custom === '少放糖'
}))

app.unmount()
// 固定窗:pacing unmount 后输出 flush 无可观测条件
await sleep(100)
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
