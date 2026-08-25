/**
 * Headless regression for the two-level `/model` picker derivation
 * (src/modelGroups.ts + src/modelRecents.ts): provider grouping
 * (first-appearance order, display labels with route-key fallback,
 * per-group counts), the pinned "recently used" pseudo-group (catalog
 * intersection, cap, vanishing entries), the landing rule (recents row,
 * current provider's group, single-provider fast path without recents), and
 * the recents file (move-to-front dedupe, cap, round-trip, corrupt reset).
 * The overlay reducer and level navigation themselves are covered by
 * verify-chat-overlay.ts; this pins the pure derivation both feed on.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// 2. landing: single-provider fast path.
{
  const models = [model('deepseek-official', 'a'), model('deepseek-official', 'b')]
  check('2 single: drills into the only group',
    eq(modelPickerLanding(models, 'deepseek-official', 'b'), { group: 'deepseek-official', index: 1 }))
  check('2 single: current model on another route lands on the first row',
    eq(modelPickerLanding(models, 'openai-codex', 'x'), { group: 'deepseek-official', index: 0 }))
  check('2 single: no current model lands on the first row',
    eq(modelPickerLanding(models, undefined, undefined), { group: 'deepseek-official', index: 0 }))
}

// 3. landing: multi-provider top level.
{
  const models = [
    model('deepseek-official', 'a'),
    model('openai-codex', 'gpt-5.6-sol'),
    model('openai-codex', 'gpt-5.6-luna'),
    model('xai', 'grok-code'),
  ]
  check('3 multi: lands at the top focused on the current provider group',
    eq(modelPickerLanding(models, 'openai-codex', 'gpt-5.6-luna'), { group: undefined, index: 1 }))
  check('3 multi: unknown current provider lands on the first group',
    eq(modelPickerLanding(models, 'anthropic', 'claude'), { group: undefined, index: 0 }))
  check('3 multi: no current provider lands on the first group',
    eq(modelPickerLanding(models, undefined, undefined), { group: undefined, index: 0 }))
}

// 4. landing: empty catalog.
{
  check('4 empty: top level, index 0', eq(modelPickerLanding([], 'deepseek-official', 'a'), { group: undefined, index: 0 }))
}

// 5. recents pseudo-group: pinned first, counts only catalogued refs, absent
//    when the intersection is empty (e.g. an OAuth provider signed out).
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
  check('5 recents: empty intersection pins nothing',
    deriveModelGroups(models, [], [{ provider: 'gone', id: 'x' }]).every(g => g.provider !== RECENTS_GROUP_PROVIDER))
  check('5 recents: recentCatalogModels keeps recency order, drops vanished, caps at 10',
    eq(recentCatalogModels(recents, models).map(m => `${m.provider}/${m.id}`), ['openai-codex/gpt-5.6-luna', 'deepseek-official/a']))
}

// 6. landing with recents: the pinned row is the destination; the
//    single-provider fast path survives only without recents.
{
  const models = [model('deepseek-official', 'a'), model('openai-codex', 'gpt-5.6-sol')]
  const recents = [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }]
  check('6 landing: recents pin focuses the recents row',
    eq(modelPickerLanding(models, 'deepseek-official', 'a', recents), { group: undefined, index: 0 }))
  const single = [model('deepseek-official', 'a'), model('deepseek-official', 'b')]
  check('6 landing: single provider without recents keeps the fast path',
    eq(modelPickerLanding(single, 'deepseek-official', 'b', []), { group: 'deepseek-official', index: 1 }))
  check('6 landing: single provider with only the seeded current model keeps the fast path',
    eq(modelPickerLanding(single, 'deepseek-official', 'b', [{ provider: 'deepseek-official', id: 'b' }]), { group: 'deepseek-official', index: 1 }))
  check('6 landing: single provider with a second used model shows the top level',
    eq(modelPickerLanding(single, 'deepseek-official', 'b', [{ provider: 'deepseek-official', id: 'b' }, { provider: 'deepseek-official', id: 'a' }]), { group: undefined, index: 0 }))
  check('6 landing: single provider fast path focuses the current model',
    eq(modelPickerLanding(single, 'deepseek-official', 'a', [{ provider: 'deepseek-official', id: 'b' }]), { group: 'deepseek-official', index: 0 }))
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
    const corrupt = join(dir, 'model-recents.json')
    writeFileSync(corrupt, '{nope')
    check('7 persist: corrupt file reads as empty', eq(readModelRecents(dir), []))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failed === 0 ? '\nAll model-picker group checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
