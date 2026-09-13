/**
 * P3 kernel-slice gate.
 *
 * Proves:
 * - every P3 capability has an enumerable KernelSlice (unique id, driver,
 *   Standard declarations);
 * - mounting all slices through the production KernelRuntime produces
 *   mounted Ports visible on the thin HostFacade;
 * - each mounted driver returns a disposer and disposing the Kernel removes
 *   the mounted ports.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-slices.ts`.
 */
import assert from 'node:assert/strict'
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ADAPTER_KERNEL_SLICES } from '../src/adapter/kernel/slices/index.js'
import { KernelRuntime } from '../src/adapter/kernel/kernel-runtime.js'
import { normalizeAdapterSliceList, parseAdapterRuntime } from '../src/adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../src/adapter/kernel/runtime-context.js'
import { decisionRegistryOf } from '../src/dsh-adapter/decision-guard.js'
import { TuiPluginHostRuntime, getHostFacade } from '../src/dsh-adapter/plugin-host.js'
import { TuiDialogRuntime } from '../src/dsh-adapter/dialogs.js'
import { TuiSceneRuntime } from '../src/dsh-adapter/scenes.js'
import { TuiSettingsSectionsRuntime, getLocalSettingsSectionsHost } from '../src/dsh-adapter/settings-sections.js'
import { TuiStatusRuntime } from '../src/dsh-adapter/status.js'
import { TuiShortcutRuntime } from '../src/dsh-adapter/shortcuts.js'
import { TuiRendererRuntime } from '../src/dsh-adapter/renderers.js'
import { TuiThemeRuntime } from '../src/dsh-adapter/themes.js'
import { TuiToastRuntime } from '../src/dsh-adapter/toast.js'
import { TuiCommandTreeRuntime } from '../src/dsh-adapter/command-trees.js'
import { TuiWorkspaceRuntime } from '../src/dsh-adapter/workspaces.js'

const ROOT = resolve(import.meta.dirname, '..')
const pluginHostSource = readFileSync(resolve(ROOT, 'src/dsh-adapter/plugin-host.ts'), 'utf8')

/**
 * AST-level production wiring check: the real `new KernelRuntime(...)` inside
 * the non-legacy branch must actually pass `kernelSlices: ADAPTER_KERNEL_SLICES`.
 * This rejects string/comment-only heuristics and proves the option is not dead.
 */
function productionKernelSlicesWired(source: string): boolean {
  const sf = ts.createSourceFile('plugin-host.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIfStatement(node)) {
      const condition = node.expression.getText(sf)
      if (condition.includes('state.runtime.mode') && condition.includes('legacy')) {
        const scanStatement = (statement: ts.Statement | undefined): void => {
          if (statement === undefined) return
          const statements = ts.isBlock(statement) ? statement.statements : [statement]
          for (const child of statements) {
            let hasKernelNew = false
            let hasSlices = false
            const scan = (n: ts.Node): void => {
              if (ts.isNewExpression(n)
                && ts.isIdentifier(n.expression)
                && n.expression.text === 'KernelRuntime') {
                hasKernelNew = true
                const arg = n.arguments?.[0]
                if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
                  for (const property of arg.properties) {
                    if (ts.isPropertyAssignment(property)
                      && ts.isIdentifier(property.name)
                      && property.name.text === 'kernelSlices') {
                      const init = property.initializer.getText(sf)
                      if (init.includes('ADAPTER_KERNEL_SLICES')) hasSlices = true
                    }
                  }
                }
              }
              if (!hasKernelNew || !hasSlices) ts.forEachChild(n, scan)
            }
            scan(child)
            if (hasKernelNew && hasSlices) found = true
          }
        }
        scanStatement(node.thenStatement)
        if (!found) scanStatement(node.elseStatement)
      }
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

assert.ok(productionKernelSlicesWired(pluginHostSource),
  'production plugin-host AST must pass ADAPTER_KERNEL_SLICES inside the non-legacy KernelRuntime branch')

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (/\.tsx?$/u.test(entry)) files.push(full)
    }
  }
  walk(dir)
  return files
}

// Runtime snapshot source gate: production composition-bound code must not
// re-read the live process environment after a service is constructed.
// `parseAdapterRuntime()` is allowed only in the runtime definition itself and
// the explicit composition-root snapshot helper.
const SRC = resolve(ROOT, 'src')
const RUNTIME_PARSE_ALLOWED = new Set<string>([
  resolve(SRC, 'adapter/kernel/runtime.ts'),
  resolve(SRC, 'adapter/kernel/runtime-context.ts'),
])
for (const file of sourceFilesUnder(SRC)) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('parseAdapterRuntime(') && !RUNTIME_PARSE_ALLOWED.has(file)) {
    assert.fail(`${file}: production code called parseAdapterRuntime() directly; use adapterRuntimeFor(ctx) or defaultAdapterRuntime()`)
  }
  if (file.startsWith(resolve(SRC, 'dsh-adapter'))) {
    for (const match of source.matchAll(/readGrantStore\([^)]*\)/gu)) {
      const call = match[0]
      if (!/adapterRuntimeFor|adapterRuntime|defaultAdapterRuntime|\bruntime\b/u.test(call)) {
        assert.fail(`${file}: readGrantStore() must be given the composition runtime snapshot: ${call}`)
      }
    }
  }
}

let checks = 0
const ids = new Set<string>()
for (const slice of ADAPTER_KERNEL_SLICES) {
  checks += 1
  assert.ok(!ids.has(slice.id), `duplicate slice ${slice.id}`)
  ids.add(slice.id)
}

assert.ok(ADAPTER_KERNEL_SLICES.length >= 6, 'P3 must have at least presentation/workspace/scenes/settings/extensions/decisions slices')

const ctx = new Context()
ctx.logger.warn = () => undefined
// Mount the real host seam services so the P3 slices can mount ports over
// the same host-only facades used by production TUI code.
new TuiSceneRuntime(ctx)
new TuiSettingsSectionsRuntime(ctx)
new TuiStatusRuntime(ctx)
new TuiShortcutRuntime(ctx)
new TuiRendererRuntime(ctx)
new TuiThemeRuntime(ctx)
new TuiToastRuntime(ctx)
new TuiCommandTreeRuntime(ctx)
new TuiWorkspaceRuntime(ctx)

const kernel = new KernelRuntime({
  context: ctx,
  mode: 'new',
  generationId: 'slices-battery',
  kernelSlices: ADAPTER_KERNEL_SLICES,
})

await kernel.refresh()
checks += 1
const lifecycleByCapability = new Map(kernel.currentLifecycles().map(lifecycle => [lifecycle.capability, lifecycle]))
const expectedLiveFeatures = Object.freeze([
  'host.workspaces.list',
  'host.workspaces.resolve',
  'host.workspaces.describe',
  'host.workspaces.commands',
  'host.scenes.register',
  'host.scenes.list',
  'host.settings.register',
  'host.settings.list',
  'host.settings.section',
  'host.status.set',
  'host.status.snapshot',
  'host.shortcuts.register',
  'host.shortcuts.list',
  'host.renderers.register',
  'host.renderers.render',
  'host.themes.register',
  'host.themes.snapshot',
  'host.themes.resolver',
  'host.command-trees.register',
  'host.command-trees.children',
])
for (const capability of expectedLiveFeatures) {
  const lifecycle = lifecycleByCapability.get(capability)
  assert.ok(lifecycle !== undefined, `Kernel refresh must produce a lifecycle for ${capability}`)
  assert.equal(lifecycle!.state, 'live', `Kernel refresh must promote feature ${capability} to live`)
}
const expectedDegradedFeatures = Object.freeze([
  'host.workspaces.commandShell',
  'host.workspaces.rename',
  'host.workspaces.runCommand',
  'host.scenes.open',
  'host.scenes.close',
  'host.scenes.active',
  'host.scenes.subscribe',
  'host.settings.subscribe',
  'host.status.subscribe',
  'host.shortcuts.dispatch',
  'host.themes.subscribe',
  'host.toast.show',
  'host.command-trees.descriptions',
])
for (const capability of expectedDegradedFeatures) {
  const lifecycle = lifecycleByCapability.get(capability)
  assert.ok(lifecycle !== undefined, `Kernel refresh must produce a degraded feature lifecycle for ${capability}`)
  assert.notEqual(lifecycle!.state, 'live', `unverified feature ${capability} must not be published as live`)
}
const presentationLifecycle = lifecycleByCapability.get('host.presentation')
assert.ok(presentationLifecycle !== undefined)
assert.notEqual(presentationLifecycle!.state, 'live', 'presentation must remain honest/degraded in the kernel live path')
checks += 1

await kernel.mount()
checks += 1
const facade = kernel.facade()
assert.equal(typeof facade.descriptor.snapshot, 'function')
assert.ok(facade.presentation !== undefined, 'presentation slice must mount a HostPresentationPort')
assert.ok(facade.workspace !== undefined, 'workspace slice must mount a HostWorkspacePort')
assert.ok(facade.scenes !== undefined, 'scenes slice must mount a HostScenesPort')
assert.ok(facade.settings !== undefined, 'settings slice must mount a HostSettingsPort')
assert.ok(facade.status !== undefined, 'status slice must mount a HostStatusPort')
assert.ok(facade.shortcuts !== undefined, 'shortcuts slice must mount a HostShortcutsPort')
assert.ok(facade.renderers !== undefined, 'renderers slice must mount a HostRenderersPort')
assert.ok(facade.themes !== undefined, 'themes slice must mount a HostThemesPort')
assert.ok(facade.toast !== undefined, 'toast slice must mount a HostToastPort')
assert.ok(facade.commandTrees !== undefined, 'command-trees slice must mount a HostCommandTreesPort')
assert.ok(facade.decisions !== undefined, 'decisions slice must mount a HostDecisionsPort')
checks += 1

const snapshot = kernel.diagnosticSnapshot()
assert.ok(snapshot.drivers.length >= ADAPTER_KERNEL_SLICES.length, 'diagnostic snapshot must include per-driver rows')
assert.ok(snapshot.drivers.every(driver => typeof driver.mounted === 'boolean'))
checks += 1

// High1 regression: P3 feature lifecycles must survive the production
// mount/descriptor/diagnostic calls. mount()/descriptorBuild() invoke
// detect() synchronously; the Kernel must preserve the latest verified
// feature facts for slices that only implement detect()/verifyLive().
kernel.descriptorBuild()
const postProduction = new Map(kernel.currentLifecycles().map(lifecycle => [lifecycle.capability, lifecycle]))
for (const capability of expectedLiveFeatures) {
  checks += 1
  const lifecycle = postProduction.get(capability)
  assert.ok(lifecycle !== undefined,
    `P3 feature ${capability} must still exist after refresh->mount->descriptorBuild->diagnosticSnapshot`)
  assert.equal(lifecycle!.state, 'live',
    `P3 feature ${capability} must remain live after production detect re-runs`)
}
for (const capability of expectedDegradedFeatures) {
  checks += 1
  const lifecycle = postProduction.get(capability)
  assert.ok(lifecycle !== undefined,
    `P3 degraded feature ${capability} must still exist after refresh->mount->descriptorBuild->diagnosticSnapshot`)
  assert.notEqual(lifecycle!.state, 'live',
    `P3 degraded feature ${capability} must remain degraded (not disappear)`)
}
assert.ok(snapshot.lifecycles.some(lifecycle => lifecycle.capability === 'host.scenes.register'),
  'diagnostic snapshot lifecycles must include P3 features')
assert.ok(snapshot.lifecycles.some(lifecycle => lifecycle.capability === 'host.workspaces.commandShell'),
  'diagnostic snapshot lifecycles must include P3 degraded features')

kernel.dispose()
checks += 1
const facadeAfter = kernel.facade()
assert.ok(facadeAfter.workspace === undefined, 'dispose must remove mounted workspace port')
assert.ok(facadeAfter.scenes === undefined, 'dispose must remove mounted scenes port')
assert.ok(facadeAfter.settings === undefined, 'dispose must remove mounted settings port')

// Slice parsing/filtering boundaries: case/whitespace normalization, aliases,
// unknown fail-closed, and corrected ownership (presentation must not load
// toast, messages must not load decisions).
{
  assert.equal(parseAdapterRuntime({}).mode, 'legacy')
  for (const mode of ['legacy', 'new', 'passive-shadow', 'replay-shadow']) {
    assert.equal(parseAdapterRuntime({ DSH_TUI_ADAPTER_MODE: ` ${mode.toUpperCase()} ` }).mode, mode)
  }
  for (const mode of ['passive_shadow', 'replay', 'bogus', '', '   ']) {
    assert.throws(() => parseAdapterRuntime({ DSH_TUI_ADAPTER_MODE: mode }),
      /unknown DSH_TUI_ADAPTER_MODE/u, `invalid mode ${JSON.stringify(mode)} must fail closed`)
  }
  assert.deepEqual(normalizeAdapterSliceList([' Presentation ']), ['presentation'])
  assert.deepEqual(normalizeAdapterSliceList(['dialogs']), ['presentation'])
  assert.deepEqual(normalizeAdapterSliceList(['decision-events']), ['decisions'])
  assert.throws(() => normalizeAdapterSliceList(['bogus']), /unknown adapter slice/)
  assert.throws(() => parseAdapterRuntime({
    DSH_TUI_ADAPTER_MODE: 'new',
    DSH_TUI_ADAPTER_SLICES: 'bogus',
  } as never), /unknown adapter slice/)
  const parsed = parseAdapterRuntime({
    DSH_TUI_ADAPTER_MODE: ' NEW ',
    DSH_TUI_ADAPTER_SLICES: ' scenes, SETTINGS ',
  } as never)
  assert.equal(parsed.mode, 'new')
  assert.deepEqual(parsed.slices, ['scenes', 'settings'])
  checks += 1

  const presentationOnly = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'slice-boundary-presentation',
    kernelSlices: ADAPTER_KERNEL_SLICES,
    slices: ['presentation'],
  })
  const presentationDriverIds = presentationOnly.diagnosticSnapshot().drivers.map(driver => driver.id)
  assert.ok(presentationDriverIds.includes('dsh-tui-presentation'))
  assert.ok(!presentationDriverIds.includes('dsh-tui-toast'),
    'presentation slice must not implicitly load toast')
  checks += 1

  const messagesOnly = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'slice-boundary-messages',
    kernelSlices: ADAPTER_KERNEL_SLICES,
    slices: ['messages'],
  })
  const messagesDriverIds = messagesOnly.diagnosticSnapshot().drivers.map(driver => driver.id)
  assert.ok(!messagesDriverIds.includes('dsh-tui-decisions'),
    'messages slice must not implicitly load decisions')
  checks += 1
}

// Real production assembly: mount the actual TuiPluginHostRuntime on a
// real Cordis composition with the host seam services, then verify the
// non-legacy Kernel mounts all P3 Ports through the production facade.
{
  const previousMode = process.env.DSH_TUI_ADAPTER_MODE
  process.env.DSH_TUI_ADAPTER_MODE = 'new'
  try {
    const integrationCtx = new Context()
    integrationCtx.logger.warn = () => undefined
    new TuiSceneRuntime(integrationCtx)
    new TuiSettingsSectionsRuntime(integrationCtx)
    new TuiStatusRuntime(integrationCtx)
    new TuiShortcutRuntime(integrationCtx)
    new TuiRendererRuntime(integrationCtx)
    new TuiThemeRuntime(integrationCtx)
    new TuiToastRuntime(integrationCtx)
    new TuiCommandTreeRuntime(integrationCtx)
    new TuiWorkspaceRuntime(integrationCtx)
    new TuiDialogRuntime(integrationCtx)
    new TuiPluginHostRuntime(integrationCtx)
    await new Promise(resolve => setTimeout(resolve, 80))
    const host = integrationCtx.get('tuiPluginHost')
    assert.ok(host !== undefined, 'real TuiPluginHostRuntime must be mounted')
    const productionFacade = getHostFacade(host)
    assert.ok(productionFacade !== undefined)
    assert.ok(productionFacade.workspace !== undefined, 'production TuiPluginHostRuntime must mount workspace Port')
    assert.ok(productionFacade.scenes !== undefined, 'production TuiPluginHostRuntime must mount scenes Port')
    assert.ok(productionFacade.settings !== undefined, 'production TuiPluginHostRuntime must mount settings Port')
    assert.ok(productionFacade.status !== undefined, 'production TuiPluginHostRuntime must mount status Port')
    assert.ok(productionFacade.toast !== undefined, 'production TuiPluginHostRuntime must mount toast Port')
    assert.ok(productionFacade.commandTrees !== undefined, 'production TuiPluginHostRuntime must mount commandTrees Port')
    assert.ok(productionFacade.decisions !== undefined, 'production TuiPluginHostRuntime must mount decisions Port')
    checks += 1
  } finally {
    if (previousMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
    else process.env.DSH_TUI_ADAPTER_MODE = previousMode
  }
}

// Runtime snapshot regression: one composition root captures the environment
// once; flipping process.env later must not mutate existing services, grants,
// decision registries or local fallback registries. A brand-new composition
// still reads the current environment.
{
  const previousMode = process.env.DSH_TUI_ADAPTER_MODE
  const previousSlices = process.env.DSH_TUI_ADAPTER_SLICES
  process.env.DSH_TUI_ADAPTER_MODE = 'passive-shadow'
  delete process.env.DSH_TUI_ADAPTER_SLICES
  try {
    const passiveCtx = new Context()
    passiveCtx.logger.warn = () => undefined
    const passiveRuntime = adapterRuntimeFor(passiveCtx)
    assert.equal(passiveRuntime.mode, 'passive-shadow')
    const passiveDecision = decisionRegistryOf(passiveCtx)
    assert.equal(passiveDecision.runtime.mode, 'passive-shadow')

    process.env.DSH_TUI_ADAPTER_MODE = 'new'
    assert.equal(adapterRuntimeFor(passiveCtx), passiveRuntime,
      'same composition root must return the same immutable snapshot after env flip')
    assert.equal(adapterRuntimeFor(passiveCtx).mode, 'passive-shadow')
    assert.equal(decisionRegistryOf(passiveCtx).runtime, passiveRuntime,
      'decision registry must use the composition-root snapshot')

    const newCtx = new Context()
    newCtx.logger.warn = () => undefined
    const newRuntime = adapterRuntimeFor(newCtx)
    assert.equal(newRuntime.mode, 'new',
      'a new composition created after env change must read the new environment')
    assert.notEqual(newRuntime, passiveRuntime)

    // The in-package local settings fallback is per composition root too,
    // so two roots never share a stale runtime or a shared host object.
    const passiveLocal = getLocalSettingsSectionsHost(passiveCtx)
    const newLocal = getLocalSettingsSectionsHost(newCtx)
    assert.notEqual(passiveLocal, newLocal)
    checks += 1
  } finally {
    if (previousMode === undefined) delete process.env.DSH_TUI_ADAPTER_MODE
    else process.env.DSH_TUI_ADAPTER_MODE = previousMode
    if (previousSlices === undefined) delete process.env.DSH_TUI_ADAPTER_SLICES
    else process.env.DSH_TUI_ADAPTER_SLICES = previousSlices
  }
}

console.log(`verify:adapter-slices OK (${checks} checks, ${ADAPTER_KERNEL_SLICES.length} slices)`)
