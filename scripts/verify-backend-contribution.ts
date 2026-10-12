/**
 * Backend contribution family gate (B-2, W-1).
 *
 * What it pins, in order:
 *  1. **Dogfood** — every built-in manifest projects onto the public declaration
 *     shape and survives the family's own validator, with no in-tree private key
 *     leaking through, and the projection is pure.
 *  2. **Single source** — the capability vocabulary equals `SessionCapabilities`'
 *     member names (bidirectional, TS AST) and the reserved id set equals the
 *     registry's built-in ids.
 *  3. **Admission** — the verdicts this host can produce, the shape of a
 *     `waiting_authorization` refusal, and the reason codes the contract profile
 *     publishes (each published code needs a producer, so a phantom name fails).
 *  4. **The probe backend** — the resource invariants claude and codex are held to
 *     (never loaded means never imported, never closed; only what was loaded is
 *     closed), the two install-surface shapes, and the declaration covering what
 *     the session actually serves.
 *  5. **Bad declarations** — each one refused, loudly, and the confirmation-policy
 *     vocabulary this host *does* implement pinned in the positive direction (it only
 *     grows; `trusted-source` requests the host's own source judgment, it never grants
 *     itself the exemption).
 *  6. **Bad baseline** — the load-bearing checkers above go red on an injected
 *     input, which is what makes them checks rather than decoration. Unlike the
 *     boundary gate (whose subject is a file tree, so it copies one), the subject
 *     here is the registry pipeline, so the injection is the mutated input itself.
 *  7. **Wired (W-2)** — the family is reachable from the registry/descriptor chain,
 *     which is what turns a declaration into an admitted contribution: `Backend`
 *     is a host-published contract, `registryEntries()` reads the registry's
 *     `extensions` section, the contract profile is pinned by a registry entry, the
 *     canonical admission catalog registers the contribution definitions, and the
 *     descriptor publishes the coordinate **only** on real probe evidence. These
 *     assertions are the positive form of the W-1 scope guards stage B left behind
 *     on purpose; each one carries a bad baseline here (the checks below), because
 *     the failure this wiring prevents — "declares support, cannot deliver" — is
 *     otherwise invisible.
 *
 * Run: node --import tsx/esm scripts/verify-backend-contribution.ts (no build)
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  BACKEND,
  BACKEND_CAPABILITY_NAMES,
  BACKEND_CONFIRMATION_POLICIES,
  BACKEND_RESERVED_IDS,
  validateBackendSpec,
} from '../src/adapter/spec/tui-contributions.js'
import { EXPECTED_PERMISSIONS, HOST_SUPPORTED_CONTRACTS } from '../src/adapter/spec/protocol-constants.js'
import { digestFile, loadSpecData, registryEntries, verifyRegistry } from '../src/adapter/standard/registry.js'
import { getAdmissionCatalog } from '../src/adapter/standard/tui-extension.js'
import type { ContractRegistry } from '../src/adapter/standard/types.js'
import { buildHostDescriptorFromLifecycles } from '../src/adapter/standard/descriptor.js'
import { verifyAndPromote } from '../src/adapter/kernel/lifecycle.js'
import { buildHostCapabilityLifecycles, refreshHostCapabilityLifecycles } from '../src/adapter/upstream/host-descriptor-driver.js'
import { BUILTIN_BACKEND_IDS } from '../src/kernelPrefs.js'
import { backendAdmission } from '../src/dsh-adapter/backend-admission.js'
import { backendContributionOf } from '../src/dsh-adapter/backend-contribution.js'
import { getBackend, listBackends, listOfferedBackends, loadBackend, registerBackend, unloadBackends } from '../src/dsh-adapter/backend-registry.js'
import { installSurfaceFor } from '../src/dsh-adapter/backends.js'
import type { BackendHost } from '../src/agent/backend.js'
import { manifest as probeManifest, manifestWithoutInstall, PROBE_BACKEND_ID, PROBE_DECLARED_CAPABILITIES, PROBE_INSTALL_SPECIFIER } from './fixtures/probe-backend/manifest.js'
import { probePoolState } from './fixtures/probe-backend/pool.js'

const ROOT = resolve(import.meta.dirname, '..')
/** The probe's `detect`/`open` take the host the boot would hand them. */
const HOST: BackendHost = { cwd: ROOT, debug: () => undefined, warn: () => undefined }
const probeLoad = (): Promise<Record<string, unknown>> => import('./fixtures/probe-backend/index.js')

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const throws = (body: () => unknown): boolean => {
  try { body(); return false } catch { return true }
}

// ── 1. Dogfood: the built-ins project onto the public declaration ────────────
/** Every key a contribution may carry. A key outside this list is either an
 *  in-tree fact that leaked through the projection or a field the spec does not
 *  have — both are projection bugs, and the bad baseline below proves the checker
 *  says so. */
const PUBLIC_SPEC_KEYS = ['id', 'label', 'shortLabel', 'product', 'capabilities', 'grants', 'install', 'unloadExport', 'confirmation']
const IN_TREE_PRIVATE_KEYS = ['inTree', 'alwaysAvailable', 'nativeKey', 'vendorPackages', 'backendExport']
const leakedKeys = (projection: Record<string, unknown>): readonly string[] => [
  ...Object.keys(projection).filter(key => !PUBLIC_SPEC_KEYS.includes(key)),
  ...IN_TREE_PRIVATE_KEYS.filter(key => key in projection),
]
for (const id of ['dsh', 'claude', 'codex'] as const) {
  const manifest = getBackend(id)?.manifest
  assert.ok(manifest !== undefined, `built-in manifest ${id} is registered`)
  const projection = backendContributionOf(manifest)
  check(`${id}: the projected declaration passes the family validator`,
    throws(() => validateBackendSpec(projection)) === false)
  check(`${id}: the projection leaks no in-tree private key`, leakedKeys(projection).length === 0, leakedKeys(projection))
  check(`${id}: the projection is pure (two projections are deep-equal)`,
    JSON.stringify(backendContributionOf(manifest)) === JSON.stringify(projection))
  check(`${id}: the registry admitted the projected declaration`,
    getBackend(id)?.admission.decision === 'compatible', getBackend(id)?.admission)
}
check('the AgentBackends declare session surfaces, the non-AgentBackend declares none',
  (getBackend('claude')?.manifest.capabilities?.length ?? 0) > 0
    && (getBackend('codex')?.manifest.capabilities?.length ?? 0) > 0
    && getBackend('dsh')?.manifest.capabilities?.length === 0)
check('bad baseline goes red — the private-key checker catches a leaked `nativeKey`',
  leakedKeys({ ...backendContributionOf(getBackend('codex')!.manifest), nativeKey: 'codex' }).includes('nativeKey'))
// The dogfood experiment the plan calls for: take a built-in out of the in-tree set
// and the *only* thing left to refuse is its host label key — refused by the
// projection itself, which is why the exported projection cannot be used to launder
// a first-party name. (Registration refuses the same combination one step earlier.)
check('dogfood: flipping `inTree` on a built-in reds on its host label key, and nothing else does',
  throws(() => backendContributionOf({ ...getBackend('claude')!.manifest, inTree: false }))
    && throws(() => validateBackendSpec(backendContributionOf(getBackend('claude')!.manifest))) === false)

// ── 2. Single source: capability names and reserved ids ───────────────────────
{
  const file = join(ROOT, 'src', 'agent', 'capabilities.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let members: string[] = []
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'SessionCapabilities') {
      members = statement.members.map(member => member.name?.getText(source) ?? '').filter(name => name !== '')
    }
  }
  assert.ok(members.length > 0, 'SessionCapabilities members are extractable')
  const onlyInterface = members.filter(name => !BACKEND_CAPABILITY_NAMES.includes(name))
  const onlyConstant = BACKEND_CAPABILITY_NAMES.filter(name => !members.includes(name))
  check('the capability vocabulary is exactly SessionCapabilities, both ways',
    onlyInterface.length === 0 && onlyConstant.length === 0, { onlyInterface, onlyConstant })
  check('the capability vocabulary has no duplicates',
    new Set(BACKEND_CAPABILITY_NAMES).size === BACKEND_CAPABILITY_NAMES.length)
  // The bidirectional compare is the point: one direction catches a stale constant
  // (a member renamed away), the other catches an invented name.
  check('bad baseline goes red — a stale or invented capability name fails one direction each',
    ['inventedCapability'].filter(name => !members.includes(name)).length === 1
      && members.filter(name => ![...members, 'inventedCapability'].includes(name)).length === 0
      && ['inventedCapability'].filter(name => !BACKEND_CAPABILITY_NAMES.includes(name)).length === 1)
  const builtInIds = BUILTIN_BACKEND_IDS as readonly string[]
  const onlyRegistry = builtInIds.filter(id => !BACKEND_RESERVED_IDS.includes(id))
  const onlyProfile = BACKEND_RESERVED_IDS.filter(id => !builtInIds.includes(id))
  check('the reserved id list is exactly the registry built-ins, both ways',
    onlyRegistry.length === 0 && onlyProfile.length === 0, { onlyRegistry, onlyProfile })
}

// ── 3. Admission: the verdicts this host can produce ──────────────────────────
{
  const facts = {
    reservedIds: new Set<string>(BUILTIN_BACKEND_IDS),
    capabilityNames: new Set<string>(BACKEND_CAPABILITY_NAMES),
    permissionNames: new Set<string>(EXPECTED_PERMISSIONS.map(permission => permission.name)),
    granted: new Set<string>(),
  }
  const spec = (overrides: Record<string, unknown>): Parameters<typeof backendAdmission>[0] =>
    ({ id: 'example-agent', label: { text: 'Example' }, shortLabel: 'Example', capabilities: [], grants: [], ...overrides })
  const compatible = backendAdmission(spec({ capabilities: ['permissions', 'rename'] }), facts)
  const degraded = backendAdmission(spec({ capabilities: ['permissions', 'not-a-surface'] }), facts)
  const waiting = backendAdmission(spec({ grants: ['storage.local.read'] }), facts)
  const unknownName = backendAdmission(spec({ grants: ['totally.invented.permission'] }), facts)
  const reserved = backendAdmission(spec({ id: 'dsh' }), facts)
  check('admission: a declaration this host can honor is compatible', compatible.decision === 'compatible')
  check('admission: an unknown capability name degrades and is recorded, it does not refuse',
    degraded.decision === 'compatible_degraded' && degraded.missingOptional.includes('capability:not-a-surface'),
    degraded)
  check('admission: a known permission with no grant waits for authorization',
    waiting.decision === 'waiting_authorization' && waiting.reasonCode === 'PERMISSION_NOT_GRANTED'
      && waiting.deniedPermissions.join(',') === 'storage.local.read', waiting)
  check('admission: an unknown permission name degrades too (D-3), it never becomes a "usable" grant',
    unknownName.decision === 'compatible_degraded'
      && unknownName.missingOptional.includes('permission:totally.invented.permission'), unknownName)
  check('admission: a reserved id is refused with the contract\'s own reason code',
    reserved.decision === 'rejected' && reserved.reasonCode === 'BACKEND_ID_RESERVED', reserved)
  // The contract is the family's published error vocabulary — the C stage's
  // descriptor and third-party backends write error handling against it. It must
  // equal what this host can actually return: a name no path produces is a phantom
  // (the shape refusals are `validateBackendSpec()` TypeErrors, and the unknown
  // capability path degrades instead of refusing), and the waiting state's code is
  // the shared `PERMISSION_NOT_GRANTED`, not a `BACKEND_`-prefixed twin.
  const publishedCodes = (JSON.parse(readFileSync(
    join(ROOT, 'tui-profile', 'registry', 'contracts', 'backend-v1alpha1.json'), 'utf8',
  )) as { errors?: readonly string[] }).errors ?? []
  check('admission: the contract profile publishes no code the admission path cannot produce',
    [...publishedCodes].sort().join(',') === 'BACKEND_ID_RESERVED,PERMISSION_NOT_GRANTED', publishedCodes)
  // `unknown` is reserved for a future protocol version and deliberately not
  // produced here: W-1 knows the family's single apiVersion. Asserting its absence
  // keeps "we never return it by accident" honest without pretending to implement a
  // version negotiation that does not exist yet.
  check('admission: the `unknown` verdict is never produced under W-1',
    [compatible, degraded, waiting, unknownName, reserved].every(verdict => verdict.decision !== 'unknown'))
  check('bad baseline goes red — an unknown permission never reaches `compatible`',
    unknownName.decision !== 'compatible' && waiting.decision !== 'compatible_degraded')
}

// ── 4. The probe backend: resource invariants, install shapes, coverage ──────
{
  registerBackend({ manifest: probeManifest, load: probeLoad })
  registerBackend({ manifest: manifestWithoutInstall, load: probeLoad })

  check('probe: registering without loading neither imports the module nor opens its pool',
    probePoolState().opens === 0, probePoolState())
  await unloadBackends()
  check('probe: unloading an entry that was never loaded closes nothing (and imports nothing)',
    probePoolState().opens === 0 && probePoolState().closes === 0, probePoolState())

  const backend = await loadBackend(PROBE_BACKEND_ID as never)
  check('probe: loading the entry evaluates the module once and hands back the AgentBackend',
    probePoolState().opens === 1 && backend.id === 'probe-backend', probePoolState())
  await unloadBackends()
  check('probe: unloading closes exactly the entry that was loaded, exactly once',
    probePoolState().closes === 1, probePoolState())
  await unloadBackends()
  check('probe: a second unload pass closes nothing (idempotent)', probePoolState().closes === 1)

  // codex's real combination: **no install recipe *and* a process-level pool**. Loading the bare
  // entry books its pool (its module is already evaluated, so `opens` stays where it was) and
  // unloading it closes that pool — "nothing to install" must not read as "nothing to close".
  await loadBackend('probe-backend-bare' as never)
  await unloadBackends()
  check('probe: an entry with no install surface still books its pool and closes it on unload',
    probePoolState().opens === 1 && probePoolState().closes === 2, probePoolState())

  const entry = listBackends().find(candidate => candidate.id === PROBE_BACKEND_ID)
  check('probe: the declared recipe makes the entry installable, and it is the entry\'s own recipe',
    entry?.installable === true && installSurfaceFor(PROBE_BACKEND_ID)?.specifier === PROBE_INSTALL_SPECIFIER)
  const bare = listBackends().find(candidate => candidate.id === 'probe-backend-bare')
  check('probe: a manifest with no recipe is not installable and carries no surface, yet keeps its pool hook (codex\'s shape)',
    bare?.installable === false && installSurfaceFor('probe-backend-bare') === undefined
      && bare?.manifest.unloadExport === 'closeProbePool')
  check('bad baseline goes red — the installable predicate is the declaration, not the id',
    bare?.manifest.install === undefined && installSurfaceFor(PROBE_BACKEND_ID)?.specifier !== bare?.manifest.install)

  // The declaration must cover what the session serves. The probe declares nothing,
  // so a session serving anything at all is the broken variant.
  const { createProbeBackend } = await import('./fixtures/probe-backend/index.js')
  const undeclared = (session: { readonly capabilities: object }, declared: readonly string[]): readonly string[] =>
    Object.keys(session.capabilities).filter(key => !declared.includes(key))
  const healthy = await createProbeBackend().open({ kind: 'create', cwd: ROOT }, HOST)
  check('probe: the session it serves stays inside the declared capability set',
    undeclared(healthy, PROBE_DECLARED_CAPABILITIES).length === 0)
  const broken = await createProbeBackend({ capabilities: { rename: { rename: async () => undefined } } })
    .open({ kind: 'create', cwd: ROOT }, HOST)
  check('bad baseline goes red — a session serving an undeclared capability is caught',
    undeclared(broken, PROBE_DECLARED_CAPABILITIES).join(',') === 'rename')

  // Registered-without-offering: what a `waiting_authorization` entry looks like. No
  // in-tree backend is in this state (all declare `grants: []`), so the probe states
  // it — and the picker projection is where "not offered" has to be visible.
  const grantedName = EXPECTED_PERMISSIONS.find(permission => permission.default === 'deny')?.name ?? EXPECTED_PERMISSIONS[0]!.name
  registerBackend({ manifest: { ...probeManifest, id: 'probe-waiting', grants: [grantedName] }, load: probeLoad })
  check('probe: an entry waiting for a grant is registered, carries its refusal, and is not offered',
    getBackend('probe-waiting')?.admission.decision === 'waiting_authorization'
      && listBackends().some(candidate => candidate.id === 'probe-waiting')
      && !listOfferedBackends().some(candidate => candidate.id === 'probe-waiting'))
}

// ── 5. Bad declarations are refused, loudly ───────────────────────────────────
{
  // (a) What the registry must refuse for a manifest that is not this host's own:
  // the pre-projection rules (a built-in id, a host label key, a native channel),
  // and the two the projection feeds straight into the family validator.
  const manifestCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a non-in-tree manifest may not wear a built-in id', { ...probeManifest, id: 'dsh' }],
    ['a non-in-tree manifest may not use a host label key', { ...probeManifest, id: 'probe-key', label: { kind: 'key', key: 'kernel-label-claude' } }],
    ['a non-in-tree manifest may not declare a native channel', { ...probeManifest, id: 'probe-native', nativeKey: 'probe' }],
    ['capabilities must be strings', { ...probeManifest, id: 'probe-caps', capabilities: [42] }],
    ['the install recipe must be complete', { ...probeManifest, id: 'probe-install', install: { executor: 'pnpm-profile-add', specifier: PROBE_INSTALL_SPECIFIER } }],
  ]
  for (const [label, manifest] of manifestCases) {
    check(`refused at registration: ${label}`, throws(() => registerBackend({ manifest: manifest as never, load: probeLoad })))
  }
  // (b) What the *declaration* validator must refuse, independent of any registry:
  // a contribution's spec is data from outside this process, and these are the
  // shapes that would let it claim something the host does not offer.
  const projection = backendContributionOf(getBackend('claude')!.manifest)
  const specCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a declaration may not carry an unknown field', { ...projection, extra: true }],
    ['a declaration may not carry an in-tree private key', { ...projection, nativeKey: 'claude' }],
    ['a label is literal text, never a host key', { ...projection, label: { kind: 'key', key: 'kernel-label-claude' } }],
    ['a label must carry text', { ...projection, label: {} }],
    ['capabilities must be an array of strings', { ...projection, capabilities: 'permissions' }],
    ['grants must be an array', { ...projection, grants: [1] }],
    ['the install recipe must be complete', { ...projection, install: { executor: 'pnpm-profile-add', version: '1.0.0' } }],
    ['the confirmation policy is one this host implements', { ...projection, confirmation: { policy: 'trusted' } }],
  ]
  for (const [label, declaration] of specCases) {
    check(`refused at validation: ${label}`, throws(() => validateBackendSpec(declaration)))
  }
  // The positive direction: the policies this host implements are accepted, and the
  // vocabulary is exactly the frozen pair. `trusted-source` asks the host to apply its
  // own source judgment (curated list, provenance cross-checked when the registry
  // offers it); declaring it is a request — the judgment that can honor it lands with
  // the install / enable chain, and a request that does not hold falls back to `confirm`.
  check('accepted at validation: the trusted-source confirmation policy',
    throws(() => validateBackendSpec({ ...projection, confirmation: { policy: 'trusted-source' } })) === false)
  check('the implemented confirmation policies are exactly confirm and trusted-source',
    [...BACKEND_CONFIRMATION_POLICIES].join(',') === 'confirm,trusted-source',
    [...BACKEND_CONFIRMATION_POLICIES])
}

// ── 6. Wired (W-2): the family reaches the registry / descriptor chain ───────
{
  const backendCoordinate = `${BACKEND.apiVersion}#${BACKEND.kind}`
  const hostContracts = HOST_SUPPORTED_CONTRACTS.map(contract => `${contract.apiVersion}#${contract.kind}`)
  check('wired: the host supports the Backend coordinate',
    hostContracts.includes(backendCoordinate), hostContracts)
  const specData = loadSpecData()
  assert.ok(specData !== undefined, 'the in-tree tui-profile data is loadable')
  const registry = JSON.parse(readFileSync(
    join(ROOT, 'tui-profile', 'registry', 'registry-0.15.json'), 'utf8',
  )) as ContractRegistry
  const read = registryEntries(registry).map(entry => `${entry.coordinates.apiVersion}#${entry.coordinates.kind}`)
  check('wired: registryEntries() reads imports+definitions+extensions, and the Backend coordinate is among them',
    read.length === registry.imports.length + registry.definitions.length + registry.extensions.length
      && read.includes(backendCoordinate), read)
  // The digest pin is the point of the entry: it is what makes "change the profile
  // text without moving the coordinate" fail closed (notes 0009's known gap 5).
  const entry = registry.extensions.find(candidate => candidate.name === 'tui.backend')
  const pinned = entry !== undefined && 'profile' in entry
    ? digestFile(join(ROOT, 'tui-profile'), entry.profile)
    : undefined
  check('wired: a registry entry pins the Backend contract profile, and its sha256 matches the file',
    entry !== undefined && 'profileHash' in entry && entry.profileHash === pinned, { entry, pinned })
  // Both halves of the family must be mounted on the canonical catalog: the
  // manifest extension definition a contribution is validated against, and the
  // contract coordinate the descriptor advertises.
  const { protocols, manifests } = getAdmissionCatalog()
  check('wired: the canonical admission catalog registers the Backend contribution definition and its contract',
    manifests.extension(BACKEND) !== undefined && protocols.resolve(BACKEND) !== undefined)
  const registrationCallers = (dir: string): readonly string[] => {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...registrationCallers(path))
      else if (/\.tsx?$/u.test(entry.name) && readFileSync(path, 'utf8').includes('registerTuiContributionExtensions(')) found.push(path)
    }
    return found
  }
  const callers = registrationCallers(join(ROOT, 'src'))
  const canonicalCatalog = join(ROOT, 'src', 'adapter', 'standard', 'tui-extension.ts')
  check('wired: the canonical admission catalog is the one production module registering the contribution definitions',
    callers.length === 1 && callers[0] === canonicalCatalog, callers.map(path => relative(ROOT, path)))

  // Publication, both directions. A descriptor that advertised the coordinate
  // without the probe would be the "declares support, cannot deliver" failure the
  // W-1 boundary warned about; one that kept it without the registry entry would be
  // the same lie one layer down.
  const driverHost = (probe: (() => unknown) | undefined): unknown => ({
    get: (name: string) => name === 'tuiPluginHost'
      ? {
          hostDescriptor: () => ({ descriptor: { contracts: [] }, dropped: [], warnings: [] }),
          describe: () => ({ descriptor: { contracts: [] }, dropped: [], warnings: [] }),
          subscribeDecision: () => () => undefined,
          probeDecisionEvents: () => [],
          ...(probe === undefined ? {} : { probeBackendAdmission: probe }),
        }
      : undefined,
  })
  const publish = (probe: (() => unknown) | undefined): ReturnType<typeof buildHostDescriptorFromLifecycles> =>
    buildHostDescriptorFromLifecycles(
      buildHostCapabilityLifecycles(driverHost(probe) as never).map(verifyAndPromote),
      { generationId: 'w2-gate' },
    )
  const answering = publish(() => ({ registered: 3, offered: 3, verdict: 'compatible' }))
  const backendContract = answering.descriptor.contracts.find(contract => contract.kind === 'Backend')
  check('wired: with the admission machine answering, the descriptor publishes the pinned Backend contract',
    backendContract !== undefined
      && backendContract.apiVersion === BACKEND.apiVersion
      && backendContract.definition.source === 'tui-profile'
      && backendContract.definition.profileHash === pinned, backendContract)
  const silent = publish(undefined)
  check('wired (fail-closed): without the probe the coordinate is not published, and the drop is reported',
    !silent.descriptor.contracts.some(contract => contract.kind === 'Backend')
      && silent.warnings.some(warning => warning.includes(backendCoordinate)), silent.warnings)
  check('wired (fail-closed): a machine that cannot admit a contribution is not evidence either',
    publish(() => ({ registered: 0, offered: 0, verdict: 'rejected' })).descriptor.contracts.length === 0
      && publish(() => { throw new Error('admission machine unavailable') }).descriptor.contracts.length === 0)
  // A completed refresh *replaces* the whole lifecycle set, so the coordinate has
  // to be re-derived there too: publishing it from the synchronous projection only
  // would advertise it before the first refresh and drop it right after.
  const refreshed = (await refreshHostCapabilityLifecycles(
    driverHost(() => ({ registered: 3, offered: 3, verdict: 'compatible' })) as never,
  )).map(verifyAndPromote).find(lifecycle => lifecycle.capability === backendCoordinate)
  check('wired: the async live refresh re-derives the coordinate (no flip-flop after a refresh)',
    refreshed?.state === 'live' && refreshed.detection.state === 'supported', refreshed)

  // Bad baselines — the two load-bearing checkers above, on mutated inputs.
  const withoutEntry = {
    ...registry,
    extensions: registry.extensions.filter(candidate => candidate.name !== 'tui.backend'),
  }
  check('bad baseline goes red — drop the registry entry and the coordinate leaves registryEntries()',
    !registryEntries(withoutEntry).some(candidate =>
      `${candidate.coordinates.apiVersion}#${candidate.coordinates.kind}` === backendCoordinate))
  const driftedEntry = {
    ...registry,
    extensions: registry.extensions.map(candidate => candidate.name === 'tui.backend'
      ? { ...candidate, profileHash: `sha256:${'0'.repeat(64)}` }
      : candidate),
  }
  check('bad baseline goes red — a drifted profileHash is reported by verifyRegistry()',
    verifyRegistry({ ...specData, registry: driftedEntry }).some(failure => failure.includes('tui.backend')),
    verifyRegistry({ ...specData, registry: driftedEntry }))
}

console.log(`\nverify-backend-contribution OK (${passed} checks)`)
