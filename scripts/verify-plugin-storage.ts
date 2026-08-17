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

// ── 授权文件：root/alpha/beta/heavy 读写全授；reader 只读；gamma 无授权 ──
mkdirSync(DATA_DIR, { recursive: true })
const GRANTS_READ_WRITE = ['storage.local.read', 'storage.local.write']
writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
  grants: {
    root: GRANTS_READ_WRITE,
    alpha: GRANTS_READ_WRITE,
    beta: GRANTS_READ_WRITE,
    heavy: GRANTS_READ_WRITE,
    reader: ['storage.local.read'],
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
const openAs = async (plugin: string) => {
  hostCtx.plugin({
    name: plugin,
    apply: (c: InstanceType<typeof Context>) => {
      const service = c.get('tuiPluginStorage')
      if (service === undefined) throw new Error('tuiPluginStorage not mounted')
      handles.set(plugin, service.open(c))
    },
  })
  await sleep(30)
}
const handle = (plugin: string): TuiPluginStorage => {
  const found = handles.get(plugin)
  if (!found) throw new Error(`no handle for ${plugin}`)
  return found
}

await openAs('alpha')
await openAs('beta')
await openAs('heavy')
await openAs('reader')
await openAs('gamma')

// ── A. 往返语义 ───────────────────────────────────────────────────────────
{
  const alpha = handle('alpha')
  check1('get on absent key resolves null', (await alpha.get('missing')) === null)
  check1('set resolves true', (await alpha.set('k1', { deep: [1, 'two', true] })) === true)
  check1('round-trip returns the value', JSON.stringify(await alpha.get('k1')) === JSON.stringify({ deep: [1, 'two', true] }))
  check1('overwrite resolves true', (await alpha.set('k1', 'plain')) === true)
  check1('overwrite visible', (await alpha.get('k1')) === 'plain')
  for (const [label, value] of [['number', 42], ['boolean', false], ['null', null], ['array', [1, 2]], ['string', 'x']] as const) {
    await alpha.set(`type-${label}`, value)
    check1(`JSON ${label} round-trips`, JSON.stringify(await alpha.get(`type-${label}`)) === JSON.stringify(value))
  }
  check1('delete on present key resolves true', (await alpha.delete('k1')) === true)
  check1('deleted key reads null', (await alpha.get('k1')) === null)
  check1('delete on absent key resolves false', (await alpha.delete('k1')) === false)
  check1('namespace file exists under ~/.dsh-tui/plugin-storage', existsSync(join(storageRoot, 'alpha.json')))
}

// ── B. 授权 ───────────────────────────────────────────────────────────────
{
  // 无 grant：拒，且不落盘。
  await expectCode('ungranted get denied', 'PERMISSION_NOT_GRANTED', () => handle('gamma').get('x'))
  await expectCode('ungranted set denied', 'PERMISSION_NOT_GRANTED', () => handle('gamma').set('x', 1))
  await expectCode('ungranted delete denied', 'PERMISSION_NOT_GRANTED', () => handle('gamma').delete('x'))
  check1('denied plugin never lands a file', !existsSync(join(storageRoot, 'gamma.json')))

  // read-only：get 通，set/delete 拒。
  check1('read-only grant: get works', (await handle('reader').get('anything')) === null)
  await expectCode('read-only grant: set denied', 'PERMISSION_NOT_GRANTED', () => handle('reader').set('x', 1))
  await expectCode('read-only grant: delete denied', 'PERMISSION_NOT_GRANTED', () => handle('reader').delete('x'))

  // 撤销（= 改文件 + 重启，以独立 runtime + 重读 store 模拟）：调用即败。
  writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
    grants: { root: ['storage.local.read'] },
  }))
  const freshCtx = new Context()
  const revokedRuntime = new TuiPluginStorageRuntime(freshCtx, { grants: readGrantStore() })
  const revokedHandle = revokedRuntime.open(freshCtx) // freshCtx fiber.name = 'root'
  check1('revoked runtime: surviving read grant still works', (await revokedHandle.get('anything')) === null)
  await expectCode('revoked runtime: write fails immediately', 'PERMISSION_NOT_GRANTED', () => revokedHandle.set('x', 1))
}

// ── C. 参数校验 ───────────────────────────────────────────────────────────
{
  const alpha = handle('alpha')
  for (const [label, key] of [['empty', ''], ['too long', 'x'.repeat(129)], ['control char', 'a\nb'], ['non-string', 42]] as const) {
    await expectCode(`invalid key (${label})`, 'INVALID_KEY', () => alpha.get(key as string))
  }
  await expectCode('undefined value rejected', 'INVALID_KEY', () => alpha.set('bad-value', undefined))
  const circular: { self?: unknown } = {}
  circular.self = circular
  await expectCode('circular value rejected', 'INVALID_KEY', () => alpha.set('bad-value', circular))
  await expectCode('bigint value rejected', 'INVALID_KEY', () => alpha.set('bad-value', 1n))
  check1('rejections left no residue key', (await alpha.get('bad-value')) === null)

  // P2-6：JSON.stringify 会静默变形的输入一律拒绝（往返不得说谎）。
  await expectCode('NaN rejected', 'INVALID_KEY', () => alpha.set('bad-nan', Number.NaN))
  await expectCode('Infinity rejected', 'INVALID_KEY', () => alpha.set('bad-inf', Number.POSITIVE_INFINITY))
  await expectCode('-Infinity rejected', 'INVALID_KEY', () => alpha.set('bad-neg-inf', Number.NEGATIVE_INFINITY))
  await expectCode('undefined array item rejected', 'INVALID_KEY', () => alpha.set('bad-arr', [1, undefined, 3]))
  await expectCode('undefined object property rejected', 'INVALID_KEY', () => alpha.set('bad-obj', { a: undefined }))
  // eslint-disable-next-line no-sparse-arrays
  await expectCode('sparse array rejected', 'INVALID_KEY', () => alpha.set('bad-sparse', new Array(3)))
  await expectCode('function value rejected', 'INVALID_KEY', () => alpha.set('bad-fn', () => 1))
  await expectCode('symbol value rejected', 'INVALID_KEY', () => alpha.set('bad-sym', Symbol('s')))
  class SomeClass { a = 1 }
  await expectCode('class instance rejected', 'INVALID_KEY', () => alpha.set('bad-class', new SomeClass()))
  await expectCode('toJSON-carrying object rejected', 'INVALID_KEY', () => alpha.set('bad-tojson', { toJSON: () => ({}) }))
  // DAG（共享引用无环）合法——stringify 展开重复，不说谎。
  const shared = { x: 1 }
  check1('DAG (shared reference, no cycle) accepted', (await alpha.set('dag', { left: shared, right: shared })) === true)
  check1('DAG round-trips expanded',
    JSON.stringify(await alpha.get('dag')) === JSON.stringify({ left: { x: 1 }, right: { x: 1 } }))

  // P2-5：原型链名就是普通数据——不读宿主原型、不伪造存在性、不污染。
  check1('get("toString") on an empty key is null (no prototype leak)', (await alpha.get('toString')) === null)
  check1('get("constructor") is null', (await alpha.get('constructor')) === null)
  check1('delete("toString") is false (no fake membership)', (await alpha.delete('toString')) === false)
  check1('set("__proto__") stores ordinary data', (await alpha.set('__proto__', { polluted: false })) === true)
  check1('get("__proto__") returns the stored own value',
    JSON.stringify(await alpha.get('__proto__')) === JSON.stringify({ polluted: false }))
  check1('Object.prototype untouched by the __proto__ write',
    ({} as { polluted?: unknown }).polluted === undefined)
  check1('delete("__proto__") is true', (await alpha.delete('__proto__')) === true)
  check1('post-delete get("__proto__") is null', (await alpha.get('__proto__')) === null)
  // 落盘往返后仍是自有属性语义（readTable 的 null 原型重建）。
  check1('set("toString") shadows the prototype as own data', (await alpha.set('toString', 'own')) === true)
  check1('get("toString") returns the stored string', (await alpha.get('toString')) === 'own')
  check1('delete("toString") now true', (await alpha.delete('toString')) === true)
}

// ── D. namespace 隔离与文件名清洗 ─────────────────────────────────────────
{
  await handle('beta').set('shared-key', 'beta-value')
  await handle('alpha').set('shared-key', 'alpha-value')
  check1('namespaces are isolated on disk', existsSync(join(storageRoot, 'beta.json')))
  check1('beta reads its own value', (await handle('beta').get('shared-key')) === 'beta-value')
  check1('alpha reads its own value', (await handle('alpha').get('shared-key')) === 'alpha-value')
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
    await heavy.set(`quota-${String(i).padStart(3, '0')}`, i)
  }
  await expectCode('key 257 hits the keys quota', 'QUOTA_EXCEEDED', () => heavy.set('quota-overflow', 1))
  check1('quota rejection wrote nothing', (await heavy.get('quota-overflow')) === null)

  // 字节阈值：更新既有键塞入超大值 → 拒，原值不变。
  const huge = 'h'.repeat(STORAGE_MAX_BYTES)
  await expectCode('oversized update hits the bytes quota', 'QUOTA_EXCEEDED', () => heavy.set('quota-000', huge))
  check1('bytes rejection kept the old value', (await heavy.get('quota-000')) === 0)

  // beta 用几乎空的 namespace 验证单写即超限。
  await expectCode('single oversized write rejected', 'QUOTA_EXCEEDED', () => handle('beta').set('huge', huge))
}

// ── F. 损坏保文件 ─────────────────────────────────────────────────────────
{
  const file = join(storageRoot, 'beta.json')
  writeFileSync(file, '{ not json at all')
  await expectCode('corrupt namespace: get fails', 'STORAGE_UNAVAILABLE', () => handle('beta').get('x'))
  await expectCode('corrupt namespace: set fails (never auto-overwrite)', 'STORAGE_UNAVAILABLE', () => handle('beta').set('x', 1))
  check1('corrupt bytes preserved verbatim', readFileSync(file, 'utf8') === '{ not json at all')

  // 非对象文档同样按不可用处理。
  writeFileSync(file, '[1,2,3]')
  await expectCode('non-object document: get fails', 'STORAGE_UNAVAILABLE', () => handle('beta').get('x'))
}

// ── G. 生命周期 ───────────────────────────────────────────────────────────
{
  // 同 namespace 双 handle 共享调用序链：并发两写按调用序落定。
  const service = hostCtx.get('tuiPluginStorage')
  const first = service.open(hostCtx) // root namespace
  const second = service.open(hostCtx)
  const write1 = first.set('order', 'first')
  const write2 = second.set('order', 'second')
  await Promise.all([write1, write2])
  check1('concurrent writes settle in invocation order', (await first.get('order')) === 'second')

  // unload 只关自己的 handle：挂一个同名 alpha 的 closer 插件再 dispose——
  // alpha 的原 handle 必须继续工作（closed 是 handle 级，不是 namespace 级）。
  let closerHandle: TuiPluginStorage | undefined
  const fiber = hostCtx.plugin({
    name: 'alpha',
    apply: (c: InstanceType<typeof Context>) => {
      closerHandle = c.get('tuiPluginStorage').open(c)
    },
  })
  await sleep(30)
  await closerHandle!.set('closer-key', 1)
  fiber.dispose()
  await sleep(30)
  await expectCode('unloaded handle is closed', 'STORAGE_UNAVAILABLE', () => closerHandle!.get('closer-key'))
  fiber.dispose() // 二次 dispose 不得抛
  check1('double dispose stays harmless', true)
  check1('the surviving same-namespace handle keeps working', (await handle('alpha').get('closer-key')) === 1)
}

// ── H. 隐私：日志永不出现 key/value 材料 ──────────────────────────────────
{
  const secret = 'SECRET-VALUE-9f8e2d'
  await handle('alpha').set('SECRET-KEY-7a1b', secret)
  await handle('alpha').get('SECRET-KEY-7a1b')
  await expectCode('denial path stays value-free', 'PERMISSION_NOT_GRANTED', () => handle('gamma').set('SECRET-KEY-7a1b', secret))
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
