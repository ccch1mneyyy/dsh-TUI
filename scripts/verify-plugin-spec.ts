/**
 * plugin-spec 库的 fixtures 全矩阵电池——TS 移植与参考实现
 * （tui-profile/conformance/tests/run.js）等价的证明，兼作 profile 一致性门禁：
 *
 *   1. verifyRegistry / verifyContractProfiles 全绿（schemaHash 钉死 +
 *      十点完备 + 坐标/权限 parity + securityBoundary:false）；
 *   2. 27 个 validate fixture 逐一过 schema check + 语义校验，pass/fail 与
 *      run.js 期望逐条相等；
 *   3. 8 个 negotiate 场景与 run.js 期望逐字段 deepEqual；
 *   4. Backend 家族（TUI-BACKEND-001）逐条镜像 run.js 的 Backend 段的期望：两种后端形态的声明
 *      形状、反例（含 roadmap §4.7 点名的 nativeKey）与保留词表都在这里执行，并与
 *      requirements-v0.15.json 登记的 fixture 清单交叉校验（锚点按段引用——行号会随套件增例漂移）。
 *      **run.js 的 Backend 段增例或改期望时，本节必须同改**——那套 profile 套件不在任何自动化里，
 *      本节才是它在 CI 的执行体（B-4 收口修的正是"等价证明"与参考实现漂移这件事）；
 *   5. 篡改任一 contract 文件后 verifyRegistry 必败（fail-closed 自检）。
 *
 * 仓内 TUI Profile（tui-profile/）没有整目录覆盖来源：它是本仓库的纯文件，
 * 随 dsh-TUI 的代码现状修订。所以本电池是「改 profile 必须同改代码派生常量与
 * fixture」的一致性证明，而不是上游漂移报警器。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-spec.ts`.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { check } = await import('../src/adapter/standard/schema-check.js')
const { loadSpecData, verifyRegistry, verifyContractProfiles } = await import('../src/adapter/standard/registry.js')
const { createContractIndex, validatePlugin, validateHost } = await import('../src/adapter/standard/validate.js')
const { negotiate } = await import('../src/adapter/standard/negotiate.js')
const { NEGOTIATION_ERROR_CODES } = await import('../src/adapter/standard/types.js')
const { parseManifest } = await import('@dsh-std/manifest')
const { validateMessageEvent } = await import('@dsh-std/messages')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const specDir = join(root, 'tui-profile')
const load = (relative: string) => JSON.parse(readFileSync(join(specDir, relative), 'utf8'))
const fixture = (name: string) => load(`conformance/fixtures/${name}`)

/**
 * 复制 vendored spec 做「篡改必败」夹具。**必须 `dereference: true`**：在
 * junction / symlink 形态的 checkout 下（例如用 junction 接子模块的 git
 * worktree），`cpSync` 默认只把链接本身复制过去，于是那份"拷贝"仍指向真目录，
 * 夹具的 `writeFileSync` 会写坏工作区里的真 spec——实测复现过：同一份链接，
 * `dereference: false` 时源文件被改写成 TAMPERED，`true` 时保持原样。
 * @param to - 目标目录（临时夹具根下的 spec 副本）。
 */
const copySpec = (to: string): void => cpSync(specDir, to, { recursive: true, dereference: true })

const data = loadSpecData(specDir)
if (!data) {
  console.error('vendored spec data unreadable (tui-profile/)')
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

// --- 4. Backend 家族（TUI-BACKEND-001）：run.js 期望的仓内执行体 ---------------
// 参考实现是 profile 套件（tui-profile/conformance/tests/run.js 的 Backend 段，TUI-BACKEND-001）。本节与它用**同一套定义**
// （dsh-std 的 ManifestDefinitionCatalog + profile 自己的扩展定义）跑**同一条期望表**：那套 suite 不在
// 任何自动化里（实测：run-verify-build 的 91 个 gate 无一含它），而本节在 `verify:build` 里。
// **run.js 的 Backend 段增例或改期望时，这里必须同改**——否则这份"等价证明"会再次漂移。
const expectBackend = (name: string, body: () => unknown, pass: boolean): void => {
  checks += 1
  try {
    body()
    if (!pass) failures.push(`${name}: expected a refusal but it passed`)
  } catch (error) {
    if (pass) failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
{
  const {
    BACKEND,
    BACKEND_CONFIRMATION_POLICIES,
    BACKEND_RESERVED_IDS,
    assertBackendHandler,
    registerTuiContributionExtensions,
    validateBackendSpec,
  } = await import('../src/adapter/spec/tui-contributions.js')
  const { ManifestDefinitionCatalog, parseManifest, projectManifest } = await import('@dsh-std/manifest')

  const manifests = new ManifestDefinitionCatalog()
  registerTuiContributionExtensions(manifests)
  expect('Backend extension definition is registered', manifests.extension(BACKEND) !== undefined)
  let duplicateRefused = false
  try { manifests.registerExtension(manifests.extension(BACKEND)!) } catch { duplicateRefused = true }
  expect('duplicate Backend coordinate is refused', duplicateRefused)

  /** 与 run.js 的 parseAndValidateManifest 同链：parse → project → catalog.validate。 */
  const backendManifestVerdict = (name: string, value?: unknown): void => {
    const source = value === undefined
      ? readFileSync(join(specDir, 'conformance', 'fixtures', name), 'utf8')
      : JSON.stringify(value)
    const parsed = parseManifest(source, { source: name })
    const report = manifests.validate(projectManifest(parsed), undefined, { source: name })
    const errors = report.issues.filter(issue => issue.severity === 'error')
    if (errors.length > 0) throw new Error(errors.map(issue => issue.message).join('; '))
  }

  // 期望表：profile 套件 Backend 段的 fixture 例逐条镜像（与 run.js 同一份定义、同一条期望）。
  // requirements 登记的清单在下面交叉校验：两侧任何一侧增删而另一侧没跟都会红；存在性检查堵住
  // "反例 fixture 缺失 → readFileSync 抛 ENOENT → pass=false 的用例把 ENOENT 当如期被拒记绿"。
  const BACKEND_FIXTURES = [
    ['valid Backend contribution (SDK peer shape)', 'valid-backend-contribution.json', true],
    ['valid Backend contribution (system CLI shape: no install recipe, pool hook)', 'valid-backend-contribution-cli.json', true],
    // 这条就是 roadmap §4.7 / §6 第 7 条点名的 nativeKey 反例：fixture 形状是 unknown-field，
    // 拒绝理由逐字是 `Backend content contains unknown field "nativeKey"`（实测）。
    ['Backend native channel rejected (unknown field)', 'invalid-backend-unknown-field.json', false],
    ['Backend bad id rejected', 'invalid-backend-bad-id.json', false],
    ['Backend host label key rejected', 'invalid-backend-key-label.json', false],
    ['Backend capability shape rejected', 'invalid-backend-capability-shape.json', false],
    ['Backend install recipe incomplete rejected', 'invalid-backend-install-incomplete.json', false],
    ['Backend confirmation policy rejected', 'invalid-backend-confirmation-policy.json', false],
    ['Backend grants shape rejected', 'invalid-backend-grants-shape.json', false],
  ] as const
  for (const [name, fileName, pass] of BACKEND_FIXTURES) {
    expectBackend(name, () => backendManifestVerdict(fileName), pass)
  }
  const requiredFixtures = (load('conformance/requirements-v0.15.json') as {
    requirements: Array<{ id: string; fixtures?: readonly string[] }>
  }).requirements.find(requirement => requirement.id === 'TUI-BACKEND-001')?.fixtures ?? []
  const mirroredFixtures = BACKEND_FIXTURES.map(([, fileName]) => fileName)
  const missingFixtures = requiredFixtures.filter(fixture => !existsSync(join(specDir, 'conformance', 'fixtures', fixture)))
  expect('the Backend fixture table is exactly TUI-BACKEND-001, and every listed fixture exists on disk',
    [...requiredFixtures].sort().join(',') === [...mirroredFixtures].sort().join(',') && missingFixtures.length === 0,
    `mirror=${[...mirroredFixtures].sort().join(',')} required=${[...requiredFixtures].sort().join(',')} missing=${missingFixtures.join(',')}`)

  // 坏基线：把正例的安装配方拆残，同一条链必须改判为拒绝——证明上面的 pass 不是空转。
  const brokenContribution = fixture('valid-backend-contribution.json') as {
    contributes: Record<string, Array<{ spec: Record<string, unknown> }>>
  }
  const brokenSpec = brokenContribution.contributes['x-dsh-tui']?.[0]?.spec
  if (brokenSpec === undefined) throw new Error('valid-backend-contribution.json carries no x-dsh-tui spec')
  delete (brokenSpec.install as Record<string, unknown>).version
  expectBackend('bad baseline is red: an incomplete install recipe is refused',
    () => backendManifestVerdict('broken-install-recipe.json', brokenContribution), false)

  const spec = {
    id: 'example-agent',
    label: { text: 'Example Agent' },
    shortLabel: 'Example',
    capabilities: ['permissions', 'anything-this-host-does-not-know'],
    grants: [],
  }
  expectBackend('Backend declaration accepts unknown capability names (degraded, not refused)',
    () => validateBackendSpec(spec), true)
  // 与 run.js 同一用例的深比较：未知能力名必须**原样留在**返回的声明里——admission 要在那里
  // 看到它才能把它记成 missingOptional；只验"不抛错"挡不住 validator 未来静默丢名字。
  expect('the declaration keeps every declared capability name, known or not',
    [...validateBackendSpec(spec).capabilities].join(',') === spec.capabilities.join(','))
  expectBackend('Backend native channel is refused in a declaration too',
    () => validateBackendSpec({ ...spec, nativeKey: 'example' }), false)
  expectBackend('Backend confirmation policy refused when it is not one this host implements',
    () => validateBackendSpec({ ...spec, confirmation: { policy: 'trusted' } }), false)
  expectBackend('Backend install recipe must be complete',
    () => validateBackendSpec({ ...spec, install: { executor: 'pnpm-profile-add', specifier: '@example/agent@1.0.0' } }), false)
  expectBackend('Backend declaration shape accepts a host-owned id (the seed is not a contribution)',
    () => validateBackendSpec({ ...spec, id: BACKEND_RESERVED_IDS[0] }), true)
  expectBackend('Backend handler assertion accepts the runtime AgentBackend shape',
    () => assertBackendHandler({ id: 'example-agent', descriptor: {}, detect: async () => ({}), open: async () => ({}), catalog: {}, launch: {} }), true)
  expectBackend('Backend handler assertion refuses a handler without open()',
    () => assertBackendHandler({ id: 'example-agent', detect: async () => ({}) }), false)
  expect('confirm stays the reserved default policy', BACKEND_CONFIRMATION_POLICIES.includes('confirm'))
  expect('the Backend family reserve exactly the registry built-ins',
    [...BACKEND_RESERVED_IDS].join(',') === 'dsh,claude,codex', [...BACKEND_RESERVED_IDS].join(','))
  expect('the Backend declaration validator freezes what it returns',
    Object.isFrozen(validateBackendSpec(spec)) === true)
}

// --- 5. 篡改必败（fail-closed 自检） ---------------------------------------
const tamperedRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-tamper-'))
try {
  copySpec(join(tamperedRoot, 'tui-profile'))
  const privateEntry = data.registry.definitions[0]
  const target = join(tamperedRoot, 'tui-profile', privateEntry.profile)
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n`)
  const tampered = loadSpecData(join(tamperedRoot, 'tui-profile'))
  const drift = tampered ? verifyRegistry(tampered) : ['tampered copy unreadable']
  expect('tampered private profile detected', drift.length === 1 && drift[0].includes(privateEntry.name), drift.join(' | '))
} finally {
  rmSync(tamperedRoot, { recursive: true, force: true })
}

// --- 6. 可解析但错误形状的数据也必须 soft-fail -------------------------------
const malformedRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-malformed-'))
try {
  const malformedSpecDir = join(malformedRoot, 'tui-profile')
  copySpec(malformedSpecDir)
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
  const policySpecDir = join(policyTamperRoot, 'tui-profile')
  copySpec(policySpecDir)
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
console.log(`plugin-spec battery OK (${checks} checks: registry self-check, ${CASES.length} validate fixtures, 8 negotiate scenarios, Backend family (TUI-BACKEND-001), tamper fail-closed)`)
process.exit(0)
