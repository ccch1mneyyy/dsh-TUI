/**
 * The standalone entry's host contract (src/dsh-adapter/host-contract.ts,
 * ADAPTER.md), part of `verify:contract`: manifest consistency, the capability
 * probe on fake hosts and (when one is found via PATH or DSH_TUI_CONTRACT_DSH)
 * the installed host, the `dsh --profile` fallback, and the replica
 * fingerprints in host-replica.snapshot.json. No installed host in CI, so
 * those parts skip there.
 *
 * Run: node --import tsx/esm scripts/verify-host-contract.ts [--snapshot]
 * (`--snapshot` rewrites the fingerprints from an installed host on the line.)
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { HOST_MODULES, HOST_PACKAGE, HOST_REPLICA_VERSION, HOST_REPLICAS, HOST_TYPE_PACKAGES } from '../src/dsh-adapter/host-contract.js'
import { UPSTREAM_BLESSED_PACKAGES, UPSTREAM_VALIDATED_VERSION, upstreamDriftSummary } from '../src/dsh-adapter/contract.js'
import { findHostDsh, loadHostDsh } from '../src/dsh-adapter/host-dsh.js'
import { fingerprintReplica } from './lib/host-replicas.js'

const repo = resolve(import.meta.dirname, '..')
const snapshotPath = join(repo, 'host-replica.snapshot.json')
const SNAPSHOT = process.argv.includes('--snapshot')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
}
const packageOf = (specifier: string): string => specifier.split('/').slice(0, 2).join('/')

// ── 1. the contract's own consistency ──────────────────────────────────
const blessed = new Set<string>(UPSTREAM_BLESSED_PACKAGES)
for (const name of HOST_TYPE_PACKAGES) check(`${name} is blessed`, blessed.has(name))
for (const spec of HOST_MODULES) {
  const name = packageOf(spec.specifier)
  check(`${spec.specifier} belongs to a declared package`, blessed.has(name) || name === HOST_PACKAGE || name === '@deepseek-ai/cordis-plugin-loader', name)
}
check('module keys are unique', new Set(HOST_MODULES.map(spec => spec.key)).size === HOST_MODULES.length)
check('the replicas were checked against the primary validated line', HOST_REPLICA_VERSION === UPSTREAM_VALIDATED_VERSION,
  `HOST_REPLICA_VERSION ${HOST_REPLICA_VERSION} vs UPSTREAM_VALIDATED_VERSION ${UPSTREAM_VALIDATED_VERSION}: review HOST_REPLICAS when the line moves`)
// A profile has no copy of the host packages: their absence is no broken host.
const coherent = Object.fromEntries(UPSTREAM_BLESSED_PACKAGES.map(name => [name,
  name === '@deepseek-ai/cordis' ? '4.0.4' : name === '@deepseek-ai/schemastery' ? '3.18.4' : UPSTREAM_VALIDATED_VERSION]))
const withoutHost: Record<string, string | undefined> = { ...coherent }
for (const name of HOST_TYPE_PACKAGES) withoutHost[name] = undefined
check('host packages absent at run time: no drift notice', upstreamDriftSummary(withoutHost) === undefined, upstreamDriftSummary(withoutHost))

// ── 2. the probe on the installed host ────────────────────────────────
const located = process.env.DSH_TUI_CONTRACT_DSH !== undefined ? { packageDir: process.env.DSH_TUI_CONTRACT_DSH } : findHostDsh()
const hostDir = 'packageDir' in located ? realpathSync(located.packageDir) : undefined
const loaded = hostDir === undefined ? undefined : await loadHostDsh(hostDir)
if (loaded === undefined) {
  console.log('SKIP the capability probe and replica hashes: no installed dsh (PATH or DSH_TUI_CONTRACT_DSH)')
} else {
  check('the probe passes on the installed host', loaded.packageDir === hostDir)
  check('the probe hands back a constructible Context', typeof loaded.Context === 'function')
  check('the launch-environment key is read', typeof loaded.launchEnvironmentKey === 'string' && loaded.launchEnvironmentKey !== '')
}

// ── 3. fake hosts, each missing one piece ─────────────────────────────
const fakeRoot = mkdtempSync(join(tmpdir(), 'verify-host-contract-'))
interface FakeOptions { readonly dropExport?: { readonly key: string; readonly name: string }; readonly dropModule?: string }
let fakeCount = 0
/** A host package laid out as npm installs it: nested node_modules, a bin. */
function fakeHost(options: FakeOptions = {}): string {
  const dir = join(fakeRoot, `host-${fakeCount++}`, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: HOST_PACKAGE, version: '0.0.0-fake.0', type: 'module', bin: { dsh: 'lib/bin.js' },
    exports: { './profile-boot': './lib/profile-boot.js', './package.json': './package.json' },
  }))
  for (const spec of HOST_MODULES) {
    if (spec.key === options.dropModule) continue
    const exports = spec.exports.filter(name => !(options.dropExport?.key === spec.key && options.dropExport.name === name))
    const body = exports.map(name => name === 'default'
      ? 'export default function Fake() {}'
      : name === 'Context' || name === 'StartupError' ? `export class ${name} {}` : `export const ${name} = ${JSON.stringify(name)}`).join('\n') + '\n'
    if (spec.specifier === `${HOST_PACKAGE}/profile-boot`) {
      writeFileSync(join(dir, 'lib', 'profile-boot.js'), body)
      continue
    }
    const moduleDir = join(dir, 'node_modules', ...spec.specifier.split('/'))
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: spec.specifier, version: '0.0.0-fake.0', type: 'module', main: 'index.js' }))
    writeFileSync(join(moduleDir, 'index.js'), body)
  }
  return dir
}
const rejection = async (dir: string): Promise<string | undefined> => {
  try {
    await loadHostDsh(dir)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
check('the complete fake host passes the probe', await rejection(fakeHost()) === undefined, await rejection(fakeHost()))
for (const spec of HOST_MODULES) {
  const short = spec.specifier.replace(/^@deepseek-ai\//u, '')
  for (const name of spec.exports) {
    const message = await rejection(fakeHost({ dropExport: { key: spec.key, name } }))
    check(`a host without ${short}.${name} is refused, naming it`, message?.includes(`lacks ${short}.${name}`) === true, message)
  }
  const missing = await rejection(fakeHost({ dropModule: spec.key }))
  const expected = spec.key === 'appBoot' ? 'does not resolve' : 'does not load'
  check(`a host without ${short} is refused, naming it`, missing?.includes(spec.specifier) === true && missing.includes(expected), missing)
}

// ── 4. the entry falls back on such a host ────────────────────────────
// A fake host lacking one export, its bin on PATH as npm links it. The bin
// records what the delegated `dsh --profile` received and exits 7.
const brokenHost = fakeHost({ dropExport: { key: 'cmdline', name: 'provideCmdline' } })
const record = join(fakeRoot, 'delegated.json')
writeFileSync(join(brokenHost, 'lib', 'bin.js'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), notice: process.env.DSH_TUI_HOST_NOTICE }))
process.exit(7)
`)
chmodSync(join(brokenHost, 'lib', 'bin.js'), 0o755)
const binDir = join(fakeRoot, 'bin')
mkdirSync(binDir)
symlinkSync(join(brokenHost, 'lib', 'bin.js'), join(binDir, 'dsh'))
const entryHome = mkdtempSync(join(tmpdir(), 'verify-host-contract-home-'))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [binDir, dirname(process.execPath)].join(delimiter),
  HOME: entryHome,
  USERPROFILE: entryHome,
  DSH_HOME: join(entryHome, '.dsh'),
  DSH_TUI_BACKEND: 'dsh',
}
for (const name of ['DSH_TUI_HOST_ENTRY', 'DSH_TUI_BACKEND_HANDOFF', 'DSH_TUI_HANDOFF_ACK_FD', 'DSH_TUI_RESTART_CHILD', 'DSH_TUI_HOST_NOTICE', 'DSH_TUI_PROFILE']) delete env[name]
const entry = spawnSync(process.execPath, ['--import', 'tsx/esm', join(repo, 'src', 'dsh-adapter', 'host-entry.ts'), 'hello'], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 })
const delegated = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; notice?: string } : undefined
check('the entry hands a host it cannot use to `dsh --profile`', JSON.stringify(delegated?.args) === JSON.stringify(['--profile', 'dsh-tui', '--', 'hello']), { delegated, stderr: entry.stderr })
check('the entry mirrors the delegated exit', entry.status === 7, { status: entry.status, signal: entry.signal, stderr: entry.stderr })
check('the reason reaches stderr', /cannot host this launch \(dsh 0\.0\.0-fake\.0 at .* lacks dsh-cmdline\.provideCmdline\); starting DSH through `dsh --profile`/u.test(entry.stderr), entry.stderr)
check('the reason reaches the delegated screen', delegated?.notice?.includes('lacks dsh-cmdline.provideCmdline') === true, delegated)
rmSync(fakeRoot, { recursive: true, force: true })
rmSync(entryHome, { recursive: true, force: true })

// ── 5. replica fingerprints ───────────────────────────────────────────
interface Snapshot {
  readonly hostVersion: string
  /** sha256 per HOST_REPLICAS id. */
  readonly replicas: Record<string, string>
}
const fingerprints = (resolvePackage: (name: string) => string): Snapshot['replicas'] => Object.fromEntries(HOST_REPLICAS.map(replica =>
  [replica.id, fingerprintReplica(resolvePackage(replica.package), replica)]))
const onLine = loaded !== undefined && loaded.version === HOST_REPLICA_VERSION
const installed = loaded === undefined ? undefined : (() => {
  const hostRequire = createRequire(join(loaded.packageDir, 'package.json'))
  return fingerprints(name => name === HOST_PACKAGE ? loaded.packageDir : dirname(hostRequire.resolve(`${name}/package.json`)))
})()
if (SNAPSHOT) {
  if (!onLine || loaded === undefined || installed === undefined) {
    console.error(`--snapshot needs an installed dsh ${HOST_REPLICA_VERSION} (found ${loaded?.version ?? 'none'})`)
    process.exit(1)
  }
  const snapshot: Snapshot = { hostVersion: loaded.version, replicas: installed }
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`host-replica snapshot written: ${snapshotPath} (${loaded.version})`)
  process.exit(0)
}
check('host-replica.snapshot.json exists', existsSync(snapshotPath), 'run with --snapshot')
const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
const ids = (list: readonly string[]): string => [...list].sort().join(',')
check('the snapshot is on the replica line', recorded.hostVersion === HOST_REPLICA_VERSION,
  `snapshot ${recorded.hostVersion} vs HOST_REPLICA_VERSION ${HOST_REPLICA_VERSION}: review HOST_REPLICAS on an installed host of the line, then --snapshot`)
check('the snapshot records exactly HOST_REPLICAS', ids(Object.keys(recorded.replicas)) === ids(HOST_REPLICAS.map(replica => replica.id)), 'run with --snapshot')
const changed = (against: Snapshot['replicas']): string[] => HOST_REPLICAS
  .filter(replica => against[replica.id] !== recorded.replicas[replica.id])
  .map(replica => `${replica.id}: ${replica.package} ${replica.symbol} → review ${replica.local}`)
const hostChanged = installed === undefined ? [] : changed(installed)
if (onLine && hostChanged.length > 0) {
  console.error(`Host replica surface needs review (snapshot ${recorded.hostVersion}, installed ${loaded?.packageDir}):`)
  for (const line of hostChanged) console.error(`  - ${line}`)
  console.error('Carry upstream changes into src/dsh-adapter/host-dsh.ts (or record why not), then run node --import tsx/esm scripts/verify-host-contract.ts --snapshot')
  process.exit(1)
}
if (onLine) passed += 1
else if (hostChanged.length > 0) {
  console.warn(`host contract warning: the installed dsh ${loaded?.version} (${loaded?.packageDir}) differs from the recorded ${recorded.hostVersion} in:`)
  for (const line of hostChanged) console.warn(`  - ${line}`)
}
console.log(`host contract OK (${passed} checks; ${HOST_MODULES.length} modules, ${HOST_REPLICAS.length} replica fingerprints on ${recorded.hostVersion})`)
process.exit(0)
