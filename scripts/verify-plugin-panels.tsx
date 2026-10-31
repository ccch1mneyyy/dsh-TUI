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
 *    and the stored `sidePanel.panels` value left untouched (registration
 *    never rewrites the setting; `*` derives the enabled set from the
 *    registry instead);
 *  - duplicate id → undefined + ledger DUPLICATE_CONTRIBUTION_ID;
 *  - per-plugin budget (≤4) → undefined + ledger PANEL_BUDGET_EXCEEDED;
 *  - descriptor validation: apiVersion/id/title/icon-width/component-or-
 *    compact/maxRows;
 *  - badge/list/open/close ownership: foreign ids rejected;
 *  - open rate limit: second open within 5s dropped + ledger RATE_LIMITED
 *    (no-consumer open returns false without rate-limit consumption);
 *  - subscribe: only own-panel events (registered/badge/unregistered/
 *    disabled), listener errors swallowed;
 *  - dispose → store entry gone, effective set no longer enables it, ledger
 *    release recorded;
 *  - a reverse-DNS Component (`com.example.echo`, the manifest grammar)
 *    registers `com.example.echo:main`, which `sidePanel.panels` persists and
 *    re-parses unchanged; legacy and anonymous addresses are unaffected.
 *
 * Render smoke (headless XTerm): throwing plugin panel renders the error
 * card and the chat body stays intact; the 3rd reportError flips the entry
 * to the session-disabled card and fires one channel.notify toast.
 *
 * Kit surface (headless XTerm): ui.Markdown / ui.CodeBlock render inside a
 * panel-narrowed TerminalSizeContext — 28/38 columns plus a resize to 60,
 * fence length outgrows inner ``` runs, the language label sheds backticks
 * and spaces, ui.CodeBlock keeps prompt-analysis tag blocks (raw code), and
 * the code body picks up cli-highlight's colours once it loads.
 *
 * WP3 (docs/plugin-ui-kit-design.md §4 + 二期): every chart-kit member on
 * `ui` is the kit's own object; `snapshot().usage` mirrors the ChannelUi
 * fields (occupancy/breakdown/tokens, backend cost first, DeepSeek CNY
 * estimate second) frozen; params validate as JSON (functions/cycles/
 * non-finite/class instances/>16 KiB refused, `__proto__` stays a key),
 * reach `host.useParams()` and keep identity when deep-equal; openPanel/
 * openScene only reach own registrations; openFile resolves against the
 * session cwd into the host preview scene; openSession goes through
 * `channel.resumeTo` with the /resume notices and a 2s rate limit; copy writes
 * OSC 52 through the renderer and announces itself; opened/closed/focused/
 * blurred come deduped from PanelStore.setPresentation and from a real
 * useSidePanel; compact rows render between chat and prompt only while the
 * split is not rendering, inside a 3-row budget, clipped, crash-isolated.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-panels.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { ReactNode } from 'react'
import type { TuiPanelProps } from '../src/panels.js'

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
const { applyCodeFrameStyle, applySidePanelPanels, getHiddenTemporarySidePanels, getSidePanelPanels, isTemporarySidePanelId, normalizeSidePanelPanels, parseSidePanelPanels, resolveSidePanelIds, setTemporarySidePanelHidden } = prefs
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
// Keep the persistent-selection cases on a verified Component. Anonymous
// activations below exercise the separate session-only selection path.
const { bindComponentIdentity } = await import('../src/dsh-adapter/component-identity.js')
const { parseManifest, projectManifest } = await import('../src/adapter/standard/protocols.js')
const { testManifest } = await import('./lib/plugin-test-utils.js')
const manifestA = parseManifest(testManifest({ id: 'verify-panel-a' }), { source: 'test:panels' })
bindComponentIdentity(pluginA, manifestA, projectManifest(manifestA), 'verify-panel-a-activation')
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
check('registration leaves the stored value untouched', getSidePanelPanels() === 'todo')
check('own list() summary', panelsA.list().some(p => p.id === entryA!.definition.id)
  && !panelsA.list().some(p => (p as { title?: string }).title === undefined))
check('ledger bind applied', ledgerRecords().some(r => r.resource?.kind === 'panel' && r.resource?.id === entryA!.definition.id && r.result === 'applied'))

const registeredIds = (): string[] => panelStore.list().map(e => e.definition.id)
const effectiveIds = (): readonly string[] => resolveSidePanelIds(getSidePanelPanels(), registeredIds())
const pluginIdA = entryA!.definition.id

// ── `*` derives the enabled set from the registry (issue #1662 / #1454) ────
// Registration never writes the setting: under `*` (the default) the panel is
// enabled because it is registered, and nothing has to be merged back on the
// next apply.
applySidePanelPanels('*')
check('store keeps the raw * sentinel', getSidePanelPanels() === '*')
check('* enables the registered plugin panel', effectiveIds().includes(pluginIdA))
applySidePanelPanels('*')
check('re-applying * is idempotent', effectiveIds().includes(pluginIdA) && getSidePanelPanels() === '*')
// The contract's other half: an explicit list is exact, so a registered panel
// that is not listed is hidden (statusBar parity). No union, no inference.
applySidePanelPanels('todo,jobs')
check('an explicit list hides an unlisted registered panel', !effectiveIds().includes(pluginIdA))
check('the explicit list still enables its own ids', effectiveIds().includes('todo') && effectiveIds().includes('jobs'))
applySidePanelPanels('*')
check('back under *, the plugin panel returns', effectiveIds().includes(pluginIdA))

// ── an explicit removal is just a list; replaying it changes nothing ──────
const disposeRemoved = panelsA.register({ apiVersion: 1, id: 'removable', title: 'Removable', component: () => null })
const removedId = panelStore.list().find(e => e.definition.id.endsWith(':removable'))?.definition.id ?? ''
check('removal fixture registered', removedId !== '' && effectiveIds().includes(removedId))
const withoutRemoved = effectiveIds().filter(id => id !== removedId).join(',')
applySidePanelPanels(withoutRemoved)
check('an explicit list stays exact (the removed one is out)',
  !effectiveIds().includes(removedId) && effectiveIds().includes(pluginIdA))
applySidePanelPanels(withoutRemoved)
check('replaying the same settings value does not revive it', !effectiveIds().includes(removedId))
disposeRemoved()
check('plugin unregister removes it from the effective set', !effectiveIds().includes(removedId))
applySidePanelPanels('*')

// descriptor validation
check('apiVersion gate', panelsA.register({ apiVersion: 2 as never, id: 'v2', title: 'x', component: () => null }) === undefined)
check('bad id gate', panelsA.register({ apiVersion: 1, id: 'Bad Id', title: 'x', component: () => null }) === undefined)
check('empty title gate', panelsA.register({ apiVersion: 1, id: 't', title: '  ', component: () => null }) === undefined)
check('icon width gate', panelsA.register({ apiVersion: 1, id: 'ic', title: 'x', icon: '中文', component: () => null }) === undefined)
check('component-or-compact gate', panelsA.register({ apiVersion: 1, id: 'none', title: 'x' }) === undefined)
check('compact maxRows gate', panelsA.register({ apiVersion: 1, id: 'cz', title: 'x', compact: { maxRows: 4 as never, component: () => null } }) === undefined)
const disposeCompact = panelsA.register({ apiVersion: 1, id: 'compact-only', title: 'Compact', compact: { maxRows: 2, component: () => null } })
check('compact-only accepted', typeof disposeCompact === 'function')

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
check('anonymous id has a disjoint session namespace', /^session:act[0-9]+:bpanel$/u.test(idB))
// A stored value cannot name a temporary panel, so its membership follows the
// registry (a saved selection leaves it alone) and closing it is session
// state that no replay revives.
applySidePanelPanels('todo')
check('a saved selection keeps the anonymous panel enabled',
  resolveSidePanelIds(getSidePanelPanels(), [idB]).includes(idB))
check('the stored value itself never carries the temporary id', !getSidePanelPanels().includes('session:'))
setTemporarySidePanelHidden(idB, true)
applySidePanelPanels('todo,jobs')
check('a saved selection cannot revive a session-only panel closed this run',
  !resolveSidePanelIds(getSidePanelPanels(), [idB], getHiddenTemporarySidePanels()).includes(idB))
setTemporarySidePanelHidden(idB, false)
applySidePanelPanels('todo,component:' + idB)
check('no stored spelling can name the temporary panel', !resolveSidePanelIds(getSidePanelPanels(), []).includes(idB))
check('session-only panel comes back without a saved id',
  resolveSidePanelIds(getSidePanelPanels(), [idB]).includes(idB))
panelsA.badge(idA, { level: 'info', unread: 1 })
panelsB.badge(idB, { level: 'info', unread: 1 })
check('own badge event delivered + listener crash swallowed', eventsA.some(e => e === 'badge:' + idA))
check('foreign badge event filtered', !eventsA.some(e => e === 'badge:' + idB))
disposeCompact?.()
await new Promise(resolve => setImmediate(resolve))
check('own unregistered event delivered', eventsA.some(e => e.startsWith('unregistered:') && e.endsWith(':compact-only')))
const beforeForeign = eventsA.length
setTemporarySidePanelHidden(idB, true)
check('a hidden temporary panel leaves the effective set',
  !resolveSidePanelIds(getSidePanelPanels(), [idB], getHiddenTemporarySidePanels()).includes(idB))
disposeB()
await new Promise(resolve => setImmediate(resolve))
check('foreign unregistered event filtered', eventsA.slice(beforeForeign).every(e => !e.endsWith(':bpanel')))
disposeSub()
// Hiding belongs to ONE registration: the same activation re-registering the
// same panel reuses its session-only id, and a fresh contribution must not be
// born hidden by the previous one (main's "re-registration is a new
// contribution", carried over to the run-local set).
const disposeB2 = panelsB.register({ apiVersion: 1, id: 'bpanel', title: 'B', component: () => null })
const idB2 = panelsB.list().find(e => e.id.endsWith(':bpanel'))?.id ?? ''
check('re-registration is a new contribution, not the hidden one',
  idB2 === idB && resolveSidePanelIds(getSidePanelPanels(), [idB2], getHiddenTemporarySidePanels()).includes(idB2),
  idB2 + ' hidden=' + JSON.stringify(getHiddenTemporarySidePanels()))
disposeB2()
await new Promise(resolve => setImmediate(resolve))

// ── reverse-DNS Component ids get a durable address (WP8) ─────────────────
// The manifest grammar (`com.example.echo`) is the norm for admitted plugins;
// the panel namespace follows the shared plugin-namespace grammar, so such a
// plugin registers `<id>:<sub>` — not a session-only `session:actN:<sub>` —
// and `sidePanel.panels` can persist it across restarts.
let pluginEcho: Context | undefined
root.inject(['tuiPanels'], ctx => { pluginEcho = ctx })
await new Promise(resolve => setImmediate(resolve))
if (pluginEcho === undefined) throw new Error('could not create the reverse-DNS activation')
const manifestEcho = parseManifest(testManifest({ id: 'com.example.echo' }), { source: 'test:panels' })
bindComponentIdentity(pluginEcho, manifestEcho, projectManifest(manifestEcho), 'verify-panel-echo-activation')
const panelsEcho = pluginEcho.get('tuiPanels') as PanelsService
const disposeEcho = panelsEcho.register({ apiVersion: 1, id: 'main', title: 'Echo', component: () => null })
const echoId = panelsEcho.list().find(p => p.id.endsWith(':main'))?.id ?? ''
check('a reverse-DNS Component registers <manifest id>:<sub>', typeof disposeEcho === 'function' && echoId === 'com.example.echo:main', echoId)
check('the reverse-DNS address is durable, not session-only', !isTemporarySidePanelId(echoId))
check('the registered definition carries the manifest id as pluginId', panelStore.get(echoId)?.definition.pluginId === 'com.example.echo')
check('the ledger records the reverse-DNS address',
  ledgerRecords().some(r => r.resource?.kind === 'panel' && r.resource?.id === echoId && r.result === 'applied'))
applySidePanelPanels('todo,' + echoId)
check('sidePanel.panels persists the reverse-DNS address', getSidePanelPanels() === 'todo,com.example.echo:main', getSidePanelPanels())
check('the stored value survives a re-parse',
  JSON.stringify(parseSidePanelPanels(getSidePanelPanels())) === JSON.stringify({ mode: 'list', ids: ['todo', 'com.example.echo:main'] })
    && normalizeSidePanelPanels(getSidePanelPanels()) === getSidePanelPanels())
check('the saved selection enables the reverse-DNS panel', effectiveIds().includes(echoId))
applySidePanelPanels('todo')
check('an explicit list without it hides it', !effectiveIds().includes(echoId))
applySidePanelPanels('todo,' + echoId)
disposeEcho?.()
check('unregistering keeps the saved id as a placeholder for the next run',
  getSidePanelPanels() === 'todo,com.example.echo:main' && effectiveIds().includes(echoId) && panelStore.get(echoId) === undefined)
const disposeEchoAgain = panelsEcho.register({ apiVersion: 1, id: 'main', title: 'Echo', component: () => null })
check('re-registration lands on the same saved address', panelStore.get(echoId) !== undefined && effectiveIds().includes(echoId))
disposeEchoAgain?.()

// ── nested fibers act under the plugin's identity ─────────────────────────
// A plugin registers from inside its own `ctx.inject([...], cb)` (the guide's
// examples do exactly that): the nested fiber inherits the nearest admitted
// ancestor's identity, so the panel still gets the durable `<id>:<sub>`
// address. A nested plugin with its own admitted manifest keeps its own.
const { componentIdentityOf } = await import('../src/dsh-adapter/component-identity.js')
let echoNested: Context | undefined
pluginEcho.inject(['tuiPanels'], ctx => { echoNested = ctx })
await new Promise(resolve => setImmediate(resolve))
if (echoNested === undefined) throw new Error('could not create the nested activation')
check('a nested fiber inherits the plugin identity', componentIdentityOf(echoNested)?.componentId === 'com.example.echo')
const disposeNested = (echoNested.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'nested', title: 'Nested', component: () => null })
check('a panel registered from a nested fiber gets the durable address',
  typeof disposeNested === 'function' && panelStore.get('com.example.echo:nested') !== undefined)
disposeNested?.()
let echoChild: Context | undefined
pluginEcho.inject(['tuiPanels'], ctx => { echoChild = ctx })
await new Promise(resolve => setImmediate(resolve))
if (echoChild === undefined) throw new Error('could not create the child plugin activation')
const manifestChild = parseManifest(testManifest({ id: 'com.example.child' }), { source: 'test:panels' })
bindComponentIdentity(echoChild, manifestChild, projectManifest(manifestChild), 'verify-panel-child-activation')
check('a nested plugin with its own manifest keeps its own identity', componentIdentityOf(echoChild)?.componentId === 'com.example.child')
// Admission asks for the activation's OWN binding: an identity a nested fiber
// only inherits must not read as "already admitted", or a nested plugin's own
// manifest would never be admitted.
const { ownComponentIdentityOf } = await import('../src/dsh-adapter/component-identity.js')
check('admission sees an inheriting nested fiber as not yet admitted itself',
  ownComponentIdentityOf(echoNested) === undefined && componentIdentityOf(echoNested)?.componentId === 'com.example.echo')
check('admission sees a nested plugin bound to its own manifest as admitted',
  ownComponentIdentityOf(echoChild)?.componentId === 'com.example.child')
check('the root never inherits a plugin identity', componentIdentityOf(root) === undefined)

// ── WP11: a nested fiber may pass its plugin's ctx as `identity` ─────────
// The trailing `identity` feeds the effect ledger's pluginId. A nested fiber
// acts under its plugin (componentIdentityOf walks up to it), so naming that
// ANCESTOR activation is the same identity — accepted, from top-level code
// and from inside the nested activation (its token current). Everything else
// stays refused: a sibling, an unrelated plugin, the root, a descendant, and
// a nested plugin with its own manifest naming its parent.
const nestedPanels = echoNested.get('tuiPanels') as PanelsService
const pluginIdOfLedger = (id: string): string | undefined =>
  (ledgerRecords() as { pluginId?: string; resource?: { id?: string }; operation?: string; result?: string }[])
    .find(r => r.resource?.id === id && r.operation === 'bind' && r.result === 'applied')?.pluginId
const disposeViaAncestor = nestedPanels.register({ apiVersion: 1, id: 'via-ancestor', title: 'A', component: () => null }, pluginEcho)
check('wp11 identity: a nested fiber may pass its plugin\'s ctx as identity',
  typeof disposeViaAncestor === 'function' && panelStore.get('com.example.echo:via-ancestor') !== undefined)
check('wp11 identity: the ledger attributes it to the plugin', pluginIdOfLedger('com.example.echo:via-ancestor') === 'com.example.echo',
  String(pluginIdOfLedger('com.example.echo:via-ancestor')))
disposeViaAncestor?.()
let disposeInside: unknown
let deeperInside: unknown
pluginEcho.inject(['tuiPanels'], nested => {
  disposeInside = (nested.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'inside', title: 'I', component: () => null }, pluginEcho)
  // Two levels down: still the same plugin.
  nested.inject(['tuiPanels'], deeper => {
    deeperInside = (deeper.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'deeper', title: 'D', component: () => null }, pluginEcho)
  })
})
await new Promise(resolve => setImmediate(resolve))
check('wp11 identity: … also from inside the nested activation\'s own callback', typeof disposeInside === 'function')
check('wp11 identity: … and from two levels down', typeof deeperInside === 'function')
;(disposeInside as (() => void) | undefined)?.()
;(deeperInside as (() => void) | undefined)?.()
check('wp11 identity: a sibling plugin\'s ctx is still refused',
  nestedPanels.register({ apiVersion: 1, id: 'sibling', title: 'S', component: () => null }, pluginA) === undefined)
check('wp11 identity: the root ctx is still refused',
  nestedPanels.register({ apiVersion: 1, id: 'rooted', title: 'R', component: () => null }, root) === undefined)
check('wp11 identity: a descendant ctx is refused (ancestors only)',
  panelsEcho.register({ apiVersion: 1, id: 'descendant', title: 'D', component: () => null }, echoNested) === undefined)
check('wp11 identity: a sibling nested fiber of the same plugin is refused',
  nestedPanels.register({ apiVersion: 1, id: 'cousin', title: 'C', component: () => null }, echoChild) === undefined)
check('wp11 identity: a nested plugin with its own manifest cannot name its parent',
  (echoChild.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'borrow', title: 'B', component: () => null }, pluginEcho) === undefined)
let insideSibling: unknown = 'unset'
pluginEcho.inject(['tuiPanels'], nested => {
  insideSibling = (nested.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'inside-sibling', title: 'S', component: () => null }, pluginA)
})
await new Promise(resolve => setImmediate(resolve))
check('wp11 identity: inside a nested activation, a sibling plugin\'s ctx is still refused', insideSibling === undefined)
// A nested fiber that rewrites its own `fiber.parent` cannot adopt another
// plugin: the ancestry is the one Cordis recorded at creation.
let forged: Context | undefined
pluginEcho.inject(['tuiPanels'], nested => { forged = nested })
await new Promise(resolve => setImmediate(resolve))
;(forged!.fiber as unknown as { parent: unknown }).parent = pluginA
check('wp11 identity: a rewritten fiber.parent does not make another plugin an ancestor',
  (forged!.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'forged', title: 'F', component: () => null }, pluginA) === undefined)
check('wp11 identity: … nor lends it that plugin\'s identity (inheritance walks the creation-time parent)',
  componentIdentityOf(forged!)?.componentId === 'com.example.echo', String(componentIdentityOf(forged!)?.componentId))
const disposeForged = (forged!.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'forged-own', title: 'F', component: () => null })
check('wp11 identity: … so its panel lands under its own plugin\'s namespace',
  typeof disposeForged === 'function' && panelStore.get('com.example.echo:forged-own') !== undefined && panelStore.get('verify-panel-a:forged-own') === undefined)
disposeForged?.()
// Legacy ids keep parsing exactly as before.
check('a legacy-grammar Component keeps its address', idA === 'verify-panel-a:metrics', idA)
check('legacy stored values parse identically',
  normalizeSidePanelPanels('todo,verify-panel-a:metrics,my_plugin:main,component:act1:x') === 'todo,verify-panel-a:metrics,my_plugin:main,component:act1:x'
    && parseSidePanelPanels('todo,session:act1:x').mode === 'invalid')
check('malformed dotted namespaces are still dropped',
  normalizeSidePanelPanels('todo,com..x:main,x.:main,.x:main') === 'todo')
applySidePanelPanels('*')

// ── crash disable (store level) ──────────────────────────────────────────
panelStore.reportError(idA, new Error('crash-1'))
panelStore.reportError(idA, new Error('crash-2'))
panelStore.reportError(idA, new Error('crash-3'))
check('3 crashes disable the panel', panelStore.get(idA)?.disabled === true)

// ── dispose: store entry + effective set + ledger release ───────────────
disposeA?.()
check('dispose removes store entry', panelStore.get(idA) === undefined)
check('dispose removes it from the effective set', !effectiveIds().includes(idA))
check('dispose records ledger release', ledgerRecords().some(r => r.resource?.id === idA && r.result === 'applied' && r.operation === 'release'))

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

// ── kit surface: ui.Markdown / ui.CodeBlock（#1456）──────────────────────
// 单独起 app：不放 chat 列、行数够，外层终端比面板宽 40 列。上面那条 60×16
// 的 app 面板正文只有 12 行、且第 0–19 列是 chat 列——九特性夹具在那里必然
// 被裁。外层终端必须明显更宽：「误用外层宽度」只有在越过 CodeBlockFrame 的
// 56 列宽表头阈值之后才看得见（见 openPanelScreen 的注释）。
const { stringWidth } = await import('../src/ink/stringWidth.js')
const { fenced } = await import('../src/components/sidePanel/panelMarkdown.js')

// 固定成 light：只有 header + rail，没有右边墙与底边，形态断言才确定。
applyCodeFrameStyle('light')

const RICH_MARKDOWN = [
  '# 面板标题',
  '',
  '一段足够长的正文，用来验证它在面板宽度内折行，而不是溢出后被裁掉。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用块',
  '',
  '- [x] 已完成的任务',
  '',
  '~~删除线~~ 与 [链接](https://example.com)',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer = 42',
  '```',
].join('\n')

/** 正文里含 ```：围栏必须比它长，否则后两行会跑到框外。 */
const TRICKY_CODE = 'const a = 1\n```\nconst b = 3'

function RichPanel({ ui: kit }: TuiPanelProps): ReactNode {
  const { Markdown } = kit
  return <Markdown>{RICH_MARKDOWN}</Markdown>
}

function CodePanel({ ui: kit }: TuiPanelProps): ReactNode {
  const { CodeBlock } = kit
  return <CodeBlock code={TRICKY_CODE} language="ts" />
}

/** `<context>` 是宿主对聊天正文剥离的 prompt 标签块；`ui.CodeBlock` 承诺
 *  「原始代码」，这三行必须原样到达屏幕（`ui.Markdown` 则保持聊天口径）。 */
const TAGGED_CODE = 'const before = 1\n<context>\nkept line\n</context>\nconst after = 2'

function TaggedPanel({ ui: kit }: TuiPanelProps): ReactNode {
  const { CodeBlock } = kit
  return <CodeBlock code={TAGGED_CODE} language="ts" />
}

let richDispose: (() => void) | undefined
let codeDispose: (() => void) | undefined
let taggedDispose: (() => void) | undefined
root.inject(['tuiPanels'], ctx => {
  const panels = ctx.get('tuiPanels') as PanelsService
  richDispose = panels.register({ apiVersion: 1, id: 'rich', title: 'Rich', component: RichPanel as never })
  codeDispose = panels.register({ apiVersion: 1, id: 'tricky', title: 'Tricky', component: CodePanel as never })
  taggedDispose = panels.register({ apiVersion: 1, id: 'tagged', title: 'Tagged', component: TaggedPanel as never })
})
await new Promise(resolve => setImmediate(resolve))
const panelIdBySuffix = (suffix: string): string =>
  panelStore.list().find(entry => entry.definition.id.endsWith(':' + suffix))?.definition.id ?? ''
const richPanelId = panelIdBySuffix('rich')
const codePanelId = panelIdBySuffix('tricky')
const taggedPanelId = panelIdBySuffix('tagged')
check('kit panels registered', richPanelId !== '' && codePanelId !== '' && taggedPanelId !== '')

/** 只挂 PanelHost 的一条 app：面板占左侧 width 列，外层终端更宽——于是
 *  「面板宽靠 TerminalSizeContext 收窄」才有可观测后果（终端宽 - 面板宽 >
 *  0 时，收窄一旦丢失，表格右边框就会落到裁剪线之外）。resize 用同一棵树
 *  走 Ink 的 rerender，证明宽度感知节点跟随面板宽度变化。 */
async function openPanelScreen(
  panelId: string,
  width: number,
  height: number,
): Promise<{
  lines: () => string[]
  cell: (x: number, y: number) => { isFgDefault(): boolean } | undefined
  resize: (nextWidth: number, nextHeight: number) => void
  close: () => Promise<void>
}> {
  // 外层要足够宽：误用外层宽度时 contentWidth（宽 - 4）必须越过 CodeBlockFrame
  // 的 56 列宽表头阈值，收窄丢失才有可见后果。
  const outerCols = (panelWidth: number): number => panelWidth + 40
  const xterm = new XTerm({ cols: outerCols(width), rows: height + 4, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(xterm)
  out.columns = xterm.cols
  out.rows = xterm.rows
  const controller = {
    enabledPanelIds: [panelId],
    activePanelId: panelId,
    focus: 'panel' as const,
    zoom: false,
    runtime: { registerInput: () => () => {}, dispatchKey: () => false },
  }
  const tree = (panelWidth: number, panelHeight: number): ReactNode => (
    <AlternateScreen>
      <ThemeProvider theme="dark">
        <Box width={panelWidth}>
          <PanelHost controller={controller as never} channel={channelStub as never} width={panelWidth} height={panelHeight} />
        </Box>
      </ThemeProvider>
    </AlternateScreen>
  )
  const rendered = await render(tree(width, height), {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const read = (): string[] => {
    const buf = xterm.buffer.active
    const lines: string[] = []
    for (let y = 0; y < xterm.rows; y += 1) lines.push((buf.getLine(y)?.translateToString(false) ?? '').trimEnd())
    return lines
  }
  return {
    lines: read,
    cell: (x, y) => xterm.buffer.active.getLine(y)?.getCell(x),
    resize: (nextWidth, nextHeight) => {
      xterm.resize(outerCols(nextWidth), nextHeight + 4)
      out.columns = xterm.cols
      out.rows = xterm.rows
      rendered.rerender(tree(nextWidth, nextHeight))
    },
    close: async () => { await rendered.unmount() },
  }
}

const wide = await openPanelScreen(richPanelId, 38, 32)
check(
  'markdown panel (38): renders heading/list/quote/strike/link',
  await settled(() => {
    const rows = wide.lines()
    return ['面板标题', '列表项一', '引用块', '删除线', 'example.com'].every(text => rows.some(line => line.includes(text)))
  }),
)
const wideLines = wide.lines()
const wideOverflow = wideLines.filter(line => stringWidth(line) > 38)
const wideTable = wideLines.find(line => line.includes('列A')) ?? ''
// 承重信号是「宽度感知节点按面板宽排版」，不是帧宽：
// - 代码框表头在 34 列内容宽下是窄形态（`┌─ ts`，无分隔线）；收窄一丢，
//   contentWidth 变 56，表头立刻带上分隔线。
// - 表格在 34 列预算下仍是有边框形态；收窄一丢，它按 56 排版并在 38 处折行，
//   表头那行不再以右边框收尾。
// 普通文本会被 Ink 按盒宽折行，帧宽永远不越界，所以宽断言本身证明不了收窄。
check(
  'markdown panel (38): width-aware nodes lay out against the panel width',
  wideOverflow.length === 0 && wideLines.includes('┌─ ts') && wideTable.endsWith('│'),
  wideOverflow[0] ?? (wideLines.find(line => line.startsWith('┌─')) ?? wideTable),
)
await wide.close()

const narrow = await openPanelScreen(richPanelId, 28, 32)
check('markdown panel (28): renders at the default minColumns', await settled(() => narrow.lines().some(line => line.includes('列A'))))
const narrowLines = narrow.lines()
const narrowOverflow = narrowLines.filter(line => stringWidth(line) > 28)
const narrowTable = narrowLines.find(line => line.includes('列A')) ?? ''
check(
  'markdown panel (28): width-aware nodes lay out against the panel width',
  narrowOverflow.length === 0 && narrowLines.includes('┌─ ts') && narrowTable.endsWith('│'),
  narrowOverflow[0] ?? (narrowLines.find(line => line.startsWith('┌─')) ?? narrowTable),
)
await narrow.close()

// 尺寸变化（#1456 验收）：同一棵树重渲染成 60 列，宽度感知节点必须换形态——
// 60 - 4 = 56 到达 CodeBlockFrame 的宽表头阈值，表头从 `┌─ ts` 变成带分隔线。
const resized = await openPanelScreen(richPanelId, 38, 32)
check('markdown panel: narrow form before resize', await settled(() => resized.lines().includes('┌─ ts')))
resized.resize(60, 32)
check(
  'markdown panel: resize re-lays width-aware nodes against the new width',
  await settled(() => resized.lines().some(line => line.startsWith('┌─ ts ─'))),
)
const resizedLines = resized.lines()
const resizedTable = resizedLines.find(line => line.includes('列A')) ?? ''
check(
  'markdown panel: resized frame and table fit the new width',
  resizedLines.filter(line => stringWidth(line) > 60).length === 0 && resizedTable.endsWith('│'),
  resizedLines.filter(line => stringWidth(line) > 60)[0] ?? resizedTable,
)
await resized.close()

const code = await openPanelScreen(codePanelId, 38, 16)
check('code block: body renders', await settled(() => code.lines().some(line => line.includes('const a = 1'))))
const codeLines = code.lines()
// 38 宽面板 → contentWidth 34 < 56，表头是窄形态（无分隔线）。出现分隔线
// 就说明 code frame 拿到了面板外的宽度。
check('code block: header stays in the panel-width form', codeLines.includes('┌─ ts'), codeLines.find(line => line.startsWith('┌─')) ?? '')
check(
  'code block: one frame holds all three rows (inner ``` did not close it)',
  codeLines.filter(line => line.startsWith('│ ')).length === 3,
  'rail rows=' + String(codeLines.filter(line => line.startsWith('│ ')).length),
)
check('code block: only one frame header (no stray re-opened fence)', codeLines.filter(line => line.startsWith('┌─ ')).length === 1)
// 高亮是异步加载的（文档第①条限制）：cli-highlight 就绪后，代码体里必须出现
// 非默认前景色。轨道（x=0）自带主题色，所以从 x=2（body 首列）起查。
const { getCliHighlightPromise } = await import('../src/terminal-utils/cliHighlight.js')
await getCliHighlightPromise()
check(
  'code block: body picks up cli-highlight colours once loaded',
  await settled(() => {
    const rows = code.lines()
    const row = rows.findIndex(line => line.includes('const a = 1'))
    if (row < 0) return false
    for (let x = 2; x <= 80; x += 1) {
      const cell = code.cell(x, row)
      if (cell !== undefined && !cell.isFgDefault()) return true
    }
    return false
  }),
)
await code.close()

const tagged = await openPanelScreen(taggedPanelId, 38, 20)
check(
  'code block: prompt-analysis tags stay in raw code',
  await settled(() => {
    const rows = tagged.lines()
    return rows.some(line => line.includes('<context>')) &&
      rows.some(line => line.includes('kept line')) &&
      rows.some(line => line.includes('</context>'))
  }),
)
check(
  'code block: tagged body keeps all five rows in one frame',
  tagged.lines().filter(line => line.startsWith('│ ')).length === 5,
  'rail rows=' + String(tagged.lines().filter(line => line.startsWith('│ ')).length),
)
await tagged.close()

check('fenced(): plain body gets three backticks', fenced('x').startsWith('```\n'))
check('fenced(): an inner ``` run gets four', fenced('a\n```\nb').startsWith('````\n'))
check('fenced(): an inner ````` run gets six', fenced('a\n`````\nb').startsWith('``````\n'))
check('fenced(): the language label sheds backticks and spaces', fenced('x', 'ts`\n````').startsWith('```ts\n'))

richDispose?.()
codeDispose?.()
taggedDispose?.()

// ── WP3：可视化套件 · usage 快照 · 共用 host 动词 · 生命周期 · compact 行 ──
const { tuiChartKit, tuiChartRowKit } = await import('../src/components/design-system/chartKit.js')
const surface = await import('../src/dsh-adapter/surface-host.js')
const registry = await import('../src/dsh-adapter/panel-runtime-registry.js')
const { buildPanelSnapshot } = await import('../src/components/sidePanel/panelSnapshot.js')
const { PanelCompactRows, selectCompactEntries, PANEL_COMPACT_ROWS } = await import('../src/components/sidePanel/PanelCompactRows.js')
const { useSidePanel } = await import('../src/components/sidePanel/useSidePanel.js')
const scenesMod = await import('../src/dsh-adapter/scenes.js')
const { t } = i18nMod
const { WORKING_GATE_NOTICES } = await import('../src/commands.js')
const { applySidePanelOpen, applySidePanelSplitEnabled } = prefs
type PanelHostApiT = TuiPanelProps['host']

await root.plugin(scenesMod.TuiSceneRuntime)
let pluginC: Context | undefined
root.inject(['tuiPanels', 'tuiScenes'], ctx => { pluginC = ctx })
await new Promise(resolve => setImmediate(resolve))
if (pluginC === undefined) throw new Error('could not create plugin activation C')
const panelsC = pluginC.get('tuiPanels') as PanelsService
const scenesC = pluginC.get('tuiScenes') as InstanceType<typeof scenesMod.TuiSceneRuntime>
const sceneHost = scenesMod.getHostSceneRuntime(root.get('tuiScenes') as never)!

const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-tui-surface-'))
writeFileSync(join(fixtureDir, 'fixture.txt'), 'one\ntwo\nthree\n')

let probeProps: TuiPanelProps | undefined
let probeParams: unknown = 'unset'
function ProbePanel(props: TuiPanelProps): ReactNode {
  probeProps = props
  probeParams = props.host.useParams()
  return React.createElement(props.ui.Text, null, 'probe-panel ' + JSON.stringify(probeParams ?? null))
}
let disposeProbe = panelsC.register({ apiVersion: 1, id: 'probe', title: 'Probe', component: ProbePanel })
const probeId = panelsC.list().find(p => p.id.endsWith(':probe'))?.id ?? ''
check('wp3: probe panel registered', probeId !== '')

const resumeCalls: string[] = []
const usageNotices: string[] = []
const usageChannel = {
  ...channelStub,
  sessionId: 's1',
  cwd: fixtureDir,
  provider: 'anthropic',
  model: 'claude-x',
  tokens: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 50, peak: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  contextOccupancy: { usedTokens: 4321, contextWindow: 128000, source: 'projection' },
  contextBreakdown: { systemTokens: 1000, toolsTokens: 2000, messageTokens: 1321 },
  costReport: { currency: 'USD', amount: 0.42, source: 'backend' },
  notify(text: string) { usageNotices.push(text); return () => {} },
  async resumeTo(id: string) { resumeCalls.push(id); return { ok: true as const } },
  closePluginScene() { sceneHost.close() },
}

const rawWrites: string[] = []
async function mountProbe(panelId: string, channel: unknown): Promise<{ lines: () => string[]; close: () => Promise<void> }> {
  const xterm = new XTerm({ cols: 60, rows: 12, scrollback: 0, allowProposedApi: true })
  class RecordingStdout extends FakeStdout {
    override _write(chunk: unknown, e: BufferEncoding, cb: () => void): void {
      rawWrites.push(String(chunk))
      super._write(chunk, e, cb)
    }
  }
  const out = new RecordingStdout(xterm)
  out.columns = 60
  out.rows = 12
  const controller = {
    enabledPanelIds: [panelId], activePanelId: panelId, focus: 'panel' as const, zoom: false,
    runtime: { registerInput: () => () => {}, dispatchKey: () => false },
  }
  const app = await render(
    <AlternateScreen>
      <ThemeProvider theme="dark">
        <PanelHost controller={controller as never} channel={channel as never} width={60} height={10} attention={{ approvals: 1, questions: 0 }} />
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const read = (): string[] => {
    const lines: string[] = []
    for (let y = 0; y < xterm.rows; y += 1) lines.push((xterm.buffer.active.getLine(y)?.translateToString(false) ?? '').trimEnd())
    return lines
  }
  return { lines: read, close: async () => { await app.unmount() } }
}

const probe = await mountProbe(probeId, usageChannel)
check('wp3: probe panel renders', await settled(() => probe.lines().some(line => line.includes('probe-panel'))))
const probeUi = probeProps?.ui as unknown as Record<string, unknown> | undefined
const probeHost = probeProps?.host as PanelHostApiT

// (a) kit：每个成员都是 chartKit 的同一个对象（不是宿主内部组件），旧成员仍在。
check('wp3 kit: every chart kit member is the kit object itself',
  probeUi !== undefined && Object.keys(tuiChartKit).every(key => probeUi[key] === (tuiChartKit as unknown as Record<string, unknown>)[key]),
  Object.keys(tuiChartKit).filter(key => probeUi?.[key] !== (tuiChartKit as unknown as Record<string, unknown>)[key]).join(','))
check('wp3 kit: full chart kit present (ColumnChart/Heatmap/Legend/Table/format/seriesColor/hashSeries)',
  ['StackedBar', 'Sparkline', 'Meter', 'ColumnChart', 'Heatmap', 'Legend', 'Table', 'format', 'seriesColor', 'hashSeries'].every(key => probeUi?.[key] !== undefined))
check('wp3 kit: existing panel members kept',
  ['Box', 'Text', 'Image', 'ScrollBox', 'Divider', 'Markdown', 'CodeBlock', 'useTerminalSize', 'useAnimationTime', 'useTheme'].every(key => probeUi?.[key] !== undefined))

// (b) usage 快照：与 ChannelUi 同源字段一一对应，冻结、不泄漏 peak/idle。
const snap = probeHost.snapshot()
check('wp3 usage: occupancy from contextOccupancy',
  JSON.stringify(snap.usage.occupancy) === JSON.stringify({ usedTokens: 4321, contextWindow: 128000, source: 'projection' }), JSON.stringify(snap.usage.occupancy))
check('wp3 usage: breakdown from contextBreakdown',
  JSON.stringify(snap.usage.breakdown) === JSON.stringify({ systemTokens: 1000, toolsTokens: 2000, messageTokens: 1321 }))
check('wp3 usage: tokens are the four running totals only',
  JSON.stringify(snap.usage.tokens) === JSON.stringify({ input: 1200, output: 340, cacheRead: 800, cacheWrite: 50 }), JSON.stringify(snap.usage.tokens))
check('wp3 usage: backend-reported cost wins',
  JSON.stringify(snap.usage.cost) === JSON.stringify({ currency: 'USD', amount: 0.42, source: 'backend' }))
check('wp3 usage: frozen structural copy', Object.isFrozen(snap.usage) && Object.isFrozen(snap.usage.tokens) && Object.isFrozen(snap.usage.occupancy))
check('wp3 usage: attention counts reach the snapshot', snap.attention.approvals === 1 && snap.attention.questions === 0)
const estimateSnap = buildPanelSnapshot({ ...usageChannel, costReport: undefined, provider: 'deepseek', model: 'deepseek-flash', mainCost: {}, subagentCost: [] } as never, undefined, undefined)
check('wp3 usage: DeepSeek official route falls back to the local CNY estimate',
  estimateSnap.usage.cost?.source === 'estimate' && estimateSnap.usage.cost.currency === 'CNY' && estimateSnap.usage.cost.amount > 0, JSON.stringify(estimateSnap.usage.cost))
const bareSnap = buildPanelSnapshot({ sessionId: 'x', provider: 'anthropic' } as never, undefined, undefined)
check('wp3 usage: unknown values stay undefined / zero (no throw on partial channels)',
  bareSnap.usage.occupancy === undefined && bareSnap.usage.breakdown === undefined && bareSnap.usage.cost === undefined
  && bareSnap.usage.tokens.input === 0)

// (c) params / useParams + 所有权。
check('wp3 params: freeze rejects functions', !surface.freezeSurfaceParams({ f: () => 1 }).ok)
const cyclic: Record<string, unknown> = {}
cyclic.self = cyclic
check('wp3 params: freeze rejects cycles', !surface.freezeSurfaceParams(cyclic).ok)
check('wp3 params: freeze rejects non-finite numbers', !surface.freezeSurfaceParams({ n: Number.NaN }).ok && !surface.freezeSurfaceParams([Infinity]).ok)
check('wp3 params: freeze rejects class instances', !surface.freezeSurfaceParams({ at: new Date() }).ok)
check('wp3 params: freeze rejects > 16 KiB', !surface.freezeSurfaceParams({ s: 'x'.repeat(17 * 1024) }).ok)
// The budget is enforced while copying: shared references (`x = [x, x]`) are
// not cycles, and walking every path of one shared 22 levels deep is 2^22
// nodes (≈1 s; 30 deep ran out of memory) — refused within the first 16 KiB.
const sharedBlowUp = (levels: number): unknown => {
  let shared: unknown = 'leaf'
  for (let level = 0; level < levels; level += 1) shared = [shared, shared]
  return shared
}
for (const levels of [22, 30]) {
  const blowUp = sharedBlowUp(levels)
  const started = performance.now()
  const refused = !surface.freezeSurfaceParams(blowUp).ok
  const elapsed = performance.now() - started
  check('wp11 params: x=[x,x] ×' + String(levels) + ' is refused in milliseconds', refused && elapsed < 100, elapsed.toFixed(1) + 'ms')
}
check('wp11 params: a value exactly at the budget still passes',
  surface.freezeSurfaceParams({ s: 'x'.repeat(surface.SURFACE_PARAMS_MAX_BYTES - 8) }).ok)
check('wp11 params: one byte over is refused', !surface.freezeSurfaceParams({ s: 'x'.repeat(surface.SURFACE_PARAMS_MAX_BYTES - 7) }).ok)
check('wp11 params: dropped undefined properties cost nothing',
  surface.freezeSurfaceParams(Object.fromEntries([...Array.from({ length: 20_000 }, (_, index) => ['k' + String(index), undefined]), ['a', 1]])).ok)
{
  // …but they still cost work: a million of them is refused at the property
  // bound instead of scanned whole and accepted as `{}`.
  const wide = Object.fromEntries(Array.from({ length: 1_000_000 }, (_, index) => ['u' + String(index), undefined]))
  const started = performance.now()
  const refusedWide = surface.freezeSurfaceParams(wide)
  check('wp11 params: a million dropped properties are refused at the work bound',
    !refusedWide.ok && refusedWide.reason.includes(String(surface.SURFACE_PARAMS_MAX_PROPERTIES)), JSON.stringify(refusedWide) + ' ' + (performance.now() - started).toFixed(0) + 'ms')
}
check('wp11 params: escapes past the budget are still caught by the exact check',
  !surface.freezeSurfaceParams({ s: '\u0001'.repeat(4000) }).ok)
check('wp11 params: a huge array is refused before its elements are walked',
  !surface.freezeSurfaceParams(new Array<number>(1_000_000).fill(0)).ok)
const protoParams = surface.freezeSurfaceParams(JSON.parse('{"__proto__":{"x":1},"keep":undefined}'.replace('undefined', 'null')))
check('wp3 params: __proto__ stays an own data key, copy is deep-frozen',
  protoParams.ok && protoParams.value !== null && typeof protoParams.value === 'object'
  && Object.getPrototypeOf(protoParams.value) === Object.prototype
  && Object.prototype.hasOwnProperty.call(protoParams.value, '__proto__') && Object.isFrozen(protoParams.value))
const dropUndefined = surface.freezeSurfaceParams({ a: 1, b: undefined })
check('wp3 params: undefined properties dropped like JSON', dropUndefined.ok && JSON.stringify(dropUndefined.value) === '{"a":1}')

panelBridgeRequests.attach()
check('wp3 params: tuiPanels.open with params accepted', panelsC.open(probeId, { tab: 'usage', n: 1 }) === true)
check('wp3 params: useParams() sees them on the panel',
  await settled(() => JSON.stringify(probeParams) === '{"tab":"usage","n":1}'), JSON.stringify(probeParams))
check('wp3 params: what the panel reads is frozen', Object.isFrozen(probeParams))
const reopen = (): void => { registry.getPanelOwnerRecord(probeId)!.openWindow.lastOpenAt = 0 }
reopen()
check('wp3 params: invalid params refused', panelsC.open(probeId, { bad: () => 1 } as never) === false)
check('wp3 params: a refused call does not burn the rate-limit window', probeHost.openPanel(probeId, { tab: 'files' }) === true)
check('wp3 params: host.openPanel re-open updates useParams()', await settled(() => JSON.stringify(probeParams) === '{"tab":"files"}'), JSON.stringify(probeParams))
const sameIdentity = probeParams
reopen()
probeHost.openPanel(probeId, { tab: 'files' })
await sleep(30) // 固定窗:探针 深相等的重开不得换掉参数身份（断言不变量）
check('wp3 params: deep-equal re-open keeps the params identity', probeParams === sameIdentity)
{
  // Deep-equal regardless of key order: no new identity, no notification.
  const canonKey = 'verify:canonical-params'
  const first = surface.freezeSurfaceParams({ a: 1, nested: { x: 1, y: [1, { p: 1, q: 2 }] } })
  const reordered = surface.freezeSurfaceParams({ nested: { y: [1, { q: 2, p: 1 }], x: 1 }, a: 1 })
  surface.setSurfaceParams(canonKey, first.ok ? first.value : undefined)
  let notified = 0
  const off = surface.subscribeSurfaceParams(canonKey, () => { notified += 1 })
  const kept = surface.getSurfaceParams(canonKey)
  surface.setSurfaceParams(canonKey, reordered.ok ? reordered.value : undefined)
  check('wp3 params: a reordered deep-equal value keeps the identity and notifies nobody', surface.getSurfaceParams(canonKey) === kept && notified === 0)
  surface.setSurfaceParams(canonKey, surface.freezeSurfaceParams({ a: 2 }).ok ? { a: 2 } : undefined)
  check('wp3 params: a different value still replaces and notifies', notified === 1)
  off()
  surface.clearSurfaceParams(canonKey)
}
check('wp3 params: rate limit still applies to host.openPanel', probeHost.openPanel(probeId, { tab: 'x' }) === false)
{
  // The window is the activation's: opening a second own panel right after
  // the first is refused too, and re-registering a panel does not reset it.
  const disposeSecond = panelsC.register({ apiVersion: 1, id: 'second', title: 'S', component: () => null })
  const secondId = panelStore.list().find(entry => entry.definition.id.endsWith(':second') && registry.getPanelOwnerRecord(entry.definition.id)?.owner === registry.getPanelOwnerRecord(probeId)?.owner)?.definition.id ?? ''
  check('wp3 rate limit: one window per activation, not per target panel', secondId !== '' && panelsC.open(secondId) === false)
  check('wp3 rate limit: the panels share it', registry.getPanelOwnerRecord(secondId)?.openWindow === registry.getPanelOwnerRecord(probeId)?.openWindow)
  disposeSecond?.()
}
let disposeForeign: (() => void) | undefined
let disposeForeignScene: (() => void) | undefined
root.inject(['tuiPanels', 'tuiScenes'], ctx => {
  disposeForeign = (ctx.get('tuiPanels') as PanelsService).register({ apiVersion: 1, id: 'foreignp', title: 'F', component: () => null })
  disposeForeignScene = (ctx.get('tuiScenes') as typeof scenesC).register({ id: 'foreign-scene', component: () => null })
})
await new Promise(resolve => setImmediate(resolve))
const foreignId = panelStore.list().find(e => e.definition.id.endsWith(':foreignp'))?.definition.id ?? ''
reopen()
check('wp3 own-only: host.openPanel refuses a foreign panel', foreignId !== '' && probeHost.openPanel(foreignId) === false)
check('wp3 own-only: host.openScene refuses a foreign scene', probeHost.openScene('foreign-scene') === false && sceneHost.active === undefined)
const disposeOwnScene = scenesC.register({ id: 'c-scene', component: () => null })
check('wp3 own-only: host.openScene opens an own scene with params',
  probeHost.openScene('c-scene', { focus: 'files' }) === true && sceneHost.active?.id === 'c-scene'
  && JSON.stringify(surface.getSurfaceParams(scenesMod.sceneParamsKeyFor(scenesC, 'c-scene'))) === '{"focus":"files"}')
check('wp3 own-only: tuiScenes.open refuses invalid params', scenesC.open('c-scene', { n: Number.POSITIVE_INFINITY }) === false)
sceneHost.close()

// openFile：校验、相对路径按会话 cwd 解析、交给宿主预览场景。
check('wp3 openFile: empty path refused', probeHost.openFile('') === false)
check('wp3 openFile: NUL in path refused', probeHost.openFile('a\u0000b') === false)
check('wp3 openFile: non-integer line refused', probeHost.openFile('fixture.txt', { line: 1.5 }) === false && probeHost.openFile('fixture.txt', { line: 0 }) === false)
check('wp3 openFile: opens the host preview scene', probeHost.openFile('fixture.txt', { line: 2 }) === true && sceneHost.active?.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID)
check('wp3 openFile: relative path resolved against the session cwd',
  JSON.stringify(surface.getSurfaceParams(scenesMod.sceneParamsKeyFor(scenesC, scenesMod.HOST_FILE_PREVIEW_SCENE_ID))) === JSON.stringify({ path: join(fixtureDir, 'fixture.txt'), line: 2 }))
check('wp3 openFile: the preview is not a listed plugin scene', !sceneHost.list().some(scene => scene.id === scenesMod.HOST_FILE_PREVIEW_SCENE_ID))
sceneHost.close()
check('wp3 openFile: closing the preview from chat lands on chat', sceneHost.active === undefined)

// openSession：与 /resume 同一路径（channel.resumeTo），每插件每 2s 至多 1 次。
check('wp3 openSession: the session already on screen resolves true without a switch', await probeHost.openSession('s1') === true && resumeCalls.length === 0)
check('wp3 openSession: invalid id refused', await probeHost.openSession('') === false && await probeHost.openSession('a\nb') === false)
check('wp3 openSession: switches through channel.resumeTo', await probeHost.openSession('s2') === true && resumeCalls.join(',') === 's2')
check('wp3 openSession: success notice is the /resume one', usageNotices.includes(t('resume-resumed')))
check('wp3 openSession: second call within 2s dropped', await probeHost.openSession('s3') === false && resumeCalls.join(',') === 's2')
const failNotices: string[] = []
const failChannel = (result: unknown) => ({
  sessionId: 's1',
  notify(text: string) { failNotices.push(text); return () => {} },
  async resumeTo() { return result as never },
})
check('wp3 openSession: working refusal → false + the /resume working notice',
  await surface.surfaceOpenSession({ owner: {}, runtime: { mode: 'legacy', slices: [] } }, failChannel({ ok: false, reason: 'working' }) as never, 's4', () => {}) === false
  && failNotices.includes(t(WORKING_GATE_NOTICES.resume)))
const beforeCancel = failNotices.length
check('wp3 openSession: cancelled (vetoed/stale-dropped) → false, no extra notice',
  await surface.surfaceOpenSession({ owner: {}, runtime: { mode: 'legacy', slices: [] } }, failChannel({ ok: false, reason: 'cancelled' }) as never, 's5', () => {}) === false
  && failNotices.length === beforeCancel)

// copy：校验 + OSC 52 经渲染器原始通道写出 + 宿主提示一次。
check('wp3 copy: empty / non-string refused', probeHost.copy('') === false && probeHost.copy(42 as never) === false)
const savedSsh = process.env.SSH_CONNECTION
const savedTmux = process.env.TMUX
process.env.SSH_CONNECTION = 'verify 0 0 0'
delete process.env.TMUX
const copyNoticeCount = usageNotices.length
check('wp3 copy: accepted', probeHost.copy('héllo') === true)
check('wp3 copy: OSC 52 written through the renderer', await settled(() => rawWrites.join('').includes(']52;c;' + Buffer.from('héllo', 'utf8').toString('base64'))))
check('wp3 copy: host announces the copy', usageNotices.slice(copyNoticeCount).includes(t('copied-chars', { n: 5 })))
// The invalid calls above did not use the window (the first valid one went
// through); a second valid copy inside it is dropped before any work.
const writesBeforeBurst = rawWrites.length
const noticesBeforeBurst = usageNotices.length
check('wp11 copy: a second copy within 1s is dropped (one per plugin per second)', probeHost.copy('again') === false && probeHost.copy('again') === false)
check('wp11 copy: a dropped copy announces nothing', usageNotices.length === noticesBeforeBurst)
await sleep(30) // 固定窗:探针 被限速的 copy 不得经渲染器写出 OSC 52（断言不变量）
check('wp11 copy: a dropped copy writes no OSC 52',
  !rawWrites.slice(writesBeforeBurst).join('').includes(']52;c;' + Buffer.from('again', 'utf8').toString('base64')))
check('wp11 copy: an over-cap text is refused before any work', probeHost.copy('x'.repeat(surface.COPY_MAX_CHARS + 1)) === false)
if (savedSsh === undefined) delete process.env.SSH_CONNECTION
else process.env.SSH_CONNECTION = savedSsh
if (savedTmux !== undefined) process.env.TMUX = savedTmux
await probe.close()
panelBridgeRequests.detach()

// (d) 生命周期事件：store 差分 + 去重，订阅只收自己的面板。
const lifecycle: string[] = []
const registeredSeen: string[] = []
const disposeLifecycle = panelsC.subscribe(event => {
  if (['opened', 'closed', 'focused', 'blurred'].includes(event.type)) lifecycle.push(event.type + ':' + (event.id === probeId ? 'probe' : event.id))
  if (event.type === 'registered') registeredSeen.push(event.id)
})
panelStore.setPresentation({ open: true, activePanelId: probeId, focus: 'chat' })
check('wp3 lifecycle: opened when it becomes the shown panel', lifecycle.join(',') === 'opened:probe', lifecycle.join(','))
panelStore.setPresentation({ open: true, activePanelId: probeId, focus: 'chat' })
check('wp3 lifecycle: same state is deduped', lifecycle.join(',') === 'opened:probe')
panelStore.setPresentation({ open: true, activePanelId: probeId, focus: 'panel' })
check('wp3 lifecycle: focused', lifecycle.join(',') === 'opened:probe,focused:probe')
panelStore.setPresentation({ open: true, activePanelId: foreignId, focus: 'panel' })
check('wp3 lifecycle: switching away → blurred then closed; foreign opened filtered',
  lifecycle.join(',') === 'opened:probe,focused:probe,blurred:probe,closed:probe', lifecycle.join(','))
panelStore.setPresentation({ open: true, activePanelId: probeId, focus: 'panel' })
panelStore.setPresentation({ open: false, activePanelId: probeId, focus: 'panel' })
check('wp3 lifecycle: collapsing the column → blurred then closed',
  lifecycle.slice(4).join(',') === 'opened:probe,focused:probe,blurred:probe,closed:probe', lifecycle.slice(4).join(','))
const beforeUnknown = lifecycle.length
panelStore.setPresentation({ open: true, activePanelId: 'nobody:none', focus: 'panel' })
check('wp3 lifecycle: an unregistered id emits nothing', lifecycle.length === beforeUnknown)
panelStore.setPresentation({ open: false, activePanelId: undefined, focus: 'chat' })

// 真实控制器：useSidePanel 的 open/active/focus 变化驱动同一组事件。
lifecycle.length = 0
applySidePanelPanels('*')
applySidePanelSplitEnabled(true)
applySidePanelOpen(false)
let controllerRef: ReturnType<typeof useSidePanel> | undefined
function ControllerProbe(): ReactNode {
  controllerRef = useSidePanel({ columns: 160, fullscreen: true, editorOpen: false })
  return null
}
const ctrlTerm = new XTerm({ cols: 60, rows: 6, scrollback: 0, allowProposedApi: true })
const ctrlApp = await render(<ControllerProbe />, {
  stdout: new FakeStdout(ctrlTerm) as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
await settled(() => controllerRef !== undefined)
{
  // A compact-only panel has no body: never a tab of the split, still part of
  // the enabled set its compact row follows.
  let disposeCompactOnly: (() => void) | undefined
  let compactPanels: PanelsService | undefined
  root.inject(['tuiPanels'], ctx => {
    compactPanels = ctx.get('tuiPanels') as PanelsService
    disposeCompactOnly = compactPanels.register({ apiVersion: 1, id: 'ctl-compact', title: 'Compact only', compact: { maxRows: 1, component: () => null } })
  })
  await new Promise(resolve => setImmediate(resolve))
  const compactOnlyId = panelStore.list().find(entry => entry.definition.id.endsWith(':ctl-compact'))?.definition.id ?? ''
  check('compact-only: registered as compact-only', compactOnlyId !== '' && panelStore.get(compactOnlyId)?.definition.compactOnly === true)
  check('compact-only: not a tab of the split, still in the compact set',
    await settled(() => controllerRef!.compactPanelIds.includes(compactOnlyId) && !controllerRef!.enabledPanelIds.includes(compactOnlyId)),
    JSON.stringify({ tabs: controllerRef!.enabledPanelIds, compact: controllerRef!.compactPanelIds }))
  controllerRef!.openPanel(compactOnlyId)
  check('compact-only: opening it never makes it the active tab', controllerRef!.activePanelId !== compactOnlyId)
  // The plugin side agrees: open() answers false, stores no params and
  // leaves the activation's rate window untouched.
  {
    const window = registry.getPanelOwnerRecord(compactOnlyId)!.openWindow
    const savedAt = window.lastOpenAt
    window.lastOpenAt = 0
    const compactOpened = compactPanels?.open(compactOnlyId, { tab: 'x' })
    check('compact-only: open() is refused without using the rate window or storing params',
      compactOpened === false && window.lastOpenAt === 0 && surface.getSurfaceParams(surface.panelParamsKey(compactOnlyId)) === undefined,
      JSON.stringify({ compactOpened, lastOpenAt: window.lastOpenAt }))
    window.lastOpenAt = savedAt
  }
  // Enabled alone (a persistable id: the admitted activation's), it leaves
  // the split nothing to show: the split stays collapsed (its row is already
  // above the prompt) instead of an empty column that takes the keyboard.
  const disposeStored = panelsA.register({ apiVersion: 1, id: 'ctl-compact-stored', title: 'Stored compact', compact: { maxRows: 1, component: () => null } })
  const storedId = panelStore.list().find(entry => entry.definition.id.endsWith(':ctl-compact-stored'))?.definition.id ?? ''
  const savedPanels = getSidePanelPanels()
  // Focus in the column as it collapses: it must go back to the chat, not
  // stay on a panel nobody sees that swallows every plain key.
  controllerRef!.openPanel(controllerRef!.enabledPanelIds[0]!, { focus: true })
  await settled(() => controllerRef!.split && controllerRef!.focus === 'panel')
  applySidePanelPanels(storedId)
  // Temporary panels are always enabled unless hidden for the run.
  const temporaryTabs = controllerRef!.enabledPanelIds.filter(id => isTemporarySidePanelId(id))
  for (const id of temporaryTabs) setTemporarySidePanelHidden(id, true)
  check('compact-only: enabled alone, the split is not available',
    storedId !== '' && await settled(() => controllerRef!.enabledPanelIds.length === 0 && controllerRef!.compactPanelIds.includes(storedId) && !controllerRef!.splitAvailable && !controllerRef!.open),
    JSON.stringify({ split: controllerRef!.splitAvailable, open: controllerRef!.open, tabs: controllerRef!.enabledPanelIds, stored: getSidePanelPanels() }))
  check('compact-only: a panel focus falls back to the chat when the split collapses',
    await settled(() => controllerRef!.focus === 'chat'), controllerRef!.focus)
  // Leave the column collapsed and the lifecycle log empty for the checks below.
  applySidePanelOpen(false)
  for (const id of temporaryTabs) setTemporarySidePanelHidden(id, false)
  applySidePanelPanels(savedPanels)
  disposeStored?.()
  await settled(() => controllerRef!.enabledPanelIds.length > 0)
  disposeCompactOnly?.()
  await new Promise(resolve => setImmediate(resolve))
  lifecycle.length = 0
}
controllerRef!.openPanel(probeId, { focus: true })
check('wp3 lifecycle (useSidePanel): openPanel → opened + focused',
  await settled(() => lifecycle.join(',') === 'opened:probe,focused:probe'), lifecycle.join(','))
// 深链一个已在分栏里显示的自己的面板：与场景重开同义——只更新参数、返回
// true、不计 5s 限速；收起后再开（真正的打开）照旧受限速。
const probeRecord = registry.getPanelOwnerRecord(probeId)!
probeRecord.openWindow.lastOpenAt = Date.now()
const windowStart = probeRecord.openWindow.lastOpenAt
const panelParams = (): string => JSON.stringify(surface.getSurfaceParams(surface.panelParamsKey(probeId)) ?? null)
check('wp11 deep link: re-opening the shown own panel updates its params at once',
  panelsC.open(probeId, { tab: 'live-1' }) === true && panelParams() === '{"tab":"live-1"}', panelParams())
check('wp11 deep link: … again inside the 5s window (host.openPanel, no rate limit while shown)',
  probeHost.openPanel(probeId, { tab: 'live-2' }) === true && panelParams() === '{"tab":"live-2"}', panelParams())
check('wp11 deep link: the shown re-opens did not use the window', probeRecord.openWindow.lastOpenAt === windowStart)
check('wp11 deep link: invalid params are still refused while shown', panelsC.open(probeId, { n: Number.NaN }) === false && panelParams() === '{"tab":"live-2"}')
controllerRef!.focusChat()
check('wp3 lifecycle (useSidePanel): focus back to chat → blurred', await settled(() => lifecycle.join(',') === 'opened:probe,focused:probe,blurred:probe'), lifecycle.join(','))
applySidePanelOpen(false)
check('wp3 lifecycle (useSidePanel): collapse → closed', await settled(() => lifecycle.at(-1) === 'closed:probe'), lifecycle.join(','))
check('wp11 deep link: opening it while the column is collapsed stays rate limited',
  panelsC.open(probeId, { tab: 'closed' }) === false && panelParams() === '{"tab":"live-2"}', panelParams())
applySidePanelOpen(true)
await settled(() => lifecycle.at(-1) === 'opened:probe')
// 屏上面板在一个同步段里撤下又注册（activation 重启）：控制器的 open/active/
// focus 都没变、它的 effect 不会再回写——store 重放最近的呈现，新注册照样
// 收到 opened(+focused)，之后的 blurred/closed 也就有了起点。
controllerRef!.focusPanel()
await settled(() => lifecycle.at(-1) === 'focused:probe')
const beforeReRegister = lifecycle.length
disposeProbe?.()
disposeProbe = panelsC.register({ apiVersion: 1, id: 'probe', title: 'Probe', component: ProbePanel })
const reRegistered = (): string => lifecycle.slice(beforeReRegister).join(',')
check('wp11 lifecycle (useSidePanel): re-registering the shown panel replays opened + focused',
  typeof disposeProbe === 'function' && reRegistered() === 'opened:probe,focused:probe', reRegistered())
check('wp11 lifecycle: the owner\'s subscriber also receives registered for its own panel', registeredSeen.includes(probeId), JSON.stringify(registeredSeen))
// The host the first registration rendered is bound to THAT registration: the
// same durable id registered again (a reload) must not hand it the new one.
const freshRecord = registry.getPanelOwnerRecord(probeId)!
check('wp11 stale host: the re-registration holds a record of its own',
  freshRecord !== probeRecord && registry.isLivePanelRegistration(freshRecord) && !registry.isLivePanelRegistration(probeRecord))
const resumesBeforeStale = resumeCalls.length
check('wp11 stale host: every verb of the old registration\'s host refuses',
  await probeHost.openSession('s-stale') === false && resumeCalls.length === resumesBeforeStale
  && probeHost.openFile('fixture.txt') === false && probeHost.copy('stale') === false
  && probeHost.openScene('c-scene') === false && probeHost.openPanel(probeId) === false
  && probeHost.toast('stale') === false && probeHost.focus() === false && probeHost.storage === undefined
  && probeHost.snapshot().sessionId === '' && probeHost.snapshot().usage.occupancy === undefined,
  'resumes=' + JSON.stringify(resumeCalls.slice(resumesBeforeStale)))
probeHost.notify('error', 9)
check('wp11 stale host: … and cannot badge the new registration', panelStore.get(probeId)?.badge?.unread !== 9)
// The panel is on screen, so the old host's openPanel above would have been a
// params-only deep link (true) had it reached the new registration.
check('wp11 stale host: the new registration\'s verbs act',
  registry.pluginPanelOpenPanel(freshRecord, probeId, { tab: 'fresh' }) === true && panelParams() === '{"tab":"fresh"}', panelParams())
controllerRef!.focusChat()
check('wp11 lifecycle (useSidePanel): the new registration then gets blurred, with no second opened',
  await settled(() => reRegistered() === 'opened:probe,focused:probe,blurred:probe'), reRegistered())
applySidePanelOpen(false)
check('wp11 lifecycle (useSidePanel): … and closed when the column collapses',
  await settled(() => reRegistered() === 'opened:probe,focused:probe,blurred:probe,closed:probe'), reRegistered())
applySidePanelOpen(true)
await settled(() => lifecycle.at(-1) === 'opened:probe')
await ctrlApp.unmount()
check('wp3 lifecycle (useSidePanel): controller unmount closes the shown panel', await settled(() => lifecycle.at(-1) === 'closed:probe'), lifecycle.join(','))
disposeLifecycle()
applySidePanelOpen(false)

// (e) compact 行：分栏不在渲染时挂在提示框上方；行预算、截断、错误隔离。
let compactPropsSeen: Record<string, unknown> | undefined
const compactRow = (label: string, extra?: string) => (props: import('../src/panels.js').TuiPanelCompactProps): ReactNode => {
  compactPropsSeen ??= props as unknown as Record<string, unknown>
  const { Box: CBox, Text: CText } = props.ui
  return React.createElement(CBox, { flexDirection: 'column' },
    React.createElement(CText, null, label + ' w=' + String(props.width) + ' b=' + String(props.badge?.unread ?? 0)),
    extra === undefined ? null : React.createElement(CText, null, extra))
}
disposeProbe?.()
const disposeC1 = panelsC.register({ apiVersion: 1, id: 'c1', title: 'C1', compact: { maxRows: 2, component: compactRow('compact-one') } })
const disposeC2 = panelsC.register({ apiVersion: 1, id: 'c2', title: 'C2', compact: { maxRows: 2, component: compactRow('compact-two') } })
const disposeC3 = panelsC.register({ apiVersion: 1, id: 'c3', title: 'C3', compact: { maxRows: 1, component: compactRow('compact-three', 'compact-three-overflow') } })
let disposeBoom: (() => void) | undefined
root.inject(['tuiPanels'], ctx => {
  disposeBoom = (ctx.get('tuiPanels') as PanelsService).register({
    apiVersion: 1, id: 'boomc', title: 'Boom', compact: { maxRows: 1, component: () => { throw new Error('compact boom') } },
  })
})
await new Promise(resolve => setImmediate(resolve))
const cId = (suffix: string): string => panelStore.list().find(e => e.definition.id.endsWith(':' + suffix))?.definition.id ?? ''
const compactIds = [cId('c1'), cId('c2'), cId('c3')]
check('wp3 compact: panels registered', compactIds.every(id => id !== '') && cId('boomc') !== '')
check('wp3 compact: budget picks c1 (2 rows) then skips c2 (2 > 1 left) and takes c3 (1 row)',
  selectCompactEntries(panelStore.list(), compactIds).map(entry => entry.definition.id).join(',') === [compactIds[0], compactIds[2]].join(','))
check('wp3 compact: total budget is 3 rows', PANEL_COMPACT_ROWS === 3)
panelsC.badge(compactIds[0]!, { level: 'warning', unread: 2 })
const compactTerm = new XTerm({ cols: 60, rows: 10, scrollback: 0, allowProposedApi: true })
const compactOut = new FakeStdout(compactTerm)
const compactTree = (split: boolean, ids: readonly string[]): ReactNode => (
  <ThemeProvider theme="dark">
    <Box flexDirection="column">
      <Text>chat-above</Text>
      <PanelCompactRows controller={{ split, enabledPanelIds: ids }} />
      <Text>prompt-below</Text>
    </Box>
  </ThemeProvider>
)
const compactApp = await render(compactTree(false, compactIds), {
  stdout: compactOut as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
const compactLines = (): string[] => {
  const lines: string[] = []
  for (let y = 0; y < compactTerm.rows; y += 1) lines.push((compactTerm.buffer.active.getLine(y)?.translateToString(false) ?? '').trimEnd())
  return lines
}
check('wp3 compact: rows render between chat and prompt when the split is not rendering',
  await settled(() => compactLines().some(line => line.includes('compact-one w=60 b=2')) && compactLines().some(line => line.includes('compact-three'))),
  compactLines().join('|'))
check('wp3 compact: a panel that does not fit the budget is skipped', !compactLines().some(line => line.includes('compact-two')))
check('wp3 compact: rows are clipped to maxRows', !compactLines().some(line => line.includes('compact-three-overflow')), compactLines().join('|'))
const seenUi = compactPropsSeen?.ui as Record<string, unknown> | undefined
check('wp3 compact: props carry React, width, badge and the row kit',
  compactPropsSeen?.React === React.default && seenUi !== undefined
  && seenUi.StackedBar === tuiChartRowKit.StackedBar && seenUi.Sparkline === tuiChartRowKit.Sparkline
  && seenUi.Meter === tuiChartRowKit.Meter && seenUi.format === tuiChartRowKit.format
  && typeof seenUi.Box === 'function' && typeof seenUi.Text === 'function')
check('wp3 compact: the row kit has no multi-row primitives', seenUi !== undefined && !('ColumnChart' in seenUi) && !('ScrollBox' in seenUi) && !('Table' in seenUi))
// While the split renders, a panel with a body is shown there instead; the
// compact-only ones (c1–c3 have no body) keep their row above the prompt.
const disposeCFull = panelsC.register({ apiVersion: 1, id: 'cfull', title: 'CF', component: () => null, compact: { maxRows: 1, component: compactRow('compact-full') } })
compactApp.rerender(compactTree(false, [cId('cfull'), ...compactIds]))
check('wp3 compact: a panel with a body has a compact row while the split is hidden',
  await settled(() => compactLines().some(line => line.includes('compact-full'))), compactLines().join('|'))
compactApp.rerender(compactTree(true, [cId('cfull'), ...compactIds]))
check('wp3 compact: its row is hidden while the split renders', await settled(() => !compactLines().some(line => line.includes('compact-full'))), compactLines().join('|'))
check('wp3 compact: compact-only rows stay while the split renders',
  compactLines().some(line => line.includes('compact-one')) && compactLines().some(line => line.includes('compact-three')), compactLines().join('|'))
disposeCFull?.()
compactApp.rerender(compactTree(false, [cId('boomc'), compactIds[2]!]))
check('wp3 compact: a crashing row shows a one-line error, the others keep rendering',
  await settled(() => compactLines().some(line => line.includes('面板渲染出错') && line.includes('compact boom')) && compactLines().some(line => line.includes('compact-three'))),
  compactLines().join('|'))
check('wp3 compact: the crash is reported to the store', panelStore.get(cId('boomc'))?.lastError?.message.includes('compact boom') === true)
await compactApp.unmount()

// (f) compact 行的 memo 与 snapshot：Chat 每个流式 delta 都重渲染 compact 槽；
// 输入没变的插件行不得因此重渲染。读 snapshot() 的行在用量变化时重渲染、
// 数字与宿主同源；从不读它的行不为它付任何代价。
check('wp11 compact: rows get snapshot() in their props', typeof compactPropsSeen?.snapshot === 'function')
{
  // `version` moves on every streamed delta and the row does not re-render
  // for it, so a compact snapshot must not carry it (it would read stale).
  const compactSnapshot = compactPropsSeen?.snapshot() as unknown as Record<string, unknown> | undefined
  check('wp11 compact: the row snapshot carries usage but no version',
    compactSnapshot !== undefined && 'usage' in compactSnapshot && !('version' in compactSnapshot) && Object.isFrozen(compactSnapshot),
    JSON.stringify(Object.keys(compactSnapshot ?? {})))
}
// Free activation C's panel budget (≤4) for the two rows below.
disposeC1?.()
disposeC2?.()
disposeC3?.()
let usingRenders = 0
let quietRenders = 0
let usingSnapshot: (() => unknown) | undefined
const usingRow = (props: import('../src/panels.js').TuiPanelCompactProps): ReactNode => {
  usingRenders += 1
  usingSnapshot = props.snapshot
  const occupancy = props.snapshot().usage.occupancy
  const pct = occupancy?.contextWindow === undefined ? '-' : String(Math.round((occupancy.usedTokens / occupancy.contextWindow) * 100))
  return React.createElement(props.ui.Text, null, 'memo-using ' + pct + '% b=' + String(props.badge?.unread ?? 0))
}
const quietRow = (props: import('../src/panels.js').TuiPanelCompactProps): ReactNode => {
  quietRenders += 1
  return React.createElement(props.ui.Text, null, 'memo-quiet b=' + String(props.badge?.unread ?? 0))
}
const disposeUsing = panelsC.register({ apiVersion: 1, id: 'cusing', title: 'U', compact: { maxRows: 1, component: usingRow } })
const disposeQuiet = panelsC.register({ apiVersion: 1, id: 'cquiet', title: 'Q', compact: { maxRows: 1, component: quietRow } })
const memoIds = [cId('cusing'), cId('cquiet')]
const memoChannel = {
  sessionId: 'm1', cwd: '/w', provider: 'anthropic', model: 'x', version: 0, working: true, spinnerMode: 'responding',
  todos: [], subagents: [], backgroundJobs: [],
  tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextOccupancy: { usedTokens: 250, contextWindow: 1000, source: 'backend' as const },
}
let committedVersion = -1
function CommitProbe({ version }: { readonly version: number }): ReactNode {
  React.useEffect(() => { committedVersion = version }, [version])
  return null
}
// Each call is a fresh controller object, as Chat's useSidePanel returns one per render.
const memoTree = (): ReactNode => (
  <ThemeProvider theme="dark">
    <Box flexDirection="column">
      <CommitProbe version={memoChannel.version} />
      <PanelCompactRows controller={{ split: false, enabledPanelIds: memoIds }} channel={memoChannel as never} approvals={0} questions={0} />
    </Box>
  </ThemeProvider>
)
const memoTerm = new XTerm({ cols: 60, rows: 6, scrollback: 0, allowProposedApi: true })
const memoApp = await render(memoTree(), {
  stdout: new FakeStdout(memoTerm) as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})
const memoLines = (): string[] => {
  const lines: string[] = []
  for (let y = 0; y < memoTerm.rows; y += 1) lines.push((memoTerm.buffer.active.getLine(y)?.translateToString(false) ?? '').trimEnd())
  return lines
}
/** A Chat re-render: bump the channel version (a streamed delta) and wait for the commit. */
const streamDelta = async (): Promise<void> => {
  memoChannel.version += 1
  memoApp.rerender(memoTree())
  await settled(() => committedVersion === memoChannel.version)
}
check('wp11 compact: both rows render',
  await settled(() => memoLines().some(line => line.includes('memo-using 25%')) && memoLines().some(line => line.includes('memo-quiet'))), memoLines().join('|'))
// The first re-render after a row first called snapshot() switches that row's
// key from "unused" to the snapshot inputs: one re-render of that row only.
await streamDelta()
const usingBefore = usingRenders
const quietBefore = quietRenders
for (let delta = 0; delta < 5; delta += 1) await streamDelta()
check('wp11 compact: streamed deltas re-render neither row (inputs unchanged)',
  usingRenders === usingBefore && quietRenders === quietBefore, 'using ' + String(usingRenders - usingBefore) + ', quiet ' + String(quietRenders - quietBefore))
memoChannel.contextOccupancy = { usedTokens: 500, contextWindow: 1000, source: 'backend' }
await streamDelta()
check('wp11 compact: a usage change re-renders the row that reads snapshot(), with the footer\'s numbers',
  await settled(() => memoLines().some(line => line.includes('memo-using 50%'))) && usingRenders === usingBefore + 1, memoLines().join('|'))
check('wp11 compact: … and not the row that never asked for a snapshot', quietRenders === quietBefore)
panelsC.badge(cId('cquiet'), { level: 'info', unread: 4 })
check('wp11 compact: a badge change re-renders its row', await settled(() => memoLines().some(line => line.includes('memo-quiet b=4'))))
const quietAfterBadge = quietRenders
await streamDelta()
await streamDelta()
check('wp11 compact: the same badge keeps the row memoized', quietRenders === quietAfterBadge && usingRenders === usingBefore + 1)
await memoApp.unmount()
check('wp11 compact: a live row\'s snapshot reads the session', (usingSnapshot?.() as { sessionId?: string } | undefined)?.sessionId === 'm1')
disposeUsing?.()
check('wp11 compact: a snapshot kept past the unregister reads empty', (usingSnapshot?.() as { sessionId?: string; usage?: { occupancy?: unknown } } | undefined)?.sessionId === ''
  && (usingSnapshot?.() as { usage?: { occupancy?: unknown } }).usage?.occupancy === undefined)
disposeQuiet?.()

disposeC1?.()
disposeC2?.()
disposeC3?.()
disposeBoom?.()
disposeForeign?.()
disposeForeignScene?.()
disposeOwnScene()
rmSync(fixtureDir, { recursive: true, force: true })

rmSync(ledgerDir, { recursive: true, force: true })
if (failed > 0) {
  console.error('verify-plugin-panels FAILED: ' + failed)
  process.exit(1)
}
console.log('verify-plugin-panels ALL PASS')
