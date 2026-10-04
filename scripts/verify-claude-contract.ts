/**
 * Claude backend version contract: every copy of the SDK pin must agree, and
 * the option classification must exist.
 *
 *  1. `package.json`: `@anthropic-ai/claude-agent-sdk` is an exact version
 *     (no range) as an optional peer dependency and as a dev dependency, the
 *     two equal;
 *  2. `src/backends/claude/contract.ts` `VALIDATED_SDK_VERSION` is that
 *     version;
 *  3. `pnpm-lock.yaml`: the root importer's dev dependency has that
 *     specifier and resolves to that version; the package entry exists, and
 *     every platform binary package it lists as optional resolves to the
 *     same version;
 *  4. `pnpm-workspace.yaml` `minimumReleaseAgeExclude` exempts exactly that
 *     version of the SDK and of every platform package the lockfile lists
 *     (no stale version of either left behind);
 *  5. the installed SDK (when installed) is that version, and the CLI
 *     version its `manifest.json` declares parity with is in
 *     `VALIDATED_CLI_VERSIONS`;
 *  6. `src/backends/claude/options.ts` classifies every SDK option with
 *     `satisfies Record<keyof Options, …>` over the SDK's own `Options`
 *     type — `tsc` then fails when the SDK adds or removes an option, so
 *     the clause must exist (and be the SDK's type, not a local alias).
 *
 * Mutations to self-test the gate: change one pin (package.json peer or
 * dev, the contract, a lockfile resolution, a workspace exemption) or drop
 * the `satisfies` clause — each fails a named check.
 *
 * Run: node --import tsx/esm scripts/verify-claude-contract.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION } from '../src/backends/claude/contract.js'

const ROOT = resolve(import.meta.dirname, '..')
const SDK = '@anthropic-ai/claude-agent-sdk'
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
type Rec = Record<string, unknown>
const rec = (value: unknown): Rec => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : {})
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

// ── 1. package.json ─────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Rec
const peer = rec(manifest.peerDependencies)[SDK]
const dev = rec(manifest.devDependencies)[SDK]
check('package.json: the SDK is an exact-version peer dependency', typeof peer === 'string' && EXACT.test(peer), peer)
check('package.json: … an OPTIONAL peer (a DSH-only install never fetches it)', rec(rec(manifest.peerDependenciesMeta)[SDK]).optional === true)
check('package.json: … and a dev dependency of the same exact version', dev === peer, { peer, dev })
check('package.json: never a runtime dependency (it would install the platform binaries for every user)', rec(manifest.dependencies)[SDK] === undefined && rec(manifest.optionalDependencies)[SDK] === undefined)
const pinned = String(peer)

// ── 2. contract.ts ──────────────────────────────────────────────────────
check(`contract.ts: VALIDATED_SDK_VERSION is the pin (${pinned})`, VALIDATED_SDK_VERSION === pinned, VALIDATED_SDK_VERSION)

// ── 3. the lockfile ─────────────────────────────────────────────────────
const lock = rec(parseYaml(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')))
const importer = rec(rec(rec(lock.importers)['.']).devDependencies)[SDK]
check('pnpm-lock.yaml: the root importer pins the same specifier', rec(importer).specifier === pinned, importer)
const resolvedVersion = String(rec(importer).version ?? '').split('(')[0]
check('pnpm-lock.yaml: … and resolves to the pinned version', resolvedVersion === pinned, rec(importer).version)
const packages = rec(lock.packages)
const snapshots = rec(lock.snapshots)
const sdkKeys = Object.keys(packages).filter(key => key.startsWith(`${SDK}@`))
check('pnpm-lock.yaml: exactly one SDK version is locked, the pinned one', sdkKeys.length === 1 && sdkKeys[0] === `${SDK}@${pinned}`, sdkKeys)
const snapshot = Object.entries(snapshots).find(([key]) => key.startsWith(`${SDK}@${pinned}`))?.[1]
const platforms = Object.entries(rec(rec(snapshot).optionalDependencies)).filter(([name]) => name.startsWith(`${SDK}-`))
check('pnpm-lock.yaml: the SDK lists its platform binaries as optional dependencies', platforms.length > 0, platforms.length)
check('pnpm-lock.yaml: … every one at the pinned version', platforms.every(([, version]) => version === pinned), platforms)
const platformKeys = Object.keys(packages).filter(key => key.startsWith(`${SDK}-`))
check('pnpm-lock.yaml: … and every locked platform package is one of them, at the pin', platformKeys.length === platforms.length && platformKeys.every(key => platforms.some(([name]) => key === `${name}@${pinned}`)), platformKeys)

// ── 4. pnpm-workspace.yaml exemptions ───────────────────────────────────
const workspace = rec(parseYaml(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')))
const exempt = (Array.isArray(workspace.minimumReleaseAgeExclude) ? workspace.minimumReleaseAgeExclude : []).filter((entry): entry is string => typeof entry === 'string')
const sdkExempt = exempt.filter(entry => entry === SDK || entry.startsWith(`${SDK}@`) || entry.startsWith(`${SDK}-`))
const expected = [`${SDK}@${pinned}`, ...platforms.map(([name]) => `${name}@${pinned}`)].sort()
check('pnpm-workspace.yaml: minimumReleaseAgeExclude exempts the pinned SDK and each platform package, at the pin', JSON.stringify([...sdkExempt].sort()) === JSON.stringify(expected), { exempt: sdkExempt, expected })

// ── 5. the installed SDK and its CLI parity ─────────────────────────────
const installed = join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
if (existsSync(join(installed, 'package.json'))) {
  const version = rec(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))).version
  check('node_modules: the installed SDK is the pinned version', version === pinned, version)
  const parity = existsSync(join(installed, 'manifest.json')) ? rec(JSON.parse(readFileSync(join(installed, 'manifest.json'), 'utf8'))).version : undefined
  check('contract.ts: the CLI the SDK declares parity with is validated', typeof parity === 'string' && VALIDATED_CLI_VERSIONS.includes(parity), { parity, validated: VALIDATED_CLI_VERSIONS })
} else {
  console.log('SKIP node_modules checks (the optional SDK is not installed)')
}

// ── 6. the exhaustive Options classification ────────────────────────────
const options = readFileSync(join(ROOT, 'src', 'backends', 'claude', 'options.ts'), 'utf8')
check('options.ts: imports the SDK\'s own `Options` type', /import type \{[^}]*\bOptions\b[^}]*\} from '@anthropic-ai\/claude-agent-sdk'/u.test(options))
check('options.ts: OPTION_POLICY is checked `satisfies Record<keyof Options, OptionPolicy>`', /export const OPTION_POLICY = \{[\s\S]*?\} as const satisfies Record<keyof Options, OptionPolicy>/u.test(options))

console.log(`\nverify-claude-contract OK (${passed} checks)`)
