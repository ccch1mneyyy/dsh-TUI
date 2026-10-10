/**
 * Session write-lease regression — the exit sweep must not delete a session
 * another process is writing (change `dsh-tui-unspoken-session-leak`,
 * REVIEW CR-2 / T-FIX-18).
 *
 * `dsh web` opens its own "new session" placeholder in the SHARED session
 * store: no person prompted there (layer ① correctly says `hasPrompt:false`),
 * its log is a header-only shell (layer ② sees no conversation) and `dsh web`
 * never writes the TUI's mount ledger (layer ③'s `held-elsewhere` cannot see
 * it). The host's exclusive write lease can, and this file drives it for real:
 * the fixture owns its lease through the shipping JSONL persistence backend
 * (the same `acquireWriteLease` a peer's write handle takes), against a real
 * temporary sessions root that `findSessionLogFile` resolves.
 *
 * Covered:
 *   1. The probe answers from the host's own arbiter: `held` while a
 *      `SessionWriteLease` is open on the fixture log, `free` once released.
 *   2. ① A write-leased shell is SPARED by the sweep with the new
 *      `write-leased` reason, and its log is still on disk afterwards.
 *   3. ② The identical fixture with no holder is DELETED — the exit sweep's
 *      behavior is unchanged where nothing holds the session.
 *   4. ③ A probe that cannot answer (platform-unsupported / any non-contention
 *      failure) spares: an unproven session is never deleted.
 *   5. ④ Negative control: a probe that always reports `free` deletes the very
 *      session case ② keeps — case ① cannot be satisfied by a constant, and
 *      "not consulted at all" is shown to be a different (and unsafe) world.
 *   6. ⑤ The reason is distinguishable from the ledger's `held-elsewhere`: a
 *      lease-only holder reports `write-leased`, a ledger holder keeps
 *      `held-elsewhere`, and the new reason is not a synonym of the old one.
 *   7. Probe failures are classified, never thrown: an unreachable service, a
 *      service without the lease method, a non-contention rejection and a
 *      lease this process cannot release all read `unknown`.
 *   8. The pre-pass is bounded, ordered and fail-soft: the round's cap limits
 *      the probes, a header without `cwd` proves nothing, a throwing header
 *      read costs one entry, and an unreadable index proves nothing at all.
 *   9. The wiring: `sweepUnspokenOnExit` carries the proof into the round, and
 *      the exit branch gathers it BEFORE the notice it feeds (so the count in
 *      the notice still belongs to one finished round).
 *
 * Run: node --import tsx/esm scripts/verify-session-write-lease.ts
 * The sessions root, the DSH home and `~/.dsh-tui` are ALL redirected under one
 * disposable mkdtemp directory before the module under test is imported, and
 * the real user index is never read (the round's index stays a fixture).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
// Type-only, so it is erased: the value imports below must stay AFTER the env
// override (sessionsRoots() reads DSH_TUI_SESSION_ROOT at import time).
import type { UnspokenIndexEntry, UnspokenSweepDeps, UnspokenSweepResult } from '../src/dsh-adapter/unspoken-sessions.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-write-lease-'))
// Registered BEFORE the imports below, so a red run still cleans up.
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true })
})
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'dsh')
const sessionsRoot = join(root, 'logs')
process.env.DSH_TUI_SESSION_ROOT = sessionsRoot

const { Context } = await import('@deepseek-ai/cordis')
const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const { provenWriteLeaseFree, sweepUnspokenSessions } = await import('../src/dsh-adapter/unspoken-sessions.js')
const { createWriteLeaseProbe } = await import('../src/dsh-adapter/compat/writeLease.js')
const { sweepUnspokenOnExit } = await import('../src/dsh-adapter/plugin.js')
const { readFileSync } = await import('node:fs')

let cases = 0
let checks = 0
let failures = 0

/** Count one assertion and label its failure with what it was proving. */
async function check(label: string, body: () => void | Promise<void>): Promise<void> {
  checks += 1
  try {
    await body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    const message = String((error as Error).message ?? error).replaceAll('\n', ' | ').slice(0, 400)
    console.error(`  FAIL ${label}\n       ${message}`)
  }
}

/** Announce one case; the checks under it carry the verdict. */
function case_(label: string): void {
  cases += 1
  console.log(`\n${cases}. ${label}`)
}

/** Start one case's fixture from an empty index (nested cases keep theirs). */
const freshIndex = (): void => {
  index.clear()
}

/* ── the shipping backend, on the temporary root ─────────────────────────── */

/** The lease surface this regression needs from the persistence service. */
interface LeaseSeam {
  acquireWriteLease(header: { readonly id: string; readonly cwd: string }): Promise<{ release(): Promise<void> }>
}

const ctx = new Context()
const fiber = ctx.plugin(JsonlSessionPersistence as never, { root: sessionsRoot })

/** Resolve the persistence service the backend registered. */
async function persistenceService(): Promise<LeaseSeam> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const service = (ctx as { get(name: string): unknown }).get('sessionPersistence')
    if (service !== undefined) return service as LeaseSeam
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the JSONL persistence service never became ready')
}

const service = await persistenceService()
const probe = createWriteLeaseProbe(() => service)

/* ── the fixture ─────────────────────────────────────────────────────────── */

const index = new Map<string, UnspokenIndexEntry>()
/** One shell: promptless in the index, exactly what the sweep collects. */
const shell = (sessionId: string): void => {
  index.set(sessionId, { derived: { hasPrompt: false } })
}

/**
 * Hold one session's write lease, as a peer writer (`dsh web`) would: the
 * backend creates the session directory and keeps the kernel lock until the
 * returned holder is released.
 */
const holdLease = async (sessionId: string, cwd: string): Promise<{ release(): Promise<void> }> =>
  service.acquireWriteLease({ id: sessionId, cwd })

/** The session directory the backend derived for one id. */
const dirOf = (sessionId: string): string | undefined => {
  for (const project of readdirSync(sessionsRoot)) {
    const candidate = join(sessionsRoot, project, sessionId)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Write the header-only durable log the sweep reads: one physical `session`
 * row and no events, the shape `dsh web`'s own placeholder materializes.
 * @param sessionId - Session directory name.
 * @param cwd - The `cwd` the physical header records (what the lease is keyed by).
 * @returns The artifact path.
 */
const writeShellLog = (sessionId: string, cwd: string): string => {
  const dir = dirOf(sessionId)
  assert.ok(dir !== undefined, `holding the lease must create ${sessionId}'s directory`)
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(path, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd })}\n`)))
  return path
}

/** The round's process facts, with the lease proof under test. */
const sweepDeps = (writeLeaseFree?: (sessionId: string) => boolean): UnspokenSweepDeps => ({
  readIndex: () => index,
  currentSessionId: () => undefined,
  liveSessionIds: () => new Set<string>(),
  isSubagentOrDescendant: () => false,
  ...(writeLeaseFree === undefined ? {} : { writeLeaseFree }),
})

/** The reason one id was spared, if it was. */
const reasonOf = (result: UnspokenSweepResult, sessionId: string): string | undefined =>
  result.skipped.find(row => row.id === sessionId)?.reason

/** Run the shipping pre-pass against the fixture index. */
const prove = async (sessionId: string, implementation = probe): Promise<boolean> => {
  const predicate = await provenWriteLeaseFree(implementation, { readIndex: () => index })
  return predicate(sessionId)
}

/* ── 1. the probe reads the host's arbiter ───────────────────────────────── */

case_('the probe reads the host write lease: held while a writer owns the session, free once released')
{
  freshIndex()
  const cwd = '/fixture/lease-probe'
  shell('probe-shell')
  const holder = await holdLease('probe-shell', cwd)
  writeShellLog('probe-shell', cwd)
  const held = await probe('probe-shell', cwd)
  await check('an open write lease reads held', () => {
    assert.equal(held, 'held')
  })
  await holder.release()
  const freed = await probe('probe-shell', cwd)
  await check('the released lease reads free', () => {
    assert.equal(freed, 'free')
  })
}

/* ── 2. ① a write-leased shell survives the sweep ────────────────────────── */

case_('① a shell another writer holds is spared with write-leased, and its log stays on disk')
{
  freshIndex()
  const sessionId = 'leased-shell'
  const cwd = '/fixture/leased'
  shell(sessionId)
  const holder = await holdLease(sessionId, cwd)
  const logPath = writeShellLog(sessionId, cwd)
  const writeLeaseFree = await provenWriteLeaseFree(probe, { readIndex: () => index })
  await check('the pre-pass does not prove the held session free', () => {
    assert.equal(writeLeaseFree(sessionId), false)
  })
  const result = sweepUnspokenSessions(sweepDeps(writeLeaseFree))
  await check('nothing is deleted', () => {
    assert.deepEqual([...result.deleted], [])
  })
  await check('the reason is the write lease, not the ledger', () => {
    assert.equal(reasonOf(result, sessionId), 'write-leased')
  })
  await check('the log is still there', () => {
    assert.ok(existsSync(logPath), `the held session log was removed: ${logPath}`)
  })

  /* ── 3. ② the same shape with no holder is still deleted ──────────────── */
  case_('② the identical shell with no holder is still deleted — the round is otherwise unchanged')
  await holder.release()
  const released = await provenWriteLeaseFree(probe, { readIndex: () => index })
  await check('the pre-pass proves the released session free', () => {
    assert.equal(released(sessionId), true)
  })
  const swept = sweepUnspokenSessions(sweepDeps(released))
  await check('it is deleted', () => {
    assert.deepEqual([...swept.deleted], [sessionId])
  })
  await check('and its log is gone', () => {
    assert.equal(existsSync(logPath), false)
  })
}

/* ── 4. ③ a probe that cannot answer spares ─────────────────────────────── */

case_('③ a probe that fails for a non-contention reason spares the session rather than guessing')
{
  freshIndex()
  const sessionId = 'unprovable-shell'
  const cwd = '/fixture/unprovable'
  shell(sessionId)
  const holder = await holdLease(sessionId, cwd)
  await holder.release()
  const logPath = writeShellLog(sessionId, cwd)
  const unsupported = async (): Promise<never> => {
    // The POSIX addon's own refusal on an unsupported platform, verbatim.
    throw Object.assign(new Error('flock is not supported on win32-x64'), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    })
  }
  const writeLeaseFree = await provenWriteLeaseFree(unsupported, { readIndex: () => index })
  const result = sweepUnspokenSessions(sweepDeps(writeLeaseFree))
  await check('an unavailable probe proves nothing', () => {
    assert.equal(writeLeaseFree(sessionId), false)
  })
  await check('the session is spared with the same reason', () => {
    assert.equal(reasonOf(result, sessionId), 'write-leased')
  })
  await check('the log is untouched', () => {
    assert.ok(existsSync(logPath))
  })
  await check('a probe that answers unknown spares too', async () => {
    assert.equal(await prove(sessionId, async () => 'unknown'), false)
  })
}

/* ── 5. ④ the negative control ──────────────────────────────────────────── */

case_('④ negative control: a probe that always says free deletes the leased session')
{
  freshIndex()
  const sessionId = 'constant-free-shell'
  const cwd = '/fixture/constant-free'
  shell(sessionId)
  const holder = await holdLease(sessionId, cwd)
  const logPath = writeShellLog(sessionId, cwd)
  const constantFree = await provenWriteLeaseFree(async () => 'free', { readIndex: () => index })
  await check('the constant satisfies the proof', () => {
    assert.equal(constantFree(sessionId), true)
  })
  const result = sweepUnspokenSessions(sweepDeps(constantFree))
  await check('the leased session is deleted — so case ① cannot be green on a constant', () => {
    assert.deepEqual([...result.deleted], [sessionId])
    assert.equal(existsSync(logPath), false)
  })
  await holder.release()

  case_('④b negative control: the round with no proof at all is the pre-fix world, which deletes it too')
  const secondId = 'no-proof-shell'
  const secondCwd = '/fixture/no-proof'
  shell(secondId)
  const secondHolder = await holdLease(secondId, secondCwd)
  const secondLog = writeShellLog(secondId, secondCwd)
  const unguarded = sweepUnspokenSessions(sweepDeps())
  await check('without the seam the layer is not consulted and the session goes', () => {
    assert.deepEqual([...unguarded.deleted], [secondId])
    assert.equal(existsSync(secondLog), false)
  })
  await secondHolder.release()
}

/* ── 6. ⑤ the new reason is not a synonym of the ledger's ───────────────── */

case_('⑤ a ledger holder keeps held-elsewhere while a lease-only holder reports write-leased')
{
  freshIndex()
  const ledgerId = 'ledger-shell'
  const leaseId = 'lease-only-shell'
  for (const id of [ledgerId, leaseId]) shell(id)
  const holder = await holdLease(leaseId, '/fixture/lease-only')
  writeShellLog(leaseId, '/fixture/lease-only')
  // The ledger fixture needs a real shell log too: layer ② runs before layer ③
  // and an absent log would spare it for the wrong reason (`log-absent`).
  const ledgerWriter = await holdLease(ledgerId, '/fixture/ledger')
  await ledgerWriter.release()
  writeShellLog(ledgerId, '/fixture/ledger')
  const writeLeaseFree = await provenWriteLeaseFree(probe, { readIndex: () => index })
  const result = sweepUnspokenSessions({
    ...sweepDeps(writeLeaseFree),
    // The ledger's own fact, injected the way the exit path injects it.
    occupiedElsewhere: () => new Set([ledgerId]),
  })
  await check('the ledger fact keeps its own reason', () => {
    assert.equal(reasonOf(result, ledgerId), 'held-elsewhere')
  })
  await check('the lease fact reports its own, and the two differ', () => {
    assert.equal(reasonOf(result, leaseId), 'write-leased')
    assert.notEqual(reasonOf(result, ledgerId), reasonOf(result, leaseId))
  })
  await holder.release()
}

/* ── 7. probe failures are classified, never thrown ─────────────────────── */

case_('probe failures read unknown: no service, no lease method, a foreign error, an unreleasable lease')
{
  const cwd = '/fixture/classified'
  await check('a host that throws is unknown', async () => {
    const throwing = createWriteLeaseProbe(() => { throw new Error('context gone') })
    assert.equal(await throwing('x', cwd), 'unknown')
  })
  await check('a service without the lease method is unknown', async () => {
    assert.equal(await createWriteLeaseProbe(() => ({}))('x', cwd), 'unknown')
  })
  await check('an absent service is unknown', async () => {
    assert.equal(await createWriteLeaseProbe(() => undefined)('x', cwd), 'unknown')
  })
  await check('a non-contention rejection is unknown', async () => {
    const foreign = createWriteLeaseProbe(() => ({
      acquireWriteLease: async () => { throw Object.assign(new Error('EACCES: open'), { code: 'EACCES' }) },
    }))
    assert.equal(await foreign('x', cwd), 'unknown')
  })
  await check('a lease that cannot be released is unknown, not free', async () => {
    const stuck = createWriteLeaseProbe(() => ({
      acquireWriteLease: async () => ({ release: async () => { throw new Error('close failed') } }),
    }))
    assert.equal(await stuck('x', cwd), 'unknown')
  })
  await check('the host contention verdict is held', async () => {
    const contended = createWriteLeaseProbe(() => ({
      acquireWriteLease: async () => {
        throw Object.assign(new Error('session "x" is already owned by an active write handle'), {
          name: 'SessionAlreadyOwnedError',
        })
      },
    }))
    assert.equal(await contended('x', cwd), 'held')
  })
  await check('a granted lease is free and is handed straight back', async () => {
    let released = false
    const granted = createWriteLeaseProbe(() => ({
      acquireWriteLease: async () => ({ release: async () => { released = true } }),
    }))
    assert.equal(await granted('x', cwd), 'free')
    assert.ok(released, 'the probe must not keep the lock it took')
  })
}

/* ── 8. the pre-pass is bounded and fail-soft ───────────────────────────── */

case_('the pre-pass honors the round cap, skips entries it cannot name, and proves nothing without an index')
{
  const cappedIndex = new Map<string, UnspokenIndexEntry>([
    ['cap-a', { derived: { hasPrompt: false } }],
    ['cap-b', { derived: { hasPrompt: false } }],
    ['prompted', { derived: { hasPrompt: true } }],
  ])
  const probed: string[] = []
  const counted = async (sessionId: string): Promise<'free'> => {
    probed.push(sessionId)
    return 'free'
  }
  const mixed = new Map<string, UnspokenIndexEntry>([
    ['bad', { derived: { hasPrompt: false } }],
    ['good', { derived: { hasPrompt: false } }],
  ])
  const capped = await provenWriteLeaseFree(counted, {
    readIndex: () => cappedIndex,
    readSessionHeader: sessionId => ({ id: sessionId, cwd: '/fixture/cap' }) as never,
    maxCandidates: 1,
  })
  await check('only the cap\'s worth of entries is probed, in the round\'s order', () => {
    assert.deepEqual(probed, ['cap-a'])
    assert.equal(capped('cap-a'), true)
    assert.equal(capped('cap-b'), false)
  })
  await check('a prompted entry is never probed', () => {
    assert.equal(probed.includes('prompted'), false)
  })
  await check('a header without cwd proves nothing', async () => {
    const noCwd = await provenWriteLeaseFree(counted, {
      readIndex: () => new Map([['no-cwd', { derived: { hasPrompt: false } }]]),
      readSessionHeader: () => undefined,
    })
    assert.equal(noCwd('no-cwd'), false)
  })
  await check('a throwing header read costs one entry, not the round', async () => {
    const predicate = await provenWriteLeaseFree(counted, {
      readIndex: () => mixed,
      readSessionHeader: sessionId => {
        if (sessionId === 'bad') throw new Error('torn first frame')
        return { id: sessionId, cwd: '/fixture/mixed' } as never
      },
    })
    assert.equal(predicate('bad'), false)
    assert.equal(predicate('good'), true)
  })
  await check('an unreadable index proves nothing at all', async () => {
    const unreadable = await provenWriteLeaseFree(counted, {
      readIndex: () => { throw new Error('index unreadable') },
    })
    assert.equal(unreadable('cap-a'), false)
  })
  await check('a probe that throws spares its own entry only', async () => {
    const predicate = await provenWriteLeaseFree(async sessionId => {
      if (sessionId === 'bad') throw new Error('probe boom')
      return 'free'
    }, {
      readIndex: () => mixed,
      readSessionHeader: sessionId => ({ id: sessionId, cwd: '/fixture/mixed' }) as never,
    })
    assert.equal(predicate('bad'), false)
    assert.equal(predicate('good'), true)
  })
}

/* ── 9. the wiring ──────────────────────────────────────────────────────── */

case_('the exit wiring carries the proof into the round and gathers it before the notice')
{
  freshIndex()
  const sessionId = 'wired-shell'
  const cwd = '/fixture/wired'
  shell(sessionId)
  const holder = await holdLease(sessionId, cwd)
  writeShellLog(sessionId, cwd)
  const writeLeaseFree = await provenWriteLeaseFree(probe, { readIndex: () => index })
  const swept = sweepUnspokenOnExit({
    currentSessionId: () => undefined,
    liveSessionIds: () => new Set<string>(),
    listedSessions: () => [{ id: sessionId }],
    writeLeaseFree,
    // The store seams the exit regression also injects: this file keeps its
    // fixtures out of the real index, the wiring under test is the lease seam.
    sweep: deps => sweepUnspokenSessions({ ...deps, readIndex: () => index }),
  })
  await check('sweepUnspokenOnExit carries writeLeaseFree into the round', () => {
    assert.notEqual(swept, undefined)
    assert.deepEqual([...(swept as UnspokenSweepResult).deleted], [])
    assert.equal(reasonOf(swept as UnspokenSweepResult, sessionId), 'write-leased')
  })
  await holder.release()

  const source = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const from = source.indexOf('// Judge against the live session behind the channel')
  const to = source.indexOf('\n    },', from)
  const block = from === -1 || to <= from ? '' : source.slice(from, to)
  await check('the branch builds the proof through the probe factory', () => {
    assert.match(block, /await\s+provenWriteLeaseFree\(\s*createWriteLeaseProbe\(/u)
  })
  await check('the proof is gathered BEFORE the round it feeds, and the notice comes after the round', () => {
    const proofAt = block.search(/await\s+provenWriteLeaseFree\(/u)
    const sweepAt = block.search(/\bsweepUnspokenOnExit\s*\(/u)
    const noticeAt = block.search(/composeExitNotice\s*\(/u)
    assert.ok(proofAt !== -1 && sweepAt !== -1 && noticeAt !== -1, `anchors: proof@${proofAt} sweep@${sweepAt} notice@${noticeAt}`)
    assert.ok(proofAt < sweepAt && sweepAt < noticeAt, `order: proof@${proofAt} sweep@${sweepAt} notice@${noticeAt}`)
  })
  await check('a pre-pass that cannot run leaves the round with a fail-closed predicate', () => {
    assert.match(block, /let\s+writeLeaseFree[^\n]*=\s*\(\)\s*=>\s*false/u)
  })
}

try {
  await Promise.resolve((fiber as { dispose(): unknown }).dispose()).catch(() => {})
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${cases - failures}/${cases} cases passed, ${checks} checks`)
if (failures > 0) {
  console.error(`${failures} session write-lease regressions failed`)
  process.exit(1)
}
console.log('session write-lease regression: OK')
