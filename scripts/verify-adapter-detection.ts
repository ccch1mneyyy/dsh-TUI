/**
 * P3 structured-detection gate.
 *
 * Proves:
 * - every registered kernel slice has a driver;
 * - every driver's detect() returns a structured `Detection`
 *   (supported / unsupported / degraded), never a bare boolean;
 * - every slice's Standard declarations are registered in the Kernel effect
 *   matrix;
 * - the production KernelRuntime consumes `driver.detect()` (not a parallel
 *   mock-only path).
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-detection.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ADAPTER_KERNEL_SLICES } from '../src/adapter/kernel/slices/index.js'
import { ADAPTER_CAPABILITY_EFFECT_CLASSES } from '../src/adapter/kernel/runtime.js'
import type { Detection } from '../src/adapter/upstream/detection.js'

const ROOT = resolve(import.meta.dirname, '..')
const kernelRuntimeSource = readFileSync(resolve(ROOT, 'src/adapter/kernel/kernel-runtime.ts'), 'utf8')
const pluginHostSource = readFileSync(resolve(ROOT, 'src/dsh-adapter/plugin-host.ts'), 'utf8')

assert.ok(
  kernelRuntimeSource.includes('driver.detect(this.context)'),
  'KernelRuntime must consume each driver.detect() on the production detection path',
)
assert.ok(
  pluginHostSource.includes('kernelSlices: ADAPTER_KERNEL_SLICES'),
  'production plugin-host must pass ADAPTER_KERNEL_SLICES into the non-legacy KernelRuntime',
)

let checks = 0
const ids = new Set<string>()
for (const slice of ADAPTER_KERNEL_SLICES) {
  checks += 1
  assert.ok(slice.id !== '', 'slice id must not be empty')
  assert.ok(!ids.has(slice.id), `duplicate slice id ${slice.id}`)
  ids.add(slice.id)
  assert.ok(slice.driver !== undefined, `${slice.id} must have a driver`)
  assert.equal(typeof slice.driver.detect, 'function', `${slice.id} driver.detect must be a function`)
  assert.equal(typeof slice.driver.mount, 'function', `${slice.id} driver.mount must be a function`)
  assert.ok(slice.driver.mountEffectClass !== undefined, `${slice.id} must declare mountEffectClass`)

  const result = slice.driver.detect({ get: () => undefined }) as Detection
  checks += 1
  assert.ok(result !== null && typeof result === 'object', `${slice.id} detect must return an object`)
  assert.ok(
    result.state === 'supported' || result.state === 'unsupported' || result.state === 'degraded',
    `${slice.id} detect returned unexpected state ${String(result.state)}`,
  )
  assert.equal(typeof (result as { state: string }).state, 'string')
  if (result.state === 'unsupported') {
    assert.equal(typeof result.reason, 'string', `${slice.id} unsupported detection must carry a reason`)
  }
  if (result.state === 'degraded') {
    assert.ok(Array.isArray(result.missing), `${slice.id} degraded detection must carry missing[]`)
  }
  if (result.state === 'supported') {
    assert.ok(Array.isArray(result.evidence), `${slice.id} supported detection must carry evidence[]`)
  } else if (result.state === 'degraded' && result.evidence !== undefined) {
    assert.ok(Array.isArray(result.evidence), `${slice.id} degraded detection evidence must be an array`)
  }
  if (result.state === 'supported' || result.state === 'degraded') {
    for (const item of result.evidence ?? []) {
      assert.ok(
        item.kind === 'service' || item.kind === 'method' || item.kind === 'version' || item.kind === 'contract' || item.kind === 'probe',
        `${slice.id} evidence kind must be structured`,
      )
    }
  }

  for (const declaration of slice.standardDeclarations) {
    checks += 1
    assert.ok(
      ADAPTER_CAPABILITY_EFFECT_CLASSES[declaration] !== undefined,
      `${slice.id} declares ${declaration} which is missing from the Kernel effect matrix`,
    )
  }
}

console.log(`verify:adapter-detection OK (${checks} checks, ${ADAPTER_KERNEL_SLICES.length} slices)`)
