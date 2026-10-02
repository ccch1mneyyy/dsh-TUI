/**
 * verify-session-supervisor — the unified session screen (issue #879).
 *
 * `/resume`, `/agentview` and `/home` are one screen over one runtime now, and
 * the two properties worth a regression are the ones that used to be spread
 * across three implementations and drifted:
 *
 *   1. it is genuinely ONE surface — a workspace rail, the sessions of the
 *      selected workspace, and a live-state cell on every row, with the
 *      current session marked;
 *   2. a session held by ANOTHER TUI terminal is shown as occupied and cannot
 *      be entered: clicking it must NOT reach the channel's resume path, which
 *      is what would interleave two processes into one append-only log;
 *   3. the rail is the ledger and nothing else — no `+` row, because a
 *      workspace joins by being the directory a terminal started in (the
 *      startup attach), not by an in-screen picker.
 *
 * Plus the pure behaviours the screen leans on: the search predicate, and the
 * rail's window math.
 *
 * It also pins the snapshot-then-refresh first paint (issue #987): a mount
 * paints its channel's previous listing instead of a loading placeholder, and
 * the fresh listing corrects it wholesale when it lands. A rejected listing
 * keeps the previous snapshot beside its error notice — only a successful
 * listing ever writes the snapshot, and only the newest reload may (a listing
 * that lands late must not repaint over a newer one).
 *
 * The snapshot is keyed by the CHANNEL, so every case below owns one: a case
 * that wants a carried-over first frame mounts the SAME stub twice, and a case
 * that wants a cold one builds a fresh stub. No case inherits another's rows,
 * and none of them depends on where it sits in this file.
 *
 * A restart is the case that paragraph cannot cover: the in-memory slot is
 * gone, so the first frame comes from the channel's on-disk cache
 * (`cachedSessions()`), synchronously, before the listing promise can answer.
 * Those cases read the PAINTED stream (`saw`), because a placeholder that
 * lived for a single frame is overwritten in the viewport and would read as a
 * pass there. The same section pins what a cache may NOT do: an empty cached
 * listing paints the empty state instead of the placeholder, a rejected
 * listing leaves the painted rows (and the cache) alone, and a superseded
 * answer never rolls the screen back. Before any cache exists the channel can
 * hand over a partial enumeration (the second callback of `listSessions`) so
 * a cold scan stops showing nothing, and a partial answer from a superseded
 * call must not repaint.
 *
 * The source tabs (other coding agents' conversations) are pinned too: the
 * strip renders only when a source has data and degrades by width (subtitle
 * first, then trailing tabs into `+N`, never the active one); a click or
 * Tab / Shift+Tab switches source and clears the query; a source tab groups
 * by directory, filters by title and cwd, and Enter imports then opens the
 * deterministic id — a second Enter opens the existing copy; a conversation
 * whose directory is gone reports it and opens nothing.
 *
 * Renders the real `SessionSupervisor` into an in-memory terminal with a stub
 * channel, then drives it with real stdin bytes (SGR mouse reports).
 *
 * Run: node --import tsx/esm scripts/verify-session-supervisor.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import fakeHome from './lib/fake-home.mjs'
import { findText, settled, sleep, viewportLines, writeParsed } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [
  { render, ThemeProvider, AlternateScreen },
  { SessionSupervisor, sessionMatchesQuery, railWindowTop },
  { layoutSourceTabs },
  { groupForeignRows, foreignRowMatchesQuery, FOREIGN_UNKNOWN_GROUP },
  { wrapPathWidth },
  // The REAL persistent listing cache, so one case can put actual bytes under
  // this run's fake home and prove the screen paints them.
  { beginListingSnapshot, readListingSnapshot },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/SessionSupervisor.js'),
  import('../src/components/sessions/SourceTabs.js'),
  import('../src/screens/sessionSupervisor/useForeignSessions.js'),
  import('../src/sessions/format.js'),
  import('../src/dsh-adapter/sessions/snapshot.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 120
const ROWS = 28
/** Workspaces in the long-rail case: comfortably more than the rail can show. */
const RAIL_ENTRIES = 24
/** The directory an unregistered-only listing falls back to; never created. */
const GHOST_DIR = join(tmpdir(), 'dsh-tui-supervisor-ghost')

class FakeStdout extends Writable {
  isTTY = true
  /**
   * Every chunk ever handed to the terminal, in order — what was PAINTED, not
   * what the composed screen happens to show now. A single frame of
   * placeholder text is overwritten by the next frame and is therefore
   * invisible in the viewport, so "the cache was never awaited" can only be
   * asserted here.
   */
  readonly painted: string[] = []
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.painted.push(String(chunk))
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-supervisor-'))
const alphaDir = join(sandbox, 'alpha')
mkdirSync(alphaDir)
// A SECOND workspace that sorts BEFORE the terminal's own directory. It exists
// so "the rail opens on the workspace this terminal is in" is provable: a
// first-entry default would select Beta and the pane header would name it.
const betaDir = join(sandbox, 'beta')
mkdirSync(betaDir)

const now = Date.now()
const session = (over: Record<string, unknown>): never => ({
  id: 's',
  kind: { kind: 'root' },
  title: { text: 'a session', source: 'prompt' },
  cwd: alphaDir,
  createdAt: now - 60_000,
  updatedAt: now - 30_000,
  bytes: 2048,
  hasPrompt: true,
  agentPreset: 'standard',
  model: 'deepseek-flash',
  label: undefined,
  branch: 'main',
  childCount: 0,
  ...over,
}) as never

const registry = [
  // Beta first, on purpose: the ledger's order must not decide the selection.
  { id: 'w-beta', path: betaDir, title: 'Beta', present: true, sessionCount: 0 },
  { id: 'w-alpha', path: alphaDir, title: 'Alpha', present: true, sessionCount: 0 },
  // A workspace that exists ONLY in the ledger: no session ever ran in it. It
  // is the control for "sessions are matched by directory", and it makes the
  // registry longer than the set of directories the listing knows about.
  { id: 'w-empty', path: join(sandbox, 'gamma'), title: 'Gamma', present: true, sessionCount: 0 },
]
const sessions = [
  session({ id: 'free-one', title: { text: 'free session', source: 'prompt' }, updatedAt: now - 1_000 }),
  session({ id: 'held-one', title: { text: 'held session', source: 'prompt' }, updatedAt: now - 2_000 }),
  session({ id: 'live-one', title: { text: 'live session', source: 'prompt' }, updatedAt: now - 3_000 }),
]

/**
 * A pid that is certainly alive so the ledger's liveness witness passes; the
 * screen must only report it. `process.ppid` is a running process on every
 * platform (pid 1 is not guaranteed to exist on Windows).
 */
const FOREIGN_PID = process.ppid
/** The session another terminal has mounted, seeded into the REAL ledger. */
const HELD_SESSION_ID = 'held-one'

// Seed the cross-process ledger the screen reads for itself. It is a FILE in
// `~/.dsh-tui` (fake-home pinned HOME before any lib import), so the regression
// proves the live path — the screen reads the ledger on its own pulse — rather
// than an injected occupancy callback that could hide a stale-snapshot bug.
{
  const dataDir = join(fakeHome, '.dsh-tui')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'session-mounts.json'),
    JSON.stringify({
      version: 1,
      owners: [{
        pid: FOREIGN_PID,
        startedAt: Date.now(),
        sessionIds: [HELD_SESSION_ID],
      }],
    }, null, 2),
    'utf8',
  )
}

const calls: string[] = []
const channel = {
  version: 0,
  cwd: alphaDir,
  working: false,
  agentId: 'live-one',
  listWorkspaceRegistry: async () => registry,
  listSessions: async () => sessions,
  // Deliberately NO `cachedSessions`: this fixture is the older host, whose
  // rows live in the hook's in-memory slot — the path the main body below
  // drives with real keystrokes and mouse reports. A stub that answered
  // `undefined` from the method would clear that slot on every mount.
  resumeTo: async (id: string) => {
    calls.push(`resumeTo:${id}`)
    return { ok: true }
  },
  switchWorkspace: async (target: { cwd: string }) => {
    calls.push(`switchWorkspace:${target.cwd}`)
    return true
  },
  resolveWorkspace: async (reference: string) => ({ cwd: reference, uri: reference, label: reference, kind: 'local', badge: 'LOCAL' }),
  stopBackgroundAgent: async (id: string) => {
    calls.push(`stop:${id}`)
    return true
  },
  notify: (text: string) => { calls.push(`notify:${text}`) },
  subscribe: () => () => {},
} as never

const liveState = {
  'live-one': { status: 'working' as const, live: true, current: true, summary: 'doing work' },
}

/**
 * The persistent listing cache a stub channel reads through
 * `cachedSessions()`.
 *
 * A mutable cell rather than a plain array because it stands in for the FILE:
 * two stubs sharing one cell are two processes over the same store, and a stub
 * that lists successfully writes the cell the way the channel writes the file.
 * `undefined` rows model an install that has never written one.
 */
interface CacheCell {
  rows: readonly unknown[] | undefined
}

/** A cache cell holding `rows`, as a previous process left it. */
function cacheCell(rows?: readonly unknown[]): CacheCell {
  return { rows }
}

/**
 * A cell that reads through to a REAL snapshot file instead of holding rows.
 *
 * Every access re-reads, so a stub built over it is scoped by what is on disk —
 * never by a previous mount of this screen. The setter is inert on purpose: the
 * stub models a channel write by assigning the cell, and for a real file the
 * writer is `beginListingSnapshot`, not the model.
 * @param read - Reads the rows a fresh channel would be scoped by.
 * @returns The cell a stub's `cachedSessions()` answers from.
 */
function diskCacheCell(read: () => readonly unknown[] | undefined): CacheCell {
  return {
    get rows(): readonly unknown[] | undefined { return read() },
    set rows(_rows: readonly unknown[] | undefined) { /* the file owns the rows; see above */ },
  }
}

/** What one stub channel answers with, and how its reads fail. */
interface StubChannelConfig {
  readonly registry: readonly unknown[]
  readonly cwd: string
  /** Simulate a successful host registry removal without touching user data. */
  readonly removeWorkspace?: (path: string) => boolean
  /** Rows the listing answers with; the shared stub listing by default. */
  readonly sessions?: readonly unknown[]
  /** True when the registry read itself fails (service missing / throwing). */
  readonly registryRejects?: boolean
  readonly registryAbsent?: boolean
  /** What the host's open path reports; defaults to a successful mount. */
  readonly openResult?: { ok: true } | { ok: false; reason: 'failed'; error: string } | { ok: false; reason: 'cancelled' }
  /** Terminal width for this screen; {@link COLS} by default. */
  readonly cols?: number
  /**
   * The persistent cache this channel reads.
   *
   * Omitting it omits the `cachedSessions` METHOD as well, and that is not a
   * detail of the fixture: the hook re-scopes its in-memory slot from that
   * read on EVERY mount, so a stub that had the method and answered
   * `undefined` would clear the slot the reopen cases carry their rows in.
   * A host older than the cache read is exactly a channel without it.
   */
  readonly cache?: CacheCell
  /** Foreign sources the channel's facade answers with; absent = no facade. */
  readonly foreign?: ForeignStubConfig
}

/** What the stub's foreign-session facade answers with. */
interface ForeignStubConfig {
  readonly sources: readonly { agentId: string; label: string }[]
  readonly rows: Readonly<Record<string, readonly ForeignRowFixture[]>>
  /** Held unresolved to keep an import in flight (the import-after-close case). */
  importGate?: Promise<void>
}

interface ForeignRowFixture {
  readonly agentId: string
  readonly key: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: number
}

/** How the NEXT listing call behaves; a case swaps it between mounts. */
interface ListingPlan {
  /** Held unresolved to keep the listing in flight (the snapshot cases). */
  readonly defer?: Promise<void>
  /** Reject instead of answering — a channel listing rejection. */
  readonly reject?: boolean
  /** Rows to answer with; the shared stub listing by default. */
  readonly sessions?: readonly unknown[]
}

/**
 * One stub channel: its own identity, its own call log, its own listing plan.
 *
 * The screen's snapshot is keyed by the channel, so a case controls its first
 * frame by building a fresh channel (a cold screen) or by mounting the same
 * one twice (rows carried over) — never by another case's leftovers.
 */
interface StubChannel {
  /** Passed as the screen's channel; `never` so the JSX site needs no cast. */
  channel: never
  readonly calls: string[]
  /** Behaviour of the next listing call. */
  plan: ListingPlan
  /** Listings that finished, resolved or rejected: the deterministic "the
   *  held-back answer really landed" signal, instead of a fixed sleep. */
  landed: number
  readonly config: StubChannelConfig
  enrich?: (row: never) => void
  /** The progress callback of the newest listing call, when the screen asked
   *  for one (`listSessions(onEnriched, onPartial)`). */
  onPartial?: (rows: readonly unknown[]) => void
}

/** Build one stub channel over the shared fixtures. */
function makeChannel(config: StubChannelConfig): StubChannel {
  const calls: string[] = []
  const stub: StubChannel = { channel: undefined as never, calls, plan: {}, landed: 0, config }
  /**
   * This stub's own listing generation, mirroring the real channel: the
   * backend keeps exactly this guard (`channel/session-metadata.ts`), so a
   * superseded listing never publishes to the cache it writes either.
   */
  let listingGeneration = 0
  stub.channel = {
    version: 0,
    cwd: config.cwd,
    working: false,
    agentId: 'live-one',
    ...(config.registryAbsent === true ? {} : {
      listWorkspaceRegistry: async () => {
        if (config.registryRejects === true) throw new Error('workspace service unavailable')
        return config.registry
      },
    }),
    ...(config.cache === undefined ? {} : {
      // Synchronous by contract: the screen paints its first frame from this,
      // before any listing promise can resolve. See StubChannelConfig.cache
      // for why the method exists only when a cache was configured.
      cachedSessions: () => config.cache?.rows,
    }),
    listSessions: async (
      onEnriched?: (row: never) => void,
      onPartial?: (rows: readonly unknown[]) => void,
    ) => {
      const generation = ++listingGeneration
      stub.enrich = onEnriched
      stub.onPartial = onPartial
      // Read per call, not per channel: a case swaps the plan between mounts.
      const plan = stub.plan
      if (plan.reject === true) {
        stub.landed++
        throw new Error('session listing rejected')
      }
      if (plan.defer !== undefined) await plan.defer
      stub.landed++
      const answered = plan.sessions ?? config.sessions ?? sessions
      // Only a successful listing writes the persistent cache, and only while
      // it is still the newest one — a late answer is not the store's state.
      if (config.cache !== undefined && generation === listingGeneration) config.cache.rows = answered
      return answered
    },
    resumeTo: async (id: string) => {
      calls.push(`resumeTo:${id}`)
      return { ok: true }
    },
    ...(config.foreign === undefined ? {} : foreignFacade(config.foreign, calls)),
    switchWorkspace: async () => true,
    resolveWorkspace: async (reference: string) => {
      calls.push(`resolveWorkspace:${reference}`)
      return { cwd: reference, uri: reference, label: reference, kind: 'local', badge: 'LOCAL' }
    },
    stopBackgroundAgent: async () => true,
    removeWorkspace: async (path: string) => {
      calls.push(`removeWorkspace:${path}`)
      return config.removeWorkspace?.(path) ?? false
    },
    notify: () => {},
    subscribe: () => () => {},
  } as never
  return stub
}

/**
 * The foreign-session facade over fixtures. Import mimics the real importer's
 * contract: a missing directory refuses, the first import creates, a repeat
 * finds the copy; the id is derived from the source key, never random.
 */
function foreignFacade(config: ForeignStubConfig, calls: string[]): Record<string, unknown> {
  const imported = new Set<string>()
  const rowsOf = (agentId: string): readonly ForeignRowFixture[] => config.rows[agentId] ?? []
  return {
    listForeignSources: async () => {
      calls.push('probe')
      return config.sources
    },
    // Rows stream as the scan finds them, then the whole list resolves.
    listForeignSessions: async (agentId: string, onRow?: (row: ForeignRowFixture) => void) => {
      calls.push(`scan:${agentId}`)
      for (const row of rowsOf(agentId)) onRow?.(row)
      return rowsOf(agentId)
    },
    importForeignSession: async (agentId: string, key: string) => {
      calls.push(`import:${agentId}:${key}`)
      if (config.importGate !== undefined) await config.importGate
      const row = rowsOf(agentId).find(candidate => candidate.key === key)
      if (row === undefined) return { kind: 'failed', reason: 'missing' }
      if (row.cwd !== '' && !existsSync(row.cwd)) return { kind: 'cwd-missing', cwd: row.cwd }
      const sessionId = `foreign-${row.key}`
      const created = !imported.has(sessionId)
      imported.add(sessionId)
      calls.push(`${created ? 'created' : 'existing'}:${sessionId}`)
      return { kind: 'ready', sessionId, created }
    },
  }
}

/** A mounted screen over one stub channel. */
interface SupervisorScreen {
  write: (data: string) => void
  lines: () => string[]
  /** One real SGR click on the first occurrence of `needle`. */
  click: (needle: string) => Promise<void>
  /** One real SGR right click on the first occurrence of `needle`. */
  rightClick: (needle: string) => Promise<void>
  /**
   * True when `text` was written to the terminal at ANY point, even when a
   * later frame erased it again. `lines()` reads the final composition, so a
   * placeholder that lived for one frame is invisible there.
   */
  saw: (text: string) => boolean
  calls: readonly string[]
  close: () => void
}

/**
 * One screen over one stub channel, on its own terminal: each case's frame
 * stays independent (a shared window would carry the previous case's rows into
 * the next), including the cases whose assertions need a different registry
 * (an empty one, and one longer than the rail can show).
 *
 * Mounting the SAME stub twice is what a reopen of one channel looks like.
 */
async function mountSupervisor(target: StubChannel): Promise<SupervisorScreen> {
  const screen = new XTerm({ cols: target.config.cols ?? COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(screen)
  const input = new FakeStdin()
  const app = await render(
    <ThemeProvider theme="dark">
      <AlternateScreen>
        <SessionSupervisor
          channel={target.channel}
          home={sandbox}
          onClose={() => {}}
          onOpenSession={async (id) => {
            // Same path Chat.tsx wires: the screen hands the row's id to the
            // channel, which is where "did Enter open the RIGHT row" is
            // observable.
            await (target.channel as unknown as { resumeTo(id: string): Promise<{ ok: boolean }> }).resumeTo(id)
            return target.config.openResult ?? { ok: true }
          }}
          onNewSession={async () => true}
          onStopSession={async () => true}
          approval={null}
          onApprove={() => {}}
          liveStateOf={(id) => liveState[id as keyof typeof liveState]}
        />
      </AlternateScreen>
    </ThemeProvider>,
    {
      stdin: input as never,
      stdout: out as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return {
    write: (data: string) => { input.write(data) },
    lines: () => viewportLines(screen),
    click: async (needle: string) => {
      await settled(() => findText(screen, needle) !== null)
      const found = findText(screen, needle)
      if (found === null) throw new Error(`text not found: ${needle}`)
      input.write(`\u001b[<0;${found.col + 1};${found.row + 1}M\u001b[<0;${found.col + 1};${found.row + 1}m`)
      await sleep(120) // 固定窗:pacing 输入泵需要一轮事件循环把点击交给解析器
    },
    rightClick: async (needle: string) => {
      await settled(() => findText(screen, needle) !== null)
      const found = findText(screen, needle)
      if (found === null) throw new Error(`text not found: ${needle}`)
      input.write(`\u001b[<2;${found.col + 1};${found.row + 1}M\u001b[<2;${found.col + 1};${found.row + 1}m`)
      await sleep(120) // 固定窗:pacing 输入泵需要一轮事件循环把右键交给解析器
    },
    saw: (text: string) => out.painted.join('').includes(text),
    calls: target.calls,
    close: () => { app.unmount() },
  }
}

/** A screen over a channel of its own, for the cases that mount once. */
async function openSupervisor(config: StubChannelConfig): Promise<SupervisorScreen> {
  return mountSupervisor(makeChannel(config))
}

// ── snapshot-then-refresh (issue #987) ─────────────────────────────────────
//
// What a mount paints BEFORE the fresh listing lands. The snapshot lives on
// the channel, so every case below owns one: a case that wants rows carried
// over mounts the SAME stub twice, and a case that wants a cold screen builds
// a fresh stub. Nothing here depends on the order of these blocks.

/** The loading placeholder the pane shows while the listing is in flight (i18n en). */
const LOADING_PLACEHOLDER = 'Loading sessions…'

/** A gate this test opens by hand, to hold one listing in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** The same listing with one title renamed on disk (same id): a carried-over
 *  snapshot shows the OLD title, the fresh listing corrects it. */
const renamedSessions = [
  session({ id: 'free-one', title: { text: 'renamed on disk', source: 'prompt' }, updatedAt: now - 1_000 }),
  sessions[1],
  sessions[2],
]

console.log('snapshot-then-refresh:')
{
  // Cold start on a fresh channel: no snapshot exists yet, so the screen keeps
  // today's loading path — the placeholder shows and no session row is invented.
  const target = makeChannel({ registry, cwd: alphaDir })
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'cold open shows the loading placeholder before the listing lands',
    await settled(() => app.lines().join('\n').includes(LOADING_PLACEHOLDER)),
    app.lines().join('\n'),
  )
  check(
    'cold open shows no session row before the listing lands',
    !app.lines().join('\n').includes('free session'),
    app.lines().join('\n'),
  )
  gate.resolve()
  check(
    'the landing listing replaces the placeholder with real rows',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('free session') && !shown.includes(LOADING_PLACEHOLDER)
    }),
    app.lines().join('\n'),
  )
  app.close()
}
{
  // Snapshot first paint: the SAME channel reopened while its listing is held
  // back paints the previous listing's rows immediately — a non-empty snapshot
  // skips the placeholder — and the fresh listing corrects them wholesale when
  // it lands.
  const target = makeChannel({ registry, cwd: alphaDir })
  const first = await mountSupervisor(target)
  await settled(() => first.lines().join('\n').includes('free session'))
  first.close()

  const gate = deferred()
  target.plan = { defer: gate.promise, sessions: renamedSessions }
  const app = await mountSupervisor(target)
  check(
    'a non-empty snapshot paints its rows without the loading placeholder',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('free session') && !shown.includes(LOADING_PLACEHOLDER)
    }),
    app.lines().join('\n'),
  )
  gate.resolve()
  check(
    'the fresh listing corrects a stale snapshot title',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('renamed on disk') && !shown.includes('free session')
    }),
    app.lines().join('\n'),
  )
  app.close()
}
{
  // A REJECTED channel listing keeps the previous snapshot: the stale rows stay
  // beside the error notice instead of dropping to an empty list, and the
  // rejection never writes the snapshot — the next mount still paints from it
  // while its own listing is in flight. Only a successful listing may write.
  //
  // Rejection here is the channel's own (`listSessions` itself throws), which
  // is what the hook can observe; a backend enumeration failure is folded into
  // an empty list inside `listSummaries` and reaches this screen as success.
  const target = makeChannel({ registry, cwd: alphaDir })
  const first = await mountSupervisor(target)
  await settled(() => first.lines().join('\n').includes('free session'))
  first.close()

  target.plan = { reject: true }
  const app = await mountSupervisor(target)
  check(
    'a rejected channel listing keeps the previous snapshot rows beside the error notice',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('free session') && shown.includes('Failed to load sessions')
        && !shown.includes(LOADING_PLACEHOLDER)
    }),
    app.lines().join('\n'),
  )
  app.close()

  const gate = deferred()
  target.plan = { defer: gate.promise }
  const next = await mountSupervisor(target)
  check(
    'the rejected listing never wrote the snapshot (the next mount paints it)',
    await settled(() => {
      const shown = next.lines().join('\n')
      return shown.includes('free session') && !shown.includes(LOADING_PLACEHOLDER)
    }),
    next.lines().join('\n'),
  )
  gate.resolve()
  await settled(() => target.landed >= 3, { timeoutMs: 4_000 })
  next.close()
}
{
  // The newest reload wins. `Ctrl+L` re-runs the listing while a slower one is
  // still in flight — an earlier press, or the previous mount's — and the
  // older answer landing afterwards must not repaint over the newer rows, nor
  // become the next mount's snapshot.
  const target = makeChannel({ registry, cwd: alphaDir })
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'an in-flight listing holds the first paint',
    await settled(() => app.lines().join('\n').includes(LOADING_PLACEHOLDER)),
    app.lines().join('\n'),
  )

  target.plan = { sessions: renamedSessions }
  app.write('\u000c') // Ctrl+L: the documented manual re-listing
  check(
    'the newer listing paints the rows it answered with',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('renamed on disk') && !shown.includes('free session')
    }),
    app.lines().join('\n'),
  )

  gate.resolve()
  const shown = (): string => app.lines().join('\n')
  await settled(() => target.landed >= 2, { timeoutMs: 4_000 })
  // This assertion is about a repaint that must NOT happen, so there is no
  // positive anchor to poll for: let one render cycle pass first, and only
  // then read the frame.
  await sleep(150) // 固定窗:pacing 等陈旧 listing 的一次重绘窗口（没有可轮询的正向锚点）
  check(
    'the older listing landing late does not repaint over the newer one',
    shown().includes('renamed on disk') && !shown().includes('free session'),
    shown(),
  )
  app.close()

  const reopen = deferred()
  target.plan = { defer: reopen.promise }
  const again = await mountSupervisor(target)
  check(
    'and the late listing did not become the snapshot either',
    await settled(() => {
      const rows = again.lines().join('\n')
      return rows.includes('renamed on disk') && !rows.includes('free session')
    }),
    again.lines().join('\n'),
  )
  reopen.resolve()
  await settled(() => target.landed >= 3, { timeoutMs: 4_000 })
  again.close()
}
{
  // A snapshot belongs to its own channel: a screen opened on a DIFFERENT
  // channel must not paint another channel's rows while its own listing is in
  // flight, even though both answer from the same store here.
  const other = makeChannel({ registry, cwd: alphaDir })
  const first = await mountSupervisor(other)
  await settled(() => first.lines().join('\n').includes('free session'))
  first.close()

  const target = makeChannel({ registry, cwd: alphaDir })
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'a different channel does not paint the previous channel snapshot',
    await settled(() => app.lines().join('\n').includes(LOADING_PLACEHOLDER)),
    app.lines().join('\n'),
  )
  check(
    'and shows none of its rows',
    !app.lines().join('\n').includes('free session'),
    app.lines().join('\n'),
  )
  gate.resolve()
  await settled(() => target.landed >= 1, { timeoutMs: 4_000 })
  app.close()
}

// ── the persistent snapshot: what a RESTART paints first ───────────────────
//
// The snapshot above lives on the channel and dies with the process, so a
// cold start had nothing to paint and sat on the placeholder until a whole
// listing landed — the empty /resume wait after a restart. The channel now
// answers cachedSessions() synchronously from its own on-disk cache, so a
// fresh channel (no in-memory slot to reuse) paints real rows on its FIRST
// frame. That is why these cases read the PAINTED stream: a placeholder that
// lived for exactly one frame is overwritten in the viewport and would look
// like a pass there.

/** What the pane shows once a listing succeeded and found nothing. */
const EMPTY_STATE = 'No sessions in this workspace yet'

console.log('persistent snapshot: a fresh channel paints the disk cache first')
{
  // No in-memory slot exists for this channel — it IS a restart — and the
  // listing is held open, so everything asserted here happens before any
  // promise could have answered.
  const cache = cacheCell(sessions)
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const gate = deferred()
  target.plan = { defer: gate.promise, sessions: renamedSessions }
  const app = await mountSupervisor(target)
  check(
    'a fresh channel paints the cached rows while the listing is in flight',
    await settled(() => app.lines().join('\n').includes('free session')),
    app.lines().join('\n'),
  )
  check('the listing really is still unresolved', target.landed === 0, 'landed: ' + target.landed)
  check('no loading placeholder was ever painted on this mount', !app.saw(LOADING_PLACEHOLDER))
  // The refresh is still running under the cached rows, and it is reported ON
  // the counts line rather than on a line of its own — so the rows it is
  // refreshing must not move while it shows.
  const countsLine = (): string => app.lines().find(line => line.includes('working ·')) ?? ''
  const heldRow = (): number => app.lines().findIndex(line => line.includes('held session'))
  await settled(() => heldRow() >= 0)
  const heldBefore = heldRow()
  check(
    'the counts line reports the refresh that is still running',
    countsLine().includes('refreshing'),
    countsLine(),
  )
  gate.resolve()
  check(
    'the fresh listing still corrects the cached rows',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('renamed on disk') && !shown.includes('free session')
    }),
    app.lines().join('\n'),
  )
  check('the refresh marker clears once the listing landed', !countsLine().includes('refreshing'), countsLine())
  check(
    'the marker took no row: the cached rows keep their place',
    heldRow() === heldBefore && heldBefore >= 0,
    'before: ' + String(heldBefore) + ' after: ' + String(heldRow()),
  )
  app.close()
}
{
  // The same first paint, with the cache coming from the REAL module instead
  // of a hand-built cell: `beginListingSnapshot` writes the actual file under
  // this run's fake home, and the stub reads straight through
  // `readListingSnapshot`. Every access re-reads the disk, and the channel is
  // brand new, so no row painted here can be a previous mount's memory.
  // The snapshot is the size a real install carries, because the FIRST frame is
  // the thing under study and a three-row list cannot speak for it. The three
  // rows above stay first and newest; the bulk is synthetic — independent ids,
  // older timestamps, no real conversation content copied from anywhere. Only
  // this case grows: every other fixture keeps its short list, so a failure
  // elsewhere still reads as itself.
  const SNAPSHOT_ROWS = 1655
  const bulk = Array.from({ length: SNAPSHOT_ROWS - sessions.length }, (_, index) => session({
    id: 'bulk-' + String(index),
    title: { text: 'bulk session ' + String(index), source: 'prompt' },
    updatedAt: now - 60_000 - index,
  }))
  const snapshotRows = [...sessions, ...bulk]
  const source = { name: 'session-persistence-jsonl', config: { root: sandbox } }
  beginListingSnapshot(source)(snapshotRows)
  check(
    'the snapshot module round-trips ' + String(SNAPSHOT_ROWS) + ' rows through a real file',
    readListingSnapshot(source)?.length === SNAPSHOT_ROWS,
    String(readListingSnapshot(source)?.length ?? -1),
  )

  const cache: CacheCell = diskCacheCell(() => readListingSnapshot(source))
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const gate = deferred()
  target.plan = { defer: gate.promise }

  const mountedAt = performance.now()
  const app = await mountSupervisor(target)
  const painted = await settled(() => app.lines().join('\n').includes('free session'))
  const firstFrameMs = performance.now() - mountedAt
  // Reported for a human reading the log, deliberately NOT an assertion: this
  // machine's load decides it, and a threshold here would be a flake source.
  console.log('info   mount → cached rows on screen at ' + String(SNAPSHOT_ROWS) + ' sessions: ' + firstFrameMs.toFixed(1) + ' ms')

  const rowIndex = (needle: string): number => app.lines().findIndex(line => line.includes(needle))
  check('a disk-scoped channel paints the real snapshot first', painted, app.lines().join('\n'))
  check(
    'the three real rows are still the three FIRST rows',
    rowIndex('live session') >= 0 && rowIndex('live session') < rowIndex('free session') && rowIndex('free session') < rowIndex('held session'),
    'rows: ' + String(rowIndex('live session')) + '/' + String(rowIndex('free session')) + '/' + String(rowIndex('held session')),
  )
  check('the fresh listing is still unresolved', target.landed === 0, 'landed: ' + target.landed)
  check('and the placeholder never reaches the screen', !app.saw(LOADING_PLACEHOLDER))
  // Left unresolved on purpose: this case owns the FIRST frame. The cell also
  // ignores the stub's model of a write — the file owns the rows (diskCacheCell).
  app.close()
}
{
  // A cache that recorded a SUCCESSFUL empty listing is not the same thing as
  // no cache at all: there is nothing to wait for, so the pane shows its empty
  // state instead of the placeholder a cold install sits on.
  const cache = cacheCell([])
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const gate = deferred()
  target.plan = { defer: gate.promise, sessions }
  const app = await mountSupervisor(target)
  check(
    'an empty cache paints the empty state, not the placeholder',
    await settled(() => app.lines().join('\n').includes(EMPTY_STATE)),
    app.lines().join('\n'),
  )
  check('an empty cache invents no session row', !app.lines().join('\n').includes('free session'))
  check('the placeholder was never painted for an empty cache', !app.saw(LOADING_PLACEHOLDER))
  gate.resolve()
  await settled(() => target.landed >= 1, { timeoutMs: 4_000 })
  app.close()
}
{
  // The store emptied after the cache was written (the user deleted the
  // sessions). The successful empty listing must clear the painted rows AND
  // the cache: rows left on screen would be deleted sessions shown as real,
  // and a cache left holding them would resurrect them on the next restart,
  // where only another listing could correct them.
  const cache = cacheCell(sessions)
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const gate = deferred()
  target.plan = { defer: gate.promise, sessions: [] }
  const app = await mountSupervisor(target)
  check(
    'the cached rows are on screen while the listing is in flight',
    await settled(() => app.lines().join('\n').includes('free session')),
    app.lines().join('\n'),
  )
  gate.resolve()
  check(
    'a successful EMPTY listing clears the cached rows',
    await settled(() => {
      const shown = app.lines().join('\n')
      return !shown.includes('free session') && shown.includes(EMPTY_STATE)
    }),
    app.lines().join('\n'),
  )
  app.close()

  const after = deferred()
  const restarted = makeChannel({ registry, cwd: alphaDir, cache })
  restarted.plan = { defer: after.promise }
  const next = await mountSupervisor(restarted)
  check(
    'a restart over that cache paints the empty state, not the deleted rows',
    await settled(() => {
      const shown = next.lines().join('\n')
      return !shown.includes('free session') && shown.includes(EMPTY_STATE)
    }),
    next.lines().join('\n'),
  )
  check('and never falls back to the placeholder', !next.saw(LOADING_PLACEHOLDER))
  after.resolve()
  await settled(() => restarted.landed >= 1, { timeoutMs: 4_000 })
  next.close()
}
{
  // A rejected listing writes nothing: the cached rows stay beside the error
  // notice, and a restart still reads them. A failure is not an empty store.
  const cache = cacheCell(sessions)
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  target.plan = { reject: true }
  const app = await mountSupervisor(target)
  check(
    'a rejected listing keeps the cached rows beside the error notice',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('free session') && shown.includes('Failed to load sessions')
    }),
    app.lines().join('\n'),
  )
  check('the placeholder was never painted for a cached failure', !app.saw(LOADING_PLACEHOLDER))
  app.close()

  const gate = deferred()
  const restarted = makeChannel({ registry, cwd: alphaDir, cache })
  restarted.plan = { defer: gate.promise }
  const next = await mountSupervisor(restarted)
  check(
    'a restart after the failure still paints the cached rows',
    await settled(() => next.lines().join('\n').includes('free session')),
    next.lines().join('\n'),
  )
  check('and does not fall back to the placeholder', !next.saw(LOADING_PLACEHOLDER))
  gate.resolve()
  await settled(() => restarted.landed >= 1, { timeoutMs: 4_000 })
  next.close()
}
{
  // A restart paints the cache, then Ctrl+L starts a newer listing while the
  // first is still in flight. The older answer landing late must not roll the
  // screen back, and must not become what the next restart reads.
  const cache = cacheCell(sessions)
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'the restart opens on the cached rows',
    await settled(() => app.lines().join('\n').includes('free session')),
    app.lines().join('\n'),
  )

  target.plan = { sessions: renamedSessions }
  app.write('\u000c') // Ctrl+L: the documented manual re-listing
  check(
    'the newer listing paints the rows it answered with',
    await settled(() => app.lines().join('\n').includes('renamed on disk')),
    app.lines().join('\n'),
  )

  gate.resolve()
  await settled(() => target.landed >= 2, { timeoutMs: 4_000 })
  await sleep(150) // 固定窗:pacing 等陈旧 listing 的一次重绘窗口（没有可轮询的正向锚点）
  check(
    'the older listing landing late does not roll the screen back',
    app.lines().join('\n').includes('renamed on disk') && !app.lines().join('\n').includes('free session'),
    app.lines().join('\n'),
  )
  app.close()

  const reopen = deferred()
  const again = makeChannel({ registry, cwd: alphaDir, cache })
  again.plan = { defer: reopen.promise }
  const restarted = await mountSupervisor(again)
  check(
    'a restart over that cache paints the newer rows',
    await settled(() => restarted.lines().join('\n').includes('renamed on disk')),
    restarted.lines().join('\n'),
  )
  check('and not the superseded ones', !restarted.lines().join('\n').includes('free session'))
  reopen.resolve()
  await settled(() => again.landed >= 1, { timeoutMs: 4_000 })
  restarted.close()
}

// ── progress: the first enumeration, before the listing can resolve ────────
//
// With no cache there is nothing to paint, so a cold mount shows the
// placeholder. The channel can hand over the summaries it has already
// enumerated while the expensive half (titles, artifacts) is still running:
// that partial answer must clear the placeholder, must not be mistaken for the
// final listing, and must never outlive the call that produced it.

/** Summaries as the early enumeration sees them: right ids, stale titles. */
const partialSessions = [
  session({ id: 'free-one', title: { text: 'partial listing', source: 'prompt' }, updatedAt: now - 1_000 }),
  sessions[1],
  sessions[2],
]

console.log('progress: a partial enumeration paints before the listing resolves')
{
  const target = makeChannel({ registry, cwd: alphaDir })
  const gate = deferred()
  target.plan = { defer: gate.promise, sessions: renamedSessions }
  const app = await mountSupervisor(target)
  check(
    'a cold mount with no cache waits on the placeholder',
    await settled(() => app.lines().join('\n').includes(LOADING_PLACEHOLDER)),
    app.lines().join('\n'),
  )
  const partial = target.onPartial
  check('the screen asked the channel for progress', typeof partial === 'function')
  partial?.(partialSessions)
  check(
    'the partial listing clears the placeholder',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('partial listing') && !shown.includes(LOADING_PLACEHOLDER)
    }),
    app.lines().join('\n'),
  )
  check('the real listing is still unresolved', target.landed === 0, 'landed: ' + target.landed)

  gate.resolve()
  check(
    'the fresh listing replaces the partial rows',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('renamed on disk') && !shown.includes('partial listing')
    }),
    app.lines().join('\n'),
  )
  check('the partial rows do not come back', !app.lines().join('\n').includes('partial listing'))
  app.close()
}
{
  // A partial answer belongs to the call that produced it. Once a newer
  // listing has landed, a progress emit from the superseded one must not
  // repaint — the same generation rule the listing answers themselves obey.
  const target = makeChannel({ registry, cwd: alphaDir })
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  await settled(() => app.lines().join('\n').includes(LOADING_PLACEHOLDER))
  const stale = target.onPartial
  target.plan = { sessions: renamedSessions }
  app.write('\u000c') // Ctrl+L: a newer listing
  check(
    'the newer listing lands',
    await settled(() => app.lines().join('\n').includes('renamed on disk')),
    app.lines().join('\n'),
  )
  stale?.(partialSessions)
  await sleep(150) // 固定窗:pacing 等一次可能的重绘，无正向锚点
  check(
    'a stale progress emit does not repaint the screen',
    !app.lines().join('\n').includes('partial listing'),
    app.lines().join('\n'),
  )
  gate.resolve()
  await settled(() => target.landed >= 2, { timeoutMs: 4_000 })
  app.close()
}

const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
const instance = await render(
  <ThemeProvider theme="dark">
    {/* The alternate screen is what turns mouse tracking on; without it the
        renderer drops every click before hit-testing (see AlternateScreen). */}
    <AlternateScreen>
      <SessionSupervisor
        channel={channel}
        home={sandbox}
        onClose={() => { calls.push('close') }}
        onOpenSession={async (id) => {
          await (channel as unknown as { resumeTo(id: string): Promise<{ ok: boolean }> }).resumeTo(id)
          return { ok: true }
        }}
        // Same path Chat.tsx wires: the screen resolves the workspace target,
        // the host switches to it and starts the session there.
        onNewSession={async (target) => {
          await (channel as unknown as { switchWorkspace(t: unknown): Promise<boolean> }).switchWorkspace(target)
          return true
        }}
        onStopSession={async (id) => {
          await (channel as unknown as { stopBackgroundAgent(id: string): Promise<boolean> }).stopBackgroundAgent(id)
          return true
        }}
        approval={null}
        onApprove={() => {}}
        liveStateOf={(id) => liveState[id as keyof typeof liveState]}
      />
    </AlternateScreen>
  </ThemeProvider>,
  {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

// Wait for the listing effect to land AND the frame to paint. The first
// condition is what makes this robust: the screen names the terminal's own
// workspace in the pane header only after `listSessions()` resolved, so polling
// for it cannot pass early. (Polling the bare word "Sessions" WOULD pass early —
// the banner carries it from the first paint, before any row exists.)
await settled(() => viewportLines(terminal).join('\n').includes('Sessions in Alpha'))

const line = (y: number): string => viewportLines(terminal)[y] ?? ''
const text = (): string => viewportLines(terminal).join('\n')
const rowOf = (needle: string): number => {
  const lines = viewportLines(terminal)
  for (let y = 0; y < lines.length; y++) if (lines[y].includes(needle)) return y
  return -1
}
/**
 * One real click, routed through the renderer's hit-testing path.
 *
 * The pointer report goes to STDIN (the app's input), not to the terminal's
 * output parser — `writeParsed` feeds the latter and would silently click
 * nothing. A whole SGR report is written in one go, like a real terminal
 * delivering an event burst, and the wait is a predicate so the assertions do
 * not race the render.
 *
 * The brief delay is `固定窗:pacing`: the input pump needs a turn of the event
 * loop to hand the bytes to the parser, and there is no observable anchor for
 * "the parser consumed the burst".
 */
const clickText = async (needle: string, until?: () => boolean): Promise<void> => {
  await settled(() => findText(terminal, needle) !== null)
  const found = findText(terminal, needle)
  if (found === null) throw new Error(`row not found: ${needle}`)
  const x = found.col + 1
  const y = found.row + 1
  stdin.write(`\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`)
  await new Promise(resolve => setTimeout(resolve, 120))
  await settled(until ?? (() => true))
}

console.log('pure helpers:')
check('empty query matches everything', sessionMatchesQuery(sessions[0] as never, ''))
check('title substring matches', sessionMatchesQuery(sessions[0] as never, 'free'))
check('cwd substring matches', sessionMatchesQuery(sessions[0] as never, 'alpha'))
check('branch substring matches', sessionMatchesQuery(sessions[0] as never, 'main'))
check('non-match is rejected', !sessionMatchesQuery(sessions[0] as never, 'zzzz'))
check('rail window keeps the focused entry visible', railWindowTop(4, 20, 6) <= 3)
check('rail window clamps at zero', railWindowTop(0, 20, 6) === 0)
const spacedPath = '/Users/名字/My Project/🧪-session'
const pathChunks = wrapPathWidth(spacedPath, 12)
check('path wrapping preserves spaces and Unicode graphemes', pathChunks.join('') === spacedPath && pathChunks.every(chunk => [...chunk].length > 0), pathChunks.join(' | '))

console.log('one surface:')
check('screen title renders', text().includes('Sessions'))
check('workspace rail renders', text().includes('Workspaces'))
check('the rail has no add-workspace row', !text().includes('Add workspace'))
check('session pane header renders', text().includes('Sessions in Alpha'))
check('the selected DSH directory is visible as an absolute path above both panes', line(2).includes(alphaDir), line(2))
check(
  'the rail opens on the terminal own workspace, not the first ledger entry',
  text().includes('Sessions in Alpha') && !text().includes('Sessions in Beta'),
)
// The cursor and the selection are ONE position on this screen. The regression
// is the untouched first frame: the cursor started at index 0 while the
// selection landed on Alpha, so Beta and Alpha both looked selected.
//
// Both rows are located by the rail's own `▣`/`▢` marker — matching the bare
// title would hit the sessions pane, whose path line also contains "alpha" —
// and "the cursor is here" is read as the ❯ in the rail's own prefix. The rail
// is a fraction of the frame, so leading cells are skipped rather than assuming
// a fixed indent.
const railCursor = (marker: string, title: string): boolean =>
  viewportLines(terminal).some(raw => new RegExp(`^\\s*❯\\s+${marker} ${title}\\b`, 'u').test(raw))
check(
  'the cursor opens on the selected workspace, not on row 0',
  railCursor('▣', 'Alpha') && !railCursor('▢', 'Beta'),
  `alpha marked: ${railCursor('▣', 'Alpha')}, beta marked: ${railCursor('▢', 'Beta')}`,
)
check('the live-state counts render', /\d+ working · \d+ live · \d+ total/u.test(text()))
check('a free session is listed', text().includes('free session'))
check('the live session is listed', text().includes('live session'))
check('the current session is marked', text().includes('current'))
check('a free session carries no occupancy badge', rowOf('free session') >= 0 && !line(rowOf('free session')).includes('held'))

// ←/→ picks the column, and exactly one column shows the cursor. The rail's own
// cursor is the unambiguous witness for which column owns the keyboard: it is
// read as "the `❯` immediately before this workspace's `▣`/`▢` marker", a shape
// no session row can produce. Asserting on it therefore proves the switch for
// both directions without trying to locate the session cursor inside a line the
// two panes share (the session half starts after the rail's column).
console.log('←/→ picks the column, and only that column shows ❯:')
check(
  'the rail starts with the cursor on its selected workspace',
  railCursor('▣', 'Alpha') && !railCursor('▢', 'Beta'),
  `alpha=${railCursor('▣', 'Alpha')} beta=${railCursor('▢', 'Beta')}`,
)
stdin.write('\u001b[C')
await settled(() => true)
check(
  '→ hands the cursor to the session column (the rail cursor clears)',
  await settled(() => !railCursor('▣', 'Alpha') && !railCursor('▢', 'Beta')),
  `alpha=${railCursor('▣', 'Alpha')} beta=${railCursor('▢', 'Beta')}`,
)
stdin.write('\u001b[D')
await settled(() => true)
check(
  '← hands it back to the rail',
  await settled(() => railCursor('▣', 'Alpha')),
  `alpha=${railCursor('▣', 'Alpha')}`,
)

// The new-session card is row 0 of the session list, so the cursor can stand on
// it. It used to be a fixed row outside the cursor model — which is what let the
// session window keep its old height, park `❯` on a row that never made it on
// screen (two cursors at once) and leave ↑ unable to reach the bottom.
//
// Cursor presence is read from the BUFFER with escapes stripped: a captured row
// can carry a bare ANSI cursor-move in front of the glyph (see the rail reader),
// which no `^\s*❯` test survives.
const focusedRowOf = (needle: string): boolean => {
  const buffer = terminal.buffer.active
  for (let y = 0; y < terminal.rows; y++) {
    const raw = buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''
    if (!raw.includes(needle)) continue
    const plain = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
    return plain.includes('❯')
  }
  return false
}
// The script pins DSH_TUI_LANG=en, so the card's label is the ASCII `+ New
// session` — looking for the Chinese one silently matched nothing and made every
// "is the card focused" question unanswerable.
const CARD_LABEL = '+ New session'
const cardFocus = (): boolean => focusedRowOf(CARD_LABEL)
const sessionRowFocus = (needle: string): boolean => focusedRowOf(needle)
console.log('the new-session card is a row in the cursor model:')
stdin.write('\u001b[C')
await settled(() => true)
check(
  '→ lands on the first session, not on the card',
  await settled(() => sessionRowFocus('live session') && !cardFocus()),
  `card=${cardFocus()} session=${sessionRowFocus('live session')}`,
)
stdin.write('\u001b[A')
check(
  '↑ puts the cursor on the card, and the first session stops being selected',
  await settled(() => cardFocus() && !sessionRowFocus('live session')),
  `card=${cardFocus()} session=${sessionRowFocus('live session')}`,
)
stdin.write('\u001b[B')
check(
  '↓ returns the cursor to the first session and the card goes quiet',
  await settled(() => sessionRowFocus('live session') && !cardFocus()),
  `card=${cardFocus()} session=${sessionRowFocus('live session')}`,
)
// The card is IN the list's cursor space (row 0), so it can be picked directly —
// which is how a user reaches it when the list is empty, and what a fixed
// outside-the-list row could never offer.
stdin.write('\u001b[D')
await settled(() => railCursor('▣', 'Alpha'))

// The pane's own new-session entry, next to the counts it acts within.
check('the sessions pane offers a new-session entry', text().includes('+ New session'))
check('the filter box is live', text().includes('Type to search sessions'))

console.log('typing filters the session list (the box is LIVE, not a mode):')
stdin.write('free')
check(
  'typing narrows the list to the matching session',
  await settled(() => text().includes('free session') && !text().includes('live session')),
  text(),
)
// Clear so the occupancy checks below see the full ledger again.
stdin.write('\u007f\u007f\u007f\u007f')
check(
  'backspace restores the full list',
  await settled(() => text().includes('live session') && text().includes('held session')),
  text(),
)

console.log('the pane entry starts a session:')
// The entry is a full session-card row directly under the filter, so the
// column-scan click lands on it rather than on a right-aligned header control.
const entryRow = rowOf('+ New session')
const hintRow = rowOf('Start a session in')
check(
  'the new-session card sits under the filter with a session card\'s height',
  entryRow > rowOf('Type to search sessions') && hintRow === entryRow + 1,
  `entry row=${entryRow} hint row=${hintRow}`,
)
await clickText('+ New session', () => calls.some(call => call.startsWith('switchWorkspace:')))
check(
  'clicking the pane entry starts a session in the selected workspace',
  calls.includes(`switchWorkspace:${alphaDir}`),
  `calls: ${calls.join(', ')}`,
)

console.log('cross-process occupancy:')
check('the occupied row is listed', text().includes('held session'))
check('the occupied row carries the badge', line(rowOf('held session')).includes('held by pid'))
check('the occupied row names the holder pid', text().includes(String(FOREIGN_PID)))

// Click the title text itself (located by search), not a control cell: a
// hard-coded x would land in the rail on any width where the rail is visible,
// and the click would then do nothing for a reason unrelated to the test.
const before = calls.filter(call => call.startsWith('resumeTo')).length
await clickText('held session')
const after = calls.filter(call => call.startsWith('resumeTo')).length
check('clicking an occupied session never reaches resumeTo', after === before, `calls: ${calls.join(', ')}`)

console.log('a free session still opens:')
await clickText('free session', () => calls.includes('resumeTo:free-one'))
check('clicking a free session resumes it', calls.includes('resumeTo:free-one'), `calls: ${calls.join(', ')}`)
check(
  'the occupied and free rows are different rows',
  findText(terminal, 'free session')?.row !== findText(terminal, 'held session')?.row,
)

instance.unmount()

console.log('occupancy follows the LEDGER, not a snapshot taken at first render')
{
  // The screen polls on its own 2s clock and must re-read the ledger there. A
  // snapshot captured by the host during ITS render stayed frozen: a foreign
  // terminal that released the session left the row red and unclickable until
  // some unrelated channel event happened to repaint the parent.
  const ledgerPath = join(fakeHome, '.dsh-tui', 'session-mounts.json')
  const owner = (sessionIds: readonly string[]): string => JSON.stringify({
    version: 1,
    owners: sessionIds.length === 0 ? [] : [{
      pid: FOREIGN_PID,
      startedAt: Date.now(),
      sessionIds,
    }],
  }, null, 2)
  writeFileSync(ledgerPath, owner([HELD_SESSION_ID]), 'utf8')
  const app = await openSupervisor({ registry, cwd: alphaDir })
  await settled(() => app.lines().join('\n').includes('Sessions in Alpha'))
  check(
    'the ledger holder is shown while the peer is alive',
    app.lines().some(line => line.includes('held session') && line.includes('held by pid')),
    app.lines().join('\n'),
  )
  writeFileSync(ledgerPath, owner([]), 'utf8')
  check(
    'the row clears on the poll once the peer releases it',
    await settled(
      () => app.lines().some(line => line.includes('held session') && !line.includes('held by pid')),
      { timeoutMs: 8_000 },
    ),
    app.lines().join('\n'),
  )
  app.close()
  // Leave the ledger empty for any later case: the peer released it above.
}

// ── the rail shows whole rows, and Enter follows the VISIBLE cursor ────────
//
// Two regressions in one screen, both invisible to the older assertions:
//
//   * the rail's window was computed in TERMINAL ROWS while each workspace
//     entry is two of them, so it rendered about twice as many entries as fit
//     and `overflow="hidden"` clipped the focused one — the user was navigating
//     workspaces that were not on screen;
//   * `sessionFocusRef` was a second focus source beside `focusSessionId`: the
//     render drew `❯` from the id while Enter read the ref, so after a filter
//     moved the rows Enter acted on a row the user had never selected.
console.log('long rail: the focused workspace is really on screen')
{
  const manyDir = join(sandbox, 'many')
  const many = Array.from({ length: RAIL_ENTRIES }, (_, index) => {
    const path = join(manyDir, `workspace-${String(index + 1).padStart(2, '0')}`)
    return { id: `w-${index}`, path, title: `Workspace${index + 1}`, present: true, sessionCount: 0 }
  })
  // The terminal sits in the LAST workspace, so the rail opens at the bottom of
  // a list that cannot fit — the exact shape the old row-count window clipped.
  const app = await openSupervisor({ registry: many, cwd: many[many.length - 1]!.path, sessions: [] })
  await settled(() => app.lines().join('\n').includes(`Workspace${RAIL_ENTRIES}`))
  const lines = app.lines()
  const focused = lines.findIndex(raw => /❯\s+▣\s+Workspace\d+/u.test(raw))
  check(
    'the focused rail entry is inside the viewport',
    focused >= 0 && focused < ROWS,
    `row ${focused} of ${ROWS}`,
  )
  check(
    'the focused entry\'s SECOND line is on screen too',
    focused >= 0 && lines[focused + 1] !== undefined && lines[focused + 1]!.includes('many'),
    `next line: ${JSON.stringify(lines[focused + 1] ?? null)}`,
  )
  app.close()
}

console.log('Enter acts on the row the filter left under the cursor')
{
  const app = await openSupervisor({ registry, cwd: alphaDir })
  await settled(() => app.lines().join('\n').includes('Sessions in Alpha'))
  // → into the session column, where the cursor lands on the ATTACHED session
  // (the second row), not on the first.
  app.write('\u001b[C')
  await settled(() => true)
  const cursorOn = (title: string): boolean => app.lines().some(line =>
    line.includes(title) && line.includes('❯'))
  await settled(() => cursorOn('live session'))
  check(
    'the cursor starts on the attached session',
    cursorOn('live session') && !cursorOn('free session'),
    app.lines().join('\n'),
  )
  // The filter re-sorts: the row that WAS second becomes the first. The cursor
  // has to follow the id it was on, not the index it used to occupy. Typing is
  // paced because this harness delivers a whole burst between renders and the
  // first character of a burst is consumed before the filter is live.
  for (const character of 'free') {
    app.write(character)
    await sleep(60) // 固定窗:pacing 逐字投喂：整串一次写入时首字符会被当作导航键吞掉
  }
  await settled(() => app.lines().join('\n').includes('free session'))
  check(
    'the filter leaves the cursor on a real row',
    cursorOn('free session'),
    app.lines().join('\n'),
  )
  await sleep(120) // 固定窗:pacing Enter 处理步间，无可观测锚点
  app.write('\r')
  check(
    'Enter opens the row the cursor is on',
    await settled(() => app.calls.includes('resumeTo:free-one'), { timeoutMs: 4_000 }),
    `calls: ${app.calls.join(', ')}`,
  )
  check(
    'Enter opened exactly that row',
    app.calls.filter(call => call.startsWith('resumeTo')).join(',') === 'resumeTo:free-one',
    `calls: ${app.calls.join(', ')}`,
  )
  app.close()
}

console.log('an unregistered directory does not hide its sessions')
{
  // "No workspace registration" is not "no history": the fallback row is the
  // way back to sessions whose directory was never registered (or was removed).
  // It is titled by the directory itself, so the rail still says WHERE they ran
  // rather than dumping every unregistered project into one anonymous group.
  const app = await openSupervisor({ registry: [], cwd: GHOST_DIR })
  const shown = () => app.lines().join('\n')
  check(
    'the rail offers a row for the unregistered directory',
    await settled(() => /alpha/.test(shown()), { timeoutMs: 6_000 }),
    shown(),
  )
  check(
    'the row lists the sessions the registry does not know',
    await settled(() => shown().includes('free session'), { timeoutMs: 6_000 }),
    shown(),
  )
  check(
    'the fallback row is not backed by a registration',
    !/No workspaces yet/.test(shown()),
    shown(),
  )
  app.close()
}

console.log('removing a registration keeps its history visibly distinct (#1040)')
{
  const records = [{ id: 'w-alpha', path: alphaDir, title: 'Alpha', present: true, sessionCount: 0 }]
  const app = await openSupervisor({
    registry: records,
    cwd: alphaDir,
    removeWorkspace: path => {
      const index = records.findIndex(record => record.path === path)
      if (index < 0) return false
      records.splice(index, 1)
      return true
    },
  })
  const shown = () => app.lines().join('\n')
  check('registered directory starts without a history label',
    await settled(() => shown().includes('Workspaces (1)') && !shown().includes('History only'), { timeoutMs: 6_000 }), shown())
  app.write('\r')
  await settled(() => shown().includes('Remove from list'))
  app.write('\u001b[B\u001b[B\u001b[B\r')
  await settled(() => shown().includes('Remove workspace'))
  app.write('\r')
  check('successful removal is acknowledged and the rail distinguishes history',
    await settled(() => shown().includes('Workspace registration removed')
      && shown().includes('Workspaces 0 · History 1')
      && shown().includes('History only · alpha'), { timeoutMs: 6_000 }), shown())
  check('past sessions stay reachable after registration removal', shown().includes('free session'), shown())
  check('the host removal action ran once', app.calls.filter(call => call === `removeWorkspace:${alphaDir}`).length === 1)
  app.close()
}

console.log('history-only rows offer no registration-only actions (#1041)')
{
  const app = await openSupervisor({ registry: [], cwd: alphaDir })
  const shown = () => app.lines().join('\n')
  await settled(() => shown().includes('History only · alpha'))
  app.write('\r')
  check('keyboard menu omits rename and remove on a history row',
    await settled(() => shown().includes('New session here')
      && !shown().includes('Rename workspace') && !shown().includes('Remove from list')), shown())
  app.write('\u001b[A\r') // Up wraps from Edit to New in the two-action menu.
  check('keyboard can activate the last available action',
    await settled(() => app.calls.includes(`resolveWorkspace:${alphaDir}`)), app.calls.join(', '))
  await app.rightClick('History only · alpha')
  check('right click opens the same reduced menu',
    await settled(() => shown().includes('New session here')
      && !shown().includes('Rename workspace') && !shown().includes('Remove from list')), shown())
  await app.click('New session here')
  check('mouse activates an available action without invoking removal',
    await settled(() => app.calls.filter(call => call === `resolveWorkspace:${alphaDir}`).length === 2)
      && !app.calls.some(call => call.startsWith('removeWorkspace:')), app.calls.join(', '))
  app.close()
}

console.log('a registry that FAILS does not take the history with it')
{
  // The two reads are independent. `Promise.all` used to reject as a whole, so
  // a throwing registry discarded the perfectly good `listSessions()` result
  // and the screen rendered "no sessions" over a directory full of them.
  const app = await openSupervisor({ registry: [], cwd: alphaDir, registryRejects: true })
  check(
    'the sessions are still listed when the registry throws',
    await settled(() => app.lines().join('\n').includes('free session'), { timeoutMs: 6_000 }),
    app.lines().join('\n'),
  )
  check(
    'the rail names the directory the sessions came from',
    app.lines().join('\n').includes('alpha'),
    app.lines().join('\n'),
  )
  // Same screen, no registry service at all (bare composition): the sessions
  // must not vanish just because the workspace stack is unmounted.
  const absent = await openSupervisor({ registry: [], cwd: alphaDir, registryAbsent: true })
  check(
    'the sessions are still listed with no workspace service',
    await settled(() => absent.lines().join('\n').includes('free session'), { timeoutMs: 6_000 }),
    absent.lines().join('\n'),
  )
  absent.close()
  app.close()
}
console.log('narrow header prioritizes the project over redundant counts')
{
  const narrow = await openSupervisor({
    registry: [{ id: 'long-title', path: alphaDir, title: 'dsh-TUI-contrib', present: true, sessionCount: 0 }],
    cwd: alphaDir,
    cols: 56,
  })
  await settled(() => narrow.lines().join('\n').includes('Sessions in dsh-TUI-contrib'))
  check('56 cols: selected project name remains intact', narrow.lines().some(line => line.includes('Sessions in dsh-TUI-contrib')))
  check('56 cols: counts collapse to a single number', narrow.lines().some(line => /Sessions in dsh-TUI-contrib\s+3\s*$/u.test(line)))
  narrow.close()
}
console.log('a refused open shows its REASON on this screen (#939)')
{
  // The screen replaces the conversation, so the composer that draws channel
  // notifications is not mounted: the reason has to reach THIS screen's own
  // notice, in full, on the final frame — at every width the pane can take.
  const REASON = 'provider desktop unreachable: connect ECONNREFUSED 127.0.0.1:8080 while restoring the recorded model route'
  for (const cols of [8, 19, 40, 80, 120]) {
    const app = await openSupervisor({
      registry,
      cwd: alphaDir,
      cols,
      openResult: { ok: false, reason: 'failed', error: REASON },
    })
    await settled(() => app.lines().join('\n').includes('free session'), { timeoutMs: 6_000 })
    app.write('\x1b[C') // → the list pane
    await sleep(50) // 固定窗:pacing 按键步间：焦点切换无可观测锚点
    app.write('\x1b[B') // past the new-session card onto the first session
    await sleep(50) // 固定窗:pacing 按键步间：焦点切换无可观测锚点
    app.write('\r')
    const joined = (): string => app.lines().map(line => line.trim()).join(' ')
    const flat = (): string => joined().replace(/\s+/gu, '')
    // Three rows of a very narrow pane cannot hold the whole sentence; what
    // must survive there is the START of the reason, not only the title.
    const probe = cols < 40 ? 'provider' : 'ECONNREFUSED'
    const shown = await settled(() => flat().includes(probe), { timeoutMs: 4_000 })
    check(`${cols} cols: the refusal reaches resumeTo`, app.calls.some(call => call.startsWith('resumeTo:')), app.calls.join(', '))
    // At 8 columns nothing on this screen is legible (title and rows clip to
    // 8 cells); the case stays for the spill check, not for the wording.
    if (cols >= 19) check(`${cols} cols: the failure reason is on the screen`, shown, app.lines().join('\n'))
    check(`${cols} cols: no pointer to an unmounted notification`, !joined().includes('notification below'), app.lines().join('\n'))
    if (cols >= 80) {
      // The rail shares these rows, so read the notice from its own column.
      const lines = app.lines()
      const top = lines.findIndex(line => line.includes('Could not enter'))
      const left = top < 0 ? 0 : lines[top].indexOf('Could not enter')
      const notice = lines.slice(top, top + 3).map(line => line.slice(left).trim()).join(' ')
      check(`${cols} cols: the whole reason is readable`, top >= 0 && notice.includes(REASON), notice)
    }
    // The renderer clips at the pane edge rather than spilling, so row widths
    // prove nothing: a clipped notice is caught by its TEXT. Read back in
    // order, the notice rows must be one unbroken prefix of the message, and
    // a message that did not fit must say so with the trailing ellipsis.
    {
      const lines = app.lines()
      // The full phrase when it fits on a row (the rail may sit to its left);
      // on the narrowest panes only its first word does.
      const whole = lines.findIndex(line => line.includes('Could not enter'))
      const top = whole >= 0 ? whole : lines.findIndex(line => line.trimStart().startsWith('Could'))
      const left = top < 0 ? 0 : lines[top].indexOf('Could')
      const rows: string[] = []
      for (let y = top; top >= 0 && y < top + 3 && y < lines.length; y++) {
        const row = lines[y].slice(left).trim()
        if (row === '' || row.includes('switch pane')) break
        rows.push(row)
      }
      const shownFlat = rows.join('').replace(/\s+/gu, '')
      const message = `Could not enter free session · ${REASON}`.replace(/\s+/gu, '')
      const cut = shownFlat.endsWith('…')
      const body = cut ? shownFlat.slice(0, -1) : shownFlat
      check(
        `${cols} cols: the notice is never silently clipped`,
        body.length > 0 && message.startsWith(body) && (cut || body === message),
        `${rows.join(' | ')}\n${lines.join('\n')}`,
      )
    }
    app.close()
  }
  const cancelled = await openSupervisor({ registry, cwd: alphaDir, openResult: { ok: false, reason: 'cancelled' } })
  await settled(() => cancelled.lines().join('\n').includes('free session'), { timeoutMs: 6_000 })
  cancelled.write('\x1b[C')
  await sleep(50) // 固定窗:pacing 按键步间：焦点切换无可观测锚点
  cancelled.write('\x1b[B')
  await sleep(50) // 固定窗:pacing 按键步间：焦点切换无可观测锚点
  cancelled.write('\r')
  await settled(() => cancelled.calls.length > 0, { timeoutMs: 4_000 })
  await sleep(200) // 固定窗:探针 取消的打开不得在此后画出提示
  check('a cancelled open stays silent', !cancelled.lines().join('\n').includes('Could not enter'), cancelled.lines().join('\n'))
  cancelled.close()
}

console.log('background title recovery updates the existing row')
{
  const target = makeChannel({ registry, cwd: alphaDir })
  const app = await mountSupervisor(target)
  check('the foreground row is visible', await settled(() => app.lines().join('\n').includes('free session')))
  target.enrich?.(session({ id: 'free-one', title: { text: 'recovered title', source: 'auto' }, updatedAt: now - 1_000 }))
  check('background metadata repaints the row', await settled(() => app.lines().join('\n').includes('recovered title')))
  app.close()
}
// ── source tabs: other coding agents' conversations ──────────────────────

const foreignRow = (over: Partial<ForeignRowFixture> & { key: string }): ForeignRowFixture => ({
  agentId: 'claude-code',
  title: over.key,
  cwd: alphaDir,
  updatedAt: now - 10_000,
  ...over,
})
const claudeRows = [
  foreignRow({ key: 'cc-1', title: 'fix the parser', updatedAt: now - 5_000 }),
  foreignRow({ key: 'cc-2', title: 'write the docs', updatedAt: now - 9_000 }),
  // Newest overall, in a directory that no longer exists: the group sorts
  // first, but the rail still opens on the terminal's own directory.
  foreignRow({ key: 'cc-3', title: 'ghost chat', cwd: GHOST_DIR, updatedAt: now - 2_000 }),
  foreignRow({ key: 'cc-4', title: 'no directory', cwd: '', updatedAt: now - 20_000 }),
]
const codexRows = [foreignRow({ agentId: 'codex', key: 'cx-1', title: 'codex refactor', updatedAt: now - 7_000 })]
const foreignConfig: ForeignStubConfig = {
  sources: [
    // The strip keeps the channel's order (registry order in the real host).
    { agentId: 'claude-code', label: 'Claude Code' },
    { agentId: 'codex', label: 'Codex' },
  ],
  rows: { 'claude-code': claudeRows, codex: codexRows },
}

console.log('source tabs: pure layout and grouping')
{
  const tabs = [
    { id: 'dsh', label: 'DSH' },
    { id: 'a', label: 'Claude Code' },
    { id: 'b', label: 'Codex' },
    { id: 'c', label: 'Grok Build' },
  ]
  // Cells are ` label `; the `│` after DSH costs one more.
  const full = 5 + 1 + 13 + 7 + 12
  const wide = layoutSourceTabs(tabs, 'dsh', full)
  check('a wide strip shows every tab', wide.shown.length === 4 && wide.hidden.length === 0)
  const narrow = layoutSourceTabs(tabs, 'dsh', full - 1)
  check(
    'a narrow strip folds trailing tabs into +N',
    narrow.hidden.map(tab => tab.id).join(',') === 'c' && narrow.shown.map(tab => tab.id).join(',') === 'dsh,a,b',
    JSON.stringify(narrow),
  )
  const keepActive = layoutSourceTabs(tabs, 'c', 5 + 1 + 12 + 4)
  check(
    'the active tab never folds',
    keepActive.shown.some(tab => tab.id === 'c') && keepActive.hidden.length === 2,
    JSON.stringify(keepActive),
  )
  const tiny = layoutSourceTabs(tabs, 'b', 3)
  check(
    'with no room at all only the active tab is drawn',
    tiny.shown.map(tab => tab.id).join(',') === 'b' && tiny.hidden.length === 3,
    JSON.stringify(tiny),
  )

  const groups = groupForeignRows(claudeRows as never, [{ ...registry[1]!, from: 'registry' }] as never)
  check('conversations group by directory', groups.length === 3, JSON.stringify(groups.map(group => group.key)))
  check('groups sort by their newest conversation', groups[0]!.rows[0]!.key === 'cc-3')
  check(
    'a registered directory keeps its DSH title',
    groups.find(group => group.path === alphaDir)?.title === 'Alpha',
  )
  check(
    'a directory with no record lands in the unknown group',
    groups.find(group => group.key === FOREIGN_UNKNOWN_GROUP)?.rows[0]?.key === 'cc-4',
  )
  check('a vanished directory is marked missing', groups.find(group => group.path === GHOST_DIR)?.present === false)
  check('foreign search matches the title', foreignRowMatchesQuery(claudeRows[0] as never, 'parser'))
  check('foreign search matches the directory', foreignRowMatchesQuery(claudeRows[0] as never, 'alpha'))
  check('foreign search rejects a non-match', !foreignRowMatchesQuery(claudeRows[0] as never, 'zzzz'))
}

console.log('source tabs: no strip without sources')
{
  const app = await openSupervisor({ registry, cwd: alphaDir })
  await settled(() => app.lines().join('\n').includes('Sessions in Alpha'))
  check('a channel without the facade draws no tab strip', !app.lines()[0]!.includes('DSH'), app.lines()[0])
  check('and keeps the subtitle', app.lines()[0]!.includes('switching does not stop them'), app.lines()[0])
  app.close()
}

console.log('source tabs: strip, switching and import')
{
  const app = await openSupervisor({ registry, cwd: alphaDir, foreign: foreignConfig })
  const shown = (): string => app.lines().join('\n')
  const header = (): string => app.lines()[0] ?? ''
  await settled(() => shown().includes('Sessions in Alpha') && header().includes('Claude Code'))
  check('the strip renders in the header', /DSH\s*│\s*Claude Code\s+Codex/u.test(header()), header())
  check('the screen opens on the DSH tab', shown().includes('free session'), shown())
  check('the DSH hints name the Tab key', shown().includes('Tab switch source'), shown())

  await app.click('Claude Code')
  check(
    'clicking a tab switches to that source',
    await settled(() => shown().includes('Claude Code · sessions in Alpha')),
    shown(),
  )
  check('the source was scanned', app.calls.includes('scan:claude-code'), app.calls.join(', '))
  check('the DSH rows are gone', !shown().includes('free session'), shown())
  check(
    'the rail groups the source by directory',
    shown().includes('dsh-tui-supervisor-ghost') && shown().includes('Unknown directory'),
    shown(),
  )
  check('the list shows the selected directory only', shown().includes('fix the parser') && !shown().includes('ghost chat'), shown())
  check('the selected Claude Code directory uses the same full-path bar', app.lines()[2]?.includes(alphaDir) ?? false, app.lines()[2])
  const parserLine = app.lines().findIndex(line => line.includes('fix the parser'))
  check('foreign session facts do not repeat the directory', parserLine >= 0 && !app.lines()[parserLine + 1]?.includes(alphaDir), app.lines()[parserLine + 1])
  check('there is no new-session card', !shown().includes('+ New session'), shown())

  const cursorOn = (title: string): boolean => app.lines().some(line => line.includes(title) && line.includes('❯'))
  app.write('\u001b[C')
  check('→ lands the cursor on the first row (no card at 0)', await settled(() => cursorOn('fix the parser')), shown())
  for (const character of 'docs') {
    app.write(character)
    await sleep(60) // 固定窗:pacing 逐字投喂：整串一次写入时首字符会被当作导航键吞掉
  }
  check(
    'typing filters by title',
    await settled(() => shown().includes('write the docs') && !shown().includes('fix the parser')),
    shown(),
  )
  check('the filtered cursor stands on a real row', await settled(() => cursorOn('write the docs')), shown())
  await sleep(120) // 固定窗:pacing Enter 处理步间，无可观测锚点
  app.write('\r')
  check(
    'Enter imports, then opens the deterministic id',
    await settled(() => app.calls.includes('resumeTo:foreign-cc-2'), { timeoutMs: 4_000 }),
    app.calls.join(', '),
  )
  check(
    'the import ran before the open',
    app.calls.indexOf('created:foreign-cc-2') >= 0
      && app.calls.indexOf('created:foreign-cc-2') < app.calls.indexOf('resumeTo:foreign-cc-2'),
    app.calls.join(', '),
  )
  await sleep(120) // 固定窗:pacing 第二次 Enter 前等导入的防重入标记释放
  app.write('\r')
  check(
    'a second Enter opens the existing copy without creating another',
    await settled(() => app.calls.filter(call => call === 'resumeTo:foreign-cc-2').length === 2, { timeoutMs: 4_000 })
      && app.calls.includes('existing:foreign-cc-2')
      && app.calls.filter(call => call === 'created:foreign-cc-2').length === 1,
    app.calls.join(', '),
  )

  app.write('\t')
  check(
    'Tab moves to the next source',
    await settled(() => shown().includes('Codex · sessions in Alpha')),
    shown(),
  )
  check('Codex shows the same selected directory once above the panes', app.lines()[2]?.includes(alphaDir) ?? false, app.lines()[2])
  check('switching source clears the query', shown().includes('codex refactor'), shown())
  app.write('\u001b[Z')
  check(
    'Shift+Tab moves back',
    await settled(() => shown().includes('Claude Code · sessions in Alpha') && shown().includes('fix the parser')),
    shown(),
  )
  check('the query stays cleared on the way back', shown().includes('fix the parser') && shown().includes('write the docs'), shown())
  check('a revisited source is listed afresh (nothing kept across tabs)', app.calls.filter(call => call === 'scan:claude-code').length === 2, app.calls.join(', '))
  check('opening the screen probed the sources once', app.calls.filter(call => call === 'probe').length === 1, app.calls.join(', '))

  await app.click('dsh-tui-supervisor-ghost')
  check('clicking a rail group selects it', await settled(() => shown().includes('ghost chat')), shown())
  const opened = app.calls.filter(call => call.startsWith('resumeTo')).length
  await app.click('ghost chat')
  check(
    'a conversation whose directory is gone reports it',
    await settled(() => shown().includes('working directory no longer exists'), { timeoutMs: 4_000 }),
    shown(),
  )
  check(
    'and opens nothing',
    app.calls.filter(call => call.startsWith('resumeTo')).length === opened,
    app.calls.join(', '),
  )

  app.write('\u001b[Z')
  await settled(() => shown().includes('Sessions in Alpha'))
  check('Shift+Tab from the first source returns to DSH', shown().includes('free session'), shown())
  app.close()
}

console.log('source tabs: a slow import respects where the user went meanwhile')
{
  // An import of a large conversation takes seconds. Closing the screen while
  // it runs is the user saying "not now": the import may finish, but it must
  // not pull the terminal into that session afterwards.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const app = await openSupervisor({ registry, cwd: alphaDir, foreign: { ...foreignConfig, importGate: gate } })
  const shown = (): string => app.lines().join('\n')
  await settled(() => (app.lines()[0] ?? '').includes('Claude Code'))
  await app.click('Claude Code')
  await settled(() => shown().includes('fix the parser'))
  await app.click('fix the parser')
  check(
    'the import started and says so',
    await settled(() => app.calls.includes('import:claude-code:cc-1') && shown().includes('Importing fix the parser')),
    shown(),
  )
  app.close()
  release()
  await settled(() => app.calls.includes('created:foreign-cc-1'), { timeoutMs: 4_000 })
  await sleep(150) // 固定窗:pacing 断言的是不该发生的打开，没有正向锚点可轮询
  check(
    'closing the screen before the import landed opens nothing',
    !app.calls.some(call => call.startsWith('resumeTo')),
    app.calls.join(', '),
  )
}
{
  // A notice belongs to the tab that asked: a failure landing after the user
  // moved to another source must not show up under it.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const app = await openSupervisor({ registry, cwd: alphaDir, foreign: { ...foreignConfig, importGate: gate } })
  const shown = (): string => app.lines().join('\n')
  await settled(() => (app.lines()[0] ?? '').includes('Claude Code'))
  await app.click('Claude Code')
  await app.click('dsh-tui-supervisor-ghost')
  await settled(() => shown().includes('ghost chat'))
  await app.click('ghost chat')
  await settled(() => app.calls.includes('import:claude-code:cc-3'))
  app.write('\t')
  await settled(() => shown().includes('Codex · sessions in Alpha'))
  release()
  await sleep(200) // 固定窗:pacing 断言的是不该出现的提示，没有正向锚点可轮询
  check(
    'an import failure that lands on another tab stays off it',
    shown().includes('codex refactor') && !shown().includes('working directory no longer exists'),
    shown(),
  )
  app.close()
}

console.log('source tabs: width degradation in the header')
{
  // Enough sources that the strip cannot fit next to the subtitle, and then
  // not even on its own: the subtitle goes, then the tail folds into `+N`.
  const many = Array.from({ length: 8 }, (_, index) => ({
    agentId: `src-${index}`,
    label: `Source Number ${index}`,
  }))
  const app = await openSupervisor({
    registry,
    cwd: alphaDir,
    foreign: {
      sources: many,
      rows: Object.fromEntries(many.map(source => [source.agentId, [foreignRow({ agentId: source.agentId, key: `${source.agentId}-row`, title: `row of ${source.label}` })]])),
    },
  })
  const header = (): string => app.lines()[0] ?? ''
  await settled(() => header().includes('Source Number 0'))
  check('a crowded header drops the subtitle', !header().includes('switching does not stop them'), header())
  const fold = /\+(\d+)/u.exec(header())
  check('trailing tabs fold into +N', fold !== null && Number(fold[1]) > 0, header())
  check('the last source is folded away', !header().includes('Source Number 7'), header())
  await app.click(`+${fold?.[1] ?? ''}`)
  check(
    'clicking +N lists the folded tabs',
    await settled(() => app.lines().join('\n').includes('Source Number 7')),
    app.lines().join('\n'),
  )
  await app.click('Source Number 7')
  check(
    'picking a folded tab activates it, and it stays drawn',
    await settled(() => app.lines().join('\n').includes('row of Source Number 7') && header().includes('Source Number 7')),
    app.lines().join('\n'),
  )
  app.close()
}

// ── the cache read re-scopes the in-memory slot on every mount ─────────────
//
// The slot is keyed by the CHANNEL, so it would otherwise outlive the provider
// it describes: the same Channel object can be re-bound to another store
// (service replacement, a workspace switch) between two mounts of this screen.
// Every mount that HAS the cache read re-scopes the slot from it, so a
// different snapshot paints — and `undefined`, "this provider's scope cannot
// be read", clears the rows the previous mount left behind. A channel WITHOUT
// the read keeps the slot: that is the pre-persistence path the reopen cases
// above still drive, not something a configured cache may break.

console.log('the cache read re-scopes the slot on every mount')
{
  // The scope changed under the same channel: another process listed, or the
  // channel was re-bound to another store. The mount must paint what the scope
  // says NOW, not the rows this channel's previous mount left in memory.
  const cache = cacheCell(sessions)
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const first = await mountSupervisor(target)
  check(
    'the first mount paints the scope it was given',
    await settled(() => first.lines().join('\n').includes('free session')),
    first.lines().join('\n'),
  )
  first.close()

  cache.rows = renamedSessions
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'a remount paints the re-scoped rows, not the ones this channel already had',
    await settled(() => {
      const shown = app.lines().join('\n')
      return shown.includes('renamed on disk') && !shown.includes('free session')
    }),
    app.lines().join('\n'),
  )
  gate.resolve()
  await settled(() => target.landed >= 2, { timeoutMs: 4_000 })
  app.close()
}
{
  // An unreadable scope is not a missing method: it clears the slot, so the
  // mount shows the loading path rather than rows belonging to a store this
  // channel no longer describes.
  const cache = cacheCell(sessions)
  const target = makeChannel({ registry, cwd: alphaDir, cache })
  const first = await mountSupervisor(target)
  await settled(() => first.lines().join('\n').includes('free session'))
  first.close()

  cache.rows = undefined
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'an unreadable scope clears the previous mount rows',
    await settled(() => app.lines().join('\n').includes(LOADING_PLACEHOLDER)),
    app.lines().join('\n'),
  )
  check('and none of the stale rows are painted', !app.lines().join('\n').includes('free session'))
  gate.resolve()
  check(
    'the listing then paints the scope it reads',
    await settled(() => app.lines().join('\n').includes('free session'), { timeoutMs: 4_000 }),
    app.lines().join('\n'),
  )
  app.close()
}

{
  // The contrast, and the reason the stub above omits the method rather than
  // answering `undefined`: a channel with NO cache read keeps its slot, so a
  // reopen still paints the previous listing instead of the placeholder.
  const target = makeChannel({ registry, cwd: alphaDir })
  const first = await mountSupervisor(target)
  await settled(() => first.lines().join('\n').includes('free session'))
  first.close()
  const gate = deferred()
  target.plan = { defer: gate.promise }
  const app = await mountSupervisor(target)
  check(
    'a channel without the cache read still reopens on its in-memory rows',
    await settled(() => app.lines().join('\n').includes('free session')),
    app.lines().join('\n'),
  )
  check('and shows no placeholder for them', !app.saw(LOADING_PLACEHOLDER))
  gate.resolve()
  await settled(() => target.landed >= 2, { timeoutMs: 4_000 })
  app.close()
}
console.log(failures === 0 ? '\nAll session-supervisor checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
