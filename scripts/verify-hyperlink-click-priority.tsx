/** Issue #1797: real transcript hyperlinks must survive row-level click handlers. */
process.env.DSH_TUI_LANG = 'en'
process.env.TERM_PROGRAM = 'kitty'
process.env.FORCE_COLOR = '3'

const [React, { PassThrough, Writable }, { Terminal }, { render, AlternateScreen, Box, Text, useInput },
  { MessageList }, { default: instances }, { hasSelection }, { settled, sleep }, { default: Link }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/MessageList.js'), import('../src/ink/instances.js'),
  import('../src/ink/selection.js'), import('./lib/term-test.mjs'), import('../src/ink/components/Link.js'),
])

let failures = 0
let checks = 0
const check = (name: string, ok: boolean): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}
type Row = Parameters<typeof MessageList>[0]['rows'][number]
const WEB = 'https://example.com/1797'
const BARE = 'https://example.com/bare'
const FILE = 'dsh-file:%2Ftmp%2F1797.md'
const rows: Row[] = [
  { id: 1, kind: 'assistant', text: `[SHORT_LINK](${WEB})` },
  { id: 2, kind: 'assistant', text: `BODY [FOLD_LINK](${WEB}) ${BARE} ${'x'.repeat(1400)} HIDDEN_TAIL` },
]

for (const cols of [48, 100]) {
  const term = new Terminal({ cols, rows: 40, scrollback: 0, allowProposedApi: true })
  class Output extends Writable {
    columns = cols
    rows = 40
    isTTY = true
    _write(data: unknown, _encoding: BufferEncoding, done: () => void): void { term.write(String(data), done) }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdout = new Output()
  const stdin = new Input()
  const stderr = new Writable({ write(_data, _encoding, done) { done() } })
  const opened: string[] = []
  const toggles: number[] = []
  function Scene(): React.ReactNode {
    useInput(() => {})
    return <AlternateScreen><Box flexDirection="column">
      <MessageList rows={rows} expanded={false} expandedRows={new Set<number>()} selectedId={null}
        onToggleRow={id => { toggles.push(id) }} model="deepseek-chat" showAll onToggleAll={() => {}} />
      <Box preferHyperlinks onClick={() => { toggles.push(99) }}><Link url={FILE}>FILE_LINK</Link></Box>
      <Box preferHyperlinks onClick={() => { toggles.push(101) }}>
        <Box onClick={event => { toggles.push(100); event.stopImmediatePropagation() }}><Text>https://example.com/editor</Text></Box>
      </Box>
    </Box></AlternateScreen>
  }
  const instance = await render(<Scene />, { stdout: stdout as never, stdin: stdin as never,
    stderr: stderr as never, patchConsole: false, exitOnCtrlC: false })
  const exited = instance.waitUntilExit()
  const lines = (): string[] => Array.from({ length: 40 }, (_, y) =>
    term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
  const locate = (text: string): { col: number; row: number } => {
    for (const [row, line] of lines().entries()) {
      const col = line.indexOf(text)
      if (col >= 0) return { col: col + 1, row: row + 1 }
    }
    throw new Error(`Rendered marker not found: ${text}`)
  }
  const mouse = (point: { col: number; row: number }, button: number, release = false): void => {
    stdin.write(`\x1b[<${button};${point.col};${point.row}${release ? 'm' : 'M'}`)
  }
  const click = (point: { col: number; row: number }, button = 0): void => {
    mouse(point, button); mouse(point, button, true)
  }
  try {
    if (!await settled(() => lines().some(line => line.includes('FILE_LINK')))) throw new Error('Scene did not render')
    const ink = instances.get(stdout)
    if (!ink) throw new Error('Mounted renderer not found')
    ink.onHyperlinkClick = url => { opened.push(url) } // no OS/browser side effect
    for (const [label, url] of [['FOLD_LINK', WEB], ['FILE_LINK', FILE]]) {
      const p = locate(label!)
      if (ink.getHyperlinkAt(p.col - 1, p.row - 1) !== url) throw new Error(`Fixture did not render the actual ${label} URL`)
      check(`${cols}: ${label} has the expected actual cell URL`, true)
    }
    console.log(`SCREEN ${cols}x40\n${lines().filter(Boolean).join('\n')}`)
    check(`${cols}: real long transcript row is folded`, !lines().join('').includes('HIDDEN_TAIL'))

    let n = opened.length
    click(locate('SHORT_LINK'))
    check(`${cols}: short transcript link opens`, await settled(() => opened.length === n + 1 && opened.at(-1) === WEB))
    // 固定窗:墙钟 — a fresh gesture must start outside the 500ms multi-click window.
    await sleep(550)
    n = opened.length
    let t = toggles.length
    click(locate('FOLD_LINK'))
    check(`${cols}: folded transcript link opens`, await settled(() => opened.length === n + 1 && opened.at(-1) === WEB, { timeoutMs: 1200 }))
    check(`${cols}: link click does not toggle its transcript row`, toggles.length === t)

    // 固定窗:墙钟 — separate the following gesture from the prior click chain.
    await sleep(550)
    n = opened.length; t = toggles.length
    click(locate(BARE))
    check(`${cols}: bare URL in folded transcript opens`, await settled(() => opened.length === n + 1 && opened.at(-1) === BARE, { timeoutMs: 1200 }))
    check(`${cols}: bare URL does not toggle its transcript row`, toggles.length === t)

    // 固定窗:墙钟 — test independent non-link click semantics.
    await sleep(550)
    n = opened.length; t = toggles.length
    click(locate('BODY'))
    check(`${cols}: non-link text still toggles the folded row`, await settled(() => toggles.length === t + 1 && toggles.at(-1) === 2))
    // 固定窗:探针 — no delayed hyperlink may be opened by the non-link click.
    await sleep(550)
    check(`${cols}: non-link click opens nothing`, opened.length === n)

    n = opened.length; t = toggles.length
    click(locate('https://example.com/editor'))
    check(`${cols}: ordinary clickable URL text retains DOM ownership`, await settled(() => toggles.length === t + 1 && toggles.at(-1) === 100, { timeoutMs: 1200 }))
    // 固定窗:探针 — input-like URL text must keep its click action, not open a browser.
    await sleep(550)
    check(`${cols}: ordinary clickable URL text opens nothing`, opened.length === n)

    // 固定窗:墙钟 — the next link has a different owner and its own gesture.
    await sleep(550)

    n = opened.length; t = toggles.length
    click(locate('FILE_LINK'))
    check(`${cols}: file-action URL reaches the existing opener`, await settled(() => opened.length === n + 1 && opened.at(-1) === FILE, { timeoutMs: 1200 }))
    check(`${cols}: file-action link does not invoke its parent`, toggles.length === t)

    // 固定窗:墙钟 — begin the actual two-press multi-click sequence independently.
    await sleep(550)
    n = opened.length
    const p = locate('FOLD_LINK')
    click(p); click(p)
    // 固定窗:探针 — the first click's 500ms opener must remain cancelled.
    await sleep(550)
    check(`${cols}: double click selects without opening`, hasSelection(ink.selection) && opened.length === n)

    // Reset selection through a fresh non-link click before testing Ctrl+click.
    // 固定窗:墙钟 — let the previous multi-click chain expire.
    await sleep(550)
    t = toggles.length; n = opened.length
    click(locate('FOLD_LINK'), 16)
    check(`${cols}: Ctrl+click keeps DOM ownership`, await settled(() => toggles.length === t + 1))
    // 固定窗:探针 — a consumed modified click must not schedule a browser open.
    await sleep(550)
    check(`${cols}: consumed modified click opens nothing`, opened.length === n)

    process.env.TERM_PROGRAM = 'vscode'
    // 固定窗:墙钟 — isolate native xterm.js ownership from the prior gesture.
    await sleep(550)
    n = opened.length; t = toggles.length
    click(locate('FOLD_LINK'))
    check(`${cols}: xterm.js retains the existing DOM path`, await settled(() => toggles.length === t + 1))
    // 固定窗:探针 — xterm.js owns link opening; the app must not open it twice.
    await sleep(550)
    check(`${cols}: xterm.js does not open through the app`, opened.length === n)
  } finally {
    process.env.TERM_PROGRAM = 'kitty'
    await instance.unmount()
    await exited
    term.dispose()
    stdin.destroy(); stdout.destroy(); stderr.destroy()
  }
}
console.log(`verify-hyperlink-click-priority: ${checks} checks, ${failures} failed`)
if (failures) process.exitCode = 1
