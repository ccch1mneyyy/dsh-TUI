/**
 * Minimal real DSH session-event → TuiChannelSnapshot projection.
 *
 * This is the P5 "real DSH replay" bridge: instead of only counting a
 * transcript, it reads `agent.session.events`-shaped records and projects the
 * visible rows/status into protocol-envelope `TuiChannelSnapshot` objects.
 *
 * It intentionally stays small and does not copy the full production
 * `src/dsh-adapter/channel.ts` projection (which is still the live Channel
 * implementation source). It is a durable-session *minimal transcript
 * replay* projection used by the harness and documentation, not a complete
 * RFC 0007 TUI Channel state projection.
 *
 * Unknown event types are fail-closed unless the event marks itself
 * `ignorable: true`, so a newer required DSH event cannot be silently skipped.
 */

import { TUI_CHANNEL_WIRE_REVISION } from '../spec/index.js'
import type { TuiChannelSnapshot } from '../spec/index.js'

export interface DshSessionProjectionMeta {
  readonly channelId: string
  readonly sessionTitle?: string
  readonly homeDir?: string
  readonly pathCaseInsensitive?: boolean
}

export class DshSessionProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DshSessionProjectionError'
  }
}

interface ProjectedRow {
  readonly kind: 'user' | 'assistant' | 'system'
  readonly text: string
}

interface SessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

const KNOWN_EVENT_PREFIXES = Object.freeze([
  'user/',
  'assistant/',
  'system/',
  'tool/',
  'turn/',
  'session/',
  'agent/',
  'subagent/',
  'goal/',
  'approval/',
  'preset/',
  'activity/',
  'mode/',
  'model/',
  'provider/',
  'file/',
  'workspace/',
  'skill/',
  'diagnostic/',
])

function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_PREFIXES.some(prefix => type.startsWith(prefix))
}

function firstText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  const content = record.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as Record<string, unknown>
    if (typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('')
}

function projectEvent(event: SessionEventLike): ProjectedRow | undefined {
  const type = typeof event.type === 'string' ? event.type : ''
  const data = (event.data ?? {}) as Record<string, unknown>
  const text = firstText(data.message ?? data)
  if (text === '') return undefined
  if (type.startsWith('user/')) return { kind: 'user', text }
  if (type.startsWith('assistant/')) return { kind: 'assistant', text }
  if (type.startsWith('system/')) return { kind: 'system', text }
  return undefined
}

function isIgnorable(event: SessionEventLike): boolean {
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return false
  return (event.data as Record<string, unknown>).ignorable === true
}

/**
 * Project DSH session events to strictly-increasing channel snapshots.
 *
 * The returned snapshots are plain JSON-safe objects suitable for
 * `createReplayChannelProvider`. If `events` is empty, one initial snapshot
 * is returned so a replay can still open/subscribe cleanly.
 *
 * Unknown non-ignorable event types cause a `DshSessionProjectionError`.
 */
export function projectDshSessionEventsToSnapshots(
  events: readonly unknown[],
  meta: DshSessionProjectionMeta,
): readonly TuiChannelSnapshot[] {
  const rows: ProjectedRow[] = []
  const snapshots: TuiChannelSnapshot[] = []
  let version = 0
  let status: 'idle' | 'working' = 'idle'

  const push = (): void => {
    version += 1
    snapshots.push({
      wireRevision: TUI_CHANNEL_WIRE_REVISION,
      channelId: meta.channelId,
      version,
      state: {
        status,
        sessionTitle: meta.sessionTitle ?? 'dsh session',
        homeDir: meta.homeDir ?? '/',
        pathCaseInsensitive: meta.pathCaseInsensitive ?? false,
        transcript: Object.freeze(rows.map(row => Object.freeze({ ...row }))),
        commandCatalog: Object.freeze([]),
      },
    })
  }

  push()
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') {
      throw new DshSessionProjectionError('DSH session event must be an object')
    }
    const event = raw as SessionEventLike
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === '') {
      if (isIgnorable(event)) continue
      throw new DshSessionProjectionError('DSH session event is missing a type and is not ignorable')
    }
    if (!isKnownEventType(type)) {
      if (isIgnorable(event)) continue
      throw new DshSessionProjectionError(`unknown non-ignorable DSH session event: ${type}`)
    }
    if (type === 'turn/start') status = 'working'
    if (type === 'turn/end' || type === 'session/end') status = 'idle'
    const row = projectEvent(event)
    if (row !== undefined) rows.push(row)
    // Push on every known event so version is monotonic; consumers see the
    // transcript evolving through the recorded session.
    push()
  }
  return Object.freeze(snapshots)
}
