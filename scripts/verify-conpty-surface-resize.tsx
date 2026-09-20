/**
 * #891: Windows Terminal can lose alt-screen cells while maximizing, then
 * report a resize whose grid matches the renderer's cached dimensions.
 * Model the external surface loss separately from Ink's correct frame cache.
 * Run: node --import tsx/esm scripts/verify-conpty-surface-resize.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'
process.env.WT_SESSION = 'headless-conpty-surface'
delete process.env.TERM_PROGRAM
delete process.env.TMUX

import assert from 'node:assert/strict'
const [React, { PassThrough, Writable }, { Terminal }, { render, AlternateScreen, Box, Text }, { LogoV2 }, { default: instances }, { settled, sleep, viewportLines, writeParsed }, { useDeclaredCursor }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/LogoV2.js'), import('../src/ink/instances.js'), import('./lib/term-test.mjs'),
  import('../src/ink/hooks/use-declared-cursor.js'),
])

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/**
 * Declares a caret, which is what gives the surface probe a parked cell to
 * judge (the real app's prompt input does this). Without a declaration the
 * probe has nothing to compare against and stays silent by design.
 */
function CursorHome(): React.ReactNode {
  const setCursor = useDeclaredCursor({ line: 0, column: 0, active: true })
  return <Box ref={setCursor}><Text>CURSOR-HOME</Text></Box>
}

async function mount(fullscreen: boolean, animated = false, extra?: React.ReactNode) {
  const term = new Terminal({ cols: 100, rows: 32, scrollback: 1000, allowProposedApi: true })
  const writes: string[] = []
  let frames = 0
  let lastFrameAt = performance.now()
  const mountAt = performance.now()
  let firstFrameAt = 0
  class Output extends Writable {
    columns = 100
    rows = 32
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  const stdout = new Output()
  const stdin = new Input()
  const logo = <LogoV2 model="STATIC-MODEL" cwd="/static/cwd" effort="max"
    intro="classic" skipIntro={!animated} whaleIdle={false} drift={null}
    tip={{ id: 'surface', group: 'display', zh: 'STATIC-TIP', en: 'STATIC-TIP' }} />
  const instance = await render(fullscreen
    ? <AlternateScreen>{extra === undefined ? logo : <Box flexDirection="column">{logo}{extra}</Box>}</AlternateScreen>
    : logo, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new Writable({ write(_c, _e, cb) { cb() } }) as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame() { frames++; lastFrameAt = performance.now(); if (firstFrameAt === 0) firstFrameAt = performance.now() },
  })
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream)
  assert.ok(ink)
  const text = () => viewportLines(term).join('\n')
  const staticText = () => ['STATIC-MODEL', '/static/cwd', 'STATIC-TIP'].every(s => text().includes(s))
  const pixels = () => {
    const buffer = term.buffer.active
    let count = 0
    for (let y = 0; y < term.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y)
      for (let x = 0; x < term.cols; x++) {
        if (line?.getCell(x)?.getFgColor() === 0x142660) count++
      }
    }
    return count
  }
  const snapshot = () => {
    const buffer = term.buffer.active
    return Array.from({ length: term.rows }, (_, y) => {
      const line = buffer.getLine(buffer.baseY + y)
      return Array.from({ length: term.cols }, (_, x) => {
        const cell = line?.getCell(x)
        return cell && [cell.getChars(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor()]
      })
    })
  }
  assert.ok(await settled(() => staticText() && pixels() > 60 &&
    (animated || performance.now() - lastFrameAt >= 50)), 'startup paints whale and static details')
  // The launch hold: the first frame that reaches the terminal waits for the
  // console size to look stable, so nothing of ours is on screen while ConPTY
  // may still re-emit its buffer. Inline mounts have no hold.
  if (fullscreen) {
    assert.ok(firstFrameAt - mountAt >= 100,
      `launch hold withholds the first frame (saw ${Math.round(firstFrameAt - mountAt)}ms)`)
  }
  return { term, stdout, stdin, instance, ink, writes, frames: () => frames, staticText, pixels, snapshot, idle: () => performance.now() - lastFrameAt >= 50 }
}

// A real dimension change followed by terminal-side surface loss and a
// duplicate resize: the late event still has to repair the whole surface.
{
  const app = await mount(true)
  try {
    const beforeResize = app.frames()
    app.stdout.columns = 213
    app.stdout.rows = 52
    app.term.resize(213, 52)
    app.stdout.emit('resize')
    assert.ok(await settled(() => app.frames() > beforeResize && app.staticText() && app.pixels() > 60 && app.idle()), 'real resize settles')
    // Let the resize's own repair paint land before wiping, so the wipe below
    // cannot be raced by a repair still in flight (the launch hold is already
    // latched by now, so no blanking follows).
    await sleep(120) // 固定窗:探针 resize 修复与擦除之间的落帧余量
    const baseline = app.snapshot()
    // Only the physical terminal is cleared. Ink must not learn about this
    // until the resize notification (the failure modeled by the issue).
    await writeParsed(app.term, '\x1b[2J\x1b[H')
    assert.equal(app.staticText(), false)
    const before = app.frames()
    const beforeWrites = app.writes.length
    for (let i = 0; i < 20; i++) app.stdout.emit('resize')
    assert.ok(await settled(() => app.staticText() && app.pixels() > 60), 'same-grid resize restores static cells without Ctrl+L')
    // The 20 events coalesce into the immediate #891 repair — never one paint
    // per event, and (with the launch hold latched) no extra blanking either.
    assert.ok(
      await settled(() => app.frames() - before >= 1),
      'a duplicate resize burst still repairs the surface',
    )
    await sleep(80) // 固定窗:探针 尾沿不得再追加更多整屏重绘
    const burstFrames = app.frames() - before
    assert.ok(burstFrames <= 2, `20 resize events must not paint per event (saw ${burstFrames})`)
    assert.deepEqual(app.snapshot(), baseline, 'restored text and whale colors match the intact surface')
    const output = app.writes.slice(beforeWrites).join('')
    assert.ok(!/\x1b\[(?:2J|3J|\?1049h)/.test(output), 'repair must not clear the screen/scrollback or re-enter alt-screen')

    // An external editor owns the terminal while paused. A queued repair
    // must stay dormant and be consumed by the ordinary resume paint.
    await writeParsed(app.term, '\x1b[2J\x1b[H')
    app.stdout.emit('resize')
    app.ink.pause()
    const pausedWrites = app.writes.length
    await sleep(80) // 固定窗:探针 暂停后不得向外部编辑器写入待执行的重绘
    assert.equal(app.writes.length, pausedWrites, 'queued repair respects pause')
    app.stdout.emit('resize')
    app.ink.resume()
    assert.ok(await settled(() => app.staticText() && app.pixels() > 60), 'resume restores a queued surface repair')
    // Queue again immediately before the real handoff/restore lifecycle.
    app.stdout.emit('resize')
    app.ink.enterAlternateScreen()
    const handoffFrames = app.frames()
    assert.ok(await settled(() => app.stdout.writableLength === 0), 'handoff bytes are parsed')
    await writeParsed(app.term, '\x1b[HEDITOR-CONTROL')
    await sleep(80) // 固定窗:探针 编辑器交接后，残留 resize 重绘必须静默
    assert.equal(app.frames(), handoffFrames, 'queued repair does not paint over an external editor')
    assert.ok(viewportLines(app.term).join('\n').includes('EDITOR-CONTROL'), 'the external editor retains its surface')
    app.ink.exitAlternateScreen()
    assert.ok(await settled(() => app.staticText() && app.pixels() > 60), 'editor return restores the splash')
    app.stdout.emit('resize')
    console.log('PASS: ConPTY same-grid surface repair, coalescing, no erase and pause/resume')
  } finally {
    await app.instance.unmount()
    const framesAfterUnmount = app.frames()
    await sleep(80) // 固定窗:探针 卸载后不得继续发送排队的重绘
    assert.equal(app.frames(), framesAfterUnmount, 'unmount cancels pending surface work')
    app.term.dispose()
  }
}

// Reproduce the distinguishing symptom during the opening animation:
// moving highlights may paint themselves, but static details must also return.
{
  const app = await mount(true, true)
  try {
    await sleep(2500) // 固定窗:墙钟 issue 的最大化与开场动画尾声重叠
    await writeParsed(app.term, '\x1b[2J\x1b[H')
    app.stdout.emit('resize')
    assert.ok(await settled(() => app.staticText() && app.pixels() > 60), 'animated splash repairs static model/cwd/tip and whale body')
    console.log('PASS: startup animation surface recovery')
  } finally {
    await app.instance.unmount()
    app.term.dispose()
  }
}

// Cursor-integrity probe: every frame ends by parking the cursor at a cell the
// renderer owns, so a terminal that reports a *different* position has rewritten
// the surface underneath it (ConPTY re-emitting its buffer, #16911). This pins
// the wiring this half needs — a declared caret plus an actual DECXCPR query;
// the reply-driven repair needs a terminal that answers, so it is verified on a
// real host (DSH_TUI_DEBUG logs "[surface] cursor probe disagrees …").
{
  const app = await mount(true, false, <CursorHome />)
  try {
    // The caret declaration lands in a layout effect: paint once more so the
    // probe has a parked cell to judge (no resize — this case is about the probe
    // alone, not the repair burst).
    app.ink.renderNow()
    assert.ok(
      await settled(() => app.writes.some(w => w.includes('?6n'))),
      'the surface probe asks the terminal where the cursor is',
    )
    // The other half — a reply that disagrees forces a full repair — needs a
    // terminal that answers, so it is exercised by the real-host check
    // (DSH_TUI_DEBUG logs "[surface] cursor probe disagrees …") rather than by
    // this headless harness.
    console.log('PASS: cursor-integrity probe is wired to the parked cell')
  } finally {
    await app.instance.unmount()
    app.term.dispose()
  }
}

// The reply shape is what makes the probe safe to use at all: Windows
// Terminal/ConPTY answers DECXCPR with the optional page parameter
// (`CSI ? row ; col ; page R`, seen as `?30;5;1R`). A parser that only accepts
// two parameters drops the reply into the key/text path, and the reply text
// lands in the prompt (measured field report).
{
  const { parseMultipleKeypresses, INITIAL_STATE } = await import('../src/ink/parse-keypress.js')
  for (const reply of ['[?30;5;1R', '[?30;5R']) {
    const [items] = parseMultipleKeypresses(INITIAL_STATE, reply)
    assert.equal(items.length, 1, `one item for ${JSON.stringify(reply)}`)
    assert.equal(items[0]?.kind, 'response', `${JSON.stringify(reply)} must parse as a terminal response`)
    assert.equal(items[0]?.response?.type, 'cursorPosition')
  }
  console.log('PASS: DECXCPR replies (2- and 3-parameter) are consumed as responses')
}

// Preserve the quiet same-grid path for inline mode and non-ConPTY hosts.
for (const fullscreen of [false, true]) {
  if (fullscreen && process.platform === 'win32') continue
  if (fullscreen) delete process.env.WT_SESSION
  const app = await mount(fullscreen)
  try {
    const before = app.frames()
    const baseline = app.snapshot()
    for (let i = 0; i < 20; i++) app.stdout.emit('resize')
    await sleep(80) // 固定窗:探针 非目标路径的同尺寸通知必须保持零重绘
    assert.equal(app.frames(), before, `${fullscreen ? 'non-ConPTY' : 'inline'} same-grid resize stays quiet`)
    assert.deepEqual(app.snapshot(), baseline)
  } finally {
    await app.instance.unmount()
    app.term.dispose()
    process.env.WT_SESSION = 'headless-conpty-surface'
  }
}
console.log('PASS: inline/non-ConPTY controls')
