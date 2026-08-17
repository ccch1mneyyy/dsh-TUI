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
 * 上游 ecosystem-spec 更新整目录覆盖后，本电池即漂移报警器。
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const specDir = join(root, 'ecosystem-spec')
const load = (relative: string) => JSON.parse(readFileSync(join(specDir, relative), 'utf8'))
const fixture = (name: string) => load(`conformance/fixtures/${name}`)

const data = loadSpecData(specDir)
if (!data) {
  console.error('vendored spec data unreadable (ecosystem-spec/)')
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
expect('error code table has 6 entries', NEGOTIATION_ERROR_CODES.length === 6)

// --- 2. validate fixture 矩阵（期望与 run.js expectCase 逐条对应） --------
type SchemaKey = keyof typeof data.schemas
interface ValidateCase {
  name: string
  value: unknown
  schema: SchemaKey
  semantic?: 'plugin' | 'host'
  pass: boolean
}

const validateCase = ({ name, value, schema, semantic, pass }: ValidateCase) => {
  checks += 1
  try {
    check(value, data.schemas[schema], data.schemas[schema])
    if (semantic === 'plugin') validatePlugin(index, value as Parameters<typeof validatePlugin>[1])
    if (semantic === 'host') validateHost(index, value as Parameters<typeof validateHost>[1])
    if (!pass) failures.push(`${name}: expected failure but passed`)
  } catch (error) {
    if (pass) failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const CASES: ValidateCase[] = [
  { name: 'valid plugin', value: fixture('valid-plugin.json'), schema: 'plugin', semantic: 'plugin', pass: true },
  { name: 'valid plugin coordinate subscriptions', value: fixture('valid-plugin-object-subs.json'), schema: 'plugin', semantic: 'plugin', pass: true },
  { name: 'invalid service rejected', value: fixture('invalid-plugin-unknown-service.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'duplicate command rejected', value: fixture('invalid-plugin-duplicate-command.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'unknown coordinate rejected', value: fixture('invalid-plugin-unknown-coordinate.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'unknown kind in known group rejected', value: fixture('invalid-plugin-unknown-kind.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'subscription to capability rejected', value: fixture('invalid-plugin-subscription-capability.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'duplicate coordinate ref rejected', value: fixture('invalid-plugin-duplicate-coordinate.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'unregistered facet apiVersion rejected', value: fixture('invalid-plugin-facet-version.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'client facet rejected', value: fixture('invalid-plugin-client-facet.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'worker facet rejected', value: fixture('invalid-plugin-worker-facet.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  { name: 'valid message', value: fixture('valid-message.json'), schema: 'message', pass: true },
  { name: 'invalid privacy rejected', value: fixture('invalid-message-privacy.json'), schema: 'message', pass: false },
  { name: 'invalid content block rejected', value: fixture('invalid-message-content.json'), schema: 'message', pass: false },
  { name: 'mixed content block rejected', value: fixture('invalid-message-mixed-content.json'), schema: 'message', pass: false },
  { name: 'valid ledger', value: fixture('valid-ledger-record.json'), schema: 'ledger', pass: true },
  { name: 'valid claim', value: fixture('valid-claim.json'), schema: 'claim', pass: true },
  { name: 'valid host descriptor', value: load('registry/host-descriptor.tui.example.json'), schema: 'host', semantic: 'host', pass: true },
  { name: 'host unknown contract rejected', value: fixture('invalid-host-unknown-contract.json'), schema: 'host', semantic: 'host', pass: false },
  { name: 'host hash mismatch rejected', value: fixture('invalid-host-hash-mismatch.json'), schema: 'host', semantic: 'host', pass: false },
  { name: 'host unknown permission rejected', value: fixture('invalid-host-unknown-permission.json'), schema: 'host', semantic: 'host', pass: false },
  { name: 'host duplicate contract rejected', value: fixture('invalid-host-duplicate-contract.json'), schema: 'host', semantic: 'host', pass: false },
  // C-030: optional 引用必须带 fallback，未注册版本不豁免（F3 红队修复）。
  { name: 'optional without fallback rejected', value: fixture('invalid-plugin-optional-no-fallback.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  // C-002: v0.15 直接拒绝 provides（服务在 RFC 0003）。
  { name: 'provides rejected', value: fixture('invalid-plugin-provides.json'), schema: 'plugin', semantic: 'plugin', pass: false },
  // C-030: 已知 group+kind 的未注册版本是合法 manifest，由协商器回答 unknown。
  { name: 'unregistered version is a valid manifest', value: fixture('unknown-version-plugin.json'), schema: 'plugin', semantic: 'plugin', pass: true },
  { name: 'compound unknown+rejected manifest is valid', value: fixture('plugin-compound-unknown.json'), schema: 'plugin', semantic: 'plugin', pass: true },
]
for (const validateEntry of CASES) validateCase(validateEntry)

// --- 3. negotiate 八场景（期望与 run.js 断言逐字段 deepEqual） -------------
const hostTui = load('registry/host-descriptor.tui.example.json')
const hostNoObserve = fixture('host-no-observe.example.json')

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
  negotiate(index, fixture('valid-plugin.json'), hostTui),
  { decision: 'compatible' },
)
negotiateCase(
  'waiting_authorization',
  negotiate(index, fixture('waiting-authorization-plugin.json'), hostTui),
  {
    decision: 'waiting_authorization',
    reasonCode: 'PERMISSION_NOT_GRANTED',
    deniedPermissions: ['messages.observe.read'],
  },
)
negotiateCase(
  'authorized by grant',
  negotiate(index, fixture('waiting-authorization-plugin.json'), hostTui, ['messages.observe.read']),
  { decision: 'compatible' },
)
// C-030: 必填契约宿主缺失 → rejected（先于权限判定）。
negotiateCase(
  'rejected missing required',
  negotiate(index, fixture('waiting-authorization-plugin.json'), hostNoObserve),
  {
    decision: 'rejected',
    reasonCode: 'REQUIRED_CONTRACT_UNAVAILABLE',
    missingRequired: ['messages.dsh/v1alpha1#MessageObserver'],
  },
)
// C-030: optional 缺失 + 声明 fallback → compatible_degraded。
negotiateCase(
  'compatible_degraded',
  negotiate(index, fixture('valid-plugin.json'), hostNoObserve),
  {
    decision: 'compatible_degraded',
    missingOptional: ['messages.dsh/v1alpha1#MessageObserver'],
  },
)
// C-030: 引用版本在注册表之外 → unknown（非 rejected）。
negotiateCase(
  'unknown unregistered version',
  negotiate(index, fixture('unknown-version-plugin.json'), hostTui),
  {
    decision: 'unknown',
    reasonCode: 'UNKNOWN_CONTRACT',
    unknownContracts: ['storage.dsh/v2beta1#LocalStorage'],
  },
)
// C-030 优先级：未注册版本 + 必填缺失 → unknown 压过 rejected。
negotiateCase(
  'unknown outranks rejected',
  negotiate(index, fixture('plugin-compound-unknown.json'), hostNoObserve),
  {
    decision: 'unknown',
    reasonCode: 'UNKNOWN_CONTRACT',
    unknownContracts: ['storage.dsh/v2beta1#LocalStorage'],
  },
)
// C-010/C-003: facet apiVersion 不在宿主声明面 → rejected。
negotiateCase(
  'facet apiVersion mismatch rejected',
  negotiate(index, fixture('valid-plugin.json'), fixture('invalid-host-facet-version.json')),
  {
    decision: 'rejected',
    reasonCode: 'FACET_API_VERSION_UNAVAILABLE',
    facetApiVersion: 'v1alpha1',
    hostFacetApiVersions: ['v9alpha1'],
  },
)

// --- 4. 篡改必败（fail-closed 自检） ---------------------------------------
const tamperedRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-tamper-'))
try {
  cpSync(specDir, join(tamperedRoot, 'ecosystem-spec'), { recursive: true })
  const target = join(tamperedRoot, 'ecosystem-spec', data.registry.entries[0].schema)
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n`)
  const tampered = loadSpecData(join(tamperedRoot, 'ecosystem-spec'))
  const drift = tampered ? verifyRegistry(tampered) : ['tampered copy unreadable']
  expect('tampered contract file detected', drift.length === 1 && drift[0].includes(data.registry.entries[0].name), drift.join(' | '))
} finally {
  rmSync(tamperedRoot, { recursive: true, force: true })
}

// --- 汇总 ------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`plugin-spec battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-spec battery OK (${checks} checks: registry self-check, ${CASES.length} validate fixtures, 8 negotiate scenarios, tamper fail-closed)`)
process.exit(0)
