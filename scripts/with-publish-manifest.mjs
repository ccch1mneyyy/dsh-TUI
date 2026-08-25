import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
// The bundled dsh-auth copy: npm publishes under the TUI's scope, while the
// repo develops against the `dsh-auth/` submodule via a `link:` dependency.
const dshAuthName = '@deepseek-harness-tui/dsh-auth'

const [command, ...args] = process.argv.slice(2)
if (command === undefined) throw new Error('usage: node with-publish-manifest.mjs <command> [args...]')

const originalManifest = await readFile(manifestPath)
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
// dsh-auth rides the same bundle: the repo develops against a `link:` to the
// submodule, but a published manifest cannot carry a link spec — the version
// plus bundledDependencies ships its compiled content in-tarball instead.
const dshAuthDir = join(projectRoot, 'dsh-auth')
const dshAuthInstalled = join(projectRoot, 'node_modules', dshAuthName)
const dshAuthManifest = JSON.parse(await readFile(join(dshAuthDir, 'package.json')))
delete manifest.dependencies?.[dshAuthName]
manifest.optionalDependencies[dshAuthName] = dshAuthManifest.version

/**
 * Stage the bundled dsh-auth copy for packing: `node_modules/<scope>/dsh-auth`
 * is a live `link:` to the submodule during development, and npm pack follows
 * it into the submodule's own node_modules (its installed dependency tree) —
 * hundreds of unrelated files and, on some platforms, a fatal traversal. A
 * bundled package ships only its own publishable files, so the link is
 * swapped for a pristine directory filtered by the submodule's `files` list
 * (plus the manifests npm always includes) and restored afterwards.
 */
const stageBundledDshAuth = async () => {
  const installed = await lstat(dshAuthInstalled).catch(() => undefined)
  if (installed === undefined || !installed.isSymbolicLink()) return () => {}
  await rm(dshAuthInstalled, { recursive: true, force: true })
  await mkdir(dirname(dshAuthInstalled), { recursive: true })
  await mkdir(dshAuthInstalled, { recursive: true })
  const entries = new Set([
    'package.json',
    ...(Array.isArray(dshAuthManifest.files) ? dshAuthManifest.files : []),
  ])
  for (const entry of entries) {
    const from = join(dshAuthDir, entry)
    if (!existsSync(from)) continue
    await cp(from, join(dshAuthInstalled, entry), { recursive: true })
  }
  return async () => {
    await rm(dshAuthInstalled, { recursive: true, force: true })
    await mkdir(dirname(dshAuthInstalled), { recursive: true })
    await symlink(dshAuthDir, dshAuthInstalled, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
const restoreDshAuth = await stageBundledDshAuth()
try {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32' && command === 'npm',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await restoreDshAuth()
  await writeFile(manifestPath, originalManifest)
}
