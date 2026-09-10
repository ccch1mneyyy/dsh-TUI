/**
 * OverlayAbove 锚点空间预算回归（#493 / #698）。
 *
 * 浮层 bottom:'100%' 钉在输入簇顶边向上生长，渲染器对探出帧顶（y<0）的行
 * 只裁不移。picker 以前按 terminalRows 预算窗口：短会话 + 高终端下锚点上方
 * 只有十几行，窗口却切了三四十行，浮层顶部整体被裁——/model 焦点行完全
 * 不可见（#493：rows≥48 短会话），供应商模型多时列表混乱（#698）。
 *
 * 断言：
 *   - overlaySpaceAbove / clampOverlayHeight 纯函数边界表（inline 溢出视口换算、
 *     声明上限取小、至少 1 行、未量到沿用声明值）；
 *   - 真实 ModelPicker 挂在 Chat 同构的输入簇里（转录 + 输入簇 + OverlayAbove），
 *     headless xterm 下短会话/高终端：标题、焦点、页脚全部在屏，浮层底边紧贴
 *     输入行；焦点在首/中/末项均成立；
 *   - 长会话（帧高于终端的 inline 溢出）不被过度钳制：列表仍用满整屏预算；
 *   - 退化场景（锚点上方仅 4 行）：焦点可见优先于标题。
 *
 * 运行：node --import tsx/esm scripts/verify-overlay-anchor-budget.tsx
 * DUMP=1 在每个断言点转储屏幕。
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'dshtui-overlay-budget-'))
process.env.USERPROFILE = process.env.HOME

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, Text },
  { ModelPicker },
  { OverlayAbove },
  { clampOverlayHeight, overlaySpaceAbove },
  { settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/ModelPicker.js'),
  import('../src/components/OverlayAbove.js'),
  import('../src/components/overlayBudget.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------- 纯函数面
check('space: fullscreen-like frame keeps anchorTop', overlaySpaceAbove({ anchorTop: 20, rootHeight: 48, terminalRows: 48 }) === 20)
check('space: inline overflow subtracts the scrolled-out frame top (+1 cursor row)',
  overlaySpaceAbove({ anchorTop: 60, rootHeight: 62, terminalRows: 48 }) === 45)
check('space: never negative', overlaySpaceAbove({ anchorTop: 3, rootHeight: 80, terminalRows: 48 }) === 0)
check('clamp: declared limit wins when space is ample', clampOverlayHeight(40, 45) === 40)
check('clamp: space wins when tighter', clampOverlayHeight(40, 12) === 12)
check('clamp: unmeasured keeps the declared limit', clampOverlayHeight(40, undefined) === 40)
check('clamp: nothing declared, nothing measured', clampOverlayHeight(undefined, undefined) === undefined)
check('clamp: no declared limit uses the space', clampOverlayHeight(undefined, 9) === 9)
check('clamp: floor of one row', clampOverlayHeight(40, 0) === 1)

// ---------------------------------------------------------------- 真机同构
const COLS = 100
const MODELS = Array.from({ length: 36 }, (_, i) => ({
  provider: 'p',
  id: `m${String(i).padStart(2, '0')}`,
  name: `model-${String(i).padStart(2, '0')}`,
  description: undefined,
}))
const CURRENT = 'p/m05'

/** Chat 输入簇同构：转录若干行 + 输入簇（输入行 + 状态行 + 浮层）。 */
function Screen({ transcriptRows, focusIndex, rows }: {
  transcriptRows: number
  focusIndex: number
  rows: number
}) {
  return React.createElement(
    Box,
    { flexDirection: 'column', width: '100%' },
    ...Array.from({ length: transcriptRows }, (_, i) =>
      React.createElement(Text, { key: `t${i}` }, `transcript-${String(i).padStart(3, '0')}`)),
    React.createElement(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      React.createElement(Text, null, '> composer-line'),
      React.createElement(Text, null, 'status-line'),
      React.createElement(
        OverlayAbove,
        { maxHeight: Math.max(rows - 8, 1) },
        React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          React.createElement(ModelPicker, {
            models: MODELS, focusIndex, currentModel: CURRENT, showBack: false,
          }),
        ),
      ),
    ),
  )
}

type Shape = {
  title: number
  divider: number
  focus: number
  hint: number
  composer: number
  listRows: number
}

function readShape(term: InstanceType<typeof XTerm>, rows: number): Shape {
  const lines = viewportLines(term, rows)
  const title = lines.findIndex(line => line.includes('模型'))
  const focus = lines.findIndex(line => line.includes('❯'))
  const hint = lines.findIndex(line => line.includes('Enter'))
  const composer = lines.findIndex(line => line.includes('composer-line'))
  const divider = title > 0 && lines[title - 1]!.includes('─') ? title - 1 : -1
  // 标题行、marginBottom 空行、列表行……页脚：列表行数 = hint - title - 2。
  const listRows = title >= 0 && hint > title ? hint - title - 2 : -1
  return { title, divider, focus, hint, composer, listRows }
}

function dump(term: InstanceType<typeof XTerm>, rows: number, tag: string): void {
  if (process.env.DUMP !== '1') return
  console.log(`--- dump: ${tag}`)
  viewportLines(term, rows).forEach((line, i) =>
    console.log(String(i).padStart(2), line.replace(/\s+$/u, '').slice(0, 60)))
}

async function mount(rows: number, transcriptRows: number, focusIndex: number) {
  const term = new XTerm({ cols: COLS, rows, scrollback: 2000, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      term.write(String(chunk), () => cb())
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const element = (focus: number) =>
    React.createElement(Screen, { transcriptRows, focusIndex: focus, rows }) as never
  const instance = await render(element(focusIndex), {
    stdout: new FakeStdout() as never,
    stdin: new FakeStdin() as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    term,
    instance,
    setFocus: (focus: number) => instance.rerender(element(focus)),
    unmount: () => instance.unmount(),
  }
}

/** 标题/焦点/页脚在屏，且浮层底边（页脚）紧贴输入行。 */
function intact(shape: Shape): boolean {
  return shape.divider >= 0 && shape.title > shape.divider && shape.focus > shape.title
    && shape.hint > shape.focus && shape.composer === shape.hint + 1
}

// 场景 A：#493 原型——高终端（48 行）、短会话（锚点上方 12 行）、焦点在当前模型。
{
  const ROWS = 48
  const m = await mount(ROWS, 12, 5)
  let shape = readShape(m.term, ROWS)
  check('48 rows / short session: pane top, focus and footer all on screen, footer hugs the composer',
    await settled(() => { shape = readShape(m.term, ROWS); return intact(shape) }),
    JSON.stringify(shape))
  dump(m.term, ROWS, 'A focus=5')
  check('48 rows / short session: window fits the 12 rows above the anchor',
    shape.title >= 0 && shape.listRows > 0 && shape.listRows <= 12 - 6, `listRows=${shape.listRows}`)
  for (const focus of [0, 20, 35]) {
    m.setFocus(focus)
    let next = readShape(m.term, ROWS)
    check(`48 rows / short session: focus=${focus} stays intact`,
      await settled(() => {
        next = readShape(m.term, ROWS)
        const lines = viewportLines(m.term, ROWS)
        return intact(next) && lines[next.focus]!.includes(`model-${String(focus).padStart(2, '0')}`)
      }),
      JSON.stringify(next))
    dump(m.term, ROWS, `A focus=${focus}`)
  }
  m.unmount()
}

// 场景 B：长会话（转录 60 行 > 48 行终端，inline 溢出）——不能过度钳制，
// 列表仍用满整屏预算（rows - 14 = 34 行）。
{
  const ROWS = 48
  const m = await mount(ROWS, 60, 5)
  let shape = readShape(m.term, ROWS)
  check('48 rows / long session: intact',
    await settled(() => { shape = readShape(m.term, ROWS); return intact(shape) }),
    JSON.stringify(shape))
  dump(m.term, ROWS, 'B')
  // 浮层 40 行（rows - 8）减 ModelPicker 框架 6 行 = 34 行列表，一行不少。
  check('48 rows / long session: full-screen budget still used (no over-clamp)',
    shape.listRows === 34, `listRows=${shape.listRows}`)
  m.unmount()
}

// 场景 C：24 行终端、锚点上方 12 行——小终端同样成立。
{
  const ROWS = 24
  const m = await mount(ROWS, 12, 35)
  let shape = readShape(m.term, ROWS)
  check('24 rows / short session, focus on the last item: intact',
    await settled(() => { shape = readShape(m.term, ROWS); return intact(shape) }),
    JSON.stringify(shape))
  dump(m.term, ROWS, 'C')
  m.unmount()
}

// 场景 D：退化——锚点上方只有 4 行。标题装不下，但焦点行与页脚必须在屏，
// 页脚仍紧贴输入行（焦点可见优先于标题）。
{
  const ROWS = 24
  const m = await mount(ROWS, 4, 5)
  let shape = readShape(m.term, ROWS)
  check('4 rows above the anchor: focus and footer visible, footer hugs the composer',
    await settled(() => {
      shape = readShape(m.term, ROWS)
      return shape.focus >= 0 && shape.hint > shape.focus && shape.composer === shape.hint + 1
    }),
    JSON.stringify(shape))
  dump(m.term, ROWS, 'D')
  m.unmount()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
