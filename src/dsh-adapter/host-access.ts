import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Fiber } from '@deepseek-ai/cordis'

/**
 * Recover the concrete Cordis service for host-only adapters.
 *
 * `ctx.get()` returns a traceable proxy even to the root context. Public
 * services deliberately do not expose their host controls on that proxy, so
 * the host accessor functions keep their state in WeakMaps keyed by the
 * concrete service instance and unwrap only here.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const compositionRoots = new WeakMap<object, Context>()
const trackedRoots = new WeakSet<object>()
const trustedFibers = new WeakSet<object>()
const canonicalContexts = new WeakMap<object, Context>()
const rootFibers = new WeakMap<object, object>()
const fiberRoots = new WeakMap<object, Context>()
const fiberEffects = new WeakMap<object, (execute: () => unknown) => unknown>()
const contextFibers = new WeakMap<object, object>()
const restartingFibers = new WeakSet<object>()
const restartPendingFibers = new WeakSet<object>()
const executingFibers = new WeakSet<object>()
const wrappedRunners = new WeakSet<object>()
const wrappedRestarts = new WeakSet<object>()
const canonicalRunners = new WeakMap<object, object>()
const activationGenerations = new WeakMap<object, number>()
const activationTokens = new WeakMap<object, ActivationToken>()
const activationStorage = new AsyncLocalStorage<ActivationToken>()
const hostCapabilityStorage = new AsyncLocalStorage<boolean>()
const guardedRootFibers = new WeakSet<object>()
const guardedRootRegistries = new WeakSet<object>()
const guardedRootEvents = new WeakSet<object>()
const guardedRootReflects = new WeakSet<object>()

interface ActivationToken {
  readonly fiber: object
  readonly context: Context
  readonly root: Context
  readonly generation: number
}

installGlobalFiberInstrumentation()

/**
 * Cordis contexts are prototype-scoped objects. A plugin can therefore make
 * `ctx.extend({ fiber: fake })`, which passes a shape-only check while making
 * cleanup land on an attacker-controlled effect object. Track the fibers
 * Cordis actually publishes from the composition root and require callers to
 * use one of those identities. The root listener is global so child context
 * filters cannot hide lifecycle notifications from this guard.
 */
function rememberFiber(value: unknown, root?: Context): object | undefined {
  if (typeof value !== 'object' || value === null) return
  try {
    const fiber = value as { ctx?: unknown }
    const owner = fiber.ctx
    if (!Context.is(owner)) return
    // The internal/plugin event carries Cordis's wrapper Fiber, while the
    // context exposes the underlying instance. Normalize both to that stable
    // instance before recording trust and lifecycle state.
    const actual = owner.fiber
    if (typeof actual !== 'object' || actual === null || actual.ctx !== owner) return
    if (root !== undefined && !fiberBelongsToComposition(actual, root)) return
    const canonical = canonicalContexts.get(actual)
    if (canonical !== undefined && canonical !== owner) return
    const knownRoot = fiberRoots.get(actual)
    if (knownRoot !== undefined && root !== undefined && knownRoot !== root) return
    if (canonical !== undefined && canonical.fiber !== actual) return
    canonicalContexts.set(actual, canonical ?? owner)
    contextFibers.set(owner as object, actual)
    trustedFibers.add(actual)
    if (root !== undefined) fiberRoots.set(actual, root)
    activationGenerations.set(actual, activationGenerations.get(actual) ?? 0)
    const runner = (actual as unknown as {
      _runner?: { execute?: (...args: unknown[]) => unknown }
    })._runner
    const knownRunner = canonicalRunners.get(actual)
    if (knownRunner !== undefined && knownRunner !== runner) return
    if (runner !== undefined) canonicalRunners.set(actual, runner)
    if (!fiberEffects.has(actual)) {
      const effect = (actual as { effect?: unknown }).effect
      if (typeof effect === 'function') {
        fiberEffects.set(actual, (execute) => Reflect.apply(effect, actual, [execute]))
      }
    }
    // Cordis reuses the same activation context across a restart and emits
    // LOADING before its private runner executes the new callback. Keep the
    // old activation rejected through that window, but allow synchronous
    // registrations made by the callback currently being executed.
    if (runner !== undefined && typeof runner.execute === 'function' && !wrappedRunners.has(runner)) {
      const execute = runner.execute
      wrappedRunners.add(runner)
      Object.defineProperty(runner, 'execute', {
        configurable: false,
        writable: false,
        value: function (this: unknown, ...args: unknown[]): unknown {
          return runActivation(actual, execute, this, args)
        },
      })
    }
    const restart = (actual as unknown as { restart?: (...args: unknown[]) => unknown }).restart
    if (typeof restart === 'function' && !wrappedRestarts.has(actual)) {
      wrappedRestarts.add(actual)
      Object.defineProperty(actual, 'restart', {
        configurable: false,
        writable: false,
        value: function (this: unknown, ...args: unknown[]): unknown {
          const root = fiberRoots.get(actual)
          if (root !== undefined && rootFibers.get(root as object) === actual) {
            rejectRootCapability(root, 'root.fiber.restart')
          }
          invalidateActivation(actual)
          restartPendingFibers.add(actual)
          restartingFibers.add(actual)
          const clear = (): void => {
            restartPendingFibers.delete(actual)
            restartingFibers.delete(actual)
          }
          try {
            const result = Reflect.apply(restart, this, args)
            if (result !== null && typeof result === 'object' && 'then' in result) {
              return Promise.resolve(result).finally(clear)
            }
            clear()
            return result
          } catch (error) {
            clear()
            throw error
          }
        },
      })
    }
    return actual
  } catch {
    // Untrusted values are simply not admitted to the identity set.
  }
}

function trackCompositionRoot(root: Context): void {
  let rootFiber: object | undefined
  try {
    const value = root.fiber
    if (typeof value === 'object' && value !== null) {
      rootFiber = value
      rootFibers.set(root as object, value)
      fiberRoots.set(value, root)
    }
  } catch {
    // Fall through to the event-listener attempt below.
  }
  rememberFiber(rootFiber, root)
  if (trackedRoots.has(root as object)) return
  trackedRoots.add(root as object)
  try {
    root.on('internal/plugin', (fiber) => rememberFiber(fiber, root), { global: true })
    root.on('internal/status', (fiber) => {
      const actual = rememberFiber(fiber, root)
      if (actual === undefined) return
      const state = (actual as { state?: number }).state
      // Cordis uses 5 for UNLOADING. The wrapper returned by ctx.plugin()
      // reports this transition while the underlying context fiber may still
      // expose ACTIVE, so track the transition explicitly. Keep the marker
      // through LOADING: Cordis awaits a microtask before invoking the new
      // callback, leaving a stale-context window otherwise. The runner wrapper
      // above temporarily admits synchronous calls from that new callback.
      if (state === 5 || state === 3 || state === 4) restartingFibers.add(actual)
      else if (state === 2 && !restartPendingFibers.has(actual)) restartingFibers.delete(actual)
    }, { global: true })
  } catch {
    // Minimal embedders may expose Context without an event helper. The
    // shape/lifecycle checks below remain as a conservative fallback.
  }
  guardRootCapabilities(root)
}

function invalidateActivation(fiber: object): void {
  activationGenerations.set(fiber, (activationGenerations.get(fiber) ?? 0) + 1)
  activationTokens.delete(fiber)
}

/** Carry an activation token through every async continuation created by a
 * Cordis plugin callback. The fallback context/root walk covers compositions
 * that do not mount a dsh-tui service and therefore have not been admitted to
 * the host's canonical Fiber maps yet. */
function runActivation(fiber: object, execute: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]): unknown {
  const context = canonicalContexts.get(fiber) ?? (fiber as { ctx?: unknown }).ctx
  const root = fiberRoots.get(fiber) ?? findFiberRoot(fiber)
  if (!Context.is(context) || !Context.is(root)) {
    return Reflect.apply(execute, receiver, args)
  }
  const generation = (activationGenerations.get(fiber) ?? 0) + 1
  activationGenerations.set(fiber, generation)
  const token: ActivationToken = { fiber, context, root, generation }
  activationTokens.set(fiber, token)
  // Once the new callback starts, the old generation is already invalidated.
  // Keep the restart marker until the public restart promise settles;
  // assertLiveContext admits only this current token while it is held.
  executingFibers.add(fiber)
  return activationStorage.run(token, () => {
    try {
      return Reflect.apply(execute, receiver, args)
    } finally {
      executingFibers.delete(fiber)
    }
  })
}

function findFiberRoot(value: object): Context | undefined {
  let fiber: any = value
  const seen = new Set<object>()
  for (let depth = 0; depth < 64; depth += 1) {
    if (typeof fiber !== 'object' || fiber === null || seen.has(fiber)) return undefined
    seen.add(fiber)
    try {
      if (fiber.runtime === null) {
        return Context.is(fiber.ctx) ? fiber.ctx : undefined
      }
      const parent = fiber.parent
      if (!Context.is(parent)) return undefined
      fiber = parent.fiber
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Patch Cordis once so plugin callbacks in compositions outside the TUI
 * host still carry an ALS token when they call a guarded root object. */
function installGlobalFiberInstrumentation(): void {
  const prototype = Fiber.prototype as unknown as {
    _execute?: (runner: unknown) => unknown
    [key: string]: unknown
  }
  const original = prototype._execute
  if (typeof original !== 'function') return
  Object.defineProperty(prototype, '_execute', {
    configurable: true,
    writable: true,
    value: function (this: any, runner: any): unknown {
      if (runner === this._runner && runner !== null && typeof runner === 'object'
        && typeof runner.execute === 'function' && !wrappedRunners.has(runner)) {
        const execute = runner.execute
        const fiber = this as object
        wrappedRunners.add(runner)
        Object.defineProperty(runner, 'execute', {
          configurable: false,
          writable: false,
          value: function (this: unknown, ...args: unknown[]): unknown {
            return runActivation(fiber, execute, this, args)
          },
        })
      }
      return Reflect.apply(original, this, [runner])
    },
  })
}

/** The event bus is public and can emit `internal/plugin` manually. Admit a
 * Fiber only when Cordis has already placed that exact identity in this
 * composition's runtime registry (or it is the composition root itself). */
function fiberBelongsToComposition(fiber: object, root: Context): boolean {
  if (rootFibers.get(root as object) === fiber) return true
  try {
    const registry = concreteService(root.registry as object) as {
      _internal?: unknown
    }
    const internal = registry._internal
    if (!(internal instanceof Map)) return false
    for (const runtime of internal.values()) {
      const fibers = (runtime as { fibers?: unknown }).fibers
      if (fibers === null || fibers === undefined || typeof (fibers as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') continue
      for (const candidate of fibers as Iterable<unknown>) {
        if (candidate === fiber) return true
      }
    }
  } catch {
    // A minimal embedder may not expose registry internals. Fail closed.
  }
  return false
}

function currentActivationIsPlugin(root: Context): boolean {
  if (hostCapabilityStorage.getStore() === true) return false
  const token = activationStorage.getStore()
  if (token === undefined) return false
  if (rootFibers.get(token.root as object) === token.fiber) return false
  // Both active and stale plugin chains are denied. Stale chains will also be
  // rejected by the mediated APIs through their generation check.
  return true
}

/** Host-only escape hatch for process teardown paths that intentionally act on
 * the composition root while running from a host plugin callback. This module
 * is internal and is not part of the public plugin package surface. */
export function withHostRootCapability<T>(callback: () => T): T {
  return hostCapabilityStorage.run(true, callback)
}

function rejectRootCapability(root: Context, capability: string): void {
  if (currentActivationIsPlugin(root)) {
    throw new Error(`dsh-tui: ${capability} is unavailable from a plugin activation`)
  }
}

function callContextOf(receiver: unknown): Context | undefined {
  try {
    const context = (receiver as { ctx?: unknown }).ctx
    return Context.is(context) ? context : undefined
  } catch {
    return undefined
  }
}

function guardRootCapabilities(root: Context): void {
  const rootFiber = rootFibers.get(root as object)
  if (rootFiber !== undefined && !guardedRootFibers.has(rootFiber)) {
    guardedRootFibers.add(rootFiber)
    guardFiberMethod(rootFiber, 'effect', root, 'root.effect')
    guardFiberMethod(rootFiber, 'restart', root, 'root.fiber.restart')
    guardFiberMethod(rootFiber, 'dispose', root, 'root.fiber.dispose')
    guardFiberMethod(rootFiber, 'update', root, 'root.fiber.update')
  }

  try {
    const registry = concreteService(root.registry as object)
    if (!guardedRootRegistries.has(registry as object)) {
      guardedRootRegistries.add(registry as object)
      guardServiceMethod(registry, 'inject', root, 'root.inject', true)
      guardServiceMethod(registry, 'plugin', root, 'root.plugin', true)
      guardServiceMethod(registry, 'delete', root, 'root.registry.delete', true)
      for (const method of ['resolve', 'get', 'has', 'keys', 'values', 'entries', 'forEach']) {
        guardServiceMethod(registry, method, root, `root.registry.${method}`, true)
      }
    }
  } catch {
    // A minimal embedder may not expose the registry service object.
  }

  try {
    const events = concreteService(root.events as object)
    if (!guardedRootEvents.has(events as object)) {
      guardedRootEvents.add(events as object)
      for (const method of ['on', 'once', 'emit', 'parallel', 'serial', 'bail', 'waterfall', 'register', 'unregister', 'dispatch']) {
        guardServiceMethod(events, method, root, `root.events.${method}`, true)
      }
    }
  } catch {
    // Event guards are supplemental; Fiber admission remains fail-closed.
  }

  try {
    const reflect = concreteService(root.reflect as object)
    if (!guardedRootReflects.has(reflect as object)) {
      guardedRootReflects.add(reflect as object)
      guardServiceMethod(reflect, 'set', root, 'root.reflect.set', true)
    }
  } catch {
    // Fall through when a minimal embedder omits reflection internals.
  }
}

function guardFiberMethod(target: object, method: string, root: Context, capability: string): void {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, method)
  if (descriptor?.configurable === false) return
  const original = Reflect.get(target, method)
  if (typeof original !== 'function') return
  Object.defineProperty(target, method, {
    configurable: false,
    writable: false,
    value: function (this: unknown, ...args: unknown[]) {
      rejectRootCapability(root, capability)
      return Reflect.apply(original, this, args)
    },
  })
}

function guardServiceMethod(target: object, method: string, root: Context, capability: string, rootOnly: boolean): void {
  const original = Reflect.get(target, method)
  if (typeof original !== 'function') return
  Object.defineProperty(target, method, {
    configurable: false,
    writable: false,
    value: function (this: unknown, ...args: unknown[]) {
      const callContext = callContextOf(this)
      if (!rootOnly || callContext === root) rejectRootCapability(root, capability)
      return Reflect.apply(original, this, args)
    },
  })
}

export function concreteService<T extends object>(service: T): T {
  let current: object = service
  const seen = new WeakSet<object>()
  while (!seen.has(current)) {
    seen.add(current)
    let original: unknown
    try {
      original = Reflect.get(current, CORDIS_ORIGINAL)
    } catch {
      break
    }
    if (original === null || typeof original !== 'object' || original === current) break
    current = original
  }
  return current as T
}

/** Bind a host-side disposer to the caller's authenticated Cordis activation.
 * A failed registration immediately rolls back the owned contribution. */
export function bindCallerEffect(
  ctx: Context,
  disposer: () => unknown,
  onRegistered?: (cleanup: () => unknown) => void,
): boolean {
  let effect: ((execute: () => unknown) => unknown) | undefined
  try {
    const fiber = assertLiveContext(ctx, 'effect')
    effect = fiberEffects.get(fiber)
  } catch {
    // An untrusted or inactive caller cannot use a compatibility fallback to
    // attach cleanup to a writable context shadow.
    disposer()
    return false
  }
  if (effect === undefined) {
    disposer()
    return false
  }
  try {
    const cleanup = effect(() => disposer)
    if (typeof cleanup === 'function') {
      onRegistered?.(cleanup as () => unknown)
    }
    return true
  } catch {
    // Registration and the mutation it owns must be atomic. If the fiber has
    // entered teardown, immediately undo the caller's contribution.
    disposer()
    return false
  }
}

/** Return the stable, authenticated Fiber identity for an activation. */
export function activationFiber(ctx: Context): object | undefined {
  try {
    return assertLiveContext(ctx, 'activation')
  } catch {
    return undefined
  }
}

/** Return Cordis's canonical activation context, never a writable context
 * shadow. Explicit owner arguments use this before resolving host services. */
export function activationContext(ctx: Context): Context | undefined {
  const fiber = activationFiber(ctx)
  if (fiber === undefined) return undefined
  return canonicalContexts.get(fiber)
}

/** Resolve a service's composition root once.  Service methods are invoked
 * through caller-bound Cordis proxies; keeping this root in host state avoids
 * resolving sibling services through an attacker-provided caller shadow. */
export function compositionRoot(ctx: Context): Context {
  try {
    const knownFiber = contextFibers.get(ctx as object)
    const trustedRoot = knownFiber === undefined ? undefined : fiberRoots.get(knownFiber)
    if (trustedRoot !== undefined) {
      compositionRoots.set(ctx as object, trustedRoot)
      return trustedRoot
    }
    const directFiber = ctx.fiber
    const directRoot = typeof directFiber === 'object' && directFiber !== null
      ? fiberRoots.get(directFiber)
      : undefined
    if (directRoot !== undefined) {
      contextFibers.set(ctx as object, directFiber as object)
      compositionRoots.set(ctx as object, directRoot)
      return directRoot
    }
    const cached = compositionRoots.get(ctx as object)
    if (cached !== undefined) {
      trackCompositionRoot(cached)
      return cached
    }
  } catch {
    // Fall through to the fiber walk for degraded contexts.
  }
  try {
    let current = ctx
    const seen = new Set<object>()
    for (let depth = 0; depth < 64; depth += 1) {
      const currentFiber = current.fiber
      if (typeof currentFiber !== 'object' || currentFiber === null || seen.has(currentFiber)) break
      seen.add(currentFiber)
      const cached = compositionRoots.get(current as object)
      if (cached !== undefined) {
        compositionRoots.set(ctx as object, cached)
        trackCompositionRoot(cached)
        return cached
      }
      if (currentFiber.runtime === null) {
        const root = Context.is(currentFiber.ctx) ? currentFiber.ctx : current
        compositionRoots.set(current as object, root)
        compositionRoots.set(ctx as object, root)
        compositionRoots.set(root as object, root)
        trackCompositionRoot(root)
        return root
      }
      const parent = currentFiber.parent
      if (!Context.is(parent)) break
      current = parent
    }
  } catch {
    // Fall through to the conservative self-root fallback below.
  }
  compositionRoots.set(ctx as object, ctx)
  trackCompositionRoot(ctx)
  return ctx
}

function assertLiveContext(ctx: Context, capability: string): object {
  try {
    const known = contextFibers.get(ctx as object)
    const directFiber = ctx.fiber
    if (known !== undefined && directFiber !== known) throw new Error('mutated context fiber')
    const fiber = (known ?? directFiber) as typeof ctx.fiber & { state?: number }
    if (fiber.uid === null) throw new Error('disposed')
    // @deepseek-ai/cordis exposes FiberState as a const enum, so it is not a
    // runtime export. LOADING=1 and ACTIVE=2 are the only states in which a
    // caller can still be executing/owning effects; all other states reject.
    if (fiber.state !== 1 && fiber.state !== 2) {
      throw new Error('inactive')
    }
    // `Fiber.restart()` invalidates the runner epoch before Cordis updates
    // the public state. Read the runtime-private marker as well so a retained
    // context cannot register an effect during that unload/reload window.
    const runner = (fiber as unknown as { _runner?: { epoch?: unknown } })._runner
    if (canonicalRunners.get(fiber as object) !== runner) throw new Error('mutated runner')
    if (runner?.epoch === '__INACTIVE__') {
      throw new Error('inactive')
    }
    if (!trustedFibers.has(fiber as object)) throw new Error('unregistered')
    const owner = canonicalContexts.get(fiber as object)
    if (owner === undefined) throw new Error('unowned')
    if ((fiber as unknown as { ctx?: unknown }).ctx !== owner || owner.fiber !== fiber) throw new Error('mutated')
    let current: object | null = ctx as object
    let matched = false
    for (let depth = 0; depth < 64 && current !== null; depth += 1) {
      if (current === owner) {
        matched = true
        break
      }
      current = Object.getPrototypeOf(current) as object | null
    }
    const token = activationStorage.getStore()
    const tokenIsCurrent = token !== undefined
      && token.fiber === fiber
      && token.context === owner
      && token.root === fiberRoots.get(fiber as object)
      && token.generation === activationGenerations.get(fiber as object)
      && activationTokens.get(fiber as object) === token
    if (token !== undefined && !tokenIsCurrent) {
      throw new Error('stale activation')
    }
    if (!matched || (restartingFibers.has(fiber as object) && !tokenIsCurrent && !executingFibers.has(fiber as object))) throw new Error('inactive')
    contextFibers.set(ctx as object, fiber as object)
    return fiber as object
  } catch {
    // Fall through to the stable public error below.
  }
  throw new Error(`dsh-tui: ${capability} requires a live Cordis activation context`)
}

/** Recover the composition root that owns a traceable service. Cordis stores
 * the provider context on the concrete Service instance; callers may reach
 * that instance through a proxy from another composition, so this must be
 * resolved from the unwrapped service rather than from the call context. */
export function serviceCompositionRoot(service: object): Context | undefined {
  try {
    const owner = (concreteService(service) as { ctx?: unknown }).ctx
    return Context.is(owner) ? compositionRoot(owner) : undefined
  } catch {
    return undefined
  }
}

/** Explicit context arguments on mediated APIs may be supplied by host code
 * running from the composition root, or may be the activation making the
 * service call.  A non-root plugin cannot nominate a different activation's
 * context and thereby borrow its verified identity/lifecycle. */
export function assertCallerContext(caller: Context, target: Context, capability: string, service?: object): void {
  if (!Context.is(caller) || !Context.is(target)) {
    throw new Error(`dsh-tui: ${capability} requires a Cordis activation context`)
  }
  const callerFiber = assertLiveContext(caller, capability)
  const targetFiber = assertLiveContext(target, capability)
  const ownerRoot = service === undefined ? undefined : serviceCompositionRoot(service)
  if (ownerRoot !== undefined
    && (compositionRoot(caller) !== ownerRoot || compositionRoot(target) !== ownerRoot)) {
    throw new Error(`dsh-tui: ${capability} context belongs to a different composition`)
  }
  if (caller === target || callerFiber === targetFiber) return
  const root = compositionRoot(caller)
  if (caller === root || callerFiber === rootFibers.get(root as object)) return
  throw new Error(`dsh-tui: ${capability} context must be the calling activation`)
}

/**
 * Resolve the caller for a plugin-owned effect. A plugin can read
 * `ctx.root`, but using its root-bound service proxy would attach cleanup to
 * the host fiber and leave the effect alive after the plugin unloads. Host
 * code must use the module-local host accessor for controls it owns; the
 * public service surface only accepts a live non-root activation.
 */
export function requirePluginCaller(caller: Context, capability: string, service?: object): Context {
  if (!Context.is(caller)) {
    throw new Error(`dsh-tui: ${capability} requires a Cordis activation context`)
  }
  try {
    const callerFiber = assertLiveContext(caller, capability)
    const root = compositionRoot(caller)
    if (caller === root || callerFiber === rootFibers.get(root as object)) {
      throw new Error(`dsh-tui: ${capability} requires a non-root calling activation`)
    }
    const ownerRoot = service === undefined ? undefined : serviceCompositionRoot(service)
    if (ownerRoot !== undefined && compositionRoot(caller) !== ownerRoot) {
      throw new Error(`dsh-tui: ${capability} context belongs to a different composition`)
    }
    return caller
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('dsh-tui:')) throw error
    throw new Error(`dsh-tui: ${capability} requires a live non-root calling activation`)
  }
}
