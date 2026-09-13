import { readFile } from 'node:fs/promises'

const input = await new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { value += chunk })
  process.stdin.on('end', () => resolve(value))
  process.stdin.on('error', reject)
})

const reports = JSON.parse(input)
// npm 10 emits an array while npm 11 emits an object keyed by package name.
const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
if (report === undefined || !Array.isArray(report.files)) {
  throw new Error('npm pack did not return a package file list')
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const packed = new Set(report.files.map(file => file.path.replaceAll('\\', '/')))
const targets = new Set()

const addTarget = value => {
  if (typeof value === 'string') targets.add(value.replace(/^\.\//u, ''))
}

addTarget(manifest.main)
addTarget(manifest.types)
for (const target of Object.values(manifest.bin ?? {})) addTarget(target)

const collectExports = value => {
  if (typeof value === 'string') {
    addTarget(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const nested of Object.values(value)) collectExports(nested)
}
collectExports(manifest.exports)

const missing = [...targets].filter(target => !packed.has(target))
if (missing.length > 0) {
  throw new Error(`package exports missing from tarball: ${missing.join(', ')}`)
}
for (const presetFile of [
  'presets/liangshen/agent.cordis.yml',
  'presets/liangshen/preset.yml',
  'presets/liangshen/.dsh-tui-managed.json',
  'presets/liangshen/tool-bootstrap.mjs',
]) {
  if (!packed.has(presetFile)) throw new Error(`packaged preset file missing from tarball: ${presetFile}`)
}
for (const path of packed) {
  const lower = path.toLowerCase()
  if (lower.includes('plugin-spec/')
    || /dsh-adapter\/(?:grants|host-descriptor)(?:\.|$)/u.test(lower)) {
    throw new Error(`npm package contains legacy compat shim (case-insensitive): ${path}`)
  }
}
if ([...packed].some(path => path.startsWith('src/'))) {
  throw new Error('npm package unexpectedly contains TypeScript sources')
}
if ([...packed].some(path => path.startsWith('skills/') || path.startsWith('.agents/skills/'))) {
  throw new Error('npm package unexpectedly contains developer skills')
}
if (packed.has('lib/invariant.js')) {
  throw new Error('npm package contains the obsolete hand-built invariant entry')
}

// The manifest ships verbatim (publish goes through npm, which rewrites no
// workspace protocols), so a `workspace:` range on a NON-BUNDLED name lands
// in the tarball and kills `dsh plugin add` in the profile workspace
// (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND). Bundled names are fine — npm packs
// their physical copies into the tarball, so the range never resolves for a
// consumer. Workspace helpers (e.g. vendor/sqlite-island) are reached by
// relative import instead of a manifest entry.
const bundled = new Set(manifest.bundledDependencies ?? manifest.bundleDependencies ?? [])
for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
  for (const [name, range] of Object.entries(manifest[section] ?? {})) {
    if (typeof range === 'string' && range.startsWith('workspace:') && !bundled.has(name)) {
      throw new Error(`manifest ${section}.${name} uses the ${range} protocol on a non-bundled package, which must never ship (reach workspace helpers by relative import)`)
    }
  }
}

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/types/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-tui-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)
