/**
 * Codex backend contract gate (docs/codex-backend-design.md D3, §10.3), part
 * of `verify:build`:
 *
 *  1. `src/backends/codex/protocol/generated/` is the generator's output:
 *     its digest equals `PROTOCOL_DIGEST`, its README names
 *     `PROTOCOL_VERSION`, and that version is validated;
 *  2. every method name in the protocol tables (`protocol/index.ts`) is in
 *     the generated unions (client requests/notifications, server
 *     notifications, server requests);
 *  3. no protocol-shaped string literal anywhere else in the backend names a
 *     method the generated unions lack (a typo, or a method an upgrade
 *     removed);
 *  4. `package.json` declares no Codex npm package (the backend drives the
 *     user's own binary; the platform packages are huge);
 *  5. the version helpers agree with the policy (`0.160.x` ≥ the validated
 *     patch is compatible, another minor drifts, below the minimum is
 *     unsupported).
 *
 * Mutations to self-test the gate: edit a generated file, change the digest
 * or version in contract.ts, add a misspelled method to a table or a
 * literal `'thread/strat'` in a backend file, add `@openai/codex` to
 * package.json — each fails a named check.
 *
 * Run: node --import tsx/esm scripts/verify-codex-contract.ts
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  codexVersionDrift,
  codexVersionSupported,
  compareCodexVersions,
  MIN_CODEX_VERSION,
  parseCodexVersion,
  PROTOCOL_DIGEST,
  PROTOCOL_VERSION,
  VALIDATED_CODEX_VERSIONS,
} from '../src/backends/codex/contract.js'
import { PROTOCOL_NAMES } from '../src/backends/codex/protocol/index.js'
import { protocolDigest } from './lib/codex-protocol-digest.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const BACKEND = join(ROOT, 'src', 'backends', 'codex')
const GENERATED = join(BACKEND, 'protocol', 'generated')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── 1. the generated tree ───────────────────────────────────────────────
const { digest, files } = protocolDigest(GENERATED)
check(`generated/: digest matches contract.ts PROTOCOL_DIGEST (${files} files)`, digest === PROTOCOL_DIGEST, { tree: digest, contract: PROTOCOL_DIGEST })
const readme = readFileSync(join(GENERATED, 'README.md'), 'utf8')
check(`generated/README.md names codex-cli ${PROTOCOL_VERSION}`, readme.includes(`codex-cli ${PROTOCOL_VERSION}`))
check('contract.ts: PROTOCOL_VERSION is a validated version', VALIDATED_CODEX_VERSIONS.includes(PROTOCOL_VERSION), { PROTOCOL_VERSION, VALIDATED_CODEX_VERSIONS })

// ── 2. the method tables ────────────────────────────────────────────────
const methodsOf = (file: string): Set<string> =>
  new Set([...readFileSync(join(GENERATED, file), 'utf8').matchAll(/"method": "([^"]+)"/gu)].map(match => match[1]!))
const clientRequests = methodsOf('ClientRequest.ts')
const clientNotifications = methodsOf('ClientNotification.ts')
const serverNotifications = methodsOf('ServerNotification.ts')
const serverRequests = methodsOf('ServerRequest.ts')
check('generated unions parsed', clientRequests.size > 50 && serverNotifications.size > 30 && serverRequests.size > 3 && clientNotifications.has('initialized'),
  { clientRequests: clientRequests.size, serverNotifications: serverNotifications.size, serverRequests: serverRequests.size })
const missing = (names: readonly string[], ...sets: Set<string>[]): string[] => names.filter(name => !sets.some(set => set.has(name)))
check('protocol/index.ts: every CLIENT method is a generated client request/notification',
  missing(PROTOCOL_NAMES.client, clientRequests, clientNotifications).length === 0, missing(PROTOCOL_NAMES.client, clientRequests, clientNotifications))
check('protocol/index.ts: every NOTIFY / opt-out method is a generated server notification',
  missing(PROTOCOL_NAMES.notifications, serverNotifications).length === 0, missing(PROTOCOL_NAMES.notifications, serverNotifications))
check('protocol/index.ts: every SERVER_REQUEST method is a generated server request',
  missing(PROTOCOL_NAMES.serverRequests, serverRequests).length === 0, missing(PROTOCOL_NAMES.serverRequests, serverRequests))

// ── 3. protocol-shaped literals in the backend ──────────────────────────
const every = new Set([...clientRequests, ...clientNotifications, ...serverNotifications, ...serverRequests])
const NAMESPACES = ['thread', 'turn', 'item', 'account', 'model', 'mcpServer', 'mcpServerStatus', 'serverRequest', 'hook', 'config', 'skills',
  'collaborationMode', 'permissionProfile', 'review', 'autoApprovalReview', 'command', 'process', 'fs', 'app', 'attestation', 'currentTime']
const LITERAL = new RegExp(`'((?:${NAMESPACES.join('|')})/[A-Za-z_/]+)'`, 'gu')
const sources: string[] = []
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { if (path !== GENERATED) walk(path) } else if (/\.tsx?$/u.test(entry.name)) sources.push(path)
  }
}
walk(BACKEND)
const unknownLiterals: string[] = []
for (const file of sources) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/u.test(line)) return
    for (const match of line.matchAll(LITERAL)) {
      if (!every.has(match[1]!)) unknownLiterals.push(`${relative(ROOT, file).split(sep).join('/')}:${index + 1} '${match[1]}'`)
    }
  })
}
check(`backend sources (${sources.length} files): every protocol-shaped literal is a generated method`, unknownLiterals.length === 0, unknownLiterals)

// ── 4. no Codex npm package ─────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  .flatMap(field => Object.keys((manifest[field] ?? {}) as Record<string, unknown>))
  .filter(name => /^@openai\/codex/u.test(name))
check('package.json: no @openai/codex* dependency of any kind', declared.length === 0, declared)

// ── 5. the version policy ───────────────────────────────────────────────
check('parseCodexVersion reads `codex-cli X.Y.Z`', parseCodexVersion('codex-cli 0.160.1\n') === '0.160.1')
check('a validated version does not drift', VALIDATED_CODEX_VERSIONS.every(version => codexVersionDrift(version) === undefined))
const [major, minor, patch] = VALIDATED_CODEX_VERSIONS[0]!.split('.').map(Number) as [number, number, number]
check('a later patch on the validated minor line does not drift', codexVersionDrift(`${major}.${minor}.${patch + 3}`) === undefined)
check('the next minor drifts', codexVersionDrift(`${major}.${minor + 1}.0`) === `${major}.${minor + 1}.0`)
check('MIN_CODEX_VERSION is not above a validated version', VALIDATED_CODEX_VERSIONS.every(version => (compareCodexVersions(MIN_CODEX_VERSION, version) ?? 1) <= 0))
check('below MIN_CODEX_VERSION is unsupported; at it, supported', !codexVersionSupported('0.1.0') && codexVersionSupported(MIN_CODEX_VERSION))

console.log(`\nverify-codex-contract OK (${passed} checks)`)
