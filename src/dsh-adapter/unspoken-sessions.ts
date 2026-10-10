/**
 * The unspoken-session sweep: delete the shells no person ever spoke to.
 *
 * A TUI session is created before it is bound to an agent, so booting the app
 * (or switching workspaces, or opening the agent view) leaves a persisted
 * session behind that nothing ever said a word in. Those shells show up in
 * `dsh web`'s sidebar and pile up on disk. This module decides which of them
 * may be removed and removes them — once, on the way out.
 *
 * The decision is three conservative layers, and **any** layer that does not
 * pass spares the session (DESIGN D5 / ADR-0012 decision 1):
 *
 *  1. INDEX — the TUI's own `derived.hasPrompt === false`
 *     (`sessions/store.ts:61-89`, written from `sessions/digest.ts:152-209`).
 *     It is monotone and treats every unknown as "prompted", so `false`
 *     implies the whole human turn surface was empty when it was derived.
 *     A missing entry or a missing `derived` record is NOT a candidate.
 *  2. LOG — a bounded re-read of the artifact must find neither a
 *     `turn/start` nor a human `user/message`. The human rule is
 *     `digest.ts:66-98`'s (`source` absent/null or `{kind:'user'}` is human;
 *     `agent/inbox/spliced` entries with `role: 'user'` count too). An
 *     absent, dangling, corrupt or budget-truncated log proves nothing and
 *     spares the session. The reader drops seq-less header rows and rows
 *     marked `ignorable` (`compat/sessionLog.ts:821`); neither can hide human
 *     evidence here — `ignorable` is set only on unrecognised, purely
 *     informational records (`dsh-session/lib/types/types.d.ts:503-507`), and
 *     every conversational event type is a known one.
 *  3. PROCESS — the session this process is bound to, a live background
 *     session, any session a LIVE peer process holds in the mount ledger, and
 *     any delegated run or descendant of one are spared. The shipping delete
 *     primitive has no `kind`/`parentSession` check
 *     (`compat/sessionLog.ts:1280-1304`; see ADR-0012's note that only the UI
 *     filters sub-agents), so this layer is ours to add.
 *
 *     Delegation is decided from the candidate's **own header** — the first
 *     frame of its log, which carries `origin` / `parentSession` /
 *     `delegationDepth` (`sessions/header.ts:16-25`, `:102-113`) — because the
 *     install's listing is a boot-time snapshot: a delegated run created after
 *     it is in the index but in no listing, and a rule that reads only the
 *     listing hands that run to the delete primitive (REVIEW F-03). The listing
 *     keeps its own job, the **descendant closure**: a fork whose ancestor the
 *     listing (or the ancestor's own header) calls delegated is spared too. An
 *     UNREADABLE header adds no protection rather than a guess — the listing
 *     still speaks, and this read resolves the log through the same lookup the
 *     delete primitive uses, so a log whose header cannot be read is a log that
 *     primitive refuses to remove.
 *
 *     Cross-process holding comes from the same ledger the mount paths consult
 *     (`sessionMounts.readSessionOwners`, synchronous, dead pids already
 *     dropped): the delete entry points refuse a session a peer holds
 *     (`useSessionSupervisor.ts:610-616`), and an exit sweep that skipped that
 *     check could delete a session another terminal is still driving
 *     (REVIEW F-04).
 *
 *     The ledger only knows TUI mounts, so a session a NON-TUI writer holds is
 *     invisible to it: `dsh web` keeps its own "new session" placeholder in the
 *     shared store without ever writing the ledger, and that placeholder is a
 *     promptless shell with a real log — every layer above would collect it.
 *     The host's exclusive write lease is the arbiter that does cover it, and
 *     {@link UnspokenSweepDeps.writeLeaseFree} is how a caller that can afford
 *     the probe feeds it in (REVIEW CR-2, {@link provenWriteLeaseFree}). It is
 *     a separate fact from the ledger rather than more of it, and it reports
 *     its own reason, because the two disagree exactly where this bug lives.
 *
 * The action is the existing primitive plus the same per-session note cleanup
 * the picker's delete uses (`channel/session-metadata.ts:233-242`):
 * `deleteSessionLog` → `forgetSession` → `forgetAgentViewSession` → drop the
 * resume target when it names this session. The index is deliberately NOT
 * rewritten — `sessions/store.ts:253-259` documents that absence of a forget
 * path, and `sessions/list.ts:364-368` converges it on the next listing.
 * Projection caches and the workspace ledger are not session-scoped and are
 * never touched.
 *
 * The round is bounded, synchronous and fail-soft: at most
 * {@link DEFAULT_MAX_CANDIDATES} candidates and {@link DEFAULT_MAX_EVENTS_PER_LOG}
 * events per log are examined, a single failure is reported and skipped, and
 * nothing here throws, retries, or spawns a process — an exit path must never
 * be blocked by its own cleanup. Synchronous on purpose: an exit funnel can
 * call it inline without leaving pending I/O or an unawaited promise behind.
 * The one asynchronous fact it cannot produce itself is the host write lease,
 * so that is gathered BEFORE the round by {@link provenWriteLeaseFree} and
 * handed in as {@link UnspokenSweepDeps.writeLeaseFree}: the decision pipeline
 * stays a synchronous function of its facts.
 *
 * The four seeded channel actions (`/model`, `/fork`, `/rewind`, `/tree`) share
 * this module's reading of the cut they offer a child, so neither rule is
 * restated per action: {@link holdsNoConversation} decides whether that cut
 * holds a conversation at all, and {@link latestPolicyFacts} extracts the
 * policy facts a conversation-less cut still carries — the facts
 * {@link replayPolicyFacts} puts back into the unseeded child.
 *
 * @module @deepseek-harness-tui/dsh-tui/dsh-adapter/unspoken-sessions
 */
import { clearResumeTarget, forgetAgentViewSession, forgetSession, readResumeTarget } from '../sessionHistory.js'
import { deleteSessionLog, findSessionLogFile, readSessionEventsFromLog } from './compat/sessionLog.js'
import type { WriteLeaseState } from './compat/writeLease.js'
import { INITIAL_POLICY_EVENTS, isHumanSource } from './fresh-agent.js'
import { readHeader, type RawSessionHeader } from './sessions/header.js'
import { decodeFrame, readWindow, walkFrames } from './sessions/frames.js'
import { readIndex as readSessionIndex } from './sessions/store.js'

/** Candidates examined per round. Past it a shell is spared, not deleted. */
const DEFAULT_MAX_CANDIDATES = 512
/**
 * Events collected per log. A shell holds a handful; a conversation reaches
 * its `turn/start` within the first few. Anything longer than this cannot be
 * *proven* empty, so it is spared (`log-incomplete`).
 */
const DEFAULT_MAX_EVENTS_PER_LOG = 1024

/**
 * Bytes read from the head of one log to reach its first frame. The physical
 * header is the first line of the file (`compat/sessionLog.ts:809`), so this is
 * the head-window budget `sessions/digest.ts` already reads with; a first frame
 * larger than it reports "unknown", which on its own never deletes anything.
 */
const HEADER_WINDOW_BYTES = 64 * 1024

/** Shared empty set — "no ledger was read" must not allocate per round. */
const NO_SESSIONS: ReadonlySet<string> = new Set<string>()

/**
 * One session's physical header, from the first frame of its log.
 *
 * The first line of a session log IS the physical `session` record, and it
 * carries `origin` / `parentSession` / `delegationDepth`. The bounded EVENT
 * reader cannot serve it: physical header rows have no `seq`
 * (`compat/sessionLog.ts:821`), so they never reach `events`. This decodes only
 * the first frame of a 64 KiB head window, which makes one candidate one small
 * read instead of a full parse.
 *
 * The log is located exactly as the delete primitive locates it
 * ({@link findSessionLogFile} — the shipping compressed generations), so
 * "this read cannot see the header" and "the primitive cannot see the log"
 * are the same fact rather than two that can drift apart.
 *
 * Never throws: an absent, undecodable, misnamed or oversized-first-frame log
 * reports `undefined`, and the caller treats that as "no new information"
 * (see {@link UnspokenSweepDeps.readSessionHeader}).
 *
 * @param sessionId - Session whose header should be read.
 * @returns The narrowed header, or undefined when it cannot be read.
 */
export function readSessionHeaderFromLog(sessionId: string): RawSessionHeader | undefined {
  try {
    const path = findSessionLogFile(sessionId)
    if (path === undefined) return undefined
    const window = readWindow(path, HEADER_WINDOW_BYTES)
    if (window === undefined) return undefined
    const first = walkFrames(window.buffer, 0, 1)[0]
    if (first === undefined) return undefined
    const line = decodeFrame(window.buffer, first)?.[0]
    return line === undefined ? undefined : readHeader(line)
  } catch {
    return undefined
  }
}

/**
 * Whether a header marks a DELEGATED run — never a fork.
 *
 * `origin === 'subagent'` is upstream's own classification
 * (`sessions/header.ts:102-113`); a nonzero `delegationDepth` records the same
 * fact without it (upstream keeps that field optional, so requiring it would
 * under-mark). `parentSession` alone is deliberately NOT enough: a `/rewind`
 * fork records one exactly like a delegated child does, and a fork inherits its
 * ancestor's conversation — the log layer sees the inherited `turn/start` or
 * human message in the fork's own artifact and spares it there.
 * @param header - A narrowed header.
 * @returns True when the session is a delegated run.
 */
function isDelegatedHeader(header: RawSessionHeader): boolean {
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * One index entry, as much of it as layer ① reads. `SessionIndex` satisfies
 * this structurally.
 */
export interface UnspokenIndexEntry {
  readonly derived?: { readonly hasPrompt: boolean } | undefined
}

/**
 * A bounded log read, as much of it as layer ② reads. `SessionLogRead`
 * (`compat/sessionLog.ts:766-783`) satisfies this structurally.
 */
export interface UnspokenLogRead {
  readonly events: readonly unknown[]
  /** False when the read stopped at a budget: absence is unproven. */
  readonly complete: boolean
  /** True when an existing log could not be decoded at all. */
  readonly failed?: boolean
}

/** Why a session was spared. Every value means "keep it". */
export type UnspokenSkipReason =
  /** ① The index says a human prompted here, or cannot say otherwise. */
  | 'index-has-prompt'
  /** ① The entry carries no derived record. */
  | 'index-unknown'
  /** Bound: this round's candidate budget was already spent. */
  | 'candidate-cap'
  /** ② No artifact was found for the entry (missing or dangling). */
  | 'log-absent'
  /** ② The artifact exists but could not be decoded. */
  | 'log-unreadable'
  /** ② The read hit its event budget, so emptiness is unproven. */
  | 'log-incomplete'
  /** ② The log carries a `turn/start`. */
  | 'turn-start'
  /** ② The log carries a human message. */
  | 'human-message'
  /** ③ This process is bound to the session right now. */
  | 'current-session'
  /** ③ This process holds the session as a live background run. */
  | 'live-session'
  /** ③ The session is a delegated run or descends from one. */
  | 'subagent'
  /** ③ Another LIVE process holds the session in the mount ledger. */
  | 'held-elsewhere'
  /**
   * ③ A writer's exclusive lease on the session log is held by another
   * process, or could not be disproved. Distinct from `held-elsewhere` on
   * purpose: the ledger only knows TUI mounts, while this fact is the host
   * persistence layer's own arbiter — the one that sees `dsh web` (CR-2).
   */
  | 'write-leased'
  /** Sweep only: the delete primitive declined (absent or uncontained). */
  | 'delete-unavailable'
  /** A dependency threw; the session is spared rather than guessed at. */
  | 'unexpected-error'

/** One spared session and the layer that spared it. */
export interface UnspokenSkip {
  readonly id: string
  readonly reason: UnspokenSkipReason
}

export interface UnspokenCollection {
  /** Index entries that passed all three layers — deletion candidates. */
  readonly ids: readonly string[]
  /**
   * Every index entry that was not collected, with its reason. `ids` and
   * `skipped` partition the index, so nothing is silently dropped.
   */
  readonly skipped: readonly UnspokenSkip[]
}

export interface UnspokenSweepResult {
  /** Sessions whose log directory was actually removed, in index order. */
  readonly deleted: readonly string[]
  /** Everything spared, including deletes the primitive refused. */
  readonly skipped: readonly UnspokenSkip[]
}

/**
 * What the sweep cannot know from inside this module. The store-layer reads
 * (index, log, header) have real shipping defaults; the process-layer facts are
 * required, because a missing one would silently widen the delete set.
 * `occupiedElsewhere` is the one optional process fact: absent means no ledger
 * was consulted, which is what every caller but the exit path wants.
 */
export interface UnspokenSweepDeps {
  /** ① Index snapshot. Defaults to the TUI session index. */
  readonly readIndex?: () => ReadonlyMap<string, UnspokenIndexEntry>
  /** ② Bounded log read. Defaults to the shipping bounded reader. */
  readonly readLog?: (sessionId: string, maxEvents: number) => UnspokenLogRead | undefined
  /** ③ The session this process is bound to, if any. */
  readonly currentSessionId: () => string | undefined
  /** ③ Sessions this process still holds (live background runs). */
  readonly liveSessionIds: () => ReadonlySet<string>
  /** ③ Whether a session is a delegated run or a descendant of one. */
  readonly isSubagentOrDescendant: (sessionId: string) => boolean
  /**
   * ③ One candidate's own physical header. Defaults to
   * {@link readSessionHeaderFromLog}, so the shipping exit path reads it
   * without wiring anything.
   *
   * `undefined` means "no new information": the session is judged by the
   * listing lineage alone, exactly as before this source existed. That is safe
   * rather than optimistic because the default reader and the delete primitive
   * locate a log through the same lookup — a log whose header cannot be read
   * is a log the primitive refuses to remove (`delete-unavailable`).
   */
  readonly readSessionHeader?: (sessionId: string) => RawSessionHeader | undefined
  /**
   * ③ Sessions some OTHER live process holds, from the mount ledger
   * (`sessionMounts.readSessionOwners`, synchronous, dead pids already
   * dropped). Absent means no ledger was read — the shipping behaviour
   * everywhere except the exit path, which is the only caller that has one.
   */
  readonly occupiedElsewhere?: () => ReadonlySet<string>
  /**
   * ③ Whether this process PROVED that no writer holds the session log's
   * exclusive lease ({@link provenWriteLeaseFree}). True is a proof — only a
   * proof lets the session be removed; false, a throw, or an id this pre-pass
   * never proved all spare it with `write-leased`.
   *
   * Absent means the layer was not consulted, which is the shipping behaviour
   * of every caller but the exit path: the probe is a kernel round-trip per
   * candidate, so it is opted into rather than defaulted (see
   * {@link UnspokenSweepDeps.occupiedElsewhere} for the same shape).
   */
  readonly writeLeaseFree?: (sessionId: string) => boolean
  /** Remove one session's log directory. Defaults to `deleteSessionLog`. */
  readonly deleteLog?: (sessionId: string) => 'deleted' | 'unavailable'
  /** Forget a deleted session's notes. Defaults to the picker's own trio. */
  readonly forgetState?: (sessionId: string) => void
  /** Candidate budget for one round. */
  readonly maxCandidates?: number
  /** Event budget for one log read. */
  readonly maxEventsPerLog?: number
}

/**
 * The three decision rules as pure functions. `undefined` means the layer
 * passed. Injectable so the regression can drive this exact pipeline with
 * reversed rules and prove the assertions have discriminating power
 * (AC-7 ③, LESSONS L-044).
 *
 * `held` is the whole process layer: this process's binding and live runs, the
 * ledger's foreign holders, and the candidate's own header lineage. It is one
 * rule rather than four because every one of them answers the same question —
 * "may something else still be using this session?" — and the FIRST answer
 * wins, so the reported reason is deterministic.
 */
export interface UnspokenJudges {
  readonly index: (entry: UnspokenIndexEntry | undefined) => UnspokenSkipReason | undefined
  readonly log: (read: UnspokenLogRead | undefined) => UnspokenSkipReason | undefined
  readonly held: (sessionId: string) => UnspokenSkipReason | undefined
}

/**
 * The line a listed session descends from, for {@link delegatedSessionIds}.
 */
export interface UnspokenSessionLineage {
  readonly id: string
  /** True for a delegated run: `SessionKind.kind === 'subagent'`
   *  (`sessions/header.ts:102-113`) or a header with `origin: 'subagent'`. */
  readonly delegated?: boolean
  /** Its parent session, when the header records one (fork or delegated). */
  readonly parent?: string | undefined
}

/**
 * Ids that are delegated runs or descend from one, by walking the parent
 * links of one listing. A `/rewind` fork of a sub-agent is a descendant even
 * though it is a real conversation, and ADR-0012 excludes it either way.
 * @param sessions - One entry per listed session.
 * @returns Every id that layer ③ must spare.
 */
export function delegatedSessionIds(sessions: Iterable<UnspokenSessionLineage>): ReadonlySet<string> {
  const parentOf = new Map<string, string>()
  const delegated = new Set<string>()
  for (const session of sessions) {
    if (session.delegated === true) delegated.add(session.id)
    if (session.parent !== undefined && session.parent.length > 0) parentOf.set(session.id, session.parent)
  }
  // Closure over the links; each pass adds at least one id or stops, so this
  // terminates in at most one pass per session.
  for (let grew = true; grew;) {
    grew = false
    for (const [id, parent] of parentOf) {
      if (delegated.has(id) || !delegated.has(parent)) continue
      delegated.add(id)
      grew = true
    }
  }
  return delegated
}

/** The shipping rules, bound to the injected process-layer facts. */
export function unspokenJudges(deps: UnspokenSweepDeps): UnspokenJudges {
  const readSessionHeader = deps.readSessionHeader ?? readSessionHeaderFromLog
  /** Whether one session's own header marks it a delegated run. */
  const delegatedHeaderOf = (sessionId: string): boolean => {
    const header = readSessionHeader(sessionId)
    return header !== undefined && isDelegatedHeader(header)
  }
  let binding: {
    readonly current: string | undefined
    readonly live: ReadonlySet<string>
    readonly occupied: ReadonlySet<string>
  } | undefined
  return {
    index: entry =>
      entry?.derived === undefined ? 'index-unknown' : entry.derived.hasPrompt ? 'index-has-prompt' : undefined,
    log: read => {
      if (read === undefined) return 'log-absent'
      if (read.failed === true) return 'log-unreadable'
      if (!read.complete) return 'log-incomplete'
      for (const event of read.events) {
        const evidence = conversationEvidence(event)
        if (evidence !== undefined) return evidence
      }
      return undefined
    },
    held: sessionId => {
      binding ??= {
        current: deps.currentSessionId(),
        live: deps.liveSessionIds(),
        occupied: deps.occupiedElsewhere?.() ?? NO_SESSIONS,
      }
      if (sessionId === binding.current) return 'current-session'
      if (binding.live.has(sessionId)) return 'live-session'
      if (binding.occupied.has(sessionId)) return 'held-elsewhere'
      // The candidate's OWN header first: the listing is a boot-time snapshot,
      // so a delegated run created after it is named by no listing at all.
      const own = readSessionHeader(sessionId)
      if (own !== undefined && isDelegatedHeader(own)) return 'subagent'
      // Descendant closure. The listing's verdict on the ancestor comes first
      // (it covers whole chains); one hop up the candidate's own header chain
      // backs it up, because a listing that predates a delegated run cannot
      // name that run's descendants either.
      const parent = own?.parentSession
      if (parent !== undefined && (deps.isSubagentOrDescendant(parent) || delegatedHeaderOf(parent))) {
        return 'subagent'
      }
      return deps.isSubagentOrDescendant(sessionId) ? 'subagent' : undefined
    },
  }
}

/** The one judges instance {@link holdsNoConversation} asks; only `log` is used. */
const CUT_JUDGES = unspokenJudges({
  currentSessionId: () => undefined,
  liveSessionIds: () => new Set<string>(),
  isSubagentOrDescendant: () => false,
})

/**
 * The cut criterion the seeded channel actions share: does this cut inherit no
 * conversation at all? It is the exit sweep's own "did a person speak here"
 * rule, asked through {@link unspokenJudges}' `log` instead of restated — a
 * FOURTH human-speech rule is exactly what the three existing ones must not
 * become (KNOWN-ISSUES B-1).
 *
 * The judges' three process-layer facts are never read here: only `log` is
 * asked, and `held` reads them lazily, so they stay inert rather than
 * fabricated.
 *
 * @param events - The cut itself (the slice a child would inherit), never the
 *   session it was cut from.
 * @returns True when the cut holds only initialization.
 */
export function holdsNoConversation(events: readonly unknown[]): boolean {
  return CUT_JUDGES.log({ events, complete: true }) === undefined
}

/** One policy fact a cut carries: the recorded type and payload, verbatim. */
export interface PolicyFact {
  readonly type: string
  readonly data: unknown
}

/**
 * The policy facts a cut carries: the LAST value of each session-policy event
 * type, in the order the cut recorded them.
 *
 * A cut that holds no conversation is not an empty inheritance. The session's
 * plan mode, sandbox mode, approval policy and durable permission preset live
 * in the same prefix, and a child created without a seed falls back to the
 * deployment defaults — which may be WIDER than the session it was cut from.
 * That is why the four seeded channel actions replay these facts into the
 * unseeded branch before the child's first real event.
 *
 * The four types are the deferral's own {@link INITIAL_POLICY_EVENTS},
 * imported rather than restated: appending a type the deferral does NOT ignore
 * starts it and publishes the permission-only shell the unseeded branch exists
 * to avoid. One value per type is enough because every consumer of these
 * events folds them last-wins (`mode-actions.ts`'s folds, `dsh-plan-mode`'s
 * log projection, `dsh-sandbox-policy`'s `sandboxMode` unit,
 * `dsh-user-approval`'s `overrideOf`), so the replay reproduces the cut's
 * effective policy exactly — and in the cut's own relative order, so the pair
 * means the same thing in the child's log.
 *
 * @param events - The cut itself (the slice a child would inherit).
 * @returns One fact per policy type the cut recorded, in recording order.
 */
export function latestPolicyFacts(events: readonly unknown[]): readonly PolicyFact[] {
  const lastAt = new Map<string, number>()
  for (const [index, event] of events.entries()) {
    const type = policyEventType(event)
    if (type !== undefined) lastAt.set(type, index)
  }
  return [...lastAt]
    .sort(([, left], [, right]) => left - right)
    .map(([type, index]) => ({ type, data: (events[index] as { readonly data: unknown }).data }))
}

/**
 * Replay a cut's policy facts into a child created WITHOUT a seed.
 *
 * Call this AFTER the factory returns and BEFORE the child's first real event.
 * Never from inside `setup`: `fresh-agent.ts:72` arms the deferral only while
 * the session is still at `seq === 0`, so an event appended there leaves the
 * gate uninstalled in silence and the child is stored immediately
 * (KNOWN-ISSUES B-14 ①). After the factory the gate is armed, and the four
 * policy types are exactly the ones it ignores, so the child stays unpublished
 * until it has something a person can see.
 *
 * The append is the same durable write path the mode and permission actions
 * already use (`mode-actions.ts`: one `session.append(type, data)` per fact);
 * these events are copied from the cut, never manufactured.
 *
 * @param session - The child's live session.
 * @param events - The cut the child was made from.
 * @returns The facts appended, in order.
 */
export function replayPolicyFacts(session: unknown, events: readonly unknown[]): readonly PolicyFact[] {
  const facts = latestPolicyFacts(events)
  if (facts.length === 0) return facts
  const target = session as { append(type: string, data: unknown): unknown }
  for (const fact of facts) target.append(fact.type, fact.data)
  return facts
}

/**
 * One event's type when it is a policy fact the deferral holds back, else
 * undefined. The vocabulary is `fresh-agent.ts`'s, so this cannot drift from
 * the set whose membership makes the replay safe.
 */
function policyEventType(event: unknown): string | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined
  const type = (event as { readonly type?: unknown }).type
  return typeof type === 'string' && INITIAL_POLICY_EVENTS.has(type) ? type : undefined
}

/**
 * What one collected event proves about whether a person ever spoke here.
 * Mirrors `digest.ts:66-98`; the one deliberate widening covers a KNOWN type
 * whose payload this code cannot read — that counts as human evidence, because
 * "the log does not say" must never become "the log says no" on an
 * irreversible action. An event whose `type` is unknown stays outside that
 * widening and proves nothing, exactly as any other unrelated event does.
 */
function conversationEvidence(event: unknown): 'turn-start' | 'human-message' | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined
  const envelope = event as Record<string, unknown>
  const type = envelope['type']
  if (type === 'turn/start') return 'turn-start'
  if (type !== 'user/message' && type !== 'agent/inbox/spliced') return undefined
  const data = envelope['data']
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'human-message'
  const record = data as Record<string, unknown>
  if (type === 'user/message') return isHumanSource(record['source']) ? 'human-message' : undefined
  const inserted = record['inserted']
  if (!Array.isArray(inserted)) return 'human-message'
  for (const message of inserted) {
    if (message === null || typeof message !== 'object') continue
    const entry = message as Record<string, unknown>
    if (entry['role'] === 'user' && isHumanSource(entry['source'])) return 'human-message'
  }
  return undefined
}

/**
 * Decide which indexed sessions are unspoken shells. Read-only: the same
 * fixtures can be judged more than once (and by reversed judges).
 *
 * @param deps - The store seams and the process-layer facts.
 * @param judges - The decision rules. Overridden only to prove their
 *   discriminating power; production always uses {@link unspokenJudges}.
 * @returns The candidates and the full spared partition of the index.
 */
export function collectUnspokenSessionIds(
  deps: UnspokenSweepDeps,
  judges: UnspokenJudges = unspokenJudges(deps),
): UnspokenCollection {
  const ids: string[] = []
  const skipped: UnspokenSkip[] = []
  const readIdx: () => ReadonlyMap<string, UnspokenIndexEntry> = deps.readIndex ?? readSessionIndex
  const readLog: (sessionId: string, maxEvents: number) => UnspokenLogRead | undefined = deps.readLog ?? readSessionEventsFromLog
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const maxEventsPerLog = deps.maxEventsPerLog ?? DEFAULT_MAX_EVENTS_PER_LOG
  let index: ReadonlyMap<string, UnspokenIndexEntry>
  try {
    index = readIdx()
  } catch {
    // An unreadable index is not an empty index: spare everything.
    return { ids, skipped }
  }
  // A stable order, so a bounded round always makes the same choice.
  const entries = [...index.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  let examined = 0
  for (const [id, entry] of entries) {
    try {
      const indexed = judges.index(entry)
      if (indexed !== undefined) {
        skipped.push({ id, reason: indexed })
        continue
      }
      if (examined >= maxCandidates) {
        skipped.push({ id, reason: 'candidate-cap' })
        continue
      }
      examined += 1
      const logged = judges.log(readLog(id, maxEventsPerLog))
      if (logged !== undefined) {
        skipped.push({ id, reason: logged })
        continue
      }
      const held = judges.held(id)
      if (held !== undefined) {
        skipped.push({ id, reason: held })
        continue
      }
      ids.push(id)
    } catch {
      // One broken dependency costs one candidate, never the round.
      skipped.push({ id, reason: 'unexpected-error' })
    }
  }
  return { ids, skipped }
}

/**
 * One session's write-lease probe: the session and the `cwd` its own header
 * records, resolving to what the host's arbiter answered.
 */
export type WriteLeaseProbe = (sessionId: string, cwd: string) => Promise<WriteLeaseState>

/**
 * The write-lease pre-pass: prove which unspoken index entries no writer holds,
 * one kernel probe per entry.
 *
 * The round itself must stay synchronous (an exit funnel calls it inline), and
 * a lease can only be asked for asynchronously — so the one process fact that
 * needs a round-trip is gathered here, before the round, exactly as the other
 * process-layer facts are: as data the synchronous pipeline reads.
 *
 * Only layer ①'s surface is probed, because a candidate's lease cannot be
 * named before its `cwd` is known and that comes from its own log header: the
 * entries that pass "no person prompted here" are the only ones the round can
 * ever collect. Nothing is deleted here and nothing is cached across rounds —
 * the answer is a predicate over this round's observations.
 *
 * Bounded and fail-soft by construction: at most
 * {@link DEFAULT_MAX_CANDIDATES} entries, in the round's own stable order with
 * the round's own cap, so a bounded exit probes what the round would examine. A
 * missing `cwd` or a failing probe costs that entry alone, an index this read
 * cannot produce proves nothing at all — and an unproven session is spared.
 *
 * @param probe - One session's lease probe ({@link WriteLeaseProbe}).
 * @param deps - The store seams this pre-pass reads. The defaults are the
 *   shipping index and the shipping header reader, so the exit path injects
 *   nothing; a regression injects the same fixtures its round uses.
 * @returns A predicate: true only for ids this round PROVED unheld.
 */
export async function provenWriteLeaseFree(
  probe: WriteLeaseProbe,
  deps: Pick<UnspokenSweepDeps, 'readIndex' | 'readSessionHeader' | 'maxCandidates'> = {},
): Promise<(sessionId: string) => boolean> {
  const free = new Set<string>()
  const readIdx: () => ReadonlyMap<string, UnspokenIndexEntry> = deps.readIndex ?? readSessionIndex
  const readHeader: (sessionId: string) => RawSessionHeader | undefined = deps.readSessionHeader ?? readSessionHeaderFromLog
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  let index: ReadonlyMap<string, UnspokenIndexEntry>
  try {
    index = readIdx()
  } catch {
    // An unreadable index is not an empty index: it proves nothing.
    return () => false
  }
  const entries = [...index.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  let examined = 0
  for (const [id, entry] of entries) {
    if (entry.derived === undefined || entry.derived.hasPrompt) continue
    if (examined >= maxCandidates) break
    examined += 1
    try {
      const cwd = readHeader(id)?.cwd
      if (cwd === undefined) continue
      if (await probe(id, cwd) === 'free') free.add(id)
    } catch {
      // One unprovable entry costs that entry; the round still runs on the rest.
    }
  }
  return id => free.has(id)
}

/**
 * Collect, then delete. Never throws; a refused or throwing delete is
 * reported as `delete-unavailable` and leaves the artifact in place.
 *
 * The last gate before the primitive is the write-lease proof, when the caller
 * supplied one: a candidate whose log may still be held is spared here rather
 * than collected-and-deleted, so the ledger's `held-elsewhere` and the host
 * lease's `write-leased` stay separately reportable.
 *
 * @param deps - See {@link collectUnspokenSessionIds}.
 * @param judges - See {@link collectUnspokenSessionIds}.
 * @returns The deleted ids and the full spared partition.
 */
export function sweepUnspokenSessions(
  deps: UnspokenSweepDeps,
  judges: UnspokenJudges = unspokenJudges(deps),
): UnspokenSweepResult {
  const collected = collectUnspokenSessionIds(deps, judges)
  const deleted: string[] = []
  const skipped: UnspokenSkip[] = [...collected.skipped]
  const removeLog: (sessionId: string) => 'deleted' | 'unavailable' = deps.deleteLog ?? deleteSessionLog
  const forgetState = deps.forgetState ?? defaultForgetState
  const writeLeaseFree = deps.writeLeaseFree
  for (const id of collected.ids) {
    if (writeLeaseFree !== undefined) {
      let free: boolean
      try {
        free = writeLeaseFree(id)
      } catch {
        // A proof that throws is not a proof; the session stays.
        free = false
      }
      if (!free) {
        skipped.push({ id, reason: 'write-leased' })
        continue
      }
    }
    let outcome: 'deleted' | 'unavailable'
    try {
      outcome = removeLog(id)
    } catch {
      outcome = 'unavailable'
    }
    if (outcome !== 'deleted') {
      skipped.push({ id, reason: 'delete-unavailable' })
      continue
    }
    deleted.push(id)
    try {
      forgetState(id)
    } catch {
      // The notes are a cache; the log this session was is already gone.
    }
  }
  return { deleted, skipped }
}

/**
 * The per-session notes the picker's delete also drops
 * (`channel/session-metadata.ts:233-242`). Best effort by construction —
 * every callee swallows its own failures.
 */
function defaultForgetState(sessionId: string): void {
  forgetSession(sessionId)
  forgetAgentViewSession(sessionId)
  if (readResumeTarget() === sessionId) clearResumeTarget()
}
