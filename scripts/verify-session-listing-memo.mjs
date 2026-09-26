#!/usr/bin/env node
/**
 * Regression: the /resume listing memo (issue #987) and the rename invalidate.
 *
 * The process-level memo in `sessions/cache.ts` serves the previous listing
 * for 3 s and re-derives only when the TTL expires, one of the two cache-file
 * fingerprints (`session-index.json` / `last-used.json`, each an
 * (mtime, size) pair) moves, an explicit `invalidateListedSessions()` lands,
 * or the caller asks for `bypass`. Every one of those doors can rot shut
 * silently, so each is opened and checked against a counting source: a memo
 * hit must serve the SAME array without touching the source, every invalidation
 * door must force exactly one re-run, a throwing source must pin `[]` for the
 * window, and two concurrent cold listings must share one source run.
 *
 * The last scenario drives the REAL channel facade (`createChannel` →
 * `renameSession`, the live-session /rename path): the rename appends a
 * `session/title` event — a log mutation no fingerprint can see — so the very
 * next `listSessions` must observe the new title. That check FAILS on code
 * that skips the invalidate (the pre-fix behavior of issue #987's B1 gap).
 *
 * Seeds sessions under a temp DSH_TUI_SESSION_ROOT (HOME is also redirected
 * so session-index.json and last-used.json stay in the sandbox), imports the
 * compiled lib — run `pnpm build` first.
 *
 * Run: `node scripts/verify-session-listing-memo.mjs`
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-listing-memo-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-listing-memo-home-'))
process.env.DSH_TUI_SESSION_ROOT = root
// DATA_DIR resolves os.homedir() at module load — HOME on POSIX, USERPROFILE
// on Windows. Set BOTH so a manual run can never write the test's index and
// last-used files into the real user profile.
process.env.HOME = home
process.env.USERPROFILE = home

// Import AFTER the env overrides.
const { cachedListedSessions, listSummariesCached, invalidateListedSessions } =
  await import('../lib/types/dsh-adapter/sessions/cache.js')
const { appendSessionTitle, readSessionTitleFromLog } =
  await import('../lib/types/dsh-adapter/compat/sessionLog.js')
const { touchSession } = await import('../lib/types/sessionHistory.js')
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

let checks = 0
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ''}`)
  checks += 1
}
function eq(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  checks += 1
}

const INDEX_FILE = join(home, '.dsh-tui', 'session-index.json')
const LAST_USED_FILE = join(home, '.dsh-tui', 'last-used.json')

/** One zstd frame per event batch — the container the backend writes. */
function encode(batches) {
  return Buffer.concat(
    batches.map((batch) =>
      zstdCompressSync(Buffer.from(batch.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))),
  )
}

/** Seed one session log (header + opening prompt + title); returns its path. */
function seed(id, title) {
  const dir = join(root, '--work-space--', id)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 0, id, createdAt: 1000, cwd: '/proj' }
  const message = {
    type: 'user/message', seq: 0, time: 1,
    data: { content: [{ type: 'text', text: `question ${id}` }], source: { kind: 'user' } },
  }
  const titleEvent = { type: 'session/title', seq: 1, time: 2, data: { title } }
  const file = join(dir, 'session.jsonl.zstd')
  writeFileSync(file, encode([[header], [message, titleEvent]]))
  return file
}

/**
 * A SessionSource whose `list` is counted — the memo-hit oracle. A hit serves
 * the memoized array without any source method running; every invalidation
 * door costs exactly one more `list`.
 */
function countingSource(paths) {
  const source = {
    calls: 0,
    list: async () => {
      source.calls += 1
      return [
        { id: 'memo-a', cwd: '/proj', createdAt: 1000 },
        { id: 'memo-b', cwd: '/proj', createdAt: 1001 },
      ]
    },
    locate: (meta) => ({ kind: 'jsonl', path: paths[meta.id] }),
  }
  return source
}

/** Move a file's mtime forward, leaving its size alone. */
function bumpMtime(file) {
  const stats = statSync(file)
  const later = new Date(stats.mtimeMs + 5000)
  utimesSync(file, later, later)
}

try {
  // ── 1. Cold process: nothing has been listed yet ────────────────────────
  eq('1. cold process: cachedListedSessions() is undefined', cachedListedSessions(), undefined)

  // ── 2. Within the TTL the memo serves the same array, source untouched ──
  const source = countingSource({
    'memo-a': seed('memo-a', 'alpha'),
    'memo-b': seed('memo-b', 'beta'),
  })
  const first = await listSummariesCached(source)
  eq('2. the first listing covers every seeded session', first.map(s => s.id).sort(), ['memo-a', 'memo-b'])
  ok('3. the listing backfills the snapshot seam (cachedListedSessions is the same array)', cachedListedSessions() === first)
  const callsAfterPopulate = source.calls
  const second = await listSummariesCached(source)
  ok('4. a repeat call within the TTL returns the same array identity', second === first)
  eq('5. a repeat call within the TTL does not re-run the source', source.calls, callsAfterPopulate)

  // ── 3. The index fingerprint: a moved session-index.json mtime ──────────
  bumpMtime(INDEX_FILE)
  const third = await listSummariesCached(source)
  eq('6. a moved session-index.json mtime forces a re-listing', source.calls, callsAfterPopulate + 1)
  ok('7. the re-listing replaces the slot with a fresh array', third !== first && cachedListedSessions() === third)

  // ── 4. The last-used fingerprint: a moved last-used.json mtime ──────────
  invalidateListedSessions()
  touchSession('memo-a')
  eq('8. fixture: touchSession created last-used.json', statSync(LAST_USED_FILE).isFile(), true)
  const fourth = await listSummariesCached(source)
  const callsBeforeLastUsed = source.calls
  bumpMtime(LAST_USED_FILE)
  const fifth = await listSummariesCached(source)
  eq('9. a moved last-used.json mtime forces a re-listing', source.calls, callsBeforeLastUsed + 1)
  ok('10. the re-listing after the last-used bump replaces the slot', fifth !== fourth && cachedListedSessions() === fifth)

  // ── 5. The TTL: a clock pushed past 3 s must re-ask the source ──────────
  invalidateListedSessions()
  const sixth = await listSummariesCached(source)
  const callsBeforeTtl = source.calls
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 3001 // LISTING_MEMO_TTL_MS is 3_000
    const seventh = await listSummariesCached(source)
    eq('11. a clock past the TTL forces a re-listing', source.calls, callsBeforeTtl + 1)
    ok('12. the post-TTL result is a fresh array, not the memoized one', seventh !== sixth)
  } finally {
    Date.now = realNow
  }

  // ── 6. bypass: an explicit reload pays for a listing even inside the TTL ─
  invalidateListedSessions()
  const eighth = await listSummariesCached(source)
  const callsBeforeBypass = source.calls
  const bypassed = await listSummariesCached(source, { bypass: true })
  eq('13. bypass re-runs the source inside the TTL', source.calls, callsBeforeBypass + 1)
  ok('14. bypass does not serve the memoized array', bypassed !== eighth)
  const ninth = await listSummariesCached(source)
  ok('15. bypass backfilled the slot: the next ordinary call hits it', ninth === bypassed)
  eq('16. and that ordinary call did not re-run the source', source.calls, callsBeforeBypass + 1)

  // ── 7. Explicit invalidation: the log-writers' door ─────────────────────
  invalidateListedSessions()
  const tenth = await listSummariesCached(source)
  const callsBeforeInvalidate = source.calls
  invalidateListedSessions()
  eq('17. an explicit invalidate empties the snapshot seam', cachedListedSessions(), undefined)
  const eleventh = await listSummariesCached(source)
  eq('18. the next call after an explicit invalidate re-runs the source', source.calls, callsBeforeInvalidate + 1)
  ok('19. and returns a fresh array', eleventh !== tenth)

  // ── 8. Concurrency: two cold listings share one source run ──────────────
  invalidateListedSessions()
  const callsBeforeConcurrent = source.calls
  const pending1 = listSummariesCached(source)
  const pending2 = listSummariesCached(source)
  const [twelfth, thirteenth] = await Promise.all([pending1, pending2])
  eq('20. two concurrent listings share one source run', source.calls, callsBeforeConcurrent + 1)
  ok('21. both concurrent callers receive the same array', twelfth === thirteenth)

  // ── 9. A throwing source pins [] for the window ─────────────────────────
  invalidateListedSessions()
  const throwing = {
    calls: 0,
    list: async () => { throwing.calls += 1; throw new Error('boom') },
  }
  const failed = await listSummariesCached(throwing)
  eq('22. a throwing source lists nothing instead of throwing', failed.length, 0)
  const failedAgain = await listSummariesCached(throwing)
  eq('23. the empty result is pinned: no re-run within the TTL', throwing.calls, 1)
  eq('24. and the pinned value is still an empty list', failedAgain.length, 0)

  // ── 10. B1 pin: the live /rename must be visible immediately ────────────
  // renameSession appends session/title — a log mutation no cache-file
  // fingerprint can see — so without an explicit invalidateListedSessions()
  // the next listing serves the old title for one TTL window. Drives the real
  // channel facade; the stub session persists the append as one more zstd
  // frame, exactly like the backend's own flush.
  const LIVE = 'live-session'
  seed(LIVE, 'old-live')
  const channelSource = {
    calls: 0,
    list: async () => {
      channelSource.calls += 1
      return [{ id: LIVE, cwd: '/proj', createdAt: 5000 }]
    },
  }
  const ctx = {
    on() { return () => {} },
    get(name) { return name === 'sessionPersistence' ? channelSource : undefined },
    logger: { warn() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session: {
      id: LIVE,
      seq: 0,
      events: [],
      append(type, data) {
        const event = { type, seq: this.seq++, time: Date.now(), data }
        this.events.push(event)
        if (type === 'session/title' && typeof data?.title === 'string') {
          appendSessionTitle(this.id, data.title)
        }
        return event
      },
    },
    ctx: { on: () => () => {} },
  }
  const channel = createChannel(ctx, agent, { model: 'm', cwd: '/proj', provider: 'p', activity: false })

  invalidateListedSessions()
  const before = await channel.listSessions()
  const rowBefore = before.find(r => r.id === LIVE)
  ok('25. pin setup: the live session row is listed', rowBefore !== undefined)
  ok('26. pin setup: the row still carries the seeded title', rowBefore?.title.text === 'old-live')
  const callsBeforeRename = channelSource.calls

  channel.renameSession('renamed-live')

  // No wait, no fingerprint games — the invalidate must already have landed.
  const after = await channel.listSessions()
  const rowAfter = after.find(r => r.id === LIVE)
  ok('27. B1 PIN: the rename is visible to the very next listing', rowAfter !== undefined && rowAfter.title.text === 'renamed-live')
  eq('28. B1 PIN: the listing re-ran the source after the rename', channelSource.calls, callsBeforeRename + 1)
  eq('29. the rename append landed in the log (last title wins)', readSessionTitleFromLog(LIVE)?.title, 'renamed-live')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log(`verify-session-listing-memo: OK (${checks} checks)`)
