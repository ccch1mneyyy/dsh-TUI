/**
 * Runtime theme service regression over a real Cordis Context.
 *
 * Covers validation, host-only controls, stable snapshots, activation cleanup,
 * static-file precedence, token-safe resolver cleanup, and no-host fallback.
 * Run: node --import tsx/esm scripts/verify-runtime-themes.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TuiThemeHost } from '../src/dsh-adapter/themes.js'

const home = mkdtempSync(join(tmpdir(), 'dshtui-runtime-theme-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
const themeDir = join(home, '.dsh-tui', 'themes')
mkdirSync(themeDir, { recursive: true })
writeFileSync(
  join(themeDir, 'shared.json'),
  JSON.stringify({
    name: 'shared',
    displayName: 'Static Shared',
    base: 'dark',
    colors: { claude: '#abcdef' },
  }),
)

const { Context } = await import('@deepseek-ai/cordis')
const { TuiThemeRuntime, getHostThemes } = await import('../src/dsh-adapter/themes.js')
const {
  clearRuntimeThemeResolver,
  getTheme,
  isThemeAvailable,
  registerCustomThemeResolver,
  registerRuntimeThemeResolver,
} = await import('../src/theme.js')
const {
  clearCustomThemeCache,
  isThemeAvailable: isStaticThemeAvailable,
  resolveCustomTheme,
} = await import('../src/customTheme.js')
const {
  listThemeCatalog,
  resolveThemeEntry,
  themeNames,
} = await import('../src/themeCatalog.js')

let checks = 0
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

const warnings: string[] = []
const root = new Context()
root.logger.warn = (format: unknown, ...params: unknown[]) => {
  warnings.push([format, ...params].map(String).join(' '))
}
const runtimeFiber = root.plugin(TuiThemeRuntime)
await runtimeFiber

const runtime = root.get('tuiThemes')
const host = getHostThemes(runtime)
if (runtime === undefined || host === undefined) {
  throw new Error('tuiThemes service did not mount')
}
registerCustomThemeResolver(resolveCustomTheme)
clearCustomThemeCache()

const emptySnapshot = host.getSnapshot()
check('host facade resolves and starts empty', emptySnapshot.length === 0)
check('empty snapshot is referentially stable', host.getSnapshot() === emptySnapshot)
check(
  'plugin-facing service exposes no host controls',
  !('getSnapshot' in runtime) && !('resolve' in runtime) && !('subscribe' in runtime),
)

let notifications = 0
const unsubscribe = host.subscribe(() => { notifications += 1 })
let pluginContext: Context | undefined
const pluginFiber = root.plugin({
  name: 'runtime-theme-probe',
  inject: ['tuiThemes'],
  apply: context => {
    pluginContext = context
  },
})
await pluginFiber
if (pluginContext === undefined) throw new Error('theme probe activation did not start')

const validDisposer = pluginContext.tuiThemes.register({
  name: 'probe:valid',
  displayName: 'Valid\nRuntime Theme',
  base: 'dark',
  colors: { claude: '#123456', text: 'rgb(232,230,224)' },
}, pluginContext)
const firstSnapshot = host.getSnapshot()
const firstEntry = firstSnapshot.find(entry => entry.name === 'probe:valid')
check('valid registration appears in the host snapshot', firstEntry !== undefined)
check('registration normalizes and sanitizes display metadata',
  firstEntry?.displayName === 'Valid Runtime Theme' && firstEntry?.name === 'probe:valid')
check('registration snapshot and colors are frozen',
  firstEntry !== undefined && Object.isFrozen(firstEntry) && Object.isFrozen(firstEntry.colors))
check('snapshot stays stable without a mutation', host.getSnapshot() === firstSnapshot)
check('host resolver returns the registered palette', host.resolve('probe:valid')?.claude === '#123456')
check('getTheme consults the runtime resolver', getTheme('probe:valid').claude === '#123456')
check('runtime availability includes the registered name', isThemeAvailable('probe:valid'))
check('static availability remains static-only', !isStaticThemeAvailable('probe:valid'))
const stablePalette = host.resolve('probe:valid')
check('host resolver returns a stable palette identity', stablePalette === host.resolve('probe:valid'))
check('registration emits one host notification', notifications === 1)

const longNameDisposer = pluginContext.tuiThemes.register({
  name: `probe:${'x'.repeat(120)}`,
  base: 'dark',
})
const longEntry = host.getSnapshot().find(entry => entry.name.startsWith('probe:xxx'))
check('default displayName stays within the terminal-cell cap', longEntry !== undefined && longEntry.displayName.length <= 120)
longNameDisposer()

const beforeInvalid = host.getSnapshot()
const invalidDescriptors: unknown[] = [
  { name: 'auto', base: 'dark' },
  { name: 'status', base: 'dark' },
  { name: 'dark', base: 'dark' },
  { name: '../escape', base: 'dark' },
  { name: 'bad\u0000name', base: 'dark' },
  { name: 'too:many:segments', base: 'dark' },
  { name: 'probe:bad-base', base: 'neon' },
  { name: 'probe:bad-color', base: 'dark', colors: { claude: 'hotpink' } },
  { name: 'probe:bad-key', base: 'dark', colors: { notAThemeKey: '#fff' } },
  { name: 'probe:bad-colors', base: 'dark', colors: [] },
]
for (const descriptor of invalidDescriptors) {
  try {
    pluginContext.tuiThemes.register(descriptor as never)
  } catch (error) {
    failures += 1
    console.error(`FAIL invalid registration threw: ${String(error)}`)
  }
}
check('invalid, reserved and unsafe declarations are no-ops', host.getSnapshot() === beforeInvalid)
check('invalid declarations warn without crashing the TUI', warnings.filter(warning => warning.includes('invalid theme descriptor')).length >= invalidDescriptors.length - 1)

const beforeDuplicate = host.getSnapshot()
const duplicateDisposer = pluginContext.tuiThemes.register({
  name: 'PROBE:VALID',
  base: 'light',
  colors: { claude: '#ffffff' },
})
check('duplicate ids are rejected case-insensitively',
  host.getSnapshot() === beforeDuplicate && host.resolve('probe:valid')?.claude === '#123456')
duplicateDisposer()
check('duplicate registration returns an inert disposer', host.getSnapshot() === beforeDuplicate)
check('duplicate registration warns', warnings.some(warning => warning.includes('already registered')))

const ownedDisposer = pluginContext.tuiThemes.register({
  name: 'probe:owned',
  base: 'light',
  colors: { claude: '#654321' },
})
let foreignContext: Context | undefined
const foreignFiber = root.plugin({
  name: 'runtime-theme-foreign',
  inject: ['tuiThemes'],
  apply: context => {
    foreignContext = context
  },
})
await foreignFiber
if (foreignContext === undefined) throw new Error('foreign theme activation did not start')
const foreignDisposer = foreignContext.tuiThemes.register({
  name: 'probe:owned',
  base: 'dark',
  colors: { claude: '#ffffff' },
})
check('a foreign activation cannot replace another owner',
  host.resolve('probe:owned')?.claude === '#654321')
foreignDisposer()
check('a foreign inert disposer cannot release another owner', host.resolve('probe:owned')?.claude === '#654321')
ownedDisposer()
check('the owning disposer releases only its own entry', host.resolve('probe:owned') === undefined)
await foreignFiber.dispose()

const cleanupDisposer = pluginContext.tuiThemes.register({
  name: 'probe:cleanup',
  base: 'dark',
  colors: { claude: '#0f0f0f' },
})
check('activation-owned registration is visible before dispose', host.resolve('probe:cleanup')?.claude === '#0f0f0f')
await pluginFiber.dispose()
check('activation cleanup releases every runtime registration', host.getSnapshot().length === 0)
check('activation cleanup removes the global runtime resolution',
  getTheme('probe:valid') === getTheme('dark') && !isThemeAvailable('probe:valid'))
cleanupDisposer()
unsubscribe()

// Static JSON wins in both the resolver and catalog, while the runtime host
// still retains its own palette and the custom-theme cache stays untouched.
let staticPluginContext: Context | undefined
const staticFiber = root.plugin({
  name: 'runtime-theme-static-probe',
  inject: ['tuiThemes'],
  apply: context => {
    staticPluginContext = context
  },
})
await staticFiber
if (staticPluginContext === undefined) throw new Error('static-priority activation did not start')
const staticPalette = resolveCustomTheme('shared')
const staticDisposer = staticPluginContext.tuiThemes.register({
  name: 'shared',
  displayName: 'Runtime Shared',
  base: 'light',
  colors: { claude: '#112233' },
})
const runtimeOnlyDisposer = staticPluginContext.tuiThemes.register({
  name: 'runtime-only',
  displayName: 'Runtime Only',
  base: 'dark',
  colors: { claude: '#445566' },
})
const earlySortDisposer = staticPluginContext.tuiThemes.register({
  name: 'aaa:theme',
  displayName: 'Early Sort',
  base: 'dark',
  colors: { claude: '#778899' },
})
check('static resolver keeps priority over a same-name runtime theme',
  getTheme('shared').claude === '#abcdef' && host.resolve('shared')?.claude === '#112233')
check('runtime palette is not mixed into static custom-theme cache',
  resolveCustomTheme('shared') === staticPalette && resolveCustomTheme('shared')?.claude === '#abcdef')
const catalog = listThemeCatalog(host)
const sharedEntries = catalog.filter(entry => entry.name === 'shared')
check('catalog orders auto, built-ins, static, then runtime',
  catalog[0]?.source === 'auto'
  && catalog.slice(1, 4).every(entry => entry.source === 'builtin')
  && sharedEntries.length === 1
  && sharedEntries[0]?.source === 'static'
  && catalog.find(entry => entry.name === 'runtime-only')?.source === 'runtime')
check('catalog names are deduplicated with static precedence',
  themeNames(host).filter(name => name === 'shared').length === 1
  && resolveThemeEntry('shared', host)?.source === 'static')
check('runtime catalog entries sort by stable theme id',
  catalog.filter(entry => entry.source === 'runtime').map(entry => entry.name).join(',') === 'aaa:theme,runtime-only')
check('catalog resolves a distinct runtime name',
  resolveThemeEntry('runtime-only', host)?.source === 'runtime'
  && resolveThemeEntry('runtime-only', host)?.theme.claude === '#445566')
earlySortDisposer()
runtimeOnlyDisposer()
staticDisposer()
await staticFiber.dispose()

// Token-safe resolver cleanup: an old disposer cannot clear a newer resolver.
const firstCleanup = registerRuntimeThemeResolver(() => ({ ...getTheme('dark'), claude: '#111111' }))
const secondCleanup = registerRuntimeThemeResolver(() => ({ ...getTheme('dark'), claude: '#222222' }))
firstCleanup()
check('stale runtime resolver cleanup is token-safe', getTheme('token-probe').claude === '#222222')
secondCleanup()
const baseCleanup = registerRuntimeThemeResolver(() => ({ ...getTheme('dark'), claude: '#333333' }))
const nestedCleanup = registerRuntimeThemeResolver(() => ({ ...getTheme('dark'), claude: '#444444' }))
nestedCleanup()
check('nested resolver cleanup restores the previous resolver', getTheme('token-probe').claude === '#333333')
baseCleanup()
clearRuntimeThemeResolver()
check('latest runtime resolver cleanup restores dark fallback', getTheme('token-probe') === getTheme('dark'))

const noHostRoot = new Context()
check('no-host accessor falls back cleanly', getHostThemes(noHostRoot.get('tuiThemes')) === undefined)
check('no-host catalog contains no runtime entries', listThemeCatalog().every(entry => entry.source !== 'runtime'))
check('no-host resolution falls back to unknown', resolveThemeEntry('probe:valid') === undefined)

// A structural host may violate the typed contract; non-array snapshots must
// degrade to zero runtime entries instead of throwing inside catalog build.
const nullSnapshotHost = {
  getSnapshot: () => null,
  resolve: () => undefined,
  subscribe: () => () => {},
} as unknown as TuiThemeHost
check(
  'non-array snapshot degrades to no runtime entries',
  listThemeCatalog(nullSnapshotHost).every(entry => entry.source !== 'runtime'),
)
await root.fiber.dispose()
await noHostRoot.fiber.dispose()
rmSync(home, { recursive: true, force: true })

if (failures > 0) {
  console.error(`runtime theme verification FAILED (${failures}/${checks})`)
  process.exit(1)
}
console.log(`runtime theme verification OK (${checks} checks)`)
