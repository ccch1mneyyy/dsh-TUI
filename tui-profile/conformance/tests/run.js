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
