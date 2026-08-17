/**
 * 批 2 电池：8 权限统一 GrantStore、plugin-host row 与 Host Descriptor 构建。
 *
 *   A. GrantStore 语义：旧格式行为逐条一致、默认值 registry 驱动（7 deny +
 *      invoke allow）、denies 撤销、未注册权限 fail-closed、损坏 fail-closed；
 *   B. decision-guard 薄壳后行为不变（readGrantStore 真文件路径）；
 *   C. plugin-host row：真 cordis 挂载、generationId 稳定且跨实例不同、
 *      descriptor 过 vendored schema + validateHost、selfCheck 全绿、
 *      bare ctx 软降级；
 *   D. buildHostDescriptor 纯函数：默认构建逐字段、篡改 contract 文件剔除
 *      + warn、数据缺失降级、与 negotiate 组合（degraded）；
 *   E. patch 面与 exports 接线（row 在 extensions 之前、./plugin-host 出口）。
 *
 * HOME/USERPROFILE 在导入 src 前隔离（plugin-host row 挂载会读默认
 * DATA_DIR 的 grants 文件）。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-grants.ts`.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 隔离 HOME（必须先于任何 src 导入）─────────────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-grants-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'

const { Context } = await import('@deepseek-ai/cordis')
const { parseGrantStore, readGrantStore, EXTENSION_GRANTS_FILE } = await import('../src/dsh-adapter/grants.js')
const { installDecisionGuard, DECISION_EVENT_PERMISSIONS } = await import('../src/dsh-adapter/decision-guard.js')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const { buildHostDescriptor, HOST_SUPPORTED_CONTRACTS, readOwnPackageVersion } = await import('../src/dsh-adapter/host-descriptor.js')
const { loadSpecData, digestFile } = await import('../src/plugin-spec/registry.js')
const { createContractIndex, validateHost } = await import('../src/plugin-spec/validate.js')
const { check } = await import('../src/plugin-spec/schema-check.js')
const { negotiate } = await import('../src/plugin-spec/negotiate.js')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const specDir = join(root, 'ecosystem-spec')
const data = loadSpecData(specDir)
if (!data) {
  console.error('vendored spec data unreadable (ecosystem-spec/)')
  process.exit(1)
}
const index = createContractIndex(data.registry, data.permissions)
const REGISTRY_PERMISSIONS = data.permissions.permissions.map(p => p.name)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
const failures: string[] = []
const check1 = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}
const cleanup: string[] = [fakeHome]

// ── A. GrantStore 语义 ────────────────────────────────────────────────────
{
  // A1. 旧格式文件（仅 grants 段，4 个 intercept 权限授给 root）行为逐条一致。
  const oldFormat = JSON.stringify({
    grants: { root: ['session.input.intercept', 'session.rewind.intercept', 'session.switch.intercept', 'session.compact.intercept'] },
  })
  const oldStore = parseGrantStore(oldFormat)
  for (const permission of Object.values(DECISION_EVENT_PERMISSIONS)) {
    check1(`old format: root holds ${permission}`, oldStore.allows('root', permission))
    check1(`old format: other plugin denied ${permission}`, !oldStore.allows('other', permission))
  }
  check1('old format: storage stays denied', !oldStore.allows('root', 'storage.local.read'))
  check1('old format: not corrupt', !oldStore.corrupt)

  // A2. 默认值 registry 驱动：空 store（= 文件缺失）→ 7 deny + invoke allow。
  const empty = parseGrantStore('')
  for (const entry of data.permissions.permissions) {
    check1(`registry default: ${entry.name} = ${entry.default}`, empty.defaultOf(entry.name) === entry.default)
    check1(`empty store: ${entry.name} ${entry.default === 'allow' ? 'allowed' : 'denied'} by default`,
      empty.allows('anyone', entry.name) === (entry.default === 'allow'))
  }
  check1('knownPermissions mirrors the vendored registry',
    JSON.stringify(empty.knownPermissions()) === JSON.stringify(REGISTRY_PERMISSIONS))
  check1('8 permissions registered', REGISTRY_PERMISSIONS.length === 8)

  // A3. denies 撤销 allow-default；显式 grant 授予 deny-default。
  const mixed = parseGrantStore(JSON.stringify({
    grants: { guard: ['session.input.intercept'] },
    denies: { noisy: ['commands.invoke'], conflicted: ['commands.invoke'] },
  }))
  check1('denies revokes allow-default', !mixed.allows('noisy', 'commands.invoke'))
  check1('denies does not affect other plugins', mixed.allows('other', 'commands.invoke'))
  check1('grant of deny-default allowed', mixed.allows('guard', 'session.input.intercept'))

  // A4. grants 与 denies 同列同权限 → denies 优先（撤销是安全操作）。
  const conflict = parseGrantStore(JSON.stringify({
    grants: { conflicted: ['commands.invoke'] },
    denies: { conflicted: ['commands.invoke'] },
  }))
  check1('deny wins over grant on conflict', !conflict.allows('conflicted', 'commands.invoke'))

  // A5. 未注册权限一律 deny——即使文件里显式授予。
  const bogus = parseGrantStore(JSON.stringify({ grants: { root: ['bogus.permission'] } }))
  check1('unregistered permission denied even when granted', !bogus.allows('root', 'bogus.permission'))
  check1('defaultOf unregistered is deny', bogus.defaultOf('bogus.permission') === 'deny')

  // A6. 损坏 fail-closed：连 allow-default 也拒。
  const corrupt = parseGrantStore('{ not json')
  check1('corrupt store flagged', corrupt.corrupt)
  check1('corrupt store denies deny-default', !corrupt.allows('root', 'session.input.intercept'))
  check1('corrupt store denies allow-default too', !corrupt.allows('root', 'commands.invoke'))

  // A7. wrong-shape 不算 corrupt——只是没有条目，走 registry 默认。
  const wrongShape = parseGrantStore(JSON.stringify({ grants: [1, 2, 3], denies: 'nope' }))
  check1('wrong-shape is not corrupt', !wrongShape.corrupt)
  check1('wrong-shape falls back to defaults (invoke allow)', wrongShape.allows('anyone', 'commands.invoke'))
  check1('wrong-shape falls back to defaults (intercept deny)', !wrongShape.allows('anyone', 'session.input.intercept'))

  // A8. 注入 registry 证明 store 完全 registry 驱动（无硬编码权限名）。
  const custom = parseGrantStore('', {
    registryVersion: 'test',
    permissions: [{ name: 'custom.allow', default: 'allow', revocable: true, scope: 'test' }],
  })
  check1('injected registry: custom permission allow-default', custom.allows('p', 'custom.allow'))
  check1('injected registry: vendored names unknown', !custom.allows('p', 'commands.invoke'))

  // A9. readGrantStore：缺失文件 = 全默认（非 corrupt）。
  const missingDir = mkdtempSync(join(tmpdir(), 'dsh-grants-missing-'))
  cleanup.push(missingDir)
  const missing = readGrantStore(missingDir)
  check1('missing file is not corrupt', !missing.corrupt)
  check1('missing file gives registry defaults', missing.allows('anyone', 'commands.invoke') && !missing.allows('anyone', 'session.input.intercept'))
}

// ── B. decision-guard 薄壳后行为不变（真文件路径）────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grants-guard-'))
  cleanup.push(dir)
  writeFileSync(join(dir, EXTENSION_GRANTS_FILE), JSON.stringify({
    grants: { 'my-guard': ['session.input.intercept'] },
  }))
  const guardCtx = new Context()
  const guardWarnings: string[] = []
  guardCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
    guardWarnings.push([format, ...params].map(String).join(' '))
  }
  installDecisionGuard(guardCtx, readGrantStore(dir))
  guardCtx.plugin({
    name: 'my-guard',
    apply: (c: InstanceType<typeof Context>) => {
      c.on('tui/input', (event: { text?: string }) =>
        event.text === '拦截' ? { cancel: true, reason: '授权拦截' } : undefined)
    },
  })
  guardCtx.plugin({
    name: 'evil-plugin',
    apply: (c: InstanceType<typeof Context>) => {
      c.on('tui/input', () => ({ cancel: true, reason: '不该生效' }))
    },
  })
  await sleep(100)
  const { dispatchTuiDecision } = await import('../src/dsh-adapter/extension-events.js')
  const passThrough = (result: unknown): unknown => result
  check1('guard via GrantStore: granted subscription enters the chain',
    (await dispatchTuiDecision(guardCtx, 'tui/input', { text: '拦截' }, passThrough)) !== undefined)
  // '别的' 只有授权的 guard 看到（它不拦截）；evil-plugin 若混进链会无条件
  // 拦截——undefined 证明它从未注册。
  check1('guard via GrantStore: ungranted subscription never enters the chain',
    (await dispatchTuiDecision(guardCtx, 'tui/input', { text: '别的' }, passThrough)) === undefined)
  check1('guard via GrantStore: denial warns with plugin + grant',
    guardWarnings.some(line => line.includes('"evil-plugin"') && line.includes('session.input.intercept')))
}

// ── C. plugin-host row ────────────────────────────────────────────────────
{
  const hostCtx = new Context()
  const hostWarnings: string[] = []
  hostCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
    hostWarnings.push([format, ...params].map(String).join(' '))
  }
  hostCtx.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await sleep(50)
  const service = hostCtx.get('tuiPluginHost')
  check1('tuiPluginHost mounted', service !== undefined)
  if (service) {
    check1('generationId matches the descriptor schema pattern', /^[A-Za-z0-9._:-]+$/.test(service.generationId))
    check1('generationId stable within the activation', service.generationId === service.generationId)
    check1('selfCheck clean on vendored data', service.selfCheck().length === 0, service.selfCheck().join(' | '))
    check1('grants store is callable', typeof service.grants.allows === 'function')
    // 隔离 HOME 里无 grants 文件 → registry 默认（invoke allow / intercept deny）。
    check1('service grants: registry defaults from empty HOME',
      service.grants.allows('root', 'commands.invoke') && !service.grants.allows('root', 'session.input.intercept'))

    const descriptor = service.hostDescriptor()
    let descriptorError = ''
    try {
      check(descriptor, data.schemas.host, data.schemas.host)
      validateHost(index, descriptor)
    } catch (error) {
      descriptorError = error instanceof Error ? error.message : String(error)
    }
    check1('service descriptor passes vendored schema + validateHost', descriptorError === '', descriptorError)
    check1('descriptor generationId is the runtime generation', descriptor.runtime.generationId === service.generationId)
    check1('descriptor cached (same object)', service.hostDescriptor() === descriptor)
    check1('no boot warnings on clean data', hostWarnings.length === 0, hostWarnings.join(' | '))
  }

  // 跨激活 generationId 不同（两个独立 root 各挂一次）。
  const secondCtx = new Context()
  secondCtx.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await sleep(50)
  check1('generationId differs across activations',
    secondCtx.get('tuiPluginHost')?.generationId !== hostCtx.get('tuiPluginHost')?.generationId)

  // bare ctx 软降级：没有行的上下文 get 不到，消费方静默降级。
  check1('bare ctx soft-degrades (no row, no throw)', new Context().get('tuiPluginHost') === undefined)
}

// ── D. buildHostDescriptor 纯函数 ─────────────────────────────────────────
{
  const build = buildHostDescriptor({ generationId: 'test-gen-1' })
  check1('default build drops nothing', build.dropped.length === 0, build.dropped.join(' | '))
  check1('default build warns nothing', build.warnings.length === 0, build.warnings.join(' | '))
  const d = build.descriptor
  let error = ''
  try {
    check(d, data.schemas.host, data.schemas.host)
    validateHost(index, d)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  check1('default descriptor passes vendored schema + validateHost', error === '', error)
  check1('hostId is dsh-tui', d.hostId === 'dsh-tui')
  check1('hostVersion is the repo package version',
    d.hostVersion === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
  check1('readOwnPackageVersion agrees', readOwnPackageVersion() === d.hostVersion)
  check1('facetApiVersions from registry', JSON.stringify(d.facetApiVersions) === JSON.stringify(data.registry.facetApiVersions))
  check1('trustLevel trusted-in-process', d.trustLevel === 'trusted-in-process')
  check1('platform matches the process', d.platform.os === process.platform && d.platform.arch === process.arch)
  check1('runtime local + headless false + generation stamped',
    d.runtime.location === 'local' && d.runtime.headless === false && d.runtime.generationId === 'test-gen-1')
  check1('advertised surface = HOST_SUPPORTED_CONTRACTS',
    d.contracts.length === HOST_SUPPORTED_CONTRACTS.length
    && d.contracts.every(c => HOST_SUPPORTED_CONTRACTS.some(s => s.apiVersion === c.apiVersion && s.kind === c.kind)))
  const command = d.contracts.find(c => c.kind === 'Command')
  check1('Command contract pinned to the registry hash',
    command !== undefined && command.schemaHash === digestFile(specDir, 'registry/contracts/commands-0.15.json'))
  check1('Command contract carries registry permissions',
    JSON.stringify(command?.permissions) === JSON.stringify(['commands.invoke']))

  // D2. 篡改 contract 文件 → 剔除 + warn（fail closed），descriptor 仍过 schema。
  const tamperedRoot = mkdtempSync(join(tmpdir(), 'dsh-descriptor-tamper-'))
  cleanup.push(tamperedRoot)
  cpSync(specDir, join(tamperedRoot, 'ecosystem-spec'), { recursive: true })
  const target = join(tamperedRoot, 'ecosystem-spec', 'registry', 'contracts', 'commands-0.15.json')
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n`)
  const tampered = buildHostDescriptor({ generationId: 'test-gen-2', specDir: join(tamperedRoot, 'ecosystem-spec') })
  check1('tampered contract dropped', tampered.dropped.includes('commands.dsh/v1alpha1#Command'), tampered.dropped.join(' | '))
  check1('tamper warning names the drift', tampered.warnings.some(w => w.includes('schemaHash drifted')))
  check1('tampered surface keeps only the untampered contracts',
    tampered.descriptor.contracts.length === HOST_SUPPORTED_CONTRACTS.length - 1
    && !tampered.descriptor.contracts.some(c => c.kind === 'Command'))
  let tamperedError = ''
  try {
    check(tampered.descriptor, data.schemas.host, data.schemas.host)
  } catch (caught) {
    tamperedError = caught instanceof Error ? caught.message : String(caught)
  }
  check1('all-dropped descriptor still schema-valid', tamperedError === '', tamperedError)

  // D3. 数据目录缺失 → 降级为空面 + warn，不抛。
  const missing = buildHostDescriptor({ generationId: 'test-gen-3', specDir: join(tamperedRoot, 'no-such-dir') })
  check1('missing spec data degrades to empty surface', missing.descriptor.contracts.length === 0)
  check1('missing spec data warns', missing.warnings.some(w => w.includes('unavailable')))

  // D4. 与 negotiate 组合：descriptor 现声明全部三契约，valid-plugin 的
  // 必填（Command）与可选（observe）都可满足 → compatible。
  const validPlugin = JSON.parse(readFileSync(join(specDir, 'conformance/fixtures/valid-plugin.json'), 'utf8'))
  const decision = negotiate(index, validPlugin, d)
  check1('negotiate against the built descriptor: compatible',
    decision.decision === 'compatible',
    JSON.stringify(decision))
}

// ── E. patch 面与 exports 接线 ────────────────────────────────────────────
{
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const mirror = readFileSync(join(root, 'cordis.yml'), 'utf8')
  check1('patch mounts plugin-host BEFORE extensions',
    patch.indexOf('dsh-tui-plugin-host') !== -1 && patch.indexOf('dsh-tui-plugin-host') < patch.indexOf('dsh-tui-extensions'))
  check1('cordis.yml mirrors the row BEFORE extensions',
    mirror.indexOf('dsh-tui-plugin-host') !== -1 && mirror.indexOf('dsh-tui-plugin-host') < mirror.indexOf('dsh-tui-extensions'))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check1('exports exposes ./plugin-host',
    manifest.exports?.['./plugin-host']?.import === './lib/types/plugin-host.js')
  check1('compiled entry exists after build', existsSync(join(root, 'lib/types/plugin-host.js')))
  const snapshot = JSON.parse(readFileSync(join(root, 'patch-surface.snapshot.json'), 'utf8'))
  check1('snapshot records the insert before extensions',
    snapshot.inserts.indexOf('dsh-tui-plugin-host') !== -1
    && snapshot.inserts.indexOf('dsh-tui-plugin-host') === snapshot.inserts.indexOf('dsh-tui-extensions') - 1)
  // 入口行 inject 纪律（#183）：新服务绝不进入 entry-level inject。
  check1('entry inject list NOT extended with tuiPluginHost', !mirror.includes('tuiPluginHost'))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-grants battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-grants battery OK (${checks} checks: grant store semantics, guard via GrantStore, plugin-host row, descriptor build, wiring)`)
process.exit(0)
