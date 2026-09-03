/**
 * Shadow-mode HostFacade gate.
 *
 * Verifies:
 * - HostFacade is a read-only composition entry (no admission/grants/ledger).
 * - Every publicly callable method on the Cordis service classes in
 *   `src/dsh-adapter` has either a production shadow-policy guard or an
 *   explicitly documented exemption. The method set is enumerated from the
 *   TypeScript AST, so a newly added method without a policy entry fails.
 * - The known platform boundary paths that the TUI cannot mediate
 *   (direct `ctx.get('commands')`, Cordis sub-plugin install, agent preset,
 *   system prompt section, skill registry) are explicitly listed and are not
 *   claimed as fully covered by the shadow gate.
 * - The raw `ctx.on` DecisionEvents path is mediated through the same guard.
 *
 * Guard-position invariant: an effectful adapter method must call its
 * capability guard before any side effect. This gate checks that service
 * methods and returned handles contain the guard call; code review must keep
 * it as the first preflight step in new methods (see the comment on
 * `assertCapabilityShadowPolicy` in src/adapter/kernel/runtime.ts).
 *
 * Verification style:
 * - AST: service-method enumeration, direct shadow guard calls, returned
 *   handle guards, KernelLedger.record routing, extra capability guards, and
 *   the production integration call-site claims below.
 * - Finite heuristic (explicitly listed, not claimed as full AST): a small
 *   set of string-literal integration assertions where the production shape is
 *   a not-yet-AST-modeled provider/literal check (grant store `.allows` use and
 *   driver evidence id literals). Everything else in this gate is AST-backed.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-shadow.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { createHostFacade, createShadowGuardedHostFacade, type HostFacade } from '../src/adapter/kernel/host-facade.js'
import { facadeFromLegacy } from '../src/adapter/kernel/legacy-facade.js'
import { buildHostDescriptor } from '../src/adapter/standard/descriptor.js'
import {
  ADAPTER_CAPABILITY_EFFECT_CLASSES,
} from '../src/adapter/kernel/runtime.js'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = resolve(ROOT, 'src')

const build = buildHostDescriptor({ generationId: 'shadow-battery' })

const services = {
  generationId: 'shadow-battery',
  describe: () => build,
}

let checks = 0
const ok = (name: string, fn: () => void) => {
  checks += 1
  try {
    fn()
  } catch (error) {
    console.error(`verify:adapter-shadow FAILED: ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// ── HostFacade runtime shape ───────────────────────────────────────────────
ok('HostFacade exposes only read-only descriptor', () => {
  const facade = facadeFromLegacy(services)
  assert.deepEqual(Object.keys(facade).sort(), ['descriptor'])
  assert.equal('admission' in facade, false)
  assert.equal('grants' in facade, false)
  assert.equal('ledger' in facade, false)
  assert.equal(facade.descriptor.generationId, 'shadow-battery')
  const snapshot = facade.descriptor.snapshot()
  assert.equal(snapshot.generationId, 'shadow-battery')
})

ok('createHostFacade is a thin read-only composition', () => {
  const facade: HostFacade = createHostFacade({
    descriptor: facadeFromLegacy(services).descriptor,
  })
  assert.deepEqual(Object.keys(facade).sort(), ['descriptor'])
})

ok('shadow-guarded facade still exposes only descriptor and allows read-only', () => {
  for (const mode of ['legacy', 'passive-shadow', 'replay-shadow', 'new'] as const) {
    const base = facadeFromLegacy(services)
    const guarded = createShadowGuardedHostFacade({ descriptor: base.descriptor }, mode)
    assert.deepEqual(Object.keys(guarded).sort(), ['descriptor'])
    assert.equal(guarded.descriptor.snapshot().generationId, 'shadow-battery')
  }
})

// ── Service-method policy registry ─────────────────────────────────────────
type MethodPolicy =
  | { kind: 'capability'; capability: string; guard?: 'direct' | 'kernel' }
  | { kind: 'exempt'; reason: string }

const METHOD_POLICY: Record<string, Record<string, MethodPolicy>> = {
  TuiPluginHostRuntime: {
    generationId: { kind: 'exempt', reason: 'read-only scalar accessor; no effect' },
    grants: { kind: 'exempt', reason: 'read-only facade accessor; underlying grant evaluation is guarded in GrantStore' },
    probeDecisionEvents: { kind: 'capability', capability: 'host.decision.probe' },
    hostDescriptor: { kind: 'capability', capability: 'host.descriptor' },
    describe: { kind: 'capability', capability: 'host.descriptor' },
    admit: { kind: 'exempt', reason: 'host-owned denial stub; always throws before producing an effect' },
    admitInternal: { kind: 'capability', capability: 'host.admission' },
    subscribeDecision: { kind: 'capability', capability: 'host.decision.subscribe' },
    registerCommand: { kind: 'capability', capability: 'host.commands.register' },
    startKernelRuntime: { kind: 'exempt', reason: 'internal host lifecycle entry; not part of the public plugin capability surface' },
    selfCheck: { kind: 'capability', capability: 'host.diagnostics' },
  },
  TuiPluginStorageRuntime: {
    probeDiagnostic: { kind: 'capability', capability: 'host.storage.probe' },
    open: { kind: 'capability', capability: 'host.storage.open' },
  },
  TuiMessageObserverRuntime: {
    probeDiagnostic: { kind: 'capability', capability: 'host.messages.probe' },
    subscribe: { kind: 'capability', capability: 'host.messages.subscribe' },
  },
  TuiDialogRuntime: {
    select: { kind: 'capability', capability: 'host.dialogs.select' },
    confirm: { kind: 'capability', capability: 'host.dialogs.confirm' },
    input: { kind: 'capability', capability: 'host.dialogs.input' },
  },
  TuiSceneRuntime: {
    register: { kind: 'capability', capability: 'host.scenes.register' },
    open: { kind: 'capability', capability: 'host.scenes.open' },
    close: { kind: 'capability', capability: 'host.scenes.close' },
    active: { kind: 'capability', capability: 'host.scenes.active' },
    subscribe: { kind: 'capability', capability: 'host.scenes.subscribe' },
  },
  TuiSettingsSectionsRuntime: {
    register: { kind: 'capability', capability: 'host.settings.register' },
    list: { kind: 'capability', capability: 'host.settings.list' },
    section: { kind: 'capability', capability: 'host.settings.section' },
    subscribe: { kind: 'capability', capability: 'host.settings.subscribe' },
  },
  TuiStatusRuntime: {
    set: { kind: 'capability', capability: 'host.status.set' },
    subscribe: { kind: 'capability', capability: 'host.status.subscribe' },
  },
  TuiRendererRuntime: {
    register: { kind: 'capability', capability: 'host.renderers.register' },
  },
  TuiShortcutRuntime: {
    register: { kind: 'capability', capability: 'host.shortcuts.register' },
    list: { kind: 'capability', capability: 'host.shortcuts.list' },
  },
  TuiThemeRuntime: {
    register: { kind: 'capability', capability: 'host.themes.register' },
  },
  TuiWorkspaceRuntime: {
    register: { kind: 'capability', capability: 'host.workspaces.register' },
    list: { kind: 'capability', capability: 'host.workspaces.list' },
    resolve: { kind: 'capability', capability: 'host.workspaces.resolve' },
    describe: { kind: 'capability', capability: 'host.workspaces.describe' },
    commandShell: { kind: 'capability', capability: 'host.workspaces.commandShell' },
    rename: { kind: 'capability', capability: 'host.workspaces.rename' },
    commands: { kind: 'capability', capability: 'host.workspaces.commands' },
    runCommand: { kind: 'capability', capability: 'host.workspaces.runCommand' },
  },
  TuiCommandTreeRuntime: {
    register: { kind: 'capability', capability: 'host.command-trees.register' },
    children: { kind: 'capability', capability: 'host.command-trees.children' },
    descriptions: { kind: 'capability', capability: 'host.command-trees.descriptions' },
  },
  TuiToastRuntime: {
    show: { kind: 'capability', capability: 'host.toast.show' },
  },
  TuiEffectLedgerRuntime: {
    record: { kind: 'capability', capability: 'host.ledger.record', guard: 'kernel' },
  },
}

/**
 * Non-Service classes whose public methods are effectful (or call effectful
 * host capabilities) and therefore need an explicit shadow-policy entry.
 *
 * Classes not listed here are internal UI/domain helpers that are not part of
 * the adapter capability surface; they are recorded as a known gate boundary
 * below rather than silently claimed as covered.
 */
const NON_SERVICE_POLICY: Readonly<Record<string, {
  readonly default: MethodPolicy
  readonly overrides?: Readonly<Record<string, MethodPolicy>>
}>> = Object.freeze({
  QuestionStore: Object.freeze({
    default: { kind: 'exempt', reason: 'internal TUI question store; not an adapter capability entry; ask() is the guarded host.presentation.ask entry point' },
    overrides: Object.freeze({
      ask: { kind: 'capability', capability: 'host.presentation.ask' },
    }),
  }),
  ApprovalStore: Object.freeze({
    default: { kind: 'exempt', reason: 'internal TUI approval store; not an adapter capability entry; park() is the guarded host.presentation.approve entry point' },
    overrides: Object.freeze({
      park: { kind: 'capability', capability: 'host.presentation.approve' },
    }),
  }),
  TuiDialogStore: Object.freeze({
    default: { kind: 'exempt', reason: 'internal Cordis-free dialog queue; public adapter entry points are TuiDialogRuntime.select/confirm/input' },
  }),
  TuiStatusStore: Object.freeze({
    default: { kind: 'exempt', reason: 'internal Cordis-free status store; public adapter entry points are TuiStatusRuntime.set/subscribe' },
  }),
  TuiToastStore: Object.freeze({
    default: { kind: 'exempt', reason: 'internal Cordis-free toast sink; public adapter entry point is TuiToastRuntime.show' },
  }),
  SubagentActivityStore: Object.freeze({
    default: { kind: 'exempt', reason: 'internal TUI subagent activity projection; not part of the adapter capability surface' },
  }),
  SettingsForm: Object.freeze({
    default: { kind: 'exempt', reason: 'internal settings editor form state; not part of the adapter capability surface' },
  }),
})

function collectServiceMethods(): Array<{ className: string; methodName: string; source: string; service: boolean }> {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (entry.endsWith('.ts')) files.push(path)
    }
  }
  walk(SRC)

  const methods: Array<{ className: string; methodName: string; source: string; service: boolean }> = []
  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const className = node.name.text
        const extendsService = node.heritageClauses?.some(clause =>
          clause.token === ts.SyntaxKind.ExtendsKeyword
          && clause.types.some(type => type.expression.getText(sf) === 'Service')) ?? false
        const inNonServicePolicy = className in NON_SERVICE_POLICY
        if (!extendsService && !inNonServicePolicy) {
          // Even non-curated classes are not silently outside the gate when
          // they directly call a shadow-policy capability; those methods must
          // be added to NON_SERVICE_POLICY explicitly.
          const hasGuardedMember = node.members.some(member =>
            (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member))
            && member.body !== undefined
            && capabilityGuardsInSource(member.getText(sf)).size > 0)
          if (!hasGuardedMember) return
        }
        for (const member of node.members) {
          const isMethod = ts.isMethodDeclaration(member) && member.body !== undefined
          const isGetter = ts.isGetAccessorDeclaration(member) && member.body !== undefined
          if (!isMethod && !isGetter) continue
          const modifiers = member.modifiers ?? []
          if (modifiers.some(modifier =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword
            || modifier.kind === ts.SyntaxKind.ProtectedKeyword
            || modifier.kind === ts.SyntaxKind.StaticKeyword)) continue
          const nameNode = member.name
          if (nameNode === undefined) continue
          const name = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)
            ? nameNode.text
            : nameNode.getText(sf)
          if (name === 'constructor' || name.startsWith('#')) continue
          const relevant = extendsService
            || inNonServicePolicy
            || capabilityGuardsInSource(member.getText(sf)).size > 0
          if (!relevant) continue
          methods.push({
            className,
            methodName: name,
            source: member.getText(sf),
            service: extendsService,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return methods
}

/** Walk an AST node and return the string-literal shadow-policy capabilities
 * that are directly called. Using the AST (rather than `source.includes`)
 * prevents comments/strings from satisfying the gate. */
function capabilityGuardsInNode(root: ts.Node): Set<string> {
  const guards = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
          ? callee.name.text
          : undefined
      if (name === 'assertAdapterCapability'
        || name === 'assertCapabilityShadowPolicy'
        || name === 'assertEffect') {
        const first = node.arguments[0]
        if (first !== undefined && ts.isStringLiteral(first)) guards.add(first.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return guards
}

/** Parse a member source snippet as an AST and return its direct guards.
 * The snippet is wrapped in a synthetic class so TypeScript parses it as a
 * real method/getter body rather than as loose statements. */
function capabilityGuardsInSource(source: string): Set<string> {
  const sf = ts.createSourceFile(
    'guarded-member.ts',
    `class __ShadowMember { ${source} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  return capabilityGuardsInNode(sf)
}

function hasDirectGuard(source: string, capability: string): boolean {
  return capabilityGuardsInSource(source).has(capability)
}

/** AST check that a service method actually routes through the KernelLedger
 *  write channel (`*.kernelLedger.record(...)`), instead of a file-order
 *  `includes()` that could be satisfied by a comment or unrelated string. */
function sourceCallsKernelLedgerRecord(source: string): boolean {
  const sf = ts.createSourceFile(
    'kernel-ledger-record.ts',
    `class __ShadowMember { ${source} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (!found && ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee)
        && callee.name.text === 'record'
        && callee.expression.getText(sf).includes('kernelLedger')) {
        found = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const methodFailures: string[] = []
const serviceMethods = collectServiceMethods()
const methodNamesSeen = new Set<string>()
for (const method of serviceMethods) {
  const key = `${method.className}.${method.methodName}`
  methodNamesSeen.add(key)
  let policy: MethodPolicy | undefined
  if (method.service) {
    const classPolicy = METHOD_POLICY[method.className]
    if (classPolicy === undefined) {
      methodFailures.push(`${key}: service class has no method-policy entry`)
      continue
    }
    policy = classPolicy[method.methodName]
    if (policy === undefined) {
      methodFailures.push(`${key}: new public service method without a shadow-policy entry`)
      continue
    }
  } else {
    const classPolicy = NON_SERVICE_POLICY[method.className]
    if (classPolicy === undefined) {
      methodFailures.push(`${key}: effectful non-service class has no explicit policy entry`)
      continue
    }
    policy = classPolicy.overrides?.[method.methodName] ?? classPolicy.default
  }
  if (policy.kind === 'exempt') {
    // A default-exempt non-service method must not silently gain a direct
    // shadow-capability guard without an explicit override in the policy map.
    const directGuards = capabilityGuardsInSource(method.source)
    if (!method.service && directGuards.size > 0) {
      methodFailures.push(`${key}: non-service method calls shadow guards (${[...directGuards].join(', ')}) but is only default-exempt; add an explicit capability override`)
    }
    continue
  }
  if (!ADAPTER_CAPABILITY_EFFECT_CLASSES[policy.capability]) {
    methodFailures.push(`${key}: capability ${policy.capability} is not registered in the effect matrix`)
    continue
  }
  if (policy.guard === 'kernel') {
    if (!sourceCallsKernelLedgerRecord(method.source)) {
      methodFailures.push(`${key}: effectful ledger method does not route through the KernelLedger guard`)
    }
  } else if (!hasDirectGuard(method.source, policy.capability)) {
    methodFailures.push(`${key}: effectful method has no direct shadow guard for ${policy.capability}`)
  }
}
assert.deepEqual(methodFailures, [], methodFailures.join('\n'))

// Every registered capability that has a service-method policy must also be in
// the effect matrix (the inverse is intentionally not required for pure host
// side capabilities such as grants/probes invoked from channel helpers).
for (const [className, methods] of Object.entries(METHOD_POLICY)) {
  for (const [methodName, policy] of Object.entries(methods)) {
    if (policy.kind === 'capability') {
      assert.ok(ADAPTER_CAPABILITY_EFFECT_CLASSES[policy.capability], `${className}.${methodName} -> ${policy.capability} missing from effect matrix`)
    }
  }
}
for (const [className, spec] of Object.entries(NON_SERVICE_POLICY)) {
  for (const [methodName, policy] of Object.entries(spec.overrides ?? {})) {
    if (policy.kind === 'capability') {
      assert.ok(ADAPTER_CAPABILITY_EFFECT_CLASSES[policy.capability], `${className}.${methodName} -> ${policy.capability} missing from effect matrix`)
    }
  }
}

// ── Returned-object handle policies ────────────────────────────────────────
/**
 * Capability methods returned by a host service method (for example
 * `storage.open()` gets/sets/deletes) are not class declarations, so they are
 * tracked explicitly here. The AST check below proves each returned property
 * contains the direct shadow-policy guard, not merely a string in the file.
 */
const RETURNED_HANDLE_POLICY: ReadonlyArray<{
  ownerClass: string
  ownerMethod: string
  handle: string
  capability: string
}> = Object.freeze([
  { ownerClass: 'TuiPluginStorageRuntime', ownerMethod: 'open', handle: 'get', capability: 'host.storage.read' },
  { ownerClass: 'TuiPluginStorageRuntime', ownerMethod: 'open', handle: 'set', capability: 'host.storage.write' },
  { ownerClass: 'TuiPluginStorageRuntime', ownerMethod: 'open', handle: 'delete', capability: 'host.storage.write' },
  { ownerClass: 'TuiPluginHostRuntime', ownerMethod: 'grants', handle: 'onChange', capability: 'host.grants.subscribe' },
])

function returnedHandleHasGuard(method: { source: string }, handle: string, capability: string): boolean {
  const sf = ts.createSourceFile(
    'returned-handle.ts',
    `class __ShadowMember { ${method.source} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (!found) {
      const isObjectMethod = ts.isMethodDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === handle
        && node.body !== undefined
        && capabilityGuardsInNode(node.body).has(capability)
      const isObjectProperty = ts.isPropertyAssignment(node)
        && ts.isIdentifier(node.name)
        && node.name.text === handle
        && capabilityGuardsInNode(node.initializer).has(capability)
      if (isObjectMethod || isObjectProperty) found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const CLASS_SOURCE_FILES: Readonly<Record<string, string>> = Object.freeze({
  TuiPluginStorageRuntime: 'dsh-adapter/plugin-storage.ts',
  TuiPluginHostRuntime: 'dsh-adapter/plugin-host.ts',
})

function classAnyMemberHasReturnedHandleGuard(ownerClass: string, handle: string, capability: string): boolean {
  const relative = CLASS_SOURCE_FILES[ownerClass]
  if (relative === undefined) return false
  const sourceText = readFileSync(resolve(SRC, relative), 'utf8')
  const sf = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === ownerClass) {
      for (const member of node.members) {
        if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) && member.body !== undefined) {
          if (returnedHandleHasGuard({ source: member.getText(sf) }, handle, capability)) {
            found = true
          }
        }
      }
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

for (const entry of RETURNED_HANDLE_POLICY) {
  const method = serviceMethods.find(candidate =>
    candidate.className === entry.ownerClass && candidate.methodName === entry.ownerMethod)
  assert.ok(method !== undefined, `${entry.ownerClass}.${entry.ownerMethod} not found for returned handle policy`)
  assert.ok(returnedHandleHasGuard(method!, entry.handle, entry.capability)
    || classAnyMemberHasReturnedHandleGuard(entry.ownerClass, entry.handle, entry.capability),
    `${entry.ownerClass}.${entry.ownerMethod} returned handle "${entry.handle}" must guard ${entry.capability}`)
}

// ── AST helpers for file-level production assertions ────────────────────────

function parseSourceFile(relative: string): ts.SourceFile {
  return ts.createSourceFile(
    relative,
    readFileSync(resolve(SRC, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function fileHasCallMatches(relative: string, predicate: (callee: ts.Expression, call: ts.CallExpression, sf: ts.SourceFile) => boolean): boolean {
  const sf = parseSourceFile(relative)
  let found = false
  const visit = (node: ts.Node): void => {
    if (!found && ts.isCallExpression(node) && predicate(node.expression, node, sf)) found = true
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function capabilityGuardName(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
      ? callee.name.text
      : undefined
  return ['assertAdapterCapability', 'assertCapabilityShadowPolicy', 'assertEffect'].includes(name ?? '') ? name : undefined
}

function fileHasDirectCapabilityGuard(relative: string, capability: string): boolean {
  return fileHasCallMatches(relative, (_, call) => {
    const first = call.arguments[0]
    return capabilityGuardName(call) !== undefined
      && first !== undefined
      && ts.isStringLiteral(first)
      && first.text === capability
  })
}

function fileHasNamedCall(relative: string, name: string): boolean {
  return fileHasCallMatches(relative, callee => {
    if (ts.isIdentifier(callee)) return callee.text === name
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text === name
    return false
  })
}

function fileHasMethodCallNamed(relative: string, method: string): boolean {
  return fileHasCallMatches(relative, callee =>
    ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) && callee.name.text === method)
}

function fileHasMethodCallNamedWithUndefinedArg(relative: string, method: string): boolean {
  return fileHasCallMatches(relative, (callee, call) =>
    ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.name)
    && callee.name.text === method
    && call.arguments.length === 1
    && ts.isIdentifier(call.arguments[0]!)
    && call.arguments[0]!.text === 'undefined')
}

// ── Non-service capability guards called from host helper paths ────────────
// These specific declarations are checked by AST. They are deliberately not
// broad "all source files guard everything" claims; the exact production call
// sites below are the ones the gate promises.
const EXTRA_CAPABILITY_GUARDS: ReadonlyArray<{ capability: string; file: string }> = Object.freeze([
  { capability: 'host.grants.evaluate', file: 'adapter/standard/grants.ts' },
  { capability: 'host.commands.invoke', file: 'dsh-adapter/channel.ts' },
  { capability: 'host.presentation.ask', file: 'dsh-adapter/questions.ts' },
  { capability: 'host.presentation.approve', file: 'dsh-adapter/approvals.ts' },
])
for (const { capability, file } of EXTRA_CAPABILITY_GUARDS) {
  assert.ok(fileHasDirectCapabilityGuard(file, capability),
    `${file} must contain an AST-verified direct shadow guard for ${capability}`)
}
assert.ok(ADAPTER_CAPABILITY_EFFECT_CLASSES['host.grants.evaluate'] === 'read-only')
assert.ok(ADAPTER_CAPABILITY_EFFECT_CLASSES['host.commands.invoke'] === 'mutate')
assert.ok(ADAPTER_CAPABILITY_EFFECT_CLASSES['host.presentation.ask'] === 'mutate')
assert.ok(ADAPTER_CAPABILITY_EFFECT_CLASSES['host.presentation.approve'] === 'mutate')

// The grant evaluation path in channel.ts is a host-internal use of the grant
// store, not an adapter capability guard. It is still a machine-checkable
// invocation claim, so keep it in the explicit heuristic section below rather
// than adding it to the AST guard list above.
const HEURISTIC_INTEGRATION_CLAIMS: ReadonlyArray<{ file: string; description: string; needle: string }> = Object.freeze([
  {
    file: 'dsh-adapter/channel.ts',
    description: 'channel wraps grant evaluation through currentGrantStore().allows',
    needle: 'currentGrantStore().allows(',
  },
  {
    file: 'adapter/upstream/host-descriptor-driver.ts',
    description: 'driver probe evidence ids carry the current API literal',
    needle: "probeDiagnostic()'",
  },
  {
    file: 'adapter/upstream/host-descriptor-driver.ts',
    description: 'driver probe evidence ids carry the current API literal',
    needle: "probeDecisionEvents()'",
  },
])
for (const claim of HEURISTIC_INTEGRATION_CLAIMS) {
  const source = readFileSync(resolve(SRC, claim.file), 'utf8')
  assert.ok(source.includes(claim.needle), `${claim.file} ${claim.description} (${claim.needle})`)
}

// ── Known platform boundaries ──────────────────────────────────────────────
const PLATFORM_BOUNDARIES: ReadonlyArray<{ id: string; path: string; reason: string }> = Object.freeze([
  {
    id: 'commands-direct',
    path: 'ctx.get(\'commands\').register / .execute',
    reason: 'C-070 trusted-in-process boundary: direct upstream dsh-commands calls cannot be mediated without replacing the upstream service; host-mediated commands are covered by host.commands.register/host.commands.invoke.',
  },
  {
    id: 'cordis-subplugin',
    path: 'ctx.plugin() / candidate.plugin()',
    reason: 'Cordis platform mechanism for installing sub-plugins; TUI cannot intercept the platform without forking Cordis.',
  },
  {
    id: 'agent-preset-registration',
    path: 'agent preset roster / recompose registration',
    reason: 'Owned by @deepseek-ai/dsh-agent-presets; TUI consumes presets but does not own the registration mechanism.',
  },
  {
    id: 'system-prompt-section',
    path: 'system prompt section registration',
    reason: 'Owned by @deepseek-ai/dsh-system-prompt; TUI reads assembled sections but does not mediate registration.',
  },
  {
    id: 'skill-registry',
    path: 'skill registry registration/invocation',
    reason: 'Owned by @deepseek-ai/dsh-skill; TUI only reads/catalogs skills and does not own registry writes.',
  },
])
assert.ok(PLATFORM_BOUNDARIES.length >= 5, 'platform boundary list must be explicit')
assert.ok(PLATFORM_BOUNDARIES.some(boundary => boundary.id === 'commands-direct' && boundary.reason.includes('C-070')))

// Known gate boundaries that are intentionally not enumerated as effectful
// methods. Keeping this list explicit prevents the gate from silently
// claiming universal coverage of every internal TUI class.
const KNOWN_GATE_BOUNDARIES: ReadonlyArray<{ id: string; path: string; reason: string }> = Object.freeze([
  {
    id: 'non-service-internal-state',
    path: 'src/dsh-adapter/** internal stores/helpers not in NON_SERVICE_POLICY',
    reason: 'Internal TUI state containers and view helpers that are not adapter/kernel capability entry points. The AST gate explicitly tracks all Service subclasses plus the curated effectful non-service stores above; other internal classes are not claimed as shadow-mediated.',
  },
  {
    id: 'raw-react-ui',
    path: 'src/screens/** src/components/**',
    reason: 'React UI state and event handlers are outside the adapter capability surface; they consume guarded services rather than implementing host capabilities.',
  },
])
assert.ok(KNOWN_GATE_BOUNDARIES.length >= 2, 'known gate boundary list must be explicit')

// ── Production integration claims (AST-verified call sites) ────────────────
const integrationClaimChecks: ReadonlyArray<{ file: string; label: string; check: () => boolean }> = Object.freeze([
  { file: 'dsh-adapter/channel.ts', label: 'getHostFacade(...)', check: () => fileHasNamedCall('dsh-adapter/channel.ts', 'getHostFacade') },
  { file: 'dsh-adapter/channel.ts', label: 'collectAdapterDiagnostics(...)', check: () => fileHasNamedCall('dsh-adapter/channel.ts', 'collectAdapterDiagnostics') },
  { file: 'dsh-adapter/channel.ts', label: 'markDecisionDispatchTopology(...)', check: () => fileHasNamedCall('dsh-adapter/channel.ts', 'markDecisionDispatchTopology') },
  { file: 'dsh-adapter/effect-ledger.ts', label: 'createKernelLedger(...)', check: () => fileHasNamedCall('dsh-adapter/effect-ledger.ts', 'createKernelLedger') },
  { file: 'adapter/upstream/host-descriptor-driver.ts', label: 'commands.list(undefined)', check: () => fileHasMethodCallNamedWithUndefinedArg('adapter/upstream/host-descriptor-driver.ts', 'list') },
  { file: 'adapter/upstream/host-descriptor-driver.ts', label: 'probeDiagnostic()', check: () => fileHasMethodCallNamed('adapter/upstream/host-descriptor-driver.ts', 'probeDiagnostic') },
  { file: 'adapter/upstream/host-descriptor-driver.ts', label: 'probeDecisionEvents()', check: () => fileHasMethodCallNamed('adapter/upstream/host-descriptor-driver.ts', 'probeDecisionEvents') },
])
for (const claim of integrationClaimChecks) {
  assert.ok(claim.check(), `${claim.file} must contain AST-verified production integration call ${claim.label}`)
}

// ── Real passive-shadow runtime: mediated + raw ctx.on DecisionEvents ──────
process.env.DSH_TUI_ADAPTER_MODE = 'passive-shadow'
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
  const { getHostAdmission, getHostFacade } = await import('../src/dsh-adapter/plugin-host.js')
  const {
    parseManifest,
    projectManifest,
  } = await import('../src/adapter/standard/protocols.js')
  const { bindComponentIdentity } = await import('../src/dsh-adapter/component-identity.js')
  const {
    decisionRegistryOf,
    decisionHandlersOf,
  } = await import('../src/dsh-adapter/decision-guard.js')
  const { parseGrantStore } = await import('../src/adapter/standard/grants.js')
  const { testManifest } = await import('./lib/plugin-test-utils.js')

  const mountPassive = async () => {
    const root = new Context()
    root.logger.warn = () => undefined
    root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
    await new Promise(resolve => setTimeout(resolve, 50))
    return root
  }

  const passiveRoot = await mountPassive()
  const host = passiveRoot.get('tuiPluginHost')
  assert.ok(host !== undefined)
  assert.throws(() => host.subscribeDecision(passiveRoot, 'tui/input', () => undefined), /shadow policy denies/)
  assert.throws(() => host.registerCommand(passiveRoot, { name: 'x' } as never), /shadow policy denies/)
  assert.throws(() => host.grants.onChange(passiveRoot, () => undefined), /shadow policy denies/)
  const storage = passiveRoot.get('tuiPluginStorage')
  assert.ok(storage !== undefined)
  assert.throws(() => storage.open(passiveRoot), /shadow policy denies/)
  const ledger = passiveRoot.get('tuiEffectLedger')
  assert.ok(ledger !== undefined)
  assert.doesNotThrow(
    () => ledger.record({ operation: 'create', resource: { kind: 'test', id: 'x' }, result: 'applied' }),
    'ledger writes remain best-effort when shadow policy denies them',
  )
  const admission = getHostAdmission(host)
  assert.ok(admission !== undefined)
  assert.throws(() => admission.admit(passiveRoot, '{}'), /shadow policy denies/)
  const facade = getHostFacade(host)
  assert.ok(facade !== undefined)
  assert.doesNotThrow(() => facade.descriptor.snapshot())

  // P3 extension services must capture the same immutable runtime snapshot
  // at host initialization. Changing process.env later must not flip them to
  // `new` and bypass passive-shadow.
  const {
    TuiSceneRuntime,
  } = await import('../src/dsh-adapter/scenes.js')
  const {
    TuiSettingsSectionsRuntime,
  } = await import('../src/dsh-adapter/settings-sections.js')
  const {
    TuiStatusRuntime,
  } = await import('../src/dsh-adapter/status.js')
  const {
    TuiShortcutRuntime,
  } = await import('../src/dsh-adapter/shortcuts.js')
  const {
    TuiRendererRuntime,
  } = await import('../src/dsh-adapter/renderers.js')
  const {
    TuiThemeRuntime,
  } = await import('../src/dsh-adapter/themes.js')
  const {
    TuiToastRuntime,
  } = await import('../src/dsh-adapter/toast.js')
  const {
    TuiCommandTreeRuntime,
  } = await import('../src/dsh-adapter/command-trees.js')
  const {
    TuiWorkspaceRuntime,
  } = await import('../src/dsh-adapter/workspaces.js')
  const {
    TuiDialogRuntime,
  } = await import('../src/dsh-adapter/dialogs.js')
  const {
    QuestionStore,
  } = await import('../src/dsh-adapter/questions.js')
  const {
    ApprovalStore,
  } = await import('../src/dsh-adapter/approvals.js')
  const p3Scenes = new TuiSceneRuntime(passiveRoot)
  const p3Settings = new TuiSettingsSectionsRuntime(passiveRoot)
  const p3Status = new TuiStatusRuntime(passiveRoot)
  const p3Shortcuts = new TuiShortcutRuntime(passiveRoot)
  const p3Renderers = new TuiRendererRuntime(passiveRoot)
  const p3Themes = new TuiThemeRuntime(passiveRoot)
  const p3Toast = new TuiToastRuntime(passiveRoot)
  const p3CommandTrees = new TuiCommandTreeRuntime(passiveRoot)
  const p3Workspaces = new TuiWorkspaceRuntime(passiveRoot)
  const p3Dialogs = new TuiDialogRuntime(passiveRoot)
  const p3Questions = new QuestionStore()
  const p3Approvals = new ApprovalStore()
  process.env.DSH_TUI_ADAPTER_MODE = 'new'
  assert.throws(() => p3Scenes.register({ id: 'x', component: () => undefined } as never), /shadow policy denies/)
  assert.throws(() => p3Settings.register({ ns: 'x', title: 'x', fields: [] } as never), /shadow policy denies/)
  assert.throws(() => p3Status.set('x', 'y'), /shadow policy denies/)
  assert.throws(() => p3Shortcuts.register('ctrl+shift+x', { description: 'x', handler: () => undefined }), /shadow policy denies/)
  assert.throws(() => p3Renderers.register('foo/bar', () => undefined), /shadow policy denies/)
  assert.throws(() => p3Themes.register({ name: 'x', base: 'dark' } as never), /shadow policy denies/)
  assert.throws(() => p3Toast.show('x'), /shadow policy denies/)
  assert.throws(() => p3CommandTrees.register({ root: 'x', children: () => [] } as never), /shadow policy denies/)
  await assert.rejects(p3Workspaces.rename('x', 'y'), /shadow policy denies/)
  assert.throws(() => p3Dialogs.select({ title: 'x', options: [] } as never), /shadow policy denies/)
  assert.throws(() => p3Questions.ask({ questions: [] } as never), /shadow policy denies/)
  assert.throws(() => p3Approvals.park({ toolName: 'x' } as never), /shadow policy denies/)
  checks += 1

  // Direct upstream command path is a documented platform boundary: even in
  // passive shadow the TUI does not (and cannot) intercept a bare
  // `ctx.get('commands').register` call without forking dsh-commands.
  const directCommands: unknown[] = []
  const fakeCommands = {
    register(definition: unknown) {
      directCommands.push(definition)
      return () => undefined
    },
    list() {
      return Object.freeze([])
    },
    find() {
      return undefined
    },
    execute() {
      return undefined
    },
  }
  ;(passiveRoot as unknown as { provide(name: string, value: unknown): () => void }).provide('commands', fakeCommands)
  await new Promise(resolve => setTimeout(resolve, 20))
  const directService = passiveRoot.get('commands') as { register(definition: unknown): () => void } | undefined
  assert.ok(directService !== undefined, 'direct commands service should be available for boundary proof')
  assert.doesNotThrow(() => directService.register({ name: 'direct-boundary' }))
  assert.equal(directCommands.length, 1, 'direct commands.register must not be swallowed by passive shadow')

  // Raw ctx.on('tui/input') must be refused by passive shadow before it can
  // enter the mediated DecisionEvents registry. Use a permissive grant store
  // so the refusal cannot be blamed on grant denial.
  decisionRegistryOf(passiveRoot).grants = parseGrantStore(
    JSON.stringify({ grants: { 'raw-decision': [{ name: 'session.input.intercept', scope: 'tui/input' }] } }),
  )
  const rawPlugin = passiveRoot.plugin({
    name: 'raw-decision',
    apply(candidate: InstanceType<typeof Context>) {
      const source = testManifest({
        id: 'raw-decision',
        requires: [{ apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' }],
        permissions: [{ name: 'session.input.intercept', scope: 'tui/input' }],
      })
      const manifest = parseManifest(source, { source: 'test:raw-decision' })
      const projection = projectManifest(manifest)
      bindComponentIdentity(candidate, manifest, projection, 'raw-act')
      // This call goes through installDecisionGuard's internal/listener hook.
      candidate.on('tui/input', () => undefined)
    },
  }) as unknown as { dispose(): unknown }
  await new Promise(resolve => setTimeout(resolve, 30))
  // Even with a permissive grant, passive shadow must leave no handler behind.
  assert.equal(decisionHandlersOf(passiveRoot, 'tui/input').length, 0)
  rawPlugin.dispose()
} finally {
  delete process.env.DSH_TUI_ADAPTER_MODE
}

// Replay-shadow on a real production host must also fail closed for every
// effectful entry (subscribe/register included), just like passive shadow.
process.env.DSH_TUI_ADAPTER_MODE = 'replay-shadow'
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
  const root = new Context()
  root.logger.warn = () => undefined
  root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await new Promise(resolve => setTimeout(resolve, 50))
  const host = root.get('tuiPluginHost')
  assert.ok(host !== undefined)
  assert.throws(() => host.subscribeDecision(root, 'tui/input', () => undefined), /shadow policy denies/)
  assert.throws(() => host.registerCommand(root, { name: 'x' } as never), /shadow policy denies/)
  assert.throws(() => host.grants.onChange(root, () => undefined), /shadow policy denies/)
  const storage = root.get('tuiPluginStorage')
  assert.ok(storage !== undefined)
  assert.throws(() => storage.open(root), /shadow policy denies/)
  const messages = root.get('tuiMessageObserver')
  assert.ok(messages !== undefined)
  assert.throws(() => messages.subscribe(root, () => undefined, { scope: 'session:x' }), /shadow policy denies/)
  // P3 services under replay-shadow must also keep the host-init snapshot:
  // flipping the environment to `new` after mount must not unlock effectful
  // methods.
  const {
    TuiSceneRuntime,
  } = await import('../src/dsh-adapter/scenes.js')
  const {
    TuiSettingsSectionsRuntime,
  } = await import('../src/dsh-adapter/settings-sections.js')
  const {
    TuiStatusRuntime,
  } = await import('../src/dsh-adapter/status.js')
  const {
    TuiShortcutRuntime,
  } = await import('../src/dsh-adapter/shortcuts.js')
  const {
    TuiRendererRuntime,
  } = await import('../src/dsh-adapter/renderers.js')
  const {
    TuiThemeRuntime,
  } = await import('../src/dsh-adapter/themes.js')
  const {
    TuiToastRuntime,
  } = await import('../src/dsh-adapter/toast.js')
  const {
    TuiCommandTreeRuntime,
  } = await import('../src/dsh-adapter/command-trees.js')
  const {
    TuiWorkspaceRuntime,
  } = await import('../src/dsh-adapter/workspaces.js')
  const {
    TuiDialogRuntime,
  } = await import('../src/dsh-adapter/dialogs.js')
  const {
    QuestionStore,
  } = await import('../src/dsh-adapter/questions.js')
  const {
    ApprovalStore,
  } = await import('../src/dsh-adapter/approvals.js')
  const p3Scenes = new TuiSceneRuntime(root)
  const p3Settings = new TuiSettingsSectionsRuntime(root)
  const p3Status = new TuiStatusRuntime(root)
  const p3Shortcuts = new TuiShortcutRuntime(root)
  const p3Renderers = new TuiRendererRuntime(root)
  const p3Themes = new TuiThemeRuntime(root)
  const p3Toast = new TuiToastRuntime(root)
  const p3CommandTrees = new TuiCommandTreeRuntime(root)
  const p3Workspaces = new TuiWorkspaceRuntime(root)
  const p3Dialogs = new TuiDialogRuntime(root)
  const p3Questions = new QuestionStore()
  const p3Approvals = new ApprovalStore()
  process.env.DSH_TUI_ADAPTER_MODE = 'new'
  assert.throws(() => p3Scenes.register({ id: 'x', component: () => undefined } as never), /shadow policy denies/)
  assert.throws(() => p3Settings.register({ ns: 'x', title: 'x', fields: [] } as never), /shadow policy denies/)
  assert.throws(() => p3Status.set('x', 'y'), /shadow policy denies/)
  assert.throws(() => p3Shortcuts.register('ctrl+shift+x', { description: 'x', handler: () => undefined }), /shadow policy denies/)
  assert.throws(() => p3Renderers.register('foo/bar', () => undefined), /shadow policy denies/)
  assert.throws(() => p3Themes.register({ name: 'x', base: 'dark' } as never), /shadow policy denies/)
  assert.throws(() => p3Toast.show('x'), /shadow policy denies/)
  assert.throws(() => p3CommandTrees.register({ root: 'x', children: () => [] } as never), /shadow policy denies/)
  await assert.rejects(p3Workspaces.rename('x', 'y'), /shadow policy denies/)
  assert.throws(() => p3Dialogs.select({ title: 'x', options: [] } as never), /shadow policy denies/)
  assert.throws(() => p3Questions.ask({ questions: [] } as never), /shadow policy denies/)
  assert.throws(() => p3Approvals.park({ toolName: 'x' } as never), /shadow policy denies/)
  checks += 1
} finally {
  delete process.env.DSH_TUI_ADAPTER_MODE
}

// Legacy control: the same raw path with a permissive grant does register,
// proving the passive test above is enforcing shadow rather than grant denial.
process.env.DSH_TUI_ADAPTER_MODE = 'legacy'
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
  const { parseManifest, projectManifest } = await import('../src/adapter/standard/protocols.js')
  const { bindComponentIdentity } = await import('../src/dsh-adapter/component-identity.js')
  const { decisionRegistryOf, decisionHandlersOf } = await import('../src/dsh-adapter/decision-guard.js')
  const { parseGrantStore } = await import('../src/adapter/standard/grants.js')
  const { testManifest } = await import('./lib/plugin-test-utils.js')
  const root = new Context()
  root.logger.warn = () => undefined
  root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await new Promise(resolve => setTimeout(resolve, 50))
  decisionRegistryOf(root).grants = parseGrantStore(
    JSON.stringify({ grants: { 'raw-decision': [{ name: 'session.input.intercept', scope: 'tui/input' }] } }),
  )
  const rawPlugin = root.plugin({
    name: 'raw-decision',
    apply(candidate: InstanceType<typeof Context>) {
      const source = testManifest({
        id: 'raw-decision',
        requires: [{ apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' }],
        permissions: [{ name: 'session.input.intercept', scope: 'tui/input' }],
      })
      const manifest = parseManifest(source, { source: 'test:raw-decision' })
      const projection = projectManifest(manifest)
      bindComponentIdentity(candidate, manifest, projection, 'raw-act')
      candidate.on('tui/input', () => undefined)
    },
  }) as unknown as { dispose(): unknown }
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(decisionHandlersOf(root, 'tui/input').length, 1, 'legacy control should register one raw handler')
  rawPlugin.dispose()
} finally {
  delete process.env.DSH_TUI_ADAPTER_MODE
}

console.log(`verify:adapter-shadow OK (${checks} runtime checks + ${serviceMethods.length} AST-enumerated service/non-service methods + ${RETURNED_HANDLE_POLICY.length} returned-handle policies + ${Object.keys(ADAPTER_CAPABILITY_EFFECT_CLASSES).length} effect classes + ${PLATFORM_BOUNDARIES.length} platform boundaries + ${KNOWN_GATE_BOUNDARIES.length} known gate boundaries)`)
