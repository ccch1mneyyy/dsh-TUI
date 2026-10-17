#!/usr/bin/env node
/** Build offline Windows x64 payload from the release matching this checkout. Node 24+, npm, tar. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import cmdShim from 'cmd-shim'
import { extractContract, selectKernelVersion, compatibleKernelVersions, newerKernelVersions, assertKernelVersion, TUI_PACKAGE, DSH_PACKAGE } from './policy.mjs'
import { normalizeBundledWorkspaceReferences } from './payload-lock.mjs'
import { collectPackageTree, copyRuntimeTree } from './package-tree.mjs'
import { buildArchives } from './archive.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return process.argv[index + 1]
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this payload on Windows x64')
const out = resolve(option('--out', join(root, 'dist-windows')))
const payload = join(out, 'payload')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const metadata = extractContract(pkg, readFileSync(join(root, 'src/dsh-adapter/contract.ts'), 'utf8'))
metadata.nodeVersion = option('--node-version', process.versions.node)
metadata.pnpmVersion = pkg.packageManager.match(/^pnpm@([^+]+)/)?.[1]
if (!/^\d+\.\d+\.\d+$/.test(metadata.nodeVersion) || !metadata.pnpmVersion) throw new Error('Invalid runtime version')
metadata.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
mkdirSync(payload, { recursive: true })

const npmCli = option('--npm-cli', join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'))
if (!existsSync(npmCli)) throw new Error('npm-cli.js was not found; supply --npm-cli <path>')
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args, '--cache', join(out, 'npm-cache'), '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' })
const runtime = join(payload, 'global')
mkdirSync(runtime, { recursive: true })
// Resolve each global package separately. DSH requires its peers; the TUI must
// use the host's Cordis instance and deliberately omits its framework peers.
// Hoisting within each tree avoids shipping thousands of duplicate files.
const locks = option('--locks', undefined)
const kernelOverride = option('--kernel-version', undefined)
if (locks && kernelOverride) throw new Error('--kernel-version cannot be combined with --locks')
// Precedence: an explicit --kernel-version, then a reproducible lock, then the
// newest RC published upstream that the maintained contract still validates.
if (kernelOverride) {
  metadata.kernelVersion = assertKernelVersion(kernelOverride, metadata)
  console.log(`Bundling DSH RC ${metadata.kernelVersion} (explicit --kernel-version)`)
} else if (locks) {
  const locked = JSON.parse(readFileSync(join(resolve(locks), 'dsh.json'), 'utf8')).packages[`node_modules/${DSH_PACKAGE}`].version
  metadata.kernelVersion = selectKernelVersion([locked], metadata)
  console.log(`Bundling DSH RC ${metadata.kernelVersion} from supplied lock`)
} else {
  const published = JSON.parse(execFileSync(process.execPath, [npmCli, 'view', DSH_PACKAGE, 'versions', '--json', '--cache', join(out, 'npm-cache')], { encoding: 'utf8' }))
  metadata.kernelVersion = selectKernelVersion(published, metadata)
  const candidates = compatibleKernelVersions(published, metadata)
  const ahead = newerKernelVersions(published, metadata)
  console.log(`Bundling DSH RC ${metadata.kernelVersion} (newest compatible published RC; candidates: ${candidates.join(', ') || 'none'})`)
  if (ahead.length) console.log(`[warn] Upstream publishes newer RC(s) outside the validated range ${metadata.kernelMinimum}..${metadata.kernelMaximum}: ${ahead.join(', ')}. Bump src/dsh-adapter/contract.ts to adopt them.`)
}
const versions = { [DSH_PACKAGE]: metadata.kernelVersion, [TUI_PACKAGE]: metadata.tuiVersion, pnpm: metadata.pnpmVersion }
for (const [name, version] of Object.entries(versions)) {
  const id = name === DSH_PACKAGE ? 'dsh' : name === TUI_PACKAGE ? 'tui' : 'pnpm'
  const work = join(out, 'packages', id)
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'package.json'), `${JSON.stringify({ private: true, dependencies: { [name]: version } }, null, 2)}\n`)
  const lockfile = join(work, 'package-lock.json')
  if (locks) cpSync(join(resolve(locks), `${id}.json`), lockfile)
  const flags = ['--install-strategy=hoisted', '--ignore-scripts', ...(name === TUI_PACKAGE ? ['--legacy-peer-deps'] : [])]
  if (!existsSync(lockfile) || (!locks && JSON.parse(readFileSync(lockfile, 'utf8')).packages?.['']?.dependencies?.[name] !== version)) npm(['install', '--package-lock-only', ...flags], work)
  writeFileSync(lockfile, `${JSON.stringify(normalizeBundledWorkspaceReferences(JSON.parse(readFileSync(lockfile, 'utf8'))), null, 2)}\n`)
  console.log(`Installing locked ${name}@${version}…`)
  npm(['ci', ...flags], work)
  if (name === DSH_PACKAGE) {
    // Only the upstream native runtime hooks are needed. All unrelated lifecycle
    // scripts stay disabled; rebuild uses the versions already fixed in the lock.
    npm(['rebuild', 'node-pty', 'koffi', '@deepseek-ai/dsh-subprocess-local', '--offline'], work)
  }
  mkdirSync(join(out, 'locks'), { recursive: true })
  cpSync(lockfile, join(out, 'locks', `${id}.json`))
  collectPackageTree(join(work, 'node_modules'), name, join(runtime, 'node_modules', name))
  const location = join(runtime, 'node_modules', name)
  const installed = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'))
  if (installed.version !== version) throw new Error(`Unexpected ${name} version`)
  for (const [command, path] of Object.entries(installed.bin)) await cmdShim(join(location, path), join(runtime, command))
}
// Remove the old combined build manifests when rebuilding an earlier payload.
for (const file of ['package.json', 'package-lock.json']) rmSync(join(runtime, file), { force: true })

const nodeName = `node-v${metadata.nodeVersion}-win-x64`
const downloads = join(out, 'downloads')
mkdirSync(downloads, { recursive: true })
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}
const base = `https://nodejs.org/dist/v${metadata.nodeVersion}`
const checksums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8')
const expected = checksums.split(/\r?\n/).find(line => line.endsWith(`  ${nodeName}.zip`))?.split(/\s+/)[0]
if (!expected) throw new Error('Node archive is absent from official SHA256 manifest')
const archive = join(downloads, `${nodeName}.zip`)
const bytes = existsSync(archive) ? readFileSync(archive) : await download(`${base}/${nodeName}.zip`)
const digest = data => createHash('sha256').update(data).digest('hex')
if (digest(bytes) !== expected) throw new Error('Node archive SHA256 mismatch')
writeFileSync(archive, bytes)
writeFileSync(join(downloads, 'SHASUMS256.txt'), checksums)
execFileSync('tar.exe', ['-xf', archive, '-C', downloads], { stdio: 'inherit' })
rmSync(join(payload, 'node'), { recursive: true, force: true })
copyRuntimeTree(join(downloads, nodeName), join(payload, 'node'))
metadata.nodeArchiveSha256 = expected

const engine = join(out, 'engine')
mkdirSync(engine, { recursive: true })
for (const file of ['install-engine.mjs', 'policy.mjs', 'transaction.mjs', 'integrity.mjs', 'archive.mjs', 'cleanup.mjs', 'windows-system.ps1']) cpSync(join(here, file), join(engine, file))
cpSync(join(here, 'node_modules/semver'), join(engine, 'node_modules/semver'), { recursive: true })
cpSync(join(payload, 'node/node.exe'), join(engine, 'node.exe'))
cpSync(join(payload, 'node/LICENSE'), join(engine, 'NODE-LICENSE.txt'))

const files = {}
function inventory(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) inventory(join(directory, entry.name), relative)
    else if (entry.isFile()) files[relative] = digest(readFileSync(join(directory, entry.name)))
    else throw new Error(`Payload contains a non-portable link: ${relative}`)
  }
}
inventory(payload)
metadata.files = files
metadata.archiveFormat = 'indexed-v1'
metadata.archives = buildArchives(payload, files, out)
writeFileSync(join(out, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
writeFileSync(join(out, 'version.nsh'), `!define TUI_VERSION "${metadata.tuiVersion}"\n!define KERNEL_VERSION "${metadata.kernelVersion}"\n`)
console.log(`Payload ready: ${Object.keys(files).length} verified files; TUI ${metadata.tuiVersion}, DSH ${metadata.kernelVersion}`)
