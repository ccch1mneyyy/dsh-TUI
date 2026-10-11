/**
 * Plugin side-panel regression (ctx.tuiPanels, §18 Phase 6): full-chain
 * admission on a real Cordis composition, plus a render smoke proving a
 * crashing plugin panel is isolated (error card, then session disable)
 * while the chat side keeps rendering.
 *
 * Store-level chain (mirrors verify-plugin-lifecycle):
 *  - root-context register/list rejected (requirePluginCaller);
 *  - register → PanelStore entry with '<pluginId>:' prefixed id,
 *    source='plugin', mountPolicy forced 'active', minColumns default 28,
 *    and the enabled-panel CSV gains the id;
 *  - duplicate id → undefined + ledger DUPLICATE_CONTRIBUTION_ID;
 *  - per-plugin budget (≤4) → undefined + ledger PANEL_BUDGET_EXCEEDED;
 *  - descriptor validation: apiVersion/id/title/icon-width/component-or-
 *    compact/maxRows;
 *  - badge/list/open/close ownership: foreign ids rejected;
 *  - open rate limit: second open within 5s dropped + ledger RATE_LIMITED
 *    (no-consumer open returns false without rate-limit consumption);
 *  - subscribe: only own-panel events (registered/badge/unregistered/
 *    disabled), listener errors swallowed;
 *  - dispose → store entry gone, CSV cleaned, ledger release recorded.
 *
 * Render smoke (headless XTerm): throwing plugin panel renders the error
 * card and the chat body stays intact; the 3rd reportError flips the entry
 * to the session-disabled card and fires one channel.notify toast.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-panels.ts
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const [cordis, React, XTermMod, ui, termTest, prefs, i18nMod, adapterMod, storeMod, bridgeMod, panelAdapterMod] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/panels.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/components/sidePanel/panelBridge.js'),
  import('../src/components/sidePanel/pluginPanelAdapter.js'),
])
const { Context } = cordis
const { Terminal: XTerm } = XTermMod
const { render, ThemeProvider, AlternateScreen, Box, Text } = ui
const { settled, sleep } = termTest
const { applySidePanelPanels, getSidePanelPanels, parseSidePanelIds } = prefs
const { setLang } = i18nMod
const { TuiPanelRuntime, getHostPanelRuntime } = adapterMod
const { panelStore } = storeMod
const { panelBridgeRequests } = bridgeMod
void panelAdapterMod

const { TuiEffectLedgerRuntime } = await import('../src/dsh-adapter/effect-ledger.js')
const { PanelHost } = await import('../src/components/sidePanel/PanelHost.js')

setLang('zh')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

const ledgerDir = mkdtempSync(join(tmpdir(), 'dsh-tui-panels-'))
const ledgerFile = join(ledgerDir, 'ledger.jsonl')

const root = new Context()
await root.plugin(TuiEffectLedgerRuntime, { file: ledgerFile })
await root.plugin(TuiPanelRuntime)
const svc = root.get('tuiPanels') as InstanceType<typeof TuiPanelRuntime>
check('service mounted + host facade', svc !== undefined && getHostPanelRuntime(svc) !== undefined)

type PanelsService = InstanceType<typeof TuiPanelRuntime>
const rootSvc = root.get('tuiPanels') as PanelsService

// Root-context mutation must be rejected (requirePluginCaller).
let rootRegisterRejected = false
try { rootSvc.register({ apiVersion: 1, id: 'root-leak', title: 'root', component: () => null }) } catch { rootRegisterRejected = true }
check('root register rejected', rootRegisterRejected === true || rootSvc.register({ apiVersion: 1, id: 'root-leak', title: 'root', component: () => null }) === undefined)
let rootListRejected = false
try { rootSvc.list() } catch { rootListRejected = true }
check('root list rejected', rootListRejected)

// Two live plugin activations.
let pluginA: Context | undefined
let pluginB: Context | undefined
root.inject(['tuiPanels'], ctx => { pluginA = ctx })
root.inject(['tuiPanels'], ctx => { pluginB = ctx })
await new Promise(resolve => setImmediate(resolve))
if (pluginA === undefined || pluginB === undefined) throw new Error('could not create plugin activations')
const panelsA = pluginA.get('tuiPanels') as PanelsService
const panelsB = pluginB.get('tuiPanels') as PanelsService

function ledgerRecords(): { operation?: string; resource?: { kind?: string; id?: string }; result?: string; errorCode?: string }[] {
  try {
    return readFileSync(ledgerFile, 'utf8').split(/\r?\n/u).filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>) as never
  } catch {
    return []
  }
}

// ── register full chain ───────────────────────────────────────────────────
applySidePanelPanels('todo')
const disposeA = panelsA.register({ apiVersion: 1, id: 'metrics', title: 'Metrics', icon: '◉', component: () => null })
check('register returns disposer', typeof disposeA === 'function')
const entryA = panelStore.list().find(e => e.definition.id.endsWith(':metrics'))
check('store entry with plugin: prefix id', entryA !== undefined && /^[a-z0-9_-]+:metrics$/u.test(entryA.definition.id))
check('source/mountPolicy/minColumns forced', entryA !== undefined
  && entryA.definition.source === 'plugin'
  && entryA.definition.mountPolicy === 'active'
  && entryA.definition.minColumns === 28)
check('enabled CSV gains plugin id', parseSidePanelIds(getSidePanelPanels()).includes(entryA!.definition.id))
check('own list() summary', panelsA.list().some(p => p.id === entryA!.definition.id)
  && !panelsA.list().some(p => (p as { title?: string }).title === undefined))
check('ledger bind applied', ledgerRecords().some(r => r.resource?.kind === 'panel' && r.resource?.id === entryA!.definition.id && r.result === 'applied'))

// descriptor validation
check('apiVersion gate', panelsA.register({ apiVersion: 2 as never, id: 'v2', title: 'x', component: () => null }) === undefined)
check('bad id gate', panelsA.register({ apiVersion: 1, id: 'Bad Id', title: 'x', component: () => null }) === undefined)
check('empty title gate', panelsA.register({ apiVersion: 1, id: 't', title: '  ', component: () => null }) === undefined)
check('icon width gate', panelsA.register({ apiVersion: 1, id: 'ic', title: 'x', icon: '中文', component: () => null }) === undefined)
check('component-or-compact gate', panelsA.register({ apiVersion: 1, id: 'none', title: 'x' }) === undefined)
check('compact maxRows gate', panelsA.register({ apiVersion: 1, id: 'cz', title: 'x', compact: { maxRows: 4 as never, component: () => null } }) === undefined)
const disposeCompact = panelsA.register({ apiVersion: 1, id: 'compact-only', title: 'Compact', compact: { maxRows: 2, component: () => null } })
check('compact-only accepted (validated, not mounted)', typeof disposeCompact === 'function')

// duplicate + budget
check('duplicate id undefined', panelsA.register({ apiVersion: 1, id: 'metrics', title: 'Again', component: () => null }) === undefined)
check('duplicate ledger DUPLICATE_CONTRIBUTION_ID', ledgerRecords().some(r => r.errorCode === 'DUPLICATE_CONTRIBUTION_ID'))
check('per-plugin budget ≤4', (() => {
  for (let i = 0; i < 4; i += 1) {
    panelsA.register({ apiVersion: 1, id: 'extra' + i, title: 'E', component: () => null })?.()
  }
  // A now owns metrics + compact-only (2); two more fit, the third must fail.
  const ok1 = panelsA.register({ apiVersion: 1, id: 'p3', title: 'E', component: () => null }) !== undefined
  const ok2 = panelsA.register({ apiVersion: 1, id: 'p4', title: 'E', component: () => null }) !== undefined
  const bad = panelsA.register({ apiVersion: 1, id: 'p5', title: 'E', component: () => null }) === undefined
  return ok1 && ok2 && bad
})())
check('budget ledger PANEL_BUDGET_EXCEEDED', ledgerRecords().some(r => r.errorCode === 'PANEL_BUDGET_EXCEEDED'))
// cleanup extras so later counts stay deterministic
for (const id of [...panelsA.list().map(p => p.id)]) {
  if (!id.endsWith(':metrics')) {
    // find its disposer? register returned them above but we dropped some;
    // dropping via a fresh re-register is impossible — remove by store side.
  }
}
// (extras stay registered under A; that is fine for the remaining checks)

// ── ownership: B cannot touch A's panel ──────────────────────────────────
const idA = entryA!.definition.id
check('foreign badge rejected', panelsB.badge(idA, { level: 'info', unread: 1 }) === false)
check('foreign open rejected', panelsB.open(idA) === false)
check('foreign close rejected', panelsB.close(idA) === false)
check('unknown id open rejected', panelsA.open('nobody:home') === false)

// ── badge ────────────────────────────────────────────────────────────────
check('own badge applied', panelsA.badge(idA, { level: 'warning', unread: 3 }) === true && panelStore.get(idA)?.badge?.unread === 3)
check('own badge cleared', panelsA.badge(idA, null) === true && panelStore.get(idA)?.badge === null)
check('invalid badge rejected', panelsA.badge(idA, { level: 'nope' as never, unread: 1 }) === false)

// ── open rate limit + no-consumer semantics ─────────────────────────────
check('open without Chat consumer returns false', panelsA.open(idA) === false)
panelBridgeRequests.attach()
check('first open with consumer accepted', panelsA.open(idA) === true)
check('second open within 5s dropped', panelsA.open(idA) === false)
check('rate-limit ledger RATE_LIMITED', ledgerRecords().some(r => r.errorCode === 'RATE_LIMITED' && r.resource?.id === idA))
check('close routed with consumer', panelsA.close(idA) === true)
panelBridgeRequests.detach()

// ── subscribe: own events only ───────────────────────────────────────────
const eventsA: string[] = []
const disposeSub = panelsA.subscribe(event => {
  eventsA.push(event.type + ':' + event.id)
  if (event.type === 'badge') throw new Error('listener crash must be swallowed')
})
const disposeB = panelsB.register({ apiVersion: 1, id: 'bpanel', title: 'B', component: () => null })
const idB = panelsB.list().find(e => e.id.endsWith(':bpanel'))?.id ?? 'b:none'
panelsA.badge(idA, { level: 'info', unread: 1 })
panelsB.badge(idB, { level: 'info', unread: 1 })
check('own badge event delivered + listener crash swallowed', eventsA.some(e => e === 'badge:' + idA))
check('foreign badge event filtered', !eventsA.some(e => e === 'badge:' + idB))
disposeCompact?.()
await new Promise(resolve => setImmediate(resolve))
check('own unregistered event delivered', eventsA.some(e => e.startsWith('unregistered:') && e.endsWith(':compact-only')))
const beforeForeign = eventsA.length
disposeB()
await new Promise(resolve => setImmediate(resolve))
check('foreign unregistered event filtered', eventsA.slice(beforeForeign).every(e => !e.endsWith(':bpanel')))
disposeSub()

// ── crash disable (store level) ──────────────────────────────────────────
panelStore.reportError(idA, new Error('crash-1'))
panelStore.reportError(idA, new Error('crash-2'))
panelStore.reportError(idA, new Error('crash-3'))
check('3 crashes disable the panel', panelStore.get(idA)?.disabled === true)

// ── dispose: store entry + CSV + ledger release ─────────────────────────
disposeA?.()
check('dispose removes store entry', panelStore.get(idA) === undefined)
check('dispose cleans enabled CSV', !parseSidePanelIds(getSidePanelPanels()).includes(idA))
check('dispose records ledger release', ledgerRecords().some(r => r.resource?.id === idA && r.result === 'applied' && r.operation === 'release'))

// ── #1454: snapshot applies must not drop plugin-registered panels ────────
// The dsh-tui settings watch replays `sidePanel.panels` snapshots; a
// snapshot written before a plugin registered must keep that plugin's panel
// enabled, an undefined snapshot keeps the store as-is, and an id dropped
// between two applied snapshots reads as a user untick and stays dropped.
{
  const { applySidePanelPanelsPreserving } = prefs
  applySidePanelPanels('todo')
  let disposeKeep: (() => void) | undefined
  root.inject(['tuiPanels'], ctx => {
    disposeKeep = (ctx.get('tuiPanels') as PanelsService).register({
      apiVersion: 1, id: 'keep', title: 'Keep', icon: '◆', component: () => null,
    })
  })
  await new Promise(resolve => setImmediate(resolve))
  const keepId = panelStore.list().find(e => e.definition.id.endsWith(':keep'))?.definition.id ?? ''
  check('1454 panel registered + CSV gains id', keepId !== '' && parseSidePanelIds(getSidePanelPanels()).includes(keepId))
  // stale document (predates the plugin) replays: id survives
  applySidePanelPanelsPreserving('todo', () => [keepId])
  check('1454 stale snapshot keeps plugin id', parseSidePanelIds(getSidePanelPanels()).includes(keepId))
  // identical replay (unrelated settings edit): id still survives
  applySidePanelPanelsPreserving('todo', () => [keepId])
  check('1454 identical replay keeps plugin id', parseSidePanelIds(getSidePanelPanels()).includes(keepId))
  // undefined snapshot (user layer + config both unset): store untouched
  applySidePanelPanelsPreserving(undefined, () => [keepId])
  check('1454 undefined snapshot keeps store', parseSidePanelIds(getSidePanelPanels()).includes(keepId))
  // user unticks: snapshot changes from one that included the id to one without
  applySidePanelPanelsPreserving(`todo,${keepId}`, () => [keepId])
  applySidePanelPanelsPreserving('todo', () => [keepId])
  check('1454 user untick drops plugin id', !parseSidePanelIds(getSidePanelPanels()).includes(keepId))
  disposeKeep?.()
}

// ── render smoke: crash isolation + disabled card ───────────────────────
// fresh panel that throws on every render (boundary catches → error card)
const smokeComponent = (): null => { throw new Error('plugin boom') }
applySidePanelPanels('todo')
applySidePanelPanels(getSidePanelPanels())
let smokeDispose: (() => void) | undefined
let smokePanelId = ''
root.inject(['tuiPanels'], ctx => {
  smokeDispose = (ctx.get('tuiPanels') as PanelsService).register({
    apiVersion: 1, id: 'smoke', title: 'Smoke', icon: '◆', component: smokeComponent as never,
  })
})
await new Promise(resolve => setImmediate(resolve))
smokePanelId = panelStore.list().find(e => e.definition.id.endsWith(':smoke'))?.definition.id ?? ''
check('smoke panel registered', smokePanelId !== '')

const notifyCalls: string[] = []
const channelStub = {
  version: 0, rows: [], status: 'idle', working: false, sessionId: 's1', cwd: '/tmp',
  spinnerMode: 'idle', goal: undefined, todos: [], subagents: [], backgroundJobs: [],
  notify(text: string) { notifyCalls.push(text) },
  subscribe() { return () => {} },
}
const fakeController = {
  enabledPanelIds: [smokePanelId],
  activePanelId: smokePanelId,
  focus: 'panel' as const,
  zoom: false,
  runtime: { registerInput: () => () => {}, dispatchKey: () => false },
}

const ROWS = 16
const COLS = 60
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; override ref() { return this }; override unref() { return this } }

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const app = await render(
  <AlternateScreen>
    <ThemeProvider theme="dark">
      <Box>
        <Box flexDirection="column" width={20}><Text>chat-ok</Text></Box>
        <PanelHost
          controller={fakeController as never}
          channel={channelStub as never}
          width={38}
          height={12}
        />
      </Box>
    </ThemeProvider>
  </AlternateScreen>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
await settled(() => lines().some(l => l.includes('chat-ok')))
await sleep(60) // 固定窗:pacing 首帧错误卡渲染 flush
const frame1 = lines()
check('render smoke: chat unaffected', frame1.some(l => l.includes('chat-ok')))
check('render smoke: error card shown', frame1.some(l => l.includes('面板渲染出错')))
panelStore.reportError(smokePanelId, new Error('crash-2'))
panelStore.reportError(smokePanelId, new Error('crash-3'))
await settled(() => lines().some(l => l.includes('面板已禁用')))
check('render smoke: disabled card after 3 crashes', lines().some(l => l.includes('面板已禁用')))
check('render smoke: disable toast fired once', notifyCalls.filter(text => text.includes('禁用')).length === 1)
await app.unmount()
smokeDispose?.()

rmSync(ledgerDir, { recursive: true, force: true })
if (failed > 0) {
  console.error('verify-plugin-panels FAILED: ' + failed)
  process.exit(1)
}
console.log('verify-plugin-panels ALL PASS')
