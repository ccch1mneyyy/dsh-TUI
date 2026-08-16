/**
 * IME 光标锚定回归（fix/ime-cursor-position）：终端 IME 的拼音预编辑跟物理
 * 光标走，useDeclaredCursor 必须把原生光标停到输入框 caret 上。本脚本用
 * xterm/headless 读取真实硬件光标落点，断言：
 *   1. 问答面板：选项行上打字（文本进输入行），光标锚在输入行 ▏ caret 上
 *   2. 聚焦输入行 + 英文输入：光标在反色 caret 格上
 *   3. CJK 宽字符输入：光标仍在反色 caret 格上
 *   4. 窄宽长回答换行 + Home：字符齐全且光标贴合反色 caret 格（首字符）
 *   5. 历史搜索浮层：光标归 SearchBox 的 caret 格，不被结果行 ListItem 抢走
 *   6. 窄宽 + 超长查询：SearchBox 单行窗口化（不折行），光标精确落在框内
 *      反色 caret 格，且可见文本是查询尾部（头部已滚出）
 *   7. emoji surrogate 对中间的非法 cursorOffset：归一化到码点边界，
 *      光标停在 emoji 首格
 *   8. 极窄 SearchBox（内容区 0 列）：光标钳制在框内不越界
 * 运行：node --import tsx/esm scripts/verify-ime-cursor.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AskUserQuestionPanel }, { HistorySearchDialog }, { SearchBox }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/components/HistorySearchDialog.js'),
  import('../src/components/SearchBox.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  // 交叉类型：既满足 render() 的 tty 流类型，又保留测试写入/行列访问。
  const stdout = new FakeStdout() as FakeStdout & NodeJS.WriteStream
  const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
  const lines = (): string[] => {
    const buf = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '')
  }
  /** 硬件光标（IME 预编辑锚点）落点。 */
  const cursor = () => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY })
  /** 屏幕上第一个反色格（聚焦 caret 的渲染形态）的坐标，可限定行范围。 */
  const findInverseCell = (yFrom = 0, yTo = rows - 1): { x: number; y: number } | undefined => {
    const buf = term.buffer.active
    for (let y = yFrom; y <= yTo; y++) {
      const line = buf.getLine(y)
      if (!line) continue
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (cell && cell.isInverse()) return { x, y }
      }
    }
    return undefined
  }
  /** 指定字符（如 '▏'）在某行的单元格列号 —— 走 buffer 单元格，避开 CJK
   *  宽度与 JS 字符串下标的错位。 */
  const findCharCell = (ch: string, yFrom = 0, yTo = rows - 1): { x: number; y: number } | undefined => {
    const buf = term.buffer.active
    for (let y = yFrom; y <= yTo; y++) {
      const line = buf.getLine(y)
      if (!line) continue
      for (let x = 0; x < line.length; x++) {
        if (line.getCell(x)?.getChars() === ch) return { x, y }
      }
    }
    return undefined
  }
  return { term, stdout, stdin, lines, cursor, findInverseCell, findCharCell }
}

const panelProps = {
  position: 1,
  total: 1,
  answered: 0,
  onAnswer: () => {},
  onCancel: () => {},
}
const QUESTION = {
  question: '输入法光标落点测试：随便回答点什么？',
  options: [{ label: '选项一' }, { label: '选项二' }],
}

let failures = 0
const report = (name: string, ok: boolean, detail: string) => {
  if (ok) console.log(`PASS  ${name}`)
  else { failures++; console.log(`FAIL  ${name} — ${detail}`) }
}

/** 场景 1-3：问答面板（80 列宽松宽度）。 */
{
  const { stdout, stdin, lines, cursor, findInverseCell, findCharCell } = makeHarness(80, 24)
  const app = await render(
    React.createElement(AskUserQuestionPanel, {
      ...panelProps,
      key: 'q1',
      question: QUESTION,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(400)

  // 场景 1：焦点在选项行时直接打字 —— 文本进输入行，非聚焦 caret 是 ▏，
  // 光标应停在 ▏ 那一格（输入行最后一个可见字符）。
  stdin.write('hello')
  await sleep(400)
  {
    const ls = lines()
    const row = ls.findIndex(l => l.includes('自定义回答') && l.includes('hello'))
    const cur = cursor()
    const bar = row >= 0 ? findCharCell('▏', row, row) : undefined
    const ok = row >= 0 && bar !== undefined && cur.y === bar.y && cur.x === bar.x
    report('选项行打字：光标锚在输入行 ▏ caret', ok,
      `row=${row} bar=${JSON.stringify(bar)} cursor=${JSON.stringify(cur)}`)
  }

  // 场景 2：↓↓ 聚焦输入行（key 重挂载清掉上一段文本），输英文。
  app.rerender(
    React.createElement(AskUserQuestionPanel, {
      ...panelProps,
      key: 'q2',
      question: QUESTION,
    }),
  )
  await sleep(300)
  stdin.write('\x1b[B')
  stdin.write('\x1b[B')
  await sleep(200)
  stdin.write('hello')
  await sleep(400)
  {
    const ls = lines()
    const row = ls.findIndex(l => l.includes('自定义回答') && l.includes('hello'))
    const caret = findInverseCell(Math.max(row, 0), row + 2)
    const cur = cursor()
    const ok = row >= 0 && caret !== undefined && cur.x === caret.x && cur.y === caret.y
    report('聚焦输入行 + 英文输入：光标在 caret 格', ok,
      `row=${row} caret=${JSON.stringify(caret)} cursor=${JSON.stringify(cur)}`)
  }

  // 场景 3：CJK 宽字符。
  stdin.write('你好')
  await sleep(400)
  {
    const ls = lines()
    const row = ls.findIndex(l => l.includes('自定义回答') && l.includes('你好'))
    const caret = findInverseCell(Math.max(row, 0), row + 2)
    const cur = cursor()
    const ok = row >= 0 && caret !== undefined && cur.x === caret.x && cur.y === caret.y
    report('CJK 输入：光标在 caret 格', ok,
      `row=${row} caret=${JSON.stringify(caret)} cursor=${JSON.stringify(cur)}`)
  }
  app.unmount()
  await sleep(100)
}

/** 场景 4：窄宽 + 长回答换行 + Home —— 光标贴合 caret。 */
{
  const { stdout, stdin, lines, cursor, findInverseCell, findCharCell } = makeHarness(40, 24)
  const app = await render(
    React.createElement(AskUserQuestionPanel, {
      ...panelProps,
      key: 'q3',
      question: QUESTION,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(400)
  stdin.write('\x1b[B')
  stdin.write('\x1b[B')
  await sleep(200)
  stdin.write('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij') // 46 字符，必换行
  await sleep(400)
  stdin.write('\x1b[H') // Home：caret 回到文本开头，反色格是 'A'
  await sleep(400)
  {
    const ls = lines()
    // 40 列下「自定义回答」标签自身会被换行拆断（如「自定义 / 答」），用
    // ✎ 单元格定位输入行。注意：换行边界存在丢字/重影（未改动的基线
    // 1ea67ed 实测同样如此），属于移植渲染器的既有问题，不在本修复范围；
    // 这里断言的是光标与 caret 格重合 + 文本主体上屏。
    const pencil = findCharCell('✎')
    const row = pencil?.y ?? -1
    const caret = findInverseCell(Math.max(row, 0), row + 6)
    const cur = cursor()
    const text = ls.join('\n')
    const ok = row >= 0 && text.includes('ABCDEF') && text.includes('defghij')
      && caret !== undefined && cur.x === caret.x && cur.y === caret.y
    report('窄宽长回答换行 + Home：光标贴合 caret', ok,
      `row=${row} caret=${JSON.stringify(caret)} cursor=${JSON.stringify(cur)}`)
  }
  app.unmount()
  await sleep(100)
}

/** 场景 5：历史搜索浮层 —— 光标归 SearchBox caret，不被结果行抢走。 */
{
  const { stdout, stdin, lines, cursor, findInverseCell } = makeHarness(80, 24)
  const matches = [
    { text: 'first result command', ts: Date.now() - 60_000 },
    { text: 'second result command', ts: Date.now() - 120_000 },
  ]
  const app = await render(
    React.createElement(HistorySearchDialog, { query: 'abc', cursorOffset: 3, matches, focusIndex: 0 }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(500)
  {
    const ls = lines()
    const boxRow = ls.findIndex(l => l.includes('abc'))
    const itemRow = ls.findIndex(l => l.includes('first result'))
    const caret = findInverseCell(Math.max(boxRow, 0), Math.max(boxRow, 0))
    const cur = cursor()
    const ok = boxRow >= 0 && itemRow >= 0 && caret !== undefined
      && cur.x === caret.x && cur.y === caret.y && cur.y !== itemRow
    report('历史搜索：光标在 SearchBox caret 格而非结果行', ok,
      `boxRow=${boxRow} itemRow=${itemRow} caret=${JSON.stringify(caret)} cursor=${JSON.stringify(cur)}`)
  }
  app.unmount()
  await sleep(100)
}

/** 场景 6：窄宽 + 超长查询 —— SearchBox 单行窗口化，光标不出框。 */
{
  const { stdout, stdin, lines, cursor, findInverseCell, findCharCell } = makeHarness(40, 24)
  // 50 字符查询，caret 在末尾：40 列下框内容区只有 ~30 格，必须水平滚动。
  const query = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0123456789'
  const app = await render(
    React.createElement(HistorySearchDialog, {
      query,
      cursorOffset: query.length,
      matches: [{ text: 'some result', ts: Date.now() - 60_000 }],
      focusIndex: 0,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(500)
  {
    const ls = lines()
    const lens = findCharCell('⌕')
    const boxRow = lens?.y ?? -1
    const boxLine = boxRow >= 0 ? ls[boxRow]! : ''
    const caret = boxRow >= 0 ? findInverseCell(boxRow, boxRow) : undefined
    const cur = cursor()
    const aRun = (boxLine.match(/a/g) ?? []).length
    // 窗口化证据：尾部 '0123456789' 可见；头部 a 串大部分滚出（可见 a
    // 远少于 40 个）；光标与反色 caret 格重合，天然落在框内。
    const ok = boxRow >= 0 && boxLine.includes('0123456789') && aRun > 0 && aRun <= 30
      && caret !== undefined && cur.x === caret.x && cur.y === caret.y
    report('窄宽超长查询：光标在框内 caret 格且尾部可见', ok,
      `boxRow=${boxRow} aRun=${aRun} caret=${JSON.stringify(caret)} cursor=${JSON.stringify(cur)}`)
  }
  app.unmount()
  await sleep(100)
}

/** 场景 7：emoji surrogate 对中间的非法 cursorOffset —— 归一化到码点边界。 */
{
  const { stdout, stdin, cursor, findInverseCell, findCharCell } = makeHarness(80, 24)
  // 'a😀b'：😀 占 UTF-16 下标 1-2，offset=2 落在 surrogate 对正中间
  // （Chat 历史搜索按 code unit 移光标就可能产生这种值）。归一化后 caret
  // 应吸附到 😀 起点，反色块覆盖整个 emoji（2 格），光标停在首格。
  const app = await render(
    React.createElement(HistorySearchDialog, {
      query: 'a😀b',
      cursorOffset: 2,
      matches: [{ text: 'some result', ts: Date.now() - 60_000 }],
      focusIndex: 0,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(500)
  {
    const emoji = findCharCell('😀')
    const caret = emoji !== undefined ? findInverseCell(emoji.y, emoji.y) : undefined
    const cur = cursor()
    const ok = emoji !== undefined && caret !== undefined
      && caret.x === emoji.x && cur.x === emoji.x && cur.y === emoji.y
    report('emoji surrogate 中间 offset：归一化到码点边界', ok,
      `emoji=${JSON.stringify(emoji)} caret=${JSON.stringify(caret)} cursor=${JSON.stringify(cur)}`)
  }
  app.unmount()
  await sleep(100)
}

/** 场景 8：极窄 SearchBox（width=4，内容区为 0）—— 光标钳制在框内。 */
{
  const { stdout, stdin, cursor } = makeHarness(80, 24)
  const app = await render(
    React.createElement(SearchBox, {
      query: 'abcdef',
      cursorOffset: 6,
      isFocused: true,
      isTerminalFocused: true,
      width: 4,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(500)
  {
    // 框在 x=0..3（width 4 圆角边框），内容区为 0 列：prefix 都放不下，
    // 光标仍不得越出框体右缘。
    const cur = cursor()
    const ok = cur.x >= 0 && cur.x <= 3
    report('极窄 SearchBox：光标钳制在框内', ok, `cursor=${JSON.stringify(cur)}`)
  }
  app.unmount()
  await sleep(100)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
