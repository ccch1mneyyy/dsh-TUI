/**
 * Pet-notice routing: while the companion panel is the ACTIVE panel, a new
 * notice is "said" by the pet's speech bubble and the composer's toast does
 * NOT repeat it; on any other panel the toast shows as always, and an error
 * notice toasts even on the pet panel (it may need action).
 *
 * Locked behavior:
 *  a. pet panel active + plain notice → the text never appears in the CHAT
 *     column (the bubble owns it on the right);
 *  b. another panel active + plain notice → the toast shows in the chat
 *     column, above the prompt;
 *  c. pet panel active + error notice → the toast still shows in the chat
 *     column.
 *
 * Run: node --import tsx/esm scripts/verify-companion-toast-routing.tsx
 */
export {}

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Box, Text, useInput }, { Chat }, { QuestionStore }, prefs, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
])
const { applySidePanelOpen, applySidePanelPanels, applySidePanelRatio } = prefs
const { settled } = termTest

const COLS = 120
const ROWS = 34

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const listeners = new Set<() => void>()
const channel: any = {
  whaleIdle: false,
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'notice-routing',
  sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab',
  agentId: 'notice-agent',
  model: 'deepseek-chat-v4',
  reasoningEffort: 'high',
  mode: { plan: false },
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextSegments: { system: 900, prompt: 1200, assistant: 3000, thinking: 400, tools: 800 },
  contextWindow: 128_000,
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
  goal: undefined,
  todos: [],
  subagents: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, steer: () => {},
  interruptAndDeliver: () => 0, removePending: () => true,
  cycleMode: () => Promise.resolve(), listFiles: () => Promise.resolve([]),
  notify() {}, listModels: () => Promise.resolve([]), listSessions: () => [],
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
  listWorkspaceRegistry: () => Promise.resolve([]),
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: Buffer.Encoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean) { this.isRaw = next; return this }
  setEncoding() { return this }
  ref() { return this }
  unref() { return this }
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdin = new FakeStdin()

// The chat column ends around 68% of the width; the divider sits just past it.
const CHAT_COLUMN_END = Math.floor(COLS * 0.68) - 2
const panelBar = (): string => termTest.viewportLines(term, ROWS)[0] ?? ''
const occurrencesInChatColumn = (s: string): number => {
  const view = termTest.viewportLines(term, ROWS)
  let count = 0
  for (const line of view) {
    const cells = termTest.lineCells ? termTest.lineCells(line) : null
    if (cells !== null) { if (cells.slice(0, CHAT_COLUMN_END).includes(s)) count += 1; continue }
    let at = line.indexOf(s)
    while (at >= 0) { if (at < CHAT_COLUMN_END) count += 1; at = line.indexOf(s, at + 1) }
  }
  return count
}

applySidePanelRatio(0.68)
applySidePanelPanels('todo,companion')
applySidePanelOpen(true)

const app = await render(
  <AlternateScreen>
    <Chat fullscreen channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
  </AlternateScreen>,
  {
    stdout: new FakeStdout(term) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

const push = (item: { id: number; text: string; color?: string }): void => {
  channel.notifications.push({ timeoutMs: 60_000, ...item })
  bump()
}

try {
  check('boot: split is up', await settled(() => termTest.viewportLines(term, ROWS).some(l => l.includes('Ctrl+B focus panel') || l.includes('z zoom')), { timeoutMs: 5000 }))
  stdin.write('\x02') // Ctrl+B: open(已开) + focus chat → focus panel
  check('focus: keyboard is in the panel', await settled(() => termTest.viewportLines(term, ROWS).some(l => l.includes('Esc chat')), { timeoutMs: 5000 }))
  stdin.write('2') // jump to the 2nd enabled panel = companion
  check('active: companion carousel title with the todo icon', await settled(() => panelBar().includes('Companion') && panelBar().includes('◀') && panelBar().includes('▶') && panelBar().includes('≡'), { timeoutMs: 5000 }), panelBar().trim())

  // a. plain notice on the pet panel → bubble owns it; the chat column stays clean
  push({ id: 1, text: 'NOTICE-A-PET-SAYS' })
  await settled(() => termTest.viewportLines(term, ROWS).some(l => l.includes('NOTICE-A-PET-SAYS')), { timeoutMs: 5000 })
  check('a: pet panel active → plain notice NOT in the chat column', occurrencesInChatColumn('NOTICE-A-PET-SAYS') === 0, 'chat occurrences=' + occurrencesInChatColumn('NOTICE-A-PET-SAYS'))

  // b. switch to another panel → toast shows in the chat column
  stdin.write('[') // previous panel
  check('switch: todo carousel title again', await settled(() => panelBar().includes('Todo') && !panelBar().includes('Companion'), { timeoutMs: 5000 }), panelBar().trim())
  push({ id: 2, text: 'NOTICE-B-TOAST' })
  check('b: other panel active → toast shows in the chat column', await settled(() => occurrencesInChatColumn('NOTICE-B-TOAST') > 0, { timeoutMs: 5000 }))

  // c. error notice toasts even on the pet panel
  stdin.write('2')
  check('back: companion carousel title', await settled(() => panelBar().includes('Companion') && !panelBar().includes('Todo'), { timeoutMs: 5000 }), panelBar().trim())
  push({ id: 3, text: 'NOTICE-C-ERROR', color: 'error' })
  check('c: error notice still toasts on the pet panel', await settled(() => occurrencesInChatColumn('NOTICE-C-ERROR') > 0, { timeoutMs: 5000 }))
} finally {
  await app.unmount()
}

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
