/** Files shared by the zero-build market entry and the terminal launcher. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'

export const PACKAGE = '@deepseek-harness-tui/dsh-tui'
export const RUNTIME_BUNDLE = '@deepseek-harness-tui/dsh-tui-runtime'
export const PROFILE = 'dsh-tui'
export const RESCUE_PROFILE = 'dsh-tui-safe'

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error(`Cannot read ${path}`, { cause: error })
  }
}

export function packageDirectory(profileDir) {
  return join(profileDir, 'node_modules', ...PACKAGE.split('/'))
}

export function ownedDirectory(profileDir) {
  return join(profileDir, '.dsh-tui')
}

export function recipeDirectory(profileDir, version, patchSha256) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('The TUI package must have an exact release version')
  }
  if (!/^[a-f0-9]{64}$/u.test(patchSha256)) throw new Error('The TUI patch digest is invalid')
  return join(ownedDirectory(profileDir), 'runtime-bundles', `${version}-${patchSha256}`)
}

export function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Compare exact package versions without making Git installs depend on semver. */
export function compareVersions(left, right) {
  const parts = version => version.split('+')[0].split(/-(.*)/su).filter(Boolean)
  const [a, ap] = parts(left)
  const [b, bp] = parts(right)
  const aa = a.split('.').map(Number)
  const bb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1
  if (ap === bp) return 0
  if (ap === undefined || bp === undefined) return ap === undefined ? 1 : -1
  const ar = ap.split('.')
  const br = bp.split('.')
  for (let i = 0; i < Math.max(ar.length, br.length); i++) {
    if (ar[i] === br[i]) continue
    if (ar[i] === undefined || br[i] === undefined) return ar[i] === undefined ? -1 : 1
    const an = /^\d+$/u.test(ar[i])
    const bn = /^\d+$/u.test(br[i])
    if (an !== bn) return an ? -1 : 1
    return an ? Math.sign(Number(ar[i]) - Number(br[i])) : ar[i] > br[i] ? 1 : -1
  }
  return 0
}

export function runtimeTemplate(packageRoot) {
  const manifest = readJson(join(packageRoot, 'package.json'))
  if (manifest?.name !== PACKAGE || manifest.dshTui?.runtimeBundle !== './lib/tui-runtime') {
    throw new Error('This package does not contain a prepared TUI runtime')
  }
  const source = join(packageRoot, 'lib', 'tui-runtime')
  const bundle = readJson(join(source, 'package.json'))
  const patch = readFileSync(join(source, 'cordis.patch.yml'))
  recipeDirectory(packageRoot, manifest.version, digest(patch))
  if (bundle?.name !== RUNTIME_BUNDLE || bundle.version !== manifest.version
    || bundle.dependencies?.[PACKAGE] !== manifest.version
    || bundle.dsh?.bundle?.patch !== './cordis.patch.yml'
    || bundle.dshTui?.patchSha256 !== digest(patch)) {
    throw new Error('The TUI runtime bundle is missing, stale or damaged')
  }
  for (const path of [manifest.main, 'lib/types/dsh-adapter/host-entry.js', 'bin/dsh-tui.js']) {
    if (typeof path !== 'string' || !existsSync(join(packageRoot, path))) {
      throw new Error('The TUI runtime is incomplete; install the matching published package')
    }
  }
  return { manifest, bundle, patch, source }
}

/** Readiness is derived from installed files and selection, never a success flag. */
export function runtimeStatus(profileDir) {
  const packageRoot = packageDirectory(profileDir)
  const manifest = readJson(join(packageRoot, 'package.json'))
  const profile = readJson(join(profileDir, 'package.json'))
  const result = { ready: false, version: typeof manifest?.version === 'string' ? manifest.version : undefined, profileDir, packageRoot }
  if (manifest === undefined || profile === undefined) return result
  try {
    const template = runtimeTemplate(packageRoot)
    const recipe = recipeDirectory(profileDir, template.manifest.version, template.bundle.dshTui.patchSha256)
    const installed = join(profileDir, 'node_modules', ...RUNTIME_BUNDLE.split('/'))
    const recipeManifest = readJson(join(recipe, 'package.json'))
    const installedManifest = readJson(join(installed, 'package.json'))
    const bundles = profile.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || bundles.includes(PACKAGE)
      || bundles.filter(name => name === RUNTIME_BUNDLE).length !== 1
      || recipeManifest?.version !== template.manifest.version
      || recipeManifest.dependencies?.[PACKAGE] !== template.manifest.version
      || installedManifest?.name !== RUNTIME_BUNDLE || installedManifest.version !== template.manifest.version
      || installedManifest.dependencies?.[PACKAGE] !== template.manifest.version
      || digest(readFileSync(join(recipe, 'cordis.patch.yml'))) !== template.bundle.dshTui.patchSha256
      || digest(readFileSync(join(installed, 'cordis.patch.yml'))) !== template.bundle.dshTui.patchSha256) return result
    const spec = profile.dependencies?.[RUNTIME_BUNDLE]
    if (typeof spec !== 'string' || !spec.startsWith('file:')
      || resolve(profileDir, spec.slice(5)) !== resolve(recipe)) return result
    return { ...result, ready: true, recipe }
  } catch (error) {
    return { ...result, problem: error.message }
  }
}

/** Materialize a self-contained, immutable file dependency outside node_modules. */
export async function materializeRecipe(profileDir, packageRoot) {
  const template = runtimeTemplate(packageRoot)
  const target = recipeDirectory(profileDir, template.manifest.version, template.bundle.dshTui.patchSha256)
  const expected = Buffer.from(`${JSON.stringify(template.bundle, null, 2)}\n`)
  if (existsSync(target)) {
    if (!expected.equals(await readFile(join(target, 'package.json')))
      || !template.patch.equals(await readFile(join(target, 'cordis.patch.yml')))) {
      throw new Error(`The immutable TUI recipe at ${target} differs from this release`)
    }
    return target
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(temporary, { mode: 0o700 })
  try {
    await writeFile(join(temporary, 'package.json'), expected, { mode: 0o600 })
    await writeFile(join(temporary, 'cordis.patch.yml'), template.patch, { mode: 0o600 })
    await rename(temporary, target)
  } finally { await rm(temporary, { recursive: true, force: true }) }
  return target
}

/** Replace the public bundle's old layer, keeping later user bundles above it. */
export function runtimeBundleOrder(bundles) {
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    throw new Error('The target profile has an invalid bundle selection')
  }
  const index = bundles.findIndex(name => name === PACKAGE || name === RUNTIME_BUNDLE)
  if (index < 0) throw new Error('The TUI package is not selected in its profile')
  const next = bundles.filter(name => name !== PACKAGE && name !== RUNTIME_BUNDLE)
  next.splice(index, 0, RUNTIME_BUNDLE)
  return next
}

/** A PID alone can belong to an unrelated process after an unclean exit. */
export async function liveRuntimeProcesses(profileDir, { keepUnverified = false } = {}) {
  const value = readJson(join(ownedDirectory(profileDir), 'running.json')) ?? []
  if (!Array.isArray(value)) throw new Error('The TUI running-process record is invalid')
  const live = await Promise.all(value.map(async entry => {
    if (!Number.isSafeInteger(entry?.pid) || entry.pid <= 0 || typeof entry.token !== 'string'
      || !Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65535) return false
    try { process.kill(entry.pid, 0) }
    catch (error) { if (error.code === 'ESRCH') return false }
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: entry.port })
      let response = ''
      const finish = (error, matches = false) => {
        socket.destroy()
        // Lease bookkeeping may retain an unresponsive owner while adding or
        // removing itself. Package mutations still fail on uncertain ownership.
        if (error && !keepUnverified) reject(error)
        else resolve(error ? true : matches)
      }
      // A busy or suspended owner is not permission to replace its files.
      socket.setTimeout(2000, () => finish(new Error(`Cannot verify TUI process ${entry.pid}; retry after it responds or exits`)))
      socket.on('error', error => finish(error.code === 'ECONNREFUSED' ? undefined : error))
      socket.on('data', data => {
        response += data.toString('utf8')
        if (response.includes('\n') || response.length > 128) finish(undefined, response === `${entry.token}\n`)
      })
      socket.on('end', () => finish(undefined, response === `${entry.token}\n`))
    })
  }))
  return value.filter((entry, index) => live[index])
}
