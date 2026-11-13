/**
 * Narrow-footer anchor regression (issue #1919): in fullscreen, the status
 * footer must stay one row tall at every narrow width.
 *
 * Reported as "输入框经常在终端中间": at roughly half a terminal width the
 * input box and the status rows sat in the upper half with a wide blank band
 * below, while `? 查看快捷键` was stranded alone near the bottom row. The root
 * cause was in the layout engine, not in Chat: Yoga probes a text node with a
 * SUB-CELL width while shrinking a flex row, and `measureTextDimensions`
 * wrapped the text at that fractional width when answering the height probe.
 * A 3-column word probed at 0.82 columns came back 4 rows tall, so the
 * StatusLine field row (a row of `wrap="truncate"` Texts with overflow hidden,
 * see src/screens/StatusLine.tsx) grew by up to 23 rows and squeezed the
 * transcript/composer up. Which column gets pressed to a fractional width
 * depends on the whole row's content, so the broken widths are discrete and
 * non-monotonic — exactly the reported "特定宽度".
 *
 * The fix makes a truncate sub-cell probe answer with the text's intrinsic size
 * (height = hard line count, width still intrinsic so "does not fit" keeps its
 * meaning), and this file pins the visible contract the bug broke: at every
 * width in the sweep, the hint row is exactly one row below the fields row,
 * both sit in the last rows of the viewport, the composer stays in the bottom
 * band, and nothing is painted below the hint.
 *
 * Run: node --import tsx/esm scripts/verify-narrow-footer-anchor.tsx
 */
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
// Terminal identity + theme pin: the footer's segmented context bar and the
// hint copy are asserted, and neither may depend on the machine the gate runs
// on (same rule as the other zh-asserting verifiers).
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { PageMargin }, termTest] =
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
const { settled, viewportLines } = termTest

let failed = 0
let checks = 0
function check(name: string, ok: boolean, extra = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

/**
 * The reported state: a long provider/model label plus cache/context readouts
 * presses the compact footer row until some of its `truncate` texts are probed
 * below one cell. `shortcutHint` is off by default, and the screenshot's
 * `? 查看快捷键` row requires it on, so the fixture turns it on too.
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
    model: 'zyb-token-plan/deepseek-v4.1-flash',
    modelDisplay: 'zyb-token-plan/deepseek-v4.1-flash',
    mode: { plan: false },
    reasoningEffort: 'max',
    tokens: { input: 96_000, output: 45 },
    cwd: '/home/user/Code/dsh-TUI',
    displayCwd: '/home/user/Code/dsh-TUI',
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
    text: 'broker 接收确认时返回失败]，与本次的 err 口径不一致。我没去改它的文件，放在 tasks.md 的 Workflow follow-up 里，归档前需同步表述。',
  })
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

/**
 * Visible-viewport row indices of the three footer elements. The hint matcher
 * is anchored (`^\s*\? 查看快捷键`) because the startup tip line also contains
 * the hint text; `fields` keys on the context readout, the only footer text
 * every width keeps visible.
 */
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

/** The contract this file pins, as one predicate (wait and assert share it). */
function footerAnchored(g: Geometry, rows: number): boolean {
  return g.composer >= 0
    && g.fields >= 0
    && g.hint >= 0
    && g.hint === g.fields + 1
    && g.fields >= rows - 4
    && g.composer >= rows - 8
    && g.lastNonBlank <= rows - 2
}

function describe(g: Geometry, rows: number): string {
  return `rows=${rows} composer=${g.composer} fields=${g.fields} hint=${g.hint} `
    + `lastNonBlank=${g.lastNonBlank} hint-fields=${g.fields >= 0 && g.hint >= 0 ? g.hint - g.fields : 'n/a'}`
}

/** Mount the real fullscreen Chat tree at one size and require the footer stays put. */
async function measure(cols: number, rows: number): Promise<void> {
  const term = new XTerm({ cols, rows, scrollback: 100, allowProposedApi: true })
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

  const instance: { unmount: () => Promise<void> } = await render(
    React.createElement(
      AlternateScreen,
      null,
      React.createElement(
        PageMargin,
        null,
        React.createElement(Chat, {
          channel: makeChannel() as never,
          questionStore: new QuestionStore() as never,
          fullscreen: true,
        } as never),
      ),
    ) as never,
    {
      stdout: new FakeStdout() as never,
      stdin: new FakeStdin() as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // Wait for a painted frame AND the footer contract; the two are one
  // expression so a slow runner cannot settle on "a frame" and then assert
  // the contract against a staler screen.
  const anchored = await settled(() => bytes > 0 && footerAnchored(geometry(term), rows), { timeoutMs: 4000 })
  const g = geometry(term)
  check(`${cols}x${rows}: footer anchored to the bottom`, anchored, describe(g, rows))
  await instance.unmount()
  term.dispose()
}

// Broken-before widths from the issue's investigation (38, 46-50, 56-58,
// 62, 64, 74) plus ordinary widths as controls. Row counts 36 (reported) and
// 24 (short terminal) share the same footer geometry contract.
for (const cols of [38, 46, 47, 48, 49, 50, 56, 57, 58, 62, 64, 74, 80, 100]) await measure(cols, 36)
for (const cols of [38, 57, 64, 74, 80, 100]) await measure(cols, 24)

console.log(`\n${failed === 0 ? 'All narrow-footer anchor checks passed.' : `${failed} of ${checks} check(s) failed.`}`)
process.exitCode = failed === 0 ? 0 : 1
