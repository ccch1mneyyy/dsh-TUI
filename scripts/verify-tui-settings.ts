/**
 * The TUI's own settings document (`~/.dsh-tui/settings.json`) and its settings
 * service (src/dsh-adapter/tui-settings.ts): one-time import from the profile
 * patch's `dsh-tui` row and an older host's `settings.yaml`, scope
 * resolution, `mutate` (under the cross-process lock), delegation of other
 * namespaces, and a broken document.
 *
 * Run: node --import tsx/esm scripts/verify-tui-settings.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createTuiSettingsService, type DelegateSettings } from '../src/dsh-adapter/tui-settings.js'
import { createTuiSettings } from '../src/tuiSettingsFile.js'
import { EDITABLE_CONFIG_KEYS } from '../src/settings/definitions.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'verify-tui-settings-'))
process.env.DSH_HOME = join(root, 'dsh')
const patchDir = join(root, 'dsh', 'profiles', 'dsh-tui')
mkdirSync(patchDir, { recursive: true })
const patchFile = join(patchDir, 'cordis.patch.yml')
const patchText = [
  '- id: something-else',
  '  config: { lang: zh }',
  '- id: dsh-tui',
  '  config:',
  '    provider: deepseek-official',
  '    lang: en',
  '    fullscreen: false',
  '    preset: !!js process.env.DSH_TUI_PRESET',
  '    diffLayout: !!js process.env.DSH_TUI_DIFF ?? "split"',
  '    statusBar:',
  '      tps: false',
  '',
].join('\n')
writeFileSync(patchFile, patchText)
const keys = EDITABLE_CONFIG_KEYS as readonly string[]
const file = join(root, 'tui', 'settings.json')
const doc = (): { values: Record<string, unknown>; imported?: { from: string } } => JSON.parse(readFileSync(file, 'utf8'))

// ── one-time import ───────────────────────────────────────────────────
const first = createTuiSettingsService({ ns: 'dsh-tui', file, profile: 'dsh-tui', keys })
check('the import wrote the document', doc().imported?.from === patchFile, doc())
check('the import took the editable keys of the dsh-tui row', doc().values.lang === 'en' && doc().values.fullscreen === false && (doc().values.statusBar as { tps?: boolean }).tps === false, doc().values)
check('deployment keys stay in the profile', !('provider' in doc().values) && !('preset' in doc().values), doc().values)
check('an editable !!js field is skipped, not evaluated', !('diffLayout' in doc().values), doc().values)
check('the profile patch is untouched', readFileSync(patchFile, 'utf8') === patchText)
writeFileSync(patchFile, patchText.replace('lang: en', 'lang: zh'))
createTuiSettingsService({ ns: 'dsh-tui', file, profile: 'dsh-tui', keys })
check('a later boot never re-imports', doc().values.lang === 'en')

// ── scope, watch, mutate ──────────────────────────────────────────────
const schema = Schema.object({
  lang: Schema.union(['zh', 'en']),
  whale: Schema.boolean().default(true),
  statusBar: Schema.object({ tps: Schema.boolean().default(true), cost: Schema.boolean().default(true) }).default({ tps: true, cost: true }),
})
const scope = first.register('dsh-tui', schema)
check('the scope resolves the user layer through the schema defaults', scope.get().lang === 'en' && scope.get().whale && !scope.get().statusBar.tps && scope.get().statusBar.cost, scope.get())
const seen: unknown[] = []
const unwatch = scope.watch(next => { seen.push(next) })
const before = first.describe().find(row => row.ns === 'dsh-tui')!
check('describe serves the own row with value and user layer', before.applies === 'live' && (before.user as { lang?: string }).lang === 'en' && (before.value as { whale?: boolean }).whale === true, before)
await first.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: false }, { op: 'unset', path: ['statusBar', 'tps'] }], before.revision)
check('mutate persists set and unset', doc().values.whale === false && !('statusBar' in doc().values), doc().values)
check('watchers see the write', seen.length === 1 && (seen[0] as { whale?: boolean }).whale === false && (seen[0] as { statusBar: { tps: boolean } }).statusBar.tps, seen)
const after = first.describe().find(row => row.ns === 'dsh-tui')!
check('the revision advances', after.revision === before.revision + 1)
await assert.rejects(first.mutate('dsh-tui', [{ op: 'set', path: ['lang'], value: 'zh' }], before.revision), (error: { code?: string }) => error.code === 'SETTINGS_CONFLICT')
check('a stale revision is refused with SETTINGS_CONFLICT', doc().values.lang === 'en')
unwatch()
await first.mutate('dsh-tui', [{ op: 'set', path: ['lang'], value: 'zh' }])
check('an unwatched callback stays quiet', seen.length === 1)
check('a write without a revision lands', first.get('dsh-tui') !== undefined && (first.get('dsh-tui') as { lang?: string }).lang === 'zh')
const other = createTuiSettingsService({ ns: 'dsh-tui', file, profile: 'dsh-tui', keys })
await other.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: true }])
await first.mutate('dsh-tui', [{ op: 'set', path: ['statusBar', 'cost'], value: false }])
check('a write keeps another process\'s write since boot', doc().values.whale === true && doc().values.lang === 'zh', doc().values)

// ── delegate routing ──────────────────────────────────────────────────
const delegated: string[] = []
const delegate: DelegateSettings = {
  describe: () => [{ ns: 'dsh-tui', revision: 9, applies: 'live', value: { lang: 'stale' } }, { ns: 'llm-pi-ai', revision: 3, applies: 'live', value: { providers: {} } }],
  mutate: (ns, ops) => { delegated.push(`${ns}:${ops.length}`); return Promise.resolve() },
}
const composite = createTuiSettingsService({ ns: 'dsh-tui', file, profile: 'dsh-tui', keys, delegate: () => delegate })
const rows = composite.describe()
check('the own row replaces the delegate\'s row of the same namespace', rows.filter(row => row.ns === 'dsh-tui').length === 1 && (rows.find(row => row.ns === 'dsh-tui')!.value as { lang?: string }).lang === 'zh', rows)
check('other namespaces come from the delegate', rows.some(row => row.ns === 'llm-pi-ai'))
await composite.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'x'], value: {} }], 3)
check('a write to another namespace goes to the delegate', delegated.join() === 'llm-pi-ai:1' && doc().values.providers === undefined)
const bare = createTuiSettingsService({ ns: 'dsh-tui', file, profile: 'dsh-tui', keys })
await assert.rejects(bare.mutate('llm-pi-ai', []), /no settings namespace/)
check('without a delegate another namespace is refused', true)

// ── missing profile patch, broken document ────────────────────────────
const fresh = join(root, 'fresh', 'settings.json')
createTuiSettingsService({ ns: 'dsh-tui', file: fresh, profile: 'no-such-profile', keys })
const freshDoc = JSON.parse(readFileSync(fresh, 'utf8')) as { values: object; imported: { from: string } }
check('no profile patch: nothing imported, the import still marked', Object.keys(freshDoc.values).length === 0 && freshDoc.imported.from === 'none', freshDoc)
writeFileSync(fresh, '{ broken')
const broken = createTuiSettingsService({ ns: 'dsh-tui', file: fresh, profile: 'dsh-tui', keys })
check('a broken document reads as an empty layer', JSON.stringify(broken.get('dsh-tui')) === '{}' && readFileSync(fresh, 'utf8') === '{ broken')
check('the broken document is visible to callers', (broken.describe().find(row => row.ns === 'dsh-tui')!.warning as { id?: string } | undefined)?.id === 'unreadable')
const corruptBackups = (): string[] => readdirSync(join(root, 'fresh')).filter(name => name.startsWith('settings.json.corrupt-'))
await broken.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: false }])
const rewritten = JSON.parse(readFileSync(fresh, 'utf8')) as { values: { whale?: boolean }; imported?: unknown }
check('a write over a broken document drops the unreadable mark', rewritten.values.whale === false && rewritten.imported === undefined, rewritten)
check('the first write over a broken document keeps the original bytes beside it',
  corruptBackups().length === 1 && readFileSync(join(root, 'fresh', corruptBackups()[0]!), 'utf8') === '{ broken', corruptBackups())
check('the backup is private', (statSync(join(root, 'fresh', corruptBackups()[0]!)).mode & 0o777) === 0o600)
check('the recovery is visible to callers',
  ((broken.describe().find(row => row.ns === 'dsh-tui')!.warning as { id?: string; backup?: string } | undefined)?.backup
    === join(root, 'fresh', corruptBackups()[0]!)))
const peer = createTuiSettingsService({ ns: 'dsh-tui', file: fresh, profile: 'dsh-tui', keys })
await peer.mutate('dsh-tui', [{ op: 'set', path: ['lang'], value: 'zh' }])
await broken.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: true }])
check('… and later writes still re-read the file', (JSON.parse(readFileSync(fresh, 'utf8')) as { values: { lang?: string } }).values.lang === 'zh')
check('only the first write over a broken document makes a backup', corruptBackups().length === 1, corruptBackups())

// ── the lock spans re-read and replace ────────────────────────────────
// Another process holds the writer lock and commits a different key while
// this write waits: the write must land on that commit, not on its own copy.
const locked = join(root, 'locked', 'settings.json')
const holder = createTuiSettingsService({ ns: 'dsh-tui', file: locked, profile: 'no-such-profile', keys })
writeFileSync(`${locked}.lock`, `${process.pid}\n`)
const waiting = holder.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: false }])
await new Promise(resolve => setTimeout(resolve, 150))
const lockedDoc = (): { values: Record<string, unknown> } => JSON.parse(readFileSync(locked, 'utf8'))
check('a write waits for the writer lock', !('whale' in lockedDoc().values), lockedDoc())
writeFileSync(locked, JSON.stringify({ version: 1, values: { statusBar: { cost: false } } }))
rmSync(`${locked}.lock`)
await waiting
check('concurrent writes of different keys both land', lockedDoc().values.whale === false && (lockedDoc().values.statusBar as { cost?: boolean }).cost === false, lockedDoc())

// ── an older host's settings.yaml ─────────────────────────────────────
// The patch's dsh-tui row now says `lang: zh`, `statusBar.tps: false`.
const legacyYaml = join(root, 'dsh', 'settings.yaml')
writeFileSync(legacyYaml, 'dsh-tui:\n  lang: en\n  whale: false\n  provider: legacy\n  statusBar:\n    cost: false\nother:\n  lang: zh\n')
const legacyFile = join(root, 'legacy', 'settings.json')
createTuiSettingsService({ ns: 'dsh-tui', file: legacyFile, profile: 'dsh-tui', keys })
const legacyDoc = (path = legacyFile): { values: Record<string, unknown>; imported?: { from: string } } => JSON.parse(readFileSync(path, 'utf8'))
check('a pending settings.yaml overrides the row, nested sections merged',
  legacyDoc().values.lang === 'en' && legacyDoc().values.whale === false
  && JSON.stringify(legacyDoc().values.statusBar) === JSON.stringify({ tps: false, cost: false }), legacyDoc().values)
check('only its editable keys are taken', !('provider' in legacyDoc().values), legacyDoc().values)
check('the import names both sources', legacyDoc().imported?.from === `${patchFile}, ${legacyYaml}`, legacyDoc().imported)
writeFileSync(legacyYaml, 'dsh-tui:\n  lang: zh\n')
createTuiSettingsService({ ns: 'dsh-tui', file: legacyFile, profile: 'dsh-tui', keys })
check('the legacy import runs once and never overwrites the document', legacyDoc().values.lang === 'en' && legacyDoc().values.whale === false, legacyDoc().values)
writeFileSync(legacyYaml, 'dsh-tui:\n  lang: en\n  whale: false\n')
renameSync(legacyYaml, `${legacyYaml}.imported`)
const movedFile = join(root, 'moved', 'settings.json')
createTuiSettingsService({ ns: 'dsh-tui', file: movedFile, profile: 'dsh-tui', keys })
check('a settings.yaml DSH already moved into the patch sits beneath the row',
  legacyDoc(movedFile).values.lang === 'zh' && legacyDoc(movedFile).values.whale === false, legacyDoc(movedFile).values)
rmSync(`${legacyYaml}.imported`)

// ── a settings.yaml without the dsh-tui section defers to the imported one ──
writeFileSync(legacyYaml, 'other:\n  lang: zh\n')
writeFileSync(`${legacyYaml}.imported`, 'dsh-tui:\n  whale: false\n')
const deferredFile = join(root, 'deferred', 'settings.json')
createTuiSettingsService({ ns: 'dsh-tui', file: deferredFile, profile: 'dsh-tui', keys })
check('a pending document without the section falls through to the imported one',
  legacyDoc(deferredFile).values.whale === false && legacyDoc(deferredFile).imported?.from === `${patchFile}, ${legacyYaml}.imported`, legacyDoc(deferredFile))
rmSync(legacyYaml)
rmSync(`${legacyYaml}.imported`)

// ── the last dsh-tui row of the patch is the effective one ────────────
const twoRowsDir = join(root, 'dsh', 'profiles', 'two-rows')
mkdirSync(twoRowsDir, { recursive: true })
writeFileSync(join(twoRowsDir, 'cordis.patch.yml'), '- id: dsh-tui\n  config: { lang: zh, whale: false }\n- id: dsh-tui\n  config: { lang: en }\n')
const twoRowsFile = join(root, 'two-rows', 'settings.json')
createTuiSettingsService({ ns: 'dsh-tui', file: twoRowsFile, profile: 'two-rows', keys })
check('a later dsh-tui row overrides the earlier one', JSON.stringify(legacyDoc(twoRowsFile).values) === JSON.stringify({ lang: 'en' }), legacyDoc(twoRowsFile).values)

// ── a second profile's row joins beneath the user layer ──────────────
const profileBDir = join(root, 'dsh', 'profiles', 'profile-b')
mkdirSync(profileBDir, { recursive: true })
const patchB = join(profileBDir, 'cordis.patch.yml')
const patchBText = '- id: dsh-tui\n  config:\n    lang: zh\n    whale: true\n    fullscreen: false\n'
writeFileSync(patchB, patchBText)
const multiFile = join(root, 'multi', 'settings.json')
const multiFirst = createTuiSettingsService({ ns: 'dsh-tui', file: multiFile, profile: 'two-rows', keys })
await multiFirst.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: false }])
check('the first profile import holds', JSON.stringify(legacyDoc(multiFile).values) === JSON.stringify({ lang: 'en', whale: false }), legacyDoc(multiFile).values)
const multiSecond = createTuiSettingsService({ ns: 'dsh-tui', file: multiFile, profile: 'profile-b', keys })
check("a second profile's row reaches keys the user never set", (multiSecond.get('dsh-tui') as { fullscreen?: boolean }).fullscreen === false, legacyDoc(multiFile).values)
check("… but never overrides keys the user layer holds",
  (multiSecond.get('dsh-tui') as { lang?: string }).lang === 'en' && (multiSecond.get('dsh-tui') as { whale?: boolean }).whale === false, legacyDoc(multiFile).values)
check('the re-import records both sources', legacyDoc(multiFile).imported?.from === `${join(twoRowsDir, 'cordis.patch.yml')}, ${patchB}`, legacyDoc(multiFile).imported)
check('the second profile patch is untouched', readFileSync(patchB, 'utf8') === patchBText)
createTuiSettingsService({ ns: 'dsh-tui', file: multiFile, profile: 'profile-b', keys })
check('a re-import runs once per profile', legacyDoc(multiFile).imported?.from.split(', ').filter(source => source === patchB).length === 1, legacyDoc(multiFile).imported)
await multiSecond.mutate('dsh-tui', [{ op: 'set', path: ['lang'], value: 'en' }])
check('the re-imported document still mutates', (JSON.parse(readFileSync(multiFile, 'utf8')) as { values: { lang?: string } }).values.lang === 'en')

// ── concurrent first imports: the first document stays ────────────────
const raced = join(root, 'raced', 'settings.json')
check('the first import creates the document', createTuiSettings({ version: 1, values: { lang: 'en' } }, raced))
check('a concurrent import does not replace it', !createTuiSettings({ version: 1, values: { lang: 'zh' } }, raced)
  && (JSON.parse(readFileSync(raced, 'utf8')) as { values: { lang?: string } }).values.lang === 'en')
const racedService = createTuiSettingsService({ ns: 'dsh-tui', file: raced, profile: 'two-rows', keys })
check('… and the later launch adopts the existing document', (racedService.get('dsh-tui') as { lang?: string }).lang === 'en')
// A filesystem without hard links: the fallback must not replace either.
const realLink = fs.linkSync
fs.linkSync = () => { throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }) }
syncBuiltinESMExports()
try {
  const noLinks = join(root, 'no-links', 'settings.json')
  check('without hard links the first import still creates the document', createTuiSettings({ version: 1, values: { lang: 'en' } }, noLinks)
    && (JSON.parse(readFileSync(noLinks, 'utf8')) as { values: { lang?: string } }).values.lang === 'en')
  check('… and a concurrent import still does not replace it', !createTuiSettings({ version: 1, values: { lang: 'zh' } }, noLinks)
    && (JSON.parse(readFileSync(noLinks, 'utf8')) as { values: { lang?: string } }).values.lang === 'en')
} finally {
  fs.linkSync = realLink
  syncBuiltinESMExports()
}

console.log(`\nverify-tui-settings: ${passed} checks passed`)
