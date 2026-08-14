/** Replay a `script` pty capture through xterm-headless and dump the screen. */
const [{ Terminal: XTerm }, fs] = await Promise.all([import('@xterm/headless'), import('node:fs')])

const COLS = Number(process.env.COLS ?? 100)
const ROWS = Number(process.env.ROWS ?? 95)
let data = fs.readFileSync(process.argv[2] ?? '/tmp/cap-tui.bin', 'utf8')
// strip script(1) header/footer (everything up to the first ESC byte is header)
const firstEsc = data.indexOf('\x1b')
if (firstEsc > 0) data = data.slice(firstEsc)
const lastEsc = data.indexOf('\x1b[?1049l')
// keep everything; the exit sequences at the end restore main screen.
// For inspection we want the frame JUST BEFORE exit: find last alt-screen content.
// Simplest: cut off the trailer starting at the final EXIT_ALT_SCREEN.
if (lastEsc !== -1) data = data.slice(0, lastEsc)

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
term.write(data)
await new Promise(r => setTimeout(r, 1500))
const buf = term.buffer.active
for (let y = 0; y < ROWS; y++) {
  const line = buf.getLine(y)?.translateToString(true) ?? ''
  console.log(`${String(y).padStart(3)}|${line}`)
}
