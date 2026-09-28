/** Welcome-art regression: full title at narrow widths, resize, and both screen modes.
 * Run: node --import tsx/esm scripts/verify-welcome-layout.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ strict: assert }, { PassThrough, Writable }, React, ui, { LogoV2 },
  xterm, { settled, writeParsed, viewportLines }, { bigLineWidth, bigTextWidth, renderBigLine, renderBigText },
  { deepSleepSegments, SLEEP_Z_COLUMN, SLEEP_Z_ROWS, wordmarkWidth }] = await Promise.all([
  import('node:assert'), import('node:stream'), import('react'), import('../src/ui.js'),
  import('../src/components/LogoV2.js'), import('@xterm/headless'),
  import('./lib/term-test.mjs'), import('../src/components/bigfont.js'),
  import('../src/components/wordmark.js'),
])
const { pixelWordmark } = await import('../src/components/welcomePixels.js')
const cleanPixel = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const pixelRows = style => pixelWordmark(style, style === 'deepsleep' ? 21 : 0).map(cleanPixel).filter(row => row.trim())
const { PageMargin } = await import('../src/components/PageMargin.js')
const { applyPageMargin } = await import('../src/tuiDisplayPrefs.js')
const { Terminal } = xterm.default ?? xterm
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '')
const color = { r: 90, g: 140, b: 210 }
for (const text of ['DEEPSEEK', 'HARNESS', 'A A', '??', '🐋A', '']) {
  const rows = renderBigText(text, 0, color, color, color)
  assert.equal(rows.length, 5)
  assert.ok(rows.every(row => strip(row).length === bigTextWidth(text)))
}
const letterRows = renderBigText('DEEPSEEK', 0, color, color, color).map(strip)
for (let gap = 5; gap < bigTextWidth('DEEPSEEK'); gap += 7) {
  assert.ok(letterRows.every(row => row.slice(gap, gap + 2) === '  '), 'letters need a clear gap')
}

// DEEP SLEEP: the narrow `LEEP` half must land `HARNESS` on the same column.
const palette = { brand: color, ice: color, pale: color }
const deepSleepTopSegments = deepSleepSegments(palette)
const harnessSegments = [{ text: 'HARNESS', from: color, to: color, gap: 3 }]
assert.equal(bigLineWidth(deepSleepTopSegments), bigLineWidth(harnessSegments), 'DEEP SLEEP rows must end on one column')
assert.equal(wordmarkWidth('deepsleep'), bigLineWidth(deepSleepTopSegments), 'DEEP SLEEP width must be the measured line')
assert.equal(wordmarkWidth('classic'), bigTextWidth('DEEPSEEK'))
assert.ok(wordmarkWidth('deepsleep') < wordmarkWidth('classic'), 'DEEP SLEEP fits one column earlier than the classic pair')
const titleRows = {
  deepsleep: {
    top: renderBigLine(deepSleepTopSegments, 0, color).map(strip),
    bottom: renderBigLine(harnessSegments, 0, color).map(strip),
  },
  classic: {
    top: letterRows,
    bottom: renderBigText('HARNESS', 0, color, color, color).map(strip),
  },
}
class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  isTTY = true
  rows = 32
  columns = 100
  writes = []
  _write(chunk, _, done) { this.writes.push(String(chunk)); done() }
}
const scenarios = [false, true].flatMap(fullscreen =>
  ['dark', 'light'].flatMap(theme =>
    [true, false].flatMap(whale =>
      ['none', 'normal'].map(margin => ({ fullscreen, theme, whale, margin })),
    ),
  ),
)
for (const { fullscreen, theme, whale, margin } of scenarios) {
  applyPageMargin(margin)
  const stdout = new Output()
  const term = new Terminal({ cols: 100, rows: 32, allowProposedApi: true })
  const logo = React.createElement(LogoV2, {
    model: 'welcome-test-model', cwd: '/welcome', skipIntro: true,
    whale, whaleIdle: false, drift: null,
    // Pin the block-font mode: this regression measures the CELL-art layout,
    // and the shipped default (`glitch`) would swap in the PNG header on a
    // wide terminal (that path is covered by verify-welcome-image-r1u and
    // verify-welcome-art).
    welcomeArt: 'deepsleep',
    tip: { en: 'Use /model', zh: '输入 /model' },
  })
  const content = React.createElement(PageMargin, null, logo)
  const tree = React.createElement(ui.ThemeProvider, { theme },
    fullscreen ? React.createElement(ui.AlternateScreen, null, content) : content)
  const instance = await ui.render(tree, {
    stdout, stderr: new Output(), stdin: new Input(),
    exitOnCtrlC: false, patchConsole: false,
  })
  let consumed = 0
  assert.ok(await settled(() => stdout.writes.join('').includes('welcome-test-model')))
  const screen = async () => {
    await writeParsed(term, stdout.writes.slice(consumed).join(''))
    consumed = stdout.writes.length
    return viewportLines(term).join('\n')
  }
  for (const columns of [100, 99, 96, 95, 80, 68, 67, 64, 63, 58, 57, 54, 53, 48, 100]) {
    if (stdout.columns !== columns) {
      const previousWrites = stdout.writes.length
      stdout.columns = columns
      term.resize(columns, 32)
      stdout.emit('resize')
      assert.ok(await settled(() => stdout.writes.length > previousWrites), 'resize must repaint')
    }
    const text = await screen()
    const available = columns - (margin === 'normal' ? 4 : 0)
    const budget = available - (whale && available >= 64 ? 42 : 0)
    if (budget >= wordmarkWidth('deepsleep')) {
      assert.ok(pixelRows('deepsleep').every(row => text.includes(row.trimEnd())), `complete art title: ${columns}, ${theme}, ${fullscreen}`)
      assert.ok(pixelRows('deepsleep').every(row => text.includes(row.trimEnd())), `aligned HARNESS row: ${columns}, ${theme}, ${fullscreen}`)
    } else {
      assert.ok(text.includes('DeepSeek Harness'), `complete compact title: ${columns}, ${theme}, ${fullscreen}`)
    }
    assert.ok(text.includes('welcome-test-model'), 'model line must survive the layout')
    assert.ok(text.includes('/welcome'), 'cwd must survive the layout')
  }
  await instance.unmount()
  term.dispose()
  console.log(`PASS: ${theme}, ${fullscreen ? 'fullscreen' : 'inline'} — whale=${whale}, margin=${margin}, resize and exact-fit boundaries (48–100 columns)`)
}

// The floating sleep-Z hangs above the wordmark's right edge, and the classic
// pair stays reachable through the mode registry.
{
  const plain = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const motifColors = {}
  const renderTitle = async welcomeArt => {
    const stdout = new Output()
    const term = new Terminal({ cols: 100, rows: 32, allowProposedApi: true })
    const instance = await ui.render(
      React.createElement(ui.ThemeProvider, { theme: 'dark' },
        React.createElement(LogoV2, {
          model: 'welcome-test-model', cwd: '/welcome', skipIntro: true,
          whale: false, whaleIdle: false, drift: null, welcomeArt,
          tip: { en: 'Use /model', zh: '输入 /model' },
        })),
      { stdout, stderr: new Output(), stdin: new Input(), exitOnCtrlC: false, patchConsole: false },
    )
    assert.ok(await settled(() => stdout.writes.join('').includes('welcome-test-model')))
    await writeParsed(term, stdout.writes.join(''))
    const text = viewportLines(term).join('\n')
    motifColors[welcomeArt] = stdout.writes.join('').includes('38;2;128;128;128')
    await instance.unmount()
    term.dispose()
    return text
  }
  const deepsleep = await renderTitle('deepsleep')
  assert.ok(pixelRows('deepsleep').every(row => deepsleep.includes(row.trimEnd())), 'the DEEP SLEEP mode renders its wordmark')
  assert.ok(deepsleep.split('\n').some(row => row.slice(SLEEP_Z_COLUMN, SLEEP_Z_COLUMN + 4) === plain(SLEEP_Z_ROWS[0])), 'the floating sleep-Z sits above the wordmark')
  assert.ok(plain(SLEEP_Z_ROWS[1]).includes('▀'), 'the floating sleep-Z keeps its diagonal stroke')
  const classic = await renderTitle('classic')
  assert.ok(pixelRows('classic').every(row => classic.includes(row.trimEnd())), 'the classic DEEPSEEK pair renders when asked')
  assert.ok(!motifColors.classic && motifColors.deepsleep, 'gray Z motif belongs to sleep, not classic')
}

console.log('PASS: glyph spacing, measured widths, DEEP SLEEP alignment, title breakpoints and resize')
