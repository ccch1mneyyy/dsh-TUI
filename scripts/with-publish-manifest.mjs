import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { stagePublishBundles } from './lib/publish-bundles.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = join(projectRoot, 'package.json')
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
let wroteManifest = false
const onInt = () => { childSignal = 'SIGINT'; child?.kill('SIGINT') }
const onTerm = () => { childSignal = 'SIGTERM'; child?.kill('SIGTERM') }
process.on('SIGINT', onInt)
process.on('SIGTERM', onTerm)
try {
  restoreBundles = stagePublishBundles(projectRoot, bundledPackages.map(name => `@dsh-std/${name}`))
  originalManifest = await readFile(manifestPath)
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
    try { if (wroteManifest) await writeFile(manifestPath, originalManifest) }
    finally { restoreBundles?.() }
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}
if (childSignal !== null && childSignal !== undefined) process.kill(process.pid, childSignal)
