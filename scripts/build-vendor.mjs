#!/usr/bin/env node
/**
 * Build the vendored packages `compile` depends on — vendor/dsh-std and
 * vendor/mathjax-tex-svg — unless their last build is provably current.
 *
 *   node scripts/build-vendor.mjs              # build what changed
 *   node scripts/build-vendor.mjs --force      # rebuild everything
 *   node scripts/build-vendor.mjs --print-key  # CI cache key, builds nothing
 *
 * Each target runs its package.json script (`build:dsh-std`, `build:mathjax`,
 * still runnable on their own). dsh-std's build type-checks and bundles seven
 * packages: ~25 s on every `compile`, although the submodule only changes when
 * its pin moves. So a successful build records a stamp in
 * node_modules/.cache/dsh-tui/vendor-build.json: a hash of everything the build
 * reads, and a hash of every file it wrote. A later run skips the target only
 * when both still match — same sources, lockfiles (the root one included),
 * workspace overrides, build command and Node version, and exactly the same
 * output files, byte for byte. Anything else (an edited vendor file, a moved
 * pin, a dependency change, a deleted or touched output) rebuilds. The stamp
 * sits in the same checkout as the outputs it vouches for, so switching
 * branches or worktrees can never reuse another tree's build.
 *
 * The stamp lives outside the output directories on purpose: those are
 * bundled into the npm tarball (bundleDependencies).
 *
 * `--print-key` prints a digest of the same input hashes (plus this script),
 * so a CI cache keyed on it restores outputs exactly when the stamp would
 * accept them; the stamp still re-checks every output file after a restore.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}
const stampFile = join(root, 'node_modules/.cache/dsh-tui/vendor-build.json')
const DSH_STD_PACKAGES = ['core', 'manifest', 'connection', 'presentation', 'command', 'storage', 'messages']
const ROOT_RESOLUTION = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']

const TARGETS = [
  {
    name: 'dsh-std',
    script: 'build:dsh-std',
    // The whole submodule checkout, minus installs and outputs: its sources,
    // tsconfigs, tsdown configs and its own lockfile. The root lockfile and
    // workspace overrides too: they decide what the root install links into
    // these packages, and a dependency change must never skip a rebuild.
    inputs: ['vendor/dsh-std', ...ROOT_RESOLUTION],
    outputs: DSH_STD_PACKAGES.map(name => `vendor/dsh-std/packages/${name}/lib`),
  },
  {
    name: 'mathjax',
    script: 'build:mathjax',
    // esbuild and mathjax-full come from the root install.
    inputs: ['vendor/mathjax-tex-svg', ...ROOT_RESOLUTION],
    outputs: ['vendor/mathjax-tex-svg/lib'],
  },
]
// Installs and VCS metadata anywhere, and exactly the declared output
// directories — not every directory that happens to be called `lib`.
const OUTPUT_DIRS = new Set(TARGETS.flatMap(target => target.outputs.map(path => join(root, path))))
const skipInput = (abs, entry) => entry === 'node_modules' || entry === '.git' || OUTPUT_DIRS.has(abs)

const args = process.argv.slice(2)
const unknown = args.filter(arg => arg !== '--force' && arg !== '--print-key')
if (unknown.length > 0 || args.length > 1) {
  console.error(`build-vendor: unexpected arguments ${args.join(' ')} (usage: [--force | --print-key])`)
  process.exit(2)
}
const force = args.includes('--force')
const printKey = args.includes('--print-key')

const sha256 = data => createHash('sha256').update(data).digest('hex')
const posix = path => path.split(sep).join('/')

/** Every regular file under `path` (or `path` itself), as sorted repo-relative paths. */
function files(path, skip) {
  const out = []
  const walk = abs => {
    const stat = lstatSync(abs, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) return
    if (stat.isFile()) out.push(posix(relative(root, abs)))
    else if (stat.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        const child = join(abs, entry)
        if (skip?.(child, entry)) continue
        walk(child)
      }
    }
  }
  walk(join(root, path))
  return out.sort()
}

const fileHashes = paths => Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(root, path)))]))

function inputHash(target) {
  const command = scripts[target.script]
  const listed = target.inputs.flatMap(path => files(path, skipInput))
  const hash = createHash('sha256').update(`${command}\n${process.version}\n`)
  for (const [path, digest] of Object.entries(fileHashes(listed))) hash.update(`${path}\0${digest}\n`)
  return hash.digest('hex')
}

const outputHashes = target => fileHashes(target.outputs.flatMap(path => files(path)))

function readStamp() {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    return {}
  }
}

function current(entry, inputs, target) {
  if (!entry || entry.inputs !== inputs) return false
  const actual = outputHashes(target)
  const recorded = entry.outputs ?? {}
  const names = Object.keys(recorded)
  return names.length > 0
    && names.length === Object.keys(actual).length
    && names.every(name => actual[name] === recorded[name])
}

for (const target of TARGETS) {
  if (typeof scripts[target.script] !== 'string') {
    console.error(`build-vendor: no package.json script ${target.script}`)
    process.exit(1)
  }
  if (!target.inputs.every(path => existsSync(join(root, path)))) {
    console.error(`build-vendor: ${target.name} sources are missing (${target.inputs.join(', ')}) — is the submodule checked out?`)
    process.exit(1)
  }
}

if (printKey) {
  const key = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url)))
  for (const target of TARGETS) key.update(`${target.name}\0${inputHash(target)}\n`)
  console.log(key.digest('hex'))
  process.exit(0)
}

const stamp = readStamp()
for (const target of TARGETS) {
  const inputs = inputHash(target)
  if (!force && current(stamp[target.name], inputs, target)) {
    console.log(`build-vendor: ${target.name} is up to date (inputs ${inputs.slice(0, 12)}), skipping ${target.script}`)
    continue
  }
  console.log(`build-vendor: building ${target.name} (${target.script})`)
  // Drop the stale entry first: a failed or interrupted build must never
  // leave a stamp that vouches for half-written outputs.
  delete stamp[target.name]
  mkdirSync(dirname(stampFile), { recursive: true })
  writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`)
  const result = spawnSync(scripts[target.script], { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`build-vendor: ${target.script} failed (exit ${result.status ?? result.signal})`)
    process.exit(result.status || 1)
  }
  const outputs = outputHashes(target)
  if (Object.keys(outputs).length === 0) {
    console.error(`build-vendor: ${target.script} produced no files under ${target.outputs.join(', ')}`)
    process.exit(1)
  }
  // Hash the inputs again after the build: a source edited mid-build must not
  // be recorded as built.
  stamp[target.name] = { inputs: inputHash(target) === inputs ? inputs : 'changed-during-build', outputs }
  writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`)
}
