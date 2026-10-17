/** npm ci cannot parse workspace:* recorded inside npm bundled dependencies. */
import semver from 'semver'

/** Resolve only already-bundled siblings; never replace a registry URL or integrity hash. */
export function normalizeBundledWorkspaceReferences(lock) {
  for (const [location, pkg] of Object.entries(lock.packages)) {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!range.startsWith('workspace:')) continue
      if (!pkg.inBundle || range !== 'workspace:*') throw new Error(`Unsupported workspace dependency: ${location} -> ${name}`)
      const marker = location.lastIndexOf('/node_modules/')
      const sibling = lock.packages[`${location.slice(0, marker)}/node_modules/${name}`]
      if (!sibling?.inBundle || !semver.valid(sibling.version)) throw new Error(`Bundled sibling is missing: ${name}`)
      pkg.dependencies[name] = sibling.version
    }
  }
  return lock
}
