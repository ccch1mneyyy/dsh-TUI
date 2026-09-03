/**
 * P2 replay-harness gate.
 *
 * Proves the minimal replay path is real and fail-closed:
 * - a replay JSON/snapshot input can be fed into the KernelRuntime/driver and
 *   produces a comparison report;
 * - the report distinguishes kernel/legacy contract sets (matched / missing /
 *   extra);
 * - using replay-shadow without an isolated replay input on a production host
 *   fails closed with an explicit error.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-replay-harness.ts`.
 */
import assert from 'node:assert/strict'
import {
  runReplayShadow,
  assertReplayShadowProductionUnavailable,
  ReplayHarnessError,
  REPLAY_SCHEMA_VERSION,
  createReplayContext,
} from '../src/adapter/kernel/replay.js'

let checks = 0

const report = await runReplayShadow({
  schemaVersion: REPLAY_SCHEMA_VERSION,
  generationId: 'replay-harness-battery',
  commands: [{ name: 'demo', description: 'demo command' }],
  storage: true,
  messages: true,
  host: {
    legacyContracts: [
      { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
      { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
      { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' },
    ],
  },
})

checks += 1
assert.equal(report.ok, true)
assert.deepEqual(report.missing, [])
assert.deepEqual(report.extra, [])
assert.ok(report.matched.length >= 3)
assert.equal(report.mode, 'replay-shadow')

const context = createReplayContext({
  schemaVersion: REPLAY_SCHEMA_VERSION,
  generationId: 'replay-context-battery',
  commands: [{ name: 'demo', description: 'demo command' }],
  storage: true,
  messages: true,
})
checks += 1
assert.equal(typeof (context as { get(name: string): unknown }).get('commands'), 'object')
assert.equal(typeof (context as { get(name: string): unknown }).get('tuiPluginStorage'), 'object')
assert.equal(typeof (context as { get(name: string): unknown }).get('tuiMessageObserver'), 'object')

checks += 1
assert.throws(
  () => assertReplayShadowProductionUnavailable(),
  (error: unknown) => error instanceof ReplayHarnessError && /replay-shadow/u.test((error as Error).message),
)

checks += 1
await assert.rejects(
  runReplayShadow({ schemaVersion: 'bad', commands: [] } as never),
  (error: unknown) => error instanceof ReplayHarnessError,
)

console.log(`verify:adapter-replay-harness OK (${checks} runtime checks)`)
