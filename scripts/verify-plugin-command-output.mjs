/**
 * Real registry -> channel -> Chat -> xterm regression for local command reports.
 * Run: node --import tsx/esm scripts/verify-plugin-command-output.mjs
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const home = mkdtempSync(join(tmpdir(), 'dsh-command-report-'))
process.env.HOME = home
process.env.USERPROFILE = home
try {
const [assert, React, { Writable, PassThrough }, { Terminal }, ui, { Chat },
  { createChannel }, { QuestionStore }, { settle, settled, sleep, findText },
  { cleanBlockLines, cleanCommandReport }, { stringWidth }, { default: instances },
  { getSelectedText }, { DATA_DIR }, { MAX_ROWS }] = await Promise.all([
  import('node:assert/strict'), import('react'), import('node:stream'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/questions.js'), import('./lib/term-test.mjs'),
  import('../src/channel/sanitize.js'), import('../src/ink/stringWidth.js'),
  import('../src/ink/instances.js'), import('../src/ink/selection.js'),
  import('../src/utils/paths.js'), import('../src/channel/transcript.js'),
])
assert.equal(DATA_DIR, join(home, '.dsh-tui'), 'application imports must see the isolated home')

// Count input units passed through the real width function: a deterministic
// work bound, independent of machine speed, on the production sanitizer.
const original = new URL('../src/channel/sanitize.ts', import.meta.url)
const measured = new URL(`./sanitize.work-${process.pid}.ts`, original)
writeFileSync(measured, readFileSync(original, 'utf8').replace(
  "import { stringWidth } from '../ink/stringWidth.js'",
  "import { stringWidth as actualWidth } from '../ink/stringWidth.js'\nexport let measuredUnits = 0\nfunction stringWidth(value: string): number { measuredUnits += value.length; return actualWidth(value) }"))
try {
  const probe = await import(measured.href)
  const input = '中文😀'.repeat(3000)
  assert.equal(probe.cleanCommandReport(input).truncated, true)
  assert.ok(probe.measuredUnits < input.length * 4, 'report clipping must not repeatedly measure growing prefixes')
} finally { rmSync(measured, { force: true }) }

assert.deepEqual(cleanBlockLines('  one  two\n\nthree', 100), ['one two', 'three'])
assert.deepEqual(cleanCommandReport('  one\n\n\x1b[31m中文😀\x1b[0m\x1b]0;hidden\x07\x00').lines, ['  one', '', '中文😀 '])
for (const value of ['x'.repeat(65_537), '中文😀'.repeat(3000), 'line\n'.repeat(201), 'x'.repeat(65_535) + '😀']) {
  const report = cleanCommandReport(value)
  assert.equal(report.truncated, true)
  assert.ok(report.lines.length <= 200)
  assert.ok(report.lines.every(line => stringWidth(line) <= 4000 && !/[\uD800-\uDBFF]$/u.test(line)))
}
console.log('PASS report bounds, Unicode, ANSI/OSC/C0, indentation, blank lines, unchanged explicit blocks')

async function harness(fullscreen, execute) {
  let calls = 0
  const durable = []
  const submitted = []
  const definition = { name: 'demo', description: 'Multiline report', input: { hint: '', images: false } }
  const commands = {
    list: () => [definition],
    find: (_agent, name) => name === 'demo' ? definition : undefined,
    async execute() { calls++; return { commandId: 'demo', result: await execute() } },
  }
  const makeAgent = id => ({
    id, status: 'idle', session: { id, seq: 0, events: id === 'origin' ? durable : [] },
    ctx: { on: () => () => {} }, followup: input => submitted.push(input), steer() {}, cancel() {},
  })
  const ctx = {
    on: () => () => {},
    get: name => name === 'commands' ? commands
      : name === 'agents' ? { create: async () => ({ agent: makeAgent('replacement'), dispose: async () => {} }) }
      : undefined,
    logger: { warn() {}, info() {}, debug() {} },
  }
  const channel = createChannel(ctx, makeAgent('origin'), { model: 'fake-model', provider: '', cwd: home, activity: false })
  const term = new Terminal({ cols: 90, rows: 50, scrollback: 1000, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _encoding, callback) { term.write(String(chunk), callback) } })
  Object.assign(stdout, { columns: 90, rows: 50, isTTY: true })
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const chat = React.createElement(Chat, { channel, fullscreen, questionStore: new QuestionStore(), onExit() {}, trajectorySeen: true })
  const app = await ui.render(fullscreen ? React.createElement(ui.AlternateScreen, { mouseTracking: true }, chat) : chat,
    { stdout, stdin, stderr, patchConsole: false, exitOnCtrlC: false })
  const screen = () => Array.from({ length: term.buffer.active.baseY + term.rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  await settle(() => screen().includes('fake-model'))
  const run = async () => {
    for (const char of '/demo') stdin.write(char)
    await settle(() => screen().includes('/demo'))
    stdin.write('\r')
  }
  return { channel, term, stdin, stdout, run, screen, calls: () => calls, durable, submitted,
    close: async () => { await app.unmount(); channel.releaseContributions(); term.dispose() } }
}

const text = Array.from({ length: 30 }, (_, i) => i === 14 ? '' : `  REPORT-${i + 1} 中文😀`).join('\n')
for (const fullscreen of [false, true]) {
  for (const kind of ['success', 'error']) {
    const h = await harness(fullscreen, async () => ({ kind, text }))
    await h.run()
    await settle(() => h.channel.rows.filter(row => row.kind === 'local-output').length === 30)
    const rows = h.channel.rows.filter(row => row.kind === 'local-output')
    assert.equal(rows[0].text, '  REPORT-1 中文😀')
    assert.equal(rows[29].text, '  REPORT-30 中文😀')
    assert.equal(rows[14].text.trim(), '')
    assert.equal(h.calls(), 1)
    assert.equal(h.durable.length, 0)
    assert.equal(h.submitted.length, 0)
    assert.equal(h.channel.notifications.some(notice => notice.color === 'error'), kind === 'error')
    await settle(() => h.screen().includes('REPORT-1 ') && h.screen().includes('REPORT-30 '))
    if (fullscreen) {
      const first = findText(h.term, 'REPORT-1 ')
      const last = findText(h.term, 'REPORT-30 ')
      h.stdin.write(`\x1b[<0;${first.col + 1};${first.row + 1}M`)
      h.stdin.write(`\x1b[<32;${last.col + 20};${last.row + 1}M`)
      h.stdin.write(`\x1b[<0;${last.col + 20};${last.row + 1}m`)
      const ink = instances.get(h.stdout)
      assert.ok(await settled(() => getSelectedText(ink.selection, ink.frontFrame.screen).includes('REPORT-30')))
      const copied = getSelectedText(ink.selection, ink.frontFrame.screen)
      assert.ok(copied.includes('REPORT-1 ') && copied.includes('REPORT-30'))
    }
    console.log(`PASS real registry/channel ${kind}, ${fullscreen ? 'fullscreen SGR copy' : 'inline scrollback'}, 30 lines, one execution, no model/durable writes`)
    if (kind === 'success') console.log(`SCREEN ${fullscreen ? 'fullscreen' : 'inline'}\n${h.screen()}\nEND SCREEN`)
    await h.close()
  }
}

{
  const h = await harness(false, async () => ({ kind: 'success', text: 'line\n'.repeat(201) }))
  await h.run()
  await settle(() => h.channel.rows.some(row => row.text.includes('command output truncated')))
  assert.equal(h.channel.rows.filter(row => row.kind === 'local-output').length, 201)
  await h.close()
  console.log('PASS visible truncation marker through real Chat')
}
{
  const h = await harness(false, async () => ({ kind: 'success', text: 'retained' }))
  h.channel.rows.push({ id: -1, kind: 'user', text: 'backend fact must survive local report eviction' })
  for (let i = 0; i < 8; i++) h.channel.pushLocal(`REPORT ${i}`, Array(200).fill(`line ${i}`), { preserveWhitespace: true })
  assert.ok(h.channel.rows.filter(row => row.kind === 'local' || row.kind === 'local-output').length <= MAX_ROWS)
  assert.equal(h.channel.rows.find(row => row.id === -1)?.text, 'backend fact must survive local report eviction')
  assert.equal(h.channel.rows.at(-1).text, 'line 7')
  assert.equal(h.channel.rows.find(row => row.kind === 'local')?.text, 'REPORT 6', 'evict whole old reports')
  await h.close()
  console.log('PASS bounded aggregate local reports; newest whole blocks and backend facts retained')
}
{
  let resolve
  const h = await harness(false, () => new Promise(done => { resolve = done }))
  await h.run()
  await settle(() => typeof resolve === 'function')
  assert.equal(await h.channel.newSession(), true)
  resolve({ kind: 'success', text: 'STALE-REPORT' })
  // 固定窗:pacing Allow a settled old registry result to reach both binding fences.
  await sleep(100)
  assert.ok(!h.channel.rows.some(row => row.text.includes('STALE-REPORT')))
  assert.equal(h.calls(), 1)
  await h.close()
  console.log('PASS actual session replacement drops late result')
}
console.log('verify-plugin-command-output: all checks passed')
} finally { rmSync(home, { recursive: true, force: true }) }
