/**
 * Regression for long option questionnaires: the absolute keyboard focus
 * must remain visible when the option list is taller than the terminal.
 *
 * Run with `node --import tsx/esm scripts/repro-askpanel-windowing.tsx`.
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AskUserQuestionPanel }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
])

const COLS = 100
const ROWS = 18
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function screen(): string {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '').join('\n')
}

function focused(label: string): boolean {
  return screen().split('\n').some(line => line.includes('❯') && line.includes(label))
}

const options = Array.from({ length: 30 }, (_, index) => ({
  label: `provider-${String(index).padStart(2, '0')}`,
  description: `description-${String(index).padStart(2, '0')}`,
}))

const app = await render(
  React.createElement(AskUserQuestionPanel, {
    question: {
      header: 'provider',
      question: 'Choose a provider',
      options,
      hideCustomInput: true,
    },
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: () => {},
    onCancel: () => {},
  }),
  { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false },
)

await sleep(300)
let failures = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

check('initial focus is visible', focused('provider-00'))

for (let index = 0; index < 15; index++) {
  stdin.write('\u001b[B')
  await sleep(20)
}
await sleep(300)
check('deep focus remains visible after navigation', focused('provider-15'))

app.unmount()
await sleep(100)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
