import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { validateMessageEvent } from './std-modules.js'
import {
  validateTuiChannelInput,
  validateTuiChannelRequirement,
  validateTuiChannelSnapshot,
  validateTuiChannelSupport,
} from '../../protocols/tui-channel.js'
import {
  BACKEND,
  BACKEND_CONFIRMATION_POLICIES,
  BACKEND_RESERVED_IDS,
  assertBackendHandler,
  backendExtensionDefinition,
  validateBackendSpec,
} from '../../protocols/tui-contributions.js'
import {
  root,
  load,
  schemas,
  profile,
  protocols,
  manifestDefinitions,
  check,
  parseAndValidateManifest,
  validateHost,
  admissionDecision,
} from './admission-core.js'

function validate(name, body, schema, semanticCheck) {
  try {
    if (schema !== undefined) check(body, schema, schema)
    semanticCheck?.(body)
    return { name, pass: true }
  } catch (error) {
    return { name, pass: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function digestFile(relative) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`
}

function verifyProfileDefinitions() {
  assert.equal(profile.std.submodule, 'vendor/dsh-std')
  assert.equal(profile.std.manifestVersion, '0.15')
  assert.equal(fs.existsSync(path.join(root, 'schemas/dsh-plugin.schema.json')), false, 'manifest schema must come from dsh-std')
  assert.equal(fs.existsSync(path.join(root, 'registry/contracts/commands-0.15.json')), false, 'Command must come from @dsh-std/command')
  assert.equal(fs.existsSync(path.join(root, 'registry/contracts/storage.local-0.15.json')), false, 'LocalStorage must come from @dsh-std/storage')
  assert.equal(fs.existsSync(path.join(root, 'registry/contracts/messages.observe-0.15.json')), false, 'MessageObserver must come from @dsh-std/messages')
  assert.equal(fs.existsSync(path.join(root, 'schemas/messages-observe-envelope.schema.json')), false, 'MessageObserver schema must come from @dsh-std/messages')
  assert.equal(fs.existsSync(path.join(root, 'registry/contracts/workspace-provider-v1alpha1.json')), true, 'legacy WorkspaceProvider reference path must remain available')
  for (const entry of profile.definitions) {
    assert.equal(digestFile(entry.profile), entry.profileHash, `${entry.name}: profile hash drifted`)
    assert.equal(protocols.understands(entry.coordinates), true, `${entry.name}: no dsh-std ProtocolDefinition is registered`)
    const contract = load(entry.profile)
    for (const key of ['name', 'version', 'kind', 'coordinates', 'caller', 'permissions', 'errors', 'concurrency', 'timeout', 'cleanup', 'privacyClass', 'securityBoundary']) {
      assert.ok(key in contract, `${entry.name}: profile missing ${key}`)
    }
    assert.deepEqual(contract.coordinates, entry.coordinates, `${entry.name}: profile coordinates differ`)
    assert.deepEqual([...contract.permissions].sort(), [...entry.permissions].sort(), `${entry.name}: permissions differ`)
    assert.equal(entry.authority, 'dsh-tui', `${entry.name}: local definition must belong to dsh-TUI`)
    assert.match(entry.coordinates.apiVersion, /^tui\.dsh\//u, `${entry.name}: private definition must use the TUI namespace`)
  }
  for (const entry of profile.extensions ?? []) {
    if (entry.authority === 'dsh-std') {
      assert.notEqual(manifestDefinitions.extension(entry.coordinates), undefined, `${entry.name}: imported manifest extension definition is unavailable`)
      continue
    }
    assert.equal(digestFile(entry.profile), entry.profileHash, `${entry.name}: profile hash drifted`)
    assert.notEqual(manifestDefinitions.extension(entry.coordinates), undefined, `${entry.name}: no manifest extension definition is registered`)
    const contract = load(entry.profile)
    for (const key of ['name', 'version', 'kind', 'coordinates', 'caller', 'permissions', 'errors', 'concurrency', 'timeout', 'cleanup', 'privacyClass', 'securityBoundary']) {
      assert.ok(key in contract, `${entry.name}: profile missing ${key}`)
    }
    assert.equal(contract.kind, 'extension', `${entry.name}: contract kind must be extension`)
    assert.deepEqual(contract.coordinates, entry.coordinates, `${entry.name}: profile coordinates differ`)
    assert.deepEqual([...contract.permissions].sort(), [...entry.permissions].sort(), `${entry.name}: permissions differ`)
    assert.equal(entry.authority, 'dsh-tui', `${entry.name}: local extension must belong to dsh-TUI`)
  }
  for (const entry of profile.imports) {
    assert.equal(protocols.understands(entry.coordinates), true, `${entry.package}: imported dsh-std definition is unavailable`)
  }
}

verifyProfileDefinitions()

const manifestCases = [
  ['valid plugin', 'conformance/fixtures/valid-plugin.json', true],
  ['valid TUI contributions', 'conformance/fixtures/valid-tui-contributions.json', true],
  ['valid plugin coordinate subscriptions', 'conformance/fixtures/valid-plugin-object-subs.json', true],
  ['valid private protocol plugin', 'conformance/fixtures/valid-private-protocol-plugin.json', true],
  ['invalid service rejected', 'conformance/fixtures/invalid-plugin-unknown-service.json', false],
  ['duplicate command rejected', 'conformance/fixtures/invalid-plugin-duplicate-command.json', false],
  ['unknown coordinate rejected', 'conformance/fixtures/invalid-plugin-unknown-coordinate.json', false],
  ['unknown kind rejected', 'conformance/fixtures/invalid-plugin-unknown-kind.json', false],
  ['subscription to capability rejected', 'conformance/fixtures/invalid-plugin-subscription-capability.json', false],
  ['duplicate coordinate rejected', 'conformance/fixtures/invalid-plugin-duplicate-coordinate.json', false],
  ['facet apiVersion rejected', 'conformance/fixtures/invalid-plugin-facet-version.json', false],
  ['client facet rejected', 'conformance/fixtures/invalid-plugin-client-facet.json', false],
  ['worker facet rejected', 'conformance/fixtures/invalid-plugin-worker-facet.json', false],
  ['optional without fallback rejected', 'conformance/fixtures/invalid-plugin-optional-no-fallback.json', false],
  ['provides rejected', 'conformance/fixtures/invalid-plugin-provides.json', false],
  ['unknown version remains structurally valid', 'conformance/fixtures/unknown-version-plugin.json', true],
  ['compound unknown remains structurally valid', 'conformance/fixtures/plugin-compound-unknown.json', true],
]
const cases = manifestCases.map(([name, relative, expected]) => {
  const result = validate(name, undefined, undefined, () => parseAndValidateManifest(relative))
  assert.equal(result.pass, expected, `${name}: ${result.error ?? `expected pass=${expected}`}`)
  return result
})
for (const [name, relative, schema, semanticCheck, expected] of [
  ['valid message', 'conformance/fixtures/valid-message.json', undefined, validateMessageEvent, true],
  ['invalid privacy rejected', 'conformance/fixtures/invalid-message-privacy.json', undefined, validateMessageEvent, false],
  ['invalid content rejected', 'conformance/fixtures/invalid-message-content.json', undefined, validateMessageEvent, false],
  ['mixed content rejected', 'conformance/fixtures/invalid-message-mixed-content.json', undefined, validateMessageEvent, false],
  ['valid ledger', 'conformance/fixtures/valid-ledger-record.json', schemas.ledger, undefined, true],
  ['valid claim', 'conformance/fixtures/valid-claim.json', schemas.claim, undefined, true],
]) {
  const result = validate(name, load(relative), schema, semanticCheck)
  assert.equal(result.pass, expected, `${name}: ${result.error ?? `expected pass=${expected}`}`)
  cases.push(result)
}
{
  const fixture = load('conformance/fixtures/valid-tui-channel.json')
  const result = validate('valid TUI channel envelopes', fixture, undefined, value => {
    validateTuiChannelRequirement(value.requirement)
    validateTuiChannelSupport(value.support)
    validateTuiChannelInput('open', value.open)
    validateTuiChannelSnapshot(value.snapshot)
  })
  assert.equal(result.pass, true, result.error)
  cases.push(result)
}
// ── Backend contribution family (TUI-BACKEND-001) ─────────────────────────────
// The family is a third extension kind in the same catalog as Scene and
// SettingsSection: a manifest contributes `tui.dsh/v1alpha1#Backend` exactly like
// the other two, and the definition — not a second registry reader — is what
// validates it. Coordinates, shape and the reserved-value refusals are all
// checked here; the host-side admission decision on top of that shape lives in
// the dsh-TUI repository (scripts/verify-backend-contribution.ts).
{
  assert.notEqual(manifestDefinitions.extension(BACKEND), undefined, 'Backend extension definition is registered')
  // The catalog stores a frozen copy of the definition, so identity is asserted
  // through the validator this family owns rather than the object wrapper.
  assert.equal(manifestDefinitions.extension(BACKEND).validateSpec, backendExtensionDefinition.validateSpec)
  assert.notEqual(manifestDefinitions.extension({ apiVersion: 'tui.dsh/v1alpha1', kind: 'Backend' }), undefined)
  // A second definition for the same coordinate is refused: the catalog is keyed
  // by coordinate and a family cannot be re-registered onto another one.
  let duplicateRefused = false
  try { manifestDefinitions.registerExtension(backendExtensionDefinition) } catch { duplicateRefused = true }
  assert.equal(duplicateRefused, true, 'duplicate Backend coordinate is refused')
}
for (const [name, relative, expected] of [
  ['valid Backend contribution (SDK peer shape: install recipe + pool hook)', 'conformance/fixtures/valid-backend-contribution.json', true],
  // The second shape, on purpose: a backend that drives a system CLI declares **no** install
  // recipe ("the user's own binary is the dependency") while still owning a process-level pool.
  // "Nothing for the host to add" is a first-class declaration, not a missing field.
  ['valid Backend contribution (system CLI shape: no install recipe, pool hook)', 'conformance/fixtures/valid-backend-contribution-cli.json', true],
  // This is the nativeKey refusal the roadmap names (§4.7 / §6 item 7): the fixture's shape is
  // "unknown field", and the refusal it produces names `nativeKey` verbatim
  // (`Backend content contains unknown field "nativeKey"`) — see notes 0009.
  ['Backend native channel rejected (unknown field)', 'conformance/fixtures/invalid-backend-unknown-field.json', false],
  ['Backend bad id rejected', 'conformance/fixtures/invalid-backend-bad-id.json', false],
  ['Backend host label key rejected', 'conformance/fixtures/invalid-backend-key-label.json', false],
  ['Backend capability shape rejected', 'conformance/fixtures/invalid-backend-capability-shape.json', false],
  ['Backend install recipe incomplete rejected', 'conformance/fixtures/invalid-backend-install-incomplete.json', false],
  ['Backend confirmation policy rejected', 'conformance/fixtures/invalid-backend-confirmation-policy.json', false],
  ['Backend grants shape rejected', 'conformance/fixtures/invalid-backend-grants-shape.json', false],
]) {
  const result = validate(name, undefined, undefined, () => parseAndValidateManifest(relative))
  assert.equal(result.pass, expected, `${name}: ${result.error ?? `expected pass=${expected}`}`)
  cases.push(result)
}
{
  const spec = {
    id: 'example-agent',
    label: { text: 'Example Agent' },
    shortLabel: 'Example',
    capabilities: ['permissions', 'anything-this-host-does-not-know'],
    grants: [],
  }
  const accepted = validate('Backend declaration accepts unknown capability names (degraded, not refused)', spec, undefined, value => {
    const frozen = validateBackendSpec(value)
    assert.equal(Object.isFrozen(frozen), true)
    assert.deepEqual(frozen.capabilities, ['permissions', 'anything-this-host-does-not-know'])
  })
  assert.equal(accepted.pass, true, accepted.error)
  cases.push(accepted)
  const refused = (label, value) => {
    const result = validate(label, undefined, undefined, () => validateBackendSpec(value))
    assert.equal(result.pass, false, `${label}: expected a refusal`)
    cases.push(result)
  }
  refused('Backend native channel refused', { ...spec, nativeKey: 'example' })
  refused('Backend confirmation policy refused when it is not one this host implements', { ...spec, confirmation: { policy: 'trusted' } })
  refused('Backend install recipe must be complete', { ...spec, install: { executor: 'pnpm-profile-add', specifier: '@example/agent@1.0.0' } })
  const handler = validate('Backend handler assertion accepts the runtime AgentBackend shape', undefined, undefined, () => {
    assertBackendHandler({ id: 'example-agent', descriptor: {}, detect: async () => ({}), open: async () => ({}), catalog: {}, launch: {} })
  })
  assert.equal(handler.pass, true, handler.error)
  cases.push(handler)
  const broken = validate('Backend handler assertion refuses a handler without open()', undefined, undefined, () => {
    assertBackendHandler({ id: 'example-agent', detect: async () => ({}) })
  })
  assert.equal(broken.pass, false, 'Backend handler missing open() must be refused')
  cases.push(broken)
  assert.equal(BACKEND_CONFIRMATION_POLICIES.includes('confirm'), true, 'confirm stays the reserved default policy')
  // The reserved ids are vocabulary, not shape: the host refuses a *contribution*
  // wearing one at admission (`BACKEND_ID_RESERVED`), while its own seed — the
  // bundled backends — legitimately carries them. Publishing the list here is what
  // lets that refusal name the same set.
  assert.deepEqual([...BACKEND_RESERVED_IDS], ['dsh', 'claude', 'codex'])
  const seedShape = validate('Backend declaration shape accepts a host-owned id (the seed is not a contribution)', { ...spec, id: BACKEND_RESERVED_IDS[0] }, undefined, value => {
    validateBackendSpec(value)
  })
  assert.equal(seedShape.pass, true, seedShape.error)
  cases.push(seedShape)
}
for (const [name, relative, expected] of [
  ['valid host descriptor', 'registry/host-descriptor.tui.example.json', true],
  ['host unknown protocol rejected', 'conformance/fixtures/invalid-host-unknown-contract.json', false],
  ['host profile hash mismatch rejected', 'conformance/fixtures/invalid-host-hash-mismatch.json', false],
  ['host unknown permission rejected', 'conformance/fixtures/invalid-host-unknown-permission.json', false],
  ['host duplicate protocol rejected', 'conformance/fixtures/invalid-host-duplicate-contract.json', false],
]) {
  const host = load(relative)
  const result = validate(name, host, schemas.host, validateHost)
  assert.equal(result.pass, expected, `${name}: ${result.error ?? `expected pass=${expected}`}`)
  cases.push(result)
}

const host = load('registry/host-descriptor.tui.example.json')
const minimalHost = load('conformance/fixtures/host-no-observe.example.json')
const negotiation = {
  compatible: admissionDecision('conformance/fixtures/valid-plugin.json', host),
  privateUnavailable: admissionDecision('conformance/fixtures/valid-private-protocol-plugin.json', host),
  waiting: admissionDecision('conformance/fixtures/waiting-authorization-plugin.json', host),
  authorized: admissionDecision('conformance/fixtures/waiting-authorization-plugin.json', host, ['messages.observe.read']),
  rejected: admissionDecision('conformance/fixtures/waiting-authorization-plugin.json', minimalHost),
  degraded: admissionDecision('conformance/fixtures/valid-plugin.json', minimalHost),
  unknown: admissionDecision('conformance/fixtures/unknown-version-plugin.json', host),
  compoundUnknown: admissionDecision('conformance/fixtures/plugin-compound-unknown.json', minimalHost),
  facetMismatch: admissionDecision('conformance/fixtures/valid-plugin.json', load('conformance/fixtures/invalid-host-facet-version.json')),
}
assert.equal(negotiation.compatible.decision, 'compatible')
assert.equal(negotiation.privateUnavailable.reasonCode, 'REQUIRED_PROTOCOL_UNAVAILABLE')
assert.equal(negotiation.waiting.decision, 'waiting_authorization')
assert.equal(negotiation.authorized.decision, 'compatible')
assert.equal(negotiation.rejected.decision, 'rejected')
assert.equal(negotiation.degraded.decision, 'compatible_degraded')
assert.equal(negotiation.unknown.decision, 'unknown')
assert.equal(negotiation.compoundUnknown.decision, 'unknown')
assert.equal(negotiation.facetMismatch.reasonCode, 'FACET_API_VERSION_UNAVAILABLE')

console.log(JSON.stringify({ suite: 'dsh-tui-admission-v0.15', std: profile.std, cases, negotiation }, null, 2))
