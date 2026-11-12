import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { stagePublishBundles } from './lib/publish-bundles.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = join(projectRoot, 'package.json')
const manifestBackupPath = join(projectRoot, 'node_modules/.dsh-tui-publish-bundles/root-package.json')
const bundledPackages = [
  'command',
  'connection',
  'core',
  'manifest',
  'messages',
  'presentation',
  'storage',
]
// Workspace packages under vendor/ that ship bundled like @dsh-std/*: the
// repo depends on them as `workspace:*`, which a published manifest cannot
// carry. The math image backend treats a missing copy as unavailable and
// falls back to Unicode, so the dependency is optional like the others.
const bundledVendorPackages = [
  ['@dsh-tui-vendor/mathjax-tex-svg', 'mathjax-tex-svg'],
]
const [command, ...args] = process.argv.slice(2)
if (command === undefined) throw new Error('usage: node with-publish-manifest.mjs <command> [args...]')

let originalManifest
let restoreBundles
let child
let childSignal
let rejectChild
let terminationError
let stoppingChild = false
let restoring = false
let wroteManifest = false
const forwardSignal = signal => {
  childSignal = signal
  if (child?.pid === undefined || restoring) return
  if (process.platform !== 'win32') { child.kill(signal); return }
  if (stoppingChild) return
  stoppingChild = true
  // npm runs under cmd.exe on Windows. Killing only that shell lets npm keep
  // reading the staged files while they are restored. Wait for our whole tree.
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  // Console Ctrl+C can end cmd.exe before this handler runs. Its exit alone
  // does not prove the descendants stopped, and its old PID is no longer ours.
  const result = child.exitCode !== null || child.signalCode !== null
    ? { error: new Error('Publish shell already exited before its process tree was confirmed stopped') }
    : spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 5000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
    terminationError = new Error(`Could not stop publish process tree ${child.pid}; original manifest at ${manifestBackupPath} and bundle backups preserved in the same directory: ${detail}`)
    child.unref()
    rejectChild?.(terminationError)
  }
}
const onInt = () => forwardSignal('SIGINT')
const onTerm = () => forwardSignal('SIGTERM')
process.on('SIGINT', onInt)
process.on('SIGTERM', onTerm)
try {
  restoreBundles = stagePublishBundles(projectRoot, bundledPackages.map(name => `@dsh-std/${name}`))
  originalManifest = await readFile(manifestPath)
  await writeFile(manifestBackupPath, originalManifest, { flag: 'wx' })
  const manifest = JSON.parse(originalManifest)
  manifest.optionalDependencies ??= {}
  for (const packageName of bundledPackages) {
    const name = `@dsh-std/${packageName}`
    const packageManifest = JSON.parse(await readFile(
      join(projectRoot, 'vendor', 'dsh-std', 'packages', packageName, 'package.json'),
    ))
    delete manifest.dependencies?.[name]
    manifest.optionalDependencies[name] = packageManifest.version
  }
  for (const [name, directory] of bundledVendorPackages) {
    const packageManifest = JSON.parse(await readFile(join(projectRoot, 'vendor', directory, 'package.json')))
    delete manifest.dependencies?.[name]
    manifest.optionalDependencies[name] = packageManifest.version
  }
  wroteManifest = true
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  // The rewritten manifest is, by design, out of sync with pnpm-lock.yaml
  // (workspace:* dependencies become exact optionalDependencies). npm runs
  // prepare -> compile against the rewritten manifest inside this window,
  // and the pnpm sub-installs in that chain then die on
  // ERR_PNPM_OUTDATED_LOCKFILE (frozen in CI). The check cannot be disabled
  // via env either: npm strips unknown npm_config_* variables from the
  // environment it hands to scripts ("npm warn Unknown env config
  // verify-deps-before-run"). The publishing job has already run the full
  // install + compile + package gates on the pristine manifest, so the
  // publish itself skips lifecycle scripts; packing collects the built
  // lib/ and the staged bundles exactly as before.
  const npmArgs = command === 'npm' && args[0] === 'publish'
    ? ['publish', '--ignore-scripts', ...args.slice(1)]
    : args
  const result = childSignal ? { code: null, signal: childSignal } : await new Promise((resolve, reject) => {
    rejectChild = reject
    child = spawn(command, npmArgs, {
      cwd: projectRoot,
      shell: process.platform === 'win32' && command === 'npm',
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    // Signal handlers stay installed until the staged files are restored.
    child.once('error', reject)
    child.once('close', (code, signal) => {
      resolve({ code, signal })
    })
  })
  childSignal ??= result.signal
  process.exitCode = result.code ?? 1
} finally {
  try {
    if (terminationError) throw terminationError
    restoring = true
    if (wroteManifest) await writeFile(manifestPath, originalManifest)
    restoreBundles?.()
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}
if (childSignal !== null && childSignal !== undefined) process.kill(process.pid, childSignal)
