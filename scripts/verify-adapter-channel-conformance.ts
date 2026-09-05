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
} from '../src/adapter/kernel/replay.js'
import {
  createReplayChannelProvider,
  createChannelConsumer,
} from '../src/adapter/channel/index.js'
import { withReplayIsolation } from '../src/adapter/kernel/replay-isolation.js'
import { registerTuiChannel } from '../src/adapter/channel/host-registry.js'
import { verifyChannelLive } from '../src/adapter/upstream/channel-driver.js'
import { KNOWN_DSH_EVENT_TYPES, projectDshSessionEventsToSnapshots } from '../src/adapter/channel/session-projection.js'
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
const invoked = await withReplayIsolation(() =>
  consumer.invoke(opened.channelId, 'commandCompletions', []))
assert.deepEqual(invoked.value, ['help', 'clear'])
assert.equal(invoked.valueDefined, true)
await assert.rejects(
  consumer.invoke(opened.channelId, 'definitely-not-a-method', []),
  /FEATURE_UNAVAILABLE/u,
  'unknown Channel method must fail per protocol',
)
const outsideConsumer = createChannelConsumer(realMethodsProvider)
await assert.rejects(
  outsideConsumer.invoke(opened.channelId, 'commandCompletions', []),
  /replay isolation/u,
  'method handlers must not execute outside replay isolation',
)
const selectorConsumer = createChannelConsumer(realMethodsProvider)
await assert.rejects(
  selectorConsumer.open({ workspace: 'file:///nonexistent', sessionId: 'wrong-session' }),
  /REPLAY_PROVIDER_UNSUPPORTED_SELECTOR/u,
  'replay provider must not silently ignore open selectors',
)
checks += 1

// Inherited Object.prototype functions are not declared replay methods.
for (const methods of [undefined, {}]) {
  const provider = createReplayChannelProvider({ snapshots: [snapshot1], methods })
  await provider.open({})
  for (const method of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    await assert.rejects(
      withReplayIsolation(() => provider.invoke(snapshot1.channelId, method, [])),
      /FEATURE_UNAVAILABLE/u,
      `inherited ${method} must never execute as a replay handler`,
    )
  }
  checks += 1
}
for (const methods of [Object.create({ inherited: () => 'unsafe' }), [], new Date()]) {
  assert.throws(
    () => createReplayChannelProvider({ snapshots: [snapshot1], methods }),
    /methods must be a plain object map/u,
  )
  checks += 1
}
// Own declarations (including prototype-like names) work on both map forms.
for (const methods of [{ toString: () => 'declared' }, Object.assign(Object.create(null), { toString: () => 'declared' })]) {
  const provider = createReplayChannelProvider({ snapshots: [snapshot1], methods })
  await provider.open({})
  const output = await withReplayIsolation(() => provider.invoke(snapshot1.channelId, 'toString', []))
  assert.equal(output.value, 'declared')
  checks += 1
}

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

// A declared method handler is not enough: without a successful invokeMethod
// it must not back a method-only feature claim.
const methodNotInvokedReport = await runChannelReplay({
  snapshots: [snapshot1, snapshot2],
  features: ['commands'],
  methods: { commandCompletions: async () => ['help'] },
})
assert.equal(methodNotInvokedReport.ok, false)
assert.ok(methodNotInvokedReport.featureErrors.some(error => /no observable evidence/u.test(error)),
  'method handler without successful invoke must not count as feature evidence')
checks += 1

// ── round2 feature/evidence/duplicate/unknown-event fail-closed cases ─────
const noExplicitFeaturesReport = await runChannelReplay({
  snapshots: [snapshot1],
})
assert.equal(noExplicitFeaturesReport.ok, false)
assert.ok(noExplicitFeaturesReport.featureErrors.some(error => /explicitly declared/u.test(error)),
  'features must be explicitly declared')
checks += 1

const emptyStateSnapshot = Object.freeze({
  wireRevision: TUI_CHANNEL_WIRE_REVISION,
  channelId: 'channel-empty',
  version: 1,
  state: Object.freeze({}),
})
const noEvidenceReport = await runChannelReplay({
  snapshots: [emptyStateSnapshot],
  features: ['commands'],
})
assert.equal(noEvidenceReport.ok, false)
assert.ok(noEvidenceReport.featureErrors.some(error => /no observable evidence/u.test(error)),
  'declared features without state/method evidence must fail')
checks += 1

const duplicateFeatureReport = await runChannelReplay({
  snapshots: [snapshot1],
  features: ['session-state', 'session-state'],
})
assert.equal(duplicateFeatureReport.ok, false)
assert.ok(duplicateFeatureReport.featureErrors.some(error => /duplicate Channel feature/u.test(error)),
  'duplicate features must be rejected before dedupe')
checks += 1

await assert.rejects(
  runChannelReplay({
    sessionEvents: [
      { type: 'totally/unknown-required', seq: 1, time: 1, data: {} },
    ],
    sessionMeta: { channelId: 'unknown-event' },
    features: ['session-state', 'session-input'],
  }),
  /unknown non-ignorable DSH session event/u,
  'unknown non-ignorable DSH event must fail closed',
)
checks += 1

// A known prefix does NOT make an unknown subtype acceptable: it must still be
// explicitly recognized or top-level ignorable.
await assert.rejects(
  runChannelReplay({
    sessionEvents: [
      { type: 'user/unknown-required', seq: 1, time: 1, data: {} },
    ],
    sessionMeta: { channelId: 'unknown-subtype' },
    features: ['session-state'],
  }),
  /unknown non-ignorable DSH session event/u,
  'known-prefix unknown subtype must still fail closed',
)
checks += 1

// Top-level `ignorable: true` (the real SessionEvent shape) allows skipping.
const ignorableReport = await runChannelReplay({
  sessionEvents: [
    { type: 'totally/unknown-but-ignorable', seq: 1, time: 1, ignorable: true, data: {} },
  ],
  sessionMeta: { channelId: 'ignorable-event' },
  features: ['session-state'],
})
assert.equal(ignorableReport.ok, true,
  'unknown top-level ignorable DSH events may be skipped')
checks += 1

// A data-level `ignorable` is NOT the SessionEvent contract and must fail.
await assert.rejects(
  runChannelReplay({
    sessionEvents: [
      { type: 'totally/unknown-data-ignorable', seq: 1, time: 1, data: { ignorable: true } },
    ],
    sessionMeta: { channelId: 'wrong-ignorable' },
    features: ['session-state'],
  }),
  /unknown non-ignorable DSH session event/u,
  'data-level ignorable must not bypass the top-level SessionEvent contract',
)
checks += 1

// Missing type is always rejected, even with top-level ignorable.
await assert.rejects(
  runChannelReplay({
    sessionEvents: [
      { seq: 1, time: 1, ignorable: true, data: {} },
    ],
    sessionMeta: { channelId: 'missing-type' },
    features: ['session-state'],
  }),
  /missing a type/u,
  'missing event type must be rejected even when top-level ignorable is set',
)
checks += 1

// Allowlist consistency: every core dsh-session SessionEventMap type must be
// present in the projection's explicit allowlist.
{
  const sessionTypesPath = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'types', 'types.d.ts')
  const sessionTypes = readFileSync(sessionTypesPath, 'utf8')
  const coreEventTypes = [...sessionTypes.matchAll(/^\s*'([a-z][a-z0-9_/-]*)':/gm)]
    .map(match => match[1]!)
    .filter(type => type.includes('/'))
  assert.ok(coreEventTypes.length >= 10, 'dsh-session core event type extraction should be meaningful')
  for (const type of coreEventTypes) {
    assert.ok(KNOWN_DSH_EVENT_TYPES.has(type),
      `DSH event allowlist must include dsh-session core type ${type}`)
  }
  checks += 1
}

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

// L5: optional RFC-adjacent state fields are carried through when provided.
{
  const enriched = projectDshSessionEventsToSnapshots([
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] }, usage: { input: 1, output: 2 } } },
  ], {
    channelId: 'enriched-channel',
    model: 'deepseek-chat',
    mode: 'default',
    agentPreset: 'standard',
    settingsSections: [{ ns: 'x', title: 'X', fields: [] }],
    scene: { id: 'scene-1' },
    diagnostic: { ok: true },
    trace: [{ type: 'trace', seq: 1 }],
    context: { segments: { system: 1 } },
    pending: [{ kind: 'user', text: 'pending' }],
  })
  const lastState = enriched.at(-1)?.state as Record<string, unknown>
  assert.equal(lastState.model, 'deepseek-chat')
  assert.equal(lastState.mode, 'default')
  assert.equal(lastState.agentPreset, 'standard')
  assert.deepEqual(lastState.settingsSections, [{ ns: 'x', title: 'X', fields: [] }])
  assert.deepEqual(lastState.scene, { id: 'scene-1' })
  assert.deepEqual(lastState.diagnostic, { ok: true })
  assert.deepEqual(lastState.trace, [{ type: 'trace', seq: 1 }])
  assert.deepEqual(lastState.context, { segments: { system: 1 } })
  assert.deepEqual(lastState.pending, [{ kind: 'user', text: 'pending' }])
  assert.deepEqual(lastState.usage, { input: 1, output: 2 })
  checks += 1
}

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

// ── production runtime path: channel-driver's live protocol validation must
// actually run open/subscribe/invoke/close (not just a source-string gate) ──
{
  const liveChannel = {
    version: 1,
    rows: [],
    status: 'idle',
    sessionTitle: 'live',
    sessionColor: '',
    agentId: 'live-channel',
    agentBindingGeneration: 1,
    model: '',
    provider: '',
    cwd: '/',
    displayCwd: '/',
    working: false,
    cancelPending: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    commandList: [],
    contextSegments: {},
    subagents: [],
    todos: [],
    pending: [],
    mode: { id: 'default' },
    traceEvents: () => [],
  }
  const liveCtx = {}
  registerTuiChannel(liveCtx, liveChannel)
  const liveLifecycles = await verifyChannelLive(liveCtx)
  assert.ok(Array.isArray(liveLifecycles))
  assert.ok(liveLifecycles.some(lifecycle =>
    lifecycle.capability === 'host.channel.transcript.trace-events'
    && lifecycle.state !== 'degraded'),
  'production channel-driver live protocol validation must complete open/subscribe/invoke/close')
  checks += 1
}

console.log(`verify:adapter-channel-conformance OK (${checks} checks, official fixture + real DSH projection + protocol negative cases)`)
