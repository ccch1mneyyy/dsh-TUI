import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import type { ChannelState } from './types.js'

export type SessionResetState = Pick<
  ChannelState,
  | 'rows'
  | 'todos'
  | 'pending'
  | 'goal'
  | 'sessionTitle'
  | 'sessionColor'
  | 'tokens'
  | 'responseChars'
  | 'activeToolCount'
  | 'lastUserText'
  | 'working'
  | 'cancelPending'
  | 'spinnerMode'
  | 'tps'
  | 'tpsSamples'
  | 'lastUsage'
  | 'workingActivity'
  | 'contextSegments'
>

/**
 * Reset the projection facts shared by every foreground session adoption.
 * Target-specific route, cwd, preset, loaded-context and status fields stay
 * with the caller: not every adoption has the same semantics for those.
 */
export function resetSessionProjection(
  state: SessionResetState,
  rowIds: { value: number },
  resetProjector: () => void,
  resetSubagents: () => void,
  resetJobs: () => void,
): void {
  resetProjector()
  rowIds.value = 0
  state.rows.length = 0
  markChannelReadDirty(state.rows)
  resetSubagents()
  resetJobs()
  state.todos = []
  state.pending = []
  state.goal = undefined
  state.sessionTitle = ''
  state.sessionColor = ''
  state.tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  state.responseChars = 0
  state.activeToolCount = 0
  state.lastUserText = ''
  state.working = false
  state.cancelPending = false
  state.spinnerMode = 'requesting'
  state.tps = undefined
  state.tpsSamples = []
  state.lastUsage = undefined
  state.workingActivity = undefined
  state.contextSegments = {
    system: 0,
    prompt: 0,
    assistant: 0,
    thinking: 0,
    tools: 0,
  }
}
