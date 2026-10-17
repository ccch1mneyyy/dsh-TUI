import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { GUIDE_DIR, guideFiles } from './guide-sources.mjs'

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

// The independent CLI is shipped as ready-to-run ESM, outside lib/types.
const cliRoot = new URL('../cli/', import.meta.url)
function cliRuntimeFiles(dir, prefix = 'cli/') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.name === 'test' ? []
    : entry.isDirectory() ? cliRuntimeFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
    : /\.(mjs|json|d\.ts)$/u.test(entry.name) ? [`${prefix}${entry.name}`] : [])
}
for (const file of cliRuntimeFiles(cliRoot)) {
  if (!packed.has(file)) throw new Error(`independent CLI file missing from tarball: ${file}`)
}
if ([...packed].some(path => path.startsWith('cli/test/'))) throw new Error('npm package contains CLI test fixtures')

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
// 随包用户手册必须真的进 tarball：它是 npm 用户机器上唯一的一份手册，
// 少了 guide/ 就等于"AI 无从查起"。（`skills/` 仍按 #613 的结论不打包。）
for (const guideFile of ['SKILL.md', ...guideFiles()]) {
  const entry = `${GUIDE_DIR}/${guideFile}`
  if (!packed.has(entry)) throw new Error(`packaged user guide missing from tarball: ${entry}`)
}
// 嫡系 feed（C-4）："随包发布"不是口头承诺——清单里的每一条判定都发生在用户机器上，
// 少了这份文件，免确认分流会静默退回"全部按第三方"（fail closed 但失去意义）。
for (const feedFile of ['tui-profile/feed/first-party.json']) {
  if (!packed.has(feedFile)) throw new Error(`packaged first-party feed missing from tarball: ${feedFile}`)
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
// The vendored Codex protocol types are compile-time only (their emitted
// files are empty modules plus ~10 MB of declarations): package.json
// `files` excludes them, and no runtime module imports them.
if ([...packed].some(path => path.startsWith('lib/types/backends/codex/protocol/generated/'))) {
  throw new Error('npm package contains the generated Codex protocol types (keep the `files` exclusion)')
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

// The website's settings reference reads this file from the exact published
// version; it must describe the version it ships in.
const settingsJson = JSON.parse(readFileSync(new URL('../lib/settings.json', import.meta.url), 'utf8'))
if (settingsJson.schemaVersion !== 1 || settingsJson.packageVersion !== manifest.version) {
  throw new Error(`lib/settings.json is stale (schemaVersion ${settingsJson.schemaVersion}, packageVersion ${settingsJson.packageVersion}, manifest ${manifest.version}); rerun pnpm compile`)
}
// …and exactly what the compiled definitions produce (same version, edited text).
const settingsCheck = spawnSync(process.execPath, [fileURLToPath(new URL('./gen-settings-json.mjs', import.meta.url)), '--check'], { encoding: 'utf8' })
if (settingsCheck.status !== 0) throw new Error(settingsCheck.stderr.trim() || 'lib/settings.json check failed')

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/types/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-tui-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}
// The compatibility entry still mounts after DSH retired its invariant service,
// and keeps the legacy registration's disposer when an older host provides it.
const { Context } = await import('@deepseek-ai/cordis')
for (const legacy of [false, true]) {
  const ctx = new Context()
  let registered = false
  let disposed = false
  if (legacy) ctx.provide('invariants', {
    register(name) {
      if (name !== manifest.name) throw new Error('invariant companion registered the wrong package')
      registered = true
      return () => { disposed = true }
    },
  })
  try {
    const fiber = ctx.plugin(invariant)
    await fiber
    await fiber.dispose()
    if (registered !== legacy || disposed !== legacy) throw new Error('invariant companion lifecycle drifted')
  } finally { await ctx.fiber.dispose() }
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)
