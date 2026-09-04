/**
 * repro-menu-shrink-stale — 真实 Chat 斜杠菜单收缩残影复现 v2
 * （用户实机：pageMargin 开启时 / → /xx 菜单变矮，静止状态腾出的行残留
 *  旧菜单内容；none 干净。）
 *
 * 挂载：AlternateScreen > PageMargin > Chat(mock channel)
 * 键入："/b"（4 项：bg/background/balance/btw）→ "a"（→ /ba，2 项收缩）
 * 断言：收缩后 buffer 不应残留 btw/bg（腾出的行应显示转录内容或空白）。
 *
 * 运行：node --import tsx/esm scripts/repro-menu-shrink-stale.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_LANG = 'en'

import type { PageMarginSetting } from '../src/tuiDisplayPrefs.js'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { PageMargin }, { applyPageMargin }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/components/PageMargin.js'),
  import('../src/tuiDisplayPrefs.js'),
])

const COLS = 110
const ROWS = 32
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
const rawChunks: string[] = []
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { rawChunks.push(String(chunk)); term.write(String(chunk), cb) }
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
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

class Trap extends React.Component<{ children: React.ReactNode }, { err: unknown }> {
  override state = { err: null as unknown }
  static getDerivedStateFromError(err: unknown): { err: unknown } { return { err } }
  override componentDidCatch(err: unknown, info: unknown): void {
    console.error('TRAPPED RENDER ERROR:', err)
    console.error('component stack:', (info as { componentStack?: string })?.componentStack?.slice(0, 2000))
  }
  override render(): React.ReactNode {
    if (this.state.err) {
      console.error('BOUNDARY STATE:', String(this.state.err).slice(0, 2000))
      return React.createElement('text', null, 'TRAPPED')
    }
    return this.props.children
  }
}
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e))
process.on('uncaughtException', (e) => console.error('UNCAUGHT:', e))

const stdin = new FakeStdin()
const stdout = new FakeStdout()

const screenText = () => {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, y) =>
    buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
  )
}
const tail = (n: number) => screenText().slice(term.rows - n).join('\n')

function makeChannel() {
  const listeners = new Set<() => void>()
  let _version = 0
  const commands = ['new', 'clear', 'compact', 'resume', 'rename', 'recap', 'rewind', 'tree', 'fork', 'export', 'btw', 'trace', 'agentview', 'bg', 'background', 'context', 'status', 'cost', 'config', 'reload', 'settings', 'doctor', 'init', 'agents', 'jobs', 'activity', 'preset', 'theme', 'color', 'lang', 'model', 'effort', 'thinking', 'tokens', 'balance', 'provider', 'login', 'logout']
  const channel: any = {
    get version() { return _version },
    set version(v: number) { _version = v },
    rows: [] as any[],
    status: 'idle',
    sessionTitle: 'menu-repro',
    agentId: 'menu-repro',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    mode: { plan: false },
    modeIndex: 0,
    displayCwd: '/tmp/demo',
    contextBarEnabled: false,
    contextSegments: undefined,
    contextWindow: undefined,
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    workingActivity: undefined,
    activityFrames: undefined,
    commandCompletions: (q: string) => {
      const token = q.replace(/^\//, '')
      return commands
        .filter(c => c.startsWith(token))
        .map(c => ({ name: c, description: `Run ${c}`, commandLine: `/${c}` }))
    },
    commandList: commands.map(c => ({ name: c, description: `Run ${c}`, commandLine: `/${c}` })),
    tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: Date.now(),
    lastUserText: '',
    pending: [],
    notifications: [],
    smoothStreaming: false,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
  }
  const bump = () => { channel.version++; for (const cb of listeners) cb() }
  return { channel, bump }
}

async function runScenario(margin: PageMarginSetting, label: string) {
  console.log(`\n=== margin=${margin} (${label}) ===`)
  applyPageMargin(margin)
  const { channel, bump } = makeChannel()
  let id = 0
  // Seed a long transcript so the overlay covers real content.
  for (let turn = 0; turn < 12; turn++) {
    channel.rows.push({ id: id++, kind: 'user', text: `Historical question ${turn} about module ${turn} implementation details` })
    channel.rows.push({
      id: id++, kind: 'assistant', streaming: false,
      text: `Module ${turn} conclusion line one that is long enough to wrap across the terminal width for layout purposes.\n- entry point \`src/mod${turn}/index.ts\`\n- key logic handles request lifecycle stage ${turn}\n- status: ok`,
    })
  }
  bump()
  rawChunks.length = 0
  const inst = await render(
    <AlternateScreen>
      <PageMargin>
        <Trap>
          <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
        </Trap>
      </PageMargin>
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  check('Chat 挂载完成（有转录内容）', screenText().join('').includes('Module 1'), screenText().slice(-3).join('|'))

  // Open the slash menu: type "/b"
  stdin.write('/b')
  await sleep(500)
  const menuOpen = tail(8)
  check('"/b" 菜单展开（含 btw/balance 字样）', menuOpen.includes('btw') || menuOpen.includes('balance'), JSON.stringify(menuOpen.slice(-3)))

  // Narrow: type "a" → "/ba" — menu shrinks 4 → 2 while staying open.
  rawChunks.length = 0
  stdin.write('a')
  await sleep(Number(process.env.SHRINK_SLEEP_MS ?? 500))
  const after = screenText()
  const joined = after.join('\n')
  const stale = ['btw', 'bg'].filter(s => joined.includes(s))
  const stillOpen = joined.includes('balance') && joined.includes('background')
  check('收缩后菜单仍开（background/balance 可见）', stillOpen, '')
  check(
    `收缩后旧菜单行已清除（残留: ${stale.join(',') || '无'}）`,
    stale.length === 0,
    stale.length > 0 ? '旧菜单行残留 = BUG 复现' : '干净',
  )
  if (process.env.DUMP_SCREEN) {
    console.log(`--- full screen after shrink (t=${process.env.SHRINK_SLEEP_MS ?? 500}ms, with row numbers) ---`)
    after.forEach((line, y) => {
      const mark = line.includes('btw') || line.includes('background') || line.includes('balance') ? ' <==' : ''
      console.log(`${String(y).padStart(2, ' ')}: ${line}${mark}`)
    })
  }
  inst.unmount()
  await sleep(150)
}

const only = process.env.SCENARIO
if (only === undefined || only === 'normal') await runScenario('normal', '页边距 normal（默认）')
if (only === undefined || only === 'none') await runScenario('none', '页边距 none（对照）')

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
