/**
 * Compat patch: pre-resume session-log repair for third-party event types.
 *
 * Background: plugins like dsh-working-activity append `activity/status`
 * through `session.append`, but rc.6's append exposes no `ignorable` flag
 * and the type is absent from KNOWN_SESSION_EVENT_TYPES — so resume's seed
 * validation rejects the WHOLE session ("unknown to this harness and not
 * marked ignorable"). The event envelope legally accepts `ignorable: true`
 * (seed validator at dsh-session/lib), which tells the read path to skip
 * the event: exactly the right semantics for ephemeral UI frames.
 *
 * This patch repairs the target session's jsonl.zstd log in place before
 * `agents.resume`: every event whose type is unknown to the harness gets
 * `ignorable: true`. It is inherently self-adjusting — the capability probe
 * IS the known-types list, so types upstream later adopts stop being
 * marked, and already-known events are never touched.
 *
 * Storage notes: the jsonl persistence flushes by APPENDING zstd frames, so
 * the file is a concatenation of frames. Frame layout is load-bearing: the
 * backend asserts frame 0 holds EXACTLY the header line (listings read only
 * that frame; `assertZstdHeaderFrame`), so the repair re-encodes each frame
 * with its original line set — frame boundaries are preserved 1:1, and any
 * frame whose lines were untouched is copied verbatim. Any decode/parse
 * anomaly aborts the repair and resume proceeds unpatched — the failure
 * mode degrades to the pre-patch behavior.
 * @module @deepseek-harness-tui/dsh-tui/compat/sessionLog
 */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { homeDir } from '../utils/paths.js'

/** Repair outcomes, surfaced for regression assertions and debug logging. */
export type ResumeRepairOutcome =
  | 'repaired' // at least one unknown-type event was marked ignorable
  | 'clean' // log read fine, nothing unknown to mark
  | 'unavailable' // no log file, or decode/parse anomaly — left untouched

/** Zstd frame magic number, little-endian (0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Session-log storage root, mirroring the persistence plugin's `root`
 * resolution in cordis.patch.yml: DSH_TUI_SESSION_ROOT, else
 * $DSH_HOME/sessions (default ~/.dsh/sessions) — the shared JSONL store
 * dsh web writes too (#24).
 */
function sessionsRoot(): string {
  return (
    process.env.DSH_TUI_SESSION_ROOT ??
    join(process.env.DSH_HOME || join(homeDir(), '.dsh'), 'sessions')
  )
}

/**
 * Locate a session's log by scanning workspace directories for the session
 * id — deliberately NOT replicating the persistence plugin's workspace-key
 * sanitization, so the repair survives upstream key-scheme changes.
 * @param sessionId - Session id (directory name under each workspace dir).
 * @returns Absolute path of session.jsonl.zstd, or undefined when absent.
 */
function findSessionLogFile(sessionId: string): string | undefined {
  const root = sessionsRoot()
  let workspaces: string[]
  try {
    workspaces = readdirSync(root)
  } catch {
    return undefined
  }
  for (const ws of workspaces) {
    const candidate = join(root, ws, sessionId, 'session.jsonl.zstd')
    if (existsSync(candidate)) return candidate
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
 * Repair one session's persisted log ahead of `agents.resume`: mark every
 * event whose type is absent from KNOWN_SESSION_EVENT_TYPES as
 * `ignorable: true` (envelope-legal, read path skips it). Never throws.
 * @param sessionId - Session about to be resumed.
 * @returns The repair outcome; 'unavailable' leaves the file untouched.
 */
export function repairSessionLogForResume(sessionId: string): ResumeRepairOutcome {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return 'unavailable'
    const frames = decodeFrames(readFileSync(file))
    // Mark unknown types in place, tracking which frames actually changed:
    // untouched frames are copied back verbatim, so the header frame keeps
    // its exact original bytes (and the one-header-line invariant with it).
    const dirty = new Set<number>()
    frames.forEach((frame, index) => {
      for (const event of frame.events) {
        const type = event['type']
        // Only real log entries carry a numeric seq — the seq-less header row
        // is parsed by a separate path that must not see an extra field.
        if (
          typeof type === 'string' &&
          typeof event['seq'] === 'number' &&
          !KNOWN_SESSION_EVENT_TYPES.has(type as never) &&
          event['ignorable'] === undefined
        ) {
          event['ignorable'] = true
          dirty.add(index)
        }
      }
    })
    if (dirty.size === 0) return 'clean'
    const parts = frames.map((frame, index) => {
      if (!dirty.has(index)) return frame.raw
      const payload = frame.events.map((event) => JSON.stringify(event)).join('\n') + '\n'
      return zstdCompressSync(Buffer.from(payload, 'utf8'))
    })
    const tmp = `${file}.compat-${randomUUID()}.tmp`
    writeFileSync(tmp, Buffer.concat(parts))
    renameSync(tmp, file)
    return 'repaired'
  } catch {
    return 'unavailable'
  }
}

/**
 * Read a session's display title from its persisted log, tolerantly.
 *
 * Why not `persistence.load()`: the backend validates every event against
 * KNOWN_SESSION_EVENT_TYPES and throws the WHOLE load when a third-party
 * plugin wrote an unmarked unknown type (e.g. activity/status before the
 * resume repair touched it) — which is exactly why pickers fell back to the
 * cwd basename for every working-activity session. A picker label is
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
 * Compat entry for the resume path: repair the target session's log, then
 * let resume proceed regardless of outcome. Never throws, never blocks on
 * anything but one small file — a repair miss degrades to the exact
 * pre-patch behavior (resume may still succeed or fail as before).
 * @param sessionId - Session about to be resumed.
 */
export async function prepareSessionForResume(sessionId: string): Promise<void> {
  repairSessionLogForResume(sessionId)
}
