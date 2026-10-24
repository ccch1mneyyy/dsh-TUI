import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Git needs a zero-build entry; the release ships the compiled application. */
export async function publishManifest(source, root) {
  const manifest = structuredClone(source)
  const metadata = manifest.dshTui
  for (const [section, names] of [
    ['dependencies', metadata.runtimeDependencies],
    ['optionalDependencies', metadata.optionalDependencies],
  ]) {
    manifest[section] = Object.fromEntries(names.map(name => {
      const version = source.devDependencies[name]
      if (typeof version !== 'string') throw new Error(`Missing runtime dependency version: ${name}`)
      return [name, version]
    }))
  }
  manifest.bundledDependencies = metadata.bundledDependencies
  for (const name of manifest.bundledDependencies) {
    const directory = name.startsWith('@dsh-std/')
      ? join(root, 'vendor/dsh-std/packages', name.split('/')[1])
      : join(root, 'vendor', name.split('/')[1])
    const bundled = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    delete manifest.dependencies[name]
    manifest.optionalDependencies[name] = bundled.version
  }
  delete manifest.devDependencies
  return manifest
}
