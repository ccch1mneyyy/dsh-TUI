/**
 * 批 P2–P4：`/plugin` 授权生命周期（install / enable / disable / remove）。
 *
 * 这里驱动的是**真流程**（`createPluginInstallFlow` / `createPluginManageFlow`），
 * 只有 profile 插件服务、first-party feed 与包内声明是夹具；授权文件落在临时目录
 * 里，由 `readGrantStore` 这个生产读路径实时读回。断言的是顺序与后果，不是实现：
 *
 *   A. 装：确认页的 `GrantPlan`（id 是声明 id，不是包名）、Enter 先写授权再
 *      `installBundle`（fake 服务在写入那一刻同步快照文件）、安装失败回滚、
 *      已有文件逐字节还原、每条声明都显式写规则（含 default-allow）；
 *   B. registry 装后 `grant` 步骤：声明装上后才可读；`{kind:'grant'}` 返回时
 *      文件仍未写；`grant()` 写入并收尾；first-party registry spec 装前仍是
 *      确认路径（声明 unjudged），silent 直通分支当前不可达、测试不覆盖；
 *   C. 启停：enable 在 `setBundleEnabled` 之前写入（fake 服务快照证明），失败
 *      回滚；disable 在 `setBundleEnabled` 之后撤销，`denies` 原样保留；
 *   D. 卸载：声明在写前读取、`forget` 在 `removeBundle` 之后、失败时醒目报告
 *      id 与路径、残留按来源逐项点名且不再出现授权条目；
 *   E. **同 id 继承回归**：装 A（id 相同、包名不同）→ 卸 A（授权键消失）→
 *      装 B（同 id、不同包名）→ 确认页全部 `·未授权`，不按键就不写文件。
 *   F. 真面板：`PluginInstallPane` / `PluginManagePane` 渲染清单与按键提示。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-grant-lifecycle.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { PluginInstallFlow } from '../src/dsh-adapter/plugin-install.js'
import type { PluginManageFlow, PluginBundleDeclaration } from '../src/dsh-adapter/plugin-manage.js'
import type { ChangeResult, BundleInfo, PluginInfo, PluginSpecInspection } from '@deepseek-ai/dsh-plugin-manager/types'
import type { DeclaredGrants } from '../src/dsh-adapter/plugin-declaration.js'
import type { GrantPlan } from '../src/dsh-adapter/grant-file.js'

const [
  { EXTENSION_GRANTS_FILE, readGrantStore },
  { createPluginInstallFlow },
  { createPluginManageFlow },
  { declaredGrantsIn },
  { testManifest },
  { t },
] = await Promise.all([
  import('../src/adapter/standard/grants.js'),
  import('../src/dsh-adapter/plugin-install.js'),
  import('../src/dsh-adapter/plugin-manage.js'),
  import('../src/dsh-adapter/plugin-declaration.js'),
  import('./lib/plugin-test-utils.js'),
  import('../src/i18n.js'),
])

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** A fresh data directory plus the grants file path inside it. */
function sandbox(): { readonly dir: string; readonly file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grant-lifecycle-'))
  return { dir, file: join(dir, EXTENSION_GRANTS_FILE) }
}
function seed(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
function read(file: string): string {
  return readFileSync(file, 'utf8')
}

// ── Shared fixtures ─────────────────────────────────────────────────────────
const PACKAGE_A = 'probe-package-a'
const PACKAGE_B = 'probe-package-b'
const SHARED_ID = 'com.example.shared'
const A_MANIFEST = testManifest({
  id: SHARED_ID,
  permissions: [
    { name: 'storage.local.read', scope: SHARED_ID },
    { name: 'session.input.intercept', scope: 'tui/input' },
    // default allow: the registry already grants it; the plan marks it granted,
    // and ensure still records the declared rule explicitly (no rule is assumed).
    { name: 'commands.invoke', scope: 'com.example.status' },
  ],
})
const A_GRANTS = declaredGrantsIn(A_MANIFEST) as DeclaredGrants
check('the fixture declaration reads back with its component id (not the package name)',
  A_GRANTS !== undefined && A_GRANTS.id === SHARED_ID && A_GRANTS.permissions.length === 3)

const NO_FEED = { kind: 'unavailable', reason: 'probe feed' } as const
const CHANGE = { changed: true, application: 'applied', stage: 'install', target: PACKAGE_A } as const

/** A service that records what it saw, in the order the flow saw it. */
function installService(options: {
  readonly file: string
  readonly inspection?: PluginSpecInspection
  readonly change?: () => Promise<ChangeResult>
}): { readonly service: PluginManagerView; readonly order: string[]; readonly grantsAtInstall: string[] } {
  const order: string[] = []
  const grantsAtInstall: string[] = []
  const inspection: PluginSpecInspection = options.inspection ?? {
    status: 'accepted', kind: 'path', name: PACKAGE_A, version: '1.0.0', bundle: true, registry: null,
  }
  const service: PluginManagerView = {
    inspect: () => Promise.resolve(inspection),
    installBundle: spec => {
      order.push(`install:${spec}`)
      // The production window this battery exists for: what the file held at
      // the instant the plugin was about to load.
      grantsAtInstall.push(existsSync(options.file) ? read(options.file) : '')
      return options.change?.() ?? Promise.resolve(CHANGE)
    },
    listBundles: () => Promise.resolve([]),
    listPlugins: () => Promise.resolve([]),
    listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
  } as unknown as PluginManagerView
  return { service, order, grantsAtInstall }
}

function installFlow(options: {
  readonly dir: string
  readonly file: string
  readonly service: PluginManagerView
  readonly spec: string
  readonly feed?: unknown
  readonly notice: 'declared' | 'unjudged'
  readonly directory?: string
  readonly grantsOf?: DeclaredGrants
  readonly installedGrantsOf?: (name: string) => DeclaredGrants | undefined
  readonly lines?: string[]
  /** Whether a turn is running; the fixture answers "idle" unless a case says so. */
  readonly busy?: () => boolean
}): PluginInstallFlow {
  return createPluginInstallFlow({
    manager: options.service,
    spec: options.spec,
    feed: (options.feed ?? NO_FEED) as never,
    noticeOf: () => ({ kind: options.notice }) as never,
    specDirectory: () => options.directory,
    binding: () => 0,
    busy: options.busy ?? (() => false),
    onLines: batch => { options.lines?.push(...batch) },
    grants: readGrantStore(options.dir),
    grantsDataDir: options.dir,
    declaredGrantsOf: () => options.grantsOf,
    installedGrantsOf: options.installedGrantsOf,
  })
}

// ── A. install: confirm lists, grants before installing, rollback on failure ─
{
  const { dir, file } = sandbox()
  const lines: string[] = []
  const rig = installService({ file })
  const flow = installFlow({
    dir, file, service: rig.service, spec: '/probe/package-a', notice: 'declared',
    directory: '/probe/package-a', grantsOf: A_GRANTS, lines,
  })
  const asked = await flow.begin()
  check('install: a readable path declaration lands on a confirm step with a grant plan',
    asked.kind === 'confirm' && asked.grants !== undefined && asked.grants.id === SHARED_ID,
    JSON.stringify(asked))
  if (asked.kind !== 'confirm' || asked.grants === undefined) throw new Error('no confirm step')
  const plan: GrantPlan = asked.grants
  check('install: the plan lists all three permissions and marks the default-allow one granted',
    plan.entries.length === 3
    && plan.entries.find(entry => entry.name === 'commands.invoke')?.granted === true
    && plan.entries.filter(entry => entry.name !== 'commands.invoke').every(entry => entry.granted === false),
    JSON.stringify(plan.entries))
  check('install: the confirmation itself writes nothing', !existsSync(file))
  const done = await flow.confirm()
  check('install: confirm finishes the install', done.kind === 'done', JSON.stringify(done))
  const doc = JSON.parse(read(file)) as { grants: Record<string, unknown[]> }
  check('install: the rules are keyed by the declaration id, never the package name',
    Object.keys(doc.grants).join(',') === SHARED_ID, JSON.stringify(Object.keys(doc.grants)))
  check('install: every declared permission becomes a rule, verbatim',
    JSON.stringify(doc.grants[SHARED_ID]) === JSON.stringify([
      { name: 'storage.local.read', scope: SHARED_ID },
      { name: 'session.input.intercept', scope: 'tui/input' },
      { name: 'commands.invoke', scope: 'com.example.status' },
    ]), JSON.stringify(doc.grants[SHARED_ID]))
  check('install: the file already held the rules when installBundle ran',
    rig.grantsAtInstall.length === 1 && rig.grantsAtInstall[0].includes('session.input.intercept')
    && rig.grantsAtInstall[0].includes('storage.local.read'),
    rig.grantsAtInstall.join(' | '))
  check('install: the transcript says what was granted',
    lines.some(line => line === t('plugins-install-granted', { count: '3', id: SHARED_ID })), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

{
  const { dir, file } = sandbox()
  const before = JSON.stringify({ grants: { 'com.example.other': [{ name: 'commands.invoke', scope: 'com.example.status' }] } })
  seed(file, before)
  const lines: string[] = []
  const rig = installService({
    file,
    change: () => Promise.resolve({ changed: true, application: 'failed', error: { code: 'probe-failure' } }),
  })
  const flow = installFlow({
    dir, file, service: rig.service, spec: '/probe/package-a', notice: 'declared',
    directory: '/probe/package-a', grantsOf: A_GRANTS, lines,
  })
  await flow.begin()
  await flow.confirm()
  check('install: a failed install restores the previous grants bytes exactly', read(file) === before, read(file))
  check('install: …and says the grant was rolled back', lines.some(line => line.includes('rolled back')), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

// ── B. registry spec: the grant step arrives after the install ───────────────
{
  const { dir, file } = sandbox()
  const lines: string[] = []
  const declaration: DeclaredGrants = {
    id: SHARED_ID,
    permissions: [
      { name: 'storage.local.read', scope: SHARED_ID },
      // A name this host's registry does not know: skipped, never written, and
      // named once in the transcript even though the flow reports it twice
      // internally (before the step, then again when the answer is written).
      { name: 'probe.unknown.permission', scope: SHARED_ID },
    ],
  }
  let reads = 0
  const rig = installService({ file })
  const flow = installFlow({
    dir, file, service: rig.service, spec: `${PACKAGE_A}@1.0.0`, notice: 'unjudged', lines,
    installedGrantsOf: () => { reads += 1; return declaration },
  })
  const asked = await flow.begin()
  check('registry install: an unjudged registry spec has no pre-install grant list',
    asked.kind === 'confirm' && asked.grants === undefined, JSON.stringify(asked))
  const step = await flow.confirm()
  check('registry install: the install completes before the declaration is read',
    reads === 1 && rig.order.length === 1, `${reads}/${rig.order.join(',')}`)
  check('registry install: a readable declaration with an ungranted permission asks to grant',
    step.kind === 'grant' && step.plan.id === SHARED_ID && step.plan.entries.length === 1, JSON.stringify(step))
  check('registry install: reaching the grant step writes nothing yet', !existsSync(file))
  const done = await flow.grant()
  check('registry install: granting finishes the flow and writes the rule',
    done.kind === 'done' && existsSync(file)
    && JSON.stringify((JSON.parse(read(file)) as { grants: Record<string, unknown> }).grants[SHARED_ID])
      === `[{"name":"storage.local.read","scope":"${SHARED_ID}"}]`, read(file))
  check('registry install: the transcript confirms the grant',
    lines.some(line => line === t('plugins-install-granted', { count: '1', id: SHARED_ID })), lines.join(' | '))
  const skipped = lines.filter(line => line.includes('Skipped permissions this host does not know'))
  check('registry install: an unknown permission is named once, not again when the grant is written',
    skipped.length === 1 && skipped[0].includes('probe.unknown.permission'), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

// The post-install step waits for an idle turn like every other write: the
// grant is read per decision, so writing it under a running turn would change
// what that turn may do. The refusal must not consume the step.
{
  const { dir, file } = sandbox()
  const lines: string[] = []
  let busy = false
  const rig = installService({ file })
  const flow = installFlow({
    dir, file, service: rig.service, spec: `${PACKAGE_A}@1.0.0`, notice: 'unjudged', lines,
    busy: () => busy,
    installedGrantsOf: () => ({ id: SHARED_ID, permissions: [{ name: 'storage.local.read', scope: SHARED_ID }] }),
  })
  await flow.begin()
  const step = await flow.confirm()
  check('grant step: the install finishes and asks to grant', step.kind === 'grant', JSON.stringify(step))
  busy = true
  const refused = await flow.grant()
  check('grant step: a turn that started while the pane waited refuses the write, keeping the step',
    refused.kind === 'grant' && refused.plan.id === SHARED_ID && !existsSync(file), JSON.stringify(refused))
  check('grant step: the refusal is reported with the grant wording',
    lines.some(line => line.includes('before granting')), lines.join(' | '))
  busy = false
  const done = await flow.grant()
  check('grant step: the same step still grants once the turn is over',
    done.kind === 'done' && existsSync(file)
    && JSON.stringify((JSON.parse(read(file)) as { grants: Record<string, unknown> }).grants[SHARED_ID])
      === `[{"name":"storage.local.read","scope":"${SHARED_ID}"}]`, read(file))
  rmSync(dir, { recursive: true, force: true })
}

// A first-party registry artifact: the feed vouches for it, but its declaration
// is unjudged before it lands, so the flow still asks and the post-install grant
// step carries the list. The ask was answered, so the confirmed wording is what
// gets reported; the silent direct-route branch is not reached from here.
{
  const { dir, file } = sandbox()
  const lines: string[] = []
  const rig = installService({
    file,
    inspection: { status: 'accepted', kind: 'registry', name: PACKAGE_A, version: '1.0.0', bundle: true, registry: null },
  })
  const flow = installFlow({
    dir, file, service: rig.service, spec: `${PACKAGE_A}@1.0.0`, notice: 'unjudged', lines,
    feed: { kind: 'ok', path: '/probe/feed.json', feed: { feedVersion: 1, entries: [{ name: PACKAGE_A, scope: '@probe', version: '1.0.0' }] } },
    installedGrantsOf: () => ({ id: SHARED_ID, permissions: [{ name: 'storage.local.read', scope: SHARED_ID }] }),
  })
  // A registry artifact can be vouched for by the feed, but its declaration is
  // still not readable before it lands (there is no directory to read), so the
  // flow asks: trust is not a confirmation, and the notice is `unjudged`.
  const asked = await flow.begin()
  check('first-party install: with no pre-install declaration the flow still asks, and the install has not run',
    asked.kind === 'confirm' && asked.trust.kind === 'first-party' && asked.grants === undefined
    && rig.order.length === 0, JSON.stringify(asked))
  const step = await flow.confirm()
  check('first-party install: the install runs, then the declared list arrives as the grant step',
    rig.order.length === 1 && step.kind === 'grant' && step.plan.entries.length === 1,
    `${rig.order.join(',')} · ${JSON.stringify(step)}`)
  await flow.grant()
  check('first-party install: granting finishes and is reported',
    lines.some(line => line === t('plugins-install-granted', { count: '1', id: SHARED_ID })), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

// ── C. lifecycle: enable grants before the write, disable revokes after ─────
const MANAGE_BUNDLES: BundleInfo[] = [{
  name: PACKAGE_A, version: '1.0.0', enabled: false, installed: false, optional: false, removable: true,
  rows: [{ rowId: 'a-row', moduleName: PACKAGE_A }], overrides: [],
}]
const MANAGE_PLUGINS: PluginInfo[] = []

function manageService(options: {
  readonly file: string
  readonly order: string[]
  readonly change?: () => Promise<ChangeResult>
  /** Snapshot of the grants file taken inside removeBundle, the instant the write runs. */
  readonly snapshot?: string[]
}): PluginManagerView {
  return {
    listBundles: () => Promise.resolve(MANAGE_BUNDLES),
    listPlugins: () => Promise.resolve(MANAGE_PLUGINS),
    removeBundle: name => {
      options.order.push(`removeBundle:${name}`)
      // Snapshot the file at the instant the profile write runs: the grant must
      // still be there now, and gone only after this call returns.
      options.snapshot?.push(existsSync(options.file) ? read(options.file) : '')
      return options.change?.() ?? Promise.resolve({ ...CHANGE, stage: 'remove', target: name })
    },
    setBundleEnabled: (name, enabled) => {
      // Snapshot the file at the instant the profile write runs.
      options.order.push(`setBundleEnabled:${name}:${String(enabled)}@${existsSync(options.file) ? read(options.file) : ''}`)
      return options.change?.() ?? Promise.resolve({ ...CHANGE, stage: enabled ? 'enable' : 'disable', target: name })
    },
  } as unknown as PluginManagerView
}

function manageFlow(options: {
  readonly action: 'remove' | 'enable' | 'disable'
  readonly dir: string
  readonly file: string
  readonly service: PluginManagerView
  readonly lines: string[]
  readonly declaration?: PluginBundleDeclaration
}): PluginManageFlow {
  return createPluginManageFlow({
    manager: options.service,
    action: options.action,
    target: PACKAGE_A,
    binding: () => 0,
    busy: () => false,
    onLines: batch => { options.lines.push(...batch) },
    profileName: 'probe-profile',
    grants: readGrantStore(options.dir),
    grantsDataDir: options.dir,
    declarationOf: () => options.declaration ?? { kind: 'declared', grants: A_GRANTS, residue: () => [] },
  })
}

{
  const { dir, file } = sandbox()
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order })
  const flow = manageFlow({ action: 'enable', dir, file, service, lines })
  const asked = await flow.begin()
  check('enable: a readable declaration asks with the grant list attached',
    asked.kind === 'confirm' && asked.question.kind === 'trust' && asked.grants?.id === SHARED_ID,
    JSON.stringify(asked))
  check('enable: asking writes nothing yet', !existsSync(file) && order.length === 0, order.join(','))
  await flow.confirm()
  check('enable: the grant is on disk when setBundleEnabled runs',
    order.length === 1 && order[0].includes('storage.local.read'), order.join(','))
  const doc = JSON.parse(read(file)) as { grants: Record<string, unknown[]> }
  check('enable: the rules use the declaration id',
    Object.keys(doc.grants).join(',') === SHARED_ID, read(file))
  rmSync(dir, { recursive: true, force: true })
}

{
  const { dir, file } = sandbox()
  const before = JSON.stringify({ grants: { 'com.example.other': [{ name: 'commands.invoke', scope: 'com.example.status' }] } })
  seed(file, before)
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order, change: () => Promise.resolve({ changed: false, application: 'failed', error: { code: 'probe' } }) })
  const flow = manageFlow({ action: 'enable', dir, file, service, lines })
  await flow.begin()
  await flow.confirm()
  check('enable: a failed save puts the grant back exactly', read(file) === before, read(file))
  check('enable: …and says both halves', lines.some(line => line.includes('rolled back')), lines.join(' | '))
  check('enable: a failed save is not reported as recorded',
    !lines.some(line => line === t('plugins-manage-enable-persisted')), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

{
  const { dir, file } = sandbox()
  const before = JSON.stringify({ grants: { 'com.example.other': [{ name: 'commands.invoke', scope: 'com.example.status' }] } })
  seed(file, before)
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order, change: () => Promise.resolve({ changed: true, application: 'failed', error: { code: 'probe' } }) })
  const flow = manageFlow({ action: 'enable', dir, file, service, lines })
  await flow.begin()
  await flow.confirm()
  const doc = JSON.parse(read(file)) as { grants: Record<string, unknown[]> }
  check('enable: a reload failure after the profile saved keeps the grant',
    doc.grants[SHARED_ID] !== undefined && read(file) !== before, read(file))
  check('enable: …and says the enable is recorded for the next start',
    lines.some(line => line === t('plugins-manage-enable-persisted')), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

{
  const { dir, file } = sandbox()
  seed(file, JSON.stringify({
    grants: { [SHARED_ID]: [
      { name: 'storage.local.read', scope: SHARED_ID },
      { name: 'session.input.intercept', scope: 'tui/input' },
      { name: 'messages.observe.read', scope: 'session:*' },
    ] },
    denies: { [SHARED_ID]: [{ name: 'session.rewind.intercept', scope: 'session:*' }] },
  }, null, 2))
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order })
  const flow = manageFlow({ action: 'disable', dir, file, service, lines })
  // A bundle disable needs no confirmation: begin() is the whole action.
  const done = await flow.begin()
  check('disable: the write happens before the revoke (the snapshot still has the rules)',
    done.kind === 'done' && order.length === 1
    && order[0].includes('storage.local.read') && order[0].includes('session.input.intercept'),
    order.join(','))
  const doc = JSON.parse(read(file)) as { grants: Record<string, unknown[]>; denies: Record<string, unknown> }
  check('disable: the declared names are revoked, a hand-written deny is kept',
    JSON.stringify(doc.grants[SHARED_ID]) === '[{"name":"messages.observe.read","scope":"session:*"}]'
    && JSON.stringify(doc.denies[SHARED_ID]) === '[{"name":"session.rewind.intercept","scope":"session:*"}]',
    read(file))
  check('disable: the transcript reports the revocation',
    lines.some(line => line.includes('Revoked 3 permission grant(s)')), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

// ── C2. failure paths the docs promise: the action still runs, the report says why ─
{
  // install: a corrupt grants file is an enhancement failure, not a veto.
  const { dir, file } = sandbox()
  seed(file, '{broken')
  const lines: string[] = []
  const rig = installService({ file })
  const flow = installFlow({
    dir, file, service: rig.service, spec: '/probe/package-a', notice: 'declared',
    directory: '/probe/package-a', grantsOf: A_GRANTS, lines,
  })
  await flow.begin()
  const done = await flow.confirm()
  check('install failure path: a corrupt grants file does not stop the install',
    done.kind === 'done' && rig.order.length === 1, JSON.stringify(done))
  check('install failure path: the refused write names the reason and the file',
    lines.some(line => line.includes('cannot be parsed') && line.includes(EXTENSION_GRANTS_FILE)), lines.join(' | '))
  check('install failure path: the corrupt file is left exactly as it was', read(file) === '{broken', read(file))
  rmSync(dir, { recursive: true, force: true })
}
{
  // enable: the same guarantee, on the other lifecycle action.
  const { dir, file } = sandbox()
  seed(file, '{broken')
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order })
  const flow = manageFlow({ action: 'enable', dir, file, service, lines })
  await flow.begin()
  await flow.confirm()
  check('enable failure path: a corrupt grants file does not stop the enable',
    order.length === 1 && order[0].includes('setBundleEnabled'), order.join(','))
  check('enable failure path: the refused write is reported',
    lines.some(line => line.includes('cannot be parsed')), lines.join(' | '))
  check('enable failure path: the corrupt file is left exactly as it was', read(file) === '{broken', read(file))
  rmSync(dir, { recursive: true, force: true })
}
{
  // install: a deny outranks the rule just written; say so instead of claiming it.
  const { dir, file } = sandbox()
  seed(file, JSON.stringify({ denies: { [SHARED_ID]: [{ name: 'storage.local.read', scope: SHARED_ID }] } }, null, 2))
  const lines: string[] = []
  const rig = installService({ file })
  const flow = installFlow({
    dir, file, service: rig.service, spec: '/probe/package-a', notice: 'declared',
    directory: '/probe/package-a', grantsOf: A_GRANTS, lines,
  })
  await flow.begin()
  await flow.confirm()
  check('unapplied: a rule outranked by a deny is reported, not counted as effective',
    lines.some(line => line.includes('do not take effect') && line.includes('storage.local.read@')), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}
{
  // install: a hand edit between the grant write and the rollback survives.
  const { dir, file } = sandbox()
  const lines: string[] = []
  const rig = installService({
    file,
    change: () => {
      writeFileSync(file, JSON.stringify({
        grants: { [SHARED_ID]: [{ name: 'storage.local.read', scope: SHARED_ID }] },
        editedBy: 'person',
      }))
      return Promise.resolve({ changed: true, application: 'failed', error: { code: 'probe' } })
    },
  })
  const flow = installFlow({
    dir, file, service: rig.service, spec: '/probe/package-a', notice: 'declared',
    directory: '/probe/package-a', grantsOf: A_GRANTS, lines,
  })
  await flow.begin()
  await flow.confirm()
  check('rollback failure: the hand edit between write and rollback is kept',
    (JSON.parse(read(file)) as { editedBy?: string }).editedBy === 'person', read(file))
  check('rollback failure: the transcript says the rollback failed',
    lines.some(line => line.includes('could not be rolled back')), lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}
{
  // disable: a corrupt grants file stops the revoke, not the disable.
  const { dir, file } = sandbox()
  seed(file, '{broken')
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order })
  const flow = manageFlow({ action: 'disable', dir, file, service, lines })
  const done = await flow.begin()
  check('disable failure path: a corrupt grants file does not stop the disable',
    done.kind === 'done' && order.length === 1, order.join(','))
  check('disable failure path: the failed revoke names the id, the file and the matrix',
    lines.some(line => line.includes(SHARED_ID) && line.includes(EXTENSION_GRANTS_FILE)
      && line.includes('could not be revoked')), lines.join(' | '))
  check('disable failure path: the corrupt file is left exactly as it was', read(file) === '{broken', read(file))
  rmSync(dir, { recursive: true, force: true })
}
{
  // enable: an unreadable declaration is named, never guessed into a grant.
  const { dir, file } = sandbox()
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order })
  const flow = manageFlow({
    action: 'enable', dir, file, service, lines,
    declaration: { kind: 'unreadable' },
  })
  await flow.begin()
  await flow.confirm()
  check('unhandled: an unreadable declaration is reported for the target',
    lines.some(line => line.includes('could not be read') && line.includes(PACKAGE_A)), lines.join(' | '))
  check('unhandled: the enable still runs without a grant', order.length === 1 && !existsSync(file), order.join(','))
  rmSync(dir, { recursive: true, force: true })
}
{
  // remove: a failed profile write must not forget the component's rules.
  const { dir, file } = sandbox()
  seed(file, JSON.stringify({ grants: { [SHARED_ID]: [{ name: 'storage.local.read', scope: SHARED_ID }] } }, null, 2))
  const before = read(file)
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order, change: () => Promise.resolve({ changed: false, application: 'failed', error: { code: 'probe' } }) })
  const flow = manageFlow({ action: 'remove', dir, file, service, lines })
  await flow.begin()
  await flow.confirm()
  check('remove failure path: a failed removal keeps the grant entries untouched', read(file) === before, read(file))
  rmSync(dir, { recursive: true, force: true })
}
{
  // disable: the same, before the revoke.
  const { dir, file } = sandbox()
  seed(file, JSON.stringify({ grants: { [SHARED_ID]: [{ name: 'storage.local.read', scope: SHARED_ID }] } }, null, 2))
  const before = read(file)
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order, change: () => Promise.resolve({ changed: false, application: 'failed', error: { code: 'probe' } }) })
  const flow = manageFlow({ action: 'disable', dir, file, service, lines })
  await flow.begin()
  check('disable failure path: a failed write keeps the grant entries untouched', read(file) === before, read(file))
  rmSync(dir, { recursive: true, force: true })
}

// ── D. removal: capture before, forget after, report by source ──────────────
{
  const { dir, file } = sandbox()
  seed(file, JSON.stringify({
    grants: {
      [SHARED_ID]: [{ name: 'storage.local.read', scope: SHARED_ID }],
      'com.example.other': [{ name: 'commands.invoke', scope: 'com.example.status' }],
    },
    denies: {
      [SHARED_ID]: ['messages.observe.read'],
      'com.example.other': ['storage.local.read'],
    },
  }, null, 2))
  // The ledger and a storage namespace survive the removal; the package's
  // backend directory is a third source, reported by path.
  writeFileSync(join(dir, 'effect-ledger.jsonl'), `${JSON.stringify({ sequence: 1, operation: 'storage.write', pluginId: SHARED_ID, result: 'applied' })}\n`)
  mkdirSync(join(dir, 'plugin-storage'), { recursive: true })
  writeFileSync(join(dir, 'plugin-storage', `${encodeURIComponent(SHARED_ID)}.json`), '{}')
  const lines: string[] = []
  const order: string[] = []
  const snapshot: string[] = []
  const service = manageService({ file, order, snapshot })
  const flow = manageFlow({
    action: 'remove',
    dir,
    file,
    service,
    lines,
    declaration: {
      kind: 'declared',
      grants: A_GRANTS,
      residue: () => [
        t('plugins-manage-residue-ledger', { id: SHARED_ID, file: join(dir, 'effect-ledger.jsonl') }),
        t('plugins-manage-residue-storage', { id: SHARED_ID, file: join(dir, 'plugin-storage', `${encodeURIComponent(SHARED_ID)}.json`) }),
      ],
    },
  })
  const asked = await flow.begin()
  check('remove: the removal asks first, with the grant deletion named',
    asked.kind === 'confirm' && asked.grants?.id === SHARED_ID, JSON.stringify(asked))
  check('remove: asking writes nothing', order.length === 0 && existsSync(file))
  await flow.confirm()
  check('remove: the bundle write happens first, then the grant entries go',
    order.length === 1 && order[0] === `removeBundle:${PACKAGE_A}`
    && snapshot.length === 1 && snapshot[0] !== ''
    && (JSON.parse(snapshot[0]) as { grants?: Record<string, unknown> }).grants?.[SHARED_ID] !== undefined,
    `${order.join(',')} · ${snapshot.join(' | ')}`)
  const doc = JSON.parse(read(file)) as { grants?: Record<string, unknown>; denies?: Record<string, unknown> }
  check('remove: only the component\'s grant sections lose their entries',
    doc.grants?.[SHARED_ID] === undefined && doc.denies?.[SHARED_ID] === undefined
    && doc.grants?.['com.example.other'] !== undefined
    && doc.denies?.['com.example.other'] !== undefined, read(file))
  check('remove: the transcript says the grant was forgotten',
    lines.some(line => line === t('plugins-manage-grant-forgotten', { id: SHARED_ID })), lines.join(' | '))
  check('remove: residue is reported by source, and never as a grants-file footprint',
    lines.some(line => line.includes('effect ledger still records'))
    && lines.some(line => line.includes('storage namespace')),
    lines.join(' | '))
  rmSync(dir, { recursive: true, force: true })
}

{
  const { dir, file } = sandbox()
  // A corrupt grants file: the removal must still happen, and the failed forget
  // must name the id, the file and the inheritance risk.
  seed(file, '{broken')
  const lines: string[] = []
  const order: string[] = []
  const service = manageService({ file, order })
  const flow = manageFlow({ action: 'remove', dir, file, service, lines })
  await flow.begin()
  await flow.confirm()
  check('remove: a corrupt grants file does not block the removal',
    order.join(',') === `removeBundle:${PACKAGE_A}`, order.join(','))
  check('remove: the failed forget reports the id, the file and the inheritance risk',
    lines.some(line => line.includes(SHARED_ID) && line.includes(EXTENSION_GRANTS_FILE) && line.includes('inherit')),
    lines.join(' | '))
  check('remove: the corrupt file is left exactly as it was', read(file) === '{broken')
  rmSync(dir, { recursive: true, force: true })
}

// ── E. the same-id inheritance regression (D-3) ──────────────────────────────
{
  const { dir, file } = sandbox()
  // 1. Package A installs and is granted.
  {
    const rig = installService({ file })
    const flow = installFlow({
      dir, file, service: rig.service, spec: '/probe/package-a', notice: 'declared',
      directory: '/probe/package-a', grantsOf: A_GRANTS,
    })
    await flow.begin()
    await flow.confirm()
  }
  check('inheritance: package A was granted under its component id',
    JSON.stringify((JSON.parse(read(file)) as { grants: Record<string, unknown> }).grants[SHARED_ID])
      === `[{"name":"storage.local.read","scope":"${SHARED_ID}"},{"name":"session.input.intercept","scope":"tui/input"},{"name":"commands.invoke","scope":"com.example.status"}]`,
    read(file))
  // 2. Removing A forgets that id.
  {
    const lines: string[] = []
    const order: string[] = []
    const service = manageService({ file, order })
    const flow = manageFlow({ action: 'remove', dir, file, service, lines })
    await flow.begin()
    await flow.confirm()
  }
  check('inheritance: removal leaves neither grants nor denies for that id',
    !read(file).includes(SHARED_ID), read(file))
  // 3. Package B reuses the id under a different package name: its confirmation
  //    must show every permission as ungranted, and must not write by itself.
  {
    const rig = installService({ file })
    const flow = installFlow({
      dir, file, service: rig.service, spec: '/probe/package-b', notice: 'declared',
      directory: '/probe/package-b', grantsOf: A_GRANTS,
    })
    const asked = await flow.begin()
    check('inheritance: the same id under a new package name shows nothing as granted',
      asked.kind === 'confirm' && asked.grants !== undefined
      && asked.grants.entries.filter(entry => entry.default === 'deny').every(entry => entry.granted === false),
      JSON.stringify(asked))
    check('inheritance: reading that confirmation does not resurrect the old grant',
      !read(file).includes(SHARED_ID), read(file))
  }
  rmSync(dir, { recursive: true, force: true })
}

// ── F. the real panes render the list and the key hint ───────────────────────
{
  const { Terminal: XTerm } = await import('@xterm/headless')
  const { Writable, PassThrough } = await import('node:stream')
  const React = await import('react')
  const ui = await import('../src/ui.js')
  const { PluginInstallPane } = await import('../src/components/PluginInstallPane.js')
  const { PluginManagePane } = await import('../src/components/PluginManagePane.js')
  const { settled, viewportLines } = await import('./lib/term-test.mjs')
  const ROWS = 40
  const term = new XTerm({ cols: 100, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = 100
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class In extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new In()
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  const render = (node: React.ReactElement): Promise<{ unmount(): void }> => ui.render(node, {
    stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never,
    exitOnCtrlC: false, patchConsole: false,
  })
  const plan: GrantPlan = {
    id: SHARED_ID,
    entries: [
      { name: 'storage.local.read', scope: SHARED_ID, default: 'deny', granted: false },
      { name: 'session.input.intercept', scope: 'tui/input', default: 'deny', granted: true },
      // The cross case the comparator has to get right: an already-granted
      // default-deny row still leads an ungranted default-allow one.
      { name: 'commands.invoke', scope: 'com.example.status', default: 'allow', granted: false },
    ],
    unknown: ['probe.unknown.permission'],
  }
  const install = await render(React.createElement(PluginInstallPane, {
    busy: false,
    step: {
      kind: 'confirm',
      artifact: { name: PACKAGE_A, version: '1.0.0', kind: 'path', bundle: true, registry: null },
      trust: { kind: 'third-party', reason: 'unverifiable-source' },
      notice: { kind: 'declared' },
      grants: plan,
    },
  }))
  try {
    check('pane: the install confirmation lists the declared permissions and their scopes',
      await settled(() => screen().includes('storage.local.read') && screen().includes('tui/input')), screen())
    check('pane: the list marks what is already granted and what the host will skip',
      screen().includes('✓granted') && screen().includes('Unknown to this host and skipped'), screen())
    check('pane: the key hint names both halves of Enter',
      screen().includes('install and grant 3'), screen())
    const rowOf = (needle: string): number => viewportLines(term, ROWS).findIndex(line => line.includes(needle))
    check('pane: a granted default-deny row still leads an ungranted default-allow row',
      rowOf('session.input.intercept') !== -1 && rowOf('session.input.intercept') < rowOf('commands.invoke'),
      screen())
  } finally {
    install.unmount()
  }
  const manage = await render(React.createElement(PluginManagePane, {
    busy: false,
    step: {
      kind: 'confirm',
      target: { action: 'enable', kind: 'bundle', name: PACKAGE_A, version: '1.0.0', rows: 1, overrides: 0 },
      question: { kind: 'trust' },
      grants: plan,
    },
  }))
  try {
    check('pane: the enable confirmation lists the permissions it would grant',
      await settled(() => screen().includes('storage.local.read') && screen().includes('enable and grant 3')), screen())
  } finally {
    manage.unmount()
    term.dispose()
  }
  // The confirmation has to survive the terminal sizes the real screen uses.
  // The English status labels are the widest, and the list folds into the
  // overlay's height (`rows - 8`, the strip the prompt keeps): one wrapped row
  // would double its height, and a list that ignores the budget pushes the
  // title and the question off a short terminal. The 24-row cases show the
  // fold; the tall one shows the 12-row cap itself.
  for (const rows of [24, 40] as const) {
    for (const columns of [80, 50] as const) {
      const narrow = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
      class NarrowOut extends Writable {
        columns = columns
        rows = rows
        isTTY = true
        _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { narrow.write(String(chunk), callback) }
      }
      class NarrowIn extends PassThrough {
        isTTY = true
        setRawMode() { return this }
        ref() { return this }
        unref() { return this }
      }
      const crowded: GrantPlan = {
        // An id the rows do not repeat: the question has to name it by itself.
        id: 'com.probe.ask',
        entries: Array.from({ length: 12 }, (_, index) => ({
          name: 'session.input.intercept',
          scope: `${SHARED_ID}:command-${index}`,
          default: 'deny',
          granted: false,
        })),
        unknown: [],
      }
      const pane = await ui.render(React.createElement(PluginInstallPane, {
        busy: false,
        step: { kind: 'grant', plan: crowded },
      }), {
        stdout: new NarrowOut() as never, stdin: new NarrowIn() as never, stderr: new NarrowOut() as never,
        exitOnCtrlC: false, patchConsole: false,
      })
      try {
        const view = (): string => viewportLines(narrow, rows).join('\n')
        const statusRows = (): string[] => viewportLines(narrow, rows).filter(line => line.includes('@'))
        check(`pane: at ${columns}x${rows} the title, the question and the hint share one screen`,
          await settled(() => view().includes('Install plugin')
            // The question itself may wrap: what must not disappear is the
            // title, the component id it names (unique to the question here),
            // the question's closing and the key hint.
            && view().includes('com.probe.ask')
            && view().includes('now?')
            && view().includes('grant 12') && view().includes('esc skip')), view())
        const visible = statusRows().length
        check(`pane: at ${columns}x${rows} every visible permission keeps its status on one line`,
          visible > 0 && statusRows().every(line => line.includes('not granted')), view())
        if (rows === 24) {
          check(`pane: at ${columns}x${rows} the list folds what does not fit into one count line`,
            visible < 12 && view().includes(`and ${12 - visible} more…`), view())
        } else {
          check(`pane: at ${columns}x${rows} all 12 permissions are listed`,
            visible === 12 && !view().includes('more…'), view())
        }
      } finally {
        pane.unmount()
        narrow.dispose()
      }
    }
  }
}

console.log(`verify-plugin-grant-lifecycle OK (${passed} checks)`)
