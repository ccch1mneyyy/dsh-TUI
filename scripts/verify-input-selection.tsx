/**
 * verify-input-selection — 输入框鼠标选区编辑回归（组件级 drag 协议的
 * PromptInput 消费者）：SGR press/motion/release 逐字节注入真实 Ink 管线，
 * 断言拖选/Shift+click 扩展/双击选词/Backspace/Delete 删选区/打字替换/
 * Esc 分层/Ctrl+C 经控制器复制，以及 CJK 宽字符显示列与 fold block 侧钳制。
 *
 * 两阶段：
 *   阶段 A（真实 PromptInput + AlternateScreen + Chat 式 useInput 持有者）：
 *     拖选→打字替换、反向拖选、Backspace/Delete 删选区、Shift+click 扩展
 *     + 控制器复制（OSC 52 断言）、Esc 仅清选区→再 Esc 清输入、双击选词
 *     （500ms/1 格自检测）、方向键坍缩、CJK 宽字符、英文整词换行与换行词上的
 *     caret/点击、fold block 选区钳制与无选区 consumeSelectionCopy=false。
 *   阶段 B（真实 Chat）：Ctrl+C 经 Chat→控制器复制选区且保留选区、再打字
 *     替换；无选区 Ctrl+C 保持既有清空语义。
 *
 * 运行：node --import tsx/esm scripts/verify-input-selection.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
// 纯 OSC 52 剪贴板路径：跳过原生剪贴板工具探测（与 verify-copy-on-select
// 同法），断言只依赖 stdout 帧里的 ESC]52;c;<b64>。
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { Box, render, AlternateScreen, useInput },
  { PromptInput },
  { LOCAL_COMMANDS },
  { Chat },
  { QuestionStore },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
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
  oscPayloads: () => string[]
  press: (col: number, row: number) => void
  motion: (col: number, row: number) => void
  release: (col: number, row: number) => void
  shiftPress: (col: number, row: number) => void
  shiftRelease: (col: number, row: number) => void
  click: (col: number, row: number) => void
}

function makeHarness(cols: number, rows: number): Harness {
  const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
  const frames: string[] = []
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      frames.push(String(chunk))
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
  const oscPayloads = (): string[] =>
    [...frames.join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)].map(m =>
      Buffer.from(m[1]!, 'base64').toString('utf8'),
    )
  // SGR 坐标 1-indexed（与 verify-drag-protocol 同款）。
  const press = (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}M`)
  const motion = (c: number, r: number) => stdin.write(`\x1b[<32;${c + 1};${r + 1}M`)
  const release = (c: number, r: number) => stdin.write(`\x1b[<0;${c + 1};${r + 1}m`)
  const shiftPress = (c: number, r: number) => stdin.write(`\x1b[<4;${c + 1};${r + 1}M`)
  const shiftRelease = (c: number, r: number) => stdin.write(`\x1b[<4;${c + 1};${r + 1}m`)
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
    oscPayloads,
    press,
    motion,
    release,
    shiftPress,
    shiftRelease,
    click,
  }
}

// ── 阶段 A：真实 PromptInput（Chat 式 useInput 持有者 + 控制器） ─────────
{
  const COLS = 80
  const ROWS = 24
  const h = makeHarness(COLS, ROWS)
  const { stdin, screenHas, findText, inverseAt, oscPayloads, press, motion, release, shiftPress, shiftRelease, click } = h

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
    submit() {},
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

  // 控制器盒：PromptInput 每渲染都写入 controllerRef.current。
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

  // 拖选：press 起点 → motion 终点 → release（坐标已含 c0/r0 偏移）。
  const dragRange = (from: number, to: number, row: number) => {
    press(from, row)
    motion(to, row)
    release(to, row)
  }

  try {
    await sleep(500)
    stdin.write('hello world')
    check('A0 输入渲染', await settled(() => screenHas('hello world')))
    const p = findText('hello world')
    check('A0 文本定位', p !== null && p.row >= 0, p ? `${p.col},${p.row}` : 'missing')
    const c0 = p!.col
    const r0 = p!.row

    // A1: 拖选 'ello'（press 'e'=1、motion 'o' 后空格=5）→ 打字替换
    dragRange(c0 + 1, c0 + 5, r0)
    check(
      'A1 拖选高亮 [ello]，caret 在选区尾',
      await settled(
        () =>
          inverseAt(c0 + 1, r0) &&
          inverseAt(c0 + 4, r0) &&
          inverseAt(c0 + 5, r0) &&
          !inverseAt(c0, r0) &&
          !inverseAt(c0 + 6, r0),
      ),
    )
    stdin.write('X')
    check(
      'A1 打字替换选区',
      await settled(() => screenHas('hX world') && !screenHas('hello world')),
    )

    // A2: 反向拖选 'world'（press 在 'd' 后一格、motion 到 'w'）→ 替换
    stdin.write('\x1b')
    await settle(() => !screenHas('hX world'))
    stdin.write('hello world')
    await settle(() => screenHas('hello world'))
    dragRange(c0 + 11, c0 + 6, r0)
    check(
      'A2 反向拖选高亮 [world]',
      await settled(
        () =>
          inverseAt(c0 + 6, r0) &&
          inverseAt(c0 + 10, r0) &&
          !inverseAt(c0 + 5, r0) &&
          !inverseAt(c0 + 11, r0),
      ),
    )
    stdin.write('X')
    check(
      'A2 反向选区替换（caret 在选区头）',
      await settled(() => screenHas('hello X') && !screenHas('hello world')),
    )

    // A3: Backspace 删选区 'world'
    stdin.write('\x1b')
    await settle(() => !screenHas('hello X'))
    stdin.write('hello world')
    await settle(() => screenHas('hello world'))
    dragRange(c0 + 6, c0 + 11, r0)
    await settle(() => inverseAt(c0 + 6, r0) && inverseAt(c0 + 10, r0))
    stdin.write('\x7f')
    check(
      'A3 Backspace 删选区',
      await settled(() => screenHas('hello') && !screenHas('world')),
    )

    // A4: Delete 删选区 'hello'
    stdin.write('\x1b')
    await settle(() => !screenHas('hello'))
    stdin.write('hello world')
    await settle(() => screenHas('hello world'))
    dragRange(c0, c0 + 5, r0)
    await settle(() => inverseAt(c0, r0) && inverseAt(c0 + 4, r0))
    stdin.write('\x1b[3~')
    check(
      'A4 Delete 删选区',
      await settled(() => screenHas(' world') && !screenHas('hello')),
    )

    // A5: Shift+click 扩展 + 控制器复制 + Esc 分层
    stdin.write('\x1b')
    await settle(() => !screenHas(' world'))
    stdin.write('hello world')
    await settle(() => screenHas('hello world'))
    click(c0 + 1, r0) // 单击 'e' → caret 1
    await settle(() => inverseAt(c0 + 1, r0))
    shiftPress(c0 + 10, r0)
    shiftRelease(c0 + 10, r0)
    check(
      'A5 Shift+click 扩展为 [ello wor]',
      await settled(
        () =>
          inverseAt(c0 + 1, r0) &&
          inverseAt(c0 + 9, r0) &&
          inverseAt(c0 + 10, r0) &&
          !inverseAt(c0, r0),
      ),
    )
    const copyCountBefore = oscPayloads().length
    check(
      'A5 控制器 consumeSelectionCopy 返回 true',
      controllerBox.current?.consumeSelectionCopy() === true,
    )
    check(
      'A5 复制选区文本',
      (await settled(() => oscPayloads().length === copyCountBefore + 1)) &&
        oscPayloads().at(-1) === 'ello worl',
      oscPayloads().at(-1) ?? 'no osc52',
    )
    check(
      'A5 复制保留选区（高亮仍在）',
      inverseAt(c0 + 1, r0) && inverseAt(c0 + 9, r0),
    )
    stdin.write('\x1b')
    check(
      'A5 Esc 仅清选区（文本不动）',
      await settled(
        () =>
          screenHas('hello world') &&
          !inverseAt(c0 + 1, r0) &&
          !inverseAt(c0 + 9, r0) &&
          inverseAt(c0 + 10, r0),
      ),
    )
    stdin.write('\x1b')
    check(
      'A5 无选区再 Esc 走既有清空语义',
      await settled(() => !screenHas('hello world')),
    )

    // A5b: two quick Shift+clicks are range extensions, not a local
    // double-click word selection. They must also read the latest selection.
    stdin.write('alpha beta')
    await settle(() => screenHas('alpha beta'))
    const shiftRow = findText('alpha beta')!
    click(shiftRow.col, shiftRow.row)
    await sleep(550)
    shiftPress(shiftRow.col + 5, shiftRow.row)
    shiftRelease(shiftRow.col + 5, shiftRow.row)
    await sleep(50)
    shiftPress(shiftRow.col + 6, shiftRow.row)
    shiftRelease(shiftRow.col + 6, shiftRow.row)
    await settle(() => inverseAt(shiftRow.col + 6, shiftRow.row))
    const shiftCopies = oscPayloads().length
    check(
      'A5b 连续 Shift+click 不误判双击选词',
      controllerBox.current?.consumeSelectionCopy() === true &&
        (await settled(() => oscPayloads().length === shiftCopies + 1)) &&
        oscPayloads().at(-1) === 'alpha ',
      oscPayloads().at(-1) ?? 'no osc52',
    )
    controllerBox.current?.clear()
    await settle(() => !screenHas('alpha beta'))

    // A6: 双击选词（自检测 500ms/1 格）：'foo-bar' 整词
    stdin.write('foo-bar baz')
    await settle(() => screenHas('foo-bar baz'))
    click(c0 + 5, r0) // 'a'
    await sleep(80)
    click(c0 + 5, r0)
    check(
      'A6 双击选词 [foo-bar]',
      await settled(
        () =>
          inverseAt(c0, r0) &&
          inverseAt(c0 + 6, r0) &&
          inverseAt(c0 + 7, r0) &&
          !inverseAt(c0 + 8, r0),
      ),
    )
    stdin.write('\x7f')
    check(
      'A6 Backspace 删双击词',
      await settled(() => screenHas(' baz') && !screenHas('foo-bar')),
    )

    // A7: 方向键坍缩选区到对应边缘
    stdin.write('\x1b')
    await settle(() => !screenHas(' baz'))
    stdin.write('hello world')
    await settle(() => screenHas('hello world'))
    dragRange(c0 + 6, c0 + 11, r0)
    await settle(() => inverseAt(c0 + 6, r0) && inverseAt(c0 + 10, r0))
    stdin.write('\x1b[D')
    check(
      'A7 ← 坍缩到选区头（caret 在 w）',
      await settled(
        () =>
          inverseAt(c0 + 6, r0) &&
          !inverseAt(c0 + 7, r0) &&
          !inverseAt(c0 + 10, r0),
      ),
    )
    stdin.write('X')
    check(
      'A7 坍缩后打字落在选区头',
      await settled(() => screenHas('hello Xworld')),
    )

    // A8: CJK 宽字符（显示列断言）：拖选 '世界' → Backspace
    stdin.write('\x1b')
    await settle(() => !screenHas('hello Xworld'))
    stdin.write('你好世界')
    await settle(() => screenHas('你好世界'))
    const j = findText('你好世界')!
    // 你=2 列，好=2 列 → 世 起于显示列 +4，界 止于 +7
    dragRange(j.col + 4, j.col + 7, j.row)
    check(
      'A8 CJK 拖选 [世界]（显示列）',
      await settled(
        () =>
          inverseAt(j.col + 4, j.row) &&
          inverseAt(j.col + 7, j.row) &&
          !inverseAt(j.col + 2, j.row),
      ),
    )
    stdin.write('\x7f')
    check(
      'A8 Backspace 删 CJK 选区',
      await settled(() => screenHas('你好') && !screenHas('世界')),
    )

    // A8b: the second cell of the final wide glyph still belongs to that
    // grapheme. Nearest-caret geometry used to point past EOF and select none.
    controllerBox.current?.clear()
    stdin.write('甲乙')
    await settle(() => screenHas('甲乙'))
    const wide = findText('甲乙')!
    await sleep(550)
    click(wide.col + 3, wide.row)
    await sleep(80)
    click(wide.col + 3, wide.row)
    await settle(() => inverseAt(wide.col, wide.row) && inverseAt(wide.col + 3, wide.row))
    const wideCopies = oscPayloads().length
    check(
      'A8b 双击末尾 CJK 的第二格仍选中词',
      controllerBox.current?.consumeSelectionCopy() === true &&
        (await settled(() => oscPayloads().length === wideCopies + 1)) &&
        oscPayloads().at(-1) === '甲乙',
      oscPayloads().at(-1) ?? 'no osc52',
    )

    // A8c: pasted ANSI controls and tabs cannot create source/screen geometry
    // divergence. SGR is stripped; tabs expand deterministically before edit.
    controllerBox.current?.clear()
    stdin.write('\x1b[200~A\x1b[31mB\x1b[0m\tC\x1b[201~')
    check(
      'A8c ANSI 被剥离且 Tab 展开为可编辑空格',
      await settled(() => screenHas('AB        C') && !screenHas('[31m')),
    )
    const safe = findText('AB        C')!
    dragRange(safe.col, safe.col + 11, safe.row)
    await settle(() => inverseAt(safe.col, safe.row) && inverseAt(safe.col + 10, safe.row))
    const safeCopies = oscPayloads().length
    check(
      'A8c 控制序列不会被选区拆断',
      controllerBox.current?.consumeSelectionCopy() === true &&
        (await settled(() => oscPayloads().length === safeCopies + 1)) &&
        oscPayloads().at(-1) === 'AB        C',
      oscPayloads().at(-1) ?? 'no osc52',
    )

    // A9: fold block 存在时选区钳制在 head 侧、禁止跨 chip 行
    controllerBox.current?.clear()
    await settle(() => !screenHas('AB        C'))
    stdin.write('PRE')
    const foldLines = Array.from({ length: 12 }, (_, i) => `fold-line-${i}`)
    stdin.write(`\x1b[200~${foldLines.join('\n')}\x1b[201~`)
    stdin.write('TAIL')
    check('A9 大段粘贴折叠成 chip', await settled(() => screenHas('▸ 12 lines') && screenHas('TAIL')))
    // 奇数（13）次 ↑ 停在 block.start（偶数次回到 block.end），窗口回顶且
    // caret 行稳定在 head——空 tail 行的 caret 消失后该行塌缩、布局下移一行；
    // 塌缩前/后布局里 chip 都紧贴 PRE，必须等到底边框紧贴 chip（塌缩后布局）
    // 再取坐标，否则后续拖拽全部落空一格。
    stdin.write('\x1b[A'.repeat(13))
    await settle(() => {
      const pp = findText('PRE')
      const cc = findText('▸ 12 lines')
      if (pp === null || cc === null || cc.row !== pp.row + 1) return false
      return (termTest.viewportLines(h.term)[cc.row + 1] ?? '').includes('╰')
    })
    const hd = findText('PRE')!
    press(hd.col, hd.row)
    motion(hd.col, hd.row + 1) // chip 行 → 忽略
    motion(hd.col, hd.row + 2) // tail 行 → 钳制到 block.start
    release(hd.col, hd.row + 2)
    check(
      'A9 选区钳制在 head 侧',
      await settled(
        () =>
          inverseAt(hd.col, hd.row) &&
          inverseAt(hd.col + 2, hd.row) &&
          !inverseAt(hd.col, hd.row + 1) &&
          !inverseAt(hd.col, hd.row + 2),
      ),
      `head=${inverseAt(hd.col, hd.row)},${inverseAt(hd.col + 1, hd.row)},${inverseAt(hd.col + 2, hd.row)} chip=${inverseAt(hd.col, hd.row + 1)} tail=${inverseAt(hd.col, hd.row + 2)}`,
    )
    const foldCopyBefore = oscPayloads().length
    check(
      'A9 控制器复制 head 选区',
      controllerBox.current?.consumeSelectionCopy() === true &&
        (await settled(() => oscPayloads().length === foldCopyBefore + 1)) &&
        oscPayloads().at(-1) === 'PRE',
      oscPayloads().at(-1) ?? 'no osc52',
    )
    stdin.write('\x7f')
    check(
      'A9 Backspace 删 head 选区后 chip 仍在',
      await settled(
        () => screenHas('▸ 12 lines') && screenHas('fold-line-0') && screenHas('TAIL') && !screenHas('PRE'),
      ),
      `chip=${screenHas('▸ 12 lines')} preview=${screenHas('fold-line-0')} PRE=${screenHas('PRE')}`,
    )
    // Reverse tail→head drag: sorted lo lies in head, but the anchor belongs
    // to tail. Selection and caret must remain on the tail side.
    const tailPos = findText('TAIL')!
    press(tailPos.col + 4, tailPos.row)
    motion(tailPos.col, tailPos.row - 1) // chip: ignored
    motion(tailPos.col, tailPos.row - 2) // head side: clamp back to block.end
    release(tailPos.col, tailPos.row - 2)
    const reverseCopies = oscPayloads().length
    check(
      'A9 反向跨 chip 拖选仍钳制在 tail 侧',
      await settled(() => inverseAt(tailPos.col, tailPos.row)) &&
        controllerBox.current?.consumeSelectionCopy() === true &&
        (await settled(() => oscPayloads().length === reverseCopies + 1)) &&
        oscPayloads().at(-1) === 'TAIL',
      oscPayloads().at(-1) ?? 'no osc52',
    )
    stdin.write('\x1b') // clear the reverse selection
    await sleep(200)

    // A10: 无选区 consumeSelectionCopy=false 且不写剪贴板
    const idleCopies = oscPayloads().length
    check(
      'A10 无选区复制返回 false',
      controllerBox.current?.consumeSelectionCopy() === false,
    )
    await sleep(200)
    check('A10 无选区不写剪贴板', oscPayloads().length === idleCopies)

    // A11: controller clear (idle Ctrl+C path) must clear the fold model too,
    // not only text/caret, or the next Esc is swallowed by a ghost block.
    controllerBox.current?.clear()
    check('A11 controller clear 同步清除折叠 chip 与选区',
      await settled(() => !screenHas('▸ 12 lines') && !screenHas('TAIL')) &&
        controllerBox.current?.consumeSelectionCopy() === false)

    // A12: #607 英文整词换行。COLS=80 时 inputWidth = 80-3-2 = 75（边框/展开钮）。
    // 70 个 x + 空格 + classification(14) = 85 > 75：硬换行会在词中劈开
    // （clas|sification），整词换行把 classification 整段带到下一行。
    const word = 'classification'
    stdin.write(`${'x'.repeat(70)} ${word}`)
    check(
      'A12 长英文词整词换到下一行',
      await settled(() => {
        const wpos = findText(word)
        const xs = findText('xxxxx')
        return wpos !== null && xs !== null && wpos.row > xs.row
      }),
    )
    const wpos = findText(word)!
    stdin.write('\x1b[D'.repeat(7))
    check(
      'A12 词中 caret 留在换行后的词行',
      await settled(
        () => inverseAt(wpos.col + 7, wpos.row) && !inverseAt(wpos.col + 7, wpos.row - 1),
      ),
    )
    click(wpos.col + 3, wpos.row)
    check(
      'A12 点击换行词 caret 在词行而非上一行',
      await settled(
        () =>
          (inverseAt(wpos.col + 2, wpos.row) ||
            inverseAt(wpos.col + 3, wpos.row) ||
            inverseAt(wpos.col + 4, wpos.row)) &&
          !inverseAt(wpos.col + 3, wpos.row - 1),
      ),
    )
    dragRange(wpos.col, wpos.col + word.length, wpos.row)
    const wrapCopies = oscPayloads().length
    check(
      'A12 拖选换行词复制整词',
      await settled(
        () => inverseAt(wpos.col, wpos.row) && inverseAt(wpos.col + word.length - 1, wpos.row),
      ) &&
        controllerBox.current?.consumeSelectionCopy() === true &&
        (await settled(() => oscPayloads().length === wrapCopies + 1)) &&
        oscPayloads().at(-1) === word,
      oscPayloads().at(-1) ?? 'no osc52',
    )
  } finally {
    app.unmount()
  }
}

// ── 阶段 B：真实 Chat——Ctrl+C 经控制器复制选区并保留 ────────────────────
{
  const COLS = 100
  const ROWS = 40
  const h = makeHarness(COLS, ROWS)
  const { stdin, screenHas, findText, inverseAt, oscPayloads, press, motion, release } = h

  const listeners = new Set<() => void>()
  const channel: Record<string, unknown> = {
    version: 0,
    rows: [],
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    mode: { plan: false },
    reasoningEffort: 'max',
    tokens: { input: 1, output: 1 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: Date.now(),
    lastUserText: '',
    pending: [],
    commandList: [],
    notifications: [],
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    submit(text: string) {
      void text
      bump0()
    },
    cancel: () => {},
    clear: () => {},
    notify(msg: string) {
      ;(channel.notifications as string[]).push(msg)
      bump0()
    },
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
  }
  const bump0 = () => {
    channel.version = (channel.version as number) + 1
    for (const cb of listeners) cb()
  }

  const app = await render(
    <AlternateScreen>
      <Chat channel={channel as never} questionStore={new QuestionStore()} onExit={() => {}} />
    </AlternateScreen>,
    {
      stdout: h.stdout,
      stdin,
      stderr: h.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  try {
    await sleep(600)
    stdin.write('hello world')
    check('B1 Chat 输入渲染', await settled(() => screenHas('hello world')))
    const p = findText('hello world')!
    const c0 = p.col
    const r0 = p.row

    press(c0 + 6, r0)
    motion(c0 + 11, r0)
    release(c0 + 11, r0)
    check(
      'B1 拖选 [world] 高亮',
      await settled(() => inverseAt(c0 + 6, r0) && inverseAt(c0 + 10, r0)),
    )
    const before = oscPayloads().length
    stdin.write('\x03') // Ctrl+C 走 Chat → 控制器
    check(
      'B1 Ctrl+C 经 Chat 复制选区',
      (await settled(() => oscPayloads().length === before + 1)) &&
        oscPayloads().at(-1) === 'world',
      oscPayloads().at(-1) ?? 'no osc52',
    )
    check(
      'B1 复制保留选区与文本',
      screenHas('hello world') && inverseAt(c0 + 6, r0) && inverseAt(c0 + 10, r0),
    )
    stdin.write('X')
    check(
      'B1 复制后打字仍替换选区',
      await settled(() => screenHas('hello X') && !screenHas('hello world')),
    )

    // B2: 无选区 Ctrl+C 保持既有清空语义
    stdin.write('\x03')
    check('B2 无选区 Ctrl+C 清空输入', await settled(() => !screenHas('hello X')))
    check('B2 无选区不写剪贴板', oscPayloads().length === before + 1)
  } finally {
    app.unmount()
  }
}

if (failures > 0) {
  console.error(`\nverify-input-selection: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nverify-input-selection: all checks passed')
