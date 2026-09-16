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
const [React, { PassThrough, Writable }, { Terminal }, { render, AlternateScreen }, { LogoV2 }, { default: instances }, { settled, sleep, viewportLines, writeParsed }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/LogoV2.js'), import('../src/ink/instances.js'), import('./lib/term-test.mjs'),
])

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

async function mount(fullscreen: boolean, animated = false) {
  const term = new Terminal({ cols: 100, rows: 32, scrollback: 1000, allowProposedApi: true })
  const writes: string[] = []
  let frames = 0
  let lastFrameAt = performance.now()
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
  const logo = <LogoV2 model="STATIC-MODEL" cwd="/static/cwd" effort="max"
    intro="classic" skipIntro={!animated} whaleIdle={false} drift={null}
    tip={{ id: 'surface', group: 'display', zh: 'STATIC-TIP', en: 'STATIC-TIP' }} />
  const instance = await render(fullscreen ? <AlternateScreen>{logo}</AlternateScreen> : logo, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Writable({ write(_c, _e, cb) { cb() } }) as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame() { frames++; lastFrameAt = performance.now() },
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
  return { term, stdout, instance, ink, writes, frames: () => frames, staticText, pixels, snapshot, idle: () => performance.now() - lastFrameAt >= 50 }
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
    const baseline = app.snapshot()
    // Only the physical terminal is cleared. Ink must not learn about this
    // until the resize notification (the failure modeled by the issue).
    await writeParsed(app.term, '\x1b[2J\x1b[H')
    assert.equal(app.staticText(), false)
    const before = app.frames()
    const beforeWrites = app.writes.length
    for (let i = 0; i < 20; i++) app.stdout.emit('resize')
    assert.ok(await settled(() => app.staticText() && app.pixels() > 60), 'same-grid resize restores static cells without Ctrl+L')
    await sleep(80) // 固定窗:探针 重复 resize 的尾沿不得再追加整屏重绘
    assert.deepEqual(app.snapshot(), baseline, 'restored text and whale colors match the intact surface')
    assert.equal(app.frames() - before, 1, 'a duplicate resize burst coalesces to one paint')
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
