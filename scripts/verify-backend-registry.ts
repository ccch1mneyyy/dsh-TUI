/**
 * Backend registry regression (roadmap Stage A / P0, checklist §7).
 *
 * The point of this file is the three properties a fourth backend would break:
 *
 *  1. **Registration is loud** and reserved for what the manifest can honestly
 *     say: duplicate ids, built-in ids claimed by a plugin, host label keys used
 *     off-tree, a native channel outside the tree, an install recipe missing its
 *     fields. What it may *not* decide is whether the host likes the recipe's
 *     executor value — that is a runtime table lookup (B-1, §6 item 12), pinned
 *     in §2b below.
 *  2. **Boot parsing keeps today's semantics** (D1): a syntactically valid but
 *     uninstalled id behaves like an unknown value on all five sources — dsh plus
 *     a warning, never a crash — while "registered but cannot open" still fails
 *     hard. The pure matrix plus wiring assertions pin both halves; the launcher's
 *     own copy of the rule is compared here too (its behavior is driven end-to-end
 *     by verify-safe-mode.mjs).
 *  3. **Pools are closed for what was loaded, and only for that** (D4): the
 *     unload hook of an entry that was never loaded is never called and its module
 *     is never imported; two loaded entries both close, in load order,
 *     idempotently, and one failing hook neither blocks the others nor throws.
 *
 * It also pins the two derived gate families against a copy of the source tree
 * (§6: every rule must fail on a violating import — a gate that silently stops
 * matching is worse than no gate), and the generated index's discovery rules.
 *
 * Run: node --import tsx/esm scripts/verify-backend-registry.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import type { AgentBackend, BackendDetection } from '../src/agent/backend.js'
import type { BackendEntry, BackendManifest } from '../src/agent/backend-manifest.js'
import type { AgentSession } from '../src/agent/session.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { isBackendIdSyntax } = await import('../src/agent/backend-manifest.js')
const { backendLabel, getBackend, isRegisteredBackend, listBackends, loadBackend, parseBackendChoice, registerBackend, unloadBackends } =
  await import('../src/dsh-adapter/backend-registry.js')
const { probeKernels, installSurfaceFor } = await import('../src/dsh-adapter/backends.js')
const { PNPM_PROFILE_ADD } = await import('../src/dsh-adapter/install/executors.js')
const { normalizeBackendChoice } = await import('../src/dsh-adapter/index.js')
const { readKernelPrefs, resolveRememberedBackend, writeKernelPrefs, parseBackendId, BUILTIN_BACKEND_IDS } = await import('../src/kernelPrefs.js')
const { readLastRunRecord, writeLastRunRecord } = await import('../src/update.js')

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`ok   ${label}`)
}
const throws = (fn: () => unknown): boolean => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-backend-registry-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

// ── 1. The registered reality: the seed, the generated index, the manifests ────
const backends = listBackends()
const backendIds: readonly string[] = backends.map(entry => entry.id)
// Additive on purpose (P0 §1.2: adding `src/backends/<id>/` must not red this).
// The seed stays first, every built-in stays present exactly once, and the exact
// order/completeness against the directory is the parity check right below —
// pinning the literal three here would only duplicate it and break the drill.
check('registry starts with dsh and carries every built-in exactly once (parity below pins order and completeness)',
  backendIds[0] === 'dsh' && BUILTIN_BACKEND_IDS.every(id => backendIds.includes(id))
    && new Set(backendIds).size === backendIds.length, backendIds)
check('every registered id passed the syntax gate, and getBackend agrees',
  backends.every(entry => isBackendIdSyntax(entry.id)) && getBackend('codex')?.id === 'codex' && getBackend('nope') === undefined)
check('backendLabel names the manifest, and an unknown id stays itself',
  backendLabel('claude') === 'Claude' && backendLabel('acme-agent') === 'acme-agent')

const manifestFiles = readdirSync(join(ROOT, 'src', 'backends'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(ROOT, 'src', 'backends', entry.name, 'manifest.ts')))
  .map(entry => entry.name)
  .sort()
check('one registered entry per backend manifest (no dir silently skipped)',
  JSON.stringify(backends.slice(1).map(entry => entry.id)) === JSON.stringify(manifestFiles), manifestFiles)

for (const name of manifestFiles) {
  const manifestModule: unknown = await import(pathToFileURL(join(ROOT, 'src', 'backends', name, 'manifest.ts')).href)
  const manifest = (manifestModule as { manifest: BackendManifest }).manifest
  // The implementation module too: a declared export name that the barrel does not
  // carry is exactly the typo the generator cannot see and `loadBackend` would only
  // hit at the worst moment.
  const implementation = (await import(pathToFileURL(join(ROOT, 'src', 'backends', name, 'index.ts')).href)) as Record<string, unknown>
  check(`src/backends/${name}: id matches the directory, exports resolve, the recipe is one this host runs`,
    manifest.id === name && manifest.inTree === true
      && typeof implementation[manifest.backendExport ?? 'backend'] === 'object'
      && (manifest.unloadExport === undefined || typeof implementation[manifest.unloadExport] === 'function')
      // B-1 restates D5-1's invariant on the *derived* fact: declaring a recipe is
      // exactly what makes an entry installable here. A typo in an in-tree
      // executor name would otherwise cost that backend its wizard silently —
      // nothing at runtime could report it.
      && getBackend(name)?.installable === (manifest.install !== undefined))
}
check('claude declares no native channel; codex declares exactly its own (P0 §6)',
  getBackend('claude')?.manifest.nativeKey === undefined && getBackend('codex')?.manifest.nativeKey === 'codex')
check('the install wizard target comes from the manifest that declares it',
  getBackend('claude')?.manifest.install?.version === (await import('../src/backends/claude/contract.js')).VALIDATED_SDK_VERSION)

// ── 2. Registration guards ─────────────────────────────────────────────────────
const fakeManifest = (overrides: Partial<BackendManifest> = {}): BackendManifest =>
  ({ id: 'acme-agent', label: { kind: 'literal', text: 'Acme' }, shortLabel: 'Acme', inTree: false, ...overrides })
const neverBackend = {} as AgentBackend
check('a duplicate id is refused',
  throws(() => registerBackend({ manifest: fakeManifest({ id: 'dsh', inTree: true }) })))
check('a plugin may not claim a built-in id',
  throws(() => registerBackend({ manifest: fakeManifest({ id: 'claude' }) })))
check('a plugin may not use a host label key (it would read "DeepSeek Harness")',
  throws(() => registerBackend({ manifest: fakeManifest({ label: { kind: 'key', key: 'kernel-label-dsh' } }) })))
check('a plugin may not be always-available, nor declare a native channel',
  throws(() => registerBackend({ manifest: fakeManifest({ alwaysAvailable: true }) }))
    && throws(() => registerBackend({ manifest: fakeManifest({ nativeKey: 'acme' }) })))
check('an always-available entry may not have a loader',
  throws(() => registerBackend({ manifest: fakeManifest({ id: 'dshx', inTree: true, alwaysAvailable: true }), load: async () => ({ backend: neverBackend }) })))
check('an install recipe is refused without a non-empty executor, specifier and version',
  throws(() => registerBackend({ manifest: fakeManifest({ id: 'acme-noexec', install: { executor: '', specifier: '@acme/x@1', version: '1' } }) }))
    && throws(() => registerBackend({ manifest: fakeManifest({ id: 'acme-nospec', install: { executor: 'pnpm-profile-add', specifier: '', version: '1' } }) }))
    && throws(() => registerBackend({ manifest: fakeManifest({ id: 'acme-nover', install: { executor: 'pnpm-profile-add', specifier: '@acme/x@1', version: '' } }) })))
// ── 2b. The install surface is a declaration, not an id (B-1, §6 item 12) ───────
// §2.5's acceptance is "flip claude / codex to `inTree: false` and everything but
// the label check (D2) stays green" — which could not hold while the privilege was
// spelled as one id (`HOST_INSTALLABLE_BACKEND_ID`): the id decided, not the
// declaration, so a plugin-shaped fourth backend could never have a wizard of its
// own. The probes below are that acceptance in executable form — a non-inTree entry
// declaring Claude's recipe gets *its own* wizard, while codex's "there is nothing
// to install, the user's own binary is the dependency" is an ordinary absent recipe.
check('a non-inTree entry may declare the host\'s executor, and the wizard it opens is its own (not Claude\'s)',
  (() => {
    registerBackend({
      manifest: fakeManifest({ id: 'acme-install', install: { executor: PNPM_PROFILE_ADD, specifier: '@acme/agent-sdk@2.0.0', version: '2.0.0' } }),
    })
    const surface = installSurfaceFor('acme-install')
    return getBackend('acme-install')?.installable === true
      && surface?.executor === PNPM_PROFILE_ADD && surface.specifier === '@acme/agent-sdk@2.0.0' && surface.version === '2.0.0'
  })())
check('codex-style "no install surface" stays a first-class registered row: absent recipe, not installable, no surface',
  getBackend('codex')?.manifest.install === undefined && getBackend('codex')?.installable === false
    && installSurfaceFor('codex') === undefined)
check('an executor this host does not implement registers as "no install surface" — no throw, no wizard, recipe kept',
  (() => {
    registerBackend({
      manifest: fakeManifest({ id: 'acme-exotic', install: { executor: 'cargo-install', specifier: 'acme-sdk@1', version: '1' } }),
    })
    return getBackend('acme-exotic')?.manifest.install?.executor === 'cargo-install'
      && getBackend('acme-exotic')?.installable === false
      && installSurfaceFor('acme-exotic') === undefined
  })())
check('an id nobody registered has no install surface either (membership, then declaration)',
  installSurfaceFor('never-registered') === undefined)
check('ids must match the syntax gate',
  ['has:colon', '..', 'a/b', 'Acme', '', 'x'.repeat(33)].every(id => !isBackendIdSyntax(id))
    && throws(() => registerBackend({ manifest: fakeManifest({ id: 'has:colon' }) })))

// ── 3. The two-stage parse on all five boot sources (D1) ────────────────────────
const UNINSTALLED = 'acme-agent'
check('syntax passes it, membership does not',
  isBackendIdSyntax(UNINSTALLED) && !isRegisteredBackend(UNINSTALLED) && parseBackendChoice(UNINSTALLED) === undefined)
check('--backend / Config row: an unregistered value reads as "not configured" (dsh)',
  normalizeBackendChoice(UNINSTALLED) === undefined && normalizeBackendChoice(' Codex ') === 'codex')
check('handoff env: an unregistered value is ignored, the memory still wins',
  resolveRememberedBackend({ handoff: parseBackendChoice(UNINSTALLED), memory: 'claude' }) === 'claude')
check('DSH_TUI_BACKEND without the registry predicate is the old priority chain (regression scripts rely on it)',
  resolveRememberedBackend({ envRaw: UNINSTALLED, memory: 'claude' }) === UNINSTALLED)
check('DSH_TUI_BACKEND with the registry predicate: dsh, never the memory, never a crash',
  resolveRememberedBackend({ envRaw: UNINSTALLED, envKnown: isRegisteredBackend, memory: 'claude' }) === 'dsh'
    && resolveRememberedBackend({ envRaw: ' Bad Id ', envKnown: isRegisteredBackend, memory: 'claude' }) === 'dsh')
// The hard failure stays reserved for "registered but cannot open" (D1): an
// unregistered id must never get there, and loadBackend says so if one ever does.
await assert.rejects(async () => loadBackend(UNINSTALLED as never), /is not registered/)
check('an uninstalled id cannot reach loadBackend through the parse (the R1 crash)',
  parseBackendChoice(UNINSTALLED) === undefined && normalizeBackendChoice(UNINSTALLED) === undefined)

// The store is the syntax layer and nothing else: a plugin backend remembered by
// another profile must survive the read verbatim, because filtering here would
// need the registry this module deliberately does not import. The boot filters it
// at the call site — pinned by the source wiring assertions below.
const prefsFile = join(tmp, 'kernel.json')
writeKernelPrefs({ backend: UNINSTALLED as never }, prefsFile)
check('kernel.json: the syntax layer keeps a well-formed uninstalled id verbatim (the boot filters, not the store)',
  readKernelPrefs(prefsFile).backend === UNINSTALLED && parseBackendId(UNINSTALLED) === UNINSTALLED
    && !isRegisteredBackend(UNINSTALLED))
const recordFile = join(tmp, 'last-run.json')
writeLastRunRecord({ backendId: parseBackendId(UNINSTALLED)!, sessionId: 's', cwd: '/w', attemptId: 'a' }, recordFile)
check('last-run record: an uninstalled id still reads back (the launcher then falls back to dsh)',
  readLastRunRecord(recordFile)?.backendId === UNINSTALLED)

const pluginSource = readFileSync(join(ROOT, 'src', 'dsh-adapter', 'plugin.ts'), 'utf8')
const openGuard = pluginSource.indexOf("if (backendChoice !== 'dsh')")
const loadCall = pluginSource.indexOf('await loadBackend(')
check('the boot wires the registry predicate into every raw source',
  pluginSource.includes('parseBackendChoice(handoffBackendRaw)')
    && pluginSource.includes('envKnown: isRegisteredBackend')
    && pluginSource.includes('isRegisteredBackend(rememberedBackend) ? rememberedBackend : undefined'))
check('and opens a backend in exactly one place, inside the "not dsh" branch (D1 keeps the hard failure for registered ids)',
  loadCall > openGuard && openGuard > 0 && pluginSource.split('await loadBackend(').length === 2,
  `guard@${openGuard} call@${loadCall}`)

// ── 4. The launcher's own copy of the id rule must agree with this one ─────────
{
  const binSource = readFileSync(join(ROOT, 'bin', 'dsh-tui.js'), 'utf8')
  const from = binSource.indexOf('const BACKEND_ID_PATTERN = ')
  const to = binSource.indexOf('\n', binSource.indexOf('const isBackendIdSyntax = '))
  if (from < 0 || to < 0) throw new Error('bin backend id rule not found')
  const launcherRule = new vm.Script(`${binSource.slice(from, to)}\nisBackendIdSyntax`).runInNewContext()
  const samples = ['dsh', 'codex', 'acme-agent', 'a', '0', 'x'.repeat(32), 'x'.repeat(33), 'Acme', 'has:colon', '..', 'a/b', '', 'a_b', 'ä']
  check('launcher mirror: identical verdicts to src/agent/backend-manifest.ts on a sample matrix',
    samples.every(sample => launcherRule(sample) === isBackendIdSyntax(sample)),
    samples.map(sample => `${JSON.stringify(sample)}=${launcherRule(sample)}`).join(' '))
}

// ── 5. Detection failures degrade one row, never the probe ─────────────────────
{
  const imports: string[] = []
  const fakeBackend = (detection: BackendDetection): AgentBackend => ({
    id: 'fake',
    descriptor: { label: 'Fake' },
    detect: async () => detection,
    open: async (): Promise<AgentSession> => { throw new Error('not used') },
  })
  registerBackend({
    manifest: fakeManifest({ id: 'probe-bad', backendExport: 'backend' }),
    load: async () => {
      imports.push('probe-bad')
      throw new Error('module exploded')
    },
  })
  registerBackend({
    manifest: fakeManifest({ id: 'probe-ok', backendExport: 'backend' }),
    load: async () => {
      imports.push('probe-ok')
      return { backend: fakeBackend({ installed: true, version: '9.9.9' }) }
    },
  })
  const statuses = await probeKernels(new Context(), tmp)
  check('a backend whose module fails to load shows as "not installed", the others still probe',
    statuses['probe-bad']?.installed === false && statuses['probe-ok']?.installed === true
      && statuses['probe-ok']?.version === '9.9.9' && imports.join(',') === 'probe-bad,probe-ok')
}

// ── 6. Pool bookkeeping (D4): loaded entries only, in order, idempotent ────────
{
  const closed: string[] = []
  let lazilyImported = 0
  registerBackend({
    manifest: fakeManifest({ id: 'pool-idle', backendExport: 'backend', unloadExport: 'closeIdle' }),
    load: async () => {
      lazilyImported += 1
      return { backend: neverBackend, closeIdle: async () => { closed.push('pool-idle') } }
    },
  })
  registerBackend({
    manifest: fakeManifest({ id: 'pool-one', backendExport: 'backend', unloadExport: 'closeOne' }),
    load: async () => ({ backend: neverBackend, closeOne: async () => { closed.push('pool-one') } }),
  })
  registerBackend({
    manifest: fakeManifest({ id: 'pool-two', backendExport: 'backend', unloadExport: 'closeTwo' }),
    // Records itself and *then* fails: the point is that it ran, and that its
    // failure neither stopped the earlier hook nor reached the caller.
    load: async () => ({ backend: neverBackend, closeTwo: async () => { closed.push('pool-two'); throw new Error('unload failed') } }),
  })

  // Nothing loaded yet: closing must not even import the idle entry's module.
  await unloadBackends()
  check('a registered entry that was never loaded is neither imported nor closed (D4-P1)',
    closed.length === 0 && lazilyImported === 0)

  await loadBackend('pool-one' as never)
  await loadBackend('pool-two' as never)
  await unloadBackends()
  check('loaded entries close in load order, and a failing hook does not stop the others nor throw (D4-P4)',
    closed.join(',') === 'pool-one,pool-two' && lazilyImported === 0, `closed=${closed.join(',')} idle=${lazilyImported}`)

  closed.length = 0
  await unloadBackends()
  check('unloadBackends is idempotent', closed.length === 0)

  // A declared hook that the module does not export must fail loudly at load.
  registerBackend({
    manifest: fakeManifest({ id: 'pool-typo', backendExport: 'backend', unloadExport: 'closeTypo' }),
    load: async () => ({ backend: neverBackend }),
  })
  await assert.rejects(async () => loadBackend('pool-typo' as never), /unloadExport/)
  check('a misspelled unloadExport fails the load instead of silently never closing', true)

  const disposal = readFileSync(join(ROOT, 'src', 'dsh-adapter', 'plugin.ts'), 'utf8')
  check('one exit funnel, fiber first: dispose the tree, then close the pools (D4-P2/P3)',
    disposal.includes('withHostRootCapability(() => ctx.root.fiber.dispose()).finally(() => unloadBackends())'))
}

// ── 7. The generated index: discovery, order, and fail-loud generation ─────────
{
  // The index is committed, and this check is authoritative here precisely
  // because this group does not compile (the artifact is restored): a backend
  // added without committing the regenerated index fails right here.
  const fresh = spawnSync(process.execPath, ['--import', 'tsx/esm', join(ROOT, 'scripts', 'gen-backend-index.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  check('the committed index matches the manifests on disk (no stale entry, no missing one)',
    fresh.status === 0, `${fresh.stdout.trim()} ${fresh.stderr.trim()}`.trim())

  const generated = join(ROOT, 'src', 'dsh-adapter', 'backends.generated.ts')
  const generatedSource = existsSync(generated) ? readFileSync(generated, 'utf8') : ''
  const staticImports = generatedSource.match(/import \{ manifest as /gu)?.length ?? 0
  const dynamicLoads = generatedSource.match(/load: \(\) => import\('/gu)?.length ?? 0
  check('the build-time index exists: one static manifest import and one dynamic load per backend, in directory order',
    staticImports === manifestFiles.length && dynamicLoads === manifestFiles.length
      && manifestFiles.every((name, index) => generatedSource.indexOf(`/backends/${name}/manifest.js`) > 0
        && (index === 0 || generatedSource.indexOf(`/backends/${manifestFiles[index - 1]}/manifest.js`) < generatedSource.indexOf(`/backends/${name}/manifest.js`))),
    `imports=${staticImports} loads=${dynamicLoads}`)

  const fixture = join(tmp, 'fixture')
  const out = join(tmp, 'out', 'backends.generated.ts')
  mkdirSync(dirname(out), { recursive: true })
  const writeBackend = (name: string, manifest: string, extra: { readonly index?: string; readonly noManifest?: boolean } = {}): void => {
    mkdirSync(join(fixture, name), { recursive: true })
    if (extra.noManifest !== true) writeFileSync(join(fixture, name, 'manifest.ts'), manifest)
    writeFileSync(join(fixture, name, 'index.ts'), extra.index ?? 'export const backend = {}\n')
  }
  const clean = `export const manifest = {
  id: 'zz-agent', label: { kind: 'literal', text: 'Zz' }, shortLabel: 'Zz', inTree: false, backendExport: 'backend',
}\n`
  writeBackend('zz-agent', clean)
  writeBackend('aa-agent', clean.replace("id: 'zz-agent'", "id: 'aa-agent'"))
  writeBackend('broken', 'export const manifest = { id: "broken" }\n')
  writeBackend('unmanifested', '', { noManifest: true })

  const runGenerator = (dir: string): { readonly status: number | null; readonly stderr: string; readonly stdout: string } =>
    spawnSync(process.execPath, ['--import', 'tsx/esm', join(ROOT, 'scripts', 'gen-backend-index.mjs'), '--dir', dir, '--out', out], { cwd: ROOT, encoding: 'utf8' })

  const failing = runGenerator(fixture)
  check('a backend directory without a manifest fails the generator (no silent disappearance)',
    failing.status !== 0 && failing.stderr.includes('no manifest.ts'), failing.stderr.trim().split('\n').slice(-2).join(' '))

  rmSync(join(fixture, 'unmanifested'), { recursive: true, force: true })
  const incoherent = runGenerator(fixture)
  check('an incoherent manifest (missing inTree/label/backendExport) fails the generator',
    incoherent.status !== 0 && incoherent.stderr.includes('inTree'), incoherent.stderr.trim().split('\n').slice(-2).join(' '))

  rmSync(join(fixture, 'broken'), { recursive: true, force: true })
  const ok = runGenerator(fixture)
  const emitted = existsSync(out) ? readFileSync(out, 'utf8') : ''
  check('a clean fixture tree emits entries in directory-name order (picker order)',
    ok.status === 0
      && emitted.indexOf("from '../fixture/aa-agent/manifest.js'") > 0
      && emitted.indexOf("from '../fixture/aa-agent/manifest.js'") < emitted.indexOf("from '../fixture/zz-agent/manifest.js'")
      && emitted.indexOf("load: () => import('../fixture/aa-agent/index.js')") < emitted.indexOf("load: () => import('../fixture/zz-agent/index.js')")
      && !emitted.includes('.then('),
    emitted.replace(/\n/gu, ' | '))
}

// ── 8. The boundary gate's derived rules still bite (bad baseline must be red) ─
{
  const gate = join(ROOT, 'scripts', 'verify-adapter-boundary.ts')
  const allowlist = join(ROOT, 'scripts', 'adapter-boundary.allowlist.json')
  const tree = join(tmp, 'boundary')
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'src'), join(tree, 'src'), { recursive: true })
  cpSync(gate, join(tree, 'scripts', 'verify-adapter-boundary.ts'))
  cpSync(allowlist, join(tree, 'scripts', 'adapter-boundary.allowlist.json'))
  // The copy needs the repo's module type: tsx would otherwise transpile the
  // copied gate as CJS and reject its top-level await.
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'boundary-probe', type: 'module' }))
  const runGate = (): { readonly status: number | null; readonly stderr: string } =>
    spawnSync(process.execPath, ['--import', 'tsx/esm', join(tree, 'scripts', 'verify-adapter-boundary.ts')], { cwd: ROOT, encoding: 'utf8' })

  // Control: the copied tree reproduces the real result, so the probes below fail
  // for the injected reason and not because the harness is broken.
  const control = runGate()
  check('control: the copied tree passes the gate (probes below are not tautological)',
    control.status === 0, control.stderr.trim().split('\n').slice(0, 3).join(' '))

  /** One violating import per rule family, at the worst possible place. */
  const probes: readonly { readonly name: string; readonly file: string; readonly source: string }[] = [
    { name: '@deepseek-ai/* off dsh-adapter', file: 'src/agent/probe.ts', source: "import Schema from '@deepseek-ai/schemastery'\nexport const s = Schema\n" },
    { name: '@anthropic-ai/* off backends/claude', file: 'src/screens/probe.ts', source: "import sdk from '@anthropic-ai/claude-agent-sdk'\nexport const s = sdk\n" },
    { name: '@agentclientprotocol/* off backends/acp', file: 'src/agent/probe.ts', source: "import acp from '@agentclientprotocol/sdk'\nexport const s = acp\n" },
    { name: '@dsh-std/* off adapter/standard + dsh-adapter', file: 'src/agent/probe.ts', source: "import core from '@dsh-std/core'\nexport const s = core\n" },
    { name: 'native.dsh outside dsh-adapter', file: 'src/agent/probe.ts', source: 'export const read = (session: { capabilities: { native: Record<string, unknown> } }): unknown => session.capabilities.native.dsh\n' },
    { name: 'native.codex outside backends/codex', file: 'src/agent/probe.ts', source: 'export const read = (session: { capabilities: { native: Record<string, unknown> } }): unknown => session.capabilities.native.codex\n' },
  ]
  const probeFile = join(tree, 'src', 'agent', 'probe.ts')
  for (const probe of probes) {
    const target = join(tree, probe.file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, probe.source)
    const result = runGate()
    check(`bad baseline is red: ${probe.name}`, result.status !== 0, `status=${result.status}`)
    rmSync(target, { force: true })
  }
  // The equivalence trap of §6: a manifest that invents a native rule must not be
  // able to relax the gate — the snapshot comparison catches it before the scan.
  const manifestFile = join(tree, 'src', 'backends', 'claude', 'manifest.ts')
  writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace("  backendExport: 'claudeBackend',", "  backendExport: 'claudeBackend',\n  nativeKey: 'claude',"))
  const widened = runGate()
  check('bad baseline is red: a manifest may not invent native.claude (derivation snapshot)',
    widened.status !== 0 && widened.stderr.includes('native'), widened.stderr.trim().split('\n').slice(0, 4).join(' '))
  writeFileSync(manifestFile, readFileSync(join(ROOT, 'src', 'backends', 'claude', 'manifest.ts'), 'utf8'))
  const restored = runGate()
  check('restoring the manifest restores the gate', restored.status === 0, restored.stderr.trim().split('\n').slice(0, 3).join(' '))
}

console.log(`\nverify-backend-registry OK (${passed} checks)`)
