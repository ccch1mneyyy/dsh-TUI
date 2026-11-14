/** JediTerm appended repaints own the frame, not the shell rows above it. */
import './lib/fake-home.mjs'

process.env.DSH_TUI_LANG = 'en'
process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm'
delete process.env.TERM_PROGRAM
for (const key of ['DSH_TUI_RENDER_LOG', 'DSH_TUI_DEBUG_MOUSE']) delete process.env[key]

const [React, { PassThrough, Writable }, { Terminal }, ui, { default: instances }, { settled, writeParsed }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/ink/instances.js'), import('./lib/term-test.mjs'),
])
let checks = 0, failed = 0
function check(label: string, ok: boolean): void {
  checks++; if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}
for (const [cols, rows, tall] of [[80, 24, false], [36, 12, false], [80, 24, true], [36, 12, true]] as const) {
  const name = `${cols}x${rows}/${tall ? 'tall' : 'short'}`
  const term = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true })
  await writeParsed(term, 'SHELL-HISTORY-ANCHOR\r\nprompt$ dsh\r\n')
  class Input extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(value: boolean): this { this.isRaw = value; return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdin = new Input(), chunks: string[] = [], inputs: string[] = []
  const replies: ReturnType<typeof setTimeout>[] = []
  class Output extends Writable {
    isTTY = true
    columns = cols
    rows = rows
    _write(value: unknown, _encoding: BufferEncoding, done: () => void): void {
      const text = String(value); chunks.push(text)
      if (text.includes('\x1b[c')) replies.push(setTimeout(() => stdin.write('\x1b[?1;2c'), 0))
      term.write(text, done)
    }
  }
  const stdout = new Output()
  const stderr = new Writable({ write(_value, _encoding, done) { done() } })
  const allLines = (): string[] => Array.from({ length: term.buffer.active.length }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  const viewport = (): string[] => allLines().slice(term.buffer.active.baseY, term.buffer.active.baseY + rows)
  const has = (value: string): boolean => allLines().some(line => line.includes(value))
  const historyOnce = (): boolean => allLines().filter(line => line.includes('SHELL-HISTORY-ANCHOR')).length === 1
  function Scene(): React.ReactNode {
    const [phase, setPhase] = React.useState(0)
    ui.useInput(input => { inputs.push(input); if (input === 'n') setPhase(value => value + 1) })
    const label = `ANCHOR_${['A', 'B', 'C', 'D'][phase] ?? 'INVALID'}`
    return <ui.Text>{tall ? Array.from({ length: rows + 5 }, (_, y) => `row-${String(y).padStart(2, '0')} ${label}`).join('\n') : label}</ui.Text>
  }
  let instance: Awaited<ReturnType<typeof ui.render>> | undefined
  let exited: Promise<unknown> | undefined
  try {
    instance = await ui.render(<Scene />, { stdin: stdin as never, stdout: stdout as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false })
    exited = instance.waitUntilExit()
    if (!await settled(() => has('ANCHOR_A'))) throw new Error(`${name}: first actual cells missing`)
    check(`${name}: first paint retains shell history exactly once`, historyOnce())
    const before = chunks.length
    stdin.write('n')
    check(`${name}: ordinary input paints next frame`, await settled(() => has('ANCHOR_B')))
    check(`${name}: next paint retains shell history exactly once`, historyOnce())
    const frames = chunks.slice(before).filter(value => value.includes('ANCHOR_B'))
    check(`${name}: actual changed frame stays sync-wrapped`, frames.length > 0 && frames.every(value => value.startsWith('\x1b[?2026h') && value.endsWith('\x1b[?2026l')))
    if (!tall) {
      // Deliberate viewport recovery is a different owner: put the physical
      // cursor on its park row, then request the real absolute re-anchor.
      await writeParsed(term, `\x1b[${rows};1H`)
      const ink = instances.get(stdout as never)
      if (!ink) throw new Error('Mounted renderer not found')
      ink.reanchorViewport(); stdin.write('n')
      check(`${name}: explicit viewport recovery paints`, await settled(() => has('ANCHOR_C')))
      check(`${name}: viewport recovery keeps its bottom anchor`, viewport().findIndex(line => line.includes('ANCHOR_C')) === rows - 2)
      stdin.write('n')
      check(`${name}: next appended repaint keeps recovered geometry`, await settled(() => viewport()[rows - 2]?.includes('ANCHOR_D') === true))
    }
    check(`${name}: each key reaches the real input handler once`, inputs.join('') === (tall ? 'n' : 'nnn'))
    console.log(`SCREEN ${JSON.stringify({ name, viewport: viewport(), scope: 'synthetic JetBrains identity; actual Ink/xterm cells, not a physical IDE' })}`)
  } finally {
    if (instance) { await instance.unmount(); await exited }
    for (const reply of replies) clearTimeout(reply)
    term.dispose(); stdin.destroy(); stdout.destroy(); stderr.destroy()
  }
  check(`${name}: raw mode restored`, stdin.isRaw === false)
}
console.log(`verify-jediterm-frame-anchor: ${checks} checks, ${failed} failed`)
if (failed) process.exitCode = 1
