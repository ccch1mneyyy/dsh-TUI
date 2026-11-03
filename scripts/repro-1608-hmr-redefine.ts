/**
 * Issue #1608 minimal reproduction: a second evaluation of host-access (what
 * Cordis HMR does after re-accepting the module) resets the module-scoped
 * WeakSets while the guards it installed on the reused runner stay
 * non-configurable, so the next `_execute` reinstalls them and throws.
 *
 * Run: node --import tsx/esm scripts/repro-1608-hmr-redefine.ts
 */

import { Fiber } from '@deepseek-ai/cordis'

const moduleUrl = new URL('../src/dsh-adapter/host-access.ts', import.meta.url).href
const runner = {
  epoch: 0,
  execute(): () => void {
    return () => {}
  },
  collect(): void {},
}
const fiber = { _runner: runner, ctx: null, runtime: null }

const activate = (label: string): void => {
  try {
    Reflect.apply(Fiber.prototype._execute, fiber, [runner])
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label}: ${(error as Error).message}`)
    process.exitCode = 1
  }
}

await import(`${moduleUrl}?reload=1`)
activate('first module evaluation installs the execute guard')

// HMR: the module is evaluated again, so every WeakSet above starts empty
// while Cordis keeps handing back the same runner.
await import(`${moduleUrl}?reload=2`)
activate('second module evaluation reuses the guarded runner')

console.log(`descriptor: ${JSON.stringify(Object.getOwnPropertyDescriptor(runner, 'execute')?.configurable)}`)
