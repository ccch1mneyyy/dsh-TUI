import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sessionCwdMatches } from './paths.js'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { t } from '../../i18n.js'
import {
  defaultMaxScanned,
  liveSessionListingFields,
  readPhysicalHeaderSeedLength,
  readPhysicalHeaderSeedLengthForSession,
  readSessionEventsFromFile,
  readSessionEventsFromLog,
} from '../compat/index.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { readPersistedSession, type SessionReader } from '../compat/persistence.js'
import { enumerateSessions, readInheritedCut, type SessionSource, type RawSessionHeader } from '../sessions/index.js'
import { buildSessionTree, liveTailWindow, type FamilySession, type SessionTreeData } from '../sessionTree.js'
import type { ChannelUi } from '../../adapter/ports/channel-ui.js'
import type { ChannelOwner } from './owner.js'

/** Bounded family-tree assembly owns budgets; binding remains the caller's authority. */
export function createSessionTreeReader(ctx: Context, binding: { readonly agent: Agent }, cwd: () => string, notify: ChannelUi['notify'], owner: ChannelOwner) {
async function readTree(): Promise<SessionTreeData | null> {
      const persistence = ctx.get('sessionPersistence') as
        | (SessionSource & SessionReader & {
          // Optional at runtime: fakes and third-party backends may not
          // implement the full coordinator surface.
          inspect?(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
        })
        | undefined
      if (!persistence) {
        notify(t('tree-unavailable'), { color: 'error' })
        return null
      }
      // Pin the live session snapshot NOW: every await below (list/inspect)
      // is a window in which a fire-and-forget switch (/new, /resume,
      // /model) can swap `agent`. Reading agent.session piecemeal would
      // stitch the NEW session's events under the OLD session's id — a
      // confirm would then rewind from the wrong persisted log. Everything
      // below reads this snapshot, and the result is discarded if the live
      // session moved on before the build finished.
      const liveSession = binding.agent.session
      const currentId = String(liveSession.id)
      // Same enumerate as the /resume listing (snapshots when the backend
      // offers revisions, plain list otherwise), each header narrowed through
      // the sessions reader — one malformed header costs that session its
      // metadata, never the whole tree. `raw` stays the backend's own header
      // object for locate() below.
      let listed: { header: RawSessionHeader; raw: unknown }[] = []
      try {
        listed = await enumerateSessions(persistence)
      } catch {
        // A listing failure degrades the tree to the live session only.
      }
      // Same cwd scoping as /resume (Claude Code's project dimension): forks
      // inherit cwd, so the family never crosses projects — and the match is
      // the project-aware one /resume uses, so a pre-upgrade subdirectory
      // path, Windows separators, or a case variant on one header cannot
      // quietly amputate the ancestors and siblings it records. Subagent
      // child sessions carry parentSession too, but they are delegation
      // artifacts, not rewind branches — exclude them from the family.
      const local = listed.filter(entry =>
        sessionCwdMatches(cwd(), entry.header.cwd ?? '') &&
        entry.header.origin !== 'subagent' &&
        (entry.header.delegationDepth ?? 0) === 0,
      )
      const headerById = new Map(local.map(entry => [entry.header.id, entry]))
      // The live session's header may not be materialized in list() yet
      // (the jsonl backend writes on first append) — overlay the in-memory
      // header so the ancestor walk below still finds a fresh fork's parent.
      const liveListed = liveSessionListingFields(liveSession)
      const liveMeta = (liveSession as { header?: SessionHeader }).header
      if (!headerById.has(currentId) && liveListed.id !== undefined) {
        headerById.set(currentId, {
          header: {
            id: liveListed.id,
            cwd: liveListed.cwd,
            createdAt: liveListed.createdAt,
            parentSession: liveListed.parentSession,
            origin: liveListed.origin,
            delegationDepth: liveListed.delegationDepth,
            seedLength: liveListed.seedLength,
            agentPreset: liveListed.agentPreset,
          },
          raw: liveMeta,
        })
      }
      // Family = the live session's ancestor chain PLUS every descendant of
      // its topmost known ancestor (siblings and cousins included).
      const childrenByParent = new Map<string, string[]>()
      for (const entry of local) {
        if (entry.header.parentSession === undefined) continue
        const list = childrenByParent.get(entry.header.parentSession)
        if (list === undefined) childrenByParent.set(entry.header.parentSession, [entry.header.id])
        else list.push(entry.header.id)
      }
      const ancestorIds: string[] = []
      {
        const visited = new Set<string>([currentId])
        let cursor = headerById.get(currentId)
        while (cursor?.header.parentSession !== undefined) {
          const parentId = cursor.header.parentSession
          if (visited.has(parentId)) break
          visited.add(parentId)
          if (!headerById.has(parentId)) break
          ancestorIds.push(parentId)
          cursor = headerById.get(parentId)
        }
      }
      // BFS from the topmost ancestor. The scan must NOT be gated by family
      // membership: ancestor-chain nodes are already in the family, and
      // skipping them here would never enumerate their other children —
      // siblings/cousins forking off a MIDDLE ancestor would be lost.
      const family = new Set<string>([currentId, ...ancestorIds])
      {
        const scanned = new Set<string>()
        const queue = [ancestorIds.at(-1) ?? currentId]
        while (queue.length > 0) {
          const id = queue.shift()!
          if (scanned.has(id)) continue
          scanned.add(id)
          family.add(id)
          for (const child of childrenByParent.get(id) ?? []) {
            queue.push(child)
          }
        }
      }
      // Processing order is TOPOLOGICAL (a parent before its children): the
      // coverage bookkeeping below — which seq range each chain already
      // shows — feeds the next read's inherited-prefix skip, so a parent
      // must be read before its forks. Within each sibling group the live
      // chain wins, then newest first (the same priority the read budget
      // always had).
      const ancestorSet = new Set(ancestorIds)
      const priorityOf = (a: string, b: string): number => {
        const aChain = a === currentId || ancestorSet.has(a)
        const bChain = b === currentId || ancestorSet.has(b)
        if (aChain !== bChain) return aChain ? -1 : 1
        return (headerById.get(b)?.header.createdAt ?? 0) - (headerById.get(a)?.header.createdAt ?? 0)
      }
      const kidsOf = new Map<string, string[]>()
      const familyRoots: string[] = []
      for (const id of family) {
        const parentId = headerById.get(id)?.header.parentSession
        if (parentId !== undefined && parentId !== id && family.has(parentId)) {
          const list = kidsOf.get(parentId)
          if (list === undefined) kidsOf.set(parentId, [id])
          else list.push(id)
        } else {
          familyRoots.push(id)
        }
      }
      familyRoots.sort(priorityOf)
      for (const list of kidsOf.values()) list.sort(priorityOf)
      const ordered: string[] = []
      {
        const seen = new Set<string>()
        const stack = [...familyRoots].reverse()
        while (stack.length > 0) {
          const id = stack.pop()!
          if (seen.has(id)) continue
          seen.add(id)
          ordered.push(id)
          const kids = kidsOf.get(id)
          if (kids !== undefined) {
            for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
          }
        }
        // Cycle-broken leftovers (corrupt parent headers) — never drop one.
        for (const id of [...family].sort(priorityOf)) {
          if (!seen.has(id)) ordered.push(id)
        }
      }
      // Caps: the ancestor chain + live session ALWAYS stay selected — the
      // structural invariant (the live branch must reach the family root)
      // outranks the session cap, which therefore evicts only non-ancestors.
      // The event budget bounds the READ cost too: non-live logs decode
      // lazily and stop at the remaining budget (see below), the live
      // session keeps only its tail.
      const MAX_TREE_SESSIONS = 24
      const MAX_TREE_EVENTS = 200_000
      // The event budget alone does NOT bound read cost: skipped envelopes
      // (ignorable frames, headers) are paid for but never collected, so a
      // noisy log can return ZERO events and leave the next log a full scan
      // allowance — 23 logs × ~800k envelopes would block the TUI for
      // seconds. scanBudget caps the TOTAL envelopes inspected across all
      // logs (the reader reports its real scanned count); per-log caps
      // derive from the event budget as before, and the smaller of the two
      // applies, so one flood cannot starve every later sibling either.
      const MAX_TREE_SCANNED = defaultMaxScanned(MAX_TREE_EVENTS)
      let scanBudget = MAX_TREE_SCANNED
      const selected = new Set<string>()
      let slots = MAX_TREE_SESSIONS
      for (const id of ordered) {
        const chain = id === currentId || ancestorSet.has(id)
        if (chain || slots > 0) {
          selected.add(id)
          if (!chain) slots -= 1
        }
      }
      // The live session's events come from memory (its header may not be
      // materialized yet — the jsonl backend writes on first append).
      const liveHeader = headerById.get(currentId)
      const familySessions: FamilySession[] = []
      let truncated = selected.size < family.size
      let eventBudget = 0
      // Coverage bookkeeping: coveredThrough(S) = the highest K such that
      // [0..K] is already displayed by S's chain or an ancestor's. A fork's
      // inherited seed prefix duplicates that range, so non-live reads SKIP
      // it (the reader's skipBelowSeq): the prefix still costs scan budget
      // (its bytes are read and parsed) but NOT the event budget — a fork
      // of a huge parent pays only for its OWN events, so two small forks
      // of a 70k-event parent both stay visible. Unreadable/unloaded
      // sessions are transparent: they claim nothing beyond what their own
      // ancestors covered, so a fork of a dead branch dedups against the
      // grandparent instead of hiding its self-contained history.
      const coveredThrough = new Map<string, number>()
      for (const id of ordered) {
        if (!selected.has(id)) continue
        const entry = headerById.get(id)
        if (id === currentId) {
          const liveParentId = liveHeader?.header.parentSession ?? liveListed.parentSession
          const liveParent = liveParentId !== undefined ? String(liveParentId) : undefined
          const liveEvents = snapshotLiveSessionEvents(liveSession)
          const remaining = Math.max(0, MAX_TREE_EVENTS - eventBudget)
          // The live session's in-memory log is SELF-CONTAINED: a fork's
          // events still carry the inherited seed prefix, which the parent's
          // chain already displays (and already charged to the budget).
          // Skipping it exactly like the non-live reads do keeps a live fork
          // of a huge parent from spending the whole family budget on
          // duplicated history and evicting its own siblings.
          const liveSeed = liveHeader?.header.seedLength ?? liveListed.seedLength
          // A recorded parent without an exact cut is not a usable coverage
          // edge: the pure tree detaches it, so forwarding the parent's range
          // here would let descendants skip history no root displays.
          const parentCovered = liveParent !== undefined && liveSeed !== undefined
            ? (coveredThrough.get(liveParent) ?? -1)
            : -1
          const skipBelow =
            liveParent !== undefined && liveSeed !== undefined
              ? Math.min(liveSeed, parentCovered + 1)
              : 0
          const own = skipBelow > 0
            ? liveEvents.filter(event => event.seq >= skipBelow || event.type === 'session/title')
            : liveEvents
          // A live session larger than the remaining budget keeps its TAIL,
          // aligned to whole turns (sessionTree.liveTailWindow): leftover
          // entries of a turn whose turn/start was cut away render as
          // selectable rows that can never rewind; a window holding no
          // turn/start at all (one oversized LAST turn spans the budget)
          // retries over the earlier complete turns instead of blacking the
          // session out. Rewind itself never reads this copy (rewindToNode
          // forks the real session), so the slice only narrows what the tree
          // can display.
          const events = liveTailWindow(own, remaining)
          // Charge the KEPT tail, not the in-memory length: extraction only
          // ever touches `events`, and charging the full log would black out
          // every other family member's budget behind a discarded prefix.
          eventBudget += events.length
          if (events.length !== own.length) truncated = true
          familySessions.push({
            id,
            createdAt: liveHeader?.header.createdAt ?? liveListed.createdAt ?? Date.now(),
            ...(liveParent !== undefined ? { parentSession: liveParent } : {}),
            ...(liveHeader?.header.seedLength !== undefined || liveListed.seedLength !== undefined
              ? { seedLength: liveHeader?.header.seedLength ?? liveListed.seedLength }
              : {}),
            events,
            live: true,
            // The in-memory log always reaches the tip (liveTailWindow trims
            // the head only), so the adopt/warning UX facts are derivable.
            tailComplete: true,
          })
          // A kept tail cut off the front connects to nothing — coverage
          // stays at the parent's (a fork of the live session re-reads the
          // hidden prefix from its own log).
          const firstKept = events.length > 0 ? events[0]!.seq : Number.POSITIVE_INFINITY
          const lastKept = events.length > 0 ? events[events.length - 1]!.seq : -1
          coveredThrough.set(
            id,
            firstKept <= parentCovered + 1 ? Math.max(parentCovered, lastKept) : parentCovered,
          )
          continue
        }
        const header = entry?.header
        const parentId = header?.parentSession
        const structuralParentCovered = parentId !== undefined ? (coveredThrough.get(parentId) ?? -1) : -1
        const locate = persistence.locate
        const hasLocate = typeof locate === 'function'
        let locatedPath: string | undefined
        if (hasLocate && entry !== undefined) {
          try {
            const location: unknown = locate.call(persistence, entry.raw)
            // Only the jsonl kind enters the compat file layer — a foreign
            // kind's artifact is the backend's own format (inspect below).
            if (location !== null && typeof location === 'object') {
              const record = location as { kind?: unknown; path?: unknown }
              if (record.kind === 'jsonl' && typeof record.path === 'string') {
                locatedPath = record.path
              }
            }
          } catch {
            // Best effort — a locate hiccup falls through to inspect.
          }
        }
        // Alpha.4 deliberately omits the inherited cut from logical list
        // headers. Resolve it only for the SELECTED family node currently
        // being read: JSONL keeps the exact physical `seedLength`; non-file
        // backends expose the cut on inspect below. Never scan every listed
        // session and never infer it from an end-seed marker or log length.
        let inheritedCut = parentId === undefined ? undefined : readInheritedCut(entry?.raw)
        if (parentId !== undefined && inheritedCut === undefined) {
          inheritedCut = locatedPath !== undefined
            ? readPhysicalHeaderSeedLength(locatedPath)
            : !hasLocate
                ? readPhysicalHeaderSeedLengthForSession(id)
                : undefined
        }
        // Keep structural ancestry separate from proven dedup coverage. The
        // model layer detaches a parent edge whose exact cut is unavailable;
        // treating that edge as covered here would hide a child's prefix
        // under a parent root that no longer owns it.
        let parentCovered = parentId !== undefined && inheritedCut !== undefined
          ? structuralParentCovered
          : -1
        // Never skip past the seed prefix: events beyond it are this
        // session's OWN — no ancestor can show them. A parent that was never
        // read (evicted, or outside the family) covers nothing (skip 0).
        let skipBelow =
          parentId !== undefined && inheritedCut !== undefined
            ? Math.min(inheritedCut, parentCovered + 1)
            : 0
        let facts: FamilySession = {
          id,
          createdAt: header?.createdAt ?? 0,
          events: [],
          live: false,
          ...(parentId !== undefined ? { parentSession: parentId } : {}),
          ...(inheritedCut !== undefined ? { seedLength: inheritedCut } : {}),
        }
        if (eventBudget >= MAX_TREE_EVENTS || scanBudget <= 0) {
          // Budget spent: keep the STRUCTURE — the session degrades to an
          // unloaded placeholder so its branch (and any ancestor chain
          // through it) stays visible instead of vanishing from the tree.
          truncated = true
          familySessions.push({ ...facts, events: [], live: false, unloaded: true })
          coveredThrough.set(id, parentCovered)
          continue
        }
        // Read-only, tolerant, bounded: the compat reader decodes frames
        // lazily and stops at the remaining event budget. Browsing the tree
        // must never REWRITE history logs (the ignorable-marking repair
        // stays on the explicit resume/rewind path), and the strict backend
        // inspect would both reject third-party event types wholesale and
        // parse chunk-heavy logs whole. Header facts come from list().
        const remaining = MAX_TREE_EVENTS - eventBudget
        // Source precedence, all read-only:
        //  1. persistence.locate — the backend's OWN artifact resolution is
        //     authoritative (custom root, workspace-key scheme). When it
        //     names a path, ONLY that file is read: falling back to a
        //     same-id copy under the stock root could surface a STALE log
        //     from another backend configuration. A locate miss or an ABSENT
        //     file falls through to inspect, never to the stock scan.
        //  2. Stock root scan — only for backends WITHOUT locate (fakes,
        //     older custom implementations).
        //  3. inspect — the backend's strict read (non-file backends), with
        //     the same budget enforced on what we keep — and ONLY when the
        //     file read found NOTHING (undefined). A read that failed on a
        //     safety cap or corruption (failed) must never escalate here:
        //     inspect parses the WHOLE log up front, so falling through
        //     would re-read unboundedly exactly the logs the caps exist to
        //     bound (64 MiB frames, decode bombs) — degrade to a placeholder
        //     instead.
        let events: readonly SessionEvent[] | undefined
        let physicalVersion: number | undefined
        let complete = true
        let failed = false
        // First seq the chosen source actually covers: the file readers start
        // at the inherited-prefix skip, inspect always hands the whole log.
        let readFrom = 0
        // Per-log scan allowance: the usual 4×-of-remaining derivation,
        // clamped to what the tree-level scan budget still has.
        const scanAllowance = Math.min(defaultMaxScanned(remaining), scanBudget)
        if (hasLocate) {
          if (locatedPath !== undefined) {
            const viaPath = readSessionEventsFromFile(locatedPath, remaining, scanAllowance, skipBelow)
            if (viaPath !== undefined) {
              physicalVersion = viaPath.formatVersion
              scanBudget -= viaPath.scanned
              if (viaPath.failed === true) failed = true
              else {
                events = viaPath.events
                complete = viaPath.complete
                readFrom = skipBelow
              }
            }
          }
        } else if (!hasLocate) {
          const read = readSessionEventsFromLog(id, remaining, scanAllowance, skipBelow)
          if (read !== undefined) {
            physicalVersion = read.formatVersion
            scanBudget -= read.scanned
            if (read.failed === true) failed = true
            else {
              events = read.events
              complete = read.complete
              readFrom = skipBelow
            }
          }
        }
        // Raw historical files use pre-migration seq coordinates. Normalize
        // only a fully budget-checked file through the same read handle used
        // by rewind/fork. Failed or truncated reads never escalate to a full
        // backend parse, and cannot lend old coordinates to a V3 child.
        const needsMigration = typeof persistence.open === 'function'
          && physicalVersion !== liveSession.header.version
        if (needsMigration && !complete) {
          failed = true
          truncated = true
        }
        if (!failed && typeof persistence.open === 'function' && (events === undefined || needsMigration)) {
          try {
            const inspection = await readPersistedSession(persistence, SessionId(id))
            if (inspection.meta.version !== liveSession.header.version) throw new Error('session tree generation mismatch')
            inheritedCut = parentId === undefined ? undefined : readInheritedCut(inspection)
            parentCovered = inheritedCut === undefined ? -1 : structuralParentCovered
            skipBelow = inheritedCut === undefined ? 0 : Math.min(inheritedCut, parentCovered + 1)
            facts = { ...facts, seedLength: inheritedCut }
            scanBudget -= inspection.events.length
            const all = inspection.events.filter(event => event.seq >= skipBelow || event.type === 'session/title')
            events = all.slice(0, remaining)
            complete = all.length <= remaining
            readFrom = skipBelow
          } catch {
            failed = true
          }
        }
        if (needsMigration && failed) {
          // Preserve the branch as a non-actionable placeholder. Its original
          // inherited cut is not comparable to normalized family coordinates.
          inheritedCut = undefined
          parentCovered = -1
          facts = { ...facts, seedLength: undefined }
        }
        if (!failed && events === undefined && typeof persistence.inspect === 'function') {
          try {
            const inspection = await persistence.inspect(SessionId(id))
            const inspectedCut = readInheritedCut(inspection)
            if (parentId !== undefined && inheritedCut === undefined && inspectedCut !== undefined) {
              inheritedCut = inspectedCut
              parentCovered = structuralParentCovered
              skipBelow = parentId !== undefined
                ? Math.min(inheritedCut, parentCovered + 1)
                : 0
              facts = { ...facts, seedLength: inheritedCut }
            }
            // inspect parses the WHOLE log up front: charge the full length
            // to the scan budget (may overdraw; the next iterations skip).
            scanBudget -= inspection.events.length
            // Non-file backends hand back the self-contained log from seq 0:
            // the inherited-prefix skip the file readers got must apply here
            // too, or a long prefix would fill the slice and the branch's OWN
            // events — the only ones nobody else displays — would be cut.
            const all = skipBelow > 0
              ? inspection.events.filter(event => event.seq >= skipBelow || event.type === 'session/title')
              : inspection.events
            readFrom = skipBelow
            events = all
            if (events.length > remaining) {
              events = events.slice(0, remaining)
              complete = false
            }
          } catch {
            events = undefined
          }
        }
        if (failed || events === undefined) {
          // An unreadable log keeps the branch structure, no entries — and
          // stays transparent for coverage, so a fork of this branch dedups
          // against the grandparent instead of hiding its own history.
          familySessions.push({ ...facts, events: [], live: false, unreadable: true })
          coveredThrough.set(id, parentCovered)
          continue
        }
        eventBudget += events.length
        if (!complete) truncated = true
        // tailComplete gates the branch-adopt target and the drop-turn
        // warning: a budget-sliced read lost the tail, and a tip computed
        // from it would fork mid-branch while claiming to keep everything.
        familySessions.push({ ...facts, events, live: false, ...(complete ? { tailComplete: true } : {}) })
        const lastRead = events.length > 0 ? events[events.length - 1]!.seq : -1
        coveredThrough.set(
          id,
          readFrom <= parentCovered + 1 ? Math.max(parentCovered, lastRead) : parentCovered,
        )
      }
      // A session swap mid-build invalidates the whole assembly (it mixes
      // the snapshot's lineage with headers listed for the OLD cwd state):
      // drop it silently — the reopened tree rebuilds on the new session.
      if (!owner.current() || binding.agent.session !== liveSession) return null
      return buildSessionTree(familySessions, currentId, truncated)
    }
return readTree
}
