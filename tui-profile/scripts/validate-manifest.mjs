#!/usr/bin/env node
/**
 * Validate a real plugin's `dsh-plugin.json` against this profile and negotiate
 * admission with a host descriptor — using the SAME admission core as the
 * conformance suite (conformance/tests/admission-core.js), so a plugin's
 * conformance evidence is computed by exactly the algorithm the suite exercises.
 *
 * Usage (usually through conformance.mjs, which prepares dsh-std first):
 *   npm run validate:manifest -- --manifest ./path/to/dsh-plugin.json [--host ./host.json] [--grant <permission>]
 *   node scripts/conformance.mjs --manifest ./path/to/dsh-plugin.json [--host ...] [--standalone|--no-build]
 *
 * Exit codes:
 *   0  decision is a definitive admissible state: compatible | compatible_degraded | waiting_authorization
 *   1  rejected | unknown | host invalid | manifest invalid (parse/semantic error)
 *   2  usage error
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  check,
  schemas,
  validateHost,
  parseAndValidateManifest,
  admissionDecision,
  loadFile,
} from '../conformance/tests/admission-core.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const take = flag => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const manifestPath = take('--manifest')
const hostPath = take('--host') ?? 'registry/host-descriptor.tui.example.json'
const grants = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--grant') grants.push(args[index + 1])
}

function fail(output, code) {
  console.log(JSON.stringify(output))
  process.exit(code)
}

if (manifestPath === undefined) {
  console.error('usage: npm run validate:manifest -- --manifest <dsh-plugin.json> [--host <host-descriptor.json>] [--grant <permission>]')
  process.exit(2)
}

let host
try {
  host = loadFile(hostPath)
  check(host, schemas.host, schemas.host)
  validateHost(host)
} catch (error) {
  fail({
    manifest: manifestPath,
    host: hostPath,
    valid: false,
    decision: 'rejected',
    reasonCode: 'HOST_INVALID',
    error: error instanceof Error ? error.message : String(error),
  }, 1)
}

try {
  parseAndValidateManifest(manifestPath)
} catch (error) {
  fail({
    manifest: manifestPath,
    host: hostPath,
    valid: false,
    decision: 'rejected',
    reasonCode: 'INVALID_MANIFEST',
    error: error instanceof Error ? error.message : String(error),
  }, 1)
}

const decision = admissionDecision(manifestPath, host, grants)
const ok =
  decision.decision === 'compatible'
  || decision.decision === 'compatible_degraded'
  || decision.decision === 'waiting_authorization'
console.log(JSON.stringify({ manifest: manifestPath, host: hostPath, valid: true, ...decision }))
process.exit(ok ? 0 : 1)
