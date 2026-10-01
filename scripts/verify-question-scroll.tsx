/**
 * Questionnaire viewport regression: the custom answer must be visible before
 * any click, and long details/options must be reachable by wheel and paging.
 * Uses the real Chat, question store, renderer and terminal input pipeline;
 * also verifies returning to the composer and renderer cleanup after answering.
 * DSH_TUI_VERIFY_PACKAGE_ROOT optionally checks an installed package's output.
 * Run: pnpm verify:question-scroll
 */
import './lib/fake-home.mjs'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const { createRequire } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const installedRoot = process.env.DSH_TUI_VERIFY_PACKAGE_ROOT
const moduleRoot = installedRoot === undefined
  ? new URL('../src/', import.meta.url)
  : pathToFileURL(`${installedRoot}/lib/types/`)
const reactPath = createRequire(new URL('ui.js', moduleRoot)).resolve('react')
const [React, { PassThrough, Writable }, { Terminal },
  { render, AlternateScreen, useTerminalSize }, { AskUserQuestionPanel }, { Chat },
  { QuestionStore }, { settled, viewportLines, findText },
] = await Promise.all([
  import(pathToFileURL(reactPath).href), import('node:stream'), import('@xterm/headless'),
  import(new URL('ui.js', moduleRoot).href),
  import(new URL('components/questions/AskUserQuestionPanel.js', moduleRoot).href),
  import(new URL('screens/Chat.js', moduleRoot).href),
  import(new URL('dsh-adapter/questions.js', moduleRoot).href),
  import('./lib/term-test.mjs'),
])

const HEAD = 'QUESTIONDETAILHEAD'
const TAIL = 'QUESTIONDETAILTAIL'
const LAST = 'OPTION-35'
const LAST_DETAIL = 'OPTIONDETAILTAIL'
const custom = `${'中文👩‍💻é反馈 '.repeat(30)}CUSTOMTAIL`
const question = {
  id: 'question-scroll', header: '选择后也可以输入自己的意见',
  question: '请阅读说明并选择方案，或者直接输入自定义回答。',
  detail: Array.from({ length: 30 }, (_, index) =>
    `${index === 0 ? HEAD : index === 29 ? TAIL : `Detail ${index}`} 需要完整阅读的说明。`,
  ).join('\n'),
  options: Array.from({ length: 36 }, (_, index) => ({
    label: `OPTION-${String(index).padStart(2, '0')}`,
    description: '方案描述需要正确处理中文宽度与窄窗口中的自动换行。'
      + (index === 35 ? ` ${LAST_DETAIL}` : ''),
  })),
}

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
let failures = 0
function check(name: string, ok: boolean, screen = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) { failures += 1; console.error(screen) }
}

async function scenario(fullscreen: boolean, cols: number, rows: number, inChat: boolean, dense = true) {
  const name = `${inChat ? 'chat' : 'direct'} ${fullscreen ? 'fullscreen' : 'inline'} ${cols}x${rows}${dense ? '' : ' without todos'}`
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  let parsedWrites = 0
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      term.write(String(chunk), () => { parsedWrites += 1; callback() })
    },
  }), { columns: cols, rows, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, callback) { callback() } }), { isTTY: true })
  const stdin = new Input()
  let observedSize = { columns: 0, rows: 0, parsedWrites: 0 }
  function SizeObserver({ children }: { children: import('react').ReactNode }) {
    const size = useTerminalSize()
    React.useLayoutEffect(() => {
      observedSize = { ...size, parsedWrites }
    }, [size.columns, size.rows])
    return children
  }
  const store = new QuestionStore()
  let answer: { selected: string[]; custom?: string } | undefined
  const channel = {
    version: 0, rows: Array.from({ length: 40 }, (_, id) => ({
      id, kind: 'assistant', text: `Transcript ${id}`, time: 0,
    })),
    status: 'running', sessionTitle: 'probe', agentId: 'probe', model: 'deepseek-v4-flash',
    tokens: { input: 120, output: 45 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
    working: true, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {},
    turnStart: Date.now(), lastUserText: '', pending: [], commandList: [], notifications: [],
    activityEnabled: false, contextBarEnabled: false, activityFrames: [],
    todos: dense ? Array.from({ length: 8 }, (_, index) => ({ content: `Todo ${index}`, status: 'pending' })) : [],
    subscribe: () => () => {}, submit() {}, cancel() {}, clear() {}, notify() {}, pushLocal() {},
    listModels: async () => [], commandCompletions: () => [], listSessions: () => [], setResumeTarget() {},
  }
  const panel = inChat
    ? React.createElement(Chat, { channel, questionStore: store, fullscreen, onExit() {} })
    : React.createElement(AskUserQuestionPanel, {
      question, position: 1, total: 1, answered: 0, fullscreen,
      onAnswer(value: typeof answer) { answer = value }, onCancel() {},
    })
  const app = await render(React.createElement(SizeObserver, { children: fullscreen
    ? React.createElement(AlternateScreen, { children: panel }) : panel }),
  { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false })
  let renderError: unknown
  const exitResult = app.waitUntilExit().catch((error: unknown) => { renderError = error })
  let pending: Promise<unknown> | undefined
  if (inChat) {
    pending = store.ask({ questions: [question] })
    void pending!.then((value: { answers: (typeof answer)[] }) => { answer = value.answers[0] })
  }
  const screen = () => viewportLines(term).join('\n')
  const customVisible = () => screen().includes('自定义回答')
  check(`${name}: custom input is visible before clicking`, await settled(customVisible), screen())
  check(`${name}: first detail is visible`, screen().includes(HEAD), screen())
  if (fullscreen) {
    const hit = findText(term, HEAD) ?? { col: 10, row: 3 }
    for (let tick = 0; tick < 400; tick += 1) stdin.write(`\x1b[<65;${hit.col + 1};${hit.row + 1}M`)
  } else {
    for (let page = 0; page < 400; page += 1) stdin.write('\x1b[6~')
  }
  check(`${name}: last option is reachable without clicking`, await settled(() => screen().includes(LAST) && screen().includes(LAST_DETAIL)), screen())
  check(`${name}: input remains visible at the bottom`, customVisible(), screen())
  for (let page = 0; page < 400; page += 1) stdin.write('\x1b[5~')
  check(`${name}: PageUp reaches the first detail`, await settled(() => screen().includes(HEAD)), screen())
  for (let page = 0; page < 400; page += 1) stdin.write('\x1b[6~')
  check(`${name}: PageDown reaches the last option`, await settled(() => screen().includes(LAST) && screen().includes(LAST_DETAIL)), screen())
  stdin.write('\t')
  stdin.write(`\x1b[200~${custom}\x1b[201~`)
  check(`${name}: pasted answer tail and input remain visible`,
    await settled(() => screen().includes('CUSTOMTAIL') && customVisible()), screen())
  if (cols === 80) {
    term.resize(40, 14)
    stdout.columns = 40
    stdout.rows = 14
    stdout.emit('resize')
    check(`${name}: resize commits`, await settled(() => observedSize.columns === 40
      && observedSize.rows === 14 && parsedWrites > observedSize.parsedWrites))
    check(`${name}: resizing preserves the input and caret tail`,
      await settled(() => customVisible() && screen().includes('CUSTOMTAIL')), screen())
  }
  stdin.write('\r')
  check(`${name}: keyboard submits the complete custom answer`, await settled(() =>
    answer?.custom === custom && answer.selected.length === 0), JSON.stringify(answer))
  if (answer !== undefined && pending !== undefined) await pending
  if (inChat) {
    // On a short fullscreen terminal the restored, expanded task list can
    // occupy the viewport. Use its real shortcut before checking the composer.
    if (fullscreen && dense) {
      await settled(() => !customVisible() && screen().includes('Todo 0'))
      stdin.write('\x11')
    }
    check(`${name}: answering returns to the composer`,
      await settled(() => !customVisible() && screen().includes('╭')), screen())
  }
  await app.unmount()
  await exitResult
  check(`${name}: renderer exits cleanly`, renderError === undefined, String(renderError))
  term.dispose()
}

for (const fullscreen of [true, false]) {
  for (const inChat of [false, true]) {
    await scenario(fullscreen, 80, 24, inChat)
    await scenario(fullscreen, 40, 14, inChat)
  }
  await scenario(fullscreen, 80, 24, true, false)
}
console.log(failures === 0 ? 'Question scrolling verified' : `${failures} question scroll checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
