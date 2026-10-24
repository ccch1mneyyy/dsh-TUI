/**
 * Generated /settings pages over the host's plugin Config forms
 * (src/dsh-adapter/plugin-config.ts).
 *
 * Drives the real Loader + real `@deepseek-ai/dsh-settings` (`ctx.settings`)
 * with an in-memory config editor that mirrors the host's (complete-config
 * validation via `resolveConfig`, profile-layer override, Loader update), the
 * real DSH channel and the real terminal screen. Pins:
 * - schema → field mapping: boolean / number (min/max/step) / string /
 *   textarea (escaped single line) / union of literals → select (string and
 *   non-string literals) / one nested object level → inline group with dotted
 *   paths / deeper object, array, secret → read-only rows / hidden fields
 *   skipped / non-volatile keys only named in a read-only "other fields" row;
 * - saving writes through `settings.mutate` (revision-fenced), keeps every
 *   ordinary key of the entry config, applies live without a remount, and an
 *   empty text draft unsets back to the inherited value;
 * - failure paths reach the form: client-side range/step refusals, host-side
 *   Config validation, a home-patch overlay refusal; read-only rows never
 *   stage or write; the host itself refuses non-volatile paths;
 * - precedence: registered / curated namespaces, `autoGenerate: false`
 *   (`settings.configure({ auto: false })`), first-party `@deepseek-ai/*`,
 *   this application's rows and `cordis:` builtins get no generated page;
 * - untrusted schemas (garbage, cycles, oversize dicts/unions, ANSI text,
 *   control characters in ids) never throw and stay bounded;
 * - no settings service / a pre-Config-forms host → no pages;
 * - plugin-manager titles arrive asynchronously and re-render the channel;
 * - four terminal layouts (inline/fullscreen × wide/narrow): Enter toggles
 *   through the real service, read-only rows open no editor, secrets and raw
 *   escape sequences never reach the terminal.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-config-settings.tsx
 * (imports TypeScript sources; no build needed).
 */
import './lib/fake-home.mjs'
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [
  { default: assert }, { mkdirSync, mkdtempSync, rmSync, writeFileSync }, { tmpdir }, { join }, { pathToFileURL },
  { PassThrough, Writable }, React, { Terminal }, { render, AlternateScreen },
  { Settings: SettingsScreen }, { settled, sleep, viewportLines },
  { Context, resolveConfig }, { default: Loader }, { default: Settings }, { default: Schema },
  PluginConfig, { SettingsForm, getPath }, { createChannel }, { disposeChannelOwner },
  { createChannelUi, createChannelUiLease },
] = await Promise.all([
  import('node:assert/strict'), import('node:fs'), import('node:os'), import('node:path'), import('node:url'),
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Settings.js'), import('./lib/term-test.mjs'),
  import('@deepseek-ai/cordis'), import('@deepseek-ai/cordis-plugin-loader'), import('@deepseek-ai/dsh-settings'), import('@deepseek-ai/schemastery'),
  import('../src/dsh-adapter/plugin-config.js'), import('../src/dsh-adapter/settingsEditor.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/dsh-adapter/channel/owner.js'),
  import('../src/adapter/channel/ui.js'),
])
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { TuiSettingsField, TuiSettingsSection } from '../src/adapter/ports/channel-settings.js'

const { pluginConfigSections, readSchema, escapeText, unescapeText, modulePackage, isHostOwnedModule, createPluginConfigSource, PLUGIN_CONFIG_LIMITS } = PluginConfig

let checks = 0
function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message)
  checks += 1
}
const fieldAt = (section: TuiSettingsSection | undefined, path: string): TuiSettingsField => {
  const field = section?.fields.find(candidate => candidate.path.join('.') === path)
  assert.ok(field !== undefined, `field ${path} in ${section?.ns}: ${JSON.stringify(section?.fields.map(candidate => candidate.path.join('.')))}`)
  return field
}

// ── A literal dotted key and the nested path it spells never share a draft ─
{
  const writes: unknown[] = []
  const host = {
    listNamespaces: () => [],
    write: async (_ns: string, ops: readonly unknown[]) => { writes.push(...ops) },
    credentialConfigured: async () => false,
    writeCredential: async () => {},
  }
  const view = { ns: 'collide', value: { 'a.b': 1, a: { b: 2 } }, base: {}, user: {}, revision: 1 }
  const literal: TuiSettingsField = { path: ['a.b'], label: 'literal', kind: 'number' }
  const nested: TuiSettingsField = { path: ['a', 'b'], label: 'nested', kind: 'number' }
  const form = new SettingsForm(host as never, view as never, [literal, nested])
  form.edit(literal, '5')
  check(form.field(nested).text === '2', 'editing the literal `a.b` key leaves the nested a → b row untouched')
  check(await form.save(), 'the collision form saves')
  check(JSON.stringify(writes) === JSON.stringify([{ op: 'set', path: ['a.b'], value: 5 }]),
    `only the edited path is written: ${JSON.stringify(writes)}`)
}

// ── Pure mapping over real schemastery envelopes ──────────────────────────
{
  check(escapeText('a\nb\\c\t\u001b[31m\u202e') === 'a\\nb\\\\c\\t\\u001b[31m\\u202e', 'escaped strings are one printable line')
  for (const sample of ['', 'plain', 'line1\nline2\r\n', 'C:\\dir\\n', '\u0000\u0085\u2066x\ufeff', 'tab\there']) {
    check(unescapeText(escapeText(sample)) === sample, `escape round-trips ${JSON.stringify(sample)}`)
  }
  check(unescapeText('\\q stays') === '\\q stays', 'unknown escapes stay literal')
  check(modulePackage('@scope/pkg/sub')?.name === '@scope/pkg' && modulePackage('dsh-context')?.name === 'dsh-context', 'package names from specifiers')
  check(modulePackage('file:///x/plugins/my-plugin/index.mjs')?.name === 'my-plugin' && modulePackage('./local.ts')?.local === true, 'local plugins are named by their directory/file')
  check(modulePackage('cordis:web') === undefined && isHostOwnedModule('cordis:web'), 'cordis builtins are host-owned')
  check(isHostOwnedModule('@deepseek-ai/dsh-agent-loop') && isHostOwnedModule('@deepseek-harness-tui/dsh-tui/settings-sections'), 'first-party and own rows are host-owned')
  check(!isHostOwnedModule('dsh-context') && !isHostOwnedModule('@third/plugin') && !isHostOwnedModule('/abs/@deepseek-ai/x.mjs'), 'third-party and local rows are plugins')
  check(isHostOwnedModule('/usr/lib/node_modules/@deepseek-harness-tui/dsh-tui/lib/index.js')
    && isHostOwnedModule('file:///p/node_modules/@deepseek-ai/dsh-web/lib/index.js')
    && modulePackage('C:\\p\\node_modules\\dsh-context\\lib\\index.js')?.name === 'dsh-context', 'paths into installed packages resolve to the package')

  const live = Schema.object({
    enabled: Schema.boolean().default(true).description({ '': 'Enabled', 'zh-CN': '启用' } as never),
    mode: Schema.union(['a', 'b']).default('a'),
    nums: Schema.union([Schema.const(1).description('One'), Schema.const(true).description('Yes')]).default(1),
    hybrid: Schema.union([Schema.const('x'), Schema.string()]).default('x'),
    big: Schema.union(Array.from({ length: PLUGIN_CONFIG_LIMITS.options + 5 }, (_, index) => `v${index}`)),
    ansi: Schema.string().description('\u001b[31mRed label\u001b[0m'),
    long: Schema.string().description('A description far too long to be a label in a one-line settings row, so the key is used'),
    ['bad\u0007key']: Schema.number(),
    nest: Schema.intersect([Schema.object({ a: Schema.boolean() }), Schema.object({ a: Schema.string(), b: Schema.string() })]),
  })
  const descriptor = (ns: string, schema: unknown, extra: Record<string, unknown> = {}) => ({ ns, autoGenerate: true, schema, value: {}, base: {}, user: {}, revision: 0, applies: 'live', secrets: [], ...extra })
  const entries: Record<string, string> = {
    third: 'third-party-plugin',
    first: '@deepseek-ai/dsh-agent-loop',
    own: '@deepseek-harness-tui/dsh-tui',
    builtin: 'cordis:web',
    claimed: 'other-plugin',
    optout: 'opt-out-plugin',
  }
  const input = (descriptors: readonly unknown[], claimed: string[] = [], lang: 'en' | 'zh' = 'en') => ({
    descriptors,
    claimed: new Set(claimed),
    lang,
    documentPath: '/profiles/x/cordis.patch.yml',
    entry: (ns: string) => entries[ns] === undefined ? undefined : { moduleName: entries[ns]! },
  })
  const sections = pluginConfigSections(input([
    descriptor('third', live.toJSON()),
    descriptor('first', live.toJSON()),
    descriptor('own', live.toJSON()),
    descriptor('builtin', live.toJSON()),
    descriptor('claimed', live.toJSON()),
    descriptor('optout', live.toJSON(), { autoGenerate: false }),
    descriptor('unknown-entry', live.toJSON()),
    descriptor('bad\u001bns', live.toJSON()),
  ], ['claimed']))
  check(sections.length === 1 && sections[0]!.ns === 'third', `only the unclaimed third-party form gets a page: ${sections.map(section => section.ns)}`)
  const third = sections[0]
  check(third?.page?.id === 'plugins', 'generated pages share the Plugins tab')
  check(fieldAt(third, 'enabled').kind === 'boolean' && fieldAt(third, 'enabled').label === 'Enabled', 'i18n description picks the default text in en')
  const zh = pluginConfigSections(input([descriptor('third', live.toJSON())], [], 'zh'))
  check(fieldAt(zh[0], 'enabled').label === '启用', 'zh picks the zh-CN description')
  const mode = fieldAt(third, 'mode')
  check(mode.kind === 'select' && mode.options?.map(option => option.label).join() === 'a,b', 'string literal union → select')
  const nums = fieldAt(third, 'nums')
  check(nums.kind === 'select' && nums.format?.(true) === 'option:1' && JSON.stringify(nums.parse?.('option:1')) === '{"kind":"set","value":true}', 'non-string literals round-trip through option tokens')
  check(nums.parse?.('true') === undefined, 'select drafts outside the options are invalid')
  const hybrid = fieldAt(third, 'hybrid')
  check(hybrid.kind === 'text' && hybrid.options?.length === 1, 'literal + string union → text with presets')
  check(fieldAt(third, 'big').readOnly === true, 'oversize unions are read-only')
  check(fieldAt(third, 'ansi').label === 'Red label', 'ANSI never reaches a label')
  check(fieldAt(third, 'long').label === 'long' && (fieldAt(third, 'long').hint ?? '').includes('far too long'), 'long descriptions move to the hint')
  const bad = fieldAt(third, 'bad\u0007key')
  check(bad.label === 'bad key' && bad.path[0] === 'bad\u0007key', 'labels are sanitized, paths stay exact')
  check(fieldAt(third, 'nest.a').kind === 'boolean' && fieldAt(third, 'nest.b').kind === 'text' && third?.groups?.length === 1,
    'intersections of objects merge into one inline group (first declaration wins)')

  // Garbage, cycles and caps.
  for (const garbage of [undefined, null, 1, 'x', [], {}, { uid: 1 }, { uid: 1, refs: { 1: { type: 'object', dict: { a: 2 } } } },
    { uid: 1, refs: { 1: { type: 'object', dict: { a: 1, b: 1 } } } },
    { uid: 1, refs: { 1: { type: 'intersect', list: [1, 1] } } },
    { uid: 1, refs: { ['__proto__']: { type: 'object' }, 1: { type: 'object', dict: { ['__proto__']: 3, x: 'nope' } }, 3: { type: 'boolean', meta: 7 } } }]) {
    readSchema(garbage)
    pluginConfigSections(input([descriptor('third', garbage)]))
  }
  checks += 1
  const cyclic = pluginConfigSections(input([descriptor('third', { uid: 1, refs: { 1: { type: 'object', dict: { self: 1, flag: 2 } }, 2: { type: 'boolean' } } })]))
  check(fieldAt(cyclic[0], 'self.flag').kind === 'boolean' && fieldAt(cyclic[0], 'self.self').readOnly === true, 'self-referencing schemas stop at one nested level')
  const wide = Schema.object(Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`f${index}`, Schema.boolean()])))
  const capped = pluginConfigSections(input([descriptor('third', wide.toJSON())]))
  check(capped[0]!.fields.length === PLUGIN_CONFIG_LIMITS.fields + 1 && capped[0]!.fields.at(-1)!.readOnly === true
    && capped[0]!.fields.at(-1)!.label.includes(`${300 - PLUGIN_CONFIG_LIMITS.fields}`), 'field count is capped with an overflow row')
  const many = Array.from({ length: 50 }, (_, index) => descriptor(`p${index}`, live.toJSON()))
  const manyEntries = (ns: string) => ({ moduleName: `plugin-${ns}` })
  check(pluginConfigSections({ ...input(many), entry: manyEntries }).length === PLUGIN_CONFIG_LIMITS.plugins, 'plugin page count is capped')
  check(pluginConfigSections({ ...input([descriptor('third', live.toJSON())]), writable: false })[0]!.fields.every(field => field.readOnly === true),
    'a profile that refuses form writes renders every row read-only')
}

// ── Source without a usable host ──────────────────────────────────────────
{
  const bare = { get: () => undefined, on: () => () => {} } as unknown as CordisContext
  const source = createPluginConfigSource(bare, () => {})
  check(source.sections(new Set()).length === 0, 'no settings service → no pages')
  source.dispose()
  const older = {
    get: (name: string) => name === 'settings' ? { describe: () => [{ ns: 'x', revision: 0, applies: 'live', value: { a: 1 } }] } : undefined,
    on: () => () => {},
  } as unknown as CordisContext
  const old = createPluginConfigSource(older, () => {})
  check(old.sections(new Set()).length === 0, 'a host before Config forms (no schema) → no pages')
  old.dispose()
  const throwing = { get: (name: string) => name === 'settings' ? { describe: () => { throw new Error('boom') } } : undefined, on: () => () => {} } as unknown as CordisContext
  check(createPluginConfigSource(throwing, () => {}).sections(new Set()).length === 0, 'a failing describe() yields no pages')
}

// ── Real Loader + Settings + channel + screen ─────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-plugin-config-'))
const root = new Context()
const fixture = {
  applies: { context: 0 },
  contextConfig: Schema.object({
    maxKeptTurns: Schema.number().min(1).step(1).default(300),
    bounds: Schema.object({ maxNodes: Schema.natural().default(2000) }),
    showTokens: Schema.boolean().default(true).description('Show token counts').volatile(),
    placement: Schema.union(['all', 'tab', 'sidebar']).default('all').volatile(),
    level: Schema.union([Schema.const(1).description('Low'), Schema.const(2).description('High')]).default(1).volatile(),
    ratio: Schema.number().min(0).max(1).step(0.25).default(0.5).volatile(),
    promptPrefix: Schema.string().default('').volatile(),
    notes: Schema.string().role('textarea').default('a\nb').description('\u001b[31mNotes\u001b[0m').volatile(),
    display: Schema.object({
      compact: Schema.boolean().default(false),
      width: Schema.natural().max(200).default(80),
      deep: Schema.object({ x: Schema.string().default('y') }),
    }).volatile(),
    tags: Schema.array(String).default(['x']).volatile(),
    token: Schema.string().role('secret').volatile(),
    pattern: Schema.string().pattern(/^[a-z]+$/).default('abc').volatile(),
    hiddenThing: Schema.string().hidden().volatile(),
  }),
  optOutConfig: Schema.object({ flag: Schema.boolean().default(false).volatile() }),
}
;(globalThis as { __wp9?: unknown }).__wp9 = fixture
const plugins = join(home, 'plugins')
mkdirSync(join(plugins, 'fixture-context'), { recursive: true })
mkdirSync(join(plugins, 'fixture-opt-out'), { recursive: true })
writeFileSync(join(plugins, 'fixture-context', 'index.mjs'), [
  "export const name = 'fixture-context'",
  'export const Config = globalThis.__wp9.contextConfig',
  'export function apply() { globalThis.__wp9.applies.context += 1 }',
].join('\n'))
writeFileSync(join(plugins, 'fixture-opt-out', 'index.mjs'), [
  "export const name = 'fixture-opt-out'",
  'export const Config = globalThis.__wp9.optOutConfig',
  // The documented opt-out: the plugin ships its own page and turns the generated one off.
  "export function apply(ctx) { ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) }) }",
].join('\n'))
const contextModule = pathToFileURL(join(plugins, 'fixture-context', 'index.mjs')).href
const SECRET = 'sk-fixture-secret-literal'

let channel: ReturnType<typeof createChannel> | undefined
try {
  await root.plugin(Loader)
  const patchPath = join(home, 'profiles', 'fixture', 'cordis.patch.yml')
  root.provide('profileContext', { home, name: 'fixture', patchPath })
  /** The profile layer the editor writes, and the rows' original (inherited) configs. */
  const overrides = new Map<string, Record<string, unknown>>()
  const inherited = new Map<string, Record<string, unknown>>()
  const profileWrites: Array<{ id: string; config: Record<string, unknown> }> = []
  let refuseNext: string | undefined
  type EntryLike = { id: string; options: { id: string; config?: Record<string, unknown> }; fiber: { runtime: unknown } }
  root.provide('configEditor', {
    documentPath: patchPath,
    entries: () => [...root.loader.entries()],
    configuration: () => [...root.loader.entries()].map(entry => ({
      entry, inherited: structuredClone(inherited.get(entry.options.id) ?? {}), override: structuredClone(overrides.get(entry.options.id) ?? {}),
    })),
    // The host editor's contract: derive from the current raw config, validate
    // the COMPLETE candidate, persist the override, reconcile through Loader.
    async edit(entry: EntryLike, change: (current: Record<string, unknown>, base: Record<string, unknown>) => Record<string, unknown>) {
      if (refuseNext !== undefined) {
        const message = refuseNext
        refuseNext = undefined
        throw new Error(message)
      }
      const next = change(structuredClone(entry.options.config ?? {}), structuredClone(inherited.get(entry.options.id) ?? {}))
      resolveConfig(entry.fiber.runtime as never, next)
      overrides.set(entry.options.id, next)
      profileWrites.push({ id: entry.options.id, config: structuredClone(next) })
      await root.loader.update(entry.id, { config: next })
      await root.loader.await()
    },
  })
  await root.plugin(Settings)
  const contextBase = { maxKeptTurns: 77, bounds: { maxNodes: 9 }, token: SECRET, extraUnknown: 'kept' }
  inherited.set('fixture-context', structuredClone(contextBase))
  await root.loader.create({ id: 'fixture-context', name: contextModule, config: structuredClone(contextBase) })
  await root.loader.create({ id: 'fixture-opt-out', name: pathToFileURL(join(plugins, 'fixture-opt-out', 'index.mjs')).href, config: {} })
  root.loader.builtins.hostrow = { name: 'host-row', Config: Schema.object({ x: Schema.boolean().default(false).volatile() }), apply() {} }
  await root.loader.create({ id: 'host-row', name: 'cordis:hostrow', config: {} })
  await root.loader.await()
  check(fixture.applies.context === 1, 'fixture plugin applied once')
  const settings = root.get('settings' as never) as { describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; autoGenerate: boolean }>; mutate: (...args: unknown[]) => Promise<void> }
  const served = settings.describe({ redactSecrets: true })
  check(['fixture-context', 'fixture-opt-out', 'host-row'].every(ns => served.some(view => view.ns === ns)), `the host serves every volatile form: ${served.map(view => view.ns)}`)
  check(served.find(view => view.ns === 'fixture-opt-out')?.autoGenerate === false, 'configure({ auto: false }) reaches the descriptor')

  const services = ['settings', 'loader', 'configEditor', 'credentials', 'pluginManager']
  const agent = { id: 'fixture-agent', ctx: { on: () => () => {} }, status: 'idle',
    session: { id: 'fixture-session', seq: 0, events: [] }, inbox: { remove: () => true } } as unknown as Agent
  channel = createChannel({
    get: (name: string) => services.includes(name) ? root.get(name as never) : undefined,
    on: (name: string, listener: (...args: unknown[]) => void) => root.on(name as never, listener as never),
    logger: { warn() {} },
  } as unknown as CordisContext, agent, { provider: 'deepseek-official', model: 'deepseek-flash', cwd: home, activity: false, upstreamRetry: false })
  const host = channel.settingsHost()!
  check(host !== undefined, 'the channel exposes its settings host')

  const generated = channel.settingsSections()
  check(generated.map(section => section.ns).join() === 'fixture-context',
    `only the third-party form without its own page gets a generated page: ${generated.map(section => section.ns)}`)
  const section = generated[0]!
  check(section.title === 'fixture-context' && section.page?.id === 'plugins', 'the page is titled by the plugin package until the manager answers')
  const paths = section.fields.map(field => field.path.join('.'))
  check(!paths.includes('maxKeptTurns') && !paths.includes('bounds') && !paths.includes('hiddenThing') && !paths.includes('extraUnknown'),
    `non-volatile, hidden and undeclared keys are not form fields: ${paths}`)
  check(fieldAt(section, 'showTokens').kind === 'boolean' && fieldAt(section, 'showTokens').label === 'Show token counts', 'boolean with its description as label')
  check(fieldAt(section, 'placement').kind === 'select' && fieldAt(section, 'level').options?.map(option => option.label).join() === 'Low,High', 'literal unions → selects')
  check(fieldAt(section, 'ratio').kind === 'number' && (fieldAt(section, 'ratio').hint ?? '').includes('≤ 1'), 'number range in the hint')
  check(fieldAt(section, 'notes').label === 'Notes' && (fieldAt(section, 'notes').hint ?? '').includes('\\n'), 'textarea strings edit as an escaped line')
  check(fieldAt(section, 'display.compact').group !== undefined && fieldAt(section, 'display.width').kind === 'number', 'one nested object → inline group of dotted paths')
  check(fieldAt(section, 'display.deep').readOnly === true, 'deeper objects are read-only')
  check(fieldAt(section, 'tags').readOnly === true && fieldAt(section, 'token').readOnly === true, 'arrays and secrets are read-only')
  const other = section.fields.at(-1)!
  check(other.readOnly === true && other.format?.(undefined) === '2 fields' && (other.hint ?? '').includes('maxKeptTurns')
    && (other.hint ?? '').includes(patchPath), 'non-live keys are named with the profile patch to edit')
  check(!JSON.stringify(generated).includes(SECRET), 'no secret literal in the generated sections')

  const view = () => host.listNamespaces().find(entry => entry.ns === 'fixture-context')!
  const valueOf = (path: string) => getPath(view().value, path.split('.'))
  const formFor = () => new SettingsForm(host, view(), section.fields)
  const tokenForm = formFor()
  check(tokenForm.field(fieldAt(section, 'token')).text === 'configured' || tokenForm.field(fieldAt(section, 'token')).text.includes('configured'),
    `secret rows report presence only: ${tokenForm.field(fieldAt(section, 'token')).text}`)
  check(tokenForm.field(fieldAt(section, 'notes')).text === 'a\\nb', 'multi-line values render escaped')
  check(tokenForm.field(fieldAt(section, 'level')).text === 'option:0' && tokenForm.field(fieldAt(section, 'tags')).text === '["x"]', 'select tokens and read-only summaries')

  // Save: one revision-fenced mutate, live, every ordinary key kept.
  const fiberBefore = (root.loader.entries() as unknown as Iterable<{ options: { id: string }; fiber: unknown }>)
  const contextFiber = [...fiberBefore].find(entry => entry.options.id === 'fixture-context')!.fiber
  const form = formFor()
  form.edit(fieldAt(section, 'showTokens'), 'false')
  form.edit(fieldAt(section, 'placement'), 'option:2')
  form.edit(fieldAt(section, 'level'), 'option:1')
  form.edit(fieldAt(section, 'ratio'), '0.75')
  form.edit(fieldAt(section, 'promptPrefix'), 'Hello there ')
  form.edit(fieldAt(section, 'notes'), 'line1\\nline2\\\\end')
  form.edit(fieldAt(section, 'display.width'), '120')
  form.edit(fieldAt(section, 'tags'), '["y"]')
  check(!form.isStaged(fieldAt(section, 'tags')), 'read-only rows never stage')
  const writesBefore = profileWrites.length
  check(await form.save(), `save lands: ${form.failureMessage}`)
  check(profileWrites.length === writesBefore + 1, 'one write for the whole form')
  check(valueOf('showTokens') === false && valueOf('placement') === 'sidebar' && valueOf('level') === 2 && valueOf('ratio') === 0.75,
    'boolean / select / non-string select / number land in the live config')
  check(valueOf('promptPrefix') === 'Hello there ' && valueOf('notes') === 'line1\nline2\\end' && valueOf('display.width') === 120 && valueOf('display.compact') === false,
    'strings verbatim, escaped multi-line decoded, nested paths written alone')
  const written = profileWrites.at(-1)!.config
  check(written.maxKeptTurns === 77 && (written.bounds as { maxNodes?: number }).maxNodes === 9 && written.extraUnknown === 'kept' && written.token === SECRET,
    `ordinary, undeclared and secret keys survive the write: ${JSON.stringify(Object.keys(written))}`)
  check(JSON.stringify(written.tags) === '["x"]' || written.tags === undefined, 'untouched read-only values are not rewritten')
  const contextEntry = [...(root.loader.entries() as unknown as Iterable<{ options: { id: string }; fiber: unknown }>)].find(entry => entry.options.id === 'fixture-context')!
  check(contextEntry.fiber === contextFiber && fixture.applies.context === 1, 'volatile edits apply live: no remount')
  check(view().applies === 'live', 'the host reports the form as live')

  // Clearing a text field unsets the override and re-inherits.
  const clear = formFor()
  clear.edit(fieldAt(section, 'promptPrefix'), '')
  check(await clear.save(), `clear lands: ${clear.failureMessage}`)
  check(valueOf('promptPrefix') === '' && formFor().field(fieldAt(section, 'promptPrefix')).overridden === false, 'empty draft unsets back to the inherited value')

  // Failures reach the form; nothing is written.
  const invalid = formFor()
  for (const [path, text] of [['ratio', '0.3'], ['ratio', '2'], ['display.width', '201'], ['display.width', '1.5'], ['ratio', 'NaN']] as const) {
    invalid.edit(fieldAt(section, path), text)
    check(invalid.field(fieldAt(section, path)).invalid, `${path}=${text} is refused before the host`)
    invalid.discard()
  }
  const writesBeforeFailures = profileWrites.length
  const hostInvalid = formFor()
  hostInvalid.edit(fieldAt(section, 'pattern'), 'ABC123')
  check(!(await hostInvalid.save()) && /regexp|match/u.test(hostInvalid.failureMessage ?? ''), `host-side Config validation reaches the form: ${hostInvalid.failureMessage}`)
  refuseNext = 'Configuration for "fixture-context" is overridden by a home patch or command-line overlay'
  const overlay = formFor()
  overlay.edit(fieldAt(section, 'showTokens'), 'true')
  check(!(await overlay.save()) && (overlay.failureMessage ?? '').includes('home patch'), 'an overlay refusal is reported verbatim')
  check(profileWrites.length === writesBeforeFailures, 'failed saves write nothing')
  check(valueOf('showTokens') === false, 'a refused save leaves the live value')
  await assert.rejects(host.write('fixture-context', [{ op: 'set', path: ['maxKeptTurns'], value: 5 }]), /not volatile/u)
  checks += 1

  // A stale form retries once on the revision fence.
  const stale = formFor()
  await host.write('fixture-context', [{ op: 'set', path: ['ratio'], value: 0.25 }])
  stale.edit(fieldAt(section, 'level'), 'option:0')
  check(await stale.save() && valueOf('level') === 1 && valueOf('ratio') === 0.25, 'a concurrent write is fenced and retried, not overwritten')

  // Plugin-manager titles arrive asynchronously and re-render the channel.
  let emits = 0
  const unsubscribe = channel.subscribe(() => { emits += 1 })
  // The manager row mounting later announces itself through `internal/service`.
  root.provide('pluginManager', { listPlugins: async () => [{ entryId: 'fixture-context', patchId: 'fixture-context', moduleName: contextModule, enabled: true, fiberPhase: 'active', meta: { title: { en: 'Context fixture', zh: '上下文样例' } } }] })
  channel.settingsSections()
  check(await settled(() => channel!.settingsSections().find(entry => entry.ns === 'fixture-context')?.title === 'Context fixture'), 'the manager title replaces the package name')
  check(emits > 0, 'the title arrival re-renders the channel')
  unsubscribe()

  // Registered/curated precedence at the channel level: the claim suppresses the page.
  const claimed = createPluginConfigSource({ get: (name: string) => services.includes(name) ? root.get(name as never) : undefined, on: () => () => {} } as unknown as CordisContext, () => {})
  check(claimed.sections(new Set(['fixture-context'])).length === 0, 'a claimed namespace gets no generated page')
  claimed.dispose()

  // ── Terminal: four layouts ──
  const uiLease = createChannelUiLease(() => true)
  const uiChannel = createChannelUi(createChannelUi(channel, 'legacy', uiLease), 'legacy', uiLease)
  class Input extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
  for (const fullscreen of [false, true]) for (const columns of [100, 40]) {
    const rows = 30
    const term = new Terminal({ cols: columns, rows, allowProposedApi: true })
    const output: string[] = []
    class Output extends Writable {
      columns = columns; rows = rows; isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) { output.push(String(chunk)); term.write(String(chunk), done) }
    }
    const stdin = new Input()
    const screen = () => viewportLines(term, rows).join('\n')
    const focusedLine = () => screen().split('\n').find(line => line.includes('❯')) ?? ''
    const focus = async (label: string): Promise<boolean> => {
      for (let step = 0; step < 40; step += 1) {
        if (focusedLine().includes(label)) return true
        const before = focusedLine()
        stdin.write('\x1b[B')
        await settled(() => focusedLine() !== before)
      }
      return focusedLine().includes(label)
    }
    const content = <SettingsScreen channel={uiChannel} onClose={() => {}} />
    const instance = await render(fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content,
      { stdout: new Output(), stdin, stderr: new Writable({ write(_chunk, _encoding, done) { done() } }), patchConsole: false, exitOnCtrlC: false })
    const layout = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
    try {
      check(await settled(() => screen().includes('Context fixture') || screen().includes('Context fi')), `${layout}: the generated card renders\n${screen()}`)
      check(await focus('Show token'), `${layout}: reach the boolean row\n${screen()}`)
      const before = valueOf('showTokens')
      stdin.write('\r')
      check(await settled(() => valueOf('showTokens') === !before), `${layout}: Enter toggles through the real settings service`)
      // A write from outside the open screen (another surface, a reload)
      // must refresh a clean form: the focused row shows the new value with
      // no key pressed.
      const shownAfterToggle = focusedLine()
      const external = formFor()
      external.edit(fieldAt(section, 'showTokens'), String(before))
      check(await external.save(), `${layout}: an external write lands`)
      check(await settled(() => valueOf('showTokens') === before && focusedLine() !== shownAfterToggle),
        `${layout}: the open screen re-reads the namespace after an external write\n${screen()}`)
      check(await focus('tags'), `${layout}: reach a read-only row\n${screen()}`)
      const writes = profileWrites.length
      stdin.write('\r')
      // 固定窗:探针 a read-only row must neither open the editor nor write
      await sleep(150)
      check(!screen().includes('▌') && profileWrites.length === writes, `${layout}: read-only rows open no editor and write nothing\n${screen()}`)
      const text = output.join('')
      check(!text.includes(SECRET), `${layout}: the secret literal never reaches the terminal`)
      check(!text.includes('\u001b[31mNotes'), `${layout}: plugin-supplied escape sequences are stripped`)
    } finally { await instance.unmount(); term.dispose() }
  }
  console.log(`plugin config settings OK (${checks} checks): schema mapping, live volatile writes keeping ordinary keys, failures, precedence, untrusted schemas, absent host, async titles and 4 terminal layouts`)
} finally {
  if (channel !== undefined) disposeChannelOwner(channel)
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
