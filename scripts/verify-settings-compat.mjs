/**
 * Legacy scopes and 0.1.7 Config-backed settings. Uses source via tsx so the
 * same assertions can run with TSX_TSCONFIG_PATH pointing at upstream sources.
 * Run: node --import tsx/esm scripts/verify-settings-compat.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'
import Settings from '@deepseek-ai/dsh-settings'
import { Config } from '../src/dsh-adapter/index.ts'
import { configValues, createSettingsScope, editableConfig, resolveSettingsNamespace } from '../src/dsh-adapter/compat/settings.ts'
import { createSettingsHosts } from '../src/dsh-adapter/channel/settings-host.ts'
import { SettingsForm } from '../src/dsh-adapter/settingsEditor.ts'
import { createTuiSettingsSchema } from '../src/dsh-adapter/tuiSettingsSchema.ts'
import TuiSettingsSectionsRuntime, { getHostSettingsSections, getLocalSettingsSectionsHost } from '../src/dsh-adapter/settings-sections.ts'
import { BTW_CONTEXT_BUDGET_MAX, BTW_CONTEXT_BUDGET_MIN, BTW_CONTEXT_TURNS_MAX, BTW_CONTEXT_TURNS_MIN, DEFAULT_PAGE_MARGIN, DEFAULT_SIDE_PANEL_IDS, DEFAULT_STATUS_BAR, SIDE_PANEL_ID_PATTERN, isPageMarginMode, normalizePageMargin, normalizeSidePanelPanels, parsePageMarginSpec } from '../src/tuiDisplayPrefs.ts'
import { normalizeBrandSetting } from '../src/branding.ts'
import { SPLASH_FONTS, SPLASH_FONT_OPTIONS, normalizeSplashFont } from '../src/components/splashFonts.ts'
import { getLang, isLang } from '../src/i18n.ts'
import { SHORTCUT_ACTIONS, setKeymapOverrides, resetKeymapOverrides, effectiveComboString, parseComboDraft, draftComboConflicts } from '../src/utils/keymap.ts'
import { SETTING_GROUPS, SHORTCUT_FIELD_META, settingField } from '../src/settings/definitions.ts'

const modernSchema = typeof Schema.boolean().volatile === 'function'
const parsed = Config({ fullscreen: false, whale: false, effortDefault: 'high', statusBar: { model: false } })
const plain = configValues(parsed)
assert.equal(plain.fullscreen, false)
assert.equal(plain.whale, false)
assert.equal(plain.effortDefault, 'high')
assert.equal(plain.statusBar.model, false)
assert.equal(Config.dict.fullscreen.meta.volatile === true, modernSchema)
for (const field of ['sessionId', 'model', 'provider', 'cwd', 'preset']) {
  assert.notEqual(Config.dict[field].meta.volatile, true, `${field} cannot change without agent lifecycle handling`)
}

/**
 * Mirror of the host write gate (`isVolatilePath` in @deepseek-ai/dsh-settings):
 * only a path whose schema carries `meta.volatile` at some level accepts a
 * settings write. Kept inline so the assertion tracks exactly what
 * `settings.mutate` will accept.
 */
function isVolatilePath(schema, path) {
  if (schema?.meta?.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema?.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
// Negative control: an intentionally non-volatile route must fail the walker,
// so a walker that always returns true cannot satisfy the guard below.
assert.equal(isVolatilePath(Config, ['sessionId']), false)

/**
 * Whether the schema DECLARES a settings path (walk `dict` segment by segment).
 * `isVolatilePath` cannot see this on its own: a leaf under a volatile parent
 * (`statusBar.cost`) is writable no matter what, so the host accepts the write
 * and schemastery then drops the undeclared key on the way back in — the row
 * reads "(unset)" and every edit silently reverts. Declaration is the property
 * that actually has to hold for the value to survive a round trip.
 */
function isDeclaredPath(schema, path) {
  let node = schema
  for (const key of path) {
    node = node?.dict?.[key]
    if (node === undefined) return false
  }
  return true
}
// Negative control as well: the walker must reject an undeclared leaf (its
// positive side is the production-registry guard below, exactly like
// isVolatilePath above).
assert.equal(isDeclaredPath(Config, ['statusBar', 'no-such-toggle']), false)

let update
const ctx = { on(event, handler) {
  assert.equal(event, 'loader/volatile-update')
  update = handler
  return () => { update = undefined }
} }
let current = { fullscreen: false, diffLayout: 'split' }
const scope = createSettingsScope(ctx, {}, 'dsh-tui', Schema.object({}), () => current)
assert.equal(scope.legacy, false)
assert.equal(scope.get().fullscreen, false, 'modern profile inline choice is not a legacy migration')
let observed
const dispose = scope.watch(value => { observed = value })
current = { fullscreen: true, diffLayout: 'unified' }
update()
assert.equal(observed, current, 'watch reads the committed config snapshot')
dispose()
assert.equal(update, undefined, 'watch has an owned disposer')

let registered = 0
let legacyWatch
const legacy = {
  register(ns, schema) {
    assert.equal(this, legacy)
    assert.equal(ns, 'dsh-tui')
    assert.ok(schema)
    registered++
    return { get: () => ({ fullscreen: false }), watch: callback => { legacyWatch = callback; return () => { legacyWatch = undefined } } }
  },
}
const oldScope = createSettingsScope(ctx, legacy, 'dsh-tui', Schema.object({}), () => { throw new Error('legacy host must read its user scope') })
assert.equal(oldScope.legacy, true)
assert.equal(registered, 1)
assert.equal(oldScope.get().fullscreen, false)
const stopOld = oldScope.watch(value => { observed = value })
legacyWatch({ fullscreen: true })
assert.equal(observed.fullscreen, true)
stopOld()
assert.equal(legacyWatch, undefined)

// Reproduce the old schema capability without changing the installed framework.
const oldField = Schema.boolean()
oldField.volatile = undefined
const oldConfig = editableConfig(Schema.object({ fullscreen: oldField }), ['fullscreen'])
assert.notEqual(oldConfig.dict.fullscreen.meta.volatile, true)
assert.equal(resolveSettingsNamespace({ get: () => legacy }, oldConfig), 'dsh-tui')
assert.equal(resolveSettingsNamespace({ get: () => undefined }, oldConfig), 'dsh-tui', 'settings remains optional')
assert.throws(() => resolveSettingsNamespace({ get: () => ({}) }, oldConfig), /schemastery >= 3\.18\.3.*reinstall/)

// Execute the production settings wiring, not a hand-copied listener/merge.
// Isolate these statements from TTY/agent startup, retaining their real lexical
// ctx/settingsCtx ownership and watch disposer. Loader itself dispatches events.
const source = ts.createSourceFile('plugin.ts', readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let settingsBody
let namespaceDeclaration, sectionRegistration
const sectionDeclarations = new Map()
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'tuiSettingsNs')) {
    assert.equal(namespaceDeclaration, undefined)
    namespaceDeclaration = node.getText(source)
  }
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      const name = declaration.name.getText(source)
      if (name === 'shortcutFieldMeta' || name === 'shortcutFields') sectionDeclarations.set(name, node.getText(source))
    }
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'settingsSections.register') {
    assert.equal(sectionRegistration, undefined)
    sectionRegistration = node.getText(source)
  }
  if (ts.isArrowFunction(node) && node.parameters[0]?.name.getText(source) === 'settingsCtx') {
    assert.equal(settingsBody, undefined, 'settings injection must be unambiguous')
    settingsBody = node.body
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(settingsBody && ts.isBlock(settingsBody))
assert.ok(namespaceDeclaration)
assert.ok(sectionRegistration)
assert.equal(sectionDeclarations.size, 2)
const registrationJs = ts.transpileModule(`${namespaceDeclaration}
  ${sectionDeclarations.get('shortcutFieldMeta')}
  ${sectionDeclarations.get('shortcutFields')}
  return ${sectionRegistration}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const registerSection = dependencies => new Function(...Object.keys(dependencies), registrationJs)(...Object.values(dependencies))
const declarationNames = ['scope', 'applyShortcuts', 'bootSettings', 'lastTerminalImages']
const declarations = declarationNames.map(name => {
  const statement = settingsBody.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name))
  assert.ok(statement, `production settings declaration: ${name}`)
  return statement.getText(source)
})
function containsWatch(node) {
  return (ts.isCallExpression(node) && node.expression.getText(source) === 'scope.watch')
    || ts.forEachChild(node, containsWatch)
}
const watchStatements = settingsBody.statements.filter(node => ts.isExpressionStatement(node) && containsWatch(node))
assert.equal(watchStatements.length, 1, 'one production watch registration')
const javascript = ts.transpileModule(`
  ${namespaceDeclaration}
  return ctx.inject(['settings'], settingsCtx => {
    ${declarations.join('\n')}
    const apply = next => { observe(next); applyShortcuts(next) }
    apply(bootSettings)
    ${watchStatements[0].getText(source)}
    capture(settingsCtx, scope, applyShortcuts)
  })
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const bindSettings = dependencies => new Function(...Object.keys(dependencies), javascript)(...Object.values(dependencies))

if (modernSchema) for (const registry of ['service', 'local']) for (const entryId of ['dsh-tui', 'custom-tui', '1234abcd', 'Custom.TUI', ' custom-tui ']) {
  const root = new Context()
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-settings-'))
  const observed = []
  const notices = []
  let owner, child, liveScope, applyShortcuts, runtime, legacyScopeSchema
  resetKeymapOverrides()
  const defaultPaste = effectiveComboString('paste')
  try {
    await root.plugin(Loader)
    if (registry === 'service') await root.plugin(TuiSettingsSectionsRuntime)
    const sections = registry === 'service'
      ? getHostSettingsSections(root.get('tuiSettingsSections'))
      : getLocalSettingsSectionsHost(root)
    assert.ok(sections)
    // Only the profile IO is in-memory; form projection, validation, revision
    // fencing, mutation and Loader updates all run through the real services.
    root.provide('profileContext', { home })
    root.provide('configEditor', {
      entries: () => [...root.loader.entries()],
      configuration: () => [...root.loader.entries()].map(entry => ({ entry, inherited: {}, override: entry.options.config ?? {} })),
      async edit(entry, change) {
        await root.loader.update(entry.options.id, { config: change(entry.options.config ?? {}, {}) })
        await root.loader.await()
      },
    })
    await root.plugin(Settings)
    assert.throws(() => resolveSettingsNamespace(root, Config), /require a Loader entry/)
    root.loader.builtins.fixture = { Config, async apply(ctx, runtimeConfig) {
      owner = ctx
      runtime = runtimeConfig
      await ctx.plugin(async runtimeCtx => {
        await bindSettings({
          ctx: runtimeCtx, configOwner: ctx, runtimeConfig, config: configValues(runtimeConfig), Schema, SHORTCUT_ACTIONS,
          DEFAULT_STATUS_BAR, normalizePageMargin, isLang, Config, configValues, createTuiSettingsSchema, resolveSettingsNamespace, setKeymapOverrides,
          // Capture the legacy scope's own schema: the production wiring hands
          // it a second hand-written statusBar list that has to stay in step
          // with Config (the `local` registry path reads values through it).
          createSettingsScope: (...args) => { legacyScopeSchema = args[3]; return createSettingsScope(...args) },
          bootedFullscreen: true, bootedTerminalImages: true,
          t: key => key, notifyChannel: message => notices.push(message), channel: { notify: message => notices.push(message) },
          observe: value => observed.push(value),
          capture(settingsCtx, scope, apply) { child = settingsCtx; liveScope = scope; applyShortcuts = apply },
        })
      })
    } }
    await root.loader.create({ id: entryId, name: 'cordis:fixture', config: { diffLayout: 'split', shortcuts: { paste: 'alt+v' } } })
    await root.loader.await()
    assert.notEqual(owner.fiber, child.fiber, 'injection has its own lifecycle')
    assert.equal(effectiveComboString('paste'), 'alt+v')
    const ownerFiber = owner.fiber
    const unregister = registerSection({
      configOwner: owner, Config, resolveSettingsNamespace, settingsSections: sections,
      config: configValues(runtime), SHORTCUT_ACTIONS, SHORTCUT_FIELD_META, SETTING_GROUPS, settingField, effectiveComboString, parseComboDraft, draftComboConflicts,
      getLang, DEFAULT_PAGE_MARGIN, isPageMarginMode, parsePageMarginSpec, SPLASH_FONT_OPTIONS, normalizeSplashFont,
      // Side-panel fields (sidePanel.panels) validate their draft against the
      // production id grammar, so the eval scope mirrors those helpers too.
      DEFAULT_SIDE_PANEL_IDS, SIDE_PANEL_ID_PATTERN, normalizeSidePanelPanels,
      // The brand and btw fields format/parse through these.
      normalizeBrandSetting, BTW_CONTEXT_TURNS_MIN, BTW_CONTEXT_TURNS_MAX, BTW_CONTEXT_BUDGET_MIN, BTW_CONTEXT_BUDGET_MAX,
      bootedFullscreen: true, terminalImagesDisabledByEnv: false,
      readEffortPref: () => undefined, // Do not read the developer's persisted preferences.
    })
    root.effect(() => unregister)
    const section = sections.section(entryId)
    assert.ok(section, `${registry}: production registration preserves the exact Loader ID ${JSON.stringify(entryId)}`)
    if (entryId !== entryId.trim()) {
      const removeSibling = sections.register({ ns: entryId.trim(), fields: [] })
      root.effect(() => removeSibling)
      assert.equal(sections.section(entryId), section, 'distinct Loader IDs must not alias after trimming')
    }
    const ns = section.ns
    assert.equal(ns, entryId, 'production section follows the Config owner entry ID')
    const host = createSettingsHosts(root).settingsHost()
    const view = host.listNamespaces().find(view => view.ns === ns)
    const diffField = section.fields.find(field => field.path.length === 1 && field.path[0] === 'diffLayout')
    assert.ok(diffField, 'the production section exposes diffLayout')
    const form = new SettingsForm(host, view, section.fields)
    assert.equal(form.available, true, 'real describe() supplies the editable TUI section')
    assert.equal(form.field(diffField).text, 'split', 'the settings page shows the effective value')
    // 开屏大字字体（splashFont）：面板选项直接由字体注册表推，所以这里同时钉住
    // 「选项覆盖全部合法取值」「未设置时显示生效值（daily）」与「每一位都能被选中
    // 并真的存进 profile」——select 的 parse 只认 options 里的值，写不进别的。
    const splashField = section.fields.find(field => field.path.length === 1 && field.path[0] === 'splashFont')
    assert.ok(splashField, `${registry}: the production section exposes splashFont`)
    assert.equal(splashField.kind, 'select')
    assert.deepEqual(splashField.options.map(option => option.value), ['daily', ...SPLASH_FONTS.map(font => font.id)])
    assert.equal(form.field(splashField).text, 'daily', 'unset splashFont shows the effective daily rotation')
    for (const option of splashField.options) {
      form.edit(splashField, option.value)
      assert.equal(form.field(splashField).invalid, false, `${registry}: splashFont option ${option.value} is selectable`)
    }
    const descriptor = root.settings.describe().find(view => view.ns === ns)
    assert.deepEqual(Object.keys(descriptor.schema.refs[descriptor.schema.uid].dict).sort(), Object.keys(Config.dict).filter(key => Config.dict[key].meta.volatile === true).sort())
    // 面板注册表（plugin.ts 的 fields）与 Config 是两份手写清单。两条断言各管一
    // 半：volatile 决定写路径收不收（recapOnOpen 漏掉时是响亮的
    // `Config field "x" is not volatile`），声明决定值能不能活着回来——叶子挂在
    // volatile 父节点下（statusBar.cost）时 volatile 恒真，只有声明性 walker 抓
    // 得住它：写被照收，随后 schema 重新解析时丢掉，面板退化成「（未设置）」。
    for (const field of section.fields) {
      assert.equal(isVolatilePath(Config, field.path), true, `${registry}: registered field ${field.path.join('.')} must be volatile on Config`)
      assert.equal(isDeclaredPath(Config, field.path), true, `${registry}: registered field ${field.path.join('.')} must be declared on Config`)
    }
    // normalizeStatusBar 会照单抄 DEFAULT_STATUS_BAR 的每个键，所以运行时的这份
    // 契约每个键都得在 Config.statusBar 里有槽位（同一条手写清单问题的另一半）。
    assert.deepEqual(
      Object.keys(DEFAULT_STATUS_BAR).filter(key => !isDeclaredPath(Config, ['statusBar', key])),
      [],
      `${registry}: every DEFAULT_STATUS_BAR field needs a Config.statusBar slot`,
    )
    // 老式 settings scope 自带第二份手写 statusBar 清单（plugin.ts 的
    // createSettingsScope 内联 schema）；`local` 注册表路径经它读值，键集必须与
    // Config.statusBar 一致，否则那条路径上同样读不到 / 存不住。
    assert.ok(legacyScopeSchema, `${registry}: the production wiring built its legacy settings scope schema`)
    assert.deepEqual(
      Object.keys(legacyScopeSchema.dict.statusBar.dict).sort(),
      Object.keys(Config.dict.statusBar.dict).sort(),
      `${registry}: the legacy settings scope must declare the same statusBar slots as Config`,
    )
    // 打开会话自动总结（recapOnOpen）：可写之外还要真的存得进、读得回。
    // channel.autoRecapOnOpen 读的是 describe().value.recapOnOpen !== false，漏掉
    // Config 声明时它恒为 undefined，于是自动回顾永远关不掉。
    const recapField = section.fields.find(field => field.path.length === 1 && field.path[0] === 'recapOnOpen')
    assert.ok(recapField, `${registry}: the production section exposes recapOnOpen`)
    assert.equal(form.field(recapField).text, 'true', 'unset recapOnOpen shows the effective on')
    // 底栏花费估算（statusBar.cost）：同一条链的叶子版本——未设置时面板要显示生效
    // 值「开」，改动要真的落盘，describe() 投影也要带上它（StatusLine 读的就是这一
    // 份；漏声明时那一行永远只显示「（未设置）」）。
    const costField = section.fields.find(field => field.path.length === 2 && field.path[0] === 'statusBar' && field.path[1] === 'cost')
    assert.ok(costField, `${registry}: the production section exposes statusBar.cost`)
    assert.equal(form.field(costField).text, 'true', 'unset statusBar.cost shows the effective on')
    observed.length = 0
    form.edit(diffField, 'unified')
    form.edit(splashField, 'classic')
    form.edit(recapField, 'false')
    form.edit(costField, 'false')
    assert.equal(form.field(recapField).invalid, false, `${registry}: recapOnOpen accepts a boolean edit`)
    assert.equal(form.field(costField).invalid, false, `${registry}: statusBar.cost accepts a boolean edit`)
    const saved = await form.save()
    assert.equal(saved, true, `form save uses the real settings mutation path: ${form.failureMessage}`)
    assert.equal(configValues(runtime).diffLayout, 'unified')
    assert.equal(configValues(runtime).splashFont, 'classic', 'the panel persists the picked face')
    assert.equal(configValues(runtime).recapOnOpen, false, 'the panel persists the recap switch')
    assert.equal(configValues(runtime).statusBar.cost, false, 'the panel persists the status-bar cost switch')
    assert.equal(owner.fiber, ownerFiber, 'editing settings does not remount the agent owner')
    assert.equal(observed.length, 1)
    assert.equal(host.listNamespaces().find(view => view.ns === ns).value.diffLayout, 'unified')
    assert.equal(host.listNamespaces().find(view => view.ns === ns).value.recapOnOpen, false, 'describe() projects the recap switch for the channel read site')
    assert.equal(host.listNamespaces().find(view => view.ns === ns).value.statusBar.cost, false, 'describe() projects the cost switch for the status-bar read site')
    observed.length = 0
    await root.loader.update(entryId, { config: { diffLayout: 'unified', fullscreen: false, shortcuts: {} } })
    await root.loader.await()
    assert.equal(configValues(runtime).diffLayout, 'unified', 'real Loader committed the config')
    assert.equal(observed.length, 1, 'owner event reaches the injected settings consumer exactly once')
    assert.equal(observed[0].diffLayout, 'unified')
    assert.deepEqual(notices, ['settings-fullscreen-restart'])
    assert.equal(effectiveComboString('paste'), defaultPaste, 'clearing the profile override restores the default live')
    for (const shortcuts of [undefined, { paste: '' }, { paste: '  ' }]) {
      applyShortcuts({ shortcuts })
      assert.equal(effectiveComboString('paste'), defaultPaste, 'unset and blank overrides do not revive the startup snapshot')
    }
    // The legacy scope still layers user choices over the deployment config.
    liveScope.legacy = true
    applyShortcuts({ shortcuts: {} })
    assert.equal(effectiveComboString('paste'), 'alt+v')
    applyShortcuts({ shortcuts: { paste: 'ctrl+shift+v' } })
    assert.equal(effectiveComboString('paste'), 'ctrl+shift+v')
    liveScope.legacy = false
    await child.fiber.dispose()
    await root.loader.update(entryId, { config: { diffLayout: 'split', shortcuts: {} } })
    await root.loader.await()
    assert.equal(observed.length, 1, 'disposing the injection removes its owner-fiber listener')
    await root.loader.create({ id: 'restarted', name: 'cordis:fixture', config: { diffLayout: 'split', shortcuts: {} } })
    await root.loader.await()
    assert.equal(effectiveComboString('paste'), defaultPaste, 'a fresh boot agrees with the live reset')
    unregister()
    assert.equal(sections.section(entryId), undefined, 'disposal removes the exact Loader ID')
  } finally {
    await root.fiber.dispose()
    resetKeymapOverrides()
    rmSync(home, { recursive: true, force: true })
  }
}

// Only host-owned sections accept Loader IDs; external plugin validation stays strict.
const pluginRoot = new Context()
try {
  await pluginRoot.plugin(TuiSettingsSectionsRuntime)
  await pluginRoot.inject(['tuiSettingsSections'], ctx => {
    for (const ns of ['', '1234abcd', 'Custom.TUI']) {
      assert.throws(() => ctx.tuiSettingsSections.register({ ns, fields: [] }), /invalid TUI settings-section namespace/)
    }
    const unregister = ctx.tuiSettingsSections.register({ ns: ' plugin-settings ', fields: [] })
    assert.equal(ctx.tuiSettingsSections.section('plugin-settings').ns, 'plugin-settings', 'legacy plugin namespaces still normalize whitespace')
    unregister()
  })
} finally {
  await pluginRoot.fiber.dispose()
}

for (const api of ['legacy', 'forms']) {
  const value = { providers: { test: { baseURL: 'https://example.invalid', apiKeyEnv: 'TEST_CREDENTIAL' } } }
  const mutations = []
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, applies: 'live', value }],
    mutate(...args) { mutations.push(args); return Promise.resolve() },
    ...(api === 'legacy' ? { get: () => value } : {}),
  }
  const services = {
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    llm: { listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'test', displayName: 'Test' }] },
  }
  const hosts = createSettingsHosts({ get: name => services[name] })
  const provider = hosts.providerSetup()
  assert.ok(provider, `${api}: provider wizard is available`)
  assert.equal(provider.routeExists('test'), true)
  assert.equal(provider.routeExists('missing'), false)
  assert.equal(provider.listRefUsers('TEST_CREDENTIAL').length, 1)
  assert.equal(provider.listConfiguredProviders().length, 1)
  const host = hosts.settingsHost()
  assert.equal(host.listNamespaces()[0].revision, 7)
  const ops = [{ op: 'set', path: ['providers', 'test', 'baseURL'], value: 'https://new.invalid' }]
  await host.write('llm-pi-ai', ops, 7)
  assert.deepEqual(mutations, [['llm-pi-ai', ops, 7]], 'writes retain revision fencing and path operations')
}
// The schema lives in tuiSettingsSchema.ts (shared with the `dst` preload)
// while the fields live in plugin.ts: a field whose key the schema lacks is
// dropped from the resolved settings without any type error.
{
  const pluginText = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const fieldKeys = new Set([...pluginText.matchAll(/settingField\('([^'.]+)/g)].map(match => match[1]))
  const schemaKeys = new Set(Object.keys(createTuiSettingsSchema().dict ?? {}))
  // Not in the plugin's settings schema before it moved out of plugin.ts
  // either: listed so this check catches only new gaps.
  const knownOutside = new Set(['recapOnOpen'])
  const missing = [...fieldKeys].filter(key => !schemaKeys.has(key) && !knownOutside.has(key))
  assert.ok(fieldKeys.size > 0, 'settings fields found in plugin.ts')
  assert.deepEqual(missing, [], `every settings field has a key in createTuiSettingsSchema (missing: ${missing.join(', ')})`)
}

console.log(`PASS: settings scopes, config snapshots and provider reads (${modernSchema ? 'production sections, exact Loader IDs, volatile updates, shortcut resets and disposal' : 'legacy schema'})`)
