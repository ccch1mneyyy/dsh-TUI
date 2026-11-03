/**
 * Issue #1608 host-level reproduction: after HMR re-evaluates host-access,
 * Cordis still owns the same fibers and runners. Their non-configurable
 * guards survive, but the new module instance starts with empty WeakSets, so
 * the next activation re-installs them and throws inside `_reload`.
 *
 * Run: node --import tsx/esm scripts/repro-1608-hmr-lifecycle.ts
 */

import { Context } from '@deepseek-ai/cordis'

const moduleUrl = new URL('../src/dsh-adapter/host-access.ts', import.meta.url).href
const { compositionRoot } = await import(moduleUrl)

const root = new Context()
compositionRoot(root)

let activations = 0
const plugin = {
  name: 'repro-1608-row',
  apply(ctx: Context): void {
    activations += 1
    void ctx
  },
}

const fiber = root.plugin(plugin)
await fiber
console.log(`ok   first activation (${activations} activations, fiber state ${(fiber as unknown as { state: number }).state})`)

// HMR: the loader re-evaluates the module graph. host-access runs its top
// level again, so its WeakSets are empty while `Fiber.prototype._execute`
// keeps the previous wrapper (and the runner keeps its frozen `execute`).
await import(`${moduleUrl}?reload=2`)

try {
  ;(fiber as unknown as { update(config: unknown): void }).update(plugin)
  await new Promise(resolve => setTimeout(resolve, 50))
  const error = (fiber as unknown as { _error?: Error })._error
  if (error !== undefined) {
    console.log(`FAIL second activation kept an error: ${error.message}`)
    process.exitCode = 1
  } else {
    console.log(`ok   second activation (${activations} activations)`)
  }
} catch (error) {
  console.log(`FAIL second activation threw: ${(error as Error).message}`)
  process.exitCode = 1
}
