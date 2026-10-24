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
/** The host's durable workspace ledger, faked in memory. It is mounted BEFORE
 *  the workspace runtime so `ctx.get('workspaceRegistry')` resolves from the
 *  composition root the runtime captured. */
const ledger = new Map<string, { id: unknown; path: string; title: string }>([
  ['victim', { id: 'w-victim', path: process.cwd(), title: 'Victim' }],
  // A registration whose path one activation's own provider vouches for. It
  // exists so the ownership rule can be shown to ALLOW a legitimate caller
  // rather than only to refuse everyone.
  ['owned', { id: 'w-owned', path: 'owned://workspace', title: 'Owned' }],
])
let registryCreateCalls = 0
/** The host's durable workspace ledger, faked in memory. It is provided BEFORE
 *  the workspace runtime so `ctx.get('workspaceRegistry')` resolves from the
 *  composition root that runtime captured. */
root.provide('workspaceRegistry', {
  list: () => [...ledger.values()],
  create: (path: string) => {
    registryCreateCalls += 1
    const record = { id: `w-${ledger.size}`, path, title: path }
    ledger.set(String(record.id), record)
    return record
  },
  delete: (id: unknown) => {
    for (const [key, record] of ledger) {
      if (record.id === id) return ledger.delete(key)
    }
    return false
  },
})
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
    rootCtx.get('tuiStatus')?.registerView({ key: 'root-view-leak', component: () => null })
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
check('root rich-status call leaves no contribution', status.getViewSnapshot().length === 0)
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
    trace('tuiStatus')?.registerView({ key: 'foreign-view-leak', component: () => null })
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
  && status.getViewSnapshot().length === 0
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
    pluginCtx.tuiStatus.registerView({ key: 'lifecycle-view', maxRows: 2, component: () => null })
    pluginCtx.tuiShortcuts.register('alt+x', { description: 'lifecycle', handler: () => {} })
    pluginCtx.tuiRenderers.register('lifecycle/note', () => ({ lines: ['active'] }))
    pluginCtx.tuiThemes.register({ name: 'lifecycle:theme', base: 'dark', colors: { accent: '#123456' } })
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
  && status.getViewSnapshot().some(entry => entry.key === 'lifecycle-view' && entry.maxRows === 2)
  && scenes.active?.id === 'lifecycle'
  && sections.list().some(section => section.ns === 'lifecycle')
  && shortcuts.dispatch('x', { meta: true })
  && renderers.render('lifecycle/note', {})?.lines[0] === 'active'
  && themes.resolve('lifecycle:theme')?.accent === '#123456'
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
  pluginCtx.tuiStatus.registerView({ key: 'lifecycle-view', component: () => null })
})
await foreignStatusFiber
check('foreign plugin cannot overwrite another activation status',
  status.getSnapshot().find(entry => entry.key === 'lifecycle')?.text === 'active')
check('foreign plugin cannot overwrite another activation rich status',
  status.getViewSnapshot().find(entry => entry.key === 'lifecycle-view')?.maxRows === 2)
await foreignStatusFiber.dispose()

await pluginFiber.dispose()
check('plugin dialog is cancelled on its fiber dispose', (await pluginDialog) === false)
retainedStatus?.set('retained-after-dispose', 'must not persist')
retainedThemes?.register({ name: 'retained:theme', base: 'dark' })
check('fiber dispose releases every registered extension effect',
  status.getSnapshot().length === 0
  && status.getViewSnapshot().length === 0
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

// ── the durable workspace ledger is host-owned ─────────────────────────────
//
// `remove`/`create` reach the HOST's workspace registry, so they are bound by
// the same caller discipline as `rename`: a live non-root activation, and (for
// `remove`) a cwd one of that activation's OWN providers vouches for. Without
// it, any plugin — including one whose fiber was already disposed and whose
// caller context is a retained handle — could drop a host registration. Shadow
// policy is not caller authentication.

// A plugin calling the PLUGIN-facing entry with a cwd it does not own must be
// refused: the ledger entry is the host's, and no provider of the caller's
// vouches for the path. This runs on the real Cordis plugin proxy (the same
// path a third-party plugin takes), against a live in-memory registry, and it
// asserts BOTH halves: the rejection AND that the ledger file was not touched.
let foreignRemoveOutcome = 'no-error'
const foreignLedgerFiber = root.inject(['tuiWorkspaces'], async (pluginCtx) => {
  try {
    await pluginCtx.tuiWorkspaces.remove(process.cwd())
  } catch (error) {
    foreignRemoveOutcome = error instanceof Error ? error.message : String(error)
  }
})
await foreignLedgerFiber
await foreignLedgerFiber.dispose()
check('a foreign activation cannot remove a host workspace registration',
  foreignRemoveOutcome.includes('not owned by the calling activation'), foreignRemoveOutcome)
check('the refused removal left every registration in place',
  ledger.has('victim') && ledger.has('owned'))

let retainedLedgerHandle: { remove(cwd: string): Promise<boolean> } | undefined
const ledgerPluginFiber = root.inject(['tuiWorkspaces'], (pluginCtx) => {
  retainedLedgerHandle = pluginCtx.get('tuiWorkspaces') as typeof retainedLedgerHandle
})
await ledgerPluginFiber
await ledgerPluginFiber.dispose()
let retainedRemoveOutcome = 'no-error'
try {
  await retainedLedgerHandle?.remove(process.cwd())
} catch (error) {
  retainedRemoveOutcome = error instanceof Error ? error.message : String(error)
}
check('a retained handle cannot remove a registration after its fiber is disposed',
  retainedRemoveOutcome !== 'no-error', retainedRemoveOutcome)
check('the retained-handle removal wrote nothing', ledger.has('victim') && ledger.has('owned'))

// The same call from an activation that DOES own the cwd is allowed: the rule
// is ownership, not "plugins may never remove". This is what shows the refusal
// above comes from the ownership test rather than from a blanket ban.
let ownedRemoveOutcome = 'no-error'
const ownerPluginFiber = root.inject(['tuiWorkspaces'], async (pluginCtx) => {
  pluginCtx.tuiWorkspaces.register({
    schemes: ['owned'],
    list: () => [],
    resolve: () => undefined,
    describe: (cwd: string) => (cwd === 'owned://workspace' ? { uri: cwd, cwd, label: 'Owned', kind: 'local' } : undefined),
  })
  try {
    await pluginCtx.tuiWorkspaces.remove('owned://workspace')
  } catch (error) {
    ownedRemoveOutcome = error instanceof Error ? error.message : String(error)
  }
})
await ownerPluginFiber
check('an owning activation keeps the ledger path working',
  ownedRemoveOutcome === 'no-error' && !ledger.has('owned'), ownedRemoveOutcome)
await ownerPluginFiber.dispose()

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
    forged.get('tuiStatus')?.registerView({ key: 'forged-view', component: () => null })
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
check('forged caller leaves no rich status', status.getViewSnapshot().length === 0)
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

// The package's own entry defers the root-capability guard while it mounts
// and arms it for the profile's composition: the first TUI row (a plugin
// activation reaching host code) installs it, as on the profile path.
{
  const { armRootCapabilityGuard, compositionRoot, deferRootCapabilityGuard } = await import('../src/dsh-adapter/host-access.js')
  const entryRoot = new Context()
  const release = deferRootCapabilityGuard(entryRoot)
  compositionRoot(entryRoot)
  const tryRoot = (ctx: Context): string => {
    try {
      ;(ctx.root.plugin({ name: 'smuggled', apply() {} }) as unknown as { dispose(): unknown }).dispose()
      return 'allowed'
    } catch (error) {
      return error instanceof Error && error.message.includes('unavailable from a plugin activation') ? 'denied' : String(error)
    }
  }
  const results: Record<string, string> = {}
  await entryRoot.plugin({ name: 'mount-time', apply(ctx: Context) { compositionRoot(ctx); results.mount = tryRoot(ctx) } })
  armRootCapabilityGuard(entryRoot)
  await entryRoot.plugin({ name: 'dsh-row', apply(ctx: Context) { results.dsh = tryRoot(ctx) } })
  check('deferred guard: unarmed host-code activations do not install it', results.mount === 'allowed', JSON.stringify(results))
  check('armed guard: a row before the first TUI row keeps root capabilities', results.dsh === 'allowed', JSON.stringify(results))
  results.host = tryRoot(entryRoot)
  check('armed guard: host code on the root does not install it', results.host === 'allowed', JSON.stringify(results))
  await entryRoot.plugin({ name: 'tui-row', apply(ctx: Context) { compositionRoot(ctx) } })
  await entryRoot.plugin({ name: 'third-party', apply(ctx: Context) { results.third = tryRoot(ctx) } })
  check('armed guard: the first TUI row installs it for every later row', results.third === 'denied', JSON.stringify(results))
  release()
  check('host code still uses the root after the guard is installed', tryRoot(entryRoot) === 'allowed')
  await entryRoot.fiber.dispose()
}

// #1616: profile rows activate concurrently. A dsh-base row can still be
// inside apply() when the first TUI row installs the guard; when it resumes,
// its verified official registration must still work — while generic root
// capabilities stay refused. The seam is dsh-typert-protocol's `invocation`
// accessor, which the first Remote service registers on the root ("where it
// outlives any one Service"); the host installs that root-owned property with
// the guard rather than admitting the activation.
{
  const { armRootCapabilityGuard, compositionRoot, deferRootCapabilityGuard } = await import('../src/dsh-adapter/host-access.js')
  const { default: UserQuestionService } = await import('@deepseek-ai/dsh-user-questions')
  const denied = (error: unknown): string =>
    error instanceof Error && error.message.includes('unavailable from a plugin activation') ? 'denied' : String(error)

  const entryRoot = new Context()
  const release = deferRootCapabilityGuard(entryRoot)
  armRootCapabilityGuard(entryRoot)
  const props = entryRoot.reflect.props
  const outcome: Record<string, string> = {}
  let markCoreEntered = (): void => {}
  const coreEntered = new Promise<void>(resolve => { markCoreEntered = () => resolve() })
  let resumeCore = (): void => {}
  const coreGate = new Promise<void>(resolve => { resumeCore = () => resolve() })
  const coreFiber = entryRoot.plugin({
    name: 'core-slow',
    async apply(ctx: Context) {
      markCoreEntered()
      await coreGate
      try {
        ctx.root.effect(() => {})
        outcome.generic = 'allowed'
      } catch (error) {
        outcome.generic = denied(error)
      }
      try {
        ;(ctx.root as unknown as { accessor(name: string, options: unknown): unknown }).accessor('coreProbe', { get: () => undefined })
        outcome.accessor = 'allowed'
      } catch (error) {
        outcome.accessor = denied(error)
      }
      try {
        await ctx.plugin(UserQuestionService)
        outcome.official = 'allowed'
      } catch (error) {
        outcome.official = error instanceof Error ? error.message : String(error)
      }
    },
  })
  await coreEntered
  await entryRoot.plugin({ name: 'tui-row', apply(ctx: Context) { compositionRoot(ctx) } })
  const accessorAtGuard = Object.hasOwn(props, 'invocation')
    && (entryRoot as unknown as { invocation?: unknown }).invocation === undefined
  resumeCore()
  await coreFiber
  check('slow core row: generic root capability stays refused', outcome.generic === 'denied', String(outcome.generic))
  check('slow core row: root accessor registration stays refused', outcome.accessor === 'denied', String(outcome.accessor))
  check('slow core row: the official Remote service still activates', outcome.official === 'allowed', String(outcome.official))
  check('the guard installs the root-owned invocation accessor', accessorAtGuard)
  check('the admitted official service is live', entryRoot.get('userQuestions') !== undefined)
  await coreFiber.dispose()
  check('unloading the row drops its service and keeps the root accessor',
    entryRoot.get('userQuestions') === undefined && Object.hasOwn(props, 'invocation'))
  release()
  await entryRoot.fiber.dispose()
  check('root dispose drops the root-owned accessor', !Object.hasOwn(props, 'invocation'))
}

// A third-party Remote service is no different: the accessor is root state, so
// it constructs behind the guard, reloads once, and its own service follows its
// row. Nothing of the row's survives with the accessor.
{
  const { armRootCapabilityGuard, compositionRoot, deferRootCapabilityGuard } = await import('../src/dsh-adapter/host-access.js')
  const { TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol')
  const entryRoot = new Context()
  const release = deferRootCapabilityGuard(entryRoot)
  armRootCapabilityGuard(entryRoot)
  await entryRoot.plugin({ name: 'tui-row', apply(ctx: Context) { compositionRoot(ctx) } })
  class LateRemoteService extends TypertRemoteService {
    constructor(ctx: Context) { super(ctx, 'lateRemoteProbe') }
  }
  const row = entryRoot.plugin({
    name: 'late-row',
    apply(ctx: Context) { ctx.plugin(LateRemoteService) },
  }, { generation: 1 })
  await row
  check('a later Remote service activates behind the guard', entryRoot.get('lateRemoteProbe') !== undefined)
  row.update({ generation: 2 })
  await new Promise(resolve => setTimeout(resolve, 20))
  check('a reload holds one service and one root accessor',
    entryRoot.get('lateRemoteProbe') !== undefined && Object.hasOwn(entryRoot.reflect.props, 'invocation'))
  await row.dispose()
  check('its service goes with the row while the root accessor stays',
    entryRoot.get('lateRemoteProbe') === undefined && Object.hasOwn(entryRoot.reflect.props, 'invocation'))
  release()
  await entryRoot.fiber.dispose()
}

// Failure and cancellation: the root-owned accessor is not the activation's to
// roll back, and neither leaves a service behind.
{
  const { armRootCapabilityGuard, compositionRoot, deferRootCapabilityGuard } = await import('../src/dsh-adapter/host-access.js')
  const { default: UserQuestionService } = await import('@deepseek-ai/dsh-user-questions')
  const entryRoot = new Context()
  const release = deferRootCapabilityGuard(entryRoot)
  armRootCapabilityGuard(entryRoot)
  await entryRoot.plugin({ name: 'tui-row', apply(ctx: Context) { compositionRoot(ctx) } })
  const failing = entryRoot.plugin({
    name: 'failing-row',
    async apply(ctx: Context) {
      await ctx.plugin(UserQuestionService)
      throw new Error('activation failed after the official registration')
    },
  })
  await Promise.resolve(failing).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  check('a failed activation leaves no service behind', entryRoot.get('userQuestions') === undefined)
  check('a failed activation keeps the root-owned accessor', Object.hasOwn(entryRoot.reflect.props, 'invocation'))
  await failing.dispose()

  let markEntered = (): void => {}
  const entered = new Promise<void>(resolve => { markEntered = () => resolve() })
  let resume = (): void => {}
  const gate = new Promise<void>(resolve => { resume = () => resolve() })
  const cancelled = entryRoot.plugin({
    name: 'cancelled-row',
    async apply(ctx: Context) {
      markEntered()
      await gate
      await ctx.plugin(UserQuestionService)
    },
  })
  await entered
  const disposing = cancelled.dispose()
  resume()
  await disposing.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  check('a cancelled activation registers nothing', entryRoot.get('userQuestions') === undefined)
  release()
  await entryRoot.fiber.dispose()
}

// The entry's backend assembly resolves the composition root before the kernel
// is chosen. It must run inside the deferral: a root first seen undeferred is
// guarded for good, and DSH 0.2.0-rc.2's first Remote service then fails on
// `ctx.root.accessor('invocation')` (a root effect) in its own activation.
// The root reads a profile that lists one installed bundle, so the assembly
// reaches `compositionLoader` (and the composition root) rather than returning
// early; the undeferred control shows the check can fail.
{
  const { armRootCapabilityGuard, deferRootCapabilityGuard } = await import('../src/dsh-adapter/host-access.js')
  const { assembleBackendsFromProfile } = await import('../src/dsh-adapter/backend-assembly.js')
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-tui-lifecycle-profile-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['example-backend-bundle'] } } }))
  const rowAfterAssembly = async (deferred: boolean): Promise<string> => {
    const entryRoot = new Context()
    ;(entryRoot as { baseUrl?: string }).baseUrl = pathToFileURL(profileDir).href + '/'
    const release = deferred ? deferRootCapabilityGuard(entryRoot) : undefined
    try {
      const assembled = assembleBackendsFromProfile(entryRoot)
      if (assembled.scanned.length !== 1) return `assembly scanned ${assembled.scanned.length} bundle(s)`
      armRootCapabilityGuard(entryRoot)
      let result = 'allowed'
      await entryRoot.plugin({ name: 'dsh-remote-row', apply(ctx: Context) {
        try { ctx.root.accessor('invocation', { get: () => undefined }) } catch (error) { result = error instanceof Error ? error.message : String(error) }
      } })
      return result
    } finally {
      release?.()
      await entryRoot.fiber.dispose()
    }
  }
  try {
    const undeferred = await rowAfterAssembly(false)
    check('undeferred backend assembly guards the root for good (control)', undeferred.endsWith('is unavailable from a plugin activation'), undeferred)
    const deferred = await rowAfterAssembly(true)
    check('deferred guard: backend assembly leaves DSH rows their root effects', deferred === 'allowed', deferred)
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }

  // The order inside `runInEntry` is not reachable without a host dsh: read it
  // from the syntax tree. The defer is the statement right after `ctx` is
  // bound, so nothing (whatever it is called) can resolve the composition root
  // first; comments and other functions' text cannot stand in for it.
  const { default: ts } = await import('typescript')
  const entryPath = new URL('../src/dsh-adapter/host-entry.ts', import.meta.url)
  const source = ts.createSourceFile(entryPath.pathname, readFileSync(entryPath, 'utf8'), ts.ScriptTarget.Latest, true)
  const runInEntry = source.statements.find((node): node is import('typescript').FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'runInEntry')
  const statements = runInEntry?.body?.statements ?? ts.factory.createNodeArray()
  const bindsCtx = (statement: import('typescript').Statement): boolean => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'ctx')
  const ctxAt = statements.findIndex(bindsCtx)
  const next = statements[ctxAt + 1]
  // The call counts only where a host root reaches it: a conditional expression
  // or `if` on `root` only on its root-present branch; other conditionals'
  // branches, the right of a short circuit and deferred functions not at all.
  const rootPresentWhen = (condition: import('typescript').Expression): boolean | undefined => {
    if (!ts.isBinaryExpression(condition) || !ts.isIdentifier(condition.left) || condition.left.text !== 'root'
      || !ts.isIdentifier(condition.right) || condition.right.text !== 'undefined') return undefined
    if (condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return false
    if (condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true
    return undefined
  }
  const shortCircuits = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken])
  let defers = false
  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'deferRootCapabilityGuard'
      && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0]!) && node.arguments[0].text === 'ctx') defers = true
    else if (ts.isConditionalExpression(node)) {
      const present = rootPresentWhen(node.condition)
      if (present !== undefined) visit(present ? node.whenTrue : node.whenFalse)
    } else if (ts.isIfStatement(node)) {
      const present = rootPresentWhen(node.expression)
      if (present !== undefined) {
        const branch = present ? node.thenStatement : node.elseStatement
        if (branch !== undefined) visit(branch)
      }
    } else if (ts.isBinaryExpression(node) && shortCircuits.has(node.operatorToken.kind)) visit(node.left)
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit)
  }
  if (ctxAt !== -1 && next !== undefined) visit(next)
  check('host entry defers the root guard right after binding its root', defers,
    ctxAt === -1 ? 'no `ctx` binding in runInEntry' : next?.getText(source) ?? 'nothing after the binding')
}

// DSH's agent-team service registers its projection through
// `ctx.root.sessionProjections`. Behind the installed guard that call rides
// the calling plugin's fiber (unloading it drops the key), while the root's
// own effect stays refused. Real registry, mounted before the guard (the
// profile's base row, the usual order) and after it.
for (const order of ['registry first', 'guard first'] as const) {
  const { armRootCapabilityGuard, compositionRoot, concreteService, deferRootCapabilityGuard } = await import('../src/dsh-adapter/host-access.js')
  const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
  const teamRoot = new Context()
  const release = deferRootCapabilityGuard(teamRoot)
  compositionRoot(teamRoot)
  armRootCapabilityGuard(teamRoot)
  if (order === 'registry first') await teamRoot.plugin(SessionProjectionRegistry)
  await teamRoot.plugin({ name: 'tui-row', apply(ctx: Context) { compositionRoot(ctx) } })
  release()
  if (order === 'guard first') await teamRoot.plugin(SessionProjectionRegistry)
  const definition = { key: 'agentTeamProbe', stateSchema: {}, init: () => 0, apply: (state: number) => state, stateVersion: 0 }
  const registry = concreteService((teamRoot as unknown as { sessionProjections: object }).sessionProjections) as { registrations: Map<string, unknown> }
  const outcome: Record<string, string> = {}
  const teamFiber = teamRoot.plugin({
    name: 'agent-team',
    apply(ctx: Context) {
      try {
        // No outer effect: only the caller's fiber can drop the key on unload.
        ;(ctx.root as unknown as { sessionProjections: { register(def: unknown): () => void } }).sessionProjections.register(definition)
        outcome.register = 'allowed'
      } catch (error) {
        outcome.register = error instanceof Error ? error.message : String(error)
      }
      try {
        ctx.root.effect(() => () => {})
        outcome.rootEffect = 'allowed'
      } catch (error) {
        outcome.rootEffect = error instanceof Error && error.message.includes('unavailable from a plugin activation') ? 'denied' : String(error)
      }
    },
  })
  await teamFiber
  check(`${order}: root projection registration from a plugin is admitted`, outcome.register === 'allowed', JSON.stringify(outcome))
  check(`${order}: admitted projection registration is live`, registry.registrations.has('agentTeamProbe'))
  check(`${order}: root.effect itself stays refused to the plugin`, outcome.rootEffect === 'denied', JSON.stringify(outcome))
  await teamFiber.dispose()
  check(`${order}: unloading the plugin drops its projection key`, !registry.registrations.has('agentTeamProbe'))

  // TeamService's own shape: the registration inside an outer effect whose
  // async disposer still reads the key before unregistering it. A sibling
  // effect on the plugin's fiber would drop the key mid-teardown.
  const teardown: string[] = []
  const ordered = teamRoot.plugin({
    name: 'agent-team-ordered',
    apply(ctx: Context) {
      ctx.effect(() => {
        const disposeProjection = (ctx.root as unknown as { sessionProjections: { register(def: unknown): () => void } }).sessionProjections.register(definition)
        return async () => {
          try {
            await (async () => {})()
            teardown.push(registry.registrations.has('agentTeamProbe') ? 'present' : 'gone')
          } finally {
            disposeProjection()
          }
        }
      }, 'agentTeams.runtimeLifecycle()')
    },
  })
  await ordered
  await ordered.dispose()
  check(`${order}: the key stays readable through the plugin's async teardown`, teardown.join() === 'present', teardown.join())
  check(`${order}: and goes once that teardown unregisters it`, !registry.registrations.has('agentTeamProbe'))

  // A reload releases the old registration before the new one lands.
  const reloading = teamRoot.plugin({
    name: 'agent-team-reload',
    apply(ctx: Context) {
      ;(ctx.root as unknown as { sessionProjections: { register(def: unknown): () => void } }).sessionProjections.register(definition)
    },
  }, { generation: 1 })
  await reloading
  reloading.update({ generation: 2 })
  await new Promise(resolve => setTimeout(resolve, 20))
  const refs = (registry.registrations.get('agentTeamProbe') as { refs?: number } | undefined)?.refs
  check(`${order}: a reload holds one registration, not two`, refs === 1, String(refs))
  await reloading.dispose()
  check(`${order}: unloading the reloaded plugin drops the key`, !registry.registrations.has('agentTeamProbe'))

  // An activation that throws after registering leaves nothing behind.
  const failing = teamRoot.plugin({
    name: 'agent-team-failing',
    apply(ctx: Context) {
      ;(ctx.root as unknown as { sessionProjections: { register(def: unknown): () => void } }).sessionProjections.register(definition)
      throw new Error('activation failed')
    },
  })
  await Promise.resolve(failing).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  check(`${order}: a failed activation leaves no projection key`, !registry.registrations.has('agentTeamProbe'))
  await failing.dispose()
  await teamRoot.fiber.dispose()
}
if (failures > 0) {
  console.error(`plugin lifecycle battery FAILED (${failures}/${checks})`)
  process.exit(1)
}
console.log(`plugin lifecycle battery OK (${checks} checks)`)
