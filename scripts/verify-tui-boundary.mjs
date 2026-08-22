import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FORK_PACKAGE = '@deepseek-harness-tui/pi-tui'
const UPSTREAM_PACKAGE = '@earendil-works/pi-tui'
const FORK_VERSION = '0.84.2-dsh.0'
const UPSTREAM_REPOSITORY = 'https://github.com/earendil-works/pi'
const UPSTREAM_COMMIT = '086c32e74530564922d011ade23ff582c9d63116'
const UPSTREAM_VERSION = '0.84.2'

const CORE_FILES = [
  'src/index.ts',
  'src/dsh-adapter/index.ts',
  'src/dsh-adapter/plugin.ts',
  'src/tui/bootstrap.ts',
  'src/tui/public.ts',
  'src/tui/lifecycle.ts',
  'src/tui/screen-takeover.ts',
  'src/update.ts',
  'src/utils/externalEditor.ts',
]
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])

const failures = []

function displayPath(filename) {
  return relative(ROOT, filename).split(sep).join('/')
}

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length
}

function lineContaining(text, needle, start = 0) {
  const offset = text.indexOf(needle, start)
  return offset < 0 ? 1 : lineAt(text, offset)
}

function fail(filename, line, message) {
  const failure = { filename: displayPath(filename), line: Math.max(1, line), message }
  if (!failures.some(item => item.filename === failure.filename && item.line === failure.line && item.message === failure.message)) {
    failures.push(failure)
  }
}

function readSource(relativePath, required = true) {
  const filename = join(ROOT, relativePath)
  if (!existsSync(filename)) {
    if (required) fail(filename, 1, 'missing required file')
    return undefined
  }
  try {
    const text = readFileSync(filename, 'utf8')
    return { filename, relativePath, text }
  } catch (error) {
    fail(filename, 1, `cannot read file: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function walk(relativeDirectory) {
  const directory = join(ROOT, relativeDirectory)
  if (!existsSync(directory)) return []
  const result = []
  const visit = (current, currentRelative) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name)
      const relativePath = `${currentRelative}/${entry.name}`
      if (entry.isDirectory()) {
        visit(absolute, relativePath)
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
        result.push(relativePath)
      }
    }
  }
  visit(directory, relativeDirectory)
  return result
}

function extensionOf(filename) {
  const index = filename.lastIndexOf('.')
  return index < 0 ? '' : filename.slice(index).toLowerCase()
}

function uniquePaths(paths) {
  return [...new Set(paths)]
}

function sourceFiles(paths, required = false) {
  return uniquePaths(paths).map(path => readSource(path, required)).filter(Boolean)
}

function maskNonCode(text) {
  // Keep line lengths and newlines stable while removing comments and literals.
  // Boundary checks are intentionally lexical; they must not execute project code.
  const chars = text.split('')
  let state = 'code'
  let escaped = false

  const blank = index => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    const next = chars[i + 1]

    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'code'
      else blank(i)
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        blank(i)
        blank(i + 1)
        i++
        state = 'code'
      } else {
        blank(i)
      }
      continue
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (escaped) {
        escaped = false
        blank(i)
        continue
      }
      if (char === '\\') {
        escaped = true
        blank(i)
        continue
      }
      if (
        (state === 'single-quote' && char === "'") ||
        (state === 'double-quote' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        blank(i)
        state = 'code'
      } else {
        blank(i)
      }
      continue
    }

    if (char === '/' && next === '/') {
      blank(i)
      blank(i + 1)
      i++
      state = 'line-comment'
    } else if (char === '/' && next === '*') {
      blank(i)
      blank(i + 1)
      i++
      state = 'block-comment'
    } else if (char === "'") {
      blank(i)
      state = 'single-quote'
      escaped = false
    } else if (char === '"') {
      blank(i)
      state = 'double-quote'
      escaped = false
    } else if (char === '`') {
      blank(i)
      state = 'template'
      escaped = false
    }
  }

  return chars.join('')
}

function maskComments(text) {
  const chars = text.split('')
  let state = 'code'
  let escaped = false

  const blank = index => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    const next = chars[i + 1]
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'code'
      else blank(i)
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        blank(i)
        blank(i + 1)
        i++
        state = 'code'
      } else {
        blank(i)
      }
      continue
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (
        (state === 'single-quote' && char === "'") ||
        (state === 'double-quote' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code'
      }
      continue
    }
    if (char === '/' && next === '/') {
      blank(i)
      blank(i + 1)
      i++
      state = 'line-comment'
    } else if (char === '/' && next === '*') {
      blank(i)
      blank(i + 1)
      i++
      state = 'block-comment'
    } else if (char === "'") {
      state = 'single-quote'
      escaped = false
    } else if (char === '"') {
      state = 'double-quote'
      escaped = false
    } else if (char === '`') {
      state = 'template'
      escaped = false
    }
  }
  return chars.join('')
}

function importSpecifiers(text) {
  const result = []
  const patterns = [
    /\b(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ]
  const code = maskComments(text)
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      result.push({ specifier: match[1], offset: match.index ?? 0 })
    }
  }
  return result.sort((a, b) => a.offset - b.offset)
}

function legacyImportKind(specifier) {
  const normalized = specifier.replaceAll('\\', '/')
  if (/(^|\/)(?:react|react-dom|react-reconciler)(?:\/|$)/i.test(normalized) || /force-production-react/i.test(normalized)) return 'React'
  if (/(^|\/)ink(?:\/|$)/i.test(normalized)) return 'Ink'
  if (/(^|\/)(?:yoga|yoga-layout)(?:\/|$)/i.test(normalized)) return 'Yoga'
  if (/(^|\/)native-ts\/yoga-layout(?:\/|$)/i.test(normalized)) return 'Yoga'
  if (/(^|\/)ui(?:\.[^/]+)?$/i.test(normalized)) return 'the old src/ui facade'
  if (/(^|\/)(?:renderer|renderers|render-to-screen|log-update)(?:\.[^/]+)?$/i.test(normalized)) {
    return 'the old renderer'
  }
  return undefined
}

function isForkSpecifier(specifier) {
  return specifier.includes(FORK_PACKAGE)
}

function isUpstreamSpecifier(specifier) {
  return specifier.includes(UPSTREAM_PACKAGE)
}

function scanLegacyImports(files) {
  for (const source of files) {
    for (const { specifier, offset } of importSpecifiers(source.text)) {
      const kind = legacyImportKind(specifier)
      if (kind !== undefined) {
        fail(source.filename, lineAt(source.text, offset), `forbidden ${kind} import: ${specifier}`)
      }
    }
  }
}

function scanPiImports(files) {
  let facadeForkImportCount = 0
  const facade = files.find(source => source.relativePath === 'src/tui/public.ts')

  for (const source of files) {
    for (const { specifier, offset } of importSpecifiers(source.text)) {
      if (isUpstreamSpecifier(specifier)) {
        fail(source.filename, lineAt(source.text, offset), `forbidden upstream pi-tui import: ${specifier}`)
        continue
      }
      if (!isForkSpecifier(specifier)) continue
      if (source.relativePath !== 'src/tui/public.ts') {
        fail(source.filename, lineAt(source.text, offset), `pi-tui import must go through src/tui/public.ts: ${specifier}`)
      } else if (specifier !== FORK_PACKAGE) {
        fail(source.filename, lineAt(source.text, offset), `facade must import the fork package root, not a private path: ${specifier}`)
      } else {
        facadeForkImportCount++
      }
    }
  }

  if (facade === undefined) return
  if (facadeForkImportCount === 0) {
    fail(facade.filename, 1, `src/tui/public.ts must point to ${FORK_PACKAGE}`)
  }
}

function scanStdoutWrites(files) {
  const writePatterns = [
    /(?:\b[\w$]+\s*\.\s*)*\bstdout\s*(?:\?\.\s*)?\.\s*write\s*\(/g,
    /\bprocess\s*\[\s*['"]stdout['"]\s*\]\s*\.\s*write\s*\(/g,
    /\b\w*(?:write|print|output)\w*\s*\(\s*process\s*\.\s*stdout\b/g,
  ]
  const allowed = relativePath => relativePath === 'bin/dsh-tui.js'

  for (const source of files) {
    if (allowed(source.relativePath)) continue
    const code = maskNonCode(source.text)
    const matches = []
    for (const pattern of writePatterns) {
      for (const match of code.matchAll(pattern)) matches.push(match.index ?? 0)
    }

    const aliases = []
    const aliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\s*\.\s*stdout\b/g
    for (const match of code.matchAll(aliasPattern)) aliases.push(match[1])
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`\\b${escaped}\\s*(?:\\?\\.\\s*)?\\.\\s*write\\s*\\(`, 'g')
      for (const match of code.matchAll(pattern)) matches.push(match.index ?? 0)
    }

    for (const offset of [...new Set(matches)].sort((a, b) => a - b)) {
      fail(source.filename, lineAt(source.text, offset), 'direct stdout write is outside the TUI terminal owner')
    }
  }
}

function scanFallbacks(files) {
  const fallbackPatterns = [
    /\bReact(?:DOM)?\s*\.\s*(?:render|renderSync|createRoot)\s*\(/g,
    /\b(?:createRoot|renderSync)\s*\(/g,
    /\brender\s*\(\s*(?:tree|React\s*\.|createElement)\b/g,
  ]
  for (const source of files) {
    const code = maskNonCode(source.text)
    for (const pattern of fallbackPatterns) {
      for (const match of code.matchAll(pattern)) {
        fail(source.filename, lineAt(source.text, match.index ?? 0), 'React render/createRoot fallback is forbidden')
      }
    }
  }
}

function scanOwners(files) {
  const creationPattern = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g
  const duplicateRendererPattern = /\b(?:createRenderer|renderToScreen)\s*\(/g

  const allowedCreation = (source, name, offset) => {
    const lineEnd = source.text.indexOf('\n', offset)
    const line = source.text.slice(source.text.lastIndexOf('\n', offset) + 1, lineEnd < 0 ? source.text.length : lineEnd)
    if (source.relativePath === 'src/tui/bootstrap.ts') {
      return (
        (name === 'ProcessTerminal' && /new\s+ProcessTerminal\s*\(\s*\)/.test(line)) ||
        (name === 'TuiAltScreen' && /new\s+TuiAltScreen\s*\(\s*terminal\b/.test(line)) ||
        (name === 'TuiMainScreen' && /new\s+TuiMainScreen\s*\(\s*terminal\b/.test(line))
      )
    }
    if (source.relativePath === 'src/tui/lifecycle.ts' && name === 'TuiMainScreen') {
      return /new\s+TuiMainScreen\s*\(\s*(?:ui\s*\.\s*)?terminal\b/.test(line)
    }
    return false
  }

  const allowedCounts = new Map([
    ['src/tui/bootstrap.ts:ProcessTerminal', 1],
    ['src/tui/bootstrap.ts:TuiAltScreen', 1],
    ['src/tui/bootstrap.ts:TuiMainScreen', 1],
    ['src/tui/lifecycle.ts:TuiMainScreen', 1],
  ])

  for (const source of files) {
    const code = maskNonCode(source.text)
    for (const match of code.matchAll(creationPattern)) {
      const name = match[1]
      if (!/^(?:TUI|Tui(?:MainScreen|AltScreen)|ProcessTerminal|Terminal|Ink|Renderer|TerminalRenderer)$/.test(name)) continue
      const key = `${source.relativePath}:${name}`
      const remaining = allowedCounts.get(key) ?? 0
      if (remaining > 0 && allowedCreation(source, name, match.index ?? 0)) {
        allowedCounts.set(key, remaining - 1)
      } else {
        fail(source.filename, lineAt(source.text, match.index ?? 0), `additional TUI/Terminal/renderer creation is forbidden: new ${name}()`)
      }
    }
    for (const match of code.matchAll(duplicateRendererPattern)) {
      fail(source.filename, lineAt(source.text, match.index ?? 0), 'additional renderer creation or fallback is forbidden')
    }
  }
}

function parseJson(relativePath) {
  const source = readSource(relativePath)
  if (source === undefined) return undefined
  try {
    return { source, value: JSON.parse(source.text) }
  } catch (error) {
    fail(source.filename, 1, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function keyLine(source, key, fallback = 1) {
  return lineContaining(source.text, `"${key}"` , 0) || fallback
}

function checkEqual(source, path, actual, expected) {
  if (actual === expected) return
  const key = path.split('.').at(-1)
  fail(source.filename, keyLine(source, key), `${path} must be ${JSON.stringify(expected)} (found ${JSON.stringify(actual)})`)
}

function checkForkPackage() {
  const parsed = parseJson('packages/pi-tui/package.json')
  if (parsed === undefined || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return
  const source = parsed.source
  const value = parsed.value
  const repository = value.repository
  const upstream = value.dsh?.upstream

  checkEqual(source, 'name', value.name, FORK_PACKAGE)
  checkEqual(source, 'version', value.version, FORK_VERSION)
  checkEqual(source, 'private', value.private, true)
  checkEqual(source, 'repository.url', repository?.url, 'git+https://github.com/earendil-works/pi.git')
  checkEqual(source, 'repository.directory', repository?.directory, 'packages/tui')
  checkEqual(source, 'dsh.upstream.repository', upstream?.repository, UPSTREAM_REPOSITORY)
  checkEqual(source, 'dsh.upstream.commit', upstream?.commit, UPSTREAM_COMMIT)
  checkEqual(source, 'dsh.upstream.version', upstream?.version, UPSTREAM_VERSION)
}

function checkWorkspaceWiring() {
  const root = parseJson('package.json')
  if (root !== undefined && root.value !== null && typeof root.value === 'object' && !Array.isArray(root.value)) {
    const dependencies = root.value.dependencies
    checkEqual(root.source, `dependencies.${FORK_PACKAGE}`, dependencies?.[FORK_PACKAGE], 'workspace:*')
    if (dependencies?.[UPSTREAM_PACKAGE] !== undefined) {
      fail(root.source.filename, keyLine(root.source, UPSTREAM_PACKAGE), `runtime dependency on ${UPSTREAM_PACKAGE} is forbidden`)
    }
  }

  const lock = readSource('pnpm-lock.yaml')
  if (lock === undefined) return
  const forkLine = lineContaining(lock.text, `'${FORK_PACKAGE}'`)
  const importerPattern = new RegExp(
    `^      '${escapeRegExp(FORK_PACKAGE)}':\\n        specifier: workspace:\\\*\\n        version: link:packages/pi-tui$`,
    'm',
  )
  if (!importerPattern.test(lock.text)) {
    fail(lock.filename, forkLine, `root lockfile importer must pin ${FORK_PACKAGE} to workspace:* -> link:packages/pi-tui`)
  }
  if (lock.text.includes(UPSTREAM_PACKAGE)) {
    fail(lock.filename, lineContaining(lock.text, UPSTREAM_PACKAGE), `lockfile must not contain runtime package ${UPSTREAM_PACKAGE}`)
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const tuiPaths = walk('src/tui')
const boundaryPaths = uniquePaths([...CORE_FILES, ...tuiPaths])
const boundarySources = sourceFiles(boundaryPaths, true)
const stdoutSources = sourceFiles(uniquePaths([...boundaryPaths, 'bin/dsh-tui.js']), true)
scanLegacyImports(boundarySources)
scanPiImports(boundarySources)
scanStdoutWrites(stdoutSources)
scanFallbacks(boundarySources)
scanOwners(boundarySources)
checkForkPackage()
checkWorkspaceWiring()

failures.sort((a, b) => a.filename.localeCompare(b.filename) || a.line - b.line || a.message.localeCompare(b.message))
if (failures.length > 0) {
  for (const failure of failures) console.error(`${failure.filename}:${failure.line}: ${failure.message}`)
  console.error(`TUI boundary verification failed: ${failures.length} violation(s)`)
  process.exitCode = 1
} else {
  console.error('TUI boundary verification passed')
}
