import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
function files(dir, extensions) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(resolve(dir, entry.name), extensions)
    : extensions.some(extension => entry.name.endsWith(extension)) ? [resolve(dir, entry.name)] : [])
}

function imports(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const result = []
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      assert(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), `Computed imports are not permitted: ${path}`)
      result.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function violations(path, text) {
  const name = relative(root, path).replaceAll('\\', '/')
  return imports(path, text).flatMap(specifier => {
    if (specifier.startsWith('node:')) return []
    if (!specifier.startsWith('.')) return [`${name}: non-node dependency ${specifier}`]
    const target = relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/')
    if (!target.startsWith('cli/')) return [`${name}: CLI import escapes into ${target}`]
    if (name !== 'cli/entry.mjs' && !name.startsWith('cli/adapters/') && target.startsWith('cli/adapters/')) return [`${name}: neutral engine imports adapter`]
    return []
  })
}

test('CLI runtime is physically independent; only composition root binds the adapter', () => {
  const paths = files(resolve(root, 'cli'), ['.mjs']).filter(path => !relative(root, path).replaceAll('\\', '/').startsWith('cli/test/'))
  assert(paths.length > 5)
  for (const path of paths) assert.deepEqual(violations(path, readFileSync(path, 'utf8')), [])
  for (const path of files(resolve(root, 'src'), ['.ts', '.tsx'])) {
    const text = readFileSync(path, 'utf8')
    // No new reverse dependency, including relative/dynamic imports.
    assert(!/['"][^'"\r\n]*\/cli\//u.test(text), `TUI imports CLI: ${path}`)
  }
})

test('boundary checks reject mutated imports (including dynamic and type imports)', () => {
  const path = resolve(root, 'cli', 'engine.mjs')
  for (const source of ["import x from '../src/index.js'", "import type { X } from '@deepseek-ai/dsh-agent'", "await import('./adapters/dsh/index.mjs')", "require('../src/index.js')"]) assert(violations(path, source).length > 0)
  assert.throws(() => violations(path, 'await import(variable)'), /Computed/u)
})

test('launcher CLI route is lazy and does not render/bootstrap', () => {
  const text = readFileSync(resolve(root, 'bin/dsh-tui.js'), 'utf8')
  const block = text.slice(text.indexOf('// CLI is a separate'), text.indexOf('/**\n * The credential'))
  assert.match(block, /await import\(pathToFileURL\(entry\)\.href\)/u)
  assert(!/bootstrapProfile\(|startDshSession\(|startEntrySession\(/u.test(block))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert(manifest.files.includes('cli/*.mjs'))
  assert(manifest.files.includes('cli/adapters'))
})
