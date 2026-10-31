/**
 * Home-isolation gate for scripts that mount the composer (issue #1788).
 *
 * `DATA_DIR` resolves from `os.homedir()` at import time (src/utils/paths.ts),
 * and PromptInput writes every submitted text straight to
 * `<DATA_DIR>/history.jsonl` (src/components/PromptInput.tsx:1644) regardless of
 * whether the channel stub's `submit` does anything. A script that renders the
 * composer and drives Enter therefore leaves its fixture strings in the
 * developer's real ↑ history, where unscoped entries stay visible in every
 * project (src/history.ts `inProject`) and compete with real inputs under
 * `HISTORY_LIMIT = 200`.
 *
 * The CI runners already give each script a throwaway HOME (#1018), but running
 * a script by hand — the run line in its own header — bypasses that. The
 * invariant enforced here is local to the script: mount the composer, own a
 * HOME *before* any repository module is evaluated. `src/history.ts` fixes
 * `HISTORY_FILE` from `DATA_DIR` at import time too, so a fake home that only
 * outranks the composer still leaves an earlier import writing to the real one.
 *
 * Scope: scripts that import PromptInput itself, in the source tree and in the
 * compiled `lib/types/` mirror. Scripts that mount `src/screens/Chat.tsx` reach
 * the same file-system side effect one level down, through two separate writes:
 * the chat prompt (Chat.tsx:81 imports PromptInput → PromptInput.tsx:1644 passes
 * `channel.cwd`, so those entries are project-scoped) and the launchpad submit
 * (Chat.tsx:2923 `appendHistory(text)` with no cwd, so those entries are
 * unscoped and visible in every project exactly like this issue's). Those
 * scripts are out of scope here only because each one needs its own check for
 * assertions that read the real HOME — see #1790. Widen this gate together with
 * those imports.
 *
 * Run: node scripts/verify-script-home-isolation.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPTS = join(ROOT, 'scripts')
const SUFFIXES = ['.mjs', '.ts', '.tsx']
// Coverage floor: the scan is textual, so a pattern that stops matching still
// reports success. Anything below this means the scan broke (or the composer
// moved out of src/components/), not that the scripts got cleaner.
const MIN_MOUNTED = 20
const COMPONENT = String.raw`(?:lib\/types|src)\/components\/PromptInput\.js`
const COMPONENT_RE = new RegExp(String.raw`['"][^'"]*${COMPONENT}['"]`)
const FAKE_HOME_RE = /['"][^'"]*fake-home\.mjs['"]/
// Body owners: assignments in the module body, which ESM runs after the whole
// static import list has been evaluated. `os.homedir()` reads `USERPROFILE` on
// Windows and `HOME` elsewhere, so owning one name leaves the other platform
// writing into the real home; both are required. Line-anchored, so a
// commented-out line or a one-line string mention does not count.
const HOME_ASSIGNMENTS = [
  /\bprocess\.env\.HOME\s*=/m,
  /\bprocess\.env\.USERPROFILE\s*=/m,
]
// The dynamic form runs in the body too, so it owns HOME only when it precedes
// the composer import it guards.
const FAKE_HOME_IMPORT_CALL = /import\s*\(\s*['"][^'"]*fake-home\.mjs['"]\s*\)/

/**
 * Split a file into its static import statements, one entry per `import` line or
 * per multi-line `import { ... } from`. Returns `{ line, text }` with the 0-based
 * line the statement starts on. A bare `import './x.js'` is its own statement, so
 * walking statements never runs one import's `from` into the next one's path.
 */
function importStatements(source) {
  const lines = source.split('\n')
  const statements = []
  let buffer = null
  let start = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (buffer === null) {
      if (!/^[ \t]*import\s/.test(line)) continue
      buffer = line
      start = index
    } else {
      buffer += `\n${line}`
    }
    if (/\bfrom\s*['"]/.test(buffer) || /^[ \t]*import\s+['"]/.test(buffer)) {
      statements.push({ line: start, text: buffer })
      buffer = null
    }
  }
  return statements
}

const importsComposer = ({ text }) =>
  !/^[ \t]*import\s+type\b/.test(text) && COMPONENT_RE.test(text)

const ownsHomeByImport = ({ text }) => FAKE_HOME_RE.test(text)
// Any repository module can reach `src/utils/paths.ts`, so the fake home has to
// come before the first one. `import type` is erased and cannot pin a path.
const importsLocalModule = ({ text }) =>
  !/^[ \t]*import\s+type\b/.test(text) && /(?:from|import)\s*['"]\.\.?\//.test(text)
const importedFrom = ({ text }) => text.match(/['"]([^'"]+)['"]/)?.[1] ?? 'a local module'
const landsAfter = statement =>
  `imports ${importedFrom(statement)} before the fake home, which then lands too late to redirect that module's DATA_DIR`

const lineOf = (source, pattern) => {
  const at = source.search(pattern)
  return at < 0 ? -1 : source.slice(0, at).split('\n').length - 1
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return SUFFIXES.some(suffix => entry.name.endsWith(suffix)) ? [path] : []
  })
}

const mounted = []
const failures = []
for (const path of walk(SCRIPTS)) {
  const source = readFileSync(path, 'utf8')
  const statements = importStatements(source)
  const staticAt = statements.findIndex(importsComposer)
  const dynamicAt = lineOf(source, new RegExp(String.raw`import\s*\(\s*['"][^'"]*${COMPONENT}['"]`))
  if (staticAt < 0 && dynamicAt < 0) continue
  const name = relative(ROOT, path)
  mounted.push(name)

  // Static imports evaluate in source order, so a fake-home import wins only if
  // no earlier repository module already pinned a `DATA_DIR`-derived path.
  const ownerAt = statements.findIndex(ownsHomeByImport)
  const earlyLocal = statements.slice(0, Math.max(ownerAt, 0)).find(importsLocalModule)
  if (staticAt >= 0) {
    if (ownerAt >= 0 && ownerAt < staticAt) {
      if (earlyLocal === undefined) continue
      failures.push([name, landsAfter(earlyLocal)])
      continue
    }
    const lateBody = HOME_ASSIGNMENTS.some(pattern => lineOf(source, pattern) >= 0)
    failures.push([
      name,
      ownerAt >= 0
        ? 'takes over HOME only after the composer import'
        : lateBody
          ? 'sets HOME in the module body, which runs after the static composer import'
          : "relies on the machine's real HOME",
    ])
    continue
  }

  // Composer reached only through `import(...)` in the body: a body owner counts
  // when it runs first. A static owner is already evaluated by then. Both names
  // must be set, and the later of the two has to precede the composer import.
  const assignments = HOME_ASSIGNMENTS.map(pattern => lineOf(source, pattern))
  const importCallAt = lineOf(source, FAKE_HOME_IMPORT_CALL)
  const bodyAt = [...assignments, importCallAt].filter(at => at >= 0)
  const ownsBothNames = assignments.every(at => at >= 0)
  if (ownerAt >= 0 && earlyLocal !== undefined) {
    failures.push([name, landsAfter(earlyLocal)])
    continue
  }
  if (ownerAt >= 0 || ((ownsBothNames || importCallAt >= 0) && Math.max(...bodyAt) < dynamicAt))
    continue
  failures.push([
    name,
    bodyAt.length === 0
      ? "relies on the machine's real HOME"
      : ownsBothNames
        ? 'takes over HOME only after the composer import'
        : 'owns only one of HOME / USERPROFILE before the composer import',
  ])
}

// A green run over an empty set is the failure mode this gate exists to catch:
// a renamed directory or a broken pattern would otherwise pass silently.
if (mounted.length === 0) {
  console.error('FAIL: scanned 0 composer-mounting scripts — the scan is broken')
  process.exit(1)
}
if (mounted.length < MIN_MOUNTED) {
  console.error(
    `FAIL: only ${mounted.length} composer-mounting scripts found, expected at least ${MIN_MOUNTED} — the scan is broken`,
  )
  process.exit(1)
}

for (const [name, reason] of failures) {
  console.log(`FAIL: ${name} imports the composer module but ${reason}`)
  console.log("  add `import './lib/fake-home.mjs'` above every repository import —")
  console.log('  static imports evaluate in source order, so it has to come first')
}

console.log(
  failures.length === 0
    ? `verify-script-home-isolation OK (${mounted.length} scripts mount the composer, all isolated)`
    : `verify-script-home-isolation: ${failures.length}/${mounted.length} script(s) not isolated`,
)
process.exit(failures.length === 0 ? 0 : 1)
