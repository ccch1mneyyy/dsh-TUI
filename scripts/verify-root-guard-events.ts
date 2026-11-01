/**
 * #1765：root capability guard 在 `events` / `registry` 上的拦截面。
 *
 * #1765 的失败点是 root `ctx.emit('app-boot/config-reload')`：`recompose()`
 * 收到的就是 root（`dsh-config-editor` 的三个调用点都传
 * `this.ownerContext.root`），而 web 请求跑在 `dsh-host-webserver` 的
 * activation 令牌下，收尾的 emit 于是撞上 `root.events.emit`。
 *
 * 属性读取不走那条链：`ReflectService.handler.get` 对没有 `fiber.runtime`
 * 的 root 直接 `ctx.reflect.get`，不派发 `internal/get`；插件 ctx 的读取用的
 * 是自己的 traceable events 对象，守卫本来就不看。`waterfall` 与 registry 读
 * 的放行是为了让 `root.xxx` 与 `ctx.xxx` 两个引用行为一致——守卫拦的是
 * 结构性 root 变更，不是别名。
 *
 * 拒绝面按「能不能活过 activation」划线：`on`/`once`/`register`/`unregister`
 * 会把监听器钉在 root fiber 上，`root.effect`/`root.inject`/`root.plugin`/
 * `registry.delete` 是结构变更。Cordis 自己的 `internal/listener` 通道比这个
 * 守卫更早存在，不在它的能力面里。
 *
 * 每条正向断言都校验副作用或返回值，不满足于「错误信息里没有守卫文案」。
 * Run via `node --import tsx/esm scripts/verify-root-guard-events.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import { compositionRoot } from '../src/dsh-adapter/host-access.js'

let passed = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) throw new Error(`${label}\n${String(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const REFUSAL = 'is unavailable from a plugin activation'

async function attempt(run: () => unknown): Promise<string> {
  try {
    await run()
    return 'ok'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const app = new Context()
const root = compositionRoot(app)

// Host-side listeners record side effects, so a passing assertion proves the
// dispatch actually ran rather than merely "the guard did not refuse".
let emitted = 0
let paralleled = -1
let serialized = 0
let bailed = 0
const waterfalled: number[] = []
let dispatched = 0
const resolvedProps: string[] = []
root.events.on('probe/emit', () => { emitted += 1 })
root.events.on('probe/dispatch', () => { dispatched += 1 })
root.events.on('probe/parallel', (value: number) => { paralleled = value })
root.events.on('probe/serial', () => { serialized += 1 })
root.events.on('probe/bail', () => { bailed += 1 })
root.events.on('probe/waterfall', (value: number, next: () => number) => {
  waterfalled.push(value)
  return next()
})
root.events.on('internal/get', (_ctx: unknown, prop: string, _error: unknown, next: () => unknown) => {
  resolvedProps.push(prop)
  return next()
})

const seen: Record<string, string> = {}
const observed: Record<string, unknown> = {}

const plugin = {
  name: 'probe-root-guard-events',
  async apply(ctx: Context): Promise<void> {
    const registry = root.registry as unknown as Record<string, (...args: unknown[]) => unknown>

    seen.emit = await attempt(() => root.events.emit('probe/emit'))
    seen.parallel = await attempt(() => root.events.parallel('probe/parallel', 7))
    seen.serial = await attempt(() => root.events.serial('probe/serial'))
    seen.bail = await attempt(() => root.events.bail('probe/bail'))
    seen.waterfall = await attempt(() => {
      // `next` takes no arguments: Cordis forwards the original args to the
      // innermost callback, so the composed value is `1 * 10`.
      observed.waterfall = root.events.waterfall('probe/waterfall', 1, (value: number) => value * 10)
    })
    seen.dispatch = await attempt(() => {
      observed.dispatch = root.events.dispatch('emit', ['probe/dispatch']).length
    })
    // A property read on `root` short-circuits at `root.fiber.runtime` and
    // never dispatches; dispatch on the root events service instead, which is
    // the receiver the guard actually sees.
    seen.internalGet = await attempt(() => {
      observed.internalGet = root.events.waterfall(
        'internal/get', root, 'probeUndeclared', new Error('probe'), () => 'fallback',
      )
    })

    for (const method of ['resolve', 'get', 'has', 'keys', 'values', 'entries', 'forEach']) {
      const fn = registry[method]
      if (typeof fn !== 'function') {
        seen[`registry.${method}`] = 'missing'
        continue
      }
      seen[`registry.${method}`] = await attempt(() => {
        if (method === 'forEach') {
          let visits = 0
          fn.call(registry, () => { visits += 1 })
          observed['registry.forEach'] = visits
          return undefined
        }
        if (method === 'resolve') {
          observed['registry.resolve'] = fn.call(registry, plugin) === plugin.apply
          return undefined
        }
        if (method === 'has') {
          observed['registry.has'] = fn.call(registry, plugin)
          return undefined
        }
        if (method === 'get') {
          observed['registry.get'] = fn.call(registry, plugin) !== undefined
          return undefined
        }
        if (method === 'keys') {
          observed['registry.keys'] = [...(fn.call(registry) as Iterable<unknown>)].includes(plugin.apply)
          return undefined
        }
        observed[`registry.${method}`] = [...(fn.call(registry) as Iterable<unknown>)].length
        return undefined
      })
    }

    seen.on = await attempt(() => root.events.on('probe/ping', () => {}))
    seen.once = await attempt(() => root.events.once('probe/ping', () => {}))
    seen.register = await attempt(() => root.events.register('probe', [], () => {}, {}))
    seen.unregister = await attempt(() => root.events.unregister([], () => {}))
    seen.inject = await attempt(() => root.inject([], () => {}))
    seen.plugin = await attempt(() => root.plugin({ name: 'probe-refused', apply() {} }))
    seen.effect = await attempt(() => root.effect(() => {}))
    seen.registryDelete = await attempt(() => registry.delete.call(registry, { name: 'probe-delete-target' }))
    check('the probe really ran inside a plugin activation', ctx !== root)
  },
}

root.plugin(plugin)
// Let the activation run; Cordis defers the apply callback by a microtask.
for (let turn = 0; turn < 8 && seen.registryDelete === undefined; turn += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
await new Promise((resolve) => setTimeout(resolve, 0))

check('a plugin activation may emit on the root', seen.emit === 'ok', seen.emit)
check('the emit reached the host listener', emitted === 1, emitted)
check('a plugin activation may parallel-emit on the root', seen.parallel === 'ok', seen.parallel)
check('the parallel emit delivered its argument', paralleled === 7, paralleled)
check('a plugin activation may serial-emit on the root', seen.serial === 'ok', seen.serial)
check('the serial emit awaited the host listener', serialized === 1, serialized)
check('a plugin activation may bail on the root', seen.bail === 'ok', seen.bail)
check('the bail ran the host listener', bailed === 1, bailed)
check('a plugin activation may run a root waterfall', seen.waterfall === 'ok', seen.waterfall)
check('the waterfall reached the host listener', waterfalled[0] === 1, waterfalled)
check('the waterfall returned the composed value', observed.waterfall === 10, observed.waterfall)
check('a plugin activation may dispatch on the root', seen.dispatch === 'ok', seen.dispatch)
check('the dispatch returned the host listener', observed.dispatch === 1, observed.dispatch)
check('a plugin activation may dispatch internal/get on the root', seen.internalGet === 'ok', seen.internalGet)
check('the internal/get listener ran', resolvedProps.includes('probeUndeclared'), resolvedProps.slice(-4))
check('internal/get continued to the fallback', observed.internalGet === 'fallback', observed.internalGet)

check('a plugin activation may resolve a root registry entry', seen['registry.resolve'] === 'ok', seen['registry.resolve'])
check('the resolve returned the plugin callback', observed['registry.resolve'] === true, observed['registry.resolve'])
check('a plugin activation may query the root registry', seen['registry.has'] === 'ok', seen['registry.has'])
check('the registry knows the probe plugin', observed['registry.has'] === true, observed['registry.has'])
check('a plugin activation may read a root registry entry', seen['registry.get'] === 'ok', seen['registry.get'])
check('the registry returned the probe runtime', observed['registry.get'] === true, observed['registry.get'])
check('a plugin activation may iterate root registry values', seen['registry.values'] === 'ok', seen['registry.values'])
check('the registry values include the probe runtime', Number(observed['registry.values']) >= 1, observed['registry.values'])
check('a plugin activation may iterate root registry entries', seen['registry.entries'] === 'ok', seen['registry.entries'])
check('the registry entries include the probe runtime', Number(observed['registry.entries']) >= 1, observed['registry.entries'])
check('a plugin activation may forEach the root registry', seen['registry.forEach'] === 'ok', seen['registry.forEach'])
check('forEach visited the probe runtime', Number(observed['registry.forEach']) >= 1, observed['registry.forEach'])
check('a plugin activation may list root registry keys', seen['registry.keys'] === 'ok', seen['registry.keys'])
check('the registry keys include the plugin callback', observed['registry.keys'] === true, observed['registry.keys'])

check('a plugin activation may not subscribe on the root', seen.on === `dsh-tui: root.events.on ${REFUSAL}`, seen.on)
check('a plugin activation may not subscribe once on the root', seen.once === `dsh-tui: root.events.once ${REFUSAL}`, seen.once)
check('a plugin activation may not register a root hook', seen.register === `dsh-tui: root.events.register ${REFUSAL}`, seen.register)
check('a plugin activation may not unregister a root hook', seen.unregister === `dsh-tui: root.events.unregister ${REFUSAL}`, seen.unregister)
check('a plugin activation may not inject into the root', seen.inject === `dsh-tui: root.inject ${REFUSAL}`, seen.inject)
check('a plugin activation may not start a root plugin', seen.plugin === `dsh-tui: root.plugin ${REFUSAL}`, seen.plugin)
check('a plugin activation may not add a root effect', seen.effect === `dsh-tui: root.effect ${REFUSAL}`, seen.effect)
check('a plugin activation may not delete a root service', seen.registryDelete === `dsh-tui: root.registry.delete ${REFUSAL}`, seen.registryDelete)

check('the host side may still emit on the root', await attempt(() => root.events.emit('probe/emit')) === 'ok')
check('the host emit reached its listener', emitted === 2, String(emitted))

console.log(`\n${passed} checks passed`)
