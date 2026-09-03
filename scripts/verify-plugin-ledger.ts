/**
 * 批 5 电池（一）：效果台账（C-060 + 生命周期三元组）。
 *
 *   A. 五种 operation（create/bind/replace/release/cleanup-failed）各一条
 *      落盘且逐条独立过 vendored ledger schema；
 *   B. 生命周期三元组：同 fiber 的 activationInstance 稳定、跨 fiber 相异；
 *      无 identity→'undeclared'；root fiber→'host'；runtimeGenerationId
 *      取 options/宿主 generation；
 *   C. sequence 启动续号：新 runtime 在同一文件上从 max+1 继续；损坏行
 *      跳过不改写；
 *   D. 拒收不落盘：额外字段（additionalProperties:false 天然执行 secret
 *      禁令）与畸形 valueDigest 的记录被丢弃；超长 kind 清洗截断后保留；
 *   E. schema 缺失 fail-closed：全部写入被抑制、文件不创建、warn 恰好一次；
 *   F. 接线端到端：storage open/deny、shortcut register/dispose、status
 *      set/overwrite/dispose、runtime theme create/release/duplicate 经服务
 *      真实落台账且三元组正确；
 *   G. 文件零哨兵值：全文无 undefined/NaN，逐行 JSON 可解析且过 schema；
 *   H. 接线断言：plugin-host apply 挂载序（host→ledger→storage→observer）、
 *      公共 shim 导出、五服务 identity 末参签名。
 *
 * HOME/USERPROFILE 在导入 src 前隔离。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-ledger.ts`.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 隔离 HOME（必须先于任何 src 导入）─────────────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-ledger-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_ADAPTER_MODE = 'new'

const { Context } = await import('@deepseek-ai/cordis')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const { TuiEffectLedgerRuntime, EFFECT_LEDGER_FILE } = await import('../src/dsh-adapter/effect-ledger.js')
const { TuiStatusRuntime } = await import('../src/dsh-adapter/status.js')
const { default: TuiShortcutRuntime } = await import('../src/dsh-adapter/shortcuts.js')
const { default: TuiThemeRuntime } = await import('../src/dsh-adapter/themes.js')
const { loadSpecData } = await import('../src/adapter/standard/registry.js')
const { check: schemaCheck } = await import('../src/adapter/standard/schema-check.js')
const { DATA_DIR } = await import('../src/utils/paths.js')
const { mountAdmitted, testManifest, STORAGE_COORDINATE } = await import('../scripts/lib/plugin-test-utils.js')
import type { LedgerEntry } from '../src/dsh-adapter/effect-ledger.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const cleanup: string[] = [fakeHome]

let checks = 0
const failures: string[] = []
const check1 = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

const ledgerSchema = loadSpecData()?.schemas.ledger as Record<string, unknown>
if (ledgerSchema === undefined) {
  console.error('plugin-ledger battery FAILED: vendored ledger schema unavailable')
  process.exit(1)
}

interface FileRecord {
  sequence: number
  pluginId: string
  activationInstance: string
  runtimeGenerationId: string
  operation: string
  resource: { kind: string; id: string }
  result: string
  errorCode?: string
  replaces?: { resourceId?: string }
  [key: string]: unknown
}
const readRecords = (file: string): FileRecord[] =>
  readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as FileRecord)

/** 一个已通过官方 parser/admission 的插件上下文。 */
const namedCtx = async (host: InstanceType<typeof Context>, plugin: string, id = `com.example.${plugin}`,
  permissions: readonly { name: string; scope: string }[] = [],
  requires: readonly { apiVersion: string; kind: string; optional?: boolean; fallback?: string }[] = [],
): Promise<InstanceType<typeof Context>> => {
  const admitted = await mountAdmitted(host, plugin, testManifest({
    id,
    requires,
    permissions,
  }))
  return admitted.context
}

// ── A/B/C/D 用独立文件，避免互相干扰 ─────────────────────────────────────
const fileA = join(fakeHome, 'ledger-a.jsonl')

// ── A. 五种 operation 各一条且过 schema ──────────────────────────────────
{
  const ctx = new Context()
  const ledger = new TuiEffectLedgerRuntime(ctx, { file: fileA, generationId: 'gen-battery' })
  const admissionRoot = new Context()
  admissionRoot.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await sleep(50)
  const alpha = await namedCtx(admissionRoot, 'alpha')
  const entries: LedgerEntry[] = [
    { operation: 'create', resource: { kind: 'scene', id: 'scene-a' }, result: 'applied' },
    { operation: 'bind', resource: { kind: 'shortcut', id: 'ctrl+shift+z' }, result: 'applied' },
    { operation: 'replace', resource: { kind: 'status', id: 'alpha' }, result: 'applied', replaces: { resourceId: 'alpha' } },
    { operation: 'release', resource: { kind: 'scene', id: 'scene-a' }, result: 'applied' },
    { operation: 'cleanup-failed', resource: { kind: 'subscription', id: 'alpha' }, result: 'failed', errorCode: 'DISPOSE_FAILED' },
  ]
  for (const entry of entries) ledger.record(entry, alpha)
  const records = readRecords(fileA)
  check1('all five operations persisted', records.length === 5, `got ${records.length}`)
  check1(
    'operation multiset matches',
    JSON.stringify(records.map(r => r.operation).sort()) === JSON.stringify(['bind', 'cleanup-failed', 'create', 'release', 'replace']),
    records.map(r => r.operation).join(','),
  )
  let schemaPassed = 0
  for (const record of records) {
    try {
      schemaCheck(record, ledgerSchema, ledgerSchema)
      schemaPassed += 1
    } catch {
      // counted below
    }
  }
  check1('every persisted record passes the vendored schema independently', schemaPassed === records.length, `${schemaPassed}/${records.length}`)

  // ── B. 三元组 ──
  const beta = await namedCtx(admissionRoot, 'beta')
  ledger.record({ operation: 'bind', resource: { kind: 'shortcut', id: 'ctrl+alt+b' }, result: 'applied' }, beta)
  ledger.record({ operation: 'bind', resource: { kind: 'shortcut', id: 'ctrl+alt+c' }, result: 'applied' }) // 无 identity
  ledger.record({ operation: 'bind', resource: { kind: 'shortcut', id: 'ctrl+alt+d' }, result: 'applied' }, ctx) // root fiber
  const all = readRecords(fileA)
  const alphaRecords = all.filter(r => r.pluginId === 'com.example.alpha')
  check1('pluginId = verified manifest Component identity',
    alphaRecords.length === 5 && alphaRecords.every(r => r.pluginId === 'com.example.alpha'), `${alphaRecords.length}`)
  check1('activationInstance stable per fiber', new Set(alphaRecords.map(r => r.activationInstance)).size === 1)
  const betaRecord = all.find(r => r.pluginId === 'com.example.beta')
  check1('second activation gets a distinct activationInstance',
    betaRecord !== undefined && betaRecord.activationInstance !== alphaRecords[0]?.activationInstance)
  const undeclared = all.find(r => r.resource.id === 'ctrl+alt+c')
  check1("missing identity records 'undeclared'",
    undeclared?.pluginId === 'undeclared' && undeclared?.activationInstance === 'undeclared')
  const host = all.find(r => r.resource.id === 'ctrl+alt+d')
  check1("root fiber records 'host'", host?.pluginId === 'host' && host?.activationInstance === 'host')
  check1('runtimeGenerationId from options', all.every(r => r.runtimeGenerationId === 'gen-battery'))

  // ── D. 拒收不落盘 ──
  const before = readRecords(fileA).length
  ledger.record({ operation: 'create', resource: { kind: 'scene', id: 'smuggle' }, result: 'applied', secret: 'payload' } as unknown as LedgerEntry)
  ledger.record({ operation: 'create', resource: { kind: 'scene', id: 'bad-digest' }, result: 'applied', valueDigest: 'not-a-digest' })
  ledger.record({ operation: 'create', resource: { kind: 'x'.repeat(100), id: 'long-kind' }, result: 'applied' }, alpha)
  const after = readRecords(fileA)
  // smuggle 的额外字段根本到不了记录：record() 按 allowlist 逐字段构造，
  // 与 schema 的 additionalProperties:false 构成双保险（记录本身保留）。
  check1('extra field never reaches the record (allowlist construction)', after.length === before + 2, `${after.length} vs ${before}`)
  check1('record with a malformed valueDigest is dropped', !after.some(r => r.resource.id === 'bad-digest'))
  check1('no record carries the smuggled field', !after.some(r => 'secret' in r))
  const smuggled = after.find(r => r.resource.id === 'smuggle')
  check1('the smuggle attempt itself is persisted (clean record)', smuggled !== undefined)
  const longKind = after.find(r => r.resource.id === 'long-kind')
  check1('over-long kind is cleaned to the schema bound and kept', longKind !== undefined && longKind.resource.kind.length === 64)
}

// ── C. sequence 启动续号 + 损坏行跳过 ────────────────────────────────────
{
  const file = join(fakeHome, 'ledger-c.jsonl')
  // 每个 runtime 一个独立 Context：Service 构造即在 ctx 注册同名服务键，
  // 同 ctx 重复 new 会撞键（生产路径每进程只挂一次，无此问题）。
  const first = new TuiEffectLedgerRuntime(new Context(), { file, generationId: 'gen-c' })
  first.record({ operation: 'create', resource: { kind: 'scene', id: 's1' }, result: 'applied' })
  first.record({ operation: 'create', resource: { kind: 'scene', id: 's2' }, result: 'applied' })
  const second = new TuiEffectLedgerRuntime(new Context(), { file, generationId: 'gen-c2' })
  second.record({ operation: 'create', resource: { kind: 'scene', id: 's3' }, result: 'applied' })
  const sequences = readRecords(file).map(r => r.sequence)
  check1('sequence continues across runtimes', JSON.stringify(sequences) === JSON.stringify([0, 1, 2]), sequences.join(','))
  appendFileSync(file, '{corrupt line!!!\n')
  const third = new TuiEffectLedgerRuntime(new Context(), { file, generationId: 'gen-c3' })
  third.record({ operation: 'create', resource: { kind: 'scene', id: 's4' }, result: 'applied' })
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
  check1('corrupt line preserved (never rewritten)', lines.some(l => l.includes('corrupt')))
  const last = JSON.parse(lines[lines.length - 1] ?? '{}') as FileRecord
  check1('sequence resumes after the max valid record despite the corrupt line', last.sequence === 3, `got ${last.sequence}`)
}

// ── E. schema 缺失 fail-closed ───────────────────────────────────────────
{
  const file = join(fakeHome, 'ledger-e.jsonl')
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.warn = (format: unknown, ...params: unknown[]) => {
    warnings.push([format, ...params].map(String).join(' '))
  }
  const ledger = new TuiEffectLedgerRuntime(ctx, { file, generationId: 'gen-e', ledgerSchema: undefined })
  ledger.record({ operation: 'create', resource: { kind: 'scene', id: 'suppressed-1' }, result: 'applied' })
  ledger.record({ operation: 'create', resource: { kind: 'scene', id: 'suppressed-2' }, result: 'applied' })
  check1('missing schema suppresses ALL writes', !existsSync(file))
  const schemaWarns = warnings.filter(w => w.includes('effect ledger schema unavailable'))
  check1('suppression warned exactly once', schemaWarns.length === 1, `${schemaWarns.length}`)
}

// ── F. 接线端到端（完整 plugin-host 行 + storage/shortcuts/status 真实服务）──
{
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: {
      'com.example.alpha': [
        { name: 'storage.local.read', scope: 'com.example.alpha' },
        { name: 'storage.local.write', scope: 'com.example.alpha' },
      ],
    },
  }))
  const ctx = new Context()
  // 生产接线：整行挂载（host → ledger → storage → observer），台账的
  // generationId 来自 tuiPluginHost 服务而非 fallback。
  ctx.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  await sleep(50)
  const ledger = ctx.get('tuiEffectLedger')
  check1('ledger service mounts via the plugin-host row', ledger !== undefined)
  const alpha = await namedCtx(ctx, 'alpha', 'com.example.alpha', [
    { name: 'storage.local.read', scope: 'com.example.alpha' },
    { name: 'storage.local.write', scope: 'com.example.alpha' },
  ], [STORAGE_COORDINATE])
  const gamma = await namedCtx(ctx, 'gamma', 'com.example.gamma', [], [STORAGE_COORDINATE])

  const storage = ctx.get('tuiPluginStorage')
  if (storage === undefined) throw new Error('tuiPluginStorage not mounted by the row')
  storage.open(alpha)
  const gammaHandle = storage.open(gamma)
  try {
    await gammaHandle.get({ key: 'k' })
    failures.push('gamma.get should have been denied')
    checks += 1
  } catch {
    checks += 1 // 拒绝成立（PERMISSION_NOT_GRANTED 由 storage 电池覆盖）
  }

  new TuiShortcutRuntime(ctx)
  const shortcuts = alpha.get('tuiShortcuts') as InstanceType<typeof TuiShortcutRuntime>
  const disposeShortcut = shortcuts.register('ctrl+shift+z', { description: '电池快捷键', handler: () => {} }, alpha)
  disposeShortcut()

  new TuiStatusRuntime(ctx)
  const status = alpha.get('tuiStatus') as InstanceType<typeof TuiStatusRuntime>
  const disposeStatus = status.set('alpha-line', 'v1', alpha)
  status.set('alpha-line', 'v2', alpha)
  disposeStatus() // v1 的 disposer 已被 v2 取代 → 不得再落 release

  new TuiThemeRuntime(ctx)
  const themes = alpha.get('tuiThemes') as InstanceType<typeof TuiThemeRuntime>
  const disposeTheme = themes.register(
    { name: 'alpha:theme', base: 'dark', colors: { claude: '#123456' } },
    alpha,
  )
  themes.register(
    { name: 'alpha:theme', base: 'dark', colors: { claude: '#654321' } },
    alpha,
  )
  disposeTheme()

  const records = readRecords(EFFECT_LEDGER_FILE)
  const byKind = (kind: string, id?: string) => records.filter(r => r.resource.kind === kind && (id === undefined || r.resource.id === id))

  const nsCreates = byKind('storage-namespace').filter(r => r.operation === 'create')
  check1('storage open records namespace create per plugin',
    nsCreates.some(r => r.resource.id === 'com.example.alpha' && r.pluginId === 'com.example.alpha') &&
    nsCreates.some(r => r.resource.id === 'com.example.gamma' && r.pluginId === 'com.example.gamma'))
  const deny = byKind('permission', 'storage.local.read')
  check1('grant deny recorded with PERMISSION_NOT_GRANTED against the denied plugin',
    deny.some(r => r.result === 'failed' && r.errorCode === 'PERMISSION_NOT_GRANTED' && r.pluginId === 'com.example.gamma'))

  const shortcutBinds = byKind('shortcut', 'ctrl+shift+z')
  check1('shortcut register records bind applied with the plugin identity',
    shortcutBinds.some(r => r.operation === 'bind' && r.result === 'applied' && r.pluginId === 'com.example.alpha'))
  check1('shortcut dispose records release applied',
    shortcutBinds.some(r => r.operation === 'release' && r.result === 'applied'))

  const statusRecords = byKind('status', 'alpha-line')
  check1('status first set records bind', statusRecords.some(r => r.operation === 'bind' && r.result === 'applied'))
  const replace = statusRecords.find(r => r.operation === 'replace')
  check1('status overwrite records replace with replaces.resourceId', replace?.replaces?.resourceId === 'alpha-line')
  check1('stale status disposer records nothing', !statusRecords.some(r => r.operation === 'release'))

  const themeRecords = byKind('theme', 'alpha:theme')
  check1('runtime theme register records create with the plugin identity',
    themeRecords.some(r => r.operation === 'create' && r.result === 'applied' && r.pluginId === 'com.example.alpha'))
  check1('runtime theme duplicate records DUPLICATE_CONTRIBUTION_ID',
    themeRecords.some(r => r.operation === 'create' && r.result === 'failed' && r.errorCode === 'DUPLICATE_CONTRIBUTION_ID'))
  check1('runtime theme dispose records release',
    themeRecords.some(r => r.operation === 'release' && r.result === 'applied' && r.pluginId === 'com.example.alpha'))

  const alphaWired = records.filter(r => r.pluginId === 'com.example.alpha')
  check1('wired records share one activationInstance per fiber', new Set(alphaWired.map(r => r.activationInstance)).size === 1)
  check1('wired records carry the host generationId',
    alphaWired.every(r => typeof r.runtimeGenerationId === 'string' && r.runtimeGenerationId !== '' && r.runtimeGenerationId !== 'unknown-generation'))

  // ── G. 文件零哨兵值 ──
  const text = readFileSync(EFFECT_LEDGER_FILE, 'utf8')
  check1("no 'undefined' sentinel in the ledger file", !text.includes('undefined'))
  check1("no 'NaN' sentinel in the ledger file", !text.includes('NaN'))
  let parseable = true
  let schemaOk = 0
  const lines = text.split('\n').filter(l => l.trim() !== '')
  for (const line of lines) {
    try {
      schemaCheck(JSON.parse(line), ledgerSchema, ledgerSchema)
      schemaOk += 1
    } catch {
      parseable = false
    }
  }
  check1('every line of the wired ledger parses and passes the schema', parseable && schemaOk === lines.length, `${schemaOk}/${lines.length}`)
}

// ── H. 接线断言 ───────────────────────────────────────────────────────────
{
  const hostSource = readFileSync(join(root, 'src/dsh-adapter/plugin-host.ts'), 'utf8')
  const hostIdx = hostSource.indexOf('ctx.plugin(TuiPluginHostRuntime)')
  const ledgerIdx = hostSource.indexOf('ctx.plugin(TuiEffectLedgerRuntime)')
  const storageIdx = hostSource.indexOf('ctx.plugin(TuiPluginStorageRuntime)')
  const observerIdx = hostSource.indexOf('ctx.plugin(TuiMessageObserverRuntime)')
  check1('plugin-host mounts host → ledger → storage → observer in order',
    hostIdx !== -1 && ledgerIdx > hostIdx && storageIdx > ledgerIdx && observerIdx > storageIdx)

  const shim = readFileSync(join(root, 'src/plugin-host.ts'), 'utf8')
  check1('public shim exports safe effect-ledger types without host runtime',
    shim.includes('export type { LedgerEntry, LedgerOperation, LedgerResult, TuiEffectLedgerRuntime }')
    && !shim.includes("export * from './dsh-adapter/effect-ledger.js'"))
  check1('public shim exports command error vocabulary without host internals',
    shim.includes('COMMAND_ERROR_CODES')
    && !shim.includes("export * from './dsh-adapter/command-errors.js'"))
  const publicHost = await import('../src/plugin-host.js')
  const hostOnlyExports = [
    'getHostAdmission', 'dispatchTuiNotification', 'decisionHandlersOf',
    'registerDecisionHandler', 'withDecisionRegistration', 'stampCommandOwner',
    'unstampCommandOwner', 'commandOwner', 'fiberNameOf', 'TuiPluginHostRuntime',
    'TuiPluginStorageRuntime', 'TuiMessageObserverRuntime', 'TuiEffectLedgerRuntime',
  ] as const
  check1('public shim hides loader, ingress, attribution and host runtime exports',
    hostOnlyExports.every(name => !(name in publicHost)))
  check1('public shim retains the Cordis row entry points',
    typeof publicHost.name === 'string' && typeof publicHost.apply === 'function')

  const identityParam = (path: string, method: string) => {
    const source = readFileSync(join(root, path), 'utf8')
    return source.includes(`${method}, identity?: Context)`) || source.includes(`${method}?: Context)`)
  }
  check1('tuiShortcuts.register takes the optional identity param',
    identityParam('src/dsh-adapter/shortcuts.ts', 'options: TuiShortcutOptions'))
  check1('tuiScenes.register takes the optional identity param',
    identityParam('src/dsh-adapter/scenes.ts', 'descriptor: TuiSceneDescriptor'))
  check1('tuiStatus.set takes the optional identity param',
    identityParam('src/dsh-adapter/status.ts', "text: string | number | boolean | undefined"))
  check1('tuiRenderers.register takes the optional identity param',
    identityParam('src/dsh-adapter/renderers.ts', 'renderer: TuiEntryRenderer'))
  check1('tuiThemes.register takes the optional identity param',
    identityParam('src/dsh-adapter/themes.ts', 'descriptor: TuiThemeDescriptor'))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-ledger battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-ledger battery OK (${checks} checks: five operations, lifecycle triple, sequence resume, drop-not-write, fail-closed, wired emitters, no sentinels, wiring)`)
process.exit(0)
