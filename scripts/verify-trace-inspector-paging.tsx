/**
 * #1751: expanded /trace details must stop at their last page, without
 * accumulating invisible j/k or wheel debt. Real scene, stdin and xterm.
 * Run: node --import tsx/esm scripts/verify-trace-inspector-paging.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const temporaryParent = resolve(tmpdir())
const home = mkdtempSync(join(temporaryParent, 'trace-paging-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_TUI_LANG = 'en'
const [React, { Terminal }, ui, { TrajectoryScene }, trajectory, { settled }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/TrajectoryScene.js'), import('../src/dsh-adapter/trajectory/index.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen } = ui
const marker = (line: number) => `PAGING-ROW-${String(line).padStart(3, '0')}`
function data(count: number, tool = false) {
  const content = [{ type: 'text', text: Array.from({ length: count }, (_, i) => marker(i)).join('\n') }]
  const events: Record<string, unknown>[] = tool ? [
    { type: 'tool/call', seq: 1, time: 1_700_000_000_000, data: { turn: 1, step: 1, callId: 'paging-tool', name: 'paging', arguments: '{"input":"retained"}' } },
    { type: 'tool/result', seq: 2, time: 1_700_000_000_100, data: { turn: 1, step: 1, message: { source: { callId: 'paging-tool' }, content } } },
  ] : [{ type: 'assistant/message', seq: 1, time: 1_700_000_000_000, data: {
    turn: 1, step: 1, message: { content },
  } }]
  const build = trajectory.buildTrajectory(events as never)
  assert.equal(build.nodes.length, 1, 'controlled fixture has one inspectable message')
  const detail = trajectory.inspectNode(build.nodes[0]!, events as never)
  assert.equal(detail.sections.length, tool ? 2 : 1)
  if (!tool) assert.equal(detail.sections[0]!.title.toLowerCase(), detail.title.toLowerCase(), 'message fixture has no extra section heading')
  return { events, build }
}
async function harness(columns: number, rows: number, count: number, tool = false) {
  const term = new Terminal({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  class Output extends Writable {
    isTTY = true
    columns = columns
    rows = rows
    frames = 0
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      term.write(String(chunk), () => { this.frames += 1; callback() })
    }
  }
  class Input extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(next: boolean) { this.isRaw = next; return this }
    setEncoding() { return this }
    ref() { return this }
    unref() { return this }
  }
  class ErrorOutput extends Writable {
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      process.stderr.write(String(chunk)); callback()
    }
  }
  const stdout = new Output()
  const stdin = new Input()
  let current = data(count, tool)
  const channel = {
    sessionTitle: 'trace paging', cwd: home, traceEvents: () => current.events as never,
    trajectorySource: () => 'supported', trajectoryLanes: () => [], subscribe: () => () => {},
  }
  const view = () => <ThemeProvider theme="dark"><AlternateScreen><TrajectoryScene channel={channel as never} build={current.build} onClose={() => {}} /></AlternateScreen></ThemeProvider>
  const app = await render(view(), {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new ErrorOutput() as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false,
  })
  const screen = () => {
    const buffer = term.buffer.active
    return Array.from({ length: stdout.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(false) ?? '').join('\n')
  }
  const key = async (value: string) => {
    stdin.write(value)
    // 固定窗:pacing 末页重复按键可能不改变画面，逐键让输入解析与节流帧完成，避免 stdin 合并。
    await new Promise(done => setTimeout(done, 80))
  }
  const close = async () => { await app.unmount(); stdin.destroy(); term.dispose() }
  try {
    // A collapsed tool detail can spend its entire body on input headings;
    // the message output is only a valid readiness anchor after expanding.
    assert.equal(await settled(() => screen().includes('✦ Trajectory') && screen().includes('● Timeline')), true, 'initial real scene chrome rendered even when the session title is omitted')
    await key('\r')
    assert.equal(await settled(() => screen().includes('j/k page') && screen().includes(marker(0))), true, 'Enter positively opened the expanded inspector and its content')
  } catch (error) { await close(); throw error }
  return {
    key, screen,
    async resize(nextRows: number) { stdout.rows = nextRows; term.resize(columns, nextRows); stdout.emit('resize') },
    async replace(nextCount: number) { current = data(nextCount, tool); app.rerender(view()) },
    close,
  }
}
let failures = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures += 1; console.error('FAIL ' + name, error) }
}
try {
  for (const [columns, rows, tool] of [[120, 30, false], [40, 18, false], [100, 24, true]] as const) {
    await test(`${columns}x${rows} ${tool ? 'tool sections' : 'message'}: repeated j stops at the last page and one k returns immediately`, async () => {
      const h = await harness(columns, rows, 100, tool)
      try {
        await h.key('j')
        assert.equal(await settled(() => h.screen().includes(marker(rows - 12))), true, 'j really advanced the inspector')
        for (let i = 0; i < 30; i++) await h.key('j')
        console.log(`PAGING-END-${columns}x${rows}\n${h.screen()}\nPAGING-END-SCREEN`)
        assert.equal(await settled(() => h.screen().includes(marker(99))), true, 'last content line remains visible after extra j')
        await h.key('k')
        const previousStart = Math.max(0, 100 - (rows - 11) - (rows - 12))
        assert.equal(await settled(() => h.screen().includes(marker(previousStart)) && !h.screen().includes(marker(99))), true, 'one k leaves the last page without paying invisible scroll debt')
      } finally { await h.close() }
    })
  }
  await test('short content never scrolls into a blank inspector', async () => {
    const h = await harness(80, 24, 3)
    try {
      for (let i = 0; i < 8; i++) await h.key('j')
      assert.equal(await settled(() => h.screen().includes(marker(0)) && h.screen().includes(marker(2))), true)
      await h.key('k')
      assert.equal(await settled(() => h.screen().includes(marker(0))), true)
    } finally { await h.close() }
  })
  await test('wheel paging obeys the same last-page bound and reverses immediately', async () => {
    const h = await harness(120, 30, 100)
    try {
      await h.key('\x1b[<65;10;15M')
      assert.equal(await settled(() => h.screen().includes(marker(18))), true, 'actual SGR wheel advanced inspector')
      for (let i = 0; i < 14; i++) await h.key('\x1b[<65;10;15M')
      assert.equal(await settled(() => h.screen().includes(marker(99))), true)
      await h.key('\x1b[<64;10;15M')
      assert.equal(await settled(() => h.screen().includes(marker(63)) && !h.screen().includes(marker(99))), true)
    } finally { await h.close() }
  })
  await test('a taller viewport immediately re-clamps an expanded last page', async () => {
    const h = await harness(100, 18, 100)
    try {
      for (let i = 0; i < 17; i++) await h.key('j')
      assert.equal(await settled(() => h.screen().includes(marker(99))), true)
      await h.resize(30)
      assert.equal(await settled(() => h.screen().includes(marker(81)) && h.screen().includes(marker(99))), true)
      await h.key('k')
      assert.equal(await settled(() => h.screen().includes(marker(63))), true)
    } finally { await h.close() }
  })
  await test('shorter replacement content cannot retain an old last-page offset', async () => {
    const h = await harness(100, 24, 100)
    try {
      for (let i = 0; i < 9; i++) await h.key('j')
      assert.equal(await settled(() => h.screen().includes(marker(99))), true)
      await h.replace(3)
      assert.equal(await settled(() => h.screen().includes(marker(0)) && h.screen().includes(marker(2))), true)
      await h.key('k')
      assert.equal(await settled(() => h.screen().includes(marker(0))), true)
      await h.replace(100)
      assert.equal(await settled(() => h.screen().includes(marker(0)) && !h.screen().includes(marker(99))), true, 'growing again must not revive the retired offset')
    } finally { await h.close() }
  })
} finally {
  assert.equal(dirname(resolve(home)), temporaryParent)
  rmSync(home, { recursive: true, force: true })
}
assert.equal(failures, 0, `${failures} trace inspector paging cases failed`)
