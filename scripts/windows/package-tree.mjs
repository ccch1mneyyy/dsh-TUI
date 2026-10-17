/** Convert a single-package npm installation into a self-contained global package. */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** The offline installer ships runnable packages, not TypeScript editor/debug data. */
export function copyRuntimeTree(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: file => {
      const path = file.replaceAll('\\', '/')
      // A compiler's standard declarations are runtime inputs to type checking.
      if (path.includes('/node_modules/typescript/lib/')) return true
      return !/\.(?:d\.(?:ts|mts|cts)(?:\.map)?|[cm]?[jt]sx?\.map)$/.test(path)
    },
  })
}

export function collectPackageTree(modules, name, destination) {
  modules = resolve(modules)
  destination = resolve(destination)
  if (destination === modules || destination.startsWith(`${modules}${sep}`)) throw new Error('Package output must be outside the npm installation')
  // destination is computed from a fixed package name by the build script.
  if (!destination.replaceAll('\\', '/').endsWith(`/node_modules/${name}`)) throw new Error('Invalid package destination')
  rmSync(destination, { recursive: true, force: true })
  copyRuntimeTree(join(modules, name), destination)
  const copyDependency = dependency => {
    if (dependency === name) return
    const target = join(destination, 'node_modules', dependency)
    if (existsSync(target)) throw new Error(`Cannot relocate conflicting dependency: ${dependency}`)
    mkdirSync(join(target, '..'), { recursive: true })
    copyRuntimeTree(join(modules, dependency), target)
  }
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name === '.package-lock.json') continue
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(join(modules, entry.name))) copyDependency(`${entry.name}/${child}`)
    } else copyDependency(entry.name)
  }
}
