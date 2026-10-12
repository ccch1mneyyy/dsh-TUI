/**
 * Live tool output (`tool.output`, N4):
 *
 *  1. the bounded tail (`src/channel/live-output.ts`): chunk boundaries
 *     inside lines, the 200-line bound with its dropped counter, the 16 KiB
 *     bound (whole lines first; one giant line keeps its newest characters,
 *     never starting on half a surrogate pair), and appends that stay cheap;
 *  2. the shared projector: chunks append to the running card's tail; an
 *     unknown, settled, child-lane or question-presented call is ignored;
 *     `tool.result` removes the tail (a card that never printed keeps its
 *     exact shape); `reset()` forgets tails;
 *  3. the card: the newest 5 lines dim (8 in fullscreen, the whole retained
 *     tail when verbose) under the running line, with a `… N lines omitted`
 *     header only when older lines exist; ANSI, carriage-return progress,
 *     tabs and control characters sanitized; lines cut to the width in
 *     display cells (CJK, very long lines) so none wraps, at 80 and 40
 *     columns; a settled card shows no live lines;
 *  4. end to end in Chat, inline and fullscreen, at 80 and 40 columns: the
 *     running card follows the tail as it grows and the row below it is
 *     never overlapped (the layout signature re-measures the card).
 *
 * Run: node --import tsx/esm scripts/verify-tool-live-output.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { AssistantToolUseMessage },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  { appendLiveOutput, liveOutputLineCount, LIVE_OUTPUT_MAX_CHARS, LIVE_OUTPUT_MAX_LINES },
  { liveOutputRows, liveOutputView, cleanOutputLine, fitOutputLine },
  { createChannelProjection },
  { createInitialChannelView },
  { stringWidth },
  { t },
  { settle, settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/channel/live-output.js'),
  import('../src/components/messages/liveOutputLines.js'),
  import('../src/channel/projection.js'),
  import('../src/dsh-adapter/channel/state.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])
type AgentEvent = import('../src/agent/events.js').AgentEvent
type ChatRow = import('../src/adapter/ports/channel-view.js').ChatRow

let failures = 0
let passed = 0
// Printed at the end: console output during a render lands in the fake
// terminal and would pollute the screen probes.
const results: string[] = []
const check = (name: string, ok: boolean, extra = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' && !ok ? `  (${extra})` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const lines = (from: number, to: number, prefix = 'line'): string => {
  const out: string[] = []
  for (let n = from; n <= to; n += 1) out.push(`${prefix} ${n}`)
  return `${out.join('\n')}\n`
}

// ── 1. the bounded tail ─────────────────────────────────────────────────
{
  let tail = appendLiveOutput(undefined, 'hel')
  tail = appendLiveOutput(tail, 'lo\nwor')
  tail = appendLiveOutput(tail, 'ld\n')
  check('1 chunks split inside lines join up', tail.text === 'hello\nworld\n' && liveOutputLineCount(tail) === 2 && tail.dropped === 0)
  const open = appendLiveOutput(tail, 'partial')
  check('1 an open last line counts as a line', liveOutputLineCount(open) === 3)

  let many = appendLiveOutput(undefined, lines(1, 150))
  many = appendLiveOutput(many, lines(151, 250))
  check('1 at most 200 lines are kept, the rest counted as dropped', liveOutputLineCount(many) === LIVE_OUTPUT_MAX_LINES && many.dropped === 50 && many.text.startsWith('line 51\n') && many.text.endsWith('line 250\n'), `${liveOutputLineCount(many)} / ${many.dropped}`)
  check('1 the break count rides on the tail exactly', many.breaks === (many.text.match(/\n/gu) ?? []).length)

  const wide = 'x'.repeat(299)
  let big: ReturnType<typeof appendLiveOutput> | undefined
  for (let n = 0; n < 100; n += 1) big = appendLiveOutput(big, `${wide}\n`)
  check('1 at most 16 KiB is kept, whole lines first', big!.text.length <= LIVE_OUTPUT_MAX_CHARS && big!.text.startsWith(wide) && big!.dropped === 100 - liveOutputLineCount(big!), `${big!.text.length} / ${big!.dropped}`)

  const giant = appendLiveOutput(undefined, `head\n${'y'.repeat(40_000)}`)
  check('1 one giant line keeps its newest 16 KiB (the line before it dropped)', giant.text.length === LIVE_OUTPUT_MAX_CHARS && /^y+$/u.test(giant.text) && giant.dropped === 1)

  const emoji = appendLiveOutput(undefined, `a${'😀'.repeat(10_000)}`)
  const first = emoji.text.charCodeAt(0)
  check('1 a cut never starts on half a surrogate pair', !(first >= 0xdc00 && first <= 0xdfff) && emoji.text.length <= LIVE_OUTPUT_MAX_CHARS)

  const started = performance.now()
  let stream: ReturnType<typeof appendLiveOutput> | undefined
  for (let n = 0; n < 20_000; n += 1) stream = appendLiveOutput(stream, `progress line ${n} ${'.'.repeat(n % 60)}\n`)
  const elapsed = performance.now() - started
  check('1 20k appends stay bounded and cheap', liveOutputLineCount(stream!) === LIVE_OUTPUT_MAX_LINES && stream!.text.length <= LIVE_OUTPUT_MAX_CHARS && elapsed < 2_000, `${elapsed.toFixed(0)} ms`)
  results.push(`INFO  20k appends: ${elapsed.toFixed(1)} ms (${(elapsed * 1000 / 20_000).toFixed(1)} µs each)`)
}

// ── 2. the shared projector ─────────────────────────────────────────────
function projector() {
  const view = createInitialChannelView(
    { model: 'm', provider: 'p', cwd: '/fixture' },
    { agentId: 'a', sessionId: 's', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
  const state = { ...view, emit: () => undefined } as Parameters<typeof createChannelProjection>[0]
  const projection = createChannelProjection(state, {
    rowIds: { value: 0 },
    resetContextWarning: () => undefined,
    checkContextWarning: () => undefined,
    notify: () => () => undefined,
    jobs: { onOutputSeen: () => undefined, onStarted: () => undefined },
    inputConvergence: { cancelInFlight: false },
    selectionAttached: () => undefined,
  })
  return { state, apply: (events: AgentEvent[]) => projection.apply(events, { replay: false }), reset: () => projection.reset() }
}
const call = (callId: string, extra: Partial<Extract<AgentEvent, { type: 'tool.call' }>> = {}): AgentEvent => ({ type: 'tool.call', seq: 1, turn: 1, step: 1, callId, name: 'shell', argsJson: '{"command":"npm test"}', presentation: { card: 'terminal', title: 'npm test' }, time: 1, ...extra })
const output = (callId: string, text: string, parentCallId?: string): AgentEvent => ({ type: 'tool.output', callId, text, time: 2, ...(parentCallId === undefined ? {} : { parentCallId }) })
const result = (callId: string): AgentEvent => ({ type: 'tool.result', seq: 3, turn: 1, step: 1, callId, isError: false, time: 3, content: [{ type: 'text', text: 'done' }], text: 'done' })
{
  const { state, apply, reset } = projector()
  apply([call('c1'), output('c1', 'compiling…\n'), output('c1', 'ok 1\nok ')])
  const card = state.rows.find(row => row.tool?.callId === 'c1')!
  check('2 chunks append to the running card', card.tool!.liveOutput === 'compiling…\nok 1\nok ' && card.tool!.liveOutputDropped === undefined)
  const before = JSON.stringify(state.rows)
  apply([output('nope', 'stray\n')])
  check('2 an unknown call is ignored', JSON.stringify(state.rows) === before)
  apply([output('c1', '')])
  check('2 an empty chunk changes nothing', card.tool!.liveOutput === 'compiling…\nok 1\nok ')
  apply([output('c1', lines(1, 300))])
  check('2 the projector keeps the bounded tail (dropped counted)', liveOutputLineCount({ text: card.tool!.liveOutput!, breaks: (card.tool!.liveOutput!.match(/\n/gu) ?? []).length }) === 200 && card.tool!.liveOutputDropped === 102, String(card.tool!.liveOutputDropped))
  apply([output('c1', 'child line\n', 'parent-call')])
  check('2 a child-lane chunk never touches the main card', !card.tool!.liveOutput!.includes('child line'))
  apply([result('c1')])
  check('2 the result removes the tail (no keys left behind)', !('liveOutput' in card.tool!) && !('liveOutputDropped' in card.tool!) && card.tool!.status === 'ok')
  apply([output('c1', 'late\n')])
  check('2 a chunk after the result is ignored', !('liveOutput' in card.tool!))

  apply([call('c2'), result('c2')])
  const quiet = state.rows.find(row => row.tool?.callId === 'c2')!
  check('2 a card that never printed keeps its exact shape', !('liveOutput' in quiet.tool!) && !('liveOutputDropped' in quiet.tool!))

  apply([call('q1', { presentation: { card: 'question' } }), output('q1', 'nope\n')])
  check('2 a question-presented call has no card to print on', state.rows.every(row => row.tool?.callId !== 'q1'))

  apply([call('c3'), output('c3', 'one\n')])
  reset()
  const third = state.rows.find(row => row.tool?.callId === 'c3')!
  apply([output('c3', 'two\n')])
  check('2 reset forgets the tails (no card is fed afterwards)', third.tool!.liveOutput === 'one\n')
}

// ── 3. the card ─────────────────────────────────────────────────────────
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
function terminal(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const screenLines = (): string[] => viewportLines(term, rows)
  /** Foreground key of the first cell of `needle` (ASCII prefix assumed).
   *  The repo's `dimColor` is the theme's `inactive` colour, not SGR 2, so
   *  "dim" is compared by colour (see verify-launchpad's fgKeyOf). */
  const fgOf = (needle: string): string => {
    const all = screenLines()
    const y = all.findIndex(line => line.includes(needle))
    if (y < 0) return 'missing'
    const cell = term.buffer.active.getLine(y)?.getCell(all[y]!.indexOf(needle))
    if (cell === undefined) return 'missing'
    if (cell.isFgDefault()) return 'default'
    return `${cell.isFgRGB() ? 'rgb' : 'palette'}:${cell.getFgColor().toString(16)}`
  }
  return { term, stdout: new FakeStdout(), stdin: new FakeStdin(), stderr: new FakeStdout(), screenLines, fgOf }
}
const runningTool = (liveOutput: string | undefined, liveOutputDropped?: number) => ({
  callId: 'c1',
  name: 'shell',
  argsText: '{"command":"npm test"}',
  status: 'running' as const,
  callView: { card: 'terminal' as const, title: 'npm test', displayKey: 'tool-name-bash' },
  startedAt: Date.now(),
  ...(liveOutput === undefined ? {} : { liveOutput }),
  ...(liveOutputDropped === undefined ? {} : { liveOutputDropped }),
})

for (const cols of [80, 40]) {
  const rows = 30
  const io = terminal(cols, rows)
  const card = (key: string, tool: Record<string, unknown>, options: { fullscreen?: boolean; verbose?: boolean } = {}) =>
    React.createElement(AssistantToolUseMessage, { key, tool: tool as never, marginTopOnTurn: false, verbose: options.verbose === true, fullscreen: options.fullscreen === true })
  const app = await render(card('boot', runningTool(undefined)), { stdout: io.stdout as never, stdin: io.stdin as never, stderr: io.stderr as never, debug: true, exitOnCtrlC: false, patchConsole: false })
  const show = async (key: string, tool: Record<string, unknown>, ready: () => boolean, options: { fullscreen?: boolean; verbose?: boolean } = {}) => {
    app.rerender(card(key, tool, options))
    await settle(ready)
  }
  const text = (): string => io.screenLines().join('\n')
  const at = `@${cols}`

  await show('few', runningTool('alpha\nbeta\ngamma\n'), () => text().includes('gamma'))
  check(`3${at} a short tail shows every line, no omitted header`, text().includes('alpha') && text().includes('beta') && !text().includes('omitted'))
  check(`3${at} the running line stays first`, (() => { const all = io.screenLines(); return all.findIndex(line => line.includes('Running')) < all.findIndex(line => line.includes('alpha')) })())
  check(`3${at} live lines are dim (the running line's inactive colour)`, io.fgOf('beta') === io.fgOf('Running') && io.fgOf('beta') !== 'default', `${io.fgOf('beta')} vs ${io.fgOf('Running')}`)

  await show('inline', runningTool(lines(1, 40), 10), () => text().includes('line 40'))
  const inlineShown = [36, 37, 38, 39, 40].every(n => text().includes(`line ${n}`)) && !text().includes('line 35')
  check(`3${at} inline: the newest 5 lines`, inlineShown, text())
  check(`3${at} inline: … N lines omitted counts dropped and hidden lines`, text().includes(t('tool-live-omitted', { count: 45 })), text())

  await show('fullscreen', runningTool(lines(1, 40), 10), () => text().includes('line 33'), { fullscreen: true })
  check(`3${at} fullscreen: the newest 8 lines`, [33, 34, 35, 36, 37, 38, 39, 40].every(n => text().includes(`line ${n}`)) && !text().includes('line 32') && text().includes(t('tool-live-omitted', { count: 42 })), text())

  await show('verbose', runningTool(lines(1, 12)), () => text().includes('line 1\n') || io.screenLines().some(line => line.trim().endsWith('line 1')), { verbose: true })
  check(`3${at} verbose: the whole retained tail, no header`, [1, 6, 12].every(n => io.screenLines().some(line => line.trimEnd().endsWith(`line ${n}`))) && !text().includes('omitted'), text())

  const long = `${'0123456789'.repeat(30)}END`
  const cjk = '汉字'.repeat(60)
  await show('wide', runningTool(`${long}\n${cjk}\nshort\n`), () => text().includes('short'))
  const all = io.screenLines()
  const longRow = all.find(line => line.includes('0123456789'))
  const cjkRow = all.find(line => line.includes('汉字'))
  check(`3${at} a very long line is cut to one row with …`, longRow !== undefined && longRow.includes('…') && !text().includes('END') && stringWidth(longRow.trimEnd()) <= cols, longRow)
  check(`3${at} a CJK line is cut by display cells (no wrap, no half glyph)`, cjkRow !== undefined && cjkRow.trimEnd().endsWith('…') && stringWidth(cjkRow.trimEnd()) <= cols && all.filter(line => line.includes('汉字')).length === 1, cjkRow)

  await show('dirty', runningTool('\u001b[31mred text\u001b[0m\nprogress 10%\rprogress 55%\rprogress 99%\ncol\tumn\u0007bell\n\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007\n'), () => text().includes('link'))
  check(`3${at} ANSI colours are stripped`, text().includes('red text') && !text().includes('[31m') && !text().includes('[0m'))
  check(`3${at} carriage-return progress shows its last state`, text().includes('progress 99%') && !text().includes('progress 10%') && !text().includes('progress 55%'))
  check(`3${at} tabs become spaces, controls and OSC links vanish`, text().includes('col    umnbell') && !text().includes('https://x.test') && text().includes('link'), text())

  await show('settled', { ...runningTool(undefined), status: 'ok', durationMs: 1200, resultView: { card: 'terminal', output: 'final output' } }, () => text().includes('final output'))
  check(`3${at} a settled card shows its result, no live lines`, !text().includes('Running') && !text().includes('omitted'))
  await app.unmount()
}

// Pure render helpers (the card's view of a tail).
{
  const view = liveOutputView(lines(1, 9), 3, 5, 80)
  check('3 the view keeps the newest lines and counts the rest', view.lines.join(',') === 'line 5,line 6,line 7,line 8,line 9' && view.omitted === 7)
  check('3 the row count matches the view (header + lines)', liveOutputRows(lines(1, 9), 3, 5) === 6 && liveOutputRows('a\nb\n', 0, 5) === 2 && liveOutputRows('a\nb\n', 1, 5) === 3 && liveOutputRows(undefined, 0, 5) === 0)
  check('3 a clean line keeps indentation', cleanOutputLine('    at foo (x.ts:1)') === '    at foo (x.ts:1)')
  check('3 fitting keeps a line that fits untouched', fitOutputLine('short', 10) === 'short' && fitOutputLine('exactly10!', 10) === 'exactly10!' && fitOutputLine('elevenchars', 10) === 'elevencha…')
}

// ── 4. end to end in Chat ───────────────────────────────────────────────
async function chatScenario(cols: number, fullscreen: boolean): Promise<void> {
  const rows = 30
  const io = terminal(cols, rows)
  const listeners = new Set<() => void>()
  const transcript: ChatRow[] = [
    { id: 1, kind: 'user', text: 'run the tests' },
  ]
  const channel: Record<string, unknown> = {
    whaleIdle: false,
    version: 0, rows: transcript, status: 'running', sessionTitle: 'live', agentId: 'live',
    model: 'gpt-test', provider: 'test', reasoningEffort: 'low', effortLevels: [],
    tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
    working: true, spinnerMode: 'tool-use', responseChars: 0, activeToolCount: 1, turnStart: Date.now(),
    pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: 'run the tests',
    scrollGutter: 'timeline',
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => undefined, cancel: () => undefined, clear: () => undefined, notify: () => () => undefined,
    listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => undefined, loadOlder: () => 0, mcpStatus: () => [], pushLocal: () => undefined,
    commandCompletions: (input: string) => completeCommands(input),
  }
  const emit = (): void => { (channel.version as number)++; for (const listener of listeners) listener() }
  const tree = fullscreen
    ? React.createElement(AlternateScreen, null, React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), fullscreen: true }))
    : React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore() })
  const app = await render(tree, { stdout: io.stdout as never, stdin: io.stdin as never, stderr: io.stderr as never, exitOnCtrlC: false, patchConsole: false })
  const text = (): string => io.screenLines().join('\n')
  const label = `${fullscreen ? 'fullscreen' : 'inline'}@${cols}`
  await settle(() => text().includes('run the tests'))

  const tool = runningTool('')
  const toolRow: ChatRow = { id: 2, kind: 'tool', text: '', tool: { ...tool } }
  transcript.push(toolRow)
  transcript.push({ id: 3, kind: 'notice', text: 'BELOW-MARKER' })
  emit()
  await settle(() => text().includes('npm test'))
  const want = fullscreen ? 8 : 5
  let total = 0
  for (let chunk = 0; chunk < 6; chunk += 1) {
    const add = chunk === 5 ? 20 : 2
    toolRow.tool!.liveOutput = `${toolRow.tool!.liveOutput ?? ''}${lines(total + 1, total + add, 'out')}`
    total += add
    emit()
    const newest = `out ${total}`
    await settle(() => text().includes(newest))
  }
  const screenNow = io.screenLines()
  const shownOut = screenNow.filter(line => /out \d+/u.test(line)).length
  check(`4 ${label}: the card follows the tail (newest ${want} lines)`, shownOut === want && text().includes(`out ${total}`) && !text().includes(`out ${total - want}\n`), `${shownOut} shown\n${text()}`)
  check(`4 ${label}: the omitted header counts the rest`, text().includes(t('tool-live-omitted', { count: total - want })))
  const lastOut = screenNow.findIndex(line => line.includes(`out ${total}`))
  const below = screenNow.findIndex(line => line.includes('BELOW-MARKER'))
  check(`4 ${label}: the row below is pushed down, never overlapped`, below > lastOut && lastOut >= 0, text())
  check(`4 ${label}: no live line wraps`, screenNow.every(line => stringWidth(line.trimEnd()) <= cols))

  // The result settles the card: the tail disappears, the output of record shows.
  toolRow.tool = { ...toolRow.tool!, status: 'ok', durationMs: 900, resultView: { card: 'terminal', output: 'all 30 tests passed' } }
  delete toolRow.tool.liveOutput
  emit()
  check(`4 ${label}: the settled card drops the live tail`, await settled(() => text().includes('all 30 tests passed') && !text().includes('omitted') && !/out \d+/u.test(text())), text())
  await app.unmount()
}
for (const cols of [80, 40]) {
  await chatScenario(cols, false)
  await chatScenario(cols, true)
}

for (const line of results) console.log(line)
console.log(`\nverify-tool-live-output ${failures === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
