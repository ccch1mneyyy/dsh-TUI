/** Declare which Agent Domain events the Codex backend emits. */
import type { AgentEventType } from '../../../agent/events.js'

/**
 * The Codex backend's decision for every Agent Domain event type (checked by
 * `verify:agent-domain`): a new `AgentEvent` variant fails `tsc` here until
 * this backend decides whether it emits it.
 */
export function codexEmits(type: AgentEventType): boolean {
  switch (type) {
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.end':
    case 'task.start':
    case 'task.output':
    case 'task.end':
    case 'tasks.snapshot':
    case 'goal.change':
    case 'commands.changed':
    case 'session.color':
    case 'session.reset':
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
    case 'assistant.attempt.end':
    case 'usage':
    case 'context.usage':
    case 'tool.call':
    case 'tool.result':
    case 'tool.progress':
    // Running command output (N4, wired in C2).
    case 'tool.output':
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
    // No native source: task metadata patches, compaction summary progress,
    // DSH presets/prompts/request headers, or direct agent-message receipts.
    case 'task.update':
    case 'compaction.progress':
    case 'preset.selected':
    case 'system.prompt':
    case 'request.header':
    case 'agent.message':
      return false
    default: {
      const unhandled: never = type
      return unhandled
    }
  }
}
