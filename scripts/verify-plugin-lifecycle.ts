/**
 * Real Cordis lifecycle boundary regression. Public extension services must
 * never let ctx.root turn a plugin-owned effect into a root-owned effect.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-lifecycle.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { TuiDialogRuntime, getHostDialogStore } from '../src/dsh-adapter/dialogs.js'
import { TuiStatusRuntime, getHostStatusStore } from '../src/dsh-adapter/status.js'
import TuiShortcutRuntime, { getHostShortcuts } from '../src/dsh-adapter/shortcuts.js'
import { TuiRendererRuntime, getHostRenderers } from '../src/dsh-adapter/renderers.js'
import TuiThemeRuntime, { getHostThemes } from '../src/dsh-adapter/themes.js'
import TuiSceneRuntime, { getHostSceneRuntime } from '../src/dsh-adapter/scenes.js'
import TuiSettingsSectionsRuntime, { getHostSettingsSections } from '../src/dsh-adapter/settings-sections.js'
import TuiWorkspaceRuntime, { getHostWorkspaceRuntime } from '../src/dsh-adapter/workspaces.js'
import TuiCommandTreeRuntime, { getHostCommandTrees } from '../src/dsh-adapter/command-trees.js'

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

const root = new Context()
await root.plugin(TuiDialogRuntime)
await root.plugin(TuiStatusRuntime)
await root.plugin(TuiShortcutRuntime)
await root.plugin(TuiRendererRuntime)
await root.plugin(TuiThemeRuntime)
await root.plugin(TuiSceneRuntime)
await root.plugin(TuiSettingsSectionsRuntime)
await root.plugin(TuiWorkspaceRuntime)
await root.plugin(TuiCommandTreeRuntime)

const dialogs = getHostDialogStore(root.get('tuiDialogs'))
const status = getHostStatusStore(root.get('tuiStatus'))
const shortcuts = getHostShortcuts(root.get('tuiShortcuts'))
const renderers = getHostRenderers(root.get('tuiRenderers'))
const themes = getHostThemes(root.get('tuiThemes'))
const scenes = getHostSceneRuntime(root.get('tuiScenes'))
const sections = getHostSettingsSections(root.get('tuiSettingsSections'))
const workspaces = getHostWorkspaceRuntime(root.get('tuiWorkspaces'))
const commandTrees = getHostCommandTrees(root.get('tuiCommandTrees'))
if (dialogs === undefined || status === undefined || shortcuts === undefined || renderers === undefined || themes === undefined || scenes === undefined || sections === undefined || workspaces === undefined || commandTrees === undefined) {
  throw new Error('lifecycle battery could not resolve host accessors')
}

// A plugin can read ctx.root, but cannot use it to attach an effect to the
// host fiber. Mutating entries reject or return their documented inert result.
let rootSceneRejected = false
let rootSettingsRejected = false
let rootWorkspaceRejected = false
let rootTreeRejected = false
let rootChildRejected = false
let rootRegistryRejected = false
let rootDialog: Promise<boolean> | undefined
let retainedStatus: any
let retainedThemes: any
let retainedWorkspace: any
let foreignWorkspaceCommands: readonly { name: string }[] | undefined
let foreignWorkspaceRun: Promise<unknown> | undefined
let foreignTreeChildren: readonly { name: string }[] | undefined
let foreignTreeDescription: unknown
let foreignSceneOpened = false
let foreignSceneActive: unknown
const rootProbe = root.inject(
  ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiThemes', 'tuiScenes', 'tuiSettingsSections', 'tuiWorkspaces', 'tuiCommandTrees'],
  (pluginCtx) => {
    const rootCtx = pluginCtx.root
    rootCtx.get('tuiStatus')?.set('root-leak', 'must not persist')
    rootCtx.get('tuiShortcuts')?.register('alt+z', { description: 'root leak', handler: () => {} })
    rootCtx.get('tuiRenderers')?.register('root/leak', () => ({ lines: ['must not persist'] }))
    rootCtx.get('tuiThemes')?.register({ name: 'root:leak', base: 'dark' })
    const canonicalRoot = rootCtx.root
    const rootBoundStatus = rootCtx.get('tuiStatus')
    rootCtx.root = new Context()
    try {
      rootBoundStatus?.set('root-mutate-leak', 'must not persist')
    } finally {
      rootCtx.root = canonicalRoot
    }
    rootDialog = rootCtx.get('tuiDialogs')?.confirm(rootCtx, { title: 'must not queue' })
    try {
      rootCtx.inject(['tuiStatus'], (childCtx) => childCtx.tuiStatus.set('root-child-leak', 'must not persist'))
    } catch {
      rootChildRejected = true
    }
    try {
      rootCtx.registry.delete(() => {})
    } catch {
      rootRegistryRejected = true
    }
    try {
      rootCtx.get('tuiScenes')?.register({ id: 'root-leak', component: () => null })
    } catch {
      rootSceneRejected = true
    }
    try {
      rootCtx.get('tuiSettingsSections')?.register({ ns: 'root-leak', title: 'Root leak', fields: [] })
    } catch {
      rootSettingsRejected = true
    }
    try {
      rootCtx.get('tuiWorkspaces')?.register({
        schemes: ['root-leak'],
        list: () => [],
        resolve: () => undefined,
        describe: () => undefined,
      })
    } catch {
      rootWorkspaceRejected = true
    }
    try {
      rootCtx.get('tuiCommandTrees')?.register({ root: 'root-leak', children: () => [] })
    } catch {
      rootTreeRejected = true
    }
  },
)
await rootProbe
check('root status call leaves no contribution', status.getSnapshot().length === 0)
check('root shortcut call leaves no binding', shortcuts.dispatch('z', { meta: true }) === false)
check('root renderer call leaves no renderer', renderers.render('root/leak', {}) === undefined)
check('root theme call leaves no contribution', themes.getSnapshot().length === 0 && themes.resolve('root:leak') === undefined)
check('root dialog call leaves no queue entry', dialogs.getSnapshot() === null && (await rootDialog) === false)
check('root scene registration is rejected', rootSceneRejected)
check('root settings registration is rejected', rootSettingsRejected)
check('root workspace registration is rejected', rootWorkspaceRejected)
check('root command-tree registration is rejected', rootTreeRejected)
check('root inject cannot create a child activation', rootChildRejected)
check('root registry deletion is rejected', rootRegistryRejected)
await rootProbe.dispose()

// A traceable service proxy can be copied into another Cordis composition.
// The receiving composition must not be able to use that proxy to mutate the
// host registry or bind cleanup to its own fiber; otherwise an effect survives
// the plugin that initiated the call.
const foreignRoot = new Context()
let foreignDialog: Promise<boolean> | undefined
let foreignSceneRejected = false
let foreignSettingsRejected = false
let foreignWorkspaceRejected = false
let foreignTreeRejected = false
let foreignRootRejected = false
const foreignFiber = foreignRoot.plugin({
  name: 'foreign-composition',
  apply: (foreignCtx) => {
    try {
      root.inject([], () => {})
    } catch {
      foreignRootRejected = true
    }
    const trace = (name: string): any => foreignCtx.reflect.trace(root.get(name))
    trace('tuiStatus')?.set('foreign-leak', 'must not persist')
    trace('tuiShortcuts')?.register('alt+y', { description: 'foreign leak', handler: () => {} })
    trace('tuiRenderers')?.register('foreign/leak', () => ({ lines: ['must not persist'] }))
    foreignDialog = trace('tuiDialogs')?.confirm({ title: 'must not queue' })
    try {
      trace('tuiScenes')?.register({ id: 'foreign-leak', component: () => null })
    } catch {
      foreignSceneRejected = true
    }
    try {
      trace('tuiSettingsSections')?.register({ ns: 'foreign-leak', title: 'Foreign leak', fields: [] })
    } catch {
      foreignSettingsRejected = true
    }
    try {
      trace('tuiWorkspaces')?.register({
        schemes: ['foreign-leak'],
        list: () => [],
        resolve: () => undefined,
        describe: () => undefined,
      })
    } catch {
      foreignWorkspaceRejected = true
    }
    try {
      trace('tuiCommandTrees')?.register({ root: 'foreign-leak', children: () => [] })
    } catch {
      foreignTreeRejected = true
    }
  },
})
await foreignFiber
check('cross-composition plugin cannot create a child on the host root', foreignRootRejected)
check('cross-composition scene registration is rejected', foreignSceneRejected)
check('cross-composition settings registration is rejected', foreignSettingsRejected)
check('cross-composition workspace registration is rejected', foreignWorkspaceRejected)
check('cross-composition command-tree registration is rejected', foreignTreeRejected)
check('cross-composition proxy cannot leave UI effects',
  status.getSnapshot().length === 0
  && shortcuts.dispatch('y', { meta: true }) === false
  && renderers.render('foreign/leak', {}) === undefined
  && dialogs.getSnapshot() === null
  && (await foreignDialog) === false)
await foreignFiber.dispose()
await foreignRoot.fiber.dispose()

let pluginDialog: Promise<boolean> | undefined
const pluginFiber = root.inject(
  ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiThemes', 'tuiScenes', 'tuiSettingsSections', 'tuiWorkspaces', 'tuiCommandTrees'],
  (pluginCtx) => {
    retainedStatus = pluginCtx.get('tuiStatus')
    retainedThemes = pluginCtx.get('tuiThemes')
    retainedWorkspace = pluginCtx.get('tuiWorkspaces')
    pluginCtx.tuiStatus.set('lifecycle', 'active')
    pluginCtx.tuiShortcuts.register('alt+x', { description: 'lifecycle', handler: () => {} })
    pluginCtx.tuiRenderers.register('lifecycle/note', () => ({ lines: ['active'] }))
    pluginCtx.tuiThemes.register({ name: 'lifecycle:theme', base: 'dark', colors: { claude: '#123456' } })
    pluginCtx.tuiScenes.register({ id: 'lifecycle', component: () => null })
    pluginCtx.tuiScenes.open('lifecycle')
    pluginCtx.tuiSettingsSections.register({ ns: 'lifecycle', title: 'Lifecycle', fields: [] })
    pluginCtx.tuiWorkspaces.register({
      schemes: ['lifecycle'],
      list: () => [],
      resolve: () => undefined,
      describe: () => undefined,
      commands: [{ name: 'lifecycle', description: 'Lifecycle', run: () => ({ kind: 'choices', title: 'Lifecycle', choices: [] }) }],
    })
    pluginCtx.tuiCommandTrees.register({ root: 'lifecycle', children: () => [{ name: 'child', description: 'Child' }] })
    pluginDialog = pluginCtx.tuiDialogs.confirm({ title: 'Dispose me' })
  },
)
await pluginFiber
check('live plugin effects are visible before dispose',
  status.getSnapshot().some(entry => entry.key === 'lifecycle')
  && scenes.active?.id === 'lifecycle'
  && sections.list().some(section => section.ns === 'lifecycle')
  && shortcuts.dispatch('x', { meta: true })
  && renderers.render('lifecycle/note', {})?.lines[0] === 'active'
  && themes.resolve('lifecycle:theme')?.claude === '#123456'
  && themes.getSnapshot().some(entry => entry.name === 'lifecycle:theme')
  && workspaces.commands().some(command => command.name === 'lifecycle') === true
  && commandTrees.children(['lifecycle']).length === 1
  && dialogs.getSnapshot()?.kind === 'confirm')

// Provider commands are activation-owned. A second plugin can use its own
// workspace facade, but it must not discover or invoke the first plugin's
// command contribution.
const foreignWorkspaceFiber = root.inject(['tuiWorkspaces'], (pluginCtx) => {
  foreignWorkspaceCommands = pluginCtx.tuiWorkspaces.commands()
  foreignWorkspaceRun = pluginCtx.tuiWorkspaces.runCommand('lifecycle', '', process.cwd())
})
await foreignWorkspaceFiber
check('foreign plugin cannot discover another activation workspace commands', foreignWorkspaceCommands?.some(command => command.name === 'lifecycle') !== true)
check('foreign plugin cannot invoke another activation workspace command', (await foreignWorkspaceRun) === undefined)
await foreignWorkspaceFiber.dispose()

// Command-tree completion is also activation-owned. The TUI reads the
// host-only facade; a plugin may inspect only its own tree metadata.
const foreignTreeFiber = root.inject(['tuiCommandTrees'], (pluginCtx) => {
  foreignTreeChildren = pluginCtx.tuiCommandTrees.children(['lifecycle'])
  foreignTreeDescription = pluginCtx.tuiCommandTrees.descriptions('lifecycle')
})
await foreignTreeFiber
check('foreign plugin cannot discover another activation command-tree children', foreignTreeChildren?.length === 0)
check('foreign plugin cannot discover another activation command-tree description', foreignTreeDescription === undefined)
await foreignTreeFiber.dispose()

const foreignSceneFiber = root.inject(['tuiScenes'], (pluginCtx) => {
  foreignSceneActive = pluginCtx.tuiScenes.active
  foreignSceneOpened = pluginCtx.tuiScenes.open('lifecycle')
  pluginCtx.tuiScenes.close()
})
await foreignSceneFiber
check('foreign plugin cannot inspect another activation scene', foreignSceneActive === undefined)
check('foreign plugin cannot open another activation scene', foreignSceneOpened === false && scenes.active?.id === 'lifecycle')
check('foreign plugin cannot close another activation scene', scenes.active?.id === 'lifecycle')
await foreignSceneFiber.dispose()

const foreignStatusFiber = root.inject(['tuiStatus'], (pluginCtx) => {
  pluginCtx.tuiStatus.set('lifecycle', 'foreign')
})
await foreignStatusFiber
check('foreign plugin cannot overwrite another activation status',
  status.getSnapshot().find(entry => entry.key === 'lifecycle')?.text === 'active')
await foreignStatusFiber.dispose()

await pluginFiber.dispose()
check('plugin dialog is cancelled on its fiber dispose', (await pluginDialog) === false)
retainedStatus?.set('retained-after-dispose', 'must not persist')
retainedThemes?.register({ name: 'retained:theme', base: 'dark' })
check('fiber dispose releases every registered extension effect',
  status.getSnapshot().length === 0
  && scenes.active === undefined
  && sections.list().length === 0
  && shortcuts.dispatch('x', { meta: true }) === false
  && renderers.render('lifecycle/note', {}) === undefined
  && themes.getSnapshot().length === 0
  && themes.resolve('lifecycle:theme') === undefined
  && themes.resolve('retained:theme') === undefined
  && workspaces.commands().some(command => command.name === 'lifecycle') === false
  && commandTrees.children(['lifecycle']).length === 0
  && dialogs.getSnapshot() === null)

let retainedWorkspaceCommandsRejected = false
let retainedWorkspaceRenameRejected = false
try {
  retainedWorkspace?.commands()
} catch {
  retainedWorkspaceCommandsRejected = true
}
try {
  await retainedWorkspace?.rename(process.cwd(), 'stale')
} catch {
  retainedWorkspaceRenameRejected = true
}
check('retained workspace proxy rejects commands after dispose', retainedWorkspaceCommandsRejected)
check('retained workspace proxy rejects rename after dispose', retainedWorkspaceRenameRejected)

// A plugin can shadow the public `fiber` property with an object that looks
// live, or mutate the real fiber's effect method. Caller authentication must
// use the Cordis-published identity and the captured host effect, not either
// writable surface.
let forgedDialog: Promise<boolean> | undefined
let forgedSceneRejected = false
let forgedSettingsRejected = false
let forgedWorkspaceRejected = false
let forgedTreeRejected = false
const forgedFiber = root.inject(
  ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiScenes', 'tuiSettingsSections', 'tuiWorkspaces', 'tuiCommandTrees'],
  (pluginCtx) => {
    const fakeFiber = { uid: 999, state: 2, runtime: null, ctx: root, effect: (execute: () => unknown) => execute() }
    const forged = pluginCtx.extend({ fiber: fakeFiber })
    forged.get('tuiStatus')?.set('forged', 'must not persist')
    forged.get('tuiShortcuts')?.register('alt+f', { description: 'forged', handler: () => {} })
    forged.get('tuiRenderers')?.register('forged/leak', () => ({ lines: ['must not persist'] }))
    forgedDialog = forged.get('tuiDialogs')?.confirm({ title: 'must not queue' })
    try {
      forged.get('tuiScenes')?.register({ id: 'forged-leak', component: () => null })
    } catch {
      forgedSceneRejected = true
    }
    try {
      forged.get('tuiSettingsSections')?.register({ ns: 'forged-leak', title: 'Forged', fields: [] })
    } catch {
      forgedSettingsRejected = true
    }
    try {
      forged.get('tuiWorkspaces')?.register({ schemes: ['forged-leak'], list: () => [], resolve: () => undefined, describe: () => undefined })
    } catch {
      forgedWorkspaceRejected = true
    }
    try {
      forged.get('tuiCommandTrees')?.register({ root: 'forged-leak', children: () => [] })
    } catch {
      forgedTreeRejected = true
    }
  },
)
await forgedFiber
check('forged caller leaves no status', status.getSnapshot().length === 0)
check('forged caller leaves no shortcut', shortcuts.dispatch('f', { alt: true, meta: true }) === false)
check('forged caller leaves no renderer', renderers.render('forged/leak', {}) === undefined)
check('forged caller leaves no dialog', dialogs.getSnapshot() === null && (await forgedDialog) === false)
check('forged scene caller is rejected', forgedSceneRejected)
check('forged settings caller is rejected', forgedSettingsRejected)
check('forged workspace caller is rejected', forgedWorkspaceRejected)
check('forged command-tree caller is rejected', forgedTreeRejected)
await forgedFiber.dispose()

let fakeEventStatus: any
const fakeEventFiber = root.inject(['tuiStatus'], (pluginCtx) => {
  const fakeFiber: any = { uid: 999, state: 2, runtime: null, ctx: undefined, effect: (execute: () => unknown) => execute() }
  const fakeContext = pluginCtx.extend({ fiber: fakeFiber })
  fakeFiber.ctx = fakeContext
  pluginCtx.emit('internal/plugin', fakeFiber)
  fakeEventStatus = fakeContext.reflect.trace(root.get('tuiStatus'))?.set('fake-event', 'must not persist')
})
await fakeEventFiber
check('forged internal/plugin event leaves no status', status.getSnapshot().every(entry => entry.key !== 'fake-event'))
await fakeEventFiber.dispose()

const mutatedContextFiber = root.inject(['tuiStatus'], (pluginCtx) => {
  const canonical = pluginCtx.fiber.ctx
  pluginCtx.fiber.ctx = root
  pluginCtx.tuiStatus.set('mutated-context', 'must not persist')
  pluginCtx.fiber.ctx = canonical
})
await mutatedContextFiber
check('mutated Fiber.ctx leaves no status', status.getSnapshot().every(entry => entry.key !== 'mutated-context'))
await mutatedContextFiber.dispose()

// `Fiber.restart()` invalidates effects before its public wrapper settles. A
// retained context must not register into the next activation during that
// unload window.
let restartContext: Context | undefined
let restartRuns = 0
const restartFiber = root.inject(['tuiStatus'], (pluginCtx) => {
  restartContext = pluginCtx
  restartRuns += 1
  if (restartRuns === 1) {
    pluginCtx.tuiStatus.set('restart-normal', 'first')
    const staleContext = pluginCtx
    setTimeout(() => staleContext.tuiStatus.set('restart-stale-timer', 'stale'), 80)
  }
  else pluginCtx.tuiStatus.set('restart-normal-2', 'second')
})
await restartFiber
const restart = restartFiber.restart()
for (let index = 0; index < 8; index += 1) {
  await Promise.resolve()
  restartContext?.tuiStatus.set(`restart-late-${index}`, 'stale')
}
await restart
check('restart window rejects retained caller effects',
  status.getSnapshot().some(entry => entry.key === 'restart-normal-2')
  && !status.getSnapshot().some(entry => entry.key.startsWith('restart-late-')))
await new Promise(resolve => setTimeout(resolve, 120))
check('old async callback after restart cannot write', !status.getSnapshot().some(entry => entry.key === 'restart-stale-timer'))
await restartFiber.dispose()

// Capturing the original fiber effect also prevents a plugin from replacing
// `ctx.fiber.effect` with a no-op and escaping teardown.
const effectFiber = root.inject(['tuiStatus'], (pluginCtx) => {
  pluginCtx.fiber.effect = (() => undefined) as typeof pluginCtx.fiber.effect
  pluginCtx.tuiStatus.set('effect-overwrite', 'must clear')
})
await effectFiber
await effectFiber.dispose()
check('overwritten fiber.effect cannot retain a contribution', !status.getSnapshot().some(entry => entry.key === 'effect-overwrite'))

await root.fiber.dispose()
if (failures > 0) {
  console.error(`plugin lifecycle battery FAILED (${failures}/${checks})`)
  process.exit(1)
}
console.log(`plugin lifecycle battery OK (${checks} checks)`)
