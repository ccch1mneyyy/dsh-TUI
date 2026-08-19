/**
 * plugin-spec 库的 fixtures 全矩阵电池——TS 移植与上游参考实现
 * （conformance/tests/run.js）等价的证明，兼作 vendored 数据漂移报警器：
 *
 *   1. verifyRegistry / verifyContractProfiles 全绿（schemaHash 钉死 +
 *      十点完备 + 坐标/权限 parity + securityBoundary:false）；
 *   2. 26 个 validate fixture 逐一过 schema check + 语义校验，pass/fail 与
 *      run.js 期望逐条相等；
 *   3. 8 个 negotiate 场景与 run.js 期望逐字段 deepEqual；
 *   4. 篡改任一 contract 文件后 verifyRegistry 必败（fail-closed 自检）。
 *
 * 上游 dsh-ecosystem-spec 更新整目录覆盖后，本电池即漂移报警器。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-spec.ts`.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { check } = await import('../src/plugin-spec/schema-check.js')
const { loadSpecData, verifyRegistry, verifyContractProfiles } = await import('../src/plugin-spec/registry.js')
const { createContractIndex, validatePlugin, validateHost } = await import('../src/plugin-spec/validate.js')
const { negotiate } = await import('../src/plugin-spec/negotiate.js')
const { NEGOTIATION_ERROR_CODES } = await import('../src/plugin-spec/types.js')
const { parseManifest } = await import('@dsh-std/manifest')
const { validateMessageEvent } = await import('@dsh-std/messages')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const specDir = join(root, 'dsh-ecosystem-spec')
const load = (relative: string) => JSON.parse(readFileSync(join(specDir, relative), 'utf8'))
const fixture = (name: string) => load(`conformance/fixtures/${name}`)

const data = loadSpecData(specDir)
if (!data) {
  console.error('vendored spec data unreadable (dsh-ecosystem-spec/)')
  process.exit(1)
}
const index = createContractIndex(data.registry, data.permissions)

let checks = 0
const failures: string[] = []
const expect = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

// --- 1. vendored 数据自检 -------------------------------------------------
expect('verifyRegistry clean', verifyRegistry(data).length === 0, verifyRegistry(data).join(' | '))
expect('verifyContractProfiles clean', verifyContractProfiles(data).length === 0, verifyContractProfiles(data).join(' | '))
expect('admission error code table has 7 entries', NEGOTIATION_ERROR_CODES.length === 7)

// --- 2. validate fixture 矩阵（官方 parser/validator + TUI semantic layer）
interface ValidateCase {
  name: string
  value: unknown
  kind: 'plugin' | 'message' | 'schema' | 'host'
  schema?: keyof typeof data.schemas
  pass: boolean
}

const validateCase = ({ name, value, kind, schema, pass }: ValidateCase) => {
  checks += 1
  try {
    if (kind === 'plugin') {
      const parsed = parseManifest(JSON.stringify(value), { source: name })
      validatePlugin(index, parsed)
    } else if (kind === 'message') {
      validateMessageEvent(value)
    } else {
      if (schema === undefined) throw new Error(`${name}: schema key missing`)
      check(value, data.schemas[schema], data.schemas[schema])
      if (kind === 'host') validateHost(index, value as Parameters<typeof validateHost>[1])
    }
    if (!pass) failures.push(`${name}: expected failure but passed`)
  } catch (error) {
    if (pass) failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const CASES: ValidateCase[] = [
  { name: 'valid plugin', value: fixture('valid-plugin.json'), kind: 'plugin', pass: true },
  { name: 'valid plugin coordinate subscriptions', value: fixture('valid-plugin-object-subs.json'), kind: 'plugin', pass: true },
  { name: 'valid private protocol plugin', value: fixture('valid-private-protocol-plugin.json'), kind: 'plugin', pass: true },
  { name: 'invalid service rejected', value: fixture('invalid-plugin-unknown-service.json'), kind: 'plugin', pass: false },
  { name: 'duplicate command rejected', value: fixture('invalid-plugin-duplicate-command.json'), kind: 'plugin', pass: false },
  { name: 'unknown coordinate rejected', value: fixture('invalid-plugin-unknown-coordinate.json'), kind: 'plugin', pass: false },
  { name: 'unknown kind in known group rejected', value: fixture('invalid-plugin-unknown-kind.json'), kind: 'plugin', pass: false },
  { name: 'subscription to capability rejected', value: fixture('invalid-plugin-subscription-capability.json'), kind: 'plugin', pass: false },
  { name: 'duplicate coordinate ref rejected', value: fixture('invalid-plugin-duplicate-coordinate.json'), kind: 'plugin', pass: false },
  { name: 'unregistered facet apiVersion rejected', value: fixture('invalid-plugin-facet-version.json'), kind: 'plugin', pass: false },
  { name: 'client facet rejected', value: fixture('invalid-plugin-client-facet.json'), kind: 'plugin', pass: false },
  { name: 'worker facet rejected', value: fixture('invalid-plugin-worker-facet.json'), kind: 'plugin', pass: false },
  { name: 'valid message', value: fixture('valid-message.json'), kind: 'message', pass: true },
  { name: 'invalid privacy rejected', value: fixture('invalid-message-privacy.json'), kind: 'message', pass: false },
  { name: 'invalid content block rejected', value: fixture('invalid-message-content.json'), kind: 'message', pass: false },
  { name: 'mixed content block rejected', value: fixture('invalid-message-mixed-content.json'), kind: 'message', pass: false },
  { name: 'valid ledger', value: fixture('valid-ledger-record.json'), kind: 'schema', schema: 'ledger', pass: true },
  { name: 'valid claim', value: fixture('valid-claim.json'), kind: 'schema', schema: 'claim', pass: true },
  { name: 'valid host descriptor', value: load('registry/host-descriptor.tui.example.json'), kind: 'host', schema: 'host', pass: true },
  { name: 'host unknown contract rejected', value: fixture('invalid-host-unknown-contract.json'), kind: 'host', schema: 'host', pass: false },
  { name: 'host hash mismatch rejected', value: fixture('invalid-host-hash-mismatch.json'), kind: 'host', schema: 'host', pass: false },
  { name: 'host unknown permission rejected', value: fixture('invalid-host-unknown-permission.json'), kind: 'host', schema: 'host', pass: false },
  { name: 'host duplicate contract rejected', value: fixture('invalid-host-duplicate-contract.json'), kind: 'host', schema: 'host', pass: false },
  // C-030: optional 引用必须带 fallback，未注册版本不豁免（F3 红队修复）。
  { name: 'optional without fallback rejected', value: fixture('invalid-plugin-optional-no-fallback.json'), kind: 'plugin', pass: false },
  // C-002: v0.15 直接拒绝 provides（服务在 RFC 0003）。
  { name: 'provides rejected', value: fixture('invalid-plugin-provides.json'), kind: 'plugin', pass: false },
  // C-030: 已知 group+kind 的未注册版本是合法 manifest，由协商器回答 unknown。
  { name: 'unregistered version is a valid manifest', value: fixture('unknown-version-plugin.json'), kind: 'plugin', pass: true },
  { name: 'compound unknown+rejected manifest is valid', value: fixture('plugin-compound-unknown.json'), kind: 'plugin', pass: true },
]
for (const validateEntry of CASES) validateCase(validateEntry)

// --- 3. negotiate 八场景（期望与 run.js 断言逐字段 deepEqual） -------------
const hostTui = load('registry/host-descriptor.tui.example.json')
const hostNoObserve = fixture('host-no-observe.example.json')
const parsedFixture = (name: string) => parseManifest(JSON.stringify(fixture(name)), { source: name })

const negotiateCase = (name: string, actual: unknown, expected: unknown) => {
  checks += 1
  try {
    assert.deepEqual(actual, expected)
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

negotiateCase(
  'compatible',
  negotiate(index, parsedFixture('valid-plugin.json'), hostTui),
  { decision: 'compatible' },
)
negotiateCase(
  'waiting_authorization',
  negotiate(index, parsedFixture('waiting-authorization-plugin.json'), hostTui),
  {
    decision: 'waiting_authorization',
    reasonCode: 'PERMISSION_NOT_GRANTED',
    deniedPermissions: ['messages.observe.read@session:*'],
  },
)
negotiateCase(
  'authorized by grant',
  negotiate(index, parsedFixture('waiting-authorization-plugin.json'), hostTui, [{ name: 'messages.observe.read', scope: 'session:*' }]),
  { decision: 'compatible' },
)
// C-030: 必填契约宿主缺失 → rejected（先于权限判定）。
negotiateCase(
  'rejected missing required',
  negotiate(index, parsedFixture('waiting-authorization-plugin.json'), hostNoObserve),
  {
    decision: 'rejected',
    reasonCode: 'REQUIRED_PROTOCOL_UNAVAILABLE',
    missingRequired: ['messages.dsh/v1alpha1#MessageObserver'],
  },
)
// C-030: optional 缺失 + 声明 fallback → compatible_degraded。
negotiateCase(
  'compatible_degraded',
  negotiate(index, parsedFixture('valid-plugin.json'), hostNoObserve),
  {
    decision: 'compatible_degraded',
    missingOptional: ['messages.dsh/v1alpha1#MessageObserver'],
  },
)
// C-030: 引用版本在注册表之外 → unknown（非 rejected）。
negotiateCase(
  'unknown unregistered version',
  negotiate(index, parsedFixture('unknown-version-plugin.json'), hostTui),
  {
    decision: 'unknown',
    reasonCode: 'UNKNOWN_PROTOCOL_VERSION',
    unknownContracts: ['storage.dsh/v2beta1#LocalStorage'],
  },
)
// C-030 优先级：未注册版本 + 必填缺失 → unknown 压过 rejected。
negotiateCase(
  'unknown outranks rejected',
  negotiate(index, parsedFixture('plugin-compound-unknown.json'), hostNoObserve),
  {
    decision: 'unknown',
    reasonCode: 'UNKNOWN_PROTOCOL_VERSION',
    unknownContracts: ['storage.dsh/v2beta1#LocalStorage'],
  },
)
// C-010/C-003: facet apiVersion 不在宿主声明面 → rejected。
negotiateCase(
  'facet apiVersion mismatch rejected',
  negotiate(index, parsedFixture('valid-plugin.json'), fixture('invalid-host-facet-version.json')),
  {
    decision: 'rejected',
    reasonCode: 'FACET_API_VERSION_UNAVAILABLE',
    facetApiVersion: 'v1alpha1',
    hostFacetApiVersions: ['v2alpha1'],
  },
)

// --- 4. 篡改必败（fail-closed 自检） ---------------------------------------
const tamperedRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-tamper-'))
try {
  cpSync(specDir, join(tamperedRoot, 'dsh-ecosystem-spec'), { recursive: true })
  const privateEntry = data.registry.definitions[0]
  const target = join(tamperedRoot, 'dsh-ecosystem-spec', privateEntry.profile)
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n`)
  const tampered = loadSpecData(join(tamperedRoot, 'dsh-ecosystem-spec'))
  const drift = tampered ? verifyRegistry(tampered) : ['tampered copy unreadable']
  expect('tampered private profile detected', drift.length === 1 && drift[0].includes(privateEntry.name), drift.join(' | '))
} finally {
  rmSync(tamperedRoot, { recursive: true, force: true })
}

// --- 5. 可解析但错误形状的数据也必须 soft-fail -------------------------------
const malformedRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-malformed-'))
try {
  const malformedSpecDir = join(malformedRoot, 'dsh-ecosystem-spec')
  cpSync(specDir, malformedSpecDir, { recursive: true })
  const registryFile = join(malformedSpecDir, 'registry', 'registry-0.15.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as Record<string, unknown>
  registry.facetApiVersions = {}
  writeFileSync(registryFile, JSON.stringify(registry))
  expect('object-shaped facetApiVersions makes vendored data unavailable', loadSpecData(malformedSpecDir) === undefined)
} finally {
  rmSync(malformedRoot, { recursive: true, force: true })
}

const policyTamperRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-policy-tamper-'))
try {
  const policySpecDir = join(policyTamperRoot, 'dsh-ecosystem-spec')
  cpSync(specDir, policySpecDir, { recursive: true })
  const permissionsFile = join(policySpecDir, 'registry', 'permissions-0.1.json')
  const permissions = JSON.parse(readFileSync(permissionsFile, 'utf8')) as {
    permissions: Array<{ name: string; default: string }>
  }
  const readPermission = permissions.permissions.find(permission => permission.name === 'storage.local.read')
  if (readPermission === undefined) throw new Error('storage.local.read policy missing from fixture')
  readPermission.default = 'allow'
  writeFileSync(permissionsFile, JSON.stringify(permissions))
  expect('permission default drift makes vendored data unavailable', loadSpecData(policySpecDir) === undefined)
} finally {
  rmSync(policyTamperRoot, { recursive: true, force: true })
}

// --- 汇总 ------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`plugin-spec battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-spec battery OK (${checks} checks: registry self-check, ${CASES.length} validate fixtures, 8 negotiate scenarios, tamper fail-closed)`)
process.exit(0)
