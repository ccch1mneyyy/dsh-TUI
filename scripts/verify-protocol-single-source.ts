/**
 * Private protocol / permission / catalog single-source gate.
 *
 * Enforces:
 * - only `src/adapter/spec/**` may resolve `#dsh-ecosystem-spec/*`,
 *   `dsh-ecosystem-spec/*`, or relative paths into the vendored spec;
 * - no production code declares the private protocol constant/mapping sets
 *   locally (all derivation lives in `src/adapter/spec`);
 * - spec-derived constants agree with the vendored machine-readable registry;
 * - the process-level canonical ProtocolCatalog is used;
 * - the public plugin-host export surface does not expose mutable catalog
 *   factories, test admission, or caller-supplied principal grant APIs.
 *
 * Run via `node --import tsx/esm scripts/verify-protocol-single-source.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const ADAPTER = join(SRC, 'adapter')
const SPEC = join(ADAPTER, 'spec')
const STANDARD = join(ADAPTER, 'standard')
const DSH_SPEC_SPECIFIERS = ['#dsh-ecosystem-spec', 'dsh-ecosystem-spec/', '../dsh-ecosystem-spec', '../../dsh-ecosystem-spec']
const CATALOG_FILE = join(STANDARD, 'tui-extension.ts')

function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...collectFiles(path))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx') || entry.endsWith('.mts') || entry.endsWith('.cts')) out.push(path)
  }
  return out
}

function isUnder(file: string, dir: string): boolean {
  return !relative(dir, file).startsWith('..')
}

function moduleSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  // Dynamic/indirect resolution including createRequire/import.meta.resolve.
  for (const match of source.matchAll(/(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\(|createRequire\s*\([^)]*\)\s*\()\s*['"]([^'"]+)['"]/gu)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

const failures: string[] = []
const allFiles = collectFiles(SRC)

for (const file of allFiles) {
  const rel = relative(ROOT, file)
  for (const specifier of moduleSpecifiers(file)) {
    const touchesSpec = DSH_SPEC_SPECIFIERS.some(prefix => specifier.startsWith(prefix))
      || specifier.includes('dsh-ecosystem-spec')
    if (touchesSpec && !isUnder(file, SPEC)) {
      failures.push(`${rel}: resolves dsh-ecosystem-spec outside spec (${specifier}); must go through src/adapter/spec`)
    }
  }
}

// No local constant/mapping declarations outside the spec derivation layer.
const LOCAL_CONSTANT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bconst\s+TUI_DECISION_EVENT_NAMES\b/u, 'TUI_DECISION_EVENT_NAMES'],
  [/\bconst\s+TUI_EXTENSION_PERMISSION_NAMES\b/u, 'TUI_EXTENSION_PERMISSION_NAMES'],
  [/\bconst\s+INTERCEPT_PERMISSIONS\b/u, 'INTERCEPT_PERMISSIONS'],
  [/\bconst\s+EXPECTED_PERMISSIONS\b/u, 'EXPECTED_PERMISSIONS'],
  [/\bconst\s+DECISION_EVENT_PERMISSIONS\b/u, 'DECISION_EVENT_PERMISSIONS'],
  [/\bconst\s+INTERCEPT_EVENT_SCOPE_BY_PERMISSION\b/u, 'INTERCEPT_EVENT_SCOPE_BY_PERMISSION'],
  [/\bconst\s+HOST_SUPPORTED_CONTRACTS\b/u, 'HOST_SUPPORTED_CONTRACTS'],
]
for (const file of allFiles) {
  if (isUnder(file, SPEC)) continue
  const source = readFileSync(file, 'utf8')
  for (const [pattern, label] of LOCAL_CONSTANT_PATTERNS) {
    if (pattern.test(source)) {
      failures.push(`${relative(ROOT, file)} locally declares ${label}; derive it from src/adapter/spec`)
    }
  }
}

// Product code must not call the old per-call factory; it must use
// getAdmissionCatalog() through the canonical ContractIndex.
for (const file of allFiles) {
  if (file === CATALOG_FILE) continue
  const source = readFileSync(file, 'utf8')
  if (/\bcreateAdmissionCatalog\s*\(/u.test(source)) {
    failures.push(`${relative(ROOT, file)} calls createAdmissionCatalog(); use getAdmissionCatalog()`)
  }
}

// Public plugin-host surface must not expose mutable catalog, test admission,
// or caller-supplied principal grant APIs.
const PUBLIC_SHIM = join(SRC, 'plugin-host.ts')
const publicSource = readFileSync(PUBLIC_SHIM, 'utf8')
const forbiddenPublicExports = [
  'createAdmissionCatalog',
  'getHostAdmissionForTest',
  'mountAdmitted',
  'GrantStore',
  'GrantPrincipal',
  'ProtocolCatalog',
]
for (const name of forbiddenPublicExports) {
  if (new RegExp(`\\b${name}\\b`).test(publicSource)) {
    failures.push(`public plugin-host shim must not export ${name}`)
  }
}

// Runtime consistency with the vendored machine-readable sources.
const {
  EXPECTED_PERMISSIONS,
  TUI_DECISION_EVENT_NAMES,
  TUI_EXTENSION_PERMISSION_NAMES,
  DECISION_EVENT_PERMISSIONS,
  INTERCEPT_EVENT_SCOPE_BY_PERMISSION,
  HOST_SUPPORTED_CONTRACTS,
} = await import('../src/adapter/spec/protocol-constants.js')
const { getAdmissionCatalog, createAdmissionCatalog } = await import('../src/adapter/standard/tui-extension.js')
const { loadSpecData } = await import('../src/adapter/standard/registry.js')
const specData = loadSpecData()
if (specData === undefined) {
  failures.push('vendored dsh-ecosystem-spec data is unavailable; cannot verify protocol constant consistency')
} else {
  const expectedByName = new Map(EXPECTED_PERMISSIONS.map(permission => [permission.name, permission]))
  const actualPermissions = specData.permissions.permissions
  if (actualPermissions.length !== EXPECTED_PERMISSIONS.length) {
    failures.push(`permission registry has ${actualPermissions.length} entries; spec-derived EXPECTED_PERMISSIONS has ${EXPECTED_PERMISSIONS.length}`)
  }
  for (const permission of actualPermissions) {
    const expected = expectedByName.get(permission.name)
    if (expected === undefined) {
      failures.push(`permission ${permission.name} is not in spec-derived EXPECTED_PERMISSIONS`)
    } else if (expected.default !== permission.default || expected.revocable !== permission.revocable || expected.scope !== permission.scope) {
      failures.push(`permission ${permission.name} metadata differs from spec-derived EXPECTED_PERMISSIONS`)
    }
  }
  let adapterNote: string | undefined
  try {
    adapterNote = readFileSync(join(specData.dir, 'adapters', 'dsh-tui-v0.15.md'), 'utf8')
  } catch (error) {
    failures.push(`cannot read the committed adapter note: ${error instanceof Error ? error.message : String(error)}`)
  }
  const eventLine = adapterNote?.split(String.fromCharCode(10)).find(line => line.includes('事件名')) ?? ''
  const committedEvents = [...eventLine.matchAll(/`(tui\/[a-z0-9-]+)`/gu)].map(match => match[1]!).sort()
  const eventNamesMatch = JSON.stringify([...TUI_DECISION_EVENT_NAMES].sort()) === JSON.stringify(committedEvents)
  if (!eventNamesMatch) {
    failures.push(`TUI_DECISION_EVENT_NAMES drifted from the committed adapter-note vocabulary (expected ${committedEvents.join(', ')})`)
  }
  const committedInterceptPermissions = actualPermissions
    .filter(permission => /^session\..+\.intercept$/u.test(permission.name))
    .map(permission => permission.name)
    .sort()
  const permissionNamesMatch = JSON.stringify([...TUI_EXTENSION_PERMISSION_NAMES].sort()) === JSON.stringify(committedInterceptPermissions)
  if (!permissionNamesMatch) {
    failures.push('TUI_EXTENSION_PERMISSION_NAMES drifted from the committed permission registry')
  }
  // Decision event permission map consistency.
  const eventNames = new Set(TUI_DECISION_EVENT_NAMES)
  const permissionNames = new Set(TUI_EXTENSION_PERMISSION_NAMES)
  for (const [event, permission] of Object.entries(DECISION_EVENT_PERMISSIONS)) {
    if (!eventNames.has(event)) failures.push(`DECISION_EVENT_PERMISSIONS contains unknown event ${event}`)
    if (!permissionNames.has(permission)) failures.push(`DECISION_EVENT_PERMISSIONS maps ${event} to unknown permission ${permission}`)
    if (INTERCEPT_EVENT_SCOPE_BY_PERMISSION[permission] !== event) {
      failures.push(`INTERCEPT_EVENT_SCOPE_BY_PERMISSION is not the inverse of DECISION_EVENT_PERMISSIONS for ${permission}`)
    }
  }
  const expectedHostContracts = [
    { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
    { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
    { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' },
    { apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' },
  ]
  const hostContractsKey = (contract: { apiVersion: string; kind: string }): string => `${contract.apiVersion}#${contract.kind}`
  const hostContractsMatch = JSON.stringify([...HOST_SUPPORTED_CONTRACTS].map(hostContractsKey).sort()) === JSON.stringify(
    [...expectedHostContracts].map(hostContractsKey).sort(),
  )
  if (!hostContractsMatch) {
    failures.push(`HOST_SUPPORTED_CONTRACTS drifted from the spec-derived host driver set: ${JSON.stringify(HOST_SUPPORTED_CONTRACTS)}`)
  }
}

// Pinned submodule must be clean and match the revision constant.
try {
  const specGitDir = join(ROOT, 'dsh-ecosystem-spec')
  const head = execFileSync('git', ['-C', specGitDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['-C', specGitDir, 'status', '--short'], { encoding: 'utf8' }).trim()
  const { ECOSYSTEM_SPEC_REVISION } = await import('../src/adapter/standard/registry.js')
  if (head !== ECOSYSTEM_SPEC_REVISION) {
    failures.push(`dsh-ecosystem-spec HEAD ${head} does not match ECOSYSTEM_SPEC_REVISION ${ECOSYSTEM_SPEC_REVISION}`)
  }
  if (status !== '') {
    failures.push(`dsh-ecosystem-spec has uncommitted changes (must be clean for reproducible derivation): ${status}`)
  }
} catch (error) {
  failures.push(`cannot verify dsh-ecosystem-spec submodule state: ${error instanceof Error ? error.message : String(error)}`)
}

// Canonical catalog singleton.
const canonical = getAdmissionCatalog()
if (createAdmissionCatalog() !== canonical) {
  failures.push('createAdmissionCatalog() returned a non-canonical catalog (singleton broken)')
}

// The canonical catalog must delegate private profiles to the spec boundary.
const catalogSource = readFileSync(CATALOG_FILE, 'utf8')
const catalogAst = ts.createSourceFile(CATALOG_FILE, catalogSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let delegatesProfileRegistration = false
const visitCatalog = (node: ts.Node): void => {
  if (ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'registerProfileProtocols') {
    delegatesProfileRegistration = true
  }
  ts.forEachChild(node, visitCatalog)
}
visitCatalog(catalogAst)
if (!delegatesProfileRegistration) {
  failures.push('standard/tui-extension.ts createAdmissionCatalog does not delegate private profiles to spec registerProfileProtocols')
}

if (failures.length > 0) {
  console.error('verify:protocol-single-source FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify:protocol-single-source OK (${allFiles.length} src files, ${SPEC.split(/[\/]/).pop()} spec boundary, canonical catalog singleton, public surface clean)`)
