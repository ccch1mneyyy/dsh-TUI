/**
 * perf-session-scan — quantify the `/resume` listing pipeline (issue #987).
 *
 * This probe exists to answer, with numbers rather than instinct, where the
 * cost of opening the session picker actually sits, and to gate which phase of
 * the issue-987 plan (docs/plans/PLAN-issue-987-session-scan.md) is worth
 * doing. Scenarios:
 *
 *   - A (cold): no `session-index.json`; every session is derived through a
 *     bounded log read. The upgrade/first-run shape.
 *   - B (warm open): the index is complete and every revision still matches —
 *     zero log reads expected. What a steady-state `/resume` open pays; the
 *     plan's P1 target.
 *   - B2 (repeat warm open): the same call again. With the listing memo
 *     (plan T1.1) this is a memo hit; without it, it costs the same as B.
 *   - C (incremental): 10% of sessions grow by one frame, then one listing —
 *     the append-carry-forward path plus one index write (plan P2). The
 *     following "C writes check" run must write nothing.
 *   - D (supervisor open path): the pieces `useSessionSupervisor`'s
 *     `reload()` touches — the listing, `readLastUsed`, `readSessionPins`,
 *     `readSessionOwners` — timed separately (plans P1/P4/P5).
 *
 * Decision thresholds (plan §2 T0.3):
 *   - B > 100 ms at 200 sessions → the every-open re-enumeration (P1) is real
 *     → phase 1. [BASELINE: confirmed — see results below.]
 *   - `findSessionLogFile` fallback count > 0 → phase 2. Not measurable here
 *     without instrumenting the source: the probe's source always provides
 *     `locate()`, as every current dsh backend does, so the fallback is
 *     unreachable by construction and phase 2 stays gated out until a real
 *     pre-`locate` backend is actually observed.
 *   - One `readSessionOwners` pulse > 20 ms or a process spawn → phase 3.
 *     [BASELINE: ~0.06–0.42 ms with an empty ledger — gated out.]
 *   - Only if all of the above are cheap and the picker still feels slow →
 *     phase 4 (rendering).
 *
 * Baseline (pre-T1.1, 2026-09-26, Windows/NVMe, 96KB synthetic sessions,
 * faithful locate shape — the backend answers with the current generation's
 * logical name so every listing pays resolveLocatedPath's probes):
 *   N=200:  A cold ≈ 1.6–2.1 s (600 stats, 27 MB log reads) · B warm ≈
 *           25–43 ms (200 stats, ~0 log reads — the index cache works) ·
 *           B2 ≈ B (no memo at HEAD) · C ≈ 184 ms, 1 index write ·
 *           C-writes-check ≈ 30 ms, 0 writes · D ≈ 26–33 ms, of which
 *           lastUsed + pins + owners < 1 ms combined (empty ledger, no spawn).
 *   N=500:  B warm ≈ 90–100 ms — the linear N × stat + locate-probe cost the
 *           memo removes; slow disks / antivirus multiply it.
 *   Real store on this machine: 13 session logs (236 KB) — the issue's
 *   reporter shape (31 MB / 49 sessions, and 200+ sessions generally) is
 *   covered by the N ∈ {200, 500} runs.
 * Decision gates (T0.3) as measured here:
 *   - B at 200 stays under the 100 ms line on this fast disk, but the probe
 *     idealizes the backend (its listSnapshots work is not included) and the
 *     plan's V7 gate ("a repeat open inside the TTL ≤ 1/5 of the first") can
 *     only be met with the listing memo — so phase 1 proceeds; phases 2–4
 *     stay gated out (no `findSessionLogFile` fallback with a locate-bearing
 *     backend; pulse reads < 1 ms; see scripts/perf output after phase 1).
 *   - noteBranch ≈ 2.1 ms / touchSession ≈ 0.26 ms / readLastUsed ≈ 47 µs at
 *     N=200 (measured once, script below) — the resume-path write debounce
 *     of plan T1.3 is not warranted by these numbers and was not added.
 *
 * Run: node --import tsx/esm scripts/perf-session-scan.ts [--sessions=50,200,500] [--real]
 * (add `--import ./scripts/lib/fs-count-patch.mjs` BEFORE the tsx --import to
 * enable the syscall counters; without it timings are printed but counts show
 * as "off".)
 * Exit code 0 on success. NOT part of any CI gate: scripts/ perf probes are
 * diagnostic tools, not bounded tests (AGENTS.md).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Counters installed by the optional preload (see the header comment). */
const counters = (globalThis as Record<symbol, Record<string, number> | undefined>)[Symbol.for('dsh-tui.fs-count')]
  ?? { stat: -1, syncReadBytes: -1, promiseReadBytes: -1, promiseReads: -1, rename: -1, readdir: -1 }
const COUNTERS_OFF = counters.stat < 0

/** Parse `--sessions=50,200,500` before anything else runs. */
function sessionCounts(): number[] {
  const flag = process.argv.find(arg => arg.startsWith('--sessions='))
  const raw = flag === undefined ? '50,200,500' : flag.slice('--sessions='.length)
  const parsed = raw.split(',').map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value > 0)
  return parsed.length > 0 ? parsed : [50, 200, 500]
}
/** `--real`: report the real store's shape and exit (read-only). */
const REAL_ONLY = process.argv.includes('--real')

// ── Environment: isolated session root and home, BEFORE lib imports ──────
// The lib modules compute DATA_DIR from the environment at import time, and
// that import happens inside main(), after these assignments.
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

// The operator's own environment, captured before the fixture overwrites it —
// `--real` reports on THIS store, not on the fixture.
const realHome = homedir()
const inheritedSessionRoot = process.env.DSH_TUI_SESSION_ROOT

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-perf-root-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-perf-home-'))
process.env.DSH_TUI_SESSION_ROOT = root
process.env.HOME = home
process.env.USERPROFILE = home

// The memo wrapper lands with plan T1.1; until it exists, `listCached` falls
// back to the raw listing so the same probe measures HEAD and the optimized
// tree alike. Resolved inside main().
let memoPresent = false
let listCached: (source: unknown, options?: { bypass?: boolean }) => Promise<readonly unknown[]> =
  () => { throw new Error('listing entry point not initialized') }

const INDEX_FILE = join(home, '.dsh-tui', 'session-index.json')

function resetCounters(): void {
  if (COUNTERS_OFF) return
  counters.stat = 0
  counters.syncReadBytes = 0
  counters.promiseReadBytes = 0
  counters.promiseReads = 0
  counters.rename = 0
  counters.readdir = 0
}

/** Deterministic high-entropy filler so zstd cannot collapse the fixture. */
let noise = 987654321
function filler(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff
    out += String.fromCharCode(33 + (noise % 90))
  }
  return out
}

/** One zstd frame per event batch — the container the backend writes. */
function encode(batches: unknown[][]): Buffer {
  return Buffer.concat(batches.map(batch =>
    zstdCompressSync(Buffer.from(batch.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8'))))
}

interface Fixture {
  headers: { id: string; cwd: string; createdAt: number }[]
  paths: Map<string, string>
  /** The session DIRECTORY per id — locate()'s logical hint is built on it. */
  directories: Map<string, string>
  /** The backend's change token per session, derived from the current file state. */
  revisions: Map<string, string>
}

/**
 * Generate `count` synthetic sessions of roughly `kilobytes` each, 90% of them
 * carrying a complete auto title (the steady-state shape), the rest needing
 * recovery scans.
 */
function generate(count: number, kilobytes: number): Fixture {
  const headers: Fixture['headers'] = []
  const paths = new Map<string, string>()
  const directories = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const id = `perf-${String(i).padStart(5, '0')}`
    const directory = join(root, `--proj${i % 5}--`, id)
    mkdirSync(directory, { recursive: true })
    const header = { type: 'session', version: 0, id, cwd: `/proj${i % 5}`, createdAt: 1_700_000_000_000 + i }
    const titled = i % 10 !== 9
    const body: unknown[][] = [
      [header],
      [{ type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: `question ${i}: ${filler(200)}` }], source: { kind: 'user' } } }],
    ]
    if (titled) {
      body.push([{ type: 'session/title', seq: 2, time: 2, data: { title: `session ${i} title`, source: { kind: 'provider' } } }])
    }
    // Pad to roughly the target size with assistant chunks.
    const chunks = Math.max(1, Math.round((kilobytes * 1024) / 600))
    for (let c = 0; c < chunks; c++) {
      body.push([{ type: 'assistant/chunk', seq: 10 + c, time: 100 + c, data: { text: filler(500) } }])
    }
    const file = join(directory, 'session.jsonl.zstd')
    writeFileSync(file, encode(body))
    headers.push(header)
    paths.set(id, file)
    directories.set(id, directory)
  }
  const revisions = refreshRevisions(headers, paths, new Map())
  return { headers, paths, directories, revisions }
}

/** Recompute backend-style tokens (`size:mtime`) for the current file state. */
function refreshRevisions(headers: Fixture['headers'], paths: Map<string, string>, into: Map<string, string>): Map<string, string> {
  for (const header of headers) {
    const file = paths.get(header.id)!
    const stats = statSync(file)
    into.set(header.id, `rev:${stats.size}:${stats.mtimeMs}`)
  }
  return into
}

/** The persistence service the probe feeds to the listing. */
function sourceOf(fixture: Fixture): unknown {
  return {
    // Revisions are captured per scenario pass (a real backend holds its own
    // metadata), so the measured cost is the TUI pipeline, not the backend's.
    listSnapshots: async () => fixture.headers.map(header => ({ header, revision: fixture.revisions.get(header.id) })),
    // The 0.1.5+ backend answers locate() with the CURRENT generation's
    // LOGICAL name without touching the filesystem; for an old-generation
    // artifact that path does not exist, so every listing pays
    // resolveLocatedPath's direct+twin probes and generation scan per
    // session. Reproduce that shape (worst case: nothing materialized at the
    // hint) instead of handing over the physical path.
    locate: (meta: { id: string }) => ({
      kind: 'jsonl',
      path: join(fixture.directories.get(meta.id)!, 'session.v3.jsonl'),
    }),
  }
}

const ms = (nanoseconds: bigint): string => (Number(nanoseconds) / 1e6).toFixed(3)
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`

interface Sample {
  scenario: string
  sessions: number
  millis: number
  stat: number
  syncReadBytes: number
  promiseReadBytes: number
  indexBytes: number
  writes: number
}
const samples: Sample[] = []

/** Time one listing pass and record it against the current counters. */
async function measure(scenario: string, count: number, run: () => Promise<unknown>): Promise<void> {
  resetCounters()
  const start = process.hrtime.bigint()
  await run()
  const millis = Number(process.hrtime.bigint() - start) / 1e6
  samples.push({
    scenario, sessions: count, millis,
    stat: counters.stat,
    syncReadBytes: counters.syncReadBytes,
    promiseReadBytes: counters.promiseReadBytes,
    indexBytes: existsSync(INDEX_FILE) ? statSync(INDEX_FILE).size : 0,
    writes: counters.rename,
  })
}

async function main(): Promise<void> {
  if (REAL_ONLY) {
    reportRealStore()
    return
  }

  const { listSummaries } = await import('../lib/types/dsh-adapter/sessions/list.js')
  listCached = source => listSummaries(source as never)
  try {
    const cache = await import('../lib/types/dsh-adapter/sessions/cache.js') as {
      listSummariesCached?: typeof listCached
    }
    if (typeof cache.listSummariesCached === 'function') {
      listCached = cache.listSummariesCached
      memoPresent = true
    }
  } catch {
    // Pre-T1.1 tree: no cache module, scenario B/B2 measure the raw path.
  }
  const { readLastUsed } = await import('../lib/types/sessionHistory.js')
  const { readSessionPins } = await import('../lib/types/sessionPins.js')
  const { readSessionOwners } = await import('../lib/types/sessionMounts.js')

  console.log(`perf-session-scan (listing memo module: ${memoPresent ? 'present' : 'ABSENT — raw path'}; counters: ${COUNTERS_OFF ? 'off — see header for the --import preload' : 'on'})`)
  const rssStart = process.memoryUsage().rss

  for (const count of sessionCounts()) {
    // 96KB per session: larger than the 64KB head window, so the cold path
    // exercises the head+tail bounded read that real (hundreds-of-KB) sessions
    // cost — while staying bounded, as the real cost is too.
    const fixture = generate(count, 96)
    const source = sourceOf(fixture)

    // A — cold: no index, every session derived through bounded log reads.
    for (let attempt = 0; attempt < 3; attempt++) {
      rmSync(INDEX_FILE, { force: true })
      await measure('A cold', count, () => listSummaries(source as never))
    }

    // B — warm open (the plan's P1 target): index complete, all tokens match.
    // B2 — the same call again: a memo hit after T1.1, a re-run before it.
    for (let attempt = 0; attempt < 3; attempt++) {
      await measure('B warm-open', count, () => listCached(source))
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await measure('B2 repeat-open', count, () => listCached(source))
    }

    // C — incremental: 10% of sessions grow by one frame, then one listing.
    const grown = Math.max(1, Math.round(count * 0.1))
    for (let i = 0; i < grown; i++) {
      const file = fixture.paths.get(fixture.headers[i]!.id)!
      appendFileSync(file, encode([[{ type: 'assistant/chunk', seq: 999, time: 999, data: { text: filler(300) } }]]))
    }
    refreshRevisions(fixture.headers, fixture.paths, fixture.revisions)
    await measure('C incremental', count, () => listCached(source, { bypass: true }))
    // The write-side ledger of scenario C: one index rewrite is the plan's
    // whole budget (T1.3 accepts ≤ 2 writes; last-used is not touched here).
    await measure('C writes check', count, () => listCached(source, { bypass: true }))

    // D — supervisor open path: what `reload()` touches, timed separately.
    for (let attempt = 0; attempt < 3; attempt++) {
      resetCounters()
      const start = process.hrtime.bigint()
      readLastUsed()
      const lastUsed = ms(process.hrtime.bigint() - start)
      const pinsStart = process.hrtime.bigint()
      readSessionPins()
      const pins = ms(process.hrtime.bigint() - pinsStart)
      const ownersStart = process.hrtime.bigint()
      readSessionOwners()
      const owners = ms(process.hrtime.bigint() - ownersStart)
      const listStart = process.hrtime.bigint()
      await listCached(source)
      const list = ms(process.hrtime.bigint() - listStart)
      const total = Number(process.hrtime.bigint() - start) / 1e6
      samples.push({
        scenario: `D open (lastUsed ${lastUsed}ms · pins ${pins}ms · owners ${owners}ms · list ${list}ms)`,
        sessions: count, millis: total,
        stat: counters.stat,
        syncReadBytes: counters.syncReadBytes,
        promiseReadBytes: counters.promiseReadBytes,
        indexBytes: existsSync(INDEX_FILE) ? statSync(INDEX_FILE).size : 0,
        writes: counters.rename,
      })
    }

    rmSync(root, { recursive: true, force: true })
  }

  const rssEnd = process.memoryUsage().rss
  const handleProbe = process as { _getActiveHandles?: () => unknown[] }
  const handles = typeof handleProbe._getActiveHandles === 'function'
    ? handleProbe._getActiveHandles().length
    : -1

  console.log('\nscenario / N                total ms   stat  syncRead  promiseRead  index    writes')
  for (const sample of samples) {
    console.log(
      `${sample.scenario.padEnd(42)} N=${String(sample.sessions).padStart(3)}  ` +
      `${sample.millis.toFixed(1).padStart(8)}ms  ` +
      (COUNTERS_OFF
        ? '  (counters off)'
        : `${String(sample.stat).padStart(5)}  ` +
          `${kb(sample.syncReadBytes).padStart(8)}  ` +
          `${kb(sample.promiseReadBytes).padStart(11)}  ` +
          `${kb(sample.indexBytes).padStart(7)}  ` +
          `${String(sample.writes).padStart(6)}`),
    )
  }
  console.log(`\nRSS ${kb(rssStart)} → ${kb(rssEnd)} (Δ ${(rssEnd - rssStart) / 1024}KB); open handles: ${handles}`)

  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

/** Read-only shape of the real store, for plan T0.2. Never writes. */
function reportRealStore(): void {
  const sessionRoot = inheritedSessionRoot ?? join(realHome, '.dsh')
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) walk(path)
      else if (stats.isFile()) {
        files += 1
        bytes += stats.size
      }
    }
  }
  walk(sessionRoot)
  console.log(`real store ${sessionRoot}: ${files} files, ${kb(bytes)} total`)
  const indexFile = join(realHome, '.dsh-tui', 'session-index.json')
  if (existsSync(indexFile)) {
    const raw = readFileSync(indexFile, 'utf8')
    const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> }
    console.log(`real index: ${kb(Buffer.byteLength(raw))}, ${Object.keys(parsed.entries ?? {}).length} entries`)
  } else {
    console.log('real index: absent')
  }
  const lastUsedFile = join(realHome, '.dsh-tui', 'last-used.json')
  console.log(`real last-used: ${existsSync(lastUsedFile) ? kb(statSync(lastUsedFile).size) : 'absent'}`)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
