#!/usr/bin/env node
/**
 * Regression: resume-seam legacy event-type registration
 * (src/dsh-adapter/compat/sessionLog.ts, issue #153).
 *
 * Part 1 boots the REAL upstream storage stack (SessionStore + the jsonl
 * persistence backend) against a temp root with hand-crafted logs, and
 * asserts through the backend's own strict read path. The read API moved
 * across generations — pre-0.1.5 exposes `persistence.load`, 0.1.5 exposes
 * `open()` + `handle.read()` — so one helper hides both.
 *
 * What is asserted depends on the stack's current format version, because
 * 0.1.5 changed WHERE unknown legacy types die:
 *
 *  - On pre-V3 stacks (SESSION_FORMAT_VERSION < 3) a v0 log tainted with
 *    activity/status (the pre-#143 shape from issue #153) is rejected by the
 *    current-generation validator's KNOWN-set check, and registration flips
 *    the SAME read to success:
 *      1. before registration, the read rejects with
 *         SessionFormatUnsupportedError ("not marked ignorable");
 *      2. ensureLegacySessionEventTypes() flips the read to success;
 *      3. the log file stays byte-identical and keeps its 0600 mode;
 *      4. a non-whitelisted unknown type still rejects after registration —
 *         upstream's fail-closed newer-harness protection is preserved;
 *      5. idempotence: a second ensure call is a harmless no-op.
 *
 *  - On V3 stacks (0.1.5+, SESSION_FORMAT_VERSION >= 3) historical logs are
 *    MIGRATED generation by generation, and the migration refuses unknown
 *    historical event types without consulting KNOWN — registration cannot
 *    rescue a tainted v0 log there (an upstream design change, asserted here
 *    as the known limitation: the read rejects with
 *    SessionFormatUnsupportedError "unknown historical event type ...
 *    migration refuses" BOTH before and after registration, and the source
 *    v0 artifact stays byte-identical). The registration seam keeps its
 *    service object for CURRENT-generation logs, whose validator still
 *    consults the KNOWN set: a v3 log tainted with activity/status rejects
 *    ("not marked ignorable") before registration and loads after it, with
 *    bytes and 0600 mode untouched, while a non-whitelisted unknown type in
 *    a v3 log stays rejected.
 *
 * Part 2 builds a split CLI/profile-tree fixture (issue #153 review): the
 * TUI module lives in a profile tree, the launcher and the persistence
 * validator in a separate CLI tree, and the validator resolves its OWN
 * physical dsh-session copy — three distinct module instances. A child
 * process launched from the CLI tree runs the compiled
 * ensureLegacySessionEventTypes and must register ALL THREE copies
 * (profile, CLI-direct, validator-nested), proving the anchor walk covers
 * trees the lockfile's single-copy layout cannot exercise here.
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-legacy-'))
const {
  ensureLegacySessionEventTypes,
  LEGACY_SESSION_EVENT_TYPES,
} = await import('../lib/types/dsh-adapter/compat/sessionLog.js')

/**
 * Read every stored event of one session through the backend's strict path.
 * `load()` is the pre-0.1.5 API; 0.1.5 replaced it with open() + read().
 */
async function readAllEvents(persistence, id) {
  if (typeof persistence.load === 'function') {
    const loaded = await persistence.load(id)
    return loaded.events
  }
  const handle = await persistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

/** Hand-craft one log: header frame + one event frame per event. */
function writeLog(id, fileName, header, events) {
  const dir = join(root, '--tmp-verify--', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  writeFileSync(
    file,
    Buffer.concat(
      [header, ...events].map(record =>
        zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8')),
      ),
    ),
  )
  chmodSync(file, 0o600) // the backend's artifact mode — must survive us
  return file
}

/** A stored v0 log as the pre-#143 writers left it (no isSeeded field). */
function writeLegacyV0Log(id, eventType) {
  return writeLog(
    id,
    'session.jsonl.zstd',
    { type: 'session', version: 0, id, createdAt: 1, cwd: '/tmp/verify', delegationDepth: 0 },
    [{ type: eventType, seq: 0, time: 2, data: {} }],
  )
}

/** A stored current-generation (V3) log: session.vN.jsonl.zstd, isSeeded header. */
function writeCurrentLog(id, eventType) {
  return writeLog(
    id,
    `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`,
    {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      isSeeded: false,
      cwd: '/tmp/verify',
      delegationDepth: 0,
    },
    [{ type: eventType, seq: 0, time: 2, data: {} }],
  )
}

const ctx = new Context()
await ctx.plugin(SessionStore)
const fork = ctx.plugin(Jsonl, { root })
if (fork && typeof fork.await === 'function') await fork.await()
else await fork
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence, 'sessionPersistence service mounted')

// 0.1.5 migrates historical logs generation by generation and its migration
// refuses unknown historical types without consulting the KNOWN set; older
// stacks validate the log AS the current format, where KNOWN is consulted.
const migrationRefusesUnknown = SESSION_FORMAT_VERSION >= 3

const legacyId = '00000000-1111-2222-3333-444444444444'
const legacyFile = writeLegacyV0Log(legacyId, 'activity/status')
const bytesBefore = readFileSync(legacyFile)
const modeBefore = statSync(legacyFile).mode & 0o777

if (!migrationRefusesUnknown) {
  // --- pre-V3 stack: the original issue #153 assertions ---------------------
  // 1. The exact issue #153 failure, through the real validator.
  await assert.rejects(
    () => readAllEvents(persistence, legacyId),
    (error) => {
      assert.equal(error.name, 'SessionFormatUnsupportedError')
      assert.match(error.message, /not marked ignorable/)
      return true
    },
    'tainted log must reject before registration',
  )

  // 2. Registration flips the same load to success.
  ensureLegacySessionEventTypes()
  const events = await readAllEvents(persistence, legacyId)
  assert.equal(events.length, 1, 'legacy session loads after registration')
  assert.equal(events[0].type, 'activity/status')

  // 3. The shared store was never rewritten.
  assert.equal(Buffer.compare(readFileSync(legacyFile), bytesBefore), 0, 'log bytes untouched')
  assert.equal(statSync(legacyFile).mode & 0o777, modeBefore, 'log mode untouched')
  if (process.platform !== 'win32') {
    assert.equal(modeBefore, 0o600, 'fixture really exercised the 0600 contract')
  }

  // 4. Fail-closed preserved: the non-whitelisted unknown still rejects.
  const futureId = '55555555-6666-7777-8888-999999999999'
  writeLegacyV0Log(futureId, 'acme/required-policy') // non-whitelisted unknown
  await assert.rejects(
    () => readAllEvents(persistence, futureId),
    /not marked ignorable/,
    'non-whitelisted unknown type must stay rejected (newer-harness protection)',
  )

  // 5. Idempotence.
  ensureLegacySessionEventTypes() // second call: no-op, never throws
  assert.equal((await readAllEvents(persistence, legacyId)).length, 1, 'still loads after re-ensure')
} else {
  // --- V3 stack (0.1.5+): migration refusal + current-generation seam -------
  // 1. Historical v0 logs die in MIGRATION, which never consults KNOWN:
  //    registration cannot rescue them. Asserted as the known upstream
  //    limitation (a tainted pre-V3 log needs the type whitelisted by the
  //    plugin that wrote it AND a harness whose migration classifies it).
  const assertMigrationRefusal = (error) => {
    assert.equal(error.name, 'SessionFormatUnsupportedError')
    assert.match(error.message, /unknown historical event type/)
    assert.match(error.message, /migration refuses/)
    return true
  }
  await assert.rejects(
    () => readAllEvents(persistence, legacyId),
    assertMigrationRefusal,
    'tainted v0 log must reject before registration',
  )

  // 2. Current-generation logs still go through the validator that consults
  //    the KNOWN set: the exact issue #153 failure shape, one generation up.
  const currentId = '11111111-2222-3333-4444-555555555555'
  const currentFile = writeCurrentLog(currentId, 'activity/status')
  await assert.rejects(
    () => readAllEvents(persistence, currentId),
    (error) => {
      assert.equal(error.name, 'SessionFormatUnsupportedError')
      assert.match(error.message, /not marked ignorable/)
      return true
    },
    'tainted v3 log must reject before registration',
  )
  const currentBytes = readFileSync(currentFile)
  const currentMode = statSync(currentFile).mode & 0o777

  ensureLegacySessionEventTypes()

  // 3. Registration cannot rescue the historical log (upstream design
  //    change), and the failed migration never rewrote the source artifact.
  await assert.rejects(
    () => readAllEvents(persistence, legacyId),
    assertMigrationRefusal,
    'migration refuses unknown historical types regardless of registration',
  )
  assert.equal(Buffer.compare(readFileSync(legacyFile), bytesBefore), 0, 'v0 log bytes untouched')
  assert.equal(statSync(legacyFile).mode & 0o777, modeBefore, 'v0 log mode untouched')
  if (process.platform !== 'win32') {
    assert.equal(modeBefore, 0o600, 'fixture really exercised the 0600 contract')
  }

  // 4. Registration flips the CURRENT-generation tainted log to success —
  //    the seam's remaining service object — without rewriting the artifact.
  const events = await readAllEvents(persistence, currentId)
  assert.equal(events.length, 1, 'current-generation tainted log loads after registration')
  assert.equal(events[0].type, 'activity/status')
  assert.equal(Buffer.compare(readFileSync(currentFile), currentBytes), 0, 'v3 log bytes untouched')
  assert.equal(statSync(currentFile).mode & 0o777, currentMode, 'v3 log mode untouched')

  // 5. Fail-closed preserved on the current generation: a non-whitelisted
  //    unknown type (standing in for a FUTURE required event) still rejects.
  const futureId = '55555555-6666-7777-8888-999999999999'
  writeCurrentLog(futureId, 'acme/required-policy')
  await assert.rejects(
    () => readAllEvents(persistence, futureId),
    (error) => {
      assert.equal(error.name, 'SessionFormatUnsupportedError')
      assert.match(error.message, /not marked ignorable/)
      return true
    },
    'non-whitelisted unknown type must stay rejected (newer-harness protection)',
  )

  // 6. Idempotence.
  ensureLegacySessionEventTypes() // second call: no-op, never throws
  assert.equal((await readAllEvents(persistence, currentId)).length, 1, 'still loads after re-ensure')
}

// Whitelist/Set coherence in this tree (generation-agnostic).
for (const type of LEGACY_SESSION_EVENT_TYPES) {
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has(type), `${type} registered in this tree's copy`)
}
assert.ok(!KNOWN_SESSION_EVENT_TYPES.has('acme/required-policy'), 'unknown stays unknown')

// --- part 2: split CLI/profile trees ---------------------------------------
// Three PHYSICAL dsh-session copies (stub packages — anchor coverage is
// about module identity, not package content; part 1 covers the real one):
// A1 = CLI tree direct copy, A2 = the CLI validator's nested copy,
// B = the profile tree's copy (the TUI module's own tree).
const fixture = mkdtempSync(join(tmpdir(), 'dsh-tui-split-'))
const cliTree = join(fixture, 'cli')
const profileTree = join(fixture, 'profile')

const sessionStubPkg = { name: '@deepseek-ai/dsh-session', version: '0.1.0-rc.6', type: 'module', main: './lib/index.js', exports: { '.': './lib/index.js' } }
const sessionStubEntry = "export const KNOWN_SESSION_EVENT_TYPES = new Set(['user/message', 'assistant/message'])\n"
const writeSessionCopy = (dest) => {
  mkdirSync(join(dest, 'lib'), { recursive: true })
  writeFileSync(join(dest, 'package.json'), JSON.stringify(sessionStubPkg, null, 2))
  writeFileSync(join(dest, 'lib', 'index.js'), sessionStubEntry)
}
const cliSession = join(cliTree, 'node_modules', '@deepseek-ai', 'dsh-session')
const validatorPkg = join(cliTree, 'node_modules', '@deepseek-ai', 'dsh-session-persistence')
const validatorSession = join(validatorPkg, 'node_modules', '@deepseek-ai', 'dsh-session')
const profileSession = join(profileTree, 'node_modules', '@deepseek-ai', 'dsh-session')
writeSessionCopy(cliSession)
writeSessionCopy(validatorSession)
writeSessionCopy(profileSession)
mkdirSync(join(validatorPkg, 'lib'), { recursive: true })
writeFileSync(
  join(validatorPkg, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-session-persistence', version: '0.1.0-rc.6', type: 'module', main: './lib/index.js', exports: { '.': './lib/index.js' } }, null, 2),
)
writeFileSync(join(validatorPkg, 'lib', 'index.js'), 'export {}\n')

// The unit under test: the COMPILED compat module, placed in the profile
// tree with its relative-import layout intact.
const tuiPkg = join(profileTree, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const profileCompat = join(tuiPkg, 'lib', 'types', 'dsh-adapter', 'compat')
mkdirSync(profileCompat, { recursive: true })
mkdirSync(join(tuiPkg, 'lib', 'types', 'utils'), { recursive: true })
cpSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'types', 'dsh-adapter', 'compat', 'sessionLog.js'),
  join(profileCompat, 'sessionLog.js'),
)
cpSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'types', 'utils', 'paths.js'),
  join(tuiPkg, 'lib', 'types', 'utils', 'paths.js'),
)
writeFileSync(join(tuiPkg, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.0.0-fixture', type: 'module' }))

const launcherPath = join(cliTree, 'launcher.js')
const profileEntry = join(profileCompat, 'sessionLog.js')
writeFileSync(
  launcherPath,
  `'use strict'
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
async function main() {
  const profileEntry = process.env.SPLIT_PROFILE_ENTRY
  const mod = await import(pathToFileURL(profileEntry).href)
  mod.ensureLegacySessionEventTypes()
  const profileReq = createRequire(profileEntry)
  const cliReq = createRequire(process.argv[1])
  const validatorReq = createRequire(cliReq.resolve('@deepseek-ai/dsh-session-persistence'))
  const copies = [
    profileReq('@deepseek-ai/dsh-session'),
    cliReq('@deepseek-ai/dsh-session'),
    validatorReq('@deepseek-ai/dsh-session'),
  ]
  console.log(JSON.stringify({
    distinctCopies: copies[0] !== copies[1] && copies[1] !== copies[2] && copies[0] !== copies[2],
    profileRegistered: copies[0].KNOWN_SESSION_EVENT_TYPES.has('activity/status'),
    cliRegistered: copies[1].KNOWN_SESSION_EVENT_TYPES.has('activity/status'),
    validatorRegistered: copies[2].KNOWN_SESSION_EVENT_TYPES.has('activity/status'),
  }))
}
main().catch((error) => { console.error(error); process.exit(1) })
`,
)
const launched = spawnSync(process.execPath, [launcherPath], {
  env: { ...process.env, SPLIT_PROFILE_ENTRY: profileEntry },
  encoding: 'utf8',
})
assert.equal(launched.status, 0, `split fixture child failed:\n${launched.stderr}`)
const coverage = JSON.parse(launched.stdout.trim().split('\n').at(-1))
assert.equal(coverage.distinctCopies, true, 'fixture must hold three distinct dsh-session instances')
assert.deepEqual(
  {
    profileRegistered: coverage.profileRegistered,
    cliRegistered: coverage.cliRegistered,
    validatorRegistered: coverage.validatorRegistered,
  },
  { profileRegistered: true, cliRegistered: true, validatorRegistered: true },
  'registration must reach the profile tree, the CLI tree, AND the validator-own copy',
)

rmSync(fixture, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
console.log('verify-resume-legacy-events: OK')
process.exit(0)
