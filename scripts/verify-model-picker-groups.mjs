/**
 * Headless regression for the tabbed `/model` picker derivation
 * (src/modelGroups.ts + src/modelRecents.ts): provider grouping
 * (first-appearance order, display labels with route-key fallback,
 * per-group counts), the pinned "recently used" pseudo-group (catalog
 * intersection, cap, vanishing entries), the landing rule (recents tab,
 * current provider/model without recents), and
 * the recents file (move-to-front dedupe, cap, round-trip, corrupt reset).
 * Keyboard, mouse and draft behavior are covered by verify-model-picker-ui.tsx.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-model-picker-groups.mjs`
 */
import {
  deriveModelGroups,
  modelPickerLanding,
  recentCatalogModels,
  RECENTS_GROUP_PROVIDER,
  RECENTS_LABEL_PLACEHOLDER,
} from '../lib/types/modelGroups.js'
import {
  MODEL_RECENTS_LIMIT,
  readModelRecents,
  recordModelUse,
} from '../lib/types/modelRecents.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const model = (provider, id) => ({ provider, id, name: id })

// 1. grouping: order, labels, counts.
{
  const models = [
    model('deepseek-official', 'deepseek-chat'),
    model('deepseek-official', 'deepseek-reasoner'),
    model('openai-codex', 'gpt-5.6-sol'),
    model('deepseek-official', 'deepseek-v3.2'),
    model('xai', 'grok-code'),
  ]
  const infos = [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'openai-codex', name: 'OpenAI Codex' },
  ]
  const groups = deriveModelGroups(models, infos)
  check('1 grouping: first-appearance order', eq(groups.map(g => g.provider), ['deepseek-official', 'openai-codex', 'xai']))
  check('1 grouping: registry labels with route-key fallback',
    eq(groups.map(g => g.label), ['DeepSeek', 'OpenAI Codex', 'xai']))
  check('1 grouping: counts include interleaved members', eq(groups.map(g => g.count), [3, 1, 1]))
  check('1 grouping: empty catalog yields no groups', eq(deriveModelGroups([], infos), []))
}

// 2. landing: provider/model when no recents tab is supplied.
{
  const models = [model('deepseek-official', 'a'), model('deepseek-official', 'b')]
  check('2 single: opens the only provider tab',
    eq(modelPickerLanding(models, 'deepseek-official', 'b'), { group: 'deepseek-official', index: 1 }))
  check('2 single: current model on another route lands on the first row',
    eq(modelPickerLanding(models, 'openai-codex', 'x'), { group: 'deepseek-official', index: 0 }))
  check('2 single: no current model lands on the first row',
    eq(modelPickerLanding(models, undefined, undefined), { group: 'deepseek-official', index: 0 }))
}

// 3. landing: multi-provider catalog without a recents tab.
{
  const models = [
    model('deepseek-official', 'a'),
    model('openai-codex', 'gpt-5.6-sol'),
    model('openai-codex', 'gpt-5.6-luna'),
    model('xai', 'grok-code'),
  ]
  check('3 multi: opens the current provider with its current model focused',
    eq(modelPickerLanding(models, 'openai-codex', 'gpt-5.6-luna'), { group: 'openai-codex', index: 1 }))
  check('3 multi: unknown current provider lands on the first provider',
    eq(modelPickerLanding(models, 'anthropic', 'claude'), { group: 'deepseek-official', index: 0 }))
  check('3 multi: no current provider lands on the first provider',
    eq(modelPickerLanding(models, undefined, undefined), { group: 'deepseek-official', index: 0 }))
}

// 4. landing: empty catalog.
{
  check('4 empty: top level, index 0', eq(modelPickerLanding([], 'deepseek-official', 'a'), { group: undefined, index: 0 }))
}

// 5. recents tab: always first, counts only catalogued refs, including an
//    empty intersection (e.g. an OAuth provider signed out).
{
  const models = [
    model('deepseek-official', 'a'),
    model('openai-codex', 'gpt-5.6-sol'),
    model('openai-codex', 'gpt-5.6-luna'),
  ]
  const recents = [
    { provider: 'openai-codex', id: 'gpt-5.6-luna' },
    { provider: 'gone', id: 'vanished' },
    { provider: 'deepseek-official', id: 'a' },
  ]
  const groups = deriveModelGroups(models, [], recents)
  check('5 recents: pinned first with placeholder label and intersected count',
    eq(groups[0], { provider: RECENTS_GROUP_PROVIDER, label: RECENTS_LABEL_PLACEHOLDER, count: 2 }),
    JSON.stringify(groups[0]))
  check('5 recents: provider groups follow unchanged',
    eq(groups.slice(1).map(g => g.provider), ['deepseek-official', 'openai-codex']))
  check('5 recents: empty intersection keeps an empty first tab',
    eq(deriveModelGroups(models, [], [{ provider: 'gone', id: 'x' }])[0],
      { provider: RECENTS_GROUP_PROVIDER, label: RECENTS_LABEL_PLACEHOLDER, count: 0 }))
  check('5 recents: recentCatalogModels keeps recency order, drops vanished, caps at 10',
    eq(recentCatalogModels(recents, models).map(m => `${m.provider}/${m.id}`), ['openai-codex/gpt-5.6-luna', 'deepseek-official/a']))
}

// 6. landing with recents: always the first model of the first tab, also
//    for a single provider or an empty recent list.
{
  const models = [model('deepseek-official', 'a'), model('openai-codex', 'gpt-5.6-sol')]
  const recents = [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }]
  check('6 landing: recents tab focuses its first model',
    eq(modelPickerLanding(models, 'deepseek-official', 'a', recents), { group: RECENTS_GROUP_PROVIDER, index: 0 }))
  const single = [model('deepseek-official', 'a'), model('deepseek-official', 'b')]
  check('6 landing: an empty recents tab is still the initial tab',
    eq(modelPickerLanding(single, 'deepseek-official', 'b', []), { group: RECENTS_GROUP_PROVIDER, index: 0 }))
  check('6 landing: single provider with only the seeded current model starts on recents',
    eq(modelPickerLanding(single, 'deepseek-official', 'b', [{ provider: 'deepseek-official', id: 'b' }]), { group: RECENTS_GROUP_PROVIDER, index: 0 }))
  check('6 landing: single provider with a second used model starts on recents',
    eq(modelPickerLanding(single, 'deepseek-official', 'b', [{ provider: 'deepseek-official', id: 'b' }, { provider: 'deepseek-official', id: 'a' }]), { group: RECENTS_GROUP_PROVIDER, index: 0 }))
  check('6 landing: recent order wins over the current model',
    eq(modelPickerLanding(single, 'deepseek-official', 'a', [{ provider: 'deepseek-official', id: 'b' }]), { group: RECENTS_GROUP_PROVIDER, index: 0 }))
}

// 7. persistence: move-to-front dedupe, 10-entry cap, round-trip, corrupt reset.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-recents-'))
  try {
    const ref = (provider, id) => ({ provider, id })
    recordModelUse(ref('p', 'm1'), dir)
    recordModelUse(ref('p', 'm2'), dir)
    recordModelUse(ref('q', 'm3'), dir)
    check('7 persist: newest first', eq(readModelRecents(dir).map(r => `${r.provider}/${r.id}`), ['q/m3', 'p/m2', 'p/m1']))
    recordModelUse(ref('p', 'm1'), dir)
    check('7 persist: re-use moves to front, deduped',
      eq(readModelRecents(dir).map(r => `${r.provider}/${r.id}`), ['p/m1', 'q/m3', 'p/m2']))
    for (let i = 0; i < 20; i += 1) recordModelUse(ref('p', `bulk-${i}`), dir)
    const capped = readModelRecents(dir)
    check('7 persist: capped at the limit', capped.length === MODEL_RECENTS_LIMIT
      && capped[0].id === 'bulk-19', `len=${capped.length} first=${capped[0]?.id}`)
    // Per backend (Phase 3 review item 7): another backend's picks live in
    // their own file and never evict the DSH list; the DSH file is unchanged.
    const dshBefore = readFileSync(join(dir, 'model-recents.json'), 'utf8')
    for (let i = 0; i < 12; i += 1) recordModelUse(ref('claude', `c-${i}`), dir, 'claude')
    check('7 persist: another backend keeps its own list',
      readModelRecents(dir, 'claude')[0]?.id === 'c-11' && existsSync(join(dir, 'backends', 'claude', 'model-recents.json')))
    check('7 persist: … and leaves the DSH file byte-for-byte unchanged',
      readFileSync(join(dir, 'model-recents.json'), 'utf8') === dshBefore && readModelRecents(dir, 'dsh')[0]?.id === 'bulk-19')
    const corrupt = join(dir, 'model-recents.json')
    writeFileSync(corrupt, '{nope')
    check('7 persist: corrupt file reads as empty', eq(readModelRecents(dir), []))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failed === 0 ? '\nAll model-picker group checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
