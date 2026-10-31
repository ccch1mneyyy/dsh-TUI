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

const { pluginConfigSections, readSchema, escapeText, unescapeText, modulePackage, isHostOwnedModule, createPluginConfigSource, localizedText, PLUGIN_CONFIG_LIMITS } = PluginConfig

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

// ── Inherited names are ordinary absent keys, never overrides ─────────────
{
  const host = { listNamespaces: () => [], write: async () => {}, credentialConfigured: async () => false, writeCredential: async () => {} }
  const view = { ns: 'proto-keys', value: { a: {} }, base: {}, user: { a: {} }, revision: 1 }
  const fields: TuiSettingsField[] = [
    { path: ['constructor'], label: 'constructor', kind: 'text' },
    { path: ['a', 'toString'], label: 'a.toString', kind: 'text' },
  ]
  const form = new SettingsForm(host as never, view as never, fields)
  for (const field of fields) {
    const state = form.field(field)
    check(state.text === '' && state.overridden === false, `${field.path.join('.')} reads as absent, not an Object.prototype member: ${JSON.stringify(state)}`)
  }
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
  // A large read-only value is summarized, never serialized whole: the walk
  // gives up after the row's character budget (the trap is never reached).
  {
    const listed = pluginConfigSections(input([descriptor('third', Schema.object({ tags: Schema.array(String) }).toJSON())]))
    const tags = fieldAt(listed[0], 'tags')
    const hugeList: unknown[] = Array.from({ length: 1_000_000 }, (_, index) => 'item-' + index)
    let read = false
    Object.defineProperty(hugeList, 500_000, { get() { read = true; return 'trap' } })
    const shown = tags.format?.(hugeList) ?? ''
    check(!read && shown.includes('1000000'), `a million-item array shows its count without being serialized: ${JSON.stringify(shown)}`)
    check(tags.format?.(['a', 'b']) === '["a","b"]', 'a small array still shows as JSON')
    const wideValue = Object.fromEntries(Array.from({ length: 1_000_000 }, (_, index) => ['w' + index, index]))
    const wideShown = tags.format?.(wideValue) ?? ''
    check(wideShown.includes(String(PLUGIN_CONFIG_LIMITS.members) + '+') && !wideShown.includes('1000000'), `a million-key map is counted only up to the member budget: ${JSON.stringify(wideShown)}`)
    const modestShown = tags.format?.(Object.fromEntries(Array.from({ length: 30 }, (_, index) => ['k' + index, 'v'.repeat(5)]))) ?? ''
    check(modestShown.includes('30') && !modestShown.includes('+'), `a modest map still shows its exact key count: ${JSON.stringify(modestShown)}`)
    check(tags.format?.({ when: new Date(0) }) === JSON.stringify({ when: new Date(0) }), 'toJSON values serialize like JSON.stringify')
    check(tags.format?.({ a: undefined, b: 1, c: [undefined] }) === '{"b":1,"c":[null]}', 'undefined members follow JSON.stringify')
  }
  // A control-bearing preset makes the field use the escaped editor: the draft
  // that preset fills in shows `\n`, never a raw line break or control.
  {
    const ctrlField = fieldAt(pluginConfigSections(input([descriptor('third', Schema.object({ sep: Schema.union([Schema.const('a\nb'), Schema.string()]) }).toJSON())]))[0], 'sep')
    const ctrlOption = ctrlField.options?.[0]
    check(ctrlOption !== undefined && ctrlOption.value === 'a\\nb' && !/[\u0000-\u001f]/u.test(ctrlOption.value), `a control-bearing preset is offered escaped: ${JSON.stringify(ctrlOption)}`)
    check(JSON.stringify(ctrlField.parse?.(ctrlOption!.value)) === JSON.stringify({ kind: 'set', value: 'a\nb' }), 'and still writes the real value')
  }
  // A huge or non-string manager title gives a bounded card title.
  {
    const titled = (title: unknown) => pluginConfigSections({ ...input([descriptor('third', Schema.object({ flag: Schema.boolean() }).toJSON())]), entry: () => ({ moduleName: 'third-party-plugin', title } as never) })[0]?.title ?? ''
    check(titled('T'.repeat(3_000_000)).length <= 400, 'a multi-megabyte plugin title is cut before it is sanitized')
    check(titled(42) === 'third-party-plugin', `a non-string title falls back to the package name: ${titled(42)}`)
  }
  // An oversized editable string is shown read-only (bounded summary), never
  // turned into a draft that would copy or escape it whole.
  {
    const huge = 'v'.repeat(3_000_000)
    const bigSections = pluginConfigSections(input([descriptor('third', Schema.object({ note: Schema.string(), small: Schema.string() }).toJSON(), { value: { note: huge, small: 'ok' }, user: { note: huge, small: 'ok' } })]))
    const note = fieldAt(bigSections[0], 'note')
    check(note.readOnly === true && (note.format?.(huge) ?? '').length <= 400, 'a multi-megabyte string field is read-only with a bounded summary')
    check(fieldAt(bigSections[0], 'small').readOnly !== true, 'an ordinary string field stays editable')
  }
  // An empty-string preset beside a free-form string is a value, not a reset.
  {
    const presetSections = pluginConfigSections(input([descriptor('third', Schema.object({
      sep: Schema.union([Schema.const('').description('none'), Schema.const(', '), Schema.string()]),
      plain: Schema.string(),
    }).toJSON())]))
    const sep = fieldAt(presetSections[0], 'sep')
    const emptyOption = sep.options?.find(option => option.label === 'none')
    check(emptyOption !== undefined && emptyOption.value !== '', `the empty preset has a token of its own: ${JSON.stringify(sep.options)}`)
    check(JSON.stringify(sep.parse?.(emptyOption!.value)) === JSON.stringify({ kind: 'set', value: '' }), 'picking it sets the empty string')
    check(JSON.stringify(sep.parse?.('')) === JSON.stringify({ kind: 'clear' }), 'an empty text still clears the override')
    check(sep.format?.('') === emptyOption!.value && sep.format?.(', ') === ', ', 'a stored empty string shows as that preset')
    // The token is reversible: literal `""` (and `\""` …) values round-trip.
    for (const literal of ['""', '\\""', '\\\\""', 'x""']) {
      const shown = sep.format?.(literal) ?? ''
      check(JSON.stringify(sep.parse?.(shown)) === JSON.stringify({ kind: 'set', value: literal }), `literal ${JSON.stringify(literal)} round-trips through ${JSON.stringify(shown)}`)
    }
    const plain = fieldAt(presetSections[0], 'plain')
    check(JSON.stringify(plain.parse?.('""')) === JSON.stringify({ kind: 'set', value: '""' }), 'a field without an empty preset keeps `""` literal')
  }
  // The other metadata is bounded too: badges are capped (the trap past the
  // cap is never read) and long badge, default and key texts are cut before
  // they are sanitized.
  {
    const badges: unknown[] = Array.from({ length: 100_000 }, () => ({ text: 'b'.repeat(2_000_000 / 100_000) }))
    let badgeRead = false
    Object.defineProperty(badges, 500, { get() { badgeRead = true; return { text: 'trap' } } })
    const hugeKey = 'k'.repeat(3_000_000)
    const metaSections = pluginConfigSections(input([descriptor('third', { uid: 1, refs: { 1: { type: 'object', dict: { flag: 2, [hugeKey]: 3 } }, 2: { type: 'boolean', meta: { badges, default: 'd'.repeat(3_000_000) } }, 3: { type: 'boolean' } } })]))
    const flagHint = fieldAt(metaSections[0], 'flag').hint ?? ''
    check(!badgeRead && (flagHint.match(/\[/gu)?.length ?? 0) <= 8, `badges are capped before they are read: ${flagHint.slice(0, 80)}`)
    const keyed = metaSections[0]!.fields.find(field => field.path[0] === hugeKey)
    check(keyed !== undefined && keyed.label.length <= 400, 'a huge key labels a bounded row')
  }
  // A huge preset literal labels its option from a bounded prefix and still
  // writes the whole value.
  {
    const hugePreset = 'p'.repeat(3_000_000)
    const presetField = fieldAt(pluginConfigSections(input([descriptor('third', Schema.object({ mode: Schema.union([Schema.const(hugePreset), Schema.const('b')]) }).toJSON())]))[0], 'mode')
    const hugeOption = presetField.options?.[0]
    check(hugeOption !== undefined && hugeOption.label.length <= 400, `a huge preset gets a bounded label (${hugeOption?.label.length})`)
    check((presetField.parse?.(hugeOption!.value) as { value?: unknown } | undefined)?.value === hugePreset, 'and still writes the whole value')
  }
  // The secrets sidecar is indexed once and capped: an entry past the cap is
  // never read, and the real one still marks its field configured.
  {
    const sidecar: unknown[] = Array.from({ length: 100_000 }, () => ({ path: ['other'], set: false }))
    sidecar[3] = { path: ['token'], set: true }
    let sidecarRead = false
    Object.defineProperty(sidecar, 50_000, { get() { sidecarRead = true; return { path: ['token'], set: true } } })
    const secretSections = pluginConfigSections(input([descriptor('third', Schema.object({ token: Schema.string().role('secret'), other: Schema.string().role('secret') }).toJSON(), { secrets: sidecar })]))
    const tokenShown = fieldAt(secretSections[0], 'token').format?.(undefined) ?? ''
    const otherShown = fieldAt(secretSections[0], 'other').format?.(undefined) ?? ''
    check(!sidecarRead && tokenShown !== otherShown && tokenShown.includes('●'), `the sidecar is indexed up to its cap: ${JSON.stringify([tokenShown, otherShown])}`)
  }
  // Ineligible forms spend the examination budget too: a huge describe()
  // result is cut there even though it yields no pages (the trap is past it).
  {
    const forms: unknown[] = Array.from({ length: 100_000 }, () => null)
    forms[10] = descriptor('third', Schema.object({ flag: Schema.boolean() }).toJSON())
    let formRead = false
    Object.defineProperty(forms, 50_000, { get() { formRead = true; return null } })
    const formSections = pluginConfigSections(input(forms))
    check(!formRead && formSections.length === 1 && formSections[0]!.ns === 'third', 'descriptor scans stop at their own budget, eligible pages before it still render')
  }
  // Description metadata is bounded too: a wide locale map is read lazily
  // (the trap past the entry budget is never touched) and a huge text is cut.
  {
    const locales: Record<string, unknown> = {}
    for (let index = 0; index < 100_000; index += 1) locales['x-' + index] = 'text ' + index
    let localeRead = false
    Object.defineProperty(locales, 'x-50000', { get() { localeRead = true; return 'trap' }, enumerable: true })
    check(localizedText(locales, 'en') === 'text 0' && !localeRead, 'a wide locale map is read up to its entry budget')
    check((localizedText('d'.repeat(5_000_000), 'en') ?? '').length <= 4096, 'a huge description is cut before it is processed')
    check(localizedText({ zh: '中', en: 'English' }, 'en') === 'English' && localizedText({ 'zh-CN': '启用', '': 'Enabled' }, 'zh') === '启用', 'locale choice is unchanged')
  }
  // A very wide dict or list is cut at the member budget, read lazily: a
  // member past it is never touched (the traps record a read).
  {
    const wideDict: Record<string, unknown> = {}
    for (let index = 0; index < 100_000; index += 1) wideDict['k' + index] = 2
    let dictRead = false
    Object.defineProperty(wideDict, 'k50000', { get() { dictRead = true; return 2 }, enumerable: true })
    const wideSections = pluginConfigSections(input([descriptor('third', { uid: 1, refs: { 1: { type: 'object', dict: wideDict }, 2: { type: 'boolean' } } })]))
    check(!dictRead && wideSections[0]!.fields.length === PLUGIN_CONFIG_LIMITS.fields + 1, 'a wide dict is read lazily up to the member budget')
    const wideList: unknown[] = Array.from({ length: 100_000 }, () => 99)
    let listRead = false
    Object.defineProperty(wideList, 50_000, { get() { listRead = true; return 2 } })
    pluginConfigSections(input([descriptor('third', { uid: 1, refs: { 1: { type: 'intersect', list: wideList }, 2: { type: 'object', dict: { flag: 3 } }, 3: { type: 'boolean' } } })]))
    check(!listRead, 'dangling list members spend the member budget too')
  }
  // An intersection that lists itself eight times: re-expanding every
  // reference to the depth cap is ~8^9 calls; each node is expanded once.
  const selfListing = { uid: 1, refs: { 1: { type: 'intersect', list: [1, 1, 1, 1, 1, 1, 1, 1, 2] }, 2: { type: 'object', dict: { flag: 3 } }, 3: { type: 'boolean' } } }
  const selfStarted = performance.now()
  const selfSections = pluginConfigSections(input([descriptor('third', selfListing)]))
  check(performance.now() - selfStarted < 2000 && fieldAt(selfSections[0], 'flag').kind === 'boolean', 'an intersection that lists itself eight times stays bounded')
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
  // A huge profile's rows are walked lazily, stopping at the entry budget.
  let reached = false
  const wideHost = {
    get: (name: string) => name === 'settings'
      ? { describe: () => [{ ns: 'wide-ns', autoGenerate: true, schema: Schema.object({ flag: Schema.boolean() }).toJSON(), value: {}, revision: 0, applies: 'live' }] }
      : name === 'configEditor'
        ? { *entries() { for (let index = 0; index < 100_000; index += 1) { if (index === 50_000) reached = true; yield { options: { id: 'row' + index, name: 'x' } } } } }
        : undefined,
    on: () => () => {},
  } as unknown as CordisContext
  const wideSource = createPluginConfigSource(wideHost, () => {})
  wideSource.sections(new Set())
  check(!reached, 'a huge profile is walked lazily up to the entry budget')
  wideSource.dispose()
}
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
  const originalPlugins: unknown[] = [{ entryId: 'fixture-context', patchId: 'fixture-context', moduleName: contextModule, enabled: true, fiberPhase: 'active', meta: { title: { en: 'Context fixture', zh: '上下文样例' } } }]
  let managerPlugins = originalPlugins
  let listCalls = 0
  root.provide('pluginManager', { listPlugins: async () => { listCalls += 1; return managerPlugins } })
  channel.settingsSections()
  const titleOf = (): string | undefined => channel!.settingsSections().find(entry => entry.ns === 'fixture-context')?.title
  check(await settled(() => titleOf() === 'Context fixture'), 'the manager title replaces the package name')
  check(emits > 0, 'the title arrival re-renders the channel')
  // The same manager reporting a change: the title is looked up again on the
  // very next read (not after the snapshot TTL) …
  managerPlugins = [{ ...(managerPlugins[0] as object), meta: { title: { en: 'Renamed fixture', zh: '改名样例' } } }]
  await settled(() => false, { timeoutMs: 50 }) // let any lookup in flight land
  // Start from a fresh describe() snapshot so the next reads are well inside
  // its TTL: a reread then serves the built sections unless the key moved.
  root.emit('settings/document-updated' as never)
  channel.settingsSections()
  await new Promise(resolve => setImmediate(resolve))
  // The snapshot is really reused within its TTL: every ctx.get of the
  // settings service is a fresh proxy, so the source compares the instance.
  // Counted on a source of its own (the channel's built-in sections call
  // describe() too).
  {
    const concreteSettings = (await import('../src/dsh-adapter/host-access.js')).concreteService(root.get('settings' as never) as object) as { describe: (...args: unknown[]) => unknown }
    const describeOriginal = concreteSettings.describe
    let describes = 0
    concreteSettings.describe = function counted(this: unknown, ...args: unknown[]) { describes += 1; return describeOriginal.apply(this, args) }
    const ttlSource = createPluginConfigSource({ get: (name: string) => services.includes(name) ? root.get(name as never) : undefined, on: () => () => {} } as unknown as CordisContext, () => {})
    try {
      ttlSource.sections(new Set())
      ttlSource.sections(new Set())
      ttlSource.sections(new Set())
    } finally {
      concreteSettings.describe = describeOriginal
      ttlSource.dispose()
    }
    check(describes === 1, `reads inside the TTL reuse one describe() snapshot (${describes} calls)`)
  }
  await new Promise(resolve => setImmediate(resolve)) // that source's own title lookup lands first
  const callsBeforeChange = listCalls
  root.emit('plugin-manager/changed' as never)
  channel.settingsSections()
  // The lookup starts on a microtask: one macrotask turn flushes it.
  await new Promise(resolve => setImmediate(resolve))
  check(listCalls > callsBeforeChange, `the next read asks the manager again at once (${listCalls - callsBeforeChange} calls)`)
  check(await settled(() => titleOf() === 'Renamed fixture'), `a manager change refreshes the title: ${titleOf()}`)
  // … and a plugin it no longer lists keeps no stale title.
  managerPlugins = []
  root.emit('plugin-manager/changed' as never)
  check(await settled(() => titleOf() !== 'Renamed fixture'), `a plugin the manager dropped falls back to its package name: ${titleOf()}`)
  managerPlugins = originalPlugins
  root.emit('plugin-manager/changed' as never)
  check(await settled(() => titleOf() === 'Context fixture'), 'the manager listing it again restores its title')
  // A huge catalog is scanned only until every asked-for namespace is found
  // (the trap past the match is never read).
  {
    const catalog: unknown[] = Array.from({ length: 100_000 }, (_, index) => ({ entryId: 'other-' + index, patchId: 'other-' + index, meta: { title: 'Other' } }))
    catalog[2] = { ...(originalPlugins[0] as object), meta: { title: { en: 'Catalog fixture', zh: '目录样例' } } }
    let catalogRead = false
    Object.defineProperty(catalog, 50_000, { get() { catalogRead = true; return { entryId: 'x', patchId: 'x' } } })
    managerPlugins = catalog
    root.emit('plugin-manager/changed' as never)
    check(await settled(() => titleOf() === 'Catalog fixture') && !catalogRead, `a huge catalog stops scanning at the match: ${titleOf()}`)
    managerPlugins = originalPlugins
    root.emit('plugin-manager/changed' as never)
    await settled(() => titleOf() === 'Context fixture')
  }
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
      const shownBeforeToggle = focusedLine()
      stdin.write('\r')
      check(await settled(() => valueOf('showTokens') === !before), `${layout}: Enter toggles through the real settings service`)
      // A write from outside the open screen (another surface, a reload)
      // must refresh a clean form: the focused row shows the new value with
      // no key pressed. The toggled row is captured once it is on screen —
      // the stored value can flip a frame before the render does.
      await settled(() => focusedLine() !== shownBeforeToggle)
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
