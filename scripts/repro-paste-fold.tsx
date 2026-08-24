/**
 * Paste fold scenario (real input path via stdin, real mouse path via SGR):
 * 1. bracketed paste of 12 lines folds into an ATOMIC block chip (stats +
 *    first-line preview, no black box) — text before/after it stays visible
 * 2. hovering over the chip pops a bordered peek CARD (input stays one
 *    row); clicking a card row expands the block for editing
 * 3. `▾` prefix folds the whole input; chip click expands again
 * 4. typing NEVER expands the block (CC behavior) — the caret edits the
 *    text around it; Esc expands; Enter submits head+block+tail
 * 5. text typed BEFORE the block stays visible and is submitted with it
 * 6. Backspace at the block's tail deletes the WHOLE block in one key
 *
 * Platform-independent: bracketed paste + SGR mouse need no clipboard stub.
 */
process.env.FORCE_COLOR = '3'
// This script asserts English UI copy; pin the language before any module
// import resolves the startup lang.
process.env.DSH_TUI_LANG = 'en'
// Redirect ~/.dsh-tui (history.jsonl / resume.txt / theme.json) into a temp
// dir BEFORE any module import resolves utils/paths.js — os.homedir() reads
// these env vars, so the submits below never touch the real history.
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])
const dataDir = mkdtempSync(join(tmpdir(), 'repro-paste-fold-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function screenHas(s: string): boolean {
  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    if ((buf.getLine(y)?.translateToString(true) ?? '').includes(s)) return true
  }
  return false
}
/** 0-indexed position of the first occurrence of `s` on the screen. */
function findText(s: string): { col: number; row: number } | null {
  const buf = term.buffer.active
  for (let row = 0; row < ROWS; row++) {
    const line = buf.getLine(row)?.translateToString(true) ?? ''
    const col = line.indexOf(s)
    if (col >= 0) return { col, row }
  }
  return null
}

const listeners = new Set<() => void>()
let submitted = ''
const channel: any = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  mode: { plan: false },
  reasoningEffort: 'max',
  tokens: { input: 1, output: 1 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  lastUserText: '',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit(text: string) { submitted = text; bump0() },
  cancel: () => {}, clear: () => {},
  notify(msg: string) { channel.notifications.push(msg); bump0() },
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump0 = () => { channel.version++; for (const cb of listeners) cb() }

const stdinObj = new FakeStdin()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
  </AlternateScreen>,
  { stdout: new FakeStdout(), stdin: stdinObj, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

// 12 pasted lines; FOURTH_MARKER sits inside the 10-row peek card,
// EIGHTH_MARKER (line 11) only past it — and only visible once the input
// itself is expanded (tail/caret window).
const foldLines = Array.from({ length: 12 }, (_, i) => `fold-line-${i}`)
foldLines[4] += ' FOURTH_MARKER'
foldLines[10] += ' EIGHTH_MARKER'
const pasted = foldLines.join('\n')

/** SGR mode-1003 motion with no buttons → dispatchHover. Coords 1-indexed. */
const hover = (col: number, row: number) => stdinObj.write(`\x1b[<35;${col};${row}M`)
/** SGR left-button press + release at a cell → dispatchClick. 1-indexed. */
const click = (col: number, row: number) => {
  stdinObj.write(`\x1b[<0;${col};${row}M`)
  stdinObj.write(`\x1b[<0;${col};${row}m`)
}

try {
  // 1. A big bracketed paste folds into an atomic block chip.
  stdinObj.write(`\x1b[200~${pasted}\x1b[201~`)
  await sleep(500)
  check('big paste folds into block chip', screenHas('▸ 12 lines'), screenHas('▸ 12 lines') ? '' : 'no chip stats on screen')
  check('chip shows the first-line preview', screenHas('fold-line-0'))
  check('block text hides the later lines', !screenHas('FOURTH_MARKER'))

  // 2. Hover pops the bordered peek CARD over the chip — the input box
  //    stays one row; the card shows the block head and caps the tail.
  //    Clicking a card row expands the block into the editable input.
  let pos = findText('fold-line-0')
  if (pos) hover(pos.col + 1, pos.row + 1)
  await sleep(400)
  check('hover pops the peek card with block head',
    screenHas('FOURTH_MARKER') && screenHas('▸ 12 lines'))
  check('peek card caps the tail rows', !screenHas('EIGHTH_MARKER'))
  const cardPos = findText('FOURTH_MARKER')
  if (cardPos) click(cardPos.col + 1, cardPos.row + 1)
  await sleep(400)
  check('card click expands the block for editing', screenHas('EIGHTH_MARKER'))
  hover(1, 1)
  await sleep(400)
  check('expansion stays after the mouse leaves', screenHas('EIGHTH_MARKER'))

  // 3. Fold the whole input again via the ▾ prefix (Up arrow ×11 walks the
  //    caret to line 0, the window returns to the head and row 0 shows the
  //    prefix); then the chip click expands the block again.
  stdinObj.write('\x1b[A'.repeat(11))
  await sleep(300)
  let prefix = findText('▾ 12 lines')
  check('expanded input shows the ▾ fold prefix', prefix !== null)
  if (prefix) {
    click(prefix.col + 1, prefix.row + 1)
    await sleep(400)
    check('▾ prefix folds the input into a block', !screenHas('FOURTH_MARKER') && screenHas('▸ 12 lines'))
  }
  pos = findText('fold-line-0')
  if (pos) click(pos.col + 1, pos.row + 1)
  await sleep(400)
  // The caret was dragged to the block's end when folding, so the expanded
  // input shows the TAIL window (EIGHTH_MARKER) — and no chip.
  check('chip click expands the block', screenHas('EIGHTH_MARKER') && !screenHas('▸ 12 lines'))
  hover(1, 1)
  await sleep(300)
  check('chip-expanded stays after the mouse leaves', screenHas('EIGHTH_MARKER'))
  // Fold back for the typing test below (Up ×11 walks the caret to line 0
  // where the ▾ prefix is visible again).
  stdinObj.write('\x1b[A'.repeat(11))
  await sleep(300)
  prefix = findText('▾ 12 lines')
  if (prefix) {
    click(prefix.col + 1, prefix.row + 1)
    await sleep(400)
    check('▾ prefix folds again', screenHas('▸ 12 lines'))
  }

  // 4. Typing NEVER expands the block (CC behavior): the char lands after
  //    the chip and the block stays folded; Backspace removes it ('tail' /
  //    'zzctrl' are markers unique to typed text — 'x'/'ab' would
  //    false-positive on the splash logo / leftover text); Esc expands;
  //    Enter submits. Batch Backspace (several keys in one stdin read)
  //    must delete one char per key even with a block present.
  stdinObj.write('zzctrl')
  await sleep(300)
  stdinObj.write('\x7f'.repeat(3))
  await sleep(300)
  check('control: batch Backspace deletes 3 chars, block stays',
    screenHas('zzc') && !screenHas('zzctrl') && screenHas('▸ 12 lines'))
  stdinObj.write('\x7f'.repeat(3))
  await sleep(300)
  stdinObj.write('tail')
  await sleep(400)
  check('typing keeps the block folded', screenHas('▸ 12 lines') && screenHas('tail'))
  stdinObj.write('\x7f'.repeat(4))
  await sleep(300)
  check('Backspace removes the typed char, block stays folded',
    screenHas('▸ 12 lines') && !screenHas('tail'))
  stdinObj.write('\x1b')
  await sleep(400)
  check('Esc expands the block (does not clear)', screenHas('EIGHTH_MARKER') && !screenHas('▸ 12 lines'))
  // Esc on the EXPANDED big input folds it back into a block — the toggle
  // is lossless; clearing a big draft goes through Backspace/Ctrl+C.
  stdinObj.write('\x1b')
  await sleep(400)
  check('Esc on expanded big input folds it back', screenHas('▸ 12 lines'))
  stdinObj.write('\x1b')
  await sleep(400)
  check('Esc on the block expands again', !screenHas('▸ 12 lines') && screenHas('EIGHTH_MARKER'))
  stdinObj.write('\r')
  await sleep(400)
  check('Enter submits the full text', submitted === pasted, `got ${submitted.length} chars`)

  // 5. Text typed BEFORE the block stays visible and is submitted with it.
  submitted = ''
  stdinObj.write('pre:')
  await sleep(300)
  stdinObj.write(`\x1b[200~${pasted}\x1b[201~`)
  await sleep(500)
  check('paste after text folds; head text stays visible',
    screenHas('▸ 12 lines') && screenHas('pre:'))
  stdinObj.write('\r')
  await sleep(400)
  check('submit includes the head text', submitted === 'pre:' + pasted)

  // 6. Backspace at the block's tail deletes the WHOLE block in one key;
  //    Enter on the now-empty prompt submits nothing.
  submitted = 'sentinel'
  stdinObj.write(`\x1b[200~${pasted}\x1b[201~`)
  await sleep(500)
  check('paste folds again', screenHas('▸ 12 lines'))
  stdinObj.write('\x7f')
  await sleep(400)
  check('Backspace deletes the whole block',
    !screenHas('▸ 12 lines') && !screenHas('fold-line-0'))
  stdinObj.write('\r')
  await sleep(400)
  check('Enter after block delete submits nothing', submitted === 'sentinel')

  // 7. Small (non-foldable) inputs keep the classic Esc = clear behavior.
  stdinObj.write('tiny')
  await sleep(300)
  stdinObj.write('\x1b')
  await sleep(300)
  check('Esc clears a small (non-foldable) input', !screenHas('tiny'))
} finally {
  await instance.unmount()
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(failed)
