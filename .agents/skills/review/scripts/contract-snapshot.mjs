#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'

const SCHEMA_VERSION = 1

const CONTRACT_FILES = [
  'package.json',
  'AGENTS.md',
  'ADAPTER.md',
  'docs/contributing.md',
  'src/dsh-adapter/contract.ts',
  'src/plugin-host.ts',
  'cordis.patch.yml',
  'patch-surface.snapshot.json',
  'dsh-ecosystem-spec/protocols/tui-channel.js',
  '.github/workflows/ci.yml',
]

const SUBMODULE_PATHS = [
  'dsh-auth',
  'dsh-ecosystem-spec',
  'vendor/dsh-std',
]

function fail(message, code = 2) {
  console.error(`contract-snapshot: ${message}`)
  process.exit(code)
}

function git(repo, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    if (allowFailure) return null
    const stderr = error?.stderr?.toString?.().trim()
    throw new Error(stderr || error.message)
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stable(value[key])]),
    )
  }
  return value
}

function readAtRevision(repo, revision, path) {
  if (revision === 'WORKTREE') {
    try {
      return readFileSync(join(repo, path), 'utf8')
    } catch {
      return null
    }
  }

  if (revision === 'INDEX') {
    return git(repo, ['show', `:${path}`], { allowFailure: true })
  }

  return git(repo, ['show', `${revision}:${path}`], { allowFailure: true })
}

function resolvedRevision(repo, revision) {
  if (revision === 'WORKTREE') {
    const head = git(repo, ['rev-parse', 'HEAD'], { allowFailure: true })?.trim()
    return head ? `WORKTREE@${head}` : 'WORKTREE'
  }
  if (revision === 'INDEX') {
    const head = git(repo, ['rev-parse', 'HEAD'], { allowFailure: true })?.trim()
    return head ? `INDEX@${head}` : 'INDEX'
  }
  return git(repo, ['rev-parse', revision]).trim()
}

function parsePackage(text) {
  if (text == null) return { present: false }
  try {
    const pkg = JSON.parse(text)
    return stable({
      present: true,
      name: pkg.name ?? null,
      version: pkg.version ?? null,
      packageManager: pkg.packageManager ?? null,
      engines: pkg.engines ?? {},
      imports: pkg.imports ?? {},
      bin: pkg.bin ?? {},
      exports: pkg.exports ?? {},
      dependencies: pkg.dependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
      peerDependenciesMeta: pkg.peerDependenciesMeta ?? {},
      devDependencies: pkg.devDependencies ?? {},
      scripts: pkg.scripts ?? {},
      files: pkg.files ?? [],
    })
  } catch (error) {
    return {
      present: true,
      parseError: error.message,
      sha256: sha256(text),
    }
  }
}

function normalizeStatement(statement) {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractExportStatements(text) {
  if (!text) return []
  const statements = []

  const reExports = /(^|\n)\s*export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"][^'"]+['"]\s*;?/g
  for (const match of text.matchAll(reExports)) {
    statements.push(normalizeStatement(match[0]))
  }

  const exportAll = /(^|\n)\s*export\s+\*\s+from\s+['"][^'"]+['"]\s*;?/g
  for (const match of text.matchAll(exportAll)) {
    statements.push(normalizeStatement(match[0]))
  }

  const declarations = /(^|\n)\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g
  for (const match of text.matchAll(declarations)) {
    statements.push(`export declaration ${match[2]}`)
  }

  return [...new Set(statements)].sort()
}

function extractQuotedList(text, symbol) {
  if (!text) return []
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}\\s*=\\s*(?:Object\\.freeze\\s*\\()?\\s*\\[([\\s\\S]*?)\\]`, 'm')
  const match = text.match(pattern)
  if (!match) return []
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]).sort()
}

function extractProtocol(text) {
  if (!text) return { present: false }
  const apiVersion =
    text.match(/TUI_CHANNEL_API_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ??
    text.match(/apiVersion\s*:\s*['"]([^'"]+)['"]/)?.[1] ??
    null
  const wireRevisionRaw = text.match(/TUI_CHANNEL_WIRE_REVISION\s*=\s*(\d+)/)?.[1]
  const features = extractQuotedList(text, 'TUI_CHANNEL_FEATURES')
  return {
    present: true,
    apiVersion,
    wireRevision: wireRevisionRaw == null ? null : Number(wireRevisionRaw),
    features,
  }
}

function readSubmodulePointers(repo, revision) {
  if (revision === 'WORKTREE' || revision === 'INDEX') {
    const treeish = revision === 'INDEX' ? '--cached' : 'HEAD'
    const args = treeish === '--cached' ? ['ls-files', '--stage', '--', ...SUBMODULE_PATHS] : ['ls-tree', treeish, '--', ...SUBMODULE_PATHS]
    const output = git(repo, args, { allowFailure: true }) ?? ''
    return parseSubmoduleOutput(output)
  }

  const output = git(repo, ['ls-tree', revision, '--', ...SUBMODULE_PATHS], { allowFailure: true }) ?? ''
  return parseSubmoduleOutput(output)
}

function parseSubmoduleOutput(output) {
  const result = {}
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^160000\s+(?:commit\s+)?([0-9a-f]{40})\s+\d?\s*\t?(.+)$/)
    if (match) result[match[2]] = match[1]
  }
  return stable(result)
}

function buildSnapshot(repoInput, revisionInput) {
  const repo = resolve(repoInput)
  const revision = revisionInput || 'HEAD'
  const resolved = resolvedRevision(repo, revision)
  const contents = Object.fromEntries(
    CONTRACT_FILES.map(path => [path, readAtRevision(repo, revision, path)]),
  )

  const files = stable(Object.fromEntries(
    CONTRACT_FILES.map(path => {
      const text = contents[path]
      return [path, text == null
        ? { present: false }
        : { present: true, bytes: Buffer.byteLength(text), sha256: sha256(text) }]
    }),
  ))

  return stable({
    schemaVersion: SCHEMA_VERSION,
    repository: basename(repo),
    requestedRevision: revision,
    resolvedRevision: resolved,
    package: parsePackage(contents['package.json']),
    pluginHost: {
      present: contents['src/plugin-host.ts'] != null,
      exportStatements: extractExportStatements(contents['src/plugin-host.ts']),
    },
    protocol: extractProtocol(contents['dsh-ecosystem-spec/protocols/tui-channel.js']),
    submodules: readSubmodulePointers(repo, revision),
    files,
  })
}

function comparable(snapshot) {
  const {
    requestedRevision: _requestedRevision,
    resolvedRevision: _resolvedRevision,
    repository: _repository,
    ...rest
  } = snapshot
  return rest
}

function jsonPointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

function diffValues(base, head, path = '') {
  if (Object.is(base, head)) return []

  const baseIsObject = base && typeof base === 'object'
  const headIsObject = head && typeof head === 'object'
  const bothPlainObjects = baseIsObject && headIsObject && !Array.isArray(base) && !Array.isArray(head)

  if (bothPlainObjects) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()
    return keys.flatMap(key => diffValues(
      base[key],
      head[key],
      `${path}/${jsonPointerToken(key)}`,
    ))
  }

  if (Array.isArray(base) && Array.isArray(head)) {
    if (JSON.stringify(base) === JSON.stringify(head)) return []
    return [{ path: path || '/', base, head }]
  }

  return [{ path: path || '/', base: base ?? null, head: head ?? null }]
}

function compareSnapshots(baseSnapshot, headSnapshot) {
  return {
    schemaVersion: SCHEMA_VERSION,
    baseRevision: baseSnapshot.resolvedRevision,
    headRevision: headSnapshot.resolvedRevision,
    differences: diffValues(comparable(baseSnapshot), comparable(headSnapshot)),
    base: baseSnapshot,
    head: headSnapshot,
  }
}

function writeFixture(root, version, exportTarget, wireRevision) {
  const files = {
    'package.json': JSON.stringify({
      name: 'fixture',
      version,
      packageManager: 'pnpm@11.0.0',
      exports: { '.': { import: exportTarget, types: './lib/index.d.ts' } },
      bin: { fixture: './bin.js' },
      peerDependencies: { '@deepseek-ai/example': '^1.0.0' },
      devDependencies: { '@deepseek-ai/example': '^1.0.0' },
      scripts: { build: 'echo build' },
    }, null, 2),
    'AGENTS.md': '# fixture\n',
    'ADAPTER.md': '# adapter\n',
    'docs/contributing.md': '# contributing\n',
    'src/dsh-adapter/contract.ts': `export const VERSION = '${version}'\n`,
    'src/plugin-host.ts': "export { alpha, beta } from './impl.js'\nexport type { Gamma } from './types.js'\n",
    'cordis.patch.yml': 'version: 1\n',
    'patch-surface.snapshot.json': '{"version":1}\n',
    'dsh-ecosystem-spec/protocols/tui-channel.js': `export const TUI_CHANNEL_API_VERSION = 'tui.dsh/v1alpha1'\nexport const TUI_CHANNEL_WIRE_REVISION = ${wireRevision}\nexport const TUI_CHANNEL_FEATURES = ['commands', 'skills']\n`,
    '.github/workflows/ci.yml': 'name: ci\n',
  }
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'contract snapshot-'))
  try {
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'fixture@example.invalid'])
    git(root, ['config', 'user.name', 'Fixture'])

    writeFixture(root, '1.0.0', './lib/index.js', 1)
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'base'])
    const base = git(root, ['rev-parse', 'HEAD']).trim()

    writeFixture(root, '1.1.0', './lib/index-v2.js', 2)
    writeFileSync(join(root, 'src/plugin-host.ts'), "export { alpha, beta, delta } from './impl.js'\n")
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'head'])
    const head = git(root, ['rev-parse', 'HEAD']).trim()

    const result = compareSnapshots(buildSnapshot(root, base), buildSnapshot(root, head))
    const paths = result.differences.map(item => item.path)
    const expected = [
      '/package/version',
      '/package/exports/./import',
      '/protocol/wireRevision',
      '/pluginHost/exportStatements',
    ]
    for (const path of expected) {
      if (!paths.includes(path)) throw new Error(`missing expected diff: ${path}`)
    }

    writeFixture(root, '1.2.0', './lib/index-v3.js', 3)
    const worktree = buildSnapshot(root, 'WORKTREE')
    if (worktree.package.version !== '1.2.0') throw new Error('WORKTREE snapshot did not read filesystem')

    git(root, ['add', 'package.json'])
    const index = buildSnapshot(root, 'INDEX')
    if (index.package.version !== '1.2.0') throw new Error('INDEX snapshot did not read staged content')

    console.log(`contract-snapshot self-test: OK (${result.differences.length} differences)`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const args = { repo: '.', revision: 'HEAD', compare: null, selfTest: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') args.repo = argv[++i]
    else if (arg === '--rev') args.revision = argv[++i]
    else if (arg === '--compare') args.compare = [argv[++i], argv[++i]]
    else if (arg === '--self-test') args.selfTest = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  node contract-snapshot.mjs --repo <path> --rev <revision|WORKTREE|INDEX>
  node contract-snapshot.mjs --repo <path> --compare <base> <head>
  node contract-snapshot.mjs --self-test

The output is evidence for review, not an automatic compatibility verdict.`)
      process.exit(0)
    } else fail(`unknown argument: ${arg}`)
  }
  if (!args.repo) fail('--repo requires a path')
  if (args.compare?.some(value => !value)) fail('--compare requires two revisions')
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) return selfTest()

  try {
    const output = args.compare
      ? compareSnapshots(
          buildSnapshot(args.repo, args.compare[0]),
          buildSnapshot(args.repo, args.compare[1]),
        )
      : buildSnapshot(args.repo, args.revision)
    console.log(JSON.stringify(output, null, 2))
  } catch (error) {
    fail(error.message, 1)
  }
}

main()
