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
const forkPackage = '@deepseek-harness-tui/pi-tui'
const forkPackedPrefix = `node_modules/${forkPackage}/`
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
if (!manifest.bundledDependencies?.includes(forkPackage)) {
  throw new Error(`package manifest does not bundle ${forkPackage}`)
}
for (const forkFile of [
  'package.json',
  'README.md',
  'LICENSE',
  'native/win32/prebuilds/win32-arm64/win32-console-mode.node',
  'native/win32/prebuilds/win32-x64/win32-console-mode.node',
  'native/win32/src/win32-console-mode.c',
  'native/win32/build.mjs',
  'native/win32/README.md',
  'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node',
  'native/darwin/prebuilds/darwin-x64/darwin-modifiers.node',
  'native/darwin/src/darwin-modifiers.c',
  'native/darwin/build.sh',
  'native/darwin/README.md',
].map(path => `${forkPackedPrefix}${path}`)) {
  if (!packed.has(forkFile)) throw new Error(`bundled fork file missing from tarball: ${forkFile}`)
}
for (const presetFile of [
  'presets/liangshen/agent.cordis.yml',
  'presets/liangshen/preset.yml',
  'presets/liangshen/.dsh-tui-managed.json',
  'presets/liangshen/tool-bootstrap.mjs',
]) {
  if (!packed.has(presetFile)) throw new Error(`packaged preset file missing from tarball: ${presetFile}`)
}
if ([...packed].some(path => path.startsWith('src/'))) {
  throw new Error('npm package unexpectedly contains TypeScript sources')
}
if (packed.has('lib/invariant.js')) {
  throw new Error('npm package contains the obsolete hand-built invariant entry')
}

await import(new URL(`../${manifest.main}`, import.meta.url))
const fork = await import(forkPackage)
if (typeof fork.TuiMainScreen !== 'function' || typeof fork.TuiAltScreen !== 'function') {
  throw new Error(`bundled fork root import does not expose ${forkPackage} screen constructors`)
}
const invariant = await import(new URL('../lib/types/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-tui-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)
