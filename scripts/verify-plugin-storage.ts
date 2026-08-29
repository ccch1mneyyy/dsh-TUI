/**
 * 批 3 电池：storage.local 契约面（C-040）。
 *
 *   A. 往返语义：get/set/delete、缺席键 get→null / delete→false、JSON 全
 *      类型往返、覆盖写；
 *   B. 授权：无 grant 拒且不落盘、read-only grant 时 set/delete 拒、撤销
 *      后（新 store，模拟改文件+重启）调用即败；
 *   C. 参数校验：非法 key（空/超长/控制字符/非字符串）与不可 JSON 序列化
 *      值一律带 code=INVALID_KEY；
 *   D. namespace 隔离与文件名清洗：两个插件各写各的文件互不可见；scoped
 *      名可逆编码、'.'/'..'/空兜底；
 *   E. quota 双阈值：256 keys、256 KiB，超限拒写且文件不变；
 *   F. 损坏保文件：get/set 均 STORAGE_UNAVAILABLE，字节原样保留；非对象
 *      文档同等待遇；
 *   G. 生命周期：同 namespace 双 handle 共享调用序链；unload 只关自己的
 *      handle，disposer 幂等；
 *   H. 隐私：日志永不出现 key/value 材料；
 *   I. descriptor 现声明 LocalStorage 契约（含双权限）。
 *
 * HOME/USERPROFILE 在导入 src 前隔离。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-storage.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 隔离 HOME（必须先于任何 src 导入）─────────────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-storage-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'

const { Context } = await import('@deepseek-ai/cordis')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const {
  PluginStorageError,
  STORAGE_MAX_BYTES,
  STORAGE_MAX_KEYS,
  storageFileName,
  PLUGIN_STORAGE_DIR,
} = await import('../src/dsh-adapter/plugin-storage.js')
const { buildHostDescriptor } = await import('../src/dsh-adapter/host-descriptor.js')
const { readGrantStore } = await import('../src/dsh-adapter/grants.js')
const { TuiPluginStorageRuntime } = await import('../src/dsh-adapter/plugin-storage.js')
const { DATA_DIR } = await import('../src/utils/paths.js')
const { mountAdmitted, testManifest, STORAGE_COORDINATE } = await import('../src/dsh-adapter/plugin-test-utils.js')
import type { TuiPluginStorage } from '../src/dsh-adapter/plugin-storage.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const cleanup: string[] = [fakeHome]

let checks = 0
const failures: string[] = []
const check1 = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}
const expectCode = async (name: string, code: string, action: () => Promise<unknown>) => {
  checks += 1
  try {
    await action()
    failures.push(`${name}: expected ${code} but resolved`)
  } catch (error) {
    if (!(error instanceof PluginStorageError && error.code === code)) {
      failures.push(`${name}: expected ${code}, got ${error instanceof Error ? `${error.name}(${String((error as { code?: unknown }).code)})` : String(error)}`)
    }
  }
}

// ── 授权文件：各个已 admission 的 Component 按 manifest ID 获得 scoped 授权 ──
mkdirSync(DATA_DIR, { recursive: true })
const componentId = (plugin: string) => `com.example.${plugin}`
const storageGrant = (plugin: string, name: string) => ({ name, scope: componentId(plugin) })
const GRANTS_READ_WRITE = (plugin: string) => [
  storageGrant(plugin, 'storage.local.read'),
  storageGrant(plugin, 'storage.local.write'),
]
writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
  grants: {
    'com.example.alpha': GRANTS_READ_WRITE('alpha'),
    'com.example.beta': GRANTS_READ_WRITE('beta'),
    'com.example.heavy': GRANTS_READ_WRITE('heavy'),
    'com.example.fresh': GRANTS_READ_WRITE('fresh'),
    'com.example.reader': [storageGrant('reader', 'storage.local.read')],
  },
}))
const storageRoot = join(DATA_DIR, PLUGIN_STORAGE_DIR)

const hostCtx = new Context()
const hostWarnings: string[] = []
hostCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
  hostWarnings.push([format, ...params].map(String).join(' '))
}
hostCtx.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
await sleep(50)

const handles = new Map<string, TuiPluginStorage>()
const activations = new Map<string, { context: InstanceType<typeof Context>; fiber: { dispose(): unknown } }>()
const openAs = async (plugin: string, permissions: readonly { name: string; scope: string }[] = GRANTS_READ_WRITE(plugin)) => {
  const admitted = await mountAdmitted(hostCtx, plugin, testManifest({
    id: componentId(plugin),
    requires: [STORAGE_COORDINATE],
    permissions,
  }))
  const service = admitted.context.get('tuiPluginStorage')
  if (service === undefined) throw new Error('tuiPluginStorage not mounted')
  handles.set(plugin, service.open(admitted.context))
  activations.set(plugin, admitted)
}
const handle = (plugin: string): TuiPluginStorage => {
  const found = handles.get(plugin)
  if (!found) throw new Error(`no handle for ${plugin}`)
  return found
}

await openAs('alpha')
await openAs('beta')
await openAs('heavy')
await openAs('fresh')
await openAs('reader', [storageGrant('reader', 'storage.local.read')])
await openAs('gamma', [])

// ── A. 往返语义 ───────────────────────────────────────────────────────────
{
  const alpha = handle('alpha')
  check1('get on absent key resolves null', (await alpha.get({ key: 'missing' })).value === null)
  check1('set resolves stored=true', (await alpha.set({ key: 'k1', value: { deep: [1, 'two', true] } })).stored === true)
  check1('round-trip returns the value', JSON.stringify((await alpha.get({ key: 'k1' })).value) === JSON.stringify({ deep: [1, 'two', true] }))
  check1('overwrite resolves stored=true', (await alpha.set({ key: 'k1', value: 'plain' })).stored === true)
  check1('overwrite visible', (await alpha.get({ key: 'k1' })).value === 'plain')
  for (const [label, value] of [['number', 42], ['boolean', false], ['null', null], ['array', [1, 2]], ['string', 'x']] as const) {
    await alpha.set({ key: `type-${label}`, value })
    check1(`JSON ${label} round-trips`, JSON.stringify((await alpha.get({ key: `type-${label}` })).value) === JSON.stringify(value))
  }
  check1('delete on present key resolves deleted=true', (await alpha.delete({ key: 'k1' })).deleted === true)
  check1('deleted key reads null', (await alpha.get({ key: 'k1' })).value === null)
  check1('delete on absent key resolves deleted=false', (await alpha.delete({ key: 'k1' })).deleted === false)
  check1('namespace file uses the verified manifest Component identity',
    existsSync(join(storageRoot, 'com.example.alpha.json'))
    && !existsSync(join(storageRoot, 'alpha.json')))
}

// ── B. 授权 ───────────────────────────────────────────────────────────────
{
  // 无 grant：拒，且不落盘。
  await expectCode('ungranted get denied', 'PERMISSION_NOT_GRANTED', () => handle('gamma').get({ key: 'x' }))
  await expectCode('ungranted set denied', 'PERMISSION_NOT_GRANTED', () => handle('gamma').set({ key: 'x', value: 1 }))
  await expectCode('ungranted delete denied', 'PERMISSION_NOT_GRANTED', () => handle('gamma').delete({ key: 'x' }))
  check1('denied plugin never lands a file', !existsSync(join(storageRoot, 'gamma.json')))

  // read-only：get 通，set/delete 拒。
  check1('read-only grant: get works', (await handle('reader').get({ key: 'anything' })).value === null)
  await expectCode('read-only grant: set denied', 'PERMISSION_NOT_GRANTED', () => handle('reader').set({ key: 'x', value: 1 }))
  await expectCode('read-only grant: delete denied', 'PERMISSION_NOT_GRANTED', () => handle('reader').delete({ key: 'x' }))

  // 撤销（= 改文件 + 重启，以独立 runtime + 重读 store 模拟）：调用即败。
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: { 'com.example.alpha': [storageGrant('alpha', 'storage.local.read')] },
  }))
  const revokedHandle = handle('alpha')
  check1('revoked runtime: surviving read grant still works', (await revokedHandle.get({ key: 'anything' })).value === null)
  await expectCode('revoked runtime: write fails immediately', 'PERMISSION_NOT_GRANTED', () => revokedHandle.set({ key: 'x', value: 1 }))
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: {
      'com.example.alpha': GRANTS_READ_WRITE('alpha'),
      'com.example.beta': GRANTS_READ_WRITE('beta'),
      'com.example.heavy': GRANTS_READ_WRITE('heavy'),
      'com.example.fresh': GRANTS_READ_WRITE('fresh'),
      'com.example.reader': [storageGrant('reader', 'storage.local.read')],
    },
  }))
}

// ── C. 参数校验 ───────────────────────────────────────────────────────────
{
  const alpha = handle('alpha')
  for (const [label, key] of [['empty', ''], ['too long', 'x'.repeat(129)], ['control char', 'a\nb'], ['non-string', 42]] as const) {
    await expectCode(`invalid key (${label})`, 'INVALID_KEY', () => alpha.get({ key: key as string }))
  }
  await expectCode('undefined value rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-value', value: undefined }))
  const circular: { self?: unknown } = {}
  circular.self = circular
  await expectCode('circular value rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-value', value: circular }))
  await expectCode('bigint value rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-value', value: 1n }))
  check1('rejections left no residue key', (await alpha.get({ key: 'bad-value' })).value === null)

  // P2-6：JSON.stringify 会静默变形的输入一律拒绝（往返不得说谎）。
  await expectCode('NaN rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-nan', value: Number.NaN }))
  await expectCode('Infinity rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-inf', value: Number.POSITIVE_INFINITY }))
  await expectCode('-Infinity rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-neg-inf', value: Number.NEGATIVE_INFINITY }))
  await expectCode('undefined array item rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-arr', value: [1, undefined, 3] }))
  await expectCode('undefined object property rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-obj', value: { a: undefined } }))
  // eslint-disable-next-line no-sparse-arrays
  await expectCode('sparse array rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-sparse', value: new Array(3) }))
  await expectCode('function value rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-fn', value: () => 1 }))
  await expectCode('symbol value rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-sym', value: Symbol('s') }))
  class SomeClass { a = 1 }
  await expectCode('class instance rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-class', value: new SomeClass() }))
  await expectCode('toJSON-carrying object rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-tojson', value: { toJSON: () => ({}) } }))
  const arrayWithToJSON = Object.assign([1], { toJSON: () => undefined })
  await expectCode('array toJSON hook rejected before it can erase the stored key', 'INVALID_VALUE', () => alpha.set({ key: 'bad-array-tojson', value: arrayWithToJSON }))
  const hiddenToJSON: Record<string, unknown> = {}
  Object.defineProperty(hiddenToJSON, 'toJSON', { value: () => undefined })
  await expectCode('non-enumerable toJSON hook rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-hidden-tojson', value: hiddenToJSON }))
  const hiddenProperty: Record<string, unknown> = { visible: true }
  Object.defineProperty(hiddenProperty, 'hidden', { value: true })
  await expectCode('non-enumerable own property rejected', 'INVALID_VALUE', () => alpha.set({ key: 'bad-hidden-property', value: hiddenProperty }))
  // DAG（共享引用无环）合法——stringify 展开重复，不说谎。
  const shared = { x: 1 }
  check1('DAG (shared reference, no cycle) accepted', (await alpha.set({ key: 'dag', value: { left: shared, right: shared } })).stored === true)
  check1('DAG round-trips expanded',
    JSON.stringify((await alpha.get({ key: 'dag' })).value) === JSON.stringify({ left: { x: 1 }, right: { x: 1 } }))

  // P2-5：原型链名就是普通数据——不读宿主原型、不伪造存在性、不污染。
  check1('get("toString") on an empty key is null (no prototype leak)', (await alpha.get({ key: 'toString' })).value === null)
  check1('get("constructor") is null', (await alpha.get({ key: 'constructor' })).value === null)
  check1('delete("toString") is false (no fake membership)', (await alpha.delete({ key: 'toString' })).deleted === false)
  check1('set("__proto__") stores ordinary data', (await alpha.set({ key: '__proto__', value: { polluted: false } })).stored === true)
  check1('get("__proto__") returns the stored own value',
    JSON.stringify((await alpha.get({ key: '__proto__' })).value) === JSON.stringify({ polluted: false }))
  check1('Object.prototype untouched by the __proto__ write',
    ({} as { polluted?: unknown }).polluted === undefined)
  check1('delete("__proto__") is true', (await alpha.delete({ key: '__proto__' })).deleted === true)
  check1('post-delete get("__proto__") is null', (await alpha.get({ key: '__proto__' })).value === null)
  // 落盘往返后仍是自有属性语义（readTable 的 null 原型重建）。
  check1('set("toString") shadows the prototype as own data', (await alpha.set({ key: 'toString', value: 'own' })).stored === true)
  check1('get("toString") returns the stored string', (await alpha.get({ key: 'toString' })).value === 'own')
  check1('delete("toString") now true', (await alpha.delete({ key: 'toString' })).deleted === true)

  // The namespace has no file yet: this exercises the ENOENT table shape,
  // not only the null-prototype reconstruction of an existing document.
  const fresh = handle('fresh')
  check1('new namespace set("__proto__") stores ordinary data',
    (await fresh.set({ key: '__proto__', value: { from: 'new-table' } })).stored === true)
  check1('new namespace get("__proto__") round-trips the stored value',
    JSON.stringify((await fresh.get({ key: '__proto__' })).value) === JSON.stringify({ from: 'new-table' }))
}

// ── D. namespace 隔离与文件名清洗 ─────────────────────────────────────────
{
  await handle('beta').set({ key: 'shared-key', value: 'beta-value' })
  await handle('alpha').set({ key: 'shared-key', value: 'alpha-value' })
  check1('namespaces are isolated on disk', existsSync(join(storageRoot, `${storageFileName(componentId('beta'))}.json`)))
  check1('beta reads its own value', (await handle('beta').get({ key: 'shared-key' })).value === 'beta-value')
  check1('alpha reads its own value', (await handle('alpha').get({ key: 'shared-key' })).value === 'alpha-value')
  check1('scoped name encodes reversibly', storageFileName('@scope/pkg') === encodeURIComponent('@scope/pkg'))
  check1('plain names pass through', storageFileName('alpha') === 'alpha')
  check1("'.' and '..' map to the safe fallback", storageFileName('.') === '_' && storageFileName('..') === '_')
  check1('empty name maps to the safe fallback', storageFileName('') === '_')
}

// ── E. quota 双阈值 ───────────────────────────────────────────────────────
{
  // keys 阈值：heavy 写满 256 个键后第 257 个拒。
  const heavy = handle('heavy')
  for (let i = 0; i < STORAGE_MAX_KEYS; i++) {
    await heavy.set({ key: `quota-${String(i).padStart(3, '0')}`, value: i })
  }
  await expectCode('key 257 hits the keys quota', 'QUOTA_EXCEEDED', () => heavy.set({ key: 'quota-overflow', value: 1 }))
  check1('quota rejection wrote nothing', (await heavy.get({ key: 'quota-overflow' })).value === null)

  // 字节阈值：更新既有键塞入超大值 → 拒，原值不变。
  const huge = 'h'.repeat(STORAGE_MAX_BYTES)
  await expectCode('oversized update hits the bytes quota', 'QUOTA_EXCEEDED', () => heavy.set({ key: 'quota-000', value: huge }))
  check1('bytes rejection kept the old value', (await heavy.get({ key: 'quota-000' })).value === 0)

  // beta 用几乎空的 namespace 验证单写即超限。
  await expectCode('single oversized write rejected', 'QUOTA_EXCEEDED', () => handle('beta').set({ key: 'huge', value: huge }))
}

// ── F. 损坏保文件 ─────────────────────────────────────────────────────────
{
  const file = join(storageRoot, `${storageFileName(componentId('beta'))}.json`)
  writeFileSync(file, '{ not json at all')
  await expectCode('corrupt namespace: get fails', 'STORAGE_UNAVAILABLE', () => handle('beta').get({ key: 'x' }))
  await expectCode('corrupt namespace: set fails (never auto-overwrite)', 'STORAGE_UNAVAILABLE', () => handle('beta').set({ key: 'x', value: 1 }))
  check1('corrupt bytes preserved verbatim', readFileSync(file, 'utf8') === '{ not json at all')

  // 非对象文档同样按不可用处理。
  writeFileSync(file, '[1,2,3]')
  await expectCode('non-object document: get fails', 'STORAGE_UNAVAILABLE', () => handle('beta').get({ key: 'x' }))
}

// ── G. 生命周期 ───────────────────────────────────────────────────────────
{
  // 同 namespace 双 handle 共享调用序链：并发两写按调用序落定。
  const service = hostCtx.get('tuiPluginStorage')
  const alphaContext = activations.get('alpha')!.context
  const first = service.open(alphaContext)
  const second = service.open(alphaContext)
  const write1 = first.set({ key: 'order', value: 'first' })
  const write2 = second.set({ key: 'order', value: 'second' })
  await Promise.all([write1, write2])
  check1('concurrent writes settle in invocation order', (await first.get({ key: 'order' })).value === 'second')

  // unload 只关自己的 handle：挂一个同名 alpha 的 closer 插件再 dispose——
  // alpha 的原 handle 必须继续工作（closed 是 handle 级，不是 namespace 级）。
  const closer = await mountAdmitted(hostCtx, 'alpha-closer', testManifest({
    id: componentId('alpha'),
    requires: [STORAGE_COORDINATE],
    permissions: [storageGrant('alpha', 'storage.local.read'), storageGrant('alpha', 'storage.local.write')],
  }))
  const closerHandle = closer.context.get('tuiPluginStorage')!.open(closer.context)
  await closerHandle.set({ key: 'closer-key', value: 1 })
  await Promise.resolve(closer.fiber.dispose())
  await sleep(30)
  await expectCode('unloaded handle is closed', 'STORAGE_UNAVAILABLE', () => closerHandle.get({ key: 'closer-key' }))
  await Promise.resolve(closer.fiber.dispose()) // 二次 dispose 不得抛
  check1('double dispose stays harmless', true)
  check1('the surviving same-namespace handle keeps working', (await handle('alpha').get({ key: 'closer-key' })).value === 1)
}

// ── H. 隐私：日志永不出现 key/value 材料 ──────────────────────────────────
{
  const secret = 'SECRET-VALUE-9f8e2d'
  await handle('alpha').set({ key: 'SECRET-KEY-7a1b', value: secret })
  await handle('alpha').get({ key: 'SECRET-KEY-7a1b' })
  await expectCode('denial path stays value-free', 'PERMISSION_NOT_GRANTED', () => handle('gamma').set({ key: 'SECRET-KEY-7a1b', value: secret }))
  const leaked = hostWarnings.filter(line => line.includes(secret) || line.includes('SECRET-KEY-7a1b'))
  check1('no key/value material in logs', leaked.length === 0, leaked.join(' | '))
}

// ── I. descriptor 现声明 LocalStorage ─────────────────────────────────────
{
  const { descriptor } = buildHostDescriptor({ generationId: 'storage-battery' })
  const storage = descriptor.contracts.find(c => c.kind === 'LocalStorage')
  check1('descriptor advertises LocalStorage', storage !== undefined)
  check1('LocalStorage carries both permissions',
    JSON.stringify(storage?.permissions) === JSON.stringify(['storage.local.read', 'storage.local.write']))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-storage battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-storage battery OK (${checks} checks: round-trip, grants, validation, isolation, quota, corruption, lifecycle, privacy, descriptor)`)
process.exit(0)
