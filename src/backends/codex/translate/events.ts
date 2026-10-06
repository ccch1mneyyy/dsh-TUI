/** Declare which Agent Domain events the Codex backend emits. */
import type { AgentEventType } from '../../../agent/events.js'

/**
 * The Codex backend's decision for every Agent Domain event type (checked by
 * `verify:agent-domain`): a new `AgentEvent` variant fails `tsc` here until
 * this backend decides whether it emits it.
 */
export function codexEmits(type: AgentEventType): boolean {
  switch (type) {
    case 'session.ready':
    case 'session.title':
    case 'session.status':
    case 'turn.start':
    case 'turn.end':
    case 'step.start':
    case 'step.end':
    case 'user.message':
    case 'pending.changed':
    case 'assistant.attempt.start':
    case 'assistant.delta':
    case 'assistant.message':
    case 'tool.call':
    case 'tool.result':
    case 'tool.progress':
    case 'compaction.start':
    case 'compaction.end':
    case 'context.capacity':
    case 'model.changed':
    case 'effort.changed':
    case 'mode.changed':
    case 'todo.write':
    case 'notice':
    case 'rate-limit':
    // Item types without a mapping reach the plugin renderer seam.
    case 'custom':
      return true
    // Emitted by the session's approval bridge (session/approvals.ts).
    case 'permission.request':
    case 'permission.settled':
    case 'question.request':
    case 'question.settled':
      return true
    // Not yet (later phases of docs/codex-backend-design.md §11) or not a
    // Codex concept: subagents and background tasks (C4), session colour and
    // in-place reset (C3/C2), goals (C4, N6), DSH presets / prompts /
    // request headers, compaction summary progress, context categories,
    // agent-message relays, abandoned attempts.
    case 'session.color':
    case 'session.reset':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.end':
    case 'task.start':
    case 'task.update':
    case 'task.output':
    case 'task.end':
    case 'tasks.snapshot':
    case 'compaction.progress':
    case 'context.usage':
    case 'commands.changed':
    case 'goal.change':
    case 'preset.selected':
    case 'system.prompt':
    case 'request.header':
    case 'agent.message':
    case 'assistant.attempt.end':
      return false
    default: {
      const unhandled: never = type
      return unhandled
    }
  }
}
