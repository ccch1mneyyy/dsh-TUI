/**
 * Verify the new adapter/ skeleton boundaries.
 *
 * This is a P0/P1 gate skeleton:
 * - ports/ may not import @deepseek-ai, @dsh-std or dsh-ecosystem-spec.
 * - kernel/ may not import @deepseek-ai or @dsh-std directly.
 * - upstream/ may import @deepseek-ai in the future, but must not import
 *   @dsh-std or dsh-ecosystem-spec private protocol.
 * - standard/ may import @dsh-std and dsh-ecosystem-spec, but never
 *   @deepseek-ai.
 * - legacy shim paths are verified absent.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-skeleton.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..', 'src')
const ADAPTER = join(SRC, 'adapter')
const LAYERS = {
  ports: join(ADAPTER, 'ports'),
  kernel: join(ADAPTER, 'kernel'),
  upstream: join(ADAPTER, 'upstream'),
  standard: join(ADAPTER, 'standard'),
  spec: join(ADAPTER, 'spec'),
} as const
const SOURCE_GLOBS = ['.ts', '.tsx', '.d.ts']

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) collect(path, out)
    else if (SOURCE_GLOBS.some(ext => entry.endsWith(ext))) out.push(path)
  }
  return out
}

// Matches real module specifiers only (import/export from, bare import,
// dynamic import/require/import.meta.resolve); comments containing the words
// are not violations.
const ANY_ADAPTER_FORBIDDEN = /(?:import|export)\s[^'"]*?from\s*['"](?:@deepseek-ai\/|@dsh-std\/|#dsh-ecosystem-spec)|import\s*['"](?:@deepseek-ai\/|@dsh-std\/|#dsh-ecosystem-spec)|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"](?:@deepseek-ai\/|@dsh-std\/|#dsh-ecosystem-spec)/u
const UPSTREAM_FORBIDDEN = /(?:import|export)\s[^'"]*?from\s*['"](?:@dsh-std\/|#dsh-ecosystem-spec)|import\s*['"](?:@dsh-std\/|#dsh-ecosystem-spec)|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"](?:@dsh-std\/|#dsh-ecosystem-spec)/u
const OFFICIAL_FORBIDDEN = /(?:import|export)\s[^'"]*?from\s*['"]@deepseek-ai\/|import\s*['"]@deepseek-ai\/|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"]@deepseek-ai\//u

const failures: string[] = []
const checkNoImports = (layer: keyof typeof LAYERS, regex: RegExp, label: string): void => {
  for (const file of collect(LAYERS[layer])) {
    const content = readFileSync(file, 'utf8')
    if (regex.test(content)) {
      failures.push(`${relative(SRC, file)} imports ${label}`)
    }
  }
}

checkNoImports('ports', ANY_ADAPTER_FORBIDDEN, '@deepseek-ai/* or dsh-std/spec')
checkNoImports('kernel', ANY_ADAPTER_FORBIDDEN, '@deepseek-ai/* or dsh-std/spec')
checkNoImports('upstream', UPSTREAM_FORBIDDEN, '@dsh-std/dsh-ecosystem-spec')
const UPSTREAM_STANDARD_SPEC_IMPORT = /(?:import|export)\s[^'"]*?from\s*['"](?:\.\.\/)+(?:standard|spec)\/|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"](?:\.\.\/)+(?:standard|spec)\//u
checkNoImports('upstream', UPSTREAM_STANDARD_SPEC_IMPORT, '../standard or ../spec (shared values must come through kernel)')
checkNoImports('standard', OFFICIAL_FORBIDDEN, '@deepseek-ai/*')
checkNoImports('spec', OFFICIAL_FORBIDDEN, '@deepseek-ai/*')

// P6: the legacy public shims have been removed. Production code must import
// directly from adapter/standard; the existence of a legacy shim here is a
// hard failure instead of a delegated path.
const legacyShimPaths = [
  join(SRC, 'plugin-spec/types.ts'),
  join(SRC, 'plugin-spec/schema-check.ts'),
  join(SRC, 'plugin-spec/registry.ts'),
  join(SRC, 'plugin-spec/validate.ts'),
  join(SRC, 'plugin-spec/negotiate.ts'),
  join(SRC, 'plugin-spec/permission-scope.ts'),
  join(SRC, 'plugin-spec/tui-extension.ts'),
  join(SRC, 'dsh-adapter/grants.ts'),
  join(SRC, 'dsh-adapter/host-descriptor.ts'),
]
for (const shim of legacyShimPaths) {
  const { existsSync } = await import('node:fs')
  if (existsSync(shim)) {
    failures.push(`${relative(SRC, shim)} legacy shim still exists after P6 compat removal`)
  }
}

if (failures.length > 0) {
  console.error('adapter skeleton boundary FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`adapter skeleton boundary OK (${Object.keys(LAYERS).length} layers, ${legacyShimPaths.length} legacy shim paths verified absent)`)
