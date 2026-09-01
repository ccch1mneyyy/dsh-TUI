/**
 * Runtime gate for effect classification and shadow policy.
 *
 * Verifies the Kernel's authoritative policy matrix:
 * - passive shadow allows read-only only;
 * - replay shadow allows read-only/subscribe/register, never mutate;
 * - legacy/new allow every effect class (these are not shadow modes);
 * - every registered capability has an effect class, and the assertion helper
 *   rejects disallowed combinations.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-effect-class.ts`.
 */
import assert from 'node:assert/strict'
import {
  ADAPTER_CAPABILITY_EFFECT_CLASSES,
  assertCapabilityShadowPolicy,
  assertShadowPolicy,
  effectClassFor,
  shadowPolicyAllowed,
} from '../src/adapter/kernel/runtime.js'
import { createKernelLedger } from '../src/adapter/kernel/ledger.js'
import { withReplayIsolation, isReplayIsolationActive, enterReplayIsolation } from '../src/adapter/kernel/replay-isolation.js'


import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) collect(path, out)
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}
const usedCapabilities = new Set<string>()
for (const file of collect(SRC)) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/(?:assertCapabilityShadowPolicy|assertAdapterCapability|assertEffect)\(\s*'([^']+)'/gu)) {
    usedCapabilities.add(match[1]!)
  }
}
for (const capability of usedCapabilities) {
  if (effectClassFor(capability) === undefined) {
    console.error(`verify:adapter-effect-class FAILED: source uses unregistered capability ${capability}`)
    process.exit(1)
  }
}
// Production effect-ledger writes must go through the KernelLedger channel,
// not a second un-wired ownership/ledger abstraction.
const effectLedgerSource = readFileSync(join(SRC, 'dsh-adapter/effect-ledger.ts'), 'utf8')
if (!effectLedgerSource.includes('createKernelLedger')) {
  console.error('verify:adapter-effect-class FAILED: production effect ledger does not use KernelLedger')
  process.exit(1)
}
let checks = 0
const ok = (name: string, fn: () => void) => {
  checks += 1
  try {
    fn()
  } catch (error) {
    console.error(`verify:adapter-effect-class FAILED: ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

ok('passive shadow allows read-only only', () => {
  assert.equal(shadowPolicyAllowed('read-only', 'passive-shadow'), true)
  assert.equal(shadowPolicyAllowed('subscribe', 'passive-shadow'), false)
  assert.equal(shadowPolicyAllowed('register', 'passive-shadow'), false)
  assert.equal(shadowPolicyAllowed('mutate', 'passive-shadow'), false)
})

ok('replay shadow is fail-closed without isolated replay context', () => {
  assert.equal(shadowPolicyAllowed('read-only', 'replay-shadow'), true)
  assert.equal(shadowPolicyAllowed('subscribe', 'replay-shadow'), false)
  assert.equal(shadowPolicyAllowed('register', 'replay-shadow'), false)
  assert.equal(shadowPolicyAllowed('mutate', 'replay-shadow'), false)
  withReplayIsolation(() => {
    assert.equal(shadowPolicyAllowed('subscribe', 'replay-shadow'), true)
    assert.equal(shadowPolicyAllowed('register', 'replay-shadow'), true)
    assert.equal(shadowPolicyAllowed('mutate', 'replay-shadow'), false)
  })
})

ok('replay isolation is scoped and cannot leak after a thrown harness', () => {
  assert.equal(isReplayIsolationActive(), false)
  assert.throws(() => enterReplayIsolation(), /withReplayIsolation|runReplayShadow/)
  let resolution = 'ok'
  try {
    withReplayIsolation(() => {
      assert.equal(isReplayIsolationActive(), true)
      throw new Error('replay harness exploded')
    })
  } catch {
    resolution = 'threw'
  }
  assert.equal(resolution, 'threw')
  assert.equal(isReplayIsolationActive(), false)
})

{
  checks += 1
  await assert.rejects(
    withReplayIsolation(async () => {
      assert.equal(isReplayIsolationActive(), true)
      throw new Error('async replay harness exploded')
    }),
    /async replay harness exploded/u,
  )
  assert.equal(isReplayIsolationActive(), false, 'async replay harness exception must not leave isolation active')
}

ok('legacy/new are not shadow modes and allow all', () => {
  for (const mode of ['legacy', 'new'] as const) {
    for (const effect of ['read-only', 'subscribe', 'register', 'mutate'] as const) {
      assert.equal(shadowPolicyAllowed(effect, mode), true)
    }
  }
})

ok('assertShadowPolicy rejects disallowed combinations', () => {
  assert.throws(() => assertShadowPolicy('mutate', 'replay-shadow'), /shadow policy denies/)
  assert.throws(() => assertShadowPolicy('subscribe', 'passive-shadow'), /shadow policy denies/)
  assert.throws(() => assertShadowPolicy('register', 'passive-shadow'), /shadow policy denies/)
  assert.doesNotThrow(() => assertShadowPolicy('read-only', 'passive-shadow'))
  assert.doesNotThrow(() => assertShadowPolicy('read-only', 'replay-shadow'))
})

ok('DSH_TUI_ADAPTER_SLICES cannot bypass shadow-mode effect denial', () => {
  // Shadow modes are global: even a slice outside the allowlist is denied.
  assert.throws(() => assertCapabilityShadowPolicy('host.storage.open', 'passive-shadow', ['messages']), /shadow policy denies/)
  // In the active slice -> the unified shadow policy is enforced.
  assert.throws(() => assertCapabilityShadowPolicy('host.storage.open', 'passive-shadow', ['storage']), /shadow policy denies/)
  // Legacy/new are not shadow modes; the slice allowlist only applies there.
  assert.doesNotThrow(() => assertCapabilityShadowPolicy('host.storage.open', 'new', ['messages']))
})

ok('all registered capabilities have a declared effect class', () => {
  assert.ok(Object.keys(ADAPTER_CAPABILITY_EFFECT_CLASSES).length >= 40)
  for (const capability of Object.keys(ADAPTER_CAPABILITY_EFFECT_CLASSES)) {
    assert.notEqual(effectClassFor(capability), undefined)
  }
  assert.throws(() => assertCapabilityShadowPolicy('host.unknown', 'passive-shadow'), /no registered effect class/)
})


ok('kernel ledger write entry is guarded by shadow policy', () => {
  let wrote = 0
  const entry = { operation: 'create', resource: { kind: 'test', id: 'x' }, result: 'applied' } as const
  const ledger = createKernelLedger(() => { wrote += 1 }, 'passive-shadow')
  assert.throws(() => ledger.record(entry, { componentId: 'host' }), /shadow policy denies/)
  assert.equal(wrote, 0)
  assert.throws(() => createKernelLedger(() => {}, 'replay-shadow').record(entry, { componentId: 'host' }), /shadow policy denies/)
  assert.doesNotThrow(() => createKernelLedger(() => { wrote += 1 }, 'new').record(entry, { componentId: 'host' }))
  assert.equal(wrote, 1)
})

console.log(`verify:adapter-effect-class OK (${checks} runtime checks)`)
