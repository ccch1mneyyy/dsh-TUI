/**
 * Settings single-source contract (src/settings/definitions.ts):
 * - every /settings field in dsh-adapter/plugin.ts takes its static part
 *   from a definition (settingField(key)), and every definition is used;
 * - the editable Config keys derived from the definitions are Config fields
 *   and still include every key of the hand-written list they replaced;
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
import { EDITABLE_CONFIG_KEYS, SETTING_DEFINITIONS } from '../src/settings/definitions.js'

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

const generated = spawnSync(process.execPath, [`${root}scripts/gen-settings-json.mjs`, '--check'], { encoding: 'utf8' })
assert.equal(generated.status, 0, `settings.json generation fails:\n${generated.stderr}`)

console.log(`settings definitions verified: ${defined.size} definitions, all registered, editable keys intact, ${generated.stdout.trim()}`)
