/**
 * Type-check the TUI directly against the source-authoritative newest
 * DeepSeek Harness prerelease. CI pins the checkout SHA; local runs may point
 * DSH_HARNESS_SOURCE_ROOT at a checkout or use ../deepseek-harness.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const EXPECTED_UPSTREAM_VERSION = process.env.DSH_HARNESS_EXPECTED_VERSION ?? '0.1.2-rc.1'
const tuiRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(process.env.DSH_HARNESS_SOURCE_ROOT ?? join(tuiRoot, '../deepseek-harness'))
const sourceManifestPath = join(sourceRoot, 'package.json')
if (!existsSync(sourceManifestPath)) {
  console.error(`upstream source checkout missing: ${sourceRoot}`)
  process.exit(1)
}

const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
if (sourceManifest.version !== EXPECTED_UPSTREAM_VERSION) {
  console.error(`upstream source version mismatch: expected ${EXPECTED_UPSTREAM_VERSION}, got ${sourceManifest.version ?? 'missing'}`)
  process.exit(1)
}

const upstreamConfigPath = join(sourceRoot, 'tsconfig.base.json')
const upstreamConfigResult = ts.readConfigFile(upstreamConfigPath, path => readFileSync(path, 'utf8'))
if (upstreamConfigResult.error !== undefined) {
  console.error(ts.formatDiagnostic(upstreamConfigResult.error, {
    getCanonicalFileName: path => path,
    getCurrentDirectory: () => sourceRoot,
    getNewLine: () => '\n',
  }))
  process.exit(1)
}

const upstreamPaths = upstreamConfigResult.config?.compilerOptions?.paths
if (upstreamPaths === null || typeof upstreamPaths !== 'object') {
  console.error(`upstream source tsconfig has no compilerOptions.paths: ${upstreamConfigPath}`)
  process.exit(1)
}
const sourcePaths = Object.fromEntries(Object.entries(upstreamPaths)
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  .map(([name, entries]) => [
    name,
    entries.map(entry => {
      const target = resolve(sourceRoot, entry)
      const index = join(target, 'index.ts')
      return existsSync(index) ? index : target
    }),
  ]))
sourcePaths['@deepseek-ai/cordis'] = [
  join(tuiRoot, 'node_modules/@deepseek-ai/cordis/lib/types/index.d.ts'),
]
sourcePaths['@deepseek-ai/schemastery'] = [
  join(tuiRoot, 'node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts'),
]

const typescriptRoot = dirname(fileURLToPath(import.meta.resolve('typescript/package.json')))
// tsc requires every input file to live under rootDir. POSIX '/' covers any
// absolute path; on Windows '/' normalizes to the process drive, which need
// not hold either tree — use the tui drive root and require the upstream source
// to live on the same drive.
const typeRoot = process.platform === 'win32' ? parse(tuiRoot).root : '/'
if (process.platform === 'win32' && parse(sourceRoot).root !== typeRoot) {
  console.error(`upstream source must share the TUI drive for tsc rootDir (tui ${typeRoot}, source ${parse(sourceRoot).root})`)
  process.exit(1)
}
const projects = [
  { label: 'dsh-tui', config: join(tuiRoot, 'tsconfig.json') },
  { label: 'dsh-auth', config: join(tuiRoot, 'dsh-auth/tsconfig.json') },
]
for (const project of projects) {
  const tempRoot = mkdtempSync(join(tmpdir(), `dsh-tui-alpha-tsc-${project.label}-`))
  const generatedConfig = join(tempRoot, 'tsconfig.json')
  writeFileSync(generatedConfig, `${JSON.stringify({
    extends: project.config,
    compilerOptions: {
      target: 'ES2024',
      lib: ['ES2024'],
      noEmit: true,
      declaration: false,
      declarationMap: false,
      rootDir: typeRoot,
      allowImportingTsExtensions: true,
      typeRoots: [join(tuiRoot, 'node_modules/@types')],
      paths: sourcePaths,
    },
  }, null, 2)}\n`)
  const result = spawnSync(process.execPath, [
    join(typescriptRoot, 'bin/tsc'),
    '--project', generatedConfig,
    '--pretty', 'false',
  ], { cwd: tuiRoot, stdio: 'inherit' })
  rmSync(tempRoot, { recursive: true, force: true })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  console.log(`upstream source types OK (${project.label})`)
}
console.log(`upstream source compatibility OK (${EXPECTED_UPSTREAM_VERSION}; ${Object.keys(sourcePaths).length} path mappings)`)
