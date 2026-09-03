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
 * top-level `ignorable: true`, so a newer required DSH event cannot be
 * silently skipped. Prefix-based recognition is deliberately not used.
 */

import { TUI_CHANNEL_WIRE_REVISION } from '../spec/index.js'
import type { TuiChannelSnapshot } from '../spec/index.js'

export interface DshSessionProjectionMeta {
  readonly channelId: string
  readonly sessionTitle?: string
  readonly homeDir?: string
  readonly pathCaseInsensitive?: boolean
  /** Optional RFC-adjacent Channel state fields carried through when known. */
  readonly model?: string
  readonly mode?: string
  readonly agentPreset?: string
  readonly settingsSections?: readonly unknown[]
  readonly scene?: unknown
  readonly diagnostic?: unknown
  readonly trace?: readonly unknown[]
  readonly context?: unknown
  readonly pending?: readonly unknown[]
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
  readonly ignorable?: unknown
}

/**
 * Explicit DSH session event types this minimal projection recognizes.
 *
 * This is NOT a prefix list: `user/unknown-required` is not recognized unless
 * the exact type is present. Unknown types must be marked top-level
 * `ignorable: true` to be skipped.
 */
export const KNOWN_DSH_EVENT_TYPES = new Set<string>([
  // dsh-session core event map
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'command/run',
  'command/done',
  'hook/invoked',
  'hook/result',
  'agent/inbox/spliced',
  'todo/write',
  'request/header',
  'request/context',
  'session/end-seed',
  // Known dsh-tui / ecosystem plugin event types (exact, not prefix-based)
  'session/created',
  'session/disposed',
  'session/flush',
  'session/title',
  'session/color',
  'session/title-llm-request',
  'session/event',
  'agent/status',
  'agent/disposed',
  'agent/request',
  'agent/inbox/claimed',
  'agent/inbox/discarded',
  'agent-preset/selected',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'commands/change',
  'skills/change',
  'goal/change',
  'plan/mode',
  'sandbox/mode',
  'permission/preset',
  'llm/retry',
  'llm/retry-started',
  'compaction/start',
  'compaction/end',
  'compaction/prune',
  'compaction/summary',
  'feedback/record',
  'schedule/change',
  'session-invariant',
  'subagent/start',
  'subagent/end',
  'subagent/descriptor',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
  'tool-workflow/run-start',
  'tool-workflow/run-end',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
  'web/deepseek-search-llm-request',
  'dsh-tui/btw',
  'dsh-tui/recap',
  'dsh-working-activity/config',
  'dsh-working-activity/status',
  'activity/status',
])

function isKnownEventType(type: string): boolean {
  return KNOWN_DSH_EVENT_TYPES.has(type)
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
  if (type === 'user/message') return { kind: 'user', text }
  if (type === 'assistant/message') return { kind: 'assistant', text }
  return undefined
}

function isIgnorable(event: SessionEventLike): boolean {
  // DSH `SessionEvent` places `ignorable` at the top level of the event,
  // never inside `data`.
  return event.ignorable === true
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
  let usage: Readonly<Record<string, unknown>> = Object.freeze({})
  let context = meta.context
  let pending = meta.pending
  let diagnostic = meta.diagnostic
  let trace = meta.trace ?? Object.freeze([])

  const push = (): void => {
    const state: Record<string, unknown> = {
      status,
      sessionTitle: meta.sessionTitle ?? 'dsh session',
      homeDir: meta.homeDir ?? '/',
      pathCaseInsensitive: meta.pathCaseInsensitive ?? false,
      transcript: Object.freeze(rows.map(row => Object.freeze({ ...row }))),
      commandCatalog: Object.freeze([]),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
      ...(meta.model === undefined ? {} : { model: meta.model }),
      ...(meta.mode === undefined ? {} : { mode: meta.mode }),
      ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
      ...(meta.settingsSections === undefined ? {} : { settingsSections: Object.freeze([...meta.settingsSections]) }),
      ...(meta.scene === undefined ? {} : { scene: meta.scene }),
      ...(context === undefined ? {} : { context }),
      ...(pending === undefined ? {} : { pending: Object.freeze([...(pending as readonly unknown[])]) }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(trace === undefined ? {} : { trace }),
    }
    version += 1
    snapshots.push({
      wireRevision: TUI_CHANNEL_WIRE_REVISION,
      channelId: meta.channelId,
      version,
      state: Object.freeze(state) as TuiChannelSnapshot['state'],
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
      // Missing type is always rejectable: even an `ignorable` marker cannot
      // describe which event is being skipped.
      throw new DshSessionProjectionError('DSH session event is missing a type')
    }
    if (!isKnownEventType(type)) {
      if (isIgnorable(event)) continue
      throw new DshSessionProjectionError(`unknown non-ignorable DSH session event: ${type}`)
    }
    const data = (event.data ?? {}) as Record<string, unknown>
    if (type === 'turn/start') status = 'working'
    if (type === 'turn/end' || type === 'session/end-seed') status = 'idle'
    if (type === 'assistant/message' && data.usage !== null && typeof data.usage === 'object') {
      usage = Object.freeze({ ...(data.usage as Record<string, unknown>) })
    }
    if (type === 'request/context') {
      context = data
    }
    const row = projectEvent(event)
    if (row !== undefined) rows.push(row)
    push()
  }
  return Object.freeze(snapshots)
}
