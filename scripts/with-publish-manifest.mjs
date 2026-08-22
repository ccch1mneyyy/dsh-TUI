import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = join(projectRoot, 'package.json')
const bundledPackages = [
  {
    name: '@deepseek-harness-tui/pi-tui',
    manifestPath: join(projectRoot, 'packages', 'pi-tui', 'package.json'),
  },
  ...[
    'command',
    'connection',
    'core',
    'manifest',
    'messages',
    'presentation',
    'storage',
  ].map(packageName => ({
    name: `@dsh-std/${packageName}`,
    manifestPath: join(projectRoot, 'vendor', 'dsh-std', 'packages', packageName, 'package.json'),
  })),
]

const [command, ...args] = process.argv.slice(2)
if (command === undefined) throw new Error('usage: node with-publish-manifest.mjs <command> [args...]')

const originalManifest = await readFile(manifestPath)
const manifest = JSON.parse(originalManifest)
manifest.optionalDependencies ??= {}
for (const { name, manifestPath: packageManifestPath } of bundledPackages) {
  const packageManifest = JSON.parse(await readFile(packageManifestPath))
  delete manifest.dependencies?.[name]
  manifest.optionalDependencies[name] = packageManifest.version
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
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
  await writeFile(manifestPath, originalManifest)
}
