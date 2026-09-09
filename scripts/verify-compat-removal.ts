/**
 * P6 compat-removal / migration-graph gate.
 *
 * This is NOT a marker-list self-check. It verifies the actual cleanup state:
 * - the legacy shim files are gone from `src/` and from generated `lib/`
 *   (when present);
 * - no production source, script, bin, or compiled lib file still imports
 *   or refers to those legacy paths, `admissionCompat*`,
 *   `mountedAdmissionCoordinates`, or the old `./grants.js` /
 *   `./host-descriptor.js` comments;
 * - no package export entry points at a legacy shim;
 * - the public `./plugin-host` export graph points at the canonical public
 *   surface and that surface carries no COMPAT markers.
 *
 * Run via `node --import tsx/esm scripts/verify-compat-removal.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const SCRIPTS = join(ROOT, 'scripts')
const BIN = join(ROOT, 'bin')
const LIB = join(ROOT, 'lib')
const ADAPTER_V2_PHASE = 'P6'

const LEGACY_SHIM_PATHS = [
  'plugin-spec/types.ts',
  'plugin-spec/schema-check.ts',
  'plugin-spec/registry.ts',
  'plugin-spec/validate.ts',
  'plugin-spec/negotiate.ts',
  'plugin-spec/permission-scope.ts',
  'plugin-spec/tui-extension.ts',
  'dsh-adapter/grants.ts',
  'dsh-adapter/host-descriptor.ts',
] as const

const LEGACY_LIB_SHIM_PATHS = [
  'lib/types/plugin-spec/types.js',
  'lib/types/plugin-spec/schema-check.js',
  'lib/types/plugin-spec/registry.js',
  'lib/types/plugin-spec/validate.js',
  'lib/types/plugin-spec/negotiate.js',
  'lib/types/plugin-spec/permission-scope.js',
  'lib/types/plugin-spec/tui-extension.js',
  'lib/types/dsh-adapter/grants.js',
  'lib/types/dsh-adapter/host-descriptor.js',
] as const

const TEXT_FILE = /\.(?:ts|tsx|js|mjs|cjs|d\.ts)$/u

function collect(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) collect(path, out)
    else if (TEXT_FILE.test(entry)) out.push(path)
  }
  return out
}

function isLegacyShimPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return LEGACY_LIB_SHIM_PATHS.some(shim => normalized === join(ROOT, shim).replaceAll('\\', '/').toLowerCase())
    || normalized.includes('/plugin-spec/')
    || /\/dsh-adapter\/(?:grants|host-descriptor)(?:\.|$)/u.test(normalized)
}

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  let resolved = resolve(dirname(fromFile), specifier)
  const candidates = [resolved, `${resolved}.js`, `${resolved}.ts`, `${resolved}.d.ts`, join(resolved, 'index.js'), join(resolved, 'index.ts'), join(resolved, 'index.d.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function visitRelativeImportGraph(file: string, seen: Set<string>, failures: string[]): void {
  if (seen.has(file)) return
  seen.add(file)
  if (isLegacyShimPath(file)) {
    failures.push(`${relative(ROOT, file)} is reachable from a package export and is a legacy shim`)
    return
  }
  const source = readFileSync(file, 'utf8')
  const importPattern = /(?:from\s*|import\s+|import\s*\(\s*|require\s*\(\s*)(['"])([^'"]+)\1/gu
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2]!
    const resolved = resolveRelativeImport(file, specifier)
    if (resolved !== undefined) visitRelativeImportGraph(resolved, seen, failures)
  }
}

const failures: string[] = []
let checkedFiles = 0

// 1. Legacy shims must be absent from source and generated lib.
for (const relativePath of LEGACY_SHIM_PATHS) {
  const path = join(SRC, relativePath)
  if (existsSync(path)) {
    failures.push(`${relativePath}: legacy compat shim still exists after P6 removal`)
  }
}
for (const relativePath of LEGACY_LIB_SHIM_PATHS) {
  const path = join(ROOT, relativePath)
  if (existsSync(path)) {
    failures.push(`${relativePath}: legacy compat shim still exists in generated lib/`)
  }
}

// 2. Production source, scripts, bin, and generated lib must resolve the
// canonical surface and must not retain removed state/path references.
const LEGACY_ADAPTER_IMPORT = /(?:import|export)\s[^'"\n]*?from\s*['"][^'"]*dsh-adapter\/(?:grants|host-descriptor)|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"][^'"]*dsh-adapter\/(?:grants|host-descriptor)/iu
const LEGACY_PLUGIN_SPEC_IMPORT = /(?:import|export)\s[^'"\n]*?from\s*['"][^'"]*plugin-spec|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"][^'"]*plugin-spec/iu
const REMOVED_ADMISSION_STATE = /(?:admissionCompat(?:Coordinates)?|mountedAdmissionCoordinates)/iu
const LEGACY_OLD_PATH_REFERENCE = /(?:\.\/grants\.js|\.\/host-descriptor\.js|\.\.\/grants\.js|\.\.\/host-descriptor\.js)/iu
const ADMISSION_COMPATIBILITY_PHRASE = /admission\s+compatibility/iu
for (const root of [SRC, SCRIPTS, BIN, LIB]) {
  for (const file of collect(root)) {
    if (file === fileURLToPath(import.meta.url)) continue
    checkedFiles += 1
    const source = readFileSync(file, 'utf8')
    const normalized = file.replaceAll('\\', '/')
    const lowerNormalized = normalized.toLowerCase()
    const inLegacyArea = lowerNormalized.includes('/dsh-adapter/')
      || lowerNormalized.includes('/plugin-spec/')
      || lowerNormalized.includes('/lib/types/dsh-adapter/')
      || lowerNormalized.includes('/lib/types/plugin-spec/')
    if (lowerNormalized.includes('/plugin-spec/')
      || /\/dsh-adapter\/(?:grants|host-descriptor)(?:\.|$)/u.test(lowerNormalized)) {
      failures.push(`${relative(ROOT, file)} is a case-insensitive legacy shim path`)
    }
    if (LEGACY_ADAPTER_IMPORT.test(source) || LEGACY_PLUGIN_SPEC_IMPORT.test(source)) {
      failures.push(`${relative(ROOT, file)} still resolves a legacy shim path`)
    }
    if (REMOVED_ADMISSION_STATE.test(source)) {
      failures.push(`${relative(ROOT, file)} still references removed admissionCompat state`)
    }
    if (inLegacyArea && LEGACY_OLD_PATH_REFERENCE.test(source)) {
      failures.push(`${relative(ROOT, file)} still references the removed ./grants.js or ./host-descriptor.js paths`)
    }
    if (ADMISSION_COMPATIBILITY_PHRASE.test(source)) {
      failures.push(`${relative(ROOT, file)} still uses the removed 'admission compatibility' phrasing`)
    }
    if (source.includes('COMPAT(')) {
      failures.push(`${relative(ROOT, file)} still carries a COMPAT marker after P6 cleanup`)
    }
  }
}

// 3. Public export graph: every package export target must exist and none may
// point at a legacy/compat path.
const packageJsonPath = join(ROOT, 'package.json')
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  exports?: Record<string, { import?: string; types?: string; default?: string } | string>
}
for (const [name, target] of Object.entries(manifest.exports ?? {})) {
  const values = typeof target === 'string' ? [target] : Object.values(target ?? {}).filter((value): value is string => typeof value === 'string')
  for (const value of values) {
    const normalized = value.replace(/^\.\//u, '').toLowerCase()
    if (normalized.includes('plugin-spec/') || /dsh-adapter\/(?:grants|host-descriptor)(?:\.|$)/u.test(normalized)) {
      failures.push(`package export ${name} points at a legacy shim: ${value}`)
    }
  }
}
const pluginHostExport = manifest.exports?.['./plugin-host']
if (typeof pluginHostExport === 'string' || pluginHostExport === undefined) {
  failures.push('package.json ./plugin-host must be an export object')
} else {
  if (pluginHostExport.import !== './lib/types/plugin-host.js') {
    failures.push('package.json ./plugin-host import must point at ./lib/types/plugin-host.js')
  }
  if (pluginHostExport.types !== './lib/types/plugin-host.d.ts') {
    failures.push('package.json ./plugin-host types must point at ./lib/types/plugin-host.d.ts')
  }
}
const publicSurfacePath = join(SRC, 'plugin-host.ts')
if (!existsSync(publicSurfacePath)) {
  failures.push('src/plugin-host.ts must remain as the canonical public plugin-host surface')
} else {
  const publicSource = readFileSync(publicSurfacePath, 'utf8')
  if (!publicSource.includes('TuiPluginHost')) {
    failures.push('public plugin-host surface must export the narrowed TuiPluginHost type')
  }
  if (publicSource.includes('COMPAT(') || REMOVED_ADMISSION_STATE.test(publicSource)) {
    failures.push('public plugin-host surface must not carry COMPAT/admissionCompat markers')
  }
}

// 3b. Transitive consumer/export graph: from every package export target and
// the main/types/bin entries, follow relative imports and make sure no legacy
// shim is reachable through the graph.
{
  const exportTargets: string[] = []
  for (const target of Object.values(manifest.exports ?? {})) {
    if (typeof target === 'string') exportTargets.push(target)
    else if (target !== null && typeof target === 'object') {
      for (const value of Object.values(target)) {
        if (typeof value === 'string') exportTargets.push(value)
      }
    }
  }
  for (const target of [manifest.main, manifest.types]) {
    if (typeof target === 'string') exportTargets.push(target)
  }
  for (const target of Object.values((manifest as { bin?: Record<string, unknown> }).bin ?? {})) {
    if (typeof target === 'string') exportTargets.push(target)
  }
  const seen = new Set<string>()
  for (const target of exportTargets) {
    if (typeof target !== 'string') continue
    const path = join(ROOT, target.replace(/^\.\//u, ''))
    if (!existsSync(path) || !statSync(path).isFile()) {
      failures.push(`package entry target does not exist: ${target}`)
      continue
    }
    visitRelativeImportGraph(path, seen, failures)
  }
}

// 4. Generated lib (when present) must not re-export old server-side shims.
if (existsSync(LIB)) {
  const pluginHostLib = join(LIB, 'types', 'plugin-host.js')
  if (existsSync(pluginHostLib)) {
    const source = readFileSync(pluginHostLib, 'utf8')
    if (source.includes('mountedAdmissionCoordinates') || /admissionCompat(?:Coordinates)?/u.test(source)) {
      failures.push('lib/types/plugin-host.js still exposes removed admissionCompat helpers')
    }
  }
}

if (failures.length > 0) {
  console.error('verify:compat-removal FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify:compat-removal OK (phase ${ADAPTER_V2_PHASE}; ${LEGACY_SHIM_PATHS.length} src shim paths + ${LEGACY_LIB_SHIM_PATHS.length} lib shim paths absent; ${checkedFiles} text files scanned; package export graph verified)`)
