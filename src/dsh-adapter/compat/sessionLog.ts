/**
 * Session-log compatibility helpers.
 *
 * Title lookup tolerates event types unknown to the current harness. Offline
 * rename and delete support the `/resume` picker when no live Agent owns the
 * selected persisted session. The resume seam registers vouched-for legacy
 * event types into every reachable KNOWN_SESSION_EVENT_TYPES copy so the
 * strict read path stops rejecting whole sessions over them (issue #153).
 *
 * Registration background: plugins like dsh-working-activity (< the publish
 * cut) appended `activity/status` through `session.append`, but rc.6's
 * append exposes no `ignorable` flag and the type is absent from
 * KNOWN_SESSION_EVENT_TYPES — so resume's seed validation rejects the WHOLE
 * session ("unknown to this harness and not marked ignorable"). Upstream's
 * catalog header defers a registration surface "until such a consumer
 * exists"; the working-activity plugin became that consumer at #119 and
 * registers its type at load. Logs written BEFORE that cut, resumed in a
 * process where the plugin's registration never ran (plugin unmounted, or
 * a bare cordis.yml), still hit the rejection — this module is the consumer
 * for exactly that residue.
 *
 * Why registration and NOT rewriting the log to mark events `ignorable`
 * (the #107 approach, restored then replaced after review): the store is
 * shared with dsh web (#24) and possibly a second TUI instance (#153), and
 * a whole-file tmp+rename swap (a) loses frames an already-open appender
 * lands on the replaced inode, (b) drops the backend's 0600 artifact mode,
 * (c) re-encodes frames without the writer's checksum flag, and (d) dies on
 * torn tails the backend itself can recover. Registration touches nothing
 * on disk and degrades to exactly the pre-patch behavior when no copy
 * resolves.
 *
 * Whitelist discipline: ONLY `activity/status` — the type the plugin
 * provably wrote as ephemeral UI frames. Anything else unknown stays
 * unknown: upstream's fail-closed ("likely written by a newer harness") is
 * a feature — silently skipping a REQUIRED future event would reconstruct
 * a wrong session. Retires the day upstream's shared catalog adopts the
 * type or ships a real registration API (the add() calls become no-ops).
 *
 * @module @deepseek-harness-tui/dsh-tui/compat/sessionLog
 */
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { homeDir } from '../../utils/paths.js'

/**
 * Legacy third-party session-event types the TUI vouches for as ephemeral
 * UI frames — safe for the strict read path to accept and skip. Exported
 * for the regression verifier; grow it only with proof the type was always
 * inert (never load-bearing for session reconstruction).
 */
export const LEGACY_SESSION_EVENT_TYPES: readonly string[] = ['activity/status']

/** Zstd frame magic number, little-endian (0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Session-log storage roots, in priority order, mirroring the persistence
 * backend's `root` resolution: cordis.patch.yml sets `DSH_TUI_SESSION_ROOT ?? dshHomePath(
 * 'sessions')` where dshHomePath is `$DSH_HOME ?? ~/.dsh`; the unpatched
 * cordis.yml base falls back to ~/.dsh-tui/sessions, kept here as the legacy
 * last resort. Every candidate is scanned — the first hit wins, so an
 * explicit DSH_TUI_SESSION_ROOT always outranks the defaults.
 */
export function sessionsRoots(): string[] {
  const home = homeDir()
  const roots: string[] = []
  const override = process.env.DSH_TUI_SESSION_ROOT
  if (override !== undefined && override.trim().length > 0) roots.push(override)
  const dshHome = process.env.DSH_HOME
  roots.push(join(dshHome !== undefined && dshHome.trim().length > 0 ? dshHome : join(home, '.dsh'), 'sessions'))
  roots.push(join(home, '.dsh-tui', 'sessions'))
  return [...new Set(roots)]
}

/**
 * Session ids reach path.join() below from picker/channel callers, and
 * deleteSessionLog recursively removes the resolved parent directory — so
 * an id must be a single safe path segment. Real ids are UUIDs or
 * `session-<uuid>`; anything with separators, dots, or shell-y characters
 * is rejected outright (treated as "no such session").
 */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)
}

/**
 * Locate a session's log by scanning workspace directories for the session
 * id — deliberately NOT replicating the persistence plugin's workspace-key
 * sanitization, so the helpers survive upstream key-scheme changes.
 * @param sessionId - Session id (directory name under each workspace dir).
 * @returns Absolute path of session.jsonl.zstd, or undefined when absent.
 */
export function findSessionLogFile(sessionId: string): string | undefined {
  if (!isSafeSessionId(sessionId)) return undefined
  for (const root of sessionsRoots()) {
    let workspaces: string[]
    try {
      workspaces = readdirSync(root)
    } catch {
      continue
    }
    for (const ws of workspaces) {
      const candidate = join(root, ws, sessionId, 'session.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Decode a (possibly multi-frame) zstd jsonl log. Frames are split by magic
 * scan; any frame failing to decode or any line failing to parse throws, so
 * callers abort instead of acting on a log they did not fully understand.
 * @param buf - Raw file bytes.
 * @returns Parsed event envelopes, in log order.
 */
function decodeEvents(buf: Buffer): Record<string, unknown>[] {
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  }
  if (offsets.length === 0) throw new Error('no zstd frame found')
  return offsets.flatMap((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1]! : buf.length
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('session log line is not an event envelope')
        }
        return parsed as Record<string, unknown>
      })
  })
}

/**
 * Register every {@link LEGACY_SESSION_EVENT_TYPES} type as known in EVERY
 * reachable KNOWN_SESSION_EVENT_TYPES copy, ahead of the strict read path
 * (`agents.resume` seed validation, `persistence.load`). Idempotent; never
 * throws.
 *
 * Why a walk instead of a single import: a runtime can load dsh-session
 * more than once (CLI tree vs profile tree, version overlap during
 * upgrades, pnpm peer-context splits), and the strict validator — which
 * lives in the dsh-session-persistence package — consults only ITS OWN
 * tree's copy. Registering through one import leaves the other trees'
 * copies untouched. So from EACH base anchor (this module = the dsh-tui
 * tree, the process entry point = the launcher/CLI tree) the walk
 * registers the tree's own dsh-session AND steps one edge further:
 * resolve the validator package from that same tree, then register the
 * dsh-session copy the validator's entry resolves. A branch that cannot
 * be resolved simply is not there; resolved module paths are deduped.
 */
export function ensureLegacySessionEventTypes(): void {
  const roots = [import.meta.url, process.argv[1]].filter(
    (anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0,
  )
  const visitedAnchors = new Set<string>()
  const registeredCopies = new Set<string>()
  const walk = (anchor: string): void => {
    if (visitedAnchors.has(anchor)) return
    visitedAnchors.add(anchor)
    let req: ReturnType<typeof createRequire>
    try {
      req = createRequire(anchor)
    } catch {
      return
    }
    try {
      const copy = req.resolve('@deepseek-ai/dsh-session')
      if (!registeredCopies.has(copy)) {
        registeredCopies.add(copy)
        const mod = req(copy) as { KNOWN_SESSION_EVENT_TYPES?: Set<string> }
        for (const type of LEGACY_SESSION_EVENT_TYPES) {
          mod.KNOWN_SESSION_EVENT_TYPES?.add(type)
        }
      }
    } catch {
      // No resolvable dsh-session copy from this anchor — nothing here.
    }
    try {
      walk(req.resolve('@deepseek-ai/dsh-session-persistence'))
    } catch {
      // Validator package not reachable from this tree — nothing to cover.
    }
  }
  for (const root of roots) walk(root)
}

/**
 * Read a session's display title from its persisted log, tolerantly.
 *
 * Why not `persistence.load()`: the backend validates every event against
 * KNOWN_SESSION_EVENT_TYPES and throws the WHOLE load when a third-party
 * plugin wrote an unmarked unknown type. A picker label is
 * read-only UI state: decoding frames directly here keeps titles working
 * for logs the strict path refuses, now and for future plugin event types.
 *
 * Title precedence: the LAST `session/title` event wins (a /rename append
 * overrides the first-prompt auto title), falling back to the first user
 * message text. `hasUserMessage` drives the picker's launch-artifact filter.
 * @param sessionId - Session whose log should be read.
 * @returns The title info, or undefined when the log is absent/undecodable.
 */
export function readSessionTitleFromLog(
  sessionId: string,
): { title?: string; hasUserMessage: boolean } | undefined {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return undefined
    const events = decodeEvents(readFileSync(file))
    let titled: string | undefined
    let firstUser: string | undefined
    let hasUserMessage = false
    for (const event of events) {
      if (event['type'] === 'session/title') {
        const title = (event['data'] as { title?: unknown } | undefined)?.['title']
        if (typeof title === 'string' && title.trim().length > 0) titled = title
      } else if (event['type'] === 'user/message') {
        hasUserMessage = true
        if (firstUser === undefined) {
          firstUser = firstTextOfContent(
            (event['data'] as { content?: unknown } | undefined)?.['content'],
          )
        }
      }
    }
    return { title: titled ?? firstUser, hasUserMessage }
  } catch {
    return undefined
  }
}

/**
 * Extract the first text block from a user/message `content` payload.
 * Content is normally a block array; a bare string is accepted defensively.
 * @param content - The event's content field.
 * @returns The trimmed text, or undefined when no text block exists.
 */
function firstTextOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      const text = ((block as { text: string }).text).trim()
      if (text.length > 0) return text
    }
  }
  return undefined
}

/**
 * Append a `session/title` event to a persisted session's log — the
 * `/resume` picker rename for a NON-LIVE session (the live one goes through
 * `session.append` in the channel). The backend flushes by appending zstd
 * frames, so the new event lands as one more frame: existing bytes stay
 * untouched (the frame-0 header invariant holds), and `last title wins` in
 * {@link readSessionTitleFromLog} surfaces the new name. The seq continues
 * the log's contiguity contract (seq = event count) by taking maxSeq + 1.
 * The frame is APPEND-ONLY (O_APPEND), matching the backend's own flush
 * discipline: this store is shared with dsh web (#24), and a
 * read-concat-rewrite (tmp + rename) would silently drop a frame another
 * writer lands between our read and replace. A single append never rewrites
 * existing bytes, so concurrent frames all survive; the worst remaining
 * race is a duplicate seq when the maxSeq read above passes another
 * appender — benign next to lost frames, since last-title-wins keeps the
 * rename semantics. Never throws.
 * @param sessionId - Session to rename.
 * @param title - New display title (already trimmed by the caller).
 * @returns 'appended', or 'unavailable' when the log is absent/undecodable.
 */
export function appendSessionTitle(sessionId: string, title: string): 'appended' | 'unavailable' {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return 'unavailable'
    const events = decodeEvents(readFileSync(file))
    let maxSeq = -1
    for (const event of events) {
      const seq = event['seq']
      if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq
    }
    // Same envelope shape as a manual /rename append ({ title } only); the
    // seed validator asks only for type/seq/time/data on non-message types.
    const event = {
      type: 'session/title',
      seq: maxSeq + 1,
      time: Date.now(),
      data: { title },
    }
    const frame = zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8'))
    appendFileSync(file, frame)
    return 'appended'
  } catch {
    return 'unavailable'
  }
}

/**
 * Delete a persisted session's log directory (`<root>/<workspace>/<id>/`),
 * the `/resume` picker delete. The directory holds only session.jsonl.zstd
 * today; removing it whole keeps future sidecar files from orphaning. The
 * backend's list() materializes entries from these logs, so the session
 * drops out of the picker on the next refresh. Never throws.
 * @param sessionId - Session to delete (must not be the live session).
 * @returns 'deleted', or 'unavailable' when the log is absent.
 */
export function deleteSessionLog(sessionId: string): 'deleted' | 'unavailable' {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return 'unavailable'
    const dir = dirname(file)
    // Containment must hold after resolving symlinks, not just lexically:
    // a symlinked workspace directory (<root>/<ws -> /outside>/<id>) would
    // steer the recursive rm outside the sessions root even with a clean
    // whitelisted id. realpath BOTH sides — the root itself may legitimately
    // live behind a symlink (macOS /tmp -> /private/tmp).
    const realDir = realpathSync(dir)
    const contained = sessionsRoots().some(root => {
      try {
        return realDir.startsWith(realpathSync(root) + sep)
      } catch {
        return false
      }
    })
    if (!contained) return 'unavailable'
    rmSync(dir, { recursive: true, force: true })
    return 'deleted'
  } catch {
    return 'unavailable'
  }
}
