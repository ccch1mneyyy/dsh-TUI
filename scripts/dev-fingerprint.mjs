#!/usr/bin/env node
/**
 * Content-hash fingerprints for the layered dev loop in scripts/dev-test.mjs.
 *
 * Each fingerprint is a sha256 over the layer's input paths and file bytes, so
 * mtime-only touches and fresh checkouts never invalidate the cache, while any
 * real content edit does:
 *
 *   deps    root manifest/lockfile/workspace → root `pnpm install`
 *   vendor  the seven built @dsh-std/* packages' sources → `build:dsh-std`
 *   auth    dsh-auth sources → `build:dsh-auth`
 *   app     src/ + tsconfigs, mixed with the vendor/auth fingerprints (their
 *           .d.ts feeds tsc) → emit compile vs incremental no-emit typecheck
 *   pkg     tarball inputs (package.json, bin/, presets/, cordis*.yml and the
 *           packaged dsh-ecosystem-spec dirs), mixed with the app fingerprint
 *           (lib/ and the bundled vendor/auth builds derive from those inputs)
 *           → `npm pack` + isolated profile install
 *
 * The cache lives under the dev root (resolveDevPaths), keyed by repo path, so
 * worktrees never pollute the repository and --force can simply ignore it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const VENDOR_PACKAGES = ['core', 'manifest', 'connection', 'presentation', 'command', 'storage', 'messages']

const PACKAGED_SPEC_DIRS = ['registry', 'protocols', 'schemas']

function walkTree(absoluteDir, files) {
  if (!existsSync(absoluteDir)) return
  const entries = readdirSync(absoluteDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(absoluteDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walkTree(path, files)
    } else {
      files.add(path)
    }
  }
}

function hashLayer(repoRoot, { files = [], trees = [], mixins = [] }) {
  const hash = createHash('sha256')
  const collected = new Set(files.map(file => join(repoRoot, file)))
  for (const tree of trees) walkTree(join(repoRoot, tree), collected)
  for (const path of [...collected].sort()) {
    hash.update(relative(repoRoot, path).split(sep).join('/'))
    hash.update('\0')
    hash.update(existsSync(path) ? readFileSync(path) : '<missing>')
    hash.update('\0')
  }
  for (const mixin of mixins) {
    hash.update(mixin)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function computeDevFingerprints(repoRoot) {
  const deps = hashLayer(repoRoot, {
    files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  })
  const vendor = hashLayer(repoRoot, {
    files: [
      'vendor/dsh-std/pnpm-lock.yaml',
      'vendor/dsh-std/pnpm-workspace.yaml',
      'vendor/dsh-std/tsconfig.base.json',
      ...VENDOR_PACKAGES.flatMap(pkg => [
        `vendor/dsh-std/packages/${pkg}/package.json`,
        `vendor/dsh-std/packages/${pkg}/tsconfig.json`,
        `vendor/dsh-std/packages/${pkg}/tsdown.config.ts`,
      ]),
    ],
    trees: [
      ...VENDOR_PACKAGES.map(pkg => `vendor/dsh-std/packages/${pkg}/src`),
      'vendor/dsh-std/packages/manifest/schema',
    ],
  })
  const auth = hashLayer(repoRoot, {
    files: [
      'dsh-auth/package.json',
      'dsh-auth/pnpm-lock.yaml',
      'dsh-auth/pnpm-workspace.yaml',
      'dsh-auth/tsconfig.json',
      'dsh-auth/cordis.patch.yml',
      'dsh-auth/dsh-plugin.json',
    ],
    trees: ['dsh-auth/src'],
  })
  const app = hashLayer(repoRoot, {
    files: ['tsconfig.json', 'tsconfig.typecheck.json'],
    trees: ['src'],
    mixins: [vendor, auth],
  })
  const pkg = hashLayer(repoRoot, {
    files: ['package.json', 'cordis.yml', 'cordis.patch.yml'],
    trees: ['bin', 'presets', ...PACKAGED_SPEC_DIRS.map(dir => `dsh-ecosystem-spec/${dir}`)],
    mixins: [app],
  })
  return { deps, vendor, auth, app, pkg }
}

function cacheFilePath(devRoot) {
  return join(devRoot, 'dev-loop-cache.json')
}

/** Last successfully completed fingerprints for repoRoot, or null. */
export function readDevLoopCache(devRoot, repoRoot) {
  try {
    const data = JSON.parse(readFileSync(cacheFilePath(devRoot), 'utf8'))
    return data?.repos?.[repoRoot] ?? null
  } catch {
    return null
  }
}

export function writeDevLoopCache(devRoot, repoRoot, fingerprints) {
  let data = {}
  try {
    data = JSON.parse(readFileSync(cacheFilePath(devRoot), 'utf8'))
  } catch {
    data = {}
  }
  const repos = typeof data?.repos === 'object' && data.repos !== null ? data.repos : {}
  repos[repoRoot] = fingerprints
  const path = cacheFilePath(devRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ repos }, null, 2)}\n`)
}
