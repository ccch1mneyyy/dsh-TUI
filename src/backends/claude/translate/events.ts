/** Declare which Agent Domain events the Claude backend emits. */
import type { AgentEventType } from '../../../agent/events.js'

/**
 * The Claude backend's decision for every Agent Domain event type (checked by
 * `verify:agent-domain`): a new `AgentEvent` variant fails `tsc` here until
 * this backend decides whether it emits it.
 */
export function claudeEmits(type: AgentEventType): boolean {
  switch (type) {
    case 'session.ready':
    case 'session.title':
    case 'session.reset':
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
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.end':
    case 'task.start':
    case 'task.update':
    case 'task.end':
    case 'tasks.snapshot':
    case 'compaction.start':
    case 'compaction.end':
    case 'context.capacity':
    case 'model.changed':
    case 'mode.changed':
    case 'commands.changed':
    case 'todo.write':
    case 'notice':
    case 'rate-limit':
    // The session's `/color` (prefs-backed, session.ts).
    case 'session.color':
      return true
    // The SendMessage relay observation: emitted when the call arrives and
    // again when its result settles.
    case 'agent.message':
      return true
    // Emitted by the session's permission bridge (permissions.ts), not by
    // this translator: the prompts arrive through `canUseTool`.
    case 'permission.request':
    case 'permission.settled':
    case 'question.request':
    case 'question.settled':
      return true
    // Unsupported events or not a Claude concept (DSH
    // goals, presets, request headers, system prompt text, plugin events,
    // compaction summary progress, task output reads).
    case 'assistant.attempt.end':
    case 'task.output':
    case 'compaction.progress':
    case 'context.usage':
    case 'effort.changed':
    case 'goal.change':
    case 'preset.selected':
    case 'system.prompt':
    case 'request.header':
    case 'custom':
      return false
    default: {
      const unhandled: never = type
      return unhandled
    }
  }
}
