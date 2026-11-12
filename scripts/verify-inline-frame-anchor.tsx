/**
 * Inline frame anchor regression (issue #1919): after a resize or an idle-gap
 * re-anchor, a short main-screen frame must stay anchored to the bottom of the
 * viewport.
 *
 * Inline mode has no definite-height parent: the frame is as tall as its
 * content and "sits at the bottom" only because growth ends with the cursor
 * parked on the viewport's last row. Every full repaint path (resize reset,
 * idle-gap viewport re-anchor) used to blank the viewport with CSI H + ED and
 * then paint the frame from the viewport TOP. For a short conversation that
 * moves the whole composer/status footer into the upper half and leaves a wide
 * blank band below — and because a frame shorter than the viewport emits no
 * LFs in steady state, nothing ever re-anchors it: the UI stays stranded
 * (issue #1919; the same screenshot also showed inline mode).
 *
 * This file drives the two real entry points that take the full-repaint path
 * with the actual xterm emulator and the real Chat:
 *   1. a resize (height grows, then width narrows at a fixed row count);
 *   2. the stdin-gap re-anchor (>5s idle, then the first key),
 * and demands the footer tail stay in the bottom rows with the hint row
 * adjacent to the status fields, both immediately after the repaint and after
 * an unrelated frame.
 *
 * The emulator starts from a real shell-like screen (history lines + prompt,
 * cursor parked on the bottom row) so the first frame grows up from the
 * bottom the way it does in a terminal; reading the screen always starts at
 * `buffer.baseY`, because inline scrollback puts older frames above the
 * viewport.
 *
 * Run: node --import tsx/esm scripts/verify-inline-frame-anchor.tsx
 */
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
// Terminal identity + theme pin: the footer's segmented context bar and the
// hint copy are asserted, and neither may depend on the machine running the
// gate (same rule as the other zh-asserting verifiers).
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { PageMargin }, termTest] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/components/PageMargin.js'),
    import('./lib/term-test.mjs'),
  ])
const { sleep, settled, writeParsed, viewportLines, screenHas } = termTest

let failed = 0
let checks = 0
function check(name: string, ok: boolean, extra = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

/**
 * Short-conversation fixture with the footer switches the issue's screenshot
 * needs (`shortcutHint` is off by default; the `? 查看快捷键` row requires it).
 */
function makeChannel(): Record<string, unknown> {
  const listeners = new Set<() => void>()
  let id = 0
  const channel: Record<string, unknown> = {
    whaleIdle: false,
    version: 0,
    status: 'idle',
    sessionTitle: 'fix input position',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    modelDisplay: 'deepseek-v4-flash',
    mode: { plan: false },
    reasoningEffort: 'max',
    tokens: { input: 96_000, output: 45 },
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
    statusBar: { compact: true, shortcutHint: true, contextBar: true },
    contextBarEnabled: true,
    contextWindow: 1_000_000,
    contextOccupancy: { usedTokens: 96_000, contextWindow: 1_000_000, source: 'projection' },
    contextSegments: { system: 20_000, prompt: 30_000, assistant: 30_000, thinking: 10_000, tools: 6_000 },
    contextBreakdown: { systemTokens: 20_000, toolsTokens: 6_000, messageTokens: 70_000 },
    lastUsage: { input: 96_000, cacheRead: 1_800_000, cacheWrite: 0, output: 0 },
    rows: [] as unknown[],
    subscribe(cb: () => void): () => void {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (): void => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: (): void => {},
    loadOlder: (): void => {},
    mcpStatus: () => [],
  }
  const rows = channel.rows as Array<Record<string, unknown>>
  rows.push({ id: id++, kind: 'user', text: '看看这个 openspec change' })
  rows.push({
    id: id++,
    kind: 'assistant',
    text: '产物看完后，如果要开始实施，回我 openspec apply 或让我 apply 这个 change。',
  })
  channel.bump = (): void => {
    channel.version = (channel.version as number) + 1
    for (const cb of listeners) cb()
  }
  return channel
}

interface Geometry {
  composer: number
  fields: number
  hint: number
  lastNonBlank: number
  lines: string[]
}

/** Visible-viewport footer rows (inline scrollback: read from `baseY`, never 0). */
function geometry(term: InstanceType<typeof XTerm>): Geometry {
  const lines = viewportLines(term)
  let composer = -1
  let fields = -1
  let hint = -1
  let lastNonBlank = -1
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y]!
    if (composer < 0 && /[╭┌]/.test(line)) composer = y
    if (fields < 0 && /ctx [\d.]/.test(line)) fields = y
    if (hint < 0 && /^\s*\? 查看快捷键/.test(line)) hint = y
    if (line.trim() !== '') lastNonBlank = y
  }
  return { composer, fields, hint, lastNonBlank, lines }
}

/**
 * The inline end-state contract: the frame tail (input box → context bar →
 * status fields → hint) ends on the cursor-park row, so the hint is 1 row
 * below the fields row and three rows above the viewport bottom (the hint,
 * the PageMargin bottom row, then the park row), and the composer top stays
 * in the last eight rows.
 */
function bottomAnchored(g: Geometry, rows: number): boolean {
  return g.composer >= 0
    && g.fields >= 0
    && g.hint >= 0
    && g.hint === g.fields + 1
    && g.hint >= rows - 4
    && g.hint <= rows - 2
    && g.composer >= rows - 8
    && g.lastNonBlank <= rows - 2
}

function describe(g: Geometry, rows: number): string {
  return `rows=${rows} composer=${g.composer} fields=${g.fields} hint=${g.hint} lastNonBlank=${g.lastNonBlank} `
    + `hint-fields=${g.fields >= 0 && g.hint >= 0 ? g.hint - g.fields : 'n/a'} footerFromBottom=${g.hint >= 0 ? rows - g.hint : 'n/a'}`
}

interface Harness {
  term: InstanceType<typeof XTerm>
  stdout: Writable & { columns: number; rows: number; emit: (event: string) => boolean }
  stdin: PassThrough
  channel: Record<string, unknown>
  /** Bytes written to the fake stdout since the last `resetBytes()` call. */
  bytes: () => number
  resetBytes: () => void
  instance: { unmount: () => Promise<void> }
}

/** Mount the real inline Chat tree on a shell-like screen with the cursor parked. */
async function mount(cols: number, rows: number): Promise<Harness> {
  const term = new XTerm({ cols, rows, scrollback: 2_000, allowProposedApi: true })
  // Real terminal start: shell history + prompt park the cursor on the last
  // row, so the first app frame grows UP from the viewport bottom exactly as
  // in a terminal — rendering from row 0 measures a fake starting point.
  let shell = ''
  for (let i = 0; i < rows; i++) shell += `$ shell-line-${String(i).padStart(2, '0')}\r\n`
  await writeParsed(term, `${shell}$ `)

  let bytes = 0
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      bytes += String(chunk).length
      term.write(String(chunk), callback)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }

  const channel = makeChannel()
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance: { unmount: () => Promise<void> } = await render(
    React.createElement(
      PageMargin,
      null,
      React.createElement(Chat, {
        channel: channel as never,
        questionStore: new QuestionStore() as never,
        fullscreen: false,
      } as never),
    ) as never,
    {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return {
    term,
    stdout: stdout as Harness['stdout'],
    stdin,
    channel,
    bytes: () => bytes,
    resetBytes: () => { bytes = 0 },
    instance,
  }
}

/** Resize the emulator AND the app, the way a real SIGWINCH does. */
async function applyResize(h: Harness, cols: number, rows: number): Promise<void> {
  h.resetBytes()
  h.term.resize(cols, rows)
  h.stdout.columns = cols
  h.stdout.rows = rows
  h.stdout.emit('resize')
}

/** Wait for a post-trigger frame whose footer is bottom-anchored, then report it. */
async function waitAnchored(h: Harness, rows: number, timeoutMs = 5_000): Promise<Geometry> {
  await settled(() => h.bytes() > 0 && bottomAnchored(geometry(h.term), rows), { timeoutMs })
  return geometry(h.term)
}

async function checkAnchored(label: string, h: Harness, rows: number): Promise<Geometry> {
  const g = await waitAnchored(h, rows)
  check(`${label}: footer anchored to the bottom`, bottomAnchored(g, rows), describe(g, rows))
  check(`${label}: hint row adjacent to the status fields`, g.hint === g.fields + 1,
    `fields=${g.fields} hint=${g.hint}`)
  check(`${label}: composer stays in the bottom band`, g.composer >= rows - 8 && g.composer >= 0,
    `composer=${g.composer} rows=${rows}`)
  check(`${label}: nothing painted below the hint`, g.lastNonBlank <= rows - 2,
    `lastNonBlank=${g.lastNonBlank}`)
  return g
}

/** Height grows: the resize full-reset must keep the short frame on the bottom. */
async function heightGrowthScenario(): Promise<void> {
  const h = await mount(80, 36)
  const initial = await checkAnchored('80x36 initial', h, 36)
  await applyResize(h, 80, 48)
  const resized = await checkAnchored('80x36 -> 80x48 resize', h, 48)
  check('80x36 -> 80x48: initial frame was already bottom-anchored',
    bottomAnchored(initial, 36), describe(initial, 36))

  // An unrelated frame (the footer's cwd text changes; layout does not) must
  // not move the footer: a stranded frame is exactly the state a later diff
  // would keep skipping, so pin that it stays put.
  h.resetBytes()
  h.channel.displayCwd = '/tmp/other-project'
  h.channel.bump()
  await settled(() => h.bytes() > 0 && screenHas(h.term, 'other-project'), { timeoutMs: 5_000 })
  const afterBump = geometry(h.term)
  check('80x36 -> 80x48: unrelated frame keeps the footer anchored',
    afterBump.composer === resized.composer
    && afterBump.fields === resized.fields
    && afterBump.hint === resized.hint,
    `before composer=${resized.composer} fields=${resized.fields} hint=${resized.hint}; `
    + `after composer=${afterBump.composer} fields=${afterBump.fields} hint=${afterBump.hint}`)

  await h.instance.unmount()
  h.term.dispose()
}

/** Width narrows at a fixed row count: content reflows onto more rows. */
async function widthNarrowScenario(): Promise<void> {
  const h = await mount(100, 36)
  await checkAnchored('100x36 initial', h, 36)
  await applyResize(h, 60, 36)
  await checkAnchored('100x36 -> 60x36 resize', h, 36)
  await h.instance.unmount()
  h.term.dispose()
}

/**
 * Idle-gap re-anchor: >5s with no stdin, then the first key. The renderer
 * repaints the viewport from the physical cursor for the next frame; a short
 * frame must land on the bottom, not the top.
 */
async function idleGapReanchorScenario(): Promise<void> {
  const h = await mount(80, 36)
  await checkAnchored('idle-gap initial', h, 36)
  // 固定窗:墙钟 STDIN_RESUME_GAP_MS = 5000 是被测语义：只有真实空闲过 5s，
  // 首个按键才会触发 reanchor（没有可轮询的等价信号）。
  await sleep(5_200)
  h.resetBytes()
  h.stdin.write('a')
  await checkAnchored('idle-gap first key re-anchor', h, 36)
  await h.instance.unmount()
  h.term.dispose()
}

await heightGrowthScenario()
await widthNarrowScenario()
await idleGapReanchorScenario()

console.log(`\n${failed === 0 ? 'All inline frame anchor checks passed.' : `${failed} of ${checks} check(s) failed.`}`)
process.exitCode = failed === 0 ? 0 : 1
