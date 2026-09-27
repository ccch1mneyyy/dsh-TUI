/** Capture the real welcome component into xterm cells for visual comparison.
 * Run after pnpm compile: node --import tsx/esm scripts/preview-welcome.mjs before|after
 * `before` reads unchanged sources from a git ref (third argument, default origin/main).
 * Artifacts are local only: .local/welcome-preview/.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
const variant = process.argv[2] ?? 'after'
const baselineRef = process.argv[3] ?? 'origin/main'
if (!['before', 'after'].includes(variant)) throw new Error('Expected before or after')

if (variant === 'before') {
  const [{ execFileSync }, fs, path] = await Promise.all([
    import('node:child_process'), import('node:fs'), import('node:path'),
  ])
  const directory = '.local/welcome-preview/baseline'
  fs.mkdirSync(directory, { recursive: true })
  for (const name of ['LogoV2.tsx', 'Whale.tsx', 'bigfont.ts']) {
    const sourcePath = `src/components/${name}`
    let source = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { encoding: 'utf8' })
    source = source.replace(/from '(\.[^']+)'/g, (match, spec) => {
      if (name === 'LogoV2.tsx' && ['./Whale.js', './bigfont.js'].includes(spec)) return match
      const target = path.resolve(path.dirname(sourcePath), spec)
      const relative = path.relative(path.resolve(directory), target).replaceAll('\\', '/')
      return `from '${relative.startsWith('.') ? relative : './' + relative}'`
    })
    fs.writeFileSync(path.join(directory, name), source)
  }
}

const [{ PassThrough, Writable }, React, { render, ThemeProvider, Box, Text },
  { LogoV2 }, xterm, { mkdir, writeFile }, { settled, writeParsed }] = await Promise.all([
  import('node:stream'), import('react'), import(variant === 'before' ? '../src/ui.js' : '../lib/types/ui.js'),
  import(variant === 'before' ? '../.local/welcome-preview/baseline/LogoV2.js' : '../lib/types/components/LogoV2.js'), import('@xterm/headless'),
  import('node:fs/promises'), import('./lib/term-test.mjs'),
])
const { Terminal } = xterm.default ?? xterm

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  isTTY = true
  rows = 32
  writes = []
  constructor(columns) { super(); this.columns = columns }
  _write(chunk, _, done) { this.writes.push(String(chunk)); done() }
}

const captures = []
for (const columns of [100, 80, 64, 48]) {
  for (const theme of ['dark', 'light']) {
    const stdout = new Output(columns)
    const stderr = new Output(columns)
    const instance = await render(
      React.createElement(ThemeProvider, { theme },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(LogoV2, {
            model: 'deepseek-v4-flash', effort: 'high', cwd: 'D:/projects/deepsea',
            skipIntro: true, whaleIdle: false, drift: null,
            tip: { zh: '输入 /model 切换模型', en: 'Use /model to switch models' },
          }),
          React.createElement(Text, null, 'PREVIEW-END'),
        ),
      ),
      { stdout, stderr, stdin: new Input(), exitOnCtrlC: false, patchConsole: false },
    )
    if (!await settled(() => stdout.writes.join('').includes('PREVIEW-END'))) {
      throw new Error(`Welcome did not render at ${columns} columns: ${stderr.writes.join('')}`)
    }
    const term = new Terminal({ cols: columns, rows: 32, allowProposedApi: true })
    await writeParsed(term, stdout.writes.join(''))
    const cells = []
    const lines = []
    for (let y = 0; y < term.buffer.active.length; y++) {
      const line = term.buffer.active.getLine(y)
      const text = line?.translateToString(true) ?? ''
      if (text.includes('PREVIEW-END')) break
      lines.push(text)
      const row = []
      for (let x = 0; x < columns; x++) {
        const cell = line?.getCell(x)
        row.push({
          text: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1,
          fg: cell?.isFgRGB() ? '#' + cell.getFgColor().toString(16).padStart(6, '0') : null,
          bg: cell?.isBgRGB() ? '#' + cell.getBgColor().toString(16).padStart(6, '0') : null,
          dim: Boolean(cell?.isDim()), bold: Boolean(cell?.isBold()),
        })
      }
      cells.push(row)
    }
    await instance.unmount()
    term.dispose()
    captures.push({ columns, theme, cells, lines })
  }
}
await mkdir('.local/welcome-preview', { recursive: true })
await writeFile(`.local/welcome-preview/${variant}.json`, JSON.stringify(captures))
console.log(`Captured ${captures.length} real welcome screens (${variant})`)
