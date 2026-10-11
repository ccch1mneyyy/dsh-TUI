/**
 * The `transcript` capability of a Claude session: "load
 * earlier" restores folded rows from, and prepends history older than the
 * resumed chain out of, the session's own transcript file — read-only,
 * synchronous, bounded (transcript-file.ts), replayed by the same replay as
 * a resume (replay.ts), so older rows look exactly like resumed ones.
 *
 * Older history exists only when the resumed chain began at a compaction
 * (`ClaudeReplay.compactedFrom`): slices are walked back one compaction
 * segment at a time (a long segment in bounded slices), newest first; the
 * cursor only moves on, so a repeated "load earlier" never repeats a slice.
 */
import { statSync } from 'node:fs'
import type { SessionCapabilities } from '../../agent/capabilities.js'
import type { AgentEvent } from '../../agent/events.js'
import { claudeText } from './text.js'
import type { JsonRecord } from '../shared/jsonl.js'
import { replayClaudeTranscript } from './replay.js'
import { cursorBefore, headBoundary, locateClaudeTranscript, olderSlice, readTranscriptEntries, type OlderCursor } from './transcript-file.js'

export interface ClaudeTranscriptHistoryDeps {
  /** The session (a function when it can change: a conversation reset moves
   *  the CLI to a new session id, whose file has no older history yet). */
  readonly sessionId: string | (() => string)
  readonly cwd: string
  /** The CLI's config directory (where its `projects/` live). */
  configDir(): string
  /** Where the resumed chain began (a compaction), if it did. */
  readonly compactedFrom?: string
  /** Entries per older slice (bounded; tests lower it). */
  readonly sliceEntries?: number
  readonly debug?: (message: string) => void
}

export function createClaudeTranscriptHistory(deps: ClaudeTranscriptHistoryDeps): NonNullable<SessionCapabilities['transcript']> {
  const debug = deps.debug ?? (() => undefined)
  const sessionIdOf = (): string => typeof deps.sessionId === 'function' ? deps.sessionId() : deps.sessionId
  let boundId = sessionIdOf()
  let path: string | undefined
  let cursor: OlderCursor | 'start' | 'done' = deps.compactedFrom === undefined ? 'done' : 'start'
  /**
   * The parsed file, keyed by its size and mtime: a "load earlier" press
   * parses the transcript once per change, not once per call (record and
   * older on the same press share it), and the full-record replay is kept
   * with it.
   */
  let parsed: { readonly size: number; readonly mtimeMs: number; readonly entries: readonly JsonRecord[]; byUuid?: Map<string, JsonRecord>; record?: readonly AgentEvent[] } | undefined

  /** The session moved to another id: its file, no older segments known. */
  const follow = (): void => {
    const id = sessionIdOf()
    if (id === boundId) return
    boundId = id
    path = undefined
    parsed = undefined
    cursor = 'done'
  }

  const load = (): NonNullable<typeof parsed> => {
    follow()
    path ??= locateClaudeTranscript(boundId, deps.configDir())
    if (path === undefined) throw new Error(claudeText('claude-transcript-missing', { id: boundId }))
    const stat = statSync(path)
    if (parsed !== undefined && parsed.size === stat.size && parsed.mtimeMs === stat.mtimeMs) return parsed
    const { entries, badLines } = readTranscriptEntries(path)
    if (badLines > 0) debug(`claude: ${badLines} malformed transcript line(s) skipped`)
    parsed = { size: stat.size, mtimeMs: stat.mtimeMs, entries }
    return parsed
  }

  const replay = (entries: readonly JsonRecord[]): readonly AgentEvent[] =>
    replayClaudeTranscript(entries, { cwd: deps.cwd, debug }).events

  return {
    record(): readonly AgentEvent[] {
      const file = load()
      file.record ??= replay(file.entries.filter(entry => (entry.type === 'user' || entry.type === 'assistant') && entry.isSidechain !== true))
      return file.record
    },
    hasOlder: () => {
      follow()
      return cursor !== 'done'
    },
    older(): readonly AgentEvent[] {
      if (cursor === 'done') return []
      const file = load()
      const entries = file.entries
      if (file.byUuid === undefined) {
        file.byUuid = new Map<string, JsonRecord>()
        for (const entry of entries) if (typeof entry.uuid === 'string') file.byUuid.set(entry.uuid, entry)
      }
      const byUuid = file.byUuid
      let current: OlderCursor | undefined
      if (cursor === 'start') {
        const head = headBoundary(entries, byUuid, deps.compactedFrom)
        current = head === undefined ? undefined : cursorBefore(head, byUuid)
      } else {
        current = cursor
      }
      // A slice with nothing to show (all hidden) moves on to the next one;
      // a corrupted tree cannot send the walk round in a circle.
      const visited = new Set<string>()
      while (current !== undefined && !visited.has(current.end)) {
        visited.add(current.end)
        const slice = olderSlice(byUuid, current, deps.sliceEntries)
        current = slice.next
        if (slice.entries.length > 0) {
          cursor = current ?? 'done'
          return replay(slice.entries)
        }
      }
      cursor = 'done'
      return []
    },
  }
}
