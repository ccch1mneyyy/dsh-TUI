/**
 * Headless verification of the IME-safe placeholder layout.
 * Renders the compiled SearchBox and PromptInput with an EMPTY value and
 * checks that:
 *  1. the placeholder text is no longer rendered at the caret (no ghost "H");
 *  2. the placeholder still appears (right-aligned, dim) on the same row;
 *  3. the caret cell is a blank inverse block (IME preedit paints there).
 * Run: node scripts/verify-placeholder.mjs
 */
process.env.FORCE_COLOR = '3'

const { Writable, PassThrough } = await import('node:stream')
const React = await import('react')
const { render } = await import('../lib/types/ui.js')
const { SearchBox } = await import('../lib/types/components/SearchBox.js')
const { PromptInput } = await import('../lib/types/components/PromptInput.js')

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 28
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

// Cursor-right moves (CSI nC) stand in for literal spaces in the
// differential renderer; normalize them BEFORE stripping ANSI so alignment
// checks see real columns. Same as scripts/smoke.tsx. Note the `>` in the
// CSI parameter class: the cursor-declaration probe replies (e.g. \x1b[>0q)
// use private parameters.
const toPlain = s =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    // OSC（\x1b]…BEL / …ST）整类清除：进度报告（OSC 9;4）、超链接
    // （OSC 8——每帧帧头的防御性 link('') 关闭序列会出现在所有帧里）。
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')

const EXAMPLE_RE =
  /Summarize the changes|Explain the code|Find and fix|Write tests|Review my recent|What does this function|Refactor this|Update the documentation|Help me debug|Add a feature/

const sleep = ms => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failed = 1
}

// ---- SearchBox -----------------------------------------------------------
{
  const { stdout, stderr, stdin } = makeStreams()
  const instance = await render(
    React.createElement(SearchBox, {
      query: '',
      placeholder: 'Type to search…',
      isFocused: true,
      isTerminalFocused: true,
      prefix: '⌕',
      width: '100%',
    }),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  const frame = toPlain(stdout.frames.join(''))
  console.log('--- SearchBox plain frame ---')
  console.log(JSON.stringify(frame))
  check('placeholder present', frame.includes('Type to search…'))
  check('no ghost caret char glued to prefix', !/⌕ T/.test(frame))
  check(
    'placeholder right-aligned (wide gap before it)',
    /\s{20,}Type to search…/.test(frame),
  )
  instance.unmount()
}

// ---- PromptInput (empty) -------------------------------------------------
{
  const { stdout, stderr, stdin } = makeStreams()
  const channel = {
    working: false,
    commandList: [],
    notifications: [],
    pending: [],
    notify() {},
    submit() {},
    listFiles: async () => [],
  }
  const instance = await render(
    React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand: () => false,
      selectionActive: false,
    }),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  const frame = toPlain(stdout.frames.join(''))
  console.log('--- PromptInput plain frame ---')
  console.log(JSON.stringify(frame))
  // The empty input shows NO placeholder text at all: only `❯ ` + the block
  // caret on a blank cell (the terminal-painted IME preedit lands there).
  check('no example placeholder anywhere', !EXAMPLE_RE.test(frame))
  check('no ghost "H" glued to prompt', !/❯ H/.test(frame))
  const line = frame.split('\n').find(l => l.includes('❯'))
  if (line) {
    check(
      'input row has no text after the prompt',
      /^❯\s+$/.test(line) || line.replace(/❯\s*/, '').trim() === '',
    )
  }
  instance.unmount()

  // Typing a character renders the text at the caret — verify via real
  // keystrokes through stdin.
  const { stdout: stdout2, stderr: stderr2, stdin: stdin2 } = makeStreams()
  const channel2 = {
    working: false,
    commandList: [],
    notifications: [],
    pending: [],
    notify() {},
    submit() {},
    listFiles: async () => [],
  }
  const instance2 = await render(
    React.createElement(PromptInput, {
      channel: channel2,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand: () => false,
      selectionActive: false,
    }),
    { stdout: stdout2, stderr: stderr2, stdin: stdin2, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  stdin2.write('hi')
  await sleep(300)
  const typed = toPlain(stdout2.frames.join(''))
  const lastFrame = toPlain(stdout2.frames.at(-1) ?? '')
  const typedLine =
    typed
      .split('\n')
      .filter(l => l.includes('❯') || /^\s+hi/.test(l))
      .at(-1) ?? ''
  console.log('--- PromptInput after typing "hi" ---')
  console.log(JSON.stringify(typedLine))
  check('no placeholder after typing', !EXAMPLE_RE.test(lastFrame))
  check('typed text rendered at caret', /hi\s*$/.test(typedLine))
  instance2.unmount()
}

process.exit(failed)
