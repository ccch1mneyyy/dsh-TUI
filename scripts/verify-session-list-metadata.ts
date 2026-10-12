/** Web list projection: modern reads, legacy fields, restore, lifecycle and host parity.
 * Run: node --import tsx/esm scripts/verify-session-list-metadata.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Registry from '@deepseek-ai/dsh-session-projection'
import { UPSTREAM_VALIDATED_VERSION } from '../src/dsh-adapter/contract.js'
import {
  SESSION_LIST_METADATA_KEY,
  SESSION_LIST_METADATA_STATE_VERSION,
  applySessionListMetadata,
  attachSessionListMetadata,
  initSessionListMetadata,
  type SessionListMetadataState as State,
} from '../src/dsh-adapter/session-list-metadata.js'

interface Definition {
  key: string
  stateVersion: number
  stateSchema: { parse(value: unknown): unknown }
  init(): State
  apply(state: State, event: SessionEvent): State
  wire: { viewSchema: Definition['stateSchema']; view(state: State): State }
  schema: Definition['stateSchema']
  viewSchema: Definition['stateSchema']
  view(state: State): State
}

// Capture the actual registration object, including the compatibility read faces.
const definitions: Definition[] = []
function attach(registry: unknown, debug: string[] = []): void {
  attachSessionListMetadata({
    inject: (_deps: unknown, callback: (ctx: unknown) => void) => callback({ sessionProjections: registry }),
    logger: { debug: (message: string) => debug.push(message) },
  } as never)
}
attach({ register: (definition: Definition) => definitions.push(definition) })
assert.equal(definitions.length, 1)
const definition = definitions[0]!
assert.equal(definition.key, 'sessionListMetadata')
assert.equal(SESSION_LIST_METADATA_KEY, definition.key)
assert.equal(definition.stateVersion, 1)
assert.equal(SESSION_LIST_METADATA_STATE_VERSION, definition.stateVersion)
assert.deepEqual(definition.init(), { blank: true, lastPromptAt: null })
assert.notEqual(definition.init(), definition.init())

const values: State[] = [
  { blank: true, lastPromptAt: null },
  { blank: false, lastPromptAt: 111 },
  { blank: true, lastPromptAt: 111 },
]
for (const value of values) {
  assert.deepEqual(definition.stateSchema.parse(value), value)
  assert.equal(definition.wire.view(value), value)
}
assert.deepEqual(definition.stateSchema.parse({ ...values[0], extra: 1 }), values[0])
for (const value of [{}, { blank: 1, lastPromptAt: null }, { blank: true }, { blank: true, lastPromptAt: '111' }]) {
  assert.throws(() => definition.stateSchema.parse(value))
}
assert.equal(definition.wire.viewSchema, definition.stateSchema)
assert.equal(definition.schema, definition.stateSchema)
assert.equal(definition.viewSchema, definition.stateSchema)
assert.equal(definition.view, definition.wire.view)
// rc.6 reads schema/view; alpha.2 reads viewSchema/view. register() alone does
// not validate these fields, so exercise the consumers that used to throw.
for (const field of ['schema', 'viewSchema'] as const) {
  for (const value of values) assert.deepEqual(definition[field].parse(definition.view(value)), value)
  const broken = { ...definition, [field]: undefined }
  assert.throws(() => broken[field]!.parse(broken.view(values[0]!)), TypeError)
}
console.log('PASS registration, schema validation and legacy read faces')

const event = (type: string, data: unknown = {}, time = 111): SessionEvent =>
  ({ type, data, time, seq: 0 }) as SessionEvent
const turn = event('turn/start', { turn: 0 }, 100)
const human = {
  ...event('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })),
  surfaceOp: 'append',
} as SessionEvent
const sourceLess = event('user/message', { content: [] })
const unchanged = [
  event('assistant/message'), event('tool/result'), event('turn/end'),
  event('user/message', { source: { kind: 'subagent' } }),
]
const initial = initSessionListMetadata()
for (const one of unchanged) assert.equal(applySessionListMetadata(initial, one), initial)
const turned = applySessionListMetadata(initial, turn)
assert.deepEqual(turned, { blank: false, lastPromptAt: null })
assert.equal(applySessionListMetadata(turned, turn), turned)
const spoken = applySessionListMetadata(turned, human)
assert.deepEqual(spoken, { blank: false, lastPromptAt: 111 })
assert.equal(applySessionListMetadata(spoken, human), spoken)
for (const one of unchanged) assert.equal(applySessionListMetadata(spoken, one), spoken)
assert.throws(() => applySessionListMetadata(initial, sourceLess), TypeError)
const events = [turn, { ...human, seq: 1 } as SessionEvent]
const session = Session.create(SessionId('11111111-0000-4000-8000-000000000042'), events)
console.log('PASS fold values, monotonic blank state and unchanged reference identity')

for (const order of ['tui-first', 'host-first'] as const) {
  const ctx = new Context()
  try {
    await ctx.plugin(Registry)
    const registry = ctx.get('sessionProjections')!
    const releases = []
    if (order === 'host-first') releases.push(registry.register({ ...definition } as never))
    attachSessionListMetadata(ctx)
    await setImmediate()
    if (order === 'tui-first') releases.push(registry.register({ ...definition } as never))
    const rows = registry.checkpoint(session)
    assert.deepEqual(rows[definition.key]?.val, spoken)
    assert.deepEqual(registry.snapshot(session, [definition.key] as never).values[definition.key], spoken)
    const restored = registry.restore(rows, events, 0 as never, session.header, 0 as never)
    assert.deepEqual(restored.checkpoint[definition.key]?.val, spoken)
    // Mismatched versions refold instead of accepting an incompatible row.
    const refolded = registry.restore({ [definition.key]: { ver: 2, seq: -1, val: {} } }, events, 0 as never, session.header, 0 as never)
    assert.deepEqual(refolded.checkpoint[definition.key]?.val, spoken)
    assert.throws(() => registry.register({ ...definition, stateVersion: 2 } as never))
    releases[0]!()
    await setImmediate()
    assert.deepEqual(registry.checkpoint(session)[definition.key]?.val, spoken, 'the second registration keeps the key alive')
  } finally { await ctx.fiber.dispose() }
}
const refs = new Context()
try {
  await refs.plugin(Registry)
  const registry = refs.get('sessionProjections')!
  const release = registry.register(definition as never)
  release()
  await setImmediate()
  assert.equal(registry.checkpoint(session)[definition.key], undefined)
} finally { await refs.fiber.dispose() }
assert.doesNotThrow(() => attach(undefined))
assert.doesNotThrow(() => attach({}))
const debug: string[] = []
attach({ register() { throw new Error('version conflict') } }, debug)
assert.equal(debug.length, 1)
const absent = new Context()
try {
  attachSessionListMetadata(absent)
  await setImmediate()
  assert.equal(absent.get('sessionProjections'), undefined)
} finally { await absent.fiber.dispose() }
const late = new Context()
try {
  attachSessionListMetadata(late)
  await late.plugin(Registry)
  await setImmediate()
  const empty = Session.create(SessionId('11111111-0000-4000-8000-000000000043'))
  assert.deepEqual(late.get('sessionProjections')!.checkpoint(empty)[definition.key]?.val, initial,
    'a registry composed after the entry still supplies the first session checkpoint')
} finally { await late.fiber.dispose() }
console.log('PASS real registry wire/checkpoint/restore, registration order, release and degradation')

// Resolve through web-app's dependency tree, without adding a runtime dependency
// on its private controller module. Missing packages may skip; API drift fails.
let controller: string | undefined
let anchor: string | undefined
try {
  anchor = import.meta.resolve(process.env.DSH_TUI_HOST_ANCHOR ?? '@deepseek-ai/dsh-web-app/package.json')
  controller = createRequire(anchor).resolve('@deepseek-ai/dsh-api-session-controller/package.json')
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') throw error
  console.log(`SKIP host parity: ${String(error)}`)
}
if (controller !== undefined) {
  assert.equal(JSON.parse(readFileSync(new URL(anchor!), 'utf8')).version, UPSTREAM_VALIDATED_VERSION)
  assert.equal(JSON.parse(readFileSync(controller, 'utf8')).version, UPSTREAM_VALIDATED_VERSION)
  const host = await import(pathToFileURL(join(dirname(controller), 'lib/types/list.js')).href)
  const captured: Definition[] = []
  new host.ApiSessionList({
    sessionProjections: { register: (value: Definition) => captured.push(value) },
    inject() {},
  })
  assert.equal(captured[0]?.key, definition.key)
  assert.equal(captured[0]?.stateVersion, definition.stateVersion)
  for (const state of values) {
    assert.deepEqual(captured[0]!.stateSchema.parse(state), state)
    for (const one of [turn, human, ...unchanged]) {
      const ours = applySessionListMetadata(state, one)
      const theirs = host.applySessionListMetadata(state, one)
      assert.deepEqual(ours, theirs)
      assert.equal(ours === state, theirs === state)
    }
  }
  assert.throws(() => host.applySessionListMetadata(initial, sourceLess), TypeError)
  console.log(`PASS installed host parity (${UPSTREAM_VALIDATED_VERSION})`)
}

const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
const registration = plugin.indexOf('  attachSessionListMetadata(ctx)')
const boot = plugin.indexOf('await resolveAgent(')
assert.ok(registration >= 0 && boot > registration, 'register the mirror before creating the boot agent')
console.log('session-list metadata: OK')
