/**
 * Headless smoke for the double-Esc session tree: drives Chat with a fake
 * channel + REAL sessionTree model/panel, injecting keys through FakeStdin.
 * Run: npm run tree-smoke
 */
process.env.FORCE_COLOR = '3'
// The assertions below match Chinese panel chrome (个会话 / row labels), so
// pin the locale BEFORE the dynamic imports — i18n resolves DSH_TUI_LANG at
// load, and an ambient C.UTF-8/English environment must not flip them.
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { render }, { Chat }, { QuestionStore }, { ApprovalStore }, { buildSessionTree }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/sessionTree.js'),
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
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const plainText = (frames: string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

// ── Synthetic family (same shape as scripts/tree-check.ts) ──────────────
let time = 0
const ev = (type: string, seq: number, data: unknown) => ({ type, seq, time: ++time, data })
const turnStart = (seq: number, turn: number) => ev('turn/start', seq, { turn })
const userMsg = (seq: number, text: string) =>
  ev('user/message', seq, { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistantMsg = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/message', seq, { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const turnEnd = (seq: number, turn: number, reason: object) => ev('turn/end', seq, { turn, reason })

const A = [
  turnStart(0, 0), userMsg(1, 'first question'), assistantMsg(2, 0, 0, 'answer one'), turnEnd(3, 0, { kind: 'completed' }),
  turnStart(4, 1), userMsg(5, 'second question'), assistantMsg(6, 1, 0, 'answer two'), turnEnd(7, 1, { kind: 'completed' }),
  turnStart(8, 2), userMsg(9, 'third question'), assistantMsg(10, 2, 0, 'answer three'), turnEnd(11, 2, { kind: 'completed' }),
]
const B = [
  ...A.slice(0, 8),
  turnStart(8, 2), userMsg(9, 'retry third question'), assistantMsg(10, 2, 0, 'answer three retry'), turnEnd(11, 2, { kind: 'completed' }),
]
const family = [
  { id: 'sess-a', createdAt: 1, events: A, live: false },
  { id: 'sess-b', createdAt: 2, parentSession: 'sess-a', seedLength: 8, events: B, live: true },
] as never
const treeData = buildSessionTree(family, 'sess-b')

// ── Fake channel ─────────────────────────────────────────────────────────
const notifications: string[] = []
const rewindCalls: Array<[string, number]> = []
// Mutable impl delegates: phases swap behavior (deferred / rejecting rewind,
// deep-family tree) without assigning to the never-typed channel literal.
let rewindImpl: (sessionId: string, seq: number) => Promise<string> = (sessionId, seq) => {
  rewindCalls.push([sessionId, seq])
  return Promise.resolve('retry third question')
}
let treeImpl: () => Promise<unknown> = () => Promise.resolve(treeData)
const channel = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'sess-b',
  model: 'deepseek-v4-flash',
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/probe',
  displayCwd: '/tmp/probe',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: 0,
  lastUserText: '',
  pending: [],
  commandList: [],
  notifications: [],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: (text: string) => { notifications.push(text) },
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  buildSessionTree: () => treeImpl(),
  rewindToNode: (sessionId: string, seq: number) => rewindImpl(sessionId, seq),
} as never

let failures = 0
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) { failures++; console.log(`FAIL ${name}`, detail ?? '') }
  else console.log(`ok   ${name}`)
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Any rejection escaping performTreeRewind's catch lands here and fails the run.
let unhandled: unknown = null
process.on('unhandledRejection', reason => { unhandled = reason })

const stdout = new FakeStdout()
// Phase 1 needs headroom: the OverlayAbove panel (title + subtitle + window)
// must fit between the startup banner and the frame top without top-clipping.
stdout.rows = 40
const stdin = new FakeStdin()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} approvalStore={new ApprovalStore()} onExit={() => {}} />,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await sleep(600)

// Double-Esc on the empty input opens the tree (async load).
stdin.write('\x1b')
await sleep(150)
stdin.write('\x1b')
await sleep(400)
let plain = plainText(stdout.frames)
check('tree opens on double-Esc', plain.includes('会话树'))
check('entries render with kind prefixes', plain.includes('user:') && plain.includes('assistant:'))
check('active path marker', plain.includes('•'))
check('branch connector', plain.includes('├─'))
check('subtitle counts sessions', plain.includes('2 个会话'), plain.match(/会话树[^\n]*/)?.[0])
check('dead branch tail visible', plain.includes('third question'))

// Cursor starts on the live tip (answer three retry, last row of B).
check('cursor on live tip', plain.includes('❯') )

// ctrl+o cycles the filter to no-tools.
stdin.write('\x0f')
await sleep(250)
plain = plainText(stdout.frames)
check('ctrl+o cycles filter', plain.includes('无工具'), plain.match(/过滤：[^ ·]*/)?.[0])

// From here on, slice frames per step — the differential renderer keeps
// stale text in the full history, so absence checks need fresh frames only.
// Type-to-search narrows the list.
let mark = stdout.frames.length
stdin.write('retry')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('search query line', plain.includes('搜索：retry') || plain.includes('retry'))
check('search narrows (first question hidden)', !plain.includes('first question'))

// Esc clears the query first, then closes.
mark = stdout.frames.length
stdin.write('\x1b')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
// The diff slice repaints changed rows only — the unchanged title is absent
// from it, so assert the panel via its rows and the query line via absence.
check('Esc clears query only', plain.includes('user:') && !plain.includes('搜索：'))

// CSI-u / modifyOtherKeys terminals deliver Shift+Enter as key.return with
// the literal input "return": it fails plainReturn (no confirm), and must not
// be typed into the search either — the tree's letter guard excludes
// key.return exactly like the session browser's does.
mark = stdout.frames.length
stdin.write('\x1b[13;2u') // CSI-u Shift+Enter
await sleep(200)
stdin.write('third')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check(
  'Shift+Enter leaves no "return" in the search query',
  plain.includes('搜索：third') && !plain.includes('return'),
  plain.match(/搜索：[^\n]*/)?.[0],
)
stdin.write('\x1b') // clear the probe query; the next Esc below closes
await sleep(200)
mark = stdout.frames.length
stdin.write('\x1b')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('second Esc closes', !plain.includes('会话树'))

// Reopen, move up to the fork's user message, Enter → confirm, Enter → rewind.
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
stdin.write('\x1b[A') // up: answer three retry → retry third question
await sleep(200)
mark = stdout.frames.length
stdin.write('\r')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('confirm panel', plain.includes('回退到此处？'), plain.match(/回退[^\n]*/)?.[0])
mark = stdout.frames.length
stdin.write('\r')
await sleep(300)
plain = plainText(stdout.frames.slice(mark))
check('rewindToNode called with fork point', JSON.stringify(rewindCalls) === JSON.stringify([['sess-b', 9]]), rewindCalls)
check('rewound notification', notifications.some(n => n.includes('已回退')), notifications)
check('panel closed after rewind', !plain.includes('会话树'))

// ── Rewinding seat: keys are swallowed until the swap settles ───────────
let releaseRewind: ((text: string) => void) | null = null
rewindImpl = (sessionId: string, seq: number) => {
  rewindCalls.push([sessionId, seq])
  return new Promise<string>(resolve => { releaseRewind = resolve })
}
// The phase-1 rewind refilled the prompt; a single Esc clears non-empty
// input (PromptInput.tsx:701), then double-Esc opens the tree.
stdin.write('\x1b')
await sleep(250)
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
stdin.write('\r') // Enter on the live tip → confirm panel
await sleep(250)
mark = stdout.frames.length
stdin.write('\r') // confirm → rewind in flight (deferred)
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('rewinding seat while swap in flight', plain.includes('正在回退并分叉…'), plain.match(/回退[^\n]*/)?.[0])
stdin.write('\x1b') // Esc must NOT close the seat mid-swap
stdin.write('x')    // printable keys must NOT reach the prompt
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('Esc swallowed during rewind', plain.includes('正在回退并分叉…'))
mark = stdout.frames.length
releaseRewind!('retry third question (edited)') // fresh string — an identical refill would not re-apply
await sleep(300)
plain = plainText(stdout.frames.slice(mark))
check('panel closes after swap settles', !plain.includes('正在回退并分叉…') && !plain.includes('回退到此处？'))

// ── A rejecting rewind reports instead of dying unhandled ───────────────
rewindImpl = () => Promise.reject(new Error('boom'))
// The released rewind refilled the prompt again — clear, then reopen.
stdin.write('\x1b')
await sleep(250)
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
stdin.write('\r') // Enter on the live tip → confirm panel
await sleep(250)
mark = stdout.frames.length
stdin.write('\r') // confirm → the rewind rejects
await sleep(300)
plain = plainText(stdout.frames.slice(mark))
check('rejected rewind notifies', notifications.some(n => n.includes('回退失败') && n.includes('boom')), notifications.slice(-2))
check('panel closes after rejection', !plain.includes('正在回退并分叉…') && !plain.includes('回退到此处？'))

// ── First-turn entries refuse the rewind before the confirm seat ────────
// The prompt is empty again (a rejection restores nothing), so double-Esc
// reopens directly. PgUp jumps a full window from the live tip to row 0 —
// sess-a's 'first question', the turn-0 USER entry of a complete
// (untruncated) log.
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
stdin.write('\x1b[5~') // PgUp → first row
await sleep(250)
mark = stdout.frames.length
stdin.write('\r')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('first-turn Enter refused with reason',
  notifications.some(n => n.includes('无法回退到第一条消息之前')), notifications.slice(-2))
check('first-turn refusal skips the confirm seat', !plain.includes('回退到此处？'))
mark = stdout.frames.length
stdin.write('\x1b')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('tree stayed open after refusal, Esc closes', !plain.includes('会话树'))

// ── Drop-turn warning + ctrl+b branch adopt ─────────────────────────────
// A dead branch whose ENTIRE own content is one turn: Enter on its head
// user message must spell out the drop (and warn that the branch vanishes
// from the fork); ctrl+b is the keep-everything switch to the branch tip.
// sess-y mirrors sess-x but without tailComplete — no adopt target, no
// coverage claim.
const X = [
  ...A.slice(0, 8),
  turnStart(8, 2), userMsg(9, 'solo branch question'), assistantMsg(10, 2, 0, 'solo branch answer'), turnEnd(11, 2, { kind: 'completed' }),
]
const adoptFamily = [
  { id: 'sess-a', createdAt: 1, events: A, live: false },
  { id: 'sess-b', createdAt: 2, parentSession: 'sess-a', seedLength: 8, events: B, live: true },
  { id: 'sess-x', createdAt: 3, parentSession: 'sess-a', seedLength: 8, events: X, live: false, tailComplete: true },
  { id: 'sess-y', createdAt: 4, parentSession: 'sess-a', seedLength: 8, events: X.map(e => ({ ...e })), live: false },
] as never
treeImpl = () => Promise.resolve(buildSessionTree(adoptFamily, 'sess-b'))
rewindImpl = (sessionId, seq) => { rewindCalls.push([sessionId, seq]); return Promise.resolve('') }
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
// Rows: a:1 a:2 a:5 a:6, b:9 b:10 (active first), a:9 a:10, x:9 x:10, y:9 y:10.
// Cursor starts on the live tip (b:10, row 5); ↓×3 lands on x:9.
stdin.write('\x1b[B')
await sleep(120)
stdin.write('\x1b[B')
await sleep(120)
stdin.write('\x1b[B')
await sleep(200)
mark = stdout.frames.length
stdin.write('\r') // Enter on the branch's head user message → confirm
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('user pick spells out the drop', plain.includes('将丢弃这条消息所在的整轮'), plain.match(/回退到此处[^\n]*\n[^\n]*/)?.[0])
check('drop-turn warning for single-turn branch', plain.includes('此分支的内容都在这一轮内'))
check('cross-session line names the branch', plain.includes('分叉自会话 sess-x'), plain.match(/分叉自[^\n]*/)?.[0])
stdin.write('\x1b') // back out of the confirm seat
await sleep(250)
mark = stdout.frames.length
stdin.write('\x02') // ctrl+b → adopt confirm
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('ctrl+b asks to switch branches', plain.includes('切换到该分支？'), plain.match(/切换[^\n]*/)?.[0])
check('adopt promises full content', plain.includes('保留该分支的全部内容'))
mark = stdout.frames.length
stdin.write('\r') // confirm → adopt forks at the branch tip (turn/end@11)
await sleep(300)
plain = plainText(stdout.frames.slice(mark))
check('adopt rewinds to the branch tip', rewindCalls.some(c => c[0] === 'sess-x' && c[1] === 11), rewindCalls)
check('adopt notification', notifications.some(n => n.includes('已切到该分支')), notifications.slice(-2))
check('panel closed after adopt', !plain.includes('会话树'))

// ctrl+b on a tail-cut branch refuses with the reason; Enter shows no
// coverage claim either (its unseen tail may hold more turns).
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
stdin.write('\x1b[B') // live tip → a:9
await sleep(120)
stdin.write('\x1b[B') // → a:10
await sleep(120)
stdin.write('\x1b[B') // → x:9
await sleep(120)
stdin.write('\x1b[B') // → x:10
await sleep(120)
stdin.write('\x1b[B') // → y:9 (same shape as x:9, but tail-incomplete)
await sleep(200)
mark = stdout.frames.length
stdin.write('\x02')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('ctrl+b refused on tail-cut branch', notifications.some(n => n.includes('内容未完整加载')), notifications.slice(-2))
check('no adopt confirm for tail-cut branch', !plain.includes('切换到该分支？'))
stdin.write('\r') // Enter on y:9 → confirm WITHOUT the coverage warning
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('tail-cut branch gets no coverage claim', plain.includes('回退到此处？') && !plain.includes('此分支的内容都在这一轮内'),
  plain.match(/注意[^\n]*/)?.[0])
stdin.write('\x1b') // out of confirm
await sleep(200)
mark = stdout.frames.length
stdin.write('\x1b') // close the tree
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('Esc closes after adopt probes', !plain.includes('会话树'))
// Later phases drive the original two-session family again.
treeImpl = () => Promise.resolve(treeData)
rewindImpl = (sessionId, seq) => { rewindCalls.push([sessionId, seq]); return Promise.resolve('retry third question') }

// ── A turn-0 ASSISTANT entry is NOT first-message-refused ───────────────
// firstTurn marks every entry of the log's own first turn, but only its USER
// message is unrewindable (dropping turn 0 needs boundary -1). An assistant
// answer keeps turn 0 whole (boundary = turn 0's closing turn/end), so Enter
// must reach the confirm seat instead of the refusal notify.
stdin.write('\x1b')
await sleep(120)
stdin.write('\x1b')
await sleep(400)
stdin.write('\x1b[5~') // PgUp → row 0: sess-a 'first question'
await sleep(250)
stdin.write('\x1b[B') // Down → row 1: sess-a 'answer one' (turn-0 assistant)
await sleep(250)
mark = stdout.frames.length
const notifyMark = notifications.length
stdin.write('\r')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('turn-0 assistant reaches the confirm seat', plain.includes('回退到此处？'), plain.match(/回退[^\n]*/)?.[0])
check('turn-0 assistant not refusal-notified',
  !notifications.slice(notifyMark).some(n => n.includes('无法回退到第一条消息之前')))
// Esc backs out of the confirm seat into the tree; a second Esc closes it.
stdin.write('\x1b')
await sleep(250)
mark = stdout.frames.length
stdin.write('\x1b')
await sleep(250)
plain = plainText(stdout.frames.slice(mark))
check('tree closed after confirm cancel', !plain.includes('会话树'))

await instance.unmount()

// ── Narrow terminals: every logical row stays on one physical line ──────
// The OverlayAbove panel rewrites existing frame rows in place instead of
// growing the frame, and the animated banner keeps re-emitting its rows —
// raw-write offset math says nothing about the final screen. These phases
// therefore assert on a headless xterm's buffer (the real terminal state).
const { Terminal: XTerm } = await import('@xterm/headless')
const { stringWidth } = await import('../src/ink/stringWidth.js')

class XtermStdout extends Writable {
  isTTY = true
  term: InstanceType<typeof XTerm>
  constructor(public columns: number, public rows: number) {
    super()
    this.term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.term.write(String(chunk), callback)
  }
  /** Final screen, trailing whitespace stripped, blank lines dropped. */
  screenLines(): string[] {
    const out: string[] = []
    const buffer = this.term.buffer.active
    for (let i = 0; i < buffer.length; i++) {
      out.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return out.map(l => l.replace(/\s+$/g, '')).filter(l => l !== '')
  }
}

const openTreeIn = async (out: XtermStdout) => {
  const input = new FakeStdin()
  const app = await render(
    <Chat channel={channel} questionStore={new QuestionStore()} approvalStore={new ApprovalStore()} onExit={() => {}} />,
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(600)
  input.write('\x1b')
  await sleep(150)
  input.write('\x1b')
  await sleep(400)
  return app
}

/** Panel window rows on the final screen. On a short fresh frame the
 *  overlay extends past the frame top (title/subtitle/position may never
 *  hit the wire — accepted OverlayAbove behavior, same as /model on an
 *  empty transcript), so exact title/rows/position composition is NOT
 *  asserted here; the durable invariants live on the rows themselves:
 *  every visible row is one physical line, within the column budget,
 *  prefixes clamped. (Window composition is pure model — tree-check.ts.) */
const panelRows = (screen: string[], marker: RegExp) => screen.filter(l => marker.test(l))

// ── 40 cols, small family: subtitle → 8 rows → position ────────────────
treeImpl = () => Promise.resolve(treeData)
const narrowOut = new XtermStdout(40, 40)
const narrow = await openTreeIn(narrowOut)
const narrowScreen = narrowOut.screenLines()
const narrowRowMarker = /[│├└•]|user:|assistant:/
const narrowRows = panelRows(narrowScreen, narrowRowMarker)
check('narrow: tree rows on screen', narrowRows.length === 8,
  `rows=${narrowRows.length} screen=${JSON.stringify(narrowScreen.slice(-4))}`)
check('narrow: no line exceeds 40 cells',
  narrowScreen.every(l => stringWidth(l) <= 40),
  narrowScreen.filter(l => stringWidth(l) > 40).map(l => JSON.stringify(l)))
await narrow.unmount()

// ── Deep family at 40 cols: clamped prefixes keep one line per row ──────
// 12 sessions, each seeded from its parent's log minus the parent's last
// turn (the rewound tail), then two own turns — so every fork anchor lands
// in the parent's OWN entries with the tail as sibling branch and nesting
// actually deepens. The cursor-centered window lands on the deepest rows
// (indents up to 20, i.e. 60-cell prefixes) which used to wrap every deep
// row into two physical lines even though no single segment overflowed.
const turn = (seq: number, n: number, tag: string) => [
  turnStart(seq, n), userMsg(seq + 1, `${tag} q${n}`), assistantMsg(seq + 2, n, 0, `${tag} a${n}`), turnEnd(seq + 3, n, { kind: 'completed' }),
]
const deepSessions: Array<Record<string, unknown>> = []
for (let i = 0; i < 12; i++) {
  const parent = deepSessions[i - 1]
  const parentEvents = parent === undefined ? [] : (parent['events'] as unknown[])
  const seed = parent === undefined ? [] : parentEvents.slice(0, parentEvents.length - 4)
  // The root's two own turns start after its base turn; forked sessions
  // start right after the seed prefix. Seqs stay unique within each log.
  const base = parent === undefined ? 4 : seed.length
  const ownA = turn(base, base / 4, `s${i}A`)
  const ownB = turn(base + 4, base / 4 + 1, `s${i}B`)
  deepSessions.push({
    id: `deep-${i}`,
    createdAt: i + 1,
    ...(parent !== undefined ? { parentSession: `deep-${i - 1}`, seedLength: seed.length } : {}),
    events: i === 0 ? [...turn(0, 0, 'root'), ...ownA, ...ownB] : [...seed, ...ownA, ...ownB],
    live: i === 11,
  })
}
treeImpl = () => Promise.resolve(buildSessionTree(deepSessions as never, 'deep-11'))
const deepOut = new XtermStdout(40, 40)
const deep = await openTreeIn(deepOut)
const deepScreen = deepOut.screenLines()
const deepRows = panelRows(deepScreen, narrowRowMarker)
check('deep narrow: window rows on screen', deepRows.length > 0,
  `rows=${deepRows.length} tail=${JSON.stringify(deepScreen.slice(-6))}`)
check('deep narrow: no row exceeds 40 cells',
  deepScreen.every(l => stringWidth(l) <= 40),
  deepScreen.filter(l => stringWidth(l) > 40).map(l => JSON.stringify(l)))
check('deep narrow: deep prefixes clamp with …',
  deepRows.some(l => /^\s*❯?\s*…/.test(l)),
  deepRows.slice(0, 2))
await deep.unmount()

// ── Minimal mode (20 cols): the widest fixed combination never wraps ────
// Below ~28 cols the clamped fixed run (• + [label] + 'assistant: ' + a
// 3-cell prefix) plus the minimal body still overflows, so TreeRow joins the
// fixed segments into ONE dim string cut from the left. Rows are identified
// by what survives: '•', the '…' cut marker, or a short 'user:' prefix.
treeImpl = () => Promise.resolve(treeData)
const tinyOut = new XtermStdout(20, 40)
const tiny = await openTreeIn(tinyOut)
const tinyScreen = tinyOut.screenLines()
// Anchor the marker at the row start: the 20-col subtitle truncates to a
// '…'-bearing line ('当前目录 · 2 个…') and must not count as a tree row.
const tinyRowMarker = /^\s*❯?\s*[…•]|user:/
const tinyRows = panelRows(tinyScreen, tinyRowMarker)
check('tiny: tree rows on screen', tinyRows.length === 8,
  `rows=${tinyRows.length} screen=${JSON.stringify(tinyScreen.slice(-4))}`)
check('tiny: no panel line exceeds 20 cells',
  tinyScreen.every(l => stringWidth(l) <= 20),
  tinyScreen.filter(l => stringWidth(l) > 20).map(l => JSON.stringify(l)))
await tiny.unmount()

check('no unhandled rejections', unhandled === null, unhandled)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
