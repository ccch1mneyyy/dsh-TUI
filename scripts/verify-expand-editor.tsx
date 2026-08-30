/**
 * verify-expand-editor — 全屏草稿编辑回归（PromptInput 展开态 + 
 * PromptEditorLayer 挂载）：Ctrl+Shift+E 展开/收起、⛶ 按钮展开、
 * 展开态 Enter=换行（不发送）、Ctrl+Enter=发送并收起、Esc 分层
 * （选区→收起）、收起保留文本、点击定位/拖选删除、多行窗口跟随与
 * 滚轮、折叠块展开显示全文、发送/收起按钮点击、行号渲染。
 *
 * 运行：node --import tsx/esm scripts/verify-expand-editor.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { Box, render, AlternateScreen, useInput },
  { PromptInput },
  { PromptEditorLayer },
  { LOCAL_COMMANDS },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/components/PromptEditor.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])

import type { PromptController } from '../src/components/PromptInput.js'

const { sleep, settle, settled } = termTest

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

type Harness = {
  term: XTerm
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  screenHas: (s: string) => boolean
  findText: (s: string) => { col: number; row: number } | null
  inverseAt: (col: number, row: number) => boolean
  press: (col: number, row: number) => void
  motion: (col: number, row: number) => void
  release: (col: number, row: number) => void
  click: (col: number, row: number) => void
}

function makeHarness(cols: number, rows: number): Harness {
  const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      term.write(String(chunk), cb)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void {
      cb()
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(next: boolean): this {
      this.isRaw = next
      return this
    }
    override setEncoding(): this {
      return this
    }
    ref(): this {
      return this
    }
    unref(): this {
      return this
    }
  }
  const stdout = new FakeStdout()
  const stderr = new FakeStderr()
  const stdin = new FakeStdin()
  const buf = () => term.buffer.active
  const screenHas = (s: string): boolean =>
    termTest.viewportLines(term).some(line => line.includes(s))
  const findText = (s: string): { col: number; row: number } | null => {
    const lines = termTest.viewportLines(term)
    for (let row = 0; row < lines.length; row++) {
      const col = lines[row]!.indexOf(s)
      if (col >= 0) return { col, row }
    }
    return null
  }
  const inverseAt = (col: number, row: number): boolean =>
    buf().getLine(buf().baseY + row)?.getCell(col)?.isInverse() ?? false
  // SGR 坐标 1-indexed（与 verify-input-selection 同款）。
  const press = (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}M`)
  const motion = (c: number, r: number) => stdin.write(`\x1b[<32;${c + 1};${r + 1}M`)
  const release = (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}m`)
  const click = (c: number, r: number) => {
    press(c, r)
    release(c, r)
  }
  return {
    term,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    screenHas,
    findText,
    inverseAt,
    press,
    motion,
    release,
    click,
  }
}

const COLS = 80
const ROWS = 24
const h = makeHarness(COLS, ROWS)
const { stdin, screenHas, findText, inverseAt, press, motion, release, click } = h

let submitted: string[] = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: LOCAL_COMMANDS,
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text: string) {
    submitted.push(text)
  },
  steer() {},
  interruptAndDeliver() {
    return 0
  },
  removePending() {
    return false
  },
  stageImage() {},
  listFiles: async () => [],
  sessionColor: '',
}

const controllerBox: { current: PromptController | null } = { current: null }

function Fixture(): React.ReactNode {
  // Chat 式持有者（先于 PromptInput 注册——镜像 Chat 的按键优先级）。
  useInput(() => {})
  return (
    <Box height={ROWS} flexDirection="column" justifyContent="flex-end">
      <Box>
        <Box />
      </Box>
      <PromptInput
        channel={channel as never}
        helpOpen={false}
        onToggleHelp={() => {}}
        onRunCommand={() => false}
        selectionActive={false}
        controllerRef={controllerBox}
      />
      {/* 全屏编辑浮层：真实环境挂在 Chat 根 Box 末尾（树序最后）。 */}
      <PromptEditorLayer />
    </Box>
  )
}

const app = await render(
  <AlternateScreen>
    <Fixture />
  </AlternateScreen>,
  {
    stdout: h.stdout,
    stdin: h.stdin,
    stderr: h.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

// CSI-u：Ctrl+Shift+E（E=69，modifier 6 = ctrl+shift）。
const CTRL_SHIFT_E = '\x1b[69;6u'
const CTRL_ENTER = '\x1b[13;5u'
const dragRange = (from: number, to: number, row: number) => {
  press(from, row)
  motion(to, row)
  release(to, row)
}

try {
  await sleep(400)
  stdin.write('hello draft')
  check('A0 输入渲染', await settled(() => screenHas('hello draft')))
  check('A0 ⛶ 按钮在输入行', screenHas('⛶'))

  // A1: Ctrl+Shift+E 展开——标题/行号/统计/按钮可见，文本迁移进编辑区
  stdin.write(CTRL_SHIFT_E)
  check(
    'A1 展开显示标题',
    await settled(() => screenHas('Draft editor')),
  )
  check('A1 行号槽渲染', screenHas('1 │'))
  check('A1 统计行', screenHas('1 lines'))
  check('A1 发送按钮', screenHas('Send'))
  check('A1 收起按钮', screenHas('Collapse'))
  check('A1 草稿文本在编辑区', screenHas('hello draft'))

  // A2: 展开态 Enter = 换行（不发送）
  stdin.write('\r')
  check(
    'A2 Enter 插入换行（状态行变 2 行）',
    await settled(() => screenHas('2 lines')),
  )
  check('A2 未发送', submitted.length === 0)
  stdin.write('second line')
  check('A2 第二行文本', await settled(() => screenHas('second line')))

  // A3: Ctrl+Enter = 发送并收起
  submitted = []
  stdin.write(CTRL_ENTER)
  check('A3 Ctrl+Enter 发送', await settled(() => submitted.length === 1))
  check('A3 发送内容含两行', submitted[0]?.includes('\n') === true, JSON.stringify(submitted[0]))
  check(
    'A3 浮层收起（标题消失）',
    await settled(() => !screenHas('Draft editor')),
  )
  check('A3 收起后输入为空', !screenHas('second line'))

  // A4: Esc 收起保留文本
  stdin.write('keep me')
  await settle(() => screenHas('keep me'))
  stdin.write(CTRL_SHIFT_E)
  await settle(() => screenHas('Draft editor'))
  stdin.write('\x1b')
  check(
    'A4 Esc 收起',
    await settled(() => !screenHas('Draft editor')),
  )
  check('A4 文本保留', screenHas('keep me'))

  // A5: 选区 Esc 分层——先清选区，再收起
  stdin.write(CTRL_SHIFT_E)
  await settle(() => screenHas('Draft editor'))
  const t5 = findText('keep me')
  check('A5 文本定位', t5 !== null)
  if (t5) {
    dragRange(t5.col, t5.col + 4, t5.row)
    await settle(() => inverseAt(t5.col, t5.row))
    stdin.write('\x1b')
    check(
      'A5 Esc 仅清选区（编辑器仍在）',
      await settled(() => screenHas('Draft editor') && !inverseAt(t5.col, t5.row)),
    )
    stdin.write('\x1b')
    check('A5 再 Esc 收起', await settled(() => !screenHas('Draft editor')))
  }

  // A6: 展开态点击定位光标（点击行内字符，caret 块移过去）
  controllerBox.current?.clear()
  stdin.write('abcdef')
  await settle(() => screenHas('abcdef'))
  stdin.write(CTRL_SHIFT_E)
  await settle(() => screenHas('Draft editor'))
  const t6 = findText('abcdef')
  check('A6 文本定位', t6 !== null)
  if (t6) {
    click(t6.col + 3, t6.row)
    check(
      'A6 点击定位 caret（d 反显）',
      await settled(() => inverseAt(t6.col + 3, t6.row) && !inverseAt(t6.col + 5, t6.row)),
    )
  }

  // A7: 展开态拖选 + Backspace 删选区
  if (t6) {
    dragRange(t6.col + 2, t6.col + 4, t6.row)
    check(
      'A7 拖选 [cd]',
      await settled(() => inverseAt(t6.col + 2, t6.row) && inverseAt(t6.col + 3, t6.row)),
    )
    stdin.write('\x7f')
    check(
      'A7 Backspace 删选区',
      await settled(() => screenHas('abef') && !screenHas('abcdef')),
    )
  }

  // A8: 多行窗口跟随 + 滚轮（clear 会收起浮层——重新展开后再写多行，
  // 展开态 Enter=换行不会提交）
  controllerBox.current?.clear()
  await settle(() => !screenHas('Draft editor'))
  stdin.write(CTRL_SHIFT_E)
  await settle(() => screenHas('Draft editor'))
  // 编辑区预算 = 24 - 5 = 19 行；写 41 行（文本与 CR 分开写——同一
  // write 会命中 whole-line 管线语义，展开态已让位但分开写更贴近逐键）。
  for (let i = 1; i <= 40; i++) {
    stdin.write(`L${String(i).padStart(2, '0')}`)
    stdin.write('\r')
  }
  stdin.write('L41')
  check(
    'A8 末行可见（caret 跟随窗口）',
    await settled(() => screenHas('L41') && screenHas('41 lines')),
  )
  check('A8 首行滚出窗口', !screenHas('L01'))
  check('A8 行号 40 宽度槽', screenHas('40 │'))
  // 窗口跟随后停在 ~L22；滚轮向上 9 次 ×3 行 → 顶部回到窗口。
  // 坐标取编辑区中部（位置路由 hit-test 需落在挂 onWheel 的编辑区 Box 内）。
  for (let i = 0; i < 9; i++) stdin.write('\x1b[<64;40;12M') // wheelUp
  check(
    'A8 滚轮向上露出首行',
    await settled(() => screenHas('L01')),
  )

  // A9: 折叠块在展开态显示全文
  controllerBox.current?.clear()
  await settle(() => !screenHas('L01'))
  // 大粘贴（≥6 行）成折叠块 → 展开后应见全文而非 chip。
  const foldLines = ['foldA', 'foldB', 'foldC', 'foldD', 'foldE', 'foldF', 'foldG']
  stdin.write(`\x1b[200~${foldLines.join('\n')}\x1b[201~`)
  check(
    'A9 收起态出现折叠 chip',
    await settled(() => screenHas('lines')),
  )
  stdin.write(CTRL_SHIFT_E)
  check(
    'A9 展开显示折叠全文首行',
    await settled(() => screenHas('foldA') && screenHas('Draft editor')),
  )
  check('A9 展开显示折叠全文末行', screenHas('foldG'))

  // A10: 收起按钮点击收起（展开即解折叠：chip 不回来，全文可编辑）
  const collapseBtn = findText('Collapse')
  check('A10 收起按钮定位', collapseBtn !== null)
  if (collapseBtn) {
    click(collapseBtn.col, collapseBtn.row)
    check('A10 点击收起', await settled(() => !screenHas('Draft editor')))
  }
  check('A10 收起后无折叠 chip（展开即解折叠）', !screenHas('▸'))
  check('A10 收起后内容保留', screenHas('foldG'))

  // A11: ⛶ 按钮点击展开
  const expandBtn = findText('⛶')
  check('A11 ⛶ 按钮定位', expandBtn !== null)
  if (expandBtn) {
    click(expandBtn.col, expandBtn.row)
    check('A11 点击展开', await settled(() => screenHas('Draft editor')))
  }

  // A12: 发送按钮点击 = 发送并收起
  submitted = []
  const sendBtn = findText('Send')
  check('A12 发送按钮定位', sendBtn !== null)
  if (sendBtn) {
    click(sendBtn.col, sendBtn.row)
    check('A12 点击发送', await settled(() => submitted.length === 1))
    check('A12 发送后收起', await settled(() => !screenHas('Draft editor')))
  }
  check('A12 发送内容含折叠全文', submitted[0]?.includes('foldD') === true)

  // A13: vim 模式在展开态保留（Esc 收起不吞 vim 状态）
  controllerBox.current?.clear()
  await settle(() => !screenHas('foldA'))
  controllerBox.current?.toggleVim()
  stdin.write('vim text')
  await settle(() => screenHas('vim text'))
  stdin.write(CTRL_SHIFT_E)
  check('A13 展开显示 INSERT 徽标', await settled(() => screenHas('INSERT')))
  stdin.write('\x1b')
  check('A13 Esc 收起（vim 开启时也是收起）', await settled(() => !screenHas('Draft editor')))
  check('A13 收起后 vim 徽标仍在', screenHas('INSERT'))
  controllerBox.current?.toggleVim()

  // A9b: 展开态粘贴大文本 → 不建折叠块（收起后无 chip、全文直接可编辑）
  controllerBox.current?.clear()
  await settle(() => !screenHas('vim text'))
  stdin.write(CTRL_SHIFT_E)
  await settle(() => screenHas('Draft editor'))
  const pasteLines = Array.from({ length: 7 }, (_, i) => `p${i}x`)
  stdin.write(`\x1b[200~${pasteLines.join('\n')}\x1b[201~`)
  check('A9b 展开态粘贴全文末行可见', await settled(() => screenHas('p6x')))
  stdin.write('\x1b')
  check('A9b 收起', await settled(() => !screenHas('Draft editor')))
  check('A9b 收起后无折叠 chip', !screenHas('▸'))
  check('A9b 收起后文本保留', screenHas('p6x'))
} finally {
  app.unmount()
}

// ── 阶段 B：设置关闭（dsh-tui.expandEditor=false）→ 两个入口都消失 ────
{
  const h2 = makeHarness(COLS, ROWS)
  const stdin2 = h2.stdin
  const screenHas2 = (s: string): boolean => h2.screenHas(s)
  const channelOff = {
    ...channel,
    expandEditor: false,
  }
  const controller2: { current: PromptController | null } = { current: null }
  function FixtureOff(): React.ReactNode {
    useInput(() => {})
    return (
      <Box height={ROWS} flexDirection="column" justifyContent="flex-end">
        <Box>
          <Box />
        </Box>
        <PromptInput
          channel={channelOff as never}
          helpOpen={false}
          onToggleHelp={() => {}}
          onRunCommand={() => false}
          selectionActive={false}
          controllerRef={controller2}
        />
        <PromptEditorLayer />
      </Box>
    )
  }
  const app2 = await render(
    <AlternateScreen>
      <FixtureOff />
    </AlternateScreen>,
    {
      stdout: h2.stdout,
      stdin: h2.stdin,
      stderr: h2.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  try {
    await sleep(400)
    stdin2.write('plain text')
    check('B0 关闭态输入正常', await settled2(() => screenHas2('plain text')))
    check('B1 ⛶ 入口不渲染', !screenHas2('⛶'))
    stdin2.write(CTRL_SHIFT_E)
    await sleep(500)
    check('B1 快捷键不展开', !screenHas2('Draft editor'))
    check('B1 文本未被误动', screenHas2('plain text'))
  } finally {
    app2.unmount()
  }
  async function settled2(cond: () => boolean): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      if (cond()) return true
      await sleep(50)
    }
    return cond()
  }
}

console.log(failures === 0 ? '\nverify-expand-editor: ALL PASS' : `\nverify-expand-editor: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
