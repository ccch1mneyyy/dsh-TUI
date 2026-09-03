/**
 * P2 KernelRuntime production-use gate.
 *
 * Proves:
 * - `KernelRuntime` is the production path (instantiated by the plugin-host
 *   row, used by `getHostFacade`);
 * - the host-descriptor driver exposes `lifecycles`/`verifyLive` so the Kernel
 *   can run `detect → lifecycle → publish`;
 * - passive-shadow production refresh is skipped (fail-closed, no reversible
 *   probes on a real host);
 * - replay-shadow refresh on a non-isolated real host is skipped with an
 *   explicit diagnostic state.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-kernel-runtime.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { KernelRuntime } from '../src/adapter/kernel/kernel-runtime.js'
import { ADAPTER_KERNEL_SLICES } from '../src/adapter/kernel/slices/index.js'
import { hostDescriptorDriver } from '../src/adapter/upstream/host-descriptor-driver.js'
import { registerTuiChannel } from '../src/adapter/channel/host-registry.js'

const ROOT = resolve(import.meta.dirname, '..')

function readSource(relative: string): string {
  const path = resolve(ROOT, 'src', relative)
  assert.ok(existsSync(path), `missing source ${relative}`)
  return readFileSync(path, 'utf8')
}

function hasCall(source: string, callee: string): boolean {
  const sf = ts.createSourceFile('check.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)
          ? expression.name.text
          : undefined
      if (name === callee) found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function hasNewExpression(source: string, className: string): boolean {
  const sf = ts.createSourceFile('check.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === className) found = true
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const pluginHostSource = readSource('dsh-adapter/plugin-host.ts')
const kernelSource = readSource('adapter/kernel/kernel-runtime.ts')
const driverSource = readSource('adapter/upstream/host-descriptor-driver.ts')

assert.ok(hasNewExpression(pluginHostSource, 'KernelRuntime'), 'plugin-host must instantiate KernelRuntime')
assert.ok(hasCall(pluginHostSource, 'facade'), 'getHostFacade must call KernelRuntime.facade()')
assert.ok(driverSource.includes('verifyLive:'), 'host-descriptor driver must expose verifyLive')
assert.ok(driverSource.includes('lifecycles:'), 'host-descriptor driver must expose lifecycles')
assert.ok(kernelSource.includes('refresh'), 'KernelRuntime must implement refresh')

let checks = 0
const passive = new KernelRuntime({
  context: { get: () => undefined },
  mode: 'passive-shadow',
  generationId: 'kernel-passive-battery',
  drivers: [hostDescriptorDriver],
})
await passive.refresh()
checks += 1
assert.equal(passive.refreshStatus(), 'skipped')
assert.equal(passive.currentLifecycles().length, 0)

const replay = new KernelRuntime({
  context: { get: () => undefined },
  mode: 'replay-shadow',
  generationId: 'kernel-replay-battery',
  drivers: [hostDescriptorDriver],
})
await replay.refresh()
checks += 1
assert.equal(replay.refreshStatus(), 'skipped')

const newMode = new KernelRuntime({
  context: { get: () => undefined },
  mode: 'new',
  generationId: 'kernel-new-battery',
  drivers: [],
})
await newMode.refresh()
checks += 1
assert.equal(newMode.refreshStatus(), 'completed')

// Freshness: live claims must not become permanently sticky. After the TTL
// expires, descriptor reads re-derive from sync detection and downgrade.
let probeAvailable = true
const freshDriver = {
  id: 'freshness-test',
  upstreamFamily: 'test',
  capability: 'test',
  mountEffectClass: 'read-only' as const,
  detect: () => ({ state: 'supported' as const, evidence: [{ kind: 'service' as const, id: 's' }] }),
  lifecycles: () => [{
    capability: 'test#Capability',
    coordinate: { apiVersion: 'test', kind: 'Capability' },
    state: 'staged' as const,
    detection: {
      state: 'supported' as const,
      evidence: [{ kind: 'method' as const, id: 'm' }],
    },
  }],
  verifyLive: async () => probeAvailable
    ? [{
        capability: 'test#Capability',
        coordinate: { apiVersion: 'test', kind: 'Capability' },
        state: 'live' as const,
        detection: {
          state: 'supported' as const,
          evidence: [{ kind: 'probe' as const, id: 'p' }],
        },
      }]
    : [{
        capability: 'test#Capability',
        coordinate: { apiVersion: 'test', kind: 'Capability' },
        state: 'staged' as const,
        detection: {
          state: 'supported' as const,
          evidence: [{ kind: 'method' as const, id: 'm' }],
        },
      }],
  mount: async () => ({ disposer: () => undefined }),
}
const fresh = new KernelRuntime({
  context: {},
  mode: 'new',
  generationId: 'kernel-freshness-battery',
  drivers: [freshDriver],
  refreshTtlMs: 20,
})
await fresh.refresh()
checks += 1
assert.equal(fresh.currentLifecycles().find(lifecycle => lifecycle.capability === 'test#Capability')?.state, 'live')
await new Promise(resolve => setTimeout(resolve, 30))
fresh.descriptorBuild()
checks += 1
assert.notEqual(fresh.currentLifecycles().find(lifecycle => lifecycle.capability === 'test#Capability')?.state, 'live',
  'stale live claim must be downgraded after TTL expiry')

// The stale descriptorBuild must trigger an async re-probe and recover live
// without an explicit refresh call.
await new Promise(resolve => setTimeout(resolve, 60))
checks += 1
assert.equal(fresh.currentLifecycles().find(lifecycle => lifecycle.capability === 'test#Capability')?.state, 'live',
  'stale descriptorBuild must trigger a real refresh and restore live after the probe succeeds')

// Failed refresh must not retain a stale live claim either.
probeAvailable = false
const failed = new KernelRuntime({
  context: {},
  mode: 'new',
  generationId: 'kernel-failed-fresh-battery',
  drivers: [freshDriver],
})
await failed.refresh()
checks += 1
assert.notEqual(failed.currentLifecycles().find(lifecycle => lifecycle.capability === 'test#Capability')?.state, 'live')

// Mount must obey the same unified shadow policy as other effectful entries.
{
  let mountCalls = 0
  const mountEffectDriver = {
    id: 'mount-effect',
    upstreamFamily: 'test',
    capability: 'test.mount',
    mountEffectClass: 'register' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    mount: async () => {
      mountCalls += 1
      return { disposer: () => undefined }
    },
  }
  const passiveMount = new KernelRuntime({
    context: {},
    mode: 'passive-shadow',
    generationId: 'kernel-mount-passive-battery',
    drivers: [mountEffectDriver],
  })
  checks += 1
  // Shadow mode skips disallowed drivers instead of aborting the whole mount
  // transaction, so read-only/replay-safe slices can still mount alongside
  // them. A single disallowed driver therefore mounts nothing but does not
  // reject.
  await passiveMount.mount()
  assert.equal(mountCalls, 0, 'mount driver must not run when shadow policy denies its effect class')

  const newMount = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'kernel-mount-new-battery',
    drivers: [mountEffectDriver],
  })
  await newMount.mount()
  checks += 1
  assert.equal(mountCalls, 1, 'non-shadow mode may mount an effectful driver')
}

// Mount is transactional: a later driver failure must roll back every
// driver successfully mounted by the same call, in reverse order.
{
  const order: string[] = []
  const disposers = new Map<string, () => void>()
  const first = {
    id: 'mount-a',
    upstreamFamily: 'test',
    capability: 'test.mount-a',
    mountEffectClass: 'read-only' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    mount: async () => {
      order.push('mount-a')
      return {
        disposer: () => {
          order.push('dispose-a')
          disposers.set('a', () => undefined)
        },
      }
    },
  }
  const failing = {
    id: 'mount-b',
    upstreamFamily: 'test',
    capability: 'test.mount-b',
    mountEffectClass: 'read-only' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    mount: async () => {
      order.push('mount-b')
      throw new Error('mount-b failed')
    },
  }
  const transactional = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'kernel-mount-rollback-battery',
    drivers: [first, failing],
  })
  checks += 1
  await assert.rejects(transactional.mount(), /mount-b failed/)
  assert.deepEqual(order, ['mount-a', 'mount-b', 'dispose-a'],
    'failed multi-driver mount must dispose the first driver after the second throws')
  const diag = transactional.diagnosticSnapshot()
  assert.equal(diag.drivers.find(driver => driver.id === 'mount-a')?.mounted, false,
    'rolled-back driver must not remain mounted')
  assert.equal(diag.drivers.find(driver => driver.id === 'mount-b')?.mounted, false,
    'failed driver must not be reported mounted')
}

// Duplicate/concurrent mount calls must not double-mount the same driver.
{
  let mountCalls = 0
  let resolveMount: (() => void) | undefined
  const once = {
    id: 'mount-once',
    upstreamFamily: 'test',
    capability: 'test.mount-once',
    mountEffectClass: 'read-only' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    mount: async () => {
      mountCalls += 1
      await new Promise<void>(resolve => { resolveMount = resolve })
      return { disposer: () => undefined }
    },
  }
  const concurrent = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'kernel-mount-concurrent-battery',
    drivers: [once],
  })
  checks += 1
  const firstMount = concurrent.mount()
  const secondMount = concurrent.mount()
  assert.equal(mountCalls, 1, 'concurrent mount calls must share one in-flight mount')
  resolveMount!()
  await Promise.all([firstMount, secondMount])
  assert.equal(mountCalls, 1, 'duplicate mount must not mount the same driver twice')
  await concurrent.mount()
  assert.equal(mountCalls, 1, 'a third mount after completion must remain a no-op')
}

// Dispose while an async mount is in flight must clean up the mount that
// resolves after the dispose, instead of leaving it orphaned.
{
  let disposerCalls = 0
  let resolveMount: (() => void) | undefined
  const slow = {
    id: 'mount-slow',
    upstreamFamily: 'test',
    capability: 'test.mount-slow',
    mountEffectClass: 'read-only' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    mount: async () => {
      await new Promise<void>(resolve => { resolveMount = resolve })
      return { disposer: () => { disposerCalls += 1 } }
    },
  }
  const racing = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'kernel-mount-dispose-race-battery',
    drivers: [slow],
  })
  const pendingMount = racing.mount()
  racing.dispose()
  resolveMount!()
  await pendingMount
  checks += 1
  assert.equal(disposerCalls, 1, 'mount resolved after dispose must be disposed immediately')
  const diag = racing.diagnosticSnapshot()
  assert.equal(diag.drivers.find(driver => driver.id === 'mount-slow')?.mounted, false,
    'disposed in-flight mount must not remain mounted')
}


// Dispose while an async live refresh is in flight must refuse/stale the
// in-flight result instead of publishing a live lifecycle after teardown.
{
  let resolveVerify: (() => void) | undefined
  const slowVerify = {
    id: 'refresh-slow',
    upstreamFamily: 'test',
    capability: 'test.refresh-slow',
    mountEffectClass: 'read-only' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    verifyLive: async () => {
      await new Promise<void>(resolve => { resolveVerify = resolve })
      return [{
        capability: 'test#Capability',
        coordinate: { apiVersion: 'test', kind: 'Capability' },
        state: 'live' as const,
        detection: {
          state: 'supported' as const,
          evidence: [{ kind: 'probe' as const, id: 'p' }],
        },
      }]
    },
  }
  const disposing = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'kernel-refresh-dispose-battery',
    drivers: [slowVerify],
  })
  const pendingRefresh = disposing.refresh()
  disposing.dispose()
  resolveVerify!()
  await pendingRefresh
  checks += 1
  assert.equal(disposing.refreshStatus(), 'skipped',
    'dispose must cause an in-flight refresh to stop rather than complete')
  assert.equal(disposing.currentLifecycles().length, 0,
    'a refresh that completes after dispose must not publish live lifecycles')
}

// R2: a Channel registered while a refresh is in flight must queue a rerun,
// so the late Channel is observed by a subsequent refresh instead of waiting
// for the TTL.
{
  let firstEnteredResolve: (() => void) | undefined
  let firstContinueResolve: (() => void) | undefined
  let secondEnteredResolve: (() => void) | undefined
  const firstEntered = new Promise<void>(resolve => { firstEnteredResolve = resolve })
  const firstContinue = new Promise<void>(resolve => { firstContinueResolve = resolve })
  const secondEntered = new Promise<void>(resolve => { secondEnteredResolve = resolve })
  const calls: number[] = []
  const slowDriver = {
    id: 'channel-rerun',
    upstreamFamily: 'test',
    capability: 'test.channel-rerun',
    mountEffectClass: 'read-only' as const,
    detect: () => ({ state: 'unsupported' as const, reason: 'not relevant' }),
    verifyLive: async () => {
      calls.push(calls.length + 1)
      if (calls.length === 1) {
        firstEnteredResolve!()
        await firstContinue
      } else if (calls.length === 2) {
        secondEnteredResolve!()
      }
      return []
    },
  }
  const rerunCtx = {}
  const rerunKernel = new KernelRuntime({
    context: rerunCtx,
    mode: 'new',
    generationId: 'kernel-rerun-battery',
    drivers: [slowDriver],
  })
  const inFlight = rerunKernel.refresh()
  await firstEntered
  // Register the Channel while the first refresh is still blocked.
  registerTuiChannel(rerunCtx, {})
  firstContinueResolve!()
  await secondEntered
  await inFlight
  checks += 1
  assert.equal(calls.length, 2,
    'a Channel registered during an in-flight refresh must trigger a rerun')
  rerunKernel.dispose()
}

// P3 High 1: no-lifecycle P3 drivers must not retain live features after TTL
// expiry, failed refresh, unsupported detect, or dispose.
{
  let behavior: 'ok' | 'fail' | 'unsupported' = 'ok'
  const noLifecycleDriver = {
    id: 'p3-no-lifecycle',
    upstreamFamily: 'test',
    capability: 'test.p3-no-lifecycle',
    mountEffectClass: 'read-only' as const,
    detect: () => behavior === 'unsupported'
      ? { state: 'unsupported' as const, reason: 'driver now unsupported' }
      : { state: 'supported' as const, evidence: [{ kind: 'service' as const, id: 'p3' }] },
    verifyLive: async () => {
      if (behavior === 'fail') throw new Error('p3 live probe failed')
      return [{
        capability: 'p3#Feature',
        coordinate: { apiVersion: 'p3', kind: 'Feature' },
        state: 'staged' as const,
        detection: {
          state: 'supported' as const,
          evidence: [{ kind: 'probe' as const, id: 'p3-probe' }],
        },
      }]
    },
  }

  // TTL expiry must demote a previously live no-lifecycle driver.
  const ttlKernel = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'p3-no-lifecycle-ttl',
    refreshTtlMs: 10,
    drivers: [noLifecycleDriver],
  })
  await ttlKernel.refresh()
  checks += 1
  assert.equal(ttlKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state, 'live')
  await new Promise(resolve => setTimeout(resolve, 25))
  ttlKernel.detect()
  checks += 1
  assert.notEqual(
    ttlKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state,
    'live',
    'expired TTL must not leave a no-lifecycle driver live',
  )
  ttlKernel.dispose()

  // Failed refresh must demote.
  const failKernel = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'p3-no-lifecycle-fail',
    drivers: [noLifecycleDriver],
  })
  await failKernel.refresh()
  checks += 1
  assert.equal(failKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state, 'live')
  behavior = 'fail'
  await failKernel.refresh()
  checks += 1
  assert.notEqual(
    failKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state,
    'live',
    'failed refresh must not keep a no-lifecycle driver live',
  )
  failKernel.dispose()
  behavior = 'ok'

  // Unsupported detect must demote even inside a fresh window.
  const unsupportedKernel = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'p3-no-lifecycle-unsupported',
    drivers: [noLifecycleDriver],
  })
  await unsupportedKernel.refresh()
  checks += 1
  assert.equal(unsupportedKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state, 'live')
  behavior = 'unsupported'
  unsupportedKernel.detect()
  checks += 1
  assert.notEqual(
    unsupportedKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state,
    'live',
    'unsupported detect must not leave a no-lifecycle driver live',
  )
  unsupportedKernel.dispose()

  // Dispose must clear current lifecycles.
  const disposeKernel = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'p3-no-lifecycle-dispose',
    drivers: [noLifecycleDriver],
  })
  await disposeKernel.refresh()
  checks += 1
  assert.equal(disposeKernel.currentLifecycles().find(lifecycle => lifecycle.capability === 'p3#Feature')?.state, 'live')
  disposeKernel.dispose()
  checks += 1
  assert.equal(disposeKernel.currentLifecycles().length, 0,
    'disposed Kernel must not retain no-lifecycle driver features')
}

// M3: DSH_TUI_ADAPTER_SLICES / KernelRuntimeOptions.slices must actually filter
// kernel slices, not leave the option as a dead parameter.
{
  const filtered = new KernelRuntime({
    context: {},
    mode: 'new',
    generationId: 'kernel-slice-filter-battery',
    kernelSlices: ADAPTER_KERNEL_SLICES,
    slices: ['scenes'],
  })
  const diag = filtered.diagnosticSnapshot()
  checks += 1
  assert.ok(diag.drivers.some(driver => driver.id === 'dsh-tui-scenes'),
    'slice allowlist must include the selected scenes slice')
  assert.ok(!diag.drivers.some(driver => driver.id === 'dsh-tui-workspace'),
    'slice allowlist must exclude unselected workspace slice')
  assert.ok(!diag.drivers.some(driver => driver.id === 'dsh-tui-settings'),
    'slice allowlist must exclude unselected settings slice')
}

console.log(`verify:adapter-kernel-runtime OK (${checks} runtime checks + AST production-call checks)`)
