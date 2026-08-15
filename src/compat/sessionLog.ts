/**
 * Session-log compatibility helpers.
 *
 * Title lookup tolerates event types unknown to the current harness. Offline
 * rename and delete support the `/resume` picker when no live Agent owns the
 * selected persisted session.
 *
 * @module @deepseek-harness-tui/dsh-tui/compat/sessionLog
 */
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
import { homeDir } from '../utils/paths.js'

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
function findSessionLogFile(sessionId: string): string | undefined {
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

/** One decoded zstd frame: its original byte span plus parsed envelopes. */
interface DecodedFrame {
  /** Original compressed bytes — reused verbatim when nothing inside changed. */
  readonly raw: Buffer
  /** Parsed event envelopes of this frame, in order. */
  readonly events: Record<string, unknown>[]
}

/**
 * Decode a (possibly multi-frame) zstd jsonl log, keeping frames separate.
 * Frames are split by magic scan; any frame failing to decode or any line
 * failing to parse throws, so callers abort instead of rewriting a log they
 * did not fully understand.
 * @param buf - Raw file bytes.
 * @returns Per-frame byte spans and parsed event envelopes, in log order.
 */
function decodeFrames(buf: Buffer): DecodedFrame[] {
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  }
  if (offsets.length === 0) throw new Error('no zstd frame found')
  return offsets.map((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1]! : buf.length
    const raw = buf.subarray(start, end)
    const text = zstdDecompressSync(raw).toString('utf8')
    const events = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('session log line is not an event envelope')
        }
        return parsed as Record<string, unknown>
      })
    return { raw, events }
  })
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
    const frames = decodeFrames(readFileSync(file))
    let titled: string | undefined
    let firstUser: string | undefined
    let hasUserMessage = false
    for (const frame of frames) {
      for (const event of frame.events) {
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
    const original = readFileSync(file)
    const frames = decodeFrames(original)
    let maxSeq = -1
    for (const frame of frames) {
      for (const event of frame.events) {
        const seq = event['seq']
        if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq
      }
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
