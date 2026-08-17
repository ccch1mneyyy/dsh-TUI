/**
 * Configurable keybinding regression (issue #113).
 *
 * Drives the real stdin -> Ink -> Chat path so the checks cover parsed
 * terminal input and the user-visible action, not only a matcher helper.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { resolveKeybindings }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/keybindings.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? `\n${detail}` : ''}`)
  if (!ok) failed += 1
}

const invalid = resolveKeybindings({ historySearch: 'shift+r' })
check('unsafe modifier-only chord falls back to the default', invalid.bindings.historySearch === 'mod+r')
check('invalid chord produces a configuration warning', invalid.warnings[0]?.reason === 'invalid')

const conflict = resolveKeybindings({ historySearch: 'alt+x', toggleDetails: 'alt+x' })
check(
  'conflicting custom chords fall back to distinct defaults',
  conflict.bindings.historySearch === 'mod+r' && conflict.bindings.toggleDetails === 'mod+o',
)
check('each conflicting action produces a warning', conflict.warnings.filter(warning => warning.reason === 'conflict').length === 2)

const mixed = resolveKeybindings({ historySearch: 'shift+r', toggleDetails: 'mod+r' })
check(
  'an invalid chord is not warned again as a conflict after fallback',
  mixed.warnings.length === 2
    && mixed.warnings.some(warning => warning.action === 'historySearch' && warning.reason === 'invalid')
    && mixed.warnings.some(warning => warning.action === 'toggleDetails' && warning.reason === 'conflict'),
)

const aliasConflict = resolveKeybindings({ historySearch: 'mod+x', toggleDetails: 'ctrl+x' })
check(
  'mod and ctrl aliases are treated as conflicting chords',
  aliasConflict.bindings.historySearch === 'mod+r'
    && aliasConflict.bindings.toggleDetails === 'mod+o'
    && aliasConflict.warnings.filter(warning => warning.reason === 'conflict').length === 2,
)

const cascadeConflict = resolveKeybindings({ historySearch: 'ctrl+c', toggleDetails: 'mod+r' })
check(
  'conflicts introduced by a fallback are resolved in a second pass',
  cascadeConflict.bindings.historySearch === 'mod+r'
    && cascadeConflict.bindings.toggleDetails === 'mod+o'
    && cascadeConflict.warnings.filter(warning => warning.reason === 'conflict').length === 2,
)
check(
  'mod cannot be combined with its ctrl alias',
  resolveKeybindings({ historySearch: 'mod+ctrl+x' }).warnings[0]?.reason === 'invalid',
)

const COLS = 100
const ROWS = 32
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const listeners = new Set<() => void>()
let cancelCount = 0
const channel: Record<string, unknown> = {
  version: 0,
  rows: [{
    id: 1,
    kind: 'reasoning',
    text: 'KEYBINDING_DETAIL_SENTINEL',
    streaming: false,
    durationMs: 1000,
  }],
  status: 'idle',
  sessionTitle: 'keybinding probe',
  agentId: 'probe',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  tokens: { input: 0, output: 0 },
  cwd: '/repo',
  displayCwd: '/repo',
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
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  reasoningEffort: 'max',
  activityEnabled: false,
  contextBarEnabled: true,
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  submit() {},
  cancel() { cancelCount += 1 },
  clear() {},
  notify() {},
  listModels: async () => [],
  listSessions: async () => [],
  listFiles: async () => [],
  listWorkspaces: async () => [],
  setResumeTarget() {},
  loadOlder() { return 0 },
  mcpStatus: () => [],
  traceEvents: () => [],
}

const stdin = new FakeStdin()
let exited = false
const TestChat = Chat as React.ComponentType<Record<string, unknown>>
const instance = await render(
  <TestChat
    channel={channel}
    questionStore={new QuestionStore()}
    onExit={() => { exited = true }}
    keybindings={{ historySearch: 'ctrl+y', toggleDetails: 'ctrl+u', interrupt: 'alt+i' }}
  />,
  {
    stdout: new FakeStdout(),
    stdin,
    stderr: new FakeStdout(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

const screen = (): string => {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) =>
    buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
  ).join('\n')
}

await sleep(500)
stdin.write('\x19') // Ctrl+Y
await sleep(400)
check('custom historySearch chord opens history search', screen().includes('Search history'))

stdin.write('\x1b')
await sleep(250)
stdin.write('\x12') // Default Ctrl+R must no longer be an alias.
await sleep(300)
check('custom historySearch chord replaces the default chord', !screen().includes('Search history'))
check('reasoning starts collapsed', !screen().includes('KEYBINDING_DETAIL_SENTINEL'))
stdin.write('draft survives global shortcut')
await sleep(300)
stdin.write('\x15') // Ctrl+U is normally the prompt's clear-before-caret action.
await sleep(400)
check('custom toggleDetails chord expands transcript details', screen().includes('KEYBINDING_DETAIL_SENTINEL'))
check('custom global chord does not also edit the prompt', screen().includes('draft survives global shortcut'), screen())

stdin.write('\x1b')
await sleep(250)

channel.working = true
channel.version = Number(channel.version) + 1
for (const listener of listeners) listener()
await sleep(200)
stdin.write('\x03') // Default Ctrl+C must no longer be an alias.
await sleep(250)
check('custom interrupt chord replaces the default chord', cancelCount === 0)
stdin.write('\x1bi') // Alt+I
await sleep(300)
check('custom interrupt chord cancels a running turn', cancelCount === 1)

channel.working = false
channel.version = Number(channel.version) + 1
for (const listener of listeners) listener()
await sleep(200)
stdin.write('?')
await sleep(350)
const help = screen()
check(
  'help menu shows the effective custom chords',
  help.includes('ctrl+y to search history')
    && help.includes('ctrl+u for verbose output')
    && help.includes('alt+i to interrupt'),
)
if (process.env.DSH_TUI_CAPTURE_KEYBINDINGS === '1') {
  const [{ mkdirSync, writeFileSync }, { resolve }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
  ])
  const directory = resolve('artifacts/issue-113')
  const escaped = help
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'after.txt'), help)
  writeFileSync(
    resolve(directory, 'after.html'),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111318;color:#e5e7eb}body{padding:28px}pre{font:16px/1.35 "Cascadia Mono","Consolas",monospace;white-space:pre;margin:0}</style><pre>${escaped}</pre>`,
  )
}

stdin.write('\x1b')
await sleep(200)
stdin.write('\x04')
await sleep(150)
check('first Ctrl+D only arms the fixed exit fallback', !exited)
stdin.write('\x04')
await sleep(200)
check('second Ctrl+D still exits with a custom interrupt chord', exited)

instance.unmount()
term.dispose()
process.exit(failed === 0 ? 0 : 1)
