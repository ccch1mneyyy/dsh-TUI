/**
 * The TUI's own settings document (`~/.dsh-tui/settings.json`) and its settings
 * service (src/dsh-adapter/tui-settings.ts): one-time import from the profile
 * patch's `dsh-tui` row, scope resolution, `mutate`, delegation of other
 * namespaces, and a broken document.
 *
 * Run: node --import tsx/esm scripts/verify-tui-settings.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createTuiSettingsService, type DelegateSettings } from '../src/dsh-adapter/tui-settings.js'
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
await broken.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: false }])
const rewritten = JSON.parse(readFileSync(fresh, 'utf8')) as { values: { whale?: boolean }; imported?: unknown }
check('a write over a broken document drops the unreadable mark', rewritten.values.whale === false && rewritten.imported === undefined, rewritten)
const peer = createTuiSettingsService({ ns: 'dsh-tui', file: fresh, profile: 'dsh-tui', keys })
await peer.mutate('dsh-tui', [{ op: 'set', path: ['lang'], value: 'zh' }])
await broken.mutate('dsh-tui', [{ op: 'set', path: ['whale'], value: true }])
check('… and later writes still re-read the file', (JSON.parse(readFileSync(fresh, 'utf8')) as { values: { lang?: string } }).values.lang === 'zh')

console.log(`\nverify-tui-settings: ${passed} checks passed`)
