/**
 * P6 compat-removal / migration-graph gate.
 *
 * This is NOT a marker-list self-check. It verifies the actual cleanup state:
 * - the legacy shim files are gone;
 * - no production source or verify script imports/refers to those legacy
 *   paths, `mountedAdmissionCoordinates`, or `admissionCompat`;
 * - the public `./plugin-host` export graph points at the canonical public
 *   surface and the surface no longer carries COMPAT markers;
 * - no `COMPAT(` marker remains anywhere in `src/`.
 *
 * Run via `node --import tsx/esm scripts/verify-compat-removal.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const SCRIPTS = join(ROOT, 'scripts')
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

function collect(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) collect(path, out)
    else if (/\.(?:ts|tsx)$/u.test(entry)) out.push(path)
  }
  return out
}

const failures: string[] = []
let checkedFiles = 0

// 1. Legacy shims must be absent.
for (const relativePath of LEGACY_SHIM_PATHS) {
  const path = join(SRC, relativePath)
  if (existsSync(path)) {
    failures.push(`${relativePath}: legacy compat shim still exists after P6 removal`)
  }
}

// 2. Production source and verify scripts must resolve the canonical surface.
const LEGACY_ADAPTER_IMPORT = /(?:import|export)\s[^'"\n]*?from\s*['"][^'"]*dsh-adapter\/(?:grants|host-descriptor)|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"][^'"]*dsh-adapter\/(?:grants|host-descriptor)/u
const LEGACY_PLUGIN_SPEC_IMPORT = /(?:import|export)\s[^'"\n]*?from\s*['"][^'"]*plugin-spec|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"][^'"]*plugin-spec/u
for (const root of [SRC, SCRIPTS]) {
  for (const file of collect(root)) {
    if (file === fileURLToPath(import.meta.url)) continue
    checkedFiles += 1
    const source = readFileSync(file, 'utf8')
    if (LEGACY_ADAPTER_IMPORT.test(source) || LEGACY_PLUGIN_SPEC_IMPORT.test(source)) {
      failures.push(`${relative(ROOT, file)} still resolves a legacy shim path`)
    }
    if (root === SRC && (/\badmissionCompat\b/u.test(source) || /\bmountedAdmissionCoordinates\b/u.test(source))) {
      failures.push(`${relative(ROOT, file)} still references removed admissionCompat state`)
    }
    if (source.includes('COMPAT(')) {
      failures.push(`${relative(ROOT, file)} still carries a COMPAT marker after P6 cleanup`)
    }
  }
}

// 3. Public export graph: ./plugin-host must remain a canonical public surface.
const packageJsonPath = join(ROOT, 'package.json')
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  exports?: Record<string, { import?: string; types?: string; default?: string }>
}
const pluginHostExport = manifest.exports?.['./plugin-host']
if (pluginHostExport?.import !== './lib/types/plugin-host.js') {
  failures.push('package.json ./plugin-host import must point at ./lib/types/plugin-host.js')
}
if (pluginHostExport?.types !== './lib/types/plugin-host.d.ts') {
  failures.push('package.json ./plugin-host types must point at ./lib/types/plugin-host.d.ts')
}
const publicSurfacePath = join(SRC, 'plugin-host.ts')
if (!existsSync(publicSurfacePath)) {
  failures.push('src/plugin-host.ts must remain as the canonical public plugin-host surface')
} else {
  const publicSource = readFileSync(publicSurfacePath, 'utf8')
  if (!publicSource.includes('TuiPluginHost')) {
    failures.push('public plugin-host surface must export the narrowed TuiPluginHost type')
  }
  if (publicSource.includes('COMPAT(') || publicSource.includes('admissionCompat')) {
    failures.push('public plugin-host surface must not carry COMPAT/admissionCompat markers')
  }
}

if (failures.length > 0) {
  console.error('verify:compat-removal FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify:compat-removal OK (phase ${ADAPTER_V2_PHASE}; ${LEGACY_SHIM_PATHS.length} shim paths absent; ${checkedFiles} source/script files scanned for migration graph; public ./plugin-host export verified)`)
