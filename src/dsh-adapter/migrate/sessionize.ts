/**
 * Cross-agent conversation migration: MigrationSession → official DSH events.
 *
 * The sessionize step owns NO storage decisions. It drives the official
 * `Session` logical-event API (`Session.create` + `append`), so envelope
 * fields (seq/time/id), surface contract and format version come from the
 * upstream implementation — the part the first iteration of this feature got
 * wrong by hand-crafting physical log rows. Physical encoding, project
 * layout, zstd and atomic writes belong to JsonlSessionPersistence (see
 * index.ts), exactly as scripts/migrate-sessions-to-jsonl.mts does for the
 * retired sqlite store.
 *
 * Turn shape: one migration turn per user message — `turn/start`, the user
 * message, one step per assistant message that follows before the next user
 * message, then `turn/end`. A conversation that starts with an assistant
 * message (source lost its head) opens its turn with no user message; a
 * trailing user message closes a step-less turn — both are legal log shapes
 * (a turn with no entered step carries no step events). Tool traffic is not
 * migrated: source formats cannot replay it faithfully, and the migration
 * contract is "re-read the conversation", not "resume the task".
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/sessionize
 */
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { MigrationSession, MigrationTurn } from './types.js'

/** One migration turn's model-visible outcome, ready for persistence. */
export interface SessionizedLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** Blocks for one migrated message: reasoning first (when the source kept
 *  one), then the visible text. Empty text with reasoning keeps both blocks
 *  honest — the projection renders reasoning as its own collapsible row. */
function assistantBlocks(turn: MigrationTurn): (TextBlock | ReasoningBlock)[] {
  const blocks: (TextBlock | ReasoningBlock)[] = []
  if (turn.reasoning !== undefined && turn.reasoning !== '') {
    blocks.push({ type: 'reasoning', text: turn.reasoning })
  }
  if (turn.text !== '') blocks.push({ type: 'text', text: turn.text })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/**
 * Build one official DSH session log from a normalized foreign conversation.
 *
 * @param id - deterministic session id (see uuid.ts); the id IS the dedupe.
 * @param agentId - source adapter id, stamped into assistant provenance as
 *   `migrated:<agentId>` so the transcript can name where text came from.
 * @param session - the normalized foreign conversation.
 * @returns the official header plus the full event log, exactly as the
 *   persistence backend expects them.
 */
export function sessionize(id: SessionId, agentId: string, session: MigrationSession): SessionizedLog {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: session.startedAt,
    cwd: session.cwd,
    isSeeded: false,
  }
  const model = Session.create(id, undefined, header)
  // Collect each append()'s RETURN (a fully enveloped event) instead of the
  // deprecated snapshotEvents() bulk read — upstream forbids NEW callers of
  // the latter, and append already returns seq/time-stamped events.
  const events: SessionEvent[] = []
  let turnIndex = 0
  let i = 0
  const turns = session.turns
  while (i < turns.length) {
    turnIndex += 1
    events.push(model.append('turn/start', { turn: turnIndex }))
    if (turns[i]!.role === 'user') {
      events.push(model.append('user/message', createUserMessage({
        content: [{ type: 'text', text: turns[i]!.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' }))
      i += 1
    }
    let step = 0
    while (i < turns.length && turns[i]!.role === 'assistant') {
      step += 1
      const turn = turns[i]!
      events.push(model.append('step/start', { turn: turnIndex, step }))
      events.push(model.append('assistant/message', {
        turn: turnIndex,
        step,
        message: createAssistantMessage({
          content: assistantBlocks(turn),
          // createAssistantMessage stamps `kind: 'model'` itself; the
          // caller-visible provenance is provider + model only.
          source: {
            provider: `migrated:${agentId}`,
            model: turn.model ?? agentId,
          },
        }),
        stream: [],
      }, { surfaceOp: 'append' }))
      events.push(model.append('step/end', { turn: turnIndex, step }))
      i += 1
    }
    events.push(model.append('turn/end', { turn: turnIndex, reason: { kind: 'completed' } }))
  }
  return { header: model.header, events }
}
