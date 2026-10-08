/**
 * Regression (#1371): the `/plan` argument the TUI's own catalog produces must
 * leave the screen in the grammar upstream accepts.
 *
 * `/plan on` — typed, or accepted from the `/plan` completion popup (the `on`
 * child `src/dsh-adapter/channel/command-completions.ts` builds) — is the
 * catalog's name for the on state. dsh-plan-mode reads a bare `/plan` as
 * "enter plan mode", the exact argument `off` as "leave it", and every other
 * non-empty argument as "enter AND steer that text into the next step": a
 * verbatim `on` therefore enters plan mode and lands the word "on" in the
 * conversation as a user message.
 *
 * Asserts through the REAL Chat screen and its single `runCommand` dispatcher
 * (the path PromptInput's Enter and the completion menu both take):
 *   1. `/plan on` dispatches the BARE registry line (empty argument);
 *   2. `/plan off` and `/plan <message>` still pass through verbatim;
 *   3. bare `/plan` opens the on/off picker instead of dispatching anything.
 *
 * Run: node --import tsx/esm scripts/verify-plan-argument-normalization.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  ui,
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { createChannel },
  { setLang, t },
  { default: instances },
  { settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])
import type { AgentInput, AgentSession } from '../src/agent/session.js'

setLang('en')
let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
  } else {
    failures.push(name)
    console.error(`FAIL ${name}${detail === '' ? '' : `\n${detail}`}`)
  }
}

interface Harness {
  /** Every `runExternalCommandOutcome(name, rawInput)` the screen made, as
   *  `name|rawInput` — the registry line is `/${name}${rawInput}`. */
  readonly dispatched: string[]
  readonly submits: AgentInput[]
  screen(): string
  typeLine(text: string): Promise<void>
  enter(): Promise<void>
  unmount(): Promise<void>
}

/**
 * A DSH-style composition: the session also lists `plan` (so the typed line is
 * a command and the `/plan` completion menu is live, exactly as on a session
 * whose backend serves it), while the registry owns the row — the route the
 * screen reads to decide between the picker and the registry.
 */
async function mountChat(): Promise<Harness> {
  const dispatched: string[] = []
  const submits: AgentInput[] = []
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId: '77777777-7777-4777-8777-777777777777' },
    cwd: process.cwd(),
    status: 'idle',
    // `plan` in the session's own catalog is what makes PromptInput treat the
    // typed line as a command instead of plain text for the model.
    capabilities: { native: {}, commands: { list: () => Promise.resolve([{ name: 'plan', description: 'Toggle plan mode' }]) } },
    history: () => Promise.resolve([]),
    subscribe: () => () => undefined,
    submit(input) {
      submits.push(input)
      return Promise.resolve({ accepted: true })
    },
    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose: () => Promise.resolve(),
  }
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
  // Stand in for the DSH registry: the route (registry, never 'none') is the
  // fact the screen dispatches on, and the recorded line is what this
  // regression is about — the real `dsh-plan-mode` grammar is asserted
  // upstream, not here.
  const wrapped = new Proxy(channel, {
    get(target, key, receiver) {
      if (key === 'capabilities') return () => ({ ...target.capabilities(), plan: { route: 'registry' } })
      if (key === 'runExternalCommandOutcome') {
        return (name: string, rawInput: string) => {
          dispatched.push(`${name}|${rawInput}`)
          return Promise.resolve({ kind: 'success', text: '', consumeDraft: true })
        }
      }
      return Reflect.get(target, key, receiver)
    },
  })
  const COLS = 100
  const ROWS = 34
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const instance = await ui.render(
    React.createElement(Chat, { channel: wrapped as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  // 固定窗:pacing the key handlers attach after the first frame.
  await sleep(300)
  return {
    dispatched,
    submits,
    screen,
    typeLine: async text => {
      for (const char of text) stdin.write(char)
      // 固定窗:pacing the prompt applies typed characters on its own render tick.
      await sleep(80)
    },
    enter: async () => {
      stdin.write('\r')
      // 固定窗:pacing Enter dispatches on the next render tick.
      await sleep(120)
    },
    unmount: async () => { instance.unmount(); await sleep(50) }, // 固定窗:pacing unmount settles before the next harness mounts
  }
}

const h = await mountChat()
try {
  // 1. The catalog's on token is normalized back to the bare switch.
  await h.typeLine('/plan on')
  await h.enter()
  check('`/plan on` dispatches the bare registry line', await settled(() => h.dispatched.includes('plan|')), h.dispatched.join(','))
  check('`/plan on` never reaches the model', h.submits.length === 0, JSON.stringify(h.submits))

  // 2. Every other argument keeps its verbatim grammar.
  await h.typeLine('/plan off')
  await h.enter()
  check('`/plan off` passes through verbatim', await settled(() => h.dispatched.includes('plan| off')), h.dispatched.join(','))
  await h.typeLine('/plan outline the task')
  await h.enter()
  check('`/plan <message>` passes through verbatim', await settled(() => h.dispatched.includes('plan| outline the task')), h.dispatched.join(','))
  check('no argument was submitted to the model', h.submits.length === 0, JSON.stringify(h.submits))

  // 3. The bare command still opens the on/off picker rather than dispatching.
  await h.typeLine('/plan')
  await h.enter()
  check('bare /plan opens the on/off picker', await settled(() => h.screen().includes(t('plan-picker-title'))), h.screen())
  check('bare /plan dispatches nothing', h.dispatched.length === 3, h.dispatched.join(','))
} finally {
  await h.unmount()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nverify-plan-argument-normalization OK (${passed} passed)`)
