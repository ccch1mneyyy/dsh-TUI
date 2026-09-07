#!/usr/bin/env node
/**
 * Regression: resume-seam event-type registration
 * (src/dsh-adapter/compat/sessionLog.ts, issue #153).
 *
 * Part 1 boots the REAL upstream storage stack (SessionStore + the jsonl
 * persistence backend) against a temp root. A tainted log carries the
 * pre-#143 `activity/status` residue (no ignorable marker — the shape that
 * makes resume reject whole sessions), and asserts through the backend's
 * own strict read path:
 *   1. before registration, the tainted load() rejects with
 *      SessionFormatUnsupportedError ("not marked ignorable");
 *   2. ensureLegacySessionEventTypes() flips the SAME load to success via
 *      the validator's own dsh-session copy (anchor coverage is e2e-proven,
 *      not assumed);
 *   3. the log file stays byte-identical and keeps its 0600 mode —
 *      registration never rewrites the shared store (no lost concurrent
 *      frames, no permission/checksum drift, no torn-tail parsing);
 *   4. whitelist discipline: a non-whitelisted unknown type (standing in
 *      for a FUTURE required event) still rejects after registration —
 *      upstream's fail-closed newer-harness protection is preserved;
 *   5. idempotence: a second ensure call is a harmless no-op.
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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Hand-craft one tainted log: header frame + one event frame. */
function writeTaintedLog(id, eventType, data = {}) {
  const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp/verify', delegationDepth: 0 }
  const event = { type: eventType, seq: 0, time: 2, data }
  const dir = join(root, '--tmp-verify--', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
  writeFileSync(
    file,
    Buffer.concat([
      zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8')),
      zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')),
    ]),
  )
  chmodSync(file, 0o600) // the backend's artifact mode — must survive us
  return file
}

/** Await a Jsonl plugin mount across the fork shapes cordis emits. */
async function mountJsonl(target, storeRoot) {
  const fork = target.plugin(Jsonl, { root: storeRoot })
  if (fork && typeof fork.await === 'function') await fork.await()
  else await fork
}

const legacyId = '00000000-1111-2222-3333-444444444444'
const futureId = '55555555-6666-7777-8888-999999999999'
const legacyFile = writeTaintedLog(legacyId, 'activity/status')
writeTaintedLog(futureId, 'acme/required-policy') // non-whitelisted unknown

// Fresh runtime on the same root = the resume process.
const ctx = new Context()
await ctx.plugin(SessionStore)
await mountJsonl(ctx, root)
const persistence = ctx.get('sessionPersistence')
assert.ok(persistence, 'sessionPersistence service mounted')

const tainted = [{ id: legacyId, file: legacyFile }]

// 1. Every tainted log rejects through the real validator.
for (const { id } of tainted) {
  await assert.rejects(
    () => persistence.load(id),
    (error) => {
      assert.equal(error.name, 'SessionFormatUnsupportedError', `${id} rejection name`)
      assert.match(error.message, /not marked ignorable/, `${id} rejection message`)
      return true
    },
    `${id} must reject before registration`,
  )
}

const bytesBefore = new Map(tainted.map(({ id, file }) => [id, readFileSync(file)]))
const modeBefore = new Map(tainted.map(({ id, file }) => [id, statSync(file).mode & 0o777]))

// 2. Registration flips the same loads to success.
ensureLegacySessionEventTypes()
const loadedLegacy = await persistence.load(legacyId)
assert.equal(loadedLegacy.events.length, 1, 'legacy session loads after registration')
assert.equal(loadedLegacy.events[0].type, 'activity/status')

// 3. The shared store was never rewritten.
for (const { id, file } of tainted) {
  assert.equal(Buffer.compare(readFileSync(file), bytesBefore.get(id)), 0, `${id} log bytes untouched`)
  assert.equal(statSync(file).mode & 0o777, modeBefore.get(id), `${id} log mode untouched`)
  if (process.platform !== 'win32') {
    assert.equal(modeBefore.get(id), 0o600, `${id} fixture really exercised the 0600 contract`)
  }
}

// 4. Fail-closed preserved: the non-whitelisted unknown still rejects.
await assert.rejects(
  () => persistence.load(futureId),
  /not marked ignorable/,
  'non-whitelisted unknown type must stay rejected (newer-harness protection)',
)

// 5. Whitelist/Set coherence in this tree + idempotence.
for (const type of LEGACY_SESSION_EVENT_TYPES) {
  assert.ok(KNOWN_SESSION_EVENT_TYPES.has(type), `${type} registered in this tree's copy`)
}
assert.ok(!KNOWN_SESSION_EVENT_TYPES.has('acme/required-policy'), 'unknown stays unknown')
ensureLegacySessionEventTypes() // second call: no-op, never throws
assert.equal((await persistence.load(legacyId)).events.length, 1, 'legacy still loads after re-ensure')

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
for (const prefix of ['profile', 'cli', 'validator']) {
  assert.equal(
    coverage[`${prefix}Registered`],
    true,
    `registration must reach the ${prefix} copy with the whitelisted type`,
  )
}

rmSync(fixture, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
console.log('verify-resume-legacy-events: OK')
process.exit(0)
