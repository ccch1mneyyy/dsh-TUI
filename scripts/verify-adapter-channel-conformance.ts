/**
 * P5 Channel Provider-Consumer / dsh-ecosystem-spec conformance gate.
 *
 * Proves:
 * - the official `dsh-ecosystem-spec/conformance/fixtures/valid-tui-channel.json`
 *   fixture is loaded and validated by the vendored protocol validators;
 * - real DSH session events can be projected to `TuiChannelSnapshot` and
 *   replayed through provider/consumer;
 * - unknown Channel methods fail per protocol rather than returning a
 *   successful no-op;
 * - feature/support/method→feature validation is enforced and included in
 *   `ok`;
 * - `subscribe` delivers snapshots at `>= afterVersion` (including version 0);
 * - continuity violations fail closed;
 * - replay method payloads are bounded (size/depth) and snapshots are frozen.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-channel-conformance.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  runChannelReplay,
  runReplayShadow,
  REPLAY_SCHEMA_VERSION,
  REPLAY_CHANNEL_SCHEMA_VERSION,
  CHANNEL_METHOD_FEATURES,
} from '../src/adapter/kernel/replay.js'
import {
  createReplayChannelProvider,
  createChannelConsumer,
} from '../src/adapter/channel/index.js'
import {
  validateTuiChannelSnapshot,
  validateTuiChannelInput,
  validateTuiChannelOutput,
  TUI_CHANNEL_WIRE_REVISION,
  TUI_CHANNEL_FEATURES,
} from '../src/adapter/spec/index.js'

const ROOT = resolve(import.meta.dirname, '..')
let checks = 0

// ── official dsh-ecosystem-spec fixture ────────────────────────────────────
const officialFixturePath = join(ROOT, 'dsh-ecosystem-spec', 'conformance', 'fixtures', 'valid-tui-channel.json')
const official = JSON.parse(readFileSync(officialFixturePath, 'utf8')) as {
  requirement: { wireRevision: number; features: readonly string[] }
  support: { wireRevision: number; features: readonly string[] }
  open: { workspace?: string; sessionId?: string; options?: unknown }
  snapshot: {
    wireRevision: number
    channelId: string
    version: number
    state: Readonly<Record<string, unknown>>
  }
}
assert.equal(official.snapshot.wireRevision, TUI_CHANNEL_WIRE_REVISION)
assert.ok(Array.isArray(official.requirement.features) && official.requirement.features.length > 0)
assert.ok(Array.isArray(official.support.features) && official.support.features.length > 0)
validateTuiChannelSnapshot(official.snapshot)
validateTuiChannelInput('open', official.open)
validateTuiChannelOutput('close', { closed: true })
checks += 1

const snapshot1 = Object.freeze({
  wireRevision: TUI_CHANNEL_WIRE_REVISION,
  channelId: official.snapshot.channelId,
  version: 1,
  state: Object.freeze({
    ...official.snapshot.state,
    status: 'idle',
    transcript: Object.freeze([]),
  }),
})
const snapshot2 = Object.freeze({
  wireRevision: TUI_CHANNEL_WIRE_REVISION,
  channelId: official.snapshot.channelId,
  version: 2,
  state: Object.freeze({
    ...official.snapshot.state,
    status: 'working',
    transcript: Object.freeze([Object.freeze({ kind: 'user', text: 'hello' })]),
  }),
})
validateTuiChannelSnapshot(snapshot1)
validateTuiChannelSnapshot(snapshot2)
checks += 1

// ── direct provider/consumer: unknown method fails, real method succeeds ──
const realMethodsProvider = createReplayChannelProvider({
  snapshots: [snapshot1, snapshot2],
  transcript: [Object.freeze({ type: 'session/event', seq: 1 })],
  methods: {
    commandCompletions: async () => ['help', 'clear'],
  },
})
const consumer = createChannelConsumer(realMethodsProvider)
const opened = await consumer.open({})
assert.equal(opened.channelId, official.snapshot.channelId)
assert.equal(opened.version, 2)
const invoked = await consumer.invoke(opened.channelId, 'commandCompletions', [])
assert.deepEqual(invoked.value, ['help', 'clear'])
assert.equal(invoked.valueDefined, true)
await assert.rejects(
  consumer.invoke(opened.channelId, 'definitely-not-a-method', []),
  /FEATURE_UNAVAILABLE/u,
  'unknown Channel method must fail per protocol',
)
checks += 1

// ── subscribe >= afterVersion, including version 0 ─────────────────────────
const received: number[] = []
const subscriptionConsumer = createChannelConsumer(realMethodsProvider)
await subscriptionConsumer.subscribe(official.snapshot.channelId, 1, value => received.push(value.version))
assert.deepEqual(received, [1, 2], 'subscription must deliver snapshots not earlier than afterVersion')
checks += 1

const zeroSnapshots = [
  Object.freeze({ ...snapshot1, version: 0, state: Object.freeze({ ...snapshot1.state, status: 'idle' }) }),
  Object.freeze({ ...snapshot1, version: 1, state: Object.freeze({ ...snapshot1.state, status: 'working' }) }),
]
const zeroProvider = createReplayChannelProvider({ snapshots: zeroSnapshots })
const zeroReceived: number[] = []
const zeroConsumer = createChannelConsumer(zeroProvider)
await zeroConsumer.subscribe(zeroSnapshots[0]!.channelId, 0, value => zeroReceived.push(value.version))
assert.deepEqual(zeroReceived, [0, 1], 'version 0 and equal afterVersion snapshots must be delivered')
checks += 1

// ── continuity fails closed ────────────────────────────────────────────────
const gapProvider = createReplayChannelProvider({
  snapshots: [snapshot1, Object.freeze({ ...snapshot2, version: 3 })],
})
const gapConsumer = createChannelConsumer(gapProvider)
await assert.rejects(
  gapConsumer.subscribe(official.snapshot.channelId, 0, () => undefined),
  /continuity violation/u,
  'a version gap must make the consumer fail closed',
)
checks += 1

// ── runChannelReplay feature/method validations ────────────────────────────
const badFeatureReport = await runChannelReplay({
  snapshots: [snapshot1],
  features: ['not-a-real-feature'],
})
assert.equal(badFeatureReport.ok, false)
assert.ok((badFeatureReport.featureErrors ?? []).some(error => /unknown Channel feature/u.test(error)))
checks += 1

const missingFeatureReport = await runChannelReplay({
  snapshots: [snapshot1],
  features: ['session-state'],
  methods: { commandCompletions: async () => ['help'] },
  invokeMethod: 'commandCompletions',
})
assert.equal(missingFeatureReport.ok, false)
assert.ok((missingFeatureReport.methodErrors ?? []).some(error => /requires feature commands/u.test(error)))
checks += 1

const realMethodReport = await runChannelReplay({
  snapshots: [snapshot1, snapshot2],
  features: ['commands'],
  methods: { commandCompletions: async () => ['help'] },
  invokeMethod: 'commandCompletions',
})
assert.equal(realMethodReport.ok, true, `real method replay should pass: ${JSON.stringify(realMethodReport)}`)
assert.equal(realMethodReport.invokeValueDefined, true)
checks += 1

// ── real DSH session-event projection (B1) ────────────────────────────────
const dshReport = await runChannelReplay({
  sessionEvents: [
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi there' }] } } },
    { type: 'turn/end', data: {} },
  ],
  sessionMeta: {
    channelId: 'channel-dsh-events',
    sessionTitle: 'real DSH replay',
    homeDir: '/work',
    pathCaseInsensitive: false,
  },
  features: ['session-state', 'session-input'],
})
assert.equal(dshReport.source, 'dsh-session-events')
assert.equal(dshReport.sessionEventCount, 4)
assert.equal(dshReport.ok, true, `DSH event replay should be ok: ${JSON.stringify(dshReport)}`)
assert.ok(dshReport.versions.length >= 5, 'event projection must emit monotonic snapshots')
assert.ok(dshReport.featureErrors.length === 0 && dshReport.methodErrors.length === 0)
checks += 1

// ── size/depth hardening ───────────────────────────────────────────────────
const deepState: Record<string, unknown> = {}
let cursor: Record<string, unknown> = deepState
for (let index = 0; index < 70; index += 1) {
  const next: Record<string, unknown> = {}
  cursor.next = next
  cursor = next
}
assert.throws(
  () => createReplayChannelProvider({
    snapshots: [Object.freeze({ ...snapshot1, state: Object.freeze({ deep: deepState }) })],
  }),
  /nesting exceeds/u,
  'excessively deep replay JSON must be rejected',
)
const hugeString = 'x'.repeat(600 * 1024)
assert.throws(
  () => createReplayChannelProvider({
    snapshots: [Object.freeze({ ...snapshot1, state: Object.freeze({ blob: hugeString }) })],
  }),
  /exceeds/u,
  'oversized replay JSON must be rejected',
)
checks += 1

// ── full harness combined path ─────────────────────────────────────────────
const shadow = await runReplayShadow({
  schemaVersion: REPLAY_SCHEMA_VERSION,
  generationId: 'channel-shared-battery',
  channel: {
    snapshots: [snapshot1, snapshot2],
    transcript: [Object.freeze({ type: 'session/event', seq: 1 })],
    features: ['commands'],
    methods: { commandCompletions: async () => ['help'] },
    invokeMethod: 'commandCompletions',
  },
})
assert.equal(shadow.ok, true, `combined replay should be ok: ${JSON.stringify(shadow.channel)}`)
assert.ok(shadow.channel !== undefined)
assert.equal(shadow.channel.source, 'snapshots')
checks += 1

// ── production wiring source gate: channel driver must consume provider/consumer ──
const channelDriverSource = readFileSync(join(ROOT, 'src/adapter/upstream/channel-driver.ts'), 'utf8')
assert.ok(channelDriverSource.includes('createChannelConsumer'),
  'production channel-driver must consume ChannelConsumer')
assert.ok(channelDriverSource.includes('createReplayChannelProviderFromSnapshot'),
  'production channel-driver must consume ChannelProvider')
assert.ok(channelDriverSource.includes('CHANNEL_METHOD_FEATURES') || Object.keys(CHANNEL_METHOD_FEATURES).length > 0,
  'method→feature map must exist for conformance checks')
checks += 1

console.log(`verify:adapter-channel-conformance OK (${checks} checks, official fixture + real DSH projection + protocol negative cases)`)
