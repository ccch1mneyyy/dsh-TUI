/**
 * Settings single-source contract (src/settings/definitions.ts):
 * - every /settings field in dsh-adapter/plugin.ts takes its static part
 *   from a definition (settingField(key)), and every definition is used;
 * - the editable Config keys derived from the definitions are Config fields
 *   and still include every key of the hand-written list they replaced;
 * - every setting that decides the header splash art opens its hint with the
 *   frozen short core (`companion.skin` owns the slot, `whaleGirl` only takes
 *   effect under it, `whale` paints the header art), so the precedence is
 *   readable from the row itself and can never drift back to the wording the
 *   pre-change hints used — a substring check was satisfied by that wording
 *   and by a semantically inverted sentence (independent review A-F2);
 * - scripts/gen-settings-json.mjs validates the definitions (both
 *   languages, option labels, sorted keys) against the compiled lib.
 * Run: node --import tsx/esm scripts/verify-settings-definitions.ts
 * (after pnpm compile — the generator reads lib/).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/dsh-adapter/index.js'
import { EDITABLE_CONFIG_KEYS, SETTING_DEFINITIONS, SETTING_GROUPS } from '../src/settings/definitions.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const plugin = readFileSync(`${root}src/dsh-adapter/plugin.ts`, 'utf8')

const used = new Set([...plugin.matchAll(/settingField\('([^']+)'\)/g)].map(match => match[1]!))
const defined = new Set(Object.keys(SETTING_DEFINITIONS))
assert.deepEqual([...used].filter(key => !defined.has(key)), [], 'every settingField(key) in plugin.ts has a definition')
assert.deepEqual([...defined].filter(key => !used.has(key)), [], 'every definition is registered as a /settings field')
assert.doesNotMatch(plugin, /\n\s+path: \['(?!shortcuts)[^']+'\],\n\s+label:/, 'plugin.ts fields take label/hint from definitions, not inline')

for (const key of EDITABLE_CONFIG_KEYS) {
  if (key === 'recapOnOpen') continue // read straight from the settings namespace; no Config field
  assert.ok(Config.dict?.[key] !== undefined, `editable key ${key} is a Config field`)
}
// The hand-written list this derivation replaced: every key in it must stay
// editable (a key may only leave this list together with its setting).
// `latexMath` was renamed to `mathRendering` upstream (#1095); the old key stays
// in the Config schema as a deprecated non-UI layer and is no longer editable.
const PREVIOUSLY_EDITABLE = [
  'diffLayout', 'thinkingFold', 'toolBackground', 'scrollGutter', 'pageMargin',
  'foldTerminalCommand', 'promptSessionLabel', 'expandEditor', 'smoothStreaming',
  'mermaidDiagrams', 'mathRendering', 'effortDefault', 'statusBar', 'whale', 'whaleIdle', 'whaleGirl', 'splashFont', 'minimal',
  'lang', 'fullscreen', 'terminalImages', 'shortcuts',
]
assert.deepEqual(PREVIOUSLY_EDITABLE.filter(key => !EDITABLE_CONFIG_KEYS.includes(key)), [], 'every previously editable key is still editable')

// Groups are the /settings topics: a field may only name a declared group,
// every declared group must hold at least one field (an empty group is dead
// UI), and the formula settings sit together behind one entry.
const groupIds = SETTING_GROUPS.map(group => group.id)
assert.equal(new Set(groupIds).size, groupIds.length, 'group ids are unique')
const grouped = Object.entries(SETTING_DEFINITIONS).filter(([, definition]) => definition.group !== undefined)
assert.deepEqual([...new Set(grouped.map(([, definition]) => definition.group))].filter(id => !groupIds.includes(id!)), [],
  'every definition group names a declared SETTING_GROUPS entry')
// The shortcut remaps are declared in plugin.ts, not in the definitions file,
// so a declared group may legitimately be filled from there. (Not every
// declared group is checked for content: sections registered by plugins carry
// their own fields and are not visible here.)
assert.deepEqual(
  ['mathRendering', 'mathImageScale', 'mathImageBacking'].map(key => SETTING_DEFINITIONS[key as keyof typeof SETTING_DEFINITIONS].group),
  ['math', 'math', 'math'],
  'the formula settings sit together on the Formula subpage',
)
// Root-page presentation: shallow topics render inline under a header (no
// navigation round-trip), deep domains keep a subpage. Every group declares
// which it is, and the Formula page is a product decision — a dedicated
// subpage for the formula settings was asked for explicitly.
assert.deepEqual(SETTING_GROUPS.filter(group => group.mode !== 'inline' && group.mode !== 'page').map(group => group.id), [],
  'every group declares a root-page presentation (inline|page)')
assert.equal(SETTING_GROUPS.find(group => group.id === 'math')?.mode, 'page',
  'the Formula group keeps its dedicated subpage')
// Every built-in setting still names a group, so the root page keeps its
// topic headers and nothing regresses to an unlabeled row.
assert.deepEqual(
  Object.entries(SETTING_DEFINITIONS).filter(([, definition]) => definition.group === undefined).map(([key]) => key),
  [],
  'every built-in setting names a group',
)

// The splash-art precedence is a contract between three settings: the companion
// skin picks the slot, the maid portrait only takes effect while the skin is
// `whale`, and the header-art row states who decides that slot. Whoever reads a
// /settings row must find that rule in that row's own hint, so each hint opens
// with the frozen short core from TASK.md («冻结表述 B v3» for the first two,
// «冻结表述 D» for `whale`) — verbatim, prefix-anchored. Substring presence is
// not a contract: the pre-change wording and a semantically inverted
// `Set it to deepy …` both satisfied it (independent review A-F2). Only the
// detail sentence after the core stays free to be compressed again for the hint
// budget; no sentence length is frozen here (L-025).
type HintKey = 'companion.skin' | 'whaleGirl' | 'whale'

const SHORT_CORES: Record<HintKey, Record<'en' | 'zh', string>> = {
  'companion.skin': {
    en: 'Also picks the splash art. Set it to whale to keep the maid portrait.',
    zh: '同时决定开屏艺术槽。设为 whale 才保留女仆娘立绘。',
  },
  whaleGirl: {
    en: 'Set Companion skin to whale, not deepy/whaleGirl.',
    zh: '宠物皮肤要设为 whale，不要 deepy/whaleGirl',
  },
  whale: {
    en: 'Header art: the companion mascot, the pixel whale, or the maid portrait (Companion skin decides).',
    zh: '标题图形：宠物皮肤决定吉祥物，或像素鲸鱼／女仆娘立绘。',
  },
}

// Values the detail sentence after the core must still spell out. A value must
// appear as a whole token: a bare `whale` must not be satisfied by the
// `whaleGirl` token sitting next to it. Split instead of building a regex, so a
// value can never be read as a pattern.
const NAMED_VALUES: Record<HintKey, readonly string[]> = {
  'companion.skin': ['whale', 'whaleGirl'],
  whaleGirl: ['whale', 'deepy'],
  whale: [],
}

for (const key of Object.keys(SHORT_CORES) as HintKey[]) {
  for (const lang of ['en', 'zh'] as const) {
    const definition = SETTING_DEFINITIONS[key]
    const hint = (lang === 'zh' ? definition.hintDescriptions?.zh : definition.hint) ?? ''
    const label = lang === 'zh' ? `${key} hintDescriptions.zh` : `${key} hint`
    assert.notEqual(hint, '', `${label} is present`)
    assert.ok(hint.startsWith(SHORT_CORES[key][lang]),
      `${label} opens with the frozen short core ${JSON.stringify(SHORT_CORES[key][lang])}: ${JSON.stringify(hint)}`)
    for (const value of NAMED_VALUES[key]) {
      assert.ok(hint.split(/[^A-Za-z0-9_]+/).includes(value), `${label} names the value ${value}: ${JSON.stringify(hint)}`)
    }
  }
}

const generated = spawnSync(process.execPath, [`${root}scripts/gen-settings-json.mjs`, '--check'], { encoding: 'utf8' })
assert.equal(generated.status, 0, `settings.json generation fails:\n${generated.stderr}`)

console.log(`settings definitions verified: ${defined.size} definitions, all registered, editable keys intact, ${generated.stdout.trim()}`)
