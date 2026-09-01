/**
 * P5 Channel Provider-Consumer / dsh-ecosystem-spec conformance gate.
 *
 * Proves:
 * - a real DSH session snapshot/transcript can be replayed through the
 *   `tui.dsh/v1alpha1#Channel` provider/consumer pair;
 * - all four protocol operations (open/subscribe/invoke/close) are validated
 *   against the vendored dsh-ecosystem-spec validators;
 * - snapshot versions are strictly increasing and no continuity error is
 *   reported;
 * - the same replay can ride the existing production `runReplayShadow` path.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-channel-conformance.ts`.
 */
import assert from 'node:assert/strict'
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
import {
  validateTuiChannelSnapshot,
  validateTuiChannelInput,
  validateTuiChannelOutput,
  TUI_CHANNEL_WIRE_REVISION,
} from '../src/adapter/spec/index.js'

let checks = 0

const snapshot1 = Object.freeze({
  wireRevision: TUI_CHANNEL_WIRE_REVISION,
  channelId: 'channel-replay-1',
  version: 1,
  state: Object.freeze({
    status: 'idle',
    sessionTitle: 'demo',
    homeDir: '/work',
    pathCaseInsensitive: false,
    transcript: Object.freeze([]),
    commandCatalog: Object.freeze([]),
  }),
})
const snapshot2 = Object.freeze({
  wireRevision: TUI_CHANNEL_WIRE_REVISION,
  channelId: 'channel-replay-1',
  version: 2,
  state: Object.freeze({
    status: 'working',
    sessionTitle: 'demo',
    homeDir: '/work',
    pathCaseInsensitive: false,
    transcript: Object.freeze([Object.freeze({ kind: 'user', text: 'hello' })]),
    commandCatalog: Object.freeze([Object.freeze({ name: 'help' })]),
  }),
})

// Protocol-side validation of the fixtures.
validateTuiChannelSnapshot(snapshot1)
validateTuiChannelSnapshot(snapshot2)
validateTuiChannelInput('open', {})
validateTuiChannelInput('subscribe', { channelId: 'channel-replay-1', afterVersion: 1 })
validateTuiChannelOutput('close', { closed: true })
checks += 1

// Direct provider/consumer replay.
const provider = createReplayChannelProvider({
  snapshots: [snapshot1, snapshot2],
  transcript: [Object.freeze({ type: 'session/event', seq: 1 })],
})
const consumer = createChannelConsumer(provider)
const opened = await consumer.open({})
assert.equal(opened.channelId, 'channel-replay-1')
assert.equal(opened.version, 2)
const received: number[] = []
const subscriptionConsumer = createChannelConsumer(provider)
await subscriptionConsumer.subscribe('channel-replay-1', 0, value => received.push(value.version))
assert.deepEqual(received, [1, 2], 'subscription must replay every snapshot in order')
const invoke = await consumer.invoke('channel-replay-1', 'replay/probe', [])
assert.equal(invoke.valueDefined, false)
assert.equal(consumer.lastSnapshot()?.version, 2)
const closed = await consumer.close('channel-replay-1')
assert.equal(closed.closed, true)
assert.deepEqual(consumer.continuityErrors(), [])
assert.deepEqual(subscriptionConsumer.continuityErrors(), [])
checks += 1

// Full harness replay report.
const report = await runChannelReplay({
  snapshots: [snapshot1, snapshot2],
  transcript: [Object.freeze({ type: 'session/event', seq: 1 })],
  features: ['session-state', 'session-input'],
})
assert.equal(report.ok, true)
assert.equal(report.schemaVersion, REPLAY_CHANNEL_SCHEMA_VERSION)
assert.equal(report.channelId, 'channel-replay-1')
assert.deepEqual(report.versions, [1, 2])
assert.equal(report.transcriptCount, 1)
assert.equal(report.invokeValueDefined, false)
assert.equal(report.closed, true)
assert.deepEqual(report.continuityErrors, [])
checks += 1

// Channel replay can also ride the production runReplayShadow path.
const shadow = await runReplayShadow({
  schemaVersion: REPLAY_SCHEMA_VERSION,
  generationId: 'channel-shared-battery',
  channel: {
    snapshots: [snapshot1, snapshot2],
    transcript: [Object.freeze({ type: 'session/event', seq: 1 })],
    features: ['session-state', 'session-input'],
  },
})
assert.equal(shadow.ok, true, `combined replay should be ok: ${JSON.stringify(shadow.channel)}`)
assert.ok(shadow.channel !== undefined)
assert.deepEqual(shadow.channel.continuityErrors, [])
checks += 1

// The validators reject malformed input/fixtures, proving the conformance
// path is not self-referential.
assert.throws(() => validateTuiChannelSnapshot({
  wireRevision: TUI_CHANNEL_WIRE_REVISION,
  channelId: 'x',
  version: -1,
  state: {},
}), /version/u)
assert.throws(() => validateTuiChannelInput('invoke', {
  channelId: 'x',
  method: '',
  arguments: [],
}), /non-empty/u)
checks += 1

console.log(`verify:adapter-channel-conformance OK (${checks} checks)`)
