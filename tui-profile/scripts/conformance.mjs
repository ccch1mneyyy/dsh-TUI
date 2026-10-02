import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// TUI Profile 现在是 dsh-TUI 仓库内的纯文件，不再自带 vendor/dsh-std 副本：
// standalone 回退统一用仓根的 vendor/dsh-std（本目录下若仍有旧副本则优先）。
const repoRoot = path.resolve(root, '..')
const vendoredStd = fs.existsSync(path.join(root, 'vendor', 'dsh-std'))
  ? path.join(root, 'vendor', 'dsh-std')
  : path.join(repoRoot, 'vendor', 'dsh-std')
const runner = path.join(root, 'conformance', 'tests', 'run.js')
const validateManifest = path.join(root, 'scripts', 'validate-manifest.mjs')
const requiredPackages = [
  '@dsh-std/core',
  '@dsh-std/connection',
  '@dsh-std/manifest',
  '@dsh-std/command',
  '@dsh-std/storage',
  '@dsh-std/messages',
  '@dsh-std/presentation',
  '@dsh-std/workspace',
  '@dsh-std/lifecycle',
]

const args = process.argv.slice(2)
const valueOf = flag => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const collect = flag => args.reduce((all, value, index) => (value === flag ? [...all, args[index + 1]] : all), [])
const manifest = valueOf('--manifest')
const host = valueOf('--host')
const grants = collect('--grant')
const knownOptions = new Set(['--no-build', '--prepare-standalone', '--standalone'])
const valueIndices = new Set()
for (const flag of ['--manifest', '--host', '--grant']) {
  let index = args.indexOf(flag)
  while (index >= 0) {
    valueIndices.add(index)
    valueIndices.add(index + 1)
    index = args.indexOf(flag, index + 1)
  }
}
const options = new Set(args.filter((arg, index) => !valueIndices.has(index)))
for (const option of options) {
  if (!knownOptions.has(option)) throw new Error(`unknown option: ${option}`)
}

function run(command, commandArgs, environment = process.env, cwd = root) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`${command} terminated by ${result.signal}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function executeTarget(environment) {
  if (manifest !== undefined) {
    const command = [validateManifest, '--manifest', manifest]
    if (host !== undefined) command.push('--host', host)
    for (const grant of grants) command.push('--grant', grant)
    run(process.execPath, command, environment)
    return
  }
  run(process.execPath, [runner], environment)
}

function installedStdAvailable() {
  return requiredPackages.every(packageName => {
    try {
      import.meta.resolve(packageName)
      return true
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') return false
      throw error
    }
  })
}

function vendoredStdBuilt() {
  return requiredPackages.every(packageName => fs.existsSync(path.join(
    vendoredStd,
    'packages',
    packageName.slice('@dsh-std/'.length),
    'lib',
    'index.js',
  )))
}

function prepareVendoredStd() {
  run('git', ['submodule', 'update', '--init', '--recursive', 'vendor/dsh-std'], process.env, repoRoot)
  const environment = { ...process.env, CI: process.env.CI ?? 'true' }
  if (process.platform === 'win32') {
    const corepackPnpm = path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    if (!fs.existsSync(corepackPnpm)) {
      throw new Error(`Corepack pnpm entry point is unavailable: ${corepackPnpm}`)
    }
    run(process.execPath, [corepackPnpm, 'install', '--frozen-lockfile'], environment, vendoredStd)
    run(process.execPath, [corepackPnpm, 'build'], environment, vendoredStd)
    return
  }
  run('pnpm', ['install', '--frozen-lockfile'], environment, vendoredStd)
  run('pnpm', ['build'], environment, vendoredStd)
}

function linkVendoredStdPackages() {
  const linkRoot = path.join(root, 'node_modules', '@dsh-std')
  fs.mkdirSync(linkRoot, { recursive: true })
  for (const packageName of requiredPackages) {
    const name = packageName.slice('@dsh-std/'.length)
    const linkPath = path.join(linkRoot, name)
    if (fs.existsSync(linkPath)) continue
    const target = path.join(vendoredStd, 'packages', name)
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

const prepareOnly = options.has('--prepare-standalone')
const forceStandalone = prepareOnly || options.has('--standalone')
const noBuild = options.has('--no-build')

if (!forceStandalone && installedStdAvailable()) {
  console.log('[conformance] using installed @dsh-std packages')
  executeTarget(process.env)
  process.exit(0)
}

if (!vendoredStdBuilt()) {
  if (noBuild) {
    throw new Error('no installed @dsh-std packages or built vendor/dsh-std fallback is available')
  }
  prepareVendoredStd()
} else if (forceStandalone && !noBuild) {
  prepareVendoredStd()
}

if (prepareOnly) process.exit(0)

linkVendoredStdPackages()

console.log(`[conformance] using standalone dsh-std at ${vendoredStd}`)
executeTarget({ ...process.env, DSH_STD_ROOT: vendoredStd })
