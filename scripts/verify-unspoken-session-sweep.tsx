/**
 * Unspoken-session sweep regression — the exit-time cleanup of shells no
 * person ever spoke to (change `dsh-tui-unspoken-session-leak`, DESIGN D5 /
 * ADR-0012).
 *
 * Every case runs against a REAL temporary sessions root and a REAL TUI
 * session index, so the three layers are exercised through their shipping
 * implementations (`sessions/store.readIndex`, `compat/sessionLog`'s bounded
 * reader and delete primitive, `sessionHistory`'s per-session notes) rather
 * than through doubles. The dependencies the module cannot know — which
 * session this process is bound to, which runs are live, what lineage is a
 * delegated run — are injected, and the pure decision rules are injectable so
 * the negative control below can drive the SAME pipeline with reversed rules.
 *
 * Covered:
 *   1. A boot-only shell in the index is collected, including a pre-existing
 *      ("historical") entry this run never created.
 *   2. A human `user/message` without a `turn/start` is preserved — the case
 *      the host's own `blank` rule would delete.
 *   3. A `turn/start` is preserved.
 *   4. Delegated runs and their descendants are preserved (the delete
 *      primitive has no `kind`/`parentSession` check of its own).
 *   5. Sessions this process still holds (bound / live background) are
 *      preserved.
 *   6. An absent, dangling, corrupt or budget-truncated log is skipped, never
 *      deleted, and reported with the layer that spared it.
 *   7. ADVERSARIAL: an index that says `hasPrompt:false` while the log holds a
 *      human message is preserved (AC-6's core assertion).
 *   8. Negative control: replacing the three rules with "always delete" /
 *      "never delete", or dropping only the log rule, changes the answer — so
 *      the positive assertions cannot be satisfied by a constant.
 *   9. Bounds and fail-soft: the candidate cap and the per-log event budget
 *      spare rather than delete, and a throwing dependency cannot abort the
 *      round.
 *  10. The reported partition covers the index exactly once, so nothing is
 *      silently dropped.
 *  11. The real sweep removes exactly the collected ids, leaves the index
 *      untouched (listing GC converges it) and forgets the session's
 *      `last-used` / agent-view / resume notes.
 *  12. A refused or throwing delete is reported and leaves the log in place.
 *  13. Layer ③ reads each candidate's OWN header (from its log's first frame):
 *      `origin:'subagent'` and `delegationDepth > 0` spare a run the listing
 *      cache never saw, a fork whose listed ancestor is delegated is spared as
 *      a descendant, and a plain fork of a non-delegated parent is left to
 *      layer ② (which sees the inherited conversation in the fork's own log).
 *      The pre-fix listing-only rule is re-run as the negative control: it
 *      really does collect the header-delegated shell (F-03's minimum case).
 *  14. A session another live process holds is spared with `held-elsewhere` —
 *      driven both through the injected seam and through the real
 *      `session-mounts.json` ledger and `sweepUnspokenOnExit`'s own wiring.
 *
 * Run: node --import tsx/esm scripts/verify-unspoken-session-sweep.tsx
 * The sessions root, the DSH home and `~/.dsh-tui` are ALL redirected under
 * one disposable mkdtemp directory before the module under test is imported.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
// Type-only, so it is erased: the value import below must stay AFTER the env
// override (DATA_DIR and sessionsRoots() read the environment at import time).
import type { UnspokenSweepDeps } from '../src/dsh-adapter/unspoken-sessions.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-sweep-'))
// Registered BEFORE the imports below: a missing or broken module under test
// throws out of the top-level `await import`, which the `finally` at the
// bottom would never reach — and a regression that litters the temp directory
// every time it is red is a regression nobody runs.
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true })
})
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'dsh')
process.env.DSH_TUI_SESSION_ROOT = join(root, 'logs')

const dataDir = join(root, '.dsh-tui')
const indexFile = join(dataDir, 'session-index.json')
const sessionsRoot = join(root, 'logs')
const workspaceDir = join(sessionsRoot, 'enc-workspace')
const resumeFile = join(dataDir, 'resume.txt')
const lastUsedFile = join(dataDir, 'last-used.json')
const agentViewFile = join(dataDir, 'agent-view-sessions.json')

// Import AFTER the env override: DATA_DIR (utils/paths) is a module-level
// constant and sessionsRoots() (compat/sessionLog) prefers
// DSH_TUI_SESSION_ROOT, so both must see the temporary root from the start.
const { collectUnspokenSessionIds, delegatedSessionIds, readSessionHeaderFromLog, sweepUnspokenSessions, unspokenJudges } =
  await import('../src/dsh-adapter/unspoken-sessions.js')
const { readIndex } = await import('../src/dsh-adapter/sessions/store.js')
const { readResumeTarget } = await import('../src/sessionHistory.js')

let cases = 0
let checks = 0
let failures = 0

/** Count one assertion and label its failure with what it was proving. */
function check(label: string, body: () => void): void {
  checks += 1
  try {
    body()
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function test(name: string, run: () => void): void {
  cases += 1
  try {
    run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures: real artifacts, real index, all under the temporary root.
 * ------------------------------------------------------------------ */

/** One JSON line per zstd frame is the shipping layout; frames are written whole. */
const frame = (rows: readonly unknown[]): Buffer =>
  zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'))

const header = (id: string): Record<string, unknown> => ({ type: 'session', version: 4, id, createdAt: 1, cwd: join(root, 'project') })
/** The only durable trace a session that booted and was never spoken to leaves. */
const boot: Record<string, unknown> = { type: 'sandbox/mode', seq: 0, time: 0, data: { mode: 'workspace-write' } }
const turnStart: Record<string, unknown> = { type: 'turn/start', seq: 4, time: 4, data: {} }
const human = (source?: unknown): Record<string, unknown> => ({
  type: 'user/message',
  seq: 1,
  time: 1,
  data: { content: [{ type: 'text', text: 'typed by a person' }], ...(source === undefined ? {} : { source }) },
})
const injected = (kind: string): Record<string, unknown> => ({
  type: 'user/message',
  seq: 1,
  time: 1,
  data: { content: [{ type: 'text', text: 'system payload' }], source: { kind } },
})
const spliced = (messages: readonly unknown[]): Record<string, unknown> => ({
  type: 'agent/inbox/spliced',
  seq: 2,
  time: 2,
  data: { inserted: messages },
})

/** A checksum-protected frame with a flipped final byte: decode throws. */
const corruptFrame = zstdCompressSync(Buffer.from('{"type":"plugin/noise"}\n'), {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
})
corruptFrame[corruptFrame.length - 1] ^= 0xff

const logDir = (id: string): string => join(workspaceDir, id)
const logFile = (id: string): string => join(logDir(id), 'session.v4.jsonl.zstd')

function writeLog(id: string, rows: readonly unknown[], extraFrames: readonly Buffer[] = []): void {
  mkdirSync(logDir(id), { recursive: true })
  writeFileSync(logFile(id), Buffer.concat([frame([header(id), boot, ...rows]), ...extraFrames]))
}

/**
 * The same layout with extra PHYSICAL header fields (`origin`,
 * `delegationDepth`, `parentSession`) — the fields dsh-session persists on the
 * log's first line and the only place a candidate's own lineage can be read
 * from (`sessions/header.ts:102-113`).
 */
function writeLogWithHeader(id: string, fields: Record<string, unknown>, rows: readonly unknown[] = []): void {
  mkdirSync(logDir(id), { recursive: true })
  writeFileSync(logFile(id), frame([{ ...header(id), ...fields }, boot, ...rows]))
}

interface IndexRow {
  /** Omitted means "no `derived`" — the unknown branch of layer ①. */
  readonly hasPrompt?: boolean
  readonly branch?: string
}

/** Write the REAL index file (`~/.dsh-tui/session-index.json`, schema v4). */
function writeIndexFixture(rows: Readonly<Record<string, IndexRow>>, marker: string): void {
  const entries: Record<string, unknown> = {}
  for (const [id, row] of Object.entries(rows)) {
    entries[id] = {
      ...(row.branch === undefined ? {} : { branch: row.branch }),
      ...(row.hasPrompt === undefined ? {} : {
        derived: {
          revision: `rev-${id}`,
          bytes: 240,
          modifiedAt: 1_700_000_000_000,
          anchor: `anchor-${id}`,
          title: `title-${id}`,
          titleSource: 'fallback',
          titleComplete: true,
          hasPrompt: row.hasPrompt,
        },
      }),
    }
  }
  rmSync(indexFile, { force: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(indexFile, JSON.stringify({ version: 4, entries }))
  // A stale module-level cache would make every later assertion meaningless,
  // so prove the fixture actually reached the reader before asserting on it.
  assert.equal(readIndex().has(marker), true, `fixture index did not reach readIndex (${marker})`)
}

function buildTree(index: Readonly<Record<string, IndexRow>>, logs: Readonly<Record<string, readonly unknown[]>>): void {
  rmSync(sessionsRoot, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(workspaceDir, { recursive: true })
  const marker = Object.keys(index)[0]
  assert.ok(marker !== undefined, 'fixture index must not be empty')
  writeIndexFixture(index, marker)
  for (const [id, rows] of Object.entries(logs)) writeLog(id, rows)
}

const reasonOf = (result: { skipped: readonly { id: string, reason: string }[] }, id: string): string | undefined =>
  result.skipped.find(entry => entry.id === id)?.reason

/* ------------------------------------------------------------------ *
 * Shared tree: one entry per layer, every branch of every layer.
 * ------------------------------------------------------------------ */

const TREE_INDEX: Record<string, IndexRow> = {
  'shell-legacy': { hasPrompt: false, branch: 'an-old-branch' },
  'shell-fresh': { hasPrompt: false },
  'shell-unknown': {},
  'shell-prompted': { hasPrompt: true },
  'spoke-first': { hasPrompt: false },
  'spoke-sourceless': { hasPrompt: false },
  'spliced-human': { hasPrompt: false },
  'turned': { hasPrompt: false },
  'subagent-run': { hasPrompt: false },
  'subagent-child': { hasPrompt: false },
  'bound-session': { hasPrompt: false },
  'live-background': { hasPrompt: false },
  'corrupt-frame': { hasPrompt: false },
  'dangling-index': { hasPrompt: false },
  'malformed-user': { hasPrompt: false },
  'bulk-shell': { hasPrompt: false },
  'injected-only': { hasPrompt: false },
  'long-ago-shell': { hasPrompt: false },
}

const TREE_LOGS: Record<string, readonly unknown[]> = {
  'shell-legacy': [],
  'shell-fresh': [],
  'shell-unknown': [],
  'shell-prompted': [],
  'spoke-first': [human({ kind: 'user' })],
  'spoke-sourceless': [human()],
  'spliced-human': [spliced([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])],
  'turned': [turnStart],
  'subagent-run': [],
  'subagent-child': [],
  'bound-session': [],
  'live-background': [],
  'corrupt-frame': [],
  'malformed-user': [{ type: 'user/message', seq: 1, time: 1 }],
  // A shell that booted many times: still no turn, still no human message.
  'bulk-shell': Array.from({ length: 40 }, (_, index) => ({ type: 'plugin/noise', seq: 100 + index, time: index, data: {} })),
  // The realistic boot-only log shape: user-ROLE messages that no person wrote.
  'injected-only': [injected('system-prompt'), spliced([{ role: 'user', source: { kind: 'subagent-settled' }, content: [] }])],
  'long-ago-shell': [],
}

const DEPENDENT_IDS = new Set(['subagent-run', 'subagent-child'])
/** The facts only the assembler knows (T05 wires these from the live ctx). */
const treeDeps = () => ({
  currentSessionId: () => 'bound-session',
  liveSessionIds: () => new Set(['live-background']),
  isSubagentOrDescendant: (id: string) => DEPENDENT_IDS.has(id),
})

function buildSharedTree(): void {
  buildTree(TREE_INDEX, TREE_LOGS)
  // The corrupt log needs a hand-built byte tail, so it is finished here.
  writeFileSync(logFile('corrupt-frame'), Buffer.concat([frame([header('corrupt-frame'), boot]), corruptFrame]))
}

// Loaded once, right before the cases that need the exit helper and the mount
// ledger: plugin.ts drags in the renderer, and this regression is the fast,
// focused one for the sweep module.
const { sweepUnspokenOnExit, exitListingGap } = await import('../src/dsh-adapter/plugin.js')
const { readMountLedgerStrict, readSessionOwners } = await import('../src/sessionMounts.js')

try {
  buildSharedTree()

  test('1. boot-only shells are collected, including a pre-existing historical entry', () => {
    const result = collectUnspokenSessionIds(treeDeps())
    check('exactly the five shells nobody spoke in are deletion candidates', () => {
      assert.deepEqual(result.ids, ['bulk-shell', 'injected-only', 'long-ago-shell', 'shell-fresh', 'shell-legacy'])
    })
    check('the historical entry kept its branch note and was still collected', () => {
      assert.equal(readIndex().get('shell-legacy')?.branch, 'an-old-branch')
      assert.ok(result.ids.includes('shell-legacy'))
    })
    check('a long-lived but still wordless shell is not excluded by size or age', () => {
      assert.ok(result.ids.includes('bulk-shell'))
      assert.ok(result.ids.includes('long-ago-shell'))
    })
  })

  test('2. a human message without turn/start is preserved (the host blank rule would delete it)', () => {
    const result = collectUnspokenSessionIds(treeDeps())
    check('an explicit human source spares the session', () => {
      assert.equal(reasonOf(result, 'spoke-first'), 'human-message')
    })
    check('a missing source counts as human, matching digest.ts', () => {
      assert.equal(reasonOf(result, 'spoke-sourceless'), 'human-message')
    })
    check('spared sessions stay on disk', () => {
      assert.ok(existsSync(logDir('spoke-first')))
      assert.ok(!result.ids.includes('spoke-first'))
      assert.ok(!result.ids.includes('spoke-sourceless'))
    })
  })

  test('3. a turn/start is preserved', () => {
    const result = collectUnspokenSessionIds(treeDeps())
    check('turn/start is the second log-layer verdict', () => {
      assert.equal(reasonOf(result, 'turned'), 'turn-start')
      assert.ok(existsSync(logDir('turned')))
    })
  })

  test('4. delegated runs and their descendants are preserved', () => {
    const result = collectUnspokenSessionIds(treeDeps())
    check('a sub-agent run is spared by the held layer', () => {
      assert.equal(reasonOf(result, 'subagent-run'), 'subagent')
    })
    check('a descendant of a delegated run is spared too', () => {
      assert.equal(reasonOf(result, 'subagent-child'), 'subagent')
    })
    check('lineage is derived from real parent links, not from the id', () => {
      assert.deepEqual(
        [...delegatedSessionIds([
          { id: 'root' },
          { id: 'fork-of-root', parent: 'root' },
          { id: 'delegated', delegated: true },
          { id: 'child-of-delegated', parent: 'delegated' },
          { id: 'fork-of-child', parent: 'child-of-delegated' },
        ])].sort(),
        ['child-of-delegated', 'delegated', 'fork-of-child'],
      )
    })
    check('a fork of a root session is not delegated', () => {
      assert.equal(delegatedSessionIds([{ id: 'root' }, { id: 'fork-of-root', parent: 'root' }]).has('fork-of-root'), false)
    })
  })

  test('5. sessions this process holds are preserved', () => {
    const result = collectUnspokenSessionIds(treeDeps())
    check('the bound session is spared', () => {
      assert.equal(reasonOf(result, 'bound-session'), 'current-session')
    })
    check('a live background session is spared', () => {
      assert.equal(reasonOf(result, 'live-background'), 'live-session')
    })
  })

  test('6. absent, dangling, corrupt and truncated logs are skipped, never deleted', () => {
    const result = collectUnspokenSessionIds({ ...treeDeps(), maxEventsPerLog: 16 })
    check('the fixture corruption really is undecodable', () => {
      assert.throws(() => zstdDecompressSync(corruptFrame))
    })
    check('a corrupt log reports the log layer, not a delete', () => {
      assert.equal(reasonOf(result, 'corrupt-frame'), 'log-unreadable')
      assert.ok(existsSync(logDir('corrupt-frame')))
    })
    check('an index entry with no artifact is a dangling entry', () => {
      assert.equal(reasonOf(result, 'dangling-index'), 'log-absent')
    })
    check('a log past the event budget cannot prove emptiness', () => {
      assert.equal(reasonOf(result, 'bulk-shell'), 'log-incomplete')
      assert.ok(!result.ids.includes('bulk-shell'))
    })
    check('an unreadable user payload is evidence, not absence of evidence', () => {
      assert.equal(reasonOf(result, 'malformed-user'), 'human-message')
    })
    check('system-role user messages are not human and do not spare a shell', () => {
      assert.ok(result.ids.includes('injected-only'))
      assert.ok(!result.ids.includes('corrupt-frame'))
    })
  })

  test('7. adversarial: index says hasPrompt:false while the log holds a human message', () => {
    const index = readIndex()
    check('the fixture really does disagree with the log (otherwise this case proves nothing)', () => {
      assert.equal(index.get('spoke-first')?.derived?.hasPrompt, false)
      assert.equal(index.get('spliced-human')?.derived?.hasPrompt, false)
    })
    const result = collectUnspokenSessionIds(treeDeps())
    check('the log layer overrides a stale index for a plain human message', () => {
      assert.equal(reasonOf(result, 'spoke-first'), 'human-message')
    })
    check('the splice arm of digest.ts spares an inbox-spliced human message', () => {
      assert.equal(reasonOf(result, 'spliced-human'), 'human-message')
      assert.ok(existsSync(logDir('spliced-human')))
    })
    check('neither adversarial id is ever a deletion candidate', () => {
      assert.ok(!result.ids.includes('spoke-first'))
      assert.ok(!result.ids.includes('spliced-human'))
    })
  })

  test('8. negative control: reversed rules change the answer on the same input', () => {
    const deps = treeDeps()
    const positive = collectUnspokenSessionIds(deps)
    const alwaysDelete = collectUnspokenSessionIds(deps, {
      index: () => undefined,
      log: () => undefined,
      held: () => undefined,
    })
    const neverDelete = collectUnspokenSessionIds(deps, {
      index: () => 'index-has-prompt',
      log: () => 'log-absent',
      held: () => 'current-session',
    })
    const logBlind = collectUnspokenSessionIds(deps, {
      index: (entry) => entry?.derived === undefined ? 'index-unknown' : entry.derived.hasPrompt ? 'index-has-prompt' : undefined,
      log: () => undefined,
      held: (id) => id === deps.currentSessionId() ? 'current-session' : deps.liveSessionIds().has(id) ? 'live-session' : deps.isSubagentOrDescendant(id) ? 'subagent' : undefined,
    })
    check('the positive answer is non-empty, so the control has something to miss', () => {
      assert.ok(positive.ids.length > 0)
    })
    check('always-delete reaches exactly the sessions the positive run spares', () => {
      assert.notDeepEqual(alwaysDelete.ids, positive.ids)
      for (const id of ['spoke-first', 'spliced-human', 'turned', 'subagent-run', 'bound-session', 'corrupt-frame', 'dangling-index']) {
        assert.ok(alwaysDelete.ids.includes(id), `always-delete did not reach ${id}`)
        assert.ok(!positive.ids.includes(id), `${id} must never be a positive candidate`)
      }
      assert.equal(alwaysDelete.skipped.some(entry => entry.reason === 'human-message'), false)
    })
    check('never-delete misses every shell the positive run collects', () => {
      assert.deepEqual(neverDelete.ids, [])
      assert.notDeepEqual(neverDelete.ids, positive.ids)
      for (const id of positive.ids) assert.ok(!neverDelete.ids.includes(id))
    })
    check('dropping only the log layer deletes sessions with conversation evidence', () => {
      assert.notDeepEqual(logBlind.ids, positive.ids)
      assert.ok(logBlind.ids.includes('spoke-first'))
      assert.ok(logBlind.ids.includes('turned'))
      assert.ok(!positive.ids.includes('spoke-first'))
    })
    check('the positive run keeps every layer doing work', () => {
      const reasons = new Set(positive.skipped.map(entry => entry.reason))
      for (const reason of ['index-has-prompt', 'index-unknown', 'human-message', 'turn-start', 'subagent', 'current-session', 'live-session', 'log-absent', 'log-unreadable']) {
        assert.ok(reasons.has(reason), `no candidate hit ${reason}`)
      }
    })
  })

  test('9. the round is bounded and fail-soft', () => {
    const capped = collectUnspokenSessionIds({ ...treeDeps(), maxCandidates: 1 })
    check('candidates past the cap are spared and reported', () => {
      assert.deepEqual(capped.ids, [])
      assert.equal(reasonOf(capped, 'shell-fresh'), 'candidate-cap')
      assert.equal(reasonOf(capped, 'shell-legacy'), 'candidate-cap')
    })
    check('the same log is a candidate once the event budget covers it', () => {
      const wide = collectUnspokenSessionIds({ ...treeDeps(), maxEventsPerLog: 1024 })
      assert.ok(wide.ids.includes('bulk-shell'))
    })
    const throwing = collectUnspokenSessionIds({
      ...treeDeps(),
      readLog: () => { throw new Error('fixture read failure') },
    })
    check('a throwing log read cannot abort the round', () => {
      assert.deepEqual(throwing.ids, [])
      assert.equal(reasonOf(throwing, 'shell-fresh'), 'unexpected-error')
      assert.equal(reasonOf(throwing, 'spoke-first'), 'unexpected-error')
    })
    const throwingHeld = collectUnspokenSessionIds({
      ...treeDeps(),
      currentSessionId: () => { throw new Error('fixture binding failure') },
    })
    check('a throwing process-layer dependency cannot abort the round either', () => {
      assert.deepEqual(throwingHeld.ids, [])
      assert.equal(reasonOf(throwingHeld, 'shell-fresh'), 'unexpected-error')
    })
    const throwingHeader = collectUnspokenSessionIds({
      ...treeDeps(),
      readSessionHeader: () => { throw new Error('fixture header failure') },
    })
    check('a throwing header read is one candidate\'s problem, never the round\'s', () => {
      assert.deepEqual(throwingHeader.ids, [])
      assert.equal(reasonOf(throwingHeader, 'shell-fresh'), 'unexpected-error')
    })
  })

  test('10. every index entry is either collected or reported with one reason', () => {
    const result = collectUnspokenSessionIds(treeDeps())
    check('collected plus skipped covers the index exactly once', () => {
      const seen = [...result.ids, ...result.skipped.map(entry => entry.id)]
      assert.equal(new Set(seen).size, seen.length, 'an id was reported twice')
      assert.deepEqual([...seen].sort(), Object.keys(TREE_INDEX).sort())
    })
    check('an entry with no derived record is unknown, therefore spared', () => {
      assert.equal(reasonOf(result, 'shell-unknown'), 'index-unknown')
    })
    check('an entry the index calls prompted is spared without reading its log', () => {
      assert.equal(reasonOf(result, 'shell-prompted'), 'index-has-prompt')
    })
  })

  test('11. the real sweep deletes exactly the collected ids and leaves the index alone', () => {
    rmSync(sessionsRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(workspaceDir, { recursive: true })
    writeIndexFixture({ 'wipe-shell': { hasPrompt: false }, 'keep-spoke': { hasPrompt: false } }, 'wipe-shell')
    writeLog('wipe-shell', [])
    writeLog('keep-spoke', [human({ kind: 'user' })])
    writeFileSync(lastUsedFile, JSON.stringify({ 'wipe-shell': 1, 'keep-spoke': 2 }))
    writeFileSync(agentViewFile, JSON.stringify({ 'wipe-shell': 1, 'keep-spoke': 2 }))
    writeFileSync(resumeFile, 'wipe-shell')
    const indexBefore = readFileSync(indexFile, 'utf8')

    const result = sweepUnspokenSessions(treeDeps())

    check('only the unspoken shell was deleted', () => {
      assert.deepEqual(result.deleted, ['wipe-shell'])
    })
    check('the log directory is gone and the spoken one survives', () => {
      assert.equal(existsSync(logDir('wipe-shell')), false)
      assert.equal(existsSync(logDir('keep-spoke')), true)
    })
    check('the index is not rewritten (the listing GC converges it)', () => {
      assert.equal(readFileSync(indexFile, 'utf8'), indexBefore)
      assert.equal(readIndex().has('wipe-shell'), true)
    })
    check('the per-session notes follow the deleted session only', () => {
      assert.deepEqual(JSON.parse(readFileSync(lastUsedFile, 'utf8')), { 'keep-spoke': 2 })
      assert.deepEqual(JSON.parse(readFileSync(agentViewFile, 'utf8')), { 'keep-spoke': 2 })
      assert.equal(readResumeTarget(), undefined)
    })
    check('a second round reports the deleted shell as absent instead of failing', () => {
      const again = sweepUnspokenSessions(treeDeps())
      assert.deepEqual(again.deleted, [])
      assert.equal(reasonOf(again, 'wipe-shell'), 'log-absent')
    })
  })

  test('12. a refused delete is reported and never removes the log', () => {
    rmSync(sessionsRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(workspaceDir, { recursive: true })
    writeIndexFixture({ 'refused-shell': { hasPrompt: false }, 'throwing-delete': { hasPrompt: false } }, 'refused-shell')
    writeLog('refused-shell', [])
    writeLog('throwing-delete', [])
    const result = sweepUnspokenSessions({
      ...treeDeps(),
      deleteLog: (id: string) => {
        if (id === 'throwing-delete') throw new Error('fixture delete failure')
        return 'unavailable'
      },
    })
    check('a declined delete keeps the directory and is counted', () => {
      assert.deepEqual(result.deleted, [])
      assert.equal(reasonOf(result, 'refused-shell'), 'delete-unavailable')
      assert.ok(existsSync(logDir('refused-shell')))
    })
    check('a throwing delete is downgraded to the same unavailable outcome', () => {
      assert.equal(reasonOf(result, 'throwing-delete'), 'delete-unavailable')
      assert.ok(existsSync(logDir('throwing-delete')))
    })
    check('an injected forget hook cannot break the round', () => {
      const noisy = sweepUnspokenSessions({
        ...treeDeps(),
        deleteLog: () => 'deleted',
        forgetState: () => { throw new Error('fixture forget failure') },
      })
      assert.deepEqual(noisy.deleted, ['refused-shell', 'throwing-delete'])
    })
  })
  test('13. a candidate\'s own header decides delegation, not the listing cache', () => {
    // The listing cache is a BOOT-time snapshot (F-03). A delegated run created
    // after boot is in the index but not in that listing, so a rule that reads
    // only the listing would hand it to the delete primitive. This tree is
    // exactly that shape: one session the listing knows about (`list-delegated`)
    // and five it does not.
    const headerIndex: Record<string, IndexRow> = {
      'sub-header-only': { hasPrompt: false },
      'deep-header': { hasPrompt: false },
      'fork-of-delegated': { hasPrompt: false },
      'fork-of-header-delegated': { hasPrompt: false },
      'fork-of-root': { hasPrompt: false },
      'fork-inherited-turn': { hasPrompt: false },
      'plain-encoding-shell': { hasPrompt: false },
    }
    buildTree(headerIndex, {})
    // The header is the ONLY source for these rows; the listing below is stale
    // by construction and names an id that is not even in the index.
    writeLogWithHeader('sub-header-only', { origin: 'subagent', delegationDepth: 1 })
    writeLogWithHeader('deep-header', { delegationDepth: 2 })
    writeLogWithHeader('fork-of-delegated', { parentSession: 'list-delegated' })
    // One hop further: the ancestor is delegated by ITS OWN header and is in no
    // listing, which is exactly the post-boot case this layer exists for.
    writeLogWithHeader('fork-of-header-delegated', { parentSession: 'sub-header-only' })
    writeLogWithHeader('fork-of-root', { parentSession: 'list-root' })
    // A fork's own log carries the inherited prefix, so layer ② sees whatever
    // the ancestor already said — this is the evidence the fork rule rests on.
    writeLogWithHeader('fork-inherited-turn', { parentSession: 'list-root' }, [turnStart])
    // A `compression:"none"` backend writes a PLAIN `session.jsonl`, which the
    // header reader's lookup deliberately does not reach — and neither does the
    // delete primitive's. This is the case that makes "an unreadable header adds
    // no protection" safe: unknown here still cannot remove anything.
    mkdirSync(logDir('plain-encoding-shell'), { recursive: true })
    writeFileSync(
      join(logDir('plain-encoding-shell'), 'session.jsonl'),
      [header('plain-encoding-shell'), boot].map(row => JSON.stringify(row)).join('\n') + '\n',
    )

    check('the shipping header reader reads the first physical frame, and only claims what is there', () => {
      assert.equal(readSessionHeaderFromLog('sub-header-only')?.origin, 'subagent')
      assert.equal(readSessionHeaderFromLog('deep-header')?.delegationDepth, 2)
      assert.equal(readSessionHeaderFromLog('fork-of-root')?.parentSession, 'list-root')
      assert.equal(readSessionHeaderFromLog('fork-of-root')?.origin, undefined)
      assert.equal(readSessionHeaderFromLog('no-such-log-at-all'), undefined, 'no log is "unknown", never "root"')
    })

    const listed = new Set(['list-delegated'])
    const headerDeps = () => ({
      currentSessionId: () => 'bound-session',
      liveSessionIds: () => new Set<string>(),
      isSubagentOrDescendant: (id: string) => listed.has(id),
    })
    const result = collectUnspokenSessionIds(headerDeps())

    check('a run whose own header says origin:subagent is spared (the boot-time listing never saw it)', () => {
      assert.equal(reasonOf(result, 'sub-header-only'), 'subagent')
      assert.ok(!result.ids.includes('sub-header-only'))
      assert.ok(existsSync(logDir('sub-header-only')))
    })
    check('a nonzero delegationDepth alone is delegation too (upstream keeps it optional)', () => {
      assert.equal(reasonOf(result, 'deep-header'), 'subagent')
      assert.ok(!result.ids.includes('deep-header'))
    })
    check('a fork of a listed delegated run is spared as a descendant', () => {
      assert.equal(reasonOf(result, 'fork-of-delegated'), 'subagent')
    })
    check('a fork whose ancestor is delegated by its OWN header is spared too', () => {
      assert.equal(reasonOf(result, 'fork-of-header-delegated'), 'subagent')
      assert.ok(!result.ids.includes('fork-of-header-delegated'))
    })
    check('a plain fork of a non-delegated parent is NOT spared by the header rule', () => {
      assert.ok(result.ids.includes('fork-of-root'), 'the listing decides forks; the header only adds delegation')
    })
    check('a fork whose inherited log carries a turn/start is spared by the log layer', () => {
      assert.equal(reasonOf(result, 'fork-inherited-turn'), 'turn-start')
      assert.ok(!result.ids.includes('fork-inherited-turn'))
    })

    // The negative control that makes the five assertions above mean something:
    // the shipped pre-F-03 rule (listing cache only) really does collect the
    // header-delegated shells — R-A's `sub-live` handed to the delete primitive.
    const shipping = unspokenJudges(headerDeps())
    const listingOnly = collectUnspokenSessionIds(headerDeps(), {
      index: shipping.index,
      log: shipping.log,
      held: id => headerDeps().isSubagentOrDescendant(id) ? 'subagent' : undefined,
    })
    check('the pre-fix listing-only rule collects the header-delegated shells (this case can go red)', () => {
      assert.ok(listingOnly.ids.includes('sub-header-only'))
      assert.ok(listingOnly.ids.includes('deep-header'))
      assert.ok(listingOnly.ids.includes('fork-of-header-delegated'))
      assert.ok(!result.ids.includes('sub-header-only'), 'and the shipped rule must not')
    })

    check('an unreadable header is UNKNOWN (not "a root conversation"), and unknown cannot delete', () => {
      assert.equal(readSessionHeaderFromLog('plain-encoding-shell'), undefined)
      assert.ok(result.ids.includes('plain-encoding-shell'), 'with no header and no listing verdict it is a candidate')
      const swept = sweepUnspokenSessions(headerDeps())
      assert.equal(reasonOf(swept, 'plain-encoding-shell'), 'delete-unavailable')
      assert.equal(existsSync(join(logDir('plain-encoding-shell'), 'session.jsonl')), true)
    })
  })

  test('14. a session another live process holds is never swept', () => {
    const ledgerFile = join(dataDir, 'session-mounts.json')
    const foreignPid = process.ppid

    buildTree({ 'held-elsewhere': { hasPrompt: false }, 'plain-shell': { hasPrompt: false } }, {})
    writeLog('held-elsewhere', [])
    writeLog('plain-shell', [])
    // The real ledger document (`publishMounts` writes version 1 + owners). The
    // version is module-private, so it is pinned by the reader check below: a
    // bump fails loudly there instead of silently disarming this case.
    writeFileSync(ledgerFile, JSON.stringify({
      version: 1,
      owners: [
        { pid: foreignPid, startedAt: 1, sessionIds: ['held-elsewhere'] },
        { pid: process.pid, startedAt: 0, sessionIds: ['plain-shell'] },
      ],
    }))
    check('the fixture ledger really reaches readSessionOwners (a foreign live holder and this process)', () => {
      const read = readMountLedgerStrict()
      if (!read.ok) assert.fail(`the fixture ledger must parse: ${read.detail}`)
      const owners = readSessionOwners()
      assert.equal(owners.get('held-elsewhere')?.pid, foreignPid, 'the foreign holder must survive the live-pid filter')
      assert.equal(owners.get('plain-shell')?.pid, process.pid)
    })

    const occupiedElsewhere = (): ReadonlySet<string> => new Set(['held-elsewhere'])
    const result = collectUnspokenSessionIds({ ...treeDeps(), occupiedElsewhere })
    check('a foreign holder is spared and reported with its own reason', () => {
      assert.equal(reasonOf(result, 'held-elsewhere'), 'held-elsewhere')
      assert.ok(!result.ids.includes('held-elsewhere'))
    })
    check('the same fixture with NO ledger fact is a deletion candidate (this case can go red)', () => {
      const withoutLedger = collectUnspokenSessionIds({ ...treeDeps(), occupiedElsewhere: () => new Set<string>() })
      assert.ok(withoutLedger.ids.includes('held-elsewhere'), 'an empty ledger is the pre-F-04 answer')
    })
    check('a session only this process holds is not in the foreign set (the live/bound layer covers it)', () => {
      assert.ok(result.ids.includes('plain-shell'), 'nothing claims it, so it stays a candidate')
      assert.equal(occupiedElsewhere().has('plain-shell'), false)
    })
    check('this process\'s own facts are reported before the foreign one', () => {
      const both = collectUnspokenSessionIds({
        ...treeDeps(),
        liveSessionIds: () => new Set(['held-elsewhere']),
        occupiedElsewhere,
      })
      assert.equal(reasonOf(both, 'held-elsewhere'), 'live-session')
    })

    const swept = sweepUnspokenSessions({ ...treeDeps(), occupiedElsewhere })
    check('the real sweep never touches the foreign holder\'s log', () => {
      assert.deepEqual(swept.deleted, ['plain-shell'])
      assert.equal(existsSync(logDir('held-elsewhere')), true)
      assert.equal(existsSync(logDir('plain-shell')), false)
    })

    // The production wiring, behaviorally: `sweepUnspokenOnExit` builds the set
    // from the REAL ledger and keeps only the records another process wrote.
    let captured: UnspokenSweepDeps | undefined
    writeLog('plain-shell', [])
    sweepUnspokenOnExit({
      currentSessionId: () => 'cur',
      liveSessionIds: () => new Set<string>(),
      listedSessions: () => [{ id: 'list-root' }],
      sweep: deps => {
        captured = deps
        return { deleted: [], skipped: [] }
      },
    })
    check('the exit sweep wires the cross-process ledger in, filtered to foreign holders', () => {
      const foreign = captured?.occupiedElsewhere?.()
      assert.notEqual(foreign, undefined, 'sweepUnspokenOnExit must pass the ledger seam (F-04)')
      assert.equal(foreign?.has('held-elsewhere'), true, 'a foreign holder must be in the spared set')
      assert.equal(foreign?.has('plain-shell'), false, 'our own record is not a foreign holder')
    })

    check('the exit path can say WHY it had no listing (F-13: "no source" is not "no listing")', () => {
      const gap = exitListingGap({ cachedSessions: () => [] })
      const none = exitListingGap({ cachedSessions: () => undefined })
      const missing = exitListingGap({})
      const threw = exitListingGap({ cachedSessions: () => { throw new Error('cache boom') } })
      assert.equal(gap, 'listed', 'a readable listing is reported as read, not as a gap')
      assert.match(none, /no listing/u)
      assert.match(missing, /no source/u)
      assert.match(threw, /read failed/u)
      assert.equal(new Set([none, missing, threw]).size, 3, 'the three ways to lose the listing must read differently')
    })
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${cases - failures}/${cases} cases passed, ${checks} checks`)
if (failures > 0) {
  console.error(`${failures} unspoken-session sweep regressions failed`)
  process.exit(1)
}
console.log('unspoken-session sweep regression: OK')
