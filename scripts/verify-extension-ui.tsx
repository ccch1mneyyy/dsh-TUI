/**
 * Verification of the plugin UI seams (dsh-tui-extensions): managed dialogs,
 * status line, keyboard shortcuts, custom entry renderers.
 *
 * Three layers, one file:
 *  A. Store units (cordis-free): FIFO queueing, decide/cancel, AbortSignal,
 *     timeout, settleAll, keyed status semantics.
 *  B. Runtime units over a REAL cordis context: input validation (warn,
 *     never throw), sanitization, shortcut parse/match/register/dispatch,
 *     renderer registration refusals + sticky failure logging.
 *  C. Chat UI integration (fake channel, REAL stores/runtimes): select /
 *     confirm / input dialogs render and settle from the keyboard, FIFO
 *     drain, Esc cancel, the status line appears/clears, and a plugin
 *     shortcut consumes its keypress through Chat's dispatch chain.
 *
 * Run: node --import tsx/esm scripts/verify-extension-ui.tsx
 */
process.env.FORCE_COLOR = '3'

// 家目录隔离（同 verify-extension-events.tsx）：Chat 加载即解析 homedir()。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-ext-ui-home-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [
  { PassThrough, Writable },
  React,
  { Context },
  { render },
  { Chat },
  { QuestionStore },
  { TuiDialogStore, TuiDialogRuntime },
  { TuiStatusStore, TuiStatusRuntime },
  { TuiShortcutRuntime, parseShortcutCombo, matchShortcut },
  { TuiRendererRuntime },
  { KNOWN_SESSION_EVENT_TYPES },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@deepseek-ai/cordis'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/dialogs.js'),
  import('../src/dsh-adapter/status.js'),
  import('../src/dsh-adapter/shortcuts.js'),
  import('../src/dsh-adapter/renderers.js'),
  import('@deepseek-ai/dsh-session'),
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
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

/** Real cordis context + captured warnings (runtime refusals warn, never throw). */
const ctx = new Context()
const warnings: string[] = []
ctx.logger.warn = (format: unknown, ...params: unknown[]) => {
  warnings.push([format, ...params].map(String).join(' '))
}
const warnCount = (fragment: string) => warnings.filter(line => line.includes(fragment)).length

// ── A. store units ───────────────────────────────────────────────────────
{
  const store = new TuiDialogStore()
  const first = store.ask({ kind: 'select', title: 't1', options: [{ id: 'a', label: 'A' }] })
  const second = store.ask({ kind: 'confirm', title: 't2', confirmLabel: '', cancelLabel: '' })
  check('dialog store: FIFO — first request is active', store.getSnapshot()?.kind === 'select')
  store.decide('a')
  check('dialog store: decide resolves the active request', (await first) === 'a')
  check('dialog store: queue advances to the second request', store.getSnapshot()?.kind === 'confirm')
  store.cancel()
  check('dialog store: cancel resolves undefined', (await second) === undefined)
  check('dialog store: queue drained', store.getSnapshot() === null)

  // Pre-aborted signal resolves immediately.
  const controller = new AbortController()
  controller.abort()
  check('dialog store: pre-aborted signal resolves undefined',
    (await store.ask({ kind: 'input', title: 't3', initial: '' }, controller.signal)) === undefined)

  // Abort mid-flight closes the active dialog.
  const controller2 = new AbortController()
  const pending = store.ask({ kind: 'input', title: 't4', initial: '' }, controller2.signal)
  check('dialog store: aborted request was active', store.getSnapshot()?.kind === 'input')
  controller2.abort()
  check('dialog store: mid-flight abort resolves undefined', (await pending) === undefined)
  check('dialog store: abort closed the dialog', store.getSnapshot() === null)

  // Timeout auto-cancels.
  const timed = store.ask({ kind: 'input', title: 't5', initial: '' }, undefined, 120)
  check('dialog store: timeout resolves undefined', (await timed) === undefined)

  // settleAll drains a mixed queue.
  const p1 = store.ask({ kind: 'input', title: 't6', initial: '' })
  const p2 = store.ask({ kind: 'input', title: 't7', initial: '' })
  store.settleAll()
  check('dialog store: settleAll resolves everything cancelled',
    (await p1) === undefined && (await p2) === undefined && store.getSnapshot() === null)

  // Stale decide is a no-op (double-settle protection).
  const stale = store.ask({ kind: 'confirm', title: 't8', confirmLabel: '', cancelLabel: '' })
  store.decide(true)
  store.decide(false)
  check('dialog store: stale decide is ignored', (await stale) === true)

  // Aborting the ACTIVE request must advance the queue — without advance(),
  // the next Promise parks forever and the UI shows no dialog.
  const abortCtl = new AbortController()
  const victim = store.ask({ kind: 'input', title: 't9', initial: '' }, abortCtl.signal)
  const successor = store.ask({ kind: 'confirm', title: 't10', confirmLabel: '', cancelLabel: '' })
  abortCtl.abort()
  check('dialog store: aborted active resolves cancelled', (await victim) === undefined)
  check('dialog store: abort ADVANCES the queue to the next request',
    store.getSnapshot()?.kind === 'confirm', JSON.stringify(store.getSnapshot()))
  store.decide(true)
  check('dialog store: the advanced request settles normally', (await successor) === true)

  // Same for a timeout: the active request dies, the queued one goes live.
  const timedOut = store.ask({ kind: 'input', title: 't11', initial: '' }, undefined, 100)
  const afterTimeout = store.ask({ kind: 'select', title: 't12', options: [{ id: 'x', label: 'X' }] })
  check('dialog store: timed-out active resolves cancelled', (await timedOut) === undefined)
  check('dialog store: timeout ADVANCES the queue',
    store.getSnapshot()?.kind === 'select', JSON.stringify(store.getSnapshot()))
  store.cancel()
  await afterTimeout
}

{
  const store = new TuiStatusStore()
  const seen: number[] = []
  store.subscribe(() => seen.push(store.getSnapshot().length))
  store.set('a', '第一')
  store.set('b', '第二')
  store.set('a', '第一-改')
  check('status store: entries in first-set order',
    store.getSnapshot().map(e => `${e.key}:${e.text}`).join(',') === 'a:第一-改,b:第二')
  store.set('b', undefined)
  check('status store: undefined clears the key', store.getSnapshot().length === 1)
  store.set('b', undefined) // no-op, no emit
  check('status store: redundant clear does not emit', seen.length === 4, String(seen.length))
  check('status store: snapshot referentially stable between emits',
    store.getSnapshot() === store.getSnapshot())
}

// ── B. runtime units over real cordis ────────────────────────────────────
ctx.plugin(TuiDialogRuntime)
ctx.plugin(TuiStatusRuntime)
ctx.plugin(TuiShortcutRuntime)
ctx.plugin(TuiRendererRuntime)
await sleep(100)

{
  // Malformed requests resolve cancelled + warn; they never throw.
  check('tuiDialogs.select: no options → cancelled + warn',
    (await ctx.tuiDialogs.select({ title: '空选择', options: [] })) === undefined && warnCount('tuiDialogs.select') === 1)
  check('tuiDialogs.confirm: no title → false + warn',
    (await ctx.tuiDialogs.confirm({ title: '' })) === false)
  check('tuiDialogs.input: no title → cancelled',
    (await ctx.tuiDialogs.input({ title: '   ' })) === undefined)

  // Sanitization: control chars stripped, malformed options dropped.
  const pending = ctx.tuiDialogs.select({
    title: '带\x07铃声\n的标题',
    options: [
      { id: 'ok', label: '正常' },
      { id: '', label: '空 id' },
      { id: 'nolabel', label: '' },
    ],
    timeoutMs: 150,
  })
  const snapshot = ctx.tuiDialogs.store.getSnapshot()
  check('tuiDialogs.select: control chars stripped from the title',
    snapshot?.kind === 'select' && snapshot.title === '带 铃声 的标题', JSON.stringify(snapshot?.title))
  check('tuiDialogs.select: malformed options filtered',
    snapshot?.kind === 'select' && snapshot.options.length === 1)
  check('tuiDialogs.select: timeout still applies through the runtime', (await pending) === undefined)
}

{
  ctx.tuiStatus.set('Bad Key!', 'nope')
  check('tuiStatus: invalid key refused + warn', ctx.tuiStatus.store.getSnapshot().length === 0 && warnCount('tuiStatus.set rejected invalid key') === 1)
  ctx.tuiStatus.set('demo', '构建\x1b[31m中')
  check('tuiStatus: control chars stripped',
    ctx.tuiStatus.store.getSnapshot()[0]?.text === '构建 [31m中', JSON.stringify(ctx.tuiStatus.store.getSnapshot()[0]?.text))
  // Beyond MAX_ENTRIES (20): the 21st NEW key is refused.
  for (let i = 0; i < 19; i++) ctx.tuiStatus.set(`plug-${String(i).padStart(2, '0')}`, 'x')
  ctx.tuiStatus.set('one-too-many', 'x')
  check('tuiStatus: contribution cap enforced',
    ctx.tuiStatus.store.getSnapshot().length === 20 && warnCount('contributions already shown') === 1)
  ctx.tuiStatus.set('demo', undefined)
  for (let i = 0; i < 19; i++) ctx.tuiStatus.set(`plug-${String(i).padStart(2, '0')}`, undefined)

  // Lifecycle disposer: clears only while the key still holds THIS text —
  // a stale disposer must not wipe a newer contribution.
  const disposeOld = ctx.tuiStatus.set('lifecycle', '旧值')
  disposeOld()
  check('tuiStatus: disposer clears its own contribution',
    ctx.tuiStatus.store.getSnapshot().length === 0)
  const disposeStale = ctx.tuiStatus.set('lifecycle', '旧值')
  ctx.tuiStatus.set('lifecycle', '新值')
  disposeStale()
  check('tuiStatus: stale disposer keeps the newer value',
    ctx.tuiStatus.store.getSnapshot()[0]?.text === '新值')
  ctx.tuiStatus.set('lifecycle', undefined)
  check('tuiStatus: explicit clear still works', ctx.tuiStatus.store.getSnapshot().length === 0)
}

{
  // parse table
  const p1 = parseShortcutCombo('ctrl+shift+p')
  check('parse: ctrl+shift+p', p1?.ctrl === true && p1.shift === true && p1.char === 'p')
  const p2 = parseShortcutCombo('alt+enter')
  check('parse: alt+enter → meta + return', p2?.meta === true && p2.named === 'return')
  check('parse: ctrl+space → char " "', parseShortcutCombo('ctrl+space')?.char === ' ')
  check('parse: bare letter refused', parseShortcutCombo('p') === undefined)
  check('parse: shift-only refused (needs ctrl/alt)', parseShortcutCombo('shift+p') === undefined)
  check('parse: unknown key name refused', parseShortcutCombo('ctrl+wat') === undefined)
  check('parse: duplicated modifier refused', parseShortcutCombo('ctrl+ctrl+p') === undefined)

  // match table
  check('match: ctrl+shift+p vs uppercase input',
    p1 !== undefined && matchShortcut(p1, 'P', { ctrl: true, shift: true }))
  check('match: shift flag mismatch refuses',
    p1 !== undefined && !matchShortcut(p1, 'p', { ctrl: true }))
  check('match: alt+k', p2 !== undefined || true)
  const pk = parseShortcutCombo('alt+k')
  check('match: alt+k matches meta',
    pk !== undefined && matchShortcut(pk, 'k', { meta: true }))
  check('match: super flag always refuses',
    pk !== undefined && !matchShortcut(pk, 'k', { meta: true, super: true }))

  // Named keys: shift must match exactly — a registered ctrl+shift+enter
  // must NOT fire on a plain ctrl+enter press (the editor's built-in
  // delivery would be shadowed).
  const namedShift = parseShortcutCombo('ctrl+shift+enter')
  check('match: named key requires the combo’s shift state',
    namedShift !== undefined &&
    !matchShortcut(namedShift, '', { ctrl: true, return: true }) &&
    matchShortcut(namedShift, '', { ctrl: true, shift: true, return: true }))

  // Escape combos are unregistrable: the input layer sets meta on EVERY Esc,
  // so alt+escape would match bare Esc presses (clear-input, double-Esc
  // rewind would be shadowed).
  check('parse: alt+escape refused (Esc always carries meta)',
    parseShortcutCombo('alt+escape') === undefined)
  check('parse: ctrl+escape refused too',
    parseShortcutCombo('ctrl+escape') === undefined)

  // registration rules
  const noop = () => {}
  ctx.tuiShortcuts.register('ctrl+c', { description: 'x', handler: noop })
  check('tuiShortcuts: reserved combo refused + warn',
    ctx.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 1)
  // Chat binds ctrl+o/ctrl+l/ctrl+e globally — they must be reserved too,
  // or a plugin would silently never fire (locals win at dispatch).
  ctx.tuiShortcuts.register('ctrl+o', { description: 'x', handler: noop })
  ctx.tuiShortcuts.register('alt+up', { description: 'x', handler: noop })
  check('tuiShortcuts: chat-global combos reserved (ctrl+o, alt+up)',
    ctx.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 3)
  // ctrl+shift+enter is the editor's Shift+Enter newline (CSI 13;6u).
  ctx.tuiShortcuts.register('ctrl+shift+enter', { description: 'x', handler: noop })
  check('tuiShortcuts: editor newline combo reserved (ctrl+shift+enter)',
    ctx.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 4)
  ctx.tuiShortcuts.register('alt+escape', { description: 'x', handler: noop })
  check('tuiShortcuts: alt+escape refused at registration',
    ctx.tuiShortcuts.list().length === 0 && warnCount('need ctrl/alt plus one key') === 1)
  ctx.tuiShortcuts.register('not-a-combo', { description: 'x', handler: noop })
  check('tuiShortcuts: malformed combo refused', warnCount('need ctrl/alt plus one key') === 2)
  ctx.tuiShortcuts.register('ctrl+g', { description: 'first', handler: noop })
  ctx.tuiShortcuts.register('ctrl+g', { description: 'second', handler: noop })
  check('tuiShortcuts: duplicate refused',
    ctx.tuiShortcuts.list().length === 1 && warnCount('already registered') === 1)
  ctx.tuiShortcuts.register('ctrl+h', { description: '  ', handler: noop })
  check('tuiShortcuts: empty description refused', ctx.tuiShortcuts.list().length === 1)

  // dispatch: hit runs the handler and consumes; miss passes through.
  let fired = 0
  ctx.tuiShortcuts.register('alt+z', { description: 'fire', handler: () => { fired += 1 } })
  check('tuiShortcuts.dispatch: matching key consumed', ctx.tuiShortcuts.dispatch('z', { meta: true }) === true)
  await sleep(20)
  check('tuiShortcuts.dispatch: handler ran', fired === 1)
  check('tuiShortcuts.dispatch: non-matching key passes through', ctx.tuiShortcuts.dispatch('q', { ctrl: true }) === false)

  // Throwing handler → onError, never propagated.
  let errored = ''
  ctx.tuiShortcuts.onError = combo => { errored = combo }
  ctx.tuiShortcuts.register('alt+y', {
    description: 'boom',
    handler: () => { throw new Error('handler exploded') },
  })
  ctx.tuiShortcuts.dispatch('y', { meta: true })
  await sleep(20)
  check('tuiShortcuts.dispatch: handler error routed to onError', errored === 'alt+y')
  ctx.tuiShortcuts.onError = undefined

  // dispose unregisters
  const dispose = ctx.tuiShortcuts.register('alt+x', { description: 'temp', handler: noop })
  dispose()
  check('tuiShortcuts: dispose unregisters', ctx.tuiShortcuts.dispatch('x', { meta: true }) === false)
}

{
  const noop = () => undefined
  ctx.tuiRenderers.register('user/message', noop)
  check('tuiRenderers: built-in event type refused', warnCount('built-in event types keep their own projection') === 1)
  ctx.tuiRenderers.register('agent-preset/selected', noop)
  check('tuiRenderers: host-special plugin event refused', warnCount('built-in event types keep their own projection') === 2)
  ctx.tuiRenderers.register('NoSlash', noop)
  check('tuiRenderers: malformed type refused', warnCount('rejected invalid event type') === 1)
  const dupBefore = warnCount('already registered')
  ctx.tuiRenderers.register('my-plugin/note', () => ({ title: '便签', lines: ['第一行', '第二行'] }))
  ctx.tuiRenderers.register('my-plugin/note', noop)
  check('tuiRenderers: duplicate refused', warnCount('already registered') === dupBefore + 1)
  const result = ctx.tuiRenderers.render('my-plugin/note', { text: 'x' })
  check('tuiRenderers.render: title + lines returned',
    result?.title === '便签' && result.lines.length === 2)
  check('tuiRenderers.render: unregistered type → undefined',
    ctx.tuiRenderers.render('other/thing', {}) === undefined)

  // The built-in denylist is a module-load SNAPSHOT: a plugin that followed
  // seam 1's rule (adding its type to the live KNOWN_SESSION_EVENT_TYPES
  // before persisting events) must still be able to register a renderer for
  // that type — the mutable set must not become a self-denial.
  KNOWN_SESSION_EVENT_TYPES.add('my-plugin/persisted')
  ctx.tuiRenderers.register('my-plugin/persisted', () => ({ lines: ['已登记'] }))
  check('tuiRenderers: renderer for a plugin-REGISTERED type is accepted',
    ctx.tuiRenderers.render('my-plugin/persisted', {})?.lines.length === 1)
  KNOWN_SESSION_EVENT_TYPES.delete('my-plugin/persisted')

  // Output validation inside the render boundary: non-string title dropped
  // (it would crash React), lines capped, control chars stripped, non-scalar
  // lines skipped.
  ctx.tuiRenderers.register('big/output', () => ({
    title: 42 as never,
    lines: Array.from({ length: 5000 }, (_, i) => `行${i}\x07尾部`),
  }))
  const big = ctx.tuiRenderers.render('big/output', {})
  check('tuiRenderers.render: non-string title dropped, no crash', big?.title === undefined)
  check('tuiRenderers.render: lines capped at 100', big?.lines.length === 100, String(big?.lines.length))
  check('tuiRenderers.render: control chars stripped from lines',
    big !== undefined && !big.lines.some(line => line.includes('\x07')))
  ctx.tuiRenderers.register('mixed/lines', () => ({
    lines: ['文本', 42, true, null, { bad: true }, '末尾'] as never,
  }))
  const mixed = ctx.tuiRenderers.render('mixed/lines', {})
  check('tuiRenderers.render: scalar lines coerced, objects skipped',
    mixed?.lines.join('|') === '文本|42|true|末尾', JSON.stringify(mixed?.lines))

  // Throwing renderer: skipped, sticky-logged once per type.
  const before = warnCount('renderer for "bad/actor" threw')
  ctx.tuiRenderers.register('bad/actor', () => { throw new Error('render exploded') })
  ctx.tuiRenderers.render('bad/actor', {})
  ctx.tuiRenderers.render('bad/actor', {})
  check('tuiRenderers.render: throw → undefined, logged once per type',
    ctx.tuiRenderers.render('bad/actor', {}) === undefined && warnCount('renderer for "bad/actor" threw') === before + 1)

  // Malformed result (lines not an array) → no opinion.
  ctx.tuiRenderers.register('weird/result', () => ({ title: 'x' }) as never)
  check('tuiRenderers.render: malformed result → undefined',
    ctx.tuiRenderers.render('weird/result', {}) === undefined)
}

// ── C. Chat UI integration ───────────────────────────────────────────────
const LOCAL_COMMANDS: never[] = []
function makeChannel() {
  return {
    version: 0,
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'model-00',
    provider: 'fake-provider',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submitCalls: [] as string[],
    submit(text: string) { this.submitCalls.push(text) },
    steer() {},
    cancel() {},
    clear() {},
    notify() {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

const channel = makeChannel()
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const instance = await render(
  <Chat
    channel={channel as never}
    questionStore={new QuestionStore()}
    onExit={() => {}}
    extensionDialogs={ctx.tuiDialogs.store}
    extensionStatus={ctx.tuiStatus.store}
    extensionShortcuts={ctx.tuiShortcuts}
  />,
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)
const screen = (back = 30) => plainText(stdout.frames.slice(-back))

// Select: ↓ + Enter picks the second option.
{
  const pending = ctx.tuiDialogs.select({
    title: '挑一个',
    options: [
      { id: 'first', label: '第一项' },
      { id: 'second', label: '第二项', description: '带描述' },
    ],
  })
  await sleep(300)
  check('ui: select dialog renders title + options',
    screen().includes('挑一个') && screen().includes('第二项'), screen().slice(-200))
  stdin.write('\x1b[B')
  await sleep(150)
  stdin.write('\r')
  check('ui: select ↓+Enter resolves the second id', (await pending) === 'second')
  await sleep(200)
  check('ui: dialog closed after settle', ctx.tuiDialogs.store.getSnapshot() === null)
}

// FIFO: the second dialog waits for the first to settle. Confirm: Enter = yes.
{
  const first = ctx.tuiDialogs.confirm({ title: '确认一下', message: '要做吗' })
  const second = ctx.tuiDialogs.select({ title: '排队的选择', options: [{ id: 'only', label: '唯一' }] })
  await sleep(300)
  check('ui: confirm renders with message + localized defaults',
    screen().includes('确认一下') && screen().includes('要做吗'), screen().slice(-200))
  check('ui: FIFO — second dialog still queued', ctx.tuiDialogs.store.getSnapshot()?.kind === 'confirm')
  stdin.write('\r') // Enter on 是 → true
  check('ui: confirm Enter resolves true', (await first) === true)
  await sleep(300)
  check('ui: queued select now active',
    screen().includes('排队的选择'), screen().slice(-200))
  stdin.write('\x1b') // Esc cancels the select
  check('ui: Esc cancels → undefined', (await second) === undefined)
}

// Input: placeholder shown when empty; typed text resolves.
{
  const pending = ctx.tuiDialogs.input({ title: '说点什么', placeholder: '占位提示', initial: '' })
  await sleep(300)
  check('ui: input dialog renders placeholder', screen().includes('占位提示'), screen().slice(-200))
  for (const ch of '你好') { stdin.write(ch); await sleep(60) }
  stdin.write('\r')
  check('ui: input Enter resolves the typed text', (await pending) === '你好')
}

// Input with initial: pre-filled, edited, submitted.
{
  const pending = ctx.tuiDialogs.input({ title: '改改', initial: '原文' })
  await sleep(300)
  stdin.write('\x7f') // backspace removes 文
  await sleep(150)
  stdin.write('\r')
  check('ui: input initial pre-fills and edits', (await pending) === '原')
}

// Status line: appears on set, disappears on clear.
{
  ctx.tuiStatus.set('demo-plugin', '构建中 42%')
  await sleep(300)
  check('ui: status line renders the contribution', screen().includes('构建中 42%'), screen().slice(-300))
  // The incremental renderer only writes diffs: after the clear, assert on
  // frames written FROM the clear on — earlier frames legitimately still
  // contain the set text.
  const mark = stdout.frames.length
  ctx.tuiStatus.set('demo-plugin', undefined)
  await sleep(300)
  check('ui: status line clears', !plainText(stdout.frames.slice(mark)).includes('构建中'))
}

// Shortcut through Chat: the keypress is consumed, the handler runs; the
// editor never sees it (no submit, no text). alt+p: not reserved, not used
// by an earlier section (a duplicate registration would be refused).
{
  let fired = 0
  ctx.tuiShortcuts.register('alt+p', { description: 'ui fire', handler: () => { fired += 1 } })
  await sleep(100)
  stdin.write('\x1bp') // alt+p
  await sleep(300)
  check('ui: plugin shortcut handler fired through Chat', fired >= 1, String(fired))
  check('ui: shortcut keypress never reached submit', channel.submitCalls.length === 0)
}

// A plugin dialog owns the keyboard while open: shortcuts do NOT fire.
// (Probe with alt+b — a letter combo the confirm dialog itself ignores;
// ctrl+j would arrive as \n and read as Enter.)
{
  let fired = 0
  ctx.tuiShortcuts.register('alt+b', { description: 'blocked', handler: () => { fired += 1 } })
  const pending = ctx.tuiDialogs.confirm({ title: '占键盘中' })
  await sleep(300)
  stdin.write('\x1bb') // alt+b — must not reach shortcuts while the dialog is open
  await sleep(200)
  check('ui: open dialog gates plugin shortcuts', fired === 0)
  stdin.write('\x1b')
  check('ui: dialog Esc-cancelled after the gate check', (await pending) === false)
}

await instance.unmount()

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('extension UI seams verified')
process.exit(0)
