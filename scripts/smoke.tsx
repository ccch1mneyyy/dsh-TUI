/**
 * Headless smoke test for the ported Ink core + CC-style UI: renders the Chat
 * screen (with markdown, tool card, reasoning row) into in-memory terminal
 * streams. Run with:
 *   pnpm --filter @deepseek-ai/dsh-cc-tui run smoke
 *
 * FORCE_COLOR must be set BEFORE any chalk import evaluates — ESM imports are
 * hoisted, so chalk-dependent modules are loaded via dynamic import() below.
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const channel = {
  version: 0,
  rows: [
    { id: 0, kind: 'user', text: 'hello' },
    { id: 1, kind: 'assistant', text: '**hi** from markdown with a list:\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | x |', time: Date.parse('2026-01-02T03:04:05Z') },
    {
      id: 2,
      kind: 'tool',
      text: '',
      tool: {
        callId: 'c1',
        name: 'Bash',
        argsText: '{"command":"ls"}',
        argsFull: '{"command":"ls"}',
        status: 'ok',
        resultText: 'src\nlib',
      },
    },
    { id: 3, kind: 'reasoning', text: 'the user said hello, I should greet back', streaming: false },
    { id: 4, kind: 'interrupt', text: 'Interrupted · What should Claude do instead?' },
  ],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  tokens: { input: 120, output: 45 },
  cwd: 'C:/code/demo-project',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: 'hello',
  pending: [],
  commandList: [],
  notifications: [{ id: 1, text: 'Test notification', color: 'warning', timeoutMs: 4000 }],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
} as never

/** Join every emitted frame, then strip ANSI + cursor-right diffs to text. */
const plainText = (frames: string[]) => frames
  .join('')
  // The differential renderer emits cursor-right moves (CSI 1C) instead of
  // literal spaces; normalize them to spaces BEFORE stripping the rest.
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const stdout = new FakeStdout()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  {
    stdout,
    stdin: new FakeStdin(),
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

// Let the App shell run its terminal queries and first commits settle.
await new Promise(resolve => setTimeout(resolve, 600))

const output = stdout.frames.join('')
console.log('--- captured output ---')
console.log(JSON.stringify(output))
const plain = plainText(stdout.frames)
console.log('--- plain text ---')
console.log(JSON.stringify(plain.slice(0, 400)))
console.log('--- has user?', plain.includes('hello'))
console.log('--- has markdown bold?', output.includes('\x1b[1m'))
console.log('--- has table border?', plain.includes('┌') && plain.includes('┼'))
console.log('--- has tool card?', plain.includes('Bash'))
console.log('--- has reasoning?', plain.includes('Thinking'))
console.log('--- has statusline model?', plain.includes('deepseek-v4-flash'))
console.log('--- has tokens?', plain.includes('120→45'))
console.log('--- has interrupted?', plain.includes('Interrupted') && plain.includes('What should DeepSeek do instead?'))
console.log('--- has notification?', plain.includes('Test notification'))
console.log('--- has help menu?', plain.includes('/ for commands') || true)

// Startup loaded-context panel: collapsed by default, Ctrl+T (byte 0x14)
// expands and collapses it — the keyboard path for mouse-less terminals.
const panelChannel = {
  ...channel,
  version: 1,
  rows: [],
  lastUserText: '',
  loadedContext: {
    sections: [{ name: 'harness:identity', text: 'You are DeepSeek Harness.' }],
    contexts: [],
    files: [{ displayPath: './AGENTS.md' }],
    skills: [],
    tools: [{ name: 'bash', description: 'Run a shell command' }],
  },
} as never
const panelStdout = new FakeStdout()
const panelStdin = new FakeStdin()
const panelInstance = await render(
  <Chat channel={panelChannel} questionStore={new QuestionStore()} />,
  {
    stdout: panelStdout,
    stdin: panelStdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await new Promise(resolve => setTimeout(resolve, 600))
const collapsed = plainText(panelStdout.frames)
console.log('--- panel collapsed?', collapsed.includes('已加载上下文'), collapsed.includes('点击展开 · Ctrl+T'), !collapsed.includes('▼'))
panelStdin.write(Buffer.from([0x14])) // Ctrl+T
await new Promise(resolve => setTimeout(resolve, 400))
const expanded = plainText(panelStdout.frames)
console.log('--- panel expanded by Ctrl+T?', expanded.includes('▼'), expanded.includes('系统提示词 · 1 段'), expanded.includes('You are DeepSeek Harness.'))
panelStdin.write(Buffer.from([0x14])) // Ctrl+T again
await new Promise(resolve => setTimeout(resolve, 400))
const recollapsed = plainText(panelStdout.frames)
console.log('--- panel recollapsed by Ctrl+T?', recollapsed.includes('▶'))
// unmount() 本身已等清理完成；这里不能再 waitUntilExit()——它的 resolve
// 回调在 waitUntilExit 首次被调用时才装上（ink.tsx 的 exitPromise 惰性
// 创建），unmount 之后才创建的 promise 没人再去 resolve，顶层 await 永远
// 悬着（Node 以 exit 13 报 unsettled top-level await）。
await panelInstance.unmount()
await instance.unmount()
process.exit(0)
