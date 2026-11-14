/**
 * The D-1 assembly point (src/dsh-adapter/backend-assembly.ts) on a real Cordis
 * composition: the bundles a profile declares in `dsh.profile.bundles` become
 * registry entries — admitted, registered and offered to the picker — without any
 * bundle row activating, and before backend-choice membership is checked.
 *
 * The cases pin the three admission states that reach the registry, the refusal
 * policy (loud, attributable to its bundle, contained), the resolution rule #1568
 * established (the Loader's own resolver, and a refusal to guess without it), the
 * fixed facts of a third-party entry (`inTree: false`, literal label, no
 * `alwaysAvailable` / `nativeKey` / `backendExport` of its own), the laziness of
 * the module import and of the pool hook, and the timing contract in both
 * directions: a boot that parsed first reads the installed id as unknown, so the
 * child case runs exactly that baseline.
 *
 * fake-home must load first: the effect ledger and the data dir resolve
 * `~/.dsh-tui` at import time.
 *
 * Run: node --import tsx/esm scripts/verify-backend-assembly.ts
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './lib/fake-home.mjs' // 必须最先：DATA_DIR/effect-ledger 在 import 时定死

const { Context } = await import('@deepseek-ai/cordis')
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { assembleBackendsFromProfile } = await import('../src/dsh-adapter/backend-assembly.js')
const { listBackends, listOfferedBackends, loadBackend, parseBackendChoice, unloadBackends } = await import('../src/dsh-adapter/backend-registry.js')
const { declaredBackendsIn } = await import('../src/dsh-adapter/plugin-declaration.js')
const { RUNTIME_BUNDLE } = await import('../src/dsh-adapter/market/runtime-profile.mjs')
const { kernelEntriesOf } = await import('../src/components/kernelCatalog.js')
const { assertBackendHandler } = await import('../src/adapter/spec/tui-contributions.js')
const { probeKernels } = await import('../src/dsh-adapter/backends.js')
type KernelBackendId = import('../src/kernelPrefs.js').KernelBackendId

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-backend-assembly-'))
/** The profile directory the Loader resolves specifiers against (`Context.baseUrl`). */
const profileDir = join(dir, 'profile')
const PROFILE_URL = pathToFileURL(profileDir).href + '/'
const AGENT_ID = 'example-agent'
const DEGRADED_ID = 'example-degraded-agent'
const WAITING_ID = 'example-waiting-agent'
const CLI_ID = 'example-cli-agent'
const PAIR_ID = 'example-pair'
const NO_EXPORT_ID = 'example-no-export-agent'
const BAD_UNLOAD_ID = 'example-bad-unload-agent'
const NON_ARRAY_ID = 'example-non-array-point-agent'
const BAD_CONTAINER_ID = 'example-bad-contributes-agent'
const MISMATCH_ID = 'example-mismatched-handler'

/**
 * The entry module of a fake backend bundle: the handler the registry reads (its
 * default export name is `backend`), its pool hook, and a marker file written when
 * the module is evaluated — one evaluation per instance, which is what makes
 * laziness and "one instance" observable from outside.
 */
const ENTRY = `import { writeFileSync } from 'node:fs'
let closed = 0
writeFileSync(new URL('./imported.txt', import.meta.url), '1')
export const backend = {
  id: 'entry-handler',
  detect: async () => undefined,
  open: async () => undefined,
}
export function closeDemoPool() {
  closed += 1
  writeFileSync(new URL('./closed.txt', import.meta.url), String(closed))
}
export default function plugin() {}
`
const entryOf = (id: string): string => ENTRY.replace("id: 'entry-handler'", `id: ${JSON.stringify(id)}`)

/** One contribution entry, in the declared shape (`apiVersion` + `kind` + `name` + `spec`).
 *  `name` is the contribution's *local* name: the canonical projection keys
 *  extensions by it, so two contributions in one declaration must not share one. */
function contribution(
  spec: Record<string, unknown>,
  apiVersion = 'tui.dsh/v1alpha1',
  name = 'example_backend',
): Record<string, unknown> {
  return { apiVersion, kind: 'Backend', id: 'com.example.' + String(spec.id), name, spec }
}

/** A package-root `dsh-plugin.json` whose `contributes` is exactly what the caller
 *  writes. `unknown` on purpose: one case below writes a container a declaration may
 *  not have, and only the canonical validator judges it. */
function declarationWith(contributes: unknown): string {
  return JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    manifestVersion: '0.15',
    id: 'com.example.backend-bundle',
    name: 'Backend Bundle',
    version: '0.1.0',
    facets: { host: { entry: 'main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [] },
    permissions: [],
    contributes,
    subscriptions: [],
    license: 'MIT',
    source: { repository: 'https://example.com/verify-backend-assembly' },
  }, null, 2)
}

/** A package-root `dsh-plugin.json` carrying one `x-dsh-tui` point. The point is
 *  typed `unknown` on purpose: one case below writes the shape a declaration may
 *  not have (present, but not an array), and only the canonical validator judges it. */
function declarationOf(point: unknown): string {
  return declarationWith({ commands: [], 'x-dsh-tui': point })
}

/**
 * Write one installed bundle under the profile's `node_modules`: a package.json
 * that makes it a profile layer (`dsh.bundle`), an optional declaration, and the
 * entry module. `undefined` models a bundle that is not a TUI plugin at all.
 */
function writeBundle(
  name: string,
  point: unknown,
  entry: string = ENTRY,
): string {
  const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { '.': './main.js' },
  }, null, 2))
  if (point !== undefined) writeFileSync(join(packageDir, 'dsh-plugin.json'), declarationOf(point))
  writeFileSync(join(packageDir, 'main.js'), entry)
  return packageDir
}

const DEMO = '@dsh-tui-verify/backend-demo'
const DEGRADED = '@dsh-tui-verify/backend-degraded'
const WAITING = '@dsh-tui-verify/backend-waiting'
const RESERVED = '@dsh-tui-verify/backend-reserved'
const INVALID = '@dsh-tui-verify/backend-invalid'
const WRONG_API = '@dsh-tui-verify/backend-wrong-api'
const NOT_A_PLUGIN = '@dsh-tui-verify/plain-dependency'
const CLI = '@dsh-tui-verify/backend-cli'
const PAIR = '@dsh-tui-verify/backend-pair'
const NO_EXPORT = '@dsh-tui-verify/backend-no-export'
const BAD_UNLOAD = '@dsh-tui-verify/backend-bad-unload'
const MISSING_ID = '@dsh-tui-verify/backend-missing-id'
const NON_STRING_ID = '@dsh-tui-verify/backend-non-string-id'
const NON_ARRAY = '@dsh-tui-verify/backend-non-array-point'
const BAD_CONTAINER = '@dsh-tui-verify/backend-bad-contributes'
const DUPLICATE_NAME = '@dsh-tui-verify/backend-duplicate-name'
const MISMATCH = '@dsh-tui-verify/backend-mismatched-handler'
const BAD_HANDLER = '@dsh-tui-verify/backend-bad-handler'
const ABSENT = '@dsh-tui-verify/declared-but-missing'
/** The D-5 dogfood bundle: a checked-in package written against the published
 *  surface, installed into the throwaway profile exactly as a person's install
 *  would leave it. */
const FIXTURE = '@dsh-tui-fixtures/echo-backend'
const FIXTURE_AGENT_ID = 'echo-agent'
const fixtureDir = join(profileDir, 'node_modules', ...FIXTURE.split('/'))
mkdirSync(dirname(fixtureDir), { recursive: true })
cpSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'third-party-backend'), fixtureDir, { recursive: true })

const demoDir = writeBundle(DEMO, [contribution({
  id: AGENT_ID,
  label: { text: 'Demo Agent' },
  shortLabel: 'Demo',
  product: 'demo-product',
  capabilities: ['permissions', 'models'],
  grants: [],
  install: { executor: 'pnpm-profile-add', specifier: '@example/agent-sdk@1.2.3', version: '1.2.3' },
  unloadExport: 'closeDemoPool',
})], entryOf(AGENT_ID))
const degradedDir = writeBundle(DEGRADED, [contribution({
  id: DEGRADED_ID,
  label: { text: 'Degraded Agent' },
  shortLabel: 'Degraded',
  capabilities: ['permissions', 'time-travel'],
  grants: [],
})], entryOf(DEGRADED_ID))
const waitingDir = writeBundle(WAITING, [contribution({
  id: WAITING_ID,
  label: { text: 'Waiting Agent' },
  shortLabel: 'Waiting',
  capabilities: [],
  grants: ['storage.local.read'],
})], entryOf(WAITING_ID))
writeBundle(RESERVED, [contribution({
  id: 'claude',
  label: { text: 'Impostor' },
  shortLabel: 'Impostor',
  capabilities: [],
  grants: [],
})])
writeBundle(INVALID, [{
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'Backend',
  id: 'com.example.invalid',
  name: 'example_backend',
  spec: {
    id: 'example-invalid-agent',
    label: { text: 'Invalid Agent' },
    shortLabel: 'Invalid',
    capabilities: [],
    grants: [],
    // In-tree only, and refused as an unknown field by the family validator.
    nativeKey: 'example',
  },
}])
writeBundle(WRONG_API, [contribution({
  id: 'example-future-agent',
  label: { text: 'Future Agent' },
  shortLabel: 'Future',
  capabilities: [],
  grants: [],
}, 'tui.dsh/v2alpha1')])
writeBundle(NOT_A_PLUGIN, undefined)
const cliDir = writeBundle(CLI, [contribution({
  id: CLI_ID,
  label: { text: 'CLI Agent' },
  shortLabel: 'CLI',
  capabilities: [],
  grants: [],
  unloadExport: 'closeDemoPool',
})], entryOf(CLI_ID))
const pairDir = writeBundle(PAIR, [
  contribution({ id: PAIR_ID + '-one', label: { text: 'Pair One' }, shortLabel: 'Pair', capabilities: [], grants: [] },
    'tui.dsh/v1alpha1', 'example_pair_one'),
  contribution({ id: PAIR_ID + '-two', label: { text: 'Pair Two' }, shortLabel: 'Pair', capabilities: [], grants: [] },
    'tui.dsh/v1alpha1', 'example_pair_two'),
])
const duplicateDir = writeBundle(DUPLICATE_NAME, [
  contribution({ id: 'example-duplicate-one', label: { text: 'One' }, shortLabel: 'One', capabilities: [], grants: [] }),
  contribution({ id: 'example-duplicate-two', label: { text: 'Two' }, shortLabel: 'Two', capabilities: [], grants: [] }),
])
writeBundle(MISMATCH, [contribution({
  id: MISMATCH_ID, label: { text: 'Mismatched' }, shortLabel: 'Mismatched', capabilities: [], grants: [],
  unloadExport: 'closeDemoPool',
})], entryOf('another-backend'))
writeBundle(BAD_HANDLER, [contribution({
  id: 'example-bad-handler', label: { text: 'Bad handler' }, shortLabel: 'Bad', capabilities: [], grants: [],
})], 'export const backend = { id: "example-bad-handler" }\n')
writeBundle(NO_EXPORT, [contribution({
  id: NO_EXPORT_ID,
  label: { text: 'No Export Agent' },
  shortLabel: 'No Export',
  capabilities: [],
  grants: [],
})], 'export default function plugin() {}\n')
writeBundle(BAD_UNLOAD, [contribution({
  id: BAD_UNLOAD_ID,
  label: { text: 'Bad Unload Agent' },
  shortLabel: 'Bad Unload',
  capabilities: [],
  grants: [],
  unloadExport: 'closeSomethingElse',
})], 'export const backend = { id: "entry-handler", detect: async () => undefined, open: async () => undefined }\n')
// The canonical projection (`projectManifest`'s extension loop) drops a
// contribution whose own outer `id` is not a string before it reads `spec`, so
// these two must be refused rather than registered — the counterexamples R3
// names. Their `spec` is otherwise valid on purpose: only the outer id decides.
writeBundle(MISSING_ID, [{
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'Backend',
  name: 'example_backend',
  spec: {
    id: 'example-missing-outer-id-agent',
    label: { text: 'Missing Outer Id Agent' },
    shortLabel: 'Missing Outer Id',
    capabilities: [],
    grants: [],
  },
}])
writeBundle(NON_STRING_ID, [{
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'Backend',
  id: 42,
  name: 'example_backend',
  spec: {
    id: 'example-non-string-id-agent',
    label: { text: 'Non-String Outer Id Agent' },
    shortLabel: 'Non-String Outer Id',
    capabilities: [],
    grants: [],
  },
}])
// The point is present but is not an array — the shape the canonical validator
// refuses outright (`contributes.x-dsh-tui must be an array`). Read as "nothing
// declared", this bundle's valid contribution would go missing with neither a
// registration nor a warning, so the assembly must name it instead.
const nonArrayDir = writeBundle(NON_ARRAY, contribution({
  id: NON_ARRAY_ID,
  label: { text: 'Non-Array Point Agent' },
  shortLabel: 'Non-Array Point',
  capabilities: [],
  grants: [],
}))
// One level up: `contributes` itself is present but is not an object (here an
// array, which `typeof` calls an object, so the older guard walked straight past
// it). The declaration carries a valid contribution, so silence would lose it
// exactly as the case above would.
const badContainerDir = writeBundle(BAD_CONTAINER, undefined)
writeFileSync(join(badContainerDir, 'dsh-plugin.json'), declarationWith([contribution({
  id: BAD_CONTAINER_ID,
  label: { text: 'Bad Contributes Agent' },
  shortLabel: 'Bad Contributes',
  capabilities: [],
  grants: [],
})]))

const COMPOSITION_OWNED = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', RUNTIME_BUNDLE]
const BUNDLES = [
  ...COMPOSITION_OWNED,
  FIXTURE, DEMO, DEGRADED, WAITING, RESERVED, INVALID, WRONG_API, NOT_A_PLUGIN, CLI, PAIR, NO_EXPORT, BAD_UNLOAD,
  MISSING_ID, NON_STRING_ID, NON_ARRAY, BAD_CONTAINER, ABSENT,
  DUPLICATE_NAME, MISMATCH, BAD_HANDLER,
]
/** Registered in scan order; each bundle binds at most one backend. */
const EXPECTED_REGISTERED = [
  FIXTURE_AGENT_ID, AGENT_ID, DEGRADED_ID, WAITING_ID, CLI_ID,
  NO_EXPORT_ID, BAD_UNLOAD_ID, MISMATCH_ID, 'example-bad-handler',
]
/** Bundles whose declaration announced a backend that could not become an entry. */
const EXPECTED_REFUSED = [RESERVED, INVALID, WRONG_API, PAIR, MISSING_ID, NON_STRING_ID, NON_ARRAY, BAD_CONTAINER, ABSENT, DUPLICATE_NAME]

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-verify-backend-assembly',
  private: true,
  dependencies: Object.fromEntries(BUNDLES.map(name => [name, '0.1.0'])),
  dsh: { profile: { bundles: BUNDLES, patchReload: 'live' } },
}, null, 2))

interface Composition {
  root: InstanceType<typeof Context>
  warnings: string[]
}

/** A real composition: a Loader based at the profile directory, and nothing else.
 *  No row is ever created — the assembly may not need one. */
async function mount(): Promise<Composition> {
  const root = new Context()
  const warnings: string[] = []
  root.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof root.logger.warn
  root.logger.info = () => undefined
  ;(root as { baseUrl?: string }).baseUrl = PROFILE_URL
  await root.plugin(Loader, { baseUrl: PROFILE_URL })
  return { root, warnings }
}

// ── child mode: the "assembled too late" baseline, in its own process ──────
// A boot that parses before it assembles reads an installed backend as unknown
// (dsh + a warning) — the failure the D1 contract exists to prevent. The child
// also shows the scan needs no activation: nothing is composed there either.
if (process.env.DSH_TUI_ASSEMBLY_CHILD === '1') {
  const composition = await mount()
  const report = process.env.DSH_TUI_ASSEMBLY_REPORT ?? join(dir, 'child.jsonl')
  writeFileSync(report, '')
  try {
    const parsedBefore = parseBackendChoice(AGENT_ID) ?? null
    const assembled = assembleBackendsFromProfile(composition.root)
    appendFileSync(report, JSON.stringify({
      parsedBefore,
      parsedAfter: parseBackendChoice(AGENT_ID) ?? null,
      registered: assembled.registered,
      scanned: assembled.scanned.length,
      warnings: composition.warnings.length,
      rows: [...composition.root.loader.entries()].length,
    }) + '\n')
  } finally {
    await composition.root.fiber.dispose()
  }
  process.exit(failed === 0 ? 0 : 1)
}

// ── the assembly pass, on a profile with no composed row ───────────────────
const composition = await mount()
const assembled = assembleBackendsFromProfile(composition.root)

check('assembly reads the profile manifest this boot composes',
  assembled.profile === join(profileDir, 'package.json'), String(assembled.profile))
check('assembly scans every declared bundle except the composition\'s own',
  assembled.scanned.length === BUNDLES.length - COMPOSITION_OWNED.length
  && COMPOSITION_OWNED.every(name => !assembled.scanned.includes(name)),
  JSON.stringify(assembled.scanned))
check('assembly registers the backend of every bundle that declares one',
  JSON.stringify(assembled.registered) === JSON.stringify(EXPECTED_REGISTERED),
  JSON.stringify(assembled.registered))
check('assembly refuses exactly the unjudgeable bundles, naming each',
  JSON.stringify(assembled.refused.map(refusal => refusal.bundle)) === JSON.stringify(EXPECTED_REFUSED),
  JSON.stringify(assembled.refused))
check('the refusal of a reserved id names the reserved rule, not a rival registration',
  assembled.refused.some(refusal => refusal.bundle === RESERVED && refusal.reason.includes('reserved built-in id')),
  JSON.stringify(assembled.refused))
check('a declaration the family validator cannot read is refused, never silently dropped',
  assembled.refused.some(refusal => refusal.bundle === INVALID && refusal.reason.includes('nativeKey')),
  JSON.stringify(assembled.refused))
check('a declaration of another apiVersion is not read as this host\'s Backend',
  assembled.refused.some(refusal => refusal.bundle === WRONG_API && refusal.reason.includes('v2alpha1')),
  JSON.stringify(assembled.refused))
check('a declared bundle that is not installed is reported, not ignored',
  assembled.refused.some(refusal => refusal.bundle === ABSENT && refusal.reason.includes('entry module')),
  JSON.stringify(assembled.refused))
check('a contribution with no outer id registers nothing: the canonical projection drops it',
  assembled.refused.some(refusal => refusal.bundle === MISSING_ID && refusal.reason.includes("['x-dsh-tui'][0].id"))
  && !assembled.registered.includes('example-missing-outer-id-agent'),
  JSON.stringify(assembled.refused.filter(refusal => refusal.bundle === MISSING_ID)))
check('a contribution with a non-string outer id registers nothing either',
  assembled.refused.some(refusal => refusal.bundle === NON_STRING_ID && refusal.reason.includes("['x-dsh-tui'][0].id"))
  && !assembled.registered.includes('example-non-string-id-agent'),
  JSON.stringify(assembled.refused.filter(refusal => refusal.bundle === NON_STRING_ID)))
check('a point that is present but not an array is a malformed declaration, not an empty one',
  assembled.refused.some(refusal => refusal.bundle === NON_ARRAY && refusal.reason.includes('must be an array'))
  && !assembled.registered.includes(NON_ARRAY_ID),
  JSON.stringify(assembled.refused.filter(refusal => refusal.bundle === NON_ARRAY)))
check('a contributes that is not an object is a malformed declaration too',
  assembled.refused.some(refusal => refusal.bundle === BAD_CONTAINER && refusal.reason.includes('contributes must be an object'))
  && !assembled.registered.includes(BAD_CONTAINER_ID),
  JSON.stringify(assembled.refused.filter(refusal => refusal.bundle === BAD_CONTAINER)))
check('a bundle that is not a TUI plugin is scanned and passed over in silence',
  assembled.refused.every(refusal => refusal.bundle !== NOT_A_PLUGIN))
check('one fixed backend export cannot register multiple backend identities',
  assembled.refused.some(refusal => refusal.bundle === PAIR && refusal.reason.includes('one Backend'))
  && !assembled.registered.some(id => id.startsWith(PAIR_ID))
  && !existsSync(join(pairDir, 'imported.txt')))
check('canonical duplicate contribution identities refuse the bundle before registration',
  assembled.refused.some(refusal => refusal.bundle === DUPLICATE_NAME && refusal.reason.includes('duplicate extension'))
  && !assembled.registered.some(id => id.startsWith('example-duplicate-'))
  && !existsSync(join(duplicateDir, 'imported.txt')))
check('every refusal is attributable to its bundle and warned about once',
  assembled.refused.every(refusal => BUNDLES.includes(refusal.bundle) && refusal.reason !== '')
  && composition.warnings.length === assembled.refused.length
  && composition.warnings.every(line => line.includes('was not registered')),
  JSON.stringify(composition.warnings))

// ── the third-party entry the registry holds ───────────────────────────────
const registered = listBackends().find(entry => entry.id === AGENT_ID)
check('the declared backend is in the registry', registered !== undefined)
check('a contribution is projected as out-of-tree', registered?.manifest.inTree === false)
check('a contribution keeps its literal label, its short label and its product',
  registered?.manifest.label.kind === 'literal' && registered.manifest.label.text === 'Demo Agent'
  && registered.manifest.shortLabel === 'Demo' && registered.manifest.product === 'demo-product',
  JSON.stringify(registered?.manifest.label))
check('a contribution carries no in-tree-only fact and no backendExport of its own',
  registered?.manifest.alwaysAvailable === undefined && registered.manifest.nativeKey === undefined
  && registered.manifest.vendorPackages === undefined && registered.manifest.backendExport === undefined)
check('a declared install recipe is installable through the host\'s executor table',
  registered?.installable === true)
const cliEntry = listBackends().find(entry => entry.id === CLI_ID)
check('a declaration without an install recipe reads as "nothing to install", not as refused',
  cliEntry !== undefined && cliEntry.installable === false)

// ── the admission states, on the assembly path ─────────────────────────────
check('a clean declaration is compatible and reaches the picker',
  registered?.admission.decision === 'compatible'
  && listOfferedBackends().some(entry => entry.id === AGENT_ID))
const degraded = listBackends().find(entry => entry.id === DEGRADED_ID)
check('an unknown capability degrades the admission and still reaches the picker',
  degraded?.admission.decision === 'compatible_degraded'
  && listOfferedBackends().some(entry => entry.id === DEGRADED_ID)
  && (degraded.admission.decision === 'compatible_degraded' ? degraded.admission.missingOptional : []).includes('capability:time-travel'),
  JSON.stringify(degraded?.admission))
const waiting = listBackends().find(entry => entry.id === WAITING_ID)
check('a known but ungranted permission registers the backend without offering it',
  waiting?.admission.decision === 'waiting_authorization'
  && waiting.admission.decision === 'waiting_authorization' && waiting.admission.reasonCode === 'PERMISSION_NOT_GRANTED'
  && !listOfferedBackends().some(entry => entry.id === WAITING_ID)
  && parseBackendChoice(WAITING_ID) === WAITING_ID,
  JSON.stringify(waiting?.admission))
check('every registered third-party id is the second half of the parse',
  EXPECTED_REGISTERED.every(id => parseBackendChoice(id) === id))

// ── the picker projection ──────────────────────────────────────────────────
const rows = kernelEntriesOf(listOfferedBackends())
const row = rows.find(candidate => candidate.id === AGENT_ID)
check('the picker row carries the declared label, product and installability',
  row !== undefined && row.label.kind === 'literal' && row.label.text === 'Demo Agent'
  && row.shortLabel === 'Demo' && row.product === 'demo-product' && row.installable === true
  && row.alwaysAvailable === false,
  JSON.stringify(row))
check('an entry that waits for authorization has no picker row',
  !rows.some(candidate => candidate.id === WAITING_ID))

// ── the implementation outlet: one module, imported once, only if selected ──
const importedAt = (packageDir: string): boolean => existsSync(join(packageDir, 'imported.txt'))
check('the module of a registered backend is not imported by the assembly itself',
  !importedAt(demoDir) && !importedAt(degradedDir) && !importedAt(cliDir))

const handler = await loadBackend(AGENT_ID as KernelBackendId)
check('the default export name of a contribution is `backend`',
  typeof (handler as { detect?: unknown }).detect === 'function' && typeof (handler as { open?: unknown }).open === 'function',
  JSON.stringify(Object.keys(handler as object)))
check('selecting the backend imports its module', importedAt(demoDir))
check('a backend nobody selected is still never imported',
  !importedAt(degradedDir) && !importedAt(cliDir))

const namespace = await composition.root.loader.internal.import(DEMO, PROFILE_URL, {}) as { backend?: unknown }
check('the Loader and the registry hand back the same module instance',
  namespace.backend !== undefined && namespace.backend === handler)

await unloadBackends()
check('the declared unloadExport closes the pool it names',
  readFileSync(join(demoDir, 'closed.txt'), 'utf8') === '1')
await unloadBackends()
check('a second unload is a no-op', readFileSync(join(demoDir, 'closed.txt'), 'utf8') === '1')
check('an entry that was never loaded never has its pool closed',
  !existsSync(join(cliDir, 'closed.txt')))

/** The registry's two load-path refusals, as the person who installed the bundle sees them. */
async function loadFailure(id: string): Promise<string> {
  try {
    await loadBackend(id as KernelBackendId)
    return ''
  } catch (error) {
    return messageOf(error)
  }
}
const noExportFailure = await loadFailure(NO_EXPORT_ID)
check('a module without the handler export fails loudly, naming the export it looked for',
  noExportFailure.includes('does not export "backend"'), noExportFailure)
const badUnloadFailure = await loadFailure(BAD_UNLOAD_ID)
check('a declared unloadExport the module does not carry fails loudly',
  badUnloadFailure.includes('closeSomethingElse'), badUnloadFailure)
const mismatchFailure = await loadFailure(MISMATCH_ID)
check('a handler with another backend id fails before it can prepare a session or data directory',
  mismatchFailure.includes(MISMATCH_ID) && mismatchFailure.includes('another-backend'), mismatchFailure)
await unloadBackends()
check('an imported module whose handler was rejected still has its pool closed',
  readFileSync(join(profileDir, 'node_modules', ...MISMATCH.split('/'), 'closed.txt'), 'utf8') === '1')
const badHandlerFailure = await loadFailure('example-bad-handler')
check('a handler missing detect/open is refused by the family assertion',
  badHandlerFailure.includes('example-bad-handler') && badHandlerFailure.includes('detect'), badHandlerFailure)

// ── the D-5 dogfood bundle, as installed ────────────────────────────────────
// The fixture is a real package on disk (scripts/fixtures/third-party-backend),
// copied into the profile untouched: whatever it gets wrong is what a community
// author would get wrong.
const fixtureEntry = listBackends().find(entry => entry.id === FIXTURE_AGENT_ID)
check('dogfood: the checked-in third-party bundle registers from its own declaration',
  fixtureEntry !== undefined && fixtureEntry.admission.decision === 'compatible',
  JSON.stringify(fixtureEntry?.admission))
check('dogfood: it reaches the picker with the literal label it declared',
  kernelEntriesOf(listOfferedBackends()).some(candidate =>
    candidate.id === FIXTURE_AGENT_ID && candidate.label.kind === 'literal'
    && candidate.label.text === 'Echo Agent' && candidate.shortLabel === 'Echo' && candidate.product === 'echo'),
  JSON.stringify(kernelEntriesOf(listOfferedBackends()).find(candidate => candidate.id === FIXTURE_AGENT_ID)))
// The fixture's own pool ledger, read through the Loader's instance of its module
// (the same instance the registry holds — asserted for the demo entry above). The
// count lives in the module, so it proves the host's unload call reached this
// very module without the regression writing any host state of its own.
const fixtureNamespace = await composition.root.loader.internal.import(FIXTURE, PROFILE_URL, {}) as {
  echoPoolCloseCount?: () => number
}
const fixturePoolCloses = (): number =>
  typeof fixtureNamespace.echoPoolCloseCount === 'function' ? fixtureNamespace.echoPoolCloseCount() : -1
await unloadBackends()
check('dogfood: an unload pass never closes the pool of a backend it did not load',
  fixturePoolCloses() === 0, String(fixturePoolCloses()))
const fixtureHandler = await loadBackend(FIXTURE_AGENT_ID as KernelBackendId)
check('dogfood: loading the backend does not close its declared pool',
  fixturePoolCloses() === 0, String(fixturePoolCloses()))
check('dogfood: the module it exports under `backend` passes the family\'s own handler assertion',
  (() => {
    try {
      assertBackendHandler(fixtureHandler)
      return true
    } catch {
      return false
    }
  })(), JSON.stringify(Object.keys(fixtureHandler as object)))
check('dogfood: detection answers instead of throwing, and reports what the fixture really is',
  await (fixtureHandler as { detect: () => Promise<{ installed: boolean; hint?: string }> }).detect()
    .then(detection => detection.installed === false && typeof detection.hint === 'string', () => false))
check('dogfood: the declaration names, in spec.unloadExport, the pool hook the module carries',
  fixtureEntry?.manifest.unloadExport === 'closeEchoPool'
  && typeof fixtureNamespace.echoPoolCloseCount === 'function',
  JSON.stringify(fixtureEntry?.manifest.unloadExport))
await unloadBackends()
check('dogfood: the declared unloadExport closes the fixture\'s pool exactly once',
  fixturePoolCloses() === 1, String(fixturePoolCloses()))
await unloadBackends()
check('dogfood: a second unload does not close the fixture\'s pool again',
  fixturePoolCloses() === 1, String(fixturePoolCloses()))

// ── the canonical projection is the measuring stick for the outer id (R3) ───
// `declaredBackendsOf` may never register a contribution the standard projection
// drops. Its authority here is `@dsh-std/manifest`'s `projectManifest`, whose
// extension loop requires the contribution's own `apiVersion`, `kind`, `id` and
// `name` to be strings before it copies `spec`. Each case reads one declaration
// through both readers, so the expected answer comes from the projection rather
// than from the helper under test.
const { projectManifest } = await import('@dsh-std/manifest')

/** The local names of the `Backend` contributions the canonical projection keeps
 *  from one declaration. `undefined` when the projection itself rejects the
 *  declaration — a duplicate extension key is one such rejection. */
function projectedBackendNames(source: string): string[] | undefined {
  try {
    const projected = projectManifest(JSON.parse(source)) as {
      spec: { facets: readonly { name: string; extensions?: readonly { apiVersion: string; kind: string; metadata: { name: string } }[] }[] }
    }
    const host = projected.spec.facets.find(facet => facet.name === 'host')
    return (host?.extensions ?? [])
      .filter(extension => extension.apiVersion === 'tui.dsh/v1alpha1' && extension.kind === 'Backend')
      .map(extension => extension.metadata.name)
  } catch {
    return undefined
  }
}

/** A `spec` the family validator accepts, so only the outer id can decide. */
function validSpec(id: string): Record<string, unknown> {
  return { id, label: { text: 'Projected Agent' }, shortLabel: 'Projected', capabilities: [], grants: [] }
}

const idGateCases: readonly { readonly what: string; readonly entry: Record<string, unknown> }[] = [
  {
    what: 'no outer id at all',
    entry: { apiVersion: 'tui.dsh/v1alpha1', kind: 'Backend', name: 'example_backend', spec: validSpec('example-no-id-agent') },
  },
  {
    what: 'a non-string outer id',
    entry: { apiVersion: 'tui.dsh/v1alpha1', kind: 'Backend', id: 42, name: 'example_backend', spec: validSpec('example-number-id-agent') },
  },
]
for (const { what, entry } of idGateCases) {
  const source = declarationOf([entry])
  const read = declaredBackendsIn(source)
  const projected = projectedBackendNames(source)
  check(`a contribution with ${what} is dropped by the canonical projection, and this reader refuses it too`,
    projected?.length === 0 && read.backends.length === 0 && read.problems.length === 1,
    JSON.stringify({ projected, read: read.backends.map(backend => backend.spec.id), problems: read.problems }))
}

// The measuring stick for the point's own shape: the standard validator refuses a
// present-but-not-array `x-*` point, so a declaration this reader reports must be
// one the canonical projection rejects as a whole.
const nonArraySource = readFileSync(join(nonArrayDir, 'dsh-plugin.json'), 'utf8')
const nonArrayRead = declaredBackendsIn(nonArraySource)
check('a present, non-array point is refused by the canonical projection, and this reader reports it',
  projectedBackendNames(nonArraySource) === undefined
  && nonArrayRead.backends.length === 0 && nonArrayRead.problems.length === 1
  && (nonArrayRead.problems[0]?.includes('must be an array') ?? false),
  JSON.stringify({ projected: projectedBackendNames(nonArraySource), problems: nonArrayRead.problems }))

// The container every shape above needs: an absent `contributes` declares nothing
// (a package that contributes no TUI row at all), while a present one that is
// `null`, a primitive or an array is malformed, which is what the standard
// validator says by rejecting the whole manifest. `undefined` serializes to no
// field at all, which is how a declaration without a container looks on disk.
// Absence stays silent here on purpose, and the projection is deliberately not
// asked about it: the standard validator wants the key (a v0.15 manifest declares
// its contributions), but a declaration that names no point cannot hide a backend
// — it is the admission path's business whether the manifest is complete, and this
// reader's only question is which backends the file claims.
const absentContributes = declaredBackendsIn(declarationWith(undefined))
check('an absent contributes is the normal "declares nothing" answer, not a problem',
  absentContributes.backends.length === 0 && absentContributes.problems.length === 0,
  JSON.stringify(absentContributes))
for (const [what, contributes] of [['null', null], ['a primitive', 'nope'], ['an array', []]] as const) {
  const source = declarationWith(contributes)
  const read = declaredBackendsIn(source)
  check(`a contributes that is ${what} is refused by the canonical projection, and this reader reports it`,
    projectedBackendNames(source) === undefined && read.backends.length === 0 && read.problems.length === 1
    && (read.problems[0]?.includes('contributes must be an object') ?? false),
    JSON.stringify({ projected: projectedBackendNames(source), problems: read.problems }))
}

const splitIdentitySource = declarationOf([{
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'Backend',
  id: 'com.example.not-the-spec-id',
  name: 'example_split',
  spec: validSpec('example-split-agent'),
}])
const splitRead = declaredBackendsIn(splitIdentitySource)
check('an outer contribution id that differs from spec.id stays legitimate, and the backend id is spec.id',
  splitRead.problems.length === 0 && splitRead.backends.length === 1
  && splitRead.backends[0]?.name === 'example_split' && splitRead.backends[0]?.spec.id === 'example-split-agent'
  && JSON.stringify(projectedBackendNames(splitIdentitySource)) === JSON.stringify(['example_split']),
  JSON.stringify({ read: splitRead, projected: projectedBackendNames(splitIdentitySource) }))

// The PAIR bundle puts two `Backend` contributions in one declaration. The
// projection keys extensions by (apiVersion, kind, metadata.name) and rejects a
// duplicate, so the two local names must stay distinct — and the projection is
// what proves the declaration itself conforms.
const pairDeclaration = readFileSync(join(pairDir, 'dsh-plugin.json'), 'utf8')
const pairRead = declaredBackendsIn(pairDeclaration)
const pairProjected = projectedBackendNames(pairDeclaration)
check('the PAIR declaration keeps two distinct local names, so the canonical projection keeps both',
  pairRead.problems.length === 0 && pairRead.backends.length === 2
  && pairProjected !== undefined && pairProjected.length === 2 && new Set(pairProjected).size === 2
  && pairRead.backends.every(backend => pairProjected.includes(backend.name)),
  JSON.stringify({ read: pairRead.backends.map(backend => backend.name), projected: pairProjected, problems: pairRead.problems }))
const duplicateDeclaration = readFileSync(join(duplicateDir, 'dsh-plugin.json'), 'utf8')
const duplicateRead = declaredBackendsIn(duplicateDeclaration)
check('the reader and canonical projection both refuse duplicate extension identities',
  projectedBackendNames(duplicateDeclaration) === undefined
  && duplicateRead.backends.length === 0 && duplicateRead.problems.some(problem => problem.includes('duplicate extension')))

// ── the pass is a no-op the second time ─────────────────────────────────────
// Two callers on purpose: the entry decides its kernel before `apply` runs, and both
// questions are registry membership. Assembling twice must not become a storm of
// "already registered".
const again = assembleBackendsFromProfile(composition.root)
check('a second pass over the same composition registers nothing and repeats no warning',
  again.registered.length === 0
  && JSON.stringify(again.refused) === JSON.stringify(assembled.refused)
  && composition.warnings.length === assembled.refused.length,
  JSON.stringify({ registered: again.registered, warned: composition.warnings.length }))

// ── the wiring of both call sites, in the real sources ─────────────────────
// The cases above prove the function; these pin its production callers. The
// entry's preliminary route is only a host-unavailable fallback: the final
// kernel must configure the root after discovery. verify-backend-host drives
// the real root/profile lifecycle; verify-backend-config covers Schema timing.
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** `assembleBackendsFromProfile(ctx)`: the line each boot path runs first. */
const ASSEMBLY_CALL = 'assembleBackendsFromProfile(ctx)'
/** `parseBackendChoice()` and `isRegisteredBackend()` are the two ways `apply` asks
 *  the registry whether an id is one this process can run. */
const BOOT_READS = /\b(?:parseBackendChoice|isRegisteredBackend)\s*\(|\benvKnown:\s*isRegisteredBackend\b/gu
/** The line that fixes the kernel the entry's composition boots on (its route
 *  helpers read membership indirectly, so the call is what is named here). */
const ENTRY_KERNEL_LINE = 'const kernel: KernelBackendId = entryKernel('

/** Whether `source` assembles installed backends before every read of `pattern`. */
function assemblesBeforeEvery(source: string, pattern: RegExp): boolean {
  const assembly = source.indexOf(ASSEMBLY_CALL)
  const reads = [...source.matchAll(pattern)]
  return assembly >= 0 && reads.length >= 1
    && reads.every(read => (read.index ?? 0) > assembly)
}

/** {@link assemblesBeforeEvery} against a named line instead of a pattern. */
function assemblesBeforeLine(source: string, line: string): boolean {
  const assembly = source.indexOf(ASSEMBLY_CALL)
  const read = source.indexOf(line)
  return assembly >= 0 && read > assembly
}

/** Move the assembly call to just after `line` — the "assembled too late" baseline. */
function assemblyMovedAfter(source: string, line: string): string {
  const call = `  ${ASSEMBLY_CALL}\n`
  const without = source.replace(call, '')
  const read = without.indexOf(line)
  const lineEnd = without.indexOf('\n', read) + 1
  return without.slice(0, lineEnd) + call + without.slice(lineEnd)
}

const bootSource = readFileSync(join(REPO, 'src', 'dsh-adapter', 'plugin.ts'), 'utf8')
check('the DSH boot reads registry membership only after the assembly ran',
  assemblesBeforeEvery(bootSource, BOOT_READS),
  JSON.stringify([...bootSource.matchAll(BOOT_READS)].map(read => read.index)))
check('the wiring check bites: moving the assembly after the boot\'s first read is red',
  !assemblesBeforeEvery(assemblyMovedAfter(bootSource, 'const handoffBackend = parseBackendChoice('), BOOT_READS))

const entrySource = readFileSync(join(REPO, 'src', 'dsh-adapter', 'host-entry.ts'), 'utf8')
const HOST_MODE_CALL = "await root?.selectKernel(kernel === 'dsh')"
function selectsFinalKernel(source: string): boolean {
  const route = source.indexOf(ENTRY_KERNEL_LINE)
  const mode = source.indexOf(HOST_MODE_CALL)
  return assemblesBeforeLine(source, ENTRY_KERNEL_LINE)
    && mode > route && source.indexOf('const config = Config(') > mode
    && source.indexOf("createEntrySlot(kernel === 'dsh',") > mode
    && source.indexOf('entryKernel: kernel') > mode
    && !source.includes("dsh: kernelBeforeHost === 'dsh'")
}
check('the standalone entry uses its assembled kernel for host mode, Schema, slot and runtime',
  selectsFinalKernel(entrySource))
check('the wiring check bites: moving the assembly after the entry\'s kernel is red',
  !selectsFinalKernel(assemblyMovedAfter(entrySource, ENTRY_KERNEL_LINE)))
check('the wiring check bites: a host mode decided by the preliminary kernel is red',
  !selectsFinalKernel(entrySource.replace(HOST_MODE_CALL, "await root?.selectKernel(kernelBeforeHost === 'dsh')")))
const selectionFailure = entrySource.slice(entrySource.indexOf(HOST_MODE_CALL), entrySource.indexOf('const config = Config('))
const delegatesDshFailure = (source: string): boolean => source.includes("if (kernel === 'dsh')")
  && source.indexOf('noteHostUnavailable(kernel, error)') >= 0
  && source.indexOf('delegateToDsh()') > source.indexOf('noteHostUnavailable(kernel, error)')
  && source.indexOf('handleStartupError(ctx, error)') > source.indexOf('delegateToDsh()')
check('failed DSH-only preparation still delegates before the screen mounts', delegatesDshFailure(selectionFailure))
check('the wiring check bites: removing DSH preparation fallback is red',
  !delegatesDshFailure(selectionFailure.replace('delegateToDsh()', '')))

const waitingFailure = await loadFailure(WAITING_ID)
check('an explicit waiting backend choice fails without importing its module',
  parseBackendChoice(WAITING_ID) === WAITING_ID && waitingFailure.includes('PERMISSION_NOT_GRANTED')
  && waitingFailure.includes('storage.local.read') && !importedAt(waitingDir), waitingFailure)
const statuses = await probeKernels(composition.root, profileDir)
check('kernel probing never imports a waiting backend or reports it as available',
  !Object.hasOwn(statuses, WAITING_ID) && !importedAt(waitingDir))
await unloadBackends()
await composition.root.fiber.dispose()

// ── identity comes from the Loader's resolver, or from nowhere ─────────────
const without = await mount()
const savedResolver = without.root.loader.internal
without.root.loader.internal = undefined
const debugLines: string[] = []
const stderrWrite = process.stderr.write
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  debugLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  return true
}) as typeof process.stderr.write
process.env.DSH_TUI_DEBUG = '1'
try {
  const refusedAll = assembleBackendsFromProfile(without.root)
  check('without the Loader resolver nothing is registered and nothing is guessed',
    refusedAll.registered.length === 0 && refusedAll.scanned.length === BUNDLES.length - COMPOSITION_OWNED.length,
    JSON.stringify(refusedAll.registered))
  check('without the Loader resolver the skip is explained, naming what could not be judged',
    debugLines.some(line => line.includes('ESM resolver is unavailable') && line.includes(DEMO)),
    debugLines.join(''))
  check('without the Loader resolver no bundle is blamed for it',
    without.warnings.length === 0, JSON.stringify(without.warnings))
} finally {
  delete process.env.DSH_TUI_DEBUG
  process.stderr.write = stderrWrite
  without.root.loader.internal = savedResolver
  await without.root.fiber.dispose()
}

// ── the timing contract: assembly before the parse ─────────────────────────
const childReport = join(dir, 'child-report.jsonl')
const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url)], {
  cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: 'utf8', timeout: 30000,
  env: { ...process.env, DSH_TUI_ASSEMBLY_CHILD: '1', DSH_TUI_ASSEMBLY_REPORT: childReport },
})
check('timing baseline child ran', child.status === 0, child.stdout + child.stderr)
const outcome = child.status === 0
  ? JSON.parse(readFileSync(childReport, 'utf8').trim().split('\n').pop() ?? '{}') as {
      parsedBefore: string | null; parsedAfter: string | null; registered: string[]; scanned: number; warnings: number; rows: number }
  : { parsedBefore: 'child failed', parsedAfter: 'child failed', registered: [], scanned: -1, warnings: -1, rows: -1 }
check('bad baseline: a boot that parses first reads an installed backend as unknown',
  outcome.parsedBefore === null, JSON.stringify(outcome))
check('assembly first: the same id is a registered backend by the time the boot parses',
  outcome.parsedAfter === AGENT_ID, JSON.stringify(outcome))
check('the scan needs no bundle row activation: the child has no Loader rows',
  outcome.rows === 0 && outcome.scanned === BUNDLES.length - COMPOSITION_OWNED.length
  && JSON.stringify(outcome.registered) === JSON.stringify(EXPECTED_REGISTERED), JSON.stringify(outcome))

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? 'verify-backend-assembly ALL PASS' : `verify-backend-assembly ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
