/**
 * Admission loader (src/dsh-adapter/admission-loader.ts) on a real Cordis
 * composition: a row whose package carries `dsh-plugin.json` registers its
 * panel under the manifest id when armed (absolute and bare specifiers) and
 * under session-only `session:act<N>` when not; a missing `tuiPluginHost` settles refused, bounded.
 * fake-home must load first: the plugin-host row writes the effect ledger.
 *
 * Run: node --import tsx/esm scripts/verify-admission-loader.ts
 */
import { findPackageJSON } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './lib/fake-home.mjs' // 必须最先：DATA_DIR/effect-ledger 在 import 时定死
import { settled } from './lib/term-test.mjs'

const { Context } = await import('@deepseek-ai/cordis')
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const hostRow = await import('../src/dsh-adapter/plugin-host.js')
const { TuiPanelRuntime } = await import('../src/dsh-adapter/panels.js')
const { armAdmissionLoader } = await import('../src/dsh-adapter/admission-loader.js')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-admission-loader-'))
const packageDir = join(dir, 'third-party-package')
mkdirSync(packageDir)
writeFileSync(join(dir, 'marker'), '')
/**
 * A second loading root for the bare-specifier case: bare names resolve relative
 * to the composition's baseUrl, not the cwd, so they need a `node_modules` there.
 */
const loadRoot = join(dir, 'load-root')
const BARE_PACKAGE = '@dsh-tui-verify/bare-third-party'
const barePackageDir = join(loadRoot, 'node_modules', '@dsh-tui-verify', 'bare-third-party')
mkdirSync(barePackageDir, { recursive: true })
const LOAD_BASE_URL = pathToFileURL(join(loadRoot, 'cordis.yml')).href
writeFileSync(join(loadRoot, 'cordis.yml'), '')
writeFileSync(join(barePackageDir, 'package.json'), JSON.stringify({
  name: BARE_PACKAGE,
  version: '0.1.0',
  type: 'module',
  main: 'main.js',
}, null, 2))

const manifestOf = (id: string): string => JSON.stringify({
  $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
  id,
  name: id,
  version: '0.1.0',
  manifestVersion: '0.15',
  facets: { host: { entry: 'main.js', apiVersion: 'v1alpha1' } },
  requires: { contracts: [] },
  permissions: [],
  contributes: { commands: [] },
  subscriptions: [],
  license: 'MIT',
  source: { repository: 'https://example.com/verify-admission-loader' },
}, null, 2)

/** The entry module both fixtures share: registers a panel, reports its ids. */
const ENTRY_SOURCE = `import { appendFileSync } from 'node:fs'
export default function thirdParty(ctx, config) {
  const panels = ctx.get('tuiPanels', false)
  const out = { hasPanels: panels !== undefined, registered: false, ids: [] }
  if (panels !== undefined) {
    const dispose = panels.register({ apiVersion: 1, id: 'demo', title: 'Demo', component: () => null })
    out.registered = typeof dispose === 'function'
    out.ids = panels.list().map(panel => panel.id)
  }
  appendFileSync(config.report, JSON.stringify(out) + '\\n')
}
`

/** A minimal Community v0.15 package: manifest + entry that registers a panel. */
function writePackage(id: string): string {
  // Every real plugin package carries a package.json, and the manifest is only
  // recognised beside the package boundary that establishes the entry's root.
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'verify-absolute-' + id, version: '0.1.0', type: 'module' }, null, 2))
  writeFileSync(join(packageDir, 'dsh-plugin.json'), manifestOf(id))
  writeFileSync(join(packageDir, 'main.js'), ENTRY_SOURCE)
  return join(packageDir, 'main.js')
}

interface MountedComposition {
  root: InstanceType<typeof Context>
  report: string
}

/** One composition: the loader, the real plugin-host row, tuiPanels. `withHost` false models issue #183. */
let compositionSequence = 0
async function mount(
  armed: boolean,
  retryAttempts?: number,
  withHost = true,
  baseUrl = pathToFileURL(join(dir, 'cordis.yml')).href,
): Promise<MountedComposition> {
  const report = join(dir, `${armed ? 'armed' : 'control'}-${++compositionSequence}-report.jsonl`)
  writeFileSync(report, '')
  const root = new Context()
  root.logger.warn = () => undefined
  root.logger.info = () => undefined
  await root.plugin(Loader, { baseUrl })
  if (withHost) await root.plugin({ name: hostRow.name, apply: hostRow.apply })
  await root.plugin(TuiPanelRuntime)
  if (armed) armAdmissionLoader(root, retryAttempts === undefined ? {} : { retryAttempts })
  return { root, report }
}

function reportedIds(report: string): string[] {
  const lines = readFileSync(report, 'utf8').split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return []
  const last = JSON.parse(lines[lines.length - 1]) as { ids?: string[] }
  return last.ids ?? []
}

async function activate(composition: MountedComposition, id: string): Promise<string> {
  const entry = writePackage(id)
  const previousReports = readFileSync(composition.report, 'utf8').split('\n').filter(Boolean).length
  await composition.root.loader.create({ id, name: entry, config: { report: composition.report } })
  await composition.root.loader.await()
  check('activation report arrived: ' + id, await settled(() => readFileSync(composition.report, 'utf8').split('\n').filter(Boolean).length > previousReports))
  return readFileSync(composition.report, 'utf8')
}

// Run in a fresh Node process: conditions must be active before ESM initialization.
const CONDITION = 'dsh-tui-admission-verify'
if (process.env.DSH_TUI_ADMISSION_CONDITION_CHILD === '1') {
  const outer = join(loadRoot, 'node_modules', '@dsh-tui-verify', 'conditioned')
  const inner = join(outer, 'panel')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: '@dsh-tui-verify/conditioned', type: 'module',
    exports: { './panel': { [CONDITION]: './active.js', import: './panel/index.js' } } }))
  writeFileSync(join(outer, 'dsh-plugin.json'), manifestOf('verify-active-condition'))
  writeFileSync(join(outer, 'active.js'), ENTRY_SOURCE)
  writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'verify-default-condition', type: 'module' }))
  writeFileSync(join(inner, 'dsh-plugin.json'), manifestOf('verify-default-condition'))
  writeFileSync(join(inner, 'index.js'), ENTRY_SOURCE)
  const composition = await mount(true, undefined, true, LOAD_BASE_URL)
  try {
    await composition.root.loader.create({ id: 'conditioned', name: '@dsh-tui-verify/conditioned/panel', config: { report: composition.report } })
    await composition.root.loader.await()
    const applied = await settled(() => reportedIds(composition.report).length > 0)
    check('active condition: execution and admission select the same component', applied && reportedIds(composition.report)[0] === 'verify-active-condition:demo', JSON.stringify(reportedIds(composition.report)))
  } finally { await composition.root.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
  process.exit(failed === 0 ? 0 : 1)
}

// ── control: no admission loader armed ────────────────────────────────────
const control = await mount(false)
await activate(control, 'verify-anonymous')
const controlIds = reportedIds(control.report)
check('control: the plugin applied and registered its panel', controlIds.length === 1, JSON.stringify(controlIds))
check('control: without the loader the panel falls back to the session-only namespace',
  controlIds.length === 1 && /^session:act\d+:demo$/u.test(controlIds[0]))
await control.root.fiber.dispose()

// ── armed: the real armAdmissionLoader on the composition ─────────────────
const armed = await mount(true)
await activate(armed, 'verify-admitted')
const armedIds = reportedIds(armed.report)
check('armed: the plugin applied and registered its panel', armedIds.length === 1, JSON.stringify(armedIds))
check('armed: admission lands before apply, so the panel carries the manifest id',
  armedIds.length === 1 && armedIds[0] === 'verify-admitted:demo')

// ── nested entry id: the shape a real profile actually produces ────────────
// A nested id (`a:b`) makes `EntryTree.resolve` throw: the pass must skip it
// and still handle every other activation.
const nested = await mount(true)
const groupFile = join(dir, 'nested-group.mjs')
writeFileSync(groupFile, `import { Group } from ${JSON.stringify(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js')).href,
)}
export default Group
`)
const nestedReport = join(dir, 'nested-report.jsonl')
writeFileSync(nestedReport, '')
await nested.root.loader.create({ id: 'include', name: groupFile, group: true, config: [] })
await nested.root.loader.await()
// The child's own id contains the separator, so it cannot resolve.
await nested.root.loader.create({
  id: 'dsh-tui-agent-preset-registry:agent-instructions',
  name: writePackage('verify-nested'),
  group: true,
  config: [],
})
await nested.root.loader.await()
// 固定窗:pacing 嵌套 entry 的激活落点没有可轮询完成条件（下一步的断言在另一组合上）
await sleep(300)
let nestedThrew: string | undefined
try {
  await activate(nested, 'verify-after-nested')
} catch (error) {
  nestedThrew = messageOf(error)
}
check('nested id: an unresolvable entry id does not tear the loader down',
  nestedThrew === undefined, nestedThrew ?? '')
check('nested id: the other activation on the same composition is still admitted',
  readFileSync(nested.report, 'utf8').includes('verify-after-nested:demo'), readFileSync(nested.report, 'utf8'))
await nested.root.fiber.dispose()

// ── admission boundary: a row nested in an admitted group is its own plugin ──
// Its own manifest is refused (unparseable), so it must get no identity at
// all — never the admitted group's, which it would inherit by fiber parent.
{
  const groupDir = join(dir, 'admitted-group')
  const childDir = join(dir, 'refused-child')
  mkdirSync(groupDir, { recursive: true })
  mkdirSync(childDir, { recursive: true })
  writeFileSync(join(groupDir, 'package.json'), JSON.stringify({ name: 'verify-admitted-group', version: '0.1.0', type: 'module' }))
  writeFileSync(join(groupDir, 'dsh-plugin.json'), manifestOf('verify-admitted-group'))
  writeFileSync(join(groupDir, 'main.js'), readFileSync(groupFile, 'utf8'))
  writeFileSync(join(childDir, 'package.json'), JSON.stringify({ name: 'verify-refused-child', version: '0.1.0', type: 'module' }))
  writeFileSync(join(childDir, 'dsh-plugin.json'), '{ "not": "a manifest" }')
  writeFileSync(join(childDir, 'main.js'), ENTRY_SOURCE)
  const grouped = await mount(true, 2)
  try {
    await grouped.root.loader.create({ id: 'admitted-group', name: join(groupDir, 'main.js'), group: true, config: [] })
    await grouped.root.loader.await()
    await grouped.root.loader.create({ id: 'refused-child', name: join(childDir, 'main.js'), config: { report: grouped.report } }, 'admitted-group')
    await grouped.root.loader.await()
    const applied = await settled(() => reportedIds(grouped.report).length > 0)
    const id = reportedIds(grouped.report)[0] ?? ''
    check('admission boundary: a refused row inside an admitted group does not inherit the group identity',
      applied && /^session:act\d+:demo$/u.test(id), id)
  } finally { await grouped.root.fiber.dispose() }
}

// Unloading the row must release its identity, so re-activation is admitted again.
const entryId = 'verify-admitted'
const entry = armed.root.loader.resolve(entryId) as { fiber?: { dispose?: () => Promise<unknown> } } | undefined
await entry?.fiber?.dispose?.()
// 固定窗:pacing 让撤销在 Cordis 里落定，之后没有断言锚点可轮询
await sleep(200)
const again = await activate(armed, 'verify-admitted-2')
check('armed: a fresh activation is admitted again (identity is per-activation)',
  readFileSync(armed.report, 'utf8').includes('verify-admitted-2:demo') || again.includes('verify-admitted-2:demo'))

await armed.root.fiber.dispose()

// A Component id and another Loader entry id may be identical. Exercise
// both activation orders with distinct package/entry/manifest identities.
let previousTemporary: string | undefined
for (const reverse of [false, true]) {
  const composition = await mount(true)
  const panelPrefs = await import('../src/tuiDisplayPrefs.js')
  // A stored value never carries a temporary address: a previous run's
  // `session:actN:…` is dropped on the way in (#1695).
  panelPrefs.applySidePanelPanels(previousTemporary === undefined ? 'todo,act1:search' : 'todo,' + previousTemporary)
  composition.report = join(dir, `collision-${reverse}.jsonl`)
  writeFileSync(composition.report, '')
  const packages = ['component', 'anonymous'].map(kind => {
    const folder = join(dir, `collision-${reverse}-${kind}`)
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: `verify-${kind}`, type: 'module' }))
    writeFileSync(join(folder, 'main.js'), ENTRY_SOURCE.replace("id: 'demo'", "id: 'search'"))
    if (kind === 'component') writeFileSync(join(folder, 'dsh-plugin.json'), manifestOf('verify-collision'))
    return { id: kind === 'component' ? 'different-entry' : 'verify-collision', name: join(folder, 'main.js') }
  })
  try {
    const ids: string[] = []
    for (const entry of reverse ? [...packages].reverse() : packages) {
      await composition.root.loader.create({ ...entry, config: { report: composition.report } })
      await composition.root.loader.await()
      check('collision fixture applied ' + entry.id, await settled(() => readFileSync(composition.report, 'utf8').split('\n').filter(Boolean).length > ids.length))
      ids.push(...reportedIds(composition.report))
    }
    const temporary = ids.find(id => /^session:act[0-9]+:search$/u.test(id))
    check('cross-source same name survives either order', ids.includes('verify-collision:search') && temporary !== undefined, JSON.stringify(ids))
    check('Component identity comes from manifest, not Loader entry id', !ids.includes('different-entry:search'))
    const registered = (await import('../src/components/sidePanel/PanelStore.js')).panelStore
    const liveIds = () => panelPrefs.resolveSidePanelIds(
      panelPrefs.getSidePanelPanels(),
      registered.list().map(entry => entry.definition.id),
      panelPrefs.getHiddenTemporarySidePanels(),
    )
    check('previous-run temporary preferences never become live entries',
      previousTemporary === undefined || !liveIds().includes(previousTemporary))
    if (temporary !== undefined) {
      panelPrefs.applySidePanelPanels('todo,verify-collision:search')
      check('durable settings replay keeps temporary panel enabled', liveIds().includes(temporary))
      panelPrefs.setTemporarySidePanelHidden(temporary, true)
      panelPrefs.applySidePanelPanels('todo,verify-collision:search')
      check('same settings replay keeps manually closed temporary panel off', !liveIds().includes(temporary))
      panelPrefs.setTemporarySidePanelHidden(temporary, false)
      previousTemporary = temporary
    }
    const componentEntry = composition.root.loader.resolve(reverse ? 'verify-collision' : 'different-entry') as { fiber?: { dispose?(): Promise<unknown> } } | undefined
    await componentEntry?.fiber?.dispose?.()
    check('unloading one owner leaves the other panel alive', temporary !== undefined && (reverse
      ? registered.get(temporary) === undefined && registered.get('verify-collision:search') !== undefined
      : registered.get(temporary) !== undefined && registered.get('verify-collision:search') === undefined))
  } finally { await composition.root.fiber.dispose() }
  const registered = (await import('../src/components/sidePanel/PanelStore.js')).panelStore
  check('composition teardown removes only its remaining live contribution', registered.get('verify-collision:search') === undefined && (previousTemporary === undefined || registered.get(previousTemporary) === undefined))
}
{
  // Exercise the legacy runtime identity contract without pretending act1 is
  // a valid current manifest id (Community manifests require a namespace).
  // Binding remains owned by the real Loader activation and its teardown.
  const composition = await mount(true)
  const identityModule = new URL('../src/dsh-adapter/component-identity.ts', import.meta.url).href
  const protocolsModule = new URL('../src/adapter/standard/protocols.ts', import.meta.url).href
  const legacyEntry = join(dir, 'legacy-identity.mjs')
  writeFileSync(legacyEntry, `import { bindComponentIdentity } from ${JSON.stringify(identityModule)}
import { parseManifest, projectManifest } from ${JSON.stringify(protocolsModule)}
const manifest = parseManifest(${JSON.stringify(manifestOf('verify-legacy'))}, { source: 'test:legacy-identity' })
const projection = projectManifest(manifest)
${ENTRY_SOURCE.replace('const panels =', "bindComponentIdentity(ctx, manifest, { ...projection, metadata: { ...projection.metadata, name: 'act1' } }); const panels =")}`)
  try {
    const prefs = await import('../src/tuiDisplayPrefs.js')
    const resolved = (registry: readonly string[]) =>
      prefs.resolveSidePanelIds(prefs.getSidePanelPanels(), registry)
    prefs.applySidePanelPanels('todo,component:act1:demo,jobs')
    await composition.root.loader.create({ id: 'act1', name: legacyEntry, config: { report: composition.report } })
    await composition.root.loader.await()
    check('legacy Component activated', await settled(() => reportedIds(composition.report).length > 0))
    check('registration leaves the saved encoding untouched',
      prefs.getSidePanelPanels() === 'todo,component:act1:demo,jobs')
    check('late registration resolves the saved encoding in place',
      resolved(['act1:demo']).includes('act1:demo'))
    check('a genuine act1 Component keeps its public runtime address', reportedIds(composition.report)[0] === 'act1:demo')
    prefs.applySidePanelPanels('todo,act1:demo')
    check('ambiguous old CSV cannot enable the real Component', !resolved(['act1:demo']).includes('act1:demo'))
    prefs.applySidePanelPanels('todo,component:act1:demo')
    check('explicit preference maps to unchanged runtime id', resolved(['act1:demo']).join(',') === 'todo,act1:demo')
    check('encoded preference is not a runtime address', !resolved(['act1:demo']).includes('component:act1:demo'))
    const loaded = composition.root.loader.resolve('act1') as { fiber?: { dispose?(): Promise<unknown> } } | undefined
    await loaded?.fiber?.dispose?.()
    check('unload leaves the saved encoding unclaimed but kept',
      prefs.getSidePanelPanels() === 'todo,component:act1:demo' && !resolved([]).includes('act1:demo'))
    prefs.applySidePanelPanels('todo,component:act1:demo,jobs')
    await composition.root.loader.create({ id: 'act1-reloaded', name: legacyEntry, config: { report: composition.report } })
    await composition.root.loader.await()
    check('re-registration resolves the saved encoding once',
      await settled(() => resolved(['act1:demo']).filter(id => id === 'act1:demo').length === 1))
  } finally { await composition.root.fiber.dispose() }
}

// ── armed + BARE specifier: the profile's real third-party row name ───────
// The cases above use absolute paths; a profile row names a package, so the
// package root comes from the package's own resolution. Two shapes: `main`
// only, and the plugin template's `exports: { ".": … }` that does not export
// `./package.json` (a `require.resolve('<pkg>/package.json')` throws there).
const EXPORTS_PACKAGE = '@dsh-tui-verify/exports-only'
const exportsPackageDir = join(loadRoot, 'node_modules', '@dsh-tui-verify', 'exports-only')
mkdirSync(exportsPackageDir, { recursive: true })
writeFileSync(join(exportsPackageDir, 'package.json'), JSON.stringify({
  name: EXPORTS_PACKAGE,
  version: '0.1.0',
  type: 'module',
  exports: { '.': './main.js' },
}, null, 2))
for (const [pkgDir, id] of [[barePackageDir, 'verify-bare'], [exportsPackageDir, 'verify-exports']] as const) {
  writeFileSync(join(pkgDir, 'dsh-plugin.json'), manifestOf(id))
  writeFileSync(join(pkgDir, 'main.js'), ENTRY_SOURCE)
}
for (const [name, pkgDir] of [[BARE_PACKAGE, barePackageDir], [EXPORTS_PACKAGE, exportsPackageDir]] as const) {
  let resolved = ''
  try {
    resolved = findPackageJSON(name, LOAD_BASE_URL) ?? ''
  } catch (error) {
    resolved = 'FAIL:' + (error instanceof Error ? error.message : String(error))
  }
  check(`bare specifier ${name}: the package root resolves under the load root`,
    resolved === join(pkgDir, 'package.json'), resolved)
}

for (const [name, manifestId] of [[BARE_PACKAGE, 'verify-bare'], [EXPORTS_PACKAGE, 'verify-exports']] as const) {
  const bare = await mount(true, undefined, true, LOAD_BASE_URL)
  await bare.root.loader.create({ id: name, name, config: { report: bare.report } })
  await bare.root.loader.await()
  // 固定窗:pacing 裸包名 entry 的 import+apply 落盘，无可轮询完成条件
  await sleep(600)
  const bareIds = reportedIds(bare.report)
  check(`bare specifier ${name}: the row applied and registered its panel`, bareIds.length === 1, JSON.stringify(bareIds))
  check(`bare specifier ${name}: the manifest id is found through the package-root walk`,
    bareIds.length === 1 && bareIds[0] === `${manifestId}:demo`, JSON.stringify(bareIds))
  await bare.root.fiber.dispose()
}

// Exported subcomponents must use the nearest package manifest, just like an absolute entry.
// A require-condition decoy ensures admission follows the module actually imported by the Loader.
for (const dual of [false, true]) {
  const suffix = dual ? 'dual' : 'default'
  const bareName = '@dsh-tui-verify/component-' + suffix
  const outer = join(loadRoot, 'node_modules', '@dsh-tui-verify', 'component-' + suffix)
  const inner = join(outer, 'panel')
  const decoy = join(outer, 'require-panel')
  mkdirSync(inner, { recursive: true }); mkdirSync(decoy, { recursive: true })
  writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: bareName, version: '0.1.0', type: 'module',
    exports: { './panel': dual ? { import: './panel/index.js', require: './require-panel/index.cjs' } : './panel/index.js' } }))
  writeFileSync(join(outer, 'dsh-plugin.json'), manifestOf('verify-outer-' + suffix))
  writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'verify-inner-' + suffix, type: 'module' }))
  writeFileSync(join(inner, 'dsh-plugin.json'), manifestOf('verify-inner-' + suffix))
  writeFileSync(join(inner, 'index.js'), ENTRY_SOURCE)
  writeFileSync(join(decoy, 'package.json'), JSON.stringify({ name: 'verify-require-' + suffix, type: 'commonjs' }))
  writeFileSync(join(decoy, 'dsh-plugin.json'), manifestOf('verify-require-' + suffix))
  writeFileSync(join(decoy, 'index.cjs'), 'module.exports = {}')
  const composition = await mount(true, undefined, true, LOAD_BASE_URL)
  try {
    await composition.root.loader.create({ id: 'component-' + suffix, name: bareName + '/panel', config: { report: composition.report } })
    await composition.root.loader.await()
    check('exported subcomponent ' + suffix + ': admitted before apply under its own manifest',
      await settled(() => reportedIds(composition.report).includes('verify-inner-' + suffix + ':demo')),
      JSON.stringify(reportedIds(composition.report)))
  } finally { await composition.root.fiber.dispose() }
}

for (const source of ['cli', 'environment']) {
  const option = '--conditions=' + CONDITION
  const child = spawnSync(process.execPath, [...(source === 'cli' ? [option] : []), '--import', 'tsx/esm', fileURLToPath(import.meta.url)], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DSH_TUI_ADMISSION_CONDITION_CHILD: '1',
      ...(source === 'environment' ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, option].filter(Boolean).join(' ') } : {}) },
  })
  check('custom export conditions from ' + source + ' match Loader execution', child.status === 0, child.stdout + child.stderr)
}

for (const boundary of [false, true]) {
  const suffix = boundary ? 'nested-package' : 'outer-package'
  const outer = join(loadRoot, 'node_modules', '@dsh-tui-verify', suffix)
  const entryDir = join(outer, ...(boundary ? ['panel', 'dist'] : ['dist']))
  mkdirSync(entryDir, { recursive: true })
  writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: '@dsh-tui-verify/' + suffix, type: 'module', exports: { './panel': './' + (boundary ? 'panel/' : '') + 'dist/index.js' } }))
  writeFileSync(join(outer, 'dsh-plugin.json'), manifestOf('verify-root-' + suffix))
  if (boundary) writeFileSync(join(outer, 'panel', 'package.json'), JSON.stringify({ name: 'verify-boundary', type: 'module' }))
  writeFileSync(join(entryDir, 'dsh-plugin.json'), manifestOf('verify-stray-' + suffix))
  writeFileSync(join(entryDir, 'index.js'), ENTRY_SOURCE)
  const composition = await mount(true, undefined, true, LOAD_BASE_URL)
  try {
    await composition.root.loader.create({ id: suffix, name: '@dsh-tui-verify/' + suffix + '/panel', config: { report: composition.report } })
    await composition.root.loader.await()
    const applied = await settled(() => reportedIds(composition.report).length > 0)
    const id = reportedIds(composition.report)[0] ?? ''
    check('stray manifest: ' + suffix + ' respects the nearest package boundary', applied && (boundary ? /^session:act\d+:demo$/u.test(id) : id === 'verify-root-' + suffix + ':demo'), id)
  } finally { await composition.root.fiber.dispose() }
}

// The optional Loader adapter may be absent. Execution can continue, but no
// guessed manifest may claim an identity or permissions for that activation.
const withoutResolver = await mount(true)
const savedResolver = withoutResolver.root.loader.internal
withoutResolver.root.loader.internal = undefined
try {
  const name = pathToFileURL(writePackage('verify-without-resolver')).href
  await withoutResolver.root.loader.create({ id: 'without-resolver', name, config: { report: withoutResolver.report } })
  await withoutResolver.root.loader.await()
  const applied = await settled(() => reportedIds(withoutResolver.report).length > 0)
  check('missing active resolver: execution continues without guessed component authority', applied && /^session:act\d+:demo$/u.test(reportedIds(withoutResolver.report)[0] ?? ''), JSON.stringify(reportedIds(withoutResolver.report)))
} finally {
  withoutResolver.root.loader.internal = savedResolver
  await withoutResolver.root.fiber.dispose()
}

// ── host-missing: bounded retry, then settle + loud diagnostic ────────────
// issue #183: `tuiPluginHost` never mounts; unbounded, the flush timer would re-arm for ever.
const ARM_TICKS = 4
const debugLines: string[] = []
const stderrWrite = process.stderr.write
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  debugLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  return true
}) as typeof process.stderr.write
process.env.DSH_TUI_DEBUG = '1'
try {
  const hostless = await mount(true, ARM_TICKS, false)
  await activate(hostless, 'verify-hostless')
  const refusals = (): string[] => debugLines.filter(line => line.includes('waiting') && line.includes('tuiPluginHost'))
  const deadline = Date.now() + 8000
  // 固定窗:探针 轮询诊断到达；上限由 deadline 兜住，不是断言窗口
  while (refusals().length === 0 && Date.now() < deadline) await sleep(100)
  const refusalLines = refusals()
  check('host-missing: the wait is bounded and settles with a diagnostic',
    refusalLines.length === 1, JSON.stringify(refusalLines))
  check('host-missing: the diagnostic names the missing host and the tick count',
    refusalLines.length === 1 && refusalLines[0].includes(String(ARM_TICKS)) && refusalLines[0].includes('host missing'),
    refusalLines[0] ?? '')
  // Settled: no further tick re-arms the flush timer.
  const ticksAtSettle = refusalLines.length
  const lineCountAtSettle = debugLines.length
  // 固定窗:探针 断言「已 settle 后计时器不再自续」——不变量，只能等观察窗
  await sleep(1200)
  check('host-missing: no further tick after it settled (the loop stopped)',
    refusals().length === ticksAtSettle && debugLines.length === lineCountAtSettle,
    debugLines.slice(lineCountAtSettle).join(''))
  await hostless.root.fiber.dispose()
} finally {
  delete process.env.DSH_TUI_DEBUG
  process.stderr.write = stderrWrite
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? 'verify-admission-loader ALL PASS' : `verify-admission-loader ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
