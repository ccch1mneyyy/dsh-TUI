#!/usr/bin/env node
/**
 * Regression: the TUI's **mirror** of the web host's `sessionListMetadata`
 * session projection — the visibility face of issue #1342.
 *
 * `dsh web` decides whether a session is a blank shell with
 * `metadata?.blank ?? false` over a projection key that, until this change,
 * only the web host registered. A TUI-created session therefore carried no such
 * row at all, and every untouched session showed up in the sidebar as an
 * untitled row. The TUI now registers the same key with the same version and
 * the same fold, so the row is written at the forced checkpoint.
 *
 * What this script pins, and why each case exists:
 *
 * 1. **The definition handed to the registry.** Key, `stateVersion`, field
 *    names/types, `init` and the **identity `wire`** are a *copy* of the host's
 *    (`list.js:9-12`, `:59-66`), so every one of them is asserted against a
 *    literal here — a host-side change must break this script rather than
 *    silently re-open the issue. `wire` is not decoration: every wire read
 *    (`snapshot` / `cachedSnapshot` / `viewCheckpoint` / `restore`) skips a
 *    definition without it (`lib/index.js:147`, `:170`, `:249`), so a mirror
 *    registered first used to blank the key for the web sidebar's own read
 *    face — issue #1342 back through another door. The view is the identity
 *    (`view: state => state`, `list.js:64`) parsed with the SAME schema the
 *    state already passed, so it can never be the stricter of the two; the
 *    legacy definition-level spellings (`schema` / `viewSchema` / `view`) stay
 *    absent.
 * 2. **The fold matrix.** Including the two properties a value-only test cannot
 *    see: an event that changes nothing returns the SAME reference (the host
 *    relies on it to skip re-publication), and `blank` never goes back to true.
 * 3. **Cross-runtime reads.** The host's own schema is module-private, so each
 *    side's value is parsed with the other side's **equivalent shape**, and the
 *    `restore()` path (whose `stateSchema.parse` is NOT inside a `try`,
 *    `lib/index.js:297`) is driven through the real registry.
 * 4. **Real registry integration.** Two registrations of one key are legal iff
 *    the `stateVersion` matches; the first definition wins and the row is still
 *    written. Both orders are exercised because "who registered first" decides
 *    which `apply` runs — and the **wire read** (`snapshot()`) is asserted in
 *    both orders as well, because that is the read face a mirror without `wire`
 *    silently blanks and a `checkpoint()` row cannot see.
 * 5. **Degradation.** No service / a service without `register` / a conflicting
 *    version must all leave the process running: a startup risk here would be
 *    worse than the bug.
 * 6. **Drift probe.** When the installed host package is locatable, the host's
 *    REAL `applySessionListMetadata` is folded side by side with ours, its real
 *    definition validates a value we wrote, and the anchor's version is
 *    asserted; when it is not locatable the probe prints a loud SKIP with the
 *    search path and the reason — never a silent pass.
 * 7. **Negative controls.** Every assertion family above is re-run against a
 *    deliberately broken subject (no registration / one inverted fold term / a
 *    validator without `.parse`) and must go red, so "green" here means the
 *    assertions have discriminating power (LESSONS L-044). The control harness
 *    is itself checked, so no control can be vacuous.
 * 8. **The boot-session wiring ORDER.** The second half of the fix is a
 *    position inside `apply()`, not a feature: the host writes one checkpoint
 *    row per registered key when a session is created, so a mirror attached
 *    after `resolveAgent` misses the boot session's own creation record and the
 *    sidebar shows it as an untitled shell until its next checkpoint
 *    (KNOWN-ISSUES A-8). `plugin.ts` is read as text and the mirror's single
 *    call site is required to precede both halves of the boot-agent statement;
 *    the pre-fix order is rebuilt **in memory** as the discriminating control —
 *    nothing is written to disk.
 *
 * Run: node --import tsx/esm scripts/verify-session-list-metadata.ts [--list]
 * Env: `DSH_TUI_HOST_ANCHOR` overrides the drift-probe anchor package — used to
 *      exercise the SKIP path, which must be loud rather than silent (AC-11).
 * @module dsh-tui/scripts/verify-session-list-metadata
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SESSION_LIST_METADATA_KEY,
  SESSION_LIST_METADATA_STATE_VERSION,
  applySessionListMetadata,
  attachSessionListMetadata,
  initSessionListMetadata,
  type SessionListMetadataState,
} from '../src/dsh-adapter/session-list-metadata.js'

const SECTIONS = [
  '1. mirror definition handed to the registry',
  '2. fold matrix',
  '3. cross-runtime reads + restore path',
  '4. real registry integration (two registrations)',
  '5. degradation (missing seam / conflicting version)',
  '6. drift probe against the installed host package',
  '7. negative controls (assertions must be able to go red)',
  '8. boot-session wiring order (registration precedes the agent)',
] as const

if (process.argv.includes('--list')) {
  for (const section of SECTIONS) console.log(section)
  process.exit(0)
}

// ── harness ────────────────────────────────────────────────────────────────

let checks = 0
const failed: string[] = []

function report(label: string, error: unknown): void {
  failed.push(label)
  console.error(`  ✗ ${label}`)
  for (const line of String((error as Error).message ?? error).split('\n')) console.error(`      ${line}`)
}

/** Run one assertion group; a throw is a failed check, not a crashed script. */
function check(label: string, run: () => void): void {
  checks += 1
  try {
    run()
  } catch (error) {
    report(label, error)
  }
}

/** The async sibling of {@link check} — awaited, so its failures really count. */
async function checkAsync(label: string, run: () => Promise<void>): Promise<void> {
  checks += 1
  try {
    await run()
  } catch (error) {
    report(label, error)
  }
}

/** Require one assertion group to FAIL — the discriminating-power control. */
function wentRed(run: () => void): boolean {
  try {
    run()
    return false
  } catch {
    return true
  }
}

function expectRed(label: string, run: () => void, why: string): void {
  checks += 1
  if (wentRed(run)) return
  failed.push(label)
  console.error(`  ✗ negative control did not go red: ${label}`)
  console.error(`      expected a failure because ${why}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * One committed event, in the shape the durable log stores it. `surfaceOp` is a
 * top-level marker the session codec requires on every surface-eligible event
 * ("requires a surfaceOp marker"), so the fixtures carry it where the log does.
 */
function event(
  type: string,
  time: number,
  data: Record<string, unknown>,
  surfaceOp?: 'append' | 'replace',
): SessionEvent {
  return { type, time, seq: 0, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as unknown as SessionEvent
}

/** The same event at an explicit sequence. */
function at(value: SessionEvent, seq: number): SessionEvent {
  return { ...value, seq: seq as SessionEvent['seq'] }
}

const TURN_START = event('turn/start', 100, { turn: 0 })
const TURN_START_LATER = event('turn/start', 101, { turn: 1 })
const TURN_END = event('turn/end', 102, { turn: 0, reason: 'completed' })
const HUMAN_MESSAGE = event('user/message', 111, {
  id: 'm1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'hi' }],
}, 'append')
const HUMAN_MESSAGE_REPEAT = event('user/message', 111, {
  id: 'm2',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'again' }],
}, 'append')
const SUBAGENT_MESSAGE = event('user/message', 112, {
  id: 'm3',
  role: 'user',
  source: { kind: 'subagent' },
  content: [{ type: 'text', text: 'from a child' }],
}, 'append')
const SOURCE_LESS_MESSAGE = event('user/message', 113, {
  id: 'm4',
  role: 'user',
  content: [{ type: 'text', text: 'no source' }],
}, 'append')
const ASSISTANT_MESSAGE = event('assistant/message', 114, {
  id: 'm5',
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  content: [{ type: 'text', text: 'hello' }],
}, 'append')
const TOOL_RESULT = event('tool/result', 115, { id: 't1', name: 'bash', ok: true, content: [] }, 'append')

/** The log a blank shell grows into: one turn, one human message. */
const SPOKEN_LOG: readonly SessionEvent[] = [at(TURN_START, 0), at(HUMAN_MESSAGE, 1)]
/** What the fold must produce for {@link SPOKEN_LOG}. */
const SPOKEN_STATE: SessionListMetadataState = { blank: false, lastPromptAt: 111 }

type Fold = (state: SessionListMetadataState, one: SessionEvent) => SessionListMetadataState

/** A composition root whose `inject` fires synchronously with fake services. */
function compositionRoot(
  services: Record<string, unknown>,
  debug: string[] = [],
): { inject: (deps: unknown, callback: (ctx: unknown) => unknown) => void; logger: { debug: (message: string) => void } } {
  const logger = { debug: (message: string): void => { debug.push(message) } }
  return {
    inject: (_deps, callback) => { callback({ ...services, logger }) },
    logger,
  }
}

/** A registry that only records what it was handed. */
function recordingRegistry(): { definitions: Record<string, unknown>[]; services: Record<string, unknown> } {
  const definitions: Record<string, unknown>[] = []
  return {
    definitions,
    services: {
      sessionProjections: {
        onChanged: () => () => undefined,
        snapshot: () => ({ values: {} }),
        register: (definition: Record<string, unknown>) => { definitions.push(definition); return () => undefined },
      },
    },
  }
}

interface ProjectionRow { readonly ver: number; readonly seq: number; readonly val: unknown }
interface HostRegistryLike {
  register(definition: unknown): () => void
  checkpoint(session: unknown): Record<string, ProjectionRow>
  /** The wire read face: skips every definition without `wire` (`lib/index.js:147`). */
  snapshot(session: unknown, keys?: readonly string[]): { readonly asOfSeq: number, readonly values: Record<string, unknown> }
  restore(
    checkpoint: Record<string, unknown>,
    events: readonly SessionEvent[],
    baseSeq: number,
    header: unknown,
    inheritedEventCount: number,
  ): { readonly checkpoint: Record<string, ProjectionRow> }
}

/** Mount the REAL projection registry — the host service this mirror joins. */
async function freshRoot(): Promise<{ ctx: unknown; registry: HostRegistryLike }> {
  const [{ Context }, registryModule] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-session-projection'),
  ])
  const ctx = new Context()
  await ctx.plugin(registryModule.default)
  return { ctx: ctx as unknown, registry: ctx.get('sessionProjections') as unknown as HostRegistryLike }
}

const freshRegistry = async (): Promise<HostRegistryLike> => (await freshRoot()).registry

// ── 1. the mirror definition ───────────────────────────────────────────────

section(SECTIONS[0])

const recorder = recordingRegistry()
attachSessionListMetadata(compositionRoot(recorder.services) as never)
const definition = recorder.definitions[0] as {
  key: string
  stateSchema: { parse: (value: unknown) => unknown }
  init: (...args: readonly unknown[]) => SessionListMetadataState
  apply: Fold
  stateVersion: number
  wire?: unknown
  schema?: unknown
  viewSchema?: unknown
  view?: unknown
}

check('attach registers exactly one definition', () => {
  assert.equal(recorder.definitions.length, 1, 'one projection, one registration')
})

check('registration key is the host literal', () => {
  assert.equal(definition.key, 'sessionListMetadata', 'the key is the shared identity; a typo means no row')
  assert.equal(SESSION_LIST_METADATA_KEY, definition.key, 'the exported constant is what gets registered')
})

check('registration carries the host stateVersion', () => {
  assert.equal(definition.stateVersion, 1, 'a mismatched version makes the host discard the row (lib/index.js:85-93)')
  assert.equal(SESSION_LIST_METADATA_STATE_VERSION, 1, 'the exported constant is what gets registered')
})

check('registration carries the identity wire and no legacy spelling', () => {
  const wire = definition.wire as {
    viewSchema?: { parse: (value: unknown) => unknown }
    view?: (state: unknown) => unknown
  } | undefined
  assert.notEqual(
    wire,
    undefined,
    'every wire read skips a definition without wire (lib/index.js:147/:170/:249), and the web sidebar reads through one',
  )
  assert.equal(wire?.viewSchema, definition.stateSchema, 'the view must be parsed with the SAME schema the state already passed — a second copy could be the stricter of the two, and lib/index.js:259/:305 parse outside a try')
  assert.equal(typeof wire?.view, 'function', 'wire.view must be callable')
  const parsed = wire?.viewSchema?.parse({ blank: true, lastPromptAt: null, extra: 1 })
  assert.deepEqual(parsed, { blank: true, lastPromptAt: null }, 'the wire schema must accept both writers\' values like the state schema')
  assert.throws(() => wire?.viewSchema?.parse({ blank: 1, lastPromptAt: null }), 'the wire schema is the same validator, not a looser one')
  assert.equal(definition.schema, undefined, '`schema` is the 0.1.0-rc.6 spelling — deliberately not carried')
  assert.equal(definition.viewSchema, undefined, '`viewSchema` is the 0.1.2-alpha.2 spelling — deliberately not carried')
  assert.equal(definition.view, undefined, '`view` is a legacy spelling — deliberately not carried')
})

check('the identity view hands back the very state it was given (the host relies on Object.is)', () => {
  const state: SessionListMetadataState = { blank: false, lastPromptAt: 111 }
  const wire = definition.wire as { view: (value: unknown) => unknown }
  assert.equal(wire.view(state), state, 'list.js:64 registers `view: state => state`; a copy would break the host\'s reference comparison')
})

check('stateSchema is a zod-shaped parser for {blank, lastPromptAt}', () => {
  const schema = definition.stateSchema
  assert.equal(typeof schema?.parse, 'function', 'the host calls def.stateSchema.parse(row.val) (lib/index.js:255/:297)')
  assert.deepEqual(schema.parse({ blank: true, lastPromptAt: null }), { blank: true, lastPromptAt: null })
  assert.deepEqual(schema.parse({ blank: false, lastPromptAt: 111 }), { blank: false, lastPromptAt: 111 })
  assert.deepEqual(schema.parse({ blank: true, lastPromptAt: 1_700_000_000_000 }), { blank: true, lastPromptAt: 1_700_000_000_000 })
})

check('stateSchema rejects wrong field names, types and coercion', () => {
  assert.throws(() => definition.stateSchema.parse({ blank: 1, lastPromptAt: null }), 'blank must be a boolean, not 0/1')
  assert.throws(() => definition.stateSchema.parse({ blank: true }), 'lastPromptAt is required (nullable, not optional)')
  assert.throws(() => definition.stateSchema.parse({ blank: true, lastPromptAt: '111' }), 'no coercion of a numeric string')
  assert.throws(() => definition.stateSchema.parse({ blank: true, lastPromptAtAt: 111 }), 'a misspelled field must not pass')
})

check('stateSchema is neither strict nor coercing on unknown keys', () => {
  // ADR-0011 §3: it must accept BOTH writers' values. Strictness would reject a
  // value the host itself writes once its state grows a field; coercion would
  // silently change a stored value. Unknown-key tolerance is zod's default.
  const parsed = definition.stateSchema.parse({ blank: true, lastPromptAt: null, extra: 1 })
  assert.deepEqual(parsed, { blank: true, lastPromptAt: null })
})

check('init starts every session blank with no prompt time', () => {
  assert.deepEqual(definition.init(), { blank: true, lastPromptAt: null })
  assert.notEqual(definition.init(), definition.init(), 'a fresh object per session, not one shared literal')
})

// ── 2. fold matrix ─────────────────────────────────────────────────────────

section(SECTIONS[1])

/**
 * The whole fold contract as one reusable group: the positive case runs it
 * against the real fold, §7 runs the very same group against each mutant.
 */
function assertFoldSemantics(fold: Fold, label: string): void {
  const init = initSessionListMetadata()
  assert.deepEqual(init, { blank: true, lastPromptAt: null }, `${label}: init`)

  // A non-turn event must not even allocate: the host compares by value and
  // keeps the reference, and a needless allocation re-publishes every unit.
  assert.equal(fold(init, ASSISTANT_MESSAGE), init, `${label}: a non-turn event leaves the reference alone`)
  assert.equal(fold(init, TOOL_RESULT), init, `${label}: a tool event leaves the reference alone`)
  assert.equal(fold(init, SUBAGENT_MESSAGE), init, `${label}: a non-human message leaves the reference alone`)
  assert.deepEqual(init, { blank: true, lastPromptAt: null }, `${label}: those events also left the value blank`)

  const afterTurn = fold(init, TURN_START)
  assert.deepEqual(afterTurn, { blank: false, lastPromptAt: null }, `${label}: turn/start clears blank`)
  assert.notEqual(afterTurn, init, `${label}: turn/start is a real change (new object)`)
  assert.equal(fold(afterTurn, TURN_START_LATER), afterTurn, `${label}: a second turn/start changes nothing`)
  assert.equal(fold(afterTurn, TURN_END), afterTurn, `${label}: blank never returns to true`)

  const afterHuman = fold(afterTurn, HUMAN_MESSAGE)
  assert.deepEqual(afterHuman, SPOKEN_STATE, `${label}: a human message stamps lastPromptAt and keeps blank false`)
  assert.equal(fold(afterHuman, HUMAN_MESSAGE_REPEAT), afterHuman, `${label}: the same timestamp is not a change`)
  assert.equal(fold(afterHuman, ASSISTANT_MESSAGE), afterHuman, `${label}: an assistant message changes nothing`)
}

check('fold matches the host state machine', () => {
  assertFoldSemantics(applySessionListMetadata, 'fold')
})

check('fold reaches the post-turn state of a spoken log', () => {
  const folded = SPOKEN_LOG.reduce<SessionListMetadataState>(
    (state, one) => applySessionListMetadata(state, one),
    initSessionListMetadata(),
  )
  assert.deepEqual(folded, SPOKEN_STATE)
})

check('a source-less user/message fails exactly like the host', () => {
  // NOT a defensive branch: the host reads event.data.source.kind unguarded
  // (list.js:29), and the session codec refuses to store such an event at all
  // ("seed user/message ... has invalid source"), so the mirror stays verbatim
  // instead of inventing a second semantic for a value the log cannot hold.
  assert.throws(() => applySessionListMetadata(initSessionListMetadata(), SOURCE_LESS_MESSAGE), TypeError)
})

// ── 3. cross-runtime reads + restore ───────────────────────────────────────

section(SECTIONS[2])

/** Values our fold produces — what the TUI writes. */
const OUR_VALUES: readonly SessionListMetadataState[] = [
  { blank: true, lastPromptAt: null },
  SPOKEN_STATE,
  { blank: true, lastPromptAt: 1_700_000_000_000 },
]
/** Values a web-written row carries — folded by the host's own `apply`. */
const HOST_VALUES: readonly SessionListMetadataState[] = [
  { blank: true, lastPromptAt: null },
  { blank: false, lastPromptAt: 111 },
  { blank: false, lastPromptAt: 1_700_000_000_000 },
]

/**
 * Assert one parser serves BOTH writers and still rejects a malformed row — the
 * rejection half is what makes the "no `.parse`" control in §7 go red.
 */
function assertValidatorServesBothWriters(parse: (value: unknown) => unknown, label: string): void {
  assert.equal(typeof parse, 'function', `${label}: must be callable`)
  for (const value of OUR_VALUES) {
    assert.deepEqual(parse(value), value, `${label}: must accept the value the TUI writes (${JSON.stringify(value)})`)
  }
  for (const value of HOST_VALUES) {
    assert.deepEqual(parse(value), value, `${label}: must accept the value the host writes (${JSON.stringify(value)})`)
  }
  assert.throws(() => parse({ blank: 1, lastPromptAt: null }), `${label}: must reject a wrong-typed blank`)
  assert.throws(() => parse({}), `${label}: must reject a row with no fields at all`)
}

check('our schema reads the values the host writes', () => {
  assertValidatorServesBothWriters(definition.stateSchema.parse.bind(definition.stateSchema), 'mirror schema')
})

const { z } = await import('zod')
/** The host schema's equivalent shape — `list.js:9-12` is module-private. */
const hostShapedSchema = z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() })

check('the host-equivalent schema reads the values we write', () => {
  for (const value of OUR_VALUES) {
    assert.deepEqual(hostShapedSchema.parse(value), value, 'the host must be able to parse our row')
  }
  assert.throws(() => hostShapedSchema.parse({ blank: true }), 'and it is the same shape, not a looser one')
})

const restoreRegistry = await freshRegistry()
restoreRegistry.register(definition)
const { Session } = await import('@deepseek-ai/dsh-session')
const spokenSession = Session.create(SessionId('11111111-0000-4000-8000-000000000012'), [...SPOKEN_LOG])
const header = (spokenSession as unknown as { header: unknown }).header

check('restore() accepts a row the TUI wrote', () => {
  const restored = restoreRegistry.restore(
    { [SESSION_LIST_METADATA_KEY]: { ver: 1, seq: 1, val: SPOKEN_STATE } },
    SPOKEN_LOG,
    0,
    header,
    0,
  )
  assert.deepEqual(restored.checkpoint[SESSION_LIST_METADATA_KEY]?.val, SPOKEN_STATE, 'the TUI-written row survives a restart')
})

check('restore() accepts a row the host wrote', () => {
  const restored = restoreRegistry.restore(
    { [SESSION_LIST_METADATA_KEY]: { ver: 1, seq: -1, val: { blank: true, lastPromptAt: null } } },
    SPOKEN_LOG,
    0,
    header,
    0,
  )
  assert.deepEqual(
    restored.checkpoint[SESSION_LIST_METADATA_KEY]?.val,
    SPOKEN_STATE,
    'a host-written row seeds the fold and the tail advances it',
  )
})

check('restore() does not throw on either writer\'s row', () => {
  // The parse at lib/index.js:297 is NOT inside a try: a schema that rejects a
  // stored row breaks the TUI's own session restore. Reaching the assertions
  // below at all is half the check; the folded values are the other half.
  for (const value of HOST_VALUES) {
    const restored = restoreRegistry.restore(
      { [SESSION_LIST_METADATA_KEY]: { ver: 1, seq: -1, val: value } },
      SPOKEN_LOG,
      0,
      header,
      0,
    )
    assert.equal(restored.checkpoint[SESSION_LIST_METADATA_KEY]?.ver, 1)
    assert.deepEqual(restored.checkpoint[SESSION_LIST_METADATA_KEY]?.val, SPOKEN_STATE)
  }
})

check('restore() discards a row written by another version', () => {
  const restored = restoreRegistry.restore(
    { [SESSION_LIST_METADATA_KEY]: { ver: 2, seq: -1, val: { blank: true, lastPromptAt: null } } },
    SPOKEN_LOG,
    0,
    header,
    0,
  )
  assert.deepEqual(restored.checkpoint[SESSION_LIST_METADATA_KEY]?.ver, 1, 'the refreshed row is written back at our version')
  assert.deepEqual(restored.checkpoint[SESSION_LIST_METADATA_KEY]?.val, SPOKEN_STATE, 'a mismatched version refolds from init')
})

// ── 4. real registry integration ───────────────────────────────────────────

section(SECTIONS[3])

/**
 * What the web host registers for the same key: same semantics, plus `wire`.
 *
 * A hand-written copy — including the host's *unguarded* `data.source` read
 * (`list.js:29`) — used to exercise "the other runtime registered first" without
 * depending on the host package being locatable. The drift probe asserts this
 * copy folds like the real host whenever it can be located, so it cannot rot
 * into a comfortable fiction.
 */
function webSideDefinition(): unknown {
  return {
    key: SESSION_LIST_METADATA_KEY,
    stateSchema: z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() }),
    init: () => ({ blank: true, lastPromptAt: null }),
    apply: (state: SessionListMetadataState, one: SessionEvent) => {
      const blank = state.blank && one.type !== 'turn/start'
      const source = (one.data as { source: { kind: string } }).source
      const lastPromptAt = one.type === 'user/message' && source.kind === 'user' ? one.time : state.lastPromptAt
      return blank === state.blank && lastPromptAt === state.lastPromptAt ? state : { blank, lastPromptAt }
    },
    wire: { viewSchema: z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() }), view: (state: unknown) => state },
    stateVersion: 1,
  }
}

const session = Session.create(SessionId('11111111-0000-4000-8000-000000000042'), [...SPOKEN_LOG])

/** Assert the row is written by whoever owns the key, with the expected value. */
function assertRowWritten(registry: HostRegistryLike, sessionLike: unknown, where: string): void {
  const rows = registry.checkpoint(sessionLike)
  const row = rows[SESSION_LIST_METADATA_KEY]
  assert.notEqual(row, undefined, `${where}: checkpoint() must contain the key (lib/index.js:195-207)`)
  assert.equal(row?.ver, 1, `${where}: the row version is the registered stateVersion`)
  assert.deepEqual(row?.val, SPOKEN_STATE, `${where}: the row value is the folded state`)
}

/**
 * Assert the WIRE read serves the key — the face the web sidebar actually reads.
 *
 * This is the assertion the row check cannot make: `checkpoint()` writes a row
 * per registered key with or without `wire` (`lib/index.js:195-207`), while
 * `snapshot()` skips every definition without one (`:147`). The shim (mirror
 * registered first) therefore used to serve `{values: {}}` and the sidebar fell
 * back to `?? false` — issue #1342 back through another door.
 */
function assertSnapshotServes(registry: HostRegistryLike, sessionLike: unknown, where: string): void {
  const snapshot = registry.snapshot(sessionLike, [SESSION_LIST_METADATA_KEY])
  assert.notEqual(
    snapshot.values[SESSION_LIST_METADATA_KEY],
    undefined,
    `${where}: snapshot() must contain the key (lib/index.js:147 skips a definition without wire)`,
  )
  assert.deepEqual(
    snapshot.values[SESSION_LIST_METADATA_KEY],
    SPOKEN_STATE,
    `${where}: the wire view serves the folded state`,
  )
}

const tuiFirst = await freshRoot()
attachSessionListMetadata(tuiFirst.ctx as never)
await flush()
tuiFirst.registry.register(webSideDefinition())

check('TUI first, host second: the row is still written', () => {
  assertRowWritten(tuiFirst.registry, session, 'tui-first')
})

check('TUI first, host second: the wire read serves the key too', () => {
  assertSnapshotServes(tuiFirst.registry, session, 'tui-first')
})

const hostFirst = await freshRoot()
hostFirst.registry.register(webSideDefinition())
attachSessionListMetadata(hostFirst.ctx as never)
await flush()

check('host first, TUI second: no throw and the row is still written', () => {
  assertRowWritten(hostFirst.registry, session, 'host-first')
})

check('host first, TUI second: the wire read serves the key too', () => {
  assertSnapshotServes(hostFirst.registry, session, 'host-first')
})

check('registration order is not observable in the value', () => {
  const left = tuiFirst.registry.checkpoint(session)[SESSION_LIST_METADATA_KEY]
  const right = hostFirst.registry.checkpoint(session)[SESSION_LIST_METADATA_KEY]
  assert.deepEqual(left, right, 'both definitions fold identically, so "who registered first" cannot matter')
})

check('registration order is not observable in the wire read either', () => {
  const left = tuiFirst.registry.snapshot(session, [SESSION_LIST_METADATA_KEY])
  const right = hostFirst.registry.snapshot(session, [SESSION_LIST_METADATA_KEY])
  assert.deepEqual(left, right, 'a shim registered first must serve the same value as one registered second (AC-2)')
})

const refs = await freshRoot()
const firstDispose = refs.registry.register(definition)
const secondDispose = refs.registry.register(webSideDefinition())

await checkAsync('the second registration increments refs instead of replacing the definition', async () => {
  firstDispose()
  await flush()
  assertRowWritten(refs.registry, session, 'after the first release')
})

await checkAsync('the key disappears only when the last registration is released', async () => {
  secondDispose()
  await flush()
  assert.equal(refs.registry.checkpoint(session)[SESSION_LIST_METADATA_KEY], undefined, 'refs back to zero removes the key')
})

// ── 5. degradation ─────────────────────────────────────────────────────────

section(SECTIONS[4])

/**
 * A composition root for a host line with **no** projection plugin: `inject`
 * records what was asked for and never fires its callback, which is what Cordis
 * does while nothing provides `sessionProjections`. The recorder it holds is the
 * service a registration WOULD land in, so "no definition was registered" is a
 * fact about `attach` rather than about a fixture with nowhere to register —
 * `withProvider()` drives the same stored callback the way a provider would and
 * the definition must then appear (the control inside the check below).
 * @returns The root, the request log and the recorder.
 */
function rootWithoutProjections(): {
  readonly asked: unknown[]
  readonly debug: string[]
  readonly registry: ReturnType<typeof recordingRegistry>
  readonly root: { inject: (deps: unknown, callback: (ctx: unknown) => unknown) => void }
  readonly withProvider: () => void
} {
  const registry = recordingRegistry()
  const asked: unknown[] = []
  const debug: string[] = []
  let stored: ((ctx: unknown) => unknown) | undefined
  return {
    asked,
    debug,
    registry,
    root: {
      inject: (deps, callback) => {
        asked.push(deps)
        stored = callback
      },
    },
    withProvider: () => {
      stored?.({ ...registry.services, logger: { debug: (message: string) => debug.push(message) } })
    },
  }
}

const noProvider = rootWithoutProjections()
check('no projection service at all: attach asks for it, registers nothing and stays silent', () => {
  attachSessionListMetadata(noProvider.root as never)
  assert.equal(noProvider.asked.length, 1, 'attach subscribes exactly once: a second subscription would double-register')
  assert.ok(
    (noProvider.asked[0] as readonly unknown[]).includes('sessionProjections'),
    'and it waits on the projection service by name',
  )
  assert.equal(noProvider.registry.definitions.length, 0, 'no provider ever appeared, so nothing may be registered')
  assert.equal(noProvider.debug.length, 0, 'and there is nothing to report: silence is this path\'s contract')
  // Control: the very callback `attach` handed over, fired the way a provider
  // would fire it, DOES register — so the zero above is `attach` behaving, not
  // an unobservable fixture (LESSONS L-044).
  noProvider.withProvider()
  assert.equal(noProvider.registry.definitions.length, 1, 'a provider makes this exact shape register')
})

const lateDebug: string[] = []
check('no projection service at all: a callback that fires without the service is still a no-op', () => {
  // The production path never fires without a provider, but the callback keeps
  // its own guard for a composition that answers late; it must not throw and it
  // must not report anything (there is no key to report on).
  assert.doesNotThrow(() => attachSessionListMetadata(compositionRoot({}, lateDebug) as never))
  assert.equal(lateDebug.length, 0, 'nothing is registered and nothing is said')
})

const noRegisterDebug: string[] = []
check('a service without register: silent degradation', () => {
  attachSessionListMetadata(compositionRoot({
    sessionProjections: { onChanged: () => () => undefined, snapshot: () => ({ values: {} }) },
  }, noRegisterDebug) as never)
  assert.equal(noRegisterDebug.length, 1, 'the reason goes to the opt-in debug channel, once')
  assert.match(noRegisterDebug[0] ?? '', /sessionListMetadata/u, 'the debug line names the projection it skipped')
})

const conflictDebug: string[] = []
const conflicting = await freshRegistry()
conflicting.register({
  key: SESSION_LIST_METADATA_KEY,
  stateSchema: z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable(), owner: z.string() }),
  init: () => ({ blank: true, lastPromptAt: null, owner: 'someone-else' }),
  apply: (state: unknown) => state,
  stateVersion: 2,
})

check('a conflicting stateVersion degrades instead of throwing', () => {
  attachSessionListMetadata(compositionRoot({ sessionProjections: conflicting }, conflictDebug) as never)
  assert.equal(conflictDebug.length, 1, 'the conflict is reported on the debug channel only')
  assert.match(conflictDebug[0] ?? '', /sessionListMetadata/u, 'the debug line names the refused key')
})

check('a conflicting stateVersion leaves the other owner untouched', () => {
  const row = conflicting.checkpoint(session)[SESSION_LIST_METADATA_KEY]
  assert.equal(row?.ver, 2, 'the first definition keeps the key ("first registration wins")')
  assert.deepEqual(row?.val, { blank: true, lastPromptAt: null, owner: 'someone-else' })
})

await checkAsync('a real Context without the registry plugin stays quiet', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const lonely = new Context()
  attachSessionListMetadata(lonely)
  attachSessionListMetadata(lonely)
  await flush()
  assert.equal(lonely.get('sessionProjections'), undefined, 'no service ever appeared, so nothing was registered')
})

// ── 6. drift probe ─────────────────────────────────────────────────────────

section(SECTIONS[5])

/** The host line this mirror was written against (DESIGN D4, ADR-0011 §8). */
const EXPECTED_HOST_LINE = '0.2.0-rc.2'
/**
 * Where the probe looks, printed verbatim on SKIP so a miss is diagnosable.
 * Overridable **only** so the SKIP path itself can be exercised (AC-11 asks for
 * both environments): point it at a package that does not resolve and the probe
 * must report a loud SKIP instead of passing silently.
 */
const ANCHOR = process.env.DSH_TUI_HOST_ANCHOR ?? '@deepseek-ai/dsh-web-app/package.json'
const SEARCH = `${ANCHOR} -> createRequire(anchor).resolve('@deepseek-ai/dsh-api-session-controller/package.json') -> <controller>/lib/types/list.js`

interface HostProbe {
  readonly fold: Fold
  readonly anchorVersion: string
  readonly controllerVersion: string
  readonly listPath: string
  readonly definition: Record<string, unknown>
}

/** Locate the installed host's own fold and definition, or explain why not. */
async function locateHost(): Promise<HostProbe> {
  const anchor = import.meta.resolve(ANCHOR)
  const require = createRequire(anchor)
  const controllerPackage = require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')
  const listPath = join(dirname(controllerPackage), 'lib/types/list.js')
  const [list, anchorJson, controllerJson] = await Promise.all([
    import(pathToFileURL(listPath).href) as Promise<{
      applySessionListMetadata: Fold
      ApiSessionList: new (ctx: unknown) => unknown
    }>,
    Promise.resolve(JSON.parse(readFileSync(new URL(anchor), 'utf8')) as { version: string }),
    Promise.resolve(JSON.parse(readFileSync(controllerPackage, 'utf8')) as { version: string }),
  ])
  // The host's own definition, captured by constructing its owner with a stub
  // registry: this is the object the web host hands to the SAME service.
  const captured: Record<string, unknown>[] = []
  new list.ApiSessionList({
    sessionProjections: { register: (value: Record<string, unknown>) => { captured.push(value); return () => undefined } },
    inject: () => undefined,
  })
  return {
    fold: list.applySessionListMetadata,
    anchorVersion: anchorJson.version,
    controllerVersion: controllerJson.version,
    listPath,
    definition: captured[0] ?? {},
  }
}

let host: HostProbe | undefined
try {
  host = await locateHost()
} catch (error) {
  console.log('\n  ⚠️  SKIP drift probe: the installed host package could not be located.')
  console.log(`      anchor : import.meta.resolve('${ANCHOR}') from scripts/verify-session-list-metadata.ts`)
  console.log(`      search : ${SEARCH}`)
  console.log(`      reason : ${String((error as Error).message ?? error).split('\n')[0]}`)
  console.log('      effect : the mirror is UNVERIFIED against the live host here; the equivalent-shape')
  console.log('               checks of section 3 still ran. This is a SKIP, not a pass.')
}

if (host !== undefined) {
  const probe = host
  console.log(`\n  drift probe HIT: anchor ${probe.anchorVersion} -> controller ${probe.controllerVersion}`)
  console.log(`      fold: ${probe.listPath}`)

  check('the anchor resolves to the host line this mirror was written against', () => {
    assert.equal(
      probe.anchorVersion,
      EXPECTED_HOST_LINE,
      `the devDependency range is wide: re-read the host definition and re-check this mirror before accepting ${probe.anchorVersion}`,
    )
    assert.equal(probe.controllerVersion, EXPECTED_HOST_LINE, 'the anchor and the controller must come from one host line')
  })

  check('the host definition has the mirrored key, version and schema shape', () => {
    assert.equal(probe.definition.key, SESSION_LIST_METADATA_KEY)
    assert.equal(probe.definition.stateVersion, SESSION_LIST_METADATA_STATE_VERSION)
    const schema = probe.definition.stateSchema as { parse?: (value: unknown) => unknown } | undefined
    assert.equal(typeof schema?.parse, 'function', 'the host stateSchema is a zod-shaped parser')
  })

  const PARITY_EVENTS: readonly (readonly [string, SessionEvent])[] = [
    ['turn/start (clears blank)', TURN_START],
    ['turn/start again (no change)', TURN_START_LATER],
    ['human user/message (stamps lastPromptAt)', HUMAN_MESSAGE],
    ['human user/message, same time (no change)', HUMAN_MESSAGE_REPEAT],
    ['subagent user/message (no change)', SUBAGENT_MESSAGE],
    ['assistant/message (no change)', ASSISTANT_MESSAGE],
    ['tool/result (no change)', TOOL_RESULT],
    ['turn/end (no change)', TURN_END],
  ]
  const PARITY_STATES: readonly (readonly [string, SessionListMetadataState])[] = [
    ['init', initSessionListMetadata()],
    ['after turn/start', { blank: false, lastPromptAt: null }],
    ['after a human message', SPOKEN_STATE],
  ]

  check(`drift probe: ${PARITY_EVENTS.length} events x ${PARITY_STATES.length} states fold identically to the host`, () => {
    for (const [stateLabel, state] of PARITY_STATES) {
      for (const [eventLabel, one] of PARITY_EVENTS) {
        const ours = applySessionListMetadata(state, one)
        const theirs = probe.fold(state, one)
        assert.deepEqual(ours, theirs, `${stateLabel} + ${eventLabel}: the mirror must fold like the host`)
        assert.equal(
          ours === state,
          theirs === state,
          `${stateLabel} + ${eventLabel}: the same-reference optimisation must match too`,
        )
      }
    }
  })

  check('drift probe: the hand-written host fixture folds like the real host too', () => {
    // Section 4 runs with an equivalent definition so it works without the host
    // package; that copy is only trustworthy while it is checked against the
    // real thing (Knowledge Duplication: one decision, two writers).
    const fixture = webSideDefinition() as { apply: Fold }
    for (const [stateLabel, state] of PARITY_STATES) {
      for (const [eventLabel, one] of PARITY_EVENTS) {
        assert.deepEqual(
          fixture.apply(state, one),
          probe.fold(state, one),
          `${stateLabel} + ${eventLabel}: the fixture must not drift from the host`,
        )
      }
    }
  })

  check('drift probe: both sides refuse a source-less user/message', () => {
    assert.throws(() => applySessionListMetadata(initSessionListMetadata(), SOURCE_LESS_MESSAGE), TypeError)
    assert.throws(() => probe.fold(initSessionListMetadata(), SOURCE_LESS_MESSAGE), TypeError)
  })

  check('drift probe: the host schema validates a value the TUI wrote', () => {
    const schema = probe.definition.stateSchema as { parse: (value: unknown) => unknown }
    assertValidatorServesBothWriters(schema.parse.bind(schema), 'host schema')
  })

  await checkAsync('drift probe: the real registry restores our row while the host definition owns the key', async () => {
    const root = await freshRoot()
    root.registry.register(probe.definition)
    attachSessionListMetadata(root.ctx as never)
    await flush()
    const restored = root.registry.restore(
      { [SESSION_LIST_METADATA_KEY]: { ver: 1, seq: 1, val: SPOKEN_STATE } },
      SPOKEN_LOG,
      0,
      header,
      0,
    )
    assert.deepEqual(restored.checkpoint[SESSION_LIST_METADATA_KEY]?.val, SPOKEN_STATE)
  })
}

// ── 7. negative controls ───────────────────────────────────────────────────

section(SECTIONS[6])

check('the control harness itself can tell red from green', () => {
  // Without this, every `expectRed` below could be vacuous — a control that can
  // never report a miss proves nothing (LESSONS L-044).
  assert.equal(
    wentRed(() => assertFoldSemantics(applySessionListMetadata, 'meta')),
    false,
    'the real fold must NOT go red, or `expectRed` would be reporting a constant',
  )
  assert.equal(
    wentRed(() => assertFoldSemantics(mutantFold('blank-always-true'), 'meta')),
    true,
    'and a mutant MUST go red, or every control below is decoration',
  )
})

/** A fold with one term of the host formula replaced (see `assertFoldSemantics`). */
function mutantFold(term: 'blank-always-true' | 'blank-always-false' | 'no-prompt-time'): Fold {
  return (state, one) => {
    const blank = term === 'blank-always-true'
      ? true
      : term === 'blank-always-false'
        ? false
        : state.blank && one.type !== 'turn/start'
    const lastPromptAt = term === 'no-prompt-time'
      ? state.lastPromptAt
      : one.type === 'user/message' && (one.data as { source?: { kind?: string } }).source?.kind === 'user'
        ? one.time
        : state.lastPromptAt
    return blank === state.blank && lastPromptAt === state.lastPromptAt ? state : { blank, lastPromptAt }
  }
}

const unregistered = await freshRegistry()

expectRed(
  'a value-only test would not notice a missing registration',
  () => assertRowWritten(unregistered, session, 'negative control'),
  'without the registration the checkpoint has no such key — the original bug',
)

/**
 * The mirror exactly as it shipped before the `wire` was added: same key, same
 * version, same fold — and no wire. Registering it FIRST is the shipped layout
 * the regression missed (F-02), because the host's own second registration only
 * bumps `refs` and the wire-less definition keeps the key (`lib/index.js:85-93`).
 */
function mirrorWithoutWire(): Record<string, unknown> {
  const { wire, ...withoutWire } = webSideDefinition() as Record<string, unknown>
  assert.notEqual(wire, undefined, 'the fixture must actually carry a wire, or this control proves nothing')
  return withoutWire
}

const shimFirst = await freshRegistry()
shimFirst.register(mirrorWithoutWire())
shimFirst.register(webSideDefinition())

check('the pre-fix shim still wrote its checkpoint row (why the row assertions missed this)', () => {
  assertRowWritten(shimFirst, session, 'shim-first')
})

expectRed(
  'shim first without wire: the host definition is shadowed and the wire read loses the key',
  () => assertSnapshotServes(shimFirst, session, 'shim-first'),
  'lib/index.js:147 skips a definition without wire and the first definition keeps the key, so snapshot() serves {values:{}} — the real TUI-first reading before this fix',
)

expectRed(
  'blank pinned true must break the fold matrix',
  () => assertFoldSemantics(mutantFold('blank-always-true'), 'mutant'),
  'turn/start would no longer clear blank, so the shell stays hidden forever',
)

expectRed(
  'blank pinned false must break the fold matrix',
  () => assertFoldSemantics(mutantFold('blank-always-false'), 'mutant'),
  'a session with no turn at all would claim to be a real conversation and become visible',
)

expectRed(
  'lastPromptAt pinned null must break the fold matrix',
  () => assertFoldSemantics(mutantFold('no-prompt-time'), 'mutant'),
  'updatedAt = max(createdAt, lastPromptAt ?? 0) would stop following the newest prompt',
)

/** A schemastery-style validator: callable, no `.parse` (the AC-7 ④ failure). */
const callableValidator = ((value: unknown) => value) as ((value: unknown) => unknown) & { parse?: (value: unknown) => unknown }

expectRed(
  'a validator without .parse must fail the cross-runtime read',
  () => assertValidatorServesBothWriters(callableValidator, 'mutant validator'),
  'a callable that echoes its input cannot serve the host\'s stateSchema.parse call, and accepts garbage',
)

const withoutParse = await freshRegistry()
withoutParse.register({
  key: SESSION_LIST_METADATA_KEY,
  stateSchema: callableValidator,
  init: () => ({ blank: true, lastPromptAt: null }),
  apply: (state: unknown) => state,
  stateVersion: 1,
})

expectRed(
  'a validator without .parse must break the restore path',
  () => {
    withoutParse.restore(
      { [SESSION_LIST_METADATA_KEY]: { ver: 1, seq: -1, val: { blank: true, lastPromptAt: null } } },
      SPOKEN_LOG,
      0,
      header,
      0,
    )
  },
  'lib/index.js:297 parses outside a try, so a validator that cannot parse throws through the restore',
)

await checkAsync('the real schemastery Schema has no .parse (the fact this control rests on)', async () => {
  const module = await import('@deepseek-ai/schemastery') as unknown as {
    Schema?: { parse?: unknown }
    default?: { parse?: unknown }
  }
  const schema = module.Schema ?? module.default
  assert.notEqual(schema, undefined, 'schemastery resolved, so the fact is checkable')
  assert.equal(
    schema?.parse,
    undefined,
    'callable-only: passing it as stateSchema is the silent failure AC-7 ④ names',
  )
})

// ── 8. the boot-session wiring order (A-8 / T-FIX-05) ──────────────────────

section(SECTIONS[7])

/**
 * `plugin.ts` as text: the second half of the fix is a POSITION inside
 * `apply()`, so the source itself is the subject. Every anchor below is a
 * structural fragment of a statement (never a comment), asserted to occur
 * exactly once — an anchor that names no single site would make the order
 * assertion vacuous (F-07 / L-048).
 */
const pluginText = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')

/**
 * Absolute offsets of every CALL of `name(` in a plugin text. The module's own
 * `function …` definition and any mention inside a comment are excluded, so a
 * reworded docstring cannot redden this (F-10's measured false-red class).
 * @param source - A `plugin.ts` text.
 * @param name - The called name.
 * @returns Offsets into `source`, in source order.
 */
function callSitesIn(source: string, name: string): number[] {
  const sites: number[] = []
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'gu'))) {
    const site = match.index ?? -1
    if (site < 0) continue
    const prefix = source.slice(source.lastIndexOf('\n', site) + 1, site).trimStart()
    if (prefix.startsWith('//') || prefix.startsWith('*') || prefix.startsWith('/*')) continue
    sites.push(site)
  }
  return sites
}

/**
 * The offset of the ONE occurrence of a structural anchor.
 * @param source - A `plugin.ts` text.
 * @param anchor - A statement fragment that must occur exactly once.
 * @returns The offset of that occurrence.
 */
function uniqueAnchor(source: string, anchor: string): number {
  const first = source.indexOf(anchor)
  assert.notEqual(
    first,
    -1,
    `plugin.ts no longer contains ${JSON.stringify(anchor)} — re-read apply() before trusting the boot-order assertion`,
  )
  assert.equal(
    source.indexOf(anchor, first + anchor.length),
    -1,
    `${JSON.stringify(anchor)} occurs more than once in plugin.ts, so it names no single statement (F-07)`,
  )
  return first
}

/**
 * The order the boot fix rests on: the mirror must be registered BEFORE the
 * boot agent is resolved.
 *
 * `resolveAgent` is what creates or resumes the boot session, and the host
 * writes one checkpoint row per registered key at that session's `create`. A
 * mirror attached after it therefore misses the boot session's own creation
 * record: `dsh web` reads `metadata?.blank ?? false` and lists the session as
 * an untitled shell until its next checkpoint. That is the UAT-observed shape —
 * visible on the landing page, healed by the first event — and it is why
 * "registered before the channel opens" was not enough (KNOWN-ISSUES A-8).
 * @param source - A `plugin.ts` text: the real one, or the pre-fix order.
 */
function assertRegistrationPrecedesBootAgent(source: string): void {
  const registrations = callSitesIn(source, 'attachSessionListMetadata')
  assert.equal(
    registrations.length,
    1,
    `the mirror must be attached exactly once in apply() (found ${registrations.length} call sites): zero is the original bug, two would be a second definition`,
  )
  const registrationAt = registrations[0] as number
  // Both halves of `const { agent, handle, … } = … await resolveAgent(…)` — the
  // statement that creates or resumes the boot session, and the call itself.
  const bootAgentAt = Math.min(
    uniqueAnchor(source, 'const { agent, handle'),
    uniqueAnchor(source, 'await resolveAgent('),
  )
  assert.ok(
    registrationAt < bootAgentAt,
    `the mirror is registered at byte ${registrationAt}, after the boot agent is resolved at byte ${bootAgentAt}: ` +
      'the boot session\'s creation checkpoint would carry no sessionListMetadata row, so `dsh web` shows an untitled shell until the next checkpoint (A-8)',
  )
}

check('order: the session-list mirror is registered before the boot agent is resolved', () => {
  assertRegistrationPrecedesBootAgent(pluginText)
})

/**
 * The pre-fix layout, rebuilt in memory: the two positions swapped, i.e. the
 * registration put back where it sat before T-FIX-05 — after the boot session
 * exists. Nothing is written to disk; the result drives the SAME assertion body
 * as the check above, so the order assertion has to have discriminating power
 * (L-044) rather than merely being green on the shipped file.
 *
 * A failed mutation throws here rather than inside the control below: a
 * `preFixOrder()` that threw *there* would make `expectRed` report a vacuous
 * pass (LESSONS L-048 ①).
 * @returns A `plugin.ts` text carrying the pre-fix order.
 */
function preFixOrder(): string {
  const registrationCall = 'attachSessionListMetadata(ctx)\n'
  assert.equal(
    callSitesIn(pluginText, 'attachSessionListMetadata').length,
    1,
    'the swap needs exactly one call site to move, or it would be rearranging something else',
  )
  const withoutRegistration = pluginText.replace(registrationCall, '')
  assert.equal(
    withoutRegistration.length,
    pluginText.length - registrationCall.length,
    'the call site was NOT removed (a string-pattern replace that matched nothing would test the fixed text and pass)',
  )
  assert.equal(
    callSitesIn(withoutRegistration, 'attachSessionListMetadata').length,
    0,
    'the removal must leave no call site behind',
  )
  const afterBootSession = uniqueAnchor(withoutRegistration, 'let startupSession: AgentSession')
  return `${withoutRegistration.slice(0, afterBootSession)}${registrationCall}${withoutRegistration.slice(afterBootSession)}`
}

/** The swapped text, filled by the check below so a broken swap reddens the run. */
let preFixText = ''

check('order: the in-memory swap keeps one call site, so the control can only go red on the order', () => {
  preFixText = preFixOrder()
  assert.notEqual(preFixText, pluginText, 'the swap must actually change the text, or the control below proves nothing')
  assert.equal(
    callSitesIn(preFixText, 'attachSessionListMetadata').length,
    1,
    'the pre-fix text must still carry exactly one call site — otherwise the control below would be red for the wrong reason',
  )
})

expectRed(
  'order: the pre-fix layout (registered after the boot agent) must go red',
  () => assertRegistrationPrecedesBootAgent(preFixText),
  'T-FIX-05 exists because the two positions are not interchangeable: resolving the agent first creates the boot session — and therefore its first checkpoint — without our row (A-8)',
)

// ── summary ────────────────────────────────────────────────────────────────

const probeStatus = host === undefined
  ? 'SKIPPED (host package not locatable — see the SKIP block above)'
  : `HIT (host ${host.controllerVersion})`
console.log('')
if (failed.length > 0) {
  console.error(`verify-session-list-metadata: FAIL (${failed.length}/${checks} checks red; drift probe: ${probeStatus})`)
  for (const label of failed) console.error(`  - ${label}`)
  process.exit(1)
}
console.log(`verify-session-list-metadata: OK (${checks} checks; drift probe: ${probeStatus})`)
process.exit(0)
