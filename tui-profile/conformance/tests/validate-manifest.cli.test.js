// Regression for the real-plugin CLI (scripts/validate-manifest.mjs), driven
// through scripts/conformance.mjs --manifest. Requires the built/linked
// dsh-std fallback (run `npm run build:std` or `npm run test:standalone` once).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(root, 'scripts', 'conformance.mjs')
const fixture = name => path.join(root, 'conformance', 'fixtures', name)
const exampleHost = path.join(root, 'registry', 'host-descriptor.tui.example.json')

function runCli(manifest, { host, grant, expectStatus, expectDecision, expectReason } = {}) {
  const args = [cli, '--manifest', manifest, '--no-build']
  if (host !== undefined) args.push('--host', host)
  if (grant !== undefined) args.push('--grant', grant)
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  const stdout = result.stdout ?? ''
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  const last = lines[lines.length - 1]
  let report
  try {
    report = JSON.parse(last)
  } catch {
    assert.fail(`unparseable stdout: ${stdout}`)
  }
  assert.equal(result.status, expectStatus, `exit=${result.status} stdout=${stdout}`)
  if (expectDecision !== undefined) assert.equal(report.decision, expectDecision, JSON.stringify(report))
  if (expectReason !== undefined) assert.equal(report.reasonCode, expectReason, JSON.stringify(report))
  return report
}

test('valid plugin admits against the example host', () => {
  runCli(fixture('valid-plugin.json'), { expectStatus: 0, expectDecision: 'compatible' })
})

test('valid plugin admits against a host that also exposes the TUI private protocol', () => {
  runCli(fixture('valid-plugin.json'), { host: fixture('cli-host-private-profile.json'), expectStatus: 0, expectDecision: 'compatible' })
})

test('private-protocol plugin admits when the host exposes tui.dsh#DecisionEvents', () => {
  runCli(fixture('valid-private-protocol-plugin.json'), { host: fixture('cli-host-private-profile.json'), expectStatus: 0, expectDecision: 'compatible' })
})

test('private-protocol plugin is rejected when the host does not support it', () => {
  runCli(fixture('valid-private-protocol-plugin.json'), {
    host: exampleHost,
    expectStatus: 1,
    expectDecision: 'rejected',
    expectReason: 'REQUIRED_PROTOCOL_UNAVAILABLE',
  })
})

test('invalid host (wrong std package) is rejected as HOST_INVALID', () => {
  const report = runCli(fixture('valid-plugin.json'), { host: fixture('cli-host-wrong-package.json'), expectStatus: 1 })
  assert.equal(report.decision, 'rejected')
  assert.equal(report.reasonCode, 'HOST_INVALID')
})

test('default-deny permission yields waiting_authorization', () => {
  runCli(fixture('waiting-authorization-plugin.json'), {
    host: exampleHost,
    expectStatus: 0,
    expectDecision: 'waiting_authorization',
  })
})

test('granting the default-deny permission upgrades to compatible', () => {
  runCli(fixture('waiting-authorization-plugin.json'), {
    host: exampleHost,
    grant: 'messages.observe.read',
    expectStatus: 0,
    expectDecision: 'compatible',
  })
})

test('missing optional + denied permission reports waiting_authorization (not compatible_degraded)', () => {
  runCli(fixture('cli-plugin-optional-deny.json'), {
    host: exampleHost,
    expectStatus: 0,
    expectDecision: 'waiting_authorization',
  })
})

test('unknown registry version reports the five-state unknown decision', () => {
  runCli(fixture('unknown-version-plugin.json'), {
    host: exampleHost,
    expectStatus: 1,
    expectDecision: 'unknown',
    expectReason: 'UNKNOWN_PROTOCOL_VERSION',
  })
})

test('absolute host path resolves on every platform', () => {
  runCli(fixture('valid-plugin.json'), {
    host: exampleHost.replace(/\//g, path.sep),
    expectStatus: 0,
    expectDecision: 'compatible',
  })
})
