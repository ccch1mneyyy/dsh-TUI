/**
 * Synthesize DSH session events from a normalized foreign conversation.
 *
 * The output shape is pinned to the REAL session log contract (verified
 * against both the upstream @deepseek-ai/dsh-session-format-catalog reader
 * and on-disk logs): a v0 header line WITHOUT `origin` (the header schema
 * only ever allows `origin: "subagent"`, so provenance cannot live there —
 * the catalog verdict for any other origin is "malformed", which makes
 * listArtifacts silently drop the session from /resume); event envelopes
 * carry seq/time/data (+ `surfaceOp` on user/message only); `turn/end`
 * reasons come from the released variant set ('completed'); and
 * `session/title.messageSeqs` anchors to the first user/message seq.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/synthesize
 */
import type { MigrationSession } from './types.js'

/** One durable session event line (structural superset of what we emit). */
export interface SynthEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
  readonly surfaceOp?: string
  readonly [key: string]: unknown
}

/** Policy trio emitted right after the header, mirroring a real boot. */
const BOOT_POLICY: readonly { type: string, data: unknown }[] = [
  { type: 'permission/preset', data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
]

/**
 * Build the full event stream for one migrated conversation.
 * @param session - The normalized foreign conversation.
 * @param agentId - Adapter id (used only for the caller's records; NOT
 *   stamped into the header — the format forbids foreign origin values).
 * @param sessionId - Deterministic DSH session id.
 * @returns Event lines in seq order, ready to serialize as JSONL.
 */
export function synthesizeSessionEvents(session: MigrationSession, _agentId: string, sessionId: string): SynthEvent[] {
  const events: SynthEvent[] = []
  let seq = 0
  let time = session.startedAt
  const at = (turnTime: number): number => {
    time = Math.max(time + 1, Math.max(turnTime, 1))
    return time
  }
  const push = (type: string, data: unknown, surfaceOp?: string): SynthEvent => {
    const event: SynthEvent = surfaceOp === undefined
      ? { type, seq, time, data }
      : { type, seq, time, data, surfaceOp }
    seq += 1
    events.push(event)
    return event
  }

  // Header line: matches the real v0 physical header (no origin, no seed).
  events.push({
    type: 'session',
    version: 0,
    id: sessionId,
    createdAt: time,
    cwd: session.cwd,
    delegationDepth: 0,
    ...(session.title === undefined ? {} : { agentPreset: 'standard' }),
  })
  for (const policy of BOOT_POLICY) {
    time += 1
    push(policy.type, policy.data)
  }

  let turn = 0
  let firstUserSeq: number | undefined
  for (const item of session.turns) {
    if (item.role === 'user') {
      turn += 1
      time += 1
      push('turn/start', { turn })
      time = at(item.time)
      push('user/message', {
        content: [{ type: 'text', text: item.text }],
        source: { kind: 'user' },
        role: 'user',
        id: `${sessionId}-${turn}`,
      }, 'append')
      firstUserSeq ??= seq - 1
    } else if (turn > 0) {
      const content: { type: string, text: string }[] = []
      if (item.reasoning !== undefined && item.reasoning !== '') content.push({ type: 'reasoning', text: item.reasoning })
      if (item.text !== '') content.push({ type: 'text', text: item.text })
      if (content.length > 0) {
        time = at(item.time)
        push('assistant/message', {
          turn,
          step: 1,
          message: { role: 'assistant', content },
        })
      }
      time += 1
      push('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  if (turn === 0) return [] // no user turn → nothing replayable; caller skips

  const title = session.title !== undefined && session.title !== ''
    ? session.title
    : session.turns.find(item => item.role === 'user')?.text.slice(0, 80)
  if (title !== undefined && title !== '' && firstUserSeq !== undefined) {
    time += 1
    push('session/title', { title, messageSeqs: [firstUserSeq], source: { kind: 'fallback' } })
  }
  return events
}
