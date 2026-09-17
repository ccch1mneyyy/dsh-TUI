// Capture the installed application through Windows ConPTY, without model calls.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const root = process.env.DSH_TUI_CAPTURE_ROOT
if (!root) throw new Error('Set DSH_TUI_CAPTURE_ROOT to the isolated installation')
const runtime = path.join(root, 'cli-rc1')
const requireRuntime = createRequire(path.join(runtime, 'package.json'))
const pty = requireRuntime('node-pty')
const { Terminal } = requireRuntime('@xterm/headless')
const [language = 'zh', variant = 'desktop'] = process.argv.slice(2)
if (!['zh', 'en'].includes(language) || !['desktop', 'mobile'].includes(variant)) {
  throw new Error('Usage: capture-runtime.cjs zh|en desktop|mobile')
}
const cols = variant === 'mobile' ? 58 : 110
const rows = variant === 'mobile' ? 36 : 42
const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
const home = path.join(root, `home-${language}-${variant}`)
fs.mkdirSync(home, { recursive: true })
const env = {
  ...process.env, HOME: home, USERPROFILE: home,
  DSH_HOME: path.join(root, 'dsh-home'),
  DSH_TUI_SESSION_ROOT: path.join(root, 'sessions'),
  DSH_TUI_LANG: language, DSH_TUI_THEME: 'light',
  TERM: 'xterm-256color', COLORTERM: 'truecolor', NODE_ENV: 'production',
}
delete env.DEEPSEEK_API_KEY
delete env.DEEPSEEK_BASE_URL
const child = pty.spawn(process.execPath, [
  path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  '--profile', 'dsh-tui',
], { cols, rows, cwd: path.join(root, 'workspace'), env, useConpty: true })
let raw = ''
let exited = false
let exitCode
child.onExit(e => { exited = true; exitCode = e.exitCode })
child.onData(data => { raw += data; term.write(data) })
term.onData(data => { if (!exited) child.write(data) })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const frames = []
const evidence = path.join(root, 'captures', `${language}-${variant}`)
fs.mkdirSync(evidence, { recursive: true })

async function snapshot(name, duration) {
  await new Promise(resolve => term.write('', resolve))
  if (exited) throw new Error(`Runtime exited with ${exitCode}`)
  const b = term.buffer.active
  const cells = []
  const lines = []
  for (let y = 0; y < rows; y++) {
    const line = b.getLine(b.viewportY + y)
    lines.push(line?.translateToString(true) || '')
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars()
      if (!chars.trim() && cell.isBgDefault() && !cell.isInverse()) continue
      cells.push([x, y, chars, cell.getWidth(),
        cell.getFgColorMode(), cell.getFgColor(),
        cell.getBgColorMode(), cell.getBgColor(),
        (cell.isBold() ? 1 : 0) | (cell.isDim() ? 2 : 0) |
        (cell.isItalic() ? 4 : 0) | (cell.isInverse() ? 8 : 0)])
    }
  }
  const plain = lines.join('\n')
  if (/Duplicate type|ERR_|引擎为|newer than|failed to import/.test(plain)) {
    throw new Error(`Runtime diagnostic appeared in ${name}: ${plain}`)
  }
  fs.writeFileSync(path.join(evidence, `${name}.txt`), plain)
  fs.writeFileSync(path.join(evidence, `${name}.ansi`), raw)
  frames.push({ name, duration, cells, cursor: [b.cursorX, b.cursorY] })
  console.log(`${language}/${variant}: ${name} (${cells.length} occupied cells)`)
}

async function main() {
  for (let i = 0; i < 60; i++) {
    await wait(500)
    if (exited) throw new Error(`Runtime exited with ${exitCode}`)
    const text = Array.from({length:rows}, (_,y) =>
      term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n')
    if (text.includes('dsh-TUI') && text.includes('❯')) break
    if (i === 59) throw new Error('Runtime did not become ready in 30 seconds')
  }
  await wait(4000)
  await snapshot('welcome', 2400)
  for (const [input, name, duration] of [
    ['/', 'slash', 800], ['he', 'completion', 800], ['lp', 'help-command', 1600],
    ['\r', 'help', 3200], ['\x1b', 'return', 1000],
  ]) {
    child.write(input)
    await wait(900)
    await snapshot(name, duration)
  }
  child.write('\x15')
  await wait(300)
  const draft = language === 'zh' ? '你好，开始吧' : 'Hello, let us begin'
  let count = 0
  for (const ch of draft) {
    child.write(ch)
    await wait(140)
    await snapshot(`typing-${++count}`, 140)
  }
  await wait(300)
  await snapshot('draft', 2800)
  const pkg = name => JSON.parse(fs.readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8')).version
  const installedTui = path.join(root, 'dsh-home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json')
  const data = {
    schema: 1, language, variant, cols, rows, cellWidth: 8.25, cellHeight: 18,
    font: 'Consolas', fontSize: 15, foreground: '#333333', background: '#ffffff',
    capturedAt: new Date().toISOString(), node: process.version,
    versions: { dsh: pkg('@deepseek-ai/dsh'), tui: JSON.parse(fs.readFileSync(installedTui)).version,
      xterm: pkg('@xterm/headless'), pty: pkg('node-pty') },
    ansiSha256: createHash('sha256').update(raw).digest('hex'),
    note: 'Real ConPTY output. No credentials, no submitted prompts, no model response.',
    frames,
  }
  const target = path.join(__dirname, 'runtime', `${language}-${variant}.json`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(data) + '\n')
}
main().then(() => {
  child.kill()
  term.dispose()
  process.exit(0)
}).catch(error => {
  fs.writeFileSync(path.join(evidence, 'failure.ansi'), raw)
  console.error(error)
  child.kill()
  term.dispose()
  process.exit(1)
})
