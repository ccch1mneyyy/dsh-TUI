/**
 * Preset-patch rows and side-branch attribution:
 *  1. registerBundledPresets applies preset-patch rows (src/preset-patch.ts)
 *     to the upstream presets it registers — rows nested in groups included,
 *     other rows and the parsed input untouched — merges several rows for one
 *     preset, passes liangshen's as include patches, skips disabled rows and
 *     profile-declared presets, and warns on unknown rows, unknown presets or
 *     malformed rows;
 *  2. without preset-patch rows every definition is registered unchanged;
 *  3. runAsSideBranch runs the side call under a seeded fork of the agent
 *     (stable id per parent surface, the branch id on `session.id` with the
 *     parent header kept by design, methods still bound to the real session)
 *     and falls back to a plain call when the agents service is absent or its
 *     scope throws.
 * Run: node --import tsx/esm scripts/verify-preset-patch.ts
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerBundledPresets } from '../src/dsh-adapter/bundled-presets.js'
import { runAsSideBranch } from '../src/dsh-adapter/sideQuestion.js'
import { PRESET_PATCH_MODULE } from '../src/preset-patch.js'

type Row = { id?: string; name?: string; group?: boolean; config?: unknown }
type Definition = { id: string; plugins: Row[] }
type Entry = { disabled: boolean; options: { name?: string; config?: unknown } }

function walk(rows: readonly Row[]): Row[] {
  return rows.flatMap(row => [row, ...(row.group === true && Array.isArray(row.config) ? walk(row.config as Row[]) : [])])
}

async function register(entries: Entry[]): Promise<{ defs: Map<string, Definition>; warnings: string[] }> {
  const defs = new Map<string, Definition>()
  const warnings: string[] = []
  const ctx = {
    baseUrl: import.meta.url,
    logger: { warn: (message: string) => warnings.push(message) },
    extend() { return ctx },
    effect() {},
    inject() { throw new Error('agentPresets is present') },
    get(key: string) {
      if (key === 'loader') return { entries: () => entries }
      if (key === 'agentPresets') return { register: async (definition: Definition) => { defs.set(definition.id, definition); return async () => {} } }
      return undefined
    },
  }
  assert.equal(await registerBundledPresets(ctx as never), true)
  return { defs, warnings }
}

const marker = (config: unknown, disabled = false): Entry => ({ disabled, options: { name: PRESET_PATCH_MODULE, config } })
const compaction = (definition: Definition | undefined): Row | undefined =>
  walk(definition?.plugins ?? []).find(row => row.name === '@deepseek-ai/dsh-compaction-basic')

// 2. baseline
const baseline = await register([])
assert.deepEqual([...baseline.defs.keys()].sort(), ['cordis', 'liangshen', 'minimal', 'ptc', 'standard'])
assert.equal(compaction(baseline.defs.get('standard'))?.config, undefined)
assert.deepEqual((baseline.defs.get('liangshen')!.plugins[0]!.config as { patches: unknown }).patches, [])
assert.deepEqual(baseline.warnings, [])

// 1. patches
const patched = await register([
  marker({ preset: 'standard', config: { 'compaction-basic': { auto: false } } }),
  marker({ preset: 'standard', config: { 'tool-result-pruner': { thresholdChars: 1 } } }),
  marker({ preset: 'ptc', config: { 'compaction-basic': { auto: true } } }, true),
  marker({ preset: 'liangshen', config: { 'compaction-basic': { auto: false } } }),
  marker({ preset: 'cordis', config: { 'no-such-row': {} } }),
  marker({ preset: 'minimal', config: { 'compaction-basic': { auto: false } } }),
  marker({ preset: 'no-such-preset', config: { 'compaction-basic': { auto: false } } }),
  marker({ preset: 'standard' }),
  { disabled: false, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'minimal' } } },
])
const standard = patched.defs.get('standard')!
assert.deepEqual(compaction(standard)?.config, { auto: false }, 'nested compaction-basic row patched')
assert.deepEqual(walk(standard.plugins).find(row => row.id === 'tool-result-pruner')?.config, { thresholdChars: 1 }, 'second row for the same preset merged')
assert.equal(compaction(baseline.defs.get('standard'))?.config, undefined, 'a later registration does not leak into an earlier one')
const unchanged = (definition: Definition) => JSON.stringify(walk(definition.plugins).filter(row => row.group !== true && row.id !== 'compaction-basic' && row.id !== 'tool-result-pruner'))
assert.equal(unchanged(standard), unchanged(baseline.defs.get('standard')!), 'other standard rows unchanged')
assert.equal(compaction(patched.defs.get('ptc'))?.config, undefined, 'disabled row ignored')
assert.equal(patched.defs.has('minimal'), false, 'profile-declared preset is not registered here')
assert.deepEqual((patched.defs.get('liangshen')!.plugins[0]!.config as { patches: unknown }).patches, [{ id: 'compaction-basic', config: { auto: false } }])
assert.ok(patched.warnings.some(warning => warning.includes('"no-such-row"') && warning.includes('"cordis"')), 'unknown row warned')
assert.ok(patched.warnings.some(warning => warning.includes('without `preset`')), 'malformed row warned')
const unknownPreset = (preset: string): boolean =>
  patched.warnings.some(warning => warning.includes('does not register') && warning.includes(`"${preset}"`))
assert.ok(unknownPreset('no-such-preset'), 'unknown preset warned')
// Registered and profile-declared presets keep quiet: a declared preset's
// patch is inert by contract, not a typo.
for (const preset of ['standard', 'ptc', 'minimal', 'cordis', 'liangshen']) {
  assert.ok(!unknownPreset(preset), `no unknown-preset warning for ${preset}`)
}

// 3. side branch
const store = new AsyncLocalStorage<unknown>()
const agents = { withInitiator: <T>(agent: unknown, operation: () => T): T => store.run(agent, operation) }
class FakeSession {
  readonly #config = { provider: 'deepseek', model: 'deepseek-flash' }
  readonly header = { id: 'parent', cwd: '/work' }
  surface = { nodes: [1, 5, 9], replaceGeneration: 2 }
  get id() { return 'parent' }
  requestHeader() { return { config: this.#config } }
}
const session = new FakeSession()
const agent = { session } as never
type Seen = { id: string; header: { parentSession: string; isSeeded: boolean; cwd: string }; model: string }
const observe = () => runAsSideBranch(agents, agent, async (): Promise<Seen> => {
  await new Promise(resolve => setTimeout(resolve, 1))
  const branch = (store.getStore() as { session: FakeSession }).session
  return { id: branch.id, header: branch.header as Seen['header'], model: branch.requestHeader().config.model }
})
const first = await observe()
assert.equal(first.id, 'parent-btw-2-9')
// Pin the deviation on purpose: the branch identity is `session.id`; header.id
// keeps the parent's (see runAsSideBranch before "fixing" this to the branch id).
assert.deepEqual(first.header, { id: 'parent', cwd: '/work', parentSession: 'parent', isSeeded: true })
assert.equal(first.model, 'deepseek-flash', 'methods stay bound to the real session')
assert.equal((await observe()).id, first.id, 'same parent surface → same branch')
session.surface = { nodes: [1, 5, 9, 12], replaceGeneration: 2 }
assert.equal((await observe()).id, 'parent-btw-2-12', 'parent progress → new branch')
assert.equal(session.id, 'parent')
assert.equal(await runAsSideBranch(undefined, agent, async () => store.getStore()), undefined, 'no agents service → plain call')
const closing = { withInitiator: () => { throw new Error('initiator scope disposed') } }
assert.equal(await runAsSideBranch(closing, agent, async () => 'ran'), 'ran', 'closing scope → plain call')

console.log('verify:preset-patch OK')
