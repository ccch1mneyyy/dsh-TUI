/**
 * Issue #1608 regression: Cordis HMR re-evaluates the host-access module while
 * the fibers and runners it instrumented stay alive. The second evaluation
 * must adopt the runtime the process already published instead of rebuilding
 * empty WeakSets under its non-configurable guards, which threw
 * `TypeError: Cannot redefine property: execute` inside `Fiber._reload`.
 *
 * Own process on purpose: verify-plugin-lifecycle.ts statically imports the
 * TUI modules that import host-access, so a second evaluation there would
 * re-instrument the shared `Fiber.prototype` inside its own assertions.
 *
 * Run: node --import tsx/esm scripts/verify-host-access-reload.ts
 */

import { execFileSync } from 'node:child_process'
import { Context, Fiber } from '@deepseek-ai/cordis'
import { sleep } from './lib/term-test.mjs'

const SLOT = Symbol.for('@deepseek-harness-tui/dsh-tui:host-access')
const WRAPPER = Symbol.for('@deepseek-harness-tui/dsh-tui:host-access-wrapper')
const moduleUrl = new URL('../src/dsh-adapter/host-access.ts', import.meta.url).href

let failures = 0
const check = (label: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`ok   ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

interface Outcome { readonly ok: boolean; readonly error?: string }

const capture = (run: () => unknown): Outcome => {
  try {
    run()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

const updateFiber = async (fiber: object, config: object): Promise<void> => {
  await (fiber as unknown as { update(config: object): Promise<unknown> }).update(config)
  // 固定窗:探针 — a reload settles on the next macrotask, not on a promise.
  await sleep(50)
}

const executeOf = (): unknown => (Fiber.prototype as unknown as { _execute: unknown })._execute

const first = await import(moduleUrl)

interface Stats { readonly roots: number; readonly listeners: number; readonly prototypes: number }
const runtime = (globalThis as unknown as Record<symbol, unknown>)[SLOT] as Record<string, unknown> | undefined
// On unfixed code the slot stays empty; say so instead of dying on `stats()`.
check('the first evaluation publishes the runtime slot', runtime !== undefined)
const stats = (): Stats => runtime === undefined
  ? { roots: 0, listeners: 0, prototypes: 0 }
  : (runtime.stats as () => Stats)()

// The counters have to move for a new root, otherwise "a reload adds nothing"
// below compares two constants and proves nothing.
const rootA = new Context()
if (runtime !== undefined) {
  const statsBeforeRootA = stats()
  first.compositionRoot(rootA)
  const statsAfterRootA = stats()
  // Each admitted root registers exactly two lifecycle listeners here plus the
  // projection one, so a looser `>` would also pass if most of them vanished.
  check(
    'a new composition root is tracked once',
    statsAfterRootA.roots === statsBeforeRootA.roots + 1
    && statsAfterRootA.listeners === statsBeforeRootA.listeners + 3,
    `${JSON.stringify(statsBeforeRootA)} -> ${JSON.stringify(statsAfterRootA)}`,
  )

  first.compositionRoot(rootA)
  const statsAfterRetrack = stats()
  check(
    're-resolving a tracked root adds no root or listener',
    statsAfterRetrack.roots === statsAfterRootA.roots && statsAfterRetrack.listeners === statsAfterRootA.listeners,
    `${JSON.stringify(statsAfterRootA)} -> ${JSON.stringify(statsAfterRetrack)}`,
  )
} else {
  first.compositionRoot(rootA)
}

const fiberA = rootA.plugin({ name: 'reload-row-a', apply(): void {} })
await fiberA

const executeBeforeReload = executeOf()

// The mark is what stops a later generation from wrapping this prototype a
// second time. The fixture below only covers the reading side, so assert the
// production wrapper carries it too.
check(
  'the installed wrapper carries the generation mark',
  (executeBeforeReload as unknown as Record<symbol, unknown>)[WRAPPER] === true,
)

// HMR: the loader evaluates the module again. `Fiber.prototype` and the fiber
// above keep the wrappers this instance installed.
const second = await import(`${moduleUrl}?reload=2`)
check('the reload evaluates a fresh module instance', second !== first)

// The order that used to crash: update without calling the new module's
// compositionRoot first, so nothing pre-warms the new instance's WeakSets.
await updateFiber(fiberA, { name: 'reload-row-a2', apply(): void {} })
const errorA = (fiberA as unknown as { _error?: Error })._error
check('an update after reload keeps no fiber error', errorA === undefined, errorA?.message)

check('the composition root is the context itself', first.compositionRoot(rootA) === rootA)

// A row created after the reload still activates.
const fiberC = rootA.plugin({ name: 'reload-row-c', apply(): void {} })
await fiberC
check('a row created after the reload activates', (fiberC as unknown as { state: number }).state === 2)

// The guard survived: still installed, still non-configurable.
const runner = (fiberA as unknown as { _runner: object })._runner
const runnerGuard = Object.getOwnPropertyDescriptor(runner, 'execute')
check('the guarded runner keeps its non-configurable execute', runnerGuard?.configurable === false)

// A reload must not add a root or a listener for a root already tracked.
const statsBeforeReloads = stats()
await import(`${moduleUrl}?reload=3`)
await import(`${moduleUrl}?reload=4`)
await import(`${moduleUrl}?reload=5`)
await updateFiber(fiberC, { name: 'reload-row-c2', apply(): void {} })
const statsAfterReloads = stats()
check(
  'a reload adds no root, listener or prototype',
  statsAfterReloads.roots === statsBeforeReloads.roots
  && statsAfterReloads.listeners === statsBeforeReloads.listeners
  && statsAfterReloads.prototypes === statsBeforeReloads.prototypes,
  `${JSON.stringify(statsBeforeReloads)} -> ${JSON.stringify(statsAfterReloads)}`,
)

// A root first seen by the reloaded instance goes through the same state.
const rootB = new Context()
const statsBeforeRootB = stats()
second.compositionRoot(rootB)
const statsAfterRootB = stats()
check(
  'a root first seen after the reload is tracked once',
  statsAfterRootB.roots === statsBeforeRootB.roots + 1
  && statsAfterRootB.listeners === statsBeforeRootB.listeners + 3,
  `${JSON.stringify(statsBeforeRootB)} -> ${JSON.stringify(statsAfterRootB)}`,
)

// Repeated reloads keep one wrapper on the prototype.
check('repeated reloads keep one _execute wrapper', executeOf() === executeBeforeReload)

// The slot is an immutable, non-enumerable global that nobody can repoint.
const slotDescriptor = Object.getOwnPropertyDescriptor(globalThis, SLOT)
check(
  'the runtime slot is frozen and non-enumerable',
  slotDescriptor?.configurable === false && slotDescriptor?.writable === false && slotDescriptor?.enumerable === false
  && Object.isFrozen(runtime),
)

// The published surface is exactly the documented method table.
const api = runtime as Record<string, unknown>
const expectedSurface = [
  'apiVersion',
  'instrument',
  'stats',
  'deferRootCapabilityGuard',
  'armRootCapabilityGuard',
  'withHostRootCapability',
  'outsideActivation',
  'concreteService',
  'bindCallerEffect',
  'activationFiber',
  'activationContext',
  'compositionRoot',
  'serviceCompositionRoot',
  'assertCallerContext',
  'requirePluginCaller',
].sort()
check(
  'the runtime surface is exactly the documented method table',
  JSON.stringify(Object.getOwnPropertyNames(api).sort()) === JSON.stringify(expectedSurface),
  JSON.stringify(Object.getOwnPropertyNames(api).sort()),
)

// A second Cordis copy arrives with its own Fiber.prototype; instrument must
// reach it once and stay idempotent. The prototype counter is the only thing
// that says the install was recorded, so assert it moves exactly once.
const instrument = api.instrument as (prototype: object) => void
const prototypesBefore = stats().prototypes
const fakePrototype: { _execute: unknown } = { _execute(this: unknown, runner: unknown): unknown { return runner } }
const fakeBefore = fakePrototype._execute
instrument(fakePrototype)
const fakeAfter = fakePrototype._execute
const prototypesAfterFirst = stats().prototypes
instrument(fakePrototype)
const prototypesAfterSecond = stats().prototypes
check(
  'instrument wraps a second prototype exactly once',
  fakeAfter !== fakeBefore && fakePrototype._execute === fakeAfter
  && prototypesAfterFirst === prototypesBefore + 1
  && prototypesAfterSecond === prototypesAfterFirst,
  `${JSON.stringify([prototypesBefore, prototypesAfterFirst, prototypesAfterSecond])}`,
)

// A prototype without `_execute` installs nothing. Recording it anyway would
// leave it marked as instrumented, so a later arrival of the real method would
// never be wrapped.
const emptyPrototype: { _execute?: unknown } = {}
const prototypesBeforeEmpty = stats().prototypes
instrument(emptyPrototype)
check(
  'instrument records nothing when the prototype has no _execute',
  stats().prototypes === prototypesBeforeEmpty,
)
emptyPrototype._execute = function (this: unknown, runner: unknown): unknown { return runner }
const emptyBefore = emptyPrototype._execute
instrument(emptyPrototype)
check(
  'a prototype that gains _execute after the miss is instrumented',
  emptyPrototype._execute !== emptyBefore && stats().prototypes === prototypesBeforeEmpty + 1,
  `${JSON.stringify([prototypesBeforeEmpty, stats().prototypes])}`,
)

// A prototype that already carries this module's wrapper belongs to another
// slot generation. Stacking a second wrapper is exactly #1608, so it must fail
// with the restart hint instead of inside Cordis.
const taggedPrototype: { _execute: unknown } = { _execute(this: unknown, runner: unknown): unknown { return runner } }
Object.defineProperty(taggedPrototype._execute as object, WRAPPER, { value: true })
const tagged = capture(() => instrument(taggedPrototype))
check(
  'a prototype from another generation is refused instead of double-wrapped',
  !tagged.ok && (tagged.error ?? '').includes('different slot generation'),
  tagged.error,
)

// The published runtime is validated on adoption; a slot holding anything
// shaped wrong must fail module evaluation rather than reach the facade. The
// slot of this process is already frozen, so every probe gets its own process.
const METHOD_STUBS = [
  'instrument() {}',
  'stats() {}',
  'deferRootCapabilityGuard() {}',
  'armRootCapabilityGuard() {}',
  'withHostRootCapability() {}',
  'outsideActivation() {}',
  'concreteService() {}',
  'bindCallerEffect() {}',
  'activationFiber() {}',
  'activationContext() {}',
  'compositionRoot() {}',
  'serviceCompositionRoot() {}',
  'assertCallerContext() {}',
  'requirePluginCaller() {}',
].join(', ')

const probeModule = (slotValue: string): string => {
  const source = `
globalThis[Symbol.for('@deepseek-harness-tui/dsh-tui:host-access')] = ${slotValue}
try {
  await import(${JSON.stringify(moduleUrl)})
  console.log('NO_THROW')
} catch (error) {
  console.log('THREW:' + (error instanceof Error ? error.message : String(error)))
}
`
  try {
    return execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', source],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? `probe failed: ${(error as Error).message}`
  }
}

const adoptOutput = probeModule('{ apiVersion: 1 }')
check(
  'an incompatible published runtime fails module evaluation',
  adoptOutput.includes('incompatible host-access runtime'),
  adoptOutput.trim(),
)

// Same method table, different version: the two sides were compiled against
// different signatures. Both directions have to stop module evaluation; running
// on would put this build's arguments through the other build's parameter list.
const olderOutput = probeModule(`{ apiVersion: 0, ${METHOD_STUBS} }`)
check(
  'a runtime from an older API version is refused on adoption',
  olderOutput.includes('is v0 and this build needs v1'),
  olderOutput.trim(),
)
const newerOutput = probeModule(`{ apiVersion: 2, ${METHOD_STUBS} }`)
check(
  'a runtime from a newer API version is refused on adoption',
  newerOutput.includes('is v2 and this build needs v1'),
  newerOutput.trim(),
)

// A null slot is not a published runtime either. It has to reach the same
// refusal, not die on a property read while the message is being built.
const nullOutput = probeModule('null')
check(
  'a null slot is refused on adoption',
  nullOutput.includes('incompatible host-access runtime'),
  nullOutput.trim(),
)

// Cross-evaluation semantics: both module instances have to read the same
// activation state. A fresh root keeps the checks off the fibers above.
const rootP = new Context()
second.compositionRoot(rootP)

let staleContext: Context | undefined
const fiberP1 = rootP.plugin({ name: 'probe-row-1', apply(ctx: Context): void { staleContext = ctx } })
await fiberP1
const stale = staleContext as Context
await updateFiber(fiberP1, { name: 'probe-row-1b', apply(): void {} })

const probes: Record<string, Outcome> = {}
const fiberP2 = rootP.plugin({
  name: 'probe-row-2',
  apply(ctx: Context): void {
    probes.bareEffect = capture(() => ctx.root.effect(() => {}))
    probes.hostEffect = capture(() => second.withHostRootCapability(() => ctx.root.effect(() => {})))
    probes.firstCaller = capture(() => first.requirePluginCaller(ctx, 'probe'))
    probes.secondCaller = capture(() => second.requirePluginCaller(ctx, 'probe'))
    probes.firstStale = capture(() => first.requirePluginCaller(stale, 'probe'))
    probes.secondStale = capture(() => second.requirePluginCaller(stale, 'probe'))
  },
})
await fiberP2

check('a bare root.effect is refused inside a plugin activation', !probes.bareEffect.ok)
check('withHostRootCapability from the reloaded module is admitted', probes.hostEffect.ok, probes.hostEffect.error)
check(
  'requirePluginCaller agrees across both evaluations',
  probes.firstCaller.ok && probes.secondCaller.ok,
  `${probes.firstCaller.error ?? 'ok'} / ${probes.secondCaller.error ?? 'ok'}`,
)
check(
  'a stale activation is rejected by both evaluations',
  !probes.firstStale.ok && !probes.secondStale.ok,
  `${probes.firstStale.ok ? 'admitted' : 'rejected'} / ${probes.secondStale.ok ? 'admitted' : 'rejected'}`,
)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks ok')
}
