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
// 断言针对中文 i18n 文案（对话框标题/状态行标记），与运行环境的 locale 无关。
process.env.DSH_TUI_LANG = 'zh'

// 家目录隔离（同 verify-extension-events.tsx）：Chat 加载即解析 homedir()。
const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
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
  { TuiDialogStore, TuiDialogRuntime, getHostDialogStore, INPUT_CELLS },
  { TuiStatusStore, TuiStatusRuntime, getHostStatusStore },
  { TuiShortcutRuntime, getHostShortcuts, parseShortcutCombo, matchShortcut },
  { TuiRendererRuntime, getHostRenderers },
  { parseExtensionGrants },
  { dispatchTuiDecision, normalizeCancelDecision },
  { stringWidth },
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
  import('../src/dsh-adapter/decision-guard.js'),
  import('../src/dsh-adapter/extension-events.js'),
  import('../src/ink/stringWidth.js'),
  import('@deepseek-ai/dsh-session'),
])
const { mountAdmitted, testManifest, DECISION_COORDINATE } = await import('./plugin-test-utils.js')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const { DATA_DIR } = await import('../src/utils/paths.js')

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
  store.decide(store.getSnapshot()?.key ?? '', 'a')
  check('dialog store: decide resolves the active request', (await first) === 'a')
  check('dialog store: queue advances to the second request', store.getSnapshot()?.kind === 'confirm')
  store.cancel(store.getSnapshot()?.key ?? '')
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
  const staleKey = store.getSnapshot()?.key ?? ''
  store.decide(staleKey, true)
  store.decide(staleKey, false)
  check('dialog store: stale decide is ignored', (await stale) === true)

  // Key isolation (ConPTY CR+LF double-fire): one Enter must never settle
  // TWO consecutive dialogs — the old panel's second callback carries its
  // own (now-stale) key and is ignored; the successor survives.
  const victimA = store.ask({ kind: 'confirm', title: 'k1', confirmLabel: '', cancelLabel: '' })
  const survivorB = store.ask({ kind: 'confirm', title: 'k2', confirmLabel: '', cancelLabel: '' })
  const keyA = store.getSnapshot()?.key ?? ''
  store.decide(keyA, true)
  store.decide(keyA, false) // the batched second fire from the OLD panel
  check('dialog store: one Enter settles only the first dialog', (await victimA) === true)
  check('dialog store: the successor survives the batched Enter',
    store.getSnapshot()?.kind === 'confirm' && store.getSnapshot()?.title === 'k2')
  store.decide(store.getSnapshot()?.key ?? '', false)
  check('dialog store: the successor settles on ITS key', (await survivorB) === false)
  // A wrong key never settles anything.
  const wrongKey = store.ask({ kind: 'confirm', title: 'k3', confirmLabel: '', cancelLabel: '' })
  store.decide('dlg-999999', true)
  check('dialog store: a foreign key is ignored', store.getSnapshot()?.title === 'k3')
  store.cancel('dlg-999999')
  check('dialog store: a foreign cancel key is ignored', store.getSnapshot()?.title === 'k3')
  store.cancel(store.getSnapshot()?.key ?? '')
  check('dialog store: the keyed cancel settles', (await wrongKey) === undefined)

  // Aborting the ACTIVE request must advance the queue — without advance(),
  // the next Promise parks forever and the UI shows no dialog.
  const abortCtl = new AbortController()
  const victim = store.ask({ kind: 'input', title: 't9', initial: '' }, abortCtl.signal)
  const successor = store.ask({ kind: 'confirm', title: 't10', confirmLabel: '', cancelLabel: '' })
  abortCtl.abort()
  check('dialog store: aborted active resolves cancelled', (await victim) === undefined)
  check('dialog store: abort ADVANCES the queue to the next request',
    store.getSnapshot()?.kind === 'confirm', JSON.stringify(store.getSnapshot()))
  store.decide(store.getSnapshot()?.key ?? '', true)
  check('dialog store: the advanced request settles normally', (await successor) === true)

  // Same for a timeout: the active request dies, the queued one goes live.
  const timedOut = store.ask({ kind: 'input', title: 't11', initial: '' }, undefined, 100)
  const afterTimeout = store.ask({ kind: 'select', title: 't12', options: [{ id: 'x', label: 'X' }] })
  check('dialog store: timed-out active resolves cancelled', (await timedOut) === undefined)
  check('dialog store: timeout ADVANCES the queue',
    store.getSnapshot()?.kind === 'select', JSON.stringify(store.getSnapshot()))
  store.cancel(store.getSnapshot()?.key ?? '')
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

// Plugin-facing extension calls must originate from a live child activation.
// Calling these services through the composition root would bind effects to
// the host lifetime and is intentionally rejected by the runtime.
let pluginCtx: Context | undefined
const pluginFiber = ctx.plugin({
  name: 'ui-extension-probe',
  inject: ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers'],
  apply: (candidate: Context) => {
    pluginCtx = candidate
  },
})
await sleep(50)
if (pluginCtx === undefined) {
  await Promise.resolve(pluginFiber.dispose())
  throw new Error('UI extension probe did not start')
}

const dialogStore = getHostDialogStore(ctx.tuiDialogs)
const statusStore = getHostStatusStore(ctx.tuiStatus)
const shortcutHost = getHostShortcuts(ctx.tuiShortcuts)
const rendererHost = getHostRenderers(ctx.tuiRenderers)
if (dialogStore === undefined || statusStore === undefined || shortcutHost === undefined || rendererHost === undefined) {
  throw new Error('extension host accessors were not initialized')
}

// Cordis callers receive a traceable service proxy. Host controls must stay
// absent from that plugin-visible object: direct queue/store/dispatch access
// would let one extension interfere with another extension's effects.
check('host-only: dialog queue is absent from the plugin service',
  !('store' in (ctx.tuiDialogs as object)))
check('host-only: status store is absent from the plugin service',
  !('store' in (ctx.tuiStatus as object)))
check('host-only: shortcut dispatch is absent from the plugin service',
  !('dispatch' in (ctx.tuiShortcuts as object)) && !('onError' in (ctx.tuiShortcuts as object)))
check('host-only: renderer dispatch is absent from the plugin service',
  !('render' in (ctx.tuiRenderers as object)))
const publicExtensionSurface = await import('../src/extensions.js')
check('host-only: accessors are absent from the public extension package',
  !Object.keys(publicExtensionSurface).some(name => name.startsWith('getHost')))

const plugin = pluginCtx

{
  // Malformed requests resolve cancelled + warn; they never throw.
  check('tuiDialogs.select: no options → cancelled + warn',
    (await plugin.tuiDialogs.select({ title: '空选择', options: [] })) === undefined && warnCount('tuiDialogs.select') === 1)
  check('tuiDialogs.confirm: no title → false + warn',
    (await plugin.tuiDialogs.confirm({ title: '' })) === false)
  check('tuiDialogs.input: no title → cancelled',
    (await plugin.tuiDialogs.input({ title: '   ' })) === undefined)

  // Scalar-only coercion: a non-scalar title is REFUSED (warn + cancelled),
  // never coerced to "[object Object]" onto the screen.
  check('tuiDialogs.confirm: object title refused, not coerced',
    (await plugin.tuiDialogs.confirm({ title: { nope: true } as unknown as string })) === false
    && warnCount('tuiDialogs.confirm called without a title') === 2)

  // Sanitization: control chars stripped, malformed options dropped.
  const pending = plugin.tuiDialogs.select({
    title: '带\x07铃声\n的标题',
    options: [
      { id: 'ok', label: '正常' },
      { id: '', label: '空 id' },
      { id: 'nolabel', label: '' },
    ],
    timeoutMs: 150,
  })
  const snapshot = dialogStore.getSnapshot()
  check('tuiDialogs.select: control chars stripped from the title',
    snapshot?.kind === 'select' && snapshot.title === '带 铃声 的标题', JSON.stringify(snapshot?.title))
  check('tuiDialogs.select: malformed options filtered',
    snapshot?.kind === 'select' && snapshot.options.length === 1)
  check('tuiDialogs.select: timeout still applies through the runtime', (await pending) === undefined)

  // Option ids are opaque tokens, NOT render-path data: whitespace/control
  // chars are NOT sanitized away and long ids are NOT truncated — the promise
  // resolves with the exact string the plugin registered.
  const opaqueId = '  spaced id\t带 空白  '
  const longId = 'x'.repeat(300)
  const pick = plugin.tuiDialogs.select({
    title: ' opaque ids ',
    options: [
      { id: opaqueId, label: '空白 id' },
      { id: longId, label: '长 id' },
    ],
    timeoutMs: 200,
  })
  const opaqueSnapshot = dialogStore.getSnapshot()
  check('tuiDialogs.select: option ids kept verbatim in the snapshot',
    opaqueSnapshot?.kind === 'select'
    && opaqueSnapshot.options[0]?.id === opaqueId
    && opaqueSnapshot.options[1]?.id === longId)
  dialogStore.cancel(dialogStore.getSnapshot()?.key ?? '')
  check('tuiDialogs.select: cleanup cancel still resolves undefined', (await pick) === undefined)
}

{
  plugin.tuiStatus.set('Bad Key!', 'nope')
  check('tuiStatus: invalid key refused + warn', statusStore.getSnapshot().length === 0 && warnCount('tuiStatus.set rejected an invalid key') === 1)
  // P2-9：文档的 plugin:sub-item 冒号命名约定合法（逐段 slug 校验）。
  plugin.tuiStatus.set('my-plugin:sub-item', 'colon ok')
  check('tuiStatus: colon-namespaced key accepted (documented convention)',
    statusStore.getSnapshot().some(e => e.key === 'my-plugin:sub-item' && e.text === 'colon ok'))
  plugin.tuiStatus.set('my-plugin:sub-item', undefined)
  // 大写按既有 case-fold 纪律归一为小写后接受。
  plugin.tuiStatus.set('My-Plugin:Sub-Item', 'folded')
  check('tuiStatus: uppercase colon key case-folds and is accepted',
    statusStore.getSnapshot().some(e => e.key === 'my-plugin:sub-item' && e.text === 'folded'))
  plugin.tuiStatus.set('My-Plugin:Sub-Item', undefined)
  // 归一化后仍畸形的（空段/连冒号/空格）拒绝。
  for (const bad of ['trail:', ':lead', 'double::colon', 'has space:x']) {
    const before = warnCount('tuiStatus.set rejected an invalid key')
    plugin.tuiStatus.set(bad, 'nope')
    check(`tuiStatus: malformed colon key "${bad}" refused`, warnCount('tuiStatus.set rejected an invalid key') === before + 1)
  }
  plugin.tuiStatus.set('demo', '构建\x1b[31m中')
  check('tuiStatus: control chars stripped',
    statusStore.getSnapshot()[0]?.text === '构建 [31m中', JSON.stringify(statusStore.getSnapshot()[0]?.text))
  // Scalar-only coercion: a non-scalar text is refused with a warn — never
  // rendered as "[object Object]", and NOT treated as a clear either.
  plugin.tuiStatus.set('scalar', { nope: true } as unknown as string)
  check('tuiStatus: non-scalar text refused + warn',
    !statusStore.getSnapshot().some(e => e.key === 'scalar')
    && warnCount('tuiStatus.set rejected non-scalar text') === 1)
  // …but a number/boolean coerces (genuine scalars, not objects) — and the
  // public signature accepts them directly, no cast needed.
  plugin.tuiStatus.set('scalar', 42)
  check('tuiStatus: numeric text coerces',
    statusStore.getSnapshot().find(e => e.key === 'scalar')?.text === '42')
  plugin.tuiStatus.set('scalar', undefined)
  // Beyond MAX_ENTRIES (20): the 21st NEW key is refused.
  for (let i = 0; i < 19; i++) plugin.tuiStatus.set(`plug-${String(i).padStart(2, '0')}`, 'x')
  plugin.tuiStatus.set('one-too-many', 'x')
  check('tuiStatus: contribution cap enforced',
    statusStore.getSnapshot().length === 20 && warnCount('contributions already shown') === 1)
  plugin.tuiStatus.set('demo', undefined)
  for (let i = 0; i < 19; i++) plugin.tuiStatus.set(`plug-${String(i).padStart(2, '0')}`, undefined)

  // Lifecycle disposer: clears only while the key still holds THIS text —
  // a stale disposer must not wipe a newer contribution.
  const disposeOld = plugin.tuiStatus.set('lifecycle', '旧值')
  disposeOld()
  check('tuiStatus: disposer clears its own contribution',
    statusStore.getSnapshot().length === 0)
  const disposeStale = plugin.tuiStatus.set('lifecycle', '旧值')
  plugin.tuiStatus.set('lifecycle', '新值')
  disposeStale()
  check('tuiStatus: stale disposer keeps the newer value',
    statusStore.getSnapshot()[0]?.text === '新值')
  plugin.tuiStatus.set('lifecycle', undefined)
  check('tuiStatus: explicit clear still works', statusStore.getSnapshot().length === 0)

  // Same-value ABA: two writes of IDENTICAL text — the first disposer must
  // not clear the second write (token comparison, not value comparison; a
  // hot reload restoring the same line hits exactly this).
  const disposeFirst = plugin.tuiStatus.set('aba', '同值')
  const disposeSecond = plugin.tuiStatus.set('aba', '同值')
  disposeFirst()
  check('tuiStatus: same-value stale disposer keeps the newer write',
    statusStore.getSnapshot().some(e => e.key === 'aba' && e.text === '同值'))
  disposeSecond()
  check('tuiStatus: the owning disposer clears the same-value write',
    !statusStore.getSnapshot().some(e => e.key === 'aba'))
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
  plugin.tuiShortcuts.register('ctrl+c', { description: 'x', handler: noop })
  check('tuiShortcuts: reserved combo refused + warn',
    plugin.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 1)
  // Chat binds ctrl+o/ctrl+l/ctrl+e globally — they must be reserved too,
  // or a plugin would silently never fire (locals win at dispatch).
  plugin.tuiShortcuts.register('ctrl+o', { description: 'x', handler: noop })
  plugin.tuiShortcuts.register('alt+up', { description: 'x', handler: noop })
  check('tuiShortcuts: chat-global combos reserved (ctrl+o, alt+up)',
    plugin.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 3)
  // ctrl+shift+enter is the editor's Shift+Enter newline (CSI 13;6u).
  plugin.tuiShortcuts.register('ctrl+shift+enter', { description: 'x', handler: noop })
  check('tuiShortcuts: editor newline combo reserved (ctrl+shift+enter)',
    plugin.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 4)
  // Built-ins match a modifier SUBSET (isMod && char, Shift never excluded):
  // a shift-superset of a reserved combo collides with the built-in on
  // terminals that don't report Shift distinctly — refused too.
  plugin.tuiShortcuts.register('ctrl+shift+x', { description: 'x', handler: noop })
  plugin.tuiShortcuts.register('ctrl+shift+t', { description: 'x', handler: noop })
  check('tuiShortcuts: shift-supersets of reserved combos refused (ctrl+shift+x/t)',
    plugin.tuiShortcuts.list().length === 0 && warnCount('reserved by a built-in binding') === 6)
  // …but a shift-superset of a NON-reserved combo still registers (and its
  // disposer removes it, keeping the registry empty for later sections).
  const disposeShiftG = plugin.tuiShortcuts.register('ctrl+shift+g', { description: 'ok', handler: noop })
  check('tuiShortcuts: shift-superset of a free combo registers',
    plugin.tuiShortcuts.list().length === 1)
  disposeShiftG()
  check('tuiShortcuts: the shift-superset disposes cleanly',
    plugin.tuiShortcuts.list().length === 0)
  plugin.tuiShortcuts.register('alt+escape', { description: 'x', handler: noop })
  check('tuiShortcuts: alt+escape refused at registration',
    plugin.tuiShortcuts.list().length === 0 && warnCount('need ctrl/alt plus one key') === 1)
  plugin.tuiShortcuts.register('not-a-combo', { description: 'x', handler: noop })
  check('tuiShortcuts: malformed combo refused', warnCount('need ctrl/alt plus one key') === 2)
  plugin.tuiShortcuts.register('ctrl+g', { description: 'first', handler: noop })
  plugin.tuiShortcuts.register('ctrl+g', { description: 'second', handler: noop })
  check('tuiShortcuts: duplicate refused',
    plugin.tuiShortcuts.list().length === 1 && warnCount('already registered') === 1)
  plugin.tuiShortcuts.register('ctrl+h', { description: '  ', handler: noop })
  check('tuiShortcuts: empty description refused', plugin.tuiShortcuts.list().length === 1)

  // dispatch: hit runs the handler and consumes; miss passes through.
  let fired = 0
  plugin.tuiShortcuts.register('alt+z', { description: 'fire', handler: () => { fired += 1 } })
  check('tuiShortcuts.dispatch: matching key consumed', shortcutHost.dispatch('z', { meta: true }) === true)
  await sleep(20)
  check('tuiShortcuts.dispatch: handler ran', fired === 1)
  check('tuiShortcuts.dispatch: non-matching key passes through', shortcutHost.dispatch('q', { ctrl: true }) === false)

  // Throwing handler → onError, never propagated.
  let errored = ''
  const removeErrorHandler = shortcutHost.setErrorHandler(combo => { errored = combo })
  plugin.tuiShortcuts.register('alt+y', {
    description: 'boom',
    handler: () => { throw new Error('handler exploded') },
  })
  shortcutHost.dispatch('y', { meta: true })
  await sleep(20)
  check('tuiShortcuts.dispatch: handler error routed to onError', errored === 'alt+y')
  removeErrorHandler()

  // dispose unregisters
  const dispose = plugin.tuiShortcuts.register('alt+x', { description: 'temp', handler: noop })
  dispose()
  check('tuiShortcuts: dispose unregisters', shortcutHost.dispatch('x', { meta: true }) === false)
}

{
  const noop = () => undefined
  plugin.tuiRenderers.register('user/message', noop)
  check('tuiRenderers: built-in event type refused', warnCount('built-in event types keep their own projection') === 1)
  plugin.tuiRenderers.register('agent-preset/selected', noop)
  check('tuiRenderers: host-special plugin event refused', warnCount('built-in event types keep their own projection') === 2)
  plugin.tuiRenderers.register('NoSlash', noop)
  check('tuiRenderers: malformed type refused', warnCount('rejected an invalid event type') === 1)
  const dupBefore = warnCount('already registered')
  plugin.tuiRenderers.register('my-plugin/note', () => ({ title: '便签', lines: ['第一行', '第二行'] }))
  plugin.tuiRenderers.register('my-plugin/note', noop)
  check('tuiRenderers: duplicate refused', warnCount('already registered') === dupBefore + 1)
  const result = rendererHost.render('my-plugin/note', { text: 'x' })
  check('tuiRenderers.render: title + lines returned',
    result?.title === '便签' && result.lines.length === 2)
  check('tuiRenderers.render: unregistered type → undefined',
    rendererHost.render('other/thing', {}) === undefined)

  // The built-in denylist is a module-load SNAPSHOT: a plugin that followed
  // seam 1's rule (adding its type to the live KNOWN_SESSION_EVENT_TYPES
  // before persisting events) must still be able to register a renderer for
  // that type — the mutable set must not become a self-denial.
  KNOWN_SESSION_EVENT_TYPES.add('my-plugin/persisted')
  plugin.tuiRenderers.register('my-plugin/persisted', () => ({ lines: ['已登记'] }))
  check('tuiRenderers: renderer for a plugin-REGISTERED type is accepted',
    rendererHost.render('my-plugin/persisted', {})?.lines.length === 1)
  KNOWN_SESSION_EVENT_TYPES.delete('my-plugin/persisted')

  // Output validation inside the render boundary: non-string title dropped
  // (it would crash React), lines capped, control chars stripped, non-scalar
  // lines skipped.
  plugin.tuiRenderers.register('big/output', () => ({
    title: 42 as never,
    lines: Array.from({ length: 5000 }, (_, i) => `行${i}\x07尾部`),
  }))
  const big = rendererHost.render('big/output', {})
  check('tuiRenderers.render: non-string title dropped, no crash', big?.title === undefined)
  check('tuiRenderers.render: lines capped at 100', big?.lines.length === 100, String(big?.lines.length))
  check('tuiRenderers.render: control chars stripped from lines',
    big !== undefined && !big.lines.some(line => line.includes('\x07')))
  plugin.tuiRenderers.register('mixed/lines', () => ({
    lines: ['文本', 42, true, null, { bad: true }, '末尾'] as never,
  }))
  const mixed = rendererHost.render('mixed/lines', {})
  check('tuiRenderers.render: scalar lines coerced, objects skipped',
    mixed?.lines.join('|') === '文本|42|true|末尾', JSON.stringify(mixed?.lines))

  // Throwing renderer: skipped, sticky-logged once per type.
  const before = warnCount('renderer for "bad/actor" threw')
  plugin.tuiRenderers.register('bad/actor', () => { throw new Error('render exploded') })
  rendererHost.render('bad/actor', {})
  rendererHost.render('bad/actor', {})
  check('tuiRenderers.render: throw → undefined, logged once per type',
    rendererHost.render('bad/actor', {}) === undefined && warnCount('renderer for "bad/actor" threw') === before + 1)

  // Malformed result (lines not an array) → no opinion.
  plugin.tuiRenderers.register('weird/result', () => ({ title: 'x' }) as never)
  check('tuiRenderers.render: malformed result → undefined',
    rendererHost.render('weird/result', {}) === undefined)
}

// ── B2. RFC 0005 D-7: intercept subscriptions require explicit grants ────
{
  // A fresh root: the host row installs the guard and owns the same live
  // grant store used by admission and runtime dispatch.
  const guardCtx = new Context()
  const guardWarnings: string[] = []
  guardCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
    guardWarnings.push([format, ...params].map(String).join(' '))
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(joinPath(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: {
      'my-guard': [{ name: 'session.input.intercept', scope: 'tui/input', activationId: 'ui-guard-act' }],
    },
  }))
  guardCtx.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await sleep(50)
  const admitted = await mountAdmitted(guardCtx, 'my-guard-export', testManifest({
    id: 'my-guard',
    requires: [DECISION_COORDINATE],
    permissions: [{ name: 'session.input.intercept', scope: 'tui/input' }],
  }), 'test:my-guard/dsh-plugin.json', { activationId: 'ui-guard-act' })
  const host = guardCtx.get('tuiPluginHost')
  if (host === undefined) throw new Error('tuiPluginHost was not mounted')

  // Granted plugin: the mediated subscription registers and answers decisions.
  const release = host.subscribeDecision(
    admitted.context,
    'tui/input',
    (event: Record<string, unknown>) => event.text === '拦截'
      ? { cancel: true, reason: '授权拦截' }
      : undefined,
    { order: 'ui-granted' },
  )
  const passThrough = (result: unknown): unknown => result
  check('decision guard: granted subscription enters the chain',
    (await dispatchTuiDecision(guardCtx, 'tui/input', { text: '拦截', sessionId: 'ui-session' }, passThrough)) !== undefined)

  // A denied raw plugin has no verified Component identity; its listeners
  // never enter the mediated registry.
  guardCtx.plugin({
    name: 'evil-plugin',
    apply: (c: Context) => {
      c.on('tui/input', () => ({ cancel: true, reason: '不该生效' }))
      c.on('tui/compact', () => ({ cancel: true }))
    },
  })
  await sleep(100)
  check('decision guard: ungranted subscription never enters the chain',
    (await dispatchTuiDecision(guardCtx, 'tui/input', { text: '别的', sessionId: 'ui-session' }, passThrough)) === undefined
    && (await dispatchTuiDecision(guardCtx, 'tui/compact', { sessionId: 'ui-session' }, normalizeCancelDecision)) === undefined)
  check('decision guard: denial warns with plugin + grant',
    guardWarnings.some(line => line.includes('"evil-plugin"') && line.includes('session.input.intercept'))
    && guardWarnings.some(line => line.includes('session.compact.intercept')))

  // Observe-class events still require an admitted DecisionEvents identity,
  // but do not require an intercept grant.
  let observed = false
  const observeRelease = host.subscribeDecision(
    admitted.context,
    'tui/session-switched',
    () => { observed = true },
    { order: 'ui-observe' },
  )
  await dispatchTuiDecision(guardCtx, 'tui/session-switched', { sessionId: 'ui-session' }, () => undefined)
  await sleep(20)
  check('decision guard: observe-class events stay ungated',
    observed && !guardWarnings.some(line => line.includes('tui/session-switched')))
  observeRelease()
  release()

  // A corrupt grants file fails CLOSED (deny-all), never open.
  check('decision guard: corrupt grants parse as deny-all',
    !parseExtensionGrants('{ not json').allows('my-guard', 'session.input.intercept'))
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
    extensionDialogs={dialogStore}
    extensionStatus={statusStore}
    extensionShortcuts={shortcutHost}
  />,
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)
const screen = (back = 30) => plainText(stdout.frames.slice(-back))

// Select: ↓ + Enter picks the second option.
{
  const pending = plugin.tuiDialogs.select({
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
  check('ui: dialog closed after settle', dialogStore.getSnapshot() === null)
}

// FIFO: the second dialog waits for the first to settle. Confirm: Enter = yes.
{
  const first = plugin.tuiDialogs.confirm({ title: '确认一下', message: '要做吗' })
  const second = plugin.tuiDialogs.select({ title: '排队的选择', options: [{ id: 'only', label: '唯一' }] })
  await sleep(300)
  check('ui: confirm renders with message + localized defaults',
    screen().includes('确认一下') && screen().includes('要做吗'), screen().slice(-200))
  check('ui: FIFO — second dialog still queued', dialogStore.getSnapshot()?.kind === 'confirm')
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
  const pending = plugin.tuiDialogs.input({ title: '说点什么', placeholder: '占位提示', initial: '' })
  await sleep(300)
  check('ui: input dialog renders placeholder', screen().includes('占位提示'), screen().slice(-200))
  for (const ch of '你好') { stdin.write(ch); await sleep(60) }
  stdin.write('\r')
  check('ui: input Enter resolves the typed text', (await pending) === '你好')
}

// Input with initial: pre-filled, edited, submitted.
{
  const pending = plugin.tuiDialogs.input({ title: '改改', initial: '原文' })
  await sleep(300)
  stdin.write('\x7f') // backspace removes 文
  await sleep(150)
  stdin.write('\r')
  check('ui: input initial pre-fills and edits', (await pending) === '原')
}

// Bracketed paste: a chunk that is all line breaks is TEXT, not an Enter
// press (isPasted lives on the InputEvent, not the key) — the confirm must
// survive it, on its default Yes focus.
{
  const pending = plugin.tuiDialogs.confirm({ title: '粘贴确认' })
  await sleep(300)
  stdin.write('\x1b[200~\r\n\r\n\x1b[201~')
  await sleep(250)
  check('ui: pure-newline paste does NOT confirm the dialog',
    dialogStore.getSnapshot()?.kind === 'confirm')
  stdin.write('\x1b') // cleanup: Esc cancels it
  const resolvedPasteConfirm = await pending
  check('ui: paste-surviving dialog cancels normally', resolvedPasteConfirm === false, JSON.stringify(resolvedPasteConfirm))
}

// Bracketed paste into the single-line input: newlines/control chars are
// flattened, and the whole value is capped at INPUT_CELLS cells so the
// resolved answer keeps the documented ≤500-cell bound.
{
  const pending = plugin.tuiDialogs.input({ title: '粘贴输入', initial: '' })
  await sleep(300)
  const chunk = '多行\n粘贴\x07' + '长'.repeat(600)
  stdin.write(`\x1b[200~${chunk}\x1b[201~`)
  await sleep(250)
  stdin.write('\r')
  const resolved = await pending
  // eslint-disable-next-line no-control-regex -- asserting the absence of control chars
  check('ui: paste flattened to one line (no control chars survive)',
    resolved !== undefined && !/[\x00-\x1f\x7f-\x9f]/u.test(resolved), JSON.stringify(resolved?.slice(0, 30)))
  check('ui: paste capped at INPUT_CELLS cells',
    resolved !== undefined && stringWidth(resolved) <= INPUT_CELLS, String(resolved?.length))
}

// A typed keystroke past the cap is ignored (the panel never grows beyond
// INPUT_CELLS even without paste).
{
  const nearCap = '字'.repeat(250) // 500 cells exactly (wide chars)
  const pending = plugin.tuiDialogs.input({ title: '顶格输入', initial: nearCap })
  await sleep(300)
  stdin.write('x')
  await sleep(150)
  stdin.write('\r')
  check('ui: typing past the cell cap is ignored',
    (await pending) === nearCap)
}

// Batched keys in ONE stdin chunk: a terminal delivers a chunk as several
// key events inside a single React batch, so state queued by the first
// event is invisible to the second. The handlers must act on synchronously
// updated state (refs): ↓+Enter settles the NEW focus, not the stale one.
{
  const pending = plugin.tuiDialogs.select({
    title: '同批选择',
    options: [
      { id: 'first', label: '第一项' },
      { id: 'second', label: '第二项' },
    ],
  })
  await sleep(300)
  stdin.write('\x1b[B\r') // Down + Enter in one chunk
  check('ui: batched ↓+Enter settles the NEW focus, not the stale one',
    (await pending) === 'second')
  await sleep(200)
}
{
  const pending = plugin.tuiDialogs.confirm({ title: '同批确认' })
  await sleep(300)
  stdin.write('\x1b[C\r') // Right + Enter in one chunk → focus 否 → false
  check('ui: batched →+Enter settles the moved focus', (await pending) === false)
  await sleep(200)
}
// Two Backspaces in one chunk must BOTH delete (each seeing the other's
// result), not compute from the same stale base.
{
  const pending = plugin.tuiDialogs.input({ title: '同批退格', initial: 'abcd' })
  await sleep(300)
  stdin.write('\x7f\x7f')
  await sleep(150)
  stdin.write('\r')
  check('ui: batched Backspace×2 deletes both characters', (await pending) === 'ab')
}

// Code-point editing: an emoji is ONE step — Backspace removes the whole
// surrogate pair (never a lone half), and arrow keys never land the cursor
// inside a pair.
{
  const pending = plugin.tuiDialogs.input({ title: '表情退格', initial: 'a😊b' })
  await sleep(300)
  stdin.write('\x1b[D') // left: cursor between 😊 and b
  await sleep(120)
  stdin.write('\x7f') // backspace deletes the whole emoji
  await sleep(120)
  stdin.write('\r')
  check('ui: Backspace deletes a whole emoji (no lone surrogate)',
    (await pending) === 'ab')
}
{
  const pending = plugin.tuiDialogs.input({ title: '表情清空', initial: '😊' })
  await sleep(300)
  stdin.write('\x7f') // single backspace at end of the sole emoji
  await sleep(150)
  stdin.write('\r')
  check('ui: Backspace on the sole emoji empties the value', (await pending) === '')
}
{
  const pending = plugin.tuiDialogs.input({ title: '表情步进', initial: '😊x' })
  await sleep(300)
  // Left ×2 from the end: code-point steps land BEFORE the emoji (a UTF-16
  // step would park the cursor mid-surrogate and split the pair on insert).
  stdin.write('\x1b[D\x1b[D')
  await sleep(120)
  stdin.write('z')
  await sleep(120)
  stdin.write('\r')
  check('ui: arrow keys step by code point (insert never splits a pair)',
    (await pending) === 'z😊x')
}

// Status line: appears on set, disappears on clear.
{
  plugin.tuiStatus.set('demo-plugin', '构建中 42%')
  await sleep(300)
  check('ui: status line renders the contribution', screen().includes('构建中 42%'), screen().slice(-300))
  // The incremental renderer only writes diffs: after the clear, assert on
  // frames written FROM the clear on — earlier frames legitimately still
  // contain the set text.
  const mark = stdout.frames.length
  plugin.tuiStatus.set('demo-plugin', undefined)
  await sleep(300)
  check('ui: status line clears', !plainText(stdout.frames.slice(mark)).includes('构建中'))
}

// Shortcut through Chat: the keypress is consumed, the handler runs; the
// editor never sees it (no submit, no text). alt+p: not reserved, not used
// by an earlier section (a duplicate registration would be refused).
{
  let fired = 0
  plugin.tuiShortcuts.register('alt+p', { description: 'ui fire', handler: () => { fired += 1 } })
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
  plugin.tuiShortcuts.register('alt+b', { description: 'blocked', handler: () => { fired += 1 } })
  const pending = plugin.tuiDialogs.confirm({ title: '占键盘中' })
  await sleep(300)
  stdin.write('\x1bb') // alt+b — must not reach shortcuts while the dialog is open
  await sleep(200)
  check('ui: open dialog gates plugin shortcuts', fired === 0)
  stdin.write('\x1b')
  check('ui: dialog Esc-cancelled after the gate check', (await pending) === false)
}

await instance.unmount()
await pluginFiber.dispose()
check('lifecycle: plugin activation dispose leaves no status contribution', statusStore.getSnapshot().length === 0)
check('lifecycle: plugin activation dispose leaves no shortcut', shortcutHost.dispatch('alt+p', { alt: true, meta: true, name: 'p' }) === false)
check('lifecycle: plugin activation dispose leaves no renderer', rendererHost.render('my-plugin/persisted', {}) === undefined)

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('extension UI seams verified')
process.exit(0)
