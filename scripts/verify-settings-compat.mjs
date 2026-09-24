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
import TuiSettingsSectionsRuntime, { getHostSettingsSections, getLocalSettingsSectionsHost } from '../src/dsh-adapter/settings-sections.ts'
import { DEFAULT_PAGE_MARGIN, DEFAULT_STATUS_BAR, isPageMarginMode, normalizePageMargin, parsePageMarginSpec } from '../src/tuiDisplayPrefs.ts'
import { getLang, isLang } from '../src/i18n.ts'
import { SHORTCUT_ACTIONS, setKeymapOverrides, resetKeymapOverrides, effectiveComboString, parseComboDraft, draftComboConflicts } from '../src/utils/keymap.ts'

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
  let owner, child, liveScope, applyShortcuts, runtime
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
          DEFAULT_STATUS_BAR, normalizePageMargin, isLang, Config, configValues, createSettingsScope, resolveSettingsNamespace, setKeymapOverrides,
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
      config: configValues(runtime), SHORTCUT_ACTIONS, effectiveComboString, parseComboDraft, draftComboConflicts,
      getLang, DEFAULT_PAGE_MARGIN, isPageMarginMode, parsePageMarginSpec,
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
    const descriptor = root.settings.describe().find(view => view.ns === ns)
    assert.deepEqual(Object.keys(descriptor.schema.refs[descriptor.schema.uid].dict).sort(), Object.keys(Config.dict).filter(key => Config.dict[key].meta.volatile === true).sort())
    observed.length = 0
    form.edit(diffField, 'unified')
    const saved = await form.save()
    assert.equal(saved, true, `form save uses the real settings mutation path: ${form.failureMessage}`)
    assert.equal(configValues(runtime).diffLayout, 'unified')
    assert.equal(owner.fiber, ownerFiber, 'editing settings does not remount the agent owner')
    assert.equal(observed.length, 1)
    assert.equal(host.listNamespaces().find(view => view.ns === ns).value.diffLayout, 'unified')
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
console.log(`PASS: settings scopes, config snapshots and provider reads (${modernSchema ? 'production sections, exact Loader IDs, volatile updates, shortcut resets and disposal' : 'legacy schema'})`)
