/**
 * repro-scrollbar-click — 页边距开启后滚动条点击失效复现
 * （用户实机：pageMargin normal 下全屏转录右缘滚动条"点不着"，none 正常。）
 *
 * 挂载真实 Chat（scrollGutter=scrollbar）+ PageMargin(margin 参数)；
 * 长转录 sticky 在底部后，向最右列（滚动条轨道）顶部发 SGR 左键
 * press+release；点击轨道应 scrollTo(近顶部) → 屏上出现早期行。
 *
 * 运行：node --import tsx/esm scripts/repro-scrollbar-click.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_LANG = 'en'

import type { PageMarginSetting } from '../src/tuiDisplayPrefs.js'
import type { ParsedMouse } from '../src/ink/parse-keypress.js'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { PageMargin }, { applyPageMargin }, { handleMouseEvent }, { default: instances }, { hitTest }, { nodeCache }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/components/PageMargin.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/ink/components/App.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/hit-test.js'),
  import('../src/ink/node-cache.js'),
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

const stdin = new FakeStdin()
const stdout = new FakeStdout()

const screenText = () => {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, y) =>
    buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
  )
}

function makeChannel() {
  const listeners = new Set<() => void>()
  let _version = 0
  const channel: any = {
    get version() { return _version },
    set version(v: number) { _version = v },
    rows: [] as any[],
    status: 'idle',
    sessionTitle: 'rail-repro',
    agentId: 'rail-repro',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
    mode: { plan: false },
    modeIndex: 0,
    displayCwd: '/tmp/demo',
    contextBarEnabled: false,
    scrollGutter: 'scrollbar',
    contextSegments: undefined,
    contextWindow: undefined,
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    workingActivity: undefined,
    activityFrames: undefined,
    commandCompletions: () => [],
    commandList: [],
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

function click(col1: number, row1: number): void {
  const app = (instances.get(stdout) as { app?: unknown }).app
  if (!app) { console.error('NO APP INSTANCE'); return }
  const press: ParsedMouse = { kind: 'mouse', button: 0, action: 'press', col: col1, row: row1, sequence: '' } as ParsedMouse
  const release: ParsedMouse = { kind: 'mouse', button: 0, action: 'release', col: col1, row: row1, sequence: '' } as ParsedMouse
  ;(handleMouseEvent as (app: unknown, m: ParsedMouse) => void)(app, press)
  ;(handleMouseEvent as (app: unknown, m: ParsedMouse) => void)(app, release)
}

async function runScenario(margin: PageMarginSetting, label: string) {
  console.log(`\n=== margin=${margin} (${label}) ===`)
  applyPageMargin(margin)
  const { channel, bump } = makeChannel()
  let id = 0
  for (let turn = 0; turn < 14; turn++) {
    channel.rows.push({ id: id++, kind: 'user', text: `Historical question ${turn} about module ${turn}` })
    channel.rows.push({
      id: id++, kind: 'assistant', streaming: false,
      text: `Module ${turn} conclusion with enough content that the transcript is much taller than the viewport for scrolling purposes.\n- entry point src/mod${turn}/index.ts\n- status ok`,
    })
  }
  bump()
  rawChunks.length = 0
  await render(
    <AlternateScreen>
      <PageMargin>
        <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
      </PageMargin>
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(600)
  const before = screenText().join('\n')
  check('挂载完成且停在底部（见 question 13）', before.includes('question 13'), '')
  check('底部视图不含 question 0', !before.includes('question 0 about module 0'), '')

  if (process.env.DUMP_SCREEN) {
    const ink = instances.get(stdout) as { rootNode?: unknown }
    const root = ink.rootNode as never
    console.log('--- hitTest at gutter cells (row=2 0-based) ---')
    for (let col = 102; col < COLS; col++) {
      const hit = hitTest(root, col, 2) as { nodeName?: string } | null
      const r = hit ? nodeCache.get(hit as never) : undefined
      const desc = hit
        ? `${hit.nodeName} rect=${r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'no-rect'}`
        : 'NULL'
      console.log(`col ${col}: ${desc}`)
    }
    console.log('--- nodes reaching right region (x+width>=104) ---')
    let count = 0
    const walk = (n: { nodeName?: string; childNodes?: unknown[]; style?: Record<string, unknown> }, depth: number): void => {
      if (count > 45) return
      const r = nodeCache.get(n as never)
      if (r && r.x + r.width >= 104) {
        const st = n.style ?? {}
        const flags = [
          st.position === 'absolute' ? 'abs' : '',
          st.opaque ? 'opaque' : '',
          st.backgroundColor ? `bg:${String(st.backgroundColor).slice(0, 12)}` : '',
        ].filter(Boolean).join(',')
        console.log(`${'  '.repeat(depth)}${n.nodeName} rect=${r.x},${r.y} ${r.width}x${r.height}${flags ? ` [${flags}]` : ''}`)
        count++
      }
      for (const c of (n.childNodes ?? []) as never[]) {
        if ((c as { nodeName?: string }).nodeName === '#text') continue
        walk(c as never, depth + 1)
      }
    }
    walk(root, 0)
    console.log(`--- (${count} nodes listed) ---`)
  }

  // Click the scrollbar track near its TOP: expect jump towards the top.
  // Rightmost column (1-based COLS), row 3.
  click(COLS, 3)
  await sleep(400)
  const after = screenText().join('\n')
  const jumped = after.includes('question 0 about module 0') || after.includes('question 1 about module 1')
  check(`滚动条顶部点击生效（跳到早期内容）: ${jumped ? '跳了' : '没跳'}`, jumped, after.slice(0, 80).split('\n')[1] ?? '')
  if (process.env.DUMP_SCREEN) {
    console.log('--- screen rows 0-6 after click ---')
    console.log(after.split('\n').slice(0, 7).join('\n'))
  }
  // teardown: unmount via the instance
  ;(instances.get(stdout) as { unmount?: () => void }).unmount?.()
  await sleep(150)
}

const only = process.env.SCENARIO
if (only === undefined || only === 'none') await runScenario('none', '页边距 none（对照）')
if (only === undefined || only === 'normal') await runScenario('normal', '页边距 normal')
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
