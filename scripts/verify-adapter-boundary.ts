/**
 * Adapter boundary gate. The rules (also in ADAPTER.md 「边界规则」):
 *
 *   vendor package            may only be imported from
 *   @deepseek-ai/*            src/dsh-adapter/**
 *   @anthropic-ai/*           src/backends/claude/**
 *   @agentclientprotocol/*    src/backends/acp/**
 *   @dsh-std/*                src/adapter/standard/**, src/dsh-adapter/**
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

const SRC = resolve(import.meta.dirname, '..', 'src')
const ALLOWLIST_FILE = join(import.meta.dirname, 'adapter-boundary.allowlist.json')
const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const VERBOSE = process.argv.includes('--verbose')

interface VendorRule {
  readonly label: string
  readonly pattern: RegExp
  readonly allowedIn: readonly string[]
}

const VENDOR_RULES: readonly VendorRule[] = [
  { label: '@deepseek-ai/*', pattern: /^@deepseek-ai\//u, allowedIn: ['dsh-adapter/'] },
  { label: '@anthropic-ai/*', pattern: /^@anthropic-ai\//u, allowedIn: ['backends/claude/'] },
  { label: '@agentclientprotocol/*', pattern: /^@agentclientprotocol\//u, allowedIn: ['backends/acp/'] },
  { label: '@dsh-std/*', pattern: /^@dsh-std\//u, allowedIn: ['adapter/standard/', 'dsh-adapter/'] },
]

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

const NATIVE_RULES: readonly { readonly key: string; readonly allowedIn: string }[] = [
  { key: 'dsh', allowedIn: 'dsh-adapter/' },
  { key: 'codex', allowedIn: 'backends/codex/' },
]

const NATIVE_PATTERNS = [
  /\bnative\s*\??\.\s*(dsh|claude|codex|acp)\b/gu,
  /\bnative\s*(?:\?\.)?\s*\[\s*['"](dsh|claude|codex|acp)['"]\s*\]/gu,
  /\{[^{}]*?\b(dsh|claude|codex|acp)\b[^{}]*\}\s*=\s*[\w$.?!]*\bnative\b/gu,
]

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
      if (ref.specifier.startsWith('@deepseek-ai/') && ref.specifier !== '@deepseek-ai/cordis') {
        violations.push(`${where} imports '${ref.specifier}'; channel core may import only @deepseek-ai/cordis`)
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

  for (const pattern of NATIVE_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const rule = NATIVE_RULES.find(candidate => candidate.key === match[1])
      if (rule === undefined) {
        violations.push(`${path}:${lineAt(code, match.index)} reads native.${match[1]}; only native.dsh is declared`)
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
