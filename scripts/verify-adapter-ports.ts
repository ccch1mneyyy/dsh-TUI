/**
 * Static gate for the TUI Host Ports boundary.
 *
 * Uses the TypeScript compiler AST (not plain string matching) to enforce:
 * - ports/ has no imports from @deepseek-ai, @dsh-std, dsh-ecosystem-spec, or
 *   outside the ports directory;
 * - no Host Port method accepts caller-supplied owner/principal/activation
 *   identity;
 * - no Host Port method exposes admission, ledger write, permission lookup,
 *   negotiation or protocol-descriptor semantics.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-ports.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const PORTS = join(ROOT, 'src', 'adapter', 'ports')
const KERNEL = join(ROOT, 'src', 'adapter', 'kernel')

const FORBIDDEN_MEMBER_NAMES = new Set([
  'admit',
  'record',
  'allows',
  'knownPermissions',
  'defaultOf',
  'protocolDescriptor',
  'negotiate',
  'permission',
  'permissions',
  'principal',
  'activationId',
  'owner',
  'manifest',
  'apiVersion',
  'kind',
])

const FORBIDDEN_PARAMETER_NAMES = new Set([
  'owner',
  'principal',
  'activationId',
  'caller',
  'permission',
  'permissions',
])

const FORBIDDEN_MODULE_PREFIXES = [
  '@deepseek-ai/',
  '@dsh-std/',
  '#dsh-ecosystem-spec',
  'dsh-ecosystem-spec/',
]

function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...collectFiles(path))
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

function isMethodLike(member: ts.TypeElement): boolean {
  if (ts.isMethodSignature(member)) return true
  if (ts.isPropertySignature(member)) {
    const type = member.type
    if (type && (ts.isFunctionTypeNode(type) || ts.isTypeLiteralNode(type))) return true
    // A property holding a function type reference is still a capability method.
    const text = type ? type.getText() : ''
    return /=>|Function|Port/u.test(text)
  }
  return false
}

function memberName(member: ts.TypeElement): string | undefined {
  if (ts.isMethodSignature(member) || ts.isPropertySignature(member)) {
    const name = member.name
    return ts.isIdentifier(name) ? name.text : undefined
  }
  return undefined
}

/** Extract parameters from a method-like declaration, including property
 * signatures whose value is a function type or a callable type literal. */
function parametersOf(member: ts.TypeElement): readonly ts.ParameterDeclaration[] {
  if (ts.isMethodSignature(member)) return member.parameters
  if (!ts.isPropertySignature(member) || member.type === undefined) return []
  if (ts.isFunctionTypeNode(member.type)) return member.type.parameters
  if (ts.isTypeLiteralNode(member.type)) {
    const parameters: ts.ParameterDeclaration[] = []
    for (const child of member.type.members) {
      if (ts.isCallSignatureDeclaration(child) || ts.isConstructSignatureDeclaration(child)) {
        parameters.push(...child.parameters)
      }
    }
    return parameters
  }
  return []
}

const failures: string[] = []

for (const file of collectFiles(PORTS)) {
  const sourceText = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const rel = relative(ROOT, file)

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
      if (ts.isStringLiteral(specifier)) {
        const value = specifier.text
        if (FORBIDDEN_MODULE_PREFIXES.some(prefix => value.startsWith(prefix))) {
          failures.push(`${rel}: forbidden import ${value}`)
        }
        if (value.startsWith('..')) {
          failures.push(`${rel}: ports must not import outside the ports directory (${value})`)
        }
      }
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
      if (specifier && ts.isStringLiteral(specifier)) {
        const value = specifier.text
        if (FORBIDDEN_MODULE_PREFIXES.some(prefix => value.startsWith(prefix))) {
          failures.push(`${rel}: forbidden re-export ${value}`)
        }
        if (value.startsWith('..')) {
          failures.push(`${rel}: ports must not re-export outside the ports directory (${value})`)
        }
      }
    }
  }

  // Skip owner.ts: HostOwnerRef is a Kernel-owned data type, not a capability
  // method. The rule is that callers cannot PASS such data into Port methods.
  if (basename(file) === 'owner.ts') continue

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (!isMethodLike(member)) continue
        const name = memberName(member)
        if (name && FORBIDDEN_MEMBER_NAMES.has(name)) {
          failures.push(`${rel}: Host Port method "${name}" carries host/protocol/permission semantics`)
        }
        for (const parameter of parametersOf(member)) {
          if (ts.isIdentifier(parameter.name) && FORBIDDEN_PARAMETER_NAMES.has(parameter.name.text)) {
            failures.push(`${rel}: Host Port method "${name}" accepts caller-supplied ${parameter.name.text}`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}


// Kernel-owned internal interfaces must also refuse caller-supplied
// owner/principal/activationId parameters. We do not forbid internal method
// names (kernel ledger write is intentionally not a Host Port), only identity
// injection parameters that could forge an owner.
for (const file of collectFiles(KERNEL)) {
  const sourceText = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const rel = relative(ROOT, file)
  function visitKernel(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (!isMethodLike(member)) continue
        const name = memberName(member)
        for (const parameter of parametersOf(member)) {
          if (ts.isIdentifier(parameter.name) && FORBIDDEN_PARAMETER_NAMES.has(parameter.name.text)) {
            failures.push(`${rel}: Kernel interface "${name}" accepts caller-supplied ${parameter.name.text}`)
          }
        }
      }
    }
    ts.forEachChild(node, visitKernel)
  }
  visitKernel(sourceFile)
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}

if (failures.length > 0) {
  console.error('verify:adapter-ports FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify:adapter-ports OK (${collectFiles(PORTS).length} port files + ${collectFiles(KERNEL).length} kernel files, AST checked)`)
