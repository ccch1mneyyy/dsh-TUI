#!/usr/bin/env node
/**
 * Clean-exit sweep regression (ADR-0012 decisions 3/5 · AC-5 / AC-6):
 *
 *  - the normal-exit fall-through sweeps the never-spoken shells and folds the
 *    count into the notice `finishExit` writes. The notice lands immediately
 *    after the terminal cleanup, so the round has to be OVER before the call —
 *    an awaited sweep could never reach it (DESIGN D6);
 *  - no other exit path sweeps: the crash / `/update` / kernel-switch /
 *    `/restart` / startup-failure branches keep the notices they had;
 *  - a hostile dependency costs the round, never the shutdown: the terminal
 *    restore sequence and the process hand-off stay exactly where they were
 *    (D7, fail-soft);
 *  - layer ③ is fed with this process's real view — the bound session, the
 *    live agents the registry lists, the sessions a live peer holds, and the
 *    delegated lineage of the listing plus each candidate's own header;
 *  - a session whose log carries a human message but no `turn/start` survives
 *    (AC-6 ①), and a listing this process never made spares the whole index
 *    instead of guessing the lineage.
 *
 * ## What is driven for real, and what can only be tripwired (F-10 / L-033)
 *
 * Every helper the branch calls is an exported pure function, so it is DRIVEN
 * here: `composeExitNotice` (§1), `readExitListing` (§3), `exitListingGap`
 * (§8), `readSessionHeaderFromLog` + the delegation verdict it feeds (§9),
 * `liveExitSessionIds` (§10), `sweepUnspokenOnExit` (§1/§4/§5) and — for the
 * cross-site question of who counts as a person — the sweep's log layer against
 * `digestSession` (§11).
 *
 * The branch itself is a closure inside `apply()`, so its WIRING can only be
 * read off `plugin.ts`. THREE assertions carry that meaning (§7); the rest of
 * what used to be nine source-text assertions is kept here as a tripwire list,
 * deliberately NOT asserted, because each was measured to go red on a
 * zero-behaviour edit (a reworded comment, an extra mention of a name, moving a
 * declaration) — the brittleness F-10 names:
 *
 *   - `attachSessionListMetadata(ctx)` is invoked exactly once, at the
 *     composition root — no line number pinned here; the order this needs is
 *     asserted in `scripts/verify-session-list-metadata.ts` under
 *     `order: the session-list mirror is registered before the boot agent is
 *     resolved`;
 *   - the crash / update / kernel-switch / restart / startup branches still
 *     pass their own notice texts (`crashLine,` / `hintText,` /
 *     `t('restart-starting'),` / `formatHandoffNotice(` /
 *     `dsh-tui startup failed:`);
 *   - the count line is the dictionary entry
 *     (`t('exit-cleaned-unspoken-sessions')`), not a literal — and that one is
 *     proven behaviourally in §1, where the zh and en notices differ.
 *
 * ## Negative controls (L-044): what can be re-run here, and what cannot
 *
 * In this file, via `--negative-controls`: five groups drive deliberately
 * broken subjects (or deliberately wrong inputs) through the SAME assertion
 * bodies the suite uses and require them to go RED — see `CONTROL_GROUPS` at the
 * end. The suite runs them too, so a green run also proves its own
 * discriminating power; `--negative-controls` runs ONLY them and prints
 * `negative-controls: N/M controls went red across 5 groups` for a caller that
 * wants just that reading (T-FIX-04's `--reverse-check`).
 *
 * CLOSURE-LEVEL controls — the two from T05's one-off experiments, plus the
 * reverse-check of the §7 interval assertion. They need a real-source rewrite,
 * so they cannot live in the file; run the command and expect exactly the red
 * rows named here (measured on this suite), then restore with
 * `git checkout HEAD -- src/dsh-adapter/plugin.ts`:
 *
 *   (a) the branch feeds empty process facts — write `currentSessionId: () => undefined`
 *       and `liveSessionIds: () => new Set()` inside the normal-exit fall-through
 *       branch's `sweepUnspokenOnExit({…})` call in `plugin.ts`. No line number is
 *       pinned on purpose: §7's `wiring:` assertions locate that call structurally
 *         $ node --import tsx/esm scripts/verify-session-cleanup-exit.tsx
 *         ⇒ 1 red: `wiring: the branch feeds the sweep the bound session, …`
 *   (b) the branch stops sweeping — drop the `const swept = sweepUnspokenOnExit({…})`
 *       call in `plugin.ts`'s normal-exit fall-through branch, leaving
 *       `const swept = undefined as UnspokenSweepResult | undefined` so the notice
 *       falls back to `hint`
 *         $ node --import tsx/esm scripts/verify-session-cleanup-exit.tsx
 *         ⇒ 2 red: `wiring: the sweep is invoked once, …` (found 0) and
 *           `wiring: the branch feeds the sweep …`
 *   (c) F-12's counter-example — inject a second sweep into the CRASH branch
 *       (`sweepUnspokenSessions({ currentSessionId: () => channel.agentId,
 *       liveSessionIds: () => liveExitSessionIds(ctx, channel.agentId),
 *       isSubagentOrDescendant: () => true })` before `finish: crashLine => {`)
 *         $ node --import tsx/esm scripts/verify-session-cleanup-exit.tsx
 *         ⇒ 1 red: `wiring: the sweep is invoked once, …` (found 2, printing both
 *           offsets). The other two wiring assertions stay GREEN — which is why
 *           the interval property, not the call-site count, is what closes F-12.
 *
 * The three sweep/notice/lineage groups are the other three of T05's five
 * experiments (a hint-only `composeExitNotice`, the pre-fix lineage mapping, a
 * blind / brittle sweep runner); the remaining two groups cover this script's
 * own new guards (the §7 source window, §11's cross-site parity).
 *
 * F-17 has its own switch, because no control that lives INSIDE the suite can
 * crash it and still report the crash:
 *
 *   $ DSH_TUI_EXIT_SWEEP_CRASH=1 node --import tsx/esm scripts/verify-session-cleanup-exit.tsx
 *   ⇒ `FAIL: F-17 control: a deliberately red row before the crash …` and
 *     `verify-session-cleanup-exit: 1/2 checks passed` are printed BEFORE the
 *     stack trace, exit 1. A plain run can never show that: the reporter used
 *     to be the last statement of the file, so a mid-suite throw printed the
 *     stack and nothing about which checks had run.
 *
 * ## Isolation (B-12)
 *
 * `DATA_DIR` is a module-level constant (the `DATA_DIR` export in
 * `src/utils/paths.ts`, evaluated at import time), so the throwaway HOME is
 * installed BEFORE the first import of anything that reaches it — hence the
 * dynamic imports below. Without that, the synthetic fixtures
 * read the operator's REAL `~/.dsh-tui/session-mounts.json` and their verdicts
 * depend on it. §12 asserts the isolation: the ledger the round consults is a
 * file under the throwaway home, and it is really consumed.
 *
 * Run: node --import tsx/esm scripts/verify-session-cleanup-exit.tsx [--negative-controls]
 *      DSH_TUI_EXIT_SWEEP_CRASH=1 node --import tsx/esm scripts/verify-session-cleanup-exit.tsx (F-17)
 * @module dsh-tui/scripts/verify-session-cleanup-exit
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
// Type-only imports are erased at load time, so they cannot pull a module (and
// its `DATA_DIR`) in before the throwaway home is installed (B-12).
import type { ExitSweepInput } from '../src/dsh-adapter/plugin.js'
import type {
  UnspokenCollection,
  UnspokenSessionLineage,
  UnspokenSweepDeps,
  UnspokenSweepResult,
} from '../src/dsh-adapter/unspoken-sessions.js'

/** Run only the negative controls (T-FIX-04's `--reverse-check` driver). */
const NEGATIVE_CONTROLS_ONLY = process.argv.includes('--negative-controls')
/**
 * F-17's own reverse-check: crash the suite on purpose right after the first
 * check and require the reporter to have printed the rows that ran (see the
 * module docstring for the command and the expected reading).
 */
const CRASH_ON_PURPOSE = process.env.DSH_TUI_EXIT_SWEEP_CRASH === '1'

// ── a throwaway home BEFORE the first import that captures DATA_DIR (B-12) ──
const operatorHome = homedir()
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-exit-sweep-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'dsh')
process.env.DSH_TUI_SESSION_ROOT = join(root, 'logs')

const { DATA_DIR } = await import('../src/utils/paths.js')
const {
  composeExitNotice,
  exitListingGap,
  finishExit,
  liveExitSessionIds,
  readExitListing,
  sweepUnspokenOnExit,
} = await import('../src/dsh-adapter/plugin.js')
const {
  collectUnspokenSessionIds,
  readSessionHeaderFromLog,
  sweepUnspokenSessions,
} = await import('../src/dsh-adapter/unspoken-sessions.js')
const { digestSession } = await import('../src/dsh-adapter/sessions/digest.js')
const { getLang, setLang, t } = await import('../src/i18n.js')
const { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, DISABLE_WIN32_INPUT_MODE } = await import('../src/ink/termio/csi.js')
const { DBP, DFE, DISABLE_MOUSE_TRACKING, SHOW_CURSOR } = await import('../src/ink/termio/dec.js')
const { CLEAR_ITERM2_PROGRESS } = await import('../src/ink/termio/osc.js')
const instances = (await import('../src/ink/instances.js')).default

// ── harness ─────────────────────────────────────────────────────────────────
// F-17: one reporter, which the exit handler also calls, so a throw halfway
// through still prints WHICH checks were red (and the temp tree is still
// removed) instead of leaving a bare stack trace.

let failures = 0
const results: string[] = []
let controlsReading = ''

const record = (name: string, ok: boolean, detail = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** Run one assertion body (node:assert throws) as one reported check. */
const checkBody = (name: string, body: () => void): void => {
  try {
    body()
    record(name, true)
  } catch (error) {
    const message = String((error as Error).message ?? error).replaceAll('\n', ' | ').slice(0, 400)
    record(name, false, message)
  }
}

/** Require one assertion body to FAIL — the discriminating-power control. */
const expectRed = (name: string, run: () => void, why: string, marker: string): void => {
  try {
    run()
  } catch (error) {
    const message = String((error as Error).message ?? error)
    if (!message.includes(marker)) {
      record(name, false, `went red on the wrong assertion: ${message.split('\n')[0] ?? ''} (expected one mentioning "${marker}")`)
      return
    }
    record(name, true)
    return
  }
  record(name, false, `expected a failure because ${why}`)
}

let reported = false
const report = (): void => {
  if (reported) return
  reported = true
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // A temp directory the OS will reap is not worth failing a regression for.
  }
  console.log(results.join('\n'))
  console.log(`verify-session-cleanup-exit: ${results.length - failures}/${results.length} checks passed`)
  if (controlsReading !== '') console.log(controlsReading)
  if (failures > 0) process.exitCode = 1
}
// Both the normal end of the suite and a throw in the middle land here (F-17):
// a crash must still print which checks were red, not just a stack trace.
process.on('exit', report)

// ── the throwaway session root ──────────────────────────────────────────────
// Two shells nobody ever spoke in, and four that must survive: a conversation
// with a `turn/start`, one whose only evidence is a human message (no turn yet
// — the shape the web blank rule would call empty), a delegated run, a live
// background run, and the session this process is bound to. Every index entry
// says `hasPrompt: false` on purpose: the log layer and the process layer are
// what the assertions below actually exercise.
const SHELLS = ['shell-a', 'shell-b']
const SPARED = ['spoken', 'human-first', 'sub-run', 'bg', 'cur']
const dirOf = (id: string): string => join(root, id)
const index = new Map(SHELLS.concat(SPARED).map(id => [id, { derived: { hasPrompt: false } }]))
const logs = new Map<string, { readonly events: readonly unknown[], readonly complete: boolean }>([
  ['shell-a', { events: [], complete: true }],
  ['shell-b', { events: [], complete: true }],
  ['spoken', { events: [{ type: 'turn/start' }], complete: true }],
  ['human-first', { events: [{ type: 'user/message', data: { source: { kind: 'user' } } }], complete: true }],
  ['sub-run', { events: [], complete: true }],
  ['bg', { events: [], complete: true }],
  ['cur', { events: [], complete: true }],
])
const ensureDirs = (): void => {
  for (const id of SHELLS.concat(SPARED)) mkdirSync(dirOf(id), { recursive: true })
}
const removed: string[] = []
ensureDirs()

/** The store seams: a fake index, fake logs, a real removal inside the temp root. */
const fixtureSeams = (overrides: Partial<UnspokenSweepDeps> = {}): Partial<UnspokenSweepDeps> => ({
  readIndex: () => index,
  readLog: id => logs.get(id),
  deleteLog: id => {
    removed.push(id)
    rmSync(dirOf(id), { recursive: true, force: true })
    return 'deleted'
  },
  ...overrides,
})

/** A sweep runner shape: the exit helper as the branch calls it, plus seam overrides. */
type SweepRun = (input: ExitSweepInput, overrides?: Partial<UnspokenSweepDeps>) => UnspokenSweepResult | undefined

/** The exit helper as the clean-exit branch calls it, with the store faked. */
const sweepWithFixture: SweepRun = (input, overrides = {}) =>
  sweepUnspokenOnExit({
    ...input,
    sweep: deps => sweepUnspokenSessions({ ...deps, ...fixtureSeams(overrides) }),
  })

/** The same fixture sweep, with the process facts deliberately rewritten (controls). */
const sweepFixtureRewriting = (rewrite: (input: ExitSweepInput) => ExitSweepInput): SweepRun =>
  (input, overrides = {}) => sweepWithFixture(rewrite(input), overrides)

/** The process view the clean-exit branch passes: bound session + live + lineage. */
const exitInput = (overrides: Partial<ExitSweepInput> = {}): ExitSweepInput => ({
  currentSessionId: () => 'cur',
  liveSessionIds: () => new Set(['bg']),
  listedSessions: () => [
    { id: 'sub-run', delegated: true, parent: 'cur' },
    { id: 'cur' },
  ],
  ...overrides,
})

/** Rebuild the fixture and run one fresh clean-exit round. */
const freshCleanExit = (run: SweepRun): UnspokenSweepResult | undefined => {
  ensureDirs()
  removed.length = 0
  return run(exitInput())
}

/** One zstd frame, the shape the durable log stores rows in. */
const frame = (rows: readonly unknown[]): Buffer =>
  zstdCompressSync(Buffer.from(rows.map(row => `${JSON.stringify(row)}\n`).join('')))

/**
 * Write a REAL compressed session log where the shipping locators look for it
 * (`sessionsRoots()` honours `DSH_TUI_SESSION_ROOT`), so `readSessionHeaderFromLog`
 * and `digestSession` read the same fixture the sweep does. The name is the
 * canonical committed generation (`session.v4.jsonl.zstd`), because
 * `findSessionLogFile` only accepts a `session[.vN].jsonl[.zstd]` artifact.
 * @param sessionId - Session directory name.
 * @param header - Extra physical-header fields (`origin`, `delegationDepth`, …).
 * @param events - Rows committed after the header.
 * @returns The artifact path.
 */
const writeRealLog = (sessionId: string, header: Record<string, unknown> = {}, events: readonly unknown[] = []): string => {
  const dir = join(process.env.DSH_TUI_SESSION_ROOT as string, 'workspace-a', sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(path, frame([
    { type: 'session', version: 4, id: sessionId, cwd: '/fixture', ...header },
    ...events,
  ]))
  return path
}

/** The reason one id was spared, from a collection or a sweep result. */
const reasonOf = (result: UnspokenCollection | UnspokenSweepResult, id: string): string | undefined =>
  result.skipped.find(row => row.id === id)?.reason

// ── the plugin source, and the guards that keep a window from being empty ──
// F-07: a bare `indexOf` + `slice` silently yields an empty string when the
// anchor moves, which makes the wiring assertion built on it vacuously green.
// Every window below goes through `window()`, which refuses `-1` and inverted
// spans instead of reading nothing.

const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
const at = (needle: string, from = 0): number => pluginSource.indexOf(needle, from)

/** A guarded source window (F-07). */
const window = (from: number, to: number, what: string): string => {
  assert.ok(from !== -1, `${what}: the opening anchor is gone from plugin.ts — re-read the branch before trusting this assertion`)
  assert.ok(to > from, `${what}: the window is empty or inverted (from=${from}, to=${to}); a slice of that span proves nothing`)
  return pluginSource.slice(from, to)
}

/**
 * Source offsets of every INVOCATION of a name family, excluding the module's
 * own `function …` definition and any mention inside a comment — so a comment
 * that names the helper (or a reworded docstring) cannot redden the result
 * (F-10's measured false-red class).
 * @param pattern - A regex whose match starts at the name.
 * @returns Absolute offsets into `pluginSource`.
 */
const invocationsMatching = (pattern: RegExp): number[] => {
  const sites: number[] = []
  for (const match of pluginSource.matchAll(pattern)) {
    const site = match.index ?? -1
    if (site < 0) continue
    if (/\bfunction\s+$/u.test(pluginSource.slice(Math.max(0, site - 12), site))) continue
    const prefix = pluginSource.slice(pluginSource.lastIndexOf('\n', site) + 1, site).trimStart()
    if (prefix.startsWith('//') || prefix.startsWith('*') || prefix.startsWith('/*')) continue
    sites.push(site)
  }
  return sites
}

/** Every `sweepUnspoken*` invocation (import and definition excluded). */
const sweepInvocations = (): number[] => invocationsMatching(/\bsweepUnspoken[A-Za-z]*\s*\(/gu)
/** Every `composeExitNotice(` invocation (definition and comments excluded). */
const noticeInvocations = (): number[] => invocationsMatching(/\bcomposeExitNotice\s*\(/gu)

/** The fall-through block of the exit funnel: from its opening anchor through the end of its own `onUserExit`. */
const fallThroughWindow = (): { readonly from: number, readonly to: number, readonly block: string } => {
  const from = at('// Judge against the live session behind the channel')
  const to = at('\n    },', from)
  return { from, to, block: window(from, to, 'the fall-through block') }
}

// ── assertion bodies ────────────────────────────────────────────────────────
// Defined once and used twice: by the suite (green reading) and by the negative
// controls (which drive a broken subject through the very same body).

type Compose = (hint: string | undefined, cleaned: number) => string | undefined

const assertNoticeKeepsHint = (compose: Compose): void => {
  const notice = compose('Resume with the command below:\n/path', 2)
  assert.ok(notice?.startsWith('Resume with the command below:\n/path\n') === true,
    `the resume hint must be kept and the count line must follow it on its own line (got ${String(notice)})`)
  assert.equal(notice?.split('\n').length, 3, 'exactly one added line')
}
const assertNoticeCountLine = (compose: Compose): void => {
  const original = getLang()
  setLang('zh')
  const notice = compose(undefined, 2)
  setLang(original)
  assert.ok(notice?.endsWith(t('exit-cleaned-unspoken-sessions', { count: 2 })) === true,
    `the count line must be the dictionary entry with the count substituted (got ${String(notice)})`)
}
const assertNoticeLocalized = (compose: Compose): void => {
  const original = getLang()
  setLang('zh')
  const zhNotice = compose(undefined, 2)
  setLang('en')
  const enNotice = compose(undefined, 2)
  const enSingular = compose(undefined, 1)
  setLang(original)
  assert.ok(enNotice !== undefined && enNotice !== zhNotice && enNotice.includes('2'),
    `zh and en must both report the number, localized and not hard-coded (zh=${String(zhNotice)} en=${String(enNotice)})`)
  assert.ok(enSingular !== undefined && enSingular !== enNotice && enSingular.includes('1'),
    `English must pick its plural form from the count (got ${String(enSingular)})`)
}
const assertNoticeQuietWhenClean = (compose: Compose): void => {
  assert.equal(compose('hint', 0), 'hint', 'nothing cleaned leaves the hint byte-for-byte')
  assert.equal(compose(undefined, 0), undefined, 'and nothing at all stays nothing')
}

const assertCleanExitDeletes = (run: SweepRun): void => {
  const swept = freshCleanExit(run)
  assert.equal(String(swept?.deleted.join(',')), 'shell-a,shell-b',
    `the round must delete the two never-spoken shells (got ${String(swept?.deleted)})`)
  assert.ok(!existsSync(dirOf('shell-a')) && !existsSync(dirOf('shell-b')), 'and their directories must be gone from disk')
}
const assertDelegatedRunSurvives = (run: SweepRun): void => {
  freshCleanExit(run)
  assert.ok(existsSync(dirOf('sub-run')), 'a delegated run must survive (AC-6 ③): the listing names it delegated')
}
const assertHumanFirstSurvives = (run: SweepRun): void => {
  freshCleanExit(run)
  assert.ok(existsSync(dirOf('human-first')), 'a human message with no turn/start must survive (AC-6 ①): the log layer reads it, not the index flag')
}
const assertSpokenSurvives = (run: SweepRun): void => {
  freshCleanExit(run)
  assert.ok(existsSync(dirOf('spoken')), 'a conversation with a turn/start must survive')
}
const assertLiveAndBoundSurvive = (run: SweepRun): void => {
  freshCleanExit(run)
  assert.ok(existsSync(dirOf('bg')) && existsSync(dirOf('cur')), 'the live background run and the bound session must survive (AC-6 ④)')
}
const assertSparedPartition = (run: SweepRun): void => {
  const swept = freshCleanExit(run)
  assert.ok(swept !== undefined, 'a readable listing must produce a round')
  for (const [id, reason] of [['sub-run', 'subagent'], ['bg', 'live-session'], ['cur', 'current-session'], ['spoken', 'turn-start']] as const) {
    assert.equal(reasonOf(swept, id), reason, `${id} must be reported as spared with reason ${reason} (got ${String(reasonOf(swept, id))})`)
  }
}
const assertUnknownListingSpares = (run: SweepRun): void => {
  ensureDirs()
  removed.length = 0
  const swept = run(exitInput({ listedSessions: () => undefined }))
  assert.equal(swept, undefined, 'an unknown listing must report no round at all')
  assert.equal(removed.length, 0, 'and delete nothing')
  assert.ok(existsSync(dirOf('shell-a')) && existsSync(dirOf('shell-b')), 'every shell is still on disk')
  assert.equal(composeExitNotice('hint', swept?.deleted.length ?? 0), 'hint', 'and the notice stays the resume hint')
}

type ListingRead = (channel: unknown) => readonly UnspokenSessionLineage[] | undefined
const LISTED_ROWS = [
  { id: 'root-1', kind: { kind: 'root' } },
  { id: 'fork-1', kind: { kind: 'fork', parent: 'root-1' } },
  { id: 'sub-1', kind: { kind: 'subagent', parent: 'root-1', depth: 1 } },
  { id: 'sub-2', kind: { kind: 'subagent', parent: undefined, depth: 1 } },
] as const
const lineageOf = (read: ListingRead): readonly UnspokenSessionLineage[] | undefined =>
  read({ cachedSessions: () => LISTED_ROWS } as never)

const assertListingDelegatedFlag = (read: ListingRead): void => {
  const rows = lineageOf(read)
  assert.equal(rows?.[2]?.delegated, true, `a listed sub-agent must be flagged delegated (got ${String(rows?.[2]?.delegated)})`)
  assert.equal(rows?.[2]?.parent, 'root-1', 'and carry its parent')
}
const assertListingForkKeepsParent = (read: ListingRead): void => {
  const rows = lineageOf(read)
  assert.equal(rows?.[1]?.delegated, false, `a fork is not itself delegated (got ${String(rows?.[1]?.delegated)})`)
  assert.equal(rows?.[1]?.parent, 'root-1', 'the parent link is what the descendant closure walks')
}
const assertListingRootNoParent = (read: ListingRead): void => {
  const rows = lineageOf(read)
  assert.equal(rows?.[0]?.parent, undefined, 'a root records no parent')
  assert.equal(rows?.[0]?.delegated, false)
}
const assertListingParentlessDelegated = (read: ListingRead): void => {
  assert.equal(lineageOf(read)?.[3]?.delegated, true, 'a parentless delegated run is still delegated')
}
// Guard against lineage drift: a kind this build does not know must count as
// delegated, because over-marking only spares — under-marking deletes.
const assertListingUnknownKindDelegated = (read: ListingRead): void => {
  const rows = read({ cachedSessions: () => [{ id: 'mystery', kind: { kind: 'imported' } }] } as never)
  assert.equal(rows?.[0]?.delegated, true,
    `a kind this build does not know must count as delegated (got ${String(rows?.[0]?.delegated)}): over-marking only spares`)
}
const assertListingUnknownSources = (read: ListingRead): void => {
  assert.equal(read({ cachedSessions: () => [] } as never)?.length, 0, 'an empty listing is empty, not unknown')
  assert.equal(read({} as never), undefined, 'a host without the cache reports unknown')
  assert.equal(read({ cachedSessions: () => { throw new Error('cache boom') } } as never), undefined, 'a throwing cache reports unknown')
}

/** The pre-fix mapping (control G2): "delegated" meant exactly `kind === 'subagent'`. */
const preFixListing: ListingRead = channel => {
  const rows = (channel as {
    cachedSessions?(): readonly { readonly id: string, readonly kind: { readonly kind: string, readonly parent?: string | undefined } }[] | undefined
  }).cachedSessions?.()
  return rows?.map(row => ({
    id: row.id,
    delegated: row.kind.kind === 'subagent',
    parent: row.kind.kind === 'root' ? undefined : row.kind.parent,
  }))
}
/** The shipped mapping with the parent link dropped (control G2). */
const parentlessListing: ListingRead = channel =>
  (readExitListing as ListingRead)(channel)?.map(row => ({ id: row.id, delegated: row.delegated }))

/** The shipped entry point with its fail-soft wrapper removed (control G3). */
const brittleSweep: SweepRun = input => {
  const listed = input.listedSessions()
  if (listed === undefined) return undefined
  return (input.sweep ?? sweepUnspokenSessions)({
    currentSessionId: input.currentSessionId,
    liveSessionIds: input.liveSessionIds,
    isSubagentOrDescendant: () => false,
  })
}

/** Every hostile dependency, in the branch's own call shape. */
const hostileCases = (run: SweepRun): readonly (readonly [string, () => UnspokenSweepResult | undefined])[] => [
  ['the listing throws', () => run(exitInput({ listedSessions: () => { throw new Error('listing boom') } }))],
  ['the index read throws', () => run(exitInput(), { readIndex: () => { throw new Error('index boom') } })],
  ['a log read throws', () => run(exitInput(), { readLog: () => { throw new Error('log boom') } })],
  ['the delete primitive throws', () => run(exitInput(), { deleteLog: () => { throw new Error('delete boom') } })],
  // The shipping entry point, directly: `run` is the fixture runner and would
  // replace the very `sweep` seam this case is about.
  ['the round itself throws', () => sweepUnspokenOnExit({ ...exitInput(), sweep: () => { throw new Error('round boom') } })],
  ['the process-layer fact throws', () => run(exitInput({ currentSessionId: () => { throw new Error('bound boom') } }))],
]
const assertFailSoft = (run: SweepRun): void => {
  ensureDirs()
  removed.length = 0
  const outcomes: string[] = []
  let threw = false
  for (const [label, hostile] of hostileCases(run)) {
    try {
      const swept = hostile()
      outcomes.push(`${label}:${swept === undefined ? 'skipped' : swept.deleted.length}`)
    } catch (error) {
      threw = true
      outcomes.push(`${label}:THREW ${String(error)}`)
    }
  }
  assert.ok(!threw, `no hostile dependency may escape as a throw (${outcomes.join(' | ')})`)
  assert.equal(outcomes.slice(1, 4).join(','), 'the index read throws:0,a log read throws:0,the delete primitive throws:0',
    `a broken index, log or delete deletes nothing and still reports the round (${outcomes.join(' | ')})`)
  assert.ok(outcomes[0] === 'the listing throws:skipped' && outcomes[4] === 'the round itself throws:skipped',
    `a throwing listing or round is reported as no round at all (${outcomes.join(' | ')})`)
  assert.ok(existsSync(dirOf('shell-a')) && existsSync(dirOf('shell-b')), 'a shell whose dependencies failed is still on disk')
}

// ── §11's fixtures: who counts as a person, across the two shipped readers ──
// B-1: the same question has three implementations. Two of them — this module's
// `conversationEvidence` and `digest.ts`'s `humanPrompt` — agree that a message
// with NO source is human; the third (`channel/session-lineage.ts`) says it is
// not. Fixing the third is outside this task's write set, so what is pinned
// here is that the two sides that DECIDE deletion stay in agreement, including
// on that divergence point (control G5 drives the third rule through this very
// assertion and requires it to go red).
const SAMPLE_EVENTS: readonly (readonly [string, unknown])[] = [
  ['a user/message from the person', { type: 'user/message', data: { source: { kind: 'user' } } }],
  ['a user/message from a sub-agent', { type: 'user/message', data: { source: { kind: 'subagent' } } }],
  ['a user/message with NO source at all', { type: 'user/message', data: {} }],
  ['a user/message with a null source', { type: 'user/message', data: { source: null } }],
  ['a user/message whose source is not an object', { type: 'user/message', data: { source: 'user' } }],
  ['an inbox splice carrying a human message', { type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user', source: { kind: 'user' }, content: [] }] } }],
  ['an inbox splice carrying only a model message', { type: 'agent/inbox/spliced', data: { inserted: [{ role: 'assistant', source: { kind: 'model' }, content: [] }] } }],
  ['an assistant message', { type: 'assistant/message', data: { source: { kind: 'model' } } }],
  ['a bare turn/start', { type: 'turn/start', data: { turn: 0 } }],
]

/** Does the SWEEP's log layer call this event human evidence? (drives `conversationEvidence`.) */
const sweepSaysHuman = (one: unknown): boolean => {
  const collected = collectUnspokenSessionIds({
    readIndex: () => new Map([['sample', { derived: { hasPrompt: false } }]]),
    readLog: () => ({ events: [one], complete: true }),
    currentSessionId: () => undefined,
    liveSessionIds: () => new Set<string>(),
    isSubagentOrDescendant: () => false,
  })
  return collected.skipped.some(row => row.id === 'sample' && row.reason === 'human-message')
}

/** Does the DIGEST call the same log a prompt? One own artifact per sample. */
const digestSaysHuman = (one: unknown, index: number): boolean =>
  digestSession(writeRealLog(`parity-${index}`, {}, [one]), '/fixture').hasPrompt

/** `channel/session-lineage.ts:48-53` verbatim: `source?.kind === 'user'` — no source is NOT human. */
const lineageSaysHuman = (one: unknown): boolean => {
  const event = one as {
    readonly type?: string
    readonly data?: {
      readonly source?: { readonly kind?: string }
      readonly inserted?: readonly { readonly role?: string, readonly source?: { readonly kind?: string } }[]
    }
  }
  if (event.type === 'user/message') return event.data?.source?.kind === 'user'
  if (event.type === 'agent/inbox/spliced') {
    return (event.data?.inserted ?? []).some(entry => entry.role === 'user' && entry.source?.kind === 'user')
  }
  return false
}

const assertHumanPromptParity = (): void => {
  const disagreements = SAMPLE_EVENTS
    .map(([label, one], index) => ({ label, sweep: sweepSaysHuman(one), digest: digestSaysHuman(one, index) }))
    .filter(row => row.sweep !== row.digest)
  assert.deepEqual(disagreements, [],
    'the sweep and the digest must call the same events human: they decide the same irreversible delete (B-1)')
}

// ── 1. the clean exit sweeps, and the count reaches the notice ──────────────

if (!NEGATIVE_CONTROLS_ONLY) {
  checkBody('clean exit: exactly the sessions no human spoke in are deleted, and gone from disk', () => assertCleanExitDeletes(sweepWithFixture))
  if (CRASH_ON_PURPOSE) {
    record('F-17 control: a deliberately red row before the crash', false,
      'this row must be printed even though the process throws on the next line')
    throw new Error('DSH_TUI_EXIT_SWEEP_CRASH=1: on purpose — the reporter must still name the red row (F-17)')
  }
  checkBody('clean exit: a human message with no turn/start survives (AC-6 ①)', () => assertHumanFirstSurvives(sweepWithFixture))
  checkBody('clean exit: a conversation with a turn/start survives', () => assertSpokenSurvives(sweepWithFixture))
  checkBody('clean exit: a delegated run survives (AC-6 ③)', () => assertDelegatedRunSurvives(sweepWithFixture))
  checkBody('clean exit: the live background run and the bound session survive (AC-6 ④)', () => assertLiveAndBoundSurvive(sweepWithFixture))
  checkBody('clean exit: the spared set is reported as a full partition, not a log', () => assertSparedPartition(sweepWithFixture))
  checkBody('notice: the resume hint is kept, and the count line follows it on its own line', () => assertNoticeKeepsHint(composeExitNotice))
  checkBody('notice: the count line is the dictionary entry, with the count substituted', () => assertNoticeCountLine(composeExitNotice))
  checkBody('notice: zh and en both report the number (localized, not hard-coded)', () => assertNoticeLocalized(composeExitNotice))
  checkBody('notice: nothing cleaned leaves the notice byte-for-byte what it was', () => assertNoticeQuietWhenClean(composeExitNotice))
}

// ── 2. layer ③ is wired with this process's own view ───────────────────────
if (!NEGATIVE_CONTROLS_ONLY) {
  let captured: UnspokenSweepDeps | undefined
  let rounds = 0
  const swept = sweepUnspokenOnExit({
    currentSessionId: () => 'cur',
    liveSessionIds: () => new Set(['bg']),
    listedSessions: () => [
      { id: 'sub-run', delegated: true, parent: 'root-1' },
      { id: 'fork-of-sub', parent: 'sub-run' },
      { id: 'root-1' },
    ],
    sweep: deps => {
      rounds += 1
      captured = deps
      return { deleted: ['x'], skipped: [] }
    },
  })
  checkBody('layer ③: the sweep receives the bound session as currentSessionId', () => {
    assert.equal(captured?.currentSessionId(), 'cur')
  })
  checkBody('layer ③: the sweep receives the live-session set', () => {
    assert.equal(captured?.liveSessionIds().has('bg'), true)
  })
  checkBody('layer ③: a delegated run is spared', () => {
    assert.equal(captured?.isSubagentOrDescendant('sub-run'), true)
  })
  checkBody('layer ③: a fork of a delegated run counts as a descendant', () => {
    assert.equal(captured?.isSubagentOrDescendant('fork-of-sub'), true)
  })
  checkBody('layer ③: an ordinary conversation is not delegated', () => {
    assert.equal(captured?.isSubagentOrDescendant('root-1'), false)
  })
  checkBody('layer ③: the round runs exactly once and its result is reported', () => {
    assert.equal(rounds, 1, 'one round per exit')
    assert.equal(String(swept?.deleted.join(',')), 'x', 'and the round\'s own result is what the caller sees')
  })
}

// ── 3. the listing seam: lineage mapping, and "unknown" is not "empty" ─────
if (!NEGATIVE_CONTROLS_ONLY) {
  checkBody('listing: a delegated run is flagged and carries its parent', () => assertListingDelegatedFlag(readExitListing as ListingRead))
  checkBody('listing: a fork keeps its parent and is not itself delegated', () => assertListingForkKeepsParent(readExitListing as ListingRead))
  checkBody('listing: a root records no parent', () => assertListingRootNoParent(readExitListing as ListingRead))
  checkBody('listing: a parentless delegated run is still delegated', () => assertListingParentlessDelegated(readExitListing as ListingRead))
  checkBody('listing: a kind this build does not know counts as delegated (over-marking only spares)', () => assertListingUnknownKindDelegated(readExitListing as ListingRead))
  checkBody('listing: an empty listing is empty, not unknown; no source and a throw are both unknown', () => assertListingUnknownSources(readExitListing as ListingRead))
}

// ── 4. no listing yet ⇒ no round: the index is spared, never guessed ───────
if (!NEGATIVE_CONTROLS_ONLY) {
  checkBody('unknown lineage: the round reports nothing and deletes nothing', () => assertUnknownListingSpares(sweepWithFixture))
}

// ── 5. fail-soft: a hostile dependency never blocks the shutdown ───────────
if (!NEGATIVE_CONTROLS_ONLY) {
  checkBody('fail-soft: no hostile dependency escapes as a throw, and every case is still reported', () => assertFailSoft(sweepWithFixture))
}

// ── 6. the terminal restore sequence is unchanged, notice and all ──────────
class CapturingStream extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(String(chunk))
    cb()
  }
}

if (!NEGATIVE_CONTROLS_ONLY) {
  const captured = new CapturingStream() as unknown as NodeJS.WriteStream
  const originalStdout = process.stdout
  const swapStdout = (stream: NodeJS.WriteStream): void => {
    Object.defineProperty(process, 'stdout', {
      value: stream,
      configurable: true,
      writable: true,
      enumerable: true,
    })
  }
  swapStdout(captured)
  instances.delete(captured)
  let done = false
  await finishExit(
    { logger: { debug() {} } } as never,
    { unmount() {} } as never,
    false,
    composeExitNotice('hint', 2),
    undefined,
    () => { done = true },
  )
  swapStdout(originalStdout)
  const written = captured.chunks.join('')
  const order = [DISABLE_MOUSE_TRACKING, DISABLE_MODIFY_OTHER_KEYS, DISABLE_KITTY_KEYBOARD, DISABLE_WIN32_INPUT_MODE, DFE, DBP, SHOW_CURSOR, CLEAR_ITERM2_PROGRESS]
  let markerAt = -1
  let ordered = true
  for (const marker of order) {
    const found = written.indexOf(marker)
    if (found <= markerAt) { ordered = false; break }
    markerAt = found
  }
  checkBody('shutdown: the terminal restore sequence is written in the shipped order', () => {
    assert.ok(ordered, `every restore marker must appear after the previous one (${JSON.stringify(written)})`)
  })
  checkBody('shutdown: the sweep line is the last thing written, after the restore sequence', () => {
    assert.ok(written.endsWith(`${composeExitNotice('hint', 2) ?? ''}\n`), `the notice is written last (${JSON.stringify(written.slice(-80))})`)
  })
  checkBody('shutdown: the notice still precedes the dispose hand-off', () => {
    assert.ok(done, 'the hand-off ran')
    assert.ok(written.indexOf('hint') > written.indexOf(SHOW_CURSOR), 'after the cursor is restored')
  })
}

// ── 7. the wiring: only the clean-exit branch sweeps (F-10 / F-12) ─────────
// Three assertions carry the meaning. Everything else that used to be a source
// text assertion lives in this file's tripwire list (see the module docstring).
if (!NEGATIVE_CONTROLS_ONLY) {
  checkBody('wiring: the sweep is invoked once, only inside the normal-exit fall-through, and its count reaches that block\'s notice', () => {
    const { from, to, block } = fallThroughWindow()
    const sweeps = sweepInvocations()
    assert.equal(sweeps.length, 1,
      `exactly one sweep invocation in the module (found ${sweeps.length}: ${sweeps.map(site => `@${site} ${pluginSource.slice(site, site + 30)}`).join(' | ')})`)
    const sweepAt = sweeps[0] as number
    assert.ok(sweepAt > from && sweepAt < to,
      `the only sweep invocation is at ${sweepAt}, OUTSIDE the fall-through block [${from}, ${to}): a crash / handoff / restart branch must never clean up (F-12)`)
    const notices = noticeInvocations()
    assert.equal(notices.length, 1,
      `only the fall-through composes a notice (found ${notices.length}: ${notices.map(site => `@${site} ${pluginSource.slice(site, site + 30)}`).join(' | ')})`)
    const noticeAt = notices[0] as number
    assert.ok(noticeAt > sweepAt && noticeAt < to,
      `the notice must be composed inside the block and after the round (sweep@${sweepAt} notice@${noticeAt} block@[${from}, ${to})): DESIGN D6`)
    assert.match(block, /composeExitNotice\(\s*hint\s*,\s*swept\?\.deleted\.length\s*\?\?\s*0\s*\)/u,
      'the notice argument is that round\'s own count (this pattern tolerates line breaks and spacing: F-10)')
  })
  checkBody('wiring: the branch feeds the sweep the bound session, the live set and the listing cache', () => {
    const { block } = fallThroughWindow()
    const facts: readonly (readonly [string, RegExp])[] = [
      ['currentSessionId', /currentSessionId:\s*\(\)\s*=>\s*channel\.agentId/u],
      ['liveSessionIds', /liveSessionIds:\s*\(\)\s*=>\s*liveExitSessionIds\(\s*ctx\s*,\s*channel\.agentId\s*\)/u],
      ['listedSessions', /listedSessions:\s*\(\)\s*=>\s*readExitListing\(\s*channel\s*\)/u],
    ]
    for (const [fact, pattern] of facts) {
      assert.match(block, pattern,
        `the ${fact} fact must be wired to the live process (an empty set / an undefined bound id widens the delete surface)`)
    }
  })
  checkBody('wiring: finishExit stays sweep-free, so its five other callers cannot inherit the cleanup', () => {
    const body = window(at('export async function finishExit('), at('function readInkShutdownState('), 'the finishExit body')
    assert.ok(!body.includes('sweepUnspoken'), 'finishExit is called from five other branches; the sweep must not ride along')
  })
}

// ── 8. "no round" is classified, not silent (T-FIX-02's exitListingGap) ────
if (!NEGATIVE_CONTROLS_ONLY) {
  const GAP_SHAPES: readonly (readonly [string, unknown, string])[] = [
    ['a host line whose channel has no listing cache', {}, 'no source'],
    ['a cache that has never listed', { cachedSessions: () => undefined }, 'no listing'],
    ['a cache that throws while being read', { cachedSessions: () => { throw new Error('cache boom') } }, 'read failed'],
    ['a listing that is readable after all', { cachedSessions: () => [] }, 'listed'],
  ]

  checkBody('exit gap: the four worlds read differently, and a readable listing is not a gap', () => {
    const seen = new Set<string>()
    for (const [label, channel, expected] of GAP_SHAPES) {
      const gap = exitListingGap(channel as never)
      assert.equal(gap, expected, label)
      seen.add(gap)
    }
    assert.equal(seen.size, 4, 'a constant classifier would collapse two of these')
  })
  checkBody('exit gap: "no round" and its classification agree on the same channel', () => {
    ensureDirs()
    removed.length = 0
    const swept = sweepUnspokenOnExit(exitInput({ listedSessions: () => undefined }))
    assert.equal(swept, undefined, 'the round cannot run without a listing')
    assert.equal(exitListingGap({ cachedSessions: () => undefined } as never), 'no listing', 'and the reason names the world it was in')
    assert.equal(exitListingGap({} as never), 'no source', 'a host without the seam is a different world from a host with an empty one')
  })
  // The debug line itself is inside the branch closure, so it can only be
  // anchored structurally: the `else` of `swept !== undefined` must interpolate
  // the classifier, i.e. "no round" is never reported as a generic nothing.
  checkBody('exit gap: the branch reports the classification when the round did not run', () => {
    const { block } = fallThroughWindow()
    assert.match(block, /if\s*\(\s*swept\s*!==\s*undefined\s*\)/u, 'the branch keeps the round result as the discriminator')
    assert.match(block, /ctx\.logger\.debug\([^)]*swept\.deleted\.length/u, 'a round that ran reports its own count')
    assert.match(block, /exitListingGap\(\s*channel\s*\)/u, 'a round that did not run names the reason through exitListingGap (F-13)')
  })
}

// ── 9. a candidate's own header decides delegation (T-FIX-02's seam) ───────
if (!NEGATIVE_CONTROLS_ONLY) {
  writeRealLog('header-sub', { origin: 'subagent', delegationDepth: 1 })
  writeRealLog('header-deep', { delegationDepth: 2 })
  writeRealLog('header-plain', { origin: 'root', delegationDepth: 0 })
  const headerIndex = new Map(['header-sub', 'header-deep', 'header-plain'].map(id => [id, { derived: { hasPrompt: false } }]))
  const headerDeps = (): UnspokenSweepDeps => ({
    readIndex: () => headerIndex,
    // The event layer proves nothing here on purpose: only the header can spare,
    // and `readSessionHeader` is deliberately NOT injected — the shipping reader
    // is what the exit path uses.
    readLog: () => ({ events: [], complete: true }),
    currentSessionId: () => undefined,
    liveSessionIds: () => new Set<string>(),
    isSubagentOrDescendant: () => false,
  })

  checkBody('header reader: the first physical frame is what it reads, and only claims what is there', () => {
    assert.equal(readSessionHeaderFromLog('header-sub')?.origin, 'subagent')
    assert.equal(readSessionHeaderFromLog('header-deep')?.delegationDepth, 2)
    assert.equal(readSessionHeaderFromLog('header-plain')?.origin, 'root')
    assert.equal(readSessionHeaderFromLog('no-such-log-at-all'), undefined, 'no log is "unknown", never "root"')
  })
  checkBody('header verdict: origin:subagent spares a candidate no listing ever saw', () => {
    const result = collectUnspokenSessionIds(headerDeps())
    assert.equal(reasonOf(result, 'header-sub'), 'subagent',
      `a delegated run created after boot must be spared (got ${String(reasonOf(result, 'header-sub'))})`)
    assert.ok(!result.ids.includes('header-sub'))
  })
  checkBody('header verdict: a nonzero delegationDepth is delegation too (upstream keeps it optional)', () => {
    const result = collectUnspokenSessionIds(headerDeps())
    assert.equal(reasonOf(result, 'header-deep'), 'subagent')
    assert.ok(!result.ids.includes('header-deep'))
  })
  checkBody('header verdict: a header with no delegation mark is NOT spared by this rule', () => {
    const result = collectUnspokenSessionIds(headerDeps())
    assert.ok(result.ids.includes('header-plain'), 'the header only ever ADDS protection; a root header leaves the candidate alone')
  })
}

// ── 10. layer ③'s live set is driven for real (F-06) ───────────────────────
if (!NEGATIVE_CONTROLS_ONLY) {
  /** A ctx whose only service is `agents` — the duck-typed roster the live set reads. */
  const rosterCtx = (agents: unknown): never => ({ get: (name: string) => name === 'agents' ? agents : undefined }) as never
  const idsOf = (ids: ReadonlySet<string>): string[] => [...ids].sort()

  checkBody('live set: the bound session and every ordinary agent are kept, sub-agent runs are not', () => {
    const ids = liveExitSessionIds(rosterCtx({
      list: () => [
        { id: 'bg-1', session: { header: {} } },
        { id: 'bg-2', session: { header: { origin: 'fork' } } },
        { id: 'sub-1', session: { header: { origin: 'subagent' } } },
        { id: '', session: { header: {} } },
      ],
    }), 'cur')
    assert.deepEqual(idsOf(ids), ['bg-1', 'bg-2', 'cur'],
      'a sub-agent run is layer ③\'s OTHER half (the header/lineage rule), never a live mount; an empty id claims nothing')
  })
  checkBody('live set: a composition with no agents service degrades to exactly the bound session (B-6)', () => {
    assert.deepEqual(idsOf(liveExitSessionIds(rosterCtx(undefined), 'cur')), ['cur'],
      'the documented degradation: fewer ids than possible, never a guessed one')
    assert.deepEqual(idsOf(liveExitSessionIds(rosterCtx(undefined), undefined)), [],
      'and to nothing when no session is bound either')
  })
  checkBody('live set: a registry that lists nothing adds nothing', () => {
    assert.deepEqual(idsOf(liveExitSessionIds(rosterCtx({ list: () => [] }), 'cur')), ['cur'])
  })
}

// ── 11. who counts as a person: the two shipped readers must agree (F-11) ──
if (!NEGATIVE_CONTROLS_ONLY) {
  checkBody('human prompt: the sweep and the digest call every sample the same way (F-11 / B-1)', assertHumanPromptParity)
}

// ── 12. the ledger is a throwaway one, and it is really consumed (B-12) ────
if (!NEGATIVE_CONTROLS_ONLY) {
  const ledgerFile = join(DATA_DIR, 'session-mounts.json')

  checkBody('isolation: the module-level DATA_DIR is the throwaway home, not the operator\'s', () => {
    assert.ok(DATA_DIR.startsWith(root),
      `DATA_DIR must be captured AFTER the HOME override (got ${DATA_DIR}; the operator's is ${join(operatorHome, '.dsh-tui')}): ` +
      'static imports here would make every fixture read the real ledger (B-12)')
    assert.notEqual(DATA_DIR, join(operatorHome, '.dsh-tui'), 'the operator\'s ledger directory must never be the one under test')
  })
  checkBody('isolation: the fixture starts with no ledger at all, and an absent one is not "no round"', () => {
    assert.equal(existsSync(ledgerFile), false, 'nothing has published a mount yet, so there is no ledger to inherit')
    assert.equal(String(freshCleanExit(sweepWithFixture)?.deleted.join(',')), 'shell-a,shell-b',
      'an absent ledger means "no foreign holder", so the round still runs')
  })
  checkBody('isolation: a foreign holder written to the throwaway ledger is what the round obeys', () => {
    ensureDirs()
    removed.length = 0
    // A live pid that is not ours: the parent process of this run.
    const foreignPid = process.ppid
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(ledgerFile, JSON.stringify({
      version: 1,
      owners: [{ pid: foreignPid, startedAt: 1, sessionIds: ['shell-a'] }],
    }))
    const stat = statSync(ledgerFile)
    // The fixture sweep, so the store seams stay faked — and the process facts
    // (`occupiedElsewhere`) are the ones `sweepUnspokenOnExit` itself builds, so
    // this is the shipping ledger read.
    const swept = sweepWithFixture(exitInput())
    assert.equal(reasonOf(swept ?? { deleted: [], skipped: [] }, 'shell-a'), 'held-elsewhere',
      'the round must read THIS ledger: a foreign live holder spares its session and reports why')
    assert.ok(existsSync(dirOf('shell-a')), 'and the held shell is still on disk')
    assert.equal(String(swept?.deleted.join(',')), 'shell-b', 'while the unheld shell is swept as usual')
    assert.equal(statSync(ledgerFile).mtimeMs, stat.mtimeMs, 'the read is read-only: the ledger itself is untouched')
    rmSync(ledgerFile, { force: true })
  })
}

// ── negative controls (L-044): the assertion bodies above, driven red ──────

interface ControlGroup {
  readonly label: string
  readonly controls: readonly { readonly name: string, readonly run: () => void, readonly why: string, readonly marker: string }[]
}

const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    label: 'G1 composeExitNotice fed a stub (T05 ③)',
    controls: [
      {
        name: 'a hint-only composer must break the count-line assertion',
        run: () => assertNoticeCountLine(hint => hint),
        why: 'the pre-fix composer never appended a count line',
        marker: 'dictionary entry',
      },
      {
        name: 'a hard-coded English line must break the localized-notice assertion',
        run: () => assertNoticeLocalized((hint, cleaned) => cleaned <= 0 ? hint : `${hint ?? ''}\nCleaned ${cleaned} session(s)`),
        why: 'a literal cannot follow the dictionary, and the zh/en notices would be identical',
        marker: 'localized and not hard-coded',
      },
    ],
  },
  {
    label: 'G2 readExitListing fed a wrong kind mapping (T05 ⑤)',
    controls: [
      {
        name: 'the pre-fix mapping must break the unknown-kind assertion',
        run: () => assertListingUnknownKindDelegated(preFixListing),
        why: 'the pre-fix rule marked only an exact `kind === "subagent"` as delegated',
        marker: 'does not know must count as delegated',
      },
      {
        name: 'a mapping that drops the parent link must break the fork assertion',
        run: () => assertListingForkKeepsParent(parentlessListing),
        why: 'the descendant closure walks `parent`, so losing it silently narrows the spared set',
        marker: 'parent link is what the descendant closure walks',
      },
    ],
  },
  {
    label: 'G3 sweepUnspokenOnExit fed a blind / brittle listing (T05 ①)',
    controls: [
      {
        name: 'an empty listing must let a delegated run be deleted',
        run: () => assertDelegatedRunSurvives(sweepFixtureRewriting(input => ({ ...input, listedSessions: () => [] }))),
        why: 'with no lineage the delegated run is just another shell — the shape this suite exists for',
        marker: 'delegated run must survive',
      },
      {
        name: 'a throwing listing must cost the round, and the partition assertion must notice',
        run: () => assertCleanExitDeletes(sweepFixtureRewriting(input => ({
          ...input,
          listedSessions: () => { throw new Error('listing boom') },
        }))),
        why: 'an unreadable listing means no round at all, so the shipped clean-exit partition cannot hold',
        marker: 'must delete the two never-spoken shells',
      },
      {
        name: 'a runner without the fail-soft wrapper must let a hostile dependency escape',
        run: () => assertFailSoft(brittleSweep),
        why: 'the shipping entry point wraps the whole round; removing that wrapper is what the fail-soft assertion catches',
        marker: 'no hostile dependency may escape',
      },
    ],
  },
  {
    label: 'G4 the guarded source window (F-07)',
    controls: [
      {
        name: 'an inverted window must be refused instead of read as empty',
        run: () => { window(10, 5, 'a deliberately inverted window') },
        why: 'a bare `indexOf` + `slice` reads an empty string and makes the wiring assertion vacuously green',
        marker: 'empty or inverted',
      },
    ],
  },
  {
    label: 'G5 the third human-prompt rule (B-1) through the parity assertion (F-11)',
    controls: [
      {
        name: 'the session-lineage rule must disagree on the source-less sample',
        run: () => {
          for (const [label, one] of SAMPLE_EVENTS) {
            assert.equal(lineageSaysHuman(one), digestSaysHuman(one, 0), label)
          }
        },
        why: 'a missing `source` is human to the sweep and the digest and NOT human to session-lineage (the B-1 divergence)',
        marker: 'NO source',
      },
    ],
  },
]

/** Run every control and require it to go red on the assertion named by `marker`. */
const runNegativeControls = (): void => {
  let total = 0
  let red = 0
  for (const group of CONTROL_GROUPS) {
    for (const control of group.controls) {
      total += 1
      const before = failures
      expectRed(`${group.label}: ${control.name}`, control.run, control.why, control.marker)
      if (failures === before) red += 1
    }
  }
  controlsReading = `negative-controls: ${red}/${total} controls went red across ${CONTROL_GROUPS.length} groups`
  if (red !== total) process.exitCode = 1
}

runNegativeControls()
report()
