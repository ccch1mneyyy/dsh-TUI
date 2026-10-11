/**
 * Adapter boundary gate. The rules (also in ADAPTER.md 「边界规则」):
 *
 *   vendor package            may only be imported from
 *   @deepseek-ai/*            src/dsh-adapter/**
 *   @anthropic-ai/*           src/backends/claude/**        (derived from its manifest)
 *   @agentclientprotocol/*    src/backends/acp/**
 *   @dsh-std/*                src/adapter/standard/**, src/dsh-adapter/**
 *
 *   native.dsh                src/dsh-adapter/**             (first-party kernel)
 *   native.<manifest key>     src/backends/<that backend>/** (derived per manifest)
 *
 * The two derived families (P0 §6) come from the backend manifests:
 * `vendorPackages` yields one rule per declared package prefix, `nativeKey` one
 * rule per backend that declares a native channel. Deriving must never *widen*
 * the gate, so the result is compared against the expected snapshot below: a
 * manifest that invents a rule (say `nativeKey: 'claude'` on a backend that never
 * had one) fails here and has to be approved in ADAPTER.md first.
 *
 *   src/agent/**, src/channel/**   no vendor package (rows above), no
 *                                  src/dsh-adapter/** or src/backends/**;
 *                                  src/agent/** also not src/channel/**
 *                                  (the domain sits below the projection);
 *                                  no src/ink/** except the explicit edge
 *                                  src/channel/sanitize.ts → src/ink/stringWidth.ts
 *                                  (a pure leaf: display-cell width, no
 *                                  renderer state)
 *   src/{screens,components,hooks,ink}/**
 *                                  no src/backends/** at all; type-only imports
 *                                  of src/dsh-adapter/** are fine, value imports
 *                                  are not; the ones that predate this rule are
 *                                  listed in adapter-boundary.allowlist.json
 *                                  (reported as one warning); an unlisted one
 *                                  fails, and so does a listed one that no
 *                                  longer exists, so the list only shrinks
 *   src/backends/<x>/**            no src/backends/<y>/** (each backend is an
 *                                  island); src/backends/shared/** is the
 *                                  one exception every backend may import
 *   src/backends/shared/**         backend-neutral helpers (D15 of
 *                                  docs/codex-backend-design.md): no scoped
 *                                  (vendor) package, no concrete backend
 *                                  directory, no src/dsh-adapter/**
 *   native.dsh    only inside src/dsh-adapter/**
 *   native.codex  only inside src/backends/codex/**
 *
 * The standalone entry's host loading (ADAPTER.md, host contract):
 *
 *   '@deepseek-ai/…' as any string literal (a specifier handed to a
 *                  `createRequire` / `import()` built at run time, not only a
 *                  static import) only inside src/dsh-adapter/**
 *   the host-only modules (src/dsh-adapter/host-contract.ts HOST_MODULES
 *                  other than cordis, and the host package itself) are never
 *                  value-imported anywhere: they load from the installed dsh
 *                  by realpath, in src/dsh-adapter/host-dsh.ts alone, which
 *                  names them only through host-contract.ts; their string
 *                  literals live in host-contract.ts (contract.ts may read the
 *                  host's package.json for its version)
 *   src/dsh-adapter/host-dsh.ts    every @deepseek-ai/* import type-only
 *   src/dsh-adapter/host-contract.ts imported only by host-dsh.ts and
 *                  contract.ts
 *
 * Plain fs + regex scan, no TypeScript program: it runs inside `verify:build`
 * on every build and must not depend on the compiled tree. Only real module
 * specifiers count (static import/export … from, bare side-effect imports,
 * dynamic import(), require(), import.meta.resolve()); comment-only lines are
 * blanked first, so prose that mentions a package is not a violation. An
 * import is type-only when it is `import type`/`export type`, when every
 * named specifier carries an inline `type` (TypeScript elides those), when it
 * sits in a `.d.ts`, or when a dynamic import() is used in a type position.
 * Only direct specifiers are checked; a value import that reaches a vendor
 * package through another module is out of scope for this gate.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-boundary.ts [--verbose]`
 * (`--verbose` lists the allowlisted UI value imports).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BackendManifest } from '../src/agent/backend-manifest.js'

const SRC = resolve(import.meta.dirname, '..', 'src')
const ALLOWLIST_FILE = join(import.meta.dirname, 'adapter-boundary.allowlist.json')
const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const VERBOSE = process.argv.includes('--verbose')

interface VendorRule {
  readonly label: string
  readonly pattern: RegExp
  readonly allowedIn: readonly string[]
}

/** Rules that cannot come from a manifest: the host framework boundary, the
 *  protocol package of a backend directory that does not exist yet
 *  (`ADAPTER.md:11`), and the vendored standard adapter. */
const BUILTIN_VENDOR_RULES: readonly VendorRule[] = [
  { label: '@deepseek-ai/*', pattern: /^@deepseek-ai\//u, allowedIn: ['dsh-adapter/'] },
  { label: '@agentclientprotocol/*', pattern: /^@agentclientprotocol\//u, allowedIn: ['backends/acp/'] },
  { label: '@dsh-std/*', pattern: /^@dsh-std\//u, allowedIn: ['adapter/standard/', 'dsh-adapter/'] },
]

/** The rules this gate must end up with, per family. Deriving is only allowed to
 *  reproduce exactly this (P0 §6): a manifest edit that relaxes the boundary has
 *  to change this snapshot — and ADAPTER.md — on purpose. */
const EXPECTED_VENDOR_RULES: readonly { readonly label: string; readonly allowedIn: readonly string[] }[] = [
  { label: '@deepseek-ai/*', allowedIn: ['dsh-adapter/'] },
  { label: '@anthropic-ai/*', allowedIn: ['backends/claude/'] },
  { label: '@agentclientprotocol/*', allowedIn: ['backends/acp/'] },
  { label: '@dsh-std/*', allowedIn: ['adapter/standard/', 'dsh-adapter/'] },
]
const EXPECTED_NATIVE_RULES: readonly { readonly key: string; readonly allowedIn: string }[] = [
  { key: 'dsh', allowedIn: 'dsh-adapter/' },
  { key: 'codex', allowedIn: 'backends/codex/' },
]

/** The one allowlisted runtime import a manifest may have: claude's SDK pin
 *  (`VALIDATED_SDK_VERSION`, via contract.ts). Everything else in a manifest
 *  must be types, or the build-time index would pull backend code into every
 *  boot (P0 §4.4). */
const MANIFEST_IMPORT_ALLOWLIST: readonly { readonly from: string; readonly to: string }[] = [
  { from: 'backends/claude/manifest.ts', to: 'backends/claude/contract.ts' },
]

/** The host's own kernel channel: `native.dsh` is first-party by definition and
 *  has no manifest to declare it. */
const DSH_NATIVE_KEY = 'dsh'

/** Internal targets each neutral layer must not reach; `allow` lists the
 *  explicit file→file edges that are exempt (pure leaves). */
const LAYER_RULES: readonly { readonly dir: string; readonly forbidden: readonly string[]; readonly allow?: readonly string[] }[] = [
  { dir: 'agent/', forbidden: ['dsh-adapter/', 'backends/', 'channel/', 'ink/'] },
  { dir: 'channel/', forbidden: ['dsh-adapter/', 'backends/', 'ink/'], allow: ['channel/sanitize.ts -> ink/stringWidth.ts'] },
]

const UI_DIRS = ['screens/', 'components/', 'hooks/', 'ink/']
/** Backend-neutral helpers every backend may import (D15). */
const SHARED_BACKEND_DIR = 'backends/shared/'
/** Any scoped package: vendor SDKs and host frameworks alike. */
const SCOPED_PACKAGE = /^@[^/]+\//u
// channel/input-delivery.ts stays outside core because it builds DSH user
// messages and ids for every backend through createUserMessage.
const CORE_DIR = 'dsh-adapter/channel/core/'

const HOST_DSH = 'dsh-adapter/host-dsh.ts'
const HOST_CONTRACT = 'dsh-adapter/host-contract.ts'
const HOST_CONTRACT_IMPORTERS = [HOST_DSH, 'dsh-adapter/contract.ts']
/** Host-only literals contract.ts may carry (a manifest read, not a module load). */
const HOST_LITERAL_EXCEPTIONS = new Set(['dsh-adapter/contract.ts @deepseek-ai/dsh/package.json'])
const STRING_LITERAL = /(['"`])(@deepseek-ai\/[^'"`\s]*)\1/gu

/** The host-only specifiers, read from the contract's source text (the gate must not import src/). */
function readHostOnlySpecifiers(): Set<string> {
  const source = readFileSync(join(SRC, HOST_CONTRACT), 'utf8')
  const host = /export const HOST_PACKAGE = '([^']+)'/u.exec(source)?.[1]
  const modules = /export const HOST_MODULES = \[([\s\S]*?)\] as const/u.exec(source)?.[1]
  if (host === undefined || modules === undefined) throw new Error(`src/${HOST_CONTRACT}: HOST_PACKAGE / HOST_MODULES not found`)
  const specifiers = new Set([host])
  for (const match of modules.matchAll(/specifier: '([^']+)'/gu)) if (match[1] !== '@deepseek-ai/cordis') specifiers.add(match[1])
  if (specifiers.size < 2) throw new Error(`src/${HOST_CONTRACT}: HOST_MODULES lists no specifier`)
  return specifiers
}
const HOST_ONLY = readHostOnlySpecifiers()
const HOST_PACKAGE_NAME = [...HOST_ONLY][0]
const isHostOnly = (specifier: string): boolean => HOST_ONLY.has(specifier) || specifier.startsWith(`${HOST_PACKAGE_NAME}/`)

/** Read every backend manifest, fail loud when one cannot be read (a manifest
 *  that silently disappears would silently *relax* the gate), and check that it
 *  imports nothing but types. */
async function readManifests(): Promise<readonly { readonly name: string; readonly manifest: BackendManifest }[]> {
  const dir = join(SRC, 'backends')
  const found: { name: string; manifest: BackendManifest }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const manifestFile = join(dir, entry.name, 'manifest.ts')
    if (!statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) continue
    const code = maskCommentLines(readFileSync(manifestFile, 'utf8'))
    const path = toPosix(relative(SRC, manifestFile))
    for (const ref of collectImports(code, false)) {
      if (ref.typeOnly) continue
      // `./contract.js` in source means `contract.ts` on disk (the repo's
      // compiled-specifier convention), which is how the allowlist spells it.
      const target = resolveInternal(manifestFile, ref.specifier)?.replace(/\.js$/u, '.ts')
      const allowed = target !== undefined && MANIFEST_IMPORT_ALLOWLIST.some(entry => entry.from === path && entry.to === target)
      if (!allowed) {
        console.error(`Adapter boundary violated:\n  - ${path}:${ref.line} imports '${ref.specifier}'; a manifest is pure data (types only, plus the allowlisted version constant)`)
        process.exit(1)
      }
    }
    const module: unknown = await import(pathToFileURL(manifestFile).href)
    const manifest = (module as { manifest?: BackendManifest }).manifest
    if (manifest === undefined || typeof manifest !== 'object') {
      console.error(`Adapter boundary violated:\n  - ${path} must export \`manifest\`; the gate derives its rules from it`)
      process.exit(1)
    }
    found.push({ name: entry.name, manifest })
  }
  return found
}

const fail = (message: string): never => {
  console.error(`Adapter boundary violated:\n  - ${message}`)
  process.exit(1)
}

/** Derive the two manifest-owned rule families and pin them to the snapshot. */
function deriveRules(manifests: readonly { readonly name: string; readonly manifest: BackendManifest }[]): {
  readonly vendor: readonly VendorRule[]
  readonly native: readonly { readonly key: string; readonly allowedIn: string }[]
  readonly nativeKeys: readonly string[]
} {
  const vendor: VendorRule[] = [BUILTIN_VENDOR_RULES[0]!]
  for (const { name, manifest } of manifests) {
    for (const prefix of manifest.vendorPackages ?? []) {
      if (manifest.inTree !== true) fail(`src/backends/${name}/manifest.ts declares vendorPackages; a non-in-tree backend may not widen the boundary`)
      if (!/^@[^/]+\/$/u.test(prefix)) fail(`src/backends/${name}/manifest.ts: vendorPackages entry "${prefix}" must be a scoped package prefix like "@scope/"`)
      // A prefix that overlaps a built-in rule would grant the backend a second
      // path to a package the boundary keeps somewhere else.
      const clashes = BUILTIN_VENDOR_RULES.find(rule => rule.label.startsWith(prefix) || prefix.startsWith(rule.label.replace(/\*$/u, '')))
      if (clashes !== undefined) fail(`src/backends/${name}/manifest.ts: vendorPackages entry "${prefix}" overlaps the built-in rule ${clashes.label}`)
      vendor.push({ label: `${prefix}*`, pattern: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`), allowedIn: [`backends/${name}/`] })
    }
  }
  vendor.push(...BUILTIN_VENDOR_RULES.slice(1))

  const native = [{ key: DSH_NATIVE_KEY, allowedIn: 'dsh-adapter/' }]
  for (const { name, manifest } of manifests) {
    if (manifest.nativeKey === undefined) continue
    if (manifest.inTree !== true) fail(`src/backends/${name}/manifest.ts declares nativeKey; native channels are a first-party privilege`)
    if (manifest.nativeKey === DSH_NATIVE_KEY) fail(`src/backends/${name}/manifest.ts must not claim native.${DSH_NATIVE_KEY} (the host's own channel)`)
    if (manifest.nativeKey !== manifest.id) fail(`src/backends/${name}/manifest.ts: nativeKey "${manifest.nativeKey}" must equal the backend id, so the rule cannot point at another backend's directory`)
    native.push({ key: manifest.nativeKey, allowedIn: `backends/${name}/` })
  }

  const derivedVendor = vendor.map(rule => ({ label: rule.label, allowedIn: rule.allowedIn }))
  if (JSON.stringify(derivedVendor) !== JSON.stringify(EXPECTED_VENDOR_RULES)) {
    fail(`derived vendor rules differ from the expected snapshot:\n      derived:  ${JSON.stringify(derivedVendor)}\n      expected: ${JSON.stringify(EXPECTED_VENDOR_RULES)}\n    (update ADAPTER.md and this snapshot together when the boundary really changes)`)
  }
  if (JSON.stringify(native) !== JSON.stringify(EXPECTED_NATIVE_RULES)) {
    fail(`derived native rules differ from the expected snapshot:\n      derived:  ${JSON.stringify(native)}\n      expected: ${JSON.stringify(EXPECTED_NATIVE_RULES)}\n    (update ADAPTER.md and this snapshot together when the boundary really changes)`)
  }
  // Every name a `native.<key>` read could spell, for the read detector below.
  const nativeKeys = [...new Set([...native.map(rule => rule.key), 'acp', ...manifests.map(({ manifest }) => manifest.id)])]
  return { vendor, native, nativeKeys }
}

interface ImportRef {
  readonly specifier: string
  readonly typeOnly: boolean
  readonly line: number
}

interface AllowlistEntry {
  readonly from: string
  readonly to: string
}

const toPosix = (path: string): string => path.split(sep).join('/')
const under = (path: string, dir: string): boolean => path.startsWith(dir)

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collectSourceFiles(path, out)
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) out.push(path)
  }
}

/**
 * Blank comment-only lines (`//`, `/*`, ` *`) while keeping line numbers.
 * Trailing comments on code lines stay: none of them holds import syntax in
 * this repo, and stripping them would need a real tokenizer (string and regex
 * literals contain `//`).
 */
function maskCommentLines(source: string): string {
  return source
    .split('\n')
    .map(line => (/^\s*(?:\/\/|\/\*|\*)/u.test(line) ? '' : line))
    .join('\n')
}

const lineAt = (code: string, index: number): number => code.slice(0, index).split('\n').length

// The clause between the keyword and `from` never holds quotes, parens, `=`,
// `;` or `:`, and must not run into the next import/export statement. That
// keeps a multi-line import matchable without swallowing unrelated code.
const STATIC_IMPORT = /^[ \t]*(?:import|export)\b((?:(?!\n[ \t]*(?:import|export)\b)[^'"`()=;:])*?)\bfrom\s*(['"])([^'"\n]+)\2/gmu
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gmu
const DYNAMIC_IMPORT = /(?<![\w$.])(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)|import\.meta\.resolve\s*\(\s*(['"])([^'"\n]+)\3/gu

function clauseIsTypeOnly(clause: string): boolean {
  const trimmed = clause.trim()
  if (/^type\b/u.test(trimmed)) return true
  // `{ type A, type B }` without a default or namespace binding is elided.
  const braces = /^\{([\s\S]*)\}$/u.exec(trimmed)
  if (!braces) return false
  const names = braces[1].split(',').map(name => name.trim()).filter(Boolean)
  return names.length > 0 && names.every(name => /^type\s/u.test(name))
}

function collectImports(code: string, declarationFile: boolean): ImportRef[] {
  const refs: ImportRef[] = []
  for (const match of code.matchAll(STATIC_IMPORT)) {
    refs.push({ specifier: match[3], typeOnly: declarationFile || clauseIsTypeOnly(match[1]), line: lineAt(code, match.index) })
  }
  for (const match of code.matchAll(SIDE_EFFECT_IMPORT)) {
    refs.push({ specifier: match[2], typeOnly: declarationFile, line: lineAt(code, match.index) })
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[2] ?? match[4]
    const before = code.slice(Math.max(0, match.index - 16), match.index)
    const after = code.slice(match.index + match[0].length, match.index + match[0].length + 24)
    // `typeof import('x')` and `import('x').Name` (other than a promise
    // method) are type positions; `await import('x')` is a value.
    const typePosition = /\btypeof\s*$/u.test(before) || /^\s*\.\s*(?!then\b|catch\b|finally\b)[A-Za-z_$]/u.test(after)
    refs.push({ specifier, typeOnly: declarationFile || typePosition, line: lineAt(code, match.index) })
  }
  return refs
}

/** Resolve a relative specifier to a src-relative posix path, or undefined. */
function resolveInternal(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const target = toPosix(relative(SRC, resolve(dirname(file), specifier)))
  return target.startsWith('..') ? undefined : target
}

function readAllowlist(): AllowlistEntry[] {
  const label = relative(process.cwd(), ALLOWLIST_FILE)
  const raw: unknown = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'))
  const entries = raw && typeof raw === 'object' && 'entries' in raw ? raw.entries : undefined
  if (!Array.isArray(entries)) throw new Error(`${label}: expected { "entries": [...] }`)
  return entries.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || !('from' in entry) || !('to' in entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      throw new Error(`${label}: entry ${index} needs string "from" and "to"`)
    }
    return { from: entry.from, to: entry.to }
  })
}

// The manifest-derived rules (P0 §6). Read before the scan: a manifest that
// cannot be read or does not parse must fail the gate, never silently drop its
// rule (that would widen the boundary without a word).
const MANIFESTS = await readManifests()
const { vendor: VENDOR_RULES, native: NATIVE_RULES, nativeKeys } = deriveRules(MANIFESTS)
/** Read detectors for every name a `native.<key>` read could spell. The
 *  alternation is deliberate: a wildcard would flag the local `native` bindings
 *  the DSH channel code legitimately uses (`const native = …capabilities.native.dsh`). */
const NATIVE_PATTERNS = [
  new RegExp(`\\bnative\\s*\\??\\.\\s*(${nativeKeys.join('|')})\\b`, 'gu'),
  new RegExp(`\\bnative\\s*(?:\\?\\.)?\\s*\\[\\s*['"](${nativeKeys.join('|')})['"]\\s*\\]`, 'gu'),
  new RegExp(`\\{[^{}]*?\\b(${nativeKeys.join('|')})\\b[^{}]*\\}\\s*=\\s*[\\w$.?!]*\\bnative\\b`, 'gu'),
]

const allowlist = readAllowlist()
const allowKey = (from: string, to: string): string => `${from} -> ${to}`
const allowed = new Set(allowlist.map(entry => allowKey(entry.from, entry.to)))
const usedAllowances = new Set<string>()
const allowlistedHits: string[] = []

const violations: string[] = []
const files: string[] = []
collectSourceFiles(SRC, files)
let importCount = 0

for (const file of files) {
  const path = toPosix(relative(SRC, file))
  const code = maskCommentLines(readFileSync(file, 'utf8'))
  const refs = collectImports(code, file.endsWith('.d.ts'))
  importCount += refs.length

  for (const ref of refs) {
    const where = `${path}:${ref.line}`
    if (under(path, CORE_DIR)) {
      // The core is built against ChannelHost, so a process-owning host can
      // compose it without a Cordis root.
      if (ref.specifier.startsWith('@deepseek-ai/')) {
        violations.push(`${where} imports '${ref.specifier}'; channel core must not import @deepseek-ai/* (take host services through ChannelHost)`)
      }
      if (ref.specifier === '../extensions.js' || ref.specifier.startsWith('../../backend/')) {
        violations.push(`${where} imports '${ref.specifier}'; channel core must not depend on DSH extensions or backend code`)
      }
    }
    for (const rule of VENDOR_RULES) {
      if (rule.pattern.test(ref.specifier) && !rule.allowedIn.some(dir => under(path, dir))) {
        violations.push(`${where} imports ${rule.label} ('${ref.specifier}'); allowed only in ${rule.allowedIn.map(dir => `src/${dir}`).join(', ')}`)
      }
    }
    if (under(path, SHARED_BACKEND_DIR) && SCOPED_PACKAGE.test(ref.specifier)) {
      violations.push(`${where} imports '${ref.specifier}'; src/${SHARED_BACKEND_DIR} must stay backend-neutral (no scoped vendor package)`)
    }
    const target = resolveInternal(file, ref.specifier)
    if (target === undefined) continue
    if (under(path, SHARED_BACKEND_DIR) && (under(target, 'dsh-adapter/') || (under(target, 'backends/') && !under(target, SHARED_BACKEND_DIR)))) {
      violations.push(`${where} imports src/${target}; src/${SHARED_BACKEND_DIR} must not depend on a concrete backend`)
    }
    for (const layer of LAYER_RULES) {
      if (!under(path, layer.dir)) continue
      const hit = layer.forbidden.find(dir => under(target, dir))
      if (hit && layer.allow?.includes(`${path} -> ${target.replace(/\.js$/u, '.ts')}`) === true) continue
      if (hit) violations.push(`${where} imports src/${target}; src/${layer.dir} must not depend on src/${hit}`)
    }
    if (under(path, 'backends/') && under(target, 'backends/') && !under(target, SHARED_BACKEND_DIR)) {
      const own = path.split('/')[1]
      const other = target.split('/')[1]
      if (own !== other) violations.push(`${where} imports src/${target}; src/backends/${own}/ must not depend on another backend (src/backends/${other}/)`)
    }
    if (!UI_DIRS.some(dir => under(path, dir))) continue
    if (under(target, 'backends/')) {
      violations.push(`${where} imports src/${target}; UI layers must not depend on src/backends/`)
    } else if (under(target, 'dsh-adapter/') && !ref.typeOnly) {
      const key = allowKey(path, target)
      if (allowed.has(key)) {
        usedAllowances.add(key)
        allowlistedHits.push(`${where} -> src/${target}`)
      } else {
        violations.push(`${where} imports values from src/${target}; UI layers may only take types from src/dsh-adapter/ (use \`import type\`, or move the value to a neutral module)`)
      }
    }
  }

  // The standalone entry's host loading (see the header).
  for (const ref of refs) {
    const where = `${path}:${ref.line}`
    if (isHostOnly(ref.specifier) && !ref.typeOnly && !HOST_LITERAL_EXCEPTIONS.has(`${path} ${ref.specifier}`)) {
      violations.push(`${where} value-imports '${ref.specifier}'; host-only modules load from the installed dsh by realpath (src/${HOST_DSH}), never from this package`)
    }
    if (path === HOST_DSH && ref.specifier.startsWith('@deepseek-ai/') && !ref.typeOnly) {
      violations.push(`${where} imports values from '${ref.specifier}'; src/${HOST_DSH} takes only types from @deepseek-ai/* (modules come from the host by realpath)`)
    }
    const target = resolveInternal(file, ref.specifier)?.replace(/\.js$/u, '.ts')
    if (target === HOST_CONTRACT && !HOST_CONTRACT_IMPORTERS.includes(path)) {
      violations.push(`${where} imports src/${HOST_CONTRACT}; only ${HOST_CONTRACT_IMPORTERS.map(item => `src/${item}`).join(' and ')} read the host contract`)
    }
  }
  // A type-only import's specifier is a type, not a load: the rules above own it.
  const typeSpecifiers = new Set(refs.filter(ref => ref.typeOnly).map(ref => `${ref.line} ${ref.specifier}`))
  for (const match of code.matchAll(STRING_LITERAL)) {
    const where = `${path}:${lineAt(code, match.index)}`
    const literal = match[2]
    if (under(path, 'dsh-adapter/') && typeSpecifiers.has(`${lineAt(code, match.index)} ${literal}`)) continue
    if (!under(path, 'dsh-adapter/')) {
      violations.push(`${where} names '${literal}'; @deepseek-ai/* specifiers (also ones resolved or imported at run time) belong in src/dsh-adapter/`)
    } else if (isHostOnly(literal) && path !== HOST_CONTRACT && !HOST_LITERAL_EXCEPTIONS.has(`${path} ${literal}`)) {
      violations.push(`${where} names the host-only '${literal}'; only src/${HOST_CONTRACT} lists host modules (src/${HOST_DSH} loads them from it)`)
    }
  }

  for (const pattern of NATIVE_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const rule = NATIVE_RULES.find(candidate => candidate.key === match[1])
      if (rule === undefined) {
        violations.push(`${path}:${lineAt(code, match.index)} reads native.${match[1]}; declared native channels: ${NATIVE_RULES.map(rule => rule.key).join(', ')}`)
      } else if (under(path, CORE_DIR) && rule.key === 'dsh') {
        violations.push(`${path}:${lineAt(code, match.index)} reads native.dsh; channel core must not access native backend slots`)
      } else if (rule && !under(path, rule.allowedIn)) {
        violations.push(`${path}:${lineAt(code, match.index)} reads native.${rule.key}; only src/${rule.allowedIn} may touch it`)
      }
    }
  }
}

for (const entry of allowlist) {
  const key = allowKey(entry.from, entry.to)
  if (!usedAllowances.has(key)) {
    violations.push(`allowlist entry "${key}" no longer matches a value import; delete it from scripts/adapter-boundary.allowlist.json`)
  }
}

if (violations.length > 0) {
  console.error('Adapter boundary violated:')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}

if (allowlistedHits.length > 0) {
  console.warn(`adapter boundary warning: ${allowlistedHits.length} allowlisted UI value imports from src/dsh-adapter/ (${allowlist.length} file pairs in scripts/adapter-boundary.allowlist.json) await cleanup${VERBOSE ? ':' : '; --verbose lists them'}`)
  if (VERBOSE) for (const hit of allowlistedHits) console.warn(`  - ${hit}`)
}
console.log(`adapter boundary OK (${files.length} source files, ${importCount} import specifiers scanned)`)
