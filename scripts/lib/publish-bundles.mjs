/** Stage bundled workspaces without ever rewriting their vendored sources. */
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Only exact workspace siblings already included in the bundle can be resolved. */
export function stagePublishBundles(root, names) {
  const modules = join(root, 'node_modules')
  const stage = join(modules, '.dsh-tui-publish-bundles')
  // Exclusive directory also prevents two publishers from swapping the same links.
  mkdirSync(stage)
  const replaced = []
  const restore = () => {
    const failures = []
    for (const { target, backup } of [...replaced].reverse()) {
      try {
        rmSync(target, { recursive: true, force: true })
        renameSync(backup, target)
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, `Bundle restoration failed; preserved backups: ${stage}`)
    rmSync(stage, { recursive: true, force: true })
  }
  try {
    const packages = names.map((name, index) => {
      const target = join(modules, name)
      const source = realpathSync(target)
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
      if (manifest.name !== name || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version)) {
        throw new Error(`Invalid bundled package identity: ${name}`)
      }
      return { name, index, target, source, manifest }
    })
    const versions = new Map(packages.map(pkg => [pkg.name, pkg.manifest.version]))
    // Prepare every copy before changing any workspace link.
    for (const pkg of packages) {
      const copy = join(stage, `copy-${pkg.index}`)
      cpSync(pkg.source, copy, {
        recursive: true,
        // Workspace-local links cause npm to emit duplicate vendor/... trees.
        // All runtime workspace siblings are staged together at the root.
        filter: path => !relative(pkg.source, path).split(sep).includes('node_modules'),
      })
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(pkg.manifest[section] ?? {})) {
          if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
          if (range !== 'workspace:*' || !versions.has(name)) throw new Error(`Unsupported bundled workspace dependency: ${pkg.name} -> ${name}@${range}`)
          pkg.manifest[section][name] = versions.get(name)
        }
      }
      writeFileSync(join(copy, 'package.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`)
    }
    for (const pkg of packages) {
      const backup = join(stage, `original-${pkg.index}`)
      // rename preserves the exact original symlink/junction or physical directory.
      renameSync(pkg.target, backup)
      replaced.push({ target: pkg.target, backup })
      renameSync(join(stage, `copy-${pkg.index}`), pkg.target)
    }
    return restore
  } catch (error) {
    try { restore() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Bundle staging and restoration failed') }
    throw error
  }
}
