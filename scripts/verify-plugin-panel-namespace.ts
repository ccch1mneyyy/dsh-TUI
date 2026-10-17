/**
 * 面板命名空间避碰回归（PR #1474 评审 R1）：loader 条目 id 与宿主发号器的
 * `act<N>` 共用同一个字符串空间，谁都不能抢占对方的号。
 *
 * 本脚本**必须自成进程**：`act<N>` 发号器是模块级计数器，用例 A 依赖
 * 「本进程第一次发号」这个前提；verify-plugin-panels 里同形状的 panel-family
 * 用例跑在若干次发号之后，复现不出这个冲突（评审：不能只依赖已推进过的计数器）。
 *
 * A/B 两个用例都用真的 @deepseek-ai/cordis-plugin-loader 装载一个条目，条目根与
 * 它两个运行期 `ctx.plugin()` 子插件注册同一个局部 id——这正是修复前会撞出
 * DUPLICATE_CONTRIBUTION_ID 的形状：
 *  A  稳定名先占：无 manifest 的条目恰好叫 `act1`（合法 slug，也是本进程第一个
 *     号）。修复前：条目把 `act1` 当稳定前缀却不推进计数器，它第一个子插件随后
 *     也领到 `act1` → 只注册 2/3。修复后：`act1` 是发号器保留区，条目落回
 *     发号器并推进计数器 → 3/3，命名空间互不相同。
 *  A2 保留区直证（loader 条目路径）：一个叫 `act999` 的条目不许把发号器的号当
 *     自己的稳定地址。
 *  A3 Component 路径的正向对照：manifest id 必须带 `.`/`-` 分隔符（dsh-std 的
 *     `COMPONENT_ID`），所以它不可能是 `act<N>` 形状、也就没有同型碰撞；这里钉住
 *     「非保留区的 Component id 照旧生效」，并注明 pluginIdFor 的 Component 分支
 *     共用 stablePluginId 属防御性。
 *  A5 Component 来源的保留区：形状为 `act<N>` 的 manifest id 写不出来（见 A3），
 *     但经身份缝绕过准入绑进来的身份仍守同一条保留区——上游评审 R1 要的"两类
 *     来源"都能被这条与用例 A 覆盖。
 *  A4 正向对照：非保留区的 loader 条目 id 照旧生效。A3/A4 一起挡住"把稳定命名
 *     空间一律关掉"这种过度修法——只测保留区的话它是能全绿的。
 *  D  组合层（真机常态）：app-boot 用根 Include 装载整棵组合树，所以每个条目的
 *     运行时 id 是 'include:<id>'；先断言夹具的 id 真是这个形状，再断言剥掉标记
 *     后取到用户写的 id。cordis:group 的行会被摊平进同一棵树（仍是 include:<row>，
 *     照常生效）；只有嵌套 Include 子树的 'include:<a>:<b>' 剥完仍多段、落到
 *     act<N>；'include:act1' 仍守保留区；只撞前缀的直接根条目不算组合行。
 *  B  自动发号先占：裸挂载（没有 loader 条目）先领走 `act<N>`，随后一个真条目
 *     **就叫**这个名字并注册同一个局部 id。修复前：条目仍把它当稳定前缀 → 和
 *     裸挂载撞车、条目根被拒（3 个）。修复后：条目让出这个名字 → 4 个都在、
 *     命名空间互不相同。
 *  C  卸载：条目、运行期子插件与准入激活撤下后，面板与启用列表一起回收。
 *
 * Run: node --import tsx/esm scripts/verify-plugin-panel-namespace.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import './lib/fake-home.mjs' // 必须最先：A3/A4 挂 plugin-host 行，DATA_DIR 在 import 时定死

// A3/A4 走 plugin-host 的准入缝，而它的内核刷新只在 new 适配器模式下 settle
// （同 verify-plugin-messages / verify-plugin-ledger）；任何 src 导入之前设好。
process.env.DSH_TUI_ADAPTER_MODE = 'new'

const [cordis, panelsMod, storeMod, prefsMod, termTest, testUtils] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/panels.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
  import('./lib/plugin-test-utils.js'),
])
const { Context } = cordis
const { TuiPanelRuntime } = panelsMod
const { panelStore } = storeMod
const { getSidePanelPanels, parseSidePanelIds } = prefsMod
const { settled } = termTest as { settled(pred: () => boolean): Promise<boolean> }
const { mountAdmitted, mountAdmissionHost, testManifest } = testUtils as {
  mountAdmitted(
    root: InstanceType<typeof Context>,
    name: string,
    manifestSource: string,
  ): Promise<{ context: InstanceType<typeof Context>; fiber: { dispose(): unknown } }>
  mountAdmissionHost(root: InstanceType<typeof Context>, label: string): Promise<void>
  testManifest(options: { id: string }): string
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

type PanelsService = InstanceType<typeof TuiPanelRuntime>

const root = new Context()
root.logger.warn = () => undefined
root.logger.info = () => undefined
await root.plugin(TuiPanelRuntime)

const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')

/** In-memory tree: `EntryTree.write()` is a documented no-op for these. */
class MemoryLoader extends Loader { write(): void {} }

const entryDir = mkdtempSync(join(tmpdir(), 'dsh-tui-panel-namespace-'))
const loaderFiber = await root.plugin(MemoryLoader)
const loader = root.get('loader') as {
  create(options: { id: string; name: string; config?: unknown }, parent?: string): Promise<string>
  root: { create(options: { id: string; name: string }): Promise<string> }
  await(): Promise<void>
}

// 临时模块放在 tmpdir，那里解析不到包名，所以把 loader 的入口路径写成绝对 URL。
const loaderLibUrl = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/cordis-plugin-loader')).href

/** 条目根 + 两个运行期子插件注册同一个局部 id（修复前的撞车形状）。 */
function familySource(entryId: string, panelId: string): string {
  return [
    `export const name = ${JSON.stringify(entryId)}`,
    `export const inject = ['tuiPanels']`,
    `function child(label) {`,
    `  return { name: ${JSON.stringify(entryId)} + '-' + label, inject: ['tuiPanels'], apply(ctx) {`,
    `    ctx.tuiPanels.register({ apiVersion: 1, id: ${JSON.stringify(panelId)}, title: label, component: () => null })`,
    `  } }`,
    `}`,
    `export function apply(ctx) {`,
    `  ctx.tuiPanels.register({ apiVersion: 1, id: ${JSON.stringify(panelId)}, title: 'Parent', component: () => null })`,
    `  ctx.plugin(child('child-a'))`,
    `  ctx.plugin(child('child-b'))`,
    `}`,
  ].join('\n')
}

/** 只注册一个面板的条目（保留区直证用）。 */
function singleSource(entryId: string, panelId: string): string {
  return [
    `export const name = ${JSON.stringify(entryId)}`,
    `export const inject = ['tuiPanels']`,
    `export function apply(ctx) {`,
    `  ctx.tuiPanels.register({ apiVersion: 1, id: ${JSON.stringify(panelId)}, title: 'Reserved', component: () => null })`,
    `}`,
  ].join('\n')
}

/** Mount a throwaway module as a real loader entry (one file per entry id). */
async function mountEntry(entryId: string, source: string): Promise<void> {
  const modulePath = join(entryDir, entryId.replace(/[^a-z0-9_-]/giu, '_') + '.mjs')
  writeFileSync(modulePath, source)
  await loader.root.create({ id: entryId, name: pathToFileURL(modulePath).href })
  await loader.await()
}
/** 组合层形状：app-boot 用根 Include（一个 EntryTree 条目，id 为 include）装载
 * 整棵组合树，cordis-loader 的 Entry 取 id 时拼成父条目 id + ':' + options.id
 * （Entry.id getter）。真机上 bundle 与用户 patch 的每一条都这样进来，所以这是
 * loader 条目路径的常态。这里挂一个最小 EntryTree 复刻那一层，前缀由 loader 自己
 * 拼——不手写，免得测的是自己造的字符串；返回值是 loader 自己算出的运行时 id，
 * 用例先断言它确实是 include:<id>，再断言由它推出的命名空间。 */
let composedParent: Promise<string> | undefined
async function mountTreeEntry(id: string, parent?: string): Promise<string> {
  const treePath = join(entryDir, 'tree-' + id.replace(/[^a-z0-9_-]/giu, '_') + '.mjs')
  writeFileSync(treePath, [
    'import { EntryTree } from ' + JSON.stringify(loaderLibUrl),
    'export default class ComposedParent extends EntryTree { write() {} }',
  ].join('\n'))
  const created = await loader.create({ id, name: pathToFileURL(treePath).href }, parent)
  await loader.await()
  return created
}

async function ensureComposedParent(): Promise<string> {
  composedParent ??= mountTreeEntry('include')
  return composedParent
}

/** Mount a throwaway plugin module under the composed parent Include. */
async function mountComposedEntry(entryId: string, source: string, parent = 'include'): Promise<string> {
  await ensureComposedParent()
  const modulePath = join(entryDir, 'composed-' + entryId.replace(/[^a-z0-9_-]/giu, '_') + '.mjs')
  writeFileSync(modulePath, source)
  const created = await loader.create({ id: entryId, name: pathToFileURL(modulePath).href }, parent)
  await loader.await()
  return created
}

function panelsEndingWith(panelId: string): { id: string; title: string; namespace: string }[] {
  return panelStore.list()
    .filter(entry => entry.definition.id.endsWith(':' + panelId))
    .map(entry => ({
      id: entry.definition.id,
      title: entry.definition.title ?? '',
      namespace: entry.definition.id.slice(0, entry.definition.id.length - panelId.length - 1),
    }))
}

// ── A：本进程第一次发号对上一条恰好叫 act1 的合法条目 ───────────────────
// 先占的来源是稳定名字（条目 id），自动发号的来源是 act<N>：两者不能互相抢占。
await mountEntry('act1', familySource('act1', 'shared'))
await settled(() => panelsEndingWith('shared').length >= 3)
const shared = panelsEndingWith('shared')
check('entry named act1: the entry root and both runtime children all register',
  shared.length === 3, shared.map(panel => panel.id).join(','))
check('entry named act1: the three namespaces are pairwise distinct',
  new Set(shared.map(panel => panel.namespace)).size === shared.length,
  shared.map(panel => panel.namespace).join(','))

// ── A2：act<N> 形状的条目 id 不许当稳定命名空间 ──────────────────────────
await mountEntry('act999', singleSource('act999', 'kept'))
await settled(() => panelsEndingWith('kept').length >= 1)
const kept = panelsEndingWith('kept')
check('an act<N>-shaped entry id never becomes a stable namespace',
  kept.length === 1 && kept[0].namespace !== 'act999', kept.map(panel => panel.id).join(','))

// ── A3：Component 路径的正向对照（这条来源不需要避碰，见下）───────────────
// Component id 走 manifest 校验，且那里的 id 必须带 `.`/`-` 分隔符
// （`COMPONENT_ID` 在 dsh-std manifest），所以它**永远不可能是 `act<N>` 形状**：
// 拿 `id: 'act1'` 的 dsh-plugin.json 去准入会被直接拒（"manifest.id must be
// namespaced"）。pluginIdFor 的 Component 分支仍然共用 stablePluginId —— 那是
// 防御性的：万一上游放宽 id 规则，两条来源仍守同一条保留区。这里钉住的是
// 「非保留区的 Component id 照旧生效」，没有它，"把稳定命名空间一律关掉"这种
// 过度修法也能全绿。
await mountAdmissionHost(root, 'plugin panel namespace')
const admittedPlain = await mountAdmitted(root, 'panel-namespace-plain', testManifest({ id: 'dsh-tui-find' }))
const admittedPlainPanels = admittedPlain.context.get('tuiPanels') as PanelsService
admittedPlainPanels.register({ apiVersion: 1, id: 'search', title: 'Admitted', component: () => null })
await settled(() => panelsEndingWith('search').length >= 1)
const search = panelsEndingWith('search')
check('a normal Component id still names the namespace',
  search.length === 1 && search[0].namespace === 'dsh-tui-find', search.map(panel => panel.id).join(','))

// ── A5：Component 来源的保留区——只能经身份缝构造 ───────────────────────────
// 形状为 `act<N>` 的 manifest id 过不了校验（见 A3），但 bindComponentIdentity
// 自己不校验名字：绕过准入绑进来的身份仍要守同一条保留区，所以 pluginIdFor 的
// Component 分支不是死代码而是活的防御层。这里用真投影覆写 metadata.name 绑一个
// act 形状身份，再让它像用例 A 那样挂一个注册同名局部 id 的运行期子插件。
//
// 号不能写死：本用例跑在 A/B 之后，发号器已经发过号——写死 `act1` 只会得到
// 「父占 act1、子领 act<N+1>」这种根本不相撞的组合，等于什么都没测（与评审对
// panel-family 的批评同型）。所以先裸挂载一个探针读出**下一个**号，再让伪造身份
// 恰好叫这个名字：父若占住它却不推进计数器，子随后领到同一个号就会被
// DUPLICATE_CONTRIBUTION_ID 拒。
// 两个 import 先做完，探针与伪造父之间才没有 await 窗口：推导靠"探针之后第一个
// 发号者就是伪造父"，别让中间插进任何能发号的东西。
const [{ bindComponentIdentity }, { parseManifest, projectManifest }] = await Promise.all([
  import('../src/dsh-adapter/component-identity.js'),
  import('../src/adapter/standard/protocols.js'),
])
let probeDispose: (() => void) | undefined
root.inject(['tuiPanels'], ctx => {
  probeDispose = (ctx.get('tuiPanels') as PanelsService).register({
    apiVersion: 1, id: 'next', title: 'Next', component: () => null,
  })
})
await settled(() => panelsEndingWith('next').length >= 1)
const probePanel = panelsEndingWith('next')[0]
// 推导的前置条件必须自己断言：探针要是拿到稳定名（或中间混进别的发号者），
// reservedName 会指到一个无害的名字，A5 就退化成"看着在测保留区、其实撞不上"
// 的空转绿——panel-family 那个坑的同型。下面还有一条断言钉住伪造父确实落在
// 推出的号上，漂移会响而不是静默。
check('the act<N> probe took a synthetic namespace', /^act[0-9]+$/u.test(probePanel.namespace), probePanel.id)
const reservedName = 'act' + String(Number(probePanel.namespace.slice('act'.length)) + 1)
const forgedManifest = parseManifest(testManifest({ id: 'dsh-tui-find' }), { source: 'test:forged-act' })
const forgedProjection = projectManifest(forgedManifest)
const forgedChild = {
  name: 'panel-namespace-forged-child',
  inject: ['tuiPanels'],
  apply(child: InstanceType<typeof Context>) {
    (child.get('tuiPanels') as PanelsService).register({
      apiVersion: 1, id: 'forged', title: 'ForgedChild', component: () => null,
    })
  },
}
const forgedFiber = root.plugin({
  name: 'panel-namespace-forged',
  apply(candidate: InstanceType<typeof Context>) {
    bindComponentIdentity(candidate, forgedManifest, {
      ...forgedProjection,
      metadata: { ...forgedProjection.metadata, name: reservedName },
    } as never, 'forged-act')
    ;(candidate.get('tuiPanels') as PanelsService)
      .register({ apiVersion: 1, id: 'forged', title: 'ForgedParent', component: () => null })
    candidate.plugin(forgedChild as never)
  },
}) as unknown as { dispose(): unknown }
await settled(() => panelsEndingWith('forged').length >= 2)
const forged = panelsEndingWith('forged')
check('an act<N>-shaped Component id bound through the identity seam yields the reserved namespace',
  forged.length === 2 && new Set(forged.map(panel => panel.namespace)).size === 2
    && forged.every(panel => /^act[0-9]+$/u.test(panel.namespace))
    && forged.some(panel => panel.namespace === reservedName),
  forged.map(panel => panel.id).join(',') + ' reserved=' + reservedName)

// ── A4：正向对照——loader 条目路径的非保留区稳定名同样照旧生效 ─────────────
await mountEntry('panel-family', singleSource('panel-family', 'plain'))
await settled(() => panelsEndingWith('plain').length >= 1)
const plain = panelsEndingWith('plain')
check('a normal entry id still names the namespace',
  plain.length === 1 && plain[0].namespace === 'panel-family', plain.map(panel => panel.id).join(','))
// ── D：组合层（根 Include）下的条目 id 带 include: 前缀 ────────────────────
// 真机实测（harness 0.2.1-rc.2 + 主线）：bundle 入口全部由根 Include 装载，条目
// id 因此是 include:<id>；宿主自己的插件清单显示身份时也把这个前缀当组合标记
// 剥掉。所以「剥掉标记后的单段 slug」才是用户写下的、跨重启稳定的那个 id。
// 先钉住夹具的形状：loader 自己拼出的 id 必须带前缀。没有这条，将来 loader 不再
// 加前缀时 D 会从「直接根条目」那条路假绿——剥离逻辑根本没被走到。
const bundledEntryId = await mountComposedEntry('find-bundle', singleSource('find-bundle', 'bundled'))
await settled(() => panelsEndingWith('bundled').length >= 1)
const bundled = panelsEndingWith('bundled')
check('the composed fixture entry id carries the include: prefix',
  bundledEntryId === 'include:find-bundle', bundledEntryId)
check('a composed entry id names the namespace after the composition marker',
  bundled.length === 1 && bundled[0].namespace === 'find-bundle',
  bundled.map(panel => panel.id).join(','))

// D2：剥掉标记之后仍守保留区——include:act1 不许把发号器的号当稳定地址。
// 号不能写死（A5 的教训）：先用裸挂载探针确认下一个号不是 act1（否则「没占住
// act1」会因为发号器自己恰好发 act1 而假绿），再看条目让不让路。
let d2ProbeDispose: (() => void) | undefined
root.inject(['tuiPanels'], ctx => {
  d2ProbeDispose = (ctx.get('tuiPanels') as PanelsService).register({
    apiVersion: 1, id: 'd2-probe', title: 'D2Probe', component: () => null,
  })
})
await settled(() => panelsEndingWith('d2-probe').length >= 1)
const d2Probe = panelsEndingWith('d2-probe')[0]
check('the D2 probe shows the fallback is past act1 (so the check below is meaningful)',
  /^act[0-9]+$/u.test(d2Probe.namespace) && d2Probe.namespace !== 'act1', d2Probe.id)
await mountComposedEntry('act1', singleSource('act1', 'composed-reserved'))
await settled(() => panelsEndingWith('composed-reserved').length >= 1)
const composedReserved = panelsEndingWith('composed-reserved')
check('the reserved act<N> region still holds after the composition marker',
  composedReserved.length === 1 && /^act[0-9]+$/u.test(composedReserved[0].namespace)
    && composedReserved[0].namespace !== 'act1',
  composedReserved.map(panel => panel.id).join(','))

// D3：嵌套 Include（子树）的路径剥一层后仍是多段 → 不认，落回发号器。这条挡住
// 「取最后一段」那种过度修法：两棵子树里的同名行会在那个方案里撞同一个命名空间。
// （cordis:group 不是这种形状：Group 把子条目摊平进所在树，运行时 id 仍是
// include:<row>，见 D4。）
await mountTreeEntry('nested-include', 'include')
const deepEntryId = await mountComposedEntry('deep', singleSource('deep', 'deep-plain'), 'include:nested-include')
await settled(() => panelsEndingWith('deep-plain').length >= 1)
const deep = panelsEndingWith('deep-plain')
check('the nested fixture entry id is a subtree path',
  deepEntryId === 'include:nested-include:deep', deepEntryId)
check('a nested Include path is not a stable namespace',
  deep.length === 1 && /^act[0-9]+$/u.test(deep[0].namespace),
  deep.map(panel => panel.id).join(','))

// D4：cordis:group 的行会被摊平进同一棵 Include 树（Group 把子条目放进
// ctx.fiber.entry.parent.tree），运行时 id 仍是 include:<row>——所以组里的行照常
// 生效，命名空间就是它自己写的 id。这条钉住「被接受」的真实语义，免得文档和后续
// 维护者把它误当成 D3 那种多段路径。
const groupUrl = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/cordis-plugin-group')).href
await loader.create({ id: 'grouped', name: groupUrl, config: [] }, 'include')
await loader.await()
const groupChildId = await mountComposedEntry('grouped-kid', singleSource('grouped-kid', 'grouped-plain'), 'include:grouped')
await settled(() => panelsEndingWith('grouped-plain').length >= 1)
const grouped = panelsEndingWith('grouped-plain')
check('a group child keeps the flat include:<row> id',
  groupChildId === 'include:grouped-kid', groupChildId)
check('a group row names the namespace with its own id',
  grouped.length === 1 && grouped[0].namespace === 'grouped-kid',
  grouped.map(panel => panel.id).join(','))

// D5：只撞前缀、不是组合行的直接根条目（loader 允许 id 带冒号）不许被剥成别人的
// 命名空间——组合标记必须连带「这一行自己的 id」一起对上。
await mountEntry('include:not-composed', singleSource('include:not-composed', 'not-composed-plain'))
await settled(() => panelsEndingWith('not-composed-plain').length >= 1)
const notComposed = panelsEndingWith('not-composed-plain')
check('a root entry whose id merely starts with include: is not a composed row',
  notComposed.length === 1 && /^act[0-9]+$/u.test(notComposed[0].namespace),
  notComposed.map(panel => panel.id).join(','))

// ── B：自动发号先占，条目名就是发号器已经发出去的那个号 ──────────────────
let bareDispose: (() => void) | undefined
root.inject(['tuiPanels'], ctx => {
  bareDispose = (ctx.get('tuiPanels') as PanelsService).register({
    apiVersion: 1, id: 'rival', title: 'Bare', component: () => null,
  })
})
await settled(() => panelsEndingWith('rival').length >= 1)
const bare = panelsEndingWith('rival')[0]
check('bare mount takes a synthetic act<N> namespace',
  bare !== undefined && /^act[0-9]+$/u.test(bare.namespace), bare?.id ?? '')
await mountEntry(bare.namespace, familySource(bare.namespace, 'rival'))
await settled(() => panelsEndingWith('rival').length >= 4)
const rival = panelsEndingWith('rival')
check('a loader entry named after the taken synthetic namespace does not preempt it',
  rival.length === 4, rival.map(panel => panel.id).join(','))
check('that entry keeps its own panel instead of being rejected as a duplicate',
  rival.some(panel => panel.title === 'Parent'), rival.map(panel => panel.id + '/' + panel.title).join(','))
check('the four namespaces are pairwise distinct',
  new Set(rival.map(panel => panel.namespace)).size === rival.length,
  rival.map(panel => panel.namespace).join(','))

// ── C：撤下 loader、裸挂载与准入激活 → 面板与启用列表一起回收 ────────────
const localIds = ['shared', 'kept', 'next', 'forged', 'plain', 'search', 'rival', 'bundled', 'd2-probe', 'composed-reserved', 'deep-plain', 'grouped-plain', 'not-composed-plain']
const trackedPanels = (): { id: string; title: string; namespace: string }[] =>
  localIds.flatMap(localId => panelsEndingWith(localId))
const claimedIds = trackedPanels().map(panel => panel.id)
await loaderFiber.dispose()
bareDispose?.()
d2ProbeDispose?.()
await Promise.resolve(admittedPlain.fiber.dispose())
await Promise.resolve(forgedFiber.dispose())
probeDispose?.()
await settled(() => trackedPanels().length === 0)
check('dispose reclaims every panel of every case',
  trackedPanels().length === 0, trackedPanels().map(panel => panel.id).join(','))
const enabled = parseSidePanelIds(getSidePanelPanels())
check('dispose cleans the enabled-panel list',
  claimedIds.every(id => !enabled.includes(id)), enabled.join(','))

rmSync(entryDir, { recursive: true, force: true })
if (failed > 0) {
  console.error('verify-plugin-panel-namespace FAILED: ' + failed)
  process.exit(1)
}
console.log('verify-plugin-panel-namespace ALL PASS')
