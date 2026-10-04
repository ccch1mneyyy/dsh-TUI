/** Subagent transcript access and background-task controls for a session. */
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSession } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import type { ClaudeAuthPlan } from '../auth.js'
import { replayClaudeSubagentLane } from '../replay.js'
import { readTaskOutputTail, taskOutputRoots } from '../task-output.js'
import type { ClaudeTranslator } from '../translate.js'
import type { ClaudeSessionDeps, Run } from './types.js'

/** The subagent transcript's newest page (messages); older windows of the
 *  same size load on demand. */
const SUBAGENT_TRANSCRIPT_PAGE = 400

export function sessionTaskCapabilities(context: {
  readonly deps: ClaudeSessionDeps
  readonly translator: ClaudeTranslator
  readonly run: Run
  readonly disposing: boolean
  readonly currentSessionId: string
  readonly authPlan: ClaudeAuthPlan
}): Pick<AgentSession['capabilities'], 'subagents' | 'tasks'> {
  const { deps, translator } = context
  /** Stop a task (subagent or job) by the id the channel knows it by. */
  const stopTask = async (id: string): Promise<boolean> => {
    const taskId = translator.taskIdOf(id)
    const query = context.run.query as Partial<Pick<Query, 'stopTask'>>
    if (taskId === undefined || typeof query.stopTask !== 'function' || context.disposing) return false
    await query.stopTask(taskId)
    return true
  }

  /**
   * The child transcript source: the subagent's own messages, read from the store and replayed through the
   *  same translator the live lane uses. Absent when this session has no
   *  store read API (tests, a store-less open); a read that fails rejects
   *  and the transcript view says unavailable — an unreadable transcript is
   *  never presented as an empty one.
   */
  function subagentHistory(): Pick<NonNullable<AgentSession['capabilities']['subagents']>, 'history'> {
    const read = deps.store?.getSubagentMessages
    if (read === undefined) return {}
    return {
      async history(agentId, window) {
        const laneOf = (messages: readonly unknown[], hasOlder: boolean, skippedFromStart: number) => {
          const lane = replayClaudeSubagentLane(agentId, messages, { cwd: deps.cwd, debug: message => deps.host.debug(message) })
          return { events: lane.events, parentAgentId: lane.parentAgentId, uuids: lane.uuids, hasOlder, skippedFromStart }
        }
        if (window !== undefined) {
          // An older slice: [skipFromStart - count, skipFromStart) of the disk
          // transcript (the SDK paginates by offset from the start). An empty
          // window reads nothing and leaves the cursor where it was.
          const skip = Math.max(0, window.skipFromStart)
          const count = Math.max(0, Math.min(window.count, skip))
          if (count === 0) return laneOf([], skip > 0, skip)
          const slice = await read(context.currentSessionId, agentId, { dir: deps.cwd, offset: skip - count, limit: count })
          return laneOf(slice, skip - count > 0, skip - slice.length)
        }
        // The newest page: one full read (bounded below), the tail kept.
        const all = await read(context.currentSessionId, agentId, { dir: deps.cwd })
        if (all.length <= SUBAGENT_TRANSCRIPT_PAGE) return laneOf(all, false, 0)
        return laneOf(all.slice(all.length - SUBAGENT_TRANSCRIPT_PAGE), true, all.length - SUBAGENT_TRANSCRIPT_PAGE)
      },
    }
  }
  return {
    // A subagent or background job is stopped by its task id (`stopTask`;
    // the CLI reports the stop as its notification).
    subagents: {
      interrupt: agentId => stopTask(agentId),
      ...subagentHistory(),
      messaging: 'parent-mediated',
    },
    tasks: {
      stop: taskId => stopTask(taskId),
      readOutput: taskId => {
        const file = translator.outputFileOf(taskId)
        if (file === undefined) return Promise.reject(new Error(t('claude-task-output-unknown', { id: taskId })))
        try {
          return Promise.resolve(readTaskOutputTail(file, taskId, taskOutputRoots(context.authPlan.env)))
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)))
        }
      },
    },
  }
}
