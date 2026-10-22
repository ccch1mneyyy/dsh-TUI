import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

// Root links are intentional (pnpm package roots). Nested links are hashed by
// their target text, never walked. Reuse requires that target to be another
// ordinary entry hashed in this tree: external, excluded, dangling and cyclic
// links disable caching rather than silently omitting their contents.
export function treeHash(path, skip = () => false) {
  try {
    const root = realpathSync.native(path)
    const hash = createHash('sha256')
    const entries = new Set()
    const links = []
    const walk = (absolute, name) => {
      if (skip(absolute, name)) return
      const stat = lstatSync(absolute)
      hash.update(`${name}\0`)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute)
        hash.update('link\0').update(target).update('\0')
        links.push([absolute, resolve(dirname(absolute), target)])
      } else if (stat.isDirectory()) {
        entries.add(absolute)
        hash.update('directory\0')
        for (const child of readdirSync(absolute).sort()) walk(join(absolute, child), name ? `${name}/${child}` : child)
      } else if (stat.isFile()) {
        entries.add(absolute)
        hash.update(`file:${stat.mode & 0o111}\0`).update(readFileSync(absolute)).update('\0')
      } else throw new Error(`unsupported file type: ${absolute}`)
    }
    walk(root, '')
    for (const [link, target] of links) {
      // Native resolution preserves OS semantics for a directory link before
      // "..", which can escape despite an internal lexical target.
      if (!entries.has(target) || !entries.has(realpathSync.native(link))) throw new Error(`symlink target is outside the hashed entries: ${link}`)
    }
    return hash.digest('hex')
  } catch (error) {
    console.warn(`dev-test: cache unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

const vendorOutputs = [
  ...['core', 'manifest', 'connection', 'presentation', 'command', 'storage', 'messages'].map(name => `vendor/dsh-std/packages/${name}/lib`),
  'vendor/mathjax-tex-svg/lib',
]

export function devOutputHash(repoRoot) {
  const outputs = ['lib', ...vendorOutputs].map(path => treeHash(join(repoRoot, path)))
  return outputs.every(value => value !== undefined)
    ? createHash('sha256').update(outputs.join('\0')).digest('hex') : undefined
}

export function devInputHash(repoRoot, devRoot, toolVersions = []) {
  if (realpathSync.native(repoRoot) === realpathSync.native(devRoot)) {
    console.warn('dev-test: cache unavailable: development root is the repository')
    return undefined
  }
  if (toolVersions.some(version => version === undefined)) {
    console.warn('dev-test: cache unavailable: a tool version is unrecognized')
    return undefined
  }
  const root = resolve(repoRoot)
  const generated = new Set(['lib', 'dist', 'dist-windows', 'ci-render-logs'].map(name => join(root, name)))
  for (const path of vendorOutputs) generated.add(join(root, path))
  const source = treeHash(root, (path, name) => {
    const leaf = name.split('/').at(-1)
    return leaf === '.git' || leaf === 'node_modules' || generated.has(path) || path === resolve(devRoot)
  })
  if (!source) return undefined
  const hash = createHash('sha256').update(`${source}\0${process.version}\0${process.platform}\0${process.arch}\0${toolVersions.join('\0')}`)
  // Include installed resolution/tool metadata, not merely source lockfiles.
  for (const file of ['.modules.yaml', '.pnpm/lock.yaml']) {
    try { hash.update(file).update(readFileSync(join(root, 'node_modules', file))) }
    catch {
      console.warn(`dev-test: cache unavailable: missing dependency metadata ${file}`)
      return undefined
    }
  }
  for (const tool of ['typescript', 'tsx', 'esbuild']) {
    let path = join(root, 'node_modules', tool)
    if (tool === 'esbuild') {
      try {
        // pnpm keeps tsx's compiler in its own dependency scope, not the root.
        const fromTsx = createRequire(createRequire(join(root, 'package.json')).resolve('tsx'))
        path = dirname(fromTsx.resolve('esbuild/package.json'))
      } catch (error) {
        console.warn(`dev-test: cache unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    const digest = treeHash(path)
    if (!digest) return undefined
    hash.update(`${tool}\0${digest}\0`)
  }
  return hash.digest('hex')
}

export function installedHash(installed) {
  return treeHash(resolve(installed, '../../..'))
}

export function reusableInstall(stamp, { repoRoot, packageRoot, installed, inputs }) {
  if (!stamp || !inputs || stamp.repoRoot !== repoRoot || stamp.inputs !== inputs || typeof stamp.tarball !== 'string') return false
  const artifactPath = relative(packageRoot, stamp.tarball).split(sep)
  if (artifactPath.length !== 2 || !/^\d{8}T\d{9}Z-\d+$/u.test(artifactPath[0]) || !artifactPath[1].endsWith('.tgz')) return false
  // Verify the owned profile, including non-bundled dependencies. Unverifiable
  // links outside this tree conservatively disable reuse.
  return typeof stamp.outputs === 'string' && devOutputHash(repoRoot) === stamp.outputs
    && typeof stamp.profile === 'string' && installedHash(installed) === stamp.profile
    && typeof stamp.artifact === 'string' && treeHash(stamp.tarball) === stamp.artifact
}
