/**
 * Picker edge-truncation regression (#396).
 *
 * Long names (multi-provider ids) truncated at the terminal's last cell used
 * to commit a pending-wrap: every list item swelled to two screen rows, the
 * declared per-item heights in listWindow desynced, the pane top got clipped,
 * and on real terminals the wrap leaked into scrollback — page turns drifted
 * by a row each time (the doubled rows / stray ❯ / shell prompt leaking into
 * the screenshot in the issue).
 *
 * This gate mounts the real ModelPicker in a headless xterm at narrow widths
 * with names sized to land the ellipsis (and the focused row's ✓) exactly on
 * the last cell, and asserts across a page turn:
 *   - zero wrapped buffer rows (isWrapped),
 *   - no phantom blank rows between items,
 *   - the pane top (row 0 content) and the focus indicator stay on screen.
 *
 * Run: node --import tsx/esm scripts/verify-picker-edge.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'dshtui-edge-'))
process.env.USERPROFILE = process.env.HOME

const [{ Terminal: XTerm }, React, { settle, viewportLines }] = await Promise.all([
  import('@xterm/headless'),
  import('react'),
  import('./lib/term-test.mjs'),
])
const { render } = await import('../src/ui.js')
const { ModelPicker } = await import('../src/components/ModelPicker.js')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

const ROWS = 30
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function mountAt(cols: number) {
  // Name length lands the truncation ellipsis — and the focused+selected
  // row's ✓ — exactly on the terminal's last cell.
  const NAME = 'x'.repeat(cols - 2)
  const models = Array.from({ length: 24 }, (_, i) => ({
    provider: 'p',
    id: `m${i}`,
    name: `${NAME}-${i}`,
    description: undefined,
  }))
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends (await import('node:stream')).Writable {
    columns = cols
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      term.write(String(chunk), () => cb())
    }
  }
  class FakeStderr extends (await import('node:stream')).Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  class FakeStdin extends (await import('node:stream')).PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const noop = () => {}
  const frame = async (focusIndex: number) => {
    instance.rerender(
      React.createElement(ModelPicker, {
        models, focusIndex, currentModel: 'p/m12', onHover: noop,
      }) as never,
    )
    // 翻页前后屏幕形态没有可区分的观察点（长名的尾部序号被省略号截掉，
    // 行文本与翻页前一致），对已成立条件轮询会立即返回等于没测；
    // 保留固定窗口等重绘落盘。
    await sleep(400)
    const buf = term.buffer.active
    const texts: string[] = []
    let wrapped = 0
    let focusVisible = false
    let tickVisible = false
    for (let y = 0; y < ROWS; y++) {
      const line = buf.getLine(y)
      if (line === undefined) { texts.push(''); continue }
      if (line.isWrapped) wrapped++
      const text = line.translateToString(true)
      texts.push(text)
      if (text.includes('❯')) focusVisible = true
      if (text.includes('✓')) tickVisible = true
    }
    // The picker is bare-mounted: blank rows above/below the pane are layout
    // padding. The invariant is INSIDE the pane — between the title row and
    // the footer row there must be no blank (phantom) rows beyond the title margin, and both title
    // and footer must be on screen at all.
    const titleAt = texts.findIndex(text => text.includes('模型'))
    const footerAt = texts.findIndex(text => text.includes('Enter'))
    let innerBlanks = -1
    if (titleAt >= 0 && footerAt > titleAt) {
      innerBlanks = texts.slice(titleAt, footerAt).filter(text => text === '').length
    }
    return { wrapped, innerBlanks, focusVisible, tickVisible, titleAt, footerAt }
  }
  const instance = await render(
    React.createElement(ModelPicker, {
      models, focusIndex: 12, currentModel: 'p/m12', onHover: noop,
    }) as never,
    {
      stdout: new FakeStdout() as never,
      stdin: new FakeStdin() as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // 首帧：标题、页脚、焦点指示与选中勾都画出来才算挂载完成。
  await settle(() => {
    const lines = viewportLines(term, ROWS)
    return lines.some(line => line.includes('模型')) && lines.some(line => line.includes('Enter'))
      && lines.some(line => line.includes('❯')) && lines.some(line => line.includes('✓'))
  })
  return { instance, frame, term }
}

for (const cols of [58, 61]) {
  const m = await mountAt(cols)
  try {
    const before = await m.frame(12)
    check(`${cols} cols: zero wrapped rows at rest`, before.wrapped === 0, `${before.wrapped} wrapped`)
    check(`${cols} cols: no phantom blank rows inside the pane`, before.innerBlanks <= 1, `${before.innerBlanks} blank`)
    check(`${cols} cols: title and footer on screen`, before.titleAt >= 0 && before.footerAt > before.titleAt)
    check(`${cols} cols: focus indicator visible`, before.focusVisible)
    check(`${cols} cols: selection tick visible`, before.tickVisible)
    const after = await m.frame(20)
    check(`${cols} cols: page turn keeps zero wrapped rows`, after.wrapped === 0, `${after.wrapped} wrapped`)
    check(`${cols} cols: page turn keeps pane and focus`,
      after.innerBlanks <= 1 && after.titleAt >= 0 && after.focusVisible)
    check(`${cols} cols: page turn keeps selection tick`, after.tickVisible)
  } finally {
    m.instance.unmount()
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
