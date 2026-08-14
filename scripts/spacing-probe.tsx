/**
 * Spacing/visual-distinction probe: renders a transcript with user prompt,
 * thinking, tool call and assistant text rows, then asserts the Claude Code
 * separations:
 *   1. Every block is separated by a blank line (CC addMargin on every row).
 *   2. User prompt carries the userMessageBackground grey (`48;2;55,55,55`).
 *   3. Thinking label + body are dim+italic (grey).
 * Run: node --import tsx scripts/spacing-probe.tsx (Windows side)
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { render }, { Chat }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
])

class FakeStdout extends Writable {
  columns = 120
  // Tall enough that the whale header + transcript + footer all fit without
  // the sticky scroll pushing the header out of the viewport.
  rows = 40
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
    { id: 0, kind: 'user', text: 'hello, list the files' },
    { id: 1, kind: 'reasoning', text: 'the user wants a file listing', streaming: false, durationMs: 12000 },
    { id: 2, kind: 'tool', text: '', tool: { callId: 'c1', name: 'Bash', argsText: '{"command":"ls"}', argsFull: '{"command":"ls"}', status: 'ok', resultText: 'src\nlib', durationMs: 8000 } },
    // Assistant reply starts with the working-activity ⏵ self-narration
    // line (narrate contract) — the transcript must strip it.
    { id: 3, kind: 'assistant', text: '⏵ 修一下状态栏\nhere are the files.', streaming: false },
  ],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  tokens: { input: 120, output: 45 },
  contextWindow: 1000000,
  reasoningEffort: 'max',
  workingActivity: { phase: 'tool', line: '正在查看 src/channel.ts · 总12s', toolCount: 2, turnElapsedMs: 12000 },
  activityFrames: 'claude',
  contextBarEnabled: true,
  lastUsage: { input: 12000, output: 356, cacheRead: 3400, cacheWrite: 1200 },
  tps: 42,
  tpsSamples: [
    { tps: 30, at: Date.now() - 50000 },
    { tps: 45, at: Date.now() - 40000 },
    { tps: 38, at: Date.now() - 30000 },
    { tps: 52, at: Date.now() - 20000 },
    { tps: 47, at: Date.now() - 10000 },
  ],
  contextSegments: { system: 3000, prompt: 4000, assistant: 5000, thinking: 2000, tools: 2000 },
  cwd: 'C:/code/demo-project',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: 'hello, list the files',
  notifications: [],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
} as never

const stdout = new FakeStdout()
const instance = await render(<Chat channel={channel} />, {
  stdout,
  stdin: new FakeStdin(),
  stderr: new FakeStderr(),
  exitOnCtrlC: false,
  patchConsole: false,
})

await new Promise(resolve => setTimeout(resolve, 600))

const output = stdout.frames.join('')
// Normalize differential cursor-right moves to spaces, then strip ANSI.
const cursorMoved = output.replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
const plain = cursorMoved
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
const lines = plain.split('\n').map(l => l.trimEnd())
const contentLines = lines.map(l => l.trim())

const results: string[] = []
let pass = 0
function check(name: string, ok: boolean, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass++
}

// 1. Every block separated by a blank line: the four marker lines must be
//    pairwise separated by >= 1 empty line in the rendered transcript.
const markers = ['hello, list the files', '∴ Thinking', 'Bash', 'here are the files.']
const markerLines = markers.map(m => contentLines.findIndex(l => l.includes(m)))
for (let i = 1; i < markerLines.length; i++) {
  const gap = markerLines[i]! - markerLines[i - 1]!
  const between = contentLines.slice(markerLines[i - 1]! + 1, markerLines[i]!)
  const blankCount = between.filter(l => l.length === 0).length
  check(
    `blank line between block ${i - 1} and ${i}`,
    blankCount >= 1,
    `markerLines ${markerLines[i - 1]} -> ${markerLines[i]}, blanks=${blankCount}`,
  )
}

// 2. User prompt carries the grey bubble background.
check(
  'user prompt grey background',
  cursorMoved.includes('\x1b[48;2;55;55;55m'),
  '48;2;55;55;55 present in user bubble region',
)

// 3. Thinking label is grey + italic (the theme's `inactive` grey is how
//    dimColor renders in this truecolor palette — no SGR-dim is emitted).
check('thinking dim', cursorMoved.includes('\x1b[38;2;153;153;153m'), 'inactive-grey SGR present')
check('thinking italic', cursorMoved.includes('\x1b[3m'), 'italic SGR present')

// 4. Tool card present.
check('tool card rendered', contentLines.some(l => l.includes('Bash') && l.includes('ls')), 'Bash("ls") card')

// 5. Tool card carries the settled duration on the header.
check(
  'tool duration on header',
  contentLines.some(l => l.includes('Bash') && l.includes('· 8s')),
  'Bash(...) · 8s',
)

// 6. Thinking duration on the folded label.
check(
  'thinking duration on folded label',
  contentLines.some(l => l.includes('∴ Thinking') && l.includes('12s')),
  '∴ Thinking · 12s (ctrl+o expand)',
)

// 7. Terminal tab title carries the ✦ prefix + DeepSeek whale (win32 path
//    writes process.title).
check('title whale prefix', process.title.includes('✦') && process.title.includes('🐋'), process.title)

// 7b. Header splash: pixel whale (half-block glyphs over the DeepSeek-blue
//     body color), shimmer tagline, model · effort line, cwd, welcome line.
check(
  'header pixel whale',
  cursorMoved.includes('▀') && cursorMoved.includes('48;2;78;111;255'),
  'half-block whale rows with DeepSeek-blue body',
)
check(
  'header tagline',
  contentLines.some(l => l.includes('█▀▀▀▄')),
  'big block-font tagline rows',
)
check(
  'header model effort',
  contentLines.some(l => l.includes('deepseek-v4-flash') && l.includes('Max effort')),
  'model · Max effort row',
)
check(
  'header cwd',
  contentLines.some(l => l.includes('C:/code/demo-project')),
  'cwd row',
)
check(
  'header welcome',
  contentLines.some(l => l.includes('探索未至之境')),
  '探索未至之境！',
)
check(
  'header tip line',
  contentLines.some(l => l.includes('Tip:') && l.includes('/model')),
  'tip under the cwd row',
)

// 8. Status line metrics (pi-bar style): pressure percent/window, think
//    level, cache hits, tps gauge/sparkline. The header also mentions the
//    model id, so pin the footer row by its `in→out` token arrow.
const statusLine = contentLines.find(l => l.includes('deepseek-v4-flash') && l.includes('→')) ?? ''
check('statusline think level', statusLine.includes('max') && !statusLine.includes('think:max'), 'bare effort level (no think: prefix)')
check('statusline cache', statusLine.includes('cache 20.5%'), 'cache hit rate, one decimal (3400/16600)')
check('statusline tps single value', statusLine.includes('tps') && !statusLine.includes('μ') && !statusLine.includes('p95'), `sparkline + one tps number (got: ${statusLine})`)
check('statusline sparkline blocks', /[▁▂▃▄▅▆▇█]/.test(cursorMoved), 'sparkline glyphs present')
check('statusline speed color', cursorMoved.includes('\x1b[38;2;202;138;4m') || cursorMoved.includes('\x1b[38;2;78;186;101m'), 'warning/success tps color')
// 9. Segmented context bar (pi-nano-context algorithm, DeepSeek palette) on
//    its own first footer row.
check('context bar bg segments', /48;2;(34|43|52|77|90);\d+;\d+m/.test(cursorMoved), 'DeepSeek-blue segment backgrounds')
check('context bar usage readout', cursorMoved.includes('ctx ') && cursorMoved.includes('/1.0M'), 'free-segment usage text')

// 10. Working-activity line (dsh-working-activity integration): the live
//     line renders on the status row with the hint still visible, and the
//     ⏵ self-narration first line is stripped from the transcript body.
check(
  'activity line in status',
  contentLines.some(l => l.includes('正在查看 src/channel.ts')),
  'live working line on the status row',
)
check(
  'activity + hint side by side',
  contentLines.some(l => l.includes('正在查看 src/channel.ts') && l.includes('? for shortcuts')),
  'hint stays visible beside the activity line',
)
check(
  'activity indicator frame',
  contentLines.some(l => l.includes('正在查看 src/channel.ts') && /^[·✢*✶✻✽]/.test(l)),
  'indicator frame leads the activity line (claude preset)',
)
check(
  'activity no warn at low usage',
  !contentLines.some(l => l.includes('⚠')),
  'no context warning below 80%',
)
check(
  'narration stripped from body',
  !contentLines.some(l => l.includes('⏵ 修一下状态栏')),
  '⏵ first line removed from the assistant transcript',
)

console.log(results.join('\n'))
console.log(`--- ${pass}/${results.length} passed ---`)
if (pass < results.length) {
  console.log('--- transcript (plain, trimmed) ---')
  console.log(contentLines.slice(0, 40).join('\n'))
  // Raw frames around the user row to diagnose missing background.
  const idx = cursorMoved.indexOf('hello, list the files')
  if (idx >= 0) {
    console.log('RAW CTX ' + JSON.stringify(cursorMoved.slice(Math.max(0, idx - 120), idx + 260)))
  } else {
    console.log('RAW CTX: user text not found in raw frames')
  }
}

await instance.unmount()
await instance.waitUntilExit()
process.exit(pass === results.length ? 0 : 1)
